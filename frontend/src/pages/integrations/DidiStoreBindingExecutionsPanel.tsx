import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { didiStoreBindingsApi } from '../../api';
import type {
  DidiStoreBindingAction,
  DidiStoreBindingExecution,
  DidiStoreBindingExecutionDetailResponse,
  DidiStoreBindingExecutionItem,
  DidiStoreBindingExecutionItemStatus,
  DidiStoreBindingShop,
} from '../../types';

interface RetryShop extends DidiStoreBindingShop {
  sourcePage: number;
}

interface Props {
  applicationId: string;
  activeExecutionId?: string;
  onActiveExecutionChange: (id?: string) => void;
  onLoadFailed: (action: DidiStoreBindingAction, shops: RetryShop[]) => void;
}

const ACTIVE_STATUSES = new Set(['pending', 'running']);
const ITEM_PAGE_SIZE = 100;
const EXPORT_PAGE_SIZE = 7_000;

function apiError(reason: unknown, fallback: string) {
  const message = (reason as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : message ?? fallback;
}

function statusLabel(status: DidiStoreBindingExecution['status']) {
  return ({
    pending: 'En cola',
    running: 'Procesando',
    done: 'Completada',
    partial_success: 'Éxito parcial',
    failed: 'Fallida',
    cancelled: 'Cancelada',
  } satisfies Record<DidiStoreBindingExecution['status'], string>)[status];
}

function statusClass(status: DidiStoreBindingExecution['status']) {
  if (status === 'done') return 's-done';
  if (status === 'running') return 's-running';
  if (status === 'pending') return 's-pending';
  if (status === 'cancelled') return 's-cancelled';
  if (status === 'partial_success') return 's-blocked';
  return 's-failed';
}

function itemStatusLabel(status: DidiStoreBindingExecutionItemStatus) {
  return ({
    pending: 'Pendiente',
    processing: 'Preparando',
    submitting: 'Enviando a DiDi',
    success: 'Confirmada',
    failed: 'Fallida definitiva',
    unconfirmed: 'Sin confirmar',
    cancelled: 'Cancelada',
  } satisfies Record<DidiStoreBindingExecutionItemStatus, string>)[status];
}

function itemStatusClass(status: DidiStoreBindingExecutionItemStatus) {
  if (status === 'success') return 's-done';
  if (status === 'processing' || status === 'submitting') return 's-running';
  if (status === 'pending') return 's-pending';
  if (status === 'cancelled') return 's-cancelled';
  if (status === 'unconfirmed') return 's-blocked';
  return 's-failed';
}

function formatDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('es-MX');
}

function csvValue(value: unknown) {
  const text = value === undefined || value === null ? '' : String(value);
  const safe = /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function downloadCsv(execution: DidiStoreBindingExecution, rows: DidiStoreBindingExecutionItem[]) {
  const header = ['ordinal', 'shop_id', 'app_shop_id', 'remote_page_no', 'status', 'message', 'started_at', 'finished_at'];
  const body = rows.map(row => [
    row.ordinal,
    row.shopId,
    row.appShopId,
    row.remotePageNo,
    row.status,
    row.message,
    row.startedAt,
    row.finishedAt,
  ].map(csvValue).join(','));
  const blob = new Blob([`\uFEFF${[header.join(','), ...body].join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `didi-${execution.action}-${execution.id}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function fetchAllItems(id: string, status?: DidiStoreBindingExecutionItemStatus) {
  const first = (await didiStoreBindingsApi.execution(id, 1, EXPORT_PAGE_SIZE, status)).data;
  const rows = [...first.items.data];
  for (let pageNo = 2; pageNo <= first.items.totalPages; pageNo += 1) {
    const page = (await didiStoreBindingsApi.execution(id, pageNo, EXPORT_PAGE_SIZE, status)).data;
    rows.push(...page.items.data);
  }
  return { execution: first.execution, rows };
}

export default function DidiStoreBindingExecutionsPanel({
  applicationId,
  activeExecutionId,
  onActiveExecutionChange,
  onLoadFailed,
}: Props) {
  const queryClient = useQueryClient();
  const [itemPage, setItemPage] = useState(1);
  const [itemFilter, setItemFilter] = useState<'' | DidiStoreBindingExecutionItemStatus>('');
  const [panelMessage, setPanelMessage] = useState('');
  const [exporting, setExporting] = useState(false);
  const [loadingFailed, setLoadingFailed] = useState(false);

  const historyQuery = useQuery({
    queryKey: ['didi-store-bindings', 'executions', applicationId],
    queryFn: () => didiStoreBindingsApi.executions(applicationId, 20).then(response => response.data),
    enabled: !!applicationId,
    retry: false,
    refetchInterval: query => query.state.data?.data.some(item => ACTIVE_STATUSES.has(item.status)) ? 4_000 : false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (activeExecutionId || !historyQuery.data?.data.length) return;
    onActiveExecutionChange(historyQuery.data.data[0].id);
  }, [activeExecutionId, historyQuery.data, onActiveExecutionChange]);

  const detailQuery = useQuery<DidiStoreBindingExecutionDetailResponse>({
    queryKey: ['didi-store-bindings', 'execution', activeExecutionId, itemPage, itemFilter],
    queryFn: () => didiStoreBindingsApi.execution(
      activeExecutionId!,
      itemPage,
      ITEM_PAGE_SIZE,
      itemFilter || undefined,
    ).then(response => response.data),
    enabled: !!activeExecutionId,
    retry: false,
    refetchInterval: query => query.state.data && ACTIVE_STATUSES.has(query.state.data.execution.status) ? 2_500 : false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const totalPages = detailQuery.data?.items.totalPages;
    if (!totalPages || itemPage <= totalPages) return;
    const timer = window.setTimeout(() => setItemPage(totalPages), 0);
    return () => window.clearTimeout(timer);
  }, [detailQuery.data?.items.totalPages, itemPage]);

  const cancelMutation = useMutation({
    mutationFn: (id: string) => didiStoreBindingsApi.cancelExecution(id),
    onSuccess: response => {
      setPanelMessage(response.data.cancelRequested
        ? 'Cancelación solicitada. La tienda que ya está en curso terminará de forma segura.'
        : 'La ejecución ya no acepta cancelación.');
      void queryClient.invalidateQueries({ queryKey: ['didi-store-bindings', 'execution', response.data.execution.id] });
      void queryClient.invalidateQueries({ queryKey: ['didi-store-bindings', 'executions', applicationId] });
    },
    onError: reason => setPanelMessage(apiError(reason, 'No se pudo solicitar la cancelación.')),
  });

  const execution = detailQuery.data?.execution;
  const items = detailQuery.data?.items;
  const progress = execution?.totalShops
    ? Math.min(100, Math.round((execution.processedShops / execution.totalShops) * 100))
    : 0;
  const cancelledShops = execution
    ? Math.max(0, execution.processedShops - execution.successfulShops - execution.failedShops - execution.unconfirmedShops)
    : 0;
  const canCancel = !!execution && ACTIVE_STATUSES.has(execution.status) && !execution.cancelRequested;
  const creator = useMemo(() => {
    if (!execution?.createdBy) return '';
    if (typeof execution.createdBy === 'string') return execution.createdBy;
    return execution.createdBy.name ?? execution.createdBy.email ?? '';
  }, [execution]);

  const exportResults = async () => {
    if (!execution || exporting) return;
    setExporting(true);
    setPanelMessage('Preparando CSV completo…');
    try {
      const result = await fetchAllItems(execution.id);
      downloadCsv(result.execution, result.rows);
      setPanelMessage(`CSV descargado con ${result.rows.length.toLocaleString('es-MX')} resultado(s).`);
    } catch (reason) {
      setPanelMessage(apiError(reason, 'No se pudo descargar el resultado completo.'));
    } finally {
      setExporting(false);
    }
  };

  const loadFailedForRetry = async () => {
    if (!execution || loadingFailed) return;
    setLoadingFailed(true);
    setPanelMessage('Cargando sólo las fallidas definitivas…');
    try {
      const result = await fetchAllItems(execution.id, 'failed');
      if (!result.rows.length) {
        setPanelMessage('Esta ejecución no tiene fallidas definitivas para preparar.');
        return;
      }
      const retryShops = result.rows.map(row => ({
        shopId: row.shopId,
        appShopId: row.appShopId,
        sourcePage: row.remotePageNo ?? 1,
      }));
      onLoadFailed(execution.action, retryShops);
      setPanelMessage(`${retryShops.length.toLocaleString('es-MX')} fallida(s) definitiva(s) cargadas para revisión manual. No se ejecutó ningún reintento.`);
    } catch (reason) {
      setPanelMessage(apiError(reason, 'No se pudieron cargar las tiendas fallidas.'));
    } finally {
      setLoadingFailed(false);
    }
  };

  if (!applicationId) return null;

  return <div className="card" style={{ padding: 18, marginTop: 14 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
      <div>
        <strong>Operaciones masivas</strong>
        <p className="text-muted" style={{ marginTop: 5, fontSize: 12 }}>
          Historial y progreso real del backend. Los estados sin confirmar nunca se reintentan automáticamente.
        </p>
      </div>
      <button type="button" className="btn btn-ghost btn-sm" disabled={historyQuery.isFetching} onClick={() => void historyQuery.refetch()}>
        {historyQuery.isFetching ? 'Actualizando…' : 'Actualizar historial'}
      </button>
    </div>

    {historyQuery.isError && <div className="error-banner" style={{ marginTop: 12 }}>
      {apiError(historyQuery.error, 'No se pudo consultar el historial. Si el despliegue acaba de iniciar, vuelve a intentar en unos segundos.')}
    </div>}

    {!!historyQuery.data?.data.length && <div style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '12px 0 4px' }} aria-label="Historial de operaciones">
      {historyQuery.data.data.map(item => <button
        key={item.id}
        type="button"
        className={`btn ${activeExecutionId === item.id ? 'btn-primary' : 'btn-ghost'} btn-sm`}
        onClick={() => onActiveExecutionChange(item.id)}
        style={{ minWidth: 150, textAlign: 'left', flex: '0 0 auto' }}
      >
        <span style={{ display: 'block' }}>{item.action === 'bind' ? 'Bind' : 'Unbind'} · {item.totalShops.toLocaleString('es-MX')}</span>
        <span style={{ display: 'block', fontSize: 10, opacity: .82 }}>{statusLabel(item.status)} · {formatDate(item.createdAt)}</span>
      </button>)}
    </div>}

    {!historyQuery.isLoading && !historyQuery.isError && !historyQuery.data?.data.length && <div className="empty-state" style={{ marginTop: 12 }}>
      <p>Aún no hay operaciones masivas para esta aplicación.</p>
    </div>}

    {detailQuery.isLoading && <p className="text-muted" style={{ padding: 14 }}>Cargando operación…</p>}
    {detailQuery.isError && <div className="error-banner" style={{ marginTop: 12 }}>{apiError(detailQuery.error, 'No se pudo consultar la operación.')}</div>}

    {execution && items && <div style={{ marginTop: 14 }} aria-live="polite">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className={`status ${statusClass(execution.status)}`}>{statusLabel(execution.status)}</span>
          <strong>{execution.action === 'bind' ? 'Bind' : 'Unbind'} de {execution.totalShops.toLocaleString('es-MX')} tiendas</strong>
          <span className="badge td-mono" title={execution.id}>ID {execution.id.slice(0, 8)}</span>
          <span className="badge">{execution.application.environment.toUpperCase()}</span>
          {ACTIVE_STATUSES.has(execution.status) && <span className="badge">Actualización automática</span>}
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={exporting} onClick={() => void exportResults()}>{exporting ? 'Preparando CSV…' : 'Descargar resultados CSV'}</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={loadingFailed || execution.failedShops === 0} onClick={() => void loadFailedForRetry()}>{loadingFailed ? 'Cargando…' : 'Preparar fallidas'}</button>
          {canCancel && <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--red-text)' }} disabled={cancelMutation.isPending} onClick={() => {
            if (window.confirm('¿Solicitar la cancelación? La tienda que ya está en curso puede terminar; sólo se cancelarán las pendientes.')) cancelMutation.mutate(execution.id);
          }}>
            {cancelMutation.isPending ? 'Solicitando…' : 'Cancelar pendientes'}
          </button>}
        </div>
      </div>

      <div style={{ marginTop: 13 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, marginBottom: 6 }}>
          <span>{execution.processedShops.toLocaleString('es-MX')} de {execution.totalShops.toLocaleString('es-MX')} procesadas</span>
          <strong>{progress}%</strong>
        </div>
        <div role="progressbar" aria-label="Avance de la operación" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} style={{ height: 10, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden' }}>
          <div style={{ width: `${progress}%`, height: '100%', background: execution.status === 'failed' ? 'var(--red-text)' : 'var(--orange)', transition: 'width .3s ease' }} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))', gap: 8, marginTop: 12 }}>
        <div className="card" style={{ padding: 10 }}><span className="text-muted" style={{ fontSize: 11 }}>Confirmadas</span><strong style={{ display: 'block', color: 'var(--green-text)' }}>{execution.successfulShops.toLocaleString('es-MX')}</strong></div>
        <div className="card" style={{ padding: 10 }}><span className="text-muted" style={{ fontSize: 11 }}>Fallidas</span><strong style={{ display: 'block', color: 'var(--red-text)' }}>{execution.failedShops.toLocaleString('es-MX')}</strong></div>
        <div className="card" style={{ padding: 10 }}><span className="text-muted" style={{ fontSize: 11 }}>Sin confirmar</span><strong style={{ display: 'block', color: 'var(--purple-text)' }}>{execution.unconfirmedShops.toLocaleString('es-MX')}</strong></div>
        <div className="card" style={{ padding: 10 }}><span className="text-muted" style={{ fontSize: 11 }}>Canceladas</span><strong style={{ display: 'block' }}>{cancelledShops.toLocaleString('es-MX')}</strong></div>
        <div className="card" style={{ padding: 10 }}><span className="text-muted" style={{ fontSize: 11 }}>Pendientes</span><strong style={{ display: 'block' }}>{execution.pendingShops.toLocaleString('es-MX')}</strong></div>
        <div className="card" style={{ padding: 10 }}><span className="text-muted" style={{ fontSize: 11 }}>Bloque</span><strong style={{ display: 'block' }}>{execution.currentBatch ?? 0}/{execution.totalBatches}</strong></div>
      </div>

      {(execution.cancelRequested || execution.currentShopId || creator) && <p className="text-muted" style={{ marginTop: 10, fontSize: 11 }}>
        {execution.cancelRequested && <><strong>Cancelación solicitada.</strong> </>}
        {execution.currentShopId && <>Tienda actual: <span className="td-mono">{execution.currentShopId}</span>. </>}
        {creator && <>Creada por {creator}. </>}
        Inicio: {formatDate(execution.startedAt)} · Fin: {formatDate(execution.finishedAt)}
      </p>}
      {execution.unconfirmedShops > 0 && <div style={{ ...warningStyle, marginTop: 11 }}>
        Hay {execution.unconfirmedShops.toLocaleString('es-MX')} tienda(s) sin confirmación. Revisa su estado antes de decidir cualquier acción; Guaro no las agrega al reintento manual.
      </div>}
      {panelMessage && <div role="status" style={{ ...warningStyle, marginTop: 11 }}>{panelMessage}</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'end', flexWrap: 'wrap', marginTop: 15 }}>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 210 }}>
          <label className="form-label" htmlFor="didi-execution-item-filter">Filtrar resultados</label>
          <select id="didi-execution-item-filter" className="form-input" value={itemFilter} onChange={event => { setItemFilter(event.target.value as typeof itemFilter); setItemPage(1); }}>
            <option value="">Todos los estados</option>
            <option value="pending">Pendientes</option>
            <option value="processing">Preparando</option>
            <option value="submitting">Enviando a DiDi</option>
            <option value="success">Confirmadas</option>
            <option value="failed">Fallidas definitivas</option>
            <option value="unconfirmed">Sin confirmar</option>
            <option value="cancelled">Canceladas</option>
          </select>
        </div>
        <span className="text-muted" style={{ fontSize: 12 }}>{items.total.toLocaleString('es-MX')} resultado(s) · página {items.pageNo}/{Math.max(1, items.totalPages)}</span>
      </div>

      <div className="table-wrap" style={{ marginTop: 10, maxHeight: 430, overflow: 'auto' }}>
        <table>
          <thead><tr><th>#</th><th>Shop ID</th><th>App Shop ID</th>{execution.action === 'unbind' && <th>Página DiDi</th>}<th>Estado</th><th>Detalle</th></tr></thead>
          <tbody>{items.data.map(row => <tr key={row.id}>
            <td>{row.ordinal}</td>
            <td className="td-mono">{row.shopId}</td>
            <td className="td-mono">{row.appShopId}</td>
            {execution.action === 'unbind' && <td>{row.remotePageNo ?? '—'}</td>}
            <td><span className={`status ${itemStatusClass(row.status)}`}>{itemStatusLabel(row.status)}</span></td>
            <td style={row.status === 'failed' || row.status === 'unconfirmed' ? { color: 'var(--red-text)' } : undefined}>{row.message ?? '—'}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {!items.data.length && <div className="empty-state"><p>No hay resultados con este estado.</p></div>}

      {items.totalPages > 1 && <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 7, marginTop: 10 }}>
        <button type="button" className="btn btn-ghost btn-sm" disabled={itemPage <= 1 || detailQuery.isFetching} onClick={() => setItemPage(1)}>Primera</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={itemPage <= 1 || detailQuery.isFetching} onClick={() => setItemPage(page => Math.max(1, page - 1))}>Anterior</button>
        <span className="text-muted" style={{ fontSize: 12 }}>{itemPage} / {items.totalPages}</span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={itemPage >= items.totalPages || detailQuery.isFetching} onClick={() => setItemPage(page => Math.min(items.totalPages, page + 1))}>Siguiente</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={itemPage >= items.totalPages || detailQuery.isFetching} onClick={() => setItemPage(items.totalPages)}>Última</button>
      </div>}
    </div>}
  </div>;
}

const warningStyle = {
  padding: '10px 12px',
  border: '1px solid var(--amber-border)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--amber-bg)',
  color: 'var(--amber-text)',
  fontSize: 12,
  lineHeight: 1.45,
};
