import {
  createOrg,
  createUser,
  enrollDevice,
  event,
  Harness,
  inviteAndJoin,
  startHarness,
  TestDevice,
  TestUser,
  upload,
} from '../integration/helpers';

let h: Harness;
let alice: TestUser;
let bob: TestUser;
let aliceDevice: TestDevice;
let aliceEventId: string;
let aliceAlertId: string;

beforeAll(async () => {
  h = await startHarness();
  alice = await createUser(h);
  bob = await createUser(h);
  aliceDevice = await enrollDevice(h, alice, { name: 'Alice laptop' });
  await enrollDevice(h, bob, { name: 'Bob laptop' });
  await upload(h, aliceDevice, [
    event({ event_type: 'local_account_created', metadata: { account_name: 'intruder' } }),
  ]).expect(200);
  aliceEventId = (
    await h.sql<{ id: string }>('SELECT id FROM activity_events WHERE device_id = $1 LIMIT 1', [
      aliceDevice.id,
    ])
  )[0].id;
  aliceAlertId = (
    await h.sql<{ id: string }>(
      `SELECT id FROM security_alerts WHERE owner_user_id = $1 AND rule = 'local_account_created'`,
      [alice.id],
    )
  )[0].id;
});
afterAll(async () => h.close());

describe('user-to-user isolation', () => {
  it('one user cannot list another user’s devices, events or alerts', async () => {
    const devices = await bob.get('/v1/devices').expect(200);
    expect(devices.body.items.map((d: { name: string }) => d.name)).toEqual(['Bob laptop']);
    const events = await bob.get('/v1/events').expect(200);
    expect(
      events.body.items.every((e: { device_id: string }) => e.device_id !== aliceDevice.id),
    ).toBe(true);
    const alerts = await bob.get('/v1/alerts').expect(200);
    expect(alerts.body.items.find((a: { id: string }) => a.id === aliceAlertId)).toBeUndefined();
  });

  it('changing an object id in the URL returns 404, not the record', async () => {
    await bob.get(`/v1/devices/${aliceDevice.id}`).expect(404);
    await bob.get(`/v1/events/${aliceEventId}`).expect(404);
    await bob.get(`/v1/alerts/${aliceAlertId}`).expect(404);
    await bob.get(`/v1/devices/${aliceDevice.id}/recovery`).expect(404);
  });

  it('filtering by someone else’s device id returns nothing', async () => {
    const res = await bob.get('/v1/events').query({ device_id: aliceDevice.id }).expect(200);
    expect(res.body.items).toHaveLength(0);
    const exp = await bob
      .get('/v1/events/export')
      .query({ device_id: aliceDevice.id, format: 'json' })
      .expect(200);
    expect(exp.body.count).toBe(0);
  });

  it('one user cannot modify another user’s devices or alerts', async () => {
    await bob.patch(`/v1/devices/${aliceDevice.id}`).send({ name: 'pwned' }).expect(404);
    await bob.post(`/v1/devices/${aliceDevice.id}/revoke`).expect(404);
    await bob.del(`/v1/devices/${aliceDevice.id}`).expect(404);
    await bob.post(`/v1/alerts/${aliceAlertId}/resolve`).send({}).expect(404);
    const [d] = await h.sql<{ name: string; status: string }>(
      'SELECT name, status FROM devices WHERE id = $1',
      [aliceDevice.id],
    );
    expect(d).toEqual({ name: 'Alice laptop', status: 'active' });
  });

  it('summaries never include another user’s events', async () => {
    const res = await bob
      .post('/v1/summaries')
      .send({ question: 'What happened today?' })
      .expect(200);
    expect(res.body.evidence.find((e: { id: string }) => e.id === aliceEventId)).toBeUndefined();
    const forAlice = await bob
      .post('/v1/summaries')
      .send({ question: 'today', device_id: aliceDevice.id })
      .expect(200);
    expect(forAlice.body.evidence).toHaveLength(0);
  });

  it('a device cannot upload events that land in another account', async () => {
    const e = event({ owner_user_id: bob.id });
    const res = await upload(h, aliceDevice, [e]).expect(200);
    expect(res.body.rejected[0].reason).toMatch(/Unrecognized key/);
    const ok = event();
    await upload(h, aliceDevice, [ok]).expect(200);
    const [row] = await h.sql<{ owner_user_id: string }>(
      'SELECT owner_user_id FROM activity_events WHERE event_id = $1',
      [ok.event_id],
    );
    expect(row.owner_user_id).toBe(alice.id);
  });
});

describe('organization isolation and roles', () => {
  let ownerA: TestUser;
  let orgA: string;
  let orgB: string;
  let ownerB: TestUser;
  let analystA: TestUser;
  let memberA: TestUser;
  let memberDevice: TestDevice;

  beforeAll(async () => {
    ownerA = await createUser(h);
    orgA = await createOrg(h, ownerA, 'Org A');
    ownerB = await createUser(h);
    orgB = await createOrg(h, ownerB, 'Org B');
    analystA = await inviteAndJoin(h, ownerA, orgA, 'security_analyst');
    memberA = await inviteAndJoin(h, ownerA, orgA, 'member');
    memberDevice = await enrollDevice(h, memberA, { organizationId: orgA, name: 'Org laptop' });
    await upload(h, memberDevice, [
      event({
        event_type: 'security_setting_changed',
        metadata: { setting: 'firewall', new_value: false },
      }),
    ]).expect(200);
    const ownerBDevice = await enrollDevice(h, ownerB, {
      organizationId: orgB,
      name: 'Org B laptop',
    });
    await upload(h, ownerBDevice, [event()]).expect(200);
  });

  it('security analysts see all devices and events in their org', async () => {
    const devices = await analystA.get('/v1/devices').expect(200);
    expect(devices.body.items.map((d: { name: string }) => d.name)).toContain('Org laptop');
    const events = await analystA.get('/v1/events').query({ organization_id: orgA }).expect(200);
    expect(events.body.items.length).toBeGreaterThan(0);
  });

  it('another organization cannot see org A data even by id', async () => {
    const devices = await ownerB.get('/v1/devices').expect(200);
    expect(devices.body.items.map((d: { name: string }) => d.name)).not.toContain('Org laptop');
    await ownerB.get(`/v1/devices/${memberDevice.id}`).expect(404);
    const events = await ownerB.get('/v1/events').query({ organization_id: orgA }).expect(200);
    expect(events.body.items).toHaveLength(0);
    await ownerB.get(`/v1/organizations/${orgA}`).expect(404);
    await ownerB.get(`/v1/organizations/${orgA}/members`).expect(404);
    await ownerB.get('/v1/audit-logs').query({ organization_id: orgA }).expect(404);
    await ownerB
      .post(`/v1/organizations/${orgA}/invitations`)
      .send({ email: 'x@example.test' })
      .expect(404);
  });

  it('standard members only see their own devices, not colleagues’', async () => {
    const colleague = await inviteAndJoin(h, ownerA, orgA, 'member');
    const res = await colleague.get('/v1/devices').expect(200);
    expect(res.body.items).toHaveLength(0);
    await colleague.get(`/v1/devices/${memberDevice.id}`).expect(404);
  });

  it('org admins cannot see members’ personal (non-org) devices', async () => {
    await memberA.post('/v1/billing/plan').send({ plan: 'personal' }).expect(201);
    const personal = await enrollDevice(h, memberA, { name: 'Member personal phone' });
    const res = await ownerA.get('/v1/devices').expect(200);
    expect(res.body.items.map((d: { id: string }) => d.id)).not.toContain(personal.id);
    await ownerA.get(`/v1/devices/${personal.id}`).expect(404);
  });

  it('analysts can resolve alerts but cannot manage members or policies', async () => {
    const alerts = await analystA.get('/v1/alerts').query({ status: 'open' }).expect(200);
    const firewall = alerts.body.items.find(
      (a: { rule: string }) => a.rule === 'security_setting_changed',
    );
    await analystA.post(`/v1/alerts/${firewall.id}/resolve`).send({ note: 'reviewed' }).expect(200);
    await analystA
      .post(`/v1/organizations/${orgA}/invitations`)
      .send({ email: 'y@example.test' })
      .expect(403);
    await analystA
      .patch(`/v1/organizations/${orgA}`)
      .send({ member_enrollment_allowed: false })
      .expect(403);
    await analystA.get('/v1/audit-logs').query({ organization_id: orgA }).expect(403);
  });

  it('auditors can read the audit log but cannot change anything', async () => {
    const auditor = await inviteAndJoin(h, ownerA, orgA, 'auditor');
    const logs = await auditor.get('/v1/audit-logs').query({ organization_id: orgA }).expect(200);
    expect(logs.body.items.map((l: { action: string }) => l.action)).toEqual(
      expect.arrayContaining(['org.created', 'org.member_invited']),
    );
    await auditor.del(`/v1/organizations/${orgA}/members/${memberA.id}`).expect(403);
    const alerts = await auditor.get('/v1/alerts').expect(200);
    await auditor.post(`/v1/alerts/${alerts.body.items[0].id}/resolve`).send({}).expect(403);
  });

  it('administrative actions require MFA when the org policy says so', async () => {
    const admin = await inviteAndJoin(h, ownerA, orgA, 'admin');
    const res = await admin
      .post(`/v1/organizations/${orgA}/invitations`)
      .send({ email: 'z@example.test' })
      .expect(403);
    expect(res.body.message).toMatch(/multifactor/);
  });

  it('invitations only work for the invited email address', async () => {
    const stranger = await createUser(h);
    await ownerA
      .post(`/v1/organizations/${orgA}/invitations`)
      .send({ email: 'intended@example.test' })
      .expect(201);
    const body = (
      await h.sql<{ body: string }>(
        `SELECT body FROM email_outbox WHERE to_email = 'intended@example.test'`,
      )
    )[0].body;
    const token = /token=([A-Za-z0-9_-]+)/.exec(body)![1];
    await stranger.post('/v1/invitations/accept').send({ token }).expect(403);
  });

  it('enrollment into an org requires membership', async () => {
    await bob.post('/v1/devices/enrollment-codes').send({ organization_id: orgA }).expect(404);
  });

  it('removing a member revokes their org devices', async () => {
    await ownerA.del(`/v1/organizations/${orgA}/members/${memberA.id}`).expect(200);
    await upload(h, memberDevice, [event()]).expect(401);
    await memberA.get(`/v1/organizations/${orgA}`).expect(404);
  });
});
