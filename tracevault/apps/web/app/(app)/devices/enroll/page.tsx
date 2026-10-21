'use client';

import { Button, Card, Field, Notice } from '@tracevault/design-system';
import Link from 'next/link';
import { useState } from 'react';
import { PageHead } from '@/components/AppShell';
import { Time } from '@/components/bits';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function EnrollPage() {
  const { memberships, user } = useSession();
  const [org, setOrg] = useState('');
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    try {
      setCode(
        await api('/v1/devices/enrollment-codes', {
          method: 'POST',
          body: { organization_id: org || null },
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <PageHead
        title="Enroll a device"
        description="Enrollment links a device to your account. Only enroll devices you own or are authorized to manage."
      />
      <div className="stack">
        <Card title="1. Install the agent on the device">
          <ul className="check-list">
            <li>
              <strong>Windows:</strong> install the TraceVault agent (build instructions in{' '}
              <code>apps/desktop-windows/README.md</code>). It reads the Windows Security event log
              and shows a tray icon while running.
            </li>
            <li>
              <strong>Try it without a device:</strong> run the simulator from the repository with{' '}
              <code>pnpm simulate --code YOUR-CODE</code>. Its events are labelled “Simulated”.
            </li>
            <li>
              <strong>macOS, Android, iOS:</strong> not released yet — see Help for what each
              platform will support.
            </li>
          </ul>
        </Card>
        <Card title="2. Create a one-time code">
          {error && <Notice tone="error">{error}</Notice>}
          {!user?.email_verified && <Notice tone="warn">Verify your email address first.</Notice>}
          {memberships.length > 0 && (
            <Field
              label="Enroll into"
              htmlFor="org"
              hint="Organization devices are visible to that organization’s administrators and analysts."
            >
              <select
                className="tv-select"
                id="org"
                value={org}
                onChange={(e) => setOrg(e.target.value)}
              >
                <option value="">My personal account</option>
                {memberships.map((m) => (
                  <option key={m.organization_id} value={m.organization_id}>
                    {m.organization_name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {code ? (
            <>
              <p>
                Enter this code in the agent. It works once and expires at{' '}
                <Time iso={code.expires_at} />.
              </p>
              <div className="code-box" aria-label="Enrollment code">
                {code.code}
              </div>
              <div className="tv-row" style={{ marginTop: 12 }}>
                <Button onClick={() => navigator.clipboard?.writeText(code.code)}>Copy code</Button>
                <Button variant="ghost" onClick={create}>
                  New code
                </Button>
                <Link href="/devices">Go to devices</Link>
              </div>
            </>
          ) : (
            <Button variant="primary" onClick={create} disabled={!user?.email_verified}>
              Create enrollment code
            </Button>
          )}
        </Card>
      </div>
    </>
  );
}
