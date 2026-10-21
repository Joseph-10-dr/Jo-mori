'use client';

import { Badge, Button, Card, EmptyState, Notice, Spinner } from '@tracevault/design-system';
import { useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { ErrorNotice, Time } from '@/components/bits';
import { api, errorMessage } from '@/lib/api';
import { bytes } from '@/lib/format';
import { useApi, useSession } from '@/lib/session';

interface Rec {
  id: string;
  device_name: string;
  kind: 'screen' | 'audio';
  status: string;
  mime_type: string;
  size_bytes: number;
  started_at: string;
  stopped_at: string;
  duration_seconds: number;
  expires_at: string;
  organization_id: string | null;
}

export default function RecordingsPage() {
  const { user } = useSession();
  const { data, error, loading, reload } = useApi<{ items: Rec[] }>('/v1/recordings');
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  async function open(id: string) {
    try {
      const r = await api<{ download_url: string }>(`/v1/recordings/${id}/download-url`, {
        method: 'POST',
      });
      // Single-use link valid for 5 minutes; the browser downloads it directly from storage.
      window.location.assign(r.download_url);
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this recording permanently?')) return;
    try {
      await api(`/v1/recordings/${id}`, { method: 'DELETE' });
      setMsg({ tone: 'success', text: 'Recording deleted.' });
      reload();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }

  return (
    <>
      <PageHead
        title="Recordings"
        description="Optional screen and audio recordings started by someone at the device."
      />
      <div className="stack">
        <Card title="How recording works">
          <ul className="check-list">
            <li>
              Recording only starts when someone at the device presses Record and accepts the
              operating system’s permission prompt.
            </li>
            <li>
              A visible indicator stays on while recording, with a Stop button. Recordings are never
              started from this dashboard.
            </li>
            <li>
              Each recording stores a consent record. Files are encrypted, private, and deleted
              automatically when retention expires.
            </li>
            <li>Every download is logged in the audit log.</li>
          </ul>
          {user?.plan === 'free' && (
            <Notice tone="warn">
              Recordings aren’t included in the Free plan. See Plan &amp; usage.
            </Notice>
          )}
          <Notice tone="warn">
            The Windows agent in this release does not capture recordings yet; the upload pipeline
            is ready for when it does. See Help for platform support.
          </Notice>
        </Card>
        <Card title="Your recordings">
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
          <ErrorNotice error={error} retry={reload} />
          {loading && <Spinner />}
          {data && data.items.length === 0 && <EmptyState title="No recordings" />}
          {data && data.items.length > 0 && (
            <div className="tv-table-wrap">
              <table className="tv-table">
                <thead>
                  <tr>
                    <th scope="col">Started</th>
                    <th scope="col">Device</th>
                    <th scope="col">Type</th>
                    <th scope="col">Length</th>
                    <th scope="col">Size</th>
                    <th scope="col">Deleted on</th>
                    <th scope="col">
                      <span className="tv-visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Time iso={r.started_at} />
                      </td>
                      <td>{r.device_name}</td>
                      <td>
                        {r.kind === 'screen' ? 'Screen' : 'Audio'}{' '}
                        {r.status !== 'available' && (
                          <Badge tone="medium">{r.status.replace('_', ' ')}</Badge>
                        )}
                      </td>
                      <td>{Math.round(r.duration_seconds / 60)} min</td>
                      <td>{bytes(r.size_bytes)}</td>
                      <td>
                        <Time iso={r.expires_at} />
                      </td>
                      <td className="tv-row">
                        <Button
                          size="sm"
                          disabled={r.status !== 'available'}
                          onClick={() => open(r.id)}
                        >
                          Download
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => remove(r.id)}>
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
