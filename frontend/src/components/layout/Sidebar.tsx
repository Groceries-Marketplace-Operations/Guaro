import { NavLink } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useT } from '../../i18n';
import { hasAnyPermission, hasPermission } from '../../auth/permissions';
import { useStoreOnboardingFeature } from '../../pages/integrations/useStoreOnboardingFeature';

const IconGrid = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
    <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
  </svg>
);
const IconTag = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
    <line x1="7" y1="7" x2="7.01" y2="7"/>
  </svg>
);
const IconBriefcase = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
  </svg>
);

const IconClipboard = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
    <rect x="9" y="3" width="6" height="4" rx="1"/>
    <line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="12" y2="16"/>
  </svg>
);
const IconUsers = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
);
const IconSettings = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
);
const IconLayers = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 2 7 12 12 22 7 12 2"/>
    <polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>
  </svg>
);
const IconApp = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="7" height="7" rx="1"/><rect x="15" y="3" width="7" height="7" rx="1"/>
    <rect x="2" y="14" width="7" height="7" rx="1"/><rect x="15" y="14" width="7" height="7" rx="1"/>
  </svg>
);
const IconTerminal = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
  </svg>
);
const IconLogOut = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
    <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
  </svg>
);
const IconPlus = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);

export default function Sidebar() {
  const { account, logout } = useAuth();
  const t = useT();
  const roles = account?.roles ?? [];

  const isSA       = roles.includes('super_admin');
  const isDirector = roles.includes('director');
  const can = (permission: string) => hasPermission(account, permission);
  const isStoreOnboardingOperator = roles.some(role => ['user', 'bpo', 'director', 'admin', 'super_admin'].includes(role));
  const canManageStoreOnboarding = can('system.manage');
  const onboardingFeature = useStoreOnboardingFeature(isStoreOnboardingOperator || canManageStoreOnboarding);
  const showStoreOnboarding = canManageStoreOnboarding || (isStoreOnboardingOperator && onboardingFeature.globalEnabled);
  const integrationPermissions = [
    'integrations.forced_open', 'integrations.auto_stores_fetch', 'integrations.auto_menu_fetch',
    'integrations.auto_turn_off', 'integrations.emergencies', 'integrations.promotions_sftp',
    'integrations.custom', 'integrations.promotion_api',
  ];
  const configPermissions = ['config.handlers', 'config.webhooks', 'config.invitations', 'config.users'];
  const canCreate = can('tasks.create') && !isDirector;
  const showAdmin = hasAnyPermission(account, [
    'applications.manage', 'sftp_applications.manage', 'bpo.team', 'sections.manage',
    'settings.manage', 'system.manage', ...configPermissions,
  ]);

  return (
    <aside className="sidebar" id="app-sidebar">
      <div className="sidebar-logo">
        <img src={`${import.meta.env.BASE_URL}didi-logo.png`} alt="DiDi" style={{ width: 32, height: 32, objectFit: 'contain', borderRadius: 6 }} />
        <div className="logo-text">
          <span className="lt-name">Tequila 1.0</span>
        </div>
      </div>

      {canCreate && (
        <div style={{ padding: '12px 12px 0' }}>
          <NavLink
            to="/tasks/new"
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center', gap: 6, textDecoration: 'none' }}
          >
            <IconPlus /> {t('nav.newTask')}
          </NavLink>
        </div>
      )}

      <nav className="sidebar-scroll" aria-label={t('nav.mainNavigation')}>
        {can('dashboard.view') && <div className="sidebar-section">
        <div className="sidebar-section-label">{t('nav.overview')}</div>
        <NavLink to="/" end className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <IconGrid /> {t('nav.dashboard')}
        </NavLink>
        </div>}

        {can('brands.view') && <div className="sidebar-section">
        <div className="sidebar-section-label">{t('nav.catalog')}</div>
        <NavLink to="/brands" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <IconTag /> {t('nav.brands')}
        </NavLink>
        </div>}

        {(can('tasks.view') || can('task_types.manage')) && <div className="sidebar-section">
        <div className="sidebar-section-label">{t('nav.tasks')}</div>
        {can('tasks.view') && <NavLink to="/tasks" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <IconClipboard /> {t('nav.tasks')}
        </NavLink>}
        {can('task_types.manage') && (
          <NavLink to="/task-types" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconLayers /> {t('nav.taskTypes')}
          </NavLink>
        )}
        </div>}

      {can('bpo.queue') && (
        <div className="sidebar-section">
          <div className="sidebar-section-label">{t('nav.bpo')}</div>
          <NavLink to="/bpo" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconBriefcase /> {t('nav.myQueue')}
          </NavLink>
        </div>
      )}

      {(hasAnyPermission(account, integrationPermissions) || showStoreOnboarding) && (
        <div className="sidebar-section">
          <div className="sidebar-section-label">{t('nav.integrations')}</div>
          {can('integrations.forced_open') && <NavLink to="/integrations/auto-open" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconBriefcase /> {t('nav.autoOpenStores')}
          </NavLink>}
          {can('integrations.forced_open') && <NavLink to="/integrations/forced-open" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconBriefcase /> {t('nav.forcedOpenStores')}
          </NavLink>}
          {can('integrations.auto_stores_fetch') && <NavLink to="/integrations/auto-stores-fetch" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconBriefcase /> Auto Stores Fetch
          </NavLink>}
          {can('integrations.auto_menu_fetch') && <NavLink to="/integrations/auto-menu-fetch" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconLayers /> Auto Menu Fetch
          </NavLink>}
          {can('integrations.auto_turn_off') && <NavLink to="/integrations/auto-turn-off" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconBriefcase /> {t('nav.autoTurnOffItems')}
          </NavLink>}
          {can('integrations.emergencies') && <NavLink to="/integrations/emergencies" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconBriefcase /> Emergencias
          </NavLink>}
          {can('integrations.promotions_sftp') && <NavLink to="/integrations/complex-promotions-sftp" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconLayers /> Promociones SFTP
          </NavLink>}
          {can('integrations.custom') && <NavLink to="/integrations/custom" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconSettings /> Custom integrations
          </NavLink>}
          {can('integrations.promotion_api') && <NavLink to="/integrations/promotion-api" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconApp /> Promociones API
          </NavLink>}
          {showStoreOnboarding && <NavLink to="/integrations/store-onboarding" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconClipboard /> <span>Store Onboarding</span>
            {canManageStoreOnboarding && !onboardingFeature.globalEnabled && <span aria-label="Store Onboarding desactivado" style={{ marginLeft: 'auto', padding: '2px 6px', borderRadius: 999, color: '#b42318', background: '#fff1f2', fontSize: '.58rem', fontWeight: 800 }}>OFF</span>}
          </NavLink>}
        </div>
      )}

      {showAdmin && (
        <div className="sidebar-section">
          <div className="sidebar-section-label">{t('nav.admin')}</div>
          {can('applications.manage') && (
            <NavLink to="/applications" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <IconApp /> {t('nav.applications')}
            </NavLink>
          )}
          {can('sftp_applications.manage') && <NavLink to="/sftp-applications" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconApp /> Aplicaciones SFTP
          </NavLink>}
          {can('bpo.team') && (
            <NavLink to="/bpo-management" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <IconBriefcase /> {t('nav.bpoTeam')}
            </NavLink>
          )}
          {can('sections.manage') && (
            <NavLink to="/sections" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <IconUsers /> {t('nav.sections')}
            </NavLink>
          )}
          {hasAnyPermission(account, configPermissions) && <NavLink to="/config" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconSettings /> {t('nav.config')}
          </NavLink>}
          {isSA && <NavLink to="/role-access" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconUsers /> Roles y permisos
          </NavLink>}
          {can('settings.manage') && (
            <NavLink to="/settings" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <IconGrid /> {t('nav.settings')}
            </NavLink>
          )}
          {can('system.manage') && (
            <NavLink to="/admin" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <IconTerminal /> {t('nav.systemPanel')}
            </NavLink>
          )}
        </div>
      )}
      </nav>

      <div className="sidebar-footer">
        <button className="nav-item w-full" style={{ background: 'none', border: 'none', cursor: 'pointer', width: '100%', color: 'var(--sidebar-text)' }} onClick={logout}>
          <IconLogOut />
          <span>{t('nav.signOut')}</span>
        </button>
      </div>
    </aside>
  );
}
