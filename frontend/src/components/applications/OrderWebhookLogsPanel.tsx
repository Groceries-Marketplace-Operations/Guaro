import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { orderWebhookEventsApi } from '../../api';
import { useLang, useT } from '../../i18n';
import type {
  Application,
  DidiOrderWebhookEvent,
  DidiOrderWebhookEventStage,
  DidiOrderWebhookEventStatus,
  DidiOrderWebhookEventsResponse,
} from '../../types';
import Paginator from '../ui/Paginator';

const LIMIT = 20;

interface Props {
  applications: Application[];
  applicationsLoading?: boolean;
  active?: boolean;
}

interface EventFilters {
  applicationId: string;
  status: DidiOrderWebhookEventStatus | '';
  appShopId: string;
  orderId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: EventFilters = {
  applicationId: '',
  status: '',
  appShopId: '',
  orderId: '',
  from: '',
  to: '',
};

const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden="true">
    <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
    <path d="M3.5 9a9 9 0 0 1 14.8-3.4L23 10M1 14l4.7 4.4A9 9 0 0 0 20.5 15"/>
  </svg>
);

const ChevronIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden="true">
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);

function apiMessage(error: unknown, fallback: string) {
  const apiError = error as { response?: { data?: { message?: string | string[] } } };
  const message = apiError.response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : (message ?? fallback);
}

export default function OrderWebhookLogsPanel({ applications, applicationsLoading = false, active = true }: Props) {
  const t = useT();
  const { lang } = useLang();
  const [draft, setDraft] = useState<EventFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<EventFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const params = useMemo(() => ({
    page,
    limit: LIMIT,
    ...(filters.applicationId ? { applicationId: filters.applicationId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.appShopId ? { appShopId: filters.appShopId } : {}),
    ...(filters.orderId ? { orderId: filters.orderId } : {}),
    ...(filters.from ? { from: new Date(filters.from).toISOString() } : {}),
    ...(filters.to ? { to: new Date(filters.to).toISOString() } : {}),
  }), [filters, page]);

  const eventsQuery = useQuery<DidiOrderWebhookEventsResponse>({
    queryKey: ['order-webhook-events', params],
    queryFn: () => orderWebhookEventsApi.list(params).then(response => response.data),
    enabled: active,
    retry: false,
    refetchInterval: active ? 15_000 : false,
  });

  const detailQuery = useQuery<DidiOrderWebhookEvent>({
    queryKey: ['order-webhook-event', selectedId],
    queryFn: () => orderWebhookEventsApi.get(selectedId!).then(response => response.data),
    enabled: active && !!selectedId,
    retry: false,
  });

  const formatDate = (value: string | null | undefined) => value
    ? new Date(value).toLocaleString(lang === 'es' ? 'es-MX' : 'en-US')
    : t('pages.applications.orderWebhookNever');

  const statusLabel = (status: DidiOrderWebhookEventStatus) => {
    const suffix = {
      accepted: 'Accepted',
      deduplicated: 'Deduplicated',
      rejected: 'Rejected',
      failed: 'Failed',
      processing: 'Processing',
    }[status];
    return t(`pages.applications.orderWebhookLogsStatus${suffix}`);
  };

  const stageLabel = (stage: DidiOrderWebhookEventStage) => {
    const suffix = {
      received: 'Received',
      validation: 'Validation',
      shop_resolution: 'ShopResolution',
      idempotency: 'Idempotency',
      authentication: 'Authentication',
      confirmation: 'Confirmation',
      completed: 'Completed',
      legacy: 'Legacy',
    }[stage];
    return t(`pages.applications.orderWebhookLogsStage${suffix}`);
  };

  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    setFilters({
      ...draft,
      appShopId: draft.appShopId.trim(),
      orderId: draft.orderId.trim(),
    });
    setPage(1);
    setSelectedId(null);
  };

  const clearFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(1);
    setSelectedId(null);
  };

  const selectSummary = (status: DidiOrderWebhookEventStatus | '') => {
    const next = { ...draft, status };
    setDraft(next);
    setFilters(next);
    setPage(1);
    setSelectedId(null);
  };

  const events = eventsQuery.data?.data ?? [];
  const applicationsById = useMemo(
    () => new Map(applications.map(application => [application.id, application])),
    [applications],
  );
  const summary = eventsQuery.data?.summary ?? {
    total: 0,
    accepted: 0,
    deduplicated: 0,
    rejected: 0,
    failed: 0,
    processing: 0,
  };
  const hasFilters = Object.values(filters).some(Boolean);
  const detail = detailQuery.data;

  return (
    <section className="order-webhook-logs" aria-label={t('pages.applications.orderWebhookLogsTitle')}>
      <div className="order-webhook-logs-toolbar">
        <div>
          <h3>{t('pages.applications.orderWebhookLogsTitle')}</h3>
          <p>{t('pages.applications.orderWebhookLogsSubtitle')}</p>
        </div>
        <div className="order-webhook-refresh">
          {eventsQuery.dataUpdatedAt > 0 && (
            <span>{t('pages.applications.orderWebhookLogsUpdated', { time: new Date(eventsQuery.dataUpdatedAt).toLocaleTimeString(lang === 'es' ? 'es-MX' : 'en-US') })}</span>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => eventsQuery.refetch()}
            disabled={eventsQuery.isFetching}
          >
            <RefreshIcon />
            {eventsQuery.isFetching
              ? t('pages.applications.orderWebhookLogsRefreshing')
              : t('pages.applications.orderWebhookLogsRefresh')}
          </button>
        </div>
      </div>

      <div className="order-webhook-summary" aria-label={t('pages.applications.orderWebhookLogsSummary')}>
        <button type="button" className={!filters.status ? 'is-active' : ''} onClick={() => selectSummary('')}>
          <span>{t('pages.applications.orderWebhookLogsTotal')}</span><strong>{summary.total}</strong>
        </button>
        <button type="button" className={filters.status === 'accepted' ? 'is-active is-success' : 'is-success'} onClick={() => selectSummary('accepted')}>
          <span>{t('pages.applications.orderWebhookLogsAccepted')}</span><strong>{summary.accepted}</strong>
        </button>
        <button type="button" className={filters.status === 'deduplicated' ? 'is-active is-neutral' : 'is-neutral'} onClick={() => selectSummary('deduplicated')}>
          <span>{t('pages.applications.orderWebhookLogsDeduplicated')}</span><strong>{summary.deduplicated}</strong>
        </button>
        <button type="button" className={filters.status === 'rejected' ? 'is-active is-warning' : 'is-warning'} onClick={() => selectSummary('rejected')}>
          <span>{t('pages.applications.orderWebhookLogsRejected')}</span><strong>{summary.rejected}</strong>
        </button>
        <button type="button" className={filters.status === 'failed' ? 'is-active is-danger' : 'is-danger'} onClick={() => selectSummary('failed')}>
          <span>{t('pages.applications.orderWebhookLogsFailed')}</span><strong>{summary.failed}</strong>
        </button>
        <button type="button" className={filters.status === 'processing' ? 'is-active is-processing' : 'is-processing'} onClick={() => selectSummary('processing')}>
          <span>{t('pages.applications.orderWebhookLogsProcessing')}</span><strong>{summary.processing}</strong>
        </button>
      </div>

      <form className="order-webhook-filters" onSubmit={applyFilters}>
        <div className="form-group">
          <label className="form-label" htmlFor="webhook-log-application">{t('pages.applications.orderWebhookLogsApplication')}</label>
          <select
            id="webhook-log-application"
            className="form-select"
            value={draft.applicationId}
            disabled={applicationsLoading}
            onChange={event => setDraft(current => ({ ...current, applicationId: event.target.value }))}
          >
            <option value="">{applicationsLoading
              ? t('common.loading')
              : t('pages.applications.orderWebhookLogsAllApplications')}</option>
            {applications.map(application => (
              <option key={application.id} value={application.id}>
                {application.appName} · {application.appId} · {application.country}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="webhook-log-status">{t('pages.applications.orderWebhookLogsStatus')}</label>
          <select
            id="webhook-log-status"
            className="form-select"
            value={draft.status}
            onChange={event => setDraft(current => ({ ...current, status: event.target.value as EventFilters['status'] }))}
          >
            <option value="">{t('pages.applications.orderWebhookLogsAllStatuses')}</option>
            <option value="accepted">{t('pages.applications.orderWebhookLogsStatusAccepted')}</option>
            <option value="deduplicated">{t('pages.applications.orderWebhookLogsStatusDeduplicated')}</option>
            <option value="rejected">{t('pages.applications.orderWebhookLogsStatusRejected')}</option>
            <option value="failed">{t('pages.applications.orderWebhookLogsStatusFailed')}</option>
            <option value="processing">{t('pages.applications.orderWebhookLogsStatusProcessing')}</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="webhook-log-shop">{t('pages.applications.orderWebhookLogsAppShopId')}</label>
          <input
            id="webhook-log-shop"
            className="form-input"
            inputMode="text"
            placeholder="83013"
            value={draft.appShopId}
            onChange={event => setDraft(current => ({ ...current, appShopId: event.target.value }))}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="webhook-log-order">{t('pages.applications.orderWebhookLogsOrderId')}</label>
          <input
            id="webhook-log-order"
            className="form-input"
            inputMode="numeric"
            placeholder="576468…"
            value={draft.orderId}
            onChange={event => setDraft(current => ({ ...current, orderId: event.target.value }))}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="webhook-log-from">{t('pages.applications.orderWebhookLogsFrom')}</label>
          <input id="webhook-log-from" className="form-input" type="datetime-local" value={draft.from} onChange={event => setDraft(current => ({ ...current, from: event.target.value }))} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="webhook-log-to">{t('pages.applications.orderWebhookLogsTo')}</label>
          <input id="webhook-log-to" className="form-input" type="datetime-local" value={draft.to} onChange={event => setDraft(current => ({ ...current, to: event.target.value }))} />
        </div>
        <div className="order-webhook-filter-actions">
          <button type="submit" className="btn btn-primary btn-sm">{t('pages.applications.orderWebhookLogsApply')}</button>
          {(hasFilters || Object.values(draft).some(Boolean)) && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>{t('pages.applications.orderWebhookLogsClear')}</button>
          )}
        </div>
      </form>

      {eventsQuery.isError && (
        <div className="error-banner">
          {apiMessage(eventsQuery.error, t('pages.applications.orderWebhookLogsLoadError'))}
        </div>
      )}

      <div className="order-webhook-table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('pages.applications.orderWebhookLogsReceived')}</th>
              <th>{t('pages.applications.orderWebhookLogsApplication')}</th>
              <th>{t('pages.applications.orderWebhookLogsStatus')}</th>
              <th>{t('pages.applications.orderWebhookLogsOrderId')}</th>
              <th>{t('pages.applications.orderWebhookLogsStore')}</th>
              <th>{t('pages.applications.orderWebhookLogsStage')}</th>
              <th>{t('pages.applications.orderWebhookLogsAttempts')}</th>
              <th>{t('pages.applications.orderWebhookLogsResult')}</th>
              <th><span className="sr-only">{t('pages.applications.orderWebhookLogsDetails')}</span></th>
            </tr>
          </thead>
          <tbody>
            {eventsQuery.isLoading && (
              <tr><td colSpan={9} className="order-webhook-table-message">{t('common.loading')}</td></tr>
            )}
            {!eventsQuery.isLoading && events.length === 0 && (
              <tr><td colSpan={9} className="order-webhook-table-message">
                <strong>{hasFilters ? t('pages.applications.orderWebhookLogsNoMatch') : t('pages.applications.orderWebhookLogsEmpty')}</strong>
                <span>{hasFilters ? t('pages.applications.orderWebhookLogsNoMatchHint') : t('pages.applications.orderWebhookLogsEmptyHint')}</span>
              </td></tr>
            )}
            {events.map(event => (
              <tr key={event.id} className={selectedId === event.id ? 'is-selected' : undefined}>
                <td className="order-webhook-date">{formatDate(event.createdAt)}</td>
                <td>
                  <strong>{event.application?.appName || applicationsById.get(event.applicationId)?.appName || '—'}</strong>
                  {(event.application?.appId || applicationsById.get(event.applicationId)?.appId) && (
                    <span className="order-webhook-cell-note">
                      {event.application?.appId || applicationsById.get(event.applicationId)?.appId}
                    </span>
                  )}
                </td>
                <td><span className={`order-webhook-log-status is-${event.status}`}>{statusLabel(event.status)}</span></td>
                <td className="td-mono">{event.orderId ?? '—'}</td>
                <td>
                  <strong>{event.shop?.name || event.appShopId || '—'}</strong>
                  {event.shop?.name && event.appShopId && <span className="order-webhook-cell-note">{event.appShopId}</span>}
                </td>
                <td><span className="order-webhook-stage">{stageLabel(event.stage)}</span></td>
                <td>{event.attempts ?? '—'}</td>
                <td className="order-webhook-result">
                  {event.status === 'accepted' && <span className="is-success">HTTP {event.remoteHttpStatus ?? '—'} · errno {event.remoteErrno ?? '—'}</span>}
                  {event.status === 'deduplicated' && <span>{t('pages.applications.orderWebhookLogsDuplicateResult')}</span>}
                  {event.status === 'rejected' && <span className="is-warning">HTTP {event.localHttpStatus ?? '—'} · {event.errorMessage || t('pages.applications.orderWebhookLogsRejectedResult')}</span>}
                  {event.status === 'failed' && <span className="is-danger">{event.errorMessage || event.remoteErrmsg || t('pages.applications.orderWebhookLogsUnknownError')}</span>}
                  {event.status === 'processing' && <span>{t('pages.applications.orderWebhookLogsInProgress')}</span>}
                </td>
                <td>
                  <button
                    type="button"
                    className="order-webhook-detail-button"
                    title={t('pages.applications.orderWebhookLogsDetails')}
                    aria-label={t('pages.applications.orderWebhookLogsOpenDetails', { orderId: event.orderId ?? event.id })}
                    onClick={() => setSelectedId(current => current === event.id ? null : event.id)}
                  >
                    <ChevronIcon />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(eventsQuery.data?.total ?? 0) > 0 && (
          <Paginator page={page} total={eventsQuery.data?.total ?? 0} limit={LIMIT} onChange={next => { setPage(next); setSelectedId(null); }} />
        )}
      </div>

      {selectedId && (
        <div className="order-webhook-detail" aria-live="polite">
          <div className="order-webhook-detail-header">
            <div>
              <span>{t('pages.applications.orderWebhookLogsEventDetails')}</span>
              <strong>{detail?.orderId ?? detail?.id ?? t('common.loading')}</strong>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedId(null)}>{t('common.close')}</button>
          </div>
          {detailQuery.isLoading && <p className="text-muted text-sm">{t('common.loading')}</p>}
          {detailQuery.isError && <div className="error-banner">{apiMessage(detailQuery.error, t('pages.applications.orderWebhookLogsDetailError'))}</div>}
          {detail && (
            <>
              <div className="order-webhook-detail-grid">
                <div><span>{t('pages.applications.orderWebhookLogsStatus')}</span><strong><span className={`order-webhook-log-status is-${detail.status}`}>{statusLabel(detail.status)}</span></strong></div>
                <div><span>{t('pages.applications.orderWebhookLogsStage')}</span><strong>{stageLabel(detail.stage)}</strong></div>
                <div><span>{t('pages.applications.orderWebhookLogsApplication')}</span><strong>{detail.application?.appName || applicationsById.get(detail.applicationId)?.appName || '—'}</strong><small>{detail.application?.appId || applicationsById.get(detail.applicationId)?.appId || detail.applicationId}</small></div>
                <div><span>{t('pages.applications.orderWebhookLogsEventType')}</span><strong>{detail.type ?? '—'}</strong></div>
                <div><span>{t('pages.applications.orderWebhookLogsOrderId')}</span><strong className="td-mono">{detail.orderId ?? '—'}</strong></div>
                <div><span>{t('pages.applications.orderWebhookLogsAppShopId')}</span><strong className="td-mono">{detail.appShopId ?? '—'}</strong></div>
                <div><span>{t('pages.applications.orderWebhookLogsDidiShopId')}</span><strong className="td-mono">{detail.didiShopId ?? '—'}</strong>{detail.remoteShopValidated && <small>{t('pages.applications.orderWebhookLogsRemoteValidated')}</small>}</div>
                <div><span>{t('pages.applications.orderWebhookLogsStore')}</span><strong>{detail.shop?.name || detail.shop?.shopId || '—'}</strong>{detail.shop?.brand && <small>{detail.shop.brand.brandName}</small>}</div>
                <div><span>{t('pages.applications.orderWebhookLogsAttempts')}</span><strong>{detail.attempts ?? '—'}</strong></div>
                <div><span>{t('pages.applications.orderWebhookLogsLocalHttp')}</span><strong>{detail.localHttpStatus ?? '—'}</strong></div>
                <div><span>{t('pages.applications.orderWebhookLogsDuration')}</span><strong>{detail.durationMs == null ? '—' : `${detail.durationMs} ms`}</strong></div>
                <div><span>{t('pages.applications.orderWebhookLogsRelatedEvent')}</span><strong className="td-mono">{detail.eventId ?? '—'}</strong></div>
                <div><span>{t('pages.applications.orderWebhookLogsSourceTime')}</span><strong>{formatDate(detail.sourceOccurredAt)}</strong>{detail.sourceTimestamp && <small>{t('pages.applications.orderWebhookLogsRawTimestamp', { value: detail.sourceTimestamp })}</small>}</div>
                <div><span>{t('pages.applications.orderWebhookLogsReceived')}</span><strong>{formatDate(detail.createdAt)}</strong></div>
                <div><span>{t('pages.applications.orderWebhookLogsStarted')}</span><strong>{formatDate(detail.startedAt)}</strong></div>
                <div><span>{t('pages.applications.orderWebhookLogsAcceptedAt')}</span><strong>{formatDate(detail.acceptedAt)}</strong></div>
                <div><span>{t('pages.applications.orderWebhookLogsFailedAt')}</span><strong>{formatDate(detail.failedAt)}</strong></div>
                <div><span>{t('pages.applications.orderWebhookLogsCompletedAt')}</span><strong>{formatDate(detail.completedAt)}</strong></div>
                <div><span>{t('pages.applications.orderWebhookLogsUpdatedAt')}</span><strong>{formatDate(detail.updatedAt)}</strong></div>
              </div>

              <div className="order-webhook-remote-response">
                <h4>{t('pages.applications.orderWebhookLogsDidiResponse')}</h4>
                <div>
                  <span>HTTP <strong>{detail.remoteHttpStatus ?? '—'}</strong></span>
                  <span>errno <strong>{detail.remoteErrno ?? '—'}</strong></span>
                  <span>errmsg <strong>{detail.remoteErrmsg || '—'}</strong></span>
                </div>
              </div>

              {detail.errorMessage && (
                <div className="order-webhook-error-detail">
                  <strong>{t('pages.applications.orderWebhookLogsErrorDetail')}</strong>
                  <code>{detail.errorMessage}</code>
                </div>
              )}
              <p className="order-webhook-security-note">{t('pages.applications.orderWebhookLogsSecurityNote')}</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
