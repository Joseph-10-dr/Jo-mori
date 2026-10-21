'use client';

import { Card, EmptyState, Notice, Spinner } from '@tracevault/design-system';
import { useApi } from '@/lib/session';
import { Time } from '@/components/bits';

/** Development only: shows emails captured by MAIL_PROVIDER=outbox. The API returns 404 in production. */
export default function OutboxPage() {
  const { data, error, loading } = useApi<{ items: { id: string; to_email: string; subject: string; body: string; created_at: string }[] }>('/v1/dev/outbox');
  return (
    <main id="main" className="landing" style={{ paddingTop: 24 }}>
      <h1>Development mail outbox</h1>
      <Notice tone="warn">Local development only. These emails were not actually sent.</Notice>
      {loading && <Spinner />}
      {error ? <Notice tone="error">The outbox is disabled (production mode) or the API is not running.</Notice> : null}
      {data?.items.length === 0 && <EmptyState title="No emails yet" />}
      <div className="stack">
        {data?.items.map((m) => (
          <Card key={m.id} title={m.subject}>
            <p className="tv-small tv-muted">
              To {m.to_email} · <Time iso={m.created_at} />
            </p>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--tv-mono)', fontSize: 13 }}>
              {m.body.split(/(https?:\/\/\S+)/).map((part, i) =>
                /^https?:\/\//.test(part) ? (
                  <a key={i} href={part.replace(/^https?:\/\/[^/]+/, '')}>
                    {part}
                  </a>
                ) : (
                  part
                ),
              )}
            </pre>
          </Card>
        ))}
      </div>
    </main>
  );
}
