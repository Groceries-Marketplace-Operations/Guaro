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
  brands: Array<{ id: string; brandName: string; brandId: string; _count: { shops: number; items: number } }>;
  executions: FetchExecution[];
}

const COUNTRY: Record<string, string> = { MX: 'México', CO: 'Colombia', CR: 'Costa Rica' };

export default function AutoFetchPage({ kind }: { kind: FetchKind }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string>('');
  const title = kind === 'stores' ? 'Auto Stores Fetch' : 'Auto Menu Fetch';
  const description = kind === 'stores'
    ? 'Descarga diariamente las tiendas KA y enriquece cada una con nombre, ciudad, dirección y coordenadas.'
    : 'Toma hasta 2 tiendas por ciudad y construye un catálogo global de nombre, UPC y appItemId para cada marca.';

  const { data: pools = [], isLoading } = useQuery<FetchPool[]>({
    queryKey: ['auto-fetch', kind],
    queryFn: () => autoFetchApi.listPools(kind).then(response => response.data),
    refetchInterval: query => {
      const data = query.state.data as FetchPool[] | undefined;
      return data?.some(pool => pool.executions.some(execution => ['pending', 'running'].includes(execution.status))) ? 5000 : 30_000;
    },
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: object }) => autoFetchApi.updatePool(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auto-fetch', kind] }),
  });
  const run = useMutation({
    mutationFn: (id: string) => autoFetchApi.runPool(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auto-fetch', kind] }),
  });

  return (
    <>
      <Topbar breadcrumb={[{ label: title }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info"><h1>{title}</h1><p>{description}</p></div>
        </div>
        <div className="alert alert-info" style={{ marginBottom: 18 }}>
          Los pools incluyen automáticamente solo marcas KA con una aplicación vinculada. La hora se interpreta en la zona horaria de cada país.
          {kind === 'menu' && ' Los ítems no se cuentan por tienda: cada marca conserva un catálogo único reutilizable en el apagado de ítems.'}
        </div>
        {isLoading && <div className="text-muted">Cargando pools…</div>}
        <div style={{ display: 'grid', gap: 16 }}>
          {pools.map(pool => {
            const latest = pool.executions[0];
            const running = latest && ['pending', 'running'].includes(latest.status);
            const time = `${String(pool.executionHour).padStart(2, '0')}:${String(pool.executionMinute).padStart(2, '0')}`;
            return (
              <section className="card" key={pool.id} style={{ padding: 18 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <StatusBadge status={pool.active ? 'active' : 'inactive'} />
                      <h2 style={{ fontSize: '1rem', margin: 0 }}>{COUNTRY[pool.country]}</h2>
                      <span className="text-muted text-sm">{pool.brands.length} marcas KA</span>
                    </div>
                    <div className="text-muted text-sm" style={{ marginTop: 7 }}>
                      Próxima ejecución: {new Date(pool.nextRunAt).toLocaleString(undefined, { timeZone: pool.timezone })} · Zona: {pool.timezone}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input className="form-input" type="time" value={time} style={{ width: 115, margin: 0 }}
                      onChange={event => {
                        const [executionHour, executionMinute] = event.target.value.split(':').map(Number);
                        update.mutate({ id: pool.id, data: { executionHour, executionMinute } });
                      }} />
                    <button className="btn btn-ghost btn-sm" onClick={() => update.mutate({ id: pool.id, data: { active: !pool.active } })}>
                      {pool.active ? 'Desactivar' : 'Activar'}
                    </button>
                    <button className="btn btn-primary btn-sm" disabled={!!running || run.isPending} onClick={() => run.mutate(pool.id)}>
                      {running ? 'Ejecutando…' : 'Ejecutar ahora'}
                    </button>
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
                      {kind === 'menu' ? ` · Items: ${latest.totalItems.toLocaleString()}` : ''}
                    </div>
                    {latest.errorMessage && <div style={{ color: 'var(--red)', fontSize: '0.78rem', marginTop: 6 }}>{latest.errorMessage}</div>}
                  </div>
                )}

                <button className="btn btn-link btn-sm" style={{ marginTop: 10 }} onClick={() => setExpanded(expanded === pool.id ? '' : pool.id)}>
                  {expanded === pool.id ? 'Ocultar marcas' : 'Ver marcas incluidas'}
                </button>
                {expanded === pool.id && (
                  <div className="table-wrap" style={{ marginTop: 8, maxHeight: 320, overflow: 'auto' }}>
                    <table><thead><tr><th>Marca KA</th><th>Brand ID</th><th>Tiendas</th><th>Items</th></tr></thead>
                      <tbody>{pool.brands.map(brand => <tr key={brand.id}><td>{brand.brandName}</td><td className="td-mono">{brand.brandId}</td><td>{brand._count.shops}</td><td>{brand._count.items.toLocaleString()}</td></tr>)}</tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </main>
    </>
  );
}
