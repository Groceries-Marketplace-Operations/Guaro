import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { Account } from '../types';
import { authApi } from '../api';

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

  useEffect(() => {
    const stored = localStorage.getItem('token');
    if (!stored) { setLoading(false); return; }
    authApi.me()
      .then((r) => { setToken(stored); setAccount(r.data); })
      .catch(() => { localStorage.removeItem('token'); localStorage.removeItem('account'); })
      .finally(() => setLoading(false));
  }, []);

  const login = (t: string, a: Account) => {
    localStorage.setItem('token', t);
    localStorage.setItem('account', JSON.stringify(a));
    setToken(t); setAccount(a);
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('account');
    setToken(null); setAccount(null);
  };

  return <Ctx.Provider value={{ account, token, login, logout, loading }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
