import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { roleHas } from '@tracevault/api-contracts';
import { AlertEngine } from '../alerts/alert-engine.service';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { UserAuth } from '../common/auth-context';
import { enrollmentCode, normalizeEnrollmentCode, randomToken, sha256 } from '../common/crypto';
import { UsageService } from '../common/usage.service';
import { Db, Queryable } from '../db/db.service';

export const DEVICE_COLUMNS = `d.id, d.name, d.platform, d.os_version, d.agent_version, d.owner_user_id, d.organization_id,
  o.name AS organization_name, d.status, d.monitoring_status, d.permissions, d.startup_enabled, d.registered_at,
  d.last_seen_at, d.last_sync_at, d.last_sync_error, d.consecutive_sync_failures, d.revoked_at,
  CASE WHEN d.status = 'revoked' THEN 'revoked'
       WHEN d.last_sync_at IS NULL THEN 'never'
       WHEN d.consecutive_sync_failures >= 3 THEN 'failing'
       WHEN d.last_seen_at < now() - interval '30 minutes' THEN 'stale'
       ELSE 'ok' END AS sync_status,
  (d.status = 'active' AND d.last_seen_at > now() - interval '30 minutes') AS reporting`;

export interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  owner_user_id: string;
  organization_id: string | null;
  status: 'active' | 'revoked';
  last_sync_at: Date | null;
  last_seen_at: Date | null;
}

const ENROLLMENT_MINUTES = 15;

@Injectable()
export class DevicesService {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly alerts: AlertEngine,
    private readonly usage: UsageService,
  ) {}

  private async enforceDeviceLimit(ownerUserId: string, organizationId: string | null, client?: Queryable) {
    const scope = UsageService.scopeFor(ownerUserId, organizationId);
    const { limits, plan } = await this.usage.plan(scope);
    const row = await this.db.one<{ n: number }>(
      organizationId
        ? `SELECT count(*)::int AS n FROM devices WHERE organization_id = $1 AND status = 'active'`
        : `SELECT count(*)::int AS n FROM devices WHERE owner_user_id = $1 AND organization_id IS NULL AND status = 'active'`,
      [organizationId ?? ownerUserId],
      client,
    );
    if ((row?.n ?? 0) >= limits.maxDevices) {
      throw new ForbiddenException(
        `Your ${plan} plan allows ${limits.maxDevices} active device${limits.maxDevices === 1 ? '' : 's'}. Revoke a device or change plan.`,
      );
    }
  }

  async createEnrollmentCode(user: UserAuth, organizationId: string | null) {
    if (!user.emailVerified) throw new ForbiddenException('Verify your email address before enrolling devices');
    if (organizationId) {
      const role = await this.access.requireMembership(user.userId, organizationId);
      const org = await this.db.one<{ member_enrollment_allowed: boolean }>(
        'SELECT member_enrollment_allowed FROM organizations WHERE id = $1',
        [organizationId],
      );
      if (!org?.member_enrollment_allowed && !roleHas(role, 'devices.manage_all')) {
        throw new ForbiddenException('Your organization only allows administrators to enroll devices');
      }
    }
    await this.enforceDeviceLimit(user.userId, organizationId);
    const code = enrollmentCode();
    const row = await this.db.one<{ expires_at: Date }>(
      `INSERT INTO device_enrollment_codes (user_id, organization_id, code_hash, expires_at)
       VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval) RETURNING expires_at`,
      [user.userId, organizationId, sha256(code), String(ENROLLMENT_MINUTES)],
    );
    return { code, expires_at: row!.expires_at };
  }

  /** Exchanges a one-time enrollment code for a device id + long random secret (shown once). */
  async register(input: {
    code: string;
    name: string;
    platform: string;
    osVersion?: string;
    agentVersion?: string;
    ip: string | null;
  }) {
    const result = await this.db.tx(async (c) => {
      const enrollment = await this.db.one<{ user_id: string; organization_id: string | null }>(
        `UPDATE device_enrollment_codes SET used_at = now()
          WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING user_id, organization_id`,
        [sha256(normalizeEnrollmentCode(input.code))],
        c,
      );
      if (!enrollment) throw new UnauthorizedException('Enrollment code is invalid, expired or already used');
      await this.enforceDeviceLimit(enrollment.user_id, enrollment.organization_id, c);
      const device = await this.db.one<DeviceRow>(
        `INSERT INTO devices (owner_user_id, organization_id, name, platform, os_version, agent_version)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, platform, owner_user_id, organization_id, status`,
        [enrollment.user_id, enrollment.organization_id, input.name, input.platform, input.osVersion ?? null, input.agentVersion ?? null],
        c,
      );
      const secret = randomToken('tvd');
      await this.db.query('INSERT INTO device_credentials (device_id, secret_hash) VALUES ($1,$2)', [device!.id, sha256(secret)], c);
      await this.audit.record(
        {
          action: 'device.registered',
          actorUserId: enrollment.user_id,
          actorDeviceId: device!.id,
          organizationId: enrollment.organization_id,
          subjectUserId: enrollment.user_id,
          targetType: 'device',
          targetId: device!.id,
          ip: input.ip,
          details: { platform: input.platform, name: input.name },
        },
        c,
      );
      return { device: device!, secret };
    });
    await this.alerts.create({
      ownerUserId: result.device.owner_user_id,
      organizationId: result.device.organization_id,
      deviceId: result.device.id,
      rule: 'new_device_registered',
      title: `New device enrolled: ${result.device.name}`,
      severity: 'info',
      confidence: 'confirmed',
      explanation: `A ${result.device.platform} device named "${result.device.name}" was enrolled using an enrollment code from your account.`,
      recommendedAction: 'If you did not enroll this device, revoke it from the Devices page.',
      dedupeKey: `device_registered:${result.device.id}`,
    });
    return { device_id: result.device.id, device_secret: result.secret, owner_user_id: result.device.owner_user_id };
  }

  async list(user: UserAuth, filter: { status?: string; organizationId?: string }) {
    const scope = await this.access.scope(user.userId);
    const params: unknown[] = [scope.userId, scope.viewAllOrgIds];
    const where = [AccessService.visibleSql('d', 1, 2)];
    if (filter.status) where.push(`d.status = $${params.push(filter.status)}`);
    if (filter.organizationId) where.push(`d.organization_id = $${params.push(filter.organizationId)}`);
    return this.db.query(
      `SELECT ${DEVICE_COLUMNS} FROM devices d LEFT JOIN organizations o ON o.id = d.organization_id
        WHERE ${where.join(' AND ')} ORDER BY d.status, d.last_seen_at DESC NULLS LAST, d.registered_at DESC`,
      params,
    );
  }

  /** Loads a device the user may view; 404 for anything outside their scope. */
  async getVisible(user: UserAuth, id: string) {
    const scope = await this.access.scope(user.userId);
    const d = await this.db.one<DeviceRow & Record<string, unknown>>(
      `SELECT ${DEVICE_COLUMNS} FROM devices d LEFT JOIN organizations o ON o.id = d.organization_id
        WHERE d.id = $3 AND ${AccessService.visibleSql('d', 1, 2)}`,
      [scope.userId, scope.viewAllOrgIds, id],
    );
    if (!d) throw new NotFoundException('Device not found');
    return { device: d, scope };
  }

  /** Owners may manage their own devices; org admins may manage any org device. */
  async getManageable(user: UserAuth, id: string) {
    const { device } = await this.getVisible(user, id);
    if (device.owner_user_id === user.userId) return device;
    if (device.organization_id) {
      await this.access.requireOrgPermission(user, device.organization_id, 'devices.manage_all');
      return device;
    }
    throw new ForbiddenException('You cannot manage this device');
  }

  async rename(user: UserAuth, id: string, name: string) {
    const d = await this.getManageable(user, id);
    await this.db.query('UPDATE devices SET name = $2 WHERE id = $1', [d.id, name]);
    await this.audit.record({
      action: 'device.renamed',
      actorUserId: user.userId,
      organizationId: d.organization_id,
      subjectUserId: d.owner_user_id,
      targetType: 'device',
      targetId: d.id,
      details: { from: d.name, to: name },
    });
  }

  async revoke(user: UserAuth, id: string, reason: 'revoked' | 'reported_lost' = 'revoked') {
    const d = await this.getManageable(user, id);
    if (d.status === 'revoked') return;
    await this.db.tx(async (c) => {
      await this.db.query(`UPDATE devices SET status = 'revoked', revoked_at = now(), revoked_by = $2 WHERE id = $1`, [d.id, user.userId], c);
      await this.db.query('UPDATE device_credentials SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL', [d.id], c);
      await this.audit.record(
        {
          action: reason === 'reported_lost' ? 'device.reported_lost' : 'device.revoked',
          actorUserId: user.userId,
          organizationId: d.organization_id,
          subjectUserId: d.owner_user_id,
          targetType: 'device',
          targetId: d.id,
        },
        c,
      );
    });
    await this.alerts.create({
      ownerUserId: d.owner_user_id,
      organizationId: d.organization_id,
      deviceId: d.id,
      rule: reason === 'reported_lost' ? 'device_reported_lost' : 'device_revoked',
      title: reason === 'reported_lost' ? `${d.name} was reported lost and its access revoked` : `${d.name} was revoked`,
      severity: reason === 'reported_lost' ? 'high' : 'info',
      confidence: 'confirmed',
      explanation: `Device credentials for ${d.name} were revoked. The device can no longer upload activity; history uploaded before ${new Date().toISOString()} is kept.`,
      recommendedAction:
        reason === 'reported_lost'
          ? 'Follow the recovery checklist: change passwords used on the device, sign out of its sessions in your email and other accounts, and use the platform lost-device service.'
          : 'No further action needed if you revoked it.',
      dedupeKey: `${reason}:${d.id}`,
    });
  }

  /** Permanently deletes the device and its uploaded history (recordings files are removed by the recordings service). */
  async remove(user: UserAuth, id: string) {
    const d = await this.getManageable(user, id);
    await this.db.tx(async (c) => {
      await this.db.query('DELETE FROM devices WHERE id = $1', [d.id], c);
      await this.audit.record(
        {
          action: 'device.deleted',
          actorUserId: user.userId,
          organizationId: d.organization_id,
          subjectUserId: d.owner_user_id,
          targetType: 'device',
          targetId: d.id,
          details: { name: d.name },
        },
        c,
      );
    });
  }

  // ---- device-authenticated ----
  async heartbeat(
    deviceId: string,
    hb: {
      monitoring_status: string;
      permissions: Record<string, string>;
      startup_enabled: boolean;
      agent_version?: string;
      os_version?: string;
      queued_events: number;
      consecutive_upload_failures: number;
      last_error?: string;
    },
  ) {
    const before = await this.db.one<DeviceRow & { consecutive_sync_failures: number; monitoring_status: string }>(
      'SELECT id, name, owner_user_id, organization_id, consecutive_sync_failures, monitoring_status FROM devices WHERE id = $1',
      [deviceId],
    );
    if (!before) throw new NotFoundException();
    await this.db.query(
      `UPDATE devices SET last_seen_at = now(), monitoring_status = $2, permissions = $3, startup_enabled = $4,
          agent_version = coalesce($5, agent_version), os_version = coalesce($6, os_version),
          consecutive_sync_failures = $7, last_sync_error = $8
        WHERE id = $1`,
      [deviceId, hb.monitoring_status, JSON.stringify(hb.permissions), hb.startup_enabled, hb.agent_version ?? null, hb.os_version ?? null, hb.consecutive_upload_failures, hb.last_error ?? null],
    );
    if (hb.consecutive_upload_failures >= 3 && before.consecutive_sync_failures < 3) {
      await this.alerts.create({
        ownerUserId: before.owner_user_id,
        organizationId: before.organization_id,
        deviceId,
        rule: 'repeated_upload_failures',
        title: `${before.name} is failing to upload activity`,
        severity: 'medium',
        confidence: 'confirmed',
        explanation: `The device reported ${hb.consecutive_upload_failures} failed uploads in a row and ${hb.queued_events} events waiting locally. Events that never reach the cloud can be lost if the device is lost or wiped.`,
        recommendedAction: 'Check the device has internet access and the correct date and time.',
        dedupeKey: `upload_failures:${deviceId}:${new Date().toISOString().slice(0, 13)}`,
      });
    }
    if (hb.monitoring_status !== 'active' && before.monitoring_status === 'active') {
      await this.audit.record({
        action: 'device.monitoring_status_changed',
        actorDeviceId: deviceId,
        organizationId: before.organization_id,
        subjectUserId: before.owner_user_id,
        targetType: 'device',
        targetId: deviceId,
        details: { from: before.monitoring_status, to: hb.monitoring_status },
      });
    }
  }

  async rotateCredential(deviceId: string, credentialId: string) {
    const secret = randomToken('tvd');
    await this.db.tx(async (c) => {
      await this.db.query('INSERT INTO device_credentials (device_id, secret_hash) VALUES ($1,$2)', [deviceId, sha256(secret)], c);
      // Short overlap so an in-flight upload with the old secret still succeeds.
      await this.db.query(
        `UPDATE device_credentials SET expires_at = now() + interval '5 minutes' WHERE id = $1 AND (expires_at IS NULL OR expires_at > now() + interval '5 minutes')`,
        [credentialId],
        c,
      );
      await this.audit.record({ action: 'device.credential_rotated', actorDeviceId: deviceId, targetType: 'device', targetId: deviceId }, c);
    });
    return { device_secret: secret };
  }

  async recovery(user: UserAuth, id: string) {
    const { device } = await this.getVisible(user, id);
    const recent = await this.db.query(
      `SELECT id, event_type, severity, occurred_at, received_at, metadata FROM activity_events
        WHERE device_id = $1 ORDER BY occurred_at DESC LIMIT 25`,
      [device.id],
    );
    const openAlerts = await this.db.query(
      `SELECT id, title, severity, created_at FROM security_alerts WHERE device_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 10`,
      [device.id],
    );
    const lastStatus = await this.db.one(
      `SELECT event_type, occurred_at, metadata FROM activity_events
        WHERE device_id = $1 AND event_type IN ('user_login','user_logout','screen_locked','screen_unlocked','device_shutdown','device_startup','agent_stopped','monitoring_paused')
        ORDER BY occurred_at DESC LIMIT 1`,
      [device.id],
    );
    return { device, last_known_state: lastStatus ?? null, recent_events: recent, open_alerts: openAlerts };
  }
}
