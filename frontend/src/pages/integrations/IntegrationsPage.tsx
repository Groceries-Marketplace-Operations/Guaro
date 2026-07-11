import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import { integrationsApi, webhooksApi } from '../../api';
import { brandsApi } from '../../api';
import { useT } from '../../i18n';
import type { AutoOpenPool, AutoOpenExecution, Webhook, Brand, Country } from '../../types';

type ApiErr = { response?: { data?: { message?: string | string[] } } };
function errMsg(e: unknown) {
  const msg = (e as ApiErr).response?.data?.message;
  return Array.isArray(msg) ? msg.join(', ') : (msg ?? 'Unexpected error');
}

const COUNTRIES: Country[] = ['CO', 'MX', 'CR'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

const statusColor: Record<string, string> = {
  pending:  'var(--text-muted)',
  running:  'var(--orange)',
  done:     '#027A48',
  failed:   'var(--red)',
};
const statusBg: Record<string, string> = {
  pending:  'var(--surface-2)',
  running:  'var(--orange-muted)',
  done:     'var(--green-bg)',
  failed:   'rgba(220,53,69,0.1)',
};

interface PoolForm {
  name: string;
  country: Country;
  executionHours: number[];
  webhookId: string;
  brandIds: string[];
}

const EMPTY_FORM: PoolForm = { name: '', country: 'CO', executionHours: [], webhookId: '', brandIds: [] };

export default function IntegrationsPage() {
  const t = useT();
  const qc = useQueryClient();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingPool, setEditingPool] = useState<AutoOpenPool | null>(null);
  const [form, setForm] = useState<PoolForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [runningId, setRunningId] = useState<string | null>(null);
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: pools = [], isLoading } = useQuery<AutoOpenPool[]>({
    queryKey: ['auto-open-pools'],
    queryFn: () => integrationsApi.listPools().then(r => r.data as AutoOpenPool[]),
  });

  const { data: webhooks = [] } = useQuery<Webhook[]>({
    queryKey: ['webhooks'],
    queryFn: () => webhooksApi.list().then(r => r.data as Webhook[]),
    enabled: modalOpen,
  });

  const { data: brandsResult } = useQuery<{ data: Brand[] }>({
    queryKey: ['brands', 'all-for-integration'],
    queryFn: () => brandsApi.list({ limit: 500 }).then(r => r.data as { data: Brand[] }),
    enabled: modalOpen,
  });
  const allBrands = brandsResult?.data ?? [];

  const { data: executionsResult } = useQuery<{ data: AutoOpenExecution[]; total: number }>({
    queryKey: ['auto-open-executions', selectedPoolId],
    queryFn: () => integrationsApi.listExecutions(selectedPoolId!).then(r => r.data as { data: AutoOpenExecution[]; total: number }),
    enabled: !!selectedPoolId,
  });
  const executions = executionsResult?.data ?? [];

  const filteredBrands = useMemo(
    () => allBrands.filter(b => b.country === form.country),
    [allBrands, form.country],
  );

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
      webhookId: pool.webhookId ?? '',
      brandIds: pool.brands.map(b => b.brandId),
    });
    setErr('');
    setModalOpen(true);
  };

  const toggleHour = (h: number) => {
    setForm(f => ({
      ...f,
      executionHours: f.executionHours.includes(h)
        ? f.executionHours.filter(x => x !== h)
        : [...f.executionHours, h].sort((a, b) => a - b),
    }));
  };

  const toggleBrand = (id: string) => {
    setForm(f => ({
      ...f,
      brandIds: f.brandIds.includes(id) ? f.brandIds.filter(x => x !== id) : [...f.brandIds, id],
    }));
  };

  const save = async () => {
    setErr(''); setSaving(true);
    try {
      const payload = {
        name: form.name,
        country: form.country,
        executionHours: form.executionHours,
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
    try {
      await integrationsApi.updatePool(pool.id, { active: !pool.active });
      qc.invalidateQueries({ queryKey: ['auto-open-pools'] });
    } catch { /* ignore */ }
  };

  const runNow = async (pool: AutoOpenPool) => {
    setRunningId(pool.id);
    try {
      await integrationsApi.runPool(pool.id);
      qc.invalidateQueries({ queryKey: ['auto-open-executions', pool.id] });
      setSelectedPoolId(pool.id);
    } catch { /* ignore */ }
    finally { setRunningId(null); }
  };

  const deletePool = async (id: string) => {
    setDeletingId(id);
    try {
      await integrationsApi.deletePool(id);
      qc.invalidateQueries({ queryKey: ['auto-open-pools'] });
      if (selectedPoolId === id) setSelectedPoolId(null);
    } catch { /* ignore */ }
    finally { setDeletingId(null); }
  };

  const formatHour = (h: number) => `${String(h).padStart(2, '0')}:00`;

  const selectedPool = pools.find(p => p.id === selectedPoolId);

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.integrations') }, { label: t('nav.autoOpenStores') }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{t('nav.autoOpenStores')}</h1>
            <p style={{ fontSize: '0.84rem', color: 'var(--text-muted)' }}>
              {t('pages.integrations.subtitle')}
            </p>
          </div>
          <button className="btn btn-primary" onClick={openCreate}>
            + {t('pages.integrations.newPool')}
          </button>
        </div>

        {isLoading && <p style={{ color: 'var(--text-muted)', fontSize: '0.84rem' }}>Loading…</p>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {pools.map(pool => (
            <div key={pool.id} className="card" style={{ padding: '16px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                  <button
                    onClick={() => toggleActive(pool)}
                    style={{
                      fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                      border: 'none', cursor: 'pointer', flexShrink: 0,
                      background: pool.active ? 'var(--green-bg)' : 'var(--surface-2)',
                      color: pool.active ? '#027A48' : 'var(--text-muted)',
                    }}
                  >
                    {pool.active ? t('common.active') : t('common.inactive')}
                  </button>
                  <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>{pool.name}</span>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-secondary)', flexShrink: 0 }}>
                    {pool.country}
                  </span>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                    {pool.brands.length} {t('common.brands')}
                  </span>
                  {pool.executionHours.length > 0 && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                      🕐 {pool.executionHours.map(formatHour).join(', ')} UTC
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ padding: '4px 10px' }}
                    onClick={() => setSelectedPoolId(selectedPoolId === pool.id ? null : pool.id)}
                  >
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
                  <button className="btn btn-ghost btn-sm" style={{ padding: '4px 8px' }} onClick={() => openEdit(pool)}>
                    ✎
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ padding: '4px 8px', color: 'var(--red)', opacity: deletingId === pool.id ? 0.5 : 1 }}
                    disabled={deletingId === pool.id}
                    onClick={() => deletePool(pool.id)}
                  >
                    ×
                  </button>
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
                      {executions.map(ex => (
                        <ExecutionRow key={ex.id} execution={ex} t={t} />
                      ))}
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
            <input className="form-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus />
          </div>

          <div className="form-group">
            <label className="form-label">{t('common.country')}</label>
            <select className="form-select" value={form.country} onChange={e => setForm(f => ({ ...f, country: e.target.value as Country, brandIds: [] }))}>
              {COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">{t('pages.integrations.executionHours')} <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.78rem' }}>(UTC)</span></label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {HOURS.map(h => {
                const sel = form.executionHours.includes(h);
                return (
                  <button key={h} type="button" onClick={() => toggleHour(h)}
                    style={{
                      padding: '3px 8px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600,
                      border: '1px solid', cursor: 'pointer',
                      background: sel ? 'var(--orange)' : 'transparent',
                      borderColor: sel ? 'var(--orange)' : 'var(--border)',
                      color: sel ? '#fff' : 'var(--text-primary)',
                    }}
                  >
                    {formatHour(h)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">{t('pages.integrations.webhook')} <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.78rem' }}>({t('common.optional')})</span></label>
            <select className="form-select" value={form.webhookId} onChange={e => setForm(f => ({ ...f, webhookId: e.target.value }))}>
              <option value="">{t('pages.integrations.noWebhook')}</option>
              {webhooks.filter(w => !w.isAlerts).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">
              {t('common.brands')} ({filteredBrands.length} {t('pages.integrations.availableInCountry')})
            </label>
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, maxHeight: 220, overflowY: 'auto', padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {filteredBrands.length === 0 ? (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', padding: '8px 0' }}>{t('pages.integrations.noBrandsForCountry')}</p>
              ) : (
                filteredBrands.map(b => {
                  const sel = form.brandIds.includes(b.id);
                  return (
                    <label key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '3px 0' }}>
                      <input type="checkbox" checked={sel} onChange={() => toggleBrand(b.id)}
                        style={{ accentColor: 'var(--orange)', width: 14, height: 14, flexShrink: 0 }} />
                      <span style={{ fontSize: '0.84rem' }}>{b.brandName}</span>
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{b.brandId}</span>
                    </label>
                  );
                })
              )}
            </div>
            {form.brandIds.length > 0 && (
              <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>
                {form.brandIds.length} {t('pages.integrations.brandsSelected')}
              </p>
            )}
          </div>
        </Modal>
      )}

      {/* Suppress unused selectedPool warning */}
      {selectedPool && null}
    </>
  );
}

function ExecutionRow({ execution, t }: { execution: AutoOpenExecution; t: (k: string) => string }) {
  const [expanded, setExpanded] = useState(false);
  const dur = execution.startedAt && execution.finishedAt
    ? Math.round((new Date(execution.finishedAt).getTime() - new Date(execution.startedAt).getTime()) / 1000)
    : null;

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', cursor: execution.logs ? 'pointer' : 'default', background: 'var(--surface-2)' }}
        onClick={() => execution.logs && setExpanded(e => !e)}
      >
        <span style={{
          fontSize: '0.68rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999,
          background: statusBg[execution.status], color: statusColor[execution.status],
          flexShrink: 0,
        }}>
          {execution.status}
        </span>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', flexShrink: 0 }}>
          {new Date(execution.createdAt).toLocaleString()}
        </span>
        {execution.status === 'done' && (
          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#027A48' }}>
            {execution.shopsOpened}/{execution.totalShops} {t('pages.integrations.shopsOpened')}
          </span>
        )}
        {dur !== null && (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
            {dur}s
          </span>
        )}
        {execution.logs && (
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
        )}
      </div>
      {expanded && execution.logs && (
        <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {execution.logs.brands.map((b, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem' }}>
              <span style={{ color: b.error ? 'var(--red)' : '#027A48', fontWeight: 700, flexShrink: 0 }}>
                {b.error ? '✗' : '✓'}
              </span>
              <span style={{ fontWeight: 500 }}>{b.brandName}</span>
              {b.error ? (
                <span style={{ color: 'var(--red)', fontSize: '0.75rem' }}>{b.error}</span>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>{b.shopsOpened}/{b.shopsProcessed} opened</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
