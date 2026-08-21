import { useState, useMemo, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import { integrationsApi, webhooksApi, brandsApi } from '../../api';
import { useLang, useT } from '../../i18n';
import type { AutoOpenCapabilities, AutoOpenPool, AutoOpenExecution, Webhook, Brand, Country } from '../../types';
import AutoOpenPoolStoresExplorer from './AutoOpenPoolStoresExplorer';
import './auto-open.css';

type ApiErr = { response?: { data?: { message?: string | string[] } } };
function errMsg(e: unknown) {
  const msg = (e as ApiErr).response?.data?.message;
  return Array.isArray(msg) ? msg.join(', ') : (msg ?? 'Unexpected error');
}

// ── Timezones ─────────────────────────────────────────────────────────────────
const TIMEZONES = [
  { label: 'Bogotá',       value: 'America/Bogota' },
  { label: 'Mexico City',  value: 'America/Mexico_City' },
  { label: 'Sao Paulo',    value: 'America/Sao_Paulo' },
  { label: 'Tijuana',      value: 'America/Tijuana' },
];

function fmtHour(h: number) {
  return `${String(h).padStart(2, '0')}:00`;
}

const COUNTRIES: Country[] = ['CO', 'MX', 'CR'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

const statusColor: Record<string, string> = {
  pending: 'var(--text-muted)',
  running: 'var(--orange)',
  done:    'var(--green-text)',
  failed:  'var(--red)',
  partial_success: 'var(--amber-text)',
};
const statusBg: Record<string, string> = {
  pending: 'var(--surface-2)',
  running: 'var(--orange-muted)',
  done:    'var(--green-bg)',
  failed:  'var(--red-bg)',
  partial_success: 'var(--amber-bg)',
};

// ── Brand search multi-select ─────────────────────────────────────────────────
interface BrandSearchProps {
  brands: Brand[];
  selected: string[];
  onChange: (ids: string[]) => void;
}

function BrandSearch({ brands, selected, onChange }: BrandSearchProps) {
  const t = useT();
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const lq = q.toLowerCase();
    return lq
      ? brands.filter(b => b.brandName.toLowerCase().includes(lq) || b.brandId.toLowerCase().includes(lq)).slice(0, 50)
      : brands.slice(0, 50);
  }, [brands, q]);

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);

  const removeChip = (id: string) => onChange(selected.filter(x => x !== id));

  const selectedBrands = brands.filter(b => selected.includes(b.id));

  return (
    <div>
      <input
        ref={inputRef}
        className="form-input"
        placeholder={t('pages.integrations.poolStores.searchBrands')}
        value={q}
        onChange={e => setQ(e.target.value)}
        style={{ marginBottom: 8 }}
      />

      {selectedBrands.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {selectedBrands.map(b => (
            <span key={b.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              background: 'var(--orange-muted)', color: 'var(--orange-dark)',
              fontSize: '0.75rem', fontWeight: 600,
              padding: '2px 8px 2px 10px', borderRadius: 999,
            }}>
              {b.brandName}
              <button
                type="button"
                onClick={() => removeChip(b.id)}
                aria-label={t('pages.integrations.poolStores.removeBrand', { brand: b.brandName })}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--orange-dark)', padding: 0, display: 'flex', lineHeight: 1 }}
              >×</button>
            </span>
          ))}
        </div>
      )}

      <div style={{ border: '1px solid var(--border)', borderRadius: 8, maxHeight: 200, overflowY: 'auto' }}>
        {brands.length === 0 ? (
          <div style={{ padding: '10px 12px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>{t('pages.integrations.noBrandsForCountry')}</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '10px 12px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>{t('pages.integrations.poolStores.noBrandResults', { search: q })}</div>
        ) : (
          filtered.map(b => {
            const sel = selected.includes(b.id);
            return (
              <label key={b.id} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', cursor: 'pointer',
                background: sel ? 'rgba(255,105,0,0.06)' : 'transparent',
                borderBottom: '1px solid var(--border)',
              }}>
                <input type="checkbox" checked={sel} onChange={() => toggle(b.id)}
                  style={{ accentColor: 'var(--orange)', width: 14, height: 14, flexShrink: 0 }} />
                <span style={{ fontSize: '0.84rem', fontWeight: sel ? 600 : 400 }}>{b.brandName}</span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>{b.brandId}</span>
              </label>
            );
          })
        )}
      </div>

      {selected.length > 0 && (
        <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 5 }}>
          {t('pages.integrations.poolStores.selectedBrands', { count: String(selected.length) })}
        </p>
      )}
    </div>
  );
}

// ── Hour picker ───────────────────────────────────────────────────────────────
interface HourPickerProps {
  hours: number[];
  onChange: (hours: number[]) => void;
}

function HourPicker({ hours, onChange }: HourPickerProps) {
  const toggle = (localH: number) => {
    const next = hours.includes(localH)
      ? hours.filter(h => h !== localH)
      : [...hours, localH].sort((a, b) => a - b);
    onChange(next);
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {HOURS.map(localH => {
        const sel = hours.includes(localH);
        return (
          <button key={localH} type="button" onClick={() => toggle(localH)}
            aria-pressed={sel}
            style={{
              padding: '3px 8px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600,
              border: '1px solid', cursor: 'pointer',
              background: sel ? 'var(--orange)' : 'transparent',
              borderColor: sel ? 'var(--orange)' : 'var(--border)',
              color: sel ? '#fff' : 'var(--text-primary)',
            }}
          >
            {fmtHour(localH)}
          </button>
        );
      })}
    </div>
  );
}

// ── Form state ────────────────────────────────────────────────────────────────
interface PoolForm {
  name: string;
  country: Country;
  executionHours: number[]; // local hours in selected timezone
  timezone: string;
  dryRun: boolean;
  webhookId: string;
  brandIds: string[];
}

type PoolSavePayload = Omit<PoolForm, 'brandIds' | 'webhookId'> & {
  webhookId?: string;
  brandIds?: string[];
  includeBrandIds?: string[];
  excludeBrandIds?: string[];
};

const EMPTY_FORM: PoolForm = {
  name: '', country: 'CO', executionHours: [],
  timezone: 'America/Mexico_City', dryRun: true, webhookId: '', brandIds: [],
};

// ── Color options for notifications ──────────────────────────────────────────
const NOTIFY_COLORS = [
  { label: 'Azul',    value: '#2D9CDB' },
  { label: 'Verde',   value: '#27AE60' },
  { label: 'Amarillo',value: '#E2B93B' },
  { label: 'Rojo',    value: '#EB5757' },
];

// ── Main page ─────────────────────────────────────────────────────────────────
export default function IntegrationsPage() {
  const t = useT();
  const { lang } = useLang();
  const qc = useQueryClient();

  const [tab, setTab] = useState<'auto-open' | 'notify'>('auto-open');

  const [modalOpen, setModalOpen]       = useState(false);
  const [editingPool, setEditingPool]   = useState<AutoOpenPool | null>(null);
  const [form, setForm]                 = useState<PoolForm>(EMPTY_FORM);
  const [saving, setSaving]             = useState(false);
  const [err, setErr]                   = useState('');
  const [saveNotice, setSaveNotice]     = useState('');
  const [runningId, setRunningId]       = useState<string | null>(null);
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);
  const [deletingId, setDeletingId]     = useState<string | null>(null);
  const autoOpenTabRef = useRef<HTMLButtonElement>(null);
  const notifyTabRef = useRef<HTMLButtonElement>(null);

  // Notify tab state
  const [notifyForm, setNotifyForm] = useState({ title: '', message: '', color: '' });
  const [notifyWebhookIds, setNotifyWebhookIds] = useState<string[]>([]);
  const [sending, setSending]   = useState(false);
  const [notifyErr, setNotifyErr] = useState('');
  const [notifyOk, setNotifyOk]  = useState(false);

  const { data: pools = [], isLoading } = useQuery<AutoOpenPool[]>({
    queryKey: ['auto-open-pools'],
    queryFn: () => integrationsApi.listPools().then(r => r.data as AutoOpenPool[]),
  });

  const { data: autoOpenCapabilities, isError: capabilitiesError } = useQuery<AutoOpenCapabilities>({
    queryKey: ['auto-open-capabilities'],
    queryFn: () => integrationsApi.autoOpenCapabilities().then(r => r.data as AutoOpenCapabilities),
  });
  const liveModeAvailable = autoOpenCapabilities?.liveModeAvailable === true;

  const { data: webhooks = [] } = useQuery<Webhook[]>({
    queryKey: ['webhooks'],
    queryFn: () => webhooksApi.list().then(r => r.data as Webhook[]),
    enabled: modalOpen || tab === 'notify',
  });

  const { data: brandsResult } = useQuery<{ data: Brand[] }>({
    queryKey: ['brands', 'by-country', form.country],
    queryFn: () => brandsApi.list({ country: form.country, limit: 500 }).then(r => r.data as { data: Brand[] }),
    enabled: modalOpen,
  });
  const allBrands = brandsResult?.data ?? [];

  const { data: executionsResult } = useQuery<{ data: AutoOpenExecution[] }>({
    queryKey: ['auto-open-executions', selectedPoolId],
    queryFn: () => integrationsApi.listExecutions(selectedPoolId!).then(r => r.data as { data: AutoOpenExecution[] }),
    enabled: !!selectedPoolId,
  });
  const executions = executionsResult?.data ?? [];

  const filteredBrands = editingPool?.managedKey
    ? allBrands.filter(brand => brand.kaType === 'KA')
    : allBrands;

  const number = useMemo(() => new Intl.NumberFormat(lang === 'es' ? 'es-MX' : 'en-US'), [lang]);
  const poolOverview = useMemo(() => pools.reduce((summary, pool) => {
    summary.brands += pool.brands.length;
    summary.totalStores += pool.storeSummary?.totalStores ?? 0;
    summary.includedStores += pool.storeSummary?.includedStores ?? 0;
    summary.emergencyProtectedStores += pool.storeSummary?.emergencyProtectedStores ?? 0;
    summary.configurationBlockedStores += pool.storeSummary?.configurationBlockedStores ?? 0;
    return summary;
  }, {
    brands: 0,
    totalStores: 0,
    includedStores: 0,
    emergencyProtectedStores: 0,
    configurationBlockedStores: 0,
  }), [pools]);

  const tzLabel = useCallback((tz: string) => TIMEZONES.find(t => t.value === tz)?.label ?? tz, []);

  const openCreate = () => {
    setEditingPool(null);
    setForm(EMPTY_FORM);
    setErr('');
    setSaveNotice('');
    setModalOpen(true);
  };

  const openEdit = (pool: AutoOpenPool) => {
    setEditingPool(pool);
    setForm({
      name: pool.name,
      country: pool.country,
      executionHours: [...pool.executionHours],
      timezone: pool.timezone ?? 'America/Bogota',
      dryRun: pool.dryRun,
      webhookId: pool.webhookId ?? '',
      brandIds: pool.brands.map(b => b.brandId),
    });
    setErr('');
    setSaveNotice('');
    setModalOpen(true);
  };

  const save = async () => {
    setErr(''); setSaving(true);
    try {
      const payload: PoolSavePayload = {
        name: form.name,
        country: form.country,
        executionHours: form.executionHours,
        timezone: form.timezone,
        dryRun: form.dryRun,
        webhookId: form.webhookId || undefined,
      };
      let includedBrands = 0;
      let excludedBrands = 0;

      if (editingPool?.managedKey) {
        const initialBrandIds = new Set(editingPool.brands.map(brand => brand.brandId));
        const desiredBrandIds = new Set(form.brandIds);
        const includeBrandIds = form.brandIds.filter(brandId => !initialBrandIds.has(brandId));
        const excludeBrandIds = [...initialBrandIds].filter(brandId => !desiredBrandIds.has(brandId));
        includedBrands = includeBrandIds.length;
        excludedBrands = excludeBrandIds.length;
        if (includeBrandIds.length > 0) payload.includeBrandIds = includeBrandIds;
        if (excludeBrandIds.length > 0) payload.excludeBrandIds = excludeBrandIds;
      } else if (!editingPool) {
        payload.brandIds = form.brandIds;
      } else {
        const initialBrandIds = new Set(editingPool.brands.map(brand => brand.brandId));
        const membershipChanged = form.brandIds.length !== initialBrandIds.size
          || form.brandIds.some(brandId => !initialBrandIds.has(brandId));
        if (membershipChanged) payload.brandIds = form.brandIds;
      }

      if (editingPool) {
        await integrationsApi.updatePool(editingPool.id, payload);
        await qc.invalidateQueries({ queryKey: ['auto-open-pool-stores', editingPool.id] });
      } else {
        await integrationsApi.createPool(payload);
      }
      await qc.invalidateQueries({ queryKey: ['auto-open-pools'] });
      setSaveNotice(editingPool?.managedKey && (includedBrands > 0 || excludedBrands > 0)
        ? t('pages.integrations.poolStores.managedBrandsSaved', {
          included: String(includedBrands),
          excluded: String(excludedBrands),
        })
        : t('pages.integrations.poolStores.poolSaved'));
      setModalOpen(false);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (pool: AutoOpenPool) => {
    setErr('');
    try {
      await integrationsApi.updatePool(pool.id, { active: !pool.active });
      qc.invalidateQueries({ queryKey: ['auto-open-pools'] });
    } catch (error) {
      setErr(errMsg(error));
    }
  };

  const runNow = async (pool: AutoOpenPool) => {
    setRunningId(pool.id);
    try {
      await integrationsApi.runPool(pool.id);
      setSelectedPoolId(pool.id);
      qc.invalidateQueries({ queryKey: ['auto-open-executions', pool.id] });
    } catch (error) {
      setErr(errMsg(error));
    } finally {
      setRunningId(null);
    }
  };

  const deletePool = async (id: string) => {
    const pool = pools.find(item => item.id === id);
    if (!pool || pool.managedKey || !window.confirm(t('pages.integrations.poolStores.deleteConfirm', { pool: pool.name }))) return;
    setDeletingId(id);
    await integrationsApi.deletePool(id).catch(() => null);
    qc.invalidateQueries({ queryKey: ['auto-open-pools'] });
    if (selectedPoolId === id) setSelectedPoolId(null);
    setDeletingId(null);
  };

  const sendNotification = async () => {
    if (!notifyForm.message.trim() || notifyWebhookIds.length === 0) return;
    setSending(true); setNotifyErr(''); setNotifyOk(false);
    try {
      await integrationsApi.sendNotification({
        title: notifyForm.title.trim() || undefined,
        message: notifyForm.message.trim(),
        webhookIds: notifyWebhookIds,
        color: notifyForm.color || undefined,
      });
      setNotifyOk(true);
      setNotifyForm({ title: '', message: '', color: '' });
      setNotifyWebhookIds([]);
      setTimeout(() => setNotifyOk(false), 4000);
    } catch (e) {
      setNotifyErr(errMsg(e));
    } finally {
      setSending(false);
    }
  };

  const formatPoolHours = (pool: AutoOpenPool) => {
    if (!pool.executionHours.length) return '—';
    const tz = pool.timezone ?? 'UTC';
    return pool.executionHours
      .map(fmtHour)
      .join(', ') + ` (${tzLabel(tz)})`;
  };

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.integrations') }]} />
      <main className="main-content auto-open-page">
        <div className="page-header auto-open-page-header">
          <div className="page-header-info">
            <h1>{t('nav.integrations')}</h1>
            <p>{t('pages.integrations.subtitle')}</p>
          </div>
          {tab === 'auto-open' && (
            <button className="btn btn-primary" onClick={openCreate}>
              + {t('pages.integrations.newPool')}
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="tabs auto-open-tabs" role="tablist" aria-label={t('pages.integrations.tabsLabel')}>
          <button
            type="button"
            ref={autoOpenTabRef}
            id="auto-open-tab"
            className={`tab ${tab === 'auto-open' ? 'active' : ''}`}
            role="tab"
            aria-selected={tab === 'auto-open'}
            aria-controls="auto-open-panel"
            tabIndex={tab === 'auto-open' ? 0 : -1}
            onClick={() => setTab('auto-open')}
            onKeyDown={event => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              setTab('notify');
              notifyTabRef.current?.focus();
            }}
          >
            {t('nav.autoOpenStores')}
          </button>
          <button
            type="button"
            ref={notifyTabRef}
            id="auto-open-notify-tab"
            className={`tab ${tab === 'notify' ? 'active' : ''}`}
            role="tab"
            aria-selected={tab === 'notify'}
            aria-controls="auto-open-notify-panel"
            tabIndex={tab === 'notify' ? 0 : -1}
            onClick={() => setTab('notify')}
            onKeyDown={event => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              setTab('auto-open');
              autoOpenTabRef.current?.focus();
            }}
          >
            {t('pages.integrations.tabNotify')}
          </button>
        </div>

        {/* ── Auto Open tab ─────────────────────────────────────────────── */}
        {tab === 'auto-open' && (<section id="auto-open-panel" role="tabpanel" aria-labelledby="auto-open-tab">
        {isLoading && <p className="text-muted" role="status">{t('pages.integrations.poolStores.loadingPools')}</p>}
        {err && !modalOpen && <div className="error-banner" style={{ marginBottom: 12 }}>{err}</div>}
        {saveNotice && !modalOpen && (
          <div className="auto-open-save-notice" role="status">
            {saveNotice}
            <button type="button" onClick={() => setSaveNotice('')} aria-label={t('common.close')}>×</button>
          </div>
        )}
        <div className={`auto-open-live-banner ${liveModeAvailable ? 'available' : 'blocked'}`}>
          <strong>{liveModeAvailable
            ? t('pages.integrations.poolStores.liveReady')
            : t('pages.integrations.poolStores.liveBlocked')}</strong>{' '}
          {capabilitiesError
            ? t('pages.integrations.poolStores.capabilitiesError')
            : autoOpenCapabilities
              ? (liveModeAvailable
                ? t('pages.integrations.poolStores.liveReadyDetail')
                : t('pages.integrations.poolStores.liveBlockedDetail'))
              : t('pages.integrations.poolStores.checkingCapabilities')}
        </div>

        {!isLoading && pools.length > 0 && (
          <div className="auto-open-overview" aria-label={t('pages.integrations.poolStores.overviewLabel')}>
            <div><span>{t('pages.integrations.poolStores.pools')}</span><strong>{number.format(pools.length)}</strong></div>
            <div><span>{t('pages.integrations.poolStores.brands')}</span><strong>{number.format(poolOverview.brands)}</strong></div>
            <div><span>{t('pages.integrations.poolStores.totalStores')}</span><strong>{number.format(poolOverview.totalStores)}</strong></div>
            <div><span>{t('pages.integrations.poolStores.includedPlural')}</span><strong>{number.format(poolOverview.includedStores)}</strong></div>
            <div className="protected"><span>{t('pages.integrations.poolStores.protectedPlural')}</span><strong>{number.format(poolOverview.emergencyProtectedStores)}</strong></div>
            <div className="configuration"><span>{t('pages.integrations.poolStores.configurationIssues')}</span><strong>{number.format(poolOverview.configurationBlockedStores)}</strong></div>
          </div>
        )}

        <div className="auto-open-pools">
          {pools.map(pool => {
            const storeSummary = pool.storeSummary ?? {
              totalStores: 0,
              includedStores: 0,
              emergencyProtectedStores: 0,
              configurationBlockedStores: 0,
            };
            const historyRegionId = `auto-open-history-${pool.id}`;
            return (
            <article key={pool.id} className="card auto-open-pool-card">
              <div className="auto-open-pool-card-main">
                <div>
                  <div className="auto-open-pool-heading">
                    <h2>{pool.name}</h2>
                    <button
                      type="button"
                      className={`auto-open-pool-pill ${pool.active ? 'active' : 'inactive'}`}
                      aria-pressed={pool.active}
                      aria-label={t('pages.integrations.poolStores.togglePoolLabel', { pool: pool.name })}
                      onClick={() => toggleActive(pool)}
                    >
                    {pool.active ? t('common.active') : t('common.inactive')}
                  </button>
                    <span className="auto-open-pool-pill country">{pool.country}</span>
                    <span className={`auto-open-pool-pill ${pool.dryRun ? 'dry-run' : 'live'}`}>
                    {pool.dryRun ? 'DRY RUN' : 'LIVE'}
                  </span>
                    {pool.managedKey && <span className="auto-open-pool-system">{t('pages.integrations.poolStores.managedPool')}</span>}
                  </div>
                  <p className="auto-open-pool-schedule">
                    {t('pages.integrations.poolStores.schedule')}: {pool.executionHours.length ? formatPoolHours(pool) : '—'}
                  </p>
                </div>
                <div className="auto-open-pool-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm auto-open-history-action"
                    aria-expanded={selectedPoolId === pool.id}
                    aria-controls={historyRegionId}
                    aria-label={t('pages.integrations.poolStores.historyLabel', { pool: pool.name })}
                    onClick={() => setSelectedPoolId(selectedPoolId === pool.id ? null : pool.id)}
                  >
                    {selectedPoolId === pool.id ? t('pages.integrations.hideHistory') : t('pages.integrations.viewHistory')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm auto-open-run-action"
                    disabled={runningId === pool.id || (!pool.dryRun && !liveModeAvailable)}
                    title={!pool.dryRun && !liveModeAvailable ? t('pages.integrations.poolStores.liveRunDisabled') : undefined}
                    aria-label={t('pages.integrations.poolStores.runLabel', { pool: pool.name })}
                    onClick={() => runNow(pool)}
                  >
                    {runningId === pool.id ? t('pages.integrations.running') : t('pages.integrations.runNow')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm auto-open-icon-action"
                    aria-label={t('pages.integrations.poolStores.editLabel', { pool: pool.name })}
                    title={t('common.edit')}
                    onClick={() => openEdit(pool)}
                  >✎</button>
                  {!pool.managedKey && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm auto-open-icon-action"
                      style={{ color: 'var(--red)' }}
                      aria-label={t('pages.integrations.poolStores.deleteLabel', { pool: pool.name })}
                      title={t('common.delete')}
                      disabled={deletingId === pool.id}
                      onClick={() => deletePool(pool.id)}
                    >×</button>
                  )}
                </div>
              </div>

              <div className="auto-open-pool-metrics" aria-label={t('pages.integrations.poolStores.poolSummaryLabel', { pool: pool.name })}>
                <div className="auto-open-pool-metric"><span>{t('pages.integrations.poolStores.brands')}</span><strong>{number.format(pool.brands.length)}</strong></div>
                <div className="auto-open-pool-metric"><span>{t('pages.integrations.poolStores.totalStores')}</span><strong>{number.format(storeSummary.totalStores)}</strong></div>
                <div className="auto-open-pool-metric"><span>{t('pages.integrations.poolStores.includedPlural')}</span><strong>{number.format(storeSummary.includedStores)}</strong></div>
                <div className="auto-open-pool-metric protected"><span>{t('pages.integrations.poolStores.protectedPlural')}</span><strong>{number.format(storeSummary.emergencyProtectedStores)}</strong></div>
                <div className="auto-open-pool-metric configuration"><span>{t('pages.integrations.poolStores.configurationIssues')}</span><strong>{number.format(storeSummary.configurationBlockedStores)}</strong></div>
              </div>

              <AutoOpenPoolStoresExplorer
                key={`${pool.id}:${pool.brands.map(membership => membership.brandId).sort().join('|')}`}
                pool={pool}
              />

              {selectedPoolId === pool.id && (
                <div id={historyRegionId} className="auto-open-history">
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                    {t('pages.integrations.executionHistory')}
                  </div>
                  {executions.length === 0 ? (
                    <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{t('pages.integrations.noExecutions')}</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {executions.map(ex => <ExecutionRow key={ex.id} execution={ex} t={t} />)}
                    </div>
                  )}
                </div>
              )}
            </article>
          );})}
        </div>

        {!isLoading && pools.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
            <p style={{ fontSize: '0.9rem' }}>{t('pages.integrations.noPools')}</p>
          </div>
        )}
        </section>)}

        {/* ── Notify tab ────────────────────────────────────────────────── */}
        {tab === 'notify' && (
          <section id="auto-open-notify-panel" role="tabpanel" aria-labelledby="auto-open-notify-tab" style={{ maxWidth: 640 }}>
            <p style={{ fontSize: '0.84rem', color: 'var(--text-muted)', marginBottom: 20 }}>
              {t('pages.integrations.notifySubtitle')}
            </p>

            {notifyErr && <div className="error-banner" style={{ marginBottom: 16 }}>{notifyErr}</div>}
            {notifyOk && (
              <div style={{ background: 'var(--green-bg)', color: 'var(--green-text)', borderRadius: 8, padding: '10px 14px', fontSize: '0.84rem', fontWeight: 600, marginBottom: 16 }}>
                ✓ {t('pages.integrations.notifySent')}
              </div>
            )}

            <div className="form-group">
              <label className="form-label">{t('pages.integrations.notifyTitle')}</label>
              <input
                className="form-input"
                placeholder={t('pages.integrations.notifyTitlePlaceholder')}
                value={notifyForm.title}
                onChange={e => setNotifyForm(f => ({ ...f, title: e.target.value }))}
              />
            </div>

            <div className="form-group">
              <label className="form-label">{t('pages.integrations.notifyMessage')} *</label>
              <textarea
                className="form-input"
                rows={5}
                placeholder={t('pages.integrations.notifyMessagePlaceholder')}
                value={notifyForm.message}
                onChange={e => setNotifyForm(f => ({ ...f, message: e.target.value }))}
                style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: '0.84rem' }}
              />
            </div>

            <div className="form-group">
              <label className="form-label">{t('pages.integrations.notifyColor')}</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => setNotifyForm(f => ({ ...f, color: '' }))}
                  style={{
                    padding: '5px 12px', borderRadius: 6, fontSize: '0.8rem', cursor: 'pointer',
                    border: '1px solid', fontWeight: notifyForm.color === '' ? 700 : 400,
                    background: notifyForm.color === '' ? 'var(--surface-2)' : 'transparent',
                    borderColor: notifyForm.color === '' ? 'var(--text-primary)' : 'var(--border)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {t('pages.integrations.notifyColorNone')}
                </button>
                {NOTIFY_COLORS.map(c => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setNotifyForm(f => ({ ...f, color: c.value }))}
                    style={{
                      padding: '5px 14px', borderRadius: 6, fontSize: '0.8rem', cursor: 'pointer',
                      border: `2px solid ${c.value}`,
                      background: notifyForm.color === c.value ? c.value : 'transparent',
                      color: notifyForm.color === c.value ? '#fff' : c.value,
                      fontWeight: 600,
                    }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">{t('pages.integrations.notifyWebhooks')} *</label>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                {webhooks.filter(w => !w.isAlerts).length === 0 ? (
                  <div style={{ padding: '12px 14px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                    {t('pages.integrations.notifyNoWebhooks')}
                  </div>
                ) : (
                  webhooks.filter(w => !w.isAlerts).map(w => {
                    const sel = notifyWebhookIds.includes(w.id);
                    return (
                      <label key={w.id} style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                        cursor: 'pointer', borderBottom: '1px solid var(--border)',
                        background: sel ? 'rgba(255,105,0,0.05)' : 'transparent',
                      }}>
                        <input
                          type="checkbox"
                          checked={sel}
                          onChange={() => setNotifyWebhookIds(ids =>
                            sel ? ids.filter(id => id !== w.id) : [...ids, w.id]
                          )}
                          style={{ accentColor: 'var(--orange)', width: 15, height: 15, flexShrink: 0 }}
                        />
                        <span style={{ fontSize: '0.86rem', fontWeight: sel ? 600 : 400 }}>{w.name}</span>
                      </label>
                    );
                  })
                )}
              </div>
            </div>

            <button
              className="btn btn-primary"
              disabled={sending || !notifyForm.message.trim() || notifyWebhookIds.length === 0}
              onClick={sendNotification}
              style={{ marginTop: 4 }}
            >
              {sending ? t('pages.integrations.notifySending') : t('pages.integrations.notifySendBtn')}
            </button>
          </section>
        )}
      </main>

      {modalOpen && (
        <Modal
          title={editingPool ? t('pages.integrations.editPool') : t('pages.integrations.newPool')}
          onClose={() => setModalOpen(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModalOpen(false)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={save} disabled={saving || !form.name}>
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </>
          }
        >
          {err && <div className="error-banner" style={{ marginBottom: 12 }}>{err}</div>}

          <div className="form-group">
            <label className="form-label">{t('pages.integrations.poolName')}</label>
            <input className="form-input" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label className="form-label">{t('pages.integrations.poolStores.country')}</label>
              <select className="form-select" value={form.country}
                disabled={!!editingPool?.managedKey}
                onChange={e => setForm(f => ({ ...f, country: e.target.value as Country, brandIds: [] }))}>
                {COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">{t('pages.integrations.timezone')}</label>
              <select className="form-select" value={form.timezone}
                onChange={e => setForm(f => ({ ...f, timezone: e.target.value, executionHours: [] }))}>
                {TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
              </select>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">
              {t('pages.integrations.executionHours')}
              {form.timezone && (
                <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.78rem', marginLeft: 6 }}>
                  ({tzLabel(form.timezone)})
                </span>
              )}
            </label>
            <HourPicker hours={form.executionHours} onChange={h => setForm(f => ({ ...f, executionHours: h }))} />
            {form.executionHours.length > 0 && (
              <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 5 }}>
                {t('pages.integrations.poolStores.localSchedule')}: {form.executionHours.map(fmtHour).join(', ')}
              </p>
            )}
          </div>

          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.dryRun}
                disabled={form.dryRun && !liveModeAvailable}
                onChange={event => setForm(value => ({ ...value, dryRun: event.target.checked }))}
                style={{ marginTop: 3, accentColor: 'var(--orange)' }}
              />
              <span>
                <strong>{t('pages.integrations.poolStores.dryRunMode')}</strong>
                <span style={{ display: 'block', fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  {t('pages.integrations.poolStores.dryRunHelp')}
                </span>
              </span>
            </label>
            {form.dryRun && !liveModeAvailable && (
              <p className="form-hint" style={{ color: 'var(--red-text)' }}>
                {t('pages.integrations.poolStores.dryRunLocked')}
              </p>
            )}
            {!form.dryRun && (
              <div className="error-banner" style={{ marginTop: 10 }}>
                {t('pages.integrations.poolStores.liveWarning')}
              </div>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">
              {t('pages.integrations.webhook')}
              <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.78rem', marginLeft: 4 }}>({t('common.optional')})</span>
            </label>
            <select className="form-select" value={form.webhookId}
              onChange={e => setForm(f => ({ ...f, webhookId: e.target.value }))}>
              <option value="">{t('pages.integrations.noWebhook')}</option>
              {webhooks.filter(w => !w.isAlerts).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">
              {t('pages.integrations.poolStores.brands')}
              <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.78rem', marginLeft: 4 }}>
                ({filteredBrands.length} {t('pages.integrations.availableInCountry')})
              </span>
            </label>
            <BrandSearch
              brands={filteredBrands}
              selected={form.brandIds}
              onChange={ids => setForm(f => ({ ...f, brandIds: ids }))}
            />
            {editingPool?.managedKey && (
              <p className="form-hint">{t('pages.integrations.poolStores.managedBrandsHelp')}</p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

function ExecutionRow({ execution, t }: { execution: AutoOpenExecution; t: (k: string) => string }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = `auto-open-execution-detail-${execution.id}`;
  const detailBrands = execution.brandRuns?.length
    ? execution.brandRuns.map(run => ({
      brandName: run.brandName,
      shopsProcessed: run.shopsProcessed,
      shopsOpened: run.shopsOpened,
      shopsWouldOpen: run.shopsWouldOpen,
      shopsSkippedEmergency: run.shopsSkippedEmergency,
      shopsFailed: run.shopsFailed,
      error: run.errorMessage,
      shopErrors: run.shopErrors,
      status: run.status,
    }))
    : (execution.logs?.brands ?? []).map(run => ({ ...run, status: run.error ? 'failed' : 'done' }));
  const hasDetails = detailBrands.length > 0;
  const dur = execution.startedAt && execution.finishedAt
    ? Math.round((new Date(execution.finishedAt).getTime() - new Date(execution.startedAt).getTime()) / 1000)
    : null;

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      <button
        type="button"
        className="auto-open-execution-summary"
        onClick={() => hasDetails && setExpanded(e => !e)}
        disabled={!hasDetails}
        aria-expanded={hasDetails ? expanded : undefined}
        aria-controls={hasDetails ? detailId : undefined}
        aria-label={hasDetails ? t('pages.integrations.poolStores.executionDetailsLabel') : undefined}
      >
        <span style={{
          fontSize: '0.68rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, flexShrink: 0,
          background: statusBg[execution.status], color: statusColor[execution.status],
        }}>
          {execution.status}
        </span>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', flexShrink: 0 }}>
          {new Date(execution.createdAt).toLocaleString()}
        </span>
        <span style={{ fontSize: '0.68rem', fontWeight: 700, color: execution.dryRun ? 'var(--blue-text)' : 'var(--red-text)' }}>
          {execution.dryRun ? 'DRY RUN' : 'LIVE'}
        </span>
        {execution.status === 'running' && execution.totalBrands > 0 && (
          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--blue-text)' }}>
            {execution.progressPercent}% · {execution.brandsCompleted}/{execution.totalBrands} marcas
            {execution.currentBrand ? ` · ${execution.currentBrand}` : ''}
          </span>
        )}
        {['done', 'partial_success'].includes(execution.status) && (
          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--green-text)' }}>
            {execution.dryRun
              ? `${execution.shopsWouldOpen}/${execution.totalShops} abriría`
              : `${execution.shopsOpened}/${execution.totalShops} ${t('pages.integrations.shopsOpened')}`}
            {execution.shopsSkippedEmergency > 0 ? ` · ${execution.shopsSkippedEmergency} protegidas` : ''}
            {execution.shopsFailed > 0 ? ` · ${execution.shopsFailed} fallidas` : ''}
          </span>
        )}
        {execution.status === 'failed' && execution.errorMessage && (
          <span style={{ fontSize: '0.78rem', color: 'var(--red)' }}>{execution.errorMessage}</span>
        )}
        {dur !== null && (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>{dur}s</span>
        )}
        {hasDetails && (
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
        )}
      </button>
      {expanded && hasDetails && (
        <div id={detailId} style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {detailBrands.map((b, i) => (
            <div key={i} style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', flexWrap: 'wrap' }}>
                <span style={{ color: b.error ? 'var(--red-text)' : b.status === 'running' ? 'var(--blue-text)' : 'var(--green-text)', fontWeight: 700, flexShrink: 0 }}>
                  {b.error ? '✗' : b.status === 'running' ? '…' : '✓'}
                </span>
                <span style={{ fontWeight: 500 }}>{b.brandName}</span>
                {b.error
                  ? <span style={{ color: 'var(--red)', fontSize: '0.75rem' }}>{b.error}</span>
                  : <span style={{ color: 'var(--text-muted)' }}>
                    {execution.dryRun ? `${b.shopsWouldOpen}/${b.shopsProcessed} abriría` : `${b.shopsOpened}/${b.shopsProcessed} abiertas`}
                    {b.shopsSkippedEmergency > 0 ? ` · ${b.shopsSkippedEmergency} protegidas` : ''}
                    {(b.shopsFailed ?? 0) > 0 ? ` · ${b.shopsFailed} fallidas` : ''}
                  </span>
                }
              </div>
              {b.shopErrors?.slice(0, 5).map((shopError, index) => (
                <div key={`${shopError.shopId}-${index}`} style={{ marginLeft: 24, color: 'var(--red)', fontSize: '0.72rem' }}>
                  {shopError.shopId}: {shopError.error}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
