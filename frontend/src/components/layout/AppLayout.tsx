import { useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import Sidebar from './Sidebar';
import NaranjaMascot from '../mascot/NaranjaMascot';
import { SidebarContext } from './SidebarContext';
import { useT } from '../../i18n';

const MOBILE_QUERY = '(max-width: 760px)';

function readCollapsedPreference(accountId?: string) {
  if (!accountId) return false;
  try {
    return window.localStorage.getItem(`guaro.ui.sidebar.collapsed.v1:${accountId}`) === 'true';
  } catch {
    return false;
  }
}

export default function AppLayout() {
  const { account } = useAuth();
  const location = useLocation();
  const t = useT();
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  const accountPreference = useMemo(
    () => readCollapsedPreference(account?.id),
    [account?.id],
  );
  const [collapseState, setCollapseState] = useState(() => ({
    accountId: account?.id,
    collapsed: readCollapsedPreference(account?.id),
  }));
  const desktopCollapsed = collapseState.accountId === account?.id
    ? collapseState.collapsed
    : accountPreference;
  const [mobileState, setMobileState] = useState(() => ({
    pathname: location.pathname,
    open: false,
  }));
  const mobileOpen = mobileState.pathname === location.pathname && mobileState.open;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setMobileState({ pathname: location.pathname, open: false });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.key, location.pathname]);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const sync = () => {
      setIsMobile(media.matches);
      if (!media.matches) {
        setMobileState(current => ({ ...current, open: false }));
      }
    };
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!account?.id || collapseState.accountId !== account.id) return;
    try {
      window.localStorage.setItem(
        `guaro.ui.sidebar.collapsed.v1:${account.id}`,
        String(collapseState.collapsed),
      );
    } catch {
      // The sidebar still works when browser storage is unavailable.
    }
  }, [account?.id, collapseState]);

  const closeMobileSidebar = useCallback(() => {
    setMobileState({ pathname: location.pathname, open: false });
  }, [location.pathname]);
  const toggleSidebar = useCallback(() => {
    if (isMobile) {
      setMobileState(current => ({
        pathname: location.pathname,
        open: current.pathname === location.pathname ? !current.open : true,
      }));
      return;
    }
    setCollapseState({ accountId: account?.id, collapsed: !desktopCollapsed });
  }, [account?.id, desktopCollapsed, isMobile, location.pathname]);

  useEffect(() => {
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return;
    sidebar.inert = isMobile && !mobileOpen;
    if (!isMobile || !mobileOpen) return;

    const shell = sidebar.parentElement;
    const background = Array.from(shell?.children ?? []).filter(
      (element): element is HTMLElement => element instanceof HTMLElement
        && element !== sidebar
        && !element.classList.contains('sidebar-backdrop'),
    );
    const previousInert = background.map(element => element.inert);
    background.forEach(element => { element.inert = true; });
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = () => Array.from(sidebar?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
    const focusFrame = window.requestAnimationFrame(() => focusable()[0]?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMobileSidebar();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (!elements.length) return;
      const current = elements.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? current <= 0 ? elements.length - 1 : current - 1
        : current === elements.length - 1 ? 0 : current + 1;
      event.preventDefault();
      elements[next]?.focus();
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      background.forEach((element, index) => { element.inert = previousInert[index]; });
      const trigger = document.getElementById('sidebar-menu-button');
      window.requestAnimationFrame(() => {
        (trigger instanceof HTMLElement ? trigger : previousFocus)?.focus();
      });
    };
  }, [closeMobileSidebar, isMobile, mobileOpen]);

  const sidebarContext = useMemo(() => ({
    isMobile,
    desktopCollapsed,
    mobileOpen,
    expanded: isMobile ? mobileOpen : !desktopCollapsed,
    toggleSidebar,
    closeMobileSidebar,
  }), [closeMobileSidebar, desktopCollapsed, isMobile, mobileOpen, toggleSidebar]);

  return (
    <SidebarContext.Provider value={sidebarContext}>
      <div className={`app-shell${desktopCollapsed ? ' is-sidebar-collapsed' : ''}${mobileOpen ? ' is-sidebar-mobile-open' : ''}`}>
        <Sidebar />
        {isMobile && mobileOpen && (
          <button
            type="button"
            className="sidebar-backdrop"
            aria-label={t('nav.closeSidebar')}
            onClick={closeMobileSidebar}
          />
        )}
        <Outlet />
        <NaranjaMascot />
      </div>
    </SidebarContext.Provider>
  );
}
