import { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import { brandsApi, shopsApi, tasksApi, taskTypesApi, applicationsApi, accountsApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
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
  const roles = account?.roles ?? [];
  const isAdmin = roles.some(r => r === 'admin' || r === 'super_admin');
  const isBpo   = roles.some(r => r === 'bpo') && !isAdmin;

  const [tab, setTab] = useState<'shops' | 'tasks'>('shops');

  // Start task modal
  const [openTask, setOpenTask] = useState(false);
  const [taskTypeId, setTaskTypeId] = useState('');
  const [savingTask, setSavingTask] = useState(false);

  // Edit brand modal
  const [openEdit, setOpenEdit] = useState(false);
  const [editForm, setEditForm] = useState({
    brandName: '', category: '',
    menuIntegration: '', pickingMode: '', paymentMode: '', kaType: '',
  });
  const [savingEdit, setSavingEdit] = useState(false);
  const [editErr, setEditErr] = useState('');

  // Change OP modal (admin only)
  const [openChangeOp, setOpenChangeOp] = useState(false);
  const [selectedOwnerId, setSelectedOwnerId] = useState('');
  const [savingOp, setSavingOp] = useState(false);

  // Change Application modal (admin only)
  const [openChangeApp, setOpenChangeApp] = useState(false);
  const [selectedAppId, setSelectedAppId] = useState('');
  const [savingApp, setSavingApp] = useState(false);

  // Batch status
  const [selectedShopIds, setSelectedShopIds] = useState<Set<string>>(new Set());
  const [batchStatus, setBatchStatus] = useState('');
  const [savingBatch, setSavingBatch] = useState(false);

  // Add shop — manual
  const [openAddShop, setOpenAddShop] = useState(false);
  const [shopMode, setShopMode] = useState<'manual' | 'batch'>('manual');
  const [shopForm, setShopForm] = useState({ shopId: '', appShopId: '', city: '', status: 'lead' });
  const [savingShop, setSavingShop] = useState(false);
  const [shopErr, setShopErr] = useState('');

  // Batch CSV
  const fileRef = useRef<HTMLInputElement>(null);
  const [batchRows, setBatchRows] = useState<{ shopId: string; appShopId: string; city: string; status: string; _err?: string }[]>([]);
  const [batchDone, setBatchDone] = useState(false);

  // ── Queries ───────────────────────────────────────────────────────────────

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

  // ── Derived permissions ───────────────────────────────────────────────────

  const isBpoOp = isBpo && !!brand && brand.owner?.id === account?.id;
  const canEdit = isAdmin || isBpoOp;
  const canAddShop = isAdmin || isBpo; // BPOs can add shops to any brand they work with

  // ── Handlers ─────────────────────────────────────────────────────────────

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
      setEditErr(Array.isArray(msg) ? msg.join(', ') : (msg ?? 'Error saving changes'));
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
      setShopErr(Array.isArray(msg) ? msg.join(', ') : (msg ?? 'Error creating shop'));
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
      setShopErr(Array.isArray(msg) ? msg.join(', ') : (msg ?? 'Error uploading shops'));
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
      <Topbar breadcrumb={[{ label: 'Brands', href: '/brands' }, { label: brand.brandName }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{brand.brandName}</h1>
            <p>{COUNTRY_EMOJI[brand.country]} {brand.country} · {brand.kaType}</p>
          </div>
          <div className="page-actions">
            {canEdit && (
              <button className="btn btn-ghost" onClick={openEditModal}>Edit Brand</button>
            )}
            <button className="btn btn-primary" onClick={() => setOpenTask(true)}>Start Task</button>
          </div>
        </div>

        {/* Stat cards */}
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 24 }}>
          <div className="stat-card">
            <div className="s-label">Brand ID</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem', fontWeight: 600, marginTop: 4 }}>{brand.brandId}</div>
          </div>

          <div className="stat-card">
            <div className="s-label">Owner (OP)</div>
            <div style={{ fontWeight: 600, marginTop: 4, fontSize: '0.9rem' }}>{brand.owner?.name ?? '—'}</div>
            <div className="s-meta">{brand.owner?.email ?? 'Unassigned'}</div>
            {isAdmin && (
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 6, fontSize: '0.72rem', padding: '2px 8px' }}
                onClick={() => { setSelectedOwnerId(brand.owner?.id ?? ''); setOpenChangeOp(true); }}
              >
                {brand.owner ? 'Change' : 'Assign'}
              </button>
            )}
          </div>

          <div className="stat-card">
            <div className="s-label">Application</div>
            <div style={{ fontWeight: 600, marginTop: 4, fontSize: '0.9rem' }}>
              {brand.application?.appName ?? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>None</span>}
            </div>
            {brand.application && <div className="s-meta td-mono">{brand.application.appId}</div>}
            {isAdmin && (
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 6, fontSize: '0.72rem', padding: '2px 8px' }}
                onClick={() => { setSelectedAppId(brand.application?.id ?? ''); setOpenChangeApp(true); }}
              >
                {brand.application ? 'Change' : 'Link'}
              </button>
            )}
          </div>

          <div className="stat-card">
            <div className="s-label">Shops</div>
            <div className="s-value">{shops.length}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">Tasks</div>
            <div className="s-value">{tasks.length}</div>
          </div>
        </div>

        {/* Brand detail row */}
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 24 }}>
          <div className="stat-card">
            <div className="s-label">Category</div>
            <div style={{ fontWeight: 500, marginTop: 4, fontSize: '0.88rem' }}>{brand.category ?? '—'}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">Menu Integration</div>
            <div style={{ fontWeight: 500, marginTop: 4, fontSize: '0.88rem' }}>{fmt(brand.menuIntegration)}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">Picking Mode</div>
            <div style={{ fontWeight: 500, marginTop: 4, fontSize: '0.88rem' }}>{fmt(brand.pickingMode)}</div>
          </div>
          <div className="stat-card">
            <div className="s-label">Payment Mode</div>
            <div style={{ fontWeight: 500, marginTop: 4, fontSize: '0.88rem' }}>{fmt(brand.paymentMode)}</div>
          </div>
        </div>

        {/* Tabs */}
        <div className="tabs">
          <div className={`tab ${tab === 'shops' ? 'active' : ''}`} onClick={() => setTab('shops')}>
            Shops ({shops.length})
          </div>
          <div className={`tab ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>
            Tasks ({tasks.length})
          </div>
        </div>

        {tab === 'shops' && (
          <>
            {/* Toolbar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              {selectedShopIds.size > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: 'var(--orange-muted)', borderRadius: 8, border: '1px solid rgba(255,105,0,0.2)' }}>
                  <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--orange)' }}>
                    {selectedShopIds.size} selected
                  </span>
                  <select
                    className="form-select"
                    style={{ margin: 0, padding: '4px 8px', fontSize: '0.82rem', height: 30, minWidth: 140 }}
                    value={batchStatus}
                    onChange={e => setBatchStatus(e.target.value)}
                  >
                    <option value="">Set status…</option>
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
                    {savingBatch ? 'Saving…' : 'Apply'}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ padding: '4px 10px', fontSize: '0.82rem' }}
                    onClick={() => setSelectedShopIds(new Set())}
                  >
                    Clear
                  </button>
                </div>
              )}
              <div style={{ marginLeft: 'auto' }}>
                {canAddShop && (
                  <button className="btn btn-primary" onClick={() => { setOpenAddShop(true); setShopMode('manual'); setBatchRows([]); setBatchDone(false); setShopErr(''); }}>
                    + Add Shop
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
                    <th>Shop ID</th><th>App Shop ID</th><th>City</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {shops.length === 0 && <tr><td colSpan={5}><div className="empty-state"><p>No shops for this brand.</p></div></td></tr>}
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
                <tr><th>Task Type</th><th>Status</th><th>Created</th></tr>
              </thead>
              <tbody>
                {tasks.length === 0 && <tr><td colSpan={3}><div className="empty-state"><p>No tasks yet.</p></div></td></tr>}
                {tasks.map(t => (
                  <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/tasks/${t.id}`)}>
                    <td style={{ fontWeight: 600 }}>{t.taskType?.name ?? '—'}</td>
                    <td><StatusBadge status={t.status} /></td>
                    <td className="text-muted text-sm">{new Date(t.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {/* Add Shop Modal */}
      {openAddShop && (
        <Modal
          title="Add Shop"
          onClose={() => setOpenAddShop(false)}
          footer={
            shopMode === 'manual' ? (
              <>
                <button className="btn btn-ghost" onClick={() => setOpenAddShop(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={handleAddShop} disabled={savingShop || !shopForm.shopId || !shopForm.appShopId}>
                  {savingShop ? 'Creating…' : 'Create Shop'}
                </button>
              </>
            ) : batchDone ? (
              <button className="btn btn-primary" onClick={() => setOpenAddShop(false)}>Done</button>
            ) : (
              <>
                <button className="btn btn-ghost" onClick={() => setOpenAddShop(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={handleBatchUpload} disabled={savingShop || batchRows.length === 0}>
                  {savingShop ? 'Uploading…' : `Upload ${batchRows.length} shop${batchRows.length !== 1 ? 's' : ''}`}
                </button>
              </>
            )
          }
        >
          {/* Mode toggle */}
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
                {m === 'manual' ? 'Manual' : 'Batch CSV'}
              </button>
            ))}
          </div>

          {shopErr && <div className="error-banner" style={{ marginBottom: 12 }}>{shopErr}</div>}

          {shopMode === 'manual' && (
            <>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Shop ID <span style={{ color: 'var(--red)' }}>*</span></label>
                  <input className="form-input" value={shopForm.shopId} placeholder="SHOP_001"
                    onChange={e => setShopForm(f => ({ ...f, shopId: e.target.value }))} autoFocus />
                </div>
                <div className="form-group">
                  <label className="form-label">App Shop ID <span style={{ color: 'var(--red)' }}>*</span></label>
                  <input className="form-input" value={shopForm.appShopId} placeholder="APP_001"
                    onChange={e => setShopForm(f => ({ ...f, appShopId: e.target.value }))} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">City</label>
                  <input className="form-input" value={shopForm.city} placeholder="Bogotá"
                    onChange={e => setShopForm(f => ({ ...f, city: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Status</label>
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
                Upload a CSV with columns: <code>shopId, appShopId, city, status</code>. Status defaults to <code>lead</code> if omitted.
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
                  {batchRows.length ? `${batchRows.length} rows loaded — click to replace` : 'Click to select CSV file'}
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
              <p style={{ fontWeight: 600 }}>{batchRows.length} shop{batchRows.length !== 1 ? 's' : ''} created successfully</p>
            </div>
          )}
        </Modal>
      )}

      {/* Edit Brand Modal */}
      {openEdit && (
        <Modal
          title="Edit Brand"
          onClose={() => setOpenEdit(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenEdit(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleEdit} disabled={savingEdit}>
              {savingEdit ? 'Saving…' : 'Save Changes'}
            </button>
          </>}
        >
          {editErr && <div className="error-banner">{editErr}</div>}

          <div className="form-group">
            <label className="form-label">Brand Name</label>
            <input className="form-input" value={editForm.brandName}
              onChange={e => setEditForm(f => ({ ...f, brandName: e.target.value }))} />
          </div>

          <div className="form-group">
            <label className="form-label">Category</label>
            <input className="form-input" placeholder="e.g. Burgers, Pizza…" value={editForm.category}
              onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))} />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Menu Integration</label>
              <select className="form-select" value={editForm.menuIntegration}
                onChange={e => setEditForm(f => ({ ...f, menuIntegration: e.target.value }))}>
                <option value="">—</option>
                {MENU_INTEGRATIONS.map(v => <option key={v} value={v}>{fmt(v)}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Picking Mode</label>
              <select className="form-select" value={editForm.pickingMode}
                onChange={e => setEditForm(f => ({ ...f, pickingMode: e.target.value }))}>
                <option value="">—</option>
                {PICKING_MODES.map(v => <option key={v} value={v}>{fmt(v)}</option>)}
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Payment Mode</label>
              <select className="form-select" value={editForm.paymentMode}
                onChange={e => setEditForm(f => ({ ...f, paymentMode: e.target.value }))}>
                <option value="">—</option>
                {PAYMENT_MODES.map(v => <option key={v} value={v}>{fmt(v)}</option>)}
              </select>
            </div>
            {isAdmin && (
              <div className="form-group">
                <label className="form-label">KA Type</label>
                <select className="form-select" value={editForm.kaType}
                  onChange={e => setEditForm(f => ({ ...f, kaType: e.target.value }))}>
                  {KA_TYPES.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Start Task Modal */}
      {openTask && (
        <Modal title="Start Task" onClose={() => setOpenTask(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenTask(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={createTask} disabled={savingTask || !taskTypeId}>
              {savingTask ? 'Creating…' : 'Start Task'}
            </button>
          </>}
        >
          <div className="form-group">
            <label className="form-label">Task Type</label>
            <select className="form-select" value={taskTypeId} onChange={e => setTaskTypeId(e.target.value)}>
              <option value="">Select a task type…</option>
              {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        </Modal>
      )}

      {/* Change OP Modal (admin only) */}
      {openChangeOp && (
        <Modal
          title="Change Owner (OP)"
          onClose={() => setOpenChangeOp(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenChangeOp(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleChangeOp} disabled={savingOp}>
              {savingOp ? 'Saving…' : 'Save'}
            </button>
          </>}
        >
          <p className="text-muted text-sm" style={{ marginBottom: 14 }}>
            Manual assignment — overrides the automatic assignment rule.
          </p>
          <div className="form-group">
            <label className="form-label">BPO / Owner</label>
            <select className="form-select" value={selectedOwnerId} onChange={e => setSelectedOwnerId(e.target.value)}>
              <option value="">Unassigned</option>
              {bpos.map(b => (
                <option key={b.id} value={b.id}>{b.name} — {b.email}</option>
              ))}
            </select>
          </div>
        </Modal>
      )}

      {/* Link Application Modal (admin only) */}
      {openChangeApp && (
        <Modal
          title="Link Application"
          onClose={() => setOpenChangeApp(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenChangeApp(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleChangeApp} disabled={savingApp}>
              {savingApp ? 'Saving…' : 'Save'}
            </button>
          </>}
        >
          <p className="text-muted text-sm" style={{ marginBottom: 14 }}>
            Only applications for {COUNTRY_EMOJI[brand.country as Country]} {brand.country} are shown.
          </p>
          <div className="form-group">
            <label className="form-label">Application</label>
            <select className="form-select" value={selectedAppId} onChange={e => setSelectedAppId(e.target.value)}>
              <option value="">None</option>
              {availableApps.map(a => (
                <option key={a.id} value={a.id}>{a.appName} ({a.appId})</option>
              ))}
            </select>
            {availableApps.length === 0 && (
              <p className="form-hint">No applications for {brand.country} yet. <a href="/applications">Create one →</a></p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
