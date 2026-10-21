import 'reflect-metadata';
import { INestApplication, LoggerService } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'pg';
import request from 'supertest';
import { createApp } from '../../apps/api/src/bootstrap';
import { AppConfig, loadConfig } from '../../apps/api/src/config';

export const TEST_DB =
  process.env.TEST_DATABASE_URL ||
  'postgres://tracevault:tracevault@localhost:5432/tracevault_test';
export const PASSWORD = 'correct-horse-battery-staple';

export interface Harness {
  app: INestApplication;
  config: AppConfig;
  http: () => ReturnType<typeof request>;
  sql: <T = Record<string, unknown>>(q: string, params?: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
}

/** Fresh schema per test file so suites are independent. */
export async function startHarness(
  opts: { logger?: LoggerService; env?: Record<string, string> } = {},
): Promise<Harness> {
  const admin = new Client({ connectionString: TEST_DB });
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  const varDir = mkdtempSync(join(tmpdir(), 'tracevault-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB,
    TV_VAR_DIR: varDir,
    PUBLIC_API_URL: 'http://127.0.0.1',
    ...opts.env,
  } as NodeJS.ProcessEnv);
  const app = await createApp(config, { logger: opts.logger ?? false });
  await app.init();
  const server = app.getHttpServer();
  return {
    app,
    config,
    http: () => request(server),
    sql: async (q, params = []) => (await admin.query(q, params)).rows,
    close: async () => {
      await app.close();
      await admin.end();
    },
  };
}

export interface TestUser {
  id: string;
  email: string;
  agent: ReturnType<typeof request.agent>;
  /** Cookie agent with the CSRF header applied for state-changing requests. */
  post: (url: string) => request.Test;
  put: (url: string) => request.Test;
  patch: (url: string) => request.Test;
  del: (url: string) => request.Test;
  get: (url: string) => request.Test;
}

export async function latestEmail(h: Harness, to: string, subjectIncludes: string) {
  const rows = await h.sql<{ body: string }>(
    `SELECT body FROM email_outbox WHERE to_email = $1 AND subject ILIKE '%' || $2 || '%' ORDER BY created_at DESC LIMIT 1`,
    [to, subjectIncludes],
  );
  return rows[0]?.body;
}

export function tokenFrom(body: string | undefined): string {
  const m = /token=([A-Za-z0-9_-]+)/.exec(body ?? '');
  if (!m) throw new Error('no token in email');
  return m[1];
}

export async function createUser(
  h: Harness,
  opts: { verify?: boolean; email?: string } = {},
): Promise<TestUser> {
  const email = opts.email ?? `user-${randomUUID().slice(0, 8)}@example.test`;
  const reg = await h.http().post('/v1/auth/register').send({ email, password: PASSWORD });
  if (reg.status !== 201)
    throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  if (opts.verify !== false) {
    const token = tokenFrom(await latestEmail(h, email, 'Verify'));
    await h.http().post('/v1/auth/verify-email').send({ token }).expect(200);
  }
  const agent = request.agent(h.app.getHttpServer());
  await agent.post('/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  const csrf = (t: request.Test) => t.set('x-tracevault-csrf', '1');
  return {
    id: reg.body.id,
    email,
    agent,
    get: (u) => agent.get(u),
    post: (u) => csrf(agent.post(u)),
    put: (u) => csrf(agent.put(u)),
    patch: (u) => csrf(agent.patch(u)),
    del: (u) => csrf(agent.delete(u)),
  };
}

export interface TestDevice {
  id: string;
  secret: string;
  auth: string;
}

export async function enrollDevice(
  h: Harness,
  user: TestUser,
  opts: { organizationId?: string; name?: string; platform?: string } = {},
): Promise<TestDevice> {
  const code = await user
    .post('/v1/devices/enrollment-codes')
    .send({ organization_id: opts.organizationId ?? null });
  if (code.status !== 201)
    throw new Error(`enrollment code failed: ${code.status} ${JSON.stringify(code.body)}`);
  const reg = await h
    .http()
    .post('/v1/devices/register')
    .send({
      enrollment_code: code.body.code,
      name: opts.name ?? 'Test laptop',
      platform: opts.platform ?? 'simulator',
      os_version: 'Test OS 1',
    });
  if (reg.status !== 201)
    throw new Error(`register device failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  return {
    id: reg.body.device_id,
    secret: reg.body.device_secret,
    auth: `Device ${reg.body.device_secret}`,
  };
}

export function event(over: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    event_type: 'application_started',
    occurred_at: new Date().toISOString(),
    source: 'simulator',
    severity: 'info',
    metadata: { application: 'browser' },
    schema_version: 1,
    ...over,
  };
}

export function upload(h: Harness, device: TestDevice, events: unknown[]) {
  return h.http().post('/v1/events/batch').set('Authorization', device.auth).send({ events });
}

/** Makes `user` an owner of a new org (MFA-enabled so admin actions are allowed). */
export async function createOrg(h: Harness, user: TestUser, name = 'Acme Ltd') {
  await enableMfa(user);
  const res = await user.post('/v1/organizations').send({ name }).expect(201);
  return res.body.id as string;
}

export async function enableMfa(user: TestUser) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const OTPAuth = require('otpauth');
  const setup = await user.post('/v1/auth/mfa/setup').expect(201);
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(setup.body.secret),
    digits: 6,
    period: 30,
  });
  await user.post('/v1/auth/mfa/enable').send({ code: totp.generate() }).expect(200);
  return totp as { generate: () => string };
}

export async function inviteAndJoin(
  h: Harness,
  owner: TestUser,
  orgId: string,
  role: string,
): Promise<TestUser> {
  const member = await createUser(h);
  await owner
    .post(`/v1/organizations/${orgId}/invitations`)
    .send({ email: member.email, role })
    .expect(201);
  const token = tokenFrom(await latestEmail(h, member.email, 'invited'));
  await member.post('/v1/invitations/accept').send({ token }).expect(200);
  return member;
}
