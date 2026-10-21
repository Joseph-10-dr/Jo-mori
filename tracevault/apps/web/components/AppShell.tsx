'use client';

import { Badge, Button, Spinner } from '@tracevault/design-system';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useEffect, useState } from 'react';
import { useApi, useSession } from '@/lib/session';

const NAV: { section?: string; href: string; label: string; icon: string }[] = [
  { href: '/dashboard', label: 'Overview', icon: '◎' },
  { href: '/timeline', label: 'Activity timeline', icon: '☰' },
  { href: '/alerts', label: 'Security alerts', icon: '⚑' },
  { href: '/investigate', label: 'Investigate', icon: '?' },
  { href: '/devices', label: 'Devices', icon: '▭' },
  { href: '/recordings', label: 'Recordings', icon: '●' },
  { section: 'Account', href: '/settings', label: 'Settings', icon: '⚙' },
  { href: '/settings/data', label: 'Data & retention', icon: '⛁' },
  { href: '/audit', label: 'Audit log', icon: '⎙' },
  { href: '/billing', label: 'Plan & usage', icon: '¤' },
  { href: '/organizations', label: 'Organizations', icon: '⌂' },
  { href: '/help', label: 'Help & recovery', icon: '✚' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const alerts = useApi<{ open_by_severity: Record<string, number> }>(
    session.status === 'signed-in' ? '/v1/alerts' : null,
    { status: 'open', limit: 1 },
  );

  useEffect(() => {
    if (session.status === 'signed-out')
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    if (session.status === 'mfa-pending')
      router.replace(`/mfa?next=${encodeURIComponent(pathname)}`);
  }, [session.status, router, pathname]);
  useEffect(() => setOpen(false), [pathname]);

  if (session.status !== 'signed-in') {
    return (
      <div className="auth-wrap">
        <Spinner label="Checking your session" />
      </div>
    );
  }
  const openAlerts = Object.values(alerts.data?.open_by_severity ?? {}).reduce((a, b) => a + b, 0);
  const isActive = (href: string) =>
    href === '/settings' ? pathname === href : pathname === href || pathname.startsWith(href + '/');

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/dashboard" className="brand" style={{ padding: 0 }}>
          <span className="brand-mark" aria-hidden="true">
            TV
          </span>
          TraceVault
        </Link>
        <Button
          size="sm"
          aria-expanded={open}
          aria-controls="sidebar"
          onClick={() => setOpen((o) => !o)}
        >
          Menu
        </Button>
      </header>
      <nav id="sidebar" className="sidebar" data-open={open} aria-label="Main">
        <Link href="/dashboard" className="brand">
          <span className="brand-mark" aria-hidden="true">
            TV
          </span>
          TraceVault
        </Link>
        {NAV.map((n) => (
          <div key={n.href}>
            {n.section && <div className="nav-section">{n.section}</div>}
            <Link
              href={n.href}
              className="nav-link"
              aria-current={isActive(n.href) ? 'page' : undefined}
            >
              <span aria-hidden="true" style={{ width: 16, textAlign: 'center' }}>
                {n.icon}
              </span>
              {n.label}
              {n.href === '/alerts' && openAlerts > 0 && (
                <span className="nav-count">
                  <Badge tone="high">
                    {openAlerts}
                    <span className="tv-visually-hidden"> open</span>
                  </Badge>
                </span>
              )}
            </Link>
          </div>
        ))}
        <div className="sidebar-foot">
          <div style={{ overflowWrap: 'anywhere' }}>{session.user?.email}</div>
          <div className="tv-row" style={{ marginTop: 6 }}>
            <Badge>{session.user?.plan} plan</Badge>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await session.logout();
                router.replace('/login');
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </nav>
      <main id="main" className="main">
        {!session.user?.email_verified && (
          <div className="tv-alert tv-alert--warn" role="status">
            Verify your email address to enroll devices and receive alerts.{' '}
            <Link href="/onboarding">Resend the link</Link>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

export function PageHead({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="tv-row">{actions}</div>}
    </div>
  );
}
