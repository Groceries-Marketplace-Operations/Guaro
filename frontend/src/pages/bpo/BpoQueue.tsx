import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import StatusBadge from '../../components/ui/StatusBadge';
import { bpoApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useT } from '../../i18n';

interface ActiveTask {
  id: string;
  status: string;
  brand?: { brandName: string; country: string };
  createdBy?: { id: string; name?: string; email?: string };
  relationship?: { createdByMe: boolean; assignedToMe: boolean };
  taskType?: { name: string };
  stepInstances?: { id: string; status: string; assignedToId?: string; stepDefinition?: { name: string; order: number } }[];
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
  const t = useT();
  const { account } = useAuth();

  const { data: tasks = [], isLoading } = useQuery<ActiveTask[]>({
    queryKey: ['bpo-my-tasks'],
    queryFn: () => bpoApi.myTasks().then(r => r.data),
    refetchInterval: 15_000,
  });

  const { data: perf } = useQuery<Perf>({
    queryKey: ['bpo-my-performance'],
    queryFn: () => bpoApi.myPerformance().then(r => r.data),
  });

  const activeStep = (task: ActiveTask) => {
    const isActive = (step: NonNullable<ActiveTask['stepInstances']>[number]) =>
      step.status === 'in_progress' || step.status === 'blocked' || step.status === 'pending';
    return (account?.id
      ? task.stepInstances?.find(step => step.assignedToId === account.id && isActive(step))
      : undefined)
      ?? task.stepInstances?.find(isActive);
  };

  const subtitle = tasks.length === 1
    ? t('pages.bpoQueue.subtitle').replace('{count}', String(tasks.length))
    : t('pages.bpoQueue.subtitlePlural').replace('{count}', String(tasks.length));

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.myQueue') }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{t('pages.bpoQueue.title')}</h1>
            <p>{subtitle}</p>
          </div>
        </div>

        {perf && (
          <div className="stat-grid" style={{ marginBottom: 24 }}>
            <div className="stat-card orange-accent">
              <div className="s-label">{t('pages.bpoQueue.stepsDone')}</div>
              <div className="s-value">{perf.stepsCompleted}</div>
              <div className="s-meta">{t('common.allTime')}</div>
            </div>
            <div className="stat-card">
              <div className="s-label">{t('pages.bpoQueue.inProgress')}</div>
              <div className="s-value" style={{ color: 'var(--amber)' }}>{perf.stepsInProgress}</div>
              <div className="s-meta">{t('pages.bpoQueue.activeSteps')}</div>
            </div>
            <div className="stat-card">
              <div className="s-label">{t('pages.bpoQueue.failed')}</div>
              <div className="s-value" style={{ color: 'var(--red)' }}>{perf.stepsFailed}</div>
              <div className="s-meta">{t('pages.bpoQueue.stepsFailed')}</div>
            </div>
            <div className="stat-card">
              <div className="s-label">{t('pages.bpoQueue.avgTime')}</div>
              <div className="s-value">
                {perf.avgCompletionHours != null ? Number(perf.avgCompletionHours).toFixed(1) : '—'}
              </div>
              <div className="s-meta">{t('pages.bpoQueue.hoursPerStep')}</div>
            </div>
          </div>
        )}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('pages.bpoQueue.colBrand')}</th>
                <th>{t('pages.bpoQueue.colTaskType')}</th>
                <th>{t('pages.bpoQueue.colRelationship')}</th>
                <th>{t('pages.bpoQueue.colTaskStatus')}</th>
                <th>{t('pages.bpoQueue.colCurrentStep')}</th>
                <th>{t('pages.bpoQueue.colLastUpdate')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={6} style={{ padding: '20px 16px', color: 'var(--text-muted)' }}>{t('common.loading')}</td></tr>
              )}
              {!isLoading && tasks.length === 0 && (
                <tr><td colSpan={6}>
                  <div className="empty-state">
                    <h3>{t('pages.bpoQueue.queueEmpty')}</h3>
                    <p>{t('pages.bpoQueue.noTasksAssigned')}</p>
                  </div>
                </td></tr>
              )}
              {tasks.map(task => {
                const step = activeStep(task);
                const createdByMe = task.relationship?.createdByMe ?? task.createdBy?.id === account?.id;
                const assignedToMe = task.relationship?.assignedToMe
                  ?? task.stepInstances?.some(item => item.assignedToId === account?.id)
                  ?? false;
                const relationshipLabel = createdByMe && assignedToMe
                  ? t('pages.bpoQueue.relationshipBoth')
                  : createdByMe
                    ? t('pages.bpoQueue.relationshipCreated')
                    : t('pages.bpoQueue.relationshipAssigned');
                return (
                  <tr key={task.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/tasks/${task.id}`)}>
                    <td style={{ fontWeight: 600 }}>{task.brand?.brandName ?? '—'}</td>
                    <td className="text-muted">{task.taskType?.name ?? '—'}</td>
                    <td>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        borderRadius: 999,
                        padding: '3px 8px',
                        fontSize: '.7rem',
                        fontWeight: 750,
                        background: createdByMe ? 'var(--amber-bg)' : 'var(--surface-2)',
                        color: createdByMe ? '#92400e' : 'var(--text-muted)',
                      }}>
                        {relationshipLabel}
                      </span>
                    </td>
                    <td><StatusBadge status={task.status} /></td>
                    <td>
                      {step?.stepDefinition?.name
                        ? <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {step.stepDefinition.name}
                            <StatusBadge status={step.status} />
                          </span>
                        : <span className="text-muted">—</span>}
                    </td>
                    <td className="text-sm text-muted">{new Date(task.updatedAt).toLocaleString()}</td>
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
