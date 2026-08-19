import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './auth/AuthContext';
import { LangProvider } from './i18n';
import PrivateRoute from './auth/PrivateRoute';
import AppLayout from './components/layout/AppLayout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import BrandsList from './pages/brands/BrandsList';
import BrandDetail from './pages/brands/BrandDetail';
import ShopsList from './pages/shops/ShopsList';
import TasksList from './pages/tasks/TasksList';
import TaskDetail from './pages/tasks/TaskDetail';
import NewTaskPage from './pages/tasks/NewTaskPage';
import TaskTypesList from './pages/task-types/TaskTypesList';
import TaskTypeDetail from './pages/task-types/TaskTypeDetail';
import BpoQueue from './pages/bpo/BpoQueue';
import BpoManagement from './pages/bpo/BpoManagement';
import SectionsList from './pages/sections/SectionsList';
import Config from './pages/Config';
import SettingsPage from './pages/settings/SettingsPage';
import ApplicationsPage from './pages/ApplicationsPage';
import InvitePage from './pages/InvitePage';
import AuthCallback from './pages/AuthCallback';
import AuthError from './pages/AuthError';
import NotFound from './pages/NotFound';
import AutoTurnOffItemsPage from './pages/integrations/AutoTurnOffItemsPage';
import AdminPanel from './pages/admin/AdminPanel';
import AutoFetchPage from './pages/integrations/AutoFetchPage';
import StoreEmergenciesPage from './pages/integrations/StoreEmergenciesPage';
import SftpApplicationsPage from './pages/admin/SftpApplicationsPage';
import ForcedOpenStoresPage from './pages/integrations/ForcedOpenStoresPage';
import IntegrationsPage from './pages/integrations/IntegrationsPage';
import FileIntegrationsPage from './pages/integrations/FileIntegrationsPage';
import PromotionApiPage from './pages/integrations/PromotionApiPage';
import PermissionRoute from './auth/PermissionRoute';
import { useAuth } from './auth/AuthContext';
import { hasPermission } from './auth/permissions';
import AccessDenied from './pages/AccessDenied';
import RoleAccessPage from './pages/admin/RoleAccessPage';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } });

const protectedPage = (permission: string | string[], page: React.ReactNode) => <PermissionRoute permission={permission}>{page}</PermissionRoute>;

function HomeRoute() {
  const { account } = useAuth();
  if (hasPermission(account, 'dashboard.view')) return <Dashboard />;
  const first = [
    ['brands.view', '/brands'], ['tasks.view', '/tasks'], ['bpo.queue', '/bpo'],
    ['applications.manage', '/applications'], ['integrations.custom', '/integrations/custom'],
  ].find(([permission]) => hasPermission(account, permission));
  return first ? <Navigate to={first[1]} replace /> : <AccessDenied />;
}

function SuperAdminOnly({ children }: { children: React.ReactNode }) {
  const { account } = useAuth();
  return account?.roles.includes('super_admin') ? <>{children}</> : <Navigate to="/access-denied" replace />;
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <LangProvider>
      <AuthProvider>
        <BrowserRouter basename="/guaro">
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/auth/error" element={<AuthError />} />
            <Route path="/invite/:token" element={<InvitePage />} />
            <Route path="*" element={<NotFound />} />
            <Route path="/" element={<PrivateRoute><AppLayout /></PrivateRoute>}>
              <Route index element={<HomeRoute />} />
              <Route path="brands" element={protectedPage('brands.view', <BrandsList />)} />
              <Route path="brands/:id" element={protectedPage('brands.view', <BrandDetail />)} />
              <Route path="shops" element={protectedPage('brands.view', <ShopsList />)} />
              <Route path="tasks" element={protectedPage('tasks.view', <TasksList />)} />
              <Route path="tasks/new" element={protectedPage('tasks.create', <NewTaskPage />)} />
              <Route path="tasks/:id" element={protectedPage('tasks.view', <TaskDetail />)} />
              <Route path="task-types" element={protectedPage('task_types.manage', <TaskTypesList />)} />
              <Route path="task-types/:id" element={protectedPage('task_types.manage', <TaskTypeDetail />)} />
              <Route path="bpo" element={protectedPage('bpo.queue', <BpoQueue />)} />
              <Route path="bpo-management" element={protectedPage('bpo.team', <BpoManagement />)} />
              <Route path="sections" element={protectedPage('sections.manage', <SectionsList />)} />
              <Route path="role-access" element={<SuperAdminOnly><RoleAccessPage /></SuperAdminOnly>} />
              <Route path="config" element={protectedPage(['config.users', 'config.invitations', 'config.handlers', 'config.webhooks'], <Config />)} />
              <Route path="settings" element={protectedPage('settings.manage', <SettingsPage />)} />
              <Route path="applications" element={protectedPage('applications.manage', <ApplicationsPage />)} />
              <Route path="integrations/auto-open" element={protectedPage('integrations.forced_open', <IntegrationsPage />)} />
              <Route path="integrations/forced-open" element={protectedPage('integrations.forced_open', <ForcedOpenStoresPage />)} />
              <Route path="integrations/auto-turn-off" element={protectedPage('integrations.auto_turn_off', <AutoTurnOffItemsPage />)} />
              <Route path="integrations/auto-stores-fetch" element={protectedPage('integrations.auto_stores_fetch', <AutoFetchPage kind="stores" />)} />
              <Route path="integrations/auto-menu-fetch" element={protectedPage('integrations.auto_menu_fetch', <AutoFetchPage kind="menu" />)} />
              <Route path="integrations/emergencies" element={protectedPage('integrations.emergencies', <StoreEmergenciesPage />)} />
              <Route path="integrations/complex-promotions-sftp" element={protectedPage('integrations.promotions_sftp', <FileIntegrationsPage kind="complex_promotion_reader" />)} />
              <Route path="integrations/custom" element={protectedPage('integrations.custom', <FileIntegrationsPage kind="price_filter" />)} />
              <Route path="integrations/promotion-api" element={protectedPage('integrations.promotion_api', <PromotionApiPage />)} />
              <Route path="sftp-applications" element={protectedPage('sftp_applications.manage', <SftpApplicationsPage />)} />
              <Route path="admin" element={protectedPage('system.manage', <AdminPanel />)} />
              <Route path="access-denied" element={<AccessDenied />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
      </LangProvider>
    </QueryClientProvider>
  );
}
