import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import StatusBadge from '../../components/ui/StatusBadge';
import Modal from '../../components/ui/Modal';
import Paginator from '../../components/ui/Paginator';
import { bpoApi, taskTypesApi } from '../../api';
import { useT } from '../../i18n';
import type { Paginated, TaskType } from '../../types';

interface BpoAccount {
  id: string;
  name: string;
  email: string;
  workload: number;
  rrCounter: number;
}

interface BpoPerf {
  account: BpoAccount;
  stepsCompleted: number;
  stepsFailed: number;
  stepsInProgress: number;
  avgCompletionHours: number | null;
}

interface HistoryArchive {
  id: string;
  taskId: string;
  taskTypeName: string;
  taskTypeId: string;
  brandName: string | null;
  brandRef: string | null;
  country: string | null;
  createdByName: string | null;
  status: string;
  stepsTotal: number;
  stepsDone: number;
  stepsFailed: number;
  taskCreatedAt: string;
  archivedAt: string;
}

const COUNTRY_EMOJI: Record<string, string> = { MX: '🇲🇽', CO: '🇨🇴', CR: '🇨🇷' };

function completionBar(completed: number, failed: number) {
  const total = completed + failed;
  if (total === 0) return null;
  const pct = Math.round((completed / total) * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--red)', borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', minWidth: 28 }}>{pct}%</span>
    </div>
  );
}

const HISTORY_LIMIT = 25;

export default function BpoManagement() {
  const t = useT();
  const [tab, setTab] = useState<'team' | 'history'>('team');
  const [selected, setSelected] = useState<BpoPerf | null>(null);
  const [historyPage, setHistoryPage] = useState(1);

  // Shared filters (used by both tabs)
  const [filterTaskTypeId, setFilterTaskTypeId] = useState('');
  const [filterYear,  setFilterYear]  = useState('');
  const [filterMonth, setFilterMonth] = useState('');
  const [filterWeek,  setFilterWeek]  = useState('');

  const sharedFilters = {
    taskTypeId: filterTaskTypeId || undefined,
    year:  filterYear  ? Number(filterYear)  : undefined,
    month: filterMonth ? Number(filterMonth) : undefined,
    week:  filterWeek  ? Number(filterWeek)  : undefined,
  };

  const clearFilters = () => {
    setFilterTaskTypeId(''); setFilterYear(''); setFilterMonth(''); setFilterWeek('');
    setHistoryPage(1);
  };

  const { data: team = [], isLoading: loadingTeam } = useQuery<BpoPerf[]>({
    queryKey: ['bpo-team', sharedFilters],
    queryFn: () => bpoApi.team(sharedFilters).then(r => r.data),
  });

  const { data: taskTypesResult } = useQuery<{ data: TaskType[] }>({
    queryKey: ['task-types', { limit: 200 }],
    queryFn: () => taskTypesApi.list({ limit: 200 }).then(r => r.data as { data: TaskType[] }),
  });

  const { data: yearOptions = [] } = useQuery<number[]>({
    queryKey: ['bpo-filter-years'],
    queryFn: () => bpoApi.filterOptions().then(r => r.data.years),
  });

  const { data: subOptions } = useQuery<{ months: number[]; weeks: number[] }>({
    queryKey: ['bpo-filter-sub', filterYear],
    queryFn: () => bpoApi.filterOptions(Number(filterYear)).then(r => ({ months: r.data.months, weeks: r.data.weeks })),
    enabled: !!filterYear,
  });
  const monthOptions = subOptions?.months ?? [];
  const weekOptions  = subOptions?.weeks  ?? [];
  const taskTypes: TaskType[] = taskTypesResult?.data ?? [];

  const { data: historyResult, isLoading: loadingHistory } = useQuery<Paginated<HistoryArchive>>({
    queryKey: ['bpo-team-history', historyPage, sharedFilters],
    queryFn: () => bpoApi.teamHistory(historyPage, HISTORY_LIMIT, sharedFilters).then(r => r.data),
    enabled: tab === 'history',
  });
  const history = historyResult?.data ?? [];
  const historyTotal = historyResult?.total ?? 0;

  const totalActive    = team.reduce((s, b) => s + b.stepsInProgress, 0);
  const totalCompleted = team.reduce((s, b) => s + b.stepsCompleted, 0);
  const totalFailed    = team.reduce((s, b) => s + b.stepsFailed, 0);

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.bpoTeam') }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{t('pages.bpoMgmt.title')}</h1>
            <p>{t('pages.bpoMgmt.subtitle').replace('{count}', String(team.length))}</p>
          </div>
        </div>

        <div className="stat-grid" style={{ marginBottom: 20 }}>
          <div className="stat-card">
            <div className="s-label">{t('pages.bpoMgmt.statAgents')}</div>
            <div className="s-value">{team.length}</div>
            <div className="s-meta">{t('pages.bpoMgmt.statInTeam')}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">{t('pages.bpoMgmt.statActiveSteps')}</div>
            <div className="s-value" style={{ color: 'var(--amber)' }}>{totalActive}</div>
            <div className="s-meta">{t('pages.bpoMgmt.statInProgress')}</div>
          </div>
          <div className="stat-card orange-accent">
            <div className="s-label">{t('pages.bpoMgmt.statStepsDone')}</div>
            <div className="s-value">{totalCompleted}</div>
            <div className="s-meta">{t('common.allTime')}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">{t('pages.bpoMgmt.statStepsFailed')}</div>
            <div className="s-value" style={{ color: 'var(--red)' }}>{totalFailed}</div>
            <div className="s-meta">{t('common.allTime')}</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="form-select" style={{ width: 200, margin: 0 }}
            value={filterTaskTypeId} onChange={e => { setFilterTaskTypeId(e.target.value); setHistoryPage(1); }}>
            <option value="">{t('pages.bpoMgmt.filterAllTaskTypes')}</option>
            {taskTypes.map(tt => <option key={tt.id} value={tt.id}>{tt.name}</option>)}
          </select>
          {yearOptions.length > 0 && (
            <select className="form-select" style={{ width: 110, margin: 0 }}
              value={filterYear} onChange={e => { setFilterYear(e.target.value); setFilterMonth(''); setFilterWeek(''); setHistoryPage(1); }}>
              <option value="">{t('pages.bpoMgmt.filterYear')}</option>
              {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          )}
          {filterYear && monthOptions.length > 0 && (
            <select className="form-select" style={{ width: 130, margin: 0 }}
              value={filterMonth} onChange={e => { setFilterMonth(e.target.value); setFilterWeek(''); setHistoryPage(1); }}>
              <option value="">{t('pages.bpoMgmt.filterMonth')}</option>
              {monthOptions.map(m => <option key={m} value={m}>{m.toString().padStart(2, '0')}</option>)}
            </select>
          )}
          {filterYear && !filterMonth && weekOptions.length > 0 && (
            <select className="form-select" style={{ width: 130, margin: 0 }}
              value={filterWeek} onChange={e => { setFilterWeek(e.target.value); setHistoryPage(1); }}>
              <option value="">{t('pages.bpoMgmt.filterWeek')}</option>
              {weekOptions.map(w => <option key={w} value={w}>W{w.toString().padStart(2, '0')}</option>)}
            </select>
          )}
          {(filterTaskTypeId || filterYear) && (
            <button className="btn btn-ghost btn-sm" onClick={clearFilters}>{t('common.clear')}</button>
          )}
        </div>

        <div className="tabs">
          <div className={`tab ${tab === 'team' ? 'active' : ''}`} onClick={() => setTab('team')}>
            {t('pages.bpoMgmt.tabTeam').replace('{count}', String(team.length))}
          </div>
          <div className={`tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
            {t('pages.bpoMgmt.tabHistory')}
          </div>
        </div>

        {tab === 'team' && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('pages.bpoMgmt.colAgent')}</th>
                  <th>{t('pages.bpoMgmt.colInProgress')}</th>
                  <th>{t('pages.bpoMgmt.colDone')}</th>
                  <th>{t('pages.bpoMgmt.colFailed')}</th>
                  <th>{t('pages.bpoMgmt.colSuccessRate')}</th>
                  <th>{t('pages.bpoMgmt.colAvgHours')}</th>
                  <th>{t('pages.bpoMgmt.colWorkload')}</th>
                </tr>
              </thead>
              <tbody>
                {loadingTeam && (
                  <tr><td colSpan={7} style={{ padding: '20px 16px', color: 'var(--text-muted)' }}>{t('common.loading')}</td></tr>
                )}
                {!loadingTeam && team.length === 0 && (
                  <tr><td colSpan={7}><div className="empty-state"><p>{t('pages.bpoMgmt.noAgents')}</p></div></td></tr>
                )}
                {team.map(b => (
                  <tr key={b.account.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(b)}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{b.account.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{b.account.email}</div>
                    </td>
                    <td>
                      <span style={{ fontWeight: 600, color: b.stepsInProgress > 0 ? 'var(--amber)' : 'var(--text-muted)' }}>
                        {b.stepsInProgress}
                      </span>
                    </td>
                    <td style={{ color: 'var(--green)', fontWeight: 600 }}>{b.stepsCompleted}</td>
                    <td style={{ color: b.stepsFailed > 0 ? 'var(--red)' : 'var(--text-muted)' }}>{b.stepsFailed}</td>
                    <td style={{ minWidth: 120 }}>{completionBar(b.stepsCompleted, b.stepsFailed)}</td>
                    <td className="text-muted">
                      {b.avgCompletionHours != null ? `${Number(b.avgCompletionHours).toFixed(1)} h` : '—'}
                    </td>
                    <td>
                      <span style={{
                        fontSize: '0.72rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                        background: b.stepsInProgress > 5 ? 'var(--red-bg)' : b.stepsInProgress > 2 ? 'var(--amber-bg)' : 'var(--green-bg)',
                        color: b.stepsInProgress > 5 ? 'var(--red)' : b.stepsInProgress > 2 ? '#B54708' : '#027A48',
                      }}>
                        {b.stepsInProgress}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'history' && (
          <>
            <div style={{ textAlign: 'right', marginBottom: 10, fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              {historyTotal} {t('pages.bpoMgmt.histArchivedTasks')}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('pages.bpoMgmt.histColBrand')}</th>
                    <th>{t('pages.bpoMgmt.histColTaskType')}</th>
                    <th>{t('pages.bpoMgmt.histColStatus')}</th>
                    <th>{t('pages.bpoMgmt.histColSteps')}</th>
                    <th>{t('pages.bpoMgmt.histColCreatedBy')}</th>
                    <th>{t('pages.bpoMgmt.histColDate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingHistory && (
                    <tr><td colSpan={6} style={{ padding: '20px 16px', color: 'var(--text-muted)' }}>{t('common.loading')}</td></tr>
                  )}
                  {!loadingHistory && history.length === 0 && (
                    <tr><td colSpan={6}><div className="empty-state"><p>{t('pages.bpoMgmt.histNoTasks')}</p></div></td></tr>
                  )}
                  {history.map(tk => (
                    <tr key={tk.id}>
                      <td>
                        <span style={{ fontWeight: 600 }}>{tk.brandName ?? '—'}</span>
                        {tk.country && (
                          <span style={{ marginLeft: 6, fontSize: '0.75rem' }}>{COUNTRY_EMOJI[tk.country] ?? ''}</span>
                        )}
                        {tk.brandRef && (
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{tk.brandRef}</div>
                        )}
                      </td>
                      <td className="text-muted">{tk.taskTypeName}</td>
                      <td><StatusBadge status={tk.status} /></td>
                      <td>
                        <span style={{ fontSize: '0.8rem' }}>
                          <span style={{ color: 'var(--green)', fontWeight: 600 }}>{tk.stepsDone}</span>
                          <span style={{ color: 'var(--text-muted)' }}>/{tk.stepsTotal}</span>
                          {tk.stepsFailed > 0 && (
                            <span style={{ color: 'var(--red)', marginLeft: 4 }}>({tk.stepsFailed} ✗)</span>
                          )}
                        </span>
                      </td>
                      <td className="text-muted text-sm">{tk.createdByName ?? '—'}</td>
                      <td className="text-muted text-sm">{tk.taskCreatedAt ? new Date(tk.taskCreatedAt).toLocaleDateString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Paginator page={historyPage} total={historyTotal} limit={HISTORY_LIMIT} onChange={setHistoryPage} />
            </div>
          </>
        )}
      </main>

      {selected && (
        <Modal title={selected.account.name} onClose={() => setSelected(null)}
          footer={<button className="btn btn-ghost" onClick={() => setSelected(null)}>{t('common.close')}</button>}
        >
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: 16 }}>{selected.account.email}</p>

          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            {[
              { label: t('pages.bpoMgmt.modalStatDone'), value: selected.stepsCompleted, color: 'var(--green)' },
              { label: t('pages.bpoMgmt.modalStatInProgress'), value: selected.stepsInProgress, color: 'var(--amber)' },
              { label: t('pages.bpoMgmt.modalStatFailed'), value: selected.stepsFailed, color: selected.stepsFailed > 0 ? 'var(--red)' : undefined },
              { label: t('pages.bpoMgmt.modalStatAvgHours'), value: selected.avgCompletionHours != null ? Number(selected.avgCompletionHours).toFixed(1) : '—', color: undefined },
            ].map(stat => (
              <div key={stat.label} style={{ textAlign: 'center', padding: '10px 16px', background: 'var(--surface-2)', borderRadius: 8, flex: 1, minWidth: 90 }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 2 }}>{stat.label}</div>
                <div style={{ fontSize: '1.35rem', fontWeight: 700, color: stat.color ?? 'var(--text-primary)' }}>{stat.value}</div>
              </div>
            ))}
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6 }}>{t('pages.bpoMgmt.modalSuccessRate')}</div>
            {completionBar(selected.stepsCompleted, selected.stepsFailed) ?? (
              <span className="text-muted text-sm">{t('pages.bpoMgmt.modalNoData')}</span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 16, fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            <span>{t('pages.bpoMgmt.modalActiveSteps')}<strong style={{ color: 'var(--text-primary)' }}>{selected.stepsInProgress}</strong></span>
            <span>{t('pages.bpoMgmt.modalRrCounter')}<strong style={{ color: 'var(--text-primary)' }}>{selected.account.rrCounter}</strong></span>
          </div>
        </Modal>
      )}
    </>
  );
}
