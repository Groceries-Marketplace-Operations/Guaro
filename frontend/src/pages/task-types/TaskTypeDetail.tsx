import { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import { taskTypesApi, handlersApi, webhooksApi, accountsApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useT } from '../../i18n';
import type { TaskType, StepDefinition, FormField, ExecutionType, AssignmentStrategy, Handler, Webhook, WebhookEvent, Account } from '../../types';

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

const EditIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);

const EXECUTION_TYPES: ExecutionType[] = ['manual_internal', 'manual_external', 'automatic'];
const STRATEGIES: AssignmentStrategy[] = ['fixed', 'round_robin', 'brand_assignment', 'by_weight', 'manual'];
const TIPO_OPTIONS = [
  { v: 'link',  l: 'Link (URL)' },
  { v: 'xlsx',  l: 'Excel (.xlsx)' },
  { v: 'csv',   l: 'CSV (.csv)' },
  { v: 'docx',  l: 'Word (.docx)' },
  { v: 'pdf',   l: 'PDF (.pdf)' },
];
const FILE_TIPOS = ['xlsx', 'csv', 'docx', 'pdf'];
const FILE_ACCEPT = '.xlsx,.csv,.docx,.pdf';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const WH_EVENTS: WebhookEvent[] = ['on_assignment', 'on_start', 'on_complete', 'on_fail'];
const FIELD_TYPES = ['texto', 'numero', 'link', 'link_spreadsheet', 'select', 'select_brand', 'select_store', 'select_ka_type', 'select_country'];

function execLabel(et: ExecutionType) {
  return et === 'manual_internal' ? 'Manual Internal' : et === 'manual_external' ? 'Manual External' : 'Automatic';
}
function execColor(et: ExecutionType) {
  if (et === 'automatic') return { bg: 'var(--blue-bg)', color: 'var(--blue)' };
  if (et === 'manual_external') return { bg: 'var(--amber-bg)', color: '#B54708' };
  return { bg: 'var(--green-bg)', color: '#027A48' };
}

type ApiError = { response?: { data?: { message?: string | string[] } } };

function errMsg(ex: unknown) {
  const e = ex as ApiError;
  const msg = e.response?.data?.message;
  return Array.isArray(msg) ? msg.join(', ') : (msg ?? 'Unexpected error');
}

const EMPTY_STEP_FORM = { name: '', order: 1, executionType: 'manual_internal' as ExecutionType, assignmentStrategy: 'round_robin' as AssignmentStrategy, handlerId: '' };
const EMPTY_FIELD_FORM = { label: '', type: 'texto', required: true, multiple: false, order: 1, options: [] as string[], filteredById: '' };

export default function TaskTypeDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { account } = useAuth();
  const t = useT();
  const isAdmin = account?.roles.includes('admin') ?? false;
  const isSA    = account?.roles.includes('super_admin') ?? false;
  const canDelete = isAdmin || isSA;

  // Modal open state
  const [openStep, setOpenStep] = useState(false);
  const [stepToEdit, setStepToEdit] = useState<StepDefinition | null>(null);

  const [openField, setOpenField] = useState(false);
  const [fieldToEdit, setFieldToEdit] = useState<FormField | null>(null);

  const [openWebhook, setOpenWebhook] = useState<StepDefinition | null>(null);
  const [openBpos, setOpenBpos] = useState<StepDefinition | null>(null);

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // Edit task type header
  const [openEditTT, setOpenEditTT] = useState(false);
  const [ttForm, setTtForm] = useState({ name: '', description: '', schedulable: false });

  const openEditTaskType = () => {
    if (!tt) return;
    setTtForm({ name: tt.name, description: tt.description ?? '', schedulable: tt.schedulable });
    setOpenEditTT(true);
  };
  const deleteTaskType = async () => {
    if (!tt) return;
    if (!window.confirm(t('pages.taskTypeDetail.deleteConfirm').replace('{name}', tt.name))) return;
    try {
      await taskTypesApi.delete(id!);
      qc.invalidateQueries({ queryKey: ['task-types'] });
      nav('/task-types', { replace: true });
    } catch { /* backend returns 403 if not in section */ }
  };

  const saveTaskType = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setErr('');
    try {
      await taskTypesApi.update(id!, ttForm);
      qc.invalidateQueries({ queryKey: ['task-type', id] });
      qc.invalidateQueries({ queryKey: ['task-types'] });
      setOpenEditTT(false);
    } catch (ex) { setErr(errMsg(ex)); }
    finally { setSaving(false); }
  };

  // Drag-and-drop for steps
  const [stepDragIndex, setStepDragIndex] = useState<number | null>(null);
  const [stepDragOver, setStepDragOver] = useState<number | null>(null);
  const stepDragRef = useRef<number | null>(null);
  // Drag-and-drop for fields
  const [fieldDragIndex, setFieldDragIndex] = useState<number | null>(null);
  const [fieldDragOver, setFieldDragOver] = useState<number | null>(null);
  const fieldDragRef = useRef<number | null>(null);

  // Templates
  const [addingTemplate, setAddingTemplate] = useState(false);
  const [templateForm, setTemplateForm] = useState({ name: '', url: '', tipo: 'link' });
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [templateFileErr, setTemplateFileErr] = useState('');

  const [stepForm, setStepForm] = useState(EMPTY_STEP_FORM);
  const [fieldForm, setFieldForm] = useState(EMPTY_FIELD_FORM);
  const [optionInput, setOptionInput] = useState('');

  // Webhook form
  const [whForm, setWhForm] = useState({ webhookId: '', events: [] as WebhookEvent[] });

  // BPO candidate picker
  const [candidateId, setCandidateId] = useState('');

  const { data: tt } = useQuery<TaskType>({ queryKey: ['task-type', id], queryFn: () => taskTypesApi.get(id!).then(r => r.data) });
  const { data: handlers = [] } = useQuery<Handler[]>({ queryKey: ['handlers'], queryFn: () => handlersApi.list().then(r => r.data) });
  const { data: webhooks = [] } = useQuery<Webhook[]>({ queryKey: ['webhooks'], queryFn: () => webhooksApi.list().then(r => r.data) });
  const { data: bpoAccountsResult } = useQuery<{ data: Account[] }>({
    queryKey: ['accounts', 'bpo'],
    queryFn: () => accountsApi.list({ role: 'bpo', limit: 200 }).then(r => r.data as { data: Account[] }),
    enabled: !!openBpos,
  });
  const bpoAccounts: Account[] = bpoAccountsResult?.data ?? [];

  const steps = [...(tt?.stepDefinitions ?? [])].sort((a, b) => a.order - b.order);
  const fields = [...(tt?.formFields ?? [])].sort((a, b) => a.order - b.order);
  const brandFields = fields.filter(f => f.tipo === 'select_brand');

  // ── Step handlers ──────────────────────────────────────────────────────────

  const openAddStep = () => {
    setStepToEdit(null);
    setStepForm({ ...EMPTY_STEP_FORM, order: steps.length + 1 });
    setErr('');
    setOpenStep(true);
  };

  const openEditStep = (s: StepDefinition) => {
    setStepToEdit(s);
    setStepForm({
      name: s.name,
      order: s.order,
      executionType: s.executionType,
      assignmentStrategy: s.assignmentStrategy,
      handlerId: s.handlerId ?? '',
    });
    setErr('');
    setOpenStep(true);
  };

  const closeStepModal = () => {
    setOpenStep(false);
    setStepToEdit(null);
  };

  const saveStep = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      const payload = { ...stepForm, handlerId: stepForm.handlerId || undefined };
      if (stepToEdit) {
        await taskTypesApi.updateStep(id!, stepToEdit.id, payload);
      } else {
        await taskTypesApi.addStep(id!, payload);
      }
      qc.invalidateQueries({ queryKey: ['task-type', id] });
      closeStepModal();
    } catch (ex) { setErr(errMsg(ex)); } finally { setSaving(false); }
  };

  const deleteStep = async (stepId: string) => {
    await taskTypesApi.deleteStep(id!, stepId);
    qc.invalidateQueries({ queryKey: ['task-type', id] });
  };

  // ── Field handlers ─────────────────────────────────────────────────────────

  const openAddField = () => {
    setFieldToEdit(null);
    setFieldForm({ ...EMPTY_FIELD_FORM, order: fields.length + 1 });
    setOptionInput('');
    setErr('');
    setOpenField(true);
  };

  const openEditField = (f: FormField) => {
    setFieldToEdit(f);
    setFieldForm({
      label: f.label,
      type: f.tipo,
      required: f.required,
      multiple: false,
      order: f.order,
      options: f.options ?? [],
      filteredById: '',
    });
    setOptionInput('');
    setErr('');
    setOpenField(true);
  };

  const closeFieldModal = () => {
    setOpenField(false);
    setFieldToEdit(null);
  };

  const saveField = async (e: React.FormEvent) => {
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
      if (fieldForm.type === 'select_store' && fieldForm.filteredById) {
        payload.filteredById = fieldForm.filteredById;
      }
      if (fieldToEdit) {
        await taskTypesApi.updateField(id!, fieldToEdit.id, payload);
      } else {
        await taskTypesApi.addField(id!, payload);
      }
      qc.invalidateQueries({ queryKey: ['task-type', id] });
      closeFieldModal();
    } catch (ex) { setErr(errMsg(ex)); } finally { setSaving(false); }
  };

  const deleteField = async (fieldId: string) => {
    await taskTypesApi.deleteField(id!, fieldId);
    qc.invalidateQueries({ queryKey: ['task-type', id] });
  };

  // ── Webhook / BPO handlers ─────────────────────────────────────────────────

  const addWebhook = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    if (!openWebhook) return;
    try {
      await taskTypesApi.addWebhook(id!, openWebhook.id, whForm);
      qc.invalidateQueries({ queryKey: ['task-type', id] });
      setOpenWebhook(null);
    } catch (ex) { setErr(errMsg(ex)); } finally { setSaving(false); }
  };

  const removeWebhook = async (stepId: string, stepWebhookId: string) => {
    try {
      await taskTypesApi.removeWebhook(id!, stepId, stepWebhookId);
      qc.invalidateQueries({ queryKey: ['task-type', id] });
    } catch (ex) { setErr(errMsg(ex)); }
  };

  const addCandidate = async () => {
    if (!openBpos || !candidateId) return;
    setSaving(true); setErr('');
    try {
      await taskTypesApi.addCandidate(id!, openBpos.id, candidateId);
      qc.invalidateQueries({ queryKey: ['task-type', id] });
      setCandidateId('');
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

  // ── Options helpers ────────────────────────────────────────────────────────

  const addOption = () => {
    const val = optionInput.trim();
    if (!val || fieldForm.options.includes(val)) return;
    setFieldForm(f => ({ ...f, options: [...f.options, val] }));
    setOptionInput('');
  };

  const removeOption = (opt: string) => {
    setFieldForm(f => ({ ...f, options: f.options.filter(o => o !== opt) }));
  };

  // ── Drag & drop ────────────────────────────────────────────────────────────

  const dropStep = async (toIndex: number) => {
    const fromIndex = stepDragRef.current;
    if (fromIndex === null || fromIndex === toIndex) {
      setStepDragIndex(null); setStepDragOver(null); stepDragRef.current = null; return;
    }
    const reordered = [...steps];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    const updates = reordered
      .map((s, i) => ({ id: s.id, newOrder: i + 1, oldOrder: s.order }))
      .filter(u => u.newOrder !== u.oldOrder);
    setStepDragIndex(null); setStepDragOver(null); stepDragRef.current = null;
    if (updates.length > 0) {
      await taskTypesApi.reorderSteps(id!, reordered.map((s, i) => ({ id: s.id, order: i + 1 })));
      qc.invalidateQueries({ queryKey: ['task-type', id] });
    }
  };

  const dropField = async (toIndex: number) => {
    const fromIndex = fieldDragRef.current;
    if (fromIndex === null || fromIndex === toIndex) {
      setFieldDragIndex(null); setFieldDragOver(null); fieldDragRef.current = null; return;
    }
    const reordered = [...fields];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    const updates = reordered
      .map((f, i) => ({ id: f.id, newOrder: i + 1, oldOrder: f.order }))
      .filter(u => u.newOrder !== u.oldOrder);
    setFieldDragIndex(null); setFieldDragOver(null); fieldDragRef.current = null;
    if (updates.length > 0) {
      await taskTypesApi.reorderFields(id!, reordered.map((f, i) => ({ id: f.id, order: i + 1 })));
      qc.invalidateQueries({ queryKey: ['task-type', id] });
    }
  };

  const toggleEvent = (ev: WebhookEvent) => {
    setWhForm(f => ({
      ...f,
      events: f.events.includes(ev) ? f.events.filter(e => e !== ev) : [...f.events, ev],
    }));
  };

  const liveStep = openBpos ? (tt?.stepDefinitions ?? []).find(s => s.id === openBpos.id) ?? openBpos : null;
  const existingCandidateIds = new Set((liveStep?.candidates ?? []).map(c => c.account.id));
  const availableBpos = bpoAccounts.filter(a => !existingCandidateIds.has(a.id));

  if (!tt) return null;

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.taskTypes'), href: '/task-types' }, { label: tt.name }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{tt.name}</h1>
            <p>{tt.description ?? ''}{tt.section ? ` · ${tt.section.name}` : ''}</p>
          </div>
          <div className="page-actions">
            {tt.schedulable && (
              <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '4px 10px', borderRadius: 999, background: 'var(--blue-bg)', color: 'var(--blue)' }}>
                {t('pages.taskTypeDetail.schedulable')}
              </span>
            )}
            {!tt.active && (
              <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '4px 10px', borderRadius: 999, background: 'rgba(180,40,40,0.12)', color: 'var(--red)' }}>
                {t('pages.taskTypeDetail.hidden')}
              </span>
            )}
            <button
              className={`btn btn-sm ${tt.active ? 'btn-ghost' : 'btn-primary'}`}
              onClick={async () => {
                await taskTypesApi.toggleActive(id!);
                qc.invalidateQueries({ queryKey: ['task-type', id] });
                qc.invalidateQueries({ queryKey: ['task-types'] });
              }}
            >
              {tt.active ? t('pages.taskTypeDetail.btnHide') : t('pages.taskTypeDetail.btnShow')}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={openEditTaskType}>
              <EditIcon /> {t('pages.taskTypeDetail.btnEdit')}
            </button>
            {canDelete && (
              <button
                className="btn btn-ghost btn-sm"
                style={{ color: 'var(--red)' }}
                onClick={deleteTaskType}
                title={t('pages.taskTypeDetail.btnDelete')}
              >
                {t('pages.taskTypeDetail.btnDelete')}
              </button>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {/* Steps */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">{t('pages.taskTypeDetail.cardSteps').replace('{count}', String(steps.length))}</span>
              <button className="btn btn-primary btn-sm" onClick={openAddStep}>
                <PlusIcon /> {t('pages.taskTypeDetail.addStep')}
              </button>
            </div>
            {steps.length === 0 ? (
              <p className="text-muted text-sm">{t('pages.taskTypeDetail.noSteps')}</p>
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
                      onDragStart={() => { setStepDragIndex(i); stepDragRef.current = i; }}
                      onDragOver={e => { e.preventDefault(); setStepDragOver(i); }}
                      onDrop={() => dropStep(i)}
                      onDragEnd={() => { setStepDragIndex(null); setStepDragOver(null); stepDragRef.current = null; }}
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
                          {(s.stepWebhooks?.length ?? 0) > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
                              {(s.stepWebhooks ?? []).map(sw => (
                                <div key={sw.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.7rem' }}>
                                  <span style={{ padding: '1px 7px', borderRadius: 999, background: 'var(--blue-bg)', color: 'var(--blue)', fontWeight: 600, border: '1px solid var(--border)' }}>
                                    {sw.webhook.name}
                                  </span>
                                  <span style={{ color: 'var(--text-muted)' }}>
                                    {sw.events.map(e => e.replace('on_', '')).join(', ')}
                                  </span>
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    style={{ padding: '0 4px', color: 'var(--red)', fontSize: '0.65rem', height: 16, lineHeight: 1 }}
                                    onClick={() => removeWebhook(s.id, sw.id)}
                                    title="Remove webhook"
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                          {isManual && (
                            <button className="btn btn-ghost btn-sm" onClick={() => { setErr(''); setCandidateId(''); setOpenBpos(s); }}>
                              {t('pages.taskTypeDetail.addBpos')} {(s.candidates?.length ?? 0) > 0 ? `(${s.candidates!.length})` : ''}
                            </button>
                          )}
                          <button className="btn btn-ghost btn-sm" onClick={() => { setErr(''); setOpenWebhook(s); setWhForm({ webhookId: '', events: [] }); }}>
                            {t('pages.taskTypeDetail.addWebhook')}
                          </button>
                          <button className="btn btn-ghost btn-sm" title={t('pages.taskTypeDetail.btnEdit')} onClick={() => openEditStep(s)}>
                            <EditIcon />
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
              <span className="card-title">{t('pages.taskTypeDetail.cardFields').replace('{count}', String(fields.length))}</span>
              <button className="btn btn-primary btn-sm" onClick={openAddField}>
                <PlusIcon /> {t('pages.taskTypeDetail.addField')}
              </button>
            </div>
            {fields.length === 0 ? (
              <p className="text-muted text-sm">{t('pages.taskTypeDetail.noFields')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {fields.map((f, i) => {
                  const isDragging = fieldDragIndex === i;
                  const isOver = fieldDragOver === i && fieldDragIndex !== i;
                  return (
                    <div key={f.id}
                      draggable
                      onDragStart={() => { setFieldDragIndex(i); fieldDragRef.current = i; }}
                      onDragOver={e => { e.preventDefault(); setFieldDragOver(i); }}
                      onDrop={() => dropField(i)}
                      onDragEnd={() => { setFieldDragIndex(null); setFieldDragOver(null); fieldDragRef.current = null; }}
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
                      <button type="button" className="btn btn-ghost btn-sm" title="Edit field" style={{ flexShrink: 0 }} onClick={() => openEditField(f)}>
                        <EditIcon />
                      </button>
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

        {/* Templates */}
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <span className="card-title">{t('pages.taskTypeDetail.cardTemplates').replace('{count}', String((tt.templates ?? []).length))}</span>
            <button className="btn btn-primary btn-sm" onClick={() => setAddingTemplate(prev => !prev)}>
              <PlusIcon /> {t('pages.taskTypeDetail.addTemplate')}
            </button>
          </div>

          {addingTemplate && (
            <form style={{ display: 'flex', gap: 8, padding: '0 0 16px', flexWrap: 'wrap', alignItems: 'flex-end' }}
              onSubmit={async e => {
                e.preventDefault();
                setTemplateFileErr('');
                const isFile = FILE_TIPOS.includes(templateForm.tipo);
                if (isFile && !templateFile) { setTemplateFileErr(t('pages.taskTypeDetail.templateFileRequired')); return; }
                setSaving(true); setErr('');
                try {
                  if (isFile && templateFile) {
                    await taskTypesApi.uploadTemplate(id!, templateForm.name, templateFile);
                  } else {
                    await taskTypesApi.addTemplate(id!, templateForm);
                  }
                  qc.invalidateQueries({ queryKey: ['task-type', id] });
                  setTemplateForm({ name: '', url: '', tipo: 'link' });
                  setTemplateFile(null);
                  setAddingTemplate(false);
                } catch (ex) { setErr(errMsg(ex)); } finally { setSaving(false); }
              }}
            >
              <div className="form-group" style={{ margin: 0, flex: '1 1 160px' }}>
                <label className="form-label">{t('pages.taskTypeDetail.templateNameLabel')}</label>
                <input className="form-input" placeholder="Integration SOP" value={templateForm.name}
                  onChange={e => setTemplateForm(f => ({ ...f, name: e.target.value }))} required autoFocus />
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">{t('pages.taskTypeDetail.templateTypeLabel')}</label>
                <select className="form-select" value={templateForm.tipo}
                  onChange={e => {
                    setTemplateForm(f => ({ ...f, tipo: e.target.value, url: '' }));
                    setTemplateFile(null);
                    setTemplateFileErr('');
                  }}>
                  {TIPO_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
              </div>

              {FILE_TIPOS.includes(templateForm.tipo) ? (
                <div className="form-group" style={{ margin: 0, flex: '2 1 240px' }}>
                  <label className="form-label">{t('pages.taskTypeDetail.templateFileLabel')} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{t('pages.taskTypeDetail.templateFileSizeHint')}</span></label>
                  <input
                    type="file"
                    accept={FILE_ACCEPT}
                    className="form-input"
                    style={{ padding: '5px 10px', cursor: 'pointer' }}
                    onChange={e => {
                      const f = e.target.files?.[0] ?? null;
                      setTemplateFileErr('');
                      if (f && f.size > MAX_FILE_BYTES) {
                        setTemplateFileErr(`File exceeds 10 MB (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
                        e.target.value = '';
                        setTemplateFile(null);
                        return;
                      }
                      setTemplateFile(f);
                    }}
                  />
                  {templateFileErr && <p style={{ color: 'var(--red)', fontSize: '0.75rem', marginTop: 3 }}>{templateFileErr}</p>}
                </div>
              ) : (
                <div className="form-group" style={{ margin: 0, flex: '2 1 240px' }}>
                  <label className="form-label">{t('pages.taskTypeDetail.templateUrlLabel')}</label>
                  <input className="form-input" placeholder="https://docs.google.com/…" value={templateForm.url}
                    onChange={e => setTemplateForm(f => ({ ...f, url: e.target.value }))} required />
                </div>
              )}

              <button type="submit" className="btn btn-primary btn-sm"
                disabled={saving || !templateForm.name.trim() || !!templateFileErr ||
                  (FILE_TIPOS.includes(templateForm.tipo) ? !templateFile : !templateForm.url.trim())}>
                {saving ? t('pages.taskTypeDetail.templateAdding') : t('pages.taskTypeDetail.templateAddBtn')}
              </button>
              <button type="button" className="btn btn-ghost btn-sm"
                onClick={() => { setAddingTemplate(false); setTemplateFile(null); setTemplateFileErr(''); setErr(''); }}>
                {t('pages.taskTypeDetail.templateCancelBtn')}
              </button>
              {err && <div className="error-banner" style={{ width: '100%', marginTop: 4 }}>{err}</div>}
            </form>
          )}

          {(tt.templates ?? []).length === 0 && !addingTemplate ? (
            <p className="text-muted text-sm">{t('pages.taskTypeDetail.noTemplates')}</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(tt.templates ?? []).map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: 'var(--orange-muted)', color: 'var(--orange)', textTransform: 'uppercase', flexShrink: 0 }}>{t.tipo}</span>
                  <span style={{ fontWeight: 500, fontSize: '0.84rem', flex: 1 }}>{t.name}</span>
                  <a href={t.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.url}</a>
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)', flexShrink: 0 }}
                    onClick={async () => {
                      setSaving(true);
                      try {
                        await taskTypesApi.removeTemplate(id!, t.id);
                        qc.invalidateQueries({ queryKey: ['task-type', id] });
                      } finally { setSaving(false); }
                    }}
                    disabled={saving}
                  >
                    <XIcon />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Add / Edit Step Modal */}
      {openStep && (
        <Modal
          title={stepToEdit ? t('pages.taskTypeDetail.modalEditStep').replace('{name}', stepToEdit.name) : t('pages.taskTypeDetail.modalAddStep')}
          onClose={closeStepModal}
          footer={<>
            <button className="btn btn-ghost" onClick={closeStepModal}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={saveStep} disabled={saving}>
              {saving ? t('common.saving') : stepToEdit ? t('pages.taskTypeDetail.saveChangesBtn') : t('pages.taskTypeDetail.addStepBtn')}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">{t('pages.taskTypeDetail.stepNameLabel')}</label>
            <input className="form-input" placeholder="Review credentials" value={stepForm.name}
              onChange={e => setStepForm(f => ({ ...f, name: e.target.value }))} required autoFocus />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{t('pages.taskTypeDetail.stepOrderLabel')}</label>
              <input className="form-input" type="number" min={1} value={stepForm.order}
                onChange={e => setStepForm(f => ({ ...f, order: parseInt(e.target.value) }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('pages.taskTypeDetail.stepExecTypeLabel')}</label>
              <select className="form-select" value={stepForm.executionType}
                onChange={e => setStepForm(f => ({ ...f, executionType: e.target.value as ExecutionType, handlerId: '' }))}>
                {EXECUTION_TYPES.map(et => <option key={et} value={et}>{execLabel(et)}</option>)}
              </select>
            </div>
          </div>
          {stepForm.executionType !== 'automatic' && (
            <div className="form-group">
              <label className="form-label">{t('pages.taskTypeDetail.stepStrategyLabel')}</label>
              <select className="form-select" value={stepForm.assignmentStrategy}
                onChange={e => setStepForm(f => ({ ...f, assignmentStrategy: e.target.value as AssignmentStrategy }))}>
                {STRATEGIES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
              <p className="form-hint">
                {stepForm.assignmentStrategy === 'fixed' ? t('pages.taskTypeDetail.strategyFixed') : ''}
                {stepForm.assignmentStrategy === 'round_robin' ? t('pages.taskTypeDetail.strategyRoundRobin') : ''}
                {stepForm.assignmentStrategy === 'brand_assignment' ? t('pages.taskTypeDetail.strategyBrandAssignment') : ''}
                {stepForm.assignmentStrategy === 'by_weight' ? t('pages.taskTypeDetail.strategyByWeight') : ''}
                {stepForm.assignmentStrategy === 'manual' ? t('pages.taskTypeDetail.strategyManual') : ''}
                {stepForm.assignmentStrategy !== 'brand_assignment' && stepForm.assignmentStrategy !== 'manual' && !stepToEdit && t('pages.taskTypeDetail.strategyAddNote')}
              </p>
            </div>
          )}
          {stepForm.executionType === 'automatic' && (
            <div className="form-group">
              <label className="form-label">{t('pages.taskTypeDetail.stepHandlerLabel')}</label>
              <select className="form-select" value={stepForm.handlerId}
                onChange={e => setStepForm(f => ({ ...f, handlerId: e.target.value }))}>
                <option value="">{t('pages.taskTypeDetail.stepHandlerPlaceholder')}</option>
                {handlers.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </div>
          )}
        </Modal>
      )}

      {/* Manage BPO Candidates Modal */}
      {openBpos && liveStep && (
        <Modal title={t('pages.taskTypeDetail.modalBpoCandidates').replace('{name}', liveStep.name)} onClose={() => setOpenBpos(null)}
          footer={<button className="btn btn-ghost" onClick={() => setOpenBpos(null)}>{t('common.close')}</button>}
        >
          {err && <div className="error-banner">{err}</div>}

          <p className="form-hint" style={{ marginBottom: 12 }}>
            {t('pages.taskTypeDetail.bpoStrategyLabel')}<strong>{liveStep.assignmentStrategy.replace(/_/g, ' ')}</strong>
            {liveStep.assignmentStrategy === 'fixed' ? t('pages.taskTypeDetail.bpoFixedNote') : ''}
            {liveStep.assignmentStrategy === 'brand_assignment' ? t('pages.taskTypeDetail.bpoBrandAssignmentNote') : ''}
            {liveStep.assignmentStrategy !== 'fixed' && liveStep.assignmentStrategy !== 'brand_assignment' ? '.' : ''}
          </p>

          <div style={{ marginBottom: 16 }}>
            <label className="form-label">{t('pages.taskTypeDetail.currentPool')}</label>
            {(liveStep.candidates?.length ?? 0) === 0 ? (
              <p className="text-muted text-sm">{t('pages.taskTypeDetail.noBpos')}</p>
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

          <div className="form-group">
            <label className="form-label">{t('pages.taskTypeDetail.addBpoLabel')}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select className="form-select" value={candidateId} onChange={e => setCandidateId(e.target.value)} style={{ flex: 1 }}>
                <option value="">{t('pages.taskTypeDetail.selectAccount')}</option>
                {availableBpos.map(a => (
                  <option key={a.id} value={a.id}>{a.name} — {a.email}</option>
                ))}
              </select>
              <button className="btn btn-primary btn-sm" onClick={addCandidate} disabled={!candidateId || saving}>
                {t('pages.taskTypeDetail.addBpoBtn')}
              </button>
            </div>
            {availableBpos.length === 0 && bpoAccounts.length > 0 && (
              <p className="form-hint">{t('pages.taskTypeDetail.allInPool')}</p>
            )}
          </div>
        </Modal>
      )}

      {/* Add / Edit Form Field Modal */}
      {openField && (
        <Modal
          title={fieldToEdit ? t('pages.taskTypeDetail.modalEditField').replace('{name}', fieldToEdit.label) : t('pages.taskTypeDetail.modalAddField')}
          onClose={closeFieldModal}
          footer={<>
            <button className="btn btn-ghost" onClick={closeFieldModal}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={saveField} disabled={saving}>
              {saving ? t('common.saving') : fieldToEdit ? t('pages.taskTypeDetail.saveFieldBtn') : t('pages.taskTypeDetail.addFieldBtn')}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">{t('pages.taskTypeDetail.fieldLabelLabel')}</label>
            <input className="form-input" placeholder="Contract URL" value={fieldForm.label}
              onChange={e => setFieldForm(f => ({ ...f, label: e.target.value }))} required autoFocus />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{t('pages.taskTypeDetail.fieldTypeLabel')}</label>
              <select className="form-select" value={fieldForm.type}
                onChange={e => setFieldForm(f => ({ ...f, type: e.target.value, options: [], filteredById: '' }))}>
                {FIELD_TYPES.map(ft => <option key={ft} value={ft}>{ft}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">{t('pages.taskTypeDetail.fieldOrderLabel')}</label>
              <input className="form-input" type="number" min={1} value={fieldForm.order}
                onChange={e => setFieldForm(f => ({ ...f, order: parseInt(e.target.value) }))} />
            </div>
          </div>
          <div className="form-check" style={{ marginBottom: 12 }}>
            <input type="checkbox" id="req" checked={fieldForm.required}
              onChange={e => setFieldForm(f => ({ ...f, required: e.target.checked }))} />
            <label htmlFor="req" style={{ fontSize: '0.83rem', cursor: 'pointer' }}>{t('pages.taskTypeDetail.fieldRequiredCheck')}</label>
          </div>

          {fieldForm.type === 'select' && (
            <>
              <div className="form-check" style={{ marginBottom: 12 }}>
                <input type="checkbox" id="multiple" checked={fieldForm.multiple}
                  onChange={e => setFieldForm(f => ({ ...f, multiple: e.target.checked }))} />
                <label htmlFor="multiple" style={{ fontSize: '0.83rem', cursor: 'pointer' }}>{t('pages.taskTypeDetail.fieldMultipleCheck')}</label>
              </div>

              <div className="form-group">
                <label className="form-label">{t('pages.taskTypeDetail.fieldOptionsLabel')}</label>
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
                  <input className="form-input" placeholder={t('pages.taskTypeDetail.fieldOptionsPlaceholder')} value={optionInput}
                    onChange={e => setOptionInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addOption(); } }}
                    style={{ flex: 1 }} />
                  <button type="button" className="btn btn-ghost btn-sm" onClick={addOption} disabled={!optionInput.trim()}>
                    {t('common.add')}
                  </button>
                </div>
                <p className="form-hint">{t('pages.taskTypeDetail.fieldOptionsHint')}</p>
              </div>
            </>
          )}

          {fieldForm.type === 'select_store' && brandFields.length > 0 && (
            <div className="form-group">
              <label className="form-label">{t('pages.taskTypeDetail.filterStoresLabel')}</label>
              <select className="form-select" value={fieldForm.filteredById}
                onChange={e => setFieldForm(f => ({ ...f, filteredById: e.target.value }))}>
                <option value="">{t('pages.taskTypeDetail.filterStoresNoFilter')}</option>
                {brandFields.map(bf => <option key={bf.id} value={bf.id}>{bf.label}</option>)}
              </select>
              <p className="form-hint">{t('pages.taskTypeDetail.filterStoresHint')}</p>
            </div>
          )}

          {(fieldForm.type === 'select_brand' || fieldForm.type === 'select_store') && (
            <div style={{ padding: '8px 12px', borderRadius: 6, background: 'var(--blue-bg)', border: '1px solid var(--blue)', fontSize: '0.78rem', color: 'var(--blue)' }}>
              <strong>{fieldForm.type === 'select_brand' ? 'Brand' : 'Store'} picker</strong> — when someone fills this task, the field renders a live {fieldForm.type === 'select_brand' ? 'brand' : 'store'} dropdown populated from the database. No extra configuration needed here.
            </div>
          )}

          {(fieldForm.type === 'select_ka_type' || fieldForm.type === 'select_country') && (
            <div style={{ padding: '8px 12px', borderRadius: 6, background: 'var(--orange-muted)', border: '1px solid var(--orange)', fontSize: '0.78rem', color: 'var(--orange)' }}>
              <strong>{fieldForm.type === 'select_ka_type' ? 'KA Type' : 'Country'} catalog</strong> — dropdown populated from the active values in Settings → Catalog. Required for <em>brand_assignment</em> strategy to work.
            </div>
          )}
        </Modal>
      )}

      {/* Add Webhook to Step Modal */}
      {openWebhook && (
        <Modal title={t('pages.taskTypeDetail.modalAddWebhook').replace('{name}', openWebhook.name)} onClose={() => setOpenWebhook(null)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenWebhook(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={addWebhook} disabled={saving || !whForm.webhookId || whForm.events.length === 0}>
              {saving ? t('pages.taskTypeDetail.adding') : t('pages.taskTypeDetail.addWebhookBtn')}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">{t('pages.taskTypeDetail.webhookLabel')}</label>
            <select className="form-select" value={whForm.webhookId} onChange={e => setWhForm(f => ({ ...f, webhookId: e.target.value }))}>
              <option value="">{t('pages.taskTypeDetail.webhookPlaceholder')}</option>
              {webhooks.map(w => <option key={w.id} value={w.id}>{w.name} {w.isAlerts ? '(alerts)' : ''}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('pages.taskTypeDetail.webhookEventsLabel')}</label>
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

      {/* Edit Task Type Modal */}
      {openEditTT && (
        <Modal title={t('pages.taskTypeDetail.modalEditTT')} onClose={() => setOpenEditTT(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenEditTT(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" form="edit-tt-form" type="submit" disabled={saving || !ttForm.name.trim()}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <form id="edit-tt-form" onSubmit={saveTaskType}>
            <div className="form-group">
              <label className="form-label">{t('pages.taskTypeDetail.ttNameLabel')}</label>
              <input className="form-input" value={ttForm.name} onChange={e => setTtForm(f => ({ ...f, name: e.target.value }))} required />
            </div>
            <div className="form-group">
              <label className="form-label">{t('pages.taskTypeDetail.ttDescLabel')}</label>
              <textarea className="form-textarea" rows={3} value={ttForm.description} onChange={e => setTtForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="form-check">
              <input type="checkbox" id="tt-schedulable" checked={ttForm.schedulable} onChange={e => setTtForm(f => ({ ...f, schedulable: e.target.checked }))} />
              <label htmlFor="tt-schedulable" style={{ fontSize: '0.83rem', cursor: 'pointer' }}>
                {t('pages.taskTypeDetail.ttSchedulableCheck')}
              </label>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
