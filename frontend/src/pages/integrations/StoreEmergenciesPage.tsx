import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import Paginator from '../../components/ui/Paginator';
import StatusBadge from '../../components/ui/StatusBadge';
import { brandsApi, storeEmergenciesApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission } from '../../auth/permissions';
import type { Brand, Paginated, StoreEmergency, StoreEmergencySummary } from '../../types';
import EmergencyDetailModal from './EmergencyDetailModal';

const INITIAL_NOW = Date.now();

function localDateTime(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function countdown(endsAt: string, now: number) {
  if (!now) return '—';
  const remaining = new Date(endsAt).getTime() - now;
  if (remaining <= 0) return 'Reapertura vencida; restauración en proceso';
  const minutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', `${mins}m`].filter(Boolean).join(' ');
}

export default function StoreEmergenciesPage() {
  const { account } = useAuth();
  const qc = useQueryClient();
  const canView = hasPermission(account, 'integrations.emergencies');
  const canExecute = hasPermission(account, 'integrations.emergencies.execute');
  const [page, setPage] = useState(1);
  const [now, setNow] = useState(INITIAL_NOW);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<StoreEmergency | null>(null);
  const [editingReopening, setEditingReopening] = useState<StoreEmergency | null>(null);
  const [reopeningAt, setReopeningAt] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    brandId: '',
    mode: 'all_brand' as 'all_brand' | 'shop_list',
    shopIds: '',
    reason: '',
    endsAt: '',
  });
  const closeDetail = useCallback(() => setDetail(null), []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const { data: brandsResult } = useQuery<{ data: Brand[] }>({
    queryKey: ['brands-emergencies'],
    queryFn: () => brandsApi.list({ page: 1, limit: 2000 }).then(response => response.data),
    enabled: canExecute,
  });
  const { data, isLoading } = useQuery<Paginated<StoreEmergency>>({
    queryKey: ['store-emergencies', page],
    queryFn: () => storeEmergenciesApi.list(page).then(response => response.data),
    enabled: canView,
    refetchInterval: query => {
      const result = query.state.data as Paginated<StoreEmergency> | undefined;
      return result?.data.some(item => ['pending', 'running', 'restoring'].includes(item.status)) ? 4000 : 30_000;
    },
  });
  const { data: summary } = useQuery<StoreEmergencySummary>({
    queryKey: ['store-emergencies', 'summary'],
    queryFn: () => storeEmergenciesApi.summary().then(response => response.data),
    enabled: canView,
    refetchInterval: 15_000,
  });
  const shopIds = useMemo(() => [...new Set(form.shopIds.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean))], [form.shopIds]);
  const create = useMutation({
    mutationFn: () => storeEmergenciesApi.create({
      brandId: form.brandId,
      mode: form.mode,
      shopIds: form.mode === 'shop_list' ? shopIds : undefined,
      reason: form.reason.trim(),
      endsAt: new Date(form.endsAt).toISOString(),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['store-emergencies'] });
      setOpen(false);
      setError('');
    },
    onError: (err: unknown) => {
      const response = err as { response?: { data?: { message?: string | string[] } } };
      const message = response.response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'No se pudo iniciar la emergencia');
    },
  });
  const restore = useMutation({
    mutationFn: (id: string) => storeEmergenciesApi.restoreNow(id),
    onSuccess: (_response, id) => {
      qc.invalidateQueries({ queryKey: ['store-emergencies'] });
      qc.invalidateQueries({ queryKey: ['store-emergency', id] });
    },
    onError: (err: unknown) => {
      const response = err as { response?: { data?: { message?: string | string[] } } };
      const message = response.response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'No se pudo encender las tiendas');
    },
  });
  const updateReopening = useMutation({
    mutationFn: () => {
      if (!editingReopening) throw new Error('No emergency selected');
      return storeEmergenciesApi.updateReopening(editingReopening.id, new Date(reopeningAt).toISOString());
    },
    onSuccess: response => {
      const updated = response.data as StoreEmergency;
      qc.invalidateQueries({ queryKey: ['store-emergencies'] });
      qc.invalidateQueries({ queryKey: ['store-emergency', updated.id] });
      if (detail?.id === updated.id) setDetail(updated);
      setEditingReopening(null);
      setReopeningAt('');
      setError('');
    },
    onError: (err: unknown) => {
      const response = err as { response?: { data?: { message?: string | string[] } } };
      const message = response.response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'No se pudo modificar la hora de reapertura');
    },
  });
  const retryFailures = useMutation({
    mutationFn: (id: string) => storeEmergenciesApi.retryFailures(id),
    onSuccess: response => {
      const updated = response.data as StoreEmergency;
      qc.invalidateQueries({ queryKey: ['store-emergencies'] });
      qc.invalidateQueries({ queryKey: ['store-emergency', updated.id] });
      if (detail?.id === updated.id) setDetail(updated);
      setError('');
    },
    onError: (err: unknown) => {
      const response = err as { response?: { data?: { message?: string | string[] } } };
      const message = response.response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'No se pudieron reintentar las tiendas fallidas');
    },
  });

  if (!canView) return <Navigate to="/" replace />;
  const brands = (brandsResult?.data ?? []).filter(brand => !!brand.applicationId);
  const selectedBrand = brands.find(brand => brand.id === form.brandId);
  const startEmergency = () => {
    const scope = form.mode === 'all_brand' ? 'todas las tiendas locales' : `${shopIds.length} tienda(s)`;
    if (!window.confirm(
      `Se apagarán ${scope} de ${selectedBrand?.brandName ?? 'la marca'} hasta ${new Date(form.endsAt).toLocaleString()}. ¿Continuar?`,
    )) return;
    create.mutate();
  };

  return <>
    <Topbar breadcrumb={[{ label: 'Integraciones' }, { label: 'Emergencias' }]} />
    <main className="main-content">
      <div className="page-header">
        <div className="page-header-info">
          <h1>Emergencias de tiendas</h1>
          <p>Apagado masivo o por shop_id, con reapertura automática en la fecha indicada.</p>
        </div>
        {canExecute && <button className="btn btn-primary" onClick={() => {
          setForm(value => ({ ...value, reason: '', endsAt: localDateTime(new Date(Date.now() + 60 * 60_000)) }));
          setOpen(true);
          setError('');
        }}>+ Nueva emergencia</button>}
      </div>
      <div className="alert" style={{ marginBottom: 18, borderColor: 'var(--amber-border)', background: 'var(--amber-bg)', color: 'var(--amber-text)' }}>
        Esta acción cambia tiendas reales a Offline usando únicamente las tiendas almacenadas localmente. Al vencer el periodo, el sistema intentará reabrir solo las tiendas que logró apagar.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 18 }}>
        {[
          { label: 'Emergencias activas', value: summary?.activeEmergencies ?? '—', tone: '#f97316', hint: 'Pendientes, apagadas o restaurando' },
          { label: 'Tiendas aún Offline', value: summary?.storesOffline ?? '—', tone: '#dc2626', hint: 'Apagadas y todavía no restauradas' },
          { label: 'Tiendas con error', value: summary?.storesWithErrors ?? '—', tone: '#b45309', hint: 'Requieren revisión o reintento' },
          { label: 'Próxima reapertura', value: summary?.nextReopening ? countdown(summary.nextReopening.endsAt, now) : '—', tone: '#2563eb', hint: summary?.nextReopening?.brand.brandName ?? 'Sin reaperturas pendientes' },
        ].map(card => <div key={card.label} className="card" style={{ padding: 16, borderTop: `3px solid ${card.tone}` }}>
          <div className="text-muted text-sm">{card.label}</div>
          <div style={{ fontSize: '1.45rem', fontWeight: 800, marginTop: 4 }}>{card.value}</div>
          <div className="text-muted" style={{ fontSize: '.7rem', marginTop: 4 }}>{card.hint}</div>
        </div>)}
      </div>
      {error && !open && !editingReopening && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}
      <div className="table-wrap emergency-list-table-wrap">
        <table className="emergency-list-table">
          <caption className="sr-only">Historial de apagados y reaperturas de tiendas</caption>
          <thead><tr><th>Marca / motivo</th><th>Alcance</th><th>Progreso</th><th>Estado</th><th>Inicio de apagado</th><th>Reapertura</th><th>Creada por</th><th></th></tr></thead>
          <tbody>
            {isLoading && <tr><td colSpan={8} className="text-muted">Cargando…</td></tr>}
            {!isLoading && !data?.data.length && <tr><td colSpan={8}><div className="empty-state"><p>No hay emergencias registradas.</p></div></td></tr>}
            {data?.data.map(item => {
              const legacyTargets = item.targets ?? [];
              const total = item.targetCounts?.total ?? legacyTargets.length;
              const offline = item.targetCounts?.shutdownSucceeded ?? item.targetCounts?.offlineDone ?? legacyTargets.filter(target => target.offlineStatus === 'done').length;
              const restored = item.targetCounts?.restoreSucceeded ?? item.targetCounts?.restoreDone ?? legacyTargets.filter(target => target.restoreStatus === 'done').length;
              return <tr key={item.id}>
                <td><strong>{item.brand.brandName}</strong><div className="text-muted text-sm">{item.brand.country} · {item.reason}</div></td>
                <td>{item.mode === 'all_brand' ? 'Toda la marca' : 'Lista de shop_ids'}</td>
                <td style={{ minWidth: 170 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.72rem', marginBottom: 5 }}><span>{offline}/{total} apagadas</span><span>{restored} reabiertas</span></div>
                  <div role="progressbar" aria-label={`Tiendas apagadas de ${item.brand.brandName}`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={offline} style={{ height: 7, background: 'var(--surface-2)', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ width: `${total ? Math.round((offline / total) * 100) : 0}%`, height: '100%', background: restored > 0 ? '#22c55e' : '#f97316', transition: 'width .25s ease' }} />
                  </div>
                </td>
                <td><StatusBadge status={item.status} />{item.errorMessage && <div style={{ color: 'var(--red)', fontSize: '.68rem', marginTop: 4 }}>{item.errorMessage}</div>}</td>
                <td>{item.startedAt ? new Date(item.startedAt).toLocaleString() : <span className="text-muted">Pendiente</span>}</td>
                <td><div>{new Date(item.endsAt).toLocaleString()}</div>{['offline', 'partial_success'].includes(item.status) && <div className="text-muted" style={{ fontSize: '.68rem', marginTop: 3 }}>{countdown(item.endsAt, now)}</div>}</td>
                <td>{item.createdBy.name}</td>
                <td><div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  {canExecute && ['pending', 'running', 'offline', 'partial_success'].includes(item.status) && <button
                    className="btn btn-ghost btn-sm"
                    disabled={updateReopening.isPending}
                    onClick={() => {
                      setEditingReopening(item);
                      setReopeningAt(localDateTime(new Date(item.endsAt)));
                      setError('');
                    }}
                  >Editar reapertura</button>}
                  {canExecute && ['offline', 'partial_success'].includes(item.status) && <button
                    className="btn btn-primary btn-sm"
                    disabled={restore.isPending}
                    onClick={() => {
                      if (window.confirm(`¿Encender ahora las tiendas apagadas de ${item.brand.brandName}?`)) restore.mutate(item.id);
                    }}
                  >Encender ahora</button>}
                  {canExecute && ['failed', 'partial_success', 'restore_failed', 'partial_restored'].includes(item.status) && <button
                    className="btn btn-ghost btn-sm"
                    disabled={retryFailures.isPending}
                    onClick={() => {
                      if (window.confirm(`¿Reintentar únicamente las tiendas fallidas de ${item.brand.brandName}?`)) retryFailures.mutate(item.id);
                    }}
                  >Reintentar fallidas</button>}
                  <button className="btn btn-ghost btn-sm" onClick={() => setDetail(item)}>Ver detalle</button>
                </div></td>
              </tr>;
            })}
          </tbody>
        </table>
        <Paginator page={page} total={data?.total ?? 0} limit={20} onChange={setPage} />
      </div>
    </main>

    {open && <Modal title="Nueva emergencia de tiendas" onClose={() => setOpen(false)}
      footer={<>
        <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
        <button className="btn btn-primary" disabled={create.isPending || !form.brandId || form.reason.trim().length < 5 || !form.endsAt || (form.mode === 'shop_list' && shopIds.length === 0)}
          onClick={startEmergency}>{create.isPending ? 'Iniciando…' : 'Apagar tiendas'}</button>
      </>}>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-group"><label className="form-label">Marca *</label>
        <select className="form-select" value={form.brandId} onChange={e => setForm(value => ({ ...value, brandId: e.target.value }))}>
          <option value="">Selecciona una marca…</option>
          {brands.map(brand => <option key={brand.id} value={brand.id}>{brand.brandName} · {brand.country}</option>)}
        </select>
      </div>
      <div className="form-group"><label className="form-label">Alcance *</label>
        <select className="form-select" value={form.mode} onChange={e => setForm(value => ({ ...value, mode: e.target.value as 'all_brand' | 'shop_list' }))}>
          <option value="all_brand">Todas las tiendas locales de la marca</option>
          <option value="shop_list">Listado específico de shop_ids</option>
        </select>
      </div>
      {form.mode === 'shop_list' && <div className="form-group"><label className="form-label">shop_ids * ({shopIds.length})</label>
        <textarea className="form-input" rows={6} placeholder="Un shop_id por línea o separados por coma" value={form.shopIds} onChange={e => setForm(value => ({ ...value, shopIds: e.target.value }))} />
        <p className="form-hint">Todos deben existir localmente y pertenecer a la marca seleccionada.</p>
      </div>}
      <div className="form-group"><label className="form-label">Motivo de la emergencia *</label>
        <textarea className="form-input" rows={3} maxLength={500} placeholder="Ej. Incidente operativo, mantenimiento o contingencia de la marca" value={form.reason} onChange={event => setForm(value => ({ ...value, reason: event.target.value }))} />
        <p className="form-hint">Quedará visible en el historial para auditoría ({form.reason.trim().length}/500).</p>
      </div>
      <div className="form-group"><label className="form-label">Reabrir automáticamente el *</label>
        <input className="form-input" type="datetime-local" value={form.endsAt} onChange={e => setForm(value => ({ ...value, endsAt: e.target.value }))} />
      </div>
    </Modal>}

    {editingReopening && <Modal title={`Modificar reapertura · ${editingReopening.brand.brandName}`} onClose={() => {
      if (!updateReopening.isPending) {
        setEditingReopening(null);
        setError('');
      }
    }} footer={<>
      <button className="btn btn-ghost" disabled={updateReopening.isPending} onClick={() => {
        setEditingReopening(null);
        setError('');
      }}>Cancelar</button>
      <button className="btn btn-primary" disabled={updateReopening.isPending || !reopeningAt} onClick={() => {
        if (window.confirm(`¿Cambiar la reapertura de ${editingReopening.brand.brandName} a ${new Date(reopeningAt).toLocaleString()}?`)) {
          updateReopening.mutate();
        }
      }}>{updateReopening.isPending ? 'Guardando…' : 'Guardar nueva hora'}</button>
    </>}>
      {error && <div className="error-banner">{error}</div>}
      <div className="alert" style={{ marginBottom: 18, borderColor: 'var(--amber-border)', background: 'var(--amber-bg)', color: 'var(--amber-text)' }}>
        El scheduler utilizará la nueva hora. Solo puede modificarse antes de que comience la reapertura.
      </div>
      <div className="form-group">
        <label className="form-label">Inicio de la instrucción de apagado</label>
        <div className="form-input" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
          {editingReopening.startedAt ? new Date(editingReopening.startedAt).toLocaleString() : 'Pendiente de iniciar'}
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Nueva fecha y hora de reapertura *</label>
        <input className="form-input" type="datetime-local" min={localDateTime(new Date())} value={reopeningAt} onChange={event => setReopeningAt(event.target.value)} />
      </div>
      <p className="form-hint">Hora actual: {new Date(editingReopening.endsAt).toLocaleString()}</p>
    </Modal>}

    {detail && <EmergencyDetailModal emergencyId={detail.id} fallback={detail} onClose={closeDetail} />}
  </>;
}
