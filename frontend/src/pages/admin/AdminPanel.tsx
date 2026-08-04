import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminApi } from '../../api';
import { useT } from '../../i18n';
import Topbar from '../../components/layout/Topbar';

type Tab = 'queues' | 'logs';
type LogStatus = '' | 'done' | 'failed' | 'in_progress' | 'pending';

const STATUS_COLOR: Record<string, string> = {
  done: 'var(--success)',
  failed: 'var(--danger)',
  in_progress: 'var(--info)',
  pending: 'var(--muted)',
  blocked: 'var(--warning)',
};

function QueueCard({ label, counts, recentFailed }: {
  label: string;
  counts: Record<string, number>;
  recentFailed: { id: string; name: string; failedReason?: string; data: unknown; timestamp: number; attemptsMade: number }[];
}) {
  const [open, setOpen] = useState(false);
  const failedCount = counts.failed ?? 0;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <strong style={{ fontSize: 15 }}>{label}</strong>
        {failedCount > 0 && (
          <span className="badge" style={{ background: 'var(--danger)', color: '#fff' }}>
            {failedCount} failed
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: recentFailed.length ? 12 : 0 }}>
        {['active', 'waiting', 'delayed', 'completed', 'failed'].map((state) => (
          <div key={state} style={{ textAlign: 'center', minWidth: 64 }}>
            <div style={{
              fontSize: 22,
              fontWeight: 700,
              color: state === 'failed' && (counts[state] ?? 0) > 0 ? 'var(--danger)' : state === 'active' && (counts[state] ?? 0) > 0 ? 'var(--info)' : 'var(--fg)',
            }}>
              {counts[state] ?? 0}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{state}</div>
          </div>
        ))}
      </div>

      {recentFailed.length > 0 && (
        <>
          <button className="btn btn-sm btn-secondary" onClick={() => setOpen(v => !v)} style={{ marginBottom: 8 }}>
            {open ? 'Hide' : 'Show'} last {recentFailed.length} failed job{recentFailed.length > 1 ? 's' : ''}
          </button>
          {open && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {recentFailed.map((j) => (
                <div key={j.id} style={{ background: 'var(--surface)', borderRadius: 6, padding: '8px 12px', fontSize: 12, fontFamily: 'monospace', borderLeft: '3px solid var(--danger)' }}>
                  <div style={{ marginBottom: 4 }}>
                    <strong>{j.name}</strong>
                    <span style={{ marginLeft: 8, color: 'var(--muted)' }}>{new Date(j.timestamp).toLocaleString()}</span>
                    <span style={{ marginLeft: 8, color: 'var(--muted)' }}>attempts: {j.attemptsMade}</span>
                  </div>
                  {j.failedReason && <div style={{ color: 'var(--danger)', marginBottom: 4 }}>{j.failedReason}</div>}
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--muted)' }}>
                    {JSON.stringify(j.data, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LogRow({ row }: { row: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const sd = row.stepDefinition as Record<string, unknown> | null;
  const task = row.task as Record<string, unknown> | null;
  const brand = task?.brand as Record<string, unknown> | null;
  const handler = sd?.handler as Record<string, unknown> | null;
  const taskType = sd?.taskType as Record<string, unknown> | null;

  return (
    <>
      <tr onClick={() => setOpen(v => !v)} style={{ cursor: 'pointer' }}>
        <td>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[row.status as string] ?? 'var(--muted)', marginRight: 6 }} />
          {row.status as string}
        </td>
        <td>{handler?.name as string ?? '—'}</td>
        <td>{taskType?.name as string ?? '—'}</td>
        <td>{sd?.name as string ?? '—'}</td>
        <td>
          {brand ? (
            <span>{brand.brandName as string} <span style={{ color: 'var(--muted)', fontSize: 11 }}>({brand.country as string})</span></span>
          ) : '—'}
        </td>
        <td style={{ color: row.failureReason ? 'var(--danger)' : 'var(--muted)', fontSize: 12 }}>
          {row.failureReason as string ?? ''}
        </td>
        <td style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
          {row.completedAt
            ? new Date(row.completedAt as string).toLocaleString()
            : row.updatedAt
              ? new Date(row.updatedAt as string).toLocaleString()
              : '—'}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} style={{ padding: '0 12px 12px', background: 'var(--surface)' }}>
            {!!row.note && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 4, textTransform: 'uppercase' }}>Note</div>
                <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{row.note as string}</pre>
              </div>
            )}
            {row.result != null && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 4, textTransform: 'uppercase' }}>Result</div>
                <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {JSON.stringify(row.result as object, null, 2)}
                </pre>
              </div>
            )}
            {!row.note && row.result == null && (
              <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>No output recorded.</div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function AdminPanel() {
  const t = useT();
  const [tab, setTab] = useState<Tab>('queues');
  const [logStatus, setLogStatus] = useState<LogStatus>('');
  const [logPage, setLogPage] = useState(1);

  const queueQuery = useQuery({
    queryKey: ['admin-queue-status'],
    queryFn: () => adminApi.queueStatus().then(r => r.data),
    refetchInterval: 10_000,
    enabled: tab === 'queues',
  });

  const logsQuery = useQuery({
    queryKey: ['admin-handler-logs', logPage, logStatus],
    queryFn: () => adminApi.handlerLogs({ page: logPage, limit: 25, status: logStatus || undefined }).then(r => r.data),
    enabled: tab === 'logs',
  });

  const queues = queueQuery.data?.queues as Record<string, { counts: Record<string, number>; recentFailed: unknown[] }> | undefined;
  const logs = logsQuery.data as { data: Record<string, unknown>[]; total: number; page: number; limit: number } | undefined;
  const totalPages = logs ? Math.ceil(logs.total / logs.limit) : 1;

  return (
    <div className="main-content">
    <Topbar breadcrumb={[{ label: t('admin.title') }]} />
    <div style={{ padding: '24px 28px', maxWidth: 1100 }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontWeight: 700, fontSize: 20 }}>{t('admin.title')}</h2>
        <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 14 }}>{t('admin.subtitle')}</p>
      </div>

      <div className="tabs" style={{ marginBottom: 20 }}>
        <button className={`tab${tab === 'queues' ? ' active' : ''}`} onClick={() => setTab('queues')}>
          {t('admin.tabQueues')}
        </button>
        <button className={`tab${tab === 'logs' ? ' active' : ''}`} onClick={() => setTab('logs')}>
          {t('admin.tabLogs')}
        </button>
      </div>

      {/* ── Queue Status ─────────────────────────────────────── */}
      {tab === 'queues' && (
        <div>
          {queueQuery.isLoading && <div style={{ color: 'var(--muted)' }}>{t('common.loading')}</div>}
          {queueQuery.isError && <div style={{ color: 'var(--danger)' }}>Error loading queue status.</div>}
          {queues && (
            <>
              <QueueCard
                label="handlers"
                counts={queues.handlers.counts}
                recentFailed={queues.handlers.recentFailed as { id: string; name: string; failedReason?: string; data: unknown; timestamp: number; attemptsMade: number }[]}
              />
              <QueueCard
                label="forced-open"
                counts={queues.forcedOpen.counts}
                recentFailed={queues.forcedOpen.recentFailed as { id: string; name: string; failedReason?: string; data: unknown; timestamp: number; attemptsMade: number }[]}
              />
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                Auto-refreshes every 10 s.
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Handler Logs ─────────────────────────────────────── */}
      {tab === 'logs' && (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
            <label style={{ fontSize: 13, color: 'var(--muted)' }}>{t('common.status')}:</label>
            <select
              className="input"
              style={{ width: 160, padding: '4px 8px', fontSize: 13 }}
              value={logStatus}
              onChange={(e) => { setLogStatus(e.target.value as LogStatus); setLogPage(1); }}
            >
              <option value="">{t('common.all')}</option>
              <option value="done">{t('status.done')}</option>
              <option value="failed">{t('status.failed')}</option>
              <option value="in_progress">{t('status.in_progress')}</option>
              <option value="pending">{t('status.pending')}</option>
            </select>
            <button className="btn btn-sm btn-secondary" onClick={() => logsQuery.refetch()}>
              Refresh
            </button>
          </div>

          {logsQuery.isLoading && <div style={{ color: 'var(--muted)' }}>{t('common.loading')}</div>}
          {logsQuery.isError && <div style={{ color: 'var(--danger)' }}>Error loading logs.</div>}

          {logs && (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table className="table" style={{ width: '100%', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th>{t('common.status')}</th>
                      <th>Handler</th>
                      <th>Task Type</th>
                      <th>Step</th>
                      <th>Brand</th>
                      <th>Failure Reason</th>
                      <th>Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.data.length === 0 && (
                      <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>{t('common.noResults')}</td></tr>
                    )}
                    {logs.data.map((row) => (
                      <LogRow key={row.id as string} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, fontSize: 13, color: 'var(--muted)' }}>
                <span>{logs.total} {t('admin.totalLogs')}</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-sm btn-secondary" disabled={logPage <= 1} onClick={() => setLogPage(p => p - 1)}>‹ Prev</button>
                  <span style={{ padding: '4px 8px' }}>{logPage} / {totalPages}</span>
                  <button className="btn btn-sm btn-secondary" disabled={logPage >= totalPages} onClick={() => setLogPage(p => p + 1)}>Next ›</button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
    </div>
  );
}
