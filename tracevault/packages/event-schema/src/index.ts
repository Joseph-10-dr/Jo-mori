import { z } from 'zod';

/**
 * TraceVault activity event contract (schema_version 1).
 *
 * Every client (simulator, Windows agent, future macOS/mobile apps) and the API
 * validate against this file. Metadata is deliberately restricted: flat, small,
 * primitive values only, with keys that look like credentials rejected outright.
 */

export const SCHEMA_VERSION = 1 as const;

export const LIMITS = {
  maxEventsPerBatch: 500,
  maxBatchBytes: 512 * 1024,
  maxMetadataKeys: 20,
  maxMetadataKeyLength: 64,
  maxMetadataStringLength: 512,
  /** Events may arrive late (offline queue) but not from the far past or future. */
  maxPastDays: 30,
  maxFutureMinutes: 10,
} as const;

export const EVENT_SOURCES = ['windows', 'macos', 'android', 'ios', 'web', 'simulator'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Human-readable labels; also the authoritative list of supported event types. */
export const EVENT_TYPES = {
  device_startup: 'Device started',
  device_shutdown: 'Device shut down',
  user_login: 'User signed in',
  user_logout: 'User signed out',
  login_failed: 'Sign-in attempt failed',
  screen_locked: 'Screen locked',
  screen_unlocked: 'Screen unlocked',
  application_started: 'Application started',
  application_exited: 'Application exited',
  security_setting_changed: 'Security setting changed',
  local_account_created: 'Local account created',
  local_account_deleted: 'Local account deleted',
  privilege_granted: 'Admin privilege granted',
  file_created: 'Watched file created',
  file_modified: 'Watched file modified',
  file_deleted: 'Watched file deleted',
  usb_device_connected: 'Removable device connected',
  recording_started: 'Recording started',
  recording_stopped: 'Recording stopped',
  monitoring_paused: 'Monitoring paused',
  monitoring_resumed: 'Monitoring resumed',
  monitoring_permission_changed: 'Monitoring permission changed',
  agent_started: 'TraceVault agent started',
  agent_stopped: 'TraceVault agent stopped',
  sync_failed: 'Upload to cloud failed',
  sync_recovered: 'Upload to cloud recovered',
} as const;
export type EventType = keyof typeof EVENT_TYPES;
export const EVENT_TYPE_KEYS = Object.keys(EVENT_TYPES) as [EventType, ...EventType[]];

/**
 * Metadata keys that suggest secrets or private content. Any key containing one
 * of these fragments is rejected so clients cannot (accidentally) ship them.
 */
export const FORBIDDEN_METADATA_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'cookie',
  'session',
  'apikey',
  'api_key',
  'credential',
  'keystroke',
  'message_body',
  'content',
  'clipboard',
  'private_key',
] as const;

const metadataKey = z
  .string()
  .min(1)
  .max(LIMITS.maxMetadataKeyLength)
  .regex(/^[a-z][a-z0-9_]*$/, 'metadata keys must be snake_case ASCII')
  .refine(
    (k) => !FORBIDDEN_METADATA_KEY_FRAGMENTS.some((f) => k.includes(f)),
    'metadata key looks like a credential or private content and is not allowed',
  );

// Strip control characters (except none) so metadata cannot smuggle terminal escapes
// or break log lines. Rendering layers must still escape HTML.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const metadataValue = z.union([
  z
    .string()
    .max(LIMITS.maxMetadataStringLength)
    .transform((s) => s.replace(CONTROL_CHARS, ' ').trim()),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const metadataSchema = z
  .record(metadataKey, metadataValue)
  .refine((m) => Object.keys(m).length <= LIMITS.maxMetadataKeys, {
    message: `metadata may contain at most ${LIMITS.maxMetadataKeys} keys`,
  });

export type EventMetadata = z.infer<typeof metadataSchema>;

/** What a device sends. Note: no owner/org fields — the server resolves those. */
export const deviceEventSchema = z
  .object({
    event_id: z.string().uuid(),
    event_type: z.enum(EVENT_TYPE_KEYS),
    occurred_at: z.string().datetime({ offset: true }),
    source: z.enum(EVENT_SOURCES),
    severity: z.enum(SEVERITIES).default('info'),
    metadata: metadataSchema.default({}),
    schema_version: z.literal(SCHEMA_VERSION),
  })
  .strict();

export type DeviceEventInput = z.input<typeof deviceEventSchema>;
export type DeviceEvent = z.output<typeof deviceEventSchema>;

export const eventBatchSchema = z
  .object({
    events: z.array(z.unknown()).min(1).max(LIMITS.maxEventsPerBatch),
  })
  .strict();

/** Normalise to UTC ISO string and check the timestamp is in an acceptable window. */
export function normalizeOccurredAt(
  iso: string,
  now: Date = new Date(),
): { ok: true; value: string } | { ok: false; reason: string } {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return { ok: false, reason: 'invalid timestamp' };
  const pastLimit = now.getTime() - LIMITS.maxPastDays * 86_400_000;
  const futureLimit = now.getTime() + LIMITS.maxFutureMinutes * 60_000;
  if (t.getTime() < pastLimit) return { ok: false, reason: 'timestamp is too far in the past' };
  if (t.getTime() > futureLimit) return { ok: false, reason: 'timestamp is in the future' };
  return { ok: true, value: t.toISOString() };
}

export type ValidatedEvent = DeviceEvent & { occurred_at: string };
export type EventRejection = { index: number; event_id?: string; reason: string };

/**
 * Validate each event independently so one bad event does not drop a whole
 * batch. Returns accepted events (normalised) and per-index rejections.
 */
export function validateEvents(
  raw: unknown[],
  now: Date = new Date(),
): { accepted: ValidatedEvent[]; rejected: EventRejection[] } {
  const accepted: ValidatedEvent[] = [];
  const rejected: EventRejection[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const parsed = deviceEventSchema.safeParse(item);
    const maybeId =
      item && typeof item === 'object' && typeof (item as { event_id?: unknown }).event_id === 'string'
        ? ((item as { event_id: string }).event_id as string)
        : undefined;
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      rejected.push({
        index,
        event_id: maybeId,
        reason: `${issue.path.join('.') || 'event'}: ${issue.message}`,
      });
      return;
    }
    const ts = normalizeOccurredAt(parsed.data.occurred_at, now);
    if (!ts.ok) {
      rejected.push({ index, event_id: parsed.data.event_id, reason: `occurred_at: ${ts.reason}` });
      return;
    }
    if (seen.has(parsed.data.event_id)) {
      rejected.push({ index, event_id: parsed.data.event_id, reason: 'duplicate event_id within batch' });
      return;
    }
    seen.add(parsed.data.event_id);
    accepted.push({ ...parsed.data, occurred_at: ts.value });
  });
  return { accepted, rejected };
}

/** Shape returned by the API for stored events. */
export interface StoredEvent {
  id: string;
  event_id: string;
  device_id: string;
  device_name: string;
  event_type: EventType;
  occurred_at: string;
  received_at: string;
  source: EventSource;
  severity: Severity;
  metadata: EventMetadata;
  schema_version: number;
  /** true when received_at - occurred_at exceeds 5 minutes (offline queue / clock drift). */
  delayed: boolean;
}

export interface BatchResult {
  accepted: number;
  duplicates: number;
  rejected: EventRejection[];
  received_at: string;
}
