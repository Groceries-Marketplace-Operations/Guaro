import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import { taskTypesApi, handlersApi, webhooksApi, accountsApi } from '../../api';
import type { TaskType, StepDefinition, ExecutionType, AssignmentStrategy, Handler, Webhook, WebhookEvent, Account } from '../../types';

const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);

const XIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="12" height="12">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

const EXECUTION_TYPES: ExecutionType[] = ['manual_internal', 'manual_external', 'automatic'];
const STRATEGIES: AssignmentStrategy[] = ['fixed', 'round_robin', 'by_weight'];
const WH_EVENTS: WebhookEvent[] = ['on_start', 'on_complete', 'on_fail'];
const FIELD_TYPES = ['texto', 'numero', 'link', 'link_spreadsheet', 'select', 'select_brand', 'select_store'];

function execLabel(t: ExecutionType) {
  return t === 'manual_internal' ? 'Manual Internal' : t === 'manual_external' ? 'Manual External' : 'Automatic';
}
function execColor(t: ExecutionType) {
  if (t === 'automatic') return { bg: 'var(--blue-bg)', color: 'var(--blue)' };
  if (t === 'manual_external') return { bg: 'var(--amber-bg)', color: '#B54708' };
  return { bg: 'var(--green-bg)', color: '#027A48' };
}

type ApiError = { response?: { data?: { message?: string | string[] } } };

function errMsg(ex: unknown) {
  const e = ex as ApiError;
  const msg = e.response?.data?.message;
  return Array.isArray(msg) ? msg.join(', ') : (msg ?? 'Unexpected error');
}

export default function TaskTypeDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  // Modal open state
  const [openStep, setOpenStep] = useState(false);
  const [openField, setOpenField] = useState(false);
  const [openWebhook, setOpenWebhook] = useState<StepDefinition | null>(null);
  const [openBpos, setOpenBpos] = useState<StepDefinition | null>(null);

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // Drag-and-drop for steps
  const [stepDragIndex, setStepDragIndex] = useState<number | null>(null);
  const [stepDragOver, setStepDragOver] = useState<number | null>(null);
  // Drag-and-drop for fields
  const [fieldDragIndex, setFieldDragIndex] = useState<number | null>(null);
  const [fieldDragOver, setFieldDragOver] = useState<number | null>(null);

  // Step form
  const [stepForm, setStepForm] = useState({
    name: '',
    order: 1,
    executionType: 'manual_internal' as ExecutionType,
    assignmentStrategy: 'round_robin' as AssignmentStrategy,
    handlerId: '',
  });

  // Field form — uses `type` (English) which maps to `tipo` in Prisma via the DTO
  const [fieldForm, setFieldForm] = useState({
    label: '',
    type: 'text',
    required: true,
    multiple: false,
    order: 1,
    options: [] as string[],
    filteredById: '',
  });
  const [optionInput, setOptionInput] = useState('');

  // Webhook form
  const [whForm, setWhForm] = useState({ webhookId: '', events: [] as WebhookEvent[] });

  // BPO candidate picker
  const [candidateId, setCandidateId] = useState('');

  const { data: tt } = useQuery<TaskType>({ queryKey: ['task-type', id], queryFn: () => taskTypesApi.get(id!).then(r => r.data) });
  const { data: handlers = [] } = useQuery<Handler[]>({ queryKey: ['handlers'], queryFn: () => handlersApi.list().then(r => r.data) });
  const { data: webhooks = [] } = useQuery<Webhook[]>({ queryKey: ['webhooks'], queryFn: () => webhooksApi.list().then(r => r.data) });
  const { data: bpoAccounts = [] } = useQuery<Account[]>({
    queryKey: ['accounts', 'bpo'],
    queryFn: () => accountsApi.list('bpo').then(r => r.data),
    enabled: !!openBpos,
  });

  const steps = [...(tt?.stepDefinitions ?? [])].sort((a, b) => a.order - b.order);
  const fields = [...(tt?.formFields ?? [])].sort((a, b) => a.order - b.order);
  // select_brand fields available for filteredById on select_store fields
  const brandFields = fields.filter(f => f.tipo === 'select_brand');

  const addStep = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      await taskTypesApi.addStep(id!, { ...stepForm, handlerId: stepForm.handlerId || undefined });
      qc.invalidateQueries({ queryKey: ['task-type', id] });
      setOpenStep(false);
      setStepForm({ name: '', order: steps.length + 2, executionType: 'manual_internal', assignmentStrategy: 'round_robin', handlerId: '' });
    } catch (ex) { setErr(errMsg(ex)); } finally { setSaving(false); }
  };

  const addField = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      const payload: Record<string, unknown> = {
        label: fieldForm.label,
        type: fieldForm.type,
        required: fieldForm.required,
        order: fieldForm.order,
      };
      if (fieldForm.type === 'select') {
        payload.options = fieldForm.options;
        payload.multiple = fieldForm.multiple;
      }
      if (fieldForm.type === 'shop' && fieldForm.filteredById) {
        payload.filteredById = fieldForm.filteredById;
      }
      await taskTypesApi.addField(id!, payload);
      qc.invalidateQueries({ queryKey: ['task-type', id] });
      setOpenField(false);
      setFieldForm({ label: '', type: 'text', required: true, multiple: false, order: fields.length + 2, options: [], filteredById: '' });
      setOptionInput('');
    } catch (ex) { setErr(errMsg(ex)); } finally { setSaving(false); }
  };

  const addWebhook = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    if (!openWebhook) return;
    try {
      await taskTypesApi.addWebhook(id!, openWebhook.id, whForm);
      qc.invalidateQueries({ queryKey: ['task-type', id] });
      setOpenWebhook(null);
    } catch (ex) { setErr(errMsg(ex)); } finally { setSaving(false); }
  };

  const addCandidate = async () => {
    if (!openBpos || !candidateId) return;
    setSaving(true); setErr('');
    try {
      await taskTypesApi.addCandidate(id!, openBpos.id, candidateId);
      qc.invalidateQueries({ queryKey: ['task-type', id] });
      setCandidateId('');
      // Re-fetch step detail in openBpos from fresh data
    } catch (ex) { setErr(errMsg(ex)); } finally { setSaving(false); }
  };

  const removeCandidate = async (accountId: string) => {
    if (!openBpos) return;
    setSaving(true); setErr('');
    try {
      await taskTypesApi.removeCandidate(id!, openBpos.id, accountId);
      qc.invalidateQueries({ queryKey: ['task-type', id] });
    } catch (ex) { setErr(errMsg(ex)); } finally { setSaving(false); }
  };

  const addOption = () => {
    const val = optionInput.trim();
    if (!val || fieldForm.options.includes(val)) return;
    setFieldForm(f => ({ ...f, options: [...f.options, val] }));
    setOptionInput('');
  };

  const removeOption = (opt: string) => {
    setFieldForm(f => ({ ...f, options: f.options.filter(o => o !== opt) }));
  };

  const dropStep = async (toIndex: number) => {
    if (stepDragIndex === null || stepDragIndex === toIndex) {
      setStepDragIndex(null); setStepDragOver(null); return;
    }
    const reordered = [...steps];
    const [moved] = reordered.splice(stepDragIndex, 1);
    reordered.splice(toIndex, 0, moved);
    const updates = reordered
      .map((s, i) => ({ id: s.id, newOrder: i + 1, oldOrder: s.order }))
      .filter(u => u.newOrder !== u.oldOrder);
    setStepDragIndex(null); setStepDragOver(null);
    await Promise.all(updates.map(u => taskTypesApi.updateStep(id!, u.id, { order: u.newOrder })));
    qc.invalidateQueries({ queryKey: ['task-type', id] });
  };

  const dropField = async (toIndex: number) => {
    if (fieldDragIndex === null || fieldDragIndex === toIndex) {
      setFieldDragIndex(null); setFieldDragOver(null); return;
    }
    const reordered = [...fields];
    const [moved] = reordered.splice(fieldDragIndex, 1);
    reordered.splice(toIndex, 0, moved);
    const updates = reordered
      .map((f, i) => ({ id: f.id, newOrder: i + 1, oldOrder: f.order }))
      .filter(u => u.newOrder !== u.oldOrder);
    setFieldDragIndex(null); setFieldDragOver(null);
    await Promise.all(updates.map(u => taskTypesApi.updateField(id!, u.id, { order: u.newOrder })));
    qc.invalidateQueries({ queryKey: ['task-type', id] });
  };

  const deleteStep = async (stepId: string) => {
    await taskTypesApi.deleteStep(id!, stepId);
    qc.invalidateQueries({ queryKey: ['task-type', id] });
  };

  const deleteField = async (fieldId: string) => {
    await taskTypesApi.deleteField(id!, fieldId);
    qc.invalidateQueries({ queryKey: ['task-type', id] });
  };

  const toggleEvent = (ev: WebhookEvent) => {
    setWhForm(f => ({
      ...f,
      events: f.events.includes(ev) ? f.events.filter(e => e !== ev) : [...f.events, ev],
    }));
  };

  // Get the live step data from tt (updated after mutations)
  const liveStep = openBpos ? (tt?.stepDefinitions ?? []).find(s => s.id === openBpos.id) ?? openBpos : null;
  const existingCandidateIds = new Set((liveStep?.candidates ?? []).map(c => c.account.id));
  const availableBpos = bpoAccounts.filter(a => !existingCandidateIds.has(a.id));

  if (!tt) return null;

  return (
    <>
      <Topbar breadcrumb={[{ label: 'Task Types', href: '/task-types' }, { label: tt.name }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{tt.name}</h1>
            <p>{tt.description ?? ''}{tt.section ? ` · ${tt.section.name}` : ''}</p>
          </div>
          <div className="page-actions">
            {tt.schedulable && (
              <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '4px 10px', borderRadius: 999, background: 'var(--blue-bg)', color: 'var(--blue)' }}>
                Schedulable
              </span>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {/* Steps */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Steps ({steps.length})</span>
              <button className="btn btn-primary btn-sm" onClick={() => { setStepForm(f => ({ ...f, order: steps.length + 1 })); setErr(''); setOpenStep(true); }}>
                <PlusIcon /> Add Step
              </button>
            </div>
            {steps.length === 0 ? (
              <p className="text-muted text-sm">No steps yet. Steps define the sequence of actions in this workflow.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {steps.map((s, i) => {
                  const col = execColor(s.executionType);
                  const isManual = s.executionType !== 'automatic';
                  const isDragging = stepDragIndex === i;
                  const isOver = stepDragOver === i && stepDragIndex !== i;
                  return (
                    <div key={s.id}
                      draggable
                      onDragStart={() => setStepDragIndex(i)}
                      onDragOver={e => { e.preventDefault(); setStepDragOver(i); }}
                      onDragLeave={() => setStepDragOver(null)}
                      onDrop={() => dropStep(i)}
                      onDragEnd={() => { setStepDragIndex(null); setStepDragOver(null); }}
                      style={{
                        padding: '10px 12px', borderRadius: 8,
                        background: isDragging ? 'var(--orange-muted)' : 'var(--surface-2)',
                        border: isOver ? '2px solid var(--orange)' : isDragging ? '1px dashed var(--orange)' : '1px solid var(--border)',
                        opacity: isDragging ? 0.5 : 1,
                        cursor: 'grab',
                        transition: 'border-color 0.1s, background 0.1s',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        {/* Drag handle + step number */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                          <svg viewBox="0 0 10 16" width="10" height="16" fill="var(--border)" style={{ pointerEvents: 'none' }}>
                            <circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/>
                            <circle cx="3" cy="8" r="1.2"/><circle cx="7" cy="8" r="1.2"/>
                            <circle cx="3" cy="13" r="1.2"/><circle cx="7" cy="13" r="1.2"/>
                          </svg>
                          <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--orange-muted)', color: 'var(--orange)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 700 }}>
                            {i + 1}
                          </div>
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{s.name}</div>
                          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                            <span style={{ ...col, fontSize: '0.68rem', fontWeight: 700, padding: '1px 7px', borderRadius: 999 }}>{execLabel(s.executionType)}</span>
                            <span style={{ fontSize: '0.68rem', fontWeight: 600, padding: '1px 7px', borderRadius: 999, background: '#F0F0F0', color: 'var(--text-secondary)' }}>{s.assignmentStrategy}</span>
                            {s.handler && <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{s.handler.name}</span>}
                          </div>
                          {isManual && (s.candidates?.length ?? 0) > 0 && (
                            <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                              {(s.candidates ?? []).map(c => (
                                <span key={c.account.id} style={{ fontSize: '0.67rem', padding: '1px 7px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                                  {c.account.name}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                          {isManual && (
                            <button className="btn btn-ghost btn-sm" onClick={() => { setErr(''); setCandidateId(''); setOpenBpos(s); }}>
                              + BPOs {(s.candidates?.length ?? 0) > 0 ? `(${s.candidates!.length})` : ''}
                            </button>
                          )}
                          <button className="btn btn-ghost btn-sm" onClick={() => { setErr(''); setOpenWebhook(s); setWhForm({ webhookId: '', events: [] }); }}>
                            + Webhook
                          </button>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => deleteStep(s.id)}>
                            <XIcon />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Form Fields */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Form Fields ({fields.length})</span>
              <button className="btn btn-primary btn-sm" onClick={() => { setFieldForm(f => ({ ...f, order: fields.length + 1 })); setErr(''); setOpenField(true); }}>
                <PlusIcon /> Add Field
              </button>
            </div>
            {fields.length === 0 ? (
              <p className="text-muted text-sm">No fields yet. Form fields collect information when a task is created.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {fields.map((f, i) => {
                  const isDragging = fieldDragIndex === i;
                  const isOver = fieldDragOver === i && fieldDragIndex !== i;
                  return (
                    <div key={f.id}
                      draggable
                      onDragStart={() => setFieldDragIndex(i)}
                      onDragOver={e => { e.preventDefault(); setFieldDragOver(i); }}
                      onDragLeave={() => setFieldDragOver(null)}
                      onDrop={() => dropField(i)}
                      onDragEnd={() => { setFieldDragIndex(null); setFieldDragOver(null); }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 10px', borderRadius: 8,
                        background: isDragging ? 'var(--orange-muted)' : 'var(--surface-2)',
                        border: isOver
                          ? '2px solid var(--orange)'
                          : isDragging
                            ? '1px dashed var(--orange)'
                            : '1px solid var(--border)',
                        opacity: isDragging ? 0.5 : 1,
                        cursor: 'grab',
                        transition: 'border-color 0.1s, background 0.1s',
                      }}
                    >
                      {/* Drag handle */}
                      <svg viewBox="0 0 10 16" width="10" height="16" fill="var(--border)" style={{ flexShrink: 0, pointerEvents: 'none' }}>
                        <circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/>
                        <circle cx="3" cy="8" r="1.2"/><circle cx="7" cy="8" r="1.2"/>
                        <circle cx="3" cy="13" r="1.2"/><circle cx="7" cy="13" r="1.2"/>
                      </svg>
                      <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.72rem', minWidth: 14 }}>{i + 1}</span>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontWeight: 600, fontSize: '0.83rem' }}>{f.label}</span>
                        <span style={{ marginLeft: 6, fontSize: '0.72rem', color: 'var(--text-muted)' }}>{f.tipo}</span>
                        {f.options && f.options.length > 0 && (
                          <span style={{ marginLeft: 6, fontSize: '0.67rem', color: 'var(--text-muted)' }}>({f.options.join(', ')})</span>
                        )}
                      </div>
                      {f.required && <span style={{ fontSize: '0.65rem', fontWeight: 700, background: 'var(--red-bg)', color: 'var(--red)', padding: '1px 6px', borderRadius: 999, flexShrink: 0 }}>req</span>}
                      <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--red)', flexShrink: 0 }} onClick={() => deleteField(f.id)}>
                        <XIcon />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Add Step Modal */}
      {openStep && (
        <Modal title="Add Step" onClose={() => setOpenStep(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenStep(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={addStep} disabled={saving}>{saving ? 'Adding…' : 'Add Step'}</button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">Step Name</label>
            <input className="form-input" placeholder="Review credentials" value={stepForm.name}
              onChange={e => setStepForm(f => ({ ...f, name: e.target.value }))} required autoFocus />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Order</label>
              <input className="form-input" type="number" min={1} value={stepForm.order}
                onChange={e => setStepForm(f => ({ ...f, order: parseInt(e.target.value) }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Execution Type</label>
              <select className="form-select" value={stepForm.executionType}
                onChange={e => setStepForm(f => ({ ...f, executionType: e.target.value as ExecutionType, handlerId: '' }))}>
                {EXECUTION_TYPES.map(t => <option key={t} value={t}>{execLabel(t)}</option>)}
              </select>
            </div>
          </div>
          {stepForm.executionType !== 'automatic' && (
            <div className="form-group">
              <label className="form-label">Assignment Strategy</label>
              <select className="form-select" value={stepForm.assignmentStrategy}
                onChange={e => setStepForm(f => ({ ...f, assignmentStrategy: e.target.value as AssignmentStrategy }))}>
                {STRATEGIES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
              <p className="form-hint">
                {stepForm.assignmentStrategy === 'fixed' ? 'One specific BPO is always assigned.' : ''}
                {stepForm.assignmentStrategy === 'round_robin' ? 'Assigns to BPOs in rotation from the candidate pool.' : ''}
                {stepForm.assignmentStrategy === 'by_weight' ? 'Assigns to the least-loaded BPO in the candidate pool.' : ''}
                {' '}You can add BPOs to the candidate pool after saving.
              </p>
            </div>
          )}
          {stepForm.executionType === 'automatic' && (
            <div className="form-group">
              <label className="form-label">Handler</label>
              <select className="form-select" value={stepForm.handlerId}
                onChange={e => setStepForm(f => ({ ...f, handlerId: e.target.value }))}>
                <option value="">Select handler…</option>
                {handlers.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </div>
          )}
        </Modal>
      )}

      {/* Manage BPO Candidates Modal */}
      {openBpos && liveStep && (
        <Modal title={`BPO Candidates — ${liveStep.name}`} onClose={() => setOpenBpos(null)}
          footer={<button className="btn btn-ghost" onClick={() => setOpenBpos(null)}>Close</button>}
        >
          {err && <div className="error-banner">{err}</div>}

          <p className="form-hint" style={{ marginBottom: 12 }}>
            Strategy: <strong>{liveStep.assignmentStrategy.replace('_', ' ')}</strong>
            {liveStep.assignmentStrategy === 'fixed' ? ' — first candidate in the list is used.' : '.'}
          </p>

          {/* Current candidates */}
          <div style={{ marginBottom: 16 }}>
            <label className="form-label">Current pool</label>
            {(liveStep.candidates?.length ?? 0) === 0 ? (
              <p className="text-muted text-sm">No BPOs added yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(liveStep.candidates ?? []).map(c => (
                  <div key={c.account.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--surface-2)', borderRadius: 6, border: '1px solid var(--border)' }}>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontWeight: 600, fontSize: '0.83rem' }}>{c.account.name}</span>
                      <span style={{ marginLeft: 6, fontSize: '0.72rem', color: 'var(--text-muted)' }}>{c.account.email}</span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--red)', padding: '2px 6px' }}
                      onClick={() => removeCandidate(c.account.id)}
                      disabled={saving}
                    >
                      <XIcon />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add BPO */}
          <div className="form-group">
            <label className="form-label">Add BPO</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select className="form-select" value={candidateId} onChange={e => setCandidateId(e.target.value)} style={{ flex: 1 }}>
                <option value="">Select account…</option>
                {availableBpos.map(a => (
                  <option key={a.id} value={a.id}>{a.name} — {a.email}</option>
                ))}
              </select>
              <button className="btn btn-primary btn-sm" onClick={addCandidate} disabled={!candidateId || saving}>
                Add
              </button>
            </div>
            {availableBpos.length === 0 && bpoAccounts.length > 0 && (
              <p className="form-hint">All BPO accounts are already in the pool.</p>
            )}
          </div>
        </Modal>
      )}

      {/* Add Form Field Modal */}
      {openField && (
        <Modal title="Add Form Field" onClose={() => setOpenField(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenField(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={addField} disabled={saving}>{saving ? 'Adding…' : 'Add Field'}</button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">Label</label>
            <input className="form-input" placeholder="Contract URL" value={fieldForm.label}
              onChange={e => setFieldForm(f => ({ ...f, label: e.target.value }))} required autoFocus />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Type</label>
              <select className="form-select" value={fieldForm.type}
                onChange={e => setFieldForm(f => ({ ...f, type: e.target.value, options: [], filteredById: '' }))}>
                {FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Order</label>
              <input className="form-input" type="number" min={1} value={fieldForm.order}
                onChange={e => setFieldForm(f => ({ ...f, order: parseInt(e.target.value) }))} />
            </div>
          </div>
          <div className="form-check" style={{ marginBottom: 12 }}>
            <input type="checkbox" id="req" checked={fieldForm.required}
              onChange={e => setFieldForm(f => ({ ...f, required: e.target.checked }))} />
            <label htmlFor="req" style={{ fontSize: '0.83rem', cursor: 'pointer' }}>Required</label>
          </div>

          {/* Select-specific options */}
          {fieldForm.type === 'select' && (
            <>
              <div className="form-check" style={{ marginBottom: 12 }}>
                <input type="checkbox" id="multiple" checked={fieldForm.multiple}
                  onChange={e => setFieldForm(f => ({ ...f, multiple: e.target.checked }))} />
                <label htmlFor="multiple" style={{ fontSize: '0.83rem', cursor: 'pointer' }}>Allow multiple selection</label>
              </div>

              <div className="form-group">
                <label className="form-label">Options</label>
                {fieldForm.options.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    {fieldForm.options.map(opt => (
                      <span key={opt} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.78rem', padding: '2px 8px', borderRadius: 999, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                        {opt}
                        <button type="button" onClick={() => removeOption(opt)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0, color: 'var(--text-muted)' }}>
                          <XIcon />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="form-input" placeholder="Add option…" value={optionInput}
                    onChange={e => setOptionInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addOption(); } }}
                    style={{ flex: 1 }} />
                  <button type="button" className="btn btn-ghost btn-sm" onClick={addOption} disabled={!optionInput.trim()}>
                    Add
                  </button>
                </div>
                <p className="form-hint">Press Enter or click Add. Options appear as a dropdown when filling the task form.</p>
              </div>
            </>
          )}

          {/* select_store — filteredById */}
          {fieldForm.type === 'select_store' && brandFields.length > 0 && (
            <div className="form-group">
              <label className="form-label">Filter stores by brand field</label>
              <select className="form-select" value={fieldForm.filteredById}
                onChange={e => setFieldForm(f => ({ ...f, filteredById: e.target.value }))}>
                <option value="">No filter (show all stores)</option>
                {brandFields.map(bf => <option key={bf.id} value={bf.id}>{bf.label}</option>)}
              </select>
              <p className="form-hint">If set, the store picker will only show stores belonging to the brand chosen in the linked field.</p>
            </div>
          )}

          {/* Info for brand/store picker fields */}
          {(fieldForm.type === 'select_brand' || fieldForm.type === 'select_store') && (
            <div style={{ padding: '8px 12px', borderRadius: 6, background: 'var(--blue-bg)', border: '1px solid var(--blue)', fontSize: '0.78rem', color: 'var(--blue)' }}>
              <strong>{fieldForm.type === 'select_brand' ? 'Brand' : 'Store'} picker</strong> — when someone fills this task, the field renders a live {fieldForm.type === 'select_brand' ? 'brand' : 'store'} dropdown populated from the database. No extra configuration needed here.
            </div>
          )}
        </Modal>
      )}

      {/* Add Webhook to Step Modal */}
      {openWebhook && (
        <Modal title={`Add Webhook to "${openWebhook.name}"`} onClose={() => setOpenWebhook(null)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenWebhook(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={addWebhook} disabled={saving || !whForm.webhookId || whForm.events.length === 0}>
              {saving ? 'Adding…' : 'Add Webhook'}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">Webhook</label>
            <select className="form-select" value={whForm.webhookId} onChange={e => setWhForm(f => ({ ...f, webhookId: e.target.value }))}>
              <option value="">Select webhook…</option>
              {webhooks.map(w => <option key={w.id} value={w.id}>{w.name} {w.isAlerts ? '(alerts)' : ''}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Fire on events</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {WH_EVENTS.map(ev => (
                <button key={ev} type="button"
                  className={`btn btn-sm ${whForm.events.includes(ev) ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => toggleEvent(ev)}
                >
                  {ev.replace('on_', 'on ')}
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
