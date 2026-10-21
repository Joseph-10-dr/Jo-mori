import type { BatchResult } from '@tracevault/event-schema';
import { OfflineQueue } from './queue';

export interface UploaderOptions {
  apiUrl: string;
  deviceSecret: string;
  queue: OfflineQueue;
  batchSize?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export type SyncOutcome =
  | { ok: true; uploaded: number; duplicates: number; rejected: number }
  | { ok: false; reason: 'offline' | 'revoked' | 'server'; message: string };

export class PermanentError extends Error {}

/**
 * Drains the queue in batches. Network errors, 5xx and 429 are retried with
 * exponential backoff and jitter; 401 means the credential was revoked and
 * stops syncing. Events the server rejects as invalid are logged and removed
 * (retrying them would never succeed).
 */
export class Uploader {
  consecutiveFailures = 0;
  lastError?: string;
  private readonly o: Required<Omit<UploaderOptions, 'log'>> & { log: (m: string) => void };

  constructor(opts: UploaderOptions) {
    this.o = {
      batchSize: 200,
      maxAttempts: 5,
      baseDelayMs: 1000,
      fetchImpl: fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: () => undefined,
      ...opts,
    };
  }

  private async post(path: string, body: unknown): Promise<Response> {
    return this.o.fetchImpl(`${this.o.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Device ${this.o.deviceSecret}`,
      },
      body: JSON.stringify(body),
    });
  }

  private async sendBatch(events: unknown[]): Promise<BatchResult> {
    for (let attempt = 1; ; attempt++) {
      let retryAfterMs: number | undefined;
      try {
        const res = await this.post('/v1/events/batch', { events });
        if (res.ok) return (await res.json()) as BatchResult;
        if (res.status === 401) throw new PermanentError('device credential revoked or invalid');
        if (res.status === 429)
          retryAfterMs = Number(res.headers.get('retry-after') ?? 0) * 1000 || undefined;
        else if (res.status < 500)
          throw new PermanentError(`server rejected the batch (${res.status})`);
        this.lastError = `HTTP ${res.status}`;
      } catch (err) {
        if (err instanceof PermanentError) throw err;
        this.lastError = (err as Error).message || 'network error';
      }
      if (attempt >= this.o.maxAttempts) throw new Error(this.lastError);
      const backoff =
        retryAfterMs ?? this.o.baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      this.o.log(`upload failed (${this.lastError}); retrying in ${Math.round(backoff)}ms`);
      await this.o.sleep(backoff);
    }
  }

  async sync(): Promise<SyncOutcome> {
    let uploaded = 0;
    let duplicates = 0;
    let rejected = 0;
    while (this.o.queue.size > 0) {
      const batch = this.o.queue.peek(this.o.batchSize);
      try {
        const r = await this.sendBatch(batch);
        uploaded += r.accepted;
        duplicates += r.duplicates;
        rejected += r.rejected.length;
        for (const rej of r.rejected)
          this.o.log(`server rejected event ${rej.event_id ?? `#${rej.index}`}: ${rej.reason}`);
        // Everything in the batch is now settled server-side.
        this.o.queue.ack(new Set(batch.map((e) => e.event_id)));
        this.consecutiveFailures = 0;
        this.lastError = undefined;
      } catch (err) {
        this.consecutiveFailures++;
        const message = (err as Error).message;
        if (err instanceof PermanentError && /revoked/.test(message))
          return { ok: false, reason: 'revoked', message };
        return { ok: false, reason: err instanceof PermanentError ? 'server' : 'offline', message };
      }
    }
    return { ok: true, uploaded, duplicates, rejected };
  }

  async heartbeat(extra: {
    monitoring_status: string;
    permissions: Record<string, string>;
    agent_version: string;
    os_version?: string;
  }) {
    try {
      await this.post('/v1/devices/self/heartbeat', {
        ...extra,
        startup_enabled: false,
        queued_events: this.o.queue.size,
        consecutive_upload_failures: this.consecutiveFailures,
        ...(this.lastError ? { last_error: this.lastError.slice(0, 300) } : {}),
      });
    } catch {
      /* heartbeat is best-effort; failures are reflected in the next one */
    }
  }
}
