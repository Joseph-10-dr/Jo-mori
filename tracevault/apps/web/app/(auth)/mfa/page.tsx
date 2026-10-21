'use client';

import { Button, Field, Notice } from '@tracevault/design-system';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';
import { AuthCard } from '@/components/AuthCard';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

function MfaForm() {
  const router = useRouter();
  const params = useSearchParams();
  const session = useSession();
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '').replace(/\s/g, '');
    try {
      await api('/v1/auth/mfa/verify', { method: 'POST', body: { code } });
      await session.refresh();
      const next = params.get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <AuthCard title="Two-step verification" subtitle="Enter the 6-digit code from your authenticator app.">
      {error && <Notice tone="error">{error}</Notice>}
      <form onSubmit={submit}>
        <Field label="Code" htmlFor="code">
          <input className="tv-input" id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required autoFocus />
        </Field>
        <div className="tv-row">
          <Button variant="primary" type="submit">
            Verify
          </Button>
          <Button type="button" variant="ghost" onClick={() => session.logout().then(() => router.replace('/login'))}>
            Cancel
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}

export default function MfaPage() {
  return (
    <Suspense>
      <MfaForm />
    </Suspense>
  );
}
