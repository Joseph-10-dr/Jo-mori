'use client';

import { Badge, Button, Card, Field, Notice, Spinner } from '@tracevault/design-system';
import { FormEvent, useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { ErrorNotice, Time } from '@/components/bits';
import { api, errorMessage } from '@/lib/api';
import { useApi, useSession } from '@/lib/session';

type Msg = { tone: 'error' | 'success'; text: string } | null;

function Profile() {
  const { user, refresh } = useSession();
  const [msg, setMsg] = useState<Msg>(null);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await api('/v1/account', { method: 'PATCH', body: { display_name: (new FormData(e.currentTarget).get('name') as string) || null } });
      await refresh();
      setMsg({ tone: 'success', text: 'Saved.' });
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }
  return (
    <Card title="Profile">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <form onSubmit={save}>
        <Field label="Email" htmlFor="email">
          <input className="tv-input" id="email" value={user?.email ?? ''} disabled />
        </Field>
        <Field label="Display name" htmlFor="name">
          <input className="tv-input" id="name" name="name" defaultValue={user?.display_name ?? ''} maxLength={80} />
        </Field>
        <Button type="submit">Save</Button>
      </form>
    </Card>
  );
}

function Password() {
  const [msg, setMsg] = useState<Msg>(null);
  async function change(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await api('/v1/auth/password/change', { method: 'POST', body: { current_password: f.get('current'), new_password: f.get('next') } });
      form.reset();
      setMsg({ tone: 'success', text: 'Password changed. Your other sessions were signed out.' });
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }
  return (
    <Card title="Password">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <form onSubmit={change}>
        <Field label="Current password" htmlFor="current">
          <input className="tv-input" id="current" name="current" type="password" autoComplete="current-password" required />
        </Field>
        <Field label="New password" htmlFor="next" hint="At least 10 characters.">
          <input className="tv-input" id="next" name="next" type="password" autoComplete="new-password" minLength={10} required />
        </Field>
        <Button type="submit">Change password</Button>
      </form>
    </Card>
  );
}

function Mfa() {
  const { user, refresh } = useSession();
  const [setup, setSetup] = useState<{ otpauth_url: string; secret: string } | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  async function start() {
    try {
      setSetup(await api('/v1/auth/mfa/setup', { method: 'POST' }));
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }
  async function confirm(e: FormEvent<HTMLFormElement>, path: 'enable' | 'disable') {
    e.preventDefault();
    try {
      await api(`/v1/auth/mfa/${path}`, { method: 'POST', body: { code: String(new FormData(e.currentTarget).get('code')).replace(/\s/g, '') } });
      setSetup(null);
      await refresh();
      setMsg({ tone: 'success', text: path === 'enable' ? 'Two-step verification is on.' : 'Two-step verification is off.' });
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }
  return (
    <Card title="Two-step verification" actions={user?.mfa_enabled ? <Badge tone="ok">On</Badge> : <Badge tone="medium">Off</Badge>}>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <p className="tv-muted">Use an authenticator app (such as Google Authenticator, Microsoft Authenticator or 1Password). Required for organization administrators.</p>
      {user?.mfa_enabled ? (
        <form onSubmit={(e) => confirm(e, 'disable')}>
          <Field label="Code from your app, to turn it off" htmlFor="mfa-off">
            <input className="tv-input" id="mfa-off" name="code" inputMode="numeric" autoComplete="one-time-code" required />
          </Field>
          <Button variant="danger" type="submit">
            Turn off
          </Button>
        </form>
      ) : setup ? (
        <form onSubmit={(e) => confirm(e, 'enable')}>
          <p>Add this key to your authenticator app, then enter the 6-digit code it shows.</p>
          <div className="code-box" style={{ fontSize: 16 }}>
            {setup.secret.match(/.{1,4}/g)?.join(' ')}
          </div>
          <p className="tv-small tv-muted" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>
            Or open this link on the device with your authenticator: <a href={setup.otpauth_url}>add to authenticator</a>
          </p>
          <Field label="6-digit code" htmlFor="mfa-code">
            <input className="tv-input" id="mfa-code" name="code" inputMode="numeric" autoComplete="one-time-code" required />
          </Field>
          <Button variant="primary" type="submit">
            Confirm and turn on
          </Button>
        </form>
      ) : (
        <Button variant="primary" onClick={start}>
          Set up two-step verification
        </Button>
      )}
    </Card>
  );
}

function Sessions() {
  const { data, error, loading, reload } = useApi<{ items: { id: string; user_agent: string | null; ip: string | null; last_used_at: string; created_at: string; current: boolean }[] }>(
    '/v1/auth/sessions',
  );
  const [msg, setMsg] = useState<Msg>(null);
  async function revoke(id?: string) {
    try {
      if (id) await api(`/v1/auth/sessions/${id}`, { method: 'DELETE' });
      else await api('/v1/auth/sessions/revoke-others', { method: 'POST' });
      reload();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }
  return (
    <Card title="Signed-in sessions" actions={<Button size="sm" onClick={() => revoke()}>Sign out all others</Button>}>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <ErrorNotice error={error} retry={reload} />
      {loading && <Spinner />}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {data?.items.map((s) => (
          <li key={s.id} className="tv-row" style={{ justifyContent: 'space-between', borderBottom: '1px solid var(--tv-border)', padding: '8px 0' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ overflowWrap: 'anywhere' }}>
                {(s.user_agent ?? 'Unknown app').slice(0, 80)} {s.current && <Badge tone="ok">This session</Badge>}
              </div>
              <div className="tv-small tv-muted">
                {s.ip ?? 'unknown IP'} · last active <Time iso={s.last_used_at} relative />
              </div>
            </div>
            {!s.current && (
              <Button size="sm" onClick={() => revoke(s.id)}>
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Notifications() {
  const { data, reload } = useApi<{ items: { channel: 'email' | 'push'; min_severity: string; enabled: boolean; login_alerts: boolean }[]; note: string }>('/v1/account/notifications');
  const [msg, setMsg] = useState<Msg>(null);
  async function save(channel: string, patch: Record<string, unknown>) {
    const cur = data?.items.find((i) => i.channel === channel);
    if (!cur) return;
    try {
      await api('/v1/account/notifications', { method: 'PUT', body: { ...cur, ...patch } });
      reload();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }
  return (
    <div id="notifications">
      <Card title="Notifications">
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {data?.items.map((n) => (
          <fieldset key={n.channel} style={{ border: '1px solid var(--tv-border)', borderRadius: 8, marginBottom: 12 }}>
            <legend style={{ fontWeight: 600 }}>{n.channel === 'email' ? 'Email' : 'Push (mobile apps)'}</legend>
            <label className="tv-row">
              <input type="checkbox" checked={n.enabled} onChange={(e) => save(n.channel, { enabled: e.target.checked })} /> Send alerts
            </label>
            <label className="tv-row" style={{ marginTop: 6 }}>
              Minimum severity
              <select className="tv-select" style={{ width: 'auto' }} value={n.min_severity} onChange={(e) => save(n.channel, { min_severity: e.target.value })}>
                {['info', 'low', 'medium', 'high', 'critical'].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            {n.channel === 'email' && (
              <label className="tv-row" style={{ marginTop: 6 }}>
                <input type="checkbox" checked={n.login_alerts} onChange={(e) => save(n.channel, { login_alerts: e.target.checked })} /> Email me when my account is
                signed in from a new browser or app
              </label>
            )}
          </fieldset>
        ))}
        {data && <p className="tv-small tv-muted">{data.note}</p>}
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <>
      <PageHead title="Account settings" />
      <div className="tv-grid tv-grid--2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <Profile />
          <Password />
          <Notifications />
        </div>
        <div className="stack">
          <Mfa />
          <Sessions />
        </div>
      </div>
    </>
  );
}
