import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import client from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission } from '../../auth/permissions';
import Topbar from '../../components/layout/Topbar';
import './completion-rate.css';
import StoreCrHistory from './StoreCrHistory';

interface Config {
  crAutoClosureEnabled: boolean;
  crAutoClosureThreshold: number;
  crAutoClosureMinOrders: number;
  crAlertsEnabled: boolean;
  crBaselineCancelRate: number;
  crDeviationPoints: number;
  crMinOrders: number;
}
interface Brand extends Config {
  id: string; brandName: string; country: string; applicationId: string | null;
  application: { appName: string } | null; webhookReady: boolean; _count: { shops: number };
}
interface Run {
  id: string; windowEnd: string; completed: number; cancelled: number; unknown: number;
  completionRate: number | null; status: string; attempts: number; error: string | null; sentAt: string | null;
}
const statuses: Record<string, string> = {
  healthy: 'Dentro del umbral', insufficient_orders: 'Órdenes insuficientes', incomplete: 'En proceso de clasificación',
  suppressed: 'Alerta desactivada', pending: 'Alerta pendiente', sending: 'Enviando', sent: 'Alerta enviada', failed: 'Error de envío',
};
const date = (value: string) => new Date(value).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });

function BrandConfiguration({ brand, dchatConfigured, closureDchatConfigured }: { brand: Brand; dchatConfigured: boolean; closureDchatConfigured: boolean }) {
  const { account } = useAuth();
  const canEdit = hasPermission(account, 'integrations.completion_rate.configure');
  const [form, setForm] = useState<Config>({ crAlertsEnabled: brand.crAlertsEnabled, crBaselineCancelRate: brand.crBaselineCancelRate,
    crDeviationPoints: brand.crDeviationPoints, crMinOrders: brand.crMinOrders,
    crAutoClosureEnabled: brand.crAutoClosureEnabled, crAutoClosureThreshold: brand.crAutoClosureThreshold, crAutoClosureMinOrders: brand.crAutoClosureMinOrders });
  const qc = useQueryClient();
  const save = useMutation({ mutationFn: () => client.patch(`/integrations/completion-rate/${brand.id}`, form),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['completion-rate'] }) });
  const history = useQuery({ queryKey: ['completion-rate-history', brand.id], queryFn: async () => (await client.get<Run[]>(`/integrations/completion-rate/${brand.id}/history`)).data, refetchInterval: 60_000 });
  const error = save.error as { response?: { data?: { message?: string | string[] } } } | null;
  return <section className="card cr-detail">
    <h2>{brand.brandName}</h2>
    <p>{brand.application?.appName ?? 'Sin aplicación asociada'} · {brand._count.shops} tiendas · {brand.country}</p>
    {!brand.webhookReady && <p role="alert" className="cr-notice">Asocia la marca a una aplicación con un DiDi Order Webhook creado y activo antes de habilitar las alertas. <Link to="/applications">Ir a Applications</Link> · <Link to={`/brands/${brand.id}`}>Ver marca</Link></p>}
    <form onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <fieldset disabled={!canEdit || save.isPending}>
        <h3>Alertas por marca</h3>
        <label className="cr-toggle"><input type="checkbox" checked={form.crAlertsEnabled} disabled={!form.crAlertsEnabled && (!brand.webhookReady || !dchatConfigured)} onChange={e => setForm({ ...form, crAlertsEnabled: e.target.checked })} /> Activar alertas de esta marca</label>
        <div className="cr-fields">
          <label>Cancel Rate base (%)<input type="number" required min="0" max="100" step="0.01" value={form.crBaselineCancelRate} onChange={e => setForm({ ...form, crBaselineCancelRate: e.target.valueAsNumber })} /></label>
          <label>Desviación para alertar (puntos porcentuales)<input type="number" required min="0.01" max="100" step="0.01" value={form.crDeviationPoints} onChange={e => setForm({ ...form, crDeviationPoints: e.target.valueAsNumber })} /></label>
          <label>Mínimo de órdenes evaluadas<input type="number" required min="4" max="1000000" step="1" value={form.crMinOrders} onChange={e => setForm({ ...form, crMinOrders: e.target.valueAsNumber })} /></label>
        </div>
        <p>Se alertará con una tasa de cancelación ≥ {Number((form.crBaselineCancelRate + form.crDeviationPoints).toFixed(2))}% y al menos {form.crMinOrders} órdenes completadas o canceladas computables en los últimos 15 minutos.</p>
        <h3>Cierre automático por tienda</h3>
        {!closureDchatConfigured && <p className="cr-notice">Falta configurar el grupo D-Chat específico de cierres para habilitar esta función.</p>}
        <label className="cr-toggle"><input type="checkbox" checked={form.crAutoClosureEnabled} disabled={!form.crAutoClosureEnabled && (!brand.webhookReady || !closureDchatConfigured)} onChange={e => setForm({ ...form, crAutoClosureEnabled: e.target.checked })} /> Activar cierre automático de tiendas</label>
        <div className="cr-fields">
          <label>Umbral de Completion Rate (%)<input type="number" required min="0" max="100" step="0.01" value={form.crAutoClosureThreshold} onChange={e => setForm({ ...form, crAutoClosureThreshold: e.target.valueAsNumber })} /></label>
          <label>Mínimo de órdenes por tienda<input type="number" required min="1" max="1000000" step="1" value={form.crAutoClosureMinOrders} onChange={e => setForm({ ...form, crAutoClosureMinOrders: e.target.valueAsNumber })} /></label>
        </div>
        <p>Se cerrará cada tienda cuyo CR sea ≤ {form.crAutoClosureThreshold}% con al menos {form.crAutoClosureMinOrders} órdenes computables, acumuladas desde las 04:00 de su día operativo ({brand.country === 'CO' ? 'Bogotá' : brand.country === 'CR' ? 'Costa Rica' : 'Ciudad de México'}).</p>
        <p>Revisión cada 15 minutos de 06:00 a 03:00, hora CDMX. Auto Open respetará el cierre hasta las siguientes 04:00 del día operativo de la tienda; después podrá abrirla en su siguiente ejecución. Esta función puede activarse independientemente de las alertas por marca.</p>
        {canEdit && <button type="submit" className="btn btn-primary" disabled={form.crBaselineCancelRate + form.crDeviationPoints > 100}>{save.isPending ? 'Guardando…' : 'Guardar configuración'}</button>}
      </fieldset>
      {save.isSuccess && <p role="status">Configuración guardada.</p>}
      {save.isError && <p role="alert">{error?.response?.data?.message ?? 'No fue posible guardar la configuración.'}</p>}
    </form>
    <h3>Últimas 100 revisiones</h3>
    <p>Horario de Ciudad de México. El CR usa solo completadas y canceladas computables. «En proceso» indica cancelaciones cuyo motivo seguía en consulta a DiDi al cerrar esa revisión; no se incluyen en el CR hasta clasificarse.</p>
    {history.isPending && <p>Cargando historial…</p>}
    {history.isError && <p role="alert">No fue posible cargar el historial. <button className="btn" onClick={() => history.refetch()}>Reintentar</button></p>}
    {history.data?.length === 0 && <p>Aún no hay revisiones para esta marca.</p>}
    {!!history.data?.length && <div className="cr-table"><table><thead><tr><th>Fin de ventana</th><th>Completadas</th><th>Canceladas</th><th>En proceso</th><th>CR</th><th>Resultado</th><th>Envío D-Chat</th></tr></thead>
      <tbody>{history.data.map(run => <tr key={run.id}><td>{date(run.windowEnd)}</td><td>{run.completed}</td><td>{run.cancelled}</td><td>{run.unknown}</td><td>{run.completionRate == null ? '—' : `${run.completionRate.toFixed(2)}%`}</td><td>{statuses[run.status] ?? run.status}</td><td>{run.sentAt ? date(run.sentAt) : run.error ? `${run.error} (${run.attempts}/3)` : '—'}</td></tr>)}</tbody>
    </table></div>}
    <StoreCrHistory brandId={brand.id} />
  </section>;
}

export default function CompletionRatePage() {
  const [params] = useSearchParams();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(params.get('brandId') ?? '');
  const query = useQuery({ queryKey: ['completion-rate'], queryFn: async () => (await client.get<{ brands: Brand[]; dchatConfigured: boolean; closureDchatConfigured: boolean }>('/integrations/completion-rate')).data });
  const brands = query.data?.brands ?? [];
  const brand = brands.find(item => item.id === selected);
  return <>
    <Topbar breadcrumb={[{ label: 'Integraciones' }, { label: 'Alertas de CR' }]} />
    <main className="main-content">
      <div className="cr-page">
    <div className="page-header"><div><h1>Alertas y cierres por Completion Rate</h1><p>Monitoreo cada 15 minutos, de 06:00 a 03:00 del día siguiente (Ciudad de México).</p></div></div>
    <p>CR = completadas ÷ (completadas + cancelaciones computables). Las alertas por marca y los cierres por tienda usan grupos D-Chat separados.</p>
    {query.isPending && <p>Cargando marcas…</p>}
    {query.isError && <p role="alert">No fue posible cargar las marcas. <button className="btn" onClick={() => query.refetch()}>Reintentar</button></p>}
    {query.data && !query.data.dchatConfigured && <p className="cr-notice" role="alert">El destino D-Chat compartido aún no está configurado. Solicita su configuración al administrador para activar alertas.</p>}
    <label className="cr-search">Buscar marca<input type="search" placeholder="Nombre o aplicación" value={search} onChange={e => setSearch(e.target.value)} /></label>
    <div className="cr-layout"><section className="card cr-brands" aria-label="Marcas">
      {brands.filter(b => `${b.brandName} ${b.application?.appName ?? ''}`.toLowerCase().includes(search.toLowerCase())).map(b => <button type="button" key={b.id} className={`cr-brand ${b.id === selected ? 'selected' : ''}`} aria-pressed={b.id === selected} onClick={() => setSelected(b.id)}><strong>{b.brandName}</strong><span>{b.application?.appName ?? 'Sin aplicación'}</span><span>Alertas: {b.crAlertsEnabled ? 'activas' : 'inactivas'} · Cierre: {b.crAutoClosureEnabled ? 'activo' : 'inactivo'}</span></button>)}
      {query.data && brands.length === 0 && <p>No hay marcas disponibles.</p>}
    </section>{brand ? <BrandConfiguration key={brand.id} brand={brand} dchatConfigured={!!query.data?.dchatConfigured} closureDchatConfigured={!!query.data?.closureDchatConfigured} /> : <section className="card cr-detail"><p>Selecciona una marca para configurar sus alertas, cierres y consultar el historial.</p></section>}</div>
      </div>
    </main>
  </>;
}
