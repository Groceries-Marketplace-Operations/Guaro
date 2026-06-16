import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { authApi } from '../api';

export default function AuthCallback() {
  const [params] = useSearchParams();
  const { login } = useAuth();
  const nav = useNavigate();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const token = params.get('token');
    if (!token) { nav('/login', { replace: true }); return; }

    // Put token in localStorage temporarily so the axios interceptor sends it
    localStorage.setItem('token', token);
    authApi.me()
      .then((r) => {
        login(token, r.data);
        nav('/', { replace: true });
      })
      .catch(() => {
        localStorage.removeItem('token');
        nav('/login', { replace: true });
      });
  }, []);

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-muted)' }}>
      Signing you in…
    </div>
  );
}
