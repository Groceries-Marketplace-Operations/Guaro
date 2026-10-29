import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import client from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission } from '../../auth/permissions';
import './completion-rate.css';

interface Config {
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
  healthy: 'Dentro del umbral', insufficient_orders: 'Órdenes insuficientes', incomplete: 'Datos incompletos',
  suppressed: 'Alerta desactivada', pending: 'Alerta pendiente', sending: 'Enviando', sent: 'Alerta enviada', failed: 'Error de envío',
};
const date = (value: string) => new Date(value).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });

function BrandConfiguration({ brand, dchatConfigured }: { brand: Brand; dchatConfigured: boolean }) {
  const { account } = useAuth();
  const canEdit = hasPermission(account, 'integrations.completion_rate.configure');
  const [form, setForm] = useState<Config>({ crAlertsEnabled: brand.crAlertsEnabled, crBaselineCancelRate: brand.crBaselineCancelRate,
    crDeviationPoints: brand.crDeviationPoints, crMinOrders: brand.crMinOrders });
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
        <label className="cr-toggle"><input type="checkbox" checked={form.crAlertsEnabled} disabled={!form.crAlertsEnabled && (!brand.webhookReady || !dchatConfigured)} onChange={e => setForm({ ...form, crAlertsEnabled: e.target.checked })} /> Activar alertas de esta marca</label>
        <div className="cr-fields">
          <label>Cancel Rate base (%)<input type="number" required min="0" max="100" step="0.01" value={form.crBaselineCancelRate} onChange={e => setForm({ ...form, crBaselineCancelRate: e.target.valueAsNumber })} /></label>
          <label>Desviación para alertar (puntos porcentuales)<input type="number" required min="0.01" max="100" step="0.01" value={form.crDeviationPoints} onChange={e => setForm({ ...form, crDeviationPoints: e.target.valueAsNumber })} /></label>
          <label>Mínimo de órdenes evaluadas<input type="number" required min="4" max="1000000" step="1" value={form.crMinOrders} onChange={e => setForm({ ...form, crMinOrders: e.target.valueAsNumber })} /></label>
        </div>
        <p>Se alertará con una tasa de cancelación ≥ {Number((form.crBaselineCancelRate + form.crDeviationPoints).toFixed(2))}% y al menos {form.crMinOrders} órdenes completadas o canceladas computables en los últimos 15 minutos.</p>
        {canEdit && <button type="submit" className="btn btn-primary" disabled={form.crBaselineCancelRate + form.crDeviationPoints > 100}>{save.isPending ? 'Guardando…' : 'Guardar configuración'}</button>}
      </fieldset>
      {save.isSuccess && <p role="status">Configuración guardada.</p>}
      {save.isError && <p role="alert">{error?.response?.data?.message ?? 'No fue posible guardar la configuración.'}</p>}
    </form>
    <h3>Últimas 100 revisiones</h3>
    <p>Horario de Ciudad de México. Las órdenes en curso y las cancelaciones de cliente antes de 5 minutos no se incluyen en el CR.</p>
    {history.isPending && <p>Cargando historial…</p>}
    {history.isError && <p role="alert">No fue posible cargar el historial. <button className="btn" onClick={() => history.refetch()}>Reintentar</button></p>}
    {history.data?.length === 0 && <p>Aún no hay revisiones para esta marca.</p>}
    {!!history.data?.length && <div className="cr-table"><table><thead><tr><th>Fin de ventana</th><th>Completadas</th><th>Canceladas</th><th>Sin resolver</th><th>CR</th><th>Resultado</th><th>Envío D-Chat</th></tr></thead>
      <tbody>{history.data.map(run => <tr key={run.id}><td>{date(run.windowEnd)}</td><td>{run.completed}</td><td>{run.cancelled}</td><td>{run.unknown}</td><td>{run.completionRate == null ? '—' : `${run.completionRate.toFixed(2)}%`}</td><td>{statuses[run.status] ?? run.status}</td><td>{run.sentAt ? date(run.sentAt) : run.error ? `${run.error} (${run.attempts}/3)` : '—'}</td></tr>)}</tbody>
    </table></div>}
  </section>;
}

export default function CompletionRatePage() {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const query = useQuery({ queryKey: ['completion-rate'], queryFn: async () => (await client.get<{ brands: Brand[]; dchatConfigured: boolean }>('/integrations/completion-rate')).data });
  const brands = query.data?.brands ?? [];
  const brand = brands.find(item => item.id === selected);
  return <div className="cr-page">
    <div className="page-header"><div><h1>Alertas de Completion Rate</h1><p>Monitoreo por marca cada 15 minutos, de 06:00 a 03:00 del día siguiente (Ciudad de México).</p></div></div>
    <p>CR = completadas ÷ (completadas + cancelaciones computables). Todas las alertas se envían al mismo grupo D-Chat.</p>
    {query.isPending && <p>Cargando marcas…</p>}
    {query.isError && <p role="alert">No fue posible cargar las marcas. <button className="btn" onClick={() => query.refetch()}>Reintentar</button></p>}
    {query.data && !query.data.dchatConfigured && <p className="cr-notice" role="alert">El destino D-Chat compartido aún no está configurado. Solicita su configuración al administrador para activar alertas.</p>}
    <label className="cr-search">Buscar marca<input type="search" placeholder="Nombre o aplicación" value={search} onChange={e => setSearch(e.target.value)} /></label>
    <div className="cr-layout"><section className="card cr-brands" aria-label="Marcas">
      {brands.filter(b => `${b.brandName} ${b.application?.appName ?? ''}`.toLowerCase().includes(search.toLowerCase())).map(b => <button type="button" key={b.id} className={`cr-brand ${b.id === selected ? 'selected' : ''}`} aria-pressed={b.id === selected} onClick={() => setSelected(b.id)}><strong>{b.brandName}</strong><span>{b.application?.appName ?? 'Sin aplicación'} · {b.crAlertsEnabled ? 'Activadas' : 'Desactivadas'}</span></button>)}
      {query.data && brands.length === 0 && <p>No hay marcas disponibles.</p>}
    </section>{brand ? <BrandConfiguration key={brand.id} brand={brand} dchatConfigured={!!query.data?.dchatConfigured} /> : <section className="card cr-detail"><p>Selecciona una marca para configurar sus alertas y consultar el historial.</p></section>}</div>
  </div>;
}
