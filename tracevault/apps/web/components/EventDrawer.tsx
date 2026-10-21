'use client';

import { Badge, Button, SeverityBadge, Spinner } from '@tracevault/design-system';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { eventLabel } from '@/lib/format';
import { useApi } from '@/lib/session';
import { ErrorNotice, SourceBadge, Time } from './bits';

type Sev = 'info' | 'low' | 'medium' | 'high' | 'critical';
interface Detail {
  event: {
    id: string;
    event_id: string;
    device_id: string;
    device_name: string;
    event_type: string;
    severity: Sev;
    source: string;
    occurred_at: string;
    received_at: string;
    metadata: Record<string, string | number | boolean | null>;
    schema_version: number;
    delayed: boolean;
  };
  context: {
    before: { id: string; event_type: string; occurred_at: string }[];
    after: { id: string; event_type: string; occurred_at: string }[];
  };
  related_alerts: { id: string; title: string; severity: Sev; status: string }[];
  note: string;
}

export function EventDrawer({
  id,
  onClose,
  onSelect,
}: {
  id: string;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const { data, error, loading } = useApi<Detail>(`/v1/events/${id}`);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const e = data?.event;
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="event-title">
        <div className="tv-row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 id="event-title" style={{ margin: 0 }}>
            {e ? eventLabel(e.event_type) : 'Event'}
          </h2>
          <Button ref={closeRef} size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        {loading && <Spinner />}
        <ErrorNotice error={error} />
        {e && data && (
          <>
            <div className="tv-row" style={{ marginBottom: 12 }}>
              <SeverityBadge severity={e.severity} />
              <SourceBadge source={e.source} />
              {e.delayed && <Badge tone="medium">Delayed upload</Badge>}
            </div>
            <dl className="kv">
              <dt>Happened</dt>
              <dd>
                <Time iso={e.occurred_at} seconds />{' '}
                <span className="tv-small tv-muted">(device clock)</span>
              </dd>
              <dt>Received</dt>
              <dd>
                <Time iso={e.received_at} seconds />{' '}
                <span className="tv-small tv-muted">(server)</span>
              </dd>
              <dt>Device</dt>
              <dd>
                <Link href={`/devices/${e.device_id}`}>{e.device_name}</Link>
              </dd>
              <dt>Event ID</dt>
              <dd className="tv-mono">{e.event_id}</dd>
              {Object.entries(e.metadata).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k.replace(/_/g, ' ')}</dt>
                  {/* Metadata is untrusted device input; React escapes it and it is never rendered as HTML. */}
                  <dd>{String(v)}</dd>
                </div>
              ))}
            </dl>
            {e.delayed && <p className="tv-small tv-muted">{data.note}</p>}
            <p className="tv-small tv-muted">
              This is what the device reported. It shows that the event happened, not who caused it
              or why.
            </p>
            {data.related_alerts.length > 0 && (
              <>
                <h3>Related alerts</h3>
                <ul>
                  {data.related_alerts.map((a) => (
                    <li key={a.id}>
                      <SeverityBadge severity={a.severity} />{' '}
                      <Link href={`/alerts?id=${a.id}`}>{a.title}</Link> ({a.status})
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h3>Before and after on this device</h3>
            <ol style={{ paddingLeft: 18 }}>
              {[
                ...data.context.before,
                { id: e.id, event_type: e.event_type, occurred_at: e.occurred_at },
                ...data.context.after,
              ].map((c) => (
                <li key={c.id} style={{ fontWeight: c.id === e.id ? 700 : 400 }}>
                  {c.id === e.id ? (
                    eventLabel(c.event_type)
                  ) : (
                    <button
                      className="tv-btn tv-btn--ghost tv-btn--sm"
                      onClick={() => onSelect(c.id)}
                    >
                      {eventLabel(c.event_type)}
                    </button>
                  )}{' '}
                  <span className="tv-small tv-muted">
                    <Time iso={c.occurred_at} seconds />
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}
      </aside>
    </>
  );
}
