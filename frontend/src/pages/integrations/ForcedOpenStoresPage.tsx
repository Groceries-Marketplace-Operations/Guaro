import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import Paginator from '../../components/ui/Paginator';
import StatusBadge from '../../components/ui/StatusBadge';
import { brandsApi, forcedOpenApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import type { Brand, ForcedOpenOperation, Paginated } from '../../types';

export default function ForcedOpenStoresPage() {
  const { account } = useAuth();
  const qc = useQueryClient();
  const isAdmin = account?.roles.some(role => role === 'admin' || role === 'super_admin');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ForcedOpenOperation | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    brandId: '',
    mode: 'all_brand' as 'all_brand' | 'shop_list',
    shopIds: '',
  });
  const { data: brandsResult } = useQuery<{ data: Brand[] }>({
    queryKey: ['brands-forced-open'],
    queryFn: () => brandsApi.list({ page: 1, limit: 2000 }).then(response => response.data),
    enabled: !!isAdmin,
  });
  const { data, isLoading } = useQuery<Paginated<ForcedOpenOperation>>({
    queryKey: ['forced-open', page],
    queryFn: () => forcedOpenApi.list(page).then(response => response.data),
    enabled: !!isAdmin,
    refetchInterval: query => {
      const result = query.state.data as Paginated<ForcedOpenOperation> | undefined;
      return result?.data.some(item => ['pending', 'running'].includes(item.status)) ? 3000 : 30_000;
    },
  });
  const shopIds = useMemo(
    () => [...new Set(form.shopIds.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean))],
    [form.shopIds],
  );
  const create = useMutation({
    mutationFn: () => forcedOpenApi.create({
      brandId: form.brandId,
      mode: form.mode,
      shopIds: form.mode === 'shop_list' ? shopIds : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['forced-open'] });
      setOpen(false);
      setError('');
    },
    onError: (err: unknown) => {
      const response = err as { response?: { data?: { message?: string | string[] } } };
      const message = response.response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'No se pudo iniciar la apertura forzada');
    },
  });
  const loadDetail = useMutation({
    mutationFn: (id: string) => forcedOpenApi.get(id).then(response => response.data as ForcedOpenOperation),
    onSuccess: operation => setDetail(operation),
    onError: () => setError('No se pudo cargar el resultado por tienda'),
  });

  if (!isAdmin) return <Navigate to="/" replace />;
  const brands = (brandsResult?.data ?? []).filter(brand => !!brand.applicationId);
  const selectedBrand = brands.find(brand => brand.id === form.brandId);
  const submit = () => {
    const scope = form.mode === 'all_brand' ? 'todas las tiendas locales' : `${shopIds.length} tienda(s)`;
    if (!window.confirm(`Se abrirán ${scope} de ${selectedBrand?.brandName ?? 'la marca'} inmediatamente. ¿Continuar?`)) return;
    create.mutate();
  };

  return <>
    <Topbar breadcrumb={[{ label: 'Integraciones' }, { label: 'Forced Open Stores' }]} />
    <main className="main-content">
      <div className="page-header">
        <div className="page-header-info">
          <h1>Forced Open Stores</h1>
          <p>Abre tiendas inmediatamente por marca o por una lista específica de shop_ids.</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setOpen(true); setError(''); }}>+ Nueva apertura</button>
      </div>
      <div className="alert" style={{ marginBottom: 18, borderColor: 'var(--amber-border)', background: 'var(--amber-bg)', color: 'var(--amber-text)' }}>
        Esta acción cambia tiendas reales a Online mediante POST /v1/shop/shop/setStatus. La ejecución continúa en el servidor aunque cierres el navegador y utiliza únicamente tiendas almacenadas localmente.
      </div>
      {error && !open && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}
      <div className="table-wrap"><table>
        <thead><tr><th>Marca</th><th>Alcance</th><th>Resultado</th><th>Estado</th><th>Creada por</th><th>Fecha</th><th></th></tr></thead>
        <tbody>
          {isLoading && <tr><td colSpan={7} className="text-muted">Cargando…</td></tr>}
          {!isLoading && !data?.data.length && <tr><td colSpan={7}><div className="empty-state"><p>No hay aperturas forzadas registradas.</p></div></td></tr>}
          {data?.data.map(item => <tr key={item.id}>
            <td><strong>{item.brand.brandName}</strong><div className="text-muted text-sm">{item.brand.country}</div></td>
            <td>{item.mode === 'all_brand' ? 'Toda la marca' : 'Lista de shop_ids'}</td>
            <td><strong>{item.shopsOpened}/{item.totalShops}</strong> abiertas{item.shopsFailed > 0 ? ` · ${item.shopsFailed} fallidas` : ''}</td>
            <td><StatusBadge status={item.status} />{item.errorMessage && <div style={{ color: 'var(--red)', fontSize: '.68rem', marginTop: 4 }}>{item.errorMessage}</div>}</td>
            <td>{item.createdBy.name}</td>
            <td>{new Date(item.createdAt).toLocaleString()}</td>
            <td><button className="btn btn-ghost btn-sm" disabled={loadDetail.isPending} onClick={() => loadDetail.mutate(item.id)}>Ver tiendas</button></td>
          </tr>)}
        </tbody>
      </table><Paginator page={page} total={data?.total ?? 0} limit={20} onChange={setPage} /></div>
    </main>

    {open && <Modal title="Nueva apertura forzada" onClose={() => setOpen(false)} footer={<>
      <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
      <button className="btn btn-primary" disabled={create.isPending || !form.brandId || (form.mode === 'shop_list' && shopIds.length === 0)} onClick={submit}>
        {create.isPending ? 'Programando…' : 'Abrir ahora'}
      </button>
    </>}>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-group"><label className="form-label">Marca *</label>
        <select className="form-select" value={form.brandId} onChange={event => setForm(value => ({ ...value, brandId: event.target.value }))}>
          <option value="">Selecciona una marca…</option>
          {brands.map(brand => <option key={brand.id} value={brand.id}>{brand.brandName} · {brand.country}</option>)}
        </select>
      </div>
      <div className="form-group"><label className="form-label">Alcance *</label>
        <select className="form-select" value={form.mode} onChange={event => setForm(value => ({ ...value, mode: event.target.value as 'all_brand' | 'shop_list' }))}>
          <option value="all_brand">Todas las tiendas locales de la marca</option>
          <option value="shop_list">Listado específico de shop_ids</option>
        </select>
      </div>
      {form.mode === 'shop_list' && <div className="form-group"><label className="form-label">shop_ids * ({shopIds.length})</label>
        <textarea className="form-input" rows={7} placeholder="Un shop_id por línea o separados por coma" value={form.shopIds} onChange={event => setForm(value => ({ ...value, shopIds: event.target.value }))} />
        <p className="form-hint">Máximo 10,000; todos deben existir localmente y pertenecer a la marca seleccionada.</p>
      </div>}
    </Modal>}

    {detail && <Modal title={`Tiendas · ${detail.brand.brandName}`} onClose={() => setDetail(null)}>
      <div className="table-wrap" style={{ maxHeight: 520, overflow: 'auto' }}><table>
        <thead><tr><th>shop_id</th><th>Tienda</th><th>Ciudad</th><th>Estado</th></tr></thead>
        <tbody>{(detail.targets ?? []).map(target => <tr key={target.id}>
          <td className="td-mono">{target.shop.shopId}<div className="text-muted text-sm">{target.shop.appShopId}</div></td>
          <td>{target.shop.name || '—'}</td><td>{target.shop.city || '—'}</td>
          <td><StatusBadge status={target.status} />{target.error && <div style={{ color: 'var(--red)', fontSize: '.66rem' }}>{target.error}</div>}</td>
        </tr>)}</tbody>
      </table></div>
    </Modal>}
  </>;
}
