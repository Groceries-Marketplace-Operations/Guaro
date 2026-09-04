import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { applicationShopInventoryApi } from '../../api';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import Paginator from '../../components/ui/Paginator';
import type {
  ApplicationShopInventory,
  ApplicationShopInventoryBrand,
  ApplicationShopInventoryBrandsResponse,
  ApplicationShopInventoryOption,
  ApplicationShopInventoryShop,
  Paginated,
} from '../../types';
import './app-shop-inventory.css';

const LIMIT = 50;
const ACTIVE_STATUSES = new Set(['queued', 'running']);

function errorMessage(error: unknown, fallback: string) {
  const apiError = error as { response?: { data?: { message?: string | string[] } } };
  const message = apiError.response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : (message ?? fallback);
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Nunca';
}

function statusLabel(status: ApplicationShopInventory['fetchStatus']) {
  return ({
    never: 'Sin consultar',
    queued: 'En cola',
    running: 'Consultando',
    succeeded: 'Actualizado',
    failed: 'Falló',
  } as const)[status];
}

function brandLabel(brand: ApplicationShopInventoryBrand) {
  return brand.brandName || brand.brandExternalId || 'Sin identificar';
}

function brandFilterValue(brand: ApplicationShopInventoryBrand) {
  return brand.brandExternalId || brand.brandName || '__unknown__';
}

export default function AppShopInventoryPage() {
  const qc = useQueryClient();
  const [selectedPreference, setSelectedPreference] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [optionQuery, setOptionQuery] = useState('');
  const [applicationId, setApplicationId] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [shopQuery, setShopQuery] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [page, setPage] = useState(1);

  const inventoriesQuery = useQuery<ApplicationShopInventory[]>({
    queryKey: ['application-shop-inventory'],
    queryFn: () => applicationShopInventoryApi.list().then(response => response.data),
    refetchInterval: query => {
      const values = query.state.data as ApplicationShopInventory[] | undefined;
      return values?.some(item => ACTIVE_STATUSES.has(item.fetchStatus)) ? 4_000 : false;
    },
    refetchOnWindowFocus: false,
  });
  const inventories = inventoriesQuery.data ?? [];
  const selected = inventories.find(item => item.id === selectedPreference) ?? inventories[0] ?? null;
  const selectedId = selected?.id ?? '';

  const optionsQuery = useQuery<ApplicationShopInventoryOption[]>({
    queryKey: ['application-shop-inventory-options', optionQuery],
    queryFn: () => applicationShopInventoryApi.options(optionQuery).then(response => response.data),
    enabled: addOpen,
    retry: false,
  });
  const availableOptions = (optionsQuery.data ?? []).filter(option => !option.shopInventory);

  const brandsQuery = useQuery<ApplicationShopInventoryBrandsResponse>({
    queryKey: ['application-shop-inventory-brands', selectedId, selected?.lastSuccessfulFetchAt],
    queryFn: () => applicationShopInventoryApi.brands(selectedId).then(response => response.data),
    enabled: Boolean(selectedId),
    retry: false,
  });
  const brands = brandsQuery.data?.data ?? [];

  const shopParams = useMemo(() => ({
    page,
    limit: LIMIT,
    ...(shopQuery.trim() ? { q: shopQuery.trim() } : {}),
    ...(brandFilter ? { brand: brandFilter } : {}),
  }), [brandFilter, page, shopQuery]);
  const shopsQuery = useQuery<Paginated<ApplicationShopInventoryShop>>({
    queryKey: ['application-shop-inventory-shops', selectedId, selected?.lastSuccessfulFetchAt, shopParams],
    queryFn: () => applicationShopInventoryApi.shops(selectedId, shopParams).then(response => response.data),
    enabled: Boolean(selectedId),
    retry: false,
  });

  const refreshLocalViews = async () => {
    await qc.invalidateQueries({ queryKey: ['application-shop-inventory'] });
    await qc.invalidateQueries({ queryKey: ['application-shop-inventory-options'] });
    await qc.invalidateQueries({ queryKey: ['application-shop-inventory-brands'] });
    await qc.invalidateQueries({ queryKey: ['application-shop-inventory-shops'] });
  };

  const addApplication = async () => {
    if (!applicationId) return;
    setBusy('add'); setError(''); setNotice('');
    try {
      const created = await applicationShopInventoryApi.add(applicationId);
      setSelectedPreference(created.data.id);
      setAddOpen(false);
      setApplicationId('');
      setOptionQuery('');
      setNotice('Aplicación añadida. El inventario sólo se consultará cuando presiones “Actualizar inventario”.');
      await refreshLocalViews();
    } catch (cause) {
      setError(errorMessage(cause, 'No se pudo añadir la aplicación.'));
    } finally {
      setBusy('');
    }
  };

  const requestFetch = async (inventory: ApplicationShopInventory) => {
    const confirmed = window.confirm(
      `Se consultará el listado completo de tiendas de ${inventory.application.appName}. `
      + 'Es una operación de sólo lectura y puede tardar varios minutos. ¿Continuar?',
    );
    if (!confirmed) return;
    setBusy(`fetch:${inventory.id}`); setError(''); setNotice('');
    try {
      await applicationShopInventoryApi.fetch(inventory.id);
      setSelectedPreference(inventory.id);
      setNotice('Consulta encolada. Puedes permanecer en esta pantalla para ver el progreso.');
      await refreshLocalViews();
    } catch (cause) {
      setError(errorMessage(cause, 'No se pudo iniciar la consulta.'));
    } finally {
      setBusy('');
    }
  };

  const removeInventory = async (inventory: ApplicationShopInventory) => {
    if (!window.confirm(
      `¿Quitar ${inventory.application.appName} de esta sección? `
      + 'Sólo se eliminará este inventario; la Application, sus brands y tiendas operativas no se modificarán.',
    )) return;
    setBusy(`remove:${inventory.id}`); setError(''); setNotice('');
    try {
      await applicationShopInventoryApi.remove(inventory.id);
      setSelectedPreference('');
      setNotice('Aplicación retirada del inventario sin modificar el catálogo operativo.');
      await refreshLocalViews();
    } catch (cause) {
      setError(errorMessage(cause, 'No se pudo quitar la aplicación.'));
    } finally {
      setBusy('');
    }
  };

  const shops = shopsQuery.data?.data ?? [];
  const shopTotal = shopsQuery.data?.total ?? 0;
  const progress = selected?.fetchExpectedShops
    ? Math.min(100, Math.round((selected.fetchShopsDiscovered / selected.fetchExpectedShops) * 100))
    : null;

  return <>
    <Topbar breadcrumb={[{ label: 'Inventario de tiendas por app' }]} />
    <main className="main-content app-shop-inventory-page">
      <div className="page-header">
        <div className="page-header-info">
          <div className="app-shop-inventory-title-line">
            <h1>Inventario de tiendas por app</h1>
            <span className="badge app-shop-inventory-super-badge">Sólo Super Admin</span>
          </div>
          <p>Añade Applications, consulta su universo completo de tiendas y revisa brands y cobertura sin alterar el catálogo operativo.</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setAddOpen(true); setError(''); }}>
          Añadir aplicación
        </button>
      </div>

      {error && <div className="error-banner app-shop-inventory-banner">{error}</div>}
      {notice && <div className="alert alert-success app-shop-inventory-banner">{notice}</div>}
      {inventoriesQuery.isError && <div className="error-banner app-shop-inventory-banner">
        {errorMessage(inventoriesQuery.error, 'No se pudo cargar el inventario de aplicaciones.')}
      </div>}

      <section className="card app-shop-inventory-managed-card">
        <div className="app-shop-inventory-section-heading">
          <div><h2>Aplicaciones administradas</h2><p>{inventories.length} configuradas</p></div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>Aplicación</th><th>País</th><th>Estado</th><th>Progreso</th>
              <th>Tiendas</th><th>Brands</th><th>Último inventario</th><th></th>
            </tr></thead>
            <tbody>
              {inventoriesQuery.isLoading && <tr><td colSpan={8} className="text-muted">Cargando…</td></tr>}
              {!inventoriesQuery.isLoading && !inventoriesQuery.isError && inventories.length === 0 && <tr><td colSpan={8}>
                <div className="empty-state"><h3>No hay aplicaciones añadidas</h3><p>Añade una Application existente; esto no hará ninguna llamada a DiDi todavía.</p></div>
              </td></tr>}
              {inventories.map(inventory => {
                const active = ACTIVE_STATUSES.has(inventory.fetchStatus);
                const applicationRemoved = Boolean(inventory.application.deletedAt);
                return <tr
                  key={inventory.id}
                  className={selectedId === inventory.id ? 'app-shop-inventory-selected-row' : undefined}
                  onClick={() => { setSelectedPreference(inventory.id); setPage(1); setBrandFilter(''); setShopQuery(''); }}
                >
                  <td><strong>{inventory.application.appName}</strong>{applicationRemoved && <span className="badge app-shop-inventory-removed-badge">Application retirada</span>}<span className="app-shop-inventory-cell-note td-mono">{inventory.application.appId}</span></td>
                  <td>{inventory.application.country}</td>
                  <td><span className={`badge app-shop-inventory-status status-${inventory.fetchStatus}`}>{statusLabel(inventory.fetchStatus)}</span></td>
                  <td>{active
                    ? <span className="text-muted text-sm">{inventory.fetchShopsDiscovered}/{inventory.fetchExpectedShops ?? '…'} · {inventory.fetchPagesProcessed} pág.</span>
                    : '—'}</td>
                  <td><strong>{inventory.totalShops.toLocaleString()}</strong></td>
                  <td><strong>{inventory.totalBrands.toLocaleString()}</strong></td>
                  <td className="text-muted text-sm">{formatDate(inventory.lastSuccessfulFetchAt)}</td>
                  <td onClick={event => event.stopPropagation()}><div className="app-shop-inventory-actions">
                    <button className="btn btn-primary btn-sm" disabled={applicationRemoved || active || !!busy} onClick={() => requestFetch(inventory)}>
                      {applicationRemoved ? 'Credencial retirada' : active ? 'En proceso…' : 'Actualizar inventario'}
                    </button>
                    <button className="btn btn-ghost btn-sm app-shop-inventory-remove" disabled={active || !!busy} onClick={() => removeInventory(inventory)}>
                      Quitar
                    </button>
                  </div></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </section>

      {selected && <>
        {ACTIVE_STATUSES.has(selected.fetchStatus) && <section className="card app-shop-inventory-progress-card">
          <div><strong>{selected.fetchStatus === 'queued' ? 'Esperando turno' : 'Consultando DiDi'}</strong>
            <span>{selected.fetchShopsDiscovered.toLocaleString()} tiendas encontradas en {selected.fetchPagesProcessed} páginas</span></div>
          <div className="app-shop-inventory-progress-track"><span style={{ width: `${progress ?? 8}%` }} /></div>
        </section>}
        {selected.fetchStatus === 'failed' && selected.lastError && <div className="error-banner app-shop-inventory-banner">
          La última actualización falló: {selected.lastError}. El snapshot exitoso anterior permanece intacto.
        </div>}

        <section className="app-shop-inventory-stats">
          <div className="stat-card orange-accent"><span>Tiendas totales</span><strong>{selected.totalShops.toLocaleString()}</strong></div>
          <div className="stat-card"><span>Brands</span><strong>{selected.totalBrands.toLocaleString()}</strong></div>
          <div className="stat-card"><span>Tiendas con brand</span><strong>{selected.identifiedBrandShops.toLocaleString()}</strong><small>de {selected.totalShops.toLocaleString()}</small></div>
          <div className="stat-card"><span>Última actualización</span><strong className="app-shop-inventory-date-stat">{formatDate(selected.lastSuccessfulFetchAt)}</strong></div>
        </section>

        <section className="app-shop-inventory-detail-grid">
          <div className="card app-shop-inventory-brand-card">
            <div className="app-shop-inventory-section-heading"><div><h2>Brands encontradas</h2><p>Fuente DiDi cuando está disponible; fallback al catálogo de Tequila.</p></div></div>
            <div className="app-shop-inventory-brand-list">
              {brandsQuery.isLoading && <p className="text-muted">Cargando brands…</p>}
              {brandsQuery.isError && <div className="error-banner">{errorMessage(brandsQuery.error, 'No se pudieron cargar las brands.')}</div>}
              {!brandsQuery.isLoading && !brandsQuery.isError && brands.length === 0 && <div className="empty-state"><p>Aún no hay datos de brands.</p></div>}
              {brands.map(brand => <button
                type="button"
                key={`${brand.brandExternalId ?? ''}:${brand.brandName ?? ''}`}
                className={`app-shop-inventory-brand-row${brandFilter === brandFilterValue(brand) ? ' active' : ''}`}
                onClick={() => { setBrandFilter(current => current === brandFilterValue(brand) ? '' : brandFilterValue(brand)); setPage(1); }}
              >
                <span><strong>{brandLabel(brand)}</strong><small>{brand.brandExternalId || 'brand_id no disponible'} · {brand.brandSource === 'remote' ? 'DiDi' : brand.brandSource === 'local' ? 'Tequila' : 'Sin identificar'}</small></span>
                <b>{brand.shopCount.toLocaleString()}</b>
              </button>)}
            </div>
          </div>

          <div className="card app-shop-inventory-shop-card">
            <div className="app-shop-inventory-section-heading app-shop-inventory-shop-heading">
              <div><h2>Tiendas</h2><p>{shopTotal.toLocaleString()} resultados{brandFilter ? ' con el filtro de brand' : ''}</p></div>
              <div className="app-shop-inventory-filters">
                <input className="form-input" value={shopQuery} placeholder="Nombre, Shop ID, App Shop ID, ciudad…" onChange={event => { setShopQuery(event.target.value); setPage(1); }} />
                {brandFilter && <button className="btn btn-ghost btn-sm" onClick={() => { setBrandFilter(''); setPage(1); }}>Quitar filtro de brand</button>}
              </div>
            </div>
            <div className="table-wrap"><table><thead><tr>
              <th>Tienda</th><th>Brand</th><th>App Shop ID</th><th>Shop ID</th><th>Ciudad</th>
            </tr></thead><tbody>
              {shopsQuery.isLoading && <tr><td colSpan={5} className="text-muted">Cargando tiendas…</td></tr>}
              {shopsQuery.isError && <tr><td colSpan={5}><div className="error-banner">{errorMessage(shopsQuery.error, 'No se pudieron cargar las tiendas.')}</div></td></tr>}
              {!shopsQuery.isLoading && !shopsQuery.isError && shops.length === 0 && <tr><td colSpan={5}><div className="empty-state"><p>No hay tiendas con estos filtros.</p></div></td></tr>}
              {shops.map(shop => <tr key={shop.id}>
                <td><strong>{shop.shopName || 'Sin nombre'}</strong>{shop.address && <span className="app-shop-inventory-cell-note">{shop.address}</span>}</td>
                <td>{shop.brandName || shop.brandExternalId || <span className="text-muted">Sin identificar</span>}</td>
                <td className="td-mono">{shop.appShopId}</td>
                <td className="td-mono">{shop.shopId}</td>
                <td>{shop.city || '—'}</td>
              </tr>)}
            </tbody></table></div>
            <Paginator page={page} total={shopTotal} limit={LIMIT} onChange={setPage} />
          </div>
        </section>
      </>}
    </main>

    {addOpen && <Modal
      title="Añadir aplicación al inventario"
      onClose={() => { if (!busy) { setAddOpen(false); setApplicationId(''); setOptionQuery(''); } }}
      footer={<>
        <button className="btn btn-ghost" disabled={!!busy} onClick={() => { setAddOpen(false); setApplicationId(''); setOptionQuery(''); }}>Cancelar</button>
        <button className="btn btn-primary" disabled={!applicationId || !!busy} onClick={addApplication}>{busy === 'add' ? 'Añadiendo…' : 'Añadir'}</button>
      </>}
    >
      <p className="text-muted" style={{ marginBottom: 14 }}>Añadir una aplicación no ejecuta ningún fetch. Podrás iniciarlo de forma explícita después.</p>
      <label className="form-label" htmlFor="shop-inventory-option-search">Buscar Application</label>
      <input id="shop-inventory-option-search" className="form-input" value={optionQuery} placeholder="Nombre o App ID" onChange={event => { setOptionQuery(event.target.value); setApplicationId(''); }} autoFocus />
      <label className="form-label" htmlFor="shop-inventory-option-select" style={{ marginTop: 14 }}>Application</label>
      <select id="shop-inventory-option-select" className="form-select" value={applicationId} onChange={event => setApplicationId(event.target.value)}>
        <option value="">Selecciona una aplicación…</option>
        {availableOptions.map(option => <option key={option.id} value={option.id}>{option.appName} · {option.country} · {option.appId}</option>)}
      </select>
      {optionsQuery.isError && <div className="error-banner">{errorMessage(optionsQuery.error, 'No se pudieron cargar las Applications.')}</div>}
      {!optionsQuery.isLoading && !optionsQuery.isError && availableOptions.length === 0 && <p className="form-hint">No hay Applications disponibles con esta búsqueda.</p>}
    </Modal>}
  </>;
}
