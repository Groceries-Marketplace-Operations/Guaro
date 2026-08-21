import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useLang, useT } from '../../i18n';
import ThemeSelector from '../ui/ThemeSelector';
import { useSidebar } from './SidebarContext';

interface Props {
  breadcrumb?: { label: string; href?: string }[];
}

export default function Topbar({ breadcrumb = [] }: Props) {
  const { account } = useAuth();
  const { lang, setLang } = useLang();
  const t = useT();
  const sidebar = useSidebar();
  const initials = account?.name?.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase() ?? 'U';
  const topRole = account?.roles?.[0] ?? 'user';
  const sidebarLabel = sidebar.isMobile
    ? sidebar.mobileOpen ? t('nav.closeSidebar') : t('nav.openSidebar')
    : sidebar.desktopCollapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar');

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          id="sidebar-menu-button"
          type="button"
          className="sidebar-menu-button"
          aria-controls="app-sidebar"
          aria-expanded={sidebar.expanded}
          aria-label={sidebarLabel}
          title={sidebarLabel}
          onClick={sidebar.toggleSidebar}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
          </svg>
        </button>
        <nav className="breadcrumb">
          <span className="bc-root">Tequila 1.0</span>
          {breadcrumb.map((b, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="bc-sep">/</span>
              {i === breadcrumb.length - 1
                ? <span className="bc-current">{b.label}</span>
                : <Link to={b.href ?? '/'} className="bc-root" style={{ color: 'var(--text-muted)' }}>{b.label}</Link>}
            </span>
          ))}
        </nav>
      </div>

      <div className="topbar-right">
        <ThemeSelector compact />
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
