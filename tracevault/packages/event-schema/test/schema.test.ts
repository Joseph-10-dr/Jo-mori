import { randomUUID } from 'crypto';
import { LIMITS, normalizeOccurredAt, validateEvents } from '../src';

const now = new Date('2026-10-21T12:00:00Z');
const good = (over: Record<string, unknown> = {}) => ({
  event_id: randomUUID(),
  event_type: 'application_started',
  occurred_at: '2026-10-21T11:59:00+01:00',
  source: 'simulator',
  severity: 'info',
  metadata: { application: 'browser' },
  schema_version: 1,
  ...over,
});

describe('event schema', () => {
  it('accepts a valid event and normalises the timestamp to UTC', () => {
    const r = validateEvents([good()], now);
    expect(r.rejected).toEqual([]);
    expect(r.accepted[0].occurred_at).toBe('2026-10-21T10:59:00.000Z');
  });

  it('rejects unknown event types and fields', () => {
    const r = validateEvents([good({ event_type: 'keystroke' }), good({ owner_id: 'x' })], now);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected).toHaveLength(2);
  });

  it('refuses device-supplied owner or organization ids (strict schema)', () => {
    const r = validateEvents([good({ organization_id: randomUUID() })], now);
    expect(r.rejected[0].reason).toMatch(/Unrecognized key/);
  });

  it.each(['password', 'auth_token', 'session_cookie', 'message_body', 'api_key'])(
    'rejects credential-like metadata key %s',
    (key) => {
      const r = validateEvents([good({ metadata: { [key]: 'x' } })], now);
      expect(r.rejected).toHaveLength(1);
    },
  );

  it('rejects nested metadata objects and oversized strings', () => {
    const nested = validateEvents([good({ metadata: { a: { b: 1 } } })], now);
    const big = validateEvents(
      [good({ metadata: { a: 'x'.repeat(LIMITS.maxMetadataStringLength + 1) } })],
      now,
    );
    expect(nested.rejected).toHaveLength(1);
    expect(big.rejected).toHaveLength(1);
  });

  it('strips control characters from metadata strings', () => {
    const r = validateEvents([good({ metadata: { application: 'evil\u001b[31m\napp' } })], now);
    expect(r.accepted[0].metadata.application).toBe('evil [31m app');
  });

  it('rejects too many metadata keys', () => {
    const metadata = Object.fromEntries(
      Array.from({ length: LIMITS.maxMetadataKeys + 1 }, (_, i) => [`k${i}`, i]),
    );
    expect(validateEvents([good({ metadata })], now).rejected).toHaveLength(1);
  });

  it('flags duplicate event ids inside one batch', () => {
    const e = good();
    const r = validateEvents([e, { ...e }], now);
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected[0].reason).toMatch(/duplicate/);
  });

  it('rejects timestamps outside the accepted window', () => {
    expect(normalizeOccurredAt('2026-08-01T00:00:00Z', now).ok).toBe(false);
    expect(normalizeOccurredAt('2026-10-21T13:00:00Z', now).ok).toBe(false);
    expect(normalizeOccurredAt('2026-10-21T12:05:00Z', now).ok).toBe(true);
  });

  it('requires schema_version 1', () => {
    expect(validateEvents([good({ schema_version: 2 })], now).rejected).toHaveLength(1);
  });
});
