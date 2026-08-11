import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import Paginator from '../../components/ui/Paginator';
import StatusBadge from '../../components/ui/StatusBadge';
import { tasksApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useT } from '../../i18n';
import type { Account, Task, TaskStatus, Paginated } from '../../types';

const LIMIT = 25;

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);

export default function TasksList() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { account } = useAuth();
  const t = useT();
  const canReassign = account?.roles.some(role => role === 'admin' || role === 'super_admin') ?? false;
  const sectionFilterStorageKey = account ? `tequila.tasks.section-filter.${account.id}` : null;
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(1);
  const [statusF, setStatusF] = useState<TaskStatus | ''>('');
  const [sectionF, setSectionF] = useState(() => (
    sectionFilterStorageKey ? localStorage.getItem(sectionFilterStorageKey) ?? '' : ''
  ));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBpoId, setBulkBpoId] = useState('');
  const [bulkError, setBulkError] = useState('');
  const [bulkNotice, setBulkNotice] = useState('');

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

  const { data: filterOptions } = useQuery({
    queryKey: ['tasks', 'filter-options'],
    queryFn: () => tasksApi.filterOptions().then(r => r.data),
  });
  const sections = filterOptions?.sections ?? [];
  const activeSectionF = !filterOptions || !sectionF || sections.some(section => section.id === sectionF)
    ? sectionF
    : '';

  useEffect(() => {
    if (filterOptions && sectionF && !activeSectionF && sectionFilterStorageKey) {
      localStorage.removeItem(sectionFilterStorageKey);
    }
  }, [filterOptions, sectionF, activeSectionF, sectionFilterStorageKey]);

  const params = {
    page, limit: LIMIT,
    ...(dq      && { q: dq }),
    ...(statusF && { status: statusF }),
    ...(activeSectionF && { sectionId: activeSectionF }),
  };

  const { data: result, isLoading } = useQuery<Paginated<Task>>({
    queryKey: ['tasks', params],
    queryFn: () => tasksApi.list(params).then(r => r.data as Paginated<Task>),
  });

  const tasks = result?.data ?? [];
  const total = result?.total ?? 0;
  const { data: bpoResult } = useQuery<{ data: Account[] }>({
    queryKey: ['tasks', 'assignable-bpos'],
    queryFn: () => tasksApi.assignableBpos().then(response => response.data),
    enabled: canReassign,
  });
  const bpoAccounts = bpoResult?.data ?? [];

  const bulkReassign = useMutation({
    mutationFn: () => tasksApi.bulkReassign([...selectedIds], bulkBpoId),
    onSuccess: response => {
      const summary = response.data as { reassigned: number; unchanged: number; skipped: number; failed: number };
      setBulkNotice(t('pages.tasksList.bulkResult')
        .replace('{reassigned}', String(summary.reassigned))
        .replace('{unchanged}', String(summary.unchanged))
        .replace('{skipped}', String(summary.skipped))
        .replace('{failed}', String(summary.failed)));
      setBulkOpen(false);
      setBulkBpoId('');
      setSelectedIds(new Set());
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (reason: unknown) => {
      const message = (reason as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
      setBulkError(Array.isArray(message) ? message.join(', ') : message ?? t('pages.tasksList.bulkError'));
    },
  });

  const activeStepFor = (tk: Task) => {
    const sorted = [...(tk.stepInstances ?? [])].sort(
      (a, b) => (a.stepDefinition?.order ?? 0) - (b.stepDefinition?.order ?? 0),
    );
    const active = sorted.find(s => s.status === 'pending' || s.status === 'in_progress' || s.status === 'blocked');
    return active?.stepDefinition?.name ?? null;
  };
  const activeHumanStepsFor = (tk: Task) => (tk.stepInstances ?? []).filter(step =>
    ['pending', 'in_progress', 'blocked'].includes(step.status)
    && step.stepDefinition?.executionType !== 'automatic',
  );
  const assignedBposFor = (tk: Task) => {
    const names = [...new Set(activeHumanStepsFor(tk).map(step => step.assignedTo?.name).filter(Boolean))];
    return names.join(', ') || '—';
  };
  const eligibleVisibleIds = tasks.filter(task => activeHumanStepsFor(task).length > 0).map(task => task.id);
  const allVisibleSelected = eligibleVisibleIds.length > 0 && eligibleVisibleIds.every(id => selectedIds.has(id));
  const toggleSelected = (taskId: string) => setSelectedIds(previous => {
    const next = new Set(previous);
    if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
    return next;
  });
  const toggleVisible = () => setSelectedIds(previous => {
    const next = new Set(previous);
    if (allVisibleSelected) eligibleVisibleIds.forEach(id => next.delete(id));
    else eligibleVisibleIds.forEach(id => next.add(id));
    return next;
  });

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
          <select
            className="form-select"
            aria-label={t('pages.tasksList.sectionFilter')}
            value={activeSectionF}
            onChange={event => {
              const value = event.target.value;
              setSectionF(value);
              setPage(1);
              if (sectionFilterStorageKey) {
                if (value) localStorage.setItem(sectionFilterStorageKey, value);
                else localStorage.removeItem(sectionFilterStorageKey);
              }
            }}
            style={{ width: 220 }}
          >
            <option value="">{t('pages.tasksList.sectionAll')}</option>
            {sections.map(section => <option key={section.id} value={section.id}>{section.name}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {STATUSES.map(s => (
              <button key={s.value} className={`btn btn-sm ${statusF === s.value ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => { setStatusF(s.value as TaskStatus | ''); setPage(1); }}>
                {t(s.labelKey)}
              </button>
            ))}
          </div>
        </div>

        {canReassign && selectedIds.size > 0 && <div className="alert" style={{
          marginBottom: 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          borderColor: '#fdba74',
          background: '#fff7ed',
          color: '#9a3412',
        }}>
          <div><strong>{selectedIds.size}</strong> {t('pages.tasksList.selectedTasks')}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelectedIds(new Set())}>{t('common.cancel')}</button>
            <button className="btn btn-primary btn-sm" onClick={() => { setBulkError(''); setBulkOpen(true); }}>
              {t('pages.tasksList.reassignSelected')}
            </button>
          </div>
        </div>}
        {bulkNotice && <div className="alert alert-info" style={{ marginBottom: 14 }}>
          {bulkNotice}
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 10 }} onClick={() => setBulkNotice('')}>×</button>
        </div>}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {canReassign && <th style={{ width: 38 }}>
                  <input type="checkbox" aria-label={t('pages.tasksList.selectVisible')} checked={allVisibleSelected} onChange={toggleVisible} />
                </th>}
                <th>{t('pages.tasksList.colBrand')}</th>
                <th>{t('pages.tasksList.colTaskType')}</th>
                <th>{t('pages.tasksList.colStatus')}</th>
                <th>{t('pages.tasksList.colActiveStep')}</th>
                {canReassign && <th>{t('pages.tasksList.colAssignedBpo')}</th>}
                <th>{t('pages.tasksList.colCreatedBy')}</th>
                <th>{t('pages.tasksList.colDate')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={canReassign ? 8 : 6} style={{ padding: '20px 16px', color: 'var(--text-muted)' }}>{t('common.loading')}</td></tr>}
              {!isLoading && tasks.length === 0 && (
                <tr><td colSpan={canReassign ? 8 : 6}>
                  <div className="empty-state">
                    <h3>{t('pages.tasksList.noTasksFound')}</h3>
                    <p>{t('pages.tasksList.noTasksHint')}</p>
                  </div>
                </td></tr>
              )}
              {tasks.map(tk => (
                <tr key={tk.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/tasks/${tk.id}`)}>
                  {canReassign && <td onClick={event => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={t('pages.tasksList.selectTask')}
                      checked={selectedIds.has(tk.id)}
                      disabled={activeHumanStepsFor(tk).length === 0}
                      onChange={() => toggleSelected(tk.id)}
                    />
                  </td>}
                  <td style={{ fontWeight: 600 }}>{tk.brand?.brandName ?? '—'}</td>
                  <td>{tk.taskType?.name ?? '—'}</td>
                  <td><StatusBadge status={tk.status} /></td>
                  <td className="text-muted text-sm">{activeStepFor(tk) ?? '—'}</td>
                  {canReassign && <td className="text-muted text-sm">{assignedBposFor(tk)}</td>}
                  <td className="text-muted">{tk.createdBy?.name ?? '—'}</td>
                  <td className="text-muted text-sm">{new Date(tk.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Paginator page={page} total={total} limit={LIMIT} onChange={setPage} />
        </div>
      </main>
      {bulkOpen && <Modal title={t('pages.tasksList.bulkTitle')} onClose={() => !bulkReassign.isPending && setBulkOpen(false)} footer={<>
        <button className="btn btn-ghost" disabled={bulkReassign.isPending} onClick={() => setBulkOpen(false)}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={bulkReassign.isPending || !bulkBpoId} onClick={() => bulkReassign.mutate()}>
          {bulkReassign.isPending ? t('pages.tasksList.reassigning') : t('pages.tasksList.confirmBulk')}
        </button>
      </>}>
        {bulkError && <div className="error-banner">{bulkError}</div>}
        <div className="alert alert-info" style={{ marginBottom: 16 }}>
          {t('pages.tasksList.bulkHint').replace('{count}', String(selectedIds.size))}
        </div>
        <div className="form-group">
          <label className="form-label">{t('pages.tasksList.targetBpo')}</label>
          <select className="form-select" value={bulkBpoId} onChange={event => setBulkBpoId(event.target.value)}>
            <option value="">{t('pages.taskDetail.selectBpo')}</option>
            {bpoAccounts.map(bpo => <option key={bpo.id} value={bpo.id}>{bpo.name} · {bpo.email}</option>)}
          </select>
        </div>
      </Modal>}
    </>
  );
}
