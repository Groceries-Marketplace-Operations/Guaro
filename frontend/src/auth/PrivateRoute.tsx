import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

export default function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { account, loading } = useAuth();
  if (loading) return <div style={{ padding: '40px', color: 'var(--text-muted)' }}>Loading…</div>;
  if (!account) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
