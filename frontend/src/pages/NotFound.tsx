import { Link } from 'react-router-dom';
import { useT } from '../i18n';

export default function NotFound() {
  const t = useT();
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
        <h2 style={{ marginBottom: 10 }}>{t('pages.notFound.title')}</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', lineHeight: 1.6, marginBottom: 28 }}>
          {t('pages.notFound.body')}
        </p>
        <Link to="/" className="btn btn-primary" style={{ textDecoration: 'none' }}>
          {t('pages.notFound.backToDashboard')}
        </Link>
      </div>
    </div>
  );
}
