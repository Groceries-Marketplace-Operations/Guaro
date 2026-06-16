import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import StatusBadge from '../../components/ui/StatusBadge';
import { bpoApi } from '../../api';

interface ActiveTask {
  id: string;
  status: string;
  brand?: { brandName: string; country: string };
  taskType?: { name: string };
  stepInstances?: { id: string; status: string; stepDefinition?: { name: string; order: number } }[];
  updatedAt: string;
  createdAt: string;
}

interface Perf {
  stepsCompleted: number;
  stepsFailed: number;
  stepsInProgress: number;
  avgCompletionHours: number | null;
}

export default function BpoQueue() {
  const nav = useNavigate();

  const { data: tasks = [], isLoading } = useQuery<ActiveTask[]>({
    queryKey: ['bpo-my-tasks'],
    queryFn: () => bpoApi.myTasks().then(r => r.data),
    refetchInterval: 15_000,
  });

  const { data: perf } = useQuery<Perf>({
    queryKey: ['bpo-my-performance'],
    queryFn: () => bpoApi.myPerformance().then(r => r.data),
  });

  const activeStep = (t: ActiveTask) =>
    t.stepInstances?.find(s => s.status === 'in_progress' || s.status === 'blocked' || s.status === 'pending');

  return (
    <>
      <Topbar breadcrumb={[{ label: 'My Queue' }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>My Queue</h1>
            <p>{tasks.length} active task{tasks.length !== 1 ? 's' : ''} · refreshes every 15 s</p>
          </div>
        </div>

        {perf && (
          <div className="stat-grid" style={{ marginBottom: 24 }}>
            <div className="stat-card orange-accent">
              <div className="s-label">Steps Done</div>
              <div className="s-value">{perf.stepsCompleted}</div>
              <div className="s-meta">all time</div>
            </div>
            <div className="stat-card">
              <div className="s-label">In Progress</div>
              <div className="s-value" style={{ color: 'var(--amber)' }}>{perf.stepsInProgress}</div>
              <div className="s-meta">active steps</div>
            </div>
            <div className="stat-card">
              <div className="s-label">Failed</div>
              <div className="s-value" style={{ color: 'var(--red)' }}>{perf.stepsFailed}</div>
              <div className="s-meta">steps failed</div>
            </div>
            <div className="stat-card">
              <div className="s-label">Avg Time</div>
              <div className="s-value">
                {perf.avgCompletionHours != null ? Number(perf.avgCompletionHours).toFixed(1) : '—'}
              </div>
              <div className="s-meta">hours per step</div>
            </div>
          </div>
        )}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Brand</th>
                <th>Task Type</th>
                <th>Task Status</th>
                <th>Current Step</th>
                <th>Last Update</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={5} style={{ padding: '20px 16px', color: 'var(--text-muted)' }}>Loading…</td></tr>
              )}
              {!isLoading && tasks.length === 0 && (
                <tr><td colSpan={5}>
                  <div className="empty-state">
                    <h3>Queue is empty</h3>
                    <p>No tasks assigned to you right now.</p>
                  </div>
                </td></tr>
              )}
              {tasks.map(t => {
                const step = activeStep(t);
                return (
                  <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/tasks/${t.id}`)}>
                    <td style={{ fontWeight: 600 }}>{t.brand?.brandName ?? '—'}</td>
                    <td className="text-muted">{t.taskType?.name ?? '—'}</td>
                    <td><StatusBadge status={t.status} /></td>
                    <td>
                      {step?.stepDefinition?.name
                        ? <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {step.stepDefinition.name}
                            <StatusBadge status={step.status} />
                          </span>
                        : <span className="text-muted">—</span>}
                    </td>
                    <td className="text-sm text-muted">{new Date(t.updatedAt).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
