import { mkdtempSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OfflineQueue } from '../../apps/simulator/src/queue';
import { lentLaptop } from '../../apps/simulator/src/scenarios';
import { Uploader } from '../../apps/simulator/src/uploader';
import { validateEvents } from '@tracevault/event-schema';

const tmpQueue = (cap?: number) =>
  new OfflineQueue(join(mkdtempSync(join(tmpdir(), 'tvq-')), 'q.json'), cap);
const ok = (accepted: number) =>
  new Response(
    JSON.stringify({
      accepted,
      duplicates: 0,
      rejected: [],
      received_at: new Date().toISOString(),
    }),
    { status: 200 },
  );

describe('offline queue', () => {
  it('persists across restarts with owner-only permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvq-'));
    const q = new OfflineQueue(join(dir, 'q.json'));
    q.push(...lentLaptop());
    expect(statSync(join(dir, 'q.json')).mode & 0o777).toBe(0o600);
    const reopened = new OfflineQueue(join(dir, 'q.json'));
    expect(reopened.size).toBe(q.size);
  });

  it('drops the oldest events when full and counts the loss', () => {
    const q = tmpQueue(10);
    const events = lentLaptop();
    q.push(...events);
    expect(q.size).toBe(10);
    expect(q.dropped).toBe(events.length - 10);
    expect(q.peek(1)[0].event_id).toBe(events[events.length - 10].event_id);
  });
});

describe('uploader', () => {
  const sleep = jest.fn(async () => undefined);

  it('scenario events are valid and labelled as demonstration data', () => {
    const { accepted, rejected } = validateEvents(lentLaptop());
    expect(rejected).toEqual([]);
    expect(accepted.every((e) => e.source === 'simulator' && e.metadata.demo === true)).toBe(true);
  });

  it('keeps events queued while offline, then syncs when connectivity returns', async () => {
    const q = tmpQueue();
    q.push(...lentLaptop());
    const n = q.size;
    let online = false;
    const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      if (!online) throw new TypeError('fetch failed');
      return ok(JSON.parse(String(init!.body)).events.length);
    }) as unknown as typeof fetch;
    const u = new Uploader({
      apiUrl: 'http://x',
      deviceSecret: 'tvd_x',
      queue: q,
      fetchImpl,
      sleep,
      maxAttempts: 3,
    });
    const first = await u.sync();
    expect(first).toMatchObject({ ok: false, reason: 'offline' });
    expect(q.size).toBe(n);
    expect(u.consecutiveFailures).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(2); // retried with backoff before giving up
    online = true;
    const second = await u.sync();
    expect(second).toMatchObject({ ok: true, uploaded: n });
    expect(q.size).toBe(0);
    expect(u.consecutiveFailures).toBe(0);
  });

  it('retries 5xx and honours Retry-After on 429', async () => {
    const q = tmpQueue();
    q.push(...lentLaptop().slice(0, 3));
    const responses = [
      new Response('', { status: 503 }),
      new Response('', { status: 429, headers: { 'retry-after': '7' } }),
      ok(3),
    ];
    const fetchImpl = jest.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const waits: number[] = [];
    const u = new Uploader({
      apiUrl: 'http://x',
      deviceSecret: 'tvd_x',
      queue: q,
      fetchImpl,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(await u.sync()).toMatchObject({ ok: true, uploaded: 3 });
    expect(waits[1]).toBe(7000);
  });

  it('stops immediately when the device credential is revoked', async () => {
    const q = tmpQueue();
    q.push(...lentLaptop().slice(0, 2));
    const fetchImpl = jest.fn(
      async () => new Response('', { status: 401 }),
    ) as unknown as typeof fetch;
    const u = new Uploader({
      apiUrl: 'http://x',
      deviceSecret: 'tvd_x',
      queue: q,
      fetchImpl,
      sleep,
    });
    expect(await u.sync()).toMatchObject({ ok: false, reason: 'revoked' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(q.size).toBe(2);
  });

  it('uploads in batches', async () => {
    const q = tmpQueue();
    q.push(...lentLaptop(), ...lentLaptop());
    const sizes: number[] = [];
    const fetchImpl = jest.fn(async (_u: unknown, init?: RequestInit) => {
      const n = JSON.parse(String(init!.body)).events.length;
      sizes.push(n);
      return ok(n);
    }) as unknown as typeof fetch;
    await new Uploader({
      apiUrl: 'http://x',
      deviceSecret: 'tvd_x',
      queue: q,
      fetchImpl,
      sleep,
      batchSize: 7,
    }).sync();
    expect(Math.max(...sizes)).toBe(7);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(lentLaptop().length * 2);
  });
});
