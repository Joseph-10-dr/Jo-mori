import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BatchResult, EVENT_TYPE_KEYS, validateEvents } from '@tracevault/event-schema';
import { z } from 'zod';
import { AlertEngine } from '../alerts/alert-engine.service';
import { AccessService } from '../common/access.service';
import { DeviceAuth, UserAuth } from '../common/auth-context';
import { decodeCursor, encodeCursor, SEVERITY_RANK } from '../common/pagination';
import { UsageService } from '../common/usage.service';
import { Db } from '../db/db.service';

export const eventFilterSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  device_id: z.string().uuid().optional(),
  organization_id: z.string().uuid().optional(),
  event_type: z
    .string()
    .max(1000)
    .optional()
    .transform((s) => (s ? s.split(',').filter(Boolean) : undefined))
    .pipe(z.array(z.enum(EVENT_TYPE_KEYS)).optional()),
  min_severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
  source: z.enum(['windows', 'macos', 'android', 'ios', 'web', 'simulator']).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
export type EventFilter = z.output<typeof eventFilterSchema>;

const EVENT_COLUMNS = `e.id, e.event_id, e.device_id, d.name AS device_name, e.organization_id, e.event_type, e.severity, e.source,
  e.occurred_at, e.received_at, e.metadata, e.schema_version,
  (e.received_at - e.occurred_at > interval '5 minutes') AS delayed`;

const DELAY_NOTE =
  'Delayed events were recorded on the device while it was offline (or its clock was wrong) and uploaded later. occurred_at is the device time; received_at is when the cloud stored it.';

@Injectable()
export class EventsService {
  private readonly logger = new Logger('Events');

  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly alerts: AlertEngine,
    private readonly usage: UsageService,
  ) {}

  async ingest(device: DeviceAuth, rawEvents: unknown[], bytes: number): Promise<BatchResult> {
    const { accepted, rejected } = validateEvents(rawEvents);
    let inserted: { id: string; event_id: string }[] = [];
    const receivedAt = new Date().toISOString();
    const dev = await this.db.tx(async (c) => {
      if (accepted.length) {
        // Owner and org come from the authenticated device row, never from the payload.
        inserted = await this.db.query<{ id: string; event_id: string }>(
          `INSERT INTO activity_events (event_id, device_id, owner_user_id, organization_id, event_type, severity, source,
              occurred_at, received_at, metadata, schema_version)
           SELECT r.event_id, $1, $2, $3, r.event_type, r.severity, r.source, r.occurred_at, $5, r.metadata, r.schema_version
             FROM jsonb_to_recordset($4::jsonb) AS r(event_id uuid, event_type text, severity text, source text,
                  occurred_at timestamptz, metadata jsonb, schema_version smallint)
           ON CONFLICT (device_id, event_id) DO NOTHING
           RETURNING id, event_id`,
          [device.deviceId, device.ownerUserId, device.organizationId, JSON.stringify(accepted), receivedAt],
          c,
        );
      }
      const d = await this.db.one<{ id: string; name: string; owner_user_id: string; organization_id: string | null }>(
        `UPDATE devices SET last_seen_at = now(), last_sync_at = now(), consecutive_sync_failures = 0, last_sync_error = NULL
          WHERE id = $1 RETURNING id, name, owner_user_id, organization_id`,
        [device.deviceId],
        c,
      );
      const scope = UsageService.scopeFor(device.ownerUserId, device.organizationId);
      await this.usage.add(scope, 'events_ingested', inserted.length, c);
      await this.usage.add(scope, 'ingest_bytes', bytes, c);
      return d!;
    });
    if (inserted.length) {
      const byEventId = new Map(inserted.map((r) => [r.event_id, r.id]));
      const fresh = accepted.filter((e) => byEventId.has(e.event_id)).map((e) => ({ ...e, id: byEventId.get(e.event_id)! }));
      // Runs after commit so notifications never reference rolled-back rows.
      await this.alerts.evaluate(dev, fresh).catch((err) => this.logger.error(`alert evaluation failed: ${(err as Error).message}`));
    }
    return {
      accepted: inserted.length,
      duplicates: accepted.length - inserted.length,
      rejected,
      received_at: receivedAt,
    };
  }

  private async buildWhere(user: UserAuth, f: EventFilter) {
    const scope = await this.access.scope(user.userId);
    const params: unknown[] = [scope.userId, scope.viewAllOrgIds];
    const where = [AccessService.visibleSql('e', 1, 2)];
    if (f.from) where.push(`e.occurred_at >= $${params.push(f.from)}`);
    if (f.to) where.push(`e.occurred_at < $${params.push(f.to)}`);
    if (f.device_id) where.push(`e.device_id = $${params.push(f.device_id)}`);
    if (f.organization_id) where.push(`e.organization_id = $${params.push(f.organization_id)}`);
    if (f.event_type?.length) where.push(`e.event_type = ANY($${params.push(f.event_type)}::text[])`);
    if (f.source) where.push(`e.source = $${params.push(f.source)}`);
    if (f.min_severity) {
      const allowed = Object.keys(SEVERITY_RANK).filter((s) => SEVERITY_RANK[s] >= SEVERITY_RANK[f.min_severity!]);
      where.push(`e.severity = ANY($${params.push(allowed)}::text[])`);
    }
    if (f.q) {
      const text = params.push(f.q);
      const like = params.push(f.q.replace(/[%_\\]/g, '\\$&'));
      where.push(`(e.search_text @@ plainto_tsquery('simple', $${text}) OR d.name ILIKE '%' || $${like} || '%')`);
    }
    return { where: where.join(' AND '), params };
  }

  async search(user: UserAuth, f: EventFilter) {
    const { where, params } = await this.buildWhere(user, f);
    const c = decodeCursor(f.cursor);
    let w = where;
    if (c) w += ` AND (e.occurred_at, e.id) < ($${params.push(c.ts)}::timestamptz, $${params.push(c.id)}::uuid)`;
    const rows = await this.db.query<{ id: string; occurred_at: Date }>(
      `SELECT ${EVENT_COLUMNS} FROM activity_events e JOIN devices d ON d.id = e.device_id
        WHERE ${w} ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${f.limit + 1}`,
      params,
    );
    const more = rows.length > f.limit;
    const items = rows.slice(0, f.limit);
    return {
      items,
      next_cursor: more ? encodeCursor(items[items.length - 1].occurred_at, items[items.length - 1].id) : null,
      note: DELAY_NOTE,
    };
  }

  async get(user: UserAuth, id: string) {
    const scope = await this.access.scope(user.userId);
    const e = await this.db.one<{ id: string; device_id: string; occurred_at: Date }>(
      `SELECT ${EVENT_COLUMNS} FROM activity_events e JOIN devices d ON d.id = e.device_id
        WHERE e.id = $3 AND ${AccessService.visibleSql('e', 1, 2)}`,
      [scope.userId, scope.viewAllOrgIds, id],
    );
    if (!e) throw new NotFoundException('Event not found');
    const [before, after, alerts] = await Promise.all([
      this.db.query(
        `SELECT id, event_type, severity, occurred_at FROM activity_events WHERE device_id = $1 AND (occurred_at, id) < ($2, $3)
          ORDER BY occurred_at DESC, id DESC LIMIT 5`,
        [e.device_id, e.occurred_at, e.id],
      ),
      this.db.query(
        `SELECT id, event_type, severity, occurred_at FROM activity_events WHERE device_id = $1 AND (occurred_at, id) > ($2, $3)
          ORDER BY occurred_at, id LIMIT 5`,
        [e.device_id, e.occurred_at, e.id],
      ),
      this.db.query(`SELECT id, title, severity, status FROM security_alerts WHERE $1 = ANY(evidence_event_ids)`, [e.id]),
    ]);
    return { event: e, context: { before: before.reverse(), after }, related_alerts: alerts, note: DELAY_NOTE };
  }

  async stats(user: UserAuth, f: EventFilter, bucket: 'hour' | 'day') {
    const { where, params } = await this.buildWhere(user, f);
    const series = await this.db.query(
      `SELECT date_trunc('${bucket}', e.occurred_at) AS bucket, count(*)::int AS total,
              count(*) FILTER (WHERE e.severity IN ('medium','high','critical'))::int AS notable
         FROM activity_events e JOIN devices d ON d.id = e.device_id
        WHERE ${where} GROUP BY 1 ORDER BY 1`,
      params,
    );
    const byType = await this.db.query(
      `SELECT e.event_type, count(*)::int AS n FROM activity_events e JOIN devices d ON d.id = e.device_id
        WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
      params,
    );
    return { bucket, series, by_type: byType };
  }

  async exportRows(user: UserAuth, f: EventFilter, max = 10_000) {
    const { where, params } = await this.buildWhere(user, f);
    return this.db.query<Record<string, unknown>>(
      `SELECT ${EVENT_COLUMNS} FROM activity_events e JOIN devices d ON d.id = e.device_id
        WHERE ${where} ORDER BY e.occurred_at DESC LIMIT ${max}`,
      params,
    );
  }
}
