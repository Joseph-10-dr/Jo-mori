import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { verify } from '@node-rs/argon2';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../common/audit.service';
import { clientIp, CurrentUser, SESSION_COOKIE, UserAuth } from '../common/auth-context';
import { parse } from '../common/http';
import { UsageService } from '../common/usage.service';
import { Db } from '../db/db.service';
import { RecordingsService } from '../recordings/recordings.service';

const severity = z.enum(['info', 'low', 'medium', 'high', 'critical']);

@ApiTags('account')
@Controller('v1/account')
export class AccountController {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly recordings: RecordingsService,
  ) {}

  @Patch()
  async update(@CurrentUser() user: UserAuth, @Body() body: unknown) {
    const dto = parse(z.object({ display_name: z.string().trim().min(1).max(80).nullable() }).strict(), body);
    await this.db.query('UPDATE users SET display_name = $2 WHERE id = $1', [user.userId, dto.display_name]);
    return { ok: true };
  }

  @Get('notifications')
  async notifications(@CurrentUser() user: UserAuth) {
    return {
      items: await this.db.query(
        'SELECT channel, min_severity, enabled, login_alerts FROM notification_preferences WHERE user_id = $1 ORDER BY channel',
        [user.userId],
      ),
      note: 'Push notifications are delivered only to the native apps once they are released; email is active now.',
    };
  }

  @Put('notifications')
  async setNotifications(@CurrentUser() user: UserAuth, @Body() body: unknown) {
    const dto = parse(
      z
        .object({
          channel: z.enum(['email', 'push']),
          min_severity: severity,
          enabled: z.boolean(),
          login_alerts: z.boolean().default(true),
        })
        .strict(),
      body,
    );
    await this.db.query(
      `INSERT INTO notification_preferences (user_id, channel, min_severity, enabled, login_alerts) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, channel) DO UPDATE SET min_severity = EXCLUDED.min_severity, enabled = EXCLUDED.enabled, login_alerts = EXCLUDED.login_alerts`,
      [user.userId, dto.channel, dto.min_severity, dto.enabled, dto.login_alerts],
    );
    await this.audit.record({ action: 'account.notifications_changed', actorUserId: user.userId, subjectUserId: user.userId, details: dto });
    return dto;
  }

  @Get('retention')
  async retention(@CurrentUser() user: UserAuth) {
    const { plan, limits } = await this.usage.plan({ userId: user.userId, organizationId: null });
    const row = await this.db.one(
      'SELECT event_retention_days, recording_retention_days, updated_at FROM retention_policies WHERE user_id = $1',
      [user.userId],
    );
    return { ...row, plan, max_days: limits.retentionDaysMax };
  }

  @Put('retention')
  async setRetention(@CurrentUser() user: UserAuth, @Body() body: unknown) {
    const { limits } = await this.usage.plan({ userId: user.userId, organizationId: null });
    const dto = parse(
      z
        .object({
          event_retention_days: z.number().int().min(1).max(limits.retentionDaysMax),
          recording_retention_days: z.number().int().min(1).max(limits.retentionDaysMax),
        })
        .strict(),
      body,
    );
    await this.db.query(
      `UPDATE retention_policies SET event_retention_days = $2, recording_retention_days = $3, updated_at = now(), updated_by = $1 WHERE user_id = $1`,
      [user.userId, dto.event_retention_days, dto.recording_retention_days],
    );
    await this.audit.record({ action: 'account.retention_changed', actorUserId: user.userId, subjectUserId: user.userId, details: dto });
    return dto;
  }

  /**
   * Personal data export (JSON). Includes the account, personal devices, their
   * events and alerts, recording metadata (not media) and your audit history.
   */
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('export')
  @HttpCode(200)
  async export(@CurrentUser() user: UserAuth, @Req() req: Request, @Res() res: Response) {
    const id = user.userId;
    const [account, devices, events, alerts, recordings, memberships, audit] = await Promise.all([
      this.db.one('SELECT id, email, display_name, account_type, created_at, email_verified_at, mfa_enabled_at FROM users WHERE id = $1', [id]),
      this.db.query('SELECT id, name, platform, os_version, status, registered_at, last_seen_at, revoked_at, organization_id FROM devices WHERE owner_user_id = $1', [id]),
      this.db.query('SELECT id, event_id, device_id, event_type, severity, source, occurred_at, received_at, metadata FROM activity_events WHERE owner_user_id = $1 ORDER BY occurred_at', [id]),
      this.db.query('SELECT id, device_id, rule, title, severity, confidence, status, created_at, explanation FROM security_alerts WHERE owner_user_id = $1 ORDER BY created_at', [id]),
      this.db.query('SELECT id, device_id, kind, status, mime_type, size_bytes, started_at, stopped_at, expires_at FROM recordings WHERE owner_user_id = $1', [id]),
      this.db.query('SELECT organization_id, role, created_at FROM organization_members WHERE user_id = $1', [id]),
      this.db.query('SELECT occurred_at, action, target_type, target_id, details FROM audit_logs WHERE subject_user_id = $1 ORDER BY id', [id]),
    ]);
    await this.audit.record({ action: 'account.exported', actorUserId: id, subjectUserId: id, ip: clientIp(req), details: { events: events.length } });
    res.setHeader('Content-Disposition', `attachment; filename="tracevault-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({
      exported_at: new Date().toISOString(),
      notes: 'Recording media files are not included; download them individually from the Recordings page.',
      account,
      memberships,
      devices,
      activity_events: events,
      security_alerts: alerts,
      recordings,
      audit_history: audit,
    });
  }

  /** Permanently deletes the account and everything it owns. Requires the password. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Delete()
  async remove(@CurrentUser() user: UserAuth, @Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const dto = parse(z.object({ password: z.string().min(1).max(128), confirm: z.literal('DELETE') }).strict(), body);
    const u = await this.db.one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.userId]);
    if (!u || !(await verify(u.password_hash, dto.password).catch(() => false))) {
      throw new UnauthorizedException('Password is incorrect');
    }
    const ownedOrgs = await this.db.query<{ organization_id: string; others: number }>(
      `SELECT m.organization_id, (SELECT count(*)::int FROM organization_members x WHERE x.organization_id = m.organization_id AND x.user_id <> $1) AS others
         FROM organization_members m WHERE m.user_id = $1 AND m.role = 'owner'`,
      [user.userId],
    );
    if (ownedOrgs.some((o) => o.others > 0)) {
      throw new ConflictException('You own an organization with other members. Transfer ownership or remove members first.');
    }
    await this.recordings.deleteObjectsWhere('owner_user_id = $1', [user.userId]);
    await this.db.tx(async (c) => {
      for (const o of ownedOrgs) await this.db.query('DELETE FROM organizations WHERE id = $1', [o.organization_id], c);
      await this.db.query('DELETE FROM users WHERE id = $1', [user.userId], c);
      await this.audit.record({ action: 'account.deleted', actorUserId: user.userId, subjectUserId: user.userId, ip: clientIp(req) }, c);
    });
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }
}
