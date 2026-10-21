import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { dirname, resolve, sep } from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

export interface StoredObject {
  size: number;
  sha256Hex: string;
}

/**
 * Private object storage abstraction. Recording bytes never go in the database.
 * `LocalEncryptedStorage` is used for development and single-server deployments;
 * an S3/Supabase Storage adapter implementing the same interface is the
 * documented next step for production (see docs/architecture.md).
 */
export interface ObjectStorage {
  put(key: string, body: Readable, maxBytes: number): Promise<StoredObject>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

export class ObjectTooLargeError extends Error {}

/** Files are AES-256-GCM encrypted at rest: [12-byte IV][ciphertext][16-byte tag]. */
export class LocalEncryptedStorage implements ObjectStorage {
  constructor(
    private readonly root: string,
    private readonly key: Buffer,
  ) {}

  private path(key: string): string {
    if (!/^[a-z0-9/_-]+$/i.test(key)) throw new Error('invalid storage key');
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return p;
  }

  async put(key: string, body: Readable, maxBytes: number): Promise<StoredObject> {
    const target = this.path(key);
    await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.part`;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const digest = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new ObjectTooLargeError(`upload exceeds ${maxBytes} bytes`));
        digest.update(chunk);
        cb(null, chunk);
      },
    });
    const out = createWriteStream(tmp, { mode: 0o600 });
    out.write(iv);
    try {
      await pipeline(body, meter, cipher, out, { end: false });
      await new Promise<void>((res, rej) => out.end(cipher.getAuthTag(), (err?: Error | null) => (err ? rej(err) : res())));
      await fs.rename(tmp, target);
    } catch (err) {
      out.destroy();
      await fs.rm(tmp, { force: true });
      throw err;
    }
    return { size, sha256Hex: digest.digest('hex') };
  }

  async get(key: string): Promise<Readable> {
    const p = this.path(key);
    const { size } = await fs.stat(p);
    const fh = await fs.open(p, 'r');
    const iv = Buffer.alloc(12);
    const tag = Buffer.alloc(16);
    await fh.read(iv, 0, 12, 0);
    await fh.read(tag, 0, 16, size - 16);
    await fh.close();
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    if (size === 28) return Readable.from(Buffer.concat([decipher.update(Buffer.alloc(0)), decipher.final()]));
    return createReadStream(p, { start: 12, end: size - 17 }).pipe(decipher);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.path(key), { force: true });
  }
}
