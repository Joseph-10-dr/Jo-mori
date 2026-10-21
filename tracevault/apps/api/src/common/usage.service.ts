import { Injectable } from '@nestjs/common';
import { PLAN_LIMITS, PlanId, PlanLimits } from '@tracevault/api-contracts';
import { Db, Queryable } from '../db/db.service';

export type UsageMetric =
  | 'events_ingested'
  | 'ingest_bytes'
  | 'recording_bytes_stored'
  | 'recording_bytes_downloaded'
  | 'summaries_generated';

export interface BillingScope {
  userId: string | null;
  organizationId: string | null;
}

@Injectable()
export class UsageService {
  constructor(private readonly db: Db) {}

  /** Usage is billed to the organization for business devices, otherwise to the user. */
  static scopeFor(ownerUserId: string, organizationId: string | null): BillingScope {
    return organizationId ? { userId: null, organizationId } : { userId: ownerUserId, organizationId: null };
  }

  async add(scope: BillingScope, metric: UsageMetric, quantity: number, client?: Queryable) {
    if (quantity === 0) return;
    const conflict = scope.organizationId
      ? '(organization_id, metric, period_day) WHERE organization_id IS NOT NULL'
      : '(user_id, metric, period_day) WHERE user_id IS NOT NULL';
    await this.db.query(
      `INSERT INTO usage_records (user_id, organization_id, metric, period_day, quantity)
       VALUES ($1, $2, $3, current_date, $4)
       ON CONFLICT ${conflict} DO UPDATE SET quantity = usage_records.quantity + EXCLUDED.quantity`,
      [scope.userId, scope.organizationId, metric, quantity],
      client,
    );
  }

  async plan(scope: BillingScope): Promise<{ plan: PlanId; limits: PlanLimits; status: string }> {
    const row = await this.db.one<{ plan: PlanId; status: string }>(
      scope.organizationId
        ? 'SELECT plan, status FROM subscriptions WHERE organization_id = $1'
        : 'SELECT plan, status FROM subscriptions WHERE user_id = $1',
      [scope.organizationId ?? scope.userId],
    );
    const plan = row?.plan ?? 'free';
    return { plan, limits: PLAN_LIMITS[plan], status: row?.status ?? 'active' };
  }

  async recordingBytesUsed(scope: BillingScope): Promise<number> {
    const row = await this.db.one<{ total: string }>(
      scope.organizationId
        ? `SELECT coalesce(sum(coalesce(size_bytes, declared_bytes)),0) AS total FROM recordings
            WHERE organization_id = $1 AND status IN ('pending_upload','available')`
        : `SELECT coalesce(sum(coalesce(size_bytes, declared_bytes)),0) AS total FROM recordings
            WHERE owner_user_id = $1 AND organization_id IS NULL AND status IN ('pending_upload','available')`,
      [scope.organizationId ?? scope.userId],
    );
    return Number(row?.total ?? 0);
  }
}
