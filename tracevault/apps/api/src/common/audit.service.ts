import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { Db, Queryable } from '../db/db.service';

export interface AuditEntry {
  action: string;
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  organizationId?: string | null;
  subjectUserId?: string | null;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  /** Never put secrets, tokens or recording contents here. */
  details?: Record<string, unknown>;
  sensitive?: boolean;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: Db) {}

  /**
   * Append to the hash-chained audit log. A transaction-scoped advisory lock
   * serialises writers so each row links to its predecessor; tampering with a
   * past row breaks the chain (see verifyChain).
   */
  async record(entry: AuditEntry, client?: Queryable): Promise<void> {
    const run = async (c: Queryable) => {
      await c.query('SELECT pg_advisory_xact_lock(727275)');
      const prev = await c.query<{ row_hash: Buffer }>('SELECT row_hash FROM audit_logs ORDER BY id DESC LIMIT 1');
      const prevHash = prev.rows[0]?.row_hash ?? null;
      const occurredAt = new Date().toISOString();
      const body = AuditService.canonical(entry, occurredAt);
      const rowHash = createHash('sha256')
        .update(prevHash ?? Buffer.alloc(0))
        .update(body)
        .digest();
      await c.query(
        `INSERT INTO audit_logs (occurred_at, actor_user_id, actor_device_id, organization_id, subject_user_id,
           action, target_type, target_id, ip, details, sensitive, prev_hash, row_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          occurredAt,
          entry.actorUserId ?? null,
          entry.actorDeviceId ?? null,
          entry.organizationId ?? null,
          entry.subjectUserId ?? null,
          entry.action,
          entry.targetType ?? null,
          entry.targetId ?? null,
          entry.ip ?? null,
          JSON.stringify(entry.details ?? {}),
          entry.sensitive ?? false,
          prevHash,
          rowHash,
        ],
      );
    };
    if (client) return run(client);
    return this.db.tx(run);
  }

  /** Key-sorted JSON so the hash survives jsonb's key reordering. */
  static stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((v) => AuditService.stable(v)).join(',')}]`;
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${AuditService.stable(v)}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
  }

  static canonical(e: AuditEntry, occurredAt: string): string {
    return AuditService.stable([
      occurredAt,
      e.actorUserId ?? null,
      e.actorDeviceId ?? null,
      e.organizationId ?? null,
      e.subjectUserId ?? null,
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      e.ip ?? null,
      e.details ?? {},
      e.sensitive ?? false,
    ]);
  }

  /** Recompute the chain; returns the first broken row id, or null if intact. */
  async verifyChain(): Promise<{ ok: boolean; checked: number; brokenAt: string | null }> {
    const rows = await this.db.query<{
      id: string;
      occurred_at: Date;
      actor_user_id: string | null;
      actor_device_id: string | null;
      organization_id: string | null;
      subject_user_id: string | null;
      action: string;
      target_type: string | null;
      target_id: string | null;
      ip: string | null;
      details: Record<string, unknown>;
      sensitive: boolean;
      prev_hash: Buffer | null;
      row_hash: Buffer;
    }>('SELECT * FROM audit_logs ORDER BY id');
    let prev: Buffer | null = rows[0]?.prev_hash ?? null; // retention may have purged older rows
    for (const r of rows) {
      const body = AuditService.canonical(
        {
          action: r.action,
          actorUserId: r.actor_user_id,
          actorDeviceId: r.actor_device_id,
          organizationId: r.organization_id,
          subjectUserId: r.subject_user_id,
          targetType: r.target_type ?? undefined,
          targetId: r.target_id ?? undefined,
          ip: r.ip,
          details: r.details,
          sensitive: r.sensitive,
        },
        r.occurred_at.toISOString(),
      );
      const expect = createHash('sha256')
        .update(prev ?? Buffer.alloc(0))
        .update(body)
        .digest();
      if (!expect.equals(r.row_hash) || !(prev ?? Buffer.alloc(0)).equals(r.prev_hash ?? Buffer.alloc(0))) {
        return { ok: false, checked: rows.length, brokenAt: r.id };
      }
      prev = r.row_hash;
    }
    return { ok: true, checked: rows.length, brokenAt: null };
  }
}
