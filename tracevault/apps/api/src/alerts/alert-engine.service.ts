import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ValidatedEvent } from '@tracevault/event-schema';
import { AppConfig, CONFIG } from '../config';
import { MailService } from '../common/mail.service';
import { SEVERITY_RANK } from '../common/pagination';
import { Db, Queryable } from '../db/db.service';

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface NewAlert {
  ownerUserId: string;
  organizationId: string | null;
  deviceId: string | null;
  rule: string;
  title: string;
  severity: Severity;
  /** confirmed: the evidence directly shows it. likely/possible: an inference. */
  confidence: 'confirmed' | 'likely' | 'possible';
  evidenceEventIds?: string[];
  explanation: string;
  recommendedAction: string;
  dedupeKey?: string;
}

interface DeviceRef {
  id: string;
  name: string;
  owner_user_id: string;
  organization_id: string | null;
}

type InsertedEvent = ValidatedEvent & { id: string };

const SECURITY_CONTROLS = [
  'firewall',
  'antivirus',
  'defender',
  'real_time_protection',
  'screen_lock',
  'disk_encryption',
  'uac',
  'gatekeeper',
  'sip',
];
const FAILED_LOGIN_THRESHOLD = 5;
const FAILED_LOGIN_WINDOW_MIN = 10;

/**
 * Rule-based detection. Each rule states whether its conclusion is directly
 * observed ("confirmed") or inferred ("likely"/"possible"); none of them claim
 * an account was compromised — they say what was recorded and what to check.
 */
@Injectable()
export class AlertEngine {
  private readonly logger = new Logger('Alerts');

  constructor(
    private readonly db: Db,
    private readonly mail: MailService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async create(a: NewAlert, client?: Queryable): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO security_alerts (owner_user_id, organization_id, device_id, rule, title, severity, confidence,
          evidence_event_ids, explanation, recommended_action, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::uuid[],$9,$10,$11)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        a.ownerUserId,
        a.organizationId,
        a.deviceId,
        a.rule,
        a.title,
        a.severity,
        a.confidence,
        a.evidenceEventIds ?? [],
        a.explanation,
        a.recommendedAction,
        a.dedupeKey ?? null,
      ],
      client,
    );
    if (row) {
      // Notification failures must not undo the alert; they are logged by MailService.
      this.notify(a).catch((err) => this.logger.error(`notify failed: ${(err as Error).message}`));
    }
    return row?.id ?? null;
  }

  /** Email the device owner and, for org devices, members who can resolve alerts. */
  private async notify(a: NewAlert) {
    const recipients = await this.db.query<{ email: string; min_severity: string }>(
      `SELECT DISTINCT u.email, np.min_severity FROM users u
         JOIN notification_preferences np ON np.user_id = u.id AND np.channel = 'email' AND np.enabled
        WHERE u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL AND (
          u.id = $1 OR u.id IN (SELECT user_id FROM organization_members
                                 WHERE organization_id = $2 AND role IN ('owner','admin','security_analyst')))`,
      [a.ownerUserId, a.organizationId],
    );
    for (const r of recipients) {
      if (SEVERITY_RANK[a.severity] < SEVERITY_RANK[r.min_severity]) continue;
      await this.mail.send({
        to: r.email,
        subject: `[TraceVault] ${a.severity.toUpperCase()}: ${a.title}`,
        text: `${a.explanation}\n\nConfidence: ${a.confidence}\nRecommended action: ${a.recommendedAction}\n\nReview it at ${this.config.webOrigin}/alerts`,
      });
    }
  }

  async evaluate(device: DeviceRef, events: InsertedEvent[], client?: Queryable): Promise<void> {
    const base = {
      ownerUserId: device.owner_user_id,
      organizationId: device.organization_id,
      deviceId: device.id,
    };
    for (const e of events) {
      const m = e.metadata as Record<string, unknown>;
      const when = new Date(e.occurred_at).toISOString();
      switch (e.event_type) {
        case 'local_account_created':
          await this.create(
            {
              ...base,
              rule: 'local_account_created',
              title: `New local account on ${device.name}`,
              severity: 'high',
              confidence: 'confirmed',
              evidenceEventIds: [e.id],
              explanation: `The operating system reported that a local account${m.account_name ? ` "${String(m.account_name)}"` : ''} was created on ${device.name} at ${when}. This is a recorded system event; it does not by itself show who created it or why.`,
              recommendedAction:
                'If you did not create this account, remove it, change your device password and review other recent events on this device.',
              dedupeKey: `evt:${e.id}`,
            },
            client,
          );
          break;
        case 'privilege_granted':
          await this.create(
            {
              ...base,
              rule: 'privilege_granted',
              title: `Administrator rights granted on ${device.name}`,
              severity: 'high',
              confidence: 'confirmed',
              evidenceEventIds: [e.id],
              explanation: `The operating system reported that administrator privileges were granted${m.account_name ? ` to "${String(m.account_name)}"` : ''} at ${when}.`,
              recommendedAction:
                'Confirm the change was intended. If not, remove the privilege and review accounts on the device.',
              dedupeKey: `evt:${e.id}`,
            },
            client,
          );
          break;
        case 'security_setting_changed': {
          const setting = String(m.setting ?? 'unknown setting');
          const weakened =
            SECURITY_CONTROLS.some((c) => setting.toLowerCase().includes(c)) &&
            (m.new_value === false || m.new_value === 'off' || m.new_value === 'disabled');
          await this.create(
            {
              ...base,
              rule: 'security_setting_changed',
              title: weakened
                ? `${setting} was turned off on ${device.name}`
                : `Security setting changed on ${device.name}`,
              severity: weakened ? 'high' : 'medium',
              confidence: 'confirmed',
              evidenceEventIds: [e.id],
              explanation: `The device reported that "${setting}" changed${m.old_value !== undefined ? ` from ${String(m.old_value)}` : ''}${m.new_value !== undefined ? ` to ${String(m.new_value)}` : ''} at ${when}.`,
              recommendedAction: weakened
                ? 'Turn the protection back on unless you disabled it yourself, then check for other unexpected changes.'
                : 'Confirm this change was intended.',
              dedupeKey: `evt:${e.id}`,
            },
            client,
          );
          break;
        }
        case 'agent_stopped':
          if (m.reason !== 'user_requested' && m.reason !== 'system_shutdown') {
            await this.create(
              {
                ...base,
                rule: 'agent_stopped_unexpectedly',
                title: `TraceVault stopped unexpectedly on ${device.name}`,
                severity: 'medium',
                confidence: 'likely',
                evidenceEventIds: [e.id],
                explanation: `The agent reported it stopped at ${when} (reason: ${String(m.reason ?? 'not given')}). Activity after this time may not have been recorded.`,
                recommendedAction:
                  'Check that TraceVault is running on the device and that its permissions have not been removed.',
                dedupeKey: `evt:${e.id}`,
              },
              client,
            );
          }
          break;
        case 'monitoring_permission_changed':
          if (m.new_value === 'denied' || m.new_value === false) {
            await this.create(
              {
                ...base,
                rule: 'monitoring_permission_removed',
                title: `A monitoring permission was removed on ${device.name}`,
                severity: 'medium',
                confidence: 'confirmed',
                evidenceEventIds: [e.id],
                explanation: `Permission "${String(m.permission ?? 'unknown')}" was reported as removed at ${when}. Events that depend on it will no longer be recorded.`,
                recommendedAction:
                  'If you did not remove it, re-grant the permission in the device settings.',
                dedupeKey: `evt:${e.id}`,
              },
              client,
            );
          }
          break;
        case 'recording_started':
          await this.create(
            {
              ...base,
              rule: 'recording_started',
              title: `A ${String(m.kind ?? 'screen')} recording was started on ${device.name}`,
              severity: 'info',
              confidence: 'confirmed',
              evidenceEventIds: [e.id],
              explanation: `A visible, user-started recording session began at ${when}.`,
              recommendedAction: 'No action needed if this was expected.',
              dedupeKey: `evt:${e.id}`,
            },
            client,
          );
          break;
      }
    }

    if (events.some((e) => e.event_type === 'login_failed')) {
      const recent = await this.db.query<{ id: string; occurred_at: Date }>(
        `SELECT id, occurred_at FROM activity_events
          WHERE device_id = $1 AND event_type = 'login_failed'
            AND occurred_at > (SELECT max(occurred_at) FROM activity_events WHERE device_id = $1 AND event_type = 'login_failed')
                              - ($2 || ' minutes')::interval
          ORDER BY occurred_at DESC LIMIT 50`,
        [device.id, String(FAILED_LOGIN_WINDOW_MIN)],
        client,
      );
      if (recent.length >= FAILED_LOGIN_THRESHOLD) {
        const bucket = Math.floor(
          recent[0].occurred_at.getTime() / (FAILED_LOGIN_WINDOW_MIN * 60_000),
        );
        await this.create(
          {
            ...base,
            rule: 'repeated_failed_logins',
            title: `${recent.length} failed sign-in attempts on ${device.name}`,
            severity: 'medium',
            confidence: 'likely',
            evidenceEventIds: recent.slice(0, 20).map((r) => r.id),
            explanation: `${recent.length} failed sign-in attempts were recorded within ${FAILED_LOGIN_WINDOW_MIN} minutes. This pattern can mean someone was guessing the password, but it can also be a mistyped password or a saved password that changed.`,
            recommendedAction:
              'If you were not trying to sign in, use a stronger device password and check whether a successful sign-in followed.',
            dedupeKey: `burst:${device.id}:${bucket}`,
          },
          client,
        );
      }
    }
  }
}
