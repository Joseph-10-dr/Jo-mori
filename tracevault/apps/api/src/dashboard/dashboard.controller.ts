import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AccessService } from '../common/access.service';
import { CurrentUser, UserAuth } from '../common/auth-context';
import { parse } from '../common/http';
import { UsageService } from '../common/usage.service';
import { Db } from '../db/db.service';

/** One round-trip for the main dashboard cards. All numbers are scoped like every other read. */
@ApiTags('dashboard')
@Controller('v1/dashboard')
export class DashboardController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly usage: UsageService,
  ) {}

  @Get()
  async overview(@CurrentUser() user: UserAuth, @Query() q: unknown) {
    const { days } = parse(
      z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }),
      q,
    );
    const scope = await this.access.scope(user.userId);
    const p = [scope.userId, scope.viewAllOrgIds];
    const vis = (a: string) => AccessService.visibleSql(a, 1, 2);
    const [devices, alerts, recentAlerts, activity, recording, attention] = await Promise.all([
      this.db.one(
        `SELECT count(*) FILTER (WHERE d.status = 'active')::int AS registered,
                count(*) FILTER (WHERE d.status = 'active' AND d.last_seen_at > now() - interval '30 minutes')::int AS reporting,
                count(*) FILTER (WHERE d.status = 'active' AND d.consecutive_sync_failures >= 3)::int AS failing,
                max(d.last_sync_at) AS last_sync_at
           FROM devices d WHERE ${vis('d')}`,
        p,
      ),
      this.db.one(
        `SELECT count(*) FILTER (WHERE a.status = 'open')::int AS open,
                count(*) FILTER (WHERE a.status = 'open' AND a.severity IN ('high','critical'))::int AS open_high
           FROM security_alerts a WHERE ${vis('a')}`,
        p,
      ),
      this.db.query(
        `SELECT a.id, a.title, a.severity, a.confidence, a.status, a.created_at, d.name AS device_name
           FROM security_alerts a LEFT JOIN devices d ON d.id = a.device_id WHERE ${vis('a')} ORDER BY a.created_at DESC LIMIT 5`,
        p,
      ),
      this.db.query(
        `SELECT date_trunc('day', e.occurred_at) AS day, count(*)::int AS total,
                count(*) FILTER (WHERE e.severity IN ('medium','high','critical'))::int AS notable
           FROM activity_events e WHERE ${vis('e')} AND e.occurred_at > now() - make_interval(days => $3)
          GROUP BY 1 ORDER BY 1`,
        [...p, days],
      ),
      this.db.one(
        `SELECT count(*) FILTER (WHERE r.status = 'available')::int AS available,
                count(*) FILTER (WHERE r.status = 'pending_upload')::int AS uploading
           FROM recordings r WHERE r.owner_user_id = $1 AND r.status <> 'deleted'`,
        [user.userId],
      ),
      this.db.query(
        `SELECT d.id, d.name, d.monitoring_status, d.permissions, d.consecutive_sync_failures, d.last_seen_at
           FROM devices d WHERE ${vis('d')} AND d.status = 'active' AND (
             d.monitoring_status <> 'active' OR d.consecutive_sync_failures >= 3
             OR d.last_seen_at IS NULL OR d.last_seen_at < now() - interval '30 minutes'
             OR EXISTS (SELECT 1 FROM jsonb_each_text(d.permissions) WHERE value = 'denied'))
          LIMIT 20`,
        p,
      ),
    ]);
    const personal = { userId: user.userId, organizationId: null };
    return {
      devices,
      alerts: { ...alerts, recent: recentAlerts },
      activity: { days, series: activity },
      recordings: recording,
      storage: {
        recording_bytes_used: await this.usage.recordingBytesUsed(personal),
        plan: await this.usage.plan(personal),
      },
      needs_attention: attention,
      email_verified: user.emailVerified,
      mfa_enabled: user.mfaEnabled,
    };
  }
}
