import { useQuery } from '@tanstack/react-query';
import client from '../../api/client';

interface Decision {
  id: string; windowStart: string; windowEnd: string; completed: number; cancelled: number; unknown: number;
  completionRate: number | null; threshold: number; minOrders: number; reason: string;
  shop: { name: string | null; appShopId: string };
  orderIds: { completed: string[]; cancelled: string[]; unknown: string[] };
}
interface Closure {
  id: string; shopName: string; appShopId: string; createdAt: string; closedAt: string | null;
  blockedUntil: string; status: string; attempts: number; completionRate: number; error: string | null;
  notificationStatus: string; notificationAttempts: number;
}
const labels: Record<string, string> = {
  healthy: 'CR sobre el umbral', insufficient_orders: 'Órdenes insuficientes', incomplete: 'En proceso de clasificación',
  closure_requested: 'Cierre solicitado', already_requested_today: 'Cierre ya registrado en este día', destination_unconfigured: 'D-Chat sin configurar',
  pending: 'Pendiente', closing: 'Solicitando cierre', closed: 'Cierre confirmado', unknown: 'Resultado sin confirmar',
  failed: 'Fallido', expired: 'Día operativo terminado', suppressed: 'Cierre cancelado por revalidación',
  waiting: 'En espera del resultado', sending: 'Enviando', sent: 'Enviado',
};
const date = (value: string) => new Date(value).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
export default function StoreCrHistory({ brandId }: { brandId: string }) {
  const history = useQuery({ queryKey: ['store-cr-history', brandId], queryFn: async () => (await client.get<{ decisions: Decision[]; closures: Closure[] }>(`/integrations/completion-rate/${brandId}/store-history`)).data, refetchInterval: 60_000 });
  return <section>
    <h3>Cierres por tienda</h3><p>Últimos 100 cierres. Fechas mostradas en hora CDMX. La protección termina con el día operativo; no se envía una reapertura desde esta integración.</p>
    {history.isPending && <p>Cargando cierres…</p>}
    {history.isError && <p role="alert">No fue posible cargar los cierres. <button className="btn" onClick={() => history.refetch()}>Reintentar</button></p>}
    {history.data?.closures.length === 0 && <p>Aún no hay cierres registrados.</p>}
    {!!history.data?.closures.length && <div className="cr-table"><table><thead><tr><th>Tienda</th><th>Solicitud</th><th>CR</th><th>Resultado DiDi</th><th>Protección hasta</th><th>D-Chat</th></tr></thead><tbody>
      {history.data.closures.map(row => <tr key={row.id}><td>{row.shopName}<br />{row.appShopId}</td><td>{date(row.createdAt)}</td><td>{row.completionRate.toFixed(2)}%</td><td>{labels[row.status] ?? row.status} · {row.attempts}/3{row.closedAt && <div>{date(row.closedAt)}</div>}{row.error && <div>{row.error}</div>}</td><td>{['pending', 'closing', 'closed', 'unknown'].includes(row.status) ? date(row.blockedUntil) : '—'}</td><td>{labels[row.notificationStatus] ?? row.notificationStatus} · {row.notificationAttempts}/3</td></tr>)}
    </tbody></table></div>}
    <h3>Evaluaciones por tienda</h3><p>Últimas 100 decisiones, con las órdenes y reglas utilizadas para cada evaluación.</p>
    {history.data?.decisions.length === 0 && <p>Aún no hay evaluaciones por tienda.</p>}
    {!!history.data?.decisions.length && <div className="cr-table"><table><thead><tr><th>Tienda</th><th>Período acumulado</th><th>Órdenes</th><th>CR / umbral</th><th>Decisión</th></tr></thead><tbody>
      {history.data.decisions.map(row => <tr key={row.id}><td>{row.shop.name ?? row.shop.appShopId}<br />{row.shop.appShopId}</td><td>{date(row.windowStart)}<br />{date(row.windowEnd)}</td><td>{row.completed} completadas · {row.cancelled} canceladas · {row.unknown} en proceso<br />Mínimo: {row.minOrders}<details><summary>Ver IDs</summary><p>Completadas: {row.orderIds.completed.join(', ') || '—'}</p><p>Canceladas: {row.orderIds.cancelled.join(', ') || '—'}</p><p>En proceso de clasificación: {row.orderIds.unknown.join(', ') || '—'}</p></details></td><td>{row.completionRate == null ? '—' : `${row.completionRate.toFixed(2)}%`} / {row.threshold}%</td><td>{labels[row.reason] ?? row.reason}</td></tr>)}
    </tbody></table></div>}
  </section>;
}
