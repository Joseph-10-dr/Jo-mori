'use client';

import { Badge, Notice } from '@tracevault/design-system';
import { errorMessage } from '@/lib/api';
import { formatTime, relativeTime, utcTitle } from '@/lib/format';

/** Local time with the zone shown; exact UTC on hover and for screen readers via <time>. */
export function Time({
  iso,
  relative,
  seconds,
}: {
  iso: string | null | undefined;
  relative?: boolean;
  seconds?: boolean;
}) {
  if (!iso) return <span className="tv-muted">never</span>;
  return (
    <time dateTime={iso} title={utcTitle(iso)}>
      {relative ? relativeTime(iso) : formatTime(iso, { seconds })}
    </time>
  );
}

/** Events from the simulator are demonstration data and always labelled as such. */
export function SourceBadge({ source }: { source: string }) {
  if (source === 'simulator') return <Badge tone="demo">Simulated</Badge>;
  return <Badge>{source}</Badge>;
}

export function SyncBadge({ status }: { status: string }) {
  const map: Record<string, [string, 'ok' | 'medium' | 'high' | 'info' | undefined]> = {
    ok: ['Syncing', 'ok'],
    stale: ['Not reporting', 'medium'],
    failing: ['Upload failing', 'high'],
    never: ['Never synced', 'info'],
    revoked: ['Revoked', undefined],
  };
  const [label, tone] = map[status] ?? [status, undefined];
  return <Badge tone={tone}>{label}</Badge>;
}

export function MonitoringBadge({ status }: { status: string }) {
  const tone = status === 'active' ? 'ok' : status === 'paused' ? 'medium' : 'high';
  const label =
    {
      active: 'Monitoring on',
      paused: 'Monitoring paused',
      unavailable: 'Monitoring unavailable',
      disabled: 'Monitoring off',
    }[status] ?? status;
  return <Badge tone={tone}>{label}</Badge>;
}

export function ConfidenceBadge({ confidence }: { confidence: string }) {
  const label =
    { confirmed: 'Observed', likely: 'Likely (inferred)', possible: 'Possible (inferred)' }[
      confidence
    ] ?? confidence;
  return <Badge tone={confidence === 'confirmed' ? 'info' : 'medium'}>{label}</Badge>;
}

export function ErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return (
    <Notice tone="error">
      {errorMessage(error)}{' '}
      {retry && (
        <button className="tv-btn tv-btn--sm" onClick={retry}>
          Try again
        </button>
      )}
    </Notice>
  );
}
