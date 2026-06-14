import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import Paginator from '../../components/ui/Paginator';
import StatusBadge from '../../components/ui/StatusBadge';
import { tasksApi } from '../../api';
import type { Task, TaskStatus, Paginated } from '../../types';

const STATUSES: { value: TaskStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'failed', label: 'Failed' },
  { value: 'done', label: 'Done' },
];
const LIMIT = 25;

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);

export default function TasksList() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(1);
  const [statusF, setStatusF] = useState<TaskStatus | ''>('');

  useEffect(() => {
    const t = setTimeout(() => { setDq(q); setPage(1); }, 300);
    return () => clearTimeout(t);
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

  const activeStepFor = (t: Task) => {
    const active = t.stepInstances?.find(s => s.status === 'in_progress' || s.status === 'blocked');
    return active?.stepDefinition?.name ?? null;
  };

  return (
    <>
      <Topbar breadcrumb={[{ label: 'Tasks' }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>Tasks</h1>
            <p>{total} tasks{statusF ? ` · ${statusF.replace('_', ' ')}` : ''}</p>
          </div>
        </div>

        <div className="toolbar">
          <div className="search-wrap">
            <SearchIcon />
            <input placeholder="Search by brand or task type…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {STATUSES.map(s => (
              <button key={s.value} className={`btn btn-sm ${statusF === s.value ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => { setStatusF(s.value as TaskStatus | ''); setPage(1); }}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Brand</th>
                <th>Task Type</th>
                <th>Status</th>
                <th>Active Step</th>
                <th>Created by</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={6} style={{ padding: '20px 16px', color: 'var(--text-muted)' }}>Loading…</td></tr>}
              {!isLoading && tasks.length === 0 && (
                <tr><td colSpan={6}>
                  <div className="empty-state">
                    <h3>No tasks found</h3>
                    <p>Tasks are created from a brand's detail page.</p>
                  </div>
                </td></tr>
              )}
              {tasks.map(t => (
                <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/tasks/${t.id}`)}>
                  <td style={{ fontWeight: 600 }}>{t.brand?.brandName ?? '—'}</td>
                  <td>{t.taskType?.name ?? '—'}</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td className="text-muted text-sm">{activeStepFor(t) ?? '—'}</td>
                  <td className="text-muted">{t.createdBy?.name ?? '—'}</td>
                  <td className="text-muted text-sm">{new Date(t.createdAt).toLocaleDateString()}</td>
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
