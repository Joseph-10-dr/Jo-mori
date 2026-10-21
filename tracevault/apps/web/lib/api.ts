/** Thin fetch wrapper for the TraceVault API (proxied at /api). */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export function qs(q: Query = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q))
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; query?: Query } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(`/api${path}${qs(init.query)}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      // Required by the API for cookie-authenticated writes (CSRF defence).
      ...(method !== 'GET' ? { 'x-tracevault-csrf': '1' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let details;
    try {
      const b = await res.json();
      msg = Array.isArray(b.message) ? b.message.join(', ') : (b.message ?? msg);
      details = b.details;
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/v1/auth/')) {
      window.dispatchEvent(new CustomEvent('tv:unauthorized'));
    }
    throw new ApiError(res.status, msg, details);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Downloads a file response (CSV/JSON export) through the proxy. */
export async function download(path: string, query: Query, fallbackName: string, method = 'GET') {
  const res = await fetch(`/api${path}${qs(query)}`, {
    method,
    credentials: 'same-origin',
    headers: method !== 'GET' ? { 'x-tracevault-csrf': '1' } : {},
  });
  if (!res.ok) throw new ApiError(res.status, `Export failed (${res.status})`);
  const blob = await res.blob();
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.details?.length)
      return `${err.message}: ${err.details.map((d) => `${d.path ? d.path + ' — ' : ''}${d.message}`).join('; ')}`;
    return err.message;
  }
  return 'Something went wrong. Check your connection and try again.';
}
