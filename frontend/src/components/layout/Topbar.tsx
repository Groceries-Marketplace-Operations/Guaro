import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useLang } from '../../i18n';

interface Props {
  breadcrumb?: { label: string; href?: string }[];
}

export default function Topbar({ breadcrumb = [] }: Props) {
  const { account } = useAuth();
  const { lang, setLang } = useLang();
  const initials = account?.name?.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase() ?? 'U';
  const topRole = account?.roles?.[0] ?? 'user';

  return (
    <header className="topbar">
      <nav className="breadcrumb">
        <span className="bc-root">Guaro</span>
        {breadcrumb.map((b, i) => (
          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="bc-sep">/</span>
            {i === breadcrumb.length - 1
              ? <span className="bc-current">{b.label}</span>
              : <Link to={b.href ?? '/'} className="bc-root" style={{ color: 'var(--text-muted)' }}>{b.label}</Link>}
          </span>
        ))}
      </nav>

      <div className="topbar-right">
        <button
          onClick={() => setLang(lang === 'en' ? 'es' : 'en')}
          className="btn btn-ghost btn-sm"
          style={{ fontWeight: 600, fontSize: '0.75rem', letterSpacing: '0.04em', padding: '3px 10px' }}
        >
          {lang === 'en' ? 'ES' : 'EN'}
        </button>
        <span className={`role-badge ${topRole}`}>{topRole.replace('_', ' ')}</span>
        <div className="avatar" title={account?.name}>{initials}</div>
      </div>
    </header>
  );
}
