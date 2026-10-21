'use client';

import type { Device } from '@tracevault/api-contracts';
import { Card, EmptyState, Spinner } from '@tracevault/design-system';
import Link from 'next/link';
import { useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { ErrorNotice, MonitoringBadge, SyncBadge, Time } from '@/components/bits';
import { PLATFORM_LABEL } from '@/lib/format';
import { useApi } from '@/lib/session';

type Row = Device & { organization_name: string | null; sync_status: string; reporting: boolean };

export default function DevicesPage() {
  const [status, setStatus] = useState<'active' | 'revoked'>('active');
  const { data, error, loading, reload } = useApi<{ items: Row[] }>('/v1/devices', { status });

  return (
    <>
      <PageHead
        title="Devices"
        description="Every enrolled device, whether it is reporting, and its monitoring status."
        actions={
          <Link className="tv-btn tv-btn--primary" href="/devices/enroll">
            Enroll a device
          </Link>
        }
      />
      <Card>
        <div className="tv-row" role="tablist" aria-label="Device status" style={{ marginBottom: 12 }}>
          {(['active', 'revoked'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={status === s} className={`tv-btn tv-btn--sm${status === s ? ' tv-btn--primary' : ''}`} onClick={() => setStatus(s)}>
              {s === 'active' ? 'Active' : 'Revoked'}
            </button>
          ))}
        </div>
        <ErrorNotice error={error} retry={reload} />
        {loading && <Spinner />}
        {data && data.items.length === 0 && (
          <EmptyState title={status === 'active' ? 'No devices enrolled' : 'No revoked devices'}>
            {status === 'active' && <Link href="/devices/enroll">Enroll your first device</Link>}
          </EmptyState>
        )}
        {data && data.items.length > 0 && (
          <div className="tv-table-wrap">
            <table className="tv-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Platform</th>
                  <th scope="col">Sync</th>
                  <th scope="col">Monitoring</th>
                  <th scope="col">Last seen</th>
                  <th scope="col">Owner</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link href={`/devices/${d.id}`} style={{ fontWeight: 600 }}>
                        {d.name}
                      </Link>
                    </td>
                    <td>
                      {PLATFORM_LABEL[d.platform] ?? d.platform}
                      {d.os_version && <div className="tv-small tv-muted">{d.os_version}</div>}
                    </td>
                    <td>
                      <SyncBadge status={d.sync_status} />
                    </td>
                    <td>{d.status === 'active' ? <MonitoringBadge status={d.monitoring_status} /> : '—'}</td>
                    <td>
                      <Time iso={d.last_seen_at} relative />
                    </td>
                    <td className="tv-small">{d.organization_name ? `Org: ${d.organization_name}` : 'Personal'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
