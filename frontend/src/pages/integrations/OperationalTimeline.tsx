import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Paginator from '../../components/ui/Paginator';
import { storeOnboardingApi } from '../../api';
import type {
  StoreOnboardingBrandDependency,
  StoreOnboardingForecast,
  StoreOnboardingRequest,
  StoreOnboardingTimelineResponse,
  StoreOnboardingTimelineSegment,
} from '../../types';

const PAGE_LIMIT = 25;

function validTime(value?: string | null) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function formatDate(value?: string | null) {
  const time = validTime(value);
  return time == null ? '—' : new Date(time).toLocaleString();
}

function formatDuration(minutes?: number | null) {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

function segmentKind(segment: StoreOnboardingTimelineSegment) {
  if (segment.kind === 'forecast' || segment.type?.includes('forecast') || segment.status === 'forecast') return 'forecast';
  if (
    segment.kind === 'blocked'
    || segment.status === 'blocked'
    || segment.stage === 'blocked'
    || segment.toStage === 'blocked'
    || segment.stage === 'audit_needs_information'
    || segment.toStage === 'audit_needs_information'
  ) return 'blocked';
  return 'actual';
}

function dependencyDuration(dependency?: StoreOnboardingBrandDependency | null) {
  if (!dependency) return null;
  return dependency.durationMinutes ?? dependency.elapsedMinutes ?? (() => {
    const start = validTime(dependency.startedAt);
    const end = validTime(dependency.readyAt);
    return start != null && end != null ? Math.max(0, (end - start) / 60_000) : null;
  })();
}

function dependencySegment(request: StoreOnboardingRequest, dependency?: StoreOnboardingBrandDependency | null): StoreOnboardingTimelineSegment {
  const existing = !dependency || dependency.status === 'existing' || dependency.autoCompleted === true;
  const startedAt = dependency?.startedAt ?? request.createdAt;
  return {
    id: `brand-dependency-${dependency?.sourceTaskId ?? dependency?.brandTaskId ?? request.brandId}`,
    type: 'brand_dependency',
    label: existing ? '1. Brand creada · existente' : '1. Brand creada · Task compartido',
    kind: dependency?.status === 'failed' ? 'blocked' : 'actual',
    status: existing || dependency?.status === 'ready' ? 'completed' : dependency?.status ?? 'completed',
    startedAt,
    endedAt: existing ? startedAt : dependency?.readyAt,
    durationMinutes: existing ? 0 : dependencyDuration(dependency),
    eventId: existing ? 'brand-auto-completed' : dependency?.readyAt ? `brand-ready-${dependency.sourceTaskId ?? dependency.brandTaskId}` : null,
    sharedDependency: !existing,
    note: existing
      ? 'La Brand ya existía: prerequisite completado automáticamente, sin extender el SLA del batch.'
      : `Dependencia compartida${dependency?.sharedBatchCount ? ` por ${dependency.sharedBatchCount} batches` : ''}; su tiempo se incluye en el lead time de cada batch y se cuenta una sola vez en métricas globales.`,
  };
}

function forecastSegments(request: StoreOnboardingRequest, forecast?: StoreOnboardingForecast | null) {
  const estimates = forecast?.stageEstimates;
  const milestones = Array.isArray(estimates) ? estimates : [];
  let cursor = validTime(request.updatedAt) ?? validTime(request.createdAt) ?? 0;
  return milestones.flatMap((milestone, index) => {
    const end = validTime(milestone.estimatedAt);
    if (end == null || end < cursor) return [];
    const segment: StoreOnboardingTimelineSegment = {
      id: `forecast-${milestone.stage ?? index}-${milestone.estimatedAt}`,
      type: 'forecast',
      label: milestone.label ?? milestone.stage ?? `Hito ${index + 1}`,
      kind: 'forecast',
      stage: milestone.stage,
      status: 'forecast',
      startedAt: new Date(cursor).toISOString(),
      estimatedEndAt: new Date(end).toISOString(),
      durationMinutes: Math.max(0, (end - cursor) / 60_000),
    };
    cursor = end;
    return [segment];
  });
}

function fallbackSegments(request: StoreOnboardingRequest, forecast?: StoreOnboardingForecast | null) {
  const unitEvents: StoreOnboardingTimelineSegment[] = (request.units ?? []).flatMap((unit): StoreOnboardingTimelineSegment[] => {
    if (unit.transitions?.length) return unit.transitions.map(transition => ({
      id: transition.id,
      type: 'transition',
      unitId: unit.id,
      label: transition.toStage.replaceAll('_', ' '),
      stage: transition.toStage,
      fromStage: transition.fromStage,
      toStage: transition.toStage,
      kind: transition.toStage === 'blocked' ? 'blocked' : 'actual',
      status: 'completed',
      startedAt: transition.createdAt,
      endedAt: transition.createdAt,
      owner: transition.actor,
      note: transition.note,
      eventId: transition.id,
      metadata: transition.metadata,
    } satisfies StoreOnboardingTimelineSegment));
    const markerAt = unit.updatedAt ?? unit.createdAt ?? request.createdAt;
    return [{
      id: `current-${unit.id}-${unit.stage}-${markerAt}`,
      type: 'current_stage',
      unitId: unit.id,
      label: unit.stage.replaceAll('_', ' '),
      stage: unit.stage,
      kind: unit.stage === 'blocked' ? 'blocked' : 'actual',
      status: 'current',
      startedAt: markerAt,
      endedAt: markerAt,
      note: 'Marcador de la última etapa confirmada; no representa progreso calculado por reloj.',
    } satisfies StoreOnboardingTimelineSegment];
  });
  return [...unitEvents, ...forecastSegments(request, forecast)];
}

function eventLaneId(segment: StoreOnboardingTimelineSegment, laneMode: 'batch' | 'stores') {
  if (segment.type === 'brand_dependency' && segment.key) return segment.key;
  if (segment.type === 'brand_dependency') return 'brand';
  if (laneMode === 'batch') {
    const batchId = segment.batchId ?? (typeof segment.metadata?.batchId === 'string' ? segment.metadata.batchId : null);
    return batchId ? `batch:${batchId}` : 'batch';
  }
  return segment.unitId ?? 'batch';
}

function confirmedEventKey(segment: StoreOnboardingTimelineSegment) {
  if (segmentKind(segment) === 'forecast') return null;
  if (!segment.eventId && !(segment.status === 'completed' && segment.endedAt)) return null;
  return segment.eventId ?? segment.id;
}

function laneLabel(request: StoreOnboardingRequest, laneId: string, segments: StoreOnboardingTimelineSegment[]) {
  if (laneId === 'brand') return 'Brand compartida';
  if (laneId === 'batch') return 'Batch / forecast';
  if (laneId.startsWith('batch:')) {
    const matching = segments.find(segment => eventLaneId(segment, 'batch') === laneId);
    return matching?.batchLabel ?? 'Batch operativo';
  }
  const unit = request.units?.find(item => item.id === laneId);
  return unit ? `${unit.externalShopId}${unit.appShopId ? ` · ${unit.appShopId}` : ''}` : `Tienda ${laneId.slice(0, 8)}`;
}

export default function OperationalTimeline({ request, forecast }: { request: StoreOnboardingRequest; forecast?: StoreOnboardingForecast | null }) {
  const [page, setPage] = useState(1);
  const [unitId, setUnitId] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [laneMode, setLaneMode] = useState<'batch' | 'stores'>('batch');
  const [viewMode, setViewMode] = useState<'gantt' | 'linear'>(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches ? 'linear' : 'gantt'
  ));
  const [selected, setSelected] = useState<StoreOnboardingTimelineSegment | null>(null);
  const [animatedEventIds, setAnimatedEventIds] = useState<Set<string>>(() => new Set());
  const [confirmedAnnouncement, setConfirmedAnnouncement] = useState('');
  const seenConfirmedIds = useRef(new Set<string>());
  const confirmationContext = useRef('');
  const [snapshotNow] = useState(() => Date.now());
  const query = useQuery<StoreOnboardingTimelineResponse>({
    queryKey: ['store-onboarding-timeline', request.id, { page, limit: PAGE_LIMIT, unitId }],
    queryFn: () => storeOnboardingApi.timeline(request.id, { page, limit: PAGE_LIMIT, unitId: unitId || undefined }).then(response => response.data),
    retry: false,
    refetchInterval: 10_000,
  });
  const dependency = query.data?.summary.brandDependency ?? request.brandDependency;
  const dependencyBar = useMemo(() => dependencySegment(request, dependency), [dependency, request]);
  const apiSegments = useMemo(() => query.data?.data ?? [], [query.data?.data]);
  const projectedSegments = useMemo(() => {
    const base = forecastSegments(request, forecast);
    if (laneMode !== 'batch') return base;
    const batches = [...new Map(apiSegments.flatMap(segment => segment.batchId
      ? [[segment.batchId, segment.batchLabel ?? 'Batch operativo'] as const]
      : [])).entries()];
    return batches.length
      ? batches.flatMap(([batchId, batchLabel]) => base.map(segment => ({
          ...segment,
          id: `${segment.id}:${batchId}`,
          batchId,
          batchLabel,
        })))
      : base;
  }, [apiSegments, forecast, laneMode, request]);
  const rawSegments = useMemo(() => apiSegments.length
    ? [...apiSegments, ...projectedSegments]
    : fallbackSegments(request, forecast), [apiSegments, forecast, projectedSegments, request]);
  const segments = useMemo(() => rawSegments.filter(segment => {
    if (unitId && segment.unitId && segment.unitId !== unitId) return false;
    return !kindFilter || segmentKind(segment) === kindFilter;
  }), [kindFilter, rawSegments, unitId]);
  const laneIds = useMemo(() => {
    const ids = [...new Set(segments.map(segment => eventLaneId(segment, laneMode)).filter(id => id !== 'brand'))];
    return ids.length ? ids : ['batch'];
  }, [laneMode, segments]);
  const allSegments = useMemo(() => {
    const repeatedDependency = laneIds.map(laneId => ({ ...dependencyBar, id: `${dependencyBar.id}:${laneId}`, key: laneId, unitId: laneId === 'batch' ? null : laneId }));
    return [...repeatedDependency, ...segments.filter(segment => segment.type !== 'brand_dependency')];
  }, [dependencyBar, laneIds, segments]);
  const linearSegments = useMemo(() => [...allSegments].sort((left, right) => (
    (validTime(left.startedAt) ?? 0) - (validTime(right.startedAt) ?? 0)
  )), [allSegments]);
  useEffect(() => {
    if (!query.isSuccess) return;
    const context = `${request.id}:${page}:${unitId}`;
    const confirmedIds = [...apiSegments, dependencyBar]
      .map(confirmedEventKey)
      .filter((id): id is string => id != null);
    if (confirmationContext.current !== context) {
      confirmationContext.current = context;
      seenConfirmedIds.current = new Set(confirmedIds);
      setAnimatedEventIds(new Set());
      setConfirmedAnnouncement('');
      return;
    }
    const fresh = confirmedIds.filter(id => !seenConfirmedIds.current.has(id));
    confirmedIds.forEach(id => seenConfirmedIds.current.add(id));
    if (!fresh.length) return;
    setAnimatedEventIds(new Set(fresh));
    setConfirmedAnnouncement(`${fresh.length} ${fresh.length === 1 ? 'evento confirmado nuevo' : 'eventos confirmados nuevos'} en el timeline.`);
    const timeout = window.setTimeout(() => setAnimatedEventIds(new Set()), 700);
    return () => window.clearTimeout(timeout);
  }, [apiSegments, dependencyBar, page, query.dataUpdatedAt, query.isSuccess, request.id, unitId]);
  const bounds = useMemo(() => {
    const times = allSegments.flatMap(segment => [validTime(segment.startedAt), validTime(segment.endedAt), validTime(segment.estimatedEndAt)]).filter((value): value is number => value != null);
    const min = times.length ? Math.min(...times) : validTime(request.createdAt) ?? 0;
    let max = times.length ? Math.max(...times) : min + 60 * 60_000;
    if (max <= min) max = min + 60 * 60_000;
    const padding = Math.max(15 * 60_000, (max - min) * .04);
    return { min: min - padding, max: max + padding };
  }, [allSegments, request.createdAt]);
  const nowPercent = ((snapshotNow - bounds.min) / (bounds.max - bounds.min)) * 100;
  const summary = query.data?.summary;
  const inclusive = summary?.inclusiveLeadTimeMinutes ?? (() => {
    const start = validTime(request.createdAt);
    const end = validTime(request.estimatedCompletionAt) ?? validTime(request.updatedAt);
    return start != null && end != null ? Math.max(0, (end - start) / 60_000) : null;
  })();
  const own = summary?.batchOwnTimeMinutes ?? (inclusive != null ? Math.max(0, inclusive - (dependencyDuration(dependency) ?? 0)) : null);

  const barStyle = (segment: StoreOnboardingTimelineSegment) => {
    const start = validTime(segment.startedAt) ?? bounds.min;
    const end = validTime(segment.endedAt) ?? validTime(segment.estimatedEndAt) ?? start;
    const range = bounds.max - bounds.min;
    const left = Math.max(0, Math.min(100, ((start - bounds.min) / range) * 100));
    const width = Math.max(1.1, Math.min(100 - left, ((Math.max(start, end) - start) / range) * 100));
    return { left: `${left}%`, width: `${width}%` };
  };

  return <section className="card operational-timeline" aria-labelledby="operational-timeline-title">
    <div className="card-header operational-timeline-header"><div><span className="card-title" id="operational-timeline-title">Timeline operacional</span><p className="text-muted text-sm">Tiempos confirmados sólidos, proyección rayada y dependencia de Brand compartida por cada lane.</p></div><div className="timeline-legend" aria-label="Leyenda"><span className="actual">Real</span><span className="forecast">Forecast</span><span className="blocked">Bloqueo</span></div></div>
    <div className="timeline-summary">
      <div><span>Lead time inclusivo</span><strong>{formatDuration(inclusive)}</strong><small>Incluye Brand</small></div>
      <div><span>Tiempo propio del batch</span><strong>{formatDuration(own)}</strong><small>Sin dependencia compartida</small></div>
      <div><span>Paso 1 · Brand creada</span><strong>{dependency?.status === 'waiting' ? 'Esperando Task' : dependency?.status === 'failed' ? 'Fallida' : 'Completada'}</strong><small>{dependency?.autoCompleted || !dependency ? 'Existente · 0 min' : `${formatDuration(dependencyDuration(dependency))} · Task compartido`}</small></div>
      <div><span>Tiendas</span><strong>{summary?.completedUnits ?? request.completedUnits} / {request.totalUnits}</strong><small>{summary?.blockedUnits ?? 0} bloqueadas · {request.failedUnits} con error</small></div>
    </div>
    <div className="timeline-toolbar">
      <label><span className="sr-only">Vista del timeline</span><select className="form-select" value={viewMode} onChange={event => setViewMode(event.target.value as 'gantt' | 'linear')}><option value="gantt">Vista Gantt</option><option value="linear">Vista lineal accesible</option></select></label>
      <label><span className="sr-only">Agrupar lanes</span><select className="form-select" value={laneMode} onChange={event => setLaneMode(event.target.value as 'batch' | 'stores')}><option value="batch">Resumen por batch</option><option value="stores">Expandir tiendas</option></select></label>
      <label><span className="sr-only">Filtrar por tienda</span><select className="form-select" value={unitId} onChange={event => { setUnitId(event.target.value); setPage(1); }}><option value="">Todas las tiendas</option>{(request.units ?? []).map(unit => <option key={unit.id} value={unit.id}>{unit.externalShopId}{unit.appShopId ? ` · ${unit.appShopId}` : ''}</option>)}</select></label>
      <label><span className="sr-only">Filtrar tipo de periodo</span><select className="form-select" value={kindFilter} onChange={event => setKindFilter(event.target.value)}><option value="">Real + forecast</option><option value="actual">Sólo real</option><option value="forecast">Sólo forecast</option><option value="blocked">Sólo bloqueos</option></select></label>
      <span>{query.isFetching ? 'Actualizando eventos confirmados…' : query.isError ? 'Timeline local de respaldo' : `${query.data?.total ?? segments.length} evento(s)`}</span>
    </div>
    {viewMode === 'gantt' && <div className="timeline-scroll" tabIndex={0} aria-label="Gantt desplazable horizontalmente">
      <div className="timeline-canvas">
        <div className="timeline-axis"><span>{new Date(bounds.min).toLocaleDateString()}</span><span>{new Date((bounds.min + bounds.max) / 2).toLocaleDateString()}</span><span>{new Date(bounds.max).toLocaleDateString()}</span></div>
        {nowPercent >= 0 && nowPercent <= 100 && <div className="timeline-now" style={{ left: `${nowPercent}%` }}><span>Ahora</span></div>}
        {laneIds.map(laneId => {
          const laneSegments = allSegments.filter(segment => eventLaneId(segment, laneMode) === laneId);
          const currentLaneLabel = laneLabel(request, laneId, segments);
          return <div className="timeline-lane" key={laneId}>
            <div className="timeline-lane-label"><strong>{currentLaneLabel}</strong><small>{laneId === 'batch' || laneId.startsWith('batch:') ? 'Resumen del batch' : request.units?.find(unit => unit.id === laneId)?.stage.replaceAll('_', ' ')}</small></div>
            <div className="timeline-track">{laneSegments.map(segment => {
              const kind = segmentKind(segment);
              const confirmed = Boolean(segment.eventId || (segment.status === 'completed' && segment.endedAt));
              return <button
                type="button"
                key={segment.id}
                className={`timeline-bar ${kind}${segment.sharedDependency ? ' shared' : ''}${confirmed && animatedEventIds.has(confirmedEventKey(segment) ?? '') ? ' is-confirmed' : ''}`}
                style={barStyle(segment)}
                title={`${segment.label} · ${formatDate(segment.startedAt)} → ${formatDate(segment.endedAt ?? segment.estimatedEndAt)}`}
                aria-label={`${currentLaneLabel}. ${segment.label}. ${kind === 'forecast' ? 'Estimado' : 'Confirmado'} desde ${formatDate(segment.startedAt)} hasta ${formatDate(segment.endedAt ?? segment.estimatedEndAt)}`}
                onClick={() => setSelected(segment)}
              ><span>{segment.label}</span></button>;
            })}</div>
          </div>;
        })}
      </div>
    </div>}
    {viewMode === 'linear' && <div className="timeline-linear" tabIndex={0} aria-label="Vista lineal del timeline por lane y tienda">
      <table className="timeline-linear-table">
        <caption className="sr-only">Eventos del Store Onboarding ordenados cronológicamente, con lane o tienda, estado, fechas, duración y responsable.</caption>
        <thead><tr><th scope="col">Lane / tienda</th><th scope="col">Evento</th><th scope="col">Tipo</th><th scope="col">Inicio</th><th scope="col">Fin</th><th scope="col">Duración</th><th scope="col">Responsable</th></tr></thead>
        <tbody>{linearSegments.map((segment, index) => {
          const kind = segmentKind(segment);
          const laneId = eventLaneId(segment, laneMode);
          const eventKey = confirmedEventKey(segment);
          const fresh = Boolean(eventKey && animatedEventIds.has(eventKey));
          return <tr className={`timeline-linear-row${fresh ? ' is-confirmed' : ''}`} key={`${segment.id}:${laneId}:${index}`}>
            <th scope="row" data-label="Lane / tienda">{laneLabel(request, laneId, segments)}</th>
            <td data-label="Evento"><button type="button" className="timeline-linear-event" onClick={() => setSelected(segment)}>{segment.label}</button></td>
            <td data-label="Tipo"><span className={`timeline-kind-badge ${kind}`}>{kind === 'forecast' ? 'Forecast' : kind === 'blocked' ? 'Bloqueo' : 'Real'}</span></td>
            <td data-label="Inicio">{formatDate(segment.startedAt)}</td>
            <td data-label="Fin">{formatDate(segment.endedAt ?? segment.estimatedEndAt)}</td>
            <td data-label="Duración">{formatDuration(segment.durationMinutes)}</td>
            <td data-label="Responsable">{segment.owner?.name ?? segment.actor?.name ?? '—'}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
    <span className="sr-only" aria-live="polite" aria-atomic="true">{confirmedAnnouncement}</span>
    {selected && <div className="timeline-event-detail" role="status"><div><span>{segmentKind(selected) === 'forecast' ? 'Proyección' : 'Evento confirmado'}</span><strong>{selected.label}</strong></div><dl><div><dt>Inicio</dt><dd>{formatDate(selected.startedAt)}</dd></div><div><dt>Fin</dt><dd>{formatDate(selected.endedAt ?? selected.estimatedEndAt)}</dd></div><div><dt>Duración</dt><dd>{formatDuration(selected.durationMinutes)}</dd></div><div><dt>Responsable</dt><dd>{selected.owner?.name ?? selected.actor?.name ?? '—'}</dd></div></dl>{selected.note && <p>{selected.note}</p>}<button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelected(null)}>Cerrar detalle</button></div>}
    {(query.data?.total ?? 0) > (query.data?.limit ?? PAGE_LIMIT) && <div className="timeline-pagination"><Paginator page={query.data?.page ?? page} total={query.data?.total ?? 0} limit={query.data?.limit ?? PAGE_LIMIT} onChange={setPage} /></div>}
    <p className="timeline-footnote">La dependencia de Brand se proyecta en cada batch que la usa. El consolidado global contabiliza ese Task una sola vez.</p>
  </section>;
}
