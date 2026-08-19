import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Paginator from '../../components/ui/Paginator';
import StatusBadge from '../../components/ui/StatusBadge';
import { storeEmergenciesApi } from '../../api';
import type {
  StoreEmergency,
  StoreEmergencyMilestone,
  StoreEmergencyMilestones,
  StoreEmergencyTarget,
  StoreEmergencyTargetCounts,
  StoreEmergencyTimelineEvent,
  StoreEmergencyTimelineResponse,
} from '../../types';

const ACTIVE_STATUSES = new Set(['pending', 'running', 'offline', 'partial_success', 'restoring']);
const TIMELINE_LIMIT = 25;
const TARGET_LIMIT = 25;

const milestoneDefinitions: Array<{ key: keyof StoreEmergencyMilestones; label: string }> = [
  { key: 'createdAt', label: 'Emergencia creada' },
  { key: 'shutdownQueuedAt', label: 'Apagado en cola' },
  { key: 'shutdownStartedAt', label: 'Apagado iniciado' },
  { key: 'shutdownFinishedAt', label: 'Intento de apagado terminado' },
  { key: 'scheduledReopeningAt', label: 'Reapertura programada' },
  { key: 'restoreRequestedAt', label: 'Reapertura solicitada' },
  { key: 'restoreQueuedAt', label: 'Reapertura en cola' },
  { key: 'restoreStartedAt', label: 'Reapertura iniciada' },
  { key: 'restoreFinishedAt', label: 'Intento de reapertura terminado' },
  { key: 'finishedAt', label: 'Emergencia finalizada' },
];

const eventSourceLabels: Record<string, string> = {
  user: 'Usuario',
  scheduler: 'Scheduler',
  worker: 'Worker',
  system: 'Sistema',
  migration: 'Histórico migrado',
};

const phaseLabels: Record<string, string> = {
  lifecycle: 'Ciclo de vida',
  shutdown: 'Apagado',
  schedule: 'Programación',
  restore: 'Reapertura',
  system: 'Sistema',
};

const outcomeLabels: Record<string, string> = {
  queued: 'En cola',
  running: 'En proceso',
  succeeded: 'Correcto',
  partial: 'Parcial',
  failed: 'Fallido',
  rescheduled: 'Reprogramado',
  requested: 'Solicitado',
  skipped: 'Omitido',
};

const eventTypeLabels: Record<string, string> = {
  emergency_created: 'Emergencia creada',
  shutdown_requested: 'Apagado solicitado',
  shutdown_queued: 'Apagado enviado a la cola',
  shutdown_started: 'Apagado iniciado',
  shutdown_completed: 'Apagado terminado',
  shutdown_partial: 'Apagado terminado parcialmente',
  shutdown_failed: 'Apagado fallido',
  target_shutdown_started: 'Apagado de tienda iniciado',
  target_shutdown_succeeded: 'Tienda apagada correctamente',
  target_shutdown_failed: 'No se pudo apagar la tienda',
  reopening_rescheduled: 'Reapertura reprogramada',
  restore_requested: 'Reapertura solicitada',
  restore_queued: 'Reapertura enviada a la cola',
  restore_started: 'Reapertura iniciada',
  restore_completed: 'Reapertura terminada',
  restore_partial: 'Reapertura terminada parcialmente',
  restore_failed: 'Reapertura fallida',
  target_restore_started: 'Reapertura de tienda iniciada',
  target_restore_succeeded: 'Tienda reabierta correctamente',
  target_restore_failed: 'No se pudo reabrir la tienda',
  retry_requested: 'Reintento solicitado',
  queue_failed: 'No se pudo enviar el trabajo a la cola',
  job_skipped: 'Trabajo omitido por cambio de estado',
};

function eventTitle(event: StoreEmergencyTimelineEvent) {
  const type = event.type ?? event.eventType ?? '';
  if (eventTypeLabels[type]) return eventTypeLabels[type];
  if (!type) return event.message?.trim() || 'Evento de la emergencia';
  const readable = type.replaceAll('_', ' ');
  return readable.charAt(0).toLocaleUpperCase() + readable.slice(1);
}

function formatDate(value?: string) {
  if (!value) return 'Pendiente';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('es-MX', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

function queryError(error: unknown, fallback: string) {
  const response = error as { response?: { data?: { message?: string | string[] } } };
  const message = response.response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : message ?? fallback;
}

function countsFor(emergency?: StoreEmergency, timeline?: StoreEmergencyTimelineResponse): StoreEmergencyTargetCounts {
  const counts = timeline?.counts ?? emergency?.targetCounts;
  const targets = emergency?.targets ?? [];
  return {
    total: counts?.total ?? targets.length,
    shutdownSucceeded: counts?.shutdownSucceeded ?? counts?.offlineDone ?? counts?.offline ?? targets.filter(target => target.offlineStatus === 'done').length,
    shutdownFailed: counts?.shutdownFailed ?? counts?.offlineFailed ?? targets.filter(target => target.offlineStatus === 'failed').length,
    shutdownPending: counts?.shutdownPending ?? counts?.offlinePending ?? targets.filter(target => ['pending', 'running'].includes(target.offlineStatus)).length,
    restoreSucceeded: counts?.restoreSucceeded ?? counts?.restoreDone ?? counts?.restored ?? targets.filter(target => target.restoreStatus === 'done').length,
    restoreFailed: counts?.restoreFailed ?? targets.filter(target => target.restoreStatus === 'failed').length,
    restorePending: counts?.restorePending ?? targets.filter(target => target.offlineStatus === 'done' && ['pending', 'running'].includes(target.restoreStatus)).length,
  };
}

function normalizedMilestones(
  value: StoreEmergencyTimelineResponse['milestones'] | undefined,
  emergency?: StoreEmergency,
): StoreEmergencyMilestone[] {
  if (Array.isArray(value)) return value;
  const milestones: StoreEmergencyMilestones = value ?? {
    createdAt: emergency?.createdAt,
    shutdownStartedAt: emergency?.startedAt,
    shutdownFinishedAt: emergency?.offlineAt,
    scheduledReopeningAt: emergency?.endsAt,
    restoreStartedAt: emergency?.restoreStartedAt,
    restoreFinishedAt: emergency?.restoredAt,
    finishedAt: emergency?.finishedAt,
  };
  return milestoneDefinitions.map(({ key, label }) => ({ key, label, at: milestones[key] ?? undefined }));
}

function milestoneTone(milestone: StoreEmergencyMilestone) {
  if (milestone.status === 'failed') return 'failed';
  if (!milestone.at && !milestone.occurredAt) return 'pending';
  if (milestone.key === 'scheduledReopeningAt' && new Date(milestone.at ?? milestone.occurredAt ?? 0).getTime() > Date.now()) return 'current';
  return milestone.status ?? 'done';
}

function eventTone(event: StoreEmergencyTimelineEvent) {
  if (event.outcome === 'failed' || event.severity === 'error') return 'failed';
  if (event.outcome === 'partial' || event.severity === 'warning') return 'warning';
  if (event.outcome === 'succeeded' || event.severity === 'success') return 'success';
  if (event.outcome === 'running') return 'running';
  return 'info';
}

function legacyTargets(
  targets: StoreEmergencyTarget[],
  search: string,
  phase: string,
  status: string,
  errorsOnly: boolean,
) {
  const needle = search.trim().toLocaleLowerCase();
  return targets.filter(target => {
    if (needle && ![target.shop.shopId, target.shop.appShopId, target.shop.name, target.shop.city]
      .some(value => value?.toLocaleLowerCase().includes(needle))) return false;
    if (phase === 'shutdown' && status && target.offlineStatus !== status) return false;
    if (phase === 'restore' && status && target.restoreStatus !== status) return false;
    if (!phase && status && target.offlineStatus !== status && target.restoreStatus !== status) return false;
    if (errorsOnly && !target.offlineError && !target.restoreError) return false;
    return true;
  });
}

interface Props {
  emergencyId: string;
  fallback?: StoreEmergency;
  onClose: () => void;
}

export default function EmergencyDetailModal({ emergencyId, fallback, onClose }: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<'timeline' | 'targets'>('timeline');
  const [timelinePage, setTimelinePage] = useState(1);
  const [timelinePhase, setTimelinePhase] = useState('');
  const [timelineSource, setTimelineSource] = useState('');
  const [timelineOutcome, setTimelineOutcome] = useState('');
  const [targetPage, setTargetPage] = useState(1);
  const [targetSearchInput, setTargetSearchInput] = useState('');
  const [targetSearch, setTargetSearch] = useState('');
  const [targetPhase, setTargetPhase] = useState<'shutdown' | 'restore' | ''>('');
  const [targetStatus, setTargetStatus] = useState('');
  const [targetErrorsOnly, setTargetErrorsOnly] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setTargetSearch(targetSearchInput.trim());
      setTargetPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [targetSearchInput]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onClose]);

  const detailQuery = useQuery<StoreEmergency>({
    queryKey: ['store-emergency', emergencyId],
    queryFn: () => storeEmergenciesApi.get(emergencyId).then(response => response.data),
  });
  const timelineQuery = useQuery<StoreEmergencyTimelineResponse>({
    queryKey: ['store-emergency', emergencyId, 'timeline', timelinePage, timelinePhase, timelineSource, timelineOutcome],
    queryFn: () => storeEmergenciesApi.timeline(emergencyId, {
      page: timelinePage,
      limit: TIMELINE_LIMIT,
      phase: timelinePhase || undefined,
      source: timelineSource || undefined,
      outcome: timelineOutcome || undefined,
    }).then(response => response.data),
    refetchInterval: query => timelinePage === 1 && ACTIVE_STATUSES.has(query.state.data?.emergency.status ?? detailQuery.data?.status ?? fallback?.status ?? '') ? 4000 : false,
  });
  const targetsQuery = useQuery({
    queryKey: ['store-emergency', emergencyId, 'targets', targetPage, targetSearch, targetPhase, targetStatus, targetErrorsOnly],
    queryFn: () => storeEmergenciesApi.targets(emergencyId, {
      page: targetPage,
      limit: TARGET_LIMIT,
      search: targetSearch || undefined,
      phase: targetPhase || undefined,
      status: targetStatus || undefined,
      errorsOnly: targetErrorsOnly || undefined,
    }).then(response => response.data),
    enabled: tab === 'targets',
    refetchInterval: targetPage === 1 && ACTIVE_STATUSES.has(detailQuery.data?.status ?? fallback?.status ?? '') ? 4000 : false,
  });

  const fetchedEmergency = detailQuery.data ?? fallback;
  const emergency = timelineQuery.data?.emergency
    ? {
        ...fetchedEmergency,
        ...timelineQuery.data.emergency,
        targets: timelineQuery.data.emergency.targets ?? fetchedEmergency?.targets,
        targetCounts: timelineQuery.data.emergency.targetCounts ?? fetchedEmergency?.targetCounts,
        milestones: timelineQuery.data.emergency.milestones ?? fetchedEmergency?.milestones,
      }
    : fetchedEmergency;
  const counts = countsFor(emergency, timelineQuery.data);
  const milestones = normalizedMilestones(timelineQuery.data?.milestones ?? emergency?.milestones, emergency);
  const events = timelineQuery.data?.data ?? timelineQuery.data?.events ?? [];
  const filteredLegacyTargets = useMemo(() => legacyTargets(
    emergency?.targets ?? [], targetSearch, targetPhase, targetStatus, targetErrorsOnly,
  ), [emergency?.targets, targetSearch, targetPhase, targetStatus, targetErrorsOnly]);
  const legacyStart = (targetPage - 1) * TARGET_LIMIT;
  const targetRows = targetsQuery.data?.data ?? filteredLegacyTargets.slice(legacyStart, legacyStart + TARGET_LIMIT);
  const targetTotal = targetsQuery.data?.total ?? filteredLegacyTargets.length;

  return <div className="emergency-detail-overlay" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section
      ref={dialogRef}
      className="emergency-detail-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="emergency-detail-title"
      aria-describedby="emergency-detail-description"
    >
      <header className="emergency-detail-header">
        <div className="emergency-detail-heading">
          <span className="emergency-detail-eyebrow">Registro completo de la emergencia</span>
          <div className="emergency-detail-title-row">
            <h2 id="emergency-detail-title">{emergency?.brand.brandName ?? fallback?.brand.brandName ?? 'Emergencia'}</h2>
            {emergency && <StatusBadge status={emergency.status} />}
          </div>
          <p id="emergency-detail-description">
            {emergency ? `${emergency.brand.country} · ${emergency.mode === 'all_brand' ? 'Toda la marca' : 'Lista de shop_ids'}` : 'Cargando información…'}
          </p>
        </div>
        <button ref={closeRef} type="button" className="emergency-detail-close" onClick={onClose} aria-label="Cerrar detalle de emergencia">×</button>
      </header>

      <div className="emergency-detail-body">
        {detailQuery.isLoading && !emergency && <div className="emergency-detail-loading" role="status">Cargando detalle…</div>}
        {detailQuery.isError && !emergency && <div className="error-banner" role="alert">
          {queryError(detailQuery.error, 'No se pudo cargar la emergencia')}
        </div>}

        {emergency && <>
          <section className="emergency-overview" aria-label="Resumen de la emergencia">
            <div className="emergency-reason-card">
              <span>Motivo</span>
              <strong>{emergency.reason}</strong>
              {emergency.errorMessage && <div className="emergency-main-error" role="alert">{emergency.errorMessage}</div>}
            </div>
            <dl className="emergency-meta-grid">
              <div><dt>ID</dt><dd><code title={emergency.id}>{emergency.id}</code></dd></div>
              <div><dt>Creada</dt><dd><time dateTime={emergency.createdAt} title={emergency.createdAt}>{formatDate(emergency.createdAt)}</time></dd></div>
              <div><dt>Creada por</dt><dd>{emergency.createdBy.name}<small>{emergency.createdBy.email}</small></dd></div>
              <div><dt>Reapertura programada</dt><dd><time dateTime={emergency.endsAt} title={emergency.endsAt}>{formatDate(emergency.endsAt)}</time></dd></div>
            </dl>
          </section>

          <section className="emergency-count-grid" aria-label="Resultados por tienda">
            {[
              ['Tiendas', counts.total, 'neutral'],
              ['Apagadas', counts.shutdownSucceeded, 'orange'],
              ['Error al apagar', counts.shutdownFailed, 'red'],
              ['Pendientes de apagar', counts.shutdownPending, 'gray'],
              ['Reabiertas', counts.restoreSucceeded, 'green'],
              ['Error al reabrir', counts.restoreFailed, 'red'],
              ['Pendientes de reabrir', counts.restorePending, 'blue'],
            ].map(([label, value, tone]) => <div key={label} className={`emergency-count-card tone-${tone}`}>
              <span>{label}</span><strong>{value}</strong>
            </div>)}
          </section>

          <section className="emergency-milestones" aria-labelledby="emergency-milestones-title">
            <div className="emergency-section-title">
              <div><h3 id="emergency-milestones-title">Hitos del proceso</h3><p>Hora local del navegador; pasa el cursor para ver el ISO original.</p></div>
            </div>
            <ol>
              {milestones.map(milestone => {
                const timestamp = milestone.at ?? milestone.occurredAt;
                return <li key={milestone.key} className={`is-${milestoneTone(milestone)}`}>
                  <i aria-hidden="true" />
                  <div><strong>{milestone.label}</strong><time dateTime={timestamp} title={timestamp}>{formatDate(timestamp)}</time>{milestone.description && <small>{milestone.description}</small>}</div>
                </li>;
              })}
            </ol>
          </section>

          <div className="emergency-detail-tabs" role="tablist" aria-label="Detalle de la emergencia">
            <button type="button" role="tab" aria-selected={tab === 'timeline'} className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>Cronología y logs</button>
            <button type="button" role="tab" aria-selected={tab === 'targets'} className={tab === 'targets' ? 'active' : ''} onClick={() => setTab('targets')}>Tiendas ({counts.total})</button>
          </div>

          {tab === 'timeline' && <section className="emergency-tab-panel" role="tabpanel" aria-label="Cronología y logs">
            <div className="emergency-filter-bar">
              <label>Fase<select value={timelinePhase} onChange={event => { setTimelinePhase(event.target.value); setTimelinePage(1); }}>
                <option value="">Todas</option><option value="lifecycle">Ciclo de vida</option><option value="shutdown">Apagado</option><option value="schedule">Programación</option><option value="restore">Reapertura</option><option value="system">Sistema</option>
              </select></label>
              <label>Origen<select value={timelineSource} onChange={event => { setTimelineSource(event.target.value); setTimelinePage(1); }}>
                <option value="">Todos</option><option value="user">Usuario</option><option value="scheduler">Scheduler</option><option value="worker">Worker</option><option value="system">Sistema</option><option value="migration">Histórico migrado</option>
              </select></label>
              <label>Resultado<select value={timelineOutcome} onChange={event => { setTimelineOutcome(event.target.value); setTimelinePage(1); }}>
                <option value="">Todos</option><option value="queued">En cola</option><option value="running">En proceso</option><option value="succeeded">Correcto</option><option value="partial">Parcial</option><option value="failed">Fallido</option><option value="rescheduled">Reprogramado</option><option value="requested">Solicitado</option><option value="skipped">Omitido</option>
              </select></label>
            </div>
            {timelineQuery.isLoading && <div className="emergency-detail-loading" role="status">Cargando logs…</div>}
            {timelineQuery.isError && <div className="error-banner" role="alert">{queryError(timelineQuery.error, 'No se pudo cargar la cronología')}</div>}
            {!timelineQuery.isLoading && !timelineQuery.isError && events.length === 0 && <div className="emergency-detail-empty">No hay eventos con estos filtros.</div>}
            {events.length > 0 && <ol className="emergency-event-list">
              {events.map(event => <li key={event.id} className={`tone-${eventTone(event)}`}>
                <i aria-hidden="true" />
                <article>
                  <div className="emergency-event-header">
                    <div>
                      <strong>{eventTitle(event)}</strong>
                      <span>{phaseLabels[event.phase ?? ''] ?? event.phase ?? 'Evento'} · {eventSourceLabels[event.source ?? ''] ?? event.source ?? 'Sistema'}{event.attempt ? ` · Intento ${event.attempt}` : ''}</span>
                    </div>
                    <div className="emergency-event-time">
                      {event.outcome && <b>{outcomeLabels[event.outcome] ?? event.outcome}</b>}
                      <time dateTime={event.occurredAt} title={event.occurredAt}>{formatDate(event.occurredAt)}</time>
                    </div>
                  </div>
                  {event.message?.trim() && event.message.trim() !== eventTitle(event) && <p className="emergency-event-message">{event.message}</p>}
                  {(event.actor || event.target) && <div className="emergency-event-context">
                    {event.actor && <span>Actor: <strong>{event.actor.name}</strong>{event.actor.email ? ` · ${event.actor.email}` : ''}</span>}
                    {event.target && <span>Tienda: <strong>{event.target.shop.shopId}</strong>{event.target.shop.name ? ` · ${event.target.shop.name}` : ''}</span>}
                  </div>}
                  <details><summary>Ver datos técnicos</summary>
                    <dl className="emergency-event-technical">
                      <div><dt>ID del evento</dt><dd><code>{event.id}</code></dd></div>
                      <div><dt>Tipo</dt><dd><code>{event.type ?? event.eventType ?? '—'}</code></dd></div>
                      <div><dt>Registrado</dt><dd>{formatDate(event.createdAt ?? event.occurredAt)}</dd></div>
                    </dl>
                    {event.metadata && Object.keys(event.metadata).length > 0 && <pre>{JSON.stringify(event.metadata, null, 2)}</pre>}
                  </details>
                </article>
              </li>)}
            </ol>}
            <Paginator page={timelineQuery.data?.page ?? timelinePage} total={timelineQuery.data?.total ?? 0} limit={timelineQuery.data?.limit ?? TIMELINE_LIMIT} onChange={setTimelinePage} />
          </section>}

          {tab === 'targets' && <section className="emergency-tab-panel" role="tabpanel" aria-label="Tiendas afectadas">
            <div className="emergency-target-toolbar">
              <label className="emergency-target-search">Buscar tienda<input type="search" placeholder="shop_id, app_shop_id, nombre o ciudad" value={targetSearchInput} onChange={event => setTargetSearchInput(event.target.value)} /></label>
              <label>Fase<select value={targetPhase} onChange={event => { setTargetPhase(event.target.value as typeof targetPhase); setTargetPage(1); }}><option value="">Ambas</option><option value="shutdown">Apagado</option><option value="restore">Reapertura</option></select></label>
              <label>Estado<select value={targetStatus} onChange={event => { setTargetStatus(event.target.value); setTargetPage(1); }}><option value="">Todos</option><option value="pending">Pendiente</option><option value="running">En proceso</option><option value="done">Correcto</option><option value="failed">Fallido</option></select></label>
              <label className="emergency-errors-check"><input type="checkbox" checked={targetErrorsOnly} onChange={event => { setTargetErrorsOnly(event.target.checked); setTargetPage(1); }} /> Solo errores</label>
            </div>
            {targetsQuery.isLoading && <div className="emergency-detail-loading" role="status">Cargando tiendas…</div>}
            {targetsQuery.isError && (!emergency.targets || emergency.targets.length === 0) && <div className="error-banner" role="alert">{queryError(targetsQuery.error, 'No se pudieron cargar las tiendas')}</div>}
            {!targetsQuery.isLoading && !targetsQuery.isError && targetRows.length === 0 && <div className="emergency-detail-empty">No hay tiendas con estos filtros.</div>}
            {targetRows.length > 0 && <div className="emergency-target-table-wrap"><table>
              <caption className="sr-only">Estados y horas por tienda afectada</caption>
              <thead><tr><th scope="col">Tienda</th><th scope="col">Ubicación</th><th scope="col">Apagado</th><th scope="col">Reapertura</th></tr></thead>
              <tbody>{targetRows.map(target => <tr key={target.id}>
                <td><strong className="td-mono">{target.shop.shopId}</strong><small>{target.shop.name || 'Sin nombre'} · app_shop_id {target.shop.appShopId}</small></td>
                <td>{target.shop.city || '—'}</td>
                <td><StatusBadge status={target.offlineStatus} /><time dateTime={target.offlineAt} title={target.offlineAt}>{target.offlineAt ? formatDate(target.offlineAt) : '—'}</time>{typeof target.offlineAttempts === 'number' && <small>Intentos: {target.offlineAttempts}</small>}{target.offlineError && <div className="emergency-target-error">{target.offlineError}</div>}</td>
                <td><StatusBadge status={target.restoreStatus} /><time dateTime={target.restoredAt} title={target.restoredAt}>{target.restoredAt ? formatDate(target.restoredAt) : '—'}</time>{typeof target.restoreAttempts === 'number' && <small>Intentos: {target.restoreAttempts}</small>}{target.restoreError && <div className="emergency-target-error">{target.restoreError}</div>}</td>
              </tr>)}</tbody>
            </table></div>}
            <Paginator page={targetsQuery.data?.page ?? targetPage} total={targetTotal} limit={targetsQuery.data?.limit ?? TARGET_LIMIT} onChange={setTargetPage} />
          </section>}
        </>}
      </div>
    </section>
  </div>;
}
