'use client';

import { roleHas, type OrgRole } from '@tracevault/api-contracts';
import { Badge, Button, Card, Field, Notice, Spinner, Stat } from '@tracevault/design-system';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { ErrorNotice } from '@/components/bits';
import { api, errorMessage } from '@/lib/api';
import { useApi, useSession } from '@/lib/session';

interface Org {
  id: string;
  name: string;
  role: OrgRole;
  role_label: string;
  plan: string;
  subscription_status: string;
  member_enrollment_allowed: boolean;
  require_mfa_for_admins: boolean;
  recordings_allowed: boolean;
  event_retention_days: number;
  recording_retention_days: number;
  audit_retention_days: number;
  stats: {
    members: number;
    active_devices: number;
    reporting_devices: number;
    open_alerts: number;
  };
}

export default function OrgPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();
  const { data, error, loading, reload } = useApi<Org>(`/v1/organizations/${id}`);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  async function patch(body: Record<string, unknown>) {
    try {
      await api(`/v1/organizations/${id}`, { method: 'PATCH', body });
      setMsg({ tone: 'success', text: 'Policy updated and recorded in the audit log.' });
      reload();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }

  async function saveRetention(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api(`/v1/organizations/${id}/retention`, {
        method: 'PUT',
        body: {
          event_retention_days: Number(f.get('events')),
          recording_retention_days: Number(f.get('recordings')),
          audit_retention_days: Number(f.get('audit')),
        },
      });
      setMsg({ tone: 'success', text: 'Retention updated.' });
      reload();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }

  if (loading && !data) return <Spinner />;
  if (!data) return <ErrorNotice error={error} retry={reload} />;
  const canPolicy = roleHas(data.role, 'policies.manage');
  const isOwner = data.role === 'owner';

  return (
    <>
      <PageHead
        title={data.name}
        description={
          <>
            Your role: {data.role_label} · Plan: {data.plan}{' '}
            <Badge>{data.subscription_status}</Badge>
          </>
        }
        actions={
          <>
            <Link className="tv-btn" href={`/organizations/${id}/members`}>
              Members & roles
            </Link>
            {roleHas(data.role, 'audit.view') && (
              <Link className="tv-btn" href={`/audit?org=${id}`}>
                Audit log
              </Link>
            )}
            <Link className="tv-btn tv-btn--primary" href="/devices/enroll">
              Enroll a company device
            </Link>
          </>
        }
      />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {canPolicy && !user?.mfa_enabled && data.require_mfa_for_admins && (
        <Notice tone="warn">
          This organization requires two-step verification for administrative changes.{' '}
          <Link href="/settings">Turn it on in Settings.</Link>
        </Notice>
      )}
      <div className="stack">
        <div className="tv-grid tv-grid--stats">
          <Stat label="Members" value={data.stats.members} />
          <Stat label="Active devices" value={data.stats.active_devices} />
          <Stat label="Reporting now" value={data.stats.reporting_devices} />
          <Stat label="Open alerts" value={data.stats.open_alerts} />
        </div>
        <div className="tv-row">
          <Link href={`/devices`}>Organization devices</Link>
          <Link href={`/timeline`}>Organization activity</Link>
          <Link href={`/alerts`}>Organization alerts</Link>
        </div>
        <div className="tv-grid tv-grid--2" style={{ alignItems: 'start' }}>
          <Card title="Policies">
            <label className="tv-row" style={{ marginBottom: 10 }}>
              <input
                type="checkbox"
                checked={data.member_enrollment_allowed}
                disabled={!canPolicy}
                onChange={(e) => patch({ member_enrollment_allowed: e.target.checked })}
              />
              Standard members may enroll devices into the organization
            </label>
            <label className="tv-row" style={{ marginBottom: 10 }}>
              <input
                type="checkbox"
                checked={data.require_mfa_for_admins}
                disabled={!isOwner}
                onChange={(e) => patch({ require_mfa_for_admins: e.target.checked })}
              />
              Require two-step verification for administrative actions
            </label>
            <label className="tv-row" style={{ marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={data.recordings_allowed}
                disabled={!isOwner}
                onChange={(e) => patch({ recordings_allowed: e.target.checked })}
              />
              Allow screen/audio recordings on organization devices
            </label>
            <p className="tv-small tv-muted">
              Only enable recordings after telling staff, in writing, when and why recordings may be
              made. Recordings still require the device user to start them and accept the system
              permission. Only the owner can view organization recordings.
            </p>
          </Card>
          <Card title="Retention">
            <form onSubmit={saveRetention}>
              <Field label="Activity events (days)" htmlFor="events">
                <input
                  className="tv-input"
                  id="events"
                  name="events"
                  type="number"
                  min={1}
                  max={730}
                  defaultValue={data.event_retention_days}
                  disabled={!canPolicy}
                />
              </Field>
              <Field label="Recordings (days)" htmlFor="recordings">
                <input
                  className="tv-input"
                  id="recordings"
                  name="recordings"
                  type="number"
                  min={1}
                  max={730}
                  defaultValue={data.recording_retention_days}
                  disabled={!canPolicy}
                />
              </Field>
              <Field label="Audit log (days)" htmlFor="audit">
                <input
                  className="tv-input"
                  id="audit"
                  name="audit"
                  type="number"
                  min={30}
                  max={3650}
                  defaultValue={data.audit_retention_days}
                  disabled={!canPolicy}
                />
              </Field>
              {canPolicy && <Button type="submit">Save retention</Button>}
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
