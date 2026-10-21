'use client';

import { ROLE_LABELS, type OrgRole } from '@tracevault/api-contracts';
import { Button, Card, EmptyState, Field, Notice, Spinner } from '@tracevault/design-system';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { ErrorNotice } from '@/components/bits';
import { api, errorMessage } from '@/lib/api';
import { useApi, useSession } from '@/lib/session';

export default function OrganizationsPage() {
  const router = useRouter();
  const { user, refresh } = useSession();
  const { data, error, loading, reload } = useApi<{
    items: {
      id: string;
      name: string;
      role: OrgRole;
      member_count: number;
      device_count: number;
    }[];
  }>('/v1/organizations');
  const [msg, setMsg] = useState<string | null>(null);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      const org = await api<{ id: string }>('/v1/organizations', {
        method: 'POST',
        body: { name: new FormData(e.currentTarget).get('name') },
      });
      await refresh();
      router.push(`/organizations/${org.id}`);
    } catch (err) {
      setMsg(errorMessage(err));
    }
  }

  return (
    <>
      <PageHead
        title="Organizations"
        description="Manage company-owned devices with roles, policies and audit logs."
      />
      <div className="tv-grid tv-grid--2" style={{ alignItems: 'start' }}>
        <Card title="Your organizations">
          <ErrorNotice error={error} retry={reload} />
          {loading && <Spinner />}
          {data && data.items.length === 0 && <EmptyState title="You’re not in any organization" />}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {data?.items.map((o) => (
              <li
                key={o.id}
                style={{ padding: '8px 0', borderBottom: '1px solid var(--tv-border)' }}
              >
                <Link href={`/organizations/${o.id}`} style={{ fontWeight: 600 }}>
                  {o.name}
                </Link>
                <div className="tv-small tv-muted">
                  {ROLE_LABELS[o.role]} · {o.member_count} members · {o.device_count} devices
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Create an organization">
          {msg && <Notice tone="error">{msg}</Notice>}
          {!user?.email_verified && <Notice tone="warn">Verify your email first.</Notice>}
          <p className="tv-small tv-muted">
            New organizations start on a Business trial (no payment is taken; billing isn’t
            connected yet). Administrator actions require two-step verification by default.
          </p>
          <form onSubmit={create}>
            <Field label="Organization name" htmlFor="org-name">
              <input
                className="tv-input"
                id="org-name"
                name="name"
                minLength={2}
                maxLength={120}
                required
              />
            </Field>
            <Button variant="primary" type="submit" disabled={!user?.email_verified}>
              Create organization
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}
