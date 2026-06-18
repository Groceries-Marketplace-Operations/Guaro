import { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import { brandsApi, shopsApi, tasksApi, taskTypesApi, applicationsApi, accountsApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useT } from '../../i18n';
import type { Brand, Shop, Task, TaskType, Paginated, Application, Country } from '../../types';

const COUNTRY_EMOJI: Record<string, string> = { MX: '🇲🇽', CO: '🇨🇴', CR: '🇨🇷' };

const MENU_INTEGRATIONS = ['api', 'api_whitelist', 'sftp', 'spreadsheets', 'bapp'];
const PICKING_MODES     = ['merchant_picking_bapp', 'merchant_picking_dapp', 'dos_en_uno'];
const PAYMENT_MODES     = ['food_mode', 'prepaid_card', 'qr_code'];
const KA_TYPES          = ['KA', 'CKA', 'SME'];

function fmt(val?: string | null) {
  if (!val) return '—';
  return val.replace(/_/g, ' ');
}

export default function BrandDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { account } = useAuth();
  const t = useT();
  const roles = account?.roles ?? [];
  const isAdmin = roles.some(r => r === 'admin' || r === 'super_admin');
  const isBpo   = roles.some(r => r === 'bpo') && !isAdmin;

  const [tab, setTab] = useState<'shops' | 'tasks'>('shops');
  const [openTask, setOpenTask] = useState(false);
  const [taskTypeId, setTaskTypeId] = useState('');
  const [savingTask, setSavingTask] = useState(false);
  const [openEdit, setOpenEdit] = useState(false);
  const [editForm, setEditForm] = useState({
    brandName: '', category: '',
    menuIntegration: '', pickingMode: '', paymentMode: '', kaType: '',
  });
  const [savingEdit, setSavingEdit] = useState(false);
  const [editErr, setEditErr] = useState('');
  const [openChangeOp, setOpenChangeOp] = useState(false);
  const [selectedOwnerId, setSelectedOwnerId] = useState('');
  const [savingOp, setSavingOp] = useState(false);
  const [openChangeApp, setOpenChangeApp] = useState(false);
  const [selectedAppId, setSelectedAppId] = useState('');
  const [savingApp, setSavingApp] = useState(false);
  const [selectedShopIds, setSelectedShopIds] = useState<Set<string>>(new Set());
  const [batchStatus, setBatchStatus] = useState('');
  const [savingBatch, setSavingBatch] = useState(false);
  const [openAddShop, setOpenAddShop] = useState(false);
  const [shopMode, setShopMode] = useState<'manual' | 'batch'>('manual');
  const [shopForm, setShopForm] = useState({ shopId: '', appShopId: '', city: '', status: 'lead' });
  const [savingShop, setSavingShop] = useState(false);
  const [shopErr, setShopErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [batchRows, setBatchRows] = useState<{ shopId: string; appShopId: string; city: string; status: string; _err?: string }[]>([]);
  const [batchDone, setBatchDone] = useState(false);

  const { data: brand, refetch: refetchBrand } = useQuery<Brand>({
    queryKey: ['brand', id],
    queryFn: () => brandsApi.get(id!).then(r => r.data),
  });

  const { data: shopsResult } = useQuery<Paginated<Shop>>({
    queryKey: ['shops', { brandId: id, limit: 500 }],
    queryFn: () => shopsApi.list({ brandId: id, limit: 500 }).then(r => r.data as Paginated<Shop>),
  });

  const { data: tasksResult } = useQuery<Paginated<Task>>({
    queryKey: ['tasks', { brandId: id, limit: 100 }],
    queryFn: () => tasksApi.list({ brandId: id, limit: 100 }).then(r => r.data as Paginated<Task>),
  });

  const shops = shopsResult?.data ?? [];
  const tasks = tasksResult?.data ?? [];

  const { data: types = [] } = useQuery<TaskType[]>({
    queryKey: ['task-types'],
    queryFn: () => taskTypesApi.list().then(r => r.data),
  });

  const { data: bposResult } = useQuery<{ data: { id: string; name: string; email: string }[] }>({
    queryKey: ['accounts', { role: 'bpo' }],
    queryFn: () => accountsApi.list({ role: 'bpo', limit: 200 }).then(r => r.data as { data: { id: string; name: string; email: string }[] }),
    enabled: openChangeOp,
  });
  const bpos = bposResult?.data ?? [];

  const { data: appsResult } = useQuery<Paginated<Application>>({
    queryKey: ['applications', { country: brand?.country, limit: 100 }],
    queryFn: () => applicationsApi.list({ country: brand?.country, limit: 100 }).then(r => r.data as Paginated<Application>),
    enabled: !!brand?.country && openChangeApp,
  });
  const availableApps = appsResult?.data ?? [];

  const isBpoOp = isBpo && !!brand && brand.owner?.id === account?.id;
  const canEdit = isAdmin || isBpoOp;
  const canAddShop = isAdmin || isBpo;

  const createTask = async () => {
    if (!taskTypeId) return;
    setSavingTask(true);
    try {
      const res = await tasksApi.create({ taskTypeId, brandId: id });
      qc.invalidateQueries({ queryKey: ['tasks', id] });
      setOpenTask(false);
      nav(`/tasks/${res.data.id}`);
    } finally { setSavingTask(false); }
  };

  const openEditModal = () => {
    if (!brand) return;
    setEditForm({
      brandName:       brand.brandName ?? '',
      category:        brand.category ?? '',
      menuIntegration: brand.menuIntegration ?? '',
      pickingMode:     brand.pickingMode ?? '',
      paymentMode:     brand.paymentMode ?? '',
      kaType:          brand.kaType ?? '',
    });
    setEditErr('');
    setOpenEdit(true);
  };

  const handleEdit = async () => {
    setSavingEdit(true); setEditErr('');
    try {
      const payload: Record<string, string | null | undefined> = {
        brandName:       editForm.brandName || undefined,
        category:        editForm.category  || null,
        menuIntegration: (editForm.menuIntegration || null) as string | null,
        pickingMode:     (editForm.pickingMode     || null) as string | null,
        paymentMode:     (editForm.paymentMode     || null) as string | null,
      };
      if (isAdmin && editForm.kaType) payload.kaType = editForm.kaType;
      await brandsApi.update(id!, payload);
      await refetchBrand();
      qc.invalidateQueries({ queryKey: ['brands'] });
      setOpenEdit(false);
    } catch (ex: unknown) {
      const e = ex as { response?: { data?: { message?: string | string[] } } };
      const msg = e.response?.data?.message;
      setEditErr(Array.isArray(msg) ? msg.join(', ') : (msg ?? t('pages.brandDetail.errorSavingChanges')));
    } finally { setSavingEdit(false); }
  };

  const handleChangeOp = async () => {
    setSavingOp(true);
    try {
      await brandsApi.update(id!, { ownerId: selectedOwnerId || null });
      await refetchBrand();
      qc.invalidateQueries({ queryKey: ['brands'] });
      setOpenChangeOp(false);
    } finally { setSavingOp(false); }
  };

  const toggleShop = (shopId: string) => {
    setSelectedShopIds(prev => {
      const next = new Set(prev);
      next.has(shopId) ? next.delete(shopId) : next.add(shopId);
      return next;
    });
  };

  const toggleAllShops = () => {
    if (selectedShopIds.size === shops.length) {
      setSelectedShopIds(new Set());
    } else {
      setSelectedShopIds(new Set(shops.map(s => s.id)));
    }
  };

  const applyBatchStatus = async () => {
    if (!batchStatus || selectedShopIds.size === 0) return;
    setSavingBatch(true);
    try {
      await shopsApi.batchStatus([...selectedShopIds], batchStatus);
      qc.invalidateQueries({ queryKey: ['shops', { brandId: id, limit: 500 }] });
      setSelectedShopIds(new Set());
      setBatchStatus('');
    } finally { setSavingBatch(false); }
  };

  const handleAddShop = async () => {
    setSavingShop(true); setShopErr('');
    try {
      await shopsApi.create({ ...shopForm, brandId: id, status: shopForm.status || 'lead' });
      qc.invalidateQueries({ queryKey: ['shops', { brandId: id, limit: 500 }] });
      setOpenAddShop(false);
      setShopForm({ shopId: '', appShopId: '', city: '', status: 'lead' });
    } catch (ex: unknown) {
      const e = ex as { response?: { data?: { message?: string | string[] } } };
      const msg = e.response?.data?.message;
      setShopErr(Array.isArray(msg) ? msg.join(', ') : (msg ?? t('pages.brandDetail.errorCreatingShop')));
    } finally { setSavingShop(false); }
  };

  const parseCSV = (text: string) => {
    const lines = text.trim().split('\n');
    const header = lines[0].toLowerCase().split(',').map(h => h.trim());
    const idx = (name: string) => header.indexOf(name);
    return lines.slice(1).filter(l => l.trim()).map(line => {
      const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      return {
        shopId:    cols[idx('shopid')]    ?? cols[idx('shop_id')]    ?? '',
        appShopId: cols[idx('appshopid')] ?? cols[idx('app_shop_id')] ?? '',
        city:      cols[idx('city')]      ?? '',
        status:    cols[idx('status')]    ?? 'lead',
      };
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const rows = parseCSV(ev.target?.result as string);
      setBatchRows(rows);
      setBatchDone(false);
      setShopErr('');
    };
    reader.readAsText(file);
  };

  const handleBatchUpload = async () => {
    if (!batchRows.length) return;
    setSavingShop(true); setShopErr('');
    try {
      await shopsApi.createBatch(batchRows.map(r => ({ ...r, brandId: id })));
      qc.invalidateQueries({ queryKey: ['shops', { brandId: id, limit: 500 }] });
      setBatchDone(true);
    } catch (ex: unknown) {
      const e = ex as { response?: { data?: { message?: string | string[] } } };
      const msg = e.response?.data?.message;
      setShopErr(Array.isArray(msg) ? msg.join(', ') : (msg ?? t('pages.brandDetail.errorUploadingShops')));
    } finally { setSavingShop(false); }
  };

  const handleChangeApp = async () => {
    setSavingApp(true);
    try {
      await brandsApi.update(id!, { applicationId: selectedAppId || null });
      await refetchBrand();
      qc.invalidateQueries({ queryKey: ['brands'] });
      setOpenChangeApp(false);
    } finally { setSavingApp(false); }
  };

  if (!brand) return null;

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.brands'), href: '/brands' }, { label: brand.brandName }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{brand.brandName}</h1>
            <p>{COUNTRY_EMOJI[brand.country]} {brand.country} · {brand.kaType}</p>
          </div>
          <div className="page-actions">
            {canEdit && (
              <button className="btn btn-ghost" onClick={openEditModal}>{t('pages.brandDetail.editBrand')}</button>
            )}
            <button className="btn btn-primary" onClick={() => setOpenTask(true)}>{t('pages.brandDetail.startTask')}</button>
          </div>
        </div>

        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 24 }}>
          <div className="stat-card">
            <div className="s-label">{t('pages.brandDetail.brandId')}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem', fontWeight: 600, marginTop: 4 }}>{brand.brandId}</div>
          </div>

          <div className="stat-card">
            <div className="s-label">{t('pages.brandDetail.ownerOp')}</div>
            <div style={{ fontWeight: 600, marginTop: 4, fontSize: '0.9rem' }}>{brand.owner?.name ?? '—'}</div>
            <div className="s-meta">{brand.owner?.email ?? t('pages.brandDetail.unassigned')}</div>
            {isAdmin && (
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 6, fontSize: '0.72rem', padding: '2px 8px' }}
                onClick={() => { setSelectedOwnerId(brand.owner?.id ?? ''); setOpenChangeOp(true); }}
              >
                {brand.owner ? t('pages.brandDetail.change') : t('pages.brandDetail.assign')}
              </button>
            )}
          </div>

          <div className="stat-card">
            <div className="s-label">{t('pages.brandDetail.application')}</div>
            <div style={{ fontWeight: 600, marginTop: 4, fontSize: '0.9rem' }}>
              {brand.application?.appName ?? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{t('pages.brandDetail.appNone')}</span>}
            </div>
            {brand.application && <div className="s-meta td-mono">{brand.application.appId}</div>}
            {isAdmin && (
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 6, fontSize: '0.72rem', padding: '2px 8px' }}
                onClick={() => { setSelectedAppId(brand.application?.id ?? ''); setOpenChangeApp(true); }}
              >
                {brand.application ? t('pages.brandDetail.change') : t('pages.brandDetail.link')}
              </button>
            )}
          </div>

          <div className="stat-card">
            <div className="s-label">{t('pages.brandDetail.shops')}</div>
            <div className="s-value">{shops.length}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">{t('pages.brandDetail.tasks')}</div>
            <div className="s-value">{tasks.length}</div>
          </div>
        </div>

        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 24 }}>
          <div className="stat-card">
            <div className="s-label">{t('pages.brandDetail.category')}</div>
            <div style={{ fontWeight: 500, marginTop: 4, fontSize: '0.88rem' }}>{brand.category ?? '—'}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">{t('pages.brandDetail.menuIntegration')}</div>
            <div style={{ fontWeight: 500, marginTop: 4, fontSize: '0.88rem' }}>{fmt(brand.menuIntegration)}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">{t('pages.brandDetail.pickingMode')}</div>
            <div style={{ fontWeight: 500, marginTop: 4, fontSize: '0.88rem' }}>{fmt(brand.pickingMode)}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">{t('pages.brandDetail.paymentMode')}</div>
            <div style={{ fontWeight: 500, marginTop: 4, fontSize: '0.88rem' }}>{fmt(brand.paymentMode)}</div>
          </div>
        </div>

        <div className="tabs">
          <div className={`tab ${tab === 'shops' ? 'active' : ''}`} onClick={() => setTab('shops')}>
            {t('pages.brandDetail.tabShops').replace('{count}', String(shops.length))}
          </div>
          <div className={`tab ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>
            {t('pages.brandDetail.tabTasks').replace('{count}', String(tasks.length))}
          </div>
        </div>

        {tab === 'shops' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              {selectedShopIds.size > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: 'var(--orange-muted)', borderRadius: 8, border: '1px solid rgba(255,105,0,0.2)' }}>
                  <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--orange)' }}>
                    {t('pages.brandDetail.selected').replace('{count}', String(selectedShopIds.size))}
                  </span>
                  <select
                    className="form-select"
                    style={{ margin: 0, padding: '4px 8px', fontSize: '0.82rem', height: 30, minWidth: 140 }}
                    value={batchStatus}
                    onChange={e => setBatchStatus(e.target.value)}
                  >
                    <option value="">{t('pages.brandDetail.setStatus')}</option>
                    <option value="lead">Lead</option>
                    <option value="application">Application</option>
                    <option value="integrated">Integrated</option>
                    <option value="online">Online</option>
                  </select>
                  <button
                    className="btn btn-primary btn-sm"
                    style={{ padding: '4px 12px', fontSize: '0.82rem' }}
                    disabled={!batchStatus || savingBatch}
                    onClick={applyBatchStatus}
                  >
                    {savingBatch ? t('pages.brandDetail.saving') : t('common.apply')}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ padding: '4px 10px', fontSize: '0.82rem' }}
                    onClick={() => setSelectedShopIds(new Set())}
                  >
                    {t('common.clear')}
                  </button>
                </div>
              )}
              <div style={{ marginLeft: 'auto' }}>
                {canAddShop && (
                  <button className="btn btn-primary" onClick={() => { setOpenAddShop(true); setShopMode('manual'); setBatchRows([]); setBatchDone(false); setShopErr(''); }}>
                    {t('pages.brandDetail.addShop')}
                  </button>
                )}
              </div>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        style={{ accentColor: 'var(--orange)', cursor: 'pointer' }}
                        checked={shops.length > 0 && selectedShopIds.size === shops.length}
                        onChange={toggleAllShops}
                      />
                    </th>
                    <th>{t('pages.brandDetail.colShopId')}</th>
                    <th>{t('pages.brandDetail.colAppShopId')}</th>
                    <th>{t('pages.brandDetail.colCity')}</th>
                    <th>{t('pages.brandDetail.colStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shops.length === 0 && <tr><td colSpan={5}><div className="empty-state"><p>{t('pages.brandDetail.noShops')}</p></div></td></tr>}
                  {shops.map(s => (
                    <tr key={s.id} style={{ cursor: 'pointer', background: selectedShopIds.has(s.id) ? 'rgba(255,105,0,0.04)' : '' }}>
                      <td onClick={e => { e.stopPropagation(); toggleShop(s.id); }}>
                        <input
                          type="checkbox"
                          style={{ accentColor: 'var(--orange)', cursor: 'pointer' }}
                          checked={selectedShopIds.has(s.id)}
                          onChange={() => toggleShop(s.id)}
                        />
                      </td>
                      <td className="td-mono" onClick={() => nav(`/shops/${s.id}`)}>{s.shopId}</td>
                      <td className="td-mono" onClick={() => nav(`/shops/${s.id}`)}>{s.appShopId}</td>
                      <td onClick={() => nav(`/shops/${s.id}`)}>{s.city ?? '—'}</td>
                      <td onClick={() => nav(`/shops/${s.id}`)}><StatusBadge status={s.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'tasks' && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('pages.brandDetail.colTaskType')}</th>
                  <th>{t('pages.brandDetail.colStatus')}</th>
                  <th>{t('pages.brandDetail.colCreated')}</th>
                </tr>
              </thead>
              <tbody>
                {tasks.length === 0 && <tr><td colSpan={3}><div className="empty-state"><p>{t('pages.brandDetail.noTasks')}</p></div></td></tr>}
                {tasks.map(tk => (
                  <tr key={tk.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/tasks/${tk.id}`)}>
                    <td style={{ fontWeight: 600 }}>{tk.taskType?.name ?? '—'}</td>
                    <td><StatusBadge status={tk.status} /></td>
                    <td className="text-muted text-sm">{new Date(tk.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {openAddShop && (
        <Modal
          title={t('pages.brandDetail.modalAddShop')}
          onClose={() => setOpenAddShop(false)}
          footer={
            shopMode === 'manual' ? (
              <>
                <button className="btn btn-ghost" onClick={() => setOpenAddShop(false)}>{t('common.cancel')}</button>
                <button className="btn btn-primary" onClick={handleAddShop} disabled={savingShop || !shopForm.shopId || !shopForm.appShopId}>
                  {savingShop ? t('pages.brandDetail.creating') : t('pages.brandDetail.createShop')}
                </button>
              </>
            ) : batchDone ? (
              <button className="btn btn-primary" onClick={() => setOpenAddShop(false)}>{t('common.done')}</button>
            ) : (
              <>
                <button className="btn btn-ghost" onClick={() => setOpenAddShop(false)}>{t('common.cancel')}</button>
                <button className="btn btn-primary" onClick={handleBatchUpload} disabled={savingShop || batchRows.length === 0}>
                  {savingShop
                    ? t('pages.brandDetail.uploading')
                    : batchRows.length !== 1
                      ? t('pages.brandDetail.uploadShopsPlural').replace('{count}', String(batchRows.length))
                      : t('pages.brandDetail.uploadShops').replace('{count}', String(batchRows.length))
                  }
                </button>
              </>
            )
          }
        >
          <div style={{ display: 'flex', gap: 0, marginBottom: 18, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {(['manual', 'batch'] as const).map(m => (
              <button
                key={m}
                onClick={() => { setShopMode(m); setShopErr(''); setBatchRows([]); setBatchDone(false); }}
                style={{
                  flex: 1, padding: '7px 0', border: 'none', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600,
                  background: shopMode === m ? 'var(--orange)' : 'var(--surface-2)',
                  color: shopMode === m ? '#fff' : 'var(--text-secondary)',
                  transition: 'background 0.15s',
                }}
              >
                {m === 'manual' ? t('pages.brandDetail.shopModeManual') : t('pages.brandDetail.shopModeBatch')}
              </button>
            ))}
          </div>

          {shopErr && <div className="error-banner" style={{ marginBottom: 12 }}>{shopErr}</div>}

          {shopMode === 'manual' && (
            <>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">{t('pages.brandDetail.shopIdLabel')} <span style={{ color: 'var(--red)' }}>*</span></label>
                  <input className="form-input" value={shopForm.shopId} placeholder="SHOP_001"
                    onChange={e => setShopForm(f => ({ ...f, shopId: e.target.value }))} autoFocus />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('pages.brandDetail.appShopIdLabel')} <span style={{ color: 'var(--red)' }}>*</span></label>
                  <input className="form-input" value={shopForm.appShopId} placeholder="APP_001"
                    onChange={e => setShopForm(f => ({ ...f, appShopId: e.target.value }))} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">{t('pages.brandDetail.cityLabel')}</label>
                  <input className="form-input" value={shopForm.city} placeholder="Bogotá"
                    onChange={e => setShopForm(f => ({ ...f, city: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('pages.brandDetail.statusLabel')}</label>
                  <select className="form-select" value={shopForm.status}
                    onChange={e => setShopForm(f => ({ ...f, status: e.target.value }))}>
                    <option value="lead">Lead</option>
                    <option value="application">Application</option>
                    <option value="integrated">Integrated</option>
                    <option value="online">Online</option>
                  </select>
                </div>
              </div>
            </>
          )}

          {shopMode === 'batch' && !batchDone && (
            <>
              <p className="form-hint" style={{ marginBottom: 10 }}>
                {t('pages.brandDetail.batchHint')}
              </p>
              <div
                style={{
                  border: '2px dashed var(--border)', borderRadius: 8, padding: '24px 16px', textAlign: 'center',
                  cursor: 'pointer', marginBottom: batchRows.length ? 14 : 0,
                  background: 'var(--surface-2)',
                }}
                onClick={() => fileRef.current?.click()}
              >
                <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={handleFileChange} />
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0 }}>
                  {batchRows.length
                    ? t('pages.brandDetail.rowsLoaded').replace('{count}', String(batchRows.length))
                    : t('pages.brandDetail.clickToSelectCsv')}
                </p>
              </div>

              {batchRows.length > 0 && (
                <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                  <table style={{ width: '100%', fontSize: '0.78rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'var(--surface-2)' }}>
                        {['shopId', 'appShopId', 'city', 'status'].map(h => (
                          <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {batchRows.map((r, i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--border)', background: r._err ? 'var(--red-bg)' : 'transparent' }}>
                          <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{r.shopId || <span style={{ color: 'var(--red)' }}>missing</span>}</td>
                          <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{r.appShopId || <span style={{ color: 'var(--red)' }}>missing</span>}</td>
                          <td style={{ padding: '5px 10px' }}>{r.city || '—'}</td>
                          <td style={{ padding: '5px 10px' }}>{r.status || 'lead'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {batchDone && (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: '2rem', marginBottom: 8 }}>✓</div>
              <p style={{ fontWeight: 600 }}>
                {batchRows.length !== 1
                  ? t('pages.brandDetail.batchSuccessPlural').replace('{count}', String(batchRows.length))
                  : t('pages.brandDetail.batchSuccess').replace('{count}', String(batchRows.length))}
              </p>
            </div>
          )}
        </Modal>
      )}

      {openEdit && (
        <Modal
          title={t('pages.brandDetail.modalEditBrand')}
          onClose={() => setOpenEdit(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenEdit(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleEdit} disabled={savingEdit}>
              {savingEdit ? t('common.saving') : t('pages.brandDetail.saveChanges')}
            </button>
          </>}
        >
          {editErr && <div className="error-banner">{editErr}</div>}

          <div className="form-group">
            <label className="form-label">{t('pages.brandDetail.brandNameLabel')}</label>
            <input className="form-input" value={editForm.brandName}
              onChange={e => setEditForm(f => ({ ...f, brandName: e.target.value }))} />
          </div>

          <div className="form-group">
            <label className="form-label">{t('pages.brandDetail.categoryLabel')}</label>
            <input className="form-input" placeholder={t('pages.brandDetail.categoryPlaceholder')} value={editForm.category}
              onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))} />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{t('pages.brandDetail.menuLabel')}</label>
              <select className="form-select" value={editForm.menuIntegration}
                onChange={e => setEditForm(f => ({ ...f, menuIntegration: e.target.value }))}>
                <option value="">—</option>
                {MENU_INTEGRATIONS.map(v => <option key={v} value={v}>{fmt(v)}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">{t('pages.brandDetail.pickingLabel')}</label>
              <select className="form-select" value={editForm.pickingMode}
                onChange={e => setEditForm(f => ({ ...f, pickingMode: e.target.value }))}>
                <option value="">—</option>
                {PICKING_MODES.map(v => <option key={v} value={v}>{fmt(v)}</option>)}
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{t('pages.brandDetail.paymentLabel')}</label>
              <select className="form-select" value={editForm.paymentMode}
                onChange={e => setEditForm(f => ({ ...f, paymentMode: e.target.value }))}>
                <option value="">—</option>
                {PAYMENT_MODES.map(v => <option key={v} value={v}>{fmt(v)}</option>)}
              </select>
            </div>
            {isAdmin && (
              <div className="form-group">
                <label className="form-label">{t('pages.brandDetail.kaTypeLabel')}</label>
                <select className="form-select" value={editForm.kaType}
                  onChange={e => setEditForm(f => ({ ...f, kaType: e.target.value }))}>
                  {KA_TYPES.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            )}
          </div>
        </Modal>
      )}

      {openTask && (
        <Modal title={t('pages.brandDetail.modalStartTask')} onClose={() => setOpenTask(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenTask(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={createTask} disabled={savingTask || !taskTypeId}>
              {savingTask ? t('common.creating') : t('pages.brandDetail.startTaskBtn')}
            </button>
          </>}
        >
          <div className="form-group">
            <label className="form-label">{t('pages.brandDetail.taskTypeLabel')}</label>
            <select className="form-select" value={taskTypeId} onChange={e => setTaskTypeId(e.target.value)}>
              <option value="">{t('pages.brandDetail.taskTypePlaceholder')}</option>
              {types.map(tp => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
            </select>
          </div>
        </Modal>
      )}

      {openChangeOp && (
        <Modal
          title={t('pages.brandDetail.modalChangeOp')}
          onClose={() => setOpenChangeOp(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenChangeOp(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleChangeOp} disabled={savingOp}>
              {savingOp ? t('common.saving') : t('common.save')}
            </button>
          </>}
        >
          <p className="text-muted text-sm" style={{ marginBottom: 14 }}>
            {t('pages.brandDetail.changeOpHint')}
          </p>
          <div className="form-group">
            <label className="form-label">{t('pages.brandDetail.bpoOwnerLabel')}</label>
            <select className="form-select" value={selectedOwnerId} onChange={e => setSelectedOwnerId(e.target.value)}>
              <option value="">{t('pages.brandDetail.unassigned')}</option>
              {bpos.map(b => (
                <option key={b.id} value={b.id}>{b.name} — {b.email}</option>
              ))}
            </select>
          </div>
        </Modal>
      )}

      {openChangeApp && (
        <Modal
          title={t('pages.brandDetail.modalLinkApp')}
          onClose={() => setOpenChangeApp(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenChangeApp(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleChangeApp} disabled={savingApp}>
              {savingApp ? t('common.saving') : t('common.save')}
            </button>
          </>}
        >
          <p className="text-muted text-sm" style={{ marginBottom: 14 }}>
            {t('pages.brandDetail.linkAppHint')
              .replace('{flag}', COUNTRY_EMOJI[brand.country as Country] ?? '')
              .replace('{country}', brand.country)}
          </p>
          <div className="form-group">
            <label className="form-label">{t('pages.brandDetail.appLabel')}</label>
            <select className="form-select" value={selectedAppId} onChange={e => setSelectedAppId(e.target.value)}>
              <option value="">{t('pages.brandDetail.appNone')}</option>
              {availableApps.map(a => (
                <option key={a.id} value={a.id}>{a.appName} ({a.appId})</option>
              ))}
            </select>
            {availableApps.length === 0 && (
              <p className="form-hint">
                {t('pages.brandDetail.noAppsYet').replace('{country}', brand.country)}{' '}
                <a href="/applications">{t('pages.brandsList.createOneArrow')}</a>
              </p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
