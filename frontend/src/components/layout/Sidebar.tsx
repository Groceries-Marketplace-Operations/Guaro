import { NavLink } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import type { AccountRole } from '../../types';

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
const IconShop = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
    <polyline points="9 22 9 12 15 12 15 22"/>
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

function hasAny(roles: AccountRole[], ...check: AccountRole[]) {
  return check.some((r) => roles.includes(r));
}

export default function Sidebar() {
  const { account, logout } = useAuth();
  const roles = account?.roles ?? [];

  const isAdmin    = hasAny(roles, 'admin', 'super_admin');
  const isBpo      = hasAny(roles, 'bpo');
  const isSA       = roles.includes('super_admin');
  const isDirector = roles.includes('director');
  const canCreate  = !isDirector && !(isBpo && !isAdmin);
  const adminMods  = account?.adminModules ?? [];
  const canSeeModule = (mod: string) => isSA || adminMods.includes(mod);

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="logo-mark">D</div>
        <div className="logo-text">
          <span className="lt-name">DiDi Ops</span>
          <span className="lt-sub">Internal Panel</span>
        </div>
      </div>

      {canCreate && (
        <div style={{ padding: '12px 12px 0' }}>
          <NavLink
            to="/tasks/new"
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center', gap: 6, textDecoration: 'none' }}
          >
            <IconPlus /> New Task
          </NavLink>
        </div>
      )}

      <div className="sidebar-section">
        <div className="sidebar-section-label">Overview</div>
        <NavLink to="/" end className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <IconGrid /> Dashboard
        </NavLink>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-label">Catalog</div>
        <NavLink to="/brands" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <IconTag /> Brands
        </NavLink>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-label">Tasks</div>
        <NavLink to="/tasks" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <IconClipboard /> Tasks
        </NavLink>
        {isAdmin && (
          <NavLink to="/task-types" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconLayers /> Task Types
          </NavLink>
        )}
      </div>

      {isBpo && (
        <div className="sidebar-section">
          <div className="sidebar-section-label">BPO</div>
          <NavLink to="/bpo" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconBriefcase /> My Queue
          </NavLink>
          {canSeeModule('create_application') && (
            <NavLink to="/applications" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <IconApp /> Applications
            </NavLink>
          )}
        </div>
      )}

      {isAdmin && (
        <div className="sidebar-section">
          <div className="sidebar-section-label">Admin</div>
          {canSeeModule('applications') && (
            <NavLink to="/applications" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <IconApp /> Applications
            </NavLink>
          )}
          {canSeeModule('bpo_team') && (
            <NavLink to="/bpo-management" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <IconBriefcase /> BPO Team
            </NavLink>
          )}
          {isSA && (
            <NavLink to="/sections" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <IconUsers /> Sections
            </NavLink>
          )}
          <NavLink to="/config" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <IconSettings /> Config
          </NavLink>
          {isSA && (
            <NavLink to="/settings" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <IconGrid /> Settings
            </NavLink>
          )}
        </div>
      )}

      <div className="sidebar-footer">
        <button className="nav-item w-full" style={{ background: 'none', border: 'none', cursor: 'pointer', width: '100%', color: 'var(--sidebar-text)' }} onClick={logout}>
          <IconLogOut />
          <span>Sign out</span>
        </button>
      </div>
    </aside>
  );
}
