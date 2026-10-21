import { createHash, createHmac } from 'crypto';
import { createOrg, createUser, enrollDevice, Harness, inviteAndJoin, startHarness, TestDevice, TestUser } from '../integration/helpers';

let h: Harness;
let owner: TestUser;
let device: TestDevice;
const media = Buffer.from('fake-webm-bytes-'.repeat(256));
const sha = createHash('sha256').update(media).digest('hex');

const consent = () => ({
  consenting_party: 'Device user',
  consent_text: 'Screen recording will start now. A red indicator is shown and you can stop at any time.',
  os_permission: 'granted',
  indicator_shown: true,
  consented_at: new Date().toISOString(),
});
const request = (over: Record<string, unknown> = {}) => ({
  kind: 'screen',
  mime_type: 'video/webm',
  size_bytes: media.length,
  sha256_hex: sha,
  started_at: new Date(Date.now() - 60_000).toISOString(),
  stopped_at: new Date().toISOString(),
  consent: consent(),
  ...over,
});
/** Signed URLs point at PUBLIC_API_URL; strip the origin to call the in-process app. */
const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');

beforeAll(async () => {
  h = await startHarness();
  owner = await createUser(h);
  device = await enrollDevice(h, owner);
});
afterAll(async () => h.close());

async function uploadRecording(d = device) {
  const ticket = await h.http().post('/v1/recordings/upload-url').set('Authorization', d.auth).send(request()).expect(201);
  await h.http().put(path(ticket.body.upload_url)).set('Content-Type', 'video/webm').send(media).expect(200);
  await h.http().post(`/v1/recordings/${ticket.body.recording_id}/complete`).set('Authorization', d.auth).expect(200);
  return ticket.body;
}

describe('recording permissions', () => {
  it('is unavailable on the free plan with a clear explanation', async () => {
    const res = await h.http().post('/v1/recordings/upload-url').set('Authorization', device.auth).send(request()).expect(403);
    expect(res.body.message).toMatch(/not included in the free plan/);
  });

  it('requires a granted OS permission and a visible indicator', async () => {
    await owner.post('/v1/billing/plan').send({ plan: 'personal' }).expect(201);
    const noIndicator = await h.http().post('/v1/recordings/upload-url').set('Authorization', device.auth).send(request({ consent: { ...consent(), indicator_shown: false } })).expect(403);
    expect(noIndicator.body.message).toMatch(/visible recording indicator/);
    await h.http().post('/v1/recordings/upload-url').set('Authorization', device.auth).send(request({ consent: { ...consent(), os_permission: 'denied' } })).expect(403);
  });

  it('enforces media type, duration limit and user session cannot request uploads', async () => {
    await h.http().post('/v1/recordings/upload-url').set('Authorization', device.auth).send(request({ mime_type: 'application/x-msdownload' })).expect(400);
    await h.http().post('/v1/recordings/upload-url').set('Authorization', device.auth).send(request({ started_at: new Date(Date.now() - 3 * 3600_000).toISOString() })).expect(400);
    await owner.post('/v1/recordings/upload-url').send(request()).expect(401);
  });
});

describe('upload and download', () => {
  let recordingId: string;

  it('stores the file encrypted outside the database and records consent', async () => {
    const t = await uploadRecording();
    recordingId = t.recording_id;
    const [rec] = await h.sql<{ status: string; size_bytes: string; storage_key: string }>('SELECT status, size_bytes, storage_key FROM recordings WHERE id = $1', [recordingId]);
    expect(rec.status).toBe('available');
    expect(Number(rec.size_bytes)).toBe(media.length);
    const fs = await import('fs');
    const onDisk = fs.readFileSync(`${h.config.storageDir}/${rec.storage_key}`);
    expect(onDisk.includes(Buffer.from('fake-webm-bytes'))).toBe(false); // encrypted at rest
    const [c] = await h.sql<{ indicator_shown: boolean }>('SELECT indicator_shown FROM recording_consents WHERE recording_id = $1', [recordingId]);
    expect(c.indicator_shown).toBe(true);
  });

  it('upload URLs are single use', async () => {
    const ticket = await h.http().post('/v1/recordings/upload-url').set('Authorization', device.auth).send(request()).expect(201);
    await h.http().put(path(ticket.body.upload_url)).set('Content-Type', 'video/webm').send(media).expect(200);
    await h.http().put(path(ticket.body.upload_url)).set('Content-Type', 'video/webm').send(media).expect(410);
  });

  it('expired upload URLs cannot be used, and tampered signatures are rejected', async () => {
    const ticket = await h.http().post('/v1/recordings/upload-url').set('Authorization', device.auth).send(request()).expect(201);
    const url = new URL(ticket.body.upload_url);
    const ticketId = url.pathname.split('/').pop()!;
    const pastExp = Math.floor(Date.now() / 1000) - 10;
    const sig = createHmac('sha256', h.config.urlSigningKey).update(`${ticketId}|upload|${pastExp}`).digest('base64url');
    await h.http().put(`/v1/storage/upload/${ticketId}?exp=${pastExp}&sig=${sig}`).set('Content-Type', 'video/webm').send(media).expect(410);
    const futureExp = Math.floor(Date.now() / 1000) + 3600; // extending expiry breaks the signature
    await h.http().put(`/v1/storage/upload/${ticketId}?exp=${futureExp}&sig=${url.searchParams.get('sig')}`).set('Content-Type', 'video/webm').send(media).expect(403);
    await h.sql(`UPDATE storage_tickets SET expires_at = now() - interval '1 second' WHERE id = $1`, [ticketId]);
    await h.http().put(path(ticket.body.upload_url)).set('Content-Type', 'video/webm').send(media).expect(410);
  });

  it('rejects uploads larger than declared and files that fail the integrity check', async () => {
    const big = await h.http().post('/v1/recordings/upload-url').set('Authorization', device.auth).send(request({ size_bytes: 100 })).expect(201);
    await h.http().put(path(big.body.upload_url)).set('Content-Type', 'video/webm').send(media).expect(413);
    const wrongHash = await h.http().post('/v1/recordings/upload-url').set('Authorization', device.auth).send(request({ sha256_hex: 'a'.repeat(64) })).expect(201);
    await h.http().put(path(wrongHash.body.upload_url)).set('Content-Type', 'video/webm').send(media).expect(200);
    const res = await h.http().post(`/v1/recordings/${wrongHash.body.recording_id}/complete`).set('Authorization', device.auth).expect(400);
    expect(res.body.message).toMatch(/does not match/);
  });

  it('owner downloads through a short-lived single-use link, and access is audited', async () => {
    const link = await owner.post(`/v1/recordings/${recordingId}/download-url`).expect(201);
    const file = await h.http().get(path(link.body.download_url)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect((file.body as Buffer).equals(media)).toBe(true);
    await h.http().get(path(link.body.download_url)).expect(410);
    const audit = await h.sql<{ action: string; sensitive: boolean }>(`SELECT action, sensitive FROM audit_logs WHERE target_id = $1 ORDER BY id`, [recordingId]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['recording.download_link_issued', 'recording.downloaded']));
    expect(audit.every((a) => a.sensitive)).toBe(true);
  });

  it('other users cannot list, download or delete the recording', async () => {
    const other = await createUser(h);
    const list = await other.get('/v1/recordings').expect(200);
    expect(list.body.items).toHaveLength(0);
    await other.post(`/v1/recordings/${recordingId}/download-url`).expect(404);
    await other.del(`/v1/recordings/${recordingId}`).expect(404);
  });

  it('deleting a recording removes the stored object', async () => {
    const t = await uploadRecording();
    const [rec] = await h.sql<{ storage_key: string }>('SELECT storage_key FROM recordings WHERE id = $1', [t.recording_id]);
    await owner.del(`/v1/recordings/${t.recording_id}`).expect(200);
    const fs = await import('fs');
    expect(fs.existsSync(`${h.config.storageDir}/${rec.storage_key}`)).toBe(false);
    await owner.post(`/v1/recordings/${t.recording_id}/download-url`).expect(404);
  });
});

describe('organization recordings', () => {
  it('business devices cannot record until the owner enables it, and analysts cannot view recordings', async () => {
    const orgOwner = await createUser(h);
    const org = await createOrg(h, orgOwner, 'Rec Org');
    const member = await inviteAndJoin(h, orgOwner, org, 'member');
    const d = await enrollDevice(h, member, { organizationId: org });
    const blocked = await h.http().post('/v1/recordings/upload-url').set('Authorization', d.auth).send(request()).expect(403);
    expect(blocked.body.message).toMatch(/has not enabled recordings/);
    await orgOwner.patch(`/v1/organizations/${org}`).send({ recordings_allowed: true }).expect(200);
    const t = await uploadRecording(d);
    const analyst = await inviteAndJoin(h, orgOwner, org, 'security_analyst');
    await analyst.post(`/v1/recordings/${t.recording_id}/download-url`).expect(403);
    // The org owner (with MFA) may access it, and that access is audited as sensitive.
    await orgOwner.post(`/v1/recordings/${t.recording_id}/download-url`).expect(201);
  });
});
