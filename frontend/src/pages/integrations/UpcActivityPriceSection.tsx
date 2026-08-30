import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import ExecutionTiming from '../../components/integrations/ExecutionTiming';
import { upcActivityPriceApi } from '../../api';
import type { UpcActivityPriceRule } from '../../types';
import ApplicationSearchField from './ApplicationSearchField';

interface FormState {
  name: string;
  applicationId: string;
  applicationSearch: string;
  shopIds: string;
  targetUpc: string;
  active: boolean;
  dryRun: boolean;
  scheduleHours: string;
  timezone: string;
  storeConcurrency: number;
}

const runningStatuses = new Set(['pending', 'running']);

function emptyForm(): FormState {
  return {
    name: 'UPC activity price 08–13',
    applicationId: '',
    applicationSearch: '',
    shopIds: '',
    targetUpc: '7707430870113',
    active: false,
    dryRun: true,
    scheduleHours: '8,9,10,11,12,13',
    timezone: 'America/Mexico_City',
    storeConcurrency: 2,
  };
}

function values(source: string) {
  return [...new Set(source.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean))];
}

function hours(source: string) {
  return [...new Set(values(source).map(Number).filter(value => Number.isInteger(value) && value >= 0 && value <= 23))].sort((a, b) => a - b);
}

function apiError(reason: unknown) {
  const message = (reason as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : message ?? 'La acción no pudo completarse';
}

function date(value?: string) {
  return value ? new Date(value).toLocaleString() : '—';
}

export default function UpcActivityPriceSection() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<UpcActivityPriceRule | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState('');
  const { data: rules = [], isLoading } = useQuery<UpcActivityPriceRule[]>({
    queryKey: ['upc-activity-price-rules'],
    queryFn: () => upcActivityPriceApi.list().then(response => response.data),
    refetchInterval: query => (query.state.data as UpcActivityPriceRule[] | undefined)
      ?.some(rule => rule.executions.some(execution => runningStatuses.has(execution.status))) ? 3000 : 15000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['upc-activity-price-rules'] });
  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name,
        applicationId: form.applicationId,
        shopIds: values(form.shopIds),
        targetUpc: form.targetUpc.trim(),
        active: form.active,
        dryRun: form.dryRun,
        scheduleHours: hours(form.scheduleHours),
        timezone: form.timezone.trim(),
        storeConcurrency: form.storeConcurrency,
      };
      return editing ? upcActivityPriceApi.update(editing.id, payload) : upcActivityPriceApi.create(payload);
    },
    onSuccess: () => { refresh(); setOpen(false); setEditing(null); setError(''); },
    onError: reason => setError(apiError(reason)),
  });
  const action = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: 'run' | 'stop' | 'delete' }) => verb === 'run'
      ? upcActivityPriceApi.run(id)
      : verb === 'stop' ? upcActivityPriceApi.stop(id) : upcActivityPriceApi.delete(id),
    onSuccess: refresh,
    onError: reason => window.alert(apiError(reason)),
  });
  const openCreate = () => { setEditing(null); setForm(emptyForm()); setError(''); setOpen(true); };
  const openEdit = (rule: UpcActivityPriceRule) => {
    setEditing(rule);
    setForm({
      name: rule.name,
      applicationId: rule.applicationId,
      applicationSearch: `${rule.application.appName} · ${rule.application.country} · ${rule.application.appId}`,
      shopIds: rule.shopIds.join('\n'),
      targetUpc: rule.targetUpc,
      active: rule.active,
      dryRun: rule.dryRun,
      scheduleHours: rule.scheduleHours.join(','),
      timezone: rule.timezone,
      storeConcurrency: rule.storeConcurrency,
    });
    setError(''); setOpen(true);
  };
  const valid = form.name.trim() && form.applicationId && values(form.shopIds).length > 0
    && /^\d{6,20}$/.test(form.targetUpc.trim()) && hours(form.scheduleHours).length > 0 && form.timezone.trim();
  const submit = () => {
    if (!form.dryRun && !window.confirm('Esta configuración hará cambios reales de activity_price. Confirma que revisaste primero un dry-run y el alcance de tiendas.')) return;
    save.mutate();
  };

  return <section style={{ marginBottom: 22 }}>
    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
        <div><strong>UPC Activity Price</strong><p className="text-muted" style={{ marginTop: 5, fontSize: 12 }}>
          Exporta el menú de cada tienda y actualiza únicamente el UPC objetivo mediante updateItemsync. No recrea menús ni categorías. Dry-run exporta y audita, pero no escribe cambios.
        </p></div>
        <button className="btn btn-primary" onClick={openCreate}>+ Nueva regla</button>
      </div>
    </div>
    <div className="alert alert-info" style={{ marginBottom: 14 }}>
      Horario recomendado: 08:00, 09:00, 10:00, 11:00, 12:00 y 13:00 en America/Mexico_City. Las escrituras reales requieren además el gate del servidor.
    </div>
    {isLoading && <p className="text-muted">Cargando reglas…</p>}
    {!isLoading && rules.length === 0 && <div className="empty-state"><p>No hay reglas configuradas.</p></div>}
    <div style={{ display: 'grid', gap: 12 }}>
      {rules.map(rule => {
        const latest = rule.executions[0];
        const running = latest && runningStatuses.has(latest.status);
        const shops = latest?.result?.shops ?? [];
        return <article key={rule.id} className="card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
            <div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <strong>{rule.name}</strong><StatusBadge status={rule.active ? 'active' : 'inactive'} />
                <span className="badge">{rule.dryRun ? 'DRY RUN' : 'LIVE'}</span>
                <span className="badge">UPC {rule.targetUpc}</span><span className="badge">{rule.shopIds.length} tiendas</span>
                <span className="badge">{rule.scheduleHours.map(hour => `${String(hour).padStart(2, '0')}:00`).join(' / ')}</span>
                {latest && <StatusBadge status={latest.status} />}
              </div>
              <p className="text-muted" style={{ marginTop: 8, fontSize: 12 }}>{rule.application.appName} · {rule.timezone} · Próxima: {date(rule.nextRunAt)} · Última: {date(rule.lastRunAt)}</p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" disabled={!!running || action.isPending} onClick={() => action.mutate({ id: rule.id, verb: 'run' })}>Ejecutar ahora</button>
              {running && <button className="btn btn-ghost btn-sm" onClick={() => action.mutate({ id: rule.id, verb: 'stop' })}>Detener</button>}
              <button className="btn btn-ghost btn-sm" disabled={!!running} onClick={() => openEdit(rule)}>Editar</button>
              <button className="btn btn-ghost btn-sm" disabled={!!running} style={{ color: 'var(--red)' }} onClick={() => window.confirm(`¿Eliminar ${rule.name}?`) && action.mutate({ id: rule.id, verb: 'delete' })}>Eliminar</button>
            </div>
          </div>
          {latest && <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}><span>{latest.processedShops}/{latest.totalShops} tiendas</span><span>{latest.successfulShops} correctas</span><span>{latest.skippedShops} sin UPC</span><span>{latest.failedShops} fallidas</span>{shops.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(expanded === latest.id ? null : latest.id)}>{expanded === latest.id ? 'Ocultar' : 'Ver detalle'}</button>}</div>
            <ExecutionTiming startedAt={latest.startedAt} finishedAt={latest.finishedAt} />
            {latest.errorMessage && <p style={{ color: 'var(--red)', marginTop: 8 }}>{latest.errorMessage}</p>}
            {expanded === latest.id && <div className="table-wrap" style={{ marginTop: 12 }}><table><thead><tr><th>Shop ID</th><th>Resultado</th><th>Coincidencias</th><th>Cambios</th><th>Referencia / error</th></tr></thead><tbody>{shops.map(shop => <tr key={shop.shopId}><td className="td-mono">{shop.shopId}</td><td>{shop.outcome}</td><td>{shop.matchedItems}</td><td>{shop.changedItems}</td><td className="td-mono">{shop.error ?? shop.uploadReferenceId ?? shop.exportTaskId ?? '—'}</td></tr>)}</tbody></table></div>}
          </div>}
        </article>;
      })}
    </div>
    {open && <Modal title={editing ? 'Editar UPC Activity Price' : 'Nueva regla UPC Activity Price'} onClose={() => setOpen(false)} footer={<><button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button><button className="btn btn-primary" disabled={!valid || save.isPending} onClick={submit}>{save.isPending ? 'Guardando…' : 'Guardar'}</button></>}>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-group"><label className="form-label">Nombre *</label><input className="form-input" value={form.name} onChange={event => setForm(value => ({ ...value, name: event.target.value }))} /></div>
      <div className="form-group"><label className="form-label">Aplicación DiDi *</label><ApplicationSearchField value={form.applicationId} displayValue={form.applicationSearch} onChange={(applicationId, applicationSearch) => setForm(value => ({ ...value, applicationId, applicationSearch }))} /></div>
      <div className="form-row"><div className="form-group"><label className="form-label">Shop IDs ({values(form.shopIds).length}) *</label><textarea className="form-input" rows={8} value={form.shopIds} onChange={event => setForm(value => ({ ...value, shopIds: event.target.value }))} placeholder={'576…\n576…'} /><p className="form-hint">Uno por línea o separados por coma. Nunca se toma “toda la aplicación” implícitamente.</p></div><div>
        <div className="form-group"><label className="form-label">UPC objetivo *</label><input className="form-input" value={form.targetUpc} onChange={event => setForm(value => ({ ...value, targetUpc: event.target.value }))} /></div>
        <div className="form-group"><label className="form-label">Horas locales *</label><input className="form-input" value={form.scheduleHours} onChange={event => setForm(value => ({ ...value, scheduleHours: event.target.value }))} /><p className="form-hint">0–23, separadas por coma.</p></div>
        <div className="form-group"><label className="form-label">Zona horaria *</label><input className="form-input" value={form.timezone} onChange={event => setForm(value => ({ ...value, timezone: event.target.value }))} /></div>
        <div className="form-group"><label className="form-label">Concurrencia (1–5)</label><input className="form-input" type="number" min={1} max={5} value={form.storeConcurrency} onChange={event => setForm(value => ({ ...value, storeConcurrency: Number(event.target.value) }))} /></div>
      </div></div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}><input type="checkbox" checked={form.dryRun} onChange={event => setForm(value => ({ ...value, dryRun: event.target.checked }))} /> Dry-run: exportar y auditar sin modificar precios</label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={form.active} onChange={event => setForm(value => ({ ...value, active: event.target.checked }))} /> Activar programación automática</label>
    </Modal>}
  </section>;
}
