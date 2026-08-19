import { useState, useMemo, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import { integrationsApi, webhooksApi, brandsApi } from '../../api';
import { useT } from '../../i18n';
import type { AutoOpenPool, AutoOpenExecution, Webhook, Brand, Country } from '../../types';

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
  done:    '#027A48',
  failed:  'var(--red)',
  partial_success: '#B54708',
};
const statusBg: Record<string, string> = {
  pending: 'var(--surface-2)',
  running: 'var(--orange-muted)',
  done:    'var(--green-bg)',
  failed:  'rgba(220,53,69,0.1)',
  partial_success: '#FFFAEB',
};

// ── Brand search multi-select ─────────────────────────────────────────────────
interface BrandSearchProps {
  brands: Brand[];
  selected: string[];
  onChange: (ids: string[]) => void;
}

function BrandSearch({ brands, selected, onChange }: BrandSearchProps) {
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
        placeholder="Search brands…"
        value={q}
        onChange={e => setQ(e.target.value)}
        style={{ marginBottom: 8 }}
      />

      {selectedBrands.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {selectedBrands.map(b => (
            <span key={b.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              background: 'var(--orange-muted)', color: 'var(--orange)',
              fontSize: '0.75rem', fontWeight: 600,
              padding: '2px 8px 2px 10px', borderRadius: 999,
            }}>
              {b.brandName}
              <button
                type="button"
                onClick={() => removeChip(b.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--orange)', padding: 0, display: 'flex', lineHeight: 1 }}
              >×</button>
            </span>
          ))}
        </div>
      )}

      <div style={{ border: '1px solid var(--border)', borderRadius: 8, maxHeight: 200, overflowY: 'auto' }}>
        {brands.length === 0 ? (
          <div style={{ padding: '10px 12px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>No brands for this country.</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '10px 12px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>No results for "{q}"</div>
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
          {selected.length} brand{selected.length > 1 ? 's' : ''} selected
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
  const qc = useQueryClient();

  const [tab, setTab] = useState<'auto-open' | 'notify'>('auto-open');

  const [modalOpen, setModalOpen]       = useState(false);
  const [editingPool, setEditingPool]   = useState<AutoOpenPool | null>(null);
  const [form, setForm]                 = useState<PoolForm>(EMPTY_FORM);
  const [saving, setSaving]             = useState(false);
  const [err, setErr]                   = useState('');
  const [runningId, setRunningId]       = useState<string | null>(null);
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);
  const [deletingId, setDeletingId]     = useState<string | null>(null);

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

  const filteredBrands = allBrands;

  const tzLabel = useCallback((tz: string) => TIMEZONES.find(t => t.value === tz)?.label ?? tz, []);

  const openCreate = () => {
    setEditingPool(null);
    setForm(EMPTY_FORM);
    setErr('');
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
    setModalOpen(true);
  };

  const save = async () => {
    setErr(''); setSaving(true);
    try {
      const payload = {
        name: form.name,
        country: form.country,
        executionHours: form.executionHours,
        timezone: form.timezone,
        dryRun: form.dryRun,
        webhookId: form.webhookId || undefined,
        brandIds: form.brandIds,
      };
      if (editingPool) {
        await integrationsApi.updatePool(editingPool.id, payload);
      } else {
        await integrationsApi.createPool(payload);
      }
      qc.invalidateQueries({ queryKey: ['auto-open-pools'] });
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
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{t('nav.integrations')}</h1>
          </div>
          {tab === 'auto-open' && (
            <button className="btn btn-primary" onClick={openCreate}>
              + {t('pages.integrations.newPool')}
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="tabs" style={{ marginBottom: 20 }}>
          <div className={`tab ${tab === 'auto-open' ? 'active' : ''}`} onClick={() => setTab('auto-open')}>
            {t('nav.autoOpenStores')}
          </div>
          <div className={`tab ${tab === 'notify' ? 'active' : ''}`} onClick={() => setTab('notify')}>
            {t('pages.integrations.tabNotify')}
          </div>
        </div>

        {/* ── Auto Open tab ─────────────────────────────────────────────── */}
        {tab === 'auto-open' && (<>
        {isLoading && <p style={{ color: 'var(--text-muted)', fontSize: '0.84rem' }}>Loading…</p>}
        {err && !modalOpen && <div className="error-banner" style={{ marginBottom: 12 }}>{err}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {pools.map(pool => (
            <div key={pool.id} className="card" style={{ padding: '16px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                  <button onClick={() => toggleActive(pool)} style={{
                    fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                    border: 'none', cursor: 'pointer', flexShrink: 0,
                    background: pool.active ? 'var(--green-bg)' : 'var(--surface-2)',
                    color: pool.active ? '#027A48' : 'var(--text-muted)',
                  }}>
                    {pool.active ? t('common.active') : t('common.inactive')}
                  </button>
                  <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>{pool.name}</span>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-secondary)', flexShrink: 0 }}>
                    {pool.country}
                  </span>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                    {pool.brands.length} brands
                  </span>
                  <span style={{
                    fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                    background: pool.dryRun ? '#EAF4FF' : '#FFF0EC',
                    color: pool.dryRun ? '#175CD3' : '#B42318',
                  }}>
                    {pool.dryRun ? 'DRY RUN' : 'LIVE'}
                  </span>
                  {pool.managedKey && <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>KA · system pool</span>}
                  {pool.executionHours.length > 0 && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                      🕐 {formatPoolHours(pool)}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button className="btn btn-ghost btn-sm" style={{ padding: '4px 10px' }}
                    onClick={() => setSelectedPoolId(selectedPoolId === pool.id ? null : pool.id)}>
                    {selectedPoolId === pool.id ? t('pages.integrations.hideHistory') : t('pages.integrations.viewHistory')}
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    style={{ padding: '4px 12px', opacity: runningId === pool.id ? 0.6 : 1 }}
                    disabled={runningId === pool.id}
                    onClick={() => runNow(pool)}
                  >
                    {runningId === pool.id ? t('pages.integrations.running') : t('pages.integrations.runNow')}
                  </button>
                  <button className="btn btn-ghost btn-sm" style={{ padding: '4px 8px' }} onClick={() => openEdit(pool)}>✎</button>
                  <button className="btn btn-ghost btn-sm"
                    style={{ padding: '4px 8px', color: 'var(--red)', opacity: deletingId === pool.id ? 0.5 : 1 }}
                    disabled={deletingId === pool.id}
                    onClick={() => deletePool(pool.id)}>×</button>
                </div>
              </div>

              {selectedPoolId === pool.id && (
                <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
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
            </div>
          ))}
        </div>

        {!isLoading && pools.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
            <p style={{ fontSize: '0.9rem' }}>{t('pages.integrations.noPools')}</p>
          </div>
        )}
        </>)}

        {/* ── Notify tab ────────────────────────────────────────────────── */}
        {tab === 'notify' && (
          <div style={{ maxWidth: 640 }}>
            <p style={{ fontSize: '0.84rem', color: 'var(--text-muted)', marginBottom: 20 }}>
              {t('pages.integrations.notifySubtitle')}
            </p>

            {notifyErr && <div className="error-banner" style={{ marginBottom: 16 }}>{notifyErr}</div>}
            {notifyOk && (
              <div style={{ background: 'var(--green-bg)', color: '#027A48', borderRadius: 8, padding: '10px 14px', fontSize: '0.84rem', fontWeight: 600, marginBottom: 16 }}>
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
          </div>
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
              <label className="form-label">Country</label>
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
                Horario local: {form.executionHours.map(fmtHour).join(', ')}
              </p>
            )}
          </div>

          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.dryRun}
                onChange={event => setForm(value => ({ ...value, dryRun: event.target.checked }))}
                style={{ marginTop: 3, accentColor: 'var(--orange)' }}
              />
              <span>
                <strong>Modo simulación (recomendado)</strong>
                <span style={{ display: 'block', fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  Consulta el estado real y muestra cuántas tiendas abriría, pero nunca envía el POST de apertura.
                </span>
              </span>
            </label>
            {!form.dryRun && (
              <div className="error-banner" style={{ marginTop: 10 }}>
                Modo LIVE: esta configuración puede abrir tiendas reales. El servidor también debe tener habilitada la barrera de escrituras remotas.
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
              Brands
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
              <p className="form-hint">Las marcas KA activas de este país se sincronizan automáticamente.</p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

function ExecutionRow({ execution, t }: { execution: AutoOpenExecution; t: (k: string) => string }) {
  const [expanded, setExpanded] = useState(false);
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
      <div
        onClick={() => hasDetails && setExpanded(e => !e)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', cursor: hasDetails ? 'pointer' : 'default', background: 'var(--surface-2)', flexWrap: 'wrap' }}
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
        <span style={{ fontSize: '0.68rem', fontWeight: 700, color: execution.dryRun ? '#175CD3' : '#B42318' }}>
          {execution.dryRun ? 'DRY RUN' : 'LIVE'}
        </span>
        {execution.status === 'running' && execution.totalBrands > 0 && (
          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#175CD3' }}>
            {execution.progressPercent}% · {execution.brandsCompleted}/{execution.totalBrands} marcas
            {execution.currentBrand ? ` · ${execution.currentBrand}` : ''}
          </span>
        )}
        {['done', 'partial_success'].includes(execution.status) && (
          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#027A48' }}>
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
      </div>
      {expanded && hasDetails && (
        <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {detailBrands.map((b, i) => (
            <div key={i} style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', flexWrap: 'wrap' }}>
                <span style={{ color: b.error ? 'var(--red)' : b.status === 'running' ? '#175CD3' : '#027A48', fontWeight: 700, flexShrink: 0 }}>
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
