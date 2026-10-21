import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sha256 } from './crypto';
import { Db } from '../db/db.service';
import { AUTH_MODE, AuthedRequest, AuthMode, CSRF_HEADER, SESSION_COOKIE } from './auth-context';

/**
 * Global guard. Every route requires a signed-in user unless marked @Public()
 * or @DeviceOnly(). Cookie-authenticated state-changing requests must carry the
 * CSRF header, which browsers cannot add cross-origin without a CORS preflight.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: Db,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const mode =
      this.reflector.getAllAndOverride<AuthMode>(AUTH_MODE, [ctx.getHandler(), ctx.getClass()]) ??
      'user';
    if (mode === 'public') return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';

    if (mode === 'device') {
      const m = /^Device (tvd_[A-Za-z0-9_-]{20,})$/.exec(header);
      if (!m) throw new UnauthorizedException('Device credential required');
      const row = await this.db.one<{
        credential_id: string;
        device_id: string;
        owner_user_id: string;
        organization_id: string | null;
        platform: string;
      }>(
        `SELECT c.id AS credential_id, d.id AS device_id, d.owner_user_id, d.organization_id, d.platform
           FROM device_credentials c JOIN devices d ON d.id = c.device_id
          WHERE c.secret_hash = $1 AND c.revoked_at IS NULL
            AND (c.expires_at IS NULL OR c.expires_at > now())
            AND d.status = 'active'`,
        [sha256(m[1])],
      );
      if (!row) throw new UnauthorizedException('Device credential is invalid or revoked');
      await this.db.query('UPDATE device_credentials SET last_used_at = now() WHERE id = $1', [
        row.credential_id,
      ]);
      req.auth = {
        kind: 'device',
        deviceId: row.device_id,
        credentialId: row.credential_id,
        ownerUserId: row.owner_user_id,
        organizationId: row.organization_id,
        platform: row.platform,
      };
      return true;
    }

    let token: string | undefined;
    let viaCookie = false;
    const bearer = /^Bearer (tvs_[A-Za-z0-9_-]{20,})$/.exec(header);
    if (bearer) token = bearer[1];
    else if (typeof req.cookies?.[SESSION_COOKIE] === 'string') {
      token = req.cookies[SESSION_COOKIE];
      viaCookie = true;
    }
    if (!token) throw new UnauthorizedException('Sign in required');
    if (
      viaCookie &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.headers[CSRF_HEADER] !== '1'
    ) {
      throw new ForbiddenException('Missing CSRF header');
    }
    const s = await this.db.one<{
      session_id: string;
      user_id: string;
      email: string;
      email_verified_at: Date | null;
      mfa_enabled_at: Date | null;
      mfa_passed: boolean;
    }>(
      `UPDATE user_sessions s SET last_used_at = now()
         FROM users u
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.id = s.user_id AND u.deleted_at IS NULL
        RETURNING s.id AS session_id, u.id AS user_id, u.email, u.email_verified_at, u.mfa_enabled_at, s.mfa_passed`,
      [sha256(token)],
    );
    if (!s) throw new UnauthorizedException('Session expired or revoked');
    const mfaEnabled = !!s.mfa_enabled_at;
    if (mfaEnabled && !s.mfa_passed && mode !== 'mfa-pending') {
      throw new UnauthorizedException('Multifactor verification required');
    }
    req.auth = {
      kind: 'user',
      userId: s.user_id,
      sessionId: s.session_id,
      email: s.email,
      emailVerified: !!s.email_verified_at,
      mfaEnabled,
      mfaPassed: s.mfa_passed,
    };
    return true;
  }
}
