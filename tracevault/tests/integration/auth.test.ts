import request from 'supertest';
import {
  createUser,
  enableMfa,
  Harness,
  latestEmail,
  PASSWORD,
  startHarness,
  tokenFrom,
} from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

describe('registration and login', () => {
  it('registers, sends a verification email, and stores only an argon2 hash', async () => {
    const res = await h
      .http()
      .post('/v1/auth/register')
      .send({ email: 'Alice@Example.test', password: PASSWORD })
      .expect(201);
    const [row] = await h.sql<{
      email: string;
      password_hash: string;
      email_verified_at: Date | null;
    }>('SELECT email, password_hash, email_verified_at FROM users WHERE id = $1', [res.body.id]);
    expect(row.email).toBe('alice@example.test');
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain(PASSWORD);
    expect(row.email_verified_at).toBeNull();
    expect(await latestEmail(h, 'alice@example.test', 'Verify')).toContain('/verify-email?token=');
  });

  it('rejects duplicate emails, weak passwords and malformed input', async () => {
    await h
      .http()
      .post('/v1/auth/register')
      .send({ email: 'alice@example.test', password: PASSWORD })
      .expect(409);
    await h
      .http()
      .post('/v1/auth/register')
      .send({ email: 'bob@example.test', password: 'short' })
      .expect(400);
    await h
      .http()
      .post('/v1/auth/register')
      .send({ email: 'not-an-email', password: PASSWORD })
      .expect(400);
  });

  it('verifies email with a single-use token', async () => {
    const token = tokenFrom(await latestEmail(h, 'alice@example.test', 'Verify'));
    await h.http().post('/v1/auth/verify-email').send({ token }).expect(200);
    await h.http().post('/v1/auth/verify-email').send({ token }).expect(400);
  });

  it('logs in with an httpOnly cookie and returns the profile', async () => {
    const agent = request.agent(h.app.getHttpServer());
    const login = await agent
      .post('/v1/auth/login')
      .send({ email: 'alice@example.test', password: PASSWORD })
      .expect(200);
    expect(login.body.token).toBeUndefined(); // browsers never see the raw token
    expect(String(login.headers['set-cookie'])).toMatch(/tv_session=.*HttpOnly/i);
    const me = await agent.get('/v1/auth/me').expect(200);
    expect(me.body.user).toMatchObject({
      email: 'alice@example.test',
      email_verified: true,
      plan: 'free',
    });
  });

  it('returns a bearer token only to native clients', async () => {
    const res = await h
      .http()
      .post('/v1/auth/login')
      .set('x-tracevault-client', 'native')
      .send({ email: 'alice@example.test', password: PASSWORD })
      .expect(200);
    expect(res.body.token).toMatch(/^tvs_/);
    await h.http().get('/v1/auth/me').set('Authorization', `Bearer ${res.body.token}`).expect(200);
  });

  it('gives the same error for unknown email and wrong password', async () => {
    const a = await h
      .http()
      .post('/v1/auth/login')
      .send({ email: 'nobody@example.test', password: PASSWORD })
      .expect(401);
    const b = await h
      .http()
      .post('/v1/auth/login')
      .send({ email: 'alice@example.test', password: 'wrong-password-123' })
      .expect(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('requires the CSRF header for cookie-authenticated writes', async () => {
    const u = await createUser(h);
    await u.agent.post('/v1/devices/enrollment-codes').send({}).expect(403);
    await u.post('/v1/devices/enrollment-codes').send({}).expect(201);
  });

  it('blocks unverified users from enrolling devices', async () => {
    const u = await createUser(h, { verify: false });
    const res = await u.post('/v1/devices/enrollment-codes').send({}).expect(403);
    expect(res.body.message).toMatch(/Verify your email/);
  });
});

describe('sessions', () => {
  it('logout revokes the session server-side', async () => {
    const u = await createUser(h);
    await u.get('/v1/auth/me').expect(200);
    await u.post('/v1/auth/logout').expect(200);
    const [row] = await h.sql<{ n: number }>(
      'SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [u.id],
    );
    expect(row.n).toBe(0);
    await u.get('/v1/auth/me').expect(401);
  });

  it('lists sessions and revokes another one', async () => {
    const u = await createUser(h);
    const other = request.agent(h.app.getHttpServer());
    await other
      .post('/v1/auth/login')
      .set('user-agent', 'second-device')
      .send({ email: u.email, password: PASSWORD })
      .expect(200);
    const list = await u.get('/v1/auth/sessions').expect(200);
    expect(list.body.items).toHaveLength(2);
    const target = list.body.items.find((s: { current: boolean }) => !s.current);
    await u.del(`/v1/auth/sessions/${target.id}`).expect(200);
    await other.get('/v1/auth/me').expect(401);
    await u.get('/v1/auth/me').expect(200);
  });

  it('cannot revoke another user’s session by id', async () => {
    const a = await createUser(h);
    const b = await createUser(h);
    const [s] = await h.sql<{ id: string }>(
      'SELECT id FROM user_sessions WHERE user_id = $1 LIMIT 1',
      [b.id],
    );
    await a.del(`/v1/auth/sessions/${s.id}`).expect(404);
    await b.get('/v1/auth/me').expect(200);
  });
});

describe('password reset', () => {
  it('resets with an emailed token and revokes existing sessions', async () => {
    const u = await createUser(h);
    await h.http().post('/v1/auth/password/forgot').send({ email: u.email }).expect(202);
    // Unknown emails get the same response.
    await h
      .http()
      .post('/v1/auth/password/forgot')
      .send({ email: 'ghost@example.test' })
      .expect(202);
    const token = tokenFrom(await latestEmail(h, u.email, 'Reset'));
    await h
      .http()
      .post('/v1/auth/password/reset')
      .send({ token, password: 'a-brand-new-passphrase' })
      .expect(200);
    await u.get('/v1/auth/me').expect(401);
    await h.http().post('/v1/auth/login').send({ email: u.email, password: PASSWORD }).expect(401);
    await h
      .http()
      .post('/v1/auth/login')
      .send({ email: u.email, password: 'a-brand-new-passphrase' })
      .expect(200);
    await h
      .http()
      .post('/v1/auth/password/reset')
      .send({ token, password: 'another-passphrase-9' })
      .expect(400);
  });
});

describe('multifactor authentication', () => {
  it('requires a TOTP code after password login once enabled', async () => {
    const u = await createUser(h);
    const totp = await enableMfa(u);
    const agent = request.agent(h.app.getHttpServer());
    const login = await agent
      .post('/v1/auth/login')
      .send({ email: u.email, password: PASSWORD })
      .expect(200);
    expect(login.body.mfa_required).toBe(true);
    await agent.get('/v1/devices').expect(401);
    const me = await agent.get('/v1/auth/me').expect(200);
    expect(me.body.mfa_pending).toBe(true);
    await agent
      .post('/v1/auth/mfa/verify')
      .set('x-tracevault-csrf', '1')
      .send({ code: '000000' })
      .expect(401);
    await agent
      .post('/v1/auth/mfa/verify')
      .set('x-tracevault-csrf', '1')
      .send({ code: totp.generate() })
      .expect(200);
    await agent.get('/v1/devices').expect(200);
    const [row] = await h.sql<{ mfa_secret_enc: string }>(
      'SELECT mfa_secret_enc FROM users WHERE id = $1',
      [u.id],
    );
    expect(row.mfa_secret_enc).not.toMatch(/^[A-Z2-7]+=*$/); // stored encrypted, not as base32
  });
});

describe('account lockout and rate limits', () => {
  it('locks the account after repeated failures', async () => {
    const u = await createUser(h);
    await h.sql('UPDATE users SET failed_login_count = 9 WHERE id = $1', [u.id]);
    await h
      .http()
      .post('/v1/auth/login')
      .send({ email: u.email, password: 'wrong-password-123' })
      .expect(401);
    const res = await h
      .http()
      .post('/v1/auth/login')
      .send({ email: u.email, password: PASSWORD })
      .expect(401);
    expect(res.body.message).toMatch(/Too many failed attempts/);
  });
});
