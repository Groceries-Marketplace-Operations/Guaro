import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Account } from '../types';
import { authApi } from '../api';
import { isLocalProductionMode, stopLocalProductionSession } from './local-production';

interface AuthCtx {
  account: Account | null;
  token: string | null;
  login: (token: string, account: Account) => void;
  logout: () => void;
  loading: boolean;
}

const Ctx = createContext<AuthCtx>({} as AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  useEffect(() => {
    if (isLocalProductionMode) {
      authApi.me()
        .then((r) => {
          setToken(null);
          setAccount(r.data);
        })
        .catch(() => {
          setToken(null);
          setAccount(null);
          void stopLocalProductionSession().catch(() => {
            // The server-side TTL remains the final fail-safe.
          });
        })
        .finally(() => setLoading(false));
      return;
    }

    const stored = localStorage.getItem('token');
    if (!stored) { setLoading(false); return; }
    authApi.me()
      .then((r) => {
        const fresh = r.data.token ?? stored;
        if (fresh !== stored) localStorage.setItem('token', fresh);
        setToken(fresh);
        setAccount(r.data);
      })
      .catch(() => { localStorage.removeItem('token'); localStorage.removeItem('account'); })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback((t: string, a: Account) => {
    if (isLocalProductionMode) {
      // Local-production authentication is owned by the loopback proxy. Never
      // accept or persist a browser-provided JWT in this mode.
      setToken(null);
      setAccount(a);
      return;
    }
    qc.clear(); // clear all cached data from previous user
    localStorage.setItem('token', t);
    localStorage.setItem('account', JSON.stringify(a));
    setToken(t); setAccount(a);
  }, [qc]);

  const logout = useCallback(() => {
    qc.clear(); // clear all cached data on logout
    if (isLocalProductionMode) {
      setToken(null);
      setAccount(null);
      void stopLocalProductionSession().catch(() => {
        // Closing the terminal still triggers the launcher's finally/revoke path.
      });
      return;
    }
    localStorage.removeItem('token');
    localStorage.removeItem('account');
    setToken(null); setAccount(null);
  }, [qc]);

  return <Ctx.Provider value={{ account, token, login, logout, loading }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
