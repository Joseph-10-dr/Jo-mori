'use client';

import { Button, Field, Notice } from '@tracevault/design-system';
import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { AuthCard } from '@/components/AuthCard';
import { api, errorMessage } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await api('/v1/auth/password/forgot', { method: 'POST', body: { email: new FormData(e.currentTarget).get('email') } });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <AuthCard title="Reset your password" footer={<Link href="/login">Back to sign in</Link>}>
      {sent ? (
        <Notice tone="success">If an account exists for that email, we’ve sent a reset link. It expires in 30 minutes.</Notice>
      ) : (
        <form onSubmit={submit}>
          {error && <Notice tone="error">{error}</Notice>}
          <Field label="Email" htmlFor="email">
            <input className="tv-input" id="email" name="email" type="email" autoComplete="email" required />
          </Field>
          <Button variant="primary" type="submit">
            Send reset link
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
