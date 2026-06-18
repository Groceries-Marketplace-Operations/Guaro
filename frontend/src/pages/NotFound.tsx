import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: 24,
    }}>
      <div style={{
        width: '100%', maxWidth: 420,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', padding: 40,
        textAlign: 'center',
      }}>
        <div style={{
          fontSize: '3rem', fontWeight: 800, letterSpacing: '-0.04em',
          color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1,
        }}>
          404
        </div>
        <h2 style={{ marginBottom: 10 }}>Page not found</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', lineHeight: 1.6, marginBottom: 28 }}>
          The page you're looking for doesn't exist or has been moved.
        </p>
        <Link to="/" className="btn btn-primary" style={{ textDecoration: 'none' }}>
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
