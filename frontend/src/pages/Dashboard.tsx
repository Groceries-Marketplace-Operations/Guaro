import { useQuery } from '@tanstack/react-query';
import Topbar from '../components/layout/Topbar';
import { useAuth } from '../auth/AuthContext';
import { brandsApi, tasksApi, shopsApi } from '../api';
import StatusBadge from '../components/ui/StatusBadge';
import type { Task, Paginated } from '../types';

export default function Dashboard() {
  const { account } = useAuth();
  const firstName = account?.name?.split(' ')[0] ?? 'there';
  const isBpo = account?.roles.includes('bpo') && !account?.roles.includes('admin') && !account?.roles.includes('super_admin');

  // BPO sees only their brands; everyone else sees all
  const brandParams = isBpo ? { limit: 1, myBrands: true } : { limit: 1 };

  const { data: totalBrands }     = useQuery({ queryKey: ['brands', brandParams],                                queryFn: () => brandsApi.list(brandParams).then(r => (r.data as Paginated<unknown>).total) });
  const { data: totalShops }      = useQuery({ queryKey: ['shops',  { limit: 1 }],                               queryFn: () => shopsApi.list({ limit: 1 }).then(r => (r.data as Paginated<unknown>).total) });
  const { data: totalInProgress } = useQuery({ queryKey: ['tasks',  { limit: 1, status: 'in_progress' }],        queryFn: () => tasksApi.list({ limit: 1, status: 'in_progress' }).then(r => (r.data as Paginated<unknown>).total) });
  const { data: totalFailed }     = useQuery({ queryKey: ['tasks',  { limit: 1, status: 'failed' }],             queryFn: () => tasksApi.list({ limit: 1, status: 'failed' }).then(r => (r.data as Paginated<unknown>).total) });
  const { data: totalDone }       = useQuery({ queryKey: ['tasks',  { limit: 1, status: 'done' }],               queryFn: () => tasksApi.list({ limit: 1, status: 'done' }).then(r => (r.data as Paginated<unknown>).total) });
  const { data: recentResult }    = useQuery({ queryKey: ['tasks',  { limit: 8 }],                               queryFn: () => tasksApi.list({ limit: 8 }).then(r => r.data as Paginated<Task>) });

  const recent = recentResult?.data ?? [];

  return (
    <>
      <Topbar breadcrumb={[{ label: 'Dashboard' }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>Hello, {firstName}</h1>
            <p>{isBpo ? "Your queue and assigned brands." : "Here's what's happening across all operations today."}</p>
          </div>
        </div>

        <div className="stat-grid">
          <div className="stat-card orange-accent">
            <div className="s-label">{isBpo ? 'My Brands' : 'Brands'}</div>
            <div className="s-value">{totalBrands ?? '—'}</div>
            <div className="s-meta">{isBpo ? 'brands you own' : 'active brands'}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">Shops</div>
            <div className="s-value">{totalShops ?? '—'}</div>
            <div className="s-meta">all stores</div>
          </div>
          <div className="stat-card">
            <div className="s-label">In Progress</div>
            <div className="s-value" style={{ color: 'var(--amber)' }}>{totalInProgress ?? '—'}</div>
            <div className="s-meta">active tasks</div>
          </div>
          <div className="stat-card">
            <div className="s-label">Failed</div>
            <div className="s-value" style={{ color: 'var(--red)' }}>{totalFailed ?? '—'}</div>
            <div className="s-meta">require attention</div>
          </div>
          <div className="stat-card">
            <div className="s-label">Completed</div>
            <div className="s-value" style={{ color: 'var(--green)' }}>{totalDone ?? '—'}</div>
            <div className="s-meta">total tasks done</div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Recent Tasks</span>
            <a href="/tasks" className="btn btn-ghost btn-sm">View all</a>
          </div>
          {recent.length === 0 ? (
            <div className="empty-state">
              <p>No tasks yet.</p>
            </div>
          ) : (
            <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th>Brand</th>
                    <th>Task Type</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((t) => (
                    <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => window.location.href = `/tasks/${t.id}`}>
                      <td style={{ fontWeight: 600 }}>{t.brand?.brandName ?? '—'}</td>
                      <td className="text-muted">{t.taskType?.name ?? '—'}</td>
                      <td><StatusBadge status={t.status} /></td>
                      <td className="text-muted text-sm">{new Date(t.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
