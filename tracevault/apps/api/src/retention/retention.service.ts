import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { AuditService } from '../common/audit.service';
import { Db } from '../db/db.service';
import { RecordingsService } from '../recordings/recordings.service';

export interface PurgeReport {
  events: number;
  recordings: number;
  audit_logs: number;
  sessions: number;
  tokens: number;
  outbox: number;
  pending_uploads: number;
}

/**
 * Applies retention policies hourly. Events and recordings use the policy of
 * their scope (organization for business devices, otherwise the owner).
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Retention');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    private readonly recordings: RecordingsService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    if (!this.config.backgroundJobs) return;
    this.timer = setInterval(() => {
      this.purge().catch((err) => this.logger.error(`purge failed: ${(err as Error).message}`));
    }, 3600_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async purge(now: Date = new Date()): Promise<PurgeReport> {
    const events = await this.db.query(
      `DELETE FROM activity_events e USING retention_policies p
        WHERE ((e.organization_id IS NOT NULL AND p.organization_id = e.organization_id)
            OR (e.organization_id IS NULL AND p.user_id = e.owner_user_id))
          AND e.occurred_at < $1::timestamptz - make_interval(days => p.event_retention_days)
        RETURNING e.id`,
      [now],
    );

    const expiredSql = `status IN ('available','failed','pending_upload') AND expires_at < $1`;
    const expiredIds = await this.recordings.deleteObjectsWhere(expiredSql, [now]);
    if (expiredIds.length) {
      await this.db.query(
        `UPDATE recordings SET status = 'deleted', deleted_at = $2 WHERE id = ANY($1::uuid[])`,
        [expiredIds, now],
      );
    }
    // Abandoned uploads (no completion within a day) are removed too.
    const stale = await this.recordings.deleteObjectsWhere(
      `status = 'pending_upload' AND created_at < $1::timestamptz - interval '1 day'`,
      [now],
    );
    if (stale.length)
      await this.db.query(`UPDATE recordings SET status = 'failed' WHERE id = ANY($1::uuid[])`, [
        stale,
      ]);

    const auditRows = await this.db.tx(async (c) => {
      await c.query(`SET LOCAL tracevault.allow_audit_purge = 'on'`);
      const r = await c.query(
        `DELETE FROM audit_logs a WHERE a.occurred_at < $1::timestamptz - make_interval(days =>
           coalesce((SELECT audit_retention_days FROM retention_policies p WHERE p.organization_id = a.organization_id), 365))
         RETURNING id`,
        [now],
      );
      return r.rowCount ?? 0;
    });

    const sessions = await this.db.query(
      `DELETE FROM user_sessions WHERE expires_at < $1 OR revoked_at < $1::timestamptz - interval '30 days' RETURNING id`,
      [now],
    );
    const tokens = await this.db.query(
      `DELETE FROM email_tokens WHERE expires_at < $1::timestamptz - interval '1 day' RETURNING id`,
      [now],
    );
    const outbox = await this.db.query(
      `DELETE FROM email_outbox WHERE created_at < $1::timestamptz - interval '7 days' RETURNING id`,
      [now],
    );
    await this.db.query(
      `DELETE FROM storage_tickets WHERE expires_at < $1::timestamptz - interval '1 day'`,
      [now],
    );
    await this.db.query(
      `DELETE FROM device_enrollment_codes WHERE expires_at < $1::timestamptz - interval '1 day'`,
      [now],
    );

    const report: PurgeReport = {
      events: events.length,
      recordings: expiredIds.length,
      audit_logs: auditRows,
      sessions: sessions.length,
      tokens: tokens.length,
      outbox: outbox.length,
      pending_uploads: stale.length,
    };
    if (report.events || report.recordings || report.audit_logs) {
      await this.audit.record({ action: 'retention.purged', details: { ...report } });
    }
    return report;
  }
}
