'use client';

import { Button, Field, Notice } from '@tracevault/design-system';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';
import { AuthCard } from '@/components/AuthCard';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

function safeNext(n: string | null) {
  return n && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard';
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ mfa_required: boolean }>('/v1/auth/login', {
        method: 'POST',
        body: { email: f.get('email'), password: f.get('password') },
      });
      await session.refresh();
      const next = safeNext(params.get('next'));
      router.replace(r.mfa_required ? `/mfa?next=${encodeURIComponent(next)}` : next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Sign in"
      subtitle="Review your devices’ security history."
      footer={
        <>
          New to TraceVault? <Link href="/register">Create an account</Link>
        </>
      }
    >
      {params.get('reset') && <Notice tone="success">Password changed. Sign in with your new password.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <form onSubmit={submit} noValidate={false}>
        <Field label="Email" htmlFor="email">
          <input className="tv-input" id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" htmlFor="password">
          <input className="tv-input" id="password" name="password" type="password" autoComplete="current-password" required />
        </Field>
        <div className="tv-row" style={{ justifyContent: 'space-between' }}>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
          <Link href="/forgot-password" className="tv-small">
            Forgot password?
          </Link>
        </div>
      </form>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
