'use client';

import { Button, Card, Field, Notice, Spinner } from '@tracevault/design-system';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { ErrorNotice, Time } from '@/components/bits';
import { api, download, errorMessage } from '@/lib/api';
import { useApi, useSession } from '@/lib/session';

type Msg = { tone: 'error' | 'success'; text: string } | null;

export default function DataPage() {
  const router = useRouter();
  const { logout } = useSession();
  const retention = useApi<{
    event_retention_days: number;
    recording_retention_days: number;
    updated_at: string;
    plan: string;
    max_days: number;
  }>('/v1/account/retention');
  const [msg, setMsg] = useState<Msg>(null);
  const [delMsg, setDelMsg] = useState<Msg>(null);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api('/v1/account/retention', {
        method: 'PUT',
        body: {
          event_retention_days: Number(f.get('events')),
          recording_retention_days: Number(f.get('recordings')),
        },
      });
      retention.reload();
      setMsg({
        tone: 'success',
        text: 'Retention updated. Older records are removed within the hour.',
      });
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }

  async function exportAll() {
    try {
      await download('/v1/account/export', {}, 'tracevault-export.json', 'POST');
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }

  async function deleteAccount(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api('/v1/account', {
        method: 'DELETE',
        body: { password: f.get('password'), confirm: f.get('confirm') },
      });
      await logout();
      router.replace('/?deleted=1');
    } catch (err) {
      setDelMsg({ tone: 'error', text: errorMessage(err) });
    }
  }

  const r = retention.data;
  return (
    <>
      <PageHead
        title="Data & retention"
        description="Control how long TraceVault keeps your records, take a copy, or delete everything."
      />
      <div className="tv-grid tv-grid--2" style={{ alignItems: 'start' }}>
        <Card title="Retention">
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
          <ErrorNotice error={retention.error} retry={retention.reload} />
          {retention.loading && <Spinner />}
          {r && (
            <form onSubmit={save}>
              <Field
                label="Keep activity events for (days)"
                htmlFor="events"
                hint={`Your ${r.plan} plan allows up to ${r.max_days} days.`}
              >
                <input
                  className="tv-input"
                  id="events"
                  name="events"
                  type="number"
                  min={1}
                  max={r.max_days}
                  defaultValue={r.event_retention_days}
                  required
                />
              </Field>
              <Field label="Keep recordings for (days)" htmlFor="recordings">
                <input
                  className="tv-input"
                  id="recordings"
                  name="recordings"
                  type="number"
                  min={1}
                  max={r.max_days}
                  defaultValue={r.recording_retention_days}
                  required
                />
              </Field>
              <p className="tv-small tv-muted">
                Last changed <Time iso={r.updated_at} />. Records older than this are permanently
                deleted. Organization devices follow the organization’s policy instead.
              </p>
              <Button type="submit">Save retention</Button>
            </form>
          )}
        </Card>
        <div className="stack">
          <Card title="Export your data">
            <p>
              Download a JSON file with your account, devices, activity events, alerts, recording
              details and account history.
            </p>
            <Button onClick={exportAll}>Download export</Button>
          </Card>
          <Card title="Delete account">
            <p>
              This permanently deletes your account, personal devices, their history and recordings.
              Audit entries about the deletion are kept for the audit retention period without your
              recordings or events.
            </p>
            {delMsg && <Notice tone={delMsg.tone}>{delMsg.text}</Notice>}
            <form onSubmit={deleteAccount}>
              <Field label="Password" htmlFor="del-password">
                <input
                  className="tv-input"
                  id="del-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              <Field label='Type "DELETE" to confirm' htmlFor="confirm">
                <input className="tv-input" id="confirm" name="confirm" required pattern="DELETE" />
              </Field>
              <Button variant="danger" type="submit">
                Delete my account
              </Button>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
