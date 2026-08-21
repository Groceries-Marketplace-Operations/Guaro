import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import Paginator from '../../components/ui/Paginator';
import { storeOnboardingApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission } from '../../auth/permissions';
import type {
  StoreOnboardingBriefField,
  StoreOnboardingBriefFieldType,
  StoreOnboardingEtaMilestone,
  StoreOnboardingForecast,
  StoreOnboardingListResponse,
  StoreOnboardingRequest,
  StoreOnboardingUnit,
} from '../../types';
import OperationalTimeline from './OperationalTimeline';
import StoreOnboardingSettingsModal from './StoreOnboardingSettingsModal';
import { useStoreOnboardingFeature } from './useStoreOnboardingFeature';
import './store-onboarding.css';

const PAGE_SIZE = 25;

const STAGE_LABELS: Record<string, string> = {
  created: 'Tienda creada',
  awaiting_shop_ids: 'Esperando Shop IDs de OP Support',
  awaiting_configuration_brief: 'Esperando ficha de configuración KA',
  no_coverage: 'Sin cobertura',
  creation_failed: 'Creación fallida',
  integration_queued: 'En cola de configuración / integración',
  configuring: 'Configuración',
  configuration_validated: 'Configuración validada',
  audit_preparing: 'Preparación para Auditoría',
  awaiting_audit: 'Esperando Auditoría',
  audit_needs_information: 'Auditoría requiere información',
  audit_rejected: 'Corrección de Auditoría',
  audit_approved: 'Auditoría aprobada · configuración RTBO',
  rtbo: 'RTBO',
  integration_complete: 'Integración completa',
  awaiting_go_live: 'Esperando Go-Live',
  going_online: 'Poniendo online',
  online: 'Online',
  online_failed: 'Error de Go-Live',
  blocked: 'Bloqueada',
  cancelled: 'Cancelada',
  ka_configuration: 'Configuración KA (pool OP Support)',
  external_audit: 'Auditoría externa',
  rtbo_supervision: 'Supervisión RTBO KA',
};

const CHECKLIST_FIELDS = [
  ['application_linked', 'Aplicación vinculada'],
  ['credentials_valid', 'Credenciales / token válidos'],
  ['shop_list_verified', 'Tienda visible en Store List'],
  ['business_hours', 'Horarios configurados'],
  ['picking_payment', 'Picking y método de pago'],
  ['driver_cash_block', 'Bloqueo de efectivo'],
  ['menu_ready', 'Menú y configuración operativa'],
] as const;

const BRIEF_FIELD_TYPES: Array<{ value: StoreOnboardingBriefFieldType; label: string }> = [
  { value: 'text', label: 'Texto corto' },
  { value: 'long_text', label: 'Texto largo' },
  { value: 'number', label: 'Número' },
  { value: 'select', label: 'Selección' },
  { value: 'link', label: 'Enlace' },
];

function formatDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function stageLabel(stage?: string | null) {
  return stage ? STAGE_LABELS[stage] ?? stage.replaceAll('_', ' ') : '—';
}

function stageTone(stage?: string | null) {
  if (stage === 'online') return 'success';
  if (['awaiting_configuration_brief', 'configuration_validated', 'audit_approved', 'rtbo', 'awaiting_go_live'].includes(stage ?? '')) return 'ready';
  if (stage?.includes('failed') || stage === 'audit_rejected') return 'danger';
  if (['blocked', 'no_coverage', 'audit_needs_information'].includes(stage ?? '')) return 'warning';
  return 'active';
}

function workflowKaType(request: StoreOnboardingRequest) {
  return request.kaTypeSnapshot ?? request.brand.kaType;
}

function workflowCountry(request: StoreOnboardingRequest) {
  return request.countrySnapshot ?? request.brand.country;
}

function progressOf(request: StoreOnboardingRequest) {
  return request.totalUnits ? Math.round((request.completedUnits / request.totalUnits) * 100) : 0;
}

function normalizeMilestones(forecast?: StoreOnboardingForecast | null): StoreOnboardingEtaMilestone[] {
  const estimates = forecast?.stageEstimates;
  if (Array.isArray(estimates)) return estimates;
  if (!estimates || typeof estimates !== 'object') return [];
  return Object.entries(estimates).map(([stage, value]) => {
    if (typeof value === 'string') return { stage, label: stageLabel(stage), estimatedAt: value };
    if (typeof value === 'object' && value) return { stage, label: stageLabel(stage), ...(value as StoreOnboardingEtaMilestone) };
    return { stage, label: stageLabel(stage) };
  });
}

function errorMessage(error: unknown, fallback: string) {
  const apiError = error as { response?: { data?: { message?: string | string[] } }; message?: string };
  const message = apiError.response?.data?.message;
  return Array.isArray(message) ? message.join(' · ') : message ?? apiError.message ?? fallback;
}

function safeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function ConfigurationBriefDisplay({ request }: { request: StoreOnboardingRequest }) {
  return <div className="configuration-brief-display">
    <div className="configuration-brief-general">
      <strong>Instrucciones generales para todas las tiendas</strong>
      <p>{request.configurationBrief ?? 'Pendientes de publicación.'}</p>
    </div>
    {(request.configurationBriefFields ?? []).length > 0 && <div className="configuration-brief-values">
      {(request.configurationBriefFields ?? []).map(field => <div key={field.id} className={`configuration-brief-value type-${field.type}`}>
          <span>{field.label}</span>
          {field.type === 'link' && safeExternalUrl(String(field.value))
            ? <a href={safeExternalUrl(String(field.value)) ?? undefined} target="_blank" rel="noreferrer">{String(field.value)}</a>
            : <strong>{String(field.value)}</strong>}
        </div>)}
    </div>}
  </div>;
}

function ShopIdHandoffPanel({ request }: { request: StoreOnboardingRequest }) {
  const qc = useQueryClient();
  const requestKaType = workflowKaType(request);
  const isKa = requestKaType === 'KA';
  const briefOwner = request.configurationBriefAssignee?.name ?? 'responsable de ficha KA';
  const [rows, setRows] = useState('');
  const [message, setMessage] = useState('');
  const mutation = useMutation({
    mutationFn: () => {
      const units = rows.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
        const [externalShopId, appShopId] = line.split(/[\t,;]/).map(value => value.trim());
        return { externalShopId, appShopId };
      });
      if (!units.length) throw new Error('Agrega al menos un shop_id.');
      if (units.some(unit => !unit.externalShopId || !unit.appShopId)) {
        throw new Error('Cada fila debe incluir Shop ID y App Shop ID.');
      }
      return storeOnboardingApi.submitShopIds(request.id, units);
    },
    onSuccess: async () => {
      setMessage(isKa
        ? `Shop IDs confirmados. ${briefOwner} ya puede ver la tarea de instrucciones.`
        : 'Shop IDs confirmados. Comercial ya puede preparar el envío a Auditoría.');
      setRows('');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['store-onboarding-detail', request.id] }),
        qc.invalidateQueries({ queryKey: ['store-onboarding'] }),
      ]);
    },
  });
  return <section className="card" style={{ marginBottom: 18, borderTop: `3px solid ${request.shopIdsValidatedAt ? 'var(--success)' : 'var(--warning)'}` }}>
    <div className="card-header"><div><span className="card-title">Compuerta de Shop IDs</span><p className="text-muted text-sm">El onboarding no avanza hasta que Shop ID y App Shop ID estén registrados de forma estructurada.</p></div><span className={`onboarding-stage tone-${request.shopIdsValidatedAt ? 'success' : 'warning'}`}>{request.shopIdsValidatedAt ? 'Confirmados' : 'Acción OP Support / Owner OP'}</span></div>
    <div style={{ padding: '0 16px 16px' }}>
      {request.shopIdsValidatedAt ? <><p><strong>{request.units?.length ?? 0} shop_id(s)</strong> validados · Fuente: {request.shopIdsValidationSource?.replaceAll('_', ' ') ?? 'registro estructurado'}.</p><p className="text-muted text-sm" style={{ marginTop: 6 }}>{isKa ? `${briefOwner} puede publicar las instrucciones de configuración.` : 'Comercial fue habilitado para preparar y enviar a Auditoría.'}</p></> : <>
        <p className="text-muted text-sm" style={{ marginBottom: 10 }}>Responsable: <strong>{request.units?.[0]?.configurationAssignee?.name ?? request.brand.owner?.name ?? 'OP Support asignado'}</strong>.</p>
        {request.canSubmitShopIds ? <><textarea className="form-textarea" rows={7} value={rows} onChange={event => setRows(event.target.value)} placeholder={'57646…\n57646…, app_shop_id'} /><div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}><button className="btn btn-primary" disabled={mutation.isPending || !rows.trim()} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Confirmando…' : isKa ? `Confirmar IDs y notificar a ${briefOwner}` : 'Confirmar IDs y habilitar preparación Comercial'}</button></div></> : <p className="text-muted text-sm">Esperando que el OP Support asignado agregue los shop_id.</p>}
      </>}
      {message && <div className="alert alert-success" style={{ marginTop: 10 }}>{message}</div>}
      {mutation.isError && <div className="error-banner" style={{ marginTop: 10 }}>{errorMessage(mutation.error, 'No se pudieron confirmar los shop_id.')}</div>}
    </div>
  </section>;
}

function ConfigurationBriefPanel({ request }: { request: StoreOnboardingRequest }) {
  const qc = useQueryClient();
  const { account } = useAuth();
  const canManage = hasPermission(account, 'system.manage');
  const [instructions, setInstructions] = useState(request.configurationBrief ?? '');
  const [fields, setFields] = useState<StoreOnboardingBriefField[]>(request.configurationBriefFields ?? []);
  const [briefAssigneeId, setBriefAssigneeId] = useState(request.configurationBriefAssigneeId ?? '');
  const [savedBriefAssigneeId, setSavedBriefAssigneeId] = useState(request.configurationBriefAssigneeId ?? '');
  const [assignmentMessage, setAssignmentMessage] = useState('');
  const [unitNotes, setUnitNotes] = useState<Record<string, string>>(() => Object.fromEntries(
    (request.units ?? []).map(unit => [unit.id, String(unit.configurationInput?.instructions ?? '')]),
  ));
  const canEdit = request.canEditConfigurationBrief === true;
  const assigneesQuery = useQuery<{ data: Array<{ id: string; name: string; email: string }> }>({
    queryKey: ['store-onboarding-assignee-options'],
    queryFn: () => storeOnboardingApi.assigneeOptions().then(response => response.data),
    enabled: canManage,
    staleTime: 60_000,
  });
  const assigneeOptions = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; email: string }>();
    for (const candidate of [request.configurationBriefAssignee, ...(assigneesQuery.data?.data ?? [])]) {
      if (candidate) byId.set(candidate.id, candidate);
    }
    return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [assigneesQuery.data?.data, request.configurationBriefAssignee]);
  const updateField = (id: string, patch: Partial<StoreOnboardingBriefField>) => {
    setFields(current => current.map(field => field.id === id ? { ...field, ...patch } : field));
  };
  const addField = () => setFields(current => [...current, {
    id: crypto.randomUUID(),
    label: '',
    type: 'text',
    value: '',
    required: true,
  }]);
  const fieldsComplete = fields.every(field => field.label.trim() && (
    field.type === 'number'
      ? field.value !== '' && Number.isFinite(Number(field.value))
      : String(field.value ?? '').trim()
  ) && (field.type !== 'select' || (field.options?.length && field.options.includes(String(field.value)))));
  const mutation = useMutation({
    mutationFn: () => storeOnboardingApi.updateConfigurationBrief(request.id, {
      instructions,
      fields,
      units: (request.units ?? []).filter(unit => unitNotes[unit.id]?.trim()).map(unit => ({
        unitId: unit.id,
        input: { instructions: unitNotes[unit.id].trim() },
      })),
    }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['store-onboarding-detail', request.id] }),
        qc.invalidateQueries({ queryKey: ['store-onboarding'] }),
      ]);
    },
  });
  const assignmentMutation = useMutation({
    mutationFn: () => storeOnboardingApi.assignConfigurationBrief(request.id, briefAssigneeId || null),
    onSuccess: async () => {
      setSavedBriefAssigneeId(briefAssigneeId);
      setAssignmentMessage('Responsable de la ficha KA actualizado; no se avanzó ninguna etapa.');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['store-onboarding-detail', request.id] }),
        qc.invalidateQueries({ queryKey: ['store-onboarding'] }),
      ]);
    },
  });
  return <section className="card" style={{ marginBottom: 18, borderTop: '3px solid var(--orange)' }}>
    <div className="card-header"><div><span className="card-title">Ficha de configuración KA</span><p className="text-muted text-sm">{request.configurationBriefAssignee?.name ?? 'Responsable por asignar'} define una sola ficha con campos y valores para todas las tiendas del Task.</p></div>{request.configurationPreparedAt && <span className="onboarding-stage tone-success">Publicada</span>}</div>
    <div style={{ padding: '0 16px 16px' }}>
      {canManage && <div className="onboarding-brief-assignment">
        <div className="form-group"><label className="form-label" htmlFor={`brief-assignee-${request.id}`}>Responsable ficha KA y RTBO KA</label><select id={`brief-assignee-${request.id}`} className="form-select" disabled={assigneesQuery.isLoading || assigneesQuery.isError} value={briefAssigneeId} onChange={event => { setBriefAssigneeId(event.target.value); setAssignmentMessage(''); }}><option value="">Sin asignar</option>{assigneeOptions.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.email}</option>)}</select><p className="form-hint">La asignación no publica la ficha ni mueve tiendas. Sólo la cuenta elegida y system.manage pueden editarla; esa cuenta confirma RTBO para KA.</p></div>
        <button type="button" className="btn btn-ghost" disabled={briefAssigneeId === savedBriefAssigneeId || assignmentMutation.isPending || assigneesQuery.isLoading || assigneesQuery.isError} onClick={() => assignmentMutation.mutate()}>{assignmentMutation.isPending ? 'Guardando…' : 'Guardar responsable'}</button>
      </div>}
      {assigneesQuery.isError && canManage && <div className="onboarding-inline-state is-warning">No se cargaron cuentas; la asignación permanece sin cambios.</div>}
      {assignmentMutation.isError && <div className="error-banner" style={{ marginBottom: 10 }}>{errorMessage(assignmentMutation.error, 'No se pudo asignar la ficha KA.')}</div>}
      {assignmentMessage && <div className="alert alert-success" style={{ marginBottom: 10 }}>{assignmentMessage}</div>}
      <label className="form-label">Instrucciones generales</label>
      <textarea className="form-textarea" rows={5} disabled={!canEdit} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="Campos, valores esperados, enlaces, evidencia y criterios para enviar a Auditoría…" />
      <div className="configuration-field-builder">
        <div className="configuration-field-builder-heading"><div><strong>Campos y valores generales</strong><span>Todos los OP Support verán los mismos valores.</span></div>{canEdit && <button type="button" className="btn btn-ghost btn-sm" onClick={addField}>+ Agregar campo</button>}</div>
        {fields.length === 0 ? <div className="configuration-field-empty">No hay campos adicionales.</div> : fields.map((field, index) => <div key={field.id} className="configuration-field-row">
            <span className="configuration-field-order">{index + 1}</span>
            <input className="form-input" disabled={!canEdit} value={field.label} onChange={event => updateField(field.id, { label: event.target.value })} placeholder="Nombre del campo" />
            <select className="form-select" disabled={!canEdit} value={field.type} onChange={event => {
              const type = event.target.value as StoreOnboardingBriefFieldType;
              updateField(field.id, { type, value: '', options: type === 'select' ? [] : undefined });
            }}>{BRIEF_FIELD_TYPES.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}</select>
            <div className="configuration-field-input">
              {field.type === 'long_text'
                ? <textarea className="form-textarea" rows={2} disabled={!canEdit} value={String(field.value ?? '')} onChange={event => updateField(field.id, { value: event.target.value })} />
                : field.type === 'select'
                  ? <><input className="form-input" disabled={!canEdit} value={(field.options ?? []).join(', ')} onChange={event => {
                    const options = event.target.value.split(',').map(value => value.trim()).filter(Boolean);
                    updateField(field.id, { options, value: options.includes(String(field.value)) ? field.value : options[0] ?? '' });
                  }} placeholder="Opciones separadas por coma" /><select className="form-select" disabled={!canEdit || !field.options?.length} value={String(field.value ?? '')} onChange={event => updateField(field.id, { value: event.target.value })}><option value="">Selecciona el valor</option>{(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}</select></>
                  : <input className="form-input" type={field.type === 'number' ? 'number' : field.type === 'link' ? 'url' : 'text'} disabled={!canEdit} value={String(field.value ?? '')} onChange={event => updateField(field.id, { value: event.target.value })} />}
            </div>
            {canEdit && <button type="button" className="configuration-field-remove" onClick={() => setFields(current => current.filter(item => item.id !== field.id))} aria-label={`Eliminar ${field.label || `campo ${index + 1}`}`}>×</button>}
          </div>)}
      </div>
      {(request.units ?? []).length > 0 && <details style={{ marginTop: 12 }}><summary style={{ cursor: 'pointer', fontWeight: 700 }}>Excepciones por tienda ({request.units?.length ?? 0})</summary><div style={{ maxHeight: 340, overflowY: 'auto', marginTop: 10, display: 'grid', gap: 8 }}>{(request.units ?? []).map(unit => <label key={unit.id} style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 10, alignItems: 'center' }}><span className="text-sm"><strong>{unit.externalShopId}</strong><br /><span className="text-muted">{unit.appShopId ?? 'Sin App Shop ID'}</span></span><input className="form-input" disabled={!canEdit} value={unitNotes[unit.id] ?? ''} onChange={event => setUnitNotes(current => ({ ...current, [unit.id]: event.target.value }))} placeholder="Sólo si esta tienda tiene una excepción…" /></label>)}</div></details>}
      {canEdit && <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}><button className="btn btn-primary" disabled={mutation.isPending || !instructions.trim() || !fieldsComplete} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Publicando…' : 'Publicar para todas las tiendas'}</button></div>}
      {mutation.isError && <div className="error-banner" style={{ marginTop: 10 }}>{errorMessage(mutation.error, 'No se pudo publicar la ficha.')}</div>}
      {!canEdit && !request.configurationPreparedAt && <p className="text-muted text-sm" style={{ marginTop: 10 }}>Esperando a {request.configurationBriefAssignee?.name ?? 'la persona asignada'} para publicar instrucciones.</p>}
      {request.configurationPreparedBy && <p className="text-muted text-sm" style={{ marginTop: 8 }}>Última publicación: {request.configurationPreparedBy.name} · {formatDate(request.configurationPreparedAt)}</p>}
    </div>
  </section>;
}

function OnboardingList() {
  const { account } = useAuth();
  const navigate = useNavigate();
  const canManage = hasPermission(account, 'system.manage');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [stage, setStage] = useState('');
  const [source, setSource] = useState('');
  const [kaType, setKaType] = useState('');
  const [country, setCountry] = useState('');
  const [brandQuery, setBrandQuery] = useState('');
  const [openSettings, setOpenSettings] = useState(false);
  const params = {
    page,
    limit: PAGE_SIZE,
    status: status || undefined,
    stage: stage || undefined,
    source: source || undefined,
    kaType: kaType || undefined,
    country: country || undefined,
  };
  const query = useQuery<StoreOnboardingListResponse>({
    queryKey: ['store-onboarding', params],
    queryFn: () => storeOnboardingApi.list(params).then(response => response.data),
    refetchInterval: 15_000,
  });
  const requests = useMemo(() => {
    const text = brandQuery.trim().toLowerCase();
    return (query.data?.data ?? []).filter(request => {
      if (kaType && workflowKaType(request) !== kaType) return false;
      if (country && workflowCountry(request) !== country) return false;
      return !text || request.brand.brandName.toLowerCase().includes(text) || (request.brand.brandId ?? '').toLowerCase().includes(text);
    });
  }, [brandQuery, country, kaType, query.data]);
  const summary = useMemo(() => ({
    active: requests.filter(item => !['done', 'partial_success', 'cancelled'].includes(item.status)).length,
    stores: requests.reduce((sum, item) => sum + item.totalUnits, 0),
    rtbo: requests.reduce((sum, item) => sum + (item.units?.filter(unit => unit.stage === 'rtbo').length ?? 0), 0),
    attention: requests.filter(item => item.failedUnits > 0 || ['blocked', 'audit_rejected', 'audit_needs_information', 'online_failed'].includes(item.currentStage)).length,
  }), [requests]);

  return <>
    <Topbar breadcrumb={[{ label: 'Integrations' }, { label: 'Store Onboarding' }]} />
    <main className="main-content onboarding-page">
      <div className="onboarding-hero">
        <div><span className="onboarding-eyebrow">Operations control tower</span><h1>Store Onboarding</h1><p>Visibilidad desde Brand creada hasta configuración, Auditoría, RTBO y Go-Live, con responsables y ETA por etapa.</p></div>
        <div className="page-actions">{canManage && <button className="btn btn-ghost" onClick={() => setOpenSettings(true)}>Configurar rollout y avisos</button>}</div>
      </div>
      <div className="onboarding-info-banner"><strong>Sin creación manual.</strong><span>En v1 sólo nacen requests de Tasks Create/Duplicate elegibles por el rollout. Auto Open permanece independiente.</span></div>
        <div className="onboarding-kpis">
          <div className="onboarding-kpi"><span>Solicitudes activas</span><strong>{summary.active}</strong><small>en esta vista</small></div>
          <div className="onboarding-kpi"><span>Tiendas gestionadas</span><strong>{summary.stores}</strong><small>unidades visibles</small></div>
          <div className="onboarding-kpi"><span>Listas RTBO</span><strong>{summary.rtbo}</strong><small>todos los tipos</small></div>
          <div className={`onboarding-kpi${summary.attention ? ' is-alert' : ''}`}><span>Requieren atención</span><strong>{summary.attention}</strong><small>bloqueos o fallos</small></div>
        </div>
        <section className="card onboarding-filter-card"><div className="onboarding-filters">
          <input className="form-input" placeholder="Buscar marca o Brand ID…" value={brandQuery} onChange={event => setBrandQuery(event.target.value)} />
          <select className="form-select" value={country} onChange={event => { setCountry(event.target.value); setPage(1); }}><option value="">Todos los países</option><option value="MX">México</option><option value="CO">Colombia</option><option value="CR">Costa Rica</option></select>
          <select className="form-select" value={kaType} onChange={event => { setKaType(event.target.value); setPage(1); }}><option value="">Todos los tipos</option><option value="KA">KA</option><option value="CKA">CKA</option><option value="SME">SME</option></select>
          <select className="form-select" value={stage} onChange={event => { setStage(event.target.value); setPage(1); }}><option value="">Todas las etapas</option>{Object.entries(STAGE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select className="form-select" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">Todos los estados</option><option value="active">Active</option><option value="blocked">Blocked</option><option value="partial_success">Partial success</option><option value="done">Done</option><option value="cancelled">Cancelled</option></select>
          <select className="form-select" value={source} onChange={event => { setSource(event.target.value); setPage(1); }}><option value="">Todos los orígenes</option><option value="create">Create Stores</option><option value="duplicate">Duplicated Stores</option></select>
        </div></section>
        {query.isLoading && <div className="onboarding-empty">Cargando onboardings…</div>}
        {query.isError && <div className="error-banner">No se pudo cargar Store Onboarding.</div>}
        {!query.isLoading && !query.isError && requests.length === 0 && <div className="onboarding-empty"><strong>No hay solicitudes para estos filtros.</strong><span>Sólo aparecerán Tasks inscritas explícitamente por el rollout.</span></div>}
        {requests.length > 0 && <div className="table-wrap onboarding-list-table"><table>
          <thead><tr><th>Marca / ruta</th><th>Etapa actual</th><th>Responsables</th><th>Progreso</th><th>Fecha estimada</th><th>Atención</th></tr></thead>
          <tbody>{requests.map(request => {
            const firstUnit = request.units?.[0];
            const people = [firstUnit?.configurationAssignee?.name, firstUnit?.commercialAssignee?.name, firstUnit?.goLiveAssignee?.name].filter(Boolean);
            const progress = progressOf(request);
            return <tr key={request.id} role="link" tabIndex={0} aria-label={`Abrir onboarding de ${request.brand.brandName}`} onClick={() => navigate(`/integrations/store-onboarding/${request.id}`)} onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                navigate(`/integrations/store-onboarding/${request.id}`);
              }
            }} className="onboarding-list-row">
              <td><strong>{request.brand.brandName}</strong><div className="onboarding-table-meta"><span>{workflowCountry(request)} · {workflowKaType(request)}</span><span>{request.source}</span><span>{request.totalUnits} tienda(s)</span></div></td>
              <td><span className={`onboarding-stage tone-${stageTone(request.currentStage)}`}>{stageLabel(request.currentStage)}</span></td>
              <td>{people.length ? [...new Set(people)].join(' · ') : request.brand.owner?.name ?? <span className="text-muted">Por asignar</span>}</td>
              <td><div className="onboarding-progress-cell"><div><span style={{ width: `${progress}%` }} /></div><strong>{progress}%</strong></div><small>{request.completedUnits} / {request.totalUnits}</small></td>
              <td><strong>{formatDate(request.estimatedCompletionAt)}</strong><div className={`eta-confidence confidence-${request.etaConfidence ?? 'unavailable'}`}>Confianza {request.etaConfidence ?? 'sin calcular'}</div></td>
              <td>{request.failedUnits > 0 ? <span className="onboarding-danger-count">{request.failedUnits} con error</span> : <span className="onboarding-ok">Sin bloqueos</span>}</td>
            </tr>;
          })}</tbody>
        </table></div>}
        <Paginator page={query.data?.page ?? page} total={query.data?.total ?? requests.length} limit={query.data?.limit ?? PAGE_SIZE} onChange={setPage} />
    </main>
    {openSettings && <StoreOnboardingSettingsModal onClose={() => setOpenSettings(false)} />}
  </>;
}

function UnitActionModal({ request, unit, onClose }: { request: StoreOnboardingRequest; unit: StoreOnboardingUnit; onClose: () => void }) {
  const qc = useQueryClient();
  const { account } = useAuth();
  const [checklist, setChecklist] = useState<Record<string, boolean | string | number | null>>(() => ({ ...(unit.checklist ?? {}) }));
  const [note, setNote] = useState('');
  const [auditNote, setAuditNote] = useState(unit.auditNote ?? '');
  const [auditEvidenceText, setAuditEvidenceText] = useState((unit.auditEvidence ?? []).join('\n'));
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const canManage = hasPermission(account, 'system.manage');
  const [assignment, setAssignment] = useState({
    configurationAssigneeId: unit.configurationAssigneeId ?? '',
    commercialAssigneeId: unit.commercialAssigneeId ?? '',
    goLiveAssigneeId: unit.goLiveAssigneeId ?? '',
  });
  const [savedAssignment, setSavedAssignment] = useState({
    configurationAssigneeId: unit.configurationAssigneeId ?? '',
    commercialAssigneeId: unit.commercialAssigneeId ?? '',
    goLiveAssigneeId: unit.goLiveAssigneeId ?? '',
  });
  const assigneesQuery = useQuery<{ data: Array<{ id: string; name: string; email: string }> }>({
    queryKey: ['store-onboarding-assignee-options'],
    queryFn: () => storeOnboardingApi.assigneeOptions().then(response => response.data),
    enabled: canManage,
    staleTime: 60_000,
  });
  const assigneeOptions = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; email: string }>();
    for (const candidate of [unit.configurationAssignee, unit.commercialAssignee, unit.goLiveAssignee, ...(assigneesQuery.data?.data ?? [])]) {
      if (candidate) byId.set(candidate.id, candidate);
    }
    return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [assigneesQuery.data?.data, unit.commercialAssignee, unit.configurationAssignee, unit.goLiveAssignee]);
  const requestKaType = workflowKaType(request);
  const kaRtboOwner = request.configurationBriefAssignee?.name ?? 'Responsable KA por asignar';
  const canConfigure = canManage || unit.configurationAssigneeId === account?.id || request.brand.owner?.id === account?.id;
  const canAudit = canManage || unit.commercialAssigneeId === account?.id;
  const canRtbo = canManage
    || (requestKaType === 'KA' && request.configurationBriefAssigneeId === account?.id)
    || (requestKaType !== 'KA' && (
      request.brand.owner?.id === account?.id
      || unit.configurationAssigneeId === account?.id
      || unit.goLiveAssigneeId === account?.id
    ));
  const canGoLive = canManage || unit.goLiveAssigneeId === account?.id || request.brand.owner?.id === account?.id;
  const auditEvidence = auditEvidenceText.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const auditEvidenceValid = auditEvidence.length <= 20 && auditEvidence.every(value => value.length <= 1000);
  const assignmentChanged = assignment.configurationAssigneeId !== savedAssignment.configurationAssigneeId
    || assignment.commercialAssigneeId !== savedAssignment.commercialAssigneeId
    || assignment.goLiveAssigneeId !== savedAssignment.goLiveAssigneeId;
  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['store-onboarding-detail', request.id] }),
      qc.invalidateQueries({ queryKey: ['store-onboarding-forecast', request.id] }),
      qc.invalidateQueries({ queryKey: ['store-onboarding-timeline', request.id] }),
      qc.invalidateQueries({ queryKey: ['store-onboarding'] }),
    ]);
  };
  const action = useMutation({
    mutationFn: async (kind: 'validate-configuration' | 'restart-configuration' | 'prepare-audit' | 'submit-audit' | 'checklist' | 'approve' | 'reject' | 'needs-information' | 'resume-audit' | 'rtbo' | 'go-live') => {
      if (kind === 'validate-configuration') return storeOnboardingApi.transitionUnit(request.id, unit.id, { stage: 'configuration_validated', note: note || undefined });
      if (kind === 'restart-configuration') return storeOnboardingApi.transitionUnit(request.id, unit.id, { stage: 'configuring', note: note || undefined });
      if (kind === 'prepare-audit' || kind === 'resume-audit') return storeOnboardingApi.transitionUnit(request.id, unit.id, { stage: 'audit_preparing', note: note || auditNote || undefined });
      if (kind === 'submit-audit') return storeOnboardingApi.transitionUnit(request.id, unit.id, { stage: 'awaiting_audit', note: note || auditNote || undefined });
      if (kind === 'checklist') return storeOnboardingApi.updateChecklist(request.id, unit.id, { checklist, note: note || undefined });
      if (kind === 'approve') return storeOnboardingApi.auditUnit(request.id, unit.id, { decision: 'approved', note: auditNote || undefined, evidence: auditEvidence });
      if (kind === 'reject') return storeOnboardingApi.auditUnit(request.id, unit.id, { decision: 'rejected', note: auditNote || undefined, evidence: auditEvidence });
      if (kind === 'needs-information') return storeOnboardingApi.auditUnit(request.id, unit.id, { decision: 'needs_information', note: auditNote, evidence: auditEvidence });
      if (kind === 'rtbo') {
        await storeOnboardingApi.updateChecklist(request.id, unit.id, { checklist, note: note || undefined });
        return storeOnboardingApi.transitionUnit(request.id, unit.id, { stage: 'rtbo', note: note || undefined });
      }
      return storeOnboardingApi.goLive(request.id, [unit.id]);
    },
    onSuccess: async (_, kind) => {
      setError('');
      setMessage(kind === 'needs-information'
        ? 'Solicitud de información registrada; el flujo quedó bloqueado.'
        : kind === 'go-live' ? 'Go-Live ejecutado; revisa el resultado.' : 'Etapa actualizada correctamente.');
      await invalidate();
    },
    onError: err => setError(errorMessage(err, 'No se pudo completar la acción.')),
  });
  const saveAssignment = useMutation({
    mutationFn: () => storeOnboardingApi.assignUnit(request.id, unit.id, {
      configurationAssigneeId: assignment.configurationAssigneeId || null,
      commercialAssigneeId: assignment.commercialAssigneeId || null,
      goLiveAssigneeId: assignment.goLiveAssigneeId || null,
    }),
    onSuccess: async () => {
      setError('');
      setSavedAssignment({ ...assignment });
      setMessage('Responsables actualizados explícitamente. No se ejecutó ninguna transición.');
      await invalidate();
    },
    onError: err => setError(errorMessage(err, 'No se pudieron actualizar los responsables.')),
  });

  return <Modal title={`${unit.externalShopId} · ${stageLabel(unit.stage)}`} onClose={onClose} footer={<button className="btn btn-ghost" onClick={onClose}>Cerrar</button>}>
    {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
    {message && <div className="alert alert-success" style={{ marginBottom: 12 }}>{message}</div>}
    <div className="unit-action-summary">
      <div><span>App Shop ID</span><strong>{unit.appShopId ?? '—'}</strong></div>
      {requestKaType === 'KA' ? <>
        <div><span>Configuración</span><strong>{unit.configurationAssignee?.name ?? 'Por asignar'}</strong></div>
        <div><span>Auditoría / Comercial</span><strong>{unit.commercialAssignee?.name ?? 'Por asignar'}</strong></div>
        <div><span>RTBO</span><strong>{kaRtboOwner}</strong></div>
      </> : <>
        <div><span>Comercial · Auditoría</span><strong>{unit.commercialAssignee?.name ?? 'Comercial por asignar'}</strong></div>
        <div><span>RTBO</span><strong>{unit.configurationAssignee?.name ?? unit.goLiveAssignee?.name ?? request.brand.owner?.name ?? 'OP Support / Owner OP'}</strong></div>
      </>}
      <div><span>Go-Live</span><strong>{unit.goLiveAssignee?.name ?? request.brand.owner?.name ?? 'Owner OP / por asignar'}</strong></div>
    </div>

    {canManage && <section className="unit-action-section">
      <div className="unit-action-title"><div><strong>Asignación de responsables</strong><span>La asignación no avanza el flujo ni completa etapas.</span></div><span className="onboarding-stage tone-ready">system.manage</span></div>
      {assigneesQuery.isError && <div className="onboarding-inline-state is-warning">No se cargaron cuentas; la asignación permanece sin cambios.</div>}
      <div className="form-row">
        <div className="form-group"><label className="form-label" htmlFor={`configuration-assignee-${unit.id}`}>Configuración / RTBO OP</label><select id={`configuration-assignee-${unit.id}`} className="form-select" disabled={assigneesQuery.isLoading || assigneesQuery.isError} value={assignment.configurationAssigneeId} onChange={event => setAssignment(current => ({ ...current, configurationAssigneeId: event.target.value }))}><option value="">Sin asignar</option>{assigneeOptions.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.email}</option>)}</select></div>
        <div className="form-group"><label className="form-label" htmlFor={`commercial-assignee-${unit.id}`}>Comercial · Auditoría</label><select id={`commercial-assignee-${unit.id}`} className="form-select" disabled={assigneesQuery.isLoading || assigneesQuery.isError} value={assignment.commercialAssigneeId} onChange={event => setAssignment(current => ({ ...current, commercialAssigneeId: event.target.value }))}><option value="">Sin asignar</option>{assigneeOptions.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.email}</option>)}</select></div>
        <div className="form-group"><label className="form-label" htmlFor={`go-live-assignee-${unit.id}`}>Owner OP / Go-Live</label><select id={`go-live-assignee-${unit.id}`} className="form-select" disabled={assigneesQuery.isLoading || assigneesQuery.isError} value={assignment.goLiveAssigneeId} onChange={event => setAssignment(current => ({ ...current, goLiveAssigneeId: event.target.value }))}><option value="">Sin asignar</option>{assigneeOptions.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.email}</option>)}</select></div>
      </div>
      <div className="unit-action-buttons"><button type="button" className="btn btn-ghost" disabled={!assignmentChanged || saveAssignment.isPending || assigneesQuery.isLoading || assigneesQuery.isError} onClick={() => saveAssignment.mutate()}>{saveAssignment.isPending ? 'Guardando…' : 'Guardar responsables'}</button></div>
    </section>}

    {requestKaType === 'KA' && ['configuring', 'audit_rejected'].includes(unit.stage) && <section className="unit-action-section">
      <div className="unit-action-title"><div><strong>Configuración previa a Auditoría</strong><span>Responsable: {unit.configurationAssignee?.name ?? 'OP Support por asignar'}</span></div><span className="onboarding-stage tone-active">KA</span></div>
      <ConfigurationBriefDisplay request={request} />
      {unit.configurationInput?.instructions && <p className="text-sm" style={{ padding: '8px 10px', borderRadius: 7, background: 'var(--amber-bg)' }}><strong>Excepción:</strong> {String(unit.configurationInput.instructions)}</p>}
      <textarea className="form-textarea" rows={3} disabled={!canConfigure} value={note} onChange={event => setNote(event.target.value)} placeholder="Notas o evidencia para Auditoría…" />
      {canConfigure && <div className="unit-action-buttons">{unit.stage === 'audit_rejected'
        ? <button className="btn btn-primary" disabled={action.isPending || !note.trim()} onClick={() => action.mutate('restart-configuration')}>Retomar corrección OP</button>
        : <button className="btn btn-primary" disabled={action.isPending} onClick={() => action.mutate('validate-configuration')}>Confirmar configuración validada</button>}</div>}
    </section>}

    {(['configuration_validated', 'audit_preparing'].includes(unit.stage) || (requestKaType !== 'KA' && unit.stage === 'audit_rejected')) && <section className="unit-action-section">
      <div className="unit-action-title"><div><strong>{unit.stage === 'audit_preparing' ? 'Preparación para Auditoría' : unit.stage === 'audit_rejected' ? 'Corrección Comercial' : 'Entrega a Comercial'}</strong><span>Responsable: {unit.commercialAssignee?.name ?? 'Comercial por asignar'}.</span></div><span className="onboarding-stage tone-active">{requestKaType}</span></div>
      <textarea className="form-textarea" rows={3} disabled={!canAudit} value={note} onChange={event => setNote(event.target.value)} placeholder="Preparación, corrección y evidencia de envío…" />
      {canAudit && <div className="unit-action-buttons">{unit.stage === 'audit_preparing'
        ? <button className="btn btn-primary" disabled={action.isPending || !note.trim()} onClick={() => action.mutate('submit-audit')}>Enviar / reenviar a Auditoría</button>
        : <button className="btn btn-primary" disabled={action.isPending} onClick={() => action.mutate('prepare-audit')}>{unit.stage === 'audit_rejected' ? 'Iniciar corrección Comercial' : 'Iniciar preparación Comercial'}</button>}</div>}
    </section>}

    {unit.stage === 'audit_needs_information' && <section className="unit-action-section audit-section">
      <div className="unit-action-title"><div><strong>Auditoría requiere información</strong><span>El flujo permanece bloqueado hasta que Comercial aporte la información y reenvíe.</span></div><span className="onboarding-stage tone-warning">Bloqueado</span></div>
      <textarea className="form-textarea" rows={3} disabled={!canAudit} value={auditNote} onChange={event => setAuditNote(event.target.value)} placeholder="Información aportada y evidencia…" />
      {canAudit && <div className="unit-action-buttons"><button className="btn btn-primary" disabled={action.isPending || !auditNote.trim()} onClick={() => action.mutate('resume-audit')}>Aportar información y retomar preparación</button></div>}
    </section>}

    {['awaiting_audit', 'audit_rejected', 'audit_approved', 'rtbo'].includes(unit.stage) && <section className="unit-action-section audit-section">
      <div className="unit-action-title"><div><strong>{requestKaType === 'KA' ? 'Auditoría gestionada por Comercial' : 'Resultado de Auditoría · Comercial'}</strong><span>{requestKaType === 'KA' ? 'Un rechazo devuelve la tienda a configuración OP.' : 'Comercial registra y corrige cualquier rechazo.'}</span></div><span className={`onboarding-stage tone-${unit.auditStatus === 'rejected' ? 'danger' : unit.auditStatus === 'approved' ? 'success' : 'warning'}`}>{unit.auditStatus ?? 'pending'}</span></div>
      <textarea className="form-textarea" rows={3} disabled={!canAudit || unit.stage !== 'awaiting_audit'} value={auditNote} onChange={event => setAuditNote(event.target.value)} placeholder="Resultado, observaciones o información requerida…" />
      <label className="form-label" htmlFor={`audit-evidence-${unit.id}`}>Evidencia básica <span className="text-muted">(opcional, una referencia por línea)</span></label>
      <textarea id={`audit-evidence-${unit.id}`} className="form-textarea" rows={3} disabled={!canAudit || unit.stage !== 'awaiting_audit'} value={auditEvidenceText} onChange={event => setAuditEvidenceText(event.target.value)} placeholder={'URL, folio o referencia 1\nURL, folio o referencia 2'} />
      <p className={`form-hint${auditEvidenceValid ? '' : ' text-danger'}`}>{auditEvidence.length} / 20 referencias; máximo 1000 caracteres por entrada.</p>
      {canAudit && unit.stage === 'awaiting_audit' && <div className="unit-action-buttons">
        <button className="btn btn-ghost" disabled={action.isPending || !auditNote.trim() || !auditEvidenceValid} onClick={() => action.mutate('needs-information')}>Requiere información</button>
        <button className="btn btn-danger" disabled={action.isPending || !auditNote.trim() || !auditEvidenceValid} onClick={() => action.mutate('reject')}>{requestKaType === 'KA' ? 'Rechazar y volver a OP' : 'Rechazar y corregir con Comercial'}</button>
        <button className="btn btn-primary" disabled={action.isPending || !auditEvidenceValid} onClick={() => action.mutate('approve')}>Registrar aprobación</button>
      </div>}
    </section>}

    {unit.stage === 'audit_approved' && <section className="unit-action-section">
      <div className="unit-action-title"><div><strong>Checklist y confirmación RTBO</strong><span>Responsable: {requestKaType === 'KA' ? kaRtboOwner : unit.configurationAssignee?.name ?? unit.goLiveAssignee?.name ?? request.brand.owner?.name ?? 'OP Support / Owner OP'}.</span></div></div>
      <div className="unit-checklist">{CHECKLIST_FIELDS.map(([key, label]) => <label key={key}><input type="checkbox" checked={checklist[key] === true} disabled={!canRtbo} onChange={event => setChecklist(current => ({ ...current, [key]: event.target.checked }))} /><span>{label}</span></label>)}</div>
      <textarea className="form-textarea" rows={3} disabled={!canRtbo} value={note} onChange={event => setNote(event.target.value)} placeholder="Notas o evidencia de RTBO…" />
      {canRtbo && <div className="unit-action-buttons"><button className="btn btn-ghost" disabled={action.isPending} onClick={() => action.mutate('checklist')}>Guardar checklist</button><button className="btn btn-primary" disabled={action.isPending || CHECKLIST_FIELDS.some(([key]) => checklist[key] !== true)} onClick={() => action.mutate('rtbo')}>Guardar y confirmar RTBO</button></div>}
    </section>}

    {['rtbo', 'awaiting_go_live', 'online_failed'].includes(unit.stage) && <section className="unit-action-section go-live-section">
      <div className="unit-action-title"><div><strong>Go-Live</strong><span>Responsable: {unit.goLiveAssignee?.name ?? request.brand.owner?.name ?? 'Owner OP / responsable asignado'}</span></div></div>
      {canGoLive
        ? <button className="btn btn-primary" disabled={action.isPending} onClick={() => action.mutate('go-live')}>{action.isPending ? 'Poniendo online…' : 'Poner tienda online'}</button>
        : <p className="text-muted text-sm">Acción restringida a la persona asignada.</p>}
    </section>}
  </Modal>;
}

function OnboardingDetail({ id }: { id: string }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { account } = useAuth();
  const [selectedUnit, setSelectedUnit] = useState<StoreOnboardingUnit | null>(null);
  const [selectedUnits, setSelectedUnits] = useState<Set<string>>(new Set());
  const [stageFilter, setStageFilter] = useState('');
  const [goLiveResult, setGoLiveResult] = useState<{ succeeded: number; pending: number; failed: number; errors: string[] } | null>(null);
  const query = useQuery<StoreOnboardingRequest>({
    queryKey: ['store-onboarding-detail', id],
    queryFn: () => storeOnboardingApi.get(id).then(response => response.data),
    refetchInterval: 10_000,
  });
  const forecastQuery = useQuery<StoreOnboardingForecast>({
    queryKey: ['store-onboarding-forecast', id],
    queryFn: () => storeOnboardingApi.forecast(id).then(response => response.data),
    retry: false,
  });
  const recalc = useMutation({
    mutationFn: () => storeOnboardingApi.recalculateForecast(id),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['store-onboarding-detail', id] }),
        qc.invalidateQueries({ queryKey: ['store-onboarding-forecast', id] }),
      ]);
    },
  });
  const bulkGoLive = useMutation({
    mutationFn: () => storeOnboardingApi.goLive(id, [...selectedUnits]),
    onSuccess: async response => {
      setGoLiveResult({
        succeeded: response.data.succeeded,
        pending: response.data.pending ?? 0,
        failed: response.data.failed,
        errors: response.data.results.filter(result => result.error).map(result => `${result.externalShopId}: ${result.error}`),
      });
      setSelectedUnits(new Set());
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['store-onboarding-detail', id] }),
        qc.invalidateQueries({ queryKey: ['store-onboarding-forecast', id] }),
        qc.invalidateQueries({ queryKey: ['store-onboarding-timeline', id] }),
        qc.invalidateQueries({ queryKey: ['store-onboarding'] }),
      ]);
    },
  });
  const request = query.data;
  if (query.isLoading) return <><Topbar breadcrumb={[{ label: 'Store Onboarding', href: '/integrations/store-onboarding' }, { label: 'Cargando…' }]} /><main className="main-content"><div className="onboarding-empty">Cargando detalle…</div></main></>;
  if (query.isError || !request) return <><Topbar breadcrumb={[{ label: 'Store Onboarding', href: '/integrations/store-onboarding' }, { label: 'No encontrado' }]} /><main className="main-content"><div className="error-banner">No se encontró esta solicitud.</div></main></>;

  const requestKaType = workflowKaType(request);
  const requestCountry = workflowCountry(request);
  const configurationBriefAssigneeName = request.configurationBriefAssignee?.name ?? 'Responsable KA por asignar';
  const units = (request.units ?? []).filter(unit => !stageFilter || unit.stage === stageFilter);
  const canManage = hasPermission(account, 'system.manage');
  const canSelectForGoLive = (unit: StoreOnboardingUnit) => ['rtbo', 'awaiting_go_live', 'online_failed'].includes(String(unit.stage))
    && (canManage || unit.goLiveAssigneeId === account?.id || request.brand.owner?.id === account?.id);
  const forecast = forecastQuery.data ?? request.forecast;
  const milestones = normalizeMilestones(forecast);
  const progress = progressOf(request);
  const toggle = (unitId: string) => setSelectedUnits(current => {
    const next = new Set(current);
    if (next.has(unitId)) next.delete(unitId);
    else next.add(unitId);
    return next;
  });
  const brandStatus = request.brandDependency?.status;

  return <>
    <Topbar breadcrumb={[{ label: 'Store Onboarding', href: '/integrations/store-onboarding' }, { label: request.brand.brandName }]} />
    <main className="main-content onboarding-page">
      <div className="onboarding-detail-header">
        <button className="btn btn-ghost" onClick={() => nav('/integrations/store-onboarding')}>← Volver</button>
        <div className="onboarding-detail-title"><div><span className="onboarding-eyebrow">{request.source} · {requestCountry} · {requestKaType} · {request.workflowVersion ?? 'flujo versionado'}</span><h1>{request.brand.brandName}</h1><p>{request.totalUnits} tienda(s) · Creado por {request.createdBy?.name ?? 'sistema'}</p></div><span className={`onboarding-stage tone-${stageTone(request.currentStage)}`}>{stageLabel(request.currentStage)}</span></div>
      </div>
      <div className="onboarding-route-strip">
        <div className={brandStatus === 'waiting' ? 'active' : brandStatus === 'failed' ? 'has-error' : 'complete'}><span>1</span><strong>Brand creada</strong><small>{brandStatus === 'waiting' ? 'Esperando Task compartido' : brandStatus === 'failed' ? 'Task de Brand fallido' : request.brandDependency?.autoCompleted === false ? 'Task compartido completado' : 'Existente · automático · 0 min'}</small></div>
        <div className={request.currentStage.includes('creat') || request.currentStage === 'awaiting_shop_ids' ? 'active' : ''}><span>2</span><strong>Creación + IDs</strong><small>{requestKaType === 'KA' ? request.currentStage === 'awaiting_shop_ids' ? 'Acción pendiente OP Support' : 'Shop IDs confirmados' : request.brand.owner?.name ?? 'Task Create / Duplicate'}</small></div>
        {requestKaType === 'KA' && <div className={['awaiting_configuration_brief', 'integration_queued', 'configuring', 'configuration_validated'].includes(request.currentStage) ? 'active' : ''}><span>3</span><strong>Configuración</strong><small>{request.currentStage === 'awaiting_configuration_brief' ? `${configurationBriefAssigneeName} publica ficha` : 'OP Support configura y valida'}</small></div>}
        <div className={['audit_preparing', 'awaiting_audit', 'audit_needs_information', 'audit_rejected', 'audit_approved'].includes(request.currentStage) ? 'active' : ''}><span>{requestKaType === 'KA' ? 4 : 3}</span><strong>Auditoría</strong><small>{requestKaType === 'KA' ? 'Comercial registra; rechazo vuelve a OP' : 'Comercial prepara, registra y corrige'}</small></div>
        <div className={['audit_approved', 'rtbo', 'integration_complete'].includes(request.currentStage) ? 'active' : ''}><span>{requestKaType === 'KA' ? 5 : 4}</span><strong>RTBO</strong><small>{requestKaType === 'KA' ? `${configurationBriefAssigneeName} confirma` : 'OP Support / Owner OP confirma'}</small></div>
        <div className={['awaiting_go_live', 'going_online', 'online', 'online_failed'].includes(request.currentStage) ? 'active' : ''}><span>{requestKaType === 'KA' ? 6 : 5}</span><strong>Go-Live</strong><small>{request.units?.[0]?.goLiveAssignee?.name ?? request.brand.owner?.name ?? 'Owner OP / responsable asignado'}</small></div>
      </div>
      <div className="onboarding-detail-grid">
        <section className="card onboarding-progress-card"><div className="card-header"><div><span className="card-title">Progreso general</span><p className="text-muted text-sm">{request.completedUnits} terminadas · {request.failedUnits} con error</p></div><strong>{progress}%</strong></div><div className="onboarding-big-progress"><div style={{ width: `${progress}%` }} /></div></section>
        <section className="card onboarding-eta-card"><div className="card-header"><div><span className="card-title">ETA dinámico</span><p className="text-muted text-sm">Incluye Brand, cola y calendario laboral</p></div>{canManage && <button className="btn btn-sm btn-ghost" disabled={recalc.isPending} onClick={() => recalc.mutate()}>{recalc.isPending ? 'Calculando…' : 'Recalcular'}</button>}</div><strong>{formatDate(forecast?.estimatedCompletionAt ?? request.estimatedCompletionAt)}</strong><span className={`eta-confidence confidence-${forecast?.confidence ?? request.etaConfidence ?? 'unavailable'}`}>Confianza {forecast?.confidence ?? request.etaConfidence ?? 'sin calcular'} · {forecast?.queueUnits ?? 0} unidades en cola</span></section>
      </div>
      {milestones.length > 0 && <section className="card onboarding-milestones"><div className="card-header"><span className="card-title">Hitos estimados</span></div><div>{milestones.map((milestone, index) => <div key={`${milestone.stage}-${index}`}><span>{index + 1}</span><strong>{milestone.label ?? stageLabel(milestone.stage)}</strong><small>{formatDate(milestone.estimatedAt)}{milestone.queueUnits != null ? ` · Cola ${milestone.queueUnits}` : ''}</small></div>)}</div>{forecast?.explanation && <p>{Array.isArray(forecast.explanation) ? forecast.explanation.join(' · ') : forecast.explanation}</p>}</section>}
      <OperationalTimeline request={request} forecast={forecast} />
      <ShopIdHandoffPanel request={request} />
      {requestKaType === 'KA' && request.shopIdsValidatedAt && <ConfigurationBriefPanel request={request} />}
      {bulkGoLive.isError && <div className="error-banner">{errorMessage(bulkGoLive.error, 'No se pudo ejecutar el Go-Live masivo.')}</div>}
      {goLiveResult && <div className={goLiveResult.failed ? 'onboarding-go-live-result has-errors' : 'onboarding-go-live-result'}><strong>{goLiveResult.succeeded} tienda(s) online · {goLiveResult.pending} pendiente(s) de verificación · {goLiveResult.failed} fallida(s)</strong>{goLiveResult.errors.map(error => <span key={error}>{error}</span>)}</div>}
      <section className="card onboarding-units-card">
        <div className="card-header"><div><span className="card-title">Resultado por tienda</span><p className="text-muted text-sm">{requestKaType === 'KA' ? `OP configura; Comercial gestiona Auditoría; ${configurationBriefAssigneeName} confirma RTBO y Owner OP ejecuta Go-Live.` : 'Comercial prepara, registra y corrige Auditoría; OP Support / Owner OP confirma RTBO y ejecuta Go-Live.'}</p></div><div className="onboarding-unit-actions"><select className="form-select" value={stageFilter} onChange={event => setStageFilter(event.target.value)}><option value="">Todas las etapas</option>{Object.entries(STAGE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{selectedUnits.size > 0 && <><span>{selectedUnits.size} seleccionada(s)</span><button className="btn btn-sm btn-primary" disabled={bulkGoLive.isPending} onClick={() => bulkGoLive.mutate()}>{bulkGoLive.isPending ? 'Ejecutando…' : 'Go-Live seleccionado'}</button></>}</div></div>
        <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}><table>
          <thead><tr><th></th><th>Tienda</th><th>Etapa</th><th>{requestKaType === 'KA' ? 'Configuración OP' : 'Preparación Comercial'}</th><th>Auditoría / corrección</th><th>RTBO</th><th>Go-Live</th><th>Resultado</th><th></th></tr></thead>
          <tbody>{units.map(unit => <tr key={unit.id} className={unit.lastError ? 'unit-has-error' : ''}>
            <td>{canSelectForGoLive(unit) ? <input type="checkbox" aria-label={`Seleccionar ${unit.externalShopId} para Go-Live`} checked={selectedUnits.has(unit.id)} onChange={() => toggle(unit.id)} /> : <span className="text-muted">—</span>}</td>
            <td><strong>{unit.externalShopId}</strong><div className="text-muted text-sm">{unit.appShopId ?? 'Sin App Shop ID'}</div></td>
            <td><span className={`onboarding-stage tone-${stageTone(unit.stage)}`}>{stageLabel(unit.stage)}</span></td>
            <td>{requestKaType === 'KA' ? unit.configurationAssignee?.name ?? '—' : unit.commercialAssignee?.name ?? 'Comercial por asignar'}<small>{requestKaType === 'KA' ? formatDate(unit.configurationCompletedAt) : unit.stage === 'audit_rejected' ? 'Corrección Comercial' : 'Preparación y envío'}</small></td>
            <td>{unit.auditedBy?.name ?? unit.commercialAssignee?.name ?? '—'}<small>{unit.auditStatus ?? 'Pendiente'}</small></td>
            <td>{requestKaType === 'KA' ? configurationBriefAssigneeName : unit.configurationAssignee?.name ?? unit.goLiveAssignee?.name ?? request.brand.owner?.name ?? 'OP Support / Owner OP'}<small>{formatDate(unit.rtboAt)}</small></td>
            <td>{unit.goLiveAssignee?.name ?? request.brand.owner?.name ?? '—'}<small>{unit.onlineSource ? `Fuente: ${unit.onlineSource.replace('_', ' ')}` : ''}</small></td>
            <td>{unit.lastError ? <span className="unit-error">{unit.lastError}</span> : unit.onlineAt ? <span className="onboarding-ok">Online · {formatDate(unit.onlineAt)}</span> : <span className="text-muted">En proceso</span>}</td>
            <td><button className="btn btn-sm btn-ghost" onClick={() => setSelectedUnit(unit)}>Gestionar</button></td>
          </tr>)}</tbody>
        </table></div>
        {units.length === 0 && <div className="onboarding-empty">No hay tiendas para esta etapa.</div>}
      </section>
    </main>
    {selectedUnit && <UnitActionModal request={request} unit={selectedUnit} onClose={() => setSelectedUnit(null)} />}
  </>;
}

export default function StoreOnboardingPage() {
  const { id } = useParams<{ id?: string }>();
  const { account } = useAuth();
  const [openSettings, setOpenSettings] = useState(false);
  const feature = useStoreOnboardingFeature();
  const canManageMaster = hasPermission(account, 'system.manage');
  if (feature.isLoading) return <><Topbar breadcrumb={[{ label: 'Integrations' }, { label: 'Store Onboarding' }]} /><main className="main-content onboarding-page"><div className="onboarding-empty">Verificando habilitación segura…</div></main></>;
  if (!feature.globalEnabled) return <>
    <Topbar breadcrumb={[{ label: 'Integrations' }, { label: 'Store Onboarding' }]} />
    <main className="main-content onboarding-page onboarding-disabled-page"><section className="onboarding-disabled-card" role="status">
      <span className="onboarding-off-badge">Global OFF</span><div className="onboarding-disabled-icon" aria-hidden="true">⏸</div><h1>Piloto de Store Onboarding desactivado</h1>
      <p>Producción conserva el flujo actual. No se consultaron solicitudes, no se habilitaron acciones operativas y no se enviarán notificaciones.</p>
      {feature.reason && <p className="text-muted text-sm">{feature.reason}</p>}
      <div className="onboarding-disabled-safety"><strong>Estado seguro</strong><span>Sin inscripción de requests nuevos · sin backfill · sin ejecuciones · sin webhooks</span></div>
      {canManageMaster && <button type="button" className="btn btn-ghost" onClick={() => setOpenSettings(true)}>Preparar piloto y control maestro</button>}
    </section></main>
    {openSettings && <StoreOnboardingSettingsModal onClose={() => setOpenSettings(false)} />}
  </>;
  return <>{id ? <OnboardingDetail id={id} /> : <OnboardingList />}</>;
}
