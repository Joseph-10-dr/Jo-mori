'use client';

import { Button, Field, Notice } from '@tracevault/design-system';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';
import { AuthCard } from '@/components/AuthCard';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

function RegisterForm() {
  const router = useRouter();
  const params = useSearchParams();
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState(params.get('type') === 'business' ? 'business' : 'personal');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get('password') !== f.get('confirm')) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = {
        email: f.get('email'),
        password: f.get('password'),
        display_name: (f.get('name') as string) || undefined,
        account_type: type,
      };
      await api('/v1/auth/register', { method: 'POST', body });
      await api('/v1/auth/login', {
        method: 'POST',
        body: { email: body.email, password: body.password },
      });
      await session.refresh();
      router.replace('/onboarding');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Create your account"
      subtitle="Free for one device. No payment details needed."
      footer={
        <>
          Already have an account? <Link href="/login">Sign in</Link>
        </>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      <form onSubmit={submit}>
        <fieldset style={{ border: 0, padding: 0, margin: '0 0 14px' }}>
          <legend style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Account type</legend>
          <div className="tv-row">
            {(['personal', 'business'] as const).map((t) => (
              <label
                key={t}
                className="tv-btn tv-btn--sm"
                style={{ background: type === t ? 'var(--tv-info-bg)' : undefined }}
              >
                <input
                  type="radio"
                  name="type"
                  value={t}
                  checked={type === t}
                  onChange={() => setType(t)}
                />
                {t === 'personal' ? 'Personal' : 'Business'}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Name (optional)" htmlFor="name">
          <input className="tv-input" id="name" name="name" autoComplete="name" maxLength={80} />
        </Field>
        <Field label="Email" htmlFor="email" hint="We’ll send a link to confirm it.">
          <input
            className="tv-input"
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            aria-describedby="email-hint"
          />
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          hint="At least 10 characters. A passphrase of several words works well."
        >
          <input
            className="tv-input"
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            aria-describedby="password-hint"
          />
        </Field>
        <Field label="Confirm password" htmlFor="confirm">
          <input
            className="tv-input"
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
          />
        </Field>
        <p className="tv-small tv-muted">
          By creating an account you agree to use TraceVault only on devices you own or are
          authorized to monitor. See the <Link href="/help#privacy">privacy summary</Link>.
        </p>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthCard>
  );
}

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
