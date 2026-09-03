import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../components/layout/Topbar';
import Modal from '../components/ui/Modal';
import Paginator from '../components/ui/Paginator';
import { applicationsApi } from '../api';
import { useAuth } from '../auth/AuthContext';
import { useT } from '../i18n';
import type { Application, ApplicationOrderWebhook, Country, DidiBindingEnvironment, Paginated } from '../types';
import { hasPermission } from '../auth/permissions';

const COUNTRIES: Country[] = ['MX', 'CO', 'CR'];
const COUNTRY_LABEL: Record<Country, string> = { MX: 'Mexico (MX)', CO: 'Colombia (CO)', CR: 'Costa Rica (CR)' };
const BINDING_ENVIRONMENTS: DidiBindingEnvironment[] = ['TEST', 'PRODUCTION'];
const LIMIT = 25;

const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="14" height="14">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
  </svg>
);
const EditIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="14" height="14">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);
const WebhookIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
    <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.15 1.15"/>
    <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.15-1.15"/>
  </svg>
);
const CopyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="14" height="14">
    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
);

type WebhookAction = 'generate' | 'rotate' | 'disable' | null;

function responseMessage(error: unknown, fallback: string) {
  const apiError = error as { response?: { data?: { message?: string | string[] } } };
  const message = apiError.response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : (message ?? fallback);
}

export default function ApplicationsPage() {
  const qc = useQueryClient();
  const { account } = useAuth();
  const t = useT();
  const canCreateApp = hasPermission(account, 'applications.create');
  const canUpdateApp = hasPermission(account, 'applications.update');
  const canDeleteApp = hasPermission(account, 'applications.delete');

  const [q, setQ] = useState('');
  const [country, setCountry] = useState<Country | ''>('');
  const [page, setPage] = useState(1);

  const [openCreate, setOpenCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    appId: '', appName: '', country: 'MX' as Country, appSecret: '',
    didiBindingEnvironment: '' as DidiBindingEnvironment | '',
  });

  const [editApp, setEditApp] = useState<Application | null>(null);
  const [editForm, setEditForm] = useState({
    appName: '', country: 'MX' as Country, appSecret: '',
    didiBindingEnvironment: '' as DidiBindingEnvironment | '',
  });

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [webhookApp, setWebhookApp] = useState<Application | null>(null);
  const [webhookAction, setWebhookAction] = useState<WebhookAction>(null);
  const [webhookErr, setWebhookErr] = useState('');
  const [copiedWebhook, setCopiedWebhook] = useState(false);

  const params = { page, limit: LIMIT, ...(q ? { q } : {}), ...(country ? { country } : {}) };

  const { data: result, isLoading } = useQuery<Paginated<Application>>({
    queryKey: ['applications', params],
    queryFn: () => applicationsApi.list(params).then(r => r.data as Paginated<Application>),
  });

  const webhookQuery = useQuery<ApplicationOrderWebhook>({
    queryKey: ['application-order-webhook', webhookApp?.id],
    queryFn: () => applicationsApi.getOrderWebhook(webhookApp!.id).then(response => response.data),
    enabled: !!webhookApp,
    retry: false,
  });

  const apps = result?.data ?? [];
  const total = result?.total ?? 0;

  const resetFilters = useCallback(() => { setQ(''); setCountry(''); setPage(1); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      await applicationsApi.create({
        ...createForm,
        didiBindingEnvironment: createForm.didiBindingEnvironment || null,
      });
      qc.invalidateQueries({ queryKey: ['applications'] });
      setOpenCreate(false);
      setCreateForm({ appId: '', appName: '', country: 'MX', appSecret: '', didiBindingEnvironment: '' });
    } catch (ex: unknown) {
      const e2 = ex as { response?: { data?: { message?: string | string[] } } };
      const msg = e2.response?.data?.message;
      setErr(Array.isArray(msg) ? msg.join(', ') : (msg ?? 'Error'));
    } finally { setSaving(false); }
  };

  const openEdit = (a: Application) => {
    setEditApp(a);
    setEditForm({
      appName: a.appName,
      country: a.country,
      appSecret: '',
      didiBindingEnvironment: a.didiBindingEnvironment ?? '',
    });
    setErr('');
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editApp) return;
    setSaving(true); setErr('');
    const payload: Record<string, string | null> = {};
    if (editForm.appName) payload.appName = editForm.appName;
    payload.country = editForm.country;
    payload.didiBindingEnvironment = editForm.didiBindingEnvironment || null;
    if (editForm.appSecret) payload.appSecret = editForm.appSecret;
    try {
      await applicationsApi.update(editApp.id, payload);
      qc.invalidateQueries({ queryKey: ['applications'] });
      setEditApp(null);
    } catch (ex: unknown) {
      const e2 = ex as { response?: { data?: { message?: string | string[] } } };
      const msg = e2.response?.data?.message;
      setErr(Array.isArray(msg) ? msg.join(', ') : (msg ?? 'Error'));
    } finally { setSaving(false); }
  };

  const handleDelete = async (a: Application) => {
    if (!window.confirm(t('pages.applications.deleteConfirm').replace('{name}', a.appName))) return;
    try {
      await applicationsApi.delete(a.id);
      qc.invalidateQueries({ queryKey: ['applications'] });
    } catch { /* ignore */ }
  };

  const openOrderWebhook = (application: Application) => {
    setWebhookApp(application);
    setWebhookErr('');
    setCopiedWebhook(false);
  };

  const closeOrderWebhook = () => {
    if (webhookAction) return;
    setWebhookApp(null);
    setWebhookErr('');
    setCopiedWebhook(false);
  };

  const refreshOrderWebhook = async () => {
    await webhookQuery.refetch();
    qc.invalidateQueries({ queryKey: ['applications'] });
  };

  const mutateOrderWebhook = async (action: Exclude<WebhookAction, null>) => {
    if (!webhookApp) return;
    if (action === 'rotate' && !window.confirm(t('pages.applications.orderWebhookRotateConfirm'))) return;
    if (action === 'disable' && !window.confirm(t('pages.applications.orderWebhookDisableConfirm'))) return;

    setWebhookAction(action);
    setWebhookErr('');
    setCopiedWebhook(false);
    try {
      if (action === 'generate') await applicationsApi.generateOrderWebhook(webhookApp.id);
      if (action === 'rotate') await applicationsApi.rotateOrderWebhook(webhookApp.id);
      if (action === 'disable') await applicationsApi.disableOrderWebhook(webhookApp.id);
      await refreshOrderWebhook();
    } catch (error: unknown) {
      setWebhookErr(responseMessage(error, t('pages.applications.orderWebhookActionError')));
    } finally {
      setWebhookAction(null);
    }
  };

  const copyOrderWebhook = async () => {
    const url = webhookQuery.data?.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedWebhook(true);
      window.setTimeout(() => setCopiedWebhook(false), 2000);
    } catch {
      setWebhookErr(t('pages.applications.orderWebhookCopyError'));
    }
  };

  const formatWebhookDate = (value: string | null) => value
    ? new Date(value).toLocaleString()
    : t('pages.applications.orderWebhookNever');

  const subtitle = total === 1
    ? t('pages.applications.subtitle').replace('{total}', String(total))
    : t('pages.applications.subtitlePlural').replace('{total}', String(total));

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.applications') }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{t('pages.applications.title')}</h1>
            <p>{subtitle}</p>
          </div>
          <div className="page-actions">
            {canCreateApp && (
              <button className="btn btn-primary" onClick={() => { setOpenCreate(true); setErr(''); }}>
                <PlusIcon /> {t('pages.applications.newApplication')}
              </button>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <input
            className="form-input"
            style={{ width: 260, margin: 0 }}
            placeholder={t('pages.applications.searchPlaceholder')}
            value={q}
            onChange={e => { setQ(e.target.value); setPage(1); }}
          />
          <select
            className="form-select"
            style={{ width: 140, margin: 0 }}
            value={country}
            onChange={e => { setCountry(e.target.value as Country | ''); setPage(1); }}
          >
            <option value="">{t('pages.applications.allCountries')}</option>
            {COUNTRIES.map(c => <option key={c} value={c}>{COUNTRY_LABEL[c]}</option>)}
          </select>
          {(q || country) && (
            <button className="btn btn-ghost btn-sm" onClick={resetFilters}>{t('pages.applications.clearFilters')}</button>
          )}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('pages.applications.colName')}</th>
                <th>{t('pages.applications.colAppId')}</th>
                <th>{t('pages.applications.colCountry')}</th>
                <th>{t('pages.applications.colBindingEnvironment')}</th>
                <th>{t('pages.applications.colCreated')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={6} style={{ padding: '20px 16px', color: 'var(--text-muted)' }}>{t('common.loading')}</td></tr>}
              {!isLoading && apps.length === 0 && (
                <tr><td colSpan={6}>
                  <div className="empty-state">
                    <h3>{t('pages.applications.noApplications')}</h3>
                    <p>{t('pages.applications.noApplicationsHint')}</p>
                  </div>
                </td></tr>
              )}
              {apps.map(a => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 600 }}>{a.appName}</td>
                  <td className="td-mono">{a.appId}</td>
                  <td>{COUNTRY_LABEL[a.country]}</td>
                  <td><span className="badge" style={a.didiBindingEnvironment === 'PRODUCTION' ? { color: 'var(--red-text)' } : a.didiBindingEnvironment === 'TEST' ? { color: 'var(--amber-text)' } : undefined}>
                    {a.didiBindingEnvironment ?? t('pages.applications.bindingEnvironmentDisabled')}
                  </span></td>
                  <td className="text-muted text-sm">{new Date(a.createdAt).toLocaleDateString()}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {canUpdateApp && <button className="btn btn-ghost btn-sm" style={{ padding: '3px 8px' }}
                        onClick={() => openOrderWebhook(a)} title={t('pages.applications.orderWebhookAction')}>
                        <WebhookIcon />
                      </button>}
                      {canUpdateApp && <button className="btn btn-ghost btn-sm" style={{ padding: '3px 8px' }}
                        onClick={() => openEdit(a)} title={t('common.edit')}>
                        <EditIcon />
                      </button>}
                      {canDeleteApp && <button className="btn btn-ghost btn-sm" style={{ padding: '3px 8px', color: 'var(--red)' }}
                        onClick={() => handleDelete(a)} title={t('common.delete')}>
                        <TrashIcon />
                      </button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {total > LIMIT && (
          <Paginator page={page} total={total} limit={LIMIT} onChange={setPage} />
        )}
      </main>

      {openCreate && (
        <Modal title={t('pages.applications.modalCreate')} onClose={() => { setOpenCreate(false); setErr(''); }}
          footer={<>
            <button className="btn btn-ghost" onClick={() => { setOpenCreate(false); setErr(''); }}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
              {saving ? t('pages.applications.creating') : t('common.create')}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{t('pages.applications.appIdLabel')} <span style={{ color: 'var(--red)' }}>*</span></label>
              <input className="form-input" placeholder="APP-MX-001" value={createForm.appId}
                onChange={e => setCreateForm(f => ({ ...f, appId: e.target.value }))} required autoFocus />
            </div>
            <div className="form-group">
              <label className="form-label">{t('pages.applications.appNameLabel')} <span style={{ color: 'var(--red)' }}>*</span></label>
              <input className="form-input" placeholder="DiDi Mexico" value={createForm.appName}
                onChange={e => setCreateForm(f => ({ ...f, appName: e.target.value }))} required />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{t('pages.applications.countryLabel')} <span style={{ color: 'var(--red)' }}>*</span></label>
              <select className="form-select" value={createForm.country}
                onChange={e => setCreateForm(f => ({ ...f, country: e.target.value as Country }))}>
                {COUNTRIES.map(c => <option key={c} value={c}>{COUNTRY_LABEL[c]}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">{t('pages.applications.appSecretLabel')} <span style={{ color: 'var(--red)' }}>*</span></label>
              <input className="form-input" type="password" placeholder="••••••••" value={createForm.appSecret}
                onChange={e => setCreateForm(f => ({ ...f, appSecret: e.target.value }))} required />
              <p className="form-hint">{t('pages.applications.appSecretHint')}</p>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">{t('pages.applications.bindingEnvironmentLabel')}</label>
            <select className="form-select" value={createForm.didiBindingEnvironment}
              onChange={e => setCreateForm(f => ({ ...f, didiBindingEnvironment: e.target.value as DidiBindingEnvironment | '' }))}>
              <option value="">{t('pages.applications.bindingEnvironmentDisabled')}</option>
              {BINDING_ENVIRONMENTS.map(value => <option key={value} value={value}>{t(`pages.applications.bindingEnvironment${value === 'TEST' ? 'Test' : 'Production'}`)}</option>)}
            </select>
            <p className="form-hint">{t('pages.applications.bindingEnvironmentHint')}</p>
          </div>
        </Modal>
      )}

      {editApp && (
        <Modal title={t('pages.applications.modalEdit').replace('{name}', editApp.appName)} onClose={() => { setEditApp(null); setErr(''); }}
          footer={<>
            <button className="btn btn-ghost" onClick={() => { setEditApp(null); setErr(''); }}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleEdit} disabled={saving}>
              {saving ? t('pages.applications.saving') : t('common.save')}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <p className="text-muted text-sm" style={{ marginBottom: 14 }}>
            {t('pages.applications.editHint').replace('{appId}', editApp.appId)}
          </p>
          <div className="form-group">
            <label className="form-label">{t('pages.applications.editAppName')}</label>
            <input className="form-input" value={editForm.appName}
              onChange={e => setEditForm(f => ({ ...f, appName: e.target.value }))} autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">{t('pages.applications.countryLabel')}</label>
            <select className="form-select" value={editForm.country}
              onChange={e => setEditForm(f => ({ ...f, country: e.target.value as Country }))}>
              {COUNTRIES.map(c => <option key={c} value={c}>{COUNTRY_LABEL[c]}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('pages.applications.bindingEnvironmentLabel')}</label>
            <select className="form-select" value={editForm.didiBindingEnvironment}
              onChange={e => setEditForm(f => ({ ...f, didiBindingEnvironment: e.target.value as DidiBindingEnvironment | '' }))}>
              <option value="">{t('pages.applications.bindingEnvironmentDisabled')}</option>
              {BINDING_ENVIRONMENTS.map(value => <option key={value} value={value}>{t(`pages.applications.bindingEnvironment${value === 'TEST' ? 'Test' : 'Production'}`)}</option>)}
            </select>
            <p className="form-hint">{t('pages.applications.bindingEnvironmentHint')}</p>
          </div>
          <div className="form-group">
            <label className="form-label">{t('pages.applications.editSecretLabel')} <span className="text-muted">{t('pages.applications.editSecretNote')}</span></label>
            <input className="form-input" type="password" placeholder="••••••••" value={editForm.appSecret}
              onChange={e => setEditForm(f => ({ ...f, appSecret: e.target.value }))} />
            <p className="form-hint">{t('pages.applications.editSecretHint')}</p>
          </div>
        </Modal>
      )}

      {webhookApp && (
        <Modal
          title={t('pages.applications.orderWebhookTitle').replace('{name}', webhookApp.appName)}
          onClose={closeOrderWebhook}
          footer={<button className="btn btn-ghost" onClick={closeOrderWebhook} disabled={!!webhookAction}>{t('common.close')}</button>}
        >
          {(webhookErr || webhookQuery.isError) && (
            <div className="error-banner">
              {webhookErr || t('pages.applications.orderWebhookLoadError')}
            </div>
          )}

          {webhookQuery.isLoading && (
            <p className="text-muted text-sm">{t('pages.applications.orderWebhookLoading')}</p>
          )}

          {!webhookQuery.isLoading && webhookQuery.data && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{t('pages.applications.orderWebhookStatus')}</div>
                  <p className="form-hint">{t('pages.applications.orderWebhookStatusHint')}</p>
                </div>
                <span className={`status ${webhookQuery.data.enabled ? 's-done' : 's-cancelled'}`}>
                  {webhookQuery.data.enabled
                    ? t('pages.applications.orderWebhookEnabled')
                    : t('pages.applications.orderWebhookDisabled')}
                </span>
              </div>

              {webhookQuery.data.enabled && webhookQuery.data.url ? (
                <>
                  <div className="form-group">
                    <label className="form-label">{t('pages.applications.orderWebhookUrl')}</label>
                    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
                      <code style={{
                        flex: 1, minWidth: 0, padding: '9px 10px', border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-md)', background: 'var(--surface-2)', color: 'var(--text-secondary)',
                        fontSize: '0.72rem', lineHeight: 1.45, overflowWrap: 'anywhere',
                      }}>{webhookQuery.data.url}</code>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={copyOrderWebhook}
                        title={t('pages.applications.orderWebhookCopy')}
                        style={{ color: copiedWebhook ? 'var(--green-text)' : undefined }}
                      >
                        {copiedWebhook ? '✓' : <CopyIcon />}
                        {copiedWebhook
                          ? t('pages.applications.orderWebhookCopied')
                          : t('pages.applications.orderWebhookCopy')}
                      </button>
                    </div>
                    <p className="form-hint">{t('pages.applications.orderWebhookUrlHint')}</p>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px 14px', marginTop: 16, fontSize: '0.76rem' }}>
                    <div><span className="text-muted">{t('pages.applications.orderWebhookCreated')}</span><br />{formatWebhookDate(webhookQuery.data.createdAt)}</div>
                    <div><span className="text-muted">{t('pages.applications.orderWebhookRotated')}</span><br />{formatWebhookDate(webhookQuery.data.rotatedAt)}</div>
                    <div><span className="text-muted">{t('pages.applications.orderWebhookLastReceived')}</span><br />{formatWebhookDate(webhookQuery.data.lastReceivedAt)}</div>
                    <div><span className="text-muted">{t('pages.applications.orderWebhookLastAccepted')}</span><br />{formatWebhookDate(webhookQuery.data.lastAcceptedAt)}</div>
                  </div>

                  {webhookQuery.data.lastError && (
                    <div style={{ marginTop: 14, padding: '9px 10px', borderRadius: 'var(--radius-md)', background: 'var(--red-bg)', color: 'var(--red-text)', fontSize: '0.75rem', overflowWrap: 'anywhere' }}>
                      <strong>{t('pages.applications.orderWebhookLastError')}:</strong> {webhookQuery.data.lastError}
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
                    <button className="btn btn-ghost" disabled={!!webhookAction} onClick={() => mutateOrderWebhook('rotate')}>
                      {webhookAction === 'rotate'
                        ? t('pages.applications.orderWebhookRotating')
                        : t('pages.applications.orderWebhookRotate')}
                    </button>
                    <button className="btn btn-danger" disabled={!!webhookAction} onClick={() => mutateOrderWebhook('disable')}>
                      {webhookAction === 'disable'
                        ? t('pages.applications.orderWebhookDisabling')
                        : t('pages.applications.orderWebhookDisable')}
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ padding: '18px 0 4px', textAlign: 'center' }}>
                  <p className="text-muted text-sm" style={{ marginBottom: 14 }}>
                    {t('pages.applications.orderWebhookGenerateHint')}
                  </p>
                  <button className="btn btn-primary" disabled={!!webhookAction} onClick={() => mutateOrderWebhook('generate')}>
                    {webhookAction === 'generate'
                      ? t('pages.applications.orderWebhookGenerating')
                      : t('pages.applications.orderWebhookGenerate')}
                  </button>
                </div>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
