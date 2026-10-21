'use client';

import { Button, Card, Notice } from '@tracevault/design-system';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

function Accept() {
  const params = useSearchParams();
  const router = useRouter();
  const { refresh, user } = useSession();
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    try {
      const r = await api<{ organization_id: string }>('/v1/invitations/accept', { method: 'POST', body: { token: params.get('token') ?? '' } });
      await refresh();
      router.replace(`/organizations/${r.organization_id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <PageHead title="Join an organization" />
      <Card>
        {error && <Notice tone="error">{error}</Notice>}
        <p>
          You’re signed in as <strong>{user?.email}</strong>. Joining lets the organization’s administrators and analysts see devices you
          enroll <em>into the organization</em>. They cannot see your personal devices or their history.
        </p>
        <Button variant="primary" onClick={accept}>
          Accept invitation
        </Button>
      </Card>
    </>
  );
}

export default function AcceptPage() {
  return (
    <Suspense>
      <Accept />
    </Suspense>
  );
}
