import Link from 'next/link';
import type { ReactNode } from 'react';

export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="auth-wrap">
      <main id="main" className="auth-card">
        <Link href="/" className="brand" style={{ justifyContent: 'center' }}>
          <span className="brand-mark" aria-hidden="true">
            TV
          </span>
          TraceVault
        </Link>
        <div className="tv-card">
          <h1 style={{ fontSize: 22 }}>{title}</h1>
          {subtitle && <p className="tv-muted">{subtitle}</p>}
          {children}
        </div>
        {footer && (
          <p className="tv-small tv-muted" style={{ textAlign: 'center', marginTop: 14 }}>
            {footer}
          </p>
        )}
      </main>
    </div>
  );
}
