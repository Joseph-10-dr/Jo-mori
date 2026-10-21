'use client';

import { Badge, Button, Card, EmptyState, Field, Notice, SeverityBadge, Spinner } from '@tracevault/design-system';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { ErrorNotice, MonitoringBadge, SyncBadge, Time } from '@/components/bits';
import { api, errorMessage } from '@/lib/api';
import { eventLabel, PLATFORM_LABEL } from '@/lib/format';
import { useApi } from '@/lib/session';

type Sev = 'info' | 'low' | 'medium' | 'high' | 'critical';
interface Recovery {
  device: {
    id: string;
    name: string;
    platform: string;
    os_version: string | null;
    agent_version: string | null;
    status: string;
    monitoring_status: string;
    sync_status: string;
    registered_at: string;
    last_seen_at: string | null;
    last_sync_at: string | null;
    last_sync_error: string | null;
    revoked_at: string | null;
    organization_name: string | null;
    startup_enabled: boolean;
    permissions: Record<string, string>;
  };
  last_known_state: { event_type: string; occurred_at: string } | null;
  recent_events: { id: string; event_type: string; severity: Sev; occurred_at: string }[];
  open_alerts: { id: string; title: string; severity: Sev; created_at: string }[];
  official_links: { label: string; url: string }[];
  limitations: string;
}

export default function DevicePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, error, loading, reload } = useApi<Recovery>(`/v1/devices/${id}/recovery`);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [renaming, setRenaming] = useState(false);

  async function act(path: string, method: string, confirmText: string, done: string) {
    if (!window.confirm(confirmText)) return;
    try {
      await api(path, { method });
      setMsg({ tone: 'success', text: done });
      if (method === 'DELETE') router.replace('/devices');
      else reload();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }

  async function rename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await api(`/v1/devices/${id}`, { method: 'PATCH', body: { name: new FormData(e.currentTarget).get('name') } });
      setRenaming(false);
      reload();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }

  if (loading && !data) return <Spinner />;
  if (!data) return <ErrorNotice error={error} retry={reload} />;
  const d = data.device;
  const active = d.status === 'active';

  return (
    <>
      <PageHead
        title={d.name}
        description={`${PLATFORM_LABEL[d.platform] ?? d.platform}${d.os_version ? ` · ${d.os_version}` : ''}${d.organization_name ? ` · ${d.organization_name}` : ' · Personal'}`}
        actions={
          <>
            <Link className="tv-btn" href={`/timeline?device=${d.id}`}>
              View activity
            </Link>
            {active && (
              <Button size="sm" onClick={() => setRenaming((r) => !r)}>
                Rename
              </Button>
            )}
          </>
        }
      />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {renaming && (
        <Card>
          <form onSubmit={rename} className="tv-row" style={{ alignItems: 'flex-end' }}>
            <Field label="Device name" htmlFor="name">
              <input className="tv-input" id="name" name="name" defaultValue={d.name} maxLength={80} required />
            </Field>
            <Button variant="primary" type="submit" style={{ marginBottom: 14 }}>
              Save
            </Button>
          </form>
        </Card>
      )}
      <div className="tv-grid tv-grid--2" style={{ alignItems: 'start' }}>
        <Card title="Status">
          <dl className="kv">
            <dt>Access</dt>
            <dd>{active ? <Badge tone="ok">Active</Badge> : <Badge tone="high">Revoked <Time iso={d.revoked_at} /></Badge>}</dd>
            <dt>Sync</dt>
            <dd>
              <SyncBadge status={d.sync_status} />
              {d.last_sync_error && <div className="tv-small tv-muted">Last error: {d.last_sync_error}</div>}
            </dd>
            <dt>Monitoring</dt>
            <dd>
              <MonitoringBadge status={d.monitoring_status} />
            </dd>
            <dt>Last successful sync</dt>
            <dd>
              <Time iso={d.last_sync_at} />
            </dd>
            <dt>Last seen</dt>
            <dd>
              <Time iso={d.last_seen_at} />
            </dd>
            <dt>Last known state</dt>
            <dd>
              {data.last_known_state ? (
                <>
                  {eventLabel(data.last_known_state.event_type)} at <Time iso={data.last_known_state.occurred_at} />
                </>
              ) : (
                '—'
              )}
            </dd>
            <dt>Enrolled</dt>
            <dd>
              <Time iso={d.registered_at} />
            </dd>
            <dt>Starts with system</dt>
            <dd>{d.startup_enabled ? 'Yes (enabled by the device user)' : 'No'}</dd>
            <dt>Agent</dt>
            <dd>{d.agent_version ?? '—'}</dd>
          </dl>
          {Object.keys(d.permissions).length > 0 && (
            <>
              <h3>Permissions reported by the device</h3>
              <ul className="check-list">
                {Object.entries(d.permissions).map(([k, v]) => (
                  <li key={k}>
                    {k.replace(/_/g, ' ')}: <Badge tone={v === 'granted' ? 'ok' : v === 'denied' ? 'high' : undefined}>{v}</Badge>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
        <Card title="Lost, stolen or lent and not returned?">
          <p>{data.limitations}</p>
          {active && (
            <div className="tv-row" style={{ marginBottom: 12 }}>
              <Button
                variant="danger"
                onClick={() =>
                  act(`/v1/devices/${d.id}/report-lost`, 'POST', `Report ${d.name} as lost? Its credentials are revoked immediately; uploaded history is kept.`, 'Device reported lost and its access revoked.')
                }
              >
                Report lost & revoke access
              </Button>
              <Button onClick={() => act(`/v1/devices/${d.id}/revoke`, 'POST', `Revoke ${d.name}? It will stop uploading until re-enrolled.`, 'Device revoked.')}>Revoke only</Button>
            </div>
          )}
          <h3>Official services</h3>
          <ul>
            {data.official_links.map((l) => (
              <li key={l.url}>
                <a href={l.url} target="_blank" rel="noopener noreferrer">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
          <Link href="/help#recovery">Full recovery checklist</Link>
        </Card>
      </div>
      <div className="tv-grid tv-grid--2" style={{ marginTop: 16, alignItems: 'start' }}>
        <Card title="Open alerts">
          {data.open_alerts.length === 0 ? (
            <EmptyState title="No open alerts" />
          ) : (
            <ul>
              {data.open_alerts.map((a) => (
                <li key={a.id}>
                  <SeverityBadge severity={a.severity} /> <Link href={`/alerts?id=${a.id}`}>{a.title}</Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Last uploaded activity" actions={<Link href={`/timeline?device=${d.id}`}>All</Link>}>
          {data.recent_events.length === 0 ? (
            <EmptyState title="Nothing uploaded yet" />
          ) : (
            <ol style={{ paddingLeft: 18, margin: 0 }}>
              {data.recent_events.slice(0, 10).map((e) => (
                <li key={e.id}>
                  <Link href={`/timeline?event=${e.id}`}>{eventLabel(e.event_type)}</Link> <span className="tv-small tv-muted"><Time iso={e.occurred_at} /></span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
      <div style={{ marginTop: 16 }}>
        <Card title="Remove device">
          <p className="tv-muted">Deleting removes the device and all of its uploaded history and recordings. This cannot be undone.</p>
          <Button variant="danger" onClick={() => act(`/v1/devices/${d.id}`, 'DELETE', `Permanently delete ${d.name} and its history?`, 'Deleted')}>
            Delete device and history
          </Button>
        </Card>
      </div>
    </>
  );
}
