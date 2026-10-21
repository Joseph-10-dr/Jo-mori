'use client';

import { Button, Card, Notice } from '@tracevault/design-system';
import Link from 'next/link';
import { useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function OnboardingPage() {
  const { user, refresh } = useSession();
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const business = user?.account_type === 'business';

  async function resend() {
    try {
      await api('/v1/auth/verify-email/resend', { method: 'POST' });
      setMsg({ tone: 'success', text: 'A new verification link is on its way.' });
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    }
  }

  return (
    <>
      <PageHead
        title="Set up TraceVault"
        description="Three steps. History only starts once a device is enrolled, so do this before you lend the device out."
      />
      <div className="stack">
        <Card title={`1. Confirm your email ${user?.email_verified ? '✓' : ''}`}>
          {user?.email_verified ? (
            <p className="tv-muted">Done — {user.email} is verified.</p>
          ) : (
            <>
              {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
              <p>We sent a link to {user?.email}. Open it to verify your address.</p>
              <div className="tv-row">
                <Button onClick={resend}>Resend link</Button>
                <Button variant="ghost" onClick={refresh}>
                  I’ve verified it
                </Button>
              </div>
            </>
          )}
        </Card>
        <Card title="2. Enroll your first device">
          <p>
            Install the TraceVault agent on the device you want to protect, then enter a one-time
            enrollment code. The agent shows its status at all times and can be paused or removed by
            the device user.
          </p>
          <Link
            className="tv-btn tv-btn--primary"
            href="/devices/enroll"
            aria-disabled={!user?.email_verified}
          >
            Get an enrollment code
          </Link>
        </Card>
        <Card title="3. Choose how you’re alerted">
          <p>
            Email alerts are on for medium-severity events and above, and for new sign-ins to your
            account.
          </p>
          <Link className="tv-btn" href="/settings#notifications">
            Review notification settings
          </Link>
        </Card>
        {business && (
          <Card title="Setting up for a business?">
            <p>
              Create an organization to invite colleagues, assign roles and enroll company-owned
              devices. Tell staff which devices are monitored and what is collected; a subscription
              alone does not authorize monitoring employees.
            </p>
            <Link className="tv-btn" href="/organizations">
              Create an organization
            </Link>
          </Card>
        )}
      </div>
    </>
  );
}
