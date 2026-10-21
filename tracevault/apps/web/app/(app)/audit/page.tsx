'use client';

import { roleHas } from '@tracevault/api-contracts';
import { Badge, Button, Card, EmptyState, Field, Notice, Spinner } from '@tracevault/design-system';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { ErrorNotice, Time } from '@/components/bits';
import { api, errorMessage } from '@/lib/api';
import { useApi, useSession } from '@/lib/session';

interface Row {
  id: string;
  occurred_at: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  details: Record<string, unknown>;
  sensitive: boolean;
  actor_email: string | null;
  actor_device_name: string | null;
}

function Audit() {
  const params = useSearchParams();
  const { memberships } = useSession();
  const auditOrgs = memberships.filter((m) => roleHas(m.role, 'audit.view'));
  const [org, setOrg] = useState(params.get('org') ?? '');
  const [sensitive, setSensitive] = useState('');
  const [before, setBefore] = useState<number | undefined>();
  const [verify, setVerify] = useState<string | null>(null);
  const { data, error, loading, reload } = useApi<{ items: Row[]; next_before_id: number | null }>('/v1/audit-logs', {
    organization_id: org || undefined,
    sensitive: sensitive || undefined,
    before_id: before,
  });

  async function check() {
    try {
      const r = await api<{ intact: boolean; rows_checked: number }>('/v1/audit-logs/verify', { query: { organization_id: org } });
      setVerify(r.intact ? `Chain intact (${r.rows_checked} entries checked).` : 'Chain verification FAILED — audit records may have been altered. Contact support.');
    } catch (err) {
      setVerify(errorMessage(err));
    }
  }

  return (
    <>
      <PageHead title="Audit log" description="Append-only record of sign-ins, policy changes, exports and access to sensitive data." />
      <Card>
        <div className="filters">
          <Field label="Scope" htmlFor="scope">
            <select className="tv-select" id="scope" value={org} onChange={(e) => (setBefore(undefined), setVerify(null), setOrg(e.target.value))}>
              <option value="">My account</option>
              {auditOrgs.map((m) => (
                <option key={m.organization_id} value={m.organization_id}>
                  {m.organization_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Show" htmlFor="sensitive">
            <select className="tv-select" id="sensitive" value={sensitive} onChange={(e) => (setBefore(undefined), setSensitive(e.target.value))}>
              <option value="">All entries</option>
              <option value="true">Sensitive access only (recordings)</option>
            </select>
          </Field>
          {org && (
            <div>
              <Button onClick={check}>Verify integrity</Button>
            </div>
          )}
        </div>
        {verify && <Notice tone={verify.startsWith('Chain intact') ? 'success' : 'error'}>{verify}</Notice>}
        <ErrorNotice error={error} retry={reload} />
        {loading && <Spinner />}
        {data && data.items.length === 0 && <EmptyState title="No entries" />}
        {data && data.items.length > 0 && (
          <div className="tv-table-wrap">
            <table className="tv-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Action</th>
                  <th scope="col">By</th>
                  <th scope="col">Target</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Time iso={r.occurred_at} seconds />
                    </td>
                    <td>
                      <code>{r.action}</code> {r.sensitive && <Badge tone="high">Sensitive</Badge>}
                    </td>
                    <td className="tv-small" style={{ overflowWrap: 'anywhere' }}>
                      {r.actor_email ?? (r.actor_device_name ? `Device: ${r.actor_device_name}` : 'System')}
                      {r.ip && <div className="tv-muted">{r.ip}</div>}
                    </td>
                    <td className="tv-small">{r.target_type ? `${r.target_type} ${r.target_id?.slice(0, 8) ?? ''}` : '—'}</td>
                    <td className="tv-small tv-muted" style={{ overflowWrap: 'anywhere' }}>
                      {Object.keys(r.details).length ? JSON.stringify(r.details).slice(0, 140) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="tv-row" style={{ marginTop: 10 }}>
          {before && (
            <Button size="sm" onClick={() => setBefore(undefined)}>
              Newest
            </Button>
          )}
          {data?.next_before_id && (
            <Button size="sm" onClick={() => setBefore(data.next_before_id!)}>
              Older entries
            </Button>
          )}
        </div>
      </Card>
    </>
  );
}

export default function AuditPage() {
  return (
    <Suspense>
      <Audit />
    </Suspense>
  );
}
