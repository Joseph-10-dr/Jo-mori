import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, UserAuth } from '../common/auth-context';
import { parse } from '../common/http';
import { Db } from '../db/db.service';

@ApiTags('audit')
@Controller('v1/audit-logs')
export class AuditController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /** Without organization_id: your own account history. With it: requires audit.view in that org. */
  @Get()
  async list(@CurrentUser() user: UserAuth, @Query() q: unknown) {
    const f = parse(
      z.object({
        organization_id: z.string().uuid().optional(),
        action: z
          .string()
          .regex(/^[a-z_.]{1,60}$/)
          .optional(),
        sensitive: z.enum(['true', 'false']).optional(),
        before_id: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      q,
    );
    const params: unknown[] = [];
    const where: string[] = [];
    if (f.organization_id) {
      await this.access.requireOrgPermission(user, f.organization_id, 'audit.view');
      where.push(`a.organization_id = $${params.push(f.organization_id)}`);
    } else {
      const p = params.push(user.userId);
      where.push(
        `(a.subject_user_id = $${p} OR (a.actor_user_id = $${p} AND a.organization_id IS NULL))`,
      );
    }
    if (f.action) where.push(`a.action LIKE $${params.push(f.action + '%')}`);
    if (f.sensitive) where.push(`a.sensitive = $${params.push(f.sensitive === 'true')}`);
    if (f.before_id) where.push(`a.id < $${params.push(f.before_id)}`);
    const rows = await this.db.query<{ id: string }>(
      `SELECT a.id, a.occurred_at, a.action, a.target_type, a.target_id, host(a.ip) AS ip, a.details, a.sensitive,
              a.actor_user_id, au.email AS actor_email, a.actor_device_id, ad.name AS actor_device_name, a.subject_user_id
         FROM audit_logs a
         LEFT JOIN users au ON au.id = a.actor_user_id
         LEFT JOIN devices ad ON ad.id = a.actor_device_id
        WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ${f.limit + 1}`,
      params,
    );
    const more = rows.length > f.limit;
    const items = rows.slice(0, f.limit);
    return { items, next_before_id: more ? Number(items[items.length - 1].id) : null };
  }

  @Get('verify')
  async verify(@CurrentUser() user: UserAuth, @Query() q: unknown) {
    const { organization_id } = parse(z.object({ organization_id: z.string().uuid() }), q);
    await this.access.requireOrgPermission(user, organization_id, 'audit.view');
    const r = await this.audit.verifyChain();
    return { intact: r.ok, rows_checked: r.checked };
  }
}
