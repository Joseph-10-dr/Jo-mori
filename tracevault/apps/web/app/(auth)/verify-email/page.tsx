'use client';

import { Notice, Spinner } from '@tracevault/design-system';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AuthCard } from '@/components/AuthCard';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

function Verify() {
  const params = useSearchParams();
  const session = useSession();
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [error, setError] = useState('');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    api('/v1/auth/verify-email', { method: 'POST', body: { token: params.get('token') ?? '' } })
      .then(() => {
        setState('done');
        session.refresh();
      })
      .catch((err) => {
        setError(errorMessage(err));
        setState('error');
      });
  }, [params, session]);

  return (
    <AuthCard title="Verify your email">
      {state === 'working' && <Spinner label="Confirming your address" />}
      {state === 'done' && (
        <>
          <Notice tone="success">Your email address is confirmed.</Notice>
          <Link className="tv-btn tv-btn--primary" href={session.status === 'signed-in' ? '/onboarding' : '/login'}>
            Continue
          </Link>
        </>
      )}
      {state === 'error' && (
        <>
          <Notice tone="error">{error}</Notice>
          <p>Sign in and request a new link from the setup page.</p>
          <Link className="tv-btn" href="/login">
            Sign in
          </Link>
        </>
      )}
    </AuthCard>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
