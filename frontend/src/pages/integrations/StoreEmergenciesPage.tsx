import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import Paginator from '../../components/ui/Paginator';
import StatusBadge from '../../components/ui/StatusBadge';
import { brandsApi, storeEmergenciesApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import type { Brand, Paginated, StoreEmergency } from '../../types';

function localDateTime(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function StoreEmergenciesPage() {
  const { account } = useAuth();
  const qc = useQueryClient();
  const isAdmin = account?.roles.some(role => role === 'admin' || role === 'super_admin');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<StoreEmergency | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    brandId: '',
    mode: 'all_brand' as 'all_brand' | 'shop_list',
    shopIds: '',
    endsAt: '',
  });
  const { data: brandsResult } = useQuery<{ data: Brand[] }>({
    queryKey: ['brands-emergencies'],
    queryFn: () => brandsApi.list({ page: 1, limit: 2000 }).then(response => response.data),
    enabled: !!isAdmin,
  });
  const { data, isLoading } = useQuery<Paginated<StoreEmergency>>({
    queryKey: ['store-emergencies', page],
    queryFn: () => storeEmergenciesApi.list(page).then(response => response.data),
    enabled: !!isAdmin,
    refetchInterval: query => {
      const result = query.state.data as Paginated<StoreEmergency> | undefined;
      return result?.data.some(item => ['pending', 'running', 'restoring'].includes(item.status)) ? 4000 : 30_000;
    },
  });
  const shopIds = useMemo(() => [...new Set(form.shopIds.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean))], [form.shopIds]);
  const create = useMutation({
    mutationFn: () => storeEmergenciesApi.create({
      brandId: form.brandId,
      mode: form.mode,
      shopIds: form.mode === 'shop_list' ? shopIds : undefined,
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

  if (!isAdmin) return <Navigate to="/" replace />;
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
        <button className="btn btn-primary" onClick={() => {
          setForm(value => ({ ...value, endsAt: localDateTime(new Date(Date.now() + 60 * 60_000)) }));
          setOpen(true);
          setError('');
        }}>+ Nueva emergencia</button>
      </div>
      <div className="alert" style={{ marginBottom: 18, borderColor: '#ffc7b2', background: '#fff4ee', color: '#8b2d00' }}>
        Esta acción cambia tiendas reales a Offline usando únicamente las tiendas almacenadas localmente. Al vencer el periodo, el sistema intentará reabrir solo las tiendas que logró apagar.
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Marca</th><th>Alcance</th><th>Tiendas</th><th>Estado</th><th>Reapertura</th><th>Creada por</th><th></th></tr></thead>
          <tbody>
            {isLoading && <tr><td colSpan={7} className="text-muted">Cargando…</td></tr>}
            {!isLoading && !data?.data.length && <tr><td colSpan={7}><div className="empty-state"><p>No hay emergencias registradas.</p></div></td></tr>}
            {data?.data.map(item => {
              const offline = item.targets.filter(target => target.offlineStatus === 'done').length;
              const restored = item.targets.filter(target => target.restoreStatus === 'done').length;
              return <tr key={item.id}>
                <td><strong>{item.brand.brandName}</strong><div className="text-muted text-sm">{item.brand.country}</div></td>
                <td>{item.mode === 'all_brand' ? 'Toda la marca' : 'Lista de shop_ids'}</td>
                <td>{offline}/{item.targets.length} apagadas{restored > 0 ? ` · ${restored} reabiertas` : ''}</td>
                <td><StatusBadge status={item.status} />{item.errorMessage && <div style={{ color: 'var(--red)', fontSize: '.68rem', marginTop: 4 }}>{item.errorMessage}</div>}</td>
                <td>{new Date(item.endsAt).toLocaleString()}</td>
                <td>{item.createdBy.name}</td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => setDetail(item)}>Ver tiendas</button></td>
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
        <button className="btn btn-primary" disabled={create.isPending || !form.brandId || !form.endsAt || (form.mode === 'shop_list' && shopIds.length === 0)}
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
      <div className="form-group"><label className="form-label">Reabrir automáticamente el *</label>
        <input className="form-input" type="datetime-local" value={form.endsAt} onChange={e => setForm(value => ({ ...value, endsAt: e.target.value }))} />
      </div>
    </Modal>}

    {detail && <Modal title={`Tiendas · ${detail.brand.brandName}`} onClose={() => setDetail(null)}>
      <div className="table-wrap" style={{ maxHeight: 520, overflow: 'auto' }}><table>
        <thead><tr><th>shop_id</th><th>Ciudad</th><th>Apagado</th><th>Reapertura</th></tr></thead>
        <tbody>{detail.targets.map(target => <tr key={target.id}>
          <td className="td-mono">{target.shop.shopId}<div className="text-muted text-sm">{target.shop.appShopId}</div></td>
          <td>{target.shop.city || '—'}</td>
          <td><StatusBadge status={target.offlineStatus} />{target.offlineError && <div style={{ color: 'var(--red)', fontSize: '.66rem' }}>{target.offlineError}</div>}</td>
          <td><StatusBadge status={target.restoreStatus} />{target.restoreError && <div style={{ color: 'var(--red)', fontSize: '.66rem' }}>{target.restoreError}</div>}</td>
        </tr>)}</tbody>
      </table></div>
    </Modal>}
  </>;
}
