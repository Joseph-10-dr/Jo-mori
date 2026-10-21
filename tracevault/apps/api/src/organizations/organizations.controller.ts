import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ORG_ROLES, PLAN_LIMITS, ROLE_LABELS } from '@tracevault/api-contracts';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../config';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, UserAuth } from '../common/auth-context';
import { randomToken, sha256 } from '../common/crypto';
import { parse, uuidParam } from '../common/http';
import { MailService } from '../common/mail.service';
import { AlertEngine } from '../alerts/alert-engine.service';
import { Db } from '../db/db.service';

const assignableRole = z.enum(['admin', 'security_analyst', 'auditor', 'member']);

@ApiTags('organizations')
@Controller('v1')
export class OrganizationsController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly alerts: AlertEngine,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('organizations')
  async create(@CurrentUser() user: UserAuth, @Body() body: unknown) {
    const dto = parse(z.object({ name: z.string().trim().min(2).max(120) }).strict(), body);
    if (!user.emailVerified) throw new ForbiddenException('Verify your email address before creating an organization');
    const limits = PLAN_LIMITS.business;
    return this.db.tx(async (c) => {
      const org = await this.db.one<{ id: string; name: string; created_at: Date }>(
        'INSERT INTO organizations (name, created_by) VALUES ($1,$2) RETURNING id, name, created_at',
        [dto.name, user.userId],
        c,
      );
      await this.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'owner')`, [org!.id, user.userId], c);
      // Billing is not integrated yet: organizations start on a business trial with no payment taken.
      await this.db.query(`INSERT INTO subscriptions (organization_id, plan, status) VALUES ($1, 'business', 'trialing')`, [org!.id], c);
      await this.db.query(
        `INSERT INTO retention_policies (organization_id, event_retention_days, recording_retention_days) VALUES ($1,$2,30)`,
        [org!.id, limits.retentionDaysDefault],
        c,
      );
      await this.audit.record(
        { action: 'org.created', actorUserId: user.userId, organizationId: org!.id, targetType: 'organization', targetId: org!.id, details: { name: dto.name } },
        c,
      );
      return { ...org, role: 'owner' };
    });
  }

  @Get('organizations')
  async mine(@CurrentUser() user: UserAuth) {
    return {
      items: await this.db.query(
        `SELECT o.id, o.name, m.role, o.created_at,
                (SELECT count(*)::int FROM organization_members WHERE organization_id = o.id) AS member_count,
                (SELECT count(*)::int FROM devices WHERE organization_id = o.id AND status = 'active') AS device_count
           FROM organization_members m JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = $1 ORDER BY o.name`,
        [user.userId],
      ),
    };
  }

  @Get('organizations/:id')
  async get(@CurrentUser() user: UserAuth, @Param('id') id: string) {
    const orgId = parse(uuidParam, id);
    const role = await this.access.requireMembership(user.userId, orgId);
    const org = await this.db.one(
      `SELECT o.id, o.name, o.member_enrollment_allowed, o.require_mfa_for_admins, o.recordings_allowed, o.created_at,
              s.plan, s.status AS subscription_status,
              r.event_retention_days, r.recording_retention_days, r.audit_retention_days
         FROM organizations o LEFT JOIN subscriptions s ON s.organization_id = o.id
         LEFT JOIN retention_policies r ON r.organization_id = o.id WHERE o.id = $1`,
      [orgId],
    );
    const stats = await this.db.one(
      `SELECT (SELECT count(*)::int FROM organization_members WHERE organization_id = $1) AS members,
              (SELECT count(*)::int FROM devices WHERE organization_id = $1 AND status = 'active') AS active_devices,
              (SELECT count(*)::int FROM devices WHERE organization_id = $1 AND status = 'active' AND last_seen_at > now() - interval '30 minutes') AS reporting_devices,
              (SELECT count(*)::int FROM security_alerts WHERE organization_id = $1 AND status = 'open') AS open_alerts`,
      [orgId],
    );
    return { ...org, role, role_label: ROLE_LABELS[role], stats };
  }

  @Patch('organizations/:id')
  async updatePolicy(@CurrentUser() user: UserAuth, @Param('id') id: string, @Body() body: unknown) {
    const orgId = parse(uuidParam, id);
    const dto = parse(
      z
        .object({
          name: z.string().trim().min(2).max(120).optional(),
          member_enrollment_allowed: z.boolean().optional(),
          require_mfa_for_admins: z.boolean().optional(),
          recordings_allowed: z.boolean().optional(),
        })
        .strict(),
      body,
    );
    // Turning recordings on, renaming, or relaxing MFA are owner-level decisions.
    const needsOwner = dto.name !== undefined || dto.recordings_allowed !== undefined || dto.require_mfa_for_admins !== undefined;
    await this.access.requireOrgPermission(user, orgId, needsOwner ? 'org.manage' : 'policies.manage');
    const sets: string[] = [];
    const params: unknown[] = [orgId];
    for (const [k, v] of Object.entries(dto)) if (v !== undefined) sets.push(`${k} = $${params.push(v)}`);
    if (sets.length) await this.db.query(`UPDATE organizations SET ${sets.join(', ')} WHERE id = $1`, params);
    await this.audit.record({ action: 'org.policy_changed', actorUserId: user.userId, organizationId: orgId, targetType: 'organization', targetId: orgId, details: dto });
    return this.get(user, orgId);
  }

  @Put('organizations/:id/retention')
  async retention(@CurrentUser() user: UserAuth, @Param('id') id: string, @Body() body: unknown) {
    const orgId = parse(uuidParam, id);
    await this.access.requireOrgPermission(user, orgId, 'policies.manage');
    const max = PLAN_LIMITS.business.retentionDaysMax;
    const dto = parse(
      z
        .object({
          event_retention_days: z.number().int().min(1).max(max),
          recording_retention_days: z.number().int().min(1).max(max),
          audit_retention_days: z.number().int().min(30).max(3650).default(365),
        })
        .strict(),
      body,
    );
    await this.db.query(
      `UPDATE retention_policies SET event_retention_days = $2, recording_retention_days = $3, audit_retention_days = $4,
         updated_at = now(), updated_by = $5 WHERE organization_id = $1`,
      [orgId, dto.event_retention_days, dto.recording_retention_days, dto.audit_retention_days, user.userId],
    );
    await this.audit.record({ action: 'org.retention_changed', actorUserId: user.userId, organizationId: orgId, details: dto });
    return dto;
  }

  @Get('organizations/:id/members')
  async members(@CurrentUser() user: UserAuth, @Param('id') id: string) {
    const orgId = parse(uuidParam, id);
    await this.access.requireMembership(user.userId, orgId);
    const items = await this.db.query(
      `SELECT u.id AS user_id, u.email, u.display_name, m.role, m.created_at AS joined_at, u.mfa_enabled_at IS NOT NULL AS mfa_enabled,
              (SELECT count(*)::int FROM devices d WHERE d.organization_id = $1 AND d.owner_user_id = u.id AND d.status = 'active') AS devices
         FROM organization_members m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 ORDER BY m.role, u.email`,
      [orgId],
    );
    return { items, roles: ORG_ROLES.map((r) => ({ id: r, label: ROLE_LABELS[r] })) };
  }

  @Patch('organizations/:id/members/:userId')
  async changeRole(@CurrentUser() user: UserAuth, @Param('id') id: string, @Param('userId') userId: string, @Body() body: unknown) {
    const orgId = parse(uuidParam, id);
    const target = parse(uuidParam, userId);
    const dto = parse(z.object({ role: assignableRole }).strict(), body);
    const actorRole = await this.access.requireOrgPermission(user, orgId, 'members.manage');
    const current = await this.db.one<{ role: string }>('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2', [orgId, target]);
    if (!current) throw new NotFoundException('Member not found');
    if (current.role === 'owner') throw new ForbiddenException('The organization owner role cannot be changed here');
    if (dto.role === 'admin' && actorRole !== 'owner') throw new ForbiddenException('Only the owner can grant the administrator role');
    await this.db.query('UPDATE organization_members SET role = $3 WHERE organization_id = $1 AND user_id = $2', [orgId, target, dto.role]);
    await this.audit.record({
      action: 'org.member_role_changed',
      actorUserId: user.userId,
      organizationId: orgId,
      subjectUserId: target,
      details: { from: current.role, to: dto.role },
    });
    if (['admin', 'security_analyst', 'auditor'].includes(dto.role)) {
      const owner = await this.db.one<{ user_id: string }>(`SELECT user_id FROM organization_members WHERE organization_id = $1 AND role = 'owner'`, [orgId]);
      if (owner) {
        await this.alerts.create({
          ownerUserId: owner.user_id,
          organizationId: orgId,
          deviceId: null,
          rule: 'privileged_role_granted',
          title: `A member was given the ${ROLE_LABELS[dto.role]} role`,
          severity: 'low',
          confidence: 'confirmed',
          explanation: `A member's role changed from ${current.role} to ${dto.role}. This role can view all organization devices and events.`,
          recommendedAction: 'Confirm this access change was approved.',
        });
      }
    }
    return { ok: true };
  }

  @Delete('organizations/:id/members/:userId')
  async removeMember(@CurrentUser() user: UserAuth, @Param('id') id: string, @Param('userId') userId: string) {
    const orgId = parse(uuidParam, id);
    const target = parse(uuidParam, userId);
    if (target !== user.userId) await this.access.requireOrgPermission(user, orgId, 'members.manage');
    const current = await this.db.one<{ role: string }>('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2', [orgId, target]);
    if (!current) throw new NotFoundException('Member not found');
    if (current.role === 'owner') throw new ForbiddenException('Transfer ownership before removing the owner');
    await this.db.tx(async (c) => {
      await this.db.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [orgId, target], c);
      // Their enrolled business devices stay with the organization but stop uploading until re-enrolled.
      await this.db.query(
        `UPDATE device_credentials SET revoked_at = now() WHERE revoked_at IS NULL AND device_id IN
           (SELECT id FROM devices WHERE organization_id = $1 AND owner_user_id = $2)`,
        [orgId, target],
        c,
      );
      await this.db.query(`UPDATE devices SET status = 'revoked', revoked_at = now(), revoked_by = $3 WHERE organization_id = $1 AND owner_user_id = $2 AND status = 'active'`, [orgId, target, user.userId], c);
      await this.audit.record({ action: 'org.member_removed', actorUserId: user.userId, organizationId: orgId, subjectUserId: target, details: { role: current.role } }, c);
    });
    return { ok: true };
  }

  @Get('organizations/:id/invitations')
  async invitations(@CurrentUser() user: UserAuth, @Param('id') id: string) {
    const orgId = parse(uuidParam, id);
    await this.access.requireOrgPermission(user, orgId, 'members.manage');
    return {
      items: await this.db.query(
        `SELECT id, email, role, expires_at, accepted_at, revoked_at, created_at FROM organization_invitations
          WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [orgId],
      ),
    };
  }

  @Post('organizations/:id/invitations')
  async invite(@CurrentUser() user: UserAuth, @Param('id') id: string, @Body() body: unknown) {
    const orgId = parse(uuidParam, id);
    const dto = parse(z.object({ email: z.string().trim().toLowerCase().email(), role: assignableRole.default('member') }).strict(), body);
    const actorRole = await this.access.requireOrgPermission(user, orgId, 'members.manage');
    if (dto.role === 'admin' && actorRole !== 'owner') throw new ForbiddenException('Only the owner can invite administrators');
    const already = await this.db.one(
      `SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND u.email = $2`,
      [orgId, dto.email],
    );
    if (already) throw new ConflictException('That person is already a member');
    const token = randomToken('tvi');
    const inv = await this.db.one<{ id: string; expires_at: Date }>(
      `INSERT INTO organization_invitations (organization_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + interval '7 days') RETURNING id, expires_at`,
      [orgId, dto.email, dto.role, sha256(token), user.userId],
    );
    const org = await this.db.one<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [orgId]);
    await this.mail.send({
      to: dto.email,
      subject: `You're invited to ${org!.name} on TraceVault`,
      text: `${user.email} invited you to join ${org!.name} on TraceVault as ${ROLE_LABELS[dto.role]}.\n\nAccept: ${this.config.webOrigin}/invitations/accept?token=${token}\n\nThe invitation expires in 7 days. Joining lets organization administrators see devices you enroll into the organization. It does not give them access to your personal devices.`,
    });
    await this.audit.record({ action: 'org.member_invited', actorUserId: user.userId, organizationId: orgId, targetType: 'invitation', targetId: inv!.id, details: { email: dto.email, role: dto.role } });
    return { id: inv!.id, email: dto.email, role: dto.role, expires_at: inv!.expires_at };
  }

  @Delete('organizations/:id/invitations/:invId')
  async revokeInvite(@CurrentUser() user: UserAuth, @Param('id') id: string, @Param('invId') invId: string) {
    const orgId = parse(uuidParam, id);
    await this.access.requireOrgPermission(user, orgId, 'members.manage');
    const row = await this.db.one(
      `UPDATE organization_invitations SET revoked_at = now() WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL RETURNING id`,
      [parse(uuidParam, invId), orgId],
    );
    if (!row) throw new NotFoundException('Invitation not found');
    await this.audit.record({ action: 'org.invitation_revoked', actorUserId: user.userId, organizationId: orgId, targetType: 'invitation', targetId: invId });
    return { ok: true };
  }

  @Post('invitations/accept')
  @HttpCode(200)
  async accept(@CurrentUser() user: UserAuth, @Body() body: unknown) {
    const dto = parse(z.object({ token: z.string().min(10).max(200) }).strict(), body);
    return this.db.tx(async (c) => {
      const inv = await this.db.one<{ id: string; organization_id: string; email: string; role: string }>(
        `SELECT id, organization_id, email, role FROM organization_invitations
          WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
        [sha256(dto.token)],
        c,
      );
      if (!inv) throw new BadRequestException('This invitation is invalid or has expired');
      if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
        throw new ForbiddenException('This invitation was sent to a different email address');
      }
      await this.db.query(
        `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [inv.organization_id, user.userId, inv.role],
        c,
      );
      await this.db.query('UPDATE organization_invitations SET accepted_at = now() WHERE id = $1', [inv.id], c);
      await this.audit.record({ action: 'org.member_joined', actorUserId: user.userId, organizationId: inv.organization_id, subjectUserId: user.userId, details: { role: inv.role } }, c);
      return { organization_id: inv.organization_id, role: inv.role };
    });
  }
}
