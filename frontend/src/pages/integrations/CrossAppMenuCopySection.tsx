import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import { menuCopyApi } from '../../api';
import type { MenuCopyExecution } from '../../types';
import ApplicationSearchField from './ApplicationSearchField';

interface FormState {
  sourceApplicationId: string;
  sourceApplicationSearch: string;
  sourceShopId: string;
  targetApplicationId: string;
  targetApplicationSearch: string;
  targetShopIds: string;
  mergePolicy: number;
  uploadEndpoint: 'uploadGrocery' | 'updateItemsync';
}
const activeStatuses = new Set(['pending', 'running']);
const shopIdPattern = /^57\d{17}$/;

const initialForm = (): FormState => ({
  sourceApplicationId: '', sourceApplicationSearch: '', sourceShopId: '',
  targetApplicationId: '', targetApplicationSearch: '', targetShopIds: '', mergePolicy: 0, uploadEndpoint: 'uploadGrocery',
});

const stepLabels: Record<string, string> = {
  queued: 'En cola',
  resolving_source_shop: 'Resolviendo tienda origen',
  resolving_target_shop: 'Resolviendo tienda destino',
  downloading_source_menu: 'Descargando menú origen',
  uploading_target_menu: 'Subiendo menú destino',
  completed: 'Completado',
};

function apiError(reason: unknown) {
  const message = (reason as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : message ?? 'No se pudo iniciar la copia';
}

function date(value?: string) {
  return value ? new Date(value).toLocaleString() : '—';
}

function parseTargetShopIds(value: string) {
  return [...new Set(value.split(/[\s,;]+/).map(entry => entry.trim()).filter(Boolean))];
}

export default function CrossAppMenuCopySection() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(initialForm);
  const [error, setError] = useState('');
  const [sourceExecution, setSourceExecution] = useState<MenuCopyExecution | null>(null);
  const { data: executions = [], isLoading } = useQuery<MenuCopyExecution[]>({
    queryKey: ['menu-copy-executions'],
    queryFn: () => menuCopyApi.list().then(response => response.data),
    refetchInterval: query => (query.state.data as MenuCopyExecution[] | undefined)
      ?.some(execution => activeStatuses.has(execution.status)) ? 3000 : 15000,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['menu-copy-executions'] });
  const targetShopIds = parseTargetShopIds(form.targetShopIds);
  const create = useMutation({
    mutationFn: () => menuCopyApi.create({
      sourceApplicationId: form.sourceApplicationId,
      sourceShopId: form.sourceShopId.trim(),
      targetApplicationId: form.targetApplicationId,
      targetShopIds,
      mergePolicy: form.mergePolicy,
      uploadEndpoint: form.uploadEndpoint,
    }),
    onSuccess: () => { refresh(); setOpen(false); setForm(initialForm()); setSourceExecution(null); setError(''); },
    onError: reason => setError(apiError(reason)),
  });
  const stop = useMutation({
    mutationFn: (id: string) => menuCopyApi.stop(id),
    onSuccess: refresh,
    onError: reason => window.alert(apiError(reason)),
  });

  const valid = !!form.sourceApplicationId && !!form.targetApplicationId
    && shopIdPattern.test(form.sourceShopId.trim())
    && targetShopIds.length > 0 && targetShopIds.length <= 500
    && targetShopIds.every(shopId => shopIdPattern.test(shopId))
    && !(form.sourceApplicationId === form.targetApplicationId && targetShopIds.includes(form.sourceShopId.trim()));

  const submit = () => {
    if (form.uploadEndpoint === 'uploadGrocery' && form.mergePolicy === 1 && !window.confirm(`Reemplazar sobrescribirá el menú actual de ${targetShopIds.length} tienda(s) destino. ¿Continuar?`)) return;
    create.mutate();
  };

  const openCreate = () => {
    setSourceExecution(null);
    setForm(initialForm());
    setError('');
    setOpen(true);
  };

  const openFromExecution = (execution: MenuCopyExecution) => {
    setSourceExecution(execution);
    setForm({
      sourceApplicationId: execution.sourceApplicationId,
      sourceApplicationSearch: `${execution.sourceApplication.appName} · ${execution.sourceApplication.country} · ${execution.sourceApplication.appId}`,
      sourceShopId: execution.sourceShopId,
      targetApplicationId: execution.targetApplicationId,
      targetApplicationSearch: `${execution.targetApplication.appName} · ${execution.targetApplication.country} · ${execution.targetApplication.appId}`,
      targetShopIds: execution.targetShopId,
      mergePolicy: execution.mergePolicy,
      uploadEndpoint: execution.uploadEndpoint ?? 'uploadGrocery',
    });
    setError('');
    setOpen(true);
  };

  return <section style={{ marginBottom: 22 }}>
    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
        <div>
          <strong>Cross-App Menu Copy</strong>
          <p className="text-muted" style={{ marginTop: 5, fontSize: 12 }}>
            Copia los ítems entre tiendas de la misma o de diferentes aplicaciones en categorías planas Cate_Grocery_N de hasta 3,500 ítems. Cada destino se procesa y reporta por separado.
          </p>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Nueva copia</button>
      </div>
    </div>

    {isLoading && <p className="text-muted">Cargando ejecuciones…</p>}
    {!isLoading && executions.length === 0 && <div className="empty-state"><p>No hay copias de menú entre aplicaciones.</p></div>}
    <div style={{ display: 'grid', gap: 12 }}>
      {executions.map(execution => {
        const running = activeStatuses.has(execution.status);
        return <article key={execution.id} className="card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
            <div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <strong>{execution.sourceApplication.appName} → {execution.targetApplication.appName}</strong>
                <StatusBadge status={execution.status} />
                <span className="badge">{execution.uploadEndpoint === 'updateItemsync' ? 'updateItemsync' : 'uploadGrocery'}</span>
                {execution.uploadEndpoint === 'uploadGrocery' && <span className="badge">{execution.mergePolicy === 1 ? 'Reemplazar' : 'Merge'}</span>}
              </div>
              <p className="text-muted" style={{ marginTop: 7, fontSize: 12 }}>
                {execution.sourceShopId} ({execution.sourceApplication.appId}) → {execution.targetShopId} ({execution.targetApplication.appId})
              </p>
              <p className="text-muted" style={{ marginTop: 5, fontSize: 12 }}>
                Paso: {stepLabels[execution.currentStep ?? ''] ?? execution.currentStep ?? '—'} · Creada: {date(execution.createdAt)} · Finalizada: {date(execution.finishedAt)}
              </p>
              {(execution.itemCount > 0 || execution.categoryCount > 0) && <p style={{ marginTop: 6, fontSize: 12 }}>{execution.itemCount} ítems · {execution.categoryCount} categorías · taskID carga: {execution.uploadTaskId ?? '—'}</p>}
              {execution.errorMessage && <p style={{ color: 'var(--red)', marginTop: 7 }}>{execution.errorMessage}</p>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {!running && <button className="btn btn-ghost btn-sm" onClick={() => openFromExecution(execution)}>Editar y repetir</button>}
              {running && <button className="btn btn-ghost btn-sm" disabled={stop.isPending} onClick={() => stop.mutate(execution.id)}>Detener</button>}
            </div>
          </div>
        </article>;
      })}
    </div>

    {open && <Modal title={sourceExecution ? 'Editar y volver a ejecutar la copia' : 'Copiar menú entre aplicaciones'} onClose={() => setOpen(false)} footer={<>
      <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
      <button className="btn btn-primary" disabled={!valid || create.isPending} onClick={submit}>{create.isPending ? 'Enviando…' : sourceExecution ? 'Crear nueva ejecución' : 'Iniciar copia'}</button>
    </>}>
      {error && <div className="error-banner">{error}</div>}
      {sourceExecution && <div className="alert alert-info" style={{ marginBottom: 14 }}>Se cargaron los valores de la ejecución anterior. Puedes modificar cualquier campo; al confirmar se creará una ejecución nueva y el historial original no cambiará.</div>}
      <div className="alert alert-info" style={{ marginBottom: 14 }}>Puedes seleccionar la misma aplicación como origen y destino. Usa shop_id de 19 dígitos; el sistema resuelve internamente cada app_shop_id.</div>
      <div className="form-row">
        <div>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Origen</h3>
          <div className="form-group"><label className="form-label">Aplicación origen *</label><ApplicationSearchField value={form.sourceApplicationId} displayValue={form.sourceApplicationSearch} onChange={(sourceApplicationId, sourceApplicationSearch) => setForm(value => ({ ...value, sourceApplicationId, sourceApplicationSearch }))} /></div>
          <div className="form-group"><label className="form-label">Shop ID origen *</label><input className="form-input td-mono" value={form.sourceShopId} maxLength={19} placeholder="57…" onChange={event => setForm(value => ({ ...value, sourceShopId: event.target.value.replace(/\D/g, '') }))} /></div>
        </div>
        <div>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Destino</h3>
          <div className="form-group"><label className="form-label">Aplicación destino *</label><ApplicationSearchField value={form.targetApplicationId} displayValue={form.targetApplicationSearch} onChange={(targetApplicationId, targetApplicationSearch) => setForm(value => ({ ...value, targetApplicationId, targetApplicationSearch }))} /></div>
          <div className="form-group">
            <label className="form-label">Shop IDs destino *</label>
            <textarea className="form-input td-mono" rows={6} value={form.targetShopIds} placeholder={'Un shop_id por línea, por ejemplo:\n5764012345678901234\n5764098765432101234'} onChange={event => setForm(value => ({ ...value, targetShopIds: event.target.value }))} />
            <p className="form-hint">Se aceptan líneas, comas o espacios. {targetShopIds.length} destino(s) detectado(s), máximo 500. Cada tienda tendrá su propia ejecución y resultado.</p>
          </div>
        </div>
      </div>
      <div className="form-group"><label className="form-label">Método de subida *</label><select className="form-input" value={form.uploadEndpoint} onChange={event => setForm(value => ({ ...value, uploadEndpoint: event.target.value as FormState['uploadEndpoint'] }))}><option value="uploadGrocery">uploadGrocery — carga estructural del menú</option><option value="updateItemsync">updateItemsync — actualiza los ítems existentes</option></select><p className="form-hint">En Cross-App, updateItemsync requiere que los mismos app_item_id ya existan en la tienda destino.</p></div>
      {form.uploadEndpoint === 'uploadGrocery' && <div className="form-group"><label className="form-label">Política de carga *</label><select className="form-input" value={form.mergePolicy} onChange={event => setForm(value => ({ ...value, mergePolicy: Number(event.target.value) }))}><option value={0}>Merge — agrega/actualiza sin borrar el resto</option><option value={1}>Reemplazar — sobrescribe el menú completo destino</option></select></div>}
      {targetShopIds.some(shopId => !shopIdPattern.test(shopId)) && <p style={{ color: 'var(--red)' }}>Todos los Shop IDs destino deben tener 19 dígitos y comenzar con 57.</p>}
      {targetShopIds.length > 500 && <p style={{ color: 'var(--red)' }}>El máximo permitido es de 500 tiendas destino por solicitud.</p>}
      {form.sourceApplicationId === form.targetApplicationId && targetShopIds.includes(form.sourceShopId.trim()) && <p style={{ color: 'var(--red)' }}>La tienda origen no puede incluirse también como destino dentro de la misma aplicación.</p>}
    </Modal>}
  </section>;
}
