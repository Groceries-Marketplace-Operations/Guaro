import { createContext, useContext } from 'react';

export type SidebarContextValue = {
  isMobile: boolean;
  desktopCollapsed: boolean;
  mobileOpen: boolean;
  expanded: boolean;
  toggleSidebar: () => void;
  closeMobileSidebar: () => void;
};

export const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) throw new Error('useSidebar must be used inside AppLayout');
  return context;
}
