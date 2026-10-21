import { Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { roleHas } from '@tracevault/api-contracts';
import { z } from 'zod';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, UserAuth } from '../common/auth-context';
import { parse, uuidParam } from '../common/http';
import { decodeCursor, encodeCursor } from '../common/pagination';
import { Db } from '../db/db.service';

const ALERT_COLUMNS = `a.id, a.device_id, d.name AS device_name, a.organization_id, a.owner_user_id, a.rule, a.title, a.severity,
  a.confidence, a.evidence_event_ids, a.explanation, a.recommended_action, a.status, a.created_at,
  a.resolved_at, a.resolution_note`;

@ApiTags('alerts')
@Controller('v1/alerts')
export class AlertsController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentUser() user: UserAuth, @Query() q: unknown) {
    const f = parse(
      z.object({
        status: z.enum(['open', 'resolved', 'dismissed']).optional(),
        severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
        device_id: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().max(200).optional(),
      }),
      q,
    );
    const scope = await this.access.scope(user.userId);
    const params: unknown[] = [scope.userId, scope.viewAllOrgIds];
    const where = [AccessService.visibleSql('a', 1, 2)];
    if (f.status) where.push(`a.status = $${params.push(f.status)}`);
    if (f.severity) where.push(`a.severity = $${params.push(f.severity)}`);
    if (f.device_id) where.push(`a.device_id = $${params.push(f.device_id)}`);
    const c = decodeCursor(f.cursor);
    if (c) where.push(`(a.created_at, a.id) < ($${params.push(c.ts)}::timestamptz, $${params.push(c.id)}::uuid)`);
    const rows = await this.db.query<{ id: string; created_at: Date }>(
      `SELECT ${ALERT_COLUMNS} FROM security_alerts a LEFT JOIN devices d ON d.id = a.device_id
        WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC LIMIT ${f.limit + 1}`,
      params,
    );
    const more = rows.length > f.limit;
    const items = rows.slice(0, f.limit);
    const counts = await this.db.query<{ severity: string; n: number }>(
      `SELECT severity, count(*)::int AS n FROM security_alerts a WHERE ${AccessService.visibleSql('a', 1, 2)} AND status = 'open' GROUP BY severity`,
      [scope.userId, scope.viewAllOrgIds],
    );
    return {
      items,
      next_cursor: more ? encodeCursor(items[items.length - 1].created_at, items[items.length - 1].id) : null,
      open_by_severity: Object.fromEntries(counts.map((r) => [r.severity, r.n])),
    };
  }

  private async load(user: UserAuth, id: string) {
    const scope = await this.access.scope(user.userId);
    const a = await this.db.one<{ id: string; owner_user_id: string; organization_id: string | null }>(
      `SELECT ${ALERT_COLUMNS} FROM security_alerts a LEFT JOIN devices d ON d.id = a.device_id
        WHERE a.id = $3 AND ${AccessService.visibleSql('a', 1, 2)}`,
      [scope.userId, scope.viewAllOrgIds, parse(uuidParam, id)],
    );
    if (!a) throw new NotFoundException('Alert not found');
    return { a, scope };
  }

  @Get(':id')
  async get(@CurrentUser() user: UserAuth, @Param('id') id: string) {
    return (await this.load(user, id)).a;
  }

  @Post(':id/resolve')
  @HttpCode(200)
  async resolve(@CurrentUser() user: UserAuth, @Param('id') id: string, @Body() body: unknown) {
    const dto = parse(
      z.object({ status: z.enum(['resolved', 'dismissed']).default('resolved'), note: z.string().trim().max(1000).optional() }),
      body ?? {},
    );
    const { a, scope } = await this.load(user, id);
    const role = a.organization_id ? scope.roles.get(a.organization_id) : undefined;
    const allowed = a.owner_user_id === user.userId || (role && roleHas(role, 'alerts.resolve'));
    if (!allowed) throw new ForbiddenException('Your role cannot resolve alerts');
    const updated = await this.db.one(
      `UPDATE security_alerts SET status = $2, resolved_at = now(), resolved_by = $3, resolution_note = $4
        WHERE id = $1 RETURNING id, status, resolved_at, resolution_note`,
      [a.id, dto.status, user.userId, dto.note ?? null],
    );
    await this.audit.record({
      action: `alert.${dto.status}`,
      actorUserId: user.userId,
      organizationId: a.organization_id,
      subjectUserId: a.owner_user_id,
      targetType: 'alert',
      targetId: a.id,
    });
    return updated;
  }
}
