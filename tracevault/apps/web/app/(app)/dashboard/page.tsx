'use client';

import { Card, EmptyState, SeverityBadge, Spinner, Stat } from '@tracevault/design-system';
import Link from 'next/link';
import { useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { ConfidenceBadge, ErrorNotice, MonitoringBadge, Time } from '@/components/bits';
import { bytes } from '@/lib/format';
import { useApi } from '@/lib/session';

interface Overview {
  devices: { registered: number; reporting: number; failing: number; last_sync_at: string | null };
  alerts: {
    open: number;
    open_high: number;
    recent: { id: string; title: string; severity: 'info' | 'low' | 'medium' | 'high' | 'critical'; confidence: string; status: string; created_at: string; device_name: string | null }[];
  };
  activity: { days: number; series: { day: string; total: number; notable: number }[] };
  recordings: { available: number; uploading: number };
  storage: { recording_bytes_used: number; plan: { plan: string; limits: { recordingStorageBytes: number } } };
  needs_attention: { id: string; name: string; monitoring_status: string; permissions: Record<string, string>; consecutive_sync_failures: number; last_seen_at: string | null }[];
}

function ActivityChart({ series, days }: { series: Overview['activity']['series']; days: number }) {
  const buckets = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    const hit = series.find((s) => new Date(s.day).getTime() === d.getTime());
    return { day: d, total: hit?.total ?? 0, notable: hit?.notable ?? 0 };
  });
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const total = buckets.reduce((a, b) => a + b.total, 0);
  return (
    <figure style={{ margin: 0 }}>
      <div className="bars" role="img" aria-label={`${total} events over the last ${days} days`}>
        {buckets.map((b) => (
          <div className="bar-col" key={b.day.toISOString()}>
            <div className="bar" style={{ height: `${Math.max(2, (b.total / max) * 120)}px` }} title={`${b.total} events, ${b.notable} notable`}>
              <span style={{ height: `${b.total ? (b.notable / b.total) * 100 : 0}%` }} />
            </div>
            <span className="bar-label">{b.day.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })}</span>
          </div>
        ))}
      </div>
      <figcaption className="tv-small tv-muted" style={{ marginTop: 8 }}>
        Daily event count (UTC days). The darker part of each bar is medium severity or higher.
      </figcaption>
    </figure>
  );
}

export default function DashboardPage() {
  const [days, setDays] = useState(7);
  const { data, error, loading, reload } = useApi<Overview>('/v1/dashboard', { days });

  return (
    <>
      <PageHead
        title="Security overview"
        description="What your devices have reported, and anything that needs your attention."
        actions={
          <label className="tv-row tv-small">
            Period
            <select className="tv-select" style={{ width: 'auto' }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
            </select>
          </label>
        }
      />
      <ErrorNotice error={error} retry={reload} />
      {loading && !data && <Spinner />}
      {data && (
        <div className="stack">
          <div className="tv-grid tv-grid--stats">
            <Stat label="Registered devices" value={data.devices.registered} />
            <Stat label="Reporting now" value={`${data.devices.reporting} / ${data.devices.registered}`} hint="Seen in the last 30 minutes" />
            <Stat label="Open alerts" value={data.alerts.open} hint={data.alerts.open_high ? `${data.alerts.open_high} high or critical` : 'None high'} />
            <Stat label="Last sync" value={<span style={{ fontSize: 18 }}><Time iso={data.devices.last_sync_at} relative /></span>} />
            <Stat
              label="Recording storage"
              value={<span style={{ fontSize: 18 }}>{bytes(data.storage.recording_bytes_used)}</span>}
              hint={data.storage.plan.limits.recordingStorageBytes ? `of ${bytes(data.storage.plan.limits.recordingStorageBytes)}` : 'Not in your plan'}
            />
          </div>

          {data.devices.registered === 0 && (
            <Card title="No devices yet">
              <p>Enroll a device to start building its security history. Nothing is recorded before enrollment.</p>
              <Link className="tv-btn tv-btn--primary" href="/devices/enroll">
                Enroll a device
              </Link>
            </Card>
          )}

          {data.needs_attention.length > 0 && (
            <Card title="Needs attention">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {data.needs_attention.map((d) => (
                  <li key={d.id} style={{ marginBottom: 6 }}>
                    <Link href={`/devices/${d.id}`}>{d.name}</Link>{' '}
                    {d.monitoring_status !== 'active' && <MonitoringBadge status={d.monitoring_status} />}{' '}
                    {d.consecutive_sync_failures >= 3 && <span>— {d.consecutive_sync_failures} uploads failed in a row</span>}
                    {!d.last_seen_at && <span className="tv-muted"> — has not reported yet</span>}
                    {d.last_seen_at && new Date(d.last_seen_at).getTime() < Date.now() - 30 * 60_000 && (
                      <span className="tv-muted">
                        {' '}
                        — last seen <Time iso={d.last_seen_at} relative />
                      </span>
                    )}
                    {Object.entries(d.permissions).filter(([, v]) => v === 'denied').map(([k]) => (
                      <span key={k} className="tv-muted">
                        {' '}
                        — permission “{k.replace(/_/g, ' ')}” denied
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="tv-grid tv-grid--2">
            <Card title="Activity" actions={<Link href="/timeline">Open timeline</Link>}>
              <ActivityChart series={data.activity.series} days={days} />
            </Card>
            <Card title="Recent alerts" actions={<Link href="/alerts">All alerts</Link>}>
              {data.alerts.recent.length === 0 ? (
                <EmptyState title="No alerts">Rules run on every upload; anything notable shows up here.</EmptyState>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {data.alerts.recent.map((a) => (
                    <li key={a.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--tv-border)' }}>
                      <div className="tv-row">
                        <SeverityBadge severity={a.severity} />
                        <ConfidenceBadge confidence={a.confidence} />
                        {a.status !== 'open' && <span className="tv-small tv-muted">{a.status}</span>}
                      </div>
                      <Link href={`/alerts?id=${a.id}`}>{a.title}</Link>
                      <div className="tv-small tv-muted">
                        <Time iso={a.created_at} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {(data.recordings.available > 0 || data.recordings.uploading > 0) && (
            <Card title="Recordings" actions={<Link href="/recordings">Manage</Link>}>
              <p style={{ margin: 0 }}>
                {data.recordings.available} available{data.recordings.uploading ? `, ${data.recordings.uploading} uploading` : ''}.
              </p>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
