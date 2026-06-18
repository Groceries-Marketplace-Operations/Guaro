import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import Topbar from '../components/layout/Topbar';
import { useAuth } from '../auth/AuthContext';
import { useT } from '../i18n';
import { brandsApi, tasksApi, shopsApi } from '../api';
import StatusBadge from '../components/ui/StatusBadge';
import type { Task, Paginated } from '../types';

export default function Dashboard() {
  const nav = useNavigate();
  const { account } = useAuth();
  const t = useT();
  const firstName = account?.name?.split(' ')[0] ?? 'there';
  const isBpo = account?.roles.includes('bpo') && !account?.roles.includes('admin') && !account?.roles.includes('super_admin');

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
      <Topbar breadcrumb={[{ label: t('nav.dashboard') }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{t('pages.dashboard.hello', { name: firstName })}</h1>
            <p>{isBpo ? t('pages.dashboard.subtitleBpo') : t('pages.dashboard.subtitleDefault')}</p>
          </div>
        </div>

        <div className="stat-grid">
          <div className="stat-card orange-accent">
            <div className="s-label">{isBpo ? t('pages.dashboard.myBrands') : t('pages.dashboard.brands')}</div>
            <div className="s-value">{totalBrands ?? '—'}</div>
            <div className="s-meta">{isBpo ? t('pages.dashboard.brandsOwned') : t('pages.dashboard.activeBrands')}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">{t('pages.dashboard.shops')}</div>
            <div className="s-value">{totalShops ?? '—'}</div>
            <div className="s-meta">{t('pages.dashboard.allStores')}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">{t('pages.dashboard.inProgress')}</div>
            <div className="s-value" style={{ color: 'var(--amber)' }}>{totalInProgress ?? '—'}</div>
            <div className="s-meta">{t('pages.dashboard.activeTasks')}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">{t('pages.dashboard.failed')}</div>
            <div className="s-value" style={{ color: 'var(--red)' }}>{totalFailed ?? '—'}</div>
            <div className="s-meta">{t('pages.dashboard.requireAttention')}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">{t('pages.dashboard.completed')}</div>
            <div className="s-value" style={{ color: 'var(--green)' }}>{totalDone ?? '—'}</div>
            <div className="s-meta">{t('pages.dashboard.totalTasksDone')}</div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">{t('pages.dashboard.recentTasks')}</span>
            <Link to="/tasks" className="btn btn-ghost btn-sm">{t('pages.dashboard.viewAll')}</Link>
          </div>
          {recent.length === 0 ? (
            <div className="empty-state">
              <p>{t('pages.dashboard.noTasksYet')}</p>
            </div>
          ) : (
            <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th>{t('pages.dashboard.colBrand')}</th>
                    <th>{t('pages.dashboard.colTaskType')}</th>
                    <th>{t('pages.dashboard.colStatus')}</th>
                    <th>{t('pages.dashboard.colCreated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((t2) => (
                    <tr key={t2.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/tasks/${t2.id}`)}>
                      <td style={{ fontWeight: 600 }}>{t2.brand?.brandName ?? '—'}</td>
                      <td className="text-muted">{t2.taskType?.name ?? '—'}</td>
                      <td><StatusBadge status={t2.status} /></td>
                      <td className="text-muted text-sm">{new Date(t2.createdAt).toLocaleDateString()}</td>
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
