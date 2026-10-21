import { createUser, enrollDevice, event, Harness, startHarness, TestDevice, TestUser, upload } from './helpers';

let h: Harness;
let user: TestUser;
let device: TestDevice;

beforeAll(async () => {
  h = await startHarness();
  user = await createUser(h);
  device = await enrollDevice(h, user, { name: 'Work laptop' });
});
afterAll(async () => h.close());

describe('device enrollment', () => {
  it('registers a device with a hashed credential and raises a new-device alert', async () => {
    const [cred] = await h.sql<{ secret_hash: Buffer }>('SELECT secret_hash FROM device_credentials WHERE device_id = $1', [device.id]);
    expect(cred.secret_hash.toString('utf8')).not.toContain(device.secret);
    const list = await user.get('/v1/devices').expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ name: 'Work laptop', status: 'active', sync_status: 'never', owner_user_id: user.id });
    const alerts = await user.get('/v1/alerts').expect(200);
    expect(alerts.body.items.map((a: { rule: string }) => a.rule)).toContain('new_device_registered');
  });

  it('enrollment codes are single use', async () => {
    // The free plan allows one device, so upgrade first.
    await user.post('/v1/billing/plan').send({ plan: 'personal' }).expect(201);
    const code = await user.post('/v1/devices/enrollment-codes').send({}).expect(201);
    const body = { enrollment_code: code.body.code, name: 'Phone', platform: 'android' };
    await h.http().post('/v1/devices/register').send(body).expect(201);
    await h.http().post('/v1/devices/register').send(body).expect(401);
  });

  it('enforces the plan device limit', async () => {
    const u = await createUser(h);
    await enrollDevice(h, u);
    const res = await u.post('/v1/devices/enrollment-codes').send({}).expect(403);
    expect(res.body.message).toMatch(/free plan allows 1 active device/);
  });

  it('lets the owner rename a device', async () => {
    const res = await user.patch(`/v1/devices/${device.id}`).send({ name: 'Renamed laptop' }).expect(200);
    expect(res.body.name).toBe('Renamed laptop');
  });
});

describe('batch ingestion', () => {
  it('accepts valid events, stores server timestamps and updates sync status', async () => {
    const e1 = event({ event_type: 'device_startup' });
    const e2 = event({ event_type: 'user_login', metadata: { account_name: 'alice' } });
    const res = await upload(h, device, [e1, e2]).expect(200);
    expect(res.body).toMatchObject({ accepted: 2, duplicates: 0, rejected: [] });
    const [row] = await h.sql<{ received_at: Date; owner_user_id: string }>('SELECT received_at, owner_user_id FROM activity_events WHERE event_id = $1', [e1.event_id]);
    expect(row.owner_user_id).toBe(user.id);
    expect(Math.abs(row.received_at.getTime() - Date.now())).toBeLessThan(10_000);
    const d = await user.get(`/v1/devices/${device.id}`).expect(200);
    expect(d.body.sync_status).toBe('ok');
    expect(d.body.reporting).toBe(true);
  });

  it('does not create duplicates when a batch is re-sent', async () => {
    const batch = [event(), event()];
    await upload(h, device, batch).expect(200);
    const again = await upload(h, device, batch).expect(200);
    expect(again.body).toMatchObject({ accepted: 0, duplicates: 2 });
    const [n] = await h.sql<{ n: number }>('SELECT count(*)::int AS n FROM activity_events WHERE event_id = ANY($1::uuid[])', [batch.map((b) => b.event_id)]);
    expect(n.n).toBe(2);
  });

  it('rejects malformed events individually without dropping the batch', async () => {
    const good = event();
    const res = await upload(h, device, [
      good,
      event({ event_type: 'keylogger_capture' }),
      event({ metadata: { password: 'hunter2' } }),
      event({ owner_user_id: '00000000-0000-0000-0000-000000000000' }),
      { not: 'an event' },
    ]).expect(200);
    expect(res.body.accepted).toBe(1);
    expect(res.body.rejected.map((r: { index: number }) => r.index)).toEqual([1, 2, 3, 4]);
    const stored = await h.sql('SELECT 1 FROM activity_events WHERE metadata ? $1', ['password']);
    expect(stored).toHaveLength(0);
  });

  it('rejects oversized and malformed payloads', async () => {
    await upload(h, device, []).expect(400);
    await upload(h, device, Array.from({ length: 501 }, () => event())).expect(400);
    const huge = { events: [event({ metadata: { a: 'x'.repeat(600_000) } })] };
    await h.http().post('/v1/events/batch').set('Authorization', device.auth).send(huge).expect(413);
    await h.http().post('/v1/events/batch').set('Authorization', device.auth).set('Content-Type', 'application/json').send('{"events": [').expect(400);
  });

  it('requires a device credential, not a user session', async () => {
    await user.post('/v1/events/batch').send({ events: [event()] }).expect(401);
    await h.http().post('/v1/events/batch').set('Authorization', 'Device tvd_invalidinvalidinvalidinvalid').send({ events: [event()] }).expect(401);
  });

  it('accepts events queued offline and marks them as delayed', async () => {
    const offline = event({ event_type: 'screen_unlocked', occurred_at: new Date(Date.now() - 3 * 3600_000).toISOString() });
    await upload(h, device, [offline]).expect(200);
    const res = await user.get('/v1/events').query({ event_type: 'screen_unlocked' }).expect(200);
    expect(res.body.items[0]).toMatchObject({ event_id: offline.event_id, delayed: true });
    expect(res.body.note).toMatch(/Delayed events/);
  });

  it('normalises time zones to UTC', async () => {
    const e = event({ event_type: 'screen_locked', occurred_at: '2026-10-21T08:30:00+01:00' });
    // occurred_at must be recent for the window check, so shift into range.
    const recent = new Date(Date.now() - 60_000);
    const local = new Date(recent.getTime() + 60 * 60_000).toISOString().replace('Z', '+01:00').replace(/\.\d{3}/, '');
    e.occurred_at = local;
    await upload(h, device, [e]).expect(200);
    const [row] = await h.sql<{ occurred_at: Date }>('SELECT occurred_at FROM activity_events WHERE event_id = $1', [e.event_id]);
    expect(Math.abs(row.occurred_at.getTime() - recent.getTime())).toBeLessThan(1000);
  });
});

describe('timeline search', () => {
  beforeAll(async () => {
    await upload(h, device, [
      event({ event_type: 'application_started', metadata: { application: 'Photoshop' } }),
      event({ event_type: 'security_setting_changed', severity: 'medium', metadata: { setting: 'firewall', new_value: false } }),
      ...Array.from({ length: 30 }, (_, i) => event({ event_type: 'file_modified', occurred_at: new Date(Date.now() - (i + 10) * 60_000).toISOString(), metadata: { path: `C:/docs/report-${i}.docx` } })),
    ]).expect(200);
  });

  it('searches metadata text', async () => {
    const res = await user.get('/v1/events').query({ q: 'photoshop' }).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].metadata.application).toBe('Photoshop');
  });

  it('filters by type, severity, device and date', async () => {
    const byType = await user.get('/v1/events').query({ event_type: 'security_setting_changed,user_login' }).expect(200);
    expect(new Set(byType.body.items.map((e: { event_type: string }) => e.event_type))).toEqual(new Set(['security_setting_changed', 'user_login']));
    const bySeverity = await user.get('/v1/events').query({ min_severity: 'medium' }).expect(200);
    expect(bySeverity.body.items.every((e: { severity: string }) => e.severity !== 'info')).toBe(true);
    const byDevice = await user.get('/v1/events').query({ device_id: device.id, limit: 1 }).expect(200);
    expect(byDevice.body.items[0].device_id).toBe(device.id);
    const future = await user.get('/v1/events').query({ from: new Date(Date.now() + 3600_000).toISOString() }).expect(200);
    expect(future.body.items).toHaveLength(0);
    await user.get('/v1/events').query({ event_type: 'drop_table' }).expect(400);
  });

  it('paginates with a stable cursor and no overlap', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await user.get('/v1/events').query({ event_type: 'file_modified', limit: 7, ...(cursor ? { cursor } : {}) }).expect(200);
      for (const e of res.body.items) {
        expect(seen.has(e.id)).toBe(false);
        seen.add(e.id);
      }
      cursor = res.body.next_cursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(seen.size).toBe(30);
    await user.get('/v1/events').query({ cursor: 'garbage' }).expect(400);
  });

  it('returns event details with surrounding context', async () => {
    const list = await user.get('/v1/events').query({ event_type: 'security_setting_changed' }).expect(200);
    const res = await user.get(`/v1/events/${list.body.items[0].id}`).expect(200);
    expect(res.body.event.event_type).toBe('security_setting_changed');
    expect(res.body.context.before.length + res.body.context.after.length).toBeGreaterThan(0);
    expect(res.body.related_alerts[0].title).toMatch(/firewall was turned off/);
  });

  it('exports authorized records as CSV with formula injection neutralised', async () => {
    await upload(h, device, [event({ metadata: { application: '=HYPERLINK("http://evil")' } })]).expect(200);
    const res = await user.get('/v1/events/export').query({ format: 'csv', q: 'hyperlink' }).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\n')[0]).toContain('occurred_at');
    expect(res.text).not.toMatch(/,"=HYPERLINK/);
    const audit = await h.sql(`SELECT 1 FROM audit_logs WHERE action = 'events.exported' AND actor_user_id = $1`, [user.id]);
    expect(audit.length).toBeGreaterThan(0);
  });

  it('returns activity statistics for the dashboard', async () => {
    const res = await user.get('/v1/dashboard').expect(200);
    expect(res.body.devices.registered).toBeGreaterThanOrEqual(1);
    expect(res.body.activity.series.length).toBeGreaterThan(0);
    const stats = await user.get('/v1/events/stats').query({ bucket: 'hour' }).expect(200);
    expect(stats.body.by_type.length).toBeGreaterThan(0);
  });
});

describe('alert rules', () => {
  it('flags a burst of failed sign-ins as likely, not confirmed', async () => {
    const now = Date.now();
    await upload(h, device, Array.from({ length: 5 }, (_, i) => event({ event_type: 'login_failed', severity: 'low', occurred_at: new Date(now - i * 30_000).toISOString() }))).expect(200);
    const res = await user.get('/v1/alerts').query({ status: 'open' }).expect(200);
    const burst = res.body.items.find((a: { rule: string }) => a.rule === 'repeated_failed_logins');
    expect(burst).toMatchObject({ confidence: 'likely', severity: 'medium' });
    expect(burst.evidence_event_ids).toHaveLength(5);
    expect(burst.explanation).toMatch(/can also be a mistyped password/);
  });

  it('flags new local accounts and resolves alerts with an audit trail', async () => {
    await upload(h, device, [event({ event_type: 'local_account_created', metadata: { account_name: 'support$' } })]).expect(200);
    const res = await user.get('/v1/alerts').query({ severity: 'high' }).expect(200);
    const alert = res.body.items.find((a: { rule: string }) => a.rule === 'local_account_created');
    expect(alert.confidence).toBe('confirmed');
    expect(alert.recommended_action).toBeTruthy();
    await user.post(`/v1/alerts/${alert.id}/resolve`).send({ note: 'It was me' }).expect(200);
    const after = await user.get(`/v1/alerts/${alert.id}`).expect(200);
    expect(after.body).toMatchObject({ status: 'resolved', resolution_note: 'It was me' });
  });

  it('reports repeated upload failures from heartbeats', async () => {
    await h
      .http()
      .post('/v1/devices/self/heartbeat')
      .set('Authorization', device.auth)
      .send({ monitoring_status: 'active', permissions: { security_log: 'granted' }, queued_events: 40, consecutive_upload_failures: 4, last_error: 'network unreachable' })
      .expect(200);
    const d = await user.get(`/v1/devices/${device.id}`).expect(200);
    expect(d.body.sync_status).toBe('failing');
    const alerts = await user.get('/v1/alerts').expect(200);
    expect(alerts.body.items.map((a: { rule: string }) => a.rule)).toContain('repeated_upload_failures');
  });
});

describe('revocation and recovery', () => {
  it('revoked device credentials stop working immediately', async () => {
    const d = await enrollDevice(h, user, { name: 'Lent laptop' });
    await upload(h, d, [event()]).expect(200);
    await user.post(`/v1/devices/${d.id}/revoke`).expect(200);
    await upload(h, d, [event()]).expect(401);
    const list = await user.get('/v1/devices').query({ status: 'revoked' }).expect(200);
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(d.id);
    // History uploaded before revocation is retained.
    const ev = await user.get('/v1/events').query({ device_id: d.id }).expect(200);
    expect(ev.body.items).toHaveLength(1);
  });

  it('credential rotation issues a new secret and expires the old one', async () => {
    const d = await enrollDevice(h, user, { name: 'Rotating' });
    const res = await h.http().post('/v1/devices/self/rotate-credential').set('Authorization', d.auth).expect(201);
    const fresh = { ...d, auth: `Device ${res.body.device_secret}` };
    await upload(h, fresh, [event()]).expect(200);
    await h.sql(`UPDATE device_credentials SET expires_at = now() - interval '1 second' WHERE device_id = $1 AND expires_at IS NOT NULL`, [d.id]);
    await upload(h, d, [event()]).expect(401);
  });

  it('report-lost revokes access and returns the recovery view', async () => {
    const d = await enrollDevice(h, user, { name: 'Stolen phone', platform: 'android' });
    await upload(h, d, [event({ event_type: 'screen_locked' })]).expect(200);
    const res = await user.post(`/v1/devices/${d.id}/report-lost`).expect(200);
    expect(res.body.recovery.device.status).toBe('revoked');
    expect(res.body.recovery.last_known_state.event_type).toBe('screen_locked');
    expect(res.body.recovery.official_links[0].url).toMatch(/google\.com\/android\/find/);
    expect(res.body.recovery.limitations).toMatch(/cannot locate, lock, unlock or erase/);
  });

  it('deleting a device removes its history', async () => {
    const d = await enrollDevice(h, user, { name: 'Temporary' });
    await upload(h, d, [event()]).expect(200);
    await user.del(`/v1/devices/${d.id}`).expect(200);
    const rows = await h.sql('SELECT 1 FROM activity_events WHERE device_id = $1', [d.id]);
    expect(rows).toHaveLength(0);
  });
});
