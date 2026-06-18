import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import StatusBadge from '../../components/ui/StatusBadge';
import Modal from '../../components/ui/Modal';
import Paginator from '../../components/ui/Paginator';
import { bpoApi } from '../../api';
import { useT } from '../../i18n';
import type { Paginated } from '../../types';

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

interface HistoryStep {
  id: string;
  status: string;
  stepDefinition?: { name: string; order: number };
  assignedTo?: { id: string; name: string };
}

interface HistoryTask {
  id: string;
  status: string;
  createdAt: string;
  brand?: { brandName: string; country: string };
  taskType?: { name: string };
  createdBy?: { name: string };
  stepInstances?: HistoryStep[];
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
  const nav = useNavigate();
  const t = useT();
  const [tab, setTab] = useState<'team' | 'history'>('team');
  const [selected, setSelected] = useState<BpoPerf | null>(null);
  const [historyPage, setHistoryPage] = useState(1);

  const { data: team = [], isLoading: loadingTeam } = useQuery<BpoPerf[]>({
    queryKey: ['bpo-team'],
    queryFn: () => bpoApi.team().then(r => r.data),
  });

  const { data: historyResult, isLoading: loadingHistory } = useQuery<Paginated<HistoryTask>>({
    queryKey: ['bpo-team-history', historyPage],
    queryFn: () => bpoApi.teamHistory(historyPage, HISTORY_LIMIT).then(r => r.data),
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
                  <tr key={tk.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/tasks/${tk.id}`)}>
                    <td>
                      <span style={{ fontWeight: 600 }}>{tk.brand?.brandName ?? '—'}</span>
                      {tk.brand?.country && (
                        <span style={{ marginLeft: 6, fontSize: '0.75rem' }}>{COUNTRY_EMOJI[tk.brand.country] ?? ''}</span>
                      )}
                    </td>
                    <td className="text-muted">{tk.taskType?.name ?? '—'}</td>
                    <td><StatusBadge status={tk.status} /></td>
                    <td>
                      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                        {(tk.stepInstances ?? []).map(s => (
                          <span key={s.id} title={`${s.stepDefinition?.name ?? '?'} → ${s.assignedTo?.name ?? 'unassigned'}`} style={{
                            width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
                            background: s.status === 'done' ? 'var(--green)' : s.status === 'failed' ? 'var(--red)' : s.status === 'in_progress' ? 'var(--amber)' : s.status === 'blocked' ? 'var(--purple, #7C3AED)' : 'var(--border)',
                          }} />
                        ))}
                      </div>
                    </td>
                    <td className="text-muted text-sm">{tk.createdBy?.name ?? '—'}</td>
                    <td className="text-muted text-sm">{new Date(tk.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Paginator page={historyPage} total={historyTotal} limit={HISTORY_LIMIT} onChange={setHistoryPage} />
          </div>
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
