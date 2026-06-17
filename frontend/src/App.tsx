import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './auth/AuthContext';
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

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } });

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <BrowserRouter basename="/guaro">
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/invite/:token" element={<InvitePage />} />
            <Route path="/" element={<PrivateRoute><AppLayout /></PrivateRoute>}>
              <Route index element={<Dashboard />} />
              <Route path="brands" element={<BrandsList />} />
              <Route path="brands/:id" element={<BrandDetail />} />
              <Route path="shops" element={<ShopsList />} />
              <Route path="tasks" element={<TasksList />} />
              <Route path="tasks/new" element={<NewTaskPage />} />
              <Route path="tasks/:id" element={<TaskDetail />} />
              <Route path="task-types" element={<TaskTypesList />} />
              <Route path="task-types/:id" element={<TaskTypeDetail />} />
              <Route path="bpo" element={<BpoQueue />} />
              <Route path="bpo-management" element={<BpoManagement />} />
              <Route path="sections" element={<SectionsList />} />
              <Route path="config" element={<Config />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="applications" element={<ApplicationsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
