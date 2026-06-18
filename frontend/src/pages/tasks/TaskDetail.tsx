import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import { tasksApi, accountsApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useT } from '../../i18n';
import type { Task, StepInstance, StepStatus, FormValue, Account } from '../../types';

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
const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
    <polygon points="5 3 19 12 5 21 5 3"/>
  </svg>
);

type ActionType = 'complete' | 'block' | 'fail' | null;

function formValueDisplay(fv: FormValue): string {
  if (fv.brand) return `${fv.brand.brandName} (${fv.brand.brandId})`;
  if (fv.shop) return `${fv.shop.shopId} / ${fv.shop.appShopId}`;
  return fv.valor ?? '—';
}

function pipeClass(status: StepStatus, isCurrent: boolean): string {
  if (status === 'done') return 'ps-done';
  if (status === 'failed') return 'ps-failed';
  if (status === 'blocked') return 'ps-blocked';
  if (status === 'in_progress' || isCurrent) return 'ps-active';
  return '';
}

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { account } = useAuth();
  const t = useT();
  const roles = account?.roles ?? [];
  const canActOnStep = roles.some(r => r === 'bpo' || r === 'admin' || r === 'super_admin');

  const [action, setAction] = useState<ActionType>(null);
  const [activeStep, setActiveStep] = useState<StepInstance | null>(null);
  const [note, setNote] = useState('');
  const [failureReason, setFailureReason] = useState('bpo_timed_out');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const [manualAssignStep, setManualAssignStep] = useState<string | null>(null);
  const [manualAssignBpo, setManualAssignBpo] = useState('');

  const { data: task, isLoading, isError } = useQuery<Task>({
    queryKey: ['task', id],
    queryFn: () => tasksApi.get(id!).then(r => r.data),
    refetchInterval: 5000,
    retry: false,
  });

  const canManualAssign = roles.some(r => r === 'admin' || r === 'super_admin');
  const { data: bpoAccountsResult } = useQuery<{ data: Account[] }>({
    queryKey: ['accounts', 'bpo'],
    queryFn: () => accountsApi.list({ role: 'bpo', limit: 200 }).then(r => r.data as { data: Account[] }),
    enabled: canManualAssign && !!task,
  });
  const bpoAccounts: Account[] = bpoAccountsResult?.data ?? [];

  const handleManualAssign = async (stepId: string) => {
    if (!manualAssignBpo) return;
    setSaving(true); setErr('');
    try {
      await tasksApi.assignStep(id!, stepId, manualAssignBpo);
      qc.invalidateQueries({ queryKey: ['task', id] });
      setManualAssignStep(null);
      setManualAssignBpo('');
    } catch (ex: unknown) {
      const e = ex as { response?: { data?: { message?: string } } };
      setErr(e.response?.data?.message ?? t('pages.taskDetail.errorAssigning'));
    } finally { setSaving(false); }
  };

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

  const handleStart = async (step: StepInstance) => {
    setSaving(true); setErr('');
    try {
      await tasksApi.startStep(id!, step.id);
      qc.invalidateQueries({ queryKey: ['task', id] });
    } catch (ex: unknown) {
      const e = ex as { response?: { data?: { message?: string } } };
      setErr(e.response?.data?.message ?? t('pages.taskDetail.errorStarting'));
    } finally { setSaving(false); }
  };

  if (isLoading) return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.tasks'), href: '/tasks' }, { label: t('pages.taskDetail.loading') }]} />
      <main className="main-content"><p className="text-muted">{t('pages.taskDetail.loading')}</p></main>
    </>
  );

  if (isError || !task) return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.tasks'), href: '/tasks' }, { label: t('pages.taskDetail.notFound') }]} />
      <main className="main-content">
        <div className="empty-state" style={{ marginTop: 64 }}>
          <p style={{ fontWeight: 600, marginBottom: 8 }}>{t('pages.taskDetail.notFound')}</p>
          <p className="text-muted text-sm">{t('pages.taskDetail.notFoundHint')}</p>
        </div>
      </main>
    </>
  );

  const steps = [...(task.stepInstances ?? [])].sort((a, b) => (a.stepDefinition?.order ?? 0) - (b.stepDefinition?.order ?? 0));

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.tasks'), href: '/tasks' }, { label: `${task.taskType?.name ?? 'Task'} — ${task.brand?.brandName ?? ''}` }]} />
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
          <div className="card-header"><span className="card-title">{t('pages.taskDetail.cardSteps')}</span></div>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>{t('pages.taskDetail.colNum')}</th>
                  <th>{t('pages.taskDetail.colStep')}</th>
                  <th>{t('pages.taskDetail.colType')}</th>
                  <th>{t('pages.taskDetail.colAssignedTo')}</th>
                  <th>{t('pages.taskDetail.colStatus')}</th>
                  <th>{t('pages.taskDetail.colNote')}</th>
                  <th></th>
                </tr>
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
                      {canManualAssign && s.stepDefinition?.assignmentStrategy === 'manual' && s.status === 'pending' && !s.assignedToId && (
                        manualAssignStep === s.id ? (
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                            <select className="form-select" style={{ fontSize: '0.8rem', padding: '3px 8px', height: 'auto' }}
                              value={manualAssignBpo} onChange={e => setManualAssignBpo(e.target.value)}>
                              <option value="">{t('pages.taskDetail.selectBpo')}</option>
                              {bpoAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                            </select>
                            <button className="btn btn-sm btn-primary" disabled={!manualAssignBpo || saving}
                              onClick={() => handleManualAssign(s.id)}>
                              {t('common.assign')}
                            </button>
                            <button className="btn btn-sm btn-ghost" onClick={() => { setManualAssignStep(null); setManualAssignBpo(''); }}>
                              {t('common.cancel')}
                            </button>
                          </div>
                        ) : (
                          <button className="btn btn-sm btn-ghost" onClick={() => { setManualAssignStep(s.id); setManualAssignBpo(''); }}>
                            {t('pages.taskDetail.assignBpo')}
                          </button>
                        )
                      )}
                      {canActOnStep && s.status === 'pending' && s.stepDefinition?.executionType !== 'automatic' &&
                        !(s.stepDefinition?.assignmentStrategy === 'manual' && !s.assignedToId) &&
                        (s.assignedToId === account?.id || roles.some(r => r === 'admin' || r === 'super_admin')) && (
                        <button
                          className="btn btn-sm btn-primary"
                          style={{ gap: 5 }}
                          disabled={saving}
                          onClick={() => handleStart(s)}
                        >
                          <PlayIcon /> {t('pages.taskDetail.startReview')}
                        </button>
                      )}
                      {canActOnStep && s.status === 'in_progress' && s.stepDefinition?.executionType !== 'automatic' && (
                        <div className="flex gap-2">
                          <button className="btn btn-sm btn-primary" title={t('pages.taskDetail.btnComplete')}
                            onClick={() => { setActiveStep(s); setAction('complete'); }}>
                            <CheckIcon />
                          </button>
                          <button className="btn btn-sm btn-ghost" title={t('pages.taskDetail.btnBlock')}
                            onClick={() => { setActiveStep(s); setAction('block'); }}>
                            <AlertIcon />
                          </button>
                          <button className="btn btn-sm btn-danger" title={t('pages.taskDetail.btnFail')}
                            onClick={() => { setActiveStep(s); setAction('fail'); }}>
                            <XIcon />
                          </button>
                        </div>
                      )}
                      {canActOnStep && s.status === 'blocked' && (
                        <div className="flex gap-2">
                          <button className="btn btn-sm btn-primary" title={t('pages.taskDetail.retry')}
                            onClick={() => handleRetry(s)}>
                            <RefreshIcon /> {t('pages.taskDetail.retry')}
                          </button>
                          <button className="btn btn-sm btn-danger" title={t('pages.taskDetail.btnFail')}
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

        {task.formValues && task.formValues.length > 0 && (
          <div className="card mt-2">
            <div className="card-header"><span className="card-title">{t('pages.taskDetail.cardFormInputs')}</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: '0 16px 16px' }}>
              {task.formValues.map((fv) => (
                <div key={fv.id}>
                  <div className="text-sm text-muted">{fv.formField?.label ?? fv.formFieldId}</div>
                  <div style={{ fontWeight: 500, marginTop: 2 }}>{formValueDisplay(fv)}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="card mt-2" style={{ background: 'var(--surface-2)' }}>
          <div className="card-header"><span className="card-title">{t('pages.taskDetail.cardDetails')}</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div className="text-sm text-muted">{t('pages.taskDetail.createdBy')}</div>
              <div style={{ fontWeight: 500 }}>{task.createdBy?.name ?? '—'}</div>
            </div>
            <div>
              <div className="text-sm text-muted">{t('pages.taskDetail.createdAt')}</div>
              <div>{new Date(task.createdAt).toLocaleString()}</div>
            </div>
            {task.scheduledStart && (
              <>
                <div>
                  <div className="text-sm text-muted">{t('pages.taskDetail.scheduledStart')}</div>
                  <div>{new Date(task.scheduledStart).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-sm text-muted">{t('pages.taskDetail.scheduledEnd')}</div>
                  <div>{task.scheduledEnd ? new Date(task.scheduledEnd).toLocaleString() : '—'}</div>
                </div>
              </>
            )}
          </div>
        </div>
      </main>

      {action && activeStep && (
        <Modal
          title={action === 'complete' ? t('pages.taskDetail.modalCompleteStep') : action === 'block' ? t('pages.taskDetail.modalBlockStep') : t('pages.taskDetail.modalFailStep')}
          onClose={() => { setAction(null); setActiveStep(null); setNote(''); setErr(''); }}
          footer={<>
            <button className="btn btn-ghost" onClick={() => { setAction(null); setActiveStep(null); }}>{t('common.cancel')}</button>
            <button
              className={`btn ${action === 'fail' ? 'btn-danger' : action === 'block' ? 'btn-ghost' : 'btn-primary'}`}
              onClick={handleAction} disabled={saving}
            >
              {saving ? t('common.saving') : action === 'complete' ? t('pages.taskDetail.btnComplete') : action === 'block' ? t('pages.taskDetail.btnBlock') : t('pages.taskDetail.btnFail')}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          {action === 'fail' && (
            <div className="form-group">
              <label className="form-label">{t('pages.taskDetail.failureReasonLabel')}</label>
              <select className="form-select" value={failureReason} onChange={e => setFailureReason(e.target.value)}>
                <option value="bpo_timed_out">{t('pages.taskDetail.failBpoTimedOut')}</option>
                <option value="no_bpo">{t('pages.taskDetail.failNoBpo')}</option>
                <option value="error_handler">{t('pages.taskDetail.failHandlerError')}</option>
                <option value="system_timed_out">{t('pages.taskDetail.failSystemTimedOut')}</option>
              </select>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">{action !== 'fail' ? t('pages.taskDetail.noteOptional') : t('pages.taskDetail.noteLabel')}</label>
            <textarea className="form-textarea" placeholder={t('pages.taskDetail.notePlaceholder')} value={note} onChange={e => setNote(e.target.value)} />
          </div>
        </Modal>
      )}
    </>
  );
}
