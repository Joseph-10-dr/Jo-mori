import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export function Button({
  variant = 'default',
  size,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost'; size?: 'sm'; ref?: Ref<HTMLButtonElement> }) {
  const cls = ['tv-btn', variant !== 'default' && `tv-btn--${variant}`, size && `tv-btn--${size}`, className].filter(Boolean).join(' ');
  return <button className={cls} {...props} />;
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`tv-card ${className}`}>
      {(title || actions) && (
        <div className="tv-card__title">
          {title && <h2>{title}</h2>}
          {actions && <div className="tv-row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="tv-card tv-stat">
      <span className="tv-stat__value">{value}</span>
      <span className="tv-stat__label">{label}</span>
      {hint && <span className="tv-small tv-muted">{hint}</span>}
    </div>
  );
}

const SEVERITY_LABEL: Record<Severity, string> = { info: 'Info', low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };

/** Severity is conveyed by text as well as colour (WCAG 1.4.1). */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`tv-badge tv-badge--${severity}`}>{SEVERITY_LABEL[severity] ?? severity}</span>;
}

export function Badge({ tone, children }: { tone?: Severity | 'ok' | 'demo'; children: ReactNode }) {
  return <span className={`tv-badge${tone ? ` tv-badge--${tone}` : ''}`}>{children}</span>;
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error' | 'success' | 'warn'; children: ReactNode }) {
  return (
    <div className={`tv-alert${tone !== 'info' ? ` tv-alert--${tone}` : ''}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="tv-empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" className="tv-row tv-muted">
      <span className="tv-spinner" aria-hidden="true" />
      <span>{label}…</span>
    </span>
  );
}

export function Field({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor: string; children: ReactNode }) {
  return (
    <div className="tv-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && (
        <span className="tv-field__hint" id={`${htmlFor}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}
