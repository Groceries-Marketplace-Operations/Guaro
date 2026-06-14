import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import { tasksApi } from '../../api';
import type { Task, StepInstance, StepStatus } from '../../types';

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);
const XIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);
const AlertIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
);
const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
  </svg>
);

type ActionType = 'complete' | 'block' | 'fail' | null;

function pipeClass(status: StepStatus, isCurrent: boolean): string {
  if (status === 'done') return 'ps-done';
  if (status === 'failed') return 'ps-failed';
  if (status === 'blocked') return 'ps-blocked';
  if (isCurrent) return 'ps-active';
  return '';
}

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [action, setAction] = useState<ActionType>(null);
  const [activeStep, setActiveStep] = useState<StepInstance | null>(null);
  const [note, setNote] = useState('');
  const [failureReason, setFailureReason] = useState('bpo_timed_out');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const { data: task, isLoading } = useQuery<Task>({
    queryKey: ['task', id],
    queryFn: () => tasksApi.get(id!).then(r => r.data),
    refetchInterval: 5000,
  });

  const handleAction = async () => {
    if (!activeStep || !action) return;
    setSaving(true); setErr('');
    try {
      if (action === 'complete') await tasksApi.completeStep(id!, activeStep.id, { note });
      if (action === 'block')    await tasksApi.blockStep(id!, activeStep.id, { note });
      if (action === 'fail')     await tasksApi.failStep(id!, activeStep.id, { failureReason, note });
      qc.invalidateQueries({ queryKey: ['task', id] });
      setAction(null); setNote(''); setActiveStep(null);
    } catch (ex: unknown) {
      const e = ex as { response?: { data?: { message?: string } } };
      setErr(e.response?.data?.message ?? 'Error');
    } finally { setSaving(false); }
  };

  const handleRetry = async (step: StepInstance) => {
    await tasksApi.retryStep(id!, step.id);
    qc.invalidateQueries({ queryKey: ['task', id] });
  };

  if (isLoading) return (
    <>
      <Topbar breadcrumb={[{ label: 'Tasks', href: '/tasks' }, { label: 'Loading…' }]} />
      <main className="main-content"><p className="text-muted">Loading…</p></main>
    </>
  );
  if (!task) return null;

  const steps = [...(task.stepInstances ?? [])].sort((a, b) => a.order - b.order);

  return (
    <>
      <Topbar breadcrumb={[{ label: 'Tasks', href: '/tasks' }, { label: `${task.taskType?.name ?? 'Task'} — ${task.brand?.brandName ?? ''}` }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{task.taskType?.name}</h1>
            <p>{task.brand?.brandName} · {task.brand?.country}</p>
          </div>
          <StatusBadge status={task.status} />
        </div>

        {steps.length > 1 && (
          <div className="card mb-4">
            <div className="pipeline">
              {steps.map((s, i) => {
                const isActive = s.status === 'in_progress' || s.status === 'blocked';
                return (
                  <div key={s.id} className={`pipe-step ${pipeClass(s.status, isActive)}`}>
                    <div className="pipe-dot">{s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : i + 1}</div>
                    <div className="pipe-label">{s.stepDefinition?.name ?? `Step ${i+1}`}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-header"><span className="card-title">Steps</span></div>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead>
                <tr><th>#</th><th>Step</th><th>Type</th><th>Assigned To</th><th>Status</th><th>Note</th><th></th></tr>
              </thead>
              <tbody>
                {steps.map((s, i) => (
                  <tr key={s.id}>
                    <td className="text-muted">{i + 1}</td>
                    <td style={{ fontWeight: 600 }}>{s.stepDefinition?.name ?? '—'}</td>
                    <td className="text-muted text-sm">{s.stepDefinition?.executionType?.replace('_', ' ') ?? '—'}</td>
                    <td>{s.assignedTo?.name ?? <span className="text-muted">—</span>}</td>
                    <td><StatusBadge status={s.status} /></td>
                    <td className="text-muted text-sm">{s.note ?? '—'}</td>
                    <td>
                      {s.status === 'in_progress' && s.stepDefinition?.executionType !== 'automatic' && (
                        <div className="flex gap-2">
                          <button className="btn btn-sm btn-primary" title="Complete"
                            onClick={() => { setActiveStep(s); setAction('complete'); }}>
                            <CheckIcon />
                          </button>
                          <button className="btn btn-sm btn-ghost" title="Block"
                            onClick={() => { setActiveStep(s); setAction('block'); }}>
                            <AlertIcon />
                          </button>
                          <button className="btn btn-sm btn-danger" title="Fail"
                            onClick={() => { setActiveStep(s); setAction('fail'); }}>
                            <XIcon />
                          </button>
                        </div>
                      )}
                      {s.status === 'blocked' && (
                        <div className="flex gap-2">
                          <button className="btn btn-sm btn-primary" title="Retry"
                            onClick={() => handleRetry(s)}>
                            <RefreshIcon /> Retry
                          </button>
                          <button className="btn btn-sm btn-danger" title="Fail"
                            onClick={() => { setActiveStep(s); setAction('fail'); }}>
                            <XIcon />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card mt-2" style={{ background: 'var(--surface-2)' }}>
          <div className="card-header"><span className="card-title">Details</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div className="text-sm text-muted">Created by</div>
              <div style={{ fontWeight: 500 }}>{task.createdBy?.name ?? '—'}</div>
            </div>
            <div>
              <div className="text-sm text-muted">Created at</div>
              <div>{new Date(task.createdAt).toLocaleString()}</div>
            </div>
            {task.scheduledStart && (
              <>
                <div>
                  <div className="text-sm text-muted">Scheduled start</div>
                  <div>{new Date(task.scheduledStart).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-sm text-muted">Scheduled end</div>
                  <div>{task.scheduledEnd ? new Date(task.scheduledEnd).toLocaleString() : '—'}</div>
                </div>
              </>
            )}
          </div>
        </div>
      </main>

      {action && activeStep && (
        <Modal
          title={action === 'complete' ? 'Complete Step' : action === 'block' ? 'Block Step' : 'Fail Step'}
          onClose={() => { setAction(null); setActiveStep(null); setNote(''); setErr(''); }}
          footer={<>
            <button className="btn btn-ghost" onClick={() => { setAction(null); setActiveStep(null); }}>Cancel</button>
            <button
              className={`btn ${action === 'fail' ? 'btn-danger' : action === 'block' ? 'btn-ghost' : 'btn-primary'}`}
              onClick={handleAction} disabled={saving}
            >
              {saving ? 'Saving…' : action === 'complete' ? 'Complete' : action === 'block' ? 'Block' : 'Fail Step'}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          {action === 'fail' && (
            <div className="form-group">
              <label className="form-label">Failure Reason</label>
              <select className="form-select" value={failureReason} onChange={e => setFailureReason(e.target.value)}>
                <option value="bpo_timed_out">BPO timed out</option>
                <option value="no_bpo">No BPO available</option>
                <option value="error_handler">Handler error</option>
                <option value="system_timed_out">System timed out</option>
              </select>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">Note {action !== 'fail' ? '(optional)' : ''}</label>
            <textarea className="form-textarea" placeholder="Add a note…" value={note} onChange={e => setNote(e.target.value)} />
          </div>
        </Modal>
      )}
    </>
  );
}
