'use client';

import type { PlanId, PlanLimits } from '@tracevault/api-contracts';
import { Badge, Button, Card, Field, Notice, Spinner, Stat } from '@tracevault/design-system';
import { useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { ErrorNotice } from '@/components/bits';
import { api, errorMessage } from '@/lib/api';
import { bytes, money } from '@/lib/format';
import { useApi, useSession } from '@/lib/session';

interface Billing {
  plan: PlanId;
  status: string;
  limits: PlanLimits;
  plans: { id: PlanId; limits: PlanLimits; price: { currency: string; amount_minor: number; per: string } | null }[];
  usage_this_month: Record<string, number>;
  active_devices: number;
  recording_bytes_used: number;
  payments_enabled: boolean;
  note: string;
}

const NAMES: Record<PlanId, string> = { free: 'Free', personal: 'Personal', premium: 'Premium', business: 'Business' };

export default function BillingPage() {
  const { refresh, memberships } = useSession();
  const [region, setRegion] = useState('default');
  const [scope, setScope] = useState('');
  const { data, error, loading, reload } = useApi<Billing>('/v1/billing', { region: region === 'default' ? undefined : region, organization_id: scope || undefined });
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  async function choose(plan: PlanId) {
    try {
      await api('/v1/billing/plan', { method: 'POST', body: { plan, organization_id: scope || undefined } });
      setMsg({ tone: 'success', text: `Switched to ${NAMES[plan]}. No payment was taken.` });
      reload();
      refresh();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }

  return (
    <>
      <PageHead title="Plan & usage" />
      <div className="filters">
        {memberships.length > 0 && (
          <Field label="Account" htmlFor="scope">
            <select className="tv-select" id="scope" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">Personal</option>
              {memberships.map((m) => (
                <option key={m.organization_id} value={m.organization_id}>
                  {m.organization_name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Show prices for" htmlFor="region">
          <select className="tv-select" id="region" value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="default">International (USD)</option>
            <option value="NG">Nigeria (NGN)</option>
          </select>
        </Field>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <ErrorNotice error={error} retry={reload} />
      {loading && !data && <Spinner />}
      {data && (
        <div className="stack">
          <Notice tone="warn">{data.note}</Notice>
          <div className="tv-grid tv-grid--stats">
            <Stat label="Current plan" value={NAMES[data.plan]} hint={data.status} />
            <Stat label="Active devices" value={`${data.active_devices} / ${data.limits.maxDevices}`} />
            <Stat label="Events this month" value={(data.usage_this_month.events_ingested ?? 0).toLocaleString()} />
            <Stat label="Data uploaded this month" value={bytes(data.usage_this_month.ingest_bytes ?? 0)} />
            <Stat label="Recording storage" value={bytes(data.recording_bytes_used)} hint={data.limits.recordingStorageBytes ? `of ${bytes(data.limits.recordingStorageBytes)}` : 'Not included'} />
          </div>
          <div className="tv-grid tv-grid--stats">
            {data.plans
              .filter((p) => (scope ? p.id === 'business' : p.id !== 'business'))
              .map((p) => (
                <Card key={p.id} title={NAMES[p.id]} actions={p.id === data.plan ? <Badge tone="ok">Current</Badge> : undefined}>
                  <p style={{ fontSize: 22, fontWeight: 700, margin: '0 0 8px' }}>
                    {p.price ? money(p.price.amount_minor, p.price.currency) : '—'}
                    <span className="tv-small tv-muted"> /{p.price?.per === 'seat_month' ? 'user/month' : 'month'}</span>
                  </p>
                  <ul className="check-list tv-small">
                    <li>{p.limits.maxDevices} device{p.limits.maxDevices > 1 ? 's' : ''}</li>
                    <li>History up to {p.limits.retentionDaysMax} days</li>
                    <li>{p.limits.recordingStorageBytes ? `${bytes(p.limits.recordingStorageBytes)} recording storage` : 'No recordings'}</li>
                    <li>{p.limits.alertRules === 'all' ? 'All alert rules' : 'Basic alerts'}</li>
                  </ul>
                  {p.id !== data.plan && (
                    <Button size="sm" onClick={() => choose(p.id)}>
                      Switch (test mode)
                    </Button>
                  )}
                </Card>
              ))}
          </div>
          <p className="tv-small tv-muted">
            Plans never add capabilities an operating system doesn’t allow — for example, background screen recording on iOS is not possible
            on any plan.
          </p>
        </div>
      )}
    </>
  );
}
