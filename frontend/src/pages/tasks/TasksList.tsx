import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import Paginator from '../../components/ui/Paginator';
import StatusBadge from '../../components/ui/StatusBadge';
import { tasksApi } from '../../api';
import { useT } from '../../i18n';
import type { Task, TaskStatus, Paginated } from '../../types';

const LIMIT = 25;

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);

export default function TasksList() {
  const nav = useNavigate();
  const t = useT();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(1);
  const [statusF, setStatusF] = useState<TaskStatus | ''>('');

  const STATUSES: { value: TaskStatus | ''; labelKey: string }[] = [
    { value: '', labelKey: 'pages.tasksList.statusAll' },
    { value: 'scheduled', labelKey: 'pages.tasksList.statusScheduled' },
    { value: 'pending', labelKey: 'pages.tasksList.statusPending' },
    { value: 'assigned', labelKey: 'pages.tasksList.statusAssigned' },
    { value: 'in_progress', labelKey: 'pages.tasksList.statusInProgress' },
    { value: 'blocked', labelKey: 'pages.tasksList.statusBlocked' },
    { value: 'failed', labelKey: 'pages.tasksList.statusFailed' },
    { value: 'done', labelKey: 'pages.tasksList.statusDone' },
  ];

  useEffect(() => {
    const timer = setTimeout(() => { setDq(q); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  const params = {
    page, limit: LIMIT,
    ...(dq      && { q: dq }),
    ...(statusF && { status: statusF }),
  };

  const { data: result, isLoading } = useQuery<Paginated<Task>>({
    queryKey: ['tasks', params],
    queryFn: () => tasksApi.list(params).then(r => r.data as Paginated<Task>),
  });

  const tasks = result?.data ?? [];
  const total = result?.total ?? 0;

  const activeStepFor = (tk: Task) => {
    const sorted = [...(tk.stepInstances ?? [])].sort(
      (a, b) => (a.stepDefinition?.order ?? 0) - (b.stepDefinition?.order ?? 0),
    );
    const active = sorted.find(s => s.status === 'pending' || s.status === 'in_progress' || s.status === 'blocked');
    return active?.stepDefinition?.name ?? null;
  };

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.tasks') }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{t('pages.tasksList.title')}</h1>
            <p>
              {statusF
                ? t('pages.tasksList.subtitleFiltered').replace('{total}', String(total)).replace('{status}', statusF.replace('_', ' '))
                : t('pages.tasksList.subtitle').replace('{total}', String(total))}
            </p>
          </div>
        </div>

        <div className="toolbar">
          <div className="search-wrap">
            <SearchIcon />
            <input placeholder={t('pages.tasksList.searchPlaceholder')} value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {STATUSES.map(s => (
              <button key={s.value} className={`btn btn-sm ${statusF === s.value ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => { setStatusF(s.value as TaskStatus | ''); setPage(1); }}>
                {t(s.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('pages.tasksList.colBrand')}</th>
                <th>{t('pages.tasksList.colTaskType')}</th>
                <th>{t('pages.tasksList.colStatus')}</th>
                <th>{t('pages.tasksList.colActiveStep')}</th>
                <th>{t('pages.tasksList.colCreatedBy')}</th>
                <th>{t('pages.tasksList.colDate')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={6} style={{ padding: '20px 16px', color: 'var(--text-muted)' }}>{t('common.loading')}</td></tr>}
              {!isLoading && tasks.length === 0 && (
                <tr><td colSpan={6}>
                  <div className="empty-state">
                    <h3>{t('pages.tasksList.noTasksFound')}</h3>
                    <p>{t('pages.tasksList.noTasksHint')}</p>
                  </div>
                </td></tr>
              )}
              {tasks.map(tk => (
                <tr key={tk.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/tasks/${tk.id}`)}>
                  <td style={{ fontWeight: 600 }}>{tk.brand?.brandName ?? '—'}</td>
                  <td>{tk.taskType?.name ?? '—'}</td>
                  <td><StatusBadge status={tk.status} /></td>
                  <td className="text-muted text-sm">{activeStepFor(tk) ?? '—'}</td>
                  <td className="text-muted">{tk.createdBy?.name ?? '—'}</td>
                  <td className="text-muted text-sm">{new Date(tk.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Paginator page={page} total={total} limit={LIMIT} onChange={setPage} />
        </div>
      </main>
    </>
  );
}
