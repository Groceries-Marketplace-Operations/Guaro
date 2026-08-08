import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import { applicationsApi, offerMenuUploadApi, sftpApplicationsApi } from '../../api';
import type { Application, OfferMenuUploadRule, Paginated, SftpApplication } from '../../types';

interface FormState {
  name: string;
  sftpApplicationId: string;
  applicationId: string;
  active: boolean;
  dryRun: boolean;
  runNow: boolean;
  scheduleHours: string;
  timezone: string;
  filePattern: string;
  delimiter: string;
  categoryIdPrefix: string;
  categoryName: string;
  menuIdPrefix: string;
  menuNamePrefix: string;
  mergePolicy: number;
  storeConcurrency: number;
  maxItemsPerStore: number;
  maxItemsPerCategory: number;
  activeStatus: number;
  includeTaxInfo: boolean;
  taxType: number;
  taxRate: number;
}

const activeStatuses = new Set(['pending', 'running']);

function emptyForm(): FormState {
  return {
    name: '', sftpApplicationId: '', applicationId: '', active: false, dryRun: true, runNow: false,
    scheduleHours: '10,20', timezone: 'America/Mexico_City', filePattern: 'offer*.csv', delimiter: ';',
    categoryIdPrefix: 'category_0', categoryName: 'Despensa', menuIdPrefix: 'menu', menuNamePrefix: 'Menu',
    mergePolicy: 1, storeConcurrency: 2, maxItemsPerStore: 30000, maxItemsPerCategory: 4999,
    activeStatus: 1, includeTaxInfo: false, taxType: 1, taxRate: 1600,
  };
}

function apiError(reason: unknown) {
  const value = reason as { response?: { data?: { message?: string | string[] } } };
  const message = value.response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : message ?? 'La acción no pudo completarse';
}

function date(value?: string) {
  return value ? new Date(value).toLocaleString() : '—';
}

function hours(value: string) {
  return [...new Set(value.split(/[,;\s]+/).map(item => Number(item)).filter(item => Number.isInteger(item) && item >= 0 && item <= 23))].sort((a, b) => a - b);
}

export default function OfferMenuUploadSection() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<OfferMenuUploadRule | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data: rules = [], isLoading } = useQuery<OfferMenuUploadRule[]>({
    queryKey: ['offer-menu-upload-rules'],
    queryFn: () => offerMenuUploadApi.list().then(response => response.data),
    refetchInterval: query => (query.state.data as OfferMenuUploadRule[] | undefined)
      ?.some(rule => rule.executions.some(execution => activeStatuses.has(execution.status))) ? 3000 : 15000,
  });
  const { data: sftpData } = useQuery<Paginated<SftpApplication>>({
    queryKey: ['sftp-applications', 'offer-menu'],
    queryFn: () => sftpApplicationsApi.list({ page: 1, limit: 100 }).then(response => response.data),
  });
  const { data: applicationData } = useQuery<Paginated<Application>>({
    queryKey: ['applications', 'offer-menu'],
    queryFn: () => applicationsApi.list({ page: 1, limit: 100 }).then(response => response.data),
  });
  const sftpApps = useMemo(() => sftpData?.data.filter(item => item.active) ?? [], [sftpData]);
  const applications = applicationData?.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['offer-menu-upload-rules'] });
  const save = useMutation({
    mutationFn: () => {
      const payload = { ...form, scheduleHours: hours(form.scheduleHours), runNow: !editing && form.runNow };
      return editing ? offerMenuUploadApi.update(editing.id, payload) : offerMenuUploadApi.create(payload);
    },
    onSuccess: () => { refresh(); setOpen(false); setEditing(null); setError(''); },
    onError: reason => setError(apiError(reason)),
  });
  const action = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: 'run' | 'stop' | 'delete' }) => verb === 'run'
      ? offerMenuUploadApi.run(id) : verb === 'stop' ? offerMenuUploadApi.stop(id) : offerMenuUploadApi.delete(id),
    onSuccess: refresh,
    onError: reason => window.alert(apiError(reason)),
  });

  const openCreate = () => { setEditing(null); setForm(emptyForm()); setError(''); setOpen(true); };
  const openEdit = (rule: OfferMenuUploadRule) => {
    setEditing(rule);
    setForm({
      name: rule.name, sftpApplicationId: rule.sftpApplicationId, applicationId: rule.applicationId,
      active: rule.active, dryRun: rule.dryRun, runNow: false, scheduleHours: rule.scheduleHours.join(','),
      timezone: rule.timezone, filePattern: rule.filePattern, delimiter: rule.delimiter,
      categoryIdPrefix: rule.categoryIdPrefix, categoryName: rule.categoryName, menuIdPrefix: rule.menuIdPrefix,
      menuNamePrefix: rule.menuNamePrefix, mergePolicy: rule.mergePolicy, storeConcurrency: rule.storeConcurrency,
      maxItemsPerStore: rule.maxItemsPerStore, maxItemsPerCategory: rule.maxItemsPerCategory,
      activeStatus: rule.activeStatus, includeTaxInfo: rule.includeTaxInfo, taxType: rule.taxType, taxRate: rule.taxRate,
    });
    setError(''); setOpen(true);
  };
  const valid = form.name.trim().length >= 2 && form.sftpApplicationId && form.applicationId
    && hours(form.scheduleHours).length > 0 && form.filePattern.trim() && form.delimiter.length === 1;
  const submit = () => {
    if (!form.dryRun && form.mergePolicy === 1 && !window.confirm('Modo real + Reemplazar puede sobrescribir el menú actual de cada tienda. ¿Confirmas guardar esta configuración?')) return;
    save.mutate();
  };

  return <section style={{ marginBottom: 22 }}>
    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
        <div><strong>SFTP Offer Menu Upload</strong><p className="text-muted" style={{ marginTop: 5, fontSize: 12 }}>
          Toma el offer*.csv más reciente, agrupa SKU por STOREID y prepara price/activity_price para uploadGrocery. La simulación valida SFTP, CSV, tiendas y límites sin modificar DiDi.
        </p></div>
        <button className="btn btn-primary" onClick={openCreate}>+ Nueva regla</button>
      </div>
    </div>
    <div className="alert alert-info" style={{ marginBottom: 14 }}>
      Cada tienda se envía en un solo request a uploadGrocery: primero se mandan todos los menús y al final se consultan los taskID. Así una respuesta lenta de DiDi no retrasa las demás modificaciones.
    </div>
    {isLoading && <p className="text-muted">Cargando reglas…</p>}
    {!isLoading && rules.length === 0 && <div className="empty-state"><p>No hay reglas SFTP Offer configuradas.</p></div>}
    <div style={{ display: 'grid', gap: 12 }}>
      {rules.map(rule => {
        const latest = rule.executions[0];
        const running = latest && activeStatuses.has(latest.status);
        const stores = latest?.result?.stores ?? [];
        const phase = latest?.result?.phase;
        const phaseLabel = phase === 'submitting'
          ? `Enviando menús: ${latest?.result?.submissionProcessedStores ?? 0}/${latest?.totalStores ?? 0}`
          : phase === 'checking_status'
            ? `Consultando taskID: ${latest?.result?.checkedStores ?? 0}/${latest?.result?.submittedStores ?? 0}`
            : phase === 'complete' ? 'Carga y verificación terminadas' : null;
        return <article key={rule.id} className="card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{rule.name}</strong><StatusBadge status={rule.active ? 'active' : 'inactive'} />
                <span className="badge">{rule.dryRun ? 'Simulación' : 'REAL'}</span>
                <span className="badge">{rule.sftpApplication.name}</span><span className="badge">{rule.application.appName}</span>
                <span className="badge">{rule.filePattern}</span><span className="badge">{rule.scheduleHours.map(value => `${String(value).padStart(2, '0')}:00`).join(' / ')}</span>
                {latest && <StatusBadge status={latest.status} />}
              </div>
              <p className="text-muted" style={{ marginTop: 8, fontSize: 12 }}>
                Próxima: {date(rule.nextRunAt)} · Última: {date(rule.lastRunAt)} · Paralelismo: {rule.storeConcurrency} tiendas · Request: hasta {rule.maxItemsPerStore.toLocaleString()} ítems
              </p>
              <p className="text-muted" style={{ marginTop: 5, fontSize: 12 }}>
                Último archivo cargado: {rule.lastSourceFile ?? '—'} · Creada por {rule.createdBy?.name ?? rule.createdBy?.email ?? 'Sistema'}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" disabled={!!running || action.isPending} onClick={() => action.mutate({ id: rule.id, verb: 'run' })}>Ejecutar ahora</button>
              {running && <button className="btn btn-ghost btn-sm" onClick={() => action.mutate({ id: rule.id, verb: 'stop' })}>Detener</button>}
              <button className="btn btn-ghost btn-sm" disabled={!!running} onClick={() => openEdit(rule)}>Editar</button>
              <button className="btn btn-ghost btn-sm" disabled={!!running} style={{ color: 'var(--red)' }} onClick={() => {
                if (window.confirm(`¿Eliminar ${rule.name}?`)) action.mutate({ id: rule.id, verb: 'delete' });
              }}>Eliminar</button>
            </div>
          </div>
          {latest && <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            {phaseLabel && <div className="alert alert-info" style={{ marginBottom: 10, padding: '9px 12px' }}>
              <strong>{phaseLabel}</strong>
              {phase === 'checking_status' && <span> · {latest.result?.submittedStores ?? 0} payloads ya fueron enviados a DiDi.</span>}
            </div>}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <span>{latest.processedStores}/{latest.totalStores} tiendas</span><span>{latest.totalItems.toLocaleString()} ítems</span>
              <span style={{ color: 'var(--green)' }}>{latest.successfulStores} exitosas</span>
              <span style={{ color: latest.failedStores ? 'var(--red)' : undefined }}>{latest.failedStores} fallidas</span>
              {latest.currentStoreId && <span>Procesando {latest.currentStoreId}</span>}
              {stores.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(expanded === latest.id ? null : latest.id)}>{expanded === latest.id ? 'Ocultar detalle' : 'Ver tiendas'}</button>}
            </div>
            <p className="text-muted" style={{ marginTop: 7, fontSize: 12 }}>Archivo: {latest.sourceFile ?? '—'} · Modificado: {date(latest.sourceModifiedAt)}{latest.result?.skipped ? ` · Omitido: ${latest.result.reason}` : ''}</p>
            {latest.errorMessage && <p style={{ color: 'var(--red)', marginTop: 8 }}>{latest.errorMessage}</p>}
            {expanded === latest.id && <div className="table-wrap" style={{ marginTop: 12 }}><table>
              <thead><tr><th>STOREID</th><th>app_shop_id</th><th>Resultado</th><th>Ítems</th><th>Cargados</th><th>Task IDs / error</th></tr></thead>
              <tbody>{stores.map(store => <tr key={store.storeId}>
                <td className="td-mono">{store.storeId}</td><td className="td-mono">{store.appShopId}</td><td><StatusBadge status={store.status} /></td>
                <td>{store.itemCount}</td><td>{store.dryRun ? 'Simulación' : store.uploadedItems}</td>
                <td className="td-mono">{store.error ?? (store.taskIds.join(', ') || '—')}{store.failedItems.length ? ` · ${store.failedItems.length} fallidos` : ''}</td>
              </tr>)}</tbody>
            </table></div>}
          </div>}
        </article>;
      })}
    </div>

    {open && <Modal title={editing ? 'Editar SFTP Offer Menu Upload' : 'Nueva regla SFTP Offer Menu Upload'} onClose={() => setOpen(false)} footer={<>
      <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
      <button className="btn btn-primary" disabled={!valid || save.isPending} onClick={submit}>{save.isPending ? 'Guardando…' : 'Guardar regla'}</button>
    </>}>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-group"><label className="form-label">Nombre *</label><input className="form-input" value={form.name} onChange={event => setForm(value => ({ ...value, name: event.target.value }))} /></div>
      <div className="form-row">
        <div className="form-group"><label className="form-label">Conexión SFTP *</label><select className="form-input" value={form.sftpApplicationId} onChange={event => setForm(value => ({ ...value, sftpApplicationId: event.target.value }))}><option value="">Selecciona…</option>{sftpApps.map(item => <option key={item.id} value={item.id}>{item.name} · {item.host}:{item.port}</option>)}</select></div>
        <div className="form-group"><label className="form-label">Aplicación DiDi *</label><select className="form-input" value={form.applicationId} onChange={event => setForm(value => ({ ...value, applicationId: event.target.value }))}><option value="">Selecciona…</option>{applications.map(item => <option key={item.id} value={item.id}>{item.appName} · {item.country} · {item.appId}</option>)}</select></div>
      </div>
      <div className="form-row">
        <div className="form-group"><label className="form-label">Horas CDMX *</label><input className="form-input" value={form.scheduleHours} onChange={event => setForm(value => ({ ...value, scheduleHours: event.target.value }))} /><p className="form-hint">Horas 0–23 separadas por coma. Ejemplo: 10,20.</p></div>
        <div className="form-group"><label className="form-label">Patrón de archivo *</label><input className="form-input" value={form.filePattern} onChange={event => setForm(value => ({ ...value, filePattern: event.target.value }))} /><p className="form-hint">Patrón glob, por ejemplo offer*.csv.</p></div>
      </div>
      <div className="form-row">
        <div className="form-group"><label className="form-label">Nombre de categoría *</label><input className="form-input" value={form.categoryName} onChange={event => setForm(value => ({ ...value, categoryName: event.target.value }))} /></div>
        <div className="form-group"><label className="form-label">Prefijo category_id *</label><input className="form-input" value={form.categoryIdPrefix} onChange={event => setForm(value => ({ ...value, categoryIdPrefix: event.target.value }))} /></div>
      </div>
      <div className="form-row">
        <div className="form-group"><label className="form-label">Concurrencia de tiendas</label><input className="form-input" type="number" min={1} max={5} value={form.storeConcurrency} onChange={event => setForm(value => ({ ...value, storeConcurrency: Number(event.target.value) }))} /></div>
        <div className="form-group"><label className="form-label">Ítems máximos por request/tienda</label><input className="form-input" type="number" min={1} max={30000} value={form.maxItemsPerStore} onChange={event => setForm(value => ({ ...value, maxItemsPerStore: Number(event.target.value) }))} /><p className="form-hint">Un solo POST por tienda; límite 30,000.</p></div>
        <div className="form-group"><label className="form-label">Ítems por categoría</label><input className="form-input" type="number" min={1} max={5000} value={form.maxItemsPerCategory} onChange={event => setForm(value => ({ ...value, maxItemsPerCategory: Number(event.target.value) }))} /></div>
      </div>
      <div className="form-group"><label className="form-label">Política de carga</label><select className="form-input" value={form.mergePolicy} onChange={event => setForm(value => ({ ...value, mergePolicy: Number(event.target.value) }))}><option value={1}>Reemplazar menú</option><option value={0}>Merge / agregar o actualizar</option></select></div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}><input type="checkbox" checked={form.dryRun} onChange={event => setForm(value => ({ ...value, dryRun: event.target.checked }))} /> Simulación segura (no llama uploadGrocery)</label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}><input type="checkbox" checked={form.active} onChange={event => setForm(value => ({ ...value, active: event.target.checked }))} /> Programación activa</label>
      {!editing && <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={form.runNow} onChange={event => setForm(value => ({ ...value, runNow: event.target.checked }))} /> Ejecutar al guardar</label>}
    </Modal>}
  </section>;
}
