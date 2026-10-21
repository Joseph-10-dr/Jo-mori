import { Body, Controller, ForbiddenException, Get, Inject, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PLAN_IDS, PLAN_LIMITS } from '@tracevault/api-contracts';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../config';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, UserAuth } from '../common/auth-context';
import { parse } from '../common/http';
import { UsageService } from '../common/usage.service';
import { Db } from '../db/db.service';

@ApiTags('billing')
@Controller('v1/billing')
export class BillingController {
  constructor(
    private readonly db: Db,
    private readonly usage: UsageService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  async summary(@CurrentUser() user: UserAuth, @Query() q: unknown) {
    const f = parse(z.object({ organization_id: z.string().uuid().optional(), region: z.string().regex(/^[A-Z]{2}$/).optional() }), q);
    if (f.organization_id) await this.access.requireMembership(user.userId, f.organization_id);
    const scope = f.organization_id ? { userId: null, organizationId: f.organization_id } : { userId: user.userId, organizationId: null };
    const { plan, limits, status } = await this.usage.plan(scope);
    const scopeSql = f.organization_id ? 'organization_id = $1' : 'user_id = $1';
    const usage = await this.db.query(
      `SELECT metric, sum(quantity)::bigint AS quantity FROM usage_records
        WHERE ${scopeSql} AND period_day >= date_trunc('month', current_date) GROUP BY metric`,
      [f.organization_id ?? user.userId],
    );
    const devices = await this.db.one<{ n: number }>(
      f.organization_id
        ? `SELECT count(*)::int AS n FROM devices WHERE organization_id = $1 AND status = 'active'`
        : `SELECT count(*)::int AS n FROM devices WHERE owner_user_id = $1 AND organization_id IS NULL AND status = 'active'`,
      [f.organization_id ?? user.userId],
    );
    const region = f.region ?? 'default';
    const prices = await this.db.query(
      `SELECT p.plan, p.currency, p.amount_minor, p.per FROM plan_prices p
        WHERE p.region = $1 OR (p.region = 'default' AND NOT EXISTS (SELECT 1 FROM plan_prices x WHERE x.region = $1 AND x.plan = p.plan))
        ORDER BY array_position(ARRAY['free','personal','premium','business'], p.plan)`,
      [region],
    );
    return {
      plan,
      status,
      limits,
      plans: PLAN_IDS.map((id) => ({ id, limits: PLAN_LIMITS[id], price: prices.find((p) => p.plan === id) ?? null })),
      usage_this_month: Object.fromEntries(usage.map((u) => [u.metric, Number(u.quantity)])),
      active_devices: devices?.n ?? 0,
      recording_bytes_used: await this.usage.recordingBytesUsed(scope),
      payments_enabled: false,
      note: 'Live payment processing is not integrated yet. Plan changes here take effect without charging anything.',
    };
  }

  /** Development/staging only until a payment provider is integrated. */
  @Post('plan')
  async changePlan(@CurrentUser() user: UserAuth, @Body() body: unknown) {
    if (!this.config.billingSelfServe) throw new ForbiddenException('Plan changes are handled by billing support');
    const dto = parse(z.object({ plan: z.enum(PLAN_IDS), organization_id: z.string().uuid().optional() }).strict(), body);
    if (dto.organization_id) {
      await this.access.requireOrgPermission(user, dto.organization_id, 'org.manage');
      await this.db.query('UPDATE subscriptions SET plan = $2 WHERE organization_id = $1', [dto.organization_id, dto.plan]);
    } else {
      if (dto.plan === 'business') throw new ForbiddenException('Create an organization to use the Business plan');
      await this.db.query('UPDATE subscriptions SET plan = $2 WHERE user_id = $1', [user.userId, dto.plan]);
      // Keep retention inside the new plan's bounds.
      const max = PLAN_LIMITS[dto.plan].retentionDaysMax;
      await this.db.query(
        `UPDATE retention_policies SET event_retention_days = least(event_retention_days, $2), recording_retention_days = least(recording_retention_days, $2) WHERE user_id = $1`,
        [user.userId, max],
      );
    }
    await this.audit.record({ action: 'billing.plan_changed', actorUserId: user.userId, organizationId: dto.organization_id ?? null, subjectUserId: user.userId, details: { plan: dto.plan } });
    return { plan: dto.plan };
  }
}
