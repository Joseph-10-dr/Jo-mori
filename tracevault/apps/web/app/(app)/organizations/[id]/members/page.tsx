'use client';

import { ROLE_LABELS, roleHas, type OrgRole } from '@tracevault/api-contracts';
import { Badge, Button, Card, Field, Notice, Spinner } from '@tracevault/design-system';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { ErrorNotice, Time } from '@/components/bits';
import { api, errorMessage } from '@/lib/api';
import { useApi, useSession } from '@/lib/session';

const ASSIGNABLE: OrgRole[] = ['admin', 'security_analyst', 'auditor', 'member'];
const ROLE_HELP: Record<OrgRole, string> = {
  owner: 'Everything, including billing, recordings and deleting the organization.',
  admin: 'Manage members, devices, policies and audit logs. Cannot view recordings.',
  security_analyst: 'View all organization devices and events, and resolve alerts.',
  auditor: 'Read-only access to devices, events and the audit log.',
  member: 'Sees only devices they enrolled themselves.',
};

export default function MembersPage() {
  const { id } = useParams<{ id: string }>();
  const { user, memberships } = useSession();
  const myRole = memberships.find((m) => m.organization_id === id)?.role;
  const canManage = myRole ? roleHas(myRole, 'members.manage') : false;
  const members = useApi<{ items: { user_id: string; email: string; display_name: string | null; role: OrgRole; joined_at: string; mfa_enabled: boolean; devices: number }[] }>(
    `/v1/organizations/${id}/members`,
  );
  const invites = useApi<{ items: { id: string; email: string; role: OrgRole; expires_at: string; accepted_at: string | null; revoked_at: string | null }[] }>(
    canManage ? `/v1/organizations/${id}/invitations` : null,
  );
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  async function run(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      setMsg({ tone: 'success', text: ok });
      members.reload();
      invites.reload();
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }

  function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    run(async () => {
      await api(`/v1/organizations/${id}/invitations`, { method: 'POST', body: { email: f.get('email'), role: f.get('role') } });
      form.reset();
    }, 'Invitation sent.');
  }

  return (
    <>
      <PageHead title="Members & roles" description={<Link href={`/organizations/${id}`}>Back to organization</Link>} />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="stack">
        <Card title="Members">
          <ErrorNotice error={members.error} retry={members.reload} />
          {members.loading && <Spinner />}
          {members.data && (
            <div className="tv-table-wrap">
              <table className="tv-table">
                <thead>
                  <tr>
                    <th scope="col">Member</th>
                    <th scope="col">Role</th>
                    <th scope="col">2-step</th>
                    <th scope="col">Devices</th>
                    <th scope="col">Joined</th>
                    <th scope="col">
                      <span className="tv-visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {members.data.items.map((m) => (
                    <tr key={m.user_id}>
                      <td style={{ overflowWrap: 'anywhere' }}>
                        {m.display_name ?? m.email}
                        {m.display_name && <div className="tv-small tv-muted">{m.email}</div>}
                      </td>
                      <td>
                        {canManage && m.role !== 'owner' && m.user_id !== user?.id ? (
                          <select
                            className="tv-select"
                            aria-label={`Role for ${m.email}`}
                            value={m.role}
                            onChange={(e) => run(() => api(`/v1/organizations/${id}/members/${m.user_id}`, { method: 'PATCH', body: { role: e.target.value } }), 'Role updated.')}
                          >
                            {ASSIGNABLE.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          ROLE_LABELS[m.role]
                        )}
                      </td>
                      <td>{m.mfa_enabled ? <Badge tone="ok">On</Badge> : <Badge tone="medium">Off</Badge>}</td>
                      <td>{m.devices}</td>
                      <td>
                        <Time iso={m.joined_at} />
                      </td>
                      <td>
                        {m.role !== 'owner' && (canManage || m.user_id === user?.id) && (
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() =>
                              window.confirm(`Remove ${m.email}? Their organization devices stop uploading.`) &&
                              run(() => api(`/v1/organizations/${id}/members/${m.user_id}`, { method: 'DELETE' }), 'Member removed.')
                            }
                          >
                            {m.user_id === user?.id ? 'Leave' : 'Remove'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {canManage && (
          <div className="tv-grid tv-grid--2" style={{ alignItems: 'start' }}>
            <Card title="Invite someone">
              <form onSubmit={invite}>
                <Field label="Email" htmlFor="inv-email">
                  <input className="tv-input" id="inv-email" name="email" type="email" required />
                </Field>
                <Field label="Role" htmlFor="inv-role">
                  <select className="tv-select" id="inv-role" name="role" defaultValue="member">
                    {ASSIGNABLE.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button variant="primary" type="submit">
                  Send invitation
                </Button>
              </form>
            </Card>
            <Card title="Pending invitations">
              {invites.data?.items.filter((i) => !i.accepted_at && !i.revoked_at).length === 0 && <p className="tv-muted">None.</p>}
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {invites.data?.items
                  .filter((i) => !i.accepted_at && !i.revoked_at)
                  .map((i) => (
                    <li key={i.id} className="tv-row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                      <span>
                        {i.email} · {ROLE_LABELS[i.role]} · expires <Time iso={i.expires_at} relative />
                      </span>
                      <Button size="sm" onClick={() => run(() => api(`/v1/organizations/${id}/invitations/${i.id}`, { method: 'DELETE' }), 'Invitation revoked.')}>
                        Revoke
                      </Button>
                    </li>
                  ))}
              </ul>
            </Card>
          </div>
        )}
        <Card title="What each role can do">
          <dl className="kv">
            {(Object.keys(ROLE_HELP) as OrgRole[]).map((r) => (
              <div key={r} style={{ display: 'contents' }}>
                <dt>{ROLE_LABELS[r]}</dt>
                <dd>{ROLE_HELP[r]}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </>
  );
}
