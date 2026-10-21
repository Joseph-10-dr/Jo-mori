'use client';

import type { Membership, User } from '@tracevault/api-contracts';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError } from './api';

interface SessionState {
  status: 'loading' | 'signed-out' | 'mfa-pending' | 'signed-in';
  user: User | null;
  memberships: Membership[];
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<SessionState, 'refresh' | 'logout'>>({ status: 'loading', user: null, memberships: [] });

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: User; memberships: Membership[]; mfa_pending: boolean }>('/v1/auth/me');
      setState({ status: me.mfa_pending ? 'mfa-pending' : 'signed-in', user: me.user, memberships: me.memberships });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setState({ status: 'signed-out', user: null, memberships: [] });
      else setState((s) => ({ ...s, status: s.user ? s.status : 'signed-out' }));
    }
  }, []);

  const logout = useCallback(async () => {
    await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
    setState({ status: 'signed-out', user: null, memberships: [] });
  }, []);

  useEffect(() => {
    refresh();
    const onUnauthorized = () => setState({ status: 'signed-out', user: null, memberships: [] });
    window.addEventListener('tv:unauthorized', onUnauthorized);
    return () => window.removeEventListener('tv:unauthorized', onUnauthorized);
  }, [refresh]);

  return <Ctx.Provider value={{ ...state, refresh, logout }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** Loads data from the API with loading/error state and a reload function. */
export function useApi<T>(path: string | null, query?: Record<string, string | number | undefined>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!path);
  const key = path ? path + JSON.stringify(query ?? {}) : null;
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      setData(await api<T>(path, { query }));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}
