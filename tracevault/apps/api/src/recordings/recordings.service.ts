import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { roleHas } from '@tracevault/api-contracts';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { AppConfig, CONFIG } from '../config';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { DeviceAuth, UserAuth } from '../common/auth-context';
import { hmac, safeEqual } from '../common/crypto';
import { UsageService } from '../common/usage.service';
import { Db } from '../db/db.service';
import { LocalEncryptedStorage, ObjectStorage, ObjectTooLargeError } from './object-storage';

export const ALLOWED_MIME: Record<'screen' | 'audio', string[]> = {
  screen: ['video/mp4', 'video/webm', 'video/quicktime'],
  audio: ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav'],
};
export const MAX_RECORDING_BYTES = 2 * 1024 ** 3;
const UPLOAD_TICKET_MINUTES = 10;
const DOWNLOAD_TICKET_MINUTES = 5;

export interface UploadRequest {
  kind: 'screen' | 'audio';
  mime_type: string;
  size_bytes: number;
  sha256_hex: string;
  started_at: string;
  stopped_at: string;
  consent: {
    consenting_party: string;
    consent_text: string;
    os_permission: 'granted' | 'denied' | 'not_required';
    indicator_shown: boolean;
    consented_at: string;
  };
}

const RECORDING_COLUMNS = `r.id, r.device_id, d.name AS device_name, r.owner_user_id, r.organization_id, r.kind, r.status,
  r.mime_type, coalesce(r.size_bytes, r.declared_bytes) AS size_bytes, r.started_at, r.stopped_at, r.created_at,
  r.completed_at, r.expires_at,
  extract(epoch FROM (r.stopped_at - r.started_at))::int AS duration_seconds`;

@Injectable()
export class RecordingsService {
  private readonly logger = new Logger('Recordings');
  readonly storage: ObjectStorage;

  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.storage = new LocalEncryptedStorage(config.storageDir, config.dataKey);
  }

  private sign(ticketId: string, purpose: string, exp: number) {
    return hmac(this.config.urlSigningKey, `${ticketId}|${purpose}|${exp}`);
  }

  private signedUrl(ticketId: string, purpose: 'upload' | 'download', exp: number) {
    return `${this.config.publicApiUrl}/v1/storage/${purpose}/${ticketId}?exp=${exp}&sig=${this.sign(ticketId, purpose, exp)}`;
  }

  async createUpload(device: DeviceAuth, req: UploadRequest) {
    if (!ALLOWED_MIME[req.kind].includes(req.mime_type)) {
      throw new BadRequestException(
        `mime_type ${req.mime_type} is not allowed for ${req.kind} recordings`,
      );
    }
    const started = new Date(req.started_at);
    const stopped = new Date(req.stopped_at);
    const seconds = (stopped.getTime() - started.getTime()) / 1000;
    if (!(seconds > 0)) throw new BadRequestException('stopped_at must be after started_at');
    if (req.consent.os_permission !== 'granted' && req.consent.os_permission !== 'not_required') {
      throw new ForbiddenException('The operating-system capture permission was not granted');
    }
    if (!req.consent.indicator_shown) {
      throw new ForbiddenException(
        'Recordings are only accepted when a visible recording indicator was shown',
      );
    }
    if (device.organizationId) {
      const org = await this.db.one<{ recordings_allowed: boolean }>(
        'SELECT recordings_allowed FROM organizations WHERE id = $1',
        [device.organizationId],
      );
      if (!org?.recordings_allowed) {
        throw new ForbiddenException(
          'Your organization has not enabled recordings for managed devices',
        );
      }
    }
    const scope = UsageService.scopeFor(device.ownerUserId, device.organizationId);
    const { plan, limits } = await this.usage.plan(scope);
    if (limits.recordingStorageBytes === 0) {
      throw new ForbiddenException(`Recordings are not included in the ${plan} plan`);
    }
    if (seconds > limits.maxRecordingSeconds) {
      throw new BadRequestException(
        `Recording is longer than the ${limits.maxRecordingSeconds}-second limit for your plan`,
      );
    }
    const used = await this.usage.recordingBytesUsed(scope);
    if (used + req.size_bytes > limits.recordingStorageBytes) {
      throw new PayloadTooLargeException(
        'Recording storage quota exceeded. Delete old recordings or change plan.',
      );
    }
    const retention = await this.db.one<{ days: number }>(
      device.organizationId
        ? 'SELECT recording_retention_days AS days FROM retention_policies WHERE organization_id = $1'
        : 'SELECT recording_retention_days AS days FROM retention_policies WHERE user_id = $1',
      [device.organizationId ?? device.ownerUserId],
    );
    const days = retention?.days ?? 7;

    return this.db.tx(async (c) => {
      const rec = await this.db.one<{ id: string }>(
        `INSERT INTO recordings (device_id, owner_user_id, organization_id, kind, storage_key, mime_type, declared_bytes, sha256_hex,
            started_at, stopped_at, expires_at)
         VALUES ($1,$2,$3,$4, 'pending/' || gen_random_uuid(), $5,$6,$7,$8,$9, $9::timestamptz + ($10 || ' days')::interval)
         RETURNING id`,
        [
          device.deviceId,
          device.ownerUserId,
          device.organizationId,
          req.kind,
          req.mime_type,
          req.size_bytes,
          req.sha256_hex.toLowerCase(),
          started,
          stopped,
          String(days),
        ],
        c,
      );
      const storageKey = `${device.organizationId ?? device.ownerUserId}/${rec!.id}`;
      await this.db.query(
        'UPDATE recordings SET storage_key = $2 WHERE id = $1',
        [rec!.id, storageKey],
        c,
      );
      await this.db.query(
        `INSERT INTO recording_consents (recording_id, device_id, consenting_party, consent_text, os_permission, indicator_shown, consented_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          rec!.id,
          device.deviceId,
          req.consent.consenting_party,
          req.consent.consent_text,
          req.consent.os_permission,
          req.consent.indicator_shown,
          req.consent.consented_at,
        ],
        c,
      );
      const ticket = await this.db.one<{ id: string; expires_at: Date }>(
        `INSERT INTO storage_tickets (recording_id, purpose, expires_at) VALUES ($1, 'upload', now() + ($2 || ' minutes')::interval)
         RETURNING id, expires_at`,
        [rec!.id, String(UPLOAD_TICKET_MINUTES)],
        c,
      );
      await this.audit.record(
        {
          action: 'recording.upload_requested',
          actorDeviceId: device.deviceId,
          organizationId: device.organizationId,
          subjectUserId: device.ownerUserId,
          targetType: 'recording',
          targetId: rec!.id,
          details: { kind: req.kind, bytes: req.size_bytes, seconds },
          sensitive: true,
        },
        c,
      );
      const exp = Math.floor(ticket!.expires_at.getTime() / 1000);
      return {
        recording_id: rec!.id,
        upload_url: this.signedUrl(ticket!.id, 'upload', exp),
        method: 'PUT',
        headers: { 'Content-Type': req.mime_type },
        expires_at: ticket!.expires_at.toISOString(),
      };
    });
  }

  /** Validates signature, expiry and single use; marks the ticket used atomically. */
  private async consumeTicket(
    ticketId: string,
    purpose: 'upload' | 'download',
    exp: string,
    sig: string,
  ) {
    const expNum = Number(exp);
    if (
      !/^[0-9a-f-]{36}$/i.test(ticketId) ||
      !Number.isInteger(expNum) ||
      !sig ||
      !safeEqual(sig, this.sign(ticketId, purpose, expNum))
    ) {
      throw new ForbiddenException('Invalid signature');
    }
    if (expNum * 1000 < Date.now()) throw new GoneException('This link has expired');
    const t = await this.db.one<{ recording_id: string }>(
      `UPDATE storage_tickets SET used_at = now()
        WHERE id = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() RETURNING recording_id`,
      [ticketId, purpose],
    );
    if (!t) throw new GoneException('This link has expired or was already used');
    return t.recording_id;
  }

  async receiveUpload(
    ticketId: string,
    exp: string,
    sig: string,
    contentType: string | undefined,
    body: Readable,
  ) {
    const recordingId = await this.consumeTicket(ticketId, 'upload', exp, sig);
    const rec = await this.db.one<{
      storage_key: string;
      declared_bytes: string;
      mime_type: string;
      status: string;
    }>('SELECT storage_key, declared_bytes, mime_type, status FROM recordings WHERE id = $1', [
      recordingId,
    ]);
    if (!rec || rec.status !== 'pending_upload')
      throw new GoneException('Recording is not awaiting upload');
    if ((contentType ?? '').split(';')[0].trim() !== rec.mime_type) {
      throw new BadRequestException(`Content-Type must be ${rec.mime_type}`);
    }
    try {
      const stored = await this.storage.put(rec.storage_key, body, Number(rec.declared_bytes));
      await this.db.query('UPDATE recordings SET size_bytes = $2 WHERE id = $1', [
        recordingId,
        stored.size,
      ]);
      return { received_bytes: stored.size };
    } catch (err) {
      if (err instanceof ObjectTooLargeError) {
        await this.db.query(`UPDATE recordings SET status = 'failed' WHERE id = $1`, [recordingId]);
        throw new PayloadTooLargeException('Upload is larger than declared');
      }
      throw err;
    }
  }

  /** Device confirms the upload; the server re-hashes the stored object before making it available. */
  async complete(device: DeviceAuth, id: string) {
    const rec = await this.db.one<{
      id: string;
      storage_key: string;
      declared_bytes: string;
      size_bytes: string | null;
      sha256_hex: string;
      status: string;
    }>(
      `SELECT id, storage_key, declared_bytes, size_bytes, sha256_hex, status FROM recordings WHERE id = $1 AND device_id = $2`,
      [id, device.deviceId],
    );
    if (!rec) throw new NotFoundException('Recording not found');
    if (rec.status === 'available') return { status: 'available' };
    if (rec.status !== 'pending_upload') throw new GoneException(`Recording is ${rec.status}`);
    let actual: { size: number; sha: string } | null = null;
    try {
      const h = createHash('sha256');
      let size = 0;
      for await (const chunk of await this.storage.get(rec.storage_key)) {
        size += (chunk as Buffer).length;
        h.update(chunk as Buffer);
      }
      actual = { size, sha: h.digest('hex') };
    } catch {
      actual = null;
    }
    const ok =
      actual && actual.size === Number(rec.declared_bytes) && actual.sha === rec.sha256_hex;
    if (!ok) {
      await this.storage.delete(rec.storage_key);
      await this.db.query(`UPDATE recordings SET status = 'failed' WHERE id = $1`, [rec.id]);
      throw new BadRequestException(
        actual
          ? 'Uploaded file does not match the declared size or SHA-256'
          : 'No uploaded file found',
      );
    }
    await this.db.query(
      `UPDATE recordings SET status = 'available', completed_at = now() WHERE id = $1`,
      [rec.id],
    );
    await this.usage.add(
      UsageService.scopeFor(device.ownerUserId, device.organizationId),
      'recording_bytes_stored',
      actual!.size,
    );
    return { status: 'available' };
  }

  async list(user: UserAuth) {
    const scope = await this.access.scope(user.userId);
    // Recordings: own, or orgs where the role explicitly has recordings.view (owner only by default).
    const orgIds = [...scope.roles]
      .filter(([, r]) => roleHas(r, 'recordings.view'))
      .map(([id]) => id);
    return this.db.query(
      `SELECT ${RECORDING_COLUMNS} FROM recordings r JOIN devices d ON d.id = r.device_id
        WHERE ${AccessService.visibleSql('r', 1, 2)} AND r.status <> 'deleted' ORDER BY r.created_at DESC LIMIT 200`,
      [user.userId, orgIds],
    );
  }

  private async loadForAccess(user: UserAuth, id: string) {
    const rec = await this.db.one<{
      id: string;
      owner_user_id: string;
      organization_id: string | null;
      storage_key: string;
      status: string;
      mime_type: string;
      size_bytes: string;
    }>(
      `SELECT r.id, r.owner_user_id, r.organization_id, r.storage_key, r.status, r.mime_type, coalesce(r.size_bytes, r.declared_bytes) AS size_bytes
         FROM recordings r WHERE r.id = $1`,
      [id],
    );
    if (!rec || rec.status === 'deleted') throw new NotFoundException('Recording not found');
    if (rec.owner_user_id === user.userId) return rec;
    if (rec.organization_id) {
      // Throws 404 for non-members, 403 without recordings.view, and requires MFA.
      await this.access.requireOrgPermission(user, rec.organization_id, 'recordings.view');
      return rec;
    }
    throw new NotFoundException('Recording not found');
  }

  async createDownload(user: UserAuth, id: string, ip: string | null) {
    const rec = await this.loadForAccess(user, id);
    if (rec.status !== 'available') throw new BadRequestException('Recording is not available');
    const t = await this.db.one<{ id: string; expires_at: Date }>(
      `INSERT INTO storage_tickets (recording_id, purpose, expires_at) VALUES ($1, 'download', now() + ($2 || ' minutes')::interval)
       RETURNING id, expires_at`,
      [rec.id, String(DOWNLOAD_TICKET_MINUTES)],
    );
    await this.audit.record({
      action: 'recording.download_link_issued',
      actorUserId: user.userId,
      organizationId: rec.organization_id,
      subjectUserId: rec.owner_user_id,
      targetType: 'recording',
      targetId: rec.id,
      ip,
      sensitive: true,
    });
    const exp = Math.floor(t!.expires_at.getTime() / 1000);
    return {
      download_url: this.signedUrl(t!.id, 'download', exp),
      expires_at: t!.expires_at.toISOString(),
    };
  }

  async openDownload(ticketId: string, exp: string, sig: string) {
    const recordingId = await this.consumeTicket(ticketId, 'download', exp, sig);
    const rec = await this.db.one<{
      storage_key: string;
      mime_type: string;
      size_bytes: string;
      owner_user_id: string;
      organization_id: string | null;
      status: string;
    }>(
      'SELECT storage_key, mime_type, size_bytes, owner_user_id, organization_id, status FROM recordings WHERE id = $1',
      [recordingId],
    );
    if (!rec || rec.status !== 'available')
      throw new GoneException('Recording is no longer available');
    await this.usage.add(
      UsageService.scopeFor(rec.owner_user_id, rec.organization_id),
      'recording_bytes_downloaded',
      Number(rec.size_bytes),
    );
    await this.audit.record({
      action: 'recording.downloaded',
      organizationId: rec.organization_id,
      subjectUserId: rec.owner_user_id,
      targetType: 'recording',
      targetId: recordingId,
      sensitive: true,
    });
    return {
      stream: await this.storage.get(rec.storage_key),
      mime: rec.mime_type,
      size: Number(rec.size_bytes),
    };
  }

  async remove(user: UserAuth, id: string) {
    const rec = await this.loadForAccess(user, id);
    await this.storage.delete(rec.storage_key);
    await this.db.query(
      `UPDATE recordings SET status = 'deleted', deleted_at = now() WHERE id = $1`,
      [rec.id],
    );
    await this.audit.record({
      action: 'recording.deleted',
      actorUserId: user.userId,
      organizationId: rec.organization_id,
      subjectUserId: rec.owner_user_id,
      targetType: 'recording',
      targetId: rec.id,
      sensitive: true,
    });
  }

  async deleteObjectsForDevice(deviceId: string) {
    const rows = await this.db.query<{ storage_key: string }>(
      'SELECT storage_key FROM recordings WHERE device_id = $1',
      [deviceId],
    );
    for (const r of rows) await this.storage.delete(r.storage_key);
  }

  async deleteObjectsWhere(sql: string, params: unknown[]) {
    const rows = await this.db.query<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM recordings WHERE ${sql}`,
      params,
    );
    for (const r of rows) {
      await this.storage
        .delete(r.storage_key)
        .catch((err) => this.logger.error(`delete ${r.id} failed: ${(err as Error).message}`));
    }
    return rows.map((r) => r.id);
  }
}
