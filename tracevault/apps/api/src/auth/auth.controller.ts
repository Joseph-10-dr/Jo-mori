import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../config';
import {
  AllowMfaPending,
  clientIp,
  CurrentUser,
  Public,
  SESSION_COOKIE,
  UserAuth,
} from '../common/auth-context';
import { parse, uuidParam } from '../common/http';
import { Db } from '../db/db.service';
import { AuthService } from './auth.service';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128)
  .refine((p) => new Set(p).size >= 5, 'Password is too repetitive');
const totpCode = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

const strictLimit = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private setCookie(res: Response, token: string, expiresAt: Date) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.env === 'production',
      expires: expiresAt,
      path: '/',
    });
  }

  @Public()
  @Throttle(strictLimit)
  @Post('register')
  async register(@Body() body: unknown, @Req() req: Request) {
    const dto = parse(
      z.object({
        email,
        password,
        display_name: z.string().trim().min(1).max(80).optional(),
        account_type: z.enum(['personal', 'business']).default('personal'),
      }),
      body,
    );
    const user = await this.auth.register({
      email: dto.email,
      password: dto.password,
      displayName: dto.display_name,
      accountType: dto.account_type,
      ip: clientIp(req),
    });
    return { id: user.id, message: 'Account created. Check your email to verify your address.' };
  }

  @Public()
  @Throttle(strictLimit)
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const dto = parse(z.object({ email, password: z.string().min(1).max(128) }), body);
    const s = await this.auth.login({
      email: dto.email,
      password: dto.password,
      userAgent: req.headers['user-agent'],
      ip: clientIp(req),
    });
    this.setCookie(res, s.token, s.expiresAt);
    // Browsers rely on the httpOnly cookie; the raw token is only returned to
    // non-browser clients (CLI, native apps) that ask for it explicitly.
    const wantsToken = req.headers['x-tracevault-client'] === 'native';
    return {
      mfa_required: s.mfaRequired,
      expires_at: s.expiresAt.toISOString(),
      ...(wantsToken ? { token: s.token } : {}),
    };
  }

  @AllowMfaPending()
  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentUser() user: UserAuth, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(user.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @AllowMfaPending()
  @Get('me')
  async me(@CurrentUser() user: UserAuth) {
    const u = await this.db.one(
      `SELECT u.id, u.email, u.display_name, u.account_type, u.created_at,
              u.email_verified_at IS NOT NULL AS email_verified,
              u.mfa_enabled_at IS NOT NULL AS mfa_enabled,
              coalesce(s.plan, 'free') AS plan
         FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id WHERE u.id = $1`,
      [user.userId],
    );
    const memberships = await this.db.query(
      `SELECT m.organization_id, o.name AS organization_name, m.role
         FROM organization_members m JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 ORDER BY o.name`,
      [user.userId],
    );
    return { user: u, memberships, mfa_pending: user.mfaEnabled && !user.mfaPassed };
  }

  @Public()
  @Throttle(strictLimit)
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Body() body: unknown) {
    const dto = parse(z.object({ token: z.string().min(10).max(200) }), body);
    await this.auth.verifyEmail(dto.token);
    return { ok: true };
  }

  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('verify-email/resend')
  @HttpCode(202)
  async resend(@CurrentUser() user: UserAuth) {
    if (!user.emailVerified) await this.auth.sendVerification(user.userId, user.email);
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password/forgot')
  @HttpCode(202)
  async forgot(@Body() body: unknown) {
    const dto = parse(z.object({ email }), body);
    await this.auth.forgotPassword(dto.email);
    return { message: 'If an account exists for that email, a reset link has been sent.' };
  }

  @Public()
  @Throttle(strictLimit)
  @Post('password/reset')
  @HttpCode(200)
  async reset(@Body() body: unknown) {
    const dto = parse(z.object({ token: z.string().min(10).max(200), password }), body);
    await this.auth.resetPassword(dto.token, dto.password);
    return { ok: true };
  }

  @Throttle(strictLimit)
  @Post('password/change')
  @HttpCode(200)
  async change(@CurrentUser() user: UserAuth, @Body() body: unknown) {
    const dto = parse(z.object({ current_password: z.string().min(1).max(128), new_password: password }), body);
    await this.auth.changePassword(user.userId, dto.current_password, dto.new_password, user.sessionId);
    return { ok: true };
  }

  @Post('mfa/setup')
  async mfaSetup(@CurrentUser() user: UserAuth) {
    return this.auth.mfaSetup(user.userId, user.email);
  }

  @Throttle(strictLimit)
  @Post('mfa/enable')
  @HttpCode(200)
  async mfaEnable(@CurrentUser() user: UserAuth, @Body() body: unknown) {
    const dto = parse(z.object({ code: totpCode }), body);
    await this.auth.mfaEnable(user.userId, user.email, dto.code, user.sessionId);
    return { ok: true };
  }

  @AllowMfaPending()
  @Throttle(strictLimit)
  @Post('mfa/verify')
  @HttpCode(200)
  async mfaVerify(@CurrentUser() user: UserAuth, @Body() body: unknown) {
    const dto = parse(z.object({ code: totpCode }), body);
    await this.auth.mfaVerify(user.userId, user.email, dto.code, user.sessionId);
    return { ok: true };
  }

  @Throttle(strictLimit)
  @Post('mfa/disable')
  @HttpCode(200)
  async mfaDisable(@CurrentUser() user: UserAuth, @Body() body: unknown) {
    const dto = parse(z.object({ code: totpCode }), body);
    await this.auth.mfaDisable(user.userId, user.email, dto.code);
    return { ok: true };
  }

  @Get('sessions')
  async sessions(@CurrentUser() user: UserAuth) {
    const rows = await this.db.query(
      `SELECT id, user_agent, host(ip) AS ip, created_at, last_used_at, expires_at, (id = $2) AS current
         FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY last_used_at DESC`,
      [user.userId, user.sessionId],
    );
    return { items: rows };
  }

  @Delete('sessions/:id')
  async revokeSession(@CurrentUser() user: UserAuth, @Param('id') id: string) {
    const sid = parse(uuidParam, id);
    const row = await this.db.one(
      'UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
      [sid, user.userId],
    );
    if (!row) throw new NotFoundException('Session not found');
    return { ok: true };
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  async revokeOthers(@CurrentUser() user: UserAuth) {
    const rows = await this.db.query(
      'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL RETURNING id',
      [user.userId, user.sessionId],
    );
    return { revoked: rows.length };
  }
}
