import { Injectable } from '@nestjs/common';
import { EVENT_TYPES, EventType } from '@tracevault/event-schema';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { UserAuth } from '../common/auth-context';
import { UsageService } from '../common/usage.service';
import { Db } from '../db/db.service';

export interface SummaryEvent {
  id: string;
  device_id: string;
  device_name: string;
  event_type: EventType;
  severity: string;
  occurred_at: Date;
  received_at: Date;
  metadata: Record<string, unknown>;
}

export interface SummaryAlert {
  id: string;
  title: string;
  severity: string;
  confidence: string;
  created_at: Date;
  evidence_event_ids: string[];
}

export interface SummaryInput {
  question: string;
  window: { from: Date; to: Date; label: string };
  devices: {
    id: string;
    name: string;
    platform: string;
    monitoring_status: string;
    last_seen_at: Date | null;
  }[];
  events: SummaryEvent[];
  alerts: SummaryAlert[];
  truncated: boolean;
}

export interface Statement {
  text: string;
  kind: 'fact' | 'inference' | 'gap' | 'advice';
  /** Supporting event ids; facts and inferences always cite evidence. */
  event_ids: string[];
}

export interface SummaryOutput {
  provider: string;
  question: string;
  window: { from: string; to: string; label: string };
  headline: string;
  statements: Statement[];
  evidence: {
    id: string;
    event_type: string;
    label: string;
    device_name: string;
    occurred_at: string;
    severity: string;
  }[];
  completeness: string;
}

/**
 * Summary providers turn already-authorized, structured records into text.
 * They never fetch data themselves. A future LLM adapter must: receive only
 * this SummaryInput, treat every metadata string as untrusted data (never as
 * instructions), and return statements that cite event ids, which the service
 * validates against the input before returning anything.
 */
export interface SummaryProvider {
  readonly name: string;
  summarize(
    input: SummaryInput,
  ): Promise<Omit<SummaryOutput, 'evidence' | 'window' | 'question' | 'provider'>>;
}

const NOTABLE: EventType[] = [
  'login_failed',
  'user_login',
  'security_setting_changed',
  'local_account_created',
  'local_account_deleted',
  'privilege_granted',
  'usb_device_connected',
  'agent_stopped',
  'monitoring_paused',
  'monitoring_permission_changed',
  'recording_started',
  'file_deleted',
];

const fmt = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** Quotes untrusted metadata as data: trimmed, length-capped, no newlines. */
function quote(v: unknown): string {
  return JSON.stringify(
    String(v ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 80),
  );
}

export class DeterministicSummaryProvider implements SummaryProvider {
  readonly name = 'deterministic-v1';

  async summarize(input: SummaryInput) {
    const { events, alerts, devices, question } = input;
    const statements: Statement[] = [];
    const q = question.toLowerCase();

    if (events.length === 0) {
      statements.push({
        kind: 'fact',
        text: `No activity was recorded for ${devices.length === 1 ? devices[0].name : 'your devices'} between ${fmt(input.window.from)} and ${fmt(input.window.to)}.`,
        event_ids: [],
      });
    } else {
      const counts = new Map<string, SummaryEvent[]>();
      for (const e of events) counts.set(e.event_type, [...(counts.get(e.event_type) ?? []), e]);
      const parts = [...counts.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 6)
        .map(([t, list]) => `${list.length} × ${EVENT_TYPES[t as EventType] ?? t}`);
      statements.push({
        kind: 'fact',
        text: `${events.length} events were recorded from ${new Set(events.map((e) => e.device_id)).size} device(s): ${parts.join(', ')}.`,
        event_ids: events.slice(0, 5).map((e) => e.id),
      });
      const first = events[0];
      const last = events[events.length - 1];
      statements.push({
        kind: 'fact',
        text: `The first recorded event was ${EVENT_TYPES[first.event_type]} at ${fmt(first.occurred_at)} on ${first.device_name}; the last was ${EVENT_TYPES[last.event_type]} at ${fmt(last.occurred_at)}.`,
        event_ids: [first.id, last.id],
      });
    }

    for (const t of NOTABLE) {
      const list = events.filter((e) => e.event_type === t);
      if (!list.length) continue;
      const sample = list.slice(0, 3);
      const detail = sample
        .map((e) => {
          const m = e.metadata;
          const what =
            m.setting ?? m.account_name ?? m.application ?? m.permission ?? m.path ?? m.reason;
          return `${fmt(e.occurred_at)}${what !== undefined ? ` (${quote(what)})` : ''}`;
        })
        .join('; ');
      statements.push({
        kind: 'fact',
        text: `${EVENT_TYPES[t]}: ${list.length} time(s) — ${detail}${list.length > 3 ? '; …' : ''}.`,
        event_ids: list.slice(0, 10).map((e) => e.id),
      });
    }

    // Inference: a successful sign-in shortly after several failures.
    const failures = events.filter((e) => e.event_type === 'login_failed');
    for (const login of events.filter((e) => e.event_type === 'user_login')) {
      const prior = failures.filter(
        (f) =>
          f.device_id === login.device_id &&
          f.occurred_at < login.occurred_at &&
          login.occurred_at.getTime() - f.occurred_at.getTime() < 15 * 60_000,
      );
      if (prior.length >= 3) {
        statements.push({
          kind: 'inference',
          text: `A successful sign-in at ${fmt(login.occurred_at)} on ${login.device_name} followed ${prior.length} failed attempts within 15 minutes. This could be you mistyping a password, or someone guessing it; the records cannot tell which.`,
          event_ids: [...prior.map((p) => p.id), login.id],
        });
      }
    }

    for (const a of alerts) {
      statements.push({
        kind: a.confidence === 'confirmed' ? 'fact' : 'inference',
        text: `Alert (${a.severity}, ${a.confidence}): ${a.title} — raised ${fmt(a.created_at)}.`,
        event_ids: a.evidence_event_ids,
      });
    }

    // Gaps: delayed uploads, monitoring not active, long silences.
    const delayed = events.filter(
      (e) => e.received_at.getTime() - e.occurred_at.getTime() > 5 * 60_000,
    );
    if (delayed.length) {
      statements.push({
        kind: 'gap',
        text: `${delayed.length} event(s) reached the cloud more than 5 minutes after they happened (the device was offline or its clock was off). Their times come from the device.`,
        event_ids: delayed.slice(0, 5).map((e) => e.id),
      });
    }
    for (const d of devices) {
      if (d.monitoring_status !== 'active') {
        statements.push({
          kind: 'gap',
          text: `Monitoring on ${d.name} is currently ${d.monitoring_status}, so some activity may not be recorded.`,
          event_ids: [],
        });
      }
      const devEvents = events.filter((e) => e.device_id === d.id);
      for (let i = 1; i < devEvents.length; i++) {
        const gapMs = devEvents[i].occurred_at.getTime() - devEvents[i - 1].occurred_at.getTime();
        if (gapMs > 6 * 3600_000) {
          statements.push({
            kind: 'gap',
            text: `No events were recorded on ${d.name} between ${fmt(devEvents[i - 1].occurred_at)} and ${fmt(devEvents[i].occurred_at)}. The device may have been off, asleep, or not reporting.`,
            event_ids: [devEvents[i - 1].id, devEvents[i].id],
          });
        }
      }
    }
    if (input.truncated) {
      statements.push({
        kind: 'gap',
        text: 'Only the most recent 500 events in this period were analysed; narrow the time range for a complete summary.',
        event_ids: [],
      });
    }
    statements.push({
      kind: 'gap',
      text: 'TraceVault only records the event types its agent supports on each platform. It does not see website contents, messages, or activity inside apps, so absence of an event is not proof nothing happened.',
      event_ids: [],
    });

    // Advice is generic guidance, never a claim about what happened.
    if (/email|gmail|outlook|account|password/.test(q)) {
      statements.push({
        kind: 'advice',
        text: 'To secure your email: change its password from a device you trust, turn on two-step verification, review "recent security activity" / signed-in devices in the provider\'s settings and sign out unknown sessions, and check forwarding rules and recovery phone/email.',
        event_ids: [],
      });
    }
    if (
      events.some((e) =>
        ['local_account_created', 'privilege_granted', 'security_setting_changed'].includes(
          e.event_type,
        ),
      )
    ) {
      statements.push({
        kind: 'advice',
        text: 'Review the accounts and security settings listed above on the device itself and undo anything you did not change.',
        event_ids: [],
      });
    }

    const notableCount =
      events.filter((e) => ['medium', 'high', 'critical'].includes(e.severity)).length +
      alerts.length;
    const headline =
      events.length === 0
        ? 'Nothing was recorded in this period.'
        : notableCount === 0
          ? `${events.length} routine events recorded; nothing flagged as unusual.`
          : `${events.length} events recorded, ${notableCount} worth reviewing.`;
    return {
      headline,
      statements,
      completeness: input.truncated
        ? 'partial'
        : events.length
          ? 'complete for recorded event types'
          : 'no data',
    };
  }
}

/** Parses simple time phrases; anything else falls back to the last 24 hours. */
export function resolveWindow(
  question: string,
  now = new Date(),
  explicit?: { from?: string; to?: string },
) {
  if (explicit?.from && explicit?.to)
    return { from: new Date(explicit.from), to: new Date(explicit.to), label: 'selected period' };
  const q = question.toLowerCase();
  const startOfDay = (d: Date) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const today = startOfDay(now);
  const day = 86_400_000;
  if (/yesterday/.test(q)) {
    const y = new Date(today.getTime() - day);
    if (/afternoon/.test(q))
      return {
        from: new Date(y.getTime() + 12 * 3600_000),
        to: new Date(y.getTime() + 18 * 3600_000),
        label: 'yesterday afternoon (12:00–18:00 UTC)',
      };
    if (/morning/.test(q))
      return {
        from: new Date(y.getTime() + 6 * 3600_000),
        to: new Date(y.getTime() + 12 * 3600_000),
        label: 'yesterday morning (06:00–12:00 UTC)',
      };
    if (/evening|night/.test(q))
      return {
        from: new Date(y.getTime() + 18 * 3600_000),
        to: today,
        label: 'yesterday evening (18:00–24:00 UTC)',
      };
    return { from: y, to: today, label: 'yesterday (UTC)' };
  }
  if (/today/.test(q)) return { from: today, to: now, label: 'today (UTC)' };
  if (/week|7 days/.test(q))
    return { from: new Date(now.getTime() - 7 * day), to: now, label: 'last 7 days' };
  if (/month|30 days/.test(q))
    return { from: new Date(now.getTime() - 30 * day), to: now, label: 'last 30 days' };
  return { from: new Date(now.getTime() - day), to: now, label: 'last 24 hours' };
}

@Injectable()
export class SummaryService {
  private readonly provider: SummaryProvider = new DeterministicSummaryProvider();

  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
  ) {}

  async summarize(
    user: UserAuth,
    req: { question: string; device_id?: string; alert_id?: string; from?: string; to?: string },
  ): Promise<SummaryOutput> {
    // 1–2: authenticated by the guard; scope comes from server-side membership.
    const scope = await this.access.scope(user.userId);
    let window = resolveWindow(req.question, new Date(), req);
    let deviceFilter = req.device_id ?? null;
    if (req.alert_id) {
      const a = await this.db.one<{ created_at: Date; device_id: string | null }>(
        `SELECT created_at, device_id FROM security_alerts a WHERE id = $3 AND ${AccessService.visibleSql('a', 1, 2)}`,
        [scope.userId, scope.viewAllOrgIds, req.alert_id],
      );
      if (a) {
        window = {
          from: new Date(a.created_at.getTime() - 2 * 3600_000),
          to: new Date(a.created_at.getTime() + 3600_000),
          label: 'two hours before to one hour after the alert',
        };
        deviceFilter = a.device_id ?? deviceFilter;
      }
    }
    // 3: retrieve only what the requester may see, only in the window.
    const devices = await this.db.query<SummaryInput['devices'][number]>(
      `SELECT d.id, d.name, d.platform, d.monitoring_status, d.last_seen_at FROM devices d
        WHERE ${AccessService.visibleSql('d', 1, 2)} AND ($3::uuid IS NULL OR d.id = $3)`,
      [scope.userId, scope.viewAllOrgIds, deviceFilter],
    );
    const ids = devices.map((d) => d.id);
    const events = await this.db.query<SummaryEvent>(
      `SELECT e.id, e.device_id, d.name AS device_name, e.event_type, e.severity, e.occurred_at, e.received_at, e.metadata
         FROM activity_events e JOIN devices d ON d.id = e.device_id
        WHERE e.device_id = ANY($1::uuid[]) AND e.occurred_at >= $2 AND e.occurred_at < $3
        ORDER BY e.occurred_at DESC LIMIT 501`,
      [ids, window.from, window.to],
    );
    const truncated = events.length > 500;
    const used = events.slice(0, 500).reverse();
    const alerts = await this.db.query<SummaryAlert>(
      `SELECT id, title, severity, confidence, created_at, evidence_event_ids FROM security_alerts
        WHERE device_id = ANY($1::uuid[]) AND created_at >= $2 AND created_at < $3 ORDER BY created_at`,
      [ids, window.from, window.to],
    );
    // 4–5: structured input to the provider.
    const out = await this.provider.summarize({
      question: req.question,
      window,
      devices,
      events: used,
      alerts,
      truncated,
    });
    // 6: drop any citation that is not in the retrieved, authorized set.
    const known = new Set(used.map((e) => e.id));
    const statements = out.statements.map((s) => ({
      ...s,
      event_ids: s.event_ids.filter((id) => known.has(id)),
    }));
    const cited = new Set(statements.flatMap((s) => s.event_ids));
    // 8: audit the investigation.
    await this.audit.record({
      action: 'summary.generated',
      actorUserId: user.userId,
      subjectUserId: user.userId,
      details: {
        provider: this.provider.name,
        window: window.label,
        device_id: deviceFilter,
        events: used.length,
      },
    });
    await this.usage.add({ userId: user.userId, organizationId: null }, 'summaries_generated', 1);
    return {
      provider: this.provider.name,
      question: req.question,
      window: { from: window.from.toISOString(), to: window.to.toISOString(), label: window.label },
      headline: out.headline,
      statements,
      evidence: used
        .filter((e) => cited.has(e.id))
        .map((e) => ({
          id: e.id,
          event_type: e.event_type,
          label: EVENT_TYPES[e.event_type] ?? e.event_type,
          device_name: e.device_name,
          occurred_at: e.occurred_at.toISOString(),
          severity: e.severity,
        })),
      completeness: out.completeness,
    };
  }
}
