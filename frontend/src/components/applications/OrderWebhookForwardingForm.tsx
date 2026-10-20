import { useState } from 'react';
import { applicationsApi } from '../../api';
import { useT } from '../../i18n';
import type { ApplicationOrderWebhook, ApplicationOrderWebhookForwarding } from '../../types';
import './order-webhook-forwarding.css';

interface Props {
  applicationId: string;
  forwarding?: ApplicationOrderWebhookForwarding;
  onSaved: (webhook: ApplicationOrderWebhook) => void;
}

const EMPTY_FORWARDING: ApplicationOrderWebhookForwarding = {
  enabled: false,
  url: null,
  hostname: null,
  updatedAt: null,
  lastDelivery: null,
};

function responseMessage(error: unknown, fallback: string) {
  const apiError = error as { response?: { data?: { message?: string | string[] } } };
  const message = apiError.response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : (message ?? fallback);
}

export default function OrderWebhookForwardingForm({ applicationId, forwarding: initialForwarding, onSaved }: Props) {
  const t = useT();
  const forwarding = initialForwarding ?? EMPTY_FORWARDING;
  const [enabled, setEnabled] = useState(forwarding.enabled);
  const [url, setUrl] = useState(forwarding.url ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const normalizedUrl = url.trim();
  const dirty = enabled !== forwarding.enabled || normalizedUrl !== (forwarding.url ?? '');
  const lastDelivery = forwarding.lastDelivery;

  const formatDate = (value: string | null | undefined) => value
    ? new Date(value).toLocaleString()
    : t('pages.applications.orderWebhookNever');

  const validateUrl = () => {
    if (!normalizedUrl) {
      return enabled ? t('pages.applications.orderWebhookForwardingUrlRequired') : '';
    }
    try {
      const parsed = new URL(normalizedUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
        return t('pages.applications.orderWebhookForwardingUrlInvalid');
      }
      return '';
    } catch {
      return t('pages.applications.orderWebhookForwardingUrlInvalid');
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const validationError = validateUrl();
    if (validationError) {
      setError(validationError);
      setSaved(false);
      return;
    }

    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const response = await applicationsApi.updateOrderWebhookForwarding(applicationId, {
        enabled,
        ...(normalizedUrl ? { url: normalizedUrl } : {}),
      });
      onSaved(response.data);
      setSaved(true);
    } catch (requestError: unknown) {
      setError(responseMessage(requestError, t('pages.applications.orderWebhookForwardingSaveError')));
    } finally {
      setSaving(false);
    }
  };

  const deliveryDate = lastDelivery?.deliveredAt
    ?? lastDelivery?.failedAt
    ?? lastDelivery?.startedAt
    ?? lastDelivery?.createdAt;

  return (
    <section className="order-webhook-forwarding" aria-labelledby="order-webhook-forwarding-title">
      <div className="order-webhook-forwarding-heading">
        <div>
          <h3 id="order-webhook-forwarding-title">{t('pages.applications.orderWebhookForwardingTitle')}</h3>
          <p>{t('pages.applications.orderWebhookForwardingSubtitle')}</p>
        </div>
        <label className="order-webhook-forwarding-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={event => {
              setEnabled(event.target.checked);
              setError('');
              setSaved(false);
            }}
          />
          <span aria-hidden="true" />
          <strong>{enabled
            ? t('pages.applications.orderWebhookForwardingEnabled')
            : t('pages.applications.orderWebhookForwardingDisabled')}</strong>
        </label>
      </div>

      <div className="order-webhook-forwarding-notice" role="note">
        <strong>{t('pages.applications.orderWebhookForwardingIndependentTitle')}</strong>
        <span>{t('pages.applications.orderWebhookForwardingIndependentHint')}</span>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <div className="form-group">
          <label className="form-label" htmlFor="order-webhook-forwarding-url">
            {t('pages.applications.orderWebhookForwardingUrl')}
          </label>
          <input
            id="order-webhook-forwarding-url"
            className="form-input"
            type="url"
            inputMode="url"
            placeholder="https://example.com/webhooks/orders"
            value={url}
            onChange={event => {
              setUrl(event.target.value);
              setError('');
              setSaved(false);
            }}
            aria-describedby="order-webhook-forwarding-url-hint"
          />
          <p id="order-webhook-forwarding-url-hint" className="form-hint">
            {t('pages.applications.orderWebhookForwardingUrlHint')}
          </p>
        </div>

        {forwarding.hostname && (
          <p className="order-webhook-forwarding-host">
            {t('pages.applications.orderWebhookForwardingDestination')}: <strong>{forwarding.hostname}</strong>
          </p>
        )}

        {error && <div className="error-banner" role="alert">{error}</div>}
        {saved && <div className="order-webhook-forwarding-success" role="status">{t('pages.applications.orderWebhookForwardingSaved')}</div>}

        <div className="order-webhook-forwarding-actions">
          <button className="btn btn-primary" type="submit" disabled={saving || !dirty}>
            {saving
              ? t('pages.applications.orderWebhookForwardingSaving')
              : t('pages.applications.orderWebhookForwardingSave')}
          </button>
        </div>
      </form>

      <div className="order-webhook-forwarding-delivery" aria-live="polite">
        <h4>{t('pages.applications.orderWebhookForwardingLastDelivery')}</h4>
        {lastDelivery ? (
          <>
            <div className="order-webhook-forwarding-delivery-grid">
              <div>
                <span>{t('pages.applications.orderWebhookForwardingDeliveryStatus')}</span>
                <strong className={`is-${lastDelivery.status}`}>
                  {t(`pages.applications.orderWebhookForwardingDeliveryStatus${lastDelivery.status[0].toUpperCase()}${lastDelivery.status.slice(1)}`)}
                </strong>
              </div>
              <div>
                <span>{t('pages.applications.orderWebhookForwardingDeliveryDate')}</span>
                <strong>{formatDate(deliveryDate)}</strong>
              </div>
              <div>
                <span>{t('pages.applications.orderWebhookForwardingDeliveryHttp')}</span>
                <strong>{lastDelivery.httpStatus ?? '—'}</strong>
              </div>
              <div>
                <span>{t('pages.applications.orderWebhookForwardingDeliveryAttempts')}</span>
                <strong>{lastDelivery.attempts}</strong>
              </div>
            </div>
            {lastDelivery.errorMessage && (
              <div className="order-webhook-forwarding-delivery-error">
                <strong>{t('pages.applications.orderWebhookForwardingDeliveryError')}:</strong>{' '}
                {lastDelivery.errorMessage}
              </div>
            )}
          </>
        ) : (
          <p>{t('pages.applications.orderWebhookForwardingNoDeliveries')}</p>
        )}
      </div>
    </section>
  );
}
