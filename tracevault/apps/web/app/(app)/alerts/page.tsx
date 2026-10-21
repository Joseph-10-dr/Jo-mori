'use client';

import type { SecurityAlert } from '@tracevault/api-contracts';
import { Button, Card, EmptyState, Field, Notice, SeverityBadge, Spinner } from '@tracevault/design-system';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { ConfidenceBadge, ErrorNotice, Time } from '@/components/bits';
import { api, errorMessage } from '@/lib/api';
import { useApi } from '@/lib/session';

function AlertDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data, error, loading, reload } = useApi<SecurityAlert>(`/v1/alerts/${id}`);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function resolve(status: 'resolved' | 'dismissed') {
    try {
      await api(`/v1/alerts/${id}/resolve`, { method: 'POST', body: { status, note: note || undefined } });
      setMsg(null);
      reload();
      onChanged();
    } catch (err) {
      setMsg(errorMessage(err));
    }
  }

  if (loading) return <Spinner />;
  if (error || !data) return <ErrorNotice error={error} />;
  return (
    <Card title={data.title}>
      <div className="tv-row" style={{ marginBottom: 10 }}>
        <SeverityBadge severity={data.severity} />
        <ConfidenceBadge confidence={data.confidence} />
        <span className="tv-small tv-muted">
          <Time iso={data.created_at} />
        </span>
      </div>
      <h3>What was recorded</h3>
      <p>{data.explanation}</p>
      {data.confidence !== 'confirmed' && (
        <Notice tone="warn">This alert is an inference from a pattern of events. It is not proof that your device or accounts were compromised.</Notice>
      )}
      <h3>Recommended response</h3>
      <p>{data.recommended_action}</p>
      {data.evidence_event_ids.length > 0 && (
        <>
          <h3>Evidence</h3>
          <ul>
            {data.evidence_event_ids.map((eid) => (
              <li key={eid}>
                <Link href={`/timeline?event=${eid}`} className="tv-mono">
                  {eid.slice(0, 8)}…
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="tv-row" style={{ marginBottom: 10 }}>
        <Link className="tv-btn tv-btn--sm" href={`/investigate?alert=${data.id}`}>
          Explain what happened around this alert
        </Link>
      </div>
      {data.status === 'open' ? (
        <>
          {msg && <Notice tone="error">{msg}</Notice>}
          <Field label="Resolution note (optional)" htmlFor="note">
            <input className="tv-input" id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </Field>
          <div className="tv-row">
            <Button variant="primary" onClick={() => resolve('resolved')}>
              Mark resolved
            </Button>
            <Button onClick={() => resolve('dismissed')}>Dismiss — expected activity</Button>
          </div>
        </>
      ) : (
        <Notice tone="success">
          {data.status === 'resolved' ? 'Resolved' : 'Dismissed'} <Time iso={data.resolved_at} />
          {data.resolution_note && ` — “${data.resolution_note}”`}
        </Notice>
      )}
    </Card>
  );
}

function Alerts() {
  const params = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState('open');
  const [severity, setSeverity] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const list = useApi<{ items: SecurityAlert[]; next_cursor: string | null; open_by_severity: Record<string, number> }>('/v1/alerts', {
    status: status || undefined,
    severity: severity || undefined,
    cursor,
    limit: 25,
  });
  const selected = params.get('id');

  return (
    <>
      <PageHead title="Security alerts" description="Rule-based alerts. Each shows its evidence and whether it is observed or inferred." />
      <div className="tv-grid tv-grid--2" style={{ alignItems: 'start' }}>
        <Card>
          <div className="filters">
            <Field label="Status" htmlFor="status">
              <select className="tv-select" id="status" value={status} onChange={(e) => (setCursor(undefined), setStatus(e.target.value))}>
                <option value="open">Open</option>
                <option value="resolved">Resolved</option>
                <option value="dismissed">Dismissed</option>
                <option value="">All</option>
              </select>
            </Field>
            <Field label="Severity" htmlFor="severity">
              <select className="tv-select" id="severity" value={severity} onChange={(e) => (setCursor(undefined), setSeverity(e.target.value))}>
                <option value="">Any</option>
                {['critical', 'high', 'medium', 'low', 'info'].map((s) => (
                  <option key={s} value={s}>
                    {s[0].toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <ErrorNotice error={list.error} retry={list.reload} />
          {list.loading && <Spinner />}
          {list.data && list.data.items.length === 0 && <EmptyState title="No alerts here">Nothing matches these filters.</EmptyState>}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {list.data?.items.map((a) => (
              <li key={a.id} style={{ borderBottom: '1px solid var(--tv-border)', padding: '10px 0' }}>
                <div className="tv-row">
                  <SeverityBadge severity={a.severity} />
                  <ConfidenceBadge confidence={a.confidence} />
                </div>
                <Link href={`/alerts?id=${a.id}`} aria-current={selected === a.id ? 'true' : undefined} style={{ fontWeight: 600 }}>
                  {a.title}
                </Link>
                <div className="tv-small tv-muted">
                  {a.device_name ?? 'Account'} · <Time iso={a.created_at} />
                </div>
              </li>
            ))}
          </ul>
          <div className="tv-row" style={{ marginTop: 10 }}>
            {cursor && (
              <Button size="sm" onClick={() => setCursor(undefined)}>
                Back to newest
              </Button>
            )}
            {list.data?.next_cursor && (
              <Button size="sm" onClick={() => setCursor(list.data!.next_cursor!)}>
                Older alerts
              </Button>
            )}
          </div>
        </Card>
        {selected ? (
          <AlertDetail id={selected} onChanged={list.reload} key={selected} />
        ) : (
          <Card>
            <EmptyState title="Select an alert">Pick an alert to see its evidence and recommended response.</EmptyState>
            <p className="tv-small tv-muted">
              <Button size="sm" variant="ghost" onClick={() => router.push('/help#alerts')}>
                How alerts work
              </Button>
            </p>
          </Card>
        )}
      </div>
    </>
  );
}

export default function AlertsPage() {
  return (
    <Suspense>
      <Alerts />
    </Suspense>
  );
}
