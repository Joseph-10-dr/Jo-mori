import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import * as OTPAuth from 'otpauth';
import { AppConfig, CONFIG } from '../config';
import { AuditService } from '../common/audit.service';
import { decrypt, encrypt, randomToken, sha256 } from '../common/crypto';
import { MailService } from '../common/mail.service';
import { Db } from '../db/db.service';

// Argon2id with OWASP-recommended minimums (19 MiB, t=2, p=1).
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;
// Precomputed hash so unknown-email logins cost the same as real ones.
let dummyHash: Promise<string> | undefined;

export interface SessionResult {
  token: string;
  expiresAt: Date;
  mfaRequired: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async register(input: {
    email: string;
    password: string;
    displayName?: string;
    accountType: 'personal' | 'business';
    ip: string | null;
  }) {
    const passwordHash = await hash(input.password, ARGON);
    const user = await this.db.tx(async (c) => {
      const existing = await this.db.one('SELECT 1 FROM users WHERE email = $1', [input.email], c);
      if (existing) throw new ConflictException('An account with this email already exists');
      const u = await this.db.one<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name, account_type) VALUES ($1,$2,$3,$4) RETURNING id`,
        [input.email, passwordHash, input.displayName ?? null, input.accountType],
        c,
      );
      await this.db.query(`INSERT INTO subscriptions (user_id, plan) VALUES ($1, 'free')`, [u!.id], c);
      await this.db.query(
        `INSERT INTO retention_policies (user_id, event_retention_days, recording_retention_days) VALUES ($1, 14, 7)`,
        [u!.id],
        c,
      );
      await this.db.query(
        `INSERT INTO notification_preferences (user_id, channel, min_severity) VALUES ($1, 'email', 'medium'), ($1, 'push', 'high')`,
        [u!.id],
        c,
      );
      await this.audit.record({ action: 'account.registered', actorUserId: u!.id, subjectUserId: u!.id, ip: input.ip }, c);
      return u!;
    });
    await this.sendVerification(user.id, input.email);
    return user;
  }

  async sendVerification(userId: string, email: string) {
    const token = await this.issueEmailToken(userId, 'verify_email', 24 * 60);
    await this.mail.send({
      to: email,
      subject: 'Verify your TraceVault email address',
      text: `Confirm your email to finish setting up TraceVault:\n\n${this.config.webOrigin}/verify-email?token=${token}\n\nThis link expires in 24 hours. If you did not create an account, ignore this email.`,
    });
  }

  private async issueEmailToken(userId: string, purpose: 'verify_email' | 'reset_password', minutes: number) {
    const token = randomToken('tve');
    // Only one live token per purpose.
    await this.db.query(
      `UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
      [userId, purpose],
    );
    await this.db.query(
      `INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)`,
      [userId, purpose, sha256(token), String(minutes)],
    );
    return token;
  }

  private async consumeEmailToken(token: string, purpose: 'verify_email' | 'reset_password') {
    const row = await this.db.one<{ user_id: string }>(
      `UPDATE email_tokens SET used_at = now()
        WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [sha256(token), purpose],
    );
    if (!row) throw new BadRequestException('This link is invalid or has expired');
    return row.user_id;
  }

  async verifyEmail(token: string) {
    const userId = await this.consumeEmailToken(token, 'verify_email');
    await this.db.query('UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [userId]);
    await this.audit.record({ action: 'account.email_verified', actorUserId: userId, subjectUserId: userId });
  }

  async login(input: { email: string; password: string; userAgent?: string; ip: string | null }): Promise<SessionResult> {
    const user = await this.db.one<{
      id: string;
      email: string;
      password_hash: string;
      mfa_enabled_at: Date | null;
      locked_until: Date | null;
    }>('SELECT id, email, password_hash, mfa_enabled_at, locked_until FROM users WHERE email = $1 AND deleted_at IS NULL', [
      input.email,
    ]);
    if (!user) {
      dummyHash ??= hash('not-a-real-password', ARGON);
      await verify(await dummyHash, input.password).catch(() => false);
      throw new UnauthorizedException('Email or password is incorrect');
    }
    if (user.locked_until && user.locked_until > new Date()) {
      throw new UnauthorizedException('Too many failed attempts. Try again later or reset your password.');
    }
    const ok = await verify(user.password_hash, input.password).catch(() => false);
    if (!ok) {
      await this.db.query(
        `UPDATE users SET failed_login_count = failed_login_count + 1,
           locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
         WHERE id = $1`,
        [user.id, MAX_FAILED_LOGINS, String(LOCK_MINUTES)],
      );
      await this.audit.record({ action: 'auth.login_failed', subjectUserId: user.id, ip: input.ip });
      throw new UnauthorizedException('Email or password is incorrect');
    }
    await this.db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);
    const knownAgent = await this.db.one(
      'SELECT 1 FROM user_sessions WHERE user_id = $1 AND user_agent IS NOT DISTINCT FROM $2 LIMIT 1',
      [user.id, input.userAgent ?? null],
    );
    const session = await this.createSession(user.id, !user.mfa_enabled_at, input.userAgent, input.ip);
    await this.audit.record({ action: 'auth.login', actorUserId: user.id, subjectUserId: user.id, ip: input.ip });
    if (!knownAgent) await this.notifyNewSignIn(user.id, user.email, input.userAgent, input.ip);
    return { ...session, mfaRequired: !!user.mfa_enabled_at };
  }

  private async notifyNewSignIn(userId: string, email: string, agent: string | undefined, ip: string | null) {
    const pref = await this.db.one<{ enabled: boolean; login_alerts: boolean }>(
      `SELECT enabled, login_alerts FROM notification_preferences WHERE user_id = $1 AND channel = 'email'`,
      [userId],
    );
    if (pref && (!pref.enabled || !pref.login_alerts)) return;
    await this.mail.send({
      to: email,
      subject: 'New sign-in to your TraceVault account',
      text: `Your TraceVault account was signed in to from a new browser or app.\n\nTime: ${new Date().toISOString()}\nIP address: ${ip ?? 'unknown'}\nApp: ${(agent ?? 'unknown').slice(0, 200)}\n\nIf this was not you, reset your password and sign out other sessions in Settings → Security.`,
    });
  }

  private async createSession(userId: string, mfaPassed: boolean, userAgent: string | undefined, ip: string | null) {
    const token = randomToken('tvs');
    const expiresAt = new Date(Date.now() + this.config.sessionTtlHours * 3600_000);
    await this.db.query(
      `INSERT INTO user_sessions (user_id, token_hash, mfa_passed, user_agent, ip, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, sha256(token), mfaPassed, userAgent?.slice(0, 300) ?? null, ip, expiresAt],
    );
    return { token, expiresAt };
  }

  async logout(sessionId: string) {
    await this.db.query('UPDATE user_sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
  }

  async forgotPassword(email: string) {
    const user = await this.db.one<{ id: string; email: string }>(
      'SELECT id, email FROM users WHERE email = $1 AND deleted_at IS NULL',
      [email],
    );
    if (!user) return; // same response either way: no account enumeration
    const token = await this.issueEmailToken(user.id, 'reset_password', 30);
    await this.mail.send({
      to: user.email,
      subject: 'Reset your TraceVault password',
      text: `Someone asked to reset your TraceVault password. If it was you, open:\n\n${this.config.webOrigin}/reset-password?token=${token}\n\nThe link expires in 30 minutes. If it was not you, you can ignore this email; your password has not changed.`,
    });
    await this.audit.record({ action: 'auth.password_reset_requested', subjectUserId: user.id });
  }

  async resetPassword(token: string, password: string) {
    const userId = await this.consumeEmailToken(token, 'reset_password');
    // Completing an emailed reset also proves control of the address.
    await this.setPassword(userId, password, undefined, true);
    await this.audit.record({ action: 'auth.password_reset', actorUserId: userId, subjectUserId: userId });
  }

  async changePassword(userId: string, current: string, next: string, keepSessionId: string) {
    const u = await this.db.one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!u || !(await verify(u.password_hash, current).catch(() => false))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.setPassword(userId, next, keepSessionId);
    await this.audit.record({ action: 'auth.password_changed', actorUserId: userId, subjectUserId: userId });
  }

  /** Changing the password revokes every other session. */
  private async setPassword(userId: string, password: string, keepSessionId?: string, markVerified = false) {
    await this.db.query(
      `UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL,
         email_verified_at = CASE WHEN $3 THEN coalesce(email_verified_at, now()) ELSE email_verified_at END
       WHERE id = $1`,
      [userId, await hash(password, ARGON), markVerified],
    );
    await this.db.query(
      'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2',
      [userId, keepSessionId ?? null],
    );
  }

  // ---- MFA (TOTP, RFC 6238) ----
  private totp(secret: OTPAuth.Secret, email: string) {
    return new OTPAuth.TOTP({ issuer: 'TraceVault', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret });
  }

  async mfaSetup(userId: string, email: string) {
    const u = await this.db.one<{ mfa_enabled_at: Date | null }>('SELECT mfa_enabled_at FROM users WHERE id = $1', [userId]);
    if (u?.mfa_enabled_at) throw new ConflictException('Multifactor authentication is already enabled');
    const secret = new OTPAuth.Secret({ size: 20 });
    await this.db.query('UPDATE users SET mfa_secret_enc = $2 WHERE id = $1', [userId, encrypt(this.config.dataKey, secret.base32)]);
    return { otpauth_url: this.totp(secret, email).toString(), secret: secret.base32 };
  }

  private async checkCode(userId: string, email: string, code: string): Promise<boolean> {
    const u = await this.db.one<{ mfa_secret_enc: string | null }>('SELECT mfa_secret_enc FROM users WHERE id = $1', [userId]);
    if (!u?.mfa_secret_enc) return false;
    const secret = OTPAuth.Secret.fromBase32(decrypt(this.config.dataKey, u.mfa_secret_enc));
    return this.totp(secret, email).validate({ token: code, window: 1 }) !== null;
  }

  async mfaEnable(userId: string, email: string, code: string, sessionId: string) {
    if (!(await this.checkCode(userId, email, code))) throw new BadRequestException('Code is incorrect');
    await this.db.query('UPDATE users SET mfa_enabled_at = now() WHERE id = $1', [userId]);
    // Current session is considered verified; all others must re-verify.
    await this.db.query('UPDATE user_sessions SET mfa_passed = (id = $2) WHERE user_id = $1', [userId, sessionId]);
    await this.audit.record({ action: 'auth.mfa_enabled', actorUserId: userId, subjectUserId: userId });
  }

  async mfaVerify(userId: string, email: string, code: string, sessionId: string) {
    if (!(await this.checkCode(userId, email, code))) {
      await this.audit.record({ action: 'auth.mfa_failed', subjectUserId: userId });
      throw new UnauthorizedException('Code is incorrect');
    }
    await this.db.query('UPDATE user_sessions SET mfa_passed = true WHERE id = $1', [sessionId]);
  }

  async mfaDisable(userId: string, email: string, code: string) {
    if (!(await this.checkCode(userId, email, code))) throw new BadRequestException('Code is incorrect');
    await this.db.query('UPDATE users SET mfa_enabled_at = NULL, mfa_secret_enc = NULL WHERE id = $1', [userId]);
    await this.audit.record({ action: 'auth.mfa_disabled', actorUserId: userId, subjectUserId: userId });
  }
}
