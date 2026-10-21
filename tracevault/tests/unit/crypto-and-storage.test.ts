import { randomBytes } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { decrypt, encrypt, enrollmentCode, normalizeEnrollmentCode, randomToken } from '../../apps/api/src/common/crypto';
import { LocalEncryptedStorage, ObjectTooLargeError } from '../../apps/api/src/recordings/object-storage';
import { resolveWindow } from '../../apps/api/src/summaries/summary.service';

describe('crypto helpers', () => {
  const key = randomBytes(32);

  it('round-trips AES-GCM and detects tampering', () => {
    const ct = encrypt(key, 'JBSWY3DPEHPK3PXP');
    expect(decrypt(key, ct)).toBe('JBSWY3DPEHPK3PXP');
    const buf = Buffer.from(ct, 'base64');
    buf[buf.length - 1] ^= 1;
    expect(() => decrypt(key, buf.toString('base64'))).toThrow();
  });

  it('generates prefixed high-entropy tokens and readable enrollment codes', () => {
    expect(randomToken('tvd')).toMatch(/^tvd_[A-Za-z0-9_-]{43}$/);
    const code = enrollmentCode();
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(normalizeEnrollmentCode(code.toLowerCase().replace('-', ' '))).toBe(code);
  });
});

describe('LocalEncryptedStorage', () => {
  const storage = new LocalEncryptedStorage(mkdtempSync(join(tmpdir(), 'tv-store-')), randomBytes(32));

  it('stores and retrieves bytes with size and hash', async () => {
    const data = randomBytes(100_000);
    const r = await storage.put('u1/rec1', Readable.from([data]), 200_000);
    expect(r.size).toBe(data.length);
    const chunks: Buffer[] = [];
    for await (const c of await storage.get('u1/rec1')) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
  });

  it('rejects uploads over the size cap and path traversal keys', async () => {
    await expect(storage.put('u1/big', Readable.from([randomBytes(2000)]), 1000)).rejects.toBeInstanceOf(ObjectTooLargeError);
    await expect(storage.put('../escape', Readable.from([Buffer.from('x')]), 10)).rejects.toThrow(/invalid storage key/);
  });
});

describe('summary time windows', () => {
  const now = new Date('2026-10-21T15:00:00Z');
  it.each([
    ['What happened yesterday afternoon?', '2026-10-20T12:00:00.000Z', '2026-10-20T18:00:00.000Z'],
    ['anything today', '2026-10-21T00:00:00.000Z', '2026-10-21T15:00:00.000Z'],
    ['last week please', '2026-10-14T15:00:00.000Z', '2026-10-21T15:00:00.000Z'],
    ['random question', '2026-10-20T15:00:00.000Z', '2026-10-21T15:00:00.000Z'],
  ])('%s', (q, from, to) => {
    const w = resolveWindow(q, now);
    expect(w.from.toISOString()).toBe(from);
    expect(w.to.toISOString()).toBe(to);
  });
});
