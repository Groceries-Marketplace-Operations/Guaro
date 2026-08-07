import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import NaranjaMascot from '../mascot/NaranjaMascot';

export default function AppLayout() {
  return (
    <div className="app-shell">
      <Sidebar />
      <Outlet />
      <NaranjaMascot />
    </div>
  );
}
