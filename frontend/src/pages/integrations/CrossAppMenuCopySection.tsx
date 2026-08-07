import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import { menuCopyApi } from '../../api';
import type { MenuCopyExecution } from '../../types';
import BrandSearchField from './BrandSearchField';

interface FormState {
  sourceBrandId: string;
  sourceBrandSearch: string;
  sourceShopId: string;
  targetBrandId: string;
  targetBrandSearch: string;
  targetShopId: string;
  mergePolicy: number;
}
const activeStatuses = new Set(['pending', 'running']);
const shopIdPattern = /^57\d{17}$/;

const initialForm = (): FormState => ({
  sourceBrandId: '', sourceBrandSearch: '', sourceShopId: '',
  targetBrandId: '', targetBrandSearch: '', targetShopId: '', mergePolicy: 0,
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

export default function CrossAppMenuCopySection() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(initialForm);
  const [error, setError] = useState('');
  const { data: executions = [], isLoading } = useQuery<MenuCopyExecution[]>({
    queryKey: ['menu-copy-executions'],
    queryFn: () => menuCopyApi.list().then(response => response.data),
    refetchInterval: query => (query.state.data as MenuCopyExecution[] | undefined)
      ?.some(execution => activeStatuses.has(execution.status)) ? 3000 : 15000,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['menu-copy-executions'] });
  const create = useMutation({
    mutationFn: () => menuCopyApi.create({
      sourceBrandId: form.sourceBrandId,
      sourceShopId: form.sourceShopId.trim(),
      targetBrandId: form.targetBrandId,
      targetShopId: form.targetShopId.trim(),
      mergePolicy: form.mergePolicy,
    }),
    onSuccess: () => { refresh(); setOpen(false); setForm(initialForm()); setError(''); },
    onError: reason => setError(apiError(reason)),
  });
  const stop = useMutation({
    mutationFn: (id: string) => menuCopyApi.stop(id),
    onSuccess: refresh,
    onError: reason => window.alert(apiError(reason)),
  });

  const valid = !!form.sourceBrandId && !!form.targetBrandId
    && form.sourceBrandId !== form.targetBrandId
    && shopIdPattern.test(form.sourceShopId.trim())
    && shopIdPattern.test(form.targetShopId.trim());

  const submit = () => {
    if (form.mergePolicy === 1 && !window.confirm('Reemplazar sobrescribirá el menú actual de la tienda destino. ¿Continuar?')) return;
    create.mutate();
  };

  return <section style={{ marginBottom: 22 }}>
    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
        <div>
          <strong>Cross-App Menu Copy</strong>
          <p className="text-muted" style={{ marginTop: 5, fontSize: 12 }}>
            Descarga el menú completo de un shop_id con las credenciales de su aplicación y lo carga en un shop_id perteneciente a otra aplicación.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => { setForm(initialForm()); setError(''); setOpen(true); }}>+ Nueva copia</button>
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
                <strong>{execution.sourceBrand.brandName} → {execution.targetBrand.brandName}</strong>
                <StatusBadge status={execution.status} />
                <span className="badge">{execution.mergePolicy === 1 ? 'Reemplazar' : 'Merge'}</span>
              </div>
              <p className="text-muted" style={{ marginTop: 7, fontSize: 12 }}>
                {execution.sourceShopId} ({execution.sourceBrand.application?.appName ?? 'sin app'}) → {execution.targetShopId} ({execution.targetBrand.application?.appName ?? 'sin app'})
              </p>
              <p className="text-muted" style={{ marginTop: 5, fontSize: 12 }}>
                Paso: {stepLabels[execution.currentStep ?? ''] ?? execution.currentStep ?? '—'} · Creada: {date(execution.createdAt)} · Finalizada: {date(execution.finishedAt)}
              </p>
              {(execution.itemCount > 0 || execution.categoryCount > 0) && <p style={{ marginTop: 6, fontSize: 12 }}>{execution.itemCount} ítems · {execution.categoryCount} categorías · taskID carga: {execution.uploadTaskId ?? '—'}</p>}
              {execution.errorMessage && <p style={{ color: 'var(--red)', marginTop: 7 }}>{execution.errorMessage}</p>}
            </div>
            {running && <button className="btn btn-ghost btn-sm" disabled={stop.isPending} onClick={() => stop.mutate(execution.id)}>Detener</button>}
          </div>
        </article>;
      })}
    </div>

    {open && <Modal title="Copiar menú entre aplicaciones" onClose={() => setOpen(false)} footer={<>
      <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
      <button className="btn btn-primary" disabled={!valid || create.isPending} onClick={submit}>{create.isPending ? 'Enviando…' : 'Iniciar copia'}</button>
    </>}>
      {error && <div className="error-banner">{error}</div>}
      <div className="alert alert-info" style={{ marginBottom: 14 }}>Usa shop_id de 19 dígitos. El sistema resuelve internamente el app_shop_id en cada aplicación.</div>
      <div className="form-row">
        <div>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Origen</h3>
          <div className="form-group"><label className="form-label">Marca / aplicación origen *</label><BrandSearchField value={form.sourceBrandId} displayValue={form.sourceBrandSearch} onChange={(sourceBrandId, sourceBrandSearch) => setForm(value => ({ ...value, sourceBrandId, sourceBrandSearch }))} /></div>
          <div className="form-group"><label className="form-label">Shop ID origen *</label><input className="form-input td-mono" value={form.sourceShopId} maxLength={19} placeholder="57…" onChange={event => setForm(value => ({ ...value, sourceShopId: event.target.value.replace(/\D/g, '') }))} /></div>
        </div>
        <div>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Destino</h3>
          <div className="form-group"><label className="form-label">Marca / aplicación destino *</label><BrandSearchField value={form.targetBrandId} displayValue={form.targetBrandSearch} onChange={(targetBrandId, targetBrandSearch) => setForm(value => ({ ...value, targetBrandId, targetBrandSearch }))} /></div>
          <div className="form-group"><label className="form-label">Shop ID destino *</label><input className="form-input td-mono" value={form.targetShopId} maxLength={19} placeholder="57…" onChange={event => setForm(value => ({ ...value, targetShopId: event.target.value.replace(/\D/g, '') }))} /></div>
        </div>
      </div>
      <div className="form-group"><label className="form-label">Política de carga *</label><select className="form-input" value={form.mergePolicy} onChange={event => setForm(value => ({ ...value, mergePolicy: Number(event.target.value) }))}><option value={0}>Merge — agrega/actualiza sin borrar el resto</option><option value={1}>Reemplazar — sobrescribe el menú completo destino</option></select></div>
      {form.sourceBrandId && form.targetBrandId && form.sourceBrandId === form.targetBrandId && <p style={{ color: 'var(--red)' }}>Selecciona marcas vinculadas a aplicaciones diferentes.</p>}
    </Modal>}
  </section>;
}
