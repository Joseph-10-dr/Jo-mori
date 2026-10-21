import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  publicApiUrl: string;
  webOrigin: string;
  /** 32-byte key for AES-256-GCM field encryption (MFA secrets). */
  dataKey: Buffer;
  /** 32-byte key for HMAC-signing storage URLs. */
  urlSigningKey: Buffer;
  mailProvider: 'outbox' | 'resend';
  mailFrom: string;
  resendApiKey?: string;
  storageDir: string;
  devOutboxEnabled: boolean;
  billingSelfServe: boolean;
  backgroundJobs: boolean;
  sessionTtlHours: number;
}

const repoRoot = resolve(__dirname, '../../..');

function keyFromEnv(name: string, value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const buf = Buffer.from(value, 'base64');
  if (buf.length !== 32) throw new Error(`${name} must be 32 bytes, base64 encoded`);
  return buf;
}

/**
 * In development, generate keys once and keep them in var/dev-keys.json
 * (git-ignored). Production refuses to start without managed secrets.
 */
function devKeys(dir: string): { dataKey: Buffer; urlSigningKey: Buffer } {
  const file = resolve(dir, 'dev-keys.json');
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        TV_DATA_KEY: randomBytes(32).toString('base64'),
        TV_URL_SIGNING_KEY: randomBytes(32).toString('base64'),
      }),
      { mode: 0o600 },
    );
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return {
    dataKey: Buffer.from(parsed.TV_DATA_KEY, 'base64'),
    urlSigningKey: Buffer.from(parsed.TV_URL_SIGNING_KEY, 'base64'),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = (env.NODE_ENV as AppConfig['env']) || 'development';
  const varDir = resolve(env.TV_VAR_DIR || resolve(repoRoot, 'var'));
  let dataKey = keyFromEnv('TV_DATA_KEY', env.TV_DATA_KEY);
  let urlSigningKey = keyFromEnv('TV_URL_SIGNING_KEY', env.TV_URL_SIGNING_KEY);
  if (!dataKey || !urlSigningKey) {
    if (mode === 'production') {
      throw new Error('TV_DATA_KEY and TV_URL_SIGNING_KEY must be set in production');
    }
    const k = devKeys(varDir);
    dataKey ??= k.dataKey;
    urlSigningKey ??= k.urlSigningKey;
  }
  const mailProvider = (env.MAIL_PROVIDER as AppConfig['mailProvider']) || 'outbox';
  if (mode === 'production' && mailProvider === 'outbox') {
    throw new Error('MAIL_PROVIDER=outbox is for development only; configure a real mail provider');
  }
  const databaseUrl = env.DATABASE_URL || 'postgres://tracevault:tracevault@localhost:5432/tracevault';
  return {
    env: mode,
    port: Number(env.PORT || 4000),
    databaseUrl,
    publicApiUrl: env.PUBLIC_API_URL || 'http://localhost:4000',
    webOrigin: env.WEB_ORIGIN || 'http://localhost:3000',
    dataKey,
    urlSigningKey,
    mailProvider,
    mailFrom: env.MAIL_FROM || 'TraceVault <no-reply@localhost>',
    resendApiKey: env.RESEND_API_KEY,
    storageDir: resolve(env.STORAGE_DIR || resolve(varDir, 'object-storage')),
    devOutboxEnabled: mode !== 'production' && env.DEV_OUTBOX !== 'false',
    billingSelfServe: mode !== 'production' || env.BILLING_SELF_SERVE === 'true',
    backgroundJobs: env.BACKGROUND_JOBS !== 'false' && mode !== 'test',
    sessionTtlHours: Number(env.SESSION_TTL_HOURS || 24 * 7),
  };
}

export const CONFIG = Symbol('CONFIG');
