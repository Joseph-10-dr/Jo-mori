'use client';

import {
  Button,
  Card,
  EmptyState,
  Field,
  Notice,
  SeverityBadge,
  Spinner,
} from '@tracevault/design-system';
import { EVENT_TYPES } from '@tracevault/event-schema';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useCallback, useEffect, useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { ErrorNotice, SourceBadge, Time } from '@/components/bits';
import { EventDrawer } from '@/components/EventDrawer';
import { api, download, errorMessage } from '@/lib/api';
import { eventLabel } from '@/lib/format';
import { useApi } from '@/lib/session';

type Sev = 'info' | 'low' | 'medium' | 'high' | 'critical';
interface Ev {
  id: string;
  device_id: string;
  device_name: string;
  event_type: string;
  severity: Sev;
  source: string;
  occurred_at: string;
  metadata: Record<string, unknown>;
  delayed: boolean;
}
interface Page {
  items: Ev[];
  next_cursor: string | null;
}

function toIso(local: string | null) {
  return local ? new Date(local).toISOString() : undefined;
}

function summary(m: Record<string, unknown>) {
  const s = Object.entries(m)
    .slice(0, 3)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${String(v)}`)
    .join(' · ');
  return s.length > 90 ? s.slice(0, 89) + '…' : s;
}

function Timeline() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const devices = useApi<{ items: { id: string; name: string }[] }>('/v1/devices');
  const [items, setItems] = useState<Ev[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const selected = params.get('event');

  const filters = {
    q: params.get('q') ?? undefined,
    device_id: params.get('device') ?? undefined,
    event_type: params.get('type') ?? undefined,
    min_severity: params.get('severity') ?? undefined,
    from: toIso(params.get('from')),
    to: toIso(params.get('to')),
  };
  const key = JSON.stringify(filters);

  const load = useCallback(
    async (after?: string) => {
      setLoading(true);
      setError(null);
      try {
        const page = await api<Page>('/v1/events', {
          query: { ...JSON.parse(key), limit: 50, cursor: after },
        });
        setItems((prev) => (after ? [...prev, ...page.items] : page.items));
        setCursor(page.next_cursor);
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    },
    [key],
  );
  useEffect(() => {
    load();
  }, [load]);

  function setParam(updates: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setParam({
      q: (f.get('q') as string) || null,
      device: (f.get('device') as string) || null,
      type: (f.get('type') as string) || null,
      severity: (f.get('severity') as string) || null,
      from: (f.get('from') as string) || null,
      to: (f.get('to') as string) || null,
      event: null,
    });
  }

  async function exportAs(format: 'csv' | 'json') {
    setExportError(null);
    try {
      await download('/v1/events/export', { ...filters, format }, `tracevault-events.${format}`);
    } catch (err) {
      setExportError(errorMessage(err));
    }
  }

  return (
    <>
      <PageHead
        title="Activity timeline"
        description={`Times are shown in your time zone (${Intl.DateTimeFormat().resolvedOptions().timeZone}). Hover a time for UTC.`}
        actions={
          <>
            <Button size="sm" onClick={() => exportAs('csv')}>
              Export CSV
            </Button>
            <Button size="sm" onClick={() => exportAs('json')}>
              Export JSON
            </Button>
          </>
        }
      />
      {exportError && <Notice tone="error">{exportError}</Notice>}
      <Card>
        <form
          className="filters"
          onSubmit={apply}
          key={key}
          role="search"
          aria-label="Filter events"
        >
          <Field label="Search" htmlFor="q">
            <input
              className="tv-input"
              id="q"
              name="q"
              defaultValue={filters.q}
              placeholder="App, setting, account…"
            />
          </Field>
          <Field label="Device" htmlFor="device">
            <select
              className="tv-select"
              id="device"
              name="device"
              defaultValue={filters.device_id ?? ''}
            >
              <option value="">All devices</option>
              {devices.data?.items.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Event type" htmlFor="type">
            <select
              className="tv-select"
              id="type"
              name="type"
              defaultValue={filters.event_type ?? ''}
            >
              <option value="">All types</option>
              {Object.entries(EVENT_TYPES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Minimum severity" htmlFor="severity">
            <select
              className="tv-select"
              id="severity"
              name="severity"
              defaultValue={filters.min_severity ?? ''}
            >
              <option value="">Any</option>
              <option value="low">Low and above</option>
              <option value="medium">Medium and above</option>
              <option value="high">High and above</option>
            </select>
          </Field>
          <Field label="From" htmlFor="from">
            <input
              className="tv-input"
              id="from"
              name="from"
              type="datetime-local"
              defaultValue={params.get('from') ?? ''}
            />
          </Field>
          <Field label="To" htmlFor="to">
            <input
              className="tv-input"
              id="to"
              name="to"
              type="datetime-local"
              defaultValue={params.get('to') ?? ''}
            />
          </Field>
          <div className="tv-row">
            <Button variant="primary" type="submit">
              Apply
            </Button>
            <Button type="button" variant="ghost" onClick={() => router.replace(pathname)}>
              Reset
            </Button>
          </div>
        </form>
        <ErrorNotice error={error} retry={() => load()} />
        {!loading && items.length === 0 && !error && (
          <EmptyState title="No events match">
            {key === '{}'
              ? 'Events appear here after an enrolled device uploads them.'
              : 'Try widening the date range or clearing filters.'}
          </EmptyState>
        )}
        {items.length > 0 && (
          <div className="tv-table-wrap">
            <table className="tv-table">
              <caption className="tv-visually-hidden">Device activity events, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Event</th>
                  <th scope="col">Device</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id} data-clickable="true" onClick={() => setParam({ event: e.id })}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Time iso={e.occurred_at} seconds />
                      {e.delayed && (
                        <div className="tv-small tv-muted" title="Uploaded later than it happened">
                          delayed upload
                        </div>
                      )}
                    </td>
                    <td>
                      <button
                        className="tv-btn tv-btn--ghost tv-btn--sm"
                        style={{ padding: 0, fontWeight: 600 }}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setParam({ event: e.id });
                        }}
                      >
                        {eventLabel(e.event_type)}
                      </button>{' '}
                      <SourceBadge source={e.source} />
                    </td>
                    <td>{e.device_name}</td>
                    <td>
                      <SeverityBadge severity={e.severity} />
                    </td>
                    <td className="tv-small tv-muted">{summary(e.metadata)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="tv-row" style={{ marginTop: 12 }}>
          {loading && <Spinner label="Loading events" />}
          {!loading && cursor && <Button onClick={() => load(cursor)}>Load older events</Button>}
          {!loading && !cursor && items.length > 0 && (
            <span className="tv-small tv-muted">End of results ({items.length} events)</span>
          )}
        </div>
      </Card>
      {selected && (
        <EventDrawer
          id={selected}
          onClose={() => setParam({ event: null })}
          onSelect={(id) => setParam({ event: id })}
        />
      )}
    </>
  );
}

export default function TimelinePage() {
  return (
    <Suspense>
      <Timeline />
    </Suspense>
  );
}
