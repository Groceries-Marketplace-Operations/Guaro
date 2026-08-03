import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import StatusBadge from '../../components/ui/StatusBadge';
import { autoFetchApi } from '../../api';

type FetchKind = 'stores' | 'menu';

interface FetchExecution {
  id: string;
  status: string;
  trigger: string;
  totalBrands: number;
  brandsSucceeded: number;
  totalShops: number;
  totalItems: number;
  progressPercent: number;
  currentBrand?: string;
  errorMessage?: string;
  createdAt: string;
  finishedAt?: string;
}

interface FetchBrand {
  id: string;
  brandName: string;
  brandId: string;
  kaType: 'KA' | 'CKA';
  active: boolean;
  manuallyIncluded: boolean;
  _count: { shops: number; items: number };
}

type CkaCandidate = Omit<FetchBrand, 'active' | 'manuallyIncluded'>;

interface FetchPool {
  id: string;
  kind: FetchKind;
  country: 'MX' | 'CO' | 'CR';
  name: string;
  active: boolean;
  executionHour: number;
  executionMinute: number;
  timezone: string;
  nextRunAt: string;
  lastRunAt?: string;
  brands: FetchBrand[];
  kaBrands: FetchBrand[];
  ckaBrands: FetchBrand[];
  ckaCandidates: CkaCandidate[];
  executions: FetchExecution[];
}

const COUNTRY: Record<string, string> = { MX: 'México', CO: 'Colombia', CR: 'Costa Rica' };

function apiError(error: unknown) {
  const response = error as { response?: { data?: { message?: string | string[] } } };
  const message = response.response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : message ?? 'No se pudo completar la acción';
}

export default function AutoFetchPage({ kind }: { kind: FetchKind }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string>('');
  const [ckaSelection, setCkaSelection] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const title = kind === 'stores' ? 'Auto Stores Fetch' : 'Auto Menu Fetch';
  const description = kind === 'stores'
    ? 'Descarga diariamente las tiendas y enriquece cada una con nombre, ciudad, dirección y coordenadas.'
    : 'Toma hasta 2 tiendas por ciudad y construye un catálogo global de nombre, UPC y appItemId para cada marca.';

  const { data: pools = [], isLoading } = useQuery<FetchPool[]>({
    queryKey: ['auto-fetch', kind],
    queryFn: () => autoFetchApi.listPools(kind).then(response => response.data),
    refetchInterval: query => {
      const data = query.state.data as FetchPool[] | undefined;
      return data?.some(pool => pool.executions.some(execution => ['pending', 'running'].includes(execution.status))) ? 4000 : 30_000;
    },
  });
  const action = useMutation({
    mutationFn: (request: () => Promise<unknown>) => request(),
    onSuccess: () => {
      setError('');
      qc.invalidateQueries({ queryKey: ['auto-fetch', kind] });
    },
    onError: (err: unknown) => setError(apiError(err)),
  });

  const brandTable = (pool: FetchPool, brands: FetchBrand[], running: boolean, isCka: boolean) => (
    <div className="table-wrap" style={{ marginTop: 8 }}>
      <table>
        <thead><tr><th>Marca {isCka ? 'CKA' : 'KA'}</th><th>Brand ID</th><th>Tiendas</th><th>Ítems</th><th>Programación</th><th></th></tr></thead>
        <tbody>{brands.map(brand => <tr key={brand.id}>
          <td><strong>{brand.brandName}</strong></td>
          <td className="td-mono">{brand.brandId}</td>
          <td>{brand._count.shops}</td>
          <td>{brand._count.items.toLocaleString()}</td>
          <td><StatusBadge status={brand.active ? 'active' : 'inactive'} /></td>
          <td><div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => action.mutate(() => autoFetchApi.updateBrand(pool.id, brand.id, !brand.active))}>
              {brand.active ? 'Pausar marca' : 'Reanudar marca'}
            </button>
            {!running && <button className="btn btn-primary btn-sm" onClick={() => action.mutate(() => autoFetchApi.runBrand(pool.id, brand.id))}>
              Ejecutar marca
            </button>}
            {running && <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => action.mutate(() => autoFetchApi.stopBrand(pool.id, brand.id))}>
              Detener marca
            </button>}
            {isCka && <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => {
              if (window.confirm(`¿Quitar ${brand.brandName} del pool CKA?`)) action.mutate(() => autoFetchApi.removeCkaBrand(pool.id, brand.id));
            }}>Quitar</button>}
          </div></td>
        </tr>)}</tbody>
      </table>
    </div>
  );

  return (
    <>
      <Topbar breadcrumb={[{ label: title }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info"><h1>{title}</h1><p>{description}</p></div>
        </div>
        <div className="alert alert-info" style={{ marginBottom: 18 }}>
          Las marcas KA se incluyen automáticamente. Las CKA se agregan manualmente dentro de cada país. Pausar una marca o país evita futuras ejecuciones; “Detener” cancela cooperativamente la ejecución en curso.
          {kind === 'menu' && ' Los ítems no se cuentan por tienda: cada marca conserva un catálogo único reutilizable en el apagado de ítems.'}
        </div>
        {error && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}
        {isLoading && <div className="text-muted">Cargando pools…</div>}
        <div style={{ display: 'grid', gap: 16 }}>
          {pools.map(pool => {
            const latest = pool.executions[0];
            const running = !!latest && ['pending', 'running'].includes(latest.status);
            const time = `${String(pool.executionHour).padStart(2, '0')}:${String(pool.executionMinute).padStart(2, '0')}`;
            return (
              <section className="card" key={pool.id} style={{ padding: 18 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <StatusBadge status={pool.active ? 'active' : 'inactive'} />
                      <h2 style={{ fontSize: '1rem', margin: 0 }}>{COUNTRY[pool.country]}</h2>
                      <span className="text-muted text-sm">{pool.kaBrands.length} KA · {pool.ckaBrands.length} CKA</span>
                    </div>
                    <div className="text-muted text-sm" style={{ marginTop: 7 }}>
                      Próxima ejecución: {new Date(pool.nextRunAt).toLocaleString(undefined, { timeZone: pool.timezone })} · Zona: {pool.timezone}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input className="form-input" type="time" value={time} style={{ width: 115, margin: 0 }}
                      onChange={event => {
                        const [executionHour, executionMinute] = event.target.value.split(':').map(Number);
                        action.mutate(() => autoFetchApi.updatePool(pool.id, { executionHour, executionMinute }));
                      }} />
                    <button className="btn btn-ghost btn-sm" onClick={() => action.mutate(() => autoFetchApi.updatePool(pool.id, { active: !pool.active }))}>
                      {pool.active ? 'Pausar país' : 'Reanudar país'}
                    </button>
                    {!running && <button className="btn btn-primary btn-sm" disabled={action.isPending} onClick={() => action.mutate(() => autoFetchApi.runPool(pool.id))}>
                      Ejecutar país
                    </button>}
                    {running && <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} disabled={action.isPending} onClick={() => action.mutate(() => autoFetchApi.stopPool(pool.id))}>
                      Detener país
                    </button>}
                  </div>
                </div>

                {latest && (
                  <div style={{ marginTop: 16, padding: 12, background: 'var(--surface-2)', borderRadius: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <span><StatusBadge status={latest.status} /> <span className="text-muted text-sm">{latest.currentBrand || latest.trigger}</span></span>
                      <strong style={{ fontSize: '0.8rem' }}>{latest.progressPercent}%</strong>
                    </div>
                    <div style={{ height: 6, background: 'var(--border)', borderRadius: 999, overflow: 'hidden', marginTop: 8 }}>
                      <div style={{ width: `${latest.progressPercent}%`, height: '100%', background: 'var(--orange)', transition: 'width .35s ease' }} />
                    </div>
                    <div className="text-muted text-sm" style={{ marginTop: 7 }}>
                      Marcas: {latest.brandsSucceeded}/{latest.totalBrands} · Tiendas: {latest.totalShops}
                      {kind === 'menu' ? ` · Ítems: ${latest.totalItems.toLocaleString()}` : ''}
                    </div>
                    {latest.errorMessage && <div style={{ color: 'var(--red)', fontSize: '0.78rem', marginTop: 6 }}>{latest.errorMessage}</div>}
                  </div>
                )}

                <button className="btn btn-link btn-sm" style={{ marginTop: 10 }} onClick={() => setExpanded(expanded === pool.id ? '' : pool.id)}>
                  {expanded === pool.id ? 'Ocultar marcas' : 'Administrar marcas'}
                </button>
                {expanded === pool.id && <div style={{ marginTop: 10, display: 'grid', gap: 18 }}>
                  <section>
                    <h3 style={{ fontSize: '.85rem', margin: 0 }}>KA automáticas</h3>
                    <p className="text-muted text-sm">Se incluyen automáticamente; puedes pausar o ejecutar una marca individual.</p>
                    {brandTable(pool, pool.kaBrands, running, false)}
                  </section>
                  <section>
                    <h3 style={{ fontSize: '.85rem', margin: 0 }}>CKA manuales</h3>
                    <div style={{ display: 'flex', gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
                      <select className="form-select" style={{ maxWidth: 420, margin: 0 }} value={ckaSelection[pool.id] ?? ''} onChange={event => setCkaSelection(current => ({ ...current, [pool.id]: event.target.value }))}>
                        <option value="">Selecciona una marca CKA…</option>
                        {pool.ckaCandidates.map(brand => <option key={brand.id} value={brand.id}>{brand.brandName} · {brand.brandId}</option>)}
                      </select>
                      <button className="btn btn-primary btn-sm" disabled={!ckaSelection[pool.id] || action.isPending} onClick={() => {
                        const brandId = ckaSelection[pool.id];
                        action.mutate(() => autoFetchApi.addCkaBrand(pool.id, brandId));
                        setCkaSelection(current => ({ ...current, [pool.id]: '' }));
                      }}>+ Agregar CKA</button>
                    </div>
                    {pool.ckaBrands.length > 0 ? brandTable(pool, pool.ckaBrands, running, true) : <p className="text-muted text-sm">No hay marcas CKA agregadas.</p>}
                  </section>
                </div>}
              </section>
            );
          })}
        </div>
      </main>
    </>
  );
}
