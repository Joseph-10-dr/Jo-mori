'use client';

import { Button, Field, Notice } from '@tracevault/design-system';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';
import { AuthCard } from '@/components/AuthCard';
import { api, errorMessage } from '@/lib/api';

function ResetForm() {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const token = params.get('token') ?? '';

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get('password') !== f.get('confirm')) return setError('The passwords do not match.');
    try {
      await api('/v1/auth/password/reset', { method: 'POST', body: { token, password: f.get('password') } });
      router.replace('/login?reset=1');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <AuthCard title="Choose a new password" subtitle="This signs you out on every other device.">
      {!token && <Notice tone="error">This reset link is incomplete. Request a new one.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <form onSubmit={submit}>
        <Field label="New password" htmlFor="password" hint="At least 10 characters.">
          <input className="tv-input" id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
        </Field>
        <Field label="Confirm new password" htmlFor="confirm">
          <input className="tv-input" id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
        </Field>
        <Button variant="primary" type="submit" disabled={!token}>
          Change password
        </Button>
      </form>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
