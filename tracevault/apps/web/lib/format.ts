import { EVENT_TYPES } from '@tracevault/event-schema';

/** Local time with zone, e.g. "21 Oct 2026, 14:05 WAT". Full UTC goes in the title attribute. */
export function formatTime(iso: string | null | undefined, opts: { seconds?: boolean } = {}): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(opts.seconds ? { second: '2-digit' } : {}),
    timeZoneName: 'short',
  });
}

export function utcTitle(iso: string | null | undefined): string | undefined {
  return iso ? `${new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}` : undefined;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [ms, unit] of units) if (abs >= ms) return rtf.format(-Math.round(diff / ms), unit);
  return 'just now';
}

export function eventLabel(type: string): string {
  return (EVENT_TYPES as Record<string, string>)[type] ?? type;
}

export function bytes(n: number | null | undefined): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function money(minor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
}

export const PLATFORM_LABEL: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  android: 'Android',
  ios: 'iOS',
  web: 'Web',
  simulator: 'Simulator',
};
