import { Link } from 'react-router-dom';
import Topbar from '../components/layout/Topbar';

export default function AccessDenied() {
  return <>
    <Topbar breadcrumb={[{ label: 'Acceso restringido' }]} />
    <main className="main-content">
      <div className="empty-state card" style={{ padding: 42 }}>
        <h2>Tu rol no tiene acceso a esta sección</h2>
        <p>Un Super Admin puede habilitarla desde Roles y permisos.</p>
        <Link to="/" className="btn btn-primary" style={{ marginTop: 14, textDecoration: 'none' }}>Volver al inicio</Link>
      </div>
    </main>
  </>;
}
