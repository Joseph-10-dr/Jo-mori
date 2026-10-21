import { BadRequestException } from '@nestjs/common';

/** Keyset pagination cursor over (timestamp, id), opaque to clients. */
export function encodeCursor(ts: Date | string, id: string): string {
  return Buffer.from(JSON.stringify([new Date(ts).toISOString(), id])).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { ts: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [ts, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof ts !== 'string' || typeof id !== 'string' || Number.isNaN(Date.parse(ts)))
      throw new Error();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error();
    return { ts, id };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

export const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};
