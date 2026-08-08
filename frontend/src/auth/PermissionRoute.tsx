import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { hasAnyPermission } from './permissions';

export default function PermissionRoute({ permission, children }: { permission: string | string[]; children: React.ReactNode }) {
  const { account } = useAuth();
  const required = Array.isArray(permission) ? permission : [permission];
  if (!hasAnyPermission(account, required)) return <Navigate to="/access-denied" replace />;
  return <>{children}</>;
}
