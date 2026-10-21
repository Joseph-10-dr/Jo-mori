import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OrgRole, Permission, roleHas } from '@tracevault/api-contracts';
import { Db } from '../db/db.service';
import { UserAuth } from './auth-context';

export interface Scope {
  userId: string;
  /** Orgs where the user may view all devices/events. */
  viewAllOrgIds: string[];
  roles: Map<string, OrgRole>;
}

/**
 * Central tenant-isolation logic. Every read of devices/events/alerts goes
 * through `scope()` + `visibleDeviceSql`, so the rule lives in one place:
 * you see your own devices, plus all devices of orgs where your role grants
 * devices.view_all. IDs in the request are never trusted on their own.
 */
@Injectable()
export class AccessService {
  constructor(private readonly db: Db) {}

  async scope(userId: string): Promise<Scope> {
    const rows = await this.db.query<{ organization_id: string; role: OrgRole }>(
      'SELECT organization_id, role FROM organization_members WHERE user_id = $1',
      [userId],
    );
    const roles = new Map(rows.map((r) => [r.organization_id, r.role]));
    return {
      userId,
      roles,
      viewAllOrgIds: rows
        .filter((r) => roleHas(r.role, 'devices.view_all'))
        .map((r) => r.organization_id),
    };
  }

  /** SQL predicate on a table alias having owner_user_id/organization_id. Params: $a = userId, $b = org ids. */
  static visibleSql(alias: string, userParam: number, orgsParam: number): string {
    return `(${alias}.owner_user_id = $${userParam} OR ${alias}.organization_id = ANY($${orgsParam}::uuid[]))`;
  }

  async requireOrgPermission(user: UserAuth, orgId: string, perm: Permission): Promise<OrgRole> {
    const row = await this.db.one<{ role: OrgRole; require_mfa_for_admins: boolean }>(
      `SELECT m.role, o.require_mfa_for_admins FROM organization_members m
         JOIN organizations o ON o.id = m.organization_id
        WHERE m.organization_id = $1 AND m.user_id = $2`,
      [orgId, user.userId],
    );
    // Non-members get 404 rather than 403 so org IDs cannot be probed.
    if (!row) throw new NotFoundException('Organization not found');
    if (!roleHas(row.role, perm)) throw new ForbiddenException(`Your role does not allow ${perm}`);
    const privileged = perm !== 'devices.view_all' && perm !== 'audit.view';
    if (privileged && row.require_mfa_for_admins && !user.mfaEnabled) {
      throw new ForbiddenException(
        'This organization requires multifactor authentication for administrative actions',
      );
    }
    return row.role;
  }

  async requireMembership(userId: string, orgId: string): Promise<OrgRole> {
    const row = await this.db.one<{ role: OrgRole }>(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [orgId, userId],
    );
    if (!row) throw new NotFoundException('Organization not found');
    return row.role;
  }
}
