import { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import Paginator from '../../components/ui/Paginator';
import { brandsApi, shopsApi, tasksApi, taskTypesApi, applicationsApi, accountsApi, appConfigApi } from '../../api';
import type { AppConfigOption } from '../../types';
import { useAuth } from '../../auth/AuthContext';
import { useT } from '../../i18n';
import type { Brand, BrandItem, BrandMenuCategory, BrandPromotion, Shop, Task, TaskType, Paginated, Application, Country } from '../../types';

const COUNTRY_EMOJI: Record<string, string> = { MX: '🇲🇽', CO: '🇨🇴', CR: '🇨🇷' };

const MENU_INTEGRATIONS = ['api', 'api_whitelist', 'sftp', 'spreadsheets', 'bapp'];
const PICKING_MODES     = ['merchant_picking_bapp', 'merchant_picking_dapp', 'dos_en_uno'];
const PAYMENT_MODES     = ['food_mode', 'prepaid_card', 'qr_code'];
const KA_TYPES          = ['KA', 'CKA', 'SME'];

function fmt(val?: string | null) {
  if (!val) return '—';
  return val.replace(/_/g, ' ');
}

function safeExternalUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function apiErrorMessage(error: unknown, fallback: string) {
  const response = error as { response?: { data?: { message?: string | string[] } } };
  const message = response.response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : message ?? fallback;
}

function promotionMechanics(promotion: BrandPromotion) {
  const values = [
    promotion.discountAmount ? `Monto: ${promotion.discountAmount}` : '',
    promotion.discountPercentage ? `%: ${promotion.discountPercentage}` : '',
    promotion.buyNum || promotion.getNum ? `Compra ${promotion.buyNum ?? '—'} / recibe ${promotion.getNum ?? '—'}` : '',
    promotion.bxgyX || promotion.bxgyY ? `BXGY ${promotion.bxgyX ?? '—'} / ${promotion.bxgyY ?? '—'}` : '',
  ].filter(Boolean);
  return values.join(' · ') || '—';
}

interface ShopBatchRow {
  shopId: string;
  appShopId: string;
  city: string;
  status: string;
  _err?: string;
}

const SHOP_IMPORT_STATUSES = new Set(['lead', 'application', 'integrated', 'online']);

function parseCsvTable(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      row.push(field.trim());
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index++;
      row.push(field.trim());
      if (row.some(value => value.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  row.push(field.trim());
  if (row.some(value => value.length > 0)) rows.push(row);
  if (quoted) throw new Error('CSV contains an unclosed quoted value');
  return rows;
}

function parseShopImportCsv(text: string): ShopBatchRow[] {
  const table = parseCsvTable(text);
  if (table.length === 0) throw new Error('CSV is empty');
  const header = table[0].map(value => value.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const column = (...names: string[]) => names.map(name => header.indexOf(name)).find(index => index >= 0) ?? -1;
  const shopIdIndex = column('shopid', 'shop_id');
  const appShopIdIndex = column('appshopid', 'app_shop_id');
  const cityIndex = column('city', 'ciudad');
  const statusIndex = column('status', 'estado');
  if (shopIdIndex < 0 || appShopIdIndex < 0) {
    throw new Error('CSV must include shopId and appShopId columns');
  }

  const rows = table.slice(1).map(values => {
    const status = (statusIndex >= 0 ? values[statusIndex] : '').trim().toLowerCase() || 'lead';
    return {
      shopId: values[shopIdIndex]?.trim() ?? '',
      appShopId: values[appShopIdIndex]?.trim() ?? '',
      city: cityIndex >= 0 ? values[cityIndex]?.trim() ?? '' : '',
      status,
    };
  });
  const shopIdCounts = new Map<string, number>();
  const appShopIdCounts = new Map<string, number>();
  for (const row of rows) {
    shopIdCounts.set(row.shopId, (shopIdCounts.get(row.shopId) ?? 0) + 1);
    appShopIdCounts.set(row.appShopId, (appShopIdCounts.get(row.appShopId) ?? 0) + 1);
  }
  return rows.map(row => {
    const errors = [
      !row.shopId ? 'shopId is required' : '',
      !row.appShopId ? 'appShopId is required' : '',
      row.status && !SHOP_IMPORT_STATUSES.has(row.status) ? `invalid status: ${row.status}` : '',
      row.shopId && (shopIdCounts.get(row.shopId) ?? 0) > 1 ? 'duplicated shopId' : '',
      row.appShopId && (appShopIdCounts.get(row.appShopId) ?? 0) > 1 ? 'duplicated appShopId' : '',
    ].filter(Boolean);
    return { ...row, _err: errors.join('; ') || undefined };
  });
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

  const [tab, setTab] = useState<'shops' | 'menu' | 'promotions' | 'tasks'>('shops');
  const [menuPage, setMenuPage] = useState(1);
  const [menuSearch, setMenuSearch] = useState('');
  const [promotionPage, setPromotionPage] = useState(1);
  const [promotionSearch, setPromotionSearch] = useState('');
  const [promotionShopId, setPromotionShopId] = useState('');
  const [promotionActivityType, setPromotionActivityType] = useState('');
  const [openTask, setOpenTask] = useState(false);
  const [taskTypeId, setTaskTypeId] = useState('');
  const [savingTask, setSavingTask] = useState(false);
  const [taskErr, setTaskErr] = useState('');
  const [openEdit, setOpenEdit] = useState(false);
  const [editForm, setEditForm] = useState({
    brandId: '', brandName: '', category: '',
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
  const [downloadingShopTemplate, setDownloadingShopTemplate] = useState(false);
  const [shopErr, setShopErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [batchRows, setBatchRows] = useState<ShopBatchRow[]>([]);
  const [batchDone, setBatchDone] = useState(false);
  const [openMenuCategories, setOpenMenuCategories] = useState(false);
  const [menuCategoryText, setMenuCategoryText] = useState('');
  const [savingMenuCategories, setSavingMenuCategories] = useState(false);
  const [menuCategoryError, setMenuCategoryError] = useState('');

  const { data: brand, refetch: refetchBrand } = useQuery<Brand>({
    queryKey: ['brand', id],
    queryFn: () => brandsApi.get(id!).then(r => r.data),
  });

  const { data: shopsResult } = useQuery<Paginated<Shop>>({
    queryKey: ['shops', { brandId: id, limit: 10000 }],
    queryFn: () => shopsApi.list({ brandId: id, limit: 10000 }).then(r => r.data as Paginated<Shop>),
  });

  const { data: tasksResult } = useQuery<Paginated<Task>>({
    queryKey: ['tasks', { brandId: id, limit: 100 }],
    queryFn: () => tasksApi.list({ brandId: id, limit: 100 }).then(r => r.data as Paginated<Task>),
  });

  const shops = shopsResult?.data ?? [];
  const tasks = tasksResult?.data ?? [];

  const { data: menuResult, isLoading: loadingMenu } = useQuery<Paginated<BrandItem> & { shopsWithMenu: number; lastSyncedAt?: string }>({
    queryKey: ['brand-menu', id, menuPage, menuSearch],
    queryFn: () => brandsApi.menu(id!, { page: menuPage, limit: 50, q: menuSearch || undefined }).then(r => r.data),
    enabled: tab === 'menu',
  });
  const menuItems = menuResult?.data ?? [];
  const { data: menuCategories = [] } = useQuery<BrandMenuCategory[]>({
    queryKey: ['brand-menu-categories', id],
    queryFn: () => brandsApi.menuCategories(id!).then(response => response.data as BrandMenuCategory[]),
    enabled: tab === 'menu',
  });

  const { data: promotionResult, isLoading: loadingPromotions } = useQuery<Paginated<BrandPromotion> & { storesWithPromotions: number; lastFetchedAt?: string }>({
    queryKey: ['brand-promotions', id, promotionPage, promotionSearch, promotionShopId, promotionActivityType],
    queryFn: () => brandsApi.promotions(id!, {
      page: promotionPage,
      limit: 50,
      q: promotionSearch || undefined,
      shopExternalId: promotionShopId || undefined,
      activityType: promotionActivityType || undefined,
    }).then(r => r.data),
    enabled: tab === 'promotions',
  });
  const promotions = promotionResult?.data ?? [];

  const { data: typesResult } = useQuery<Paginated<TaskType>>({
    queryKey: ['task-types'],
    queryFn: () => taskTypesApi.catalog({ page: 1, limit: 200 }).then(r => r.data as Paginated<TaskType>),
  });
  const types = (typesResult?.data ?? []).filter(type => type.active);
  const brandPromotionTaskType = types.find(type => type.name === 'Download Brand Promotions Information');

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

  const { data: bizCategories = [] } = useQuery<AppConfigOption[]>({
    queryKey: ['app-config', 'biz_category'],
    queryFn: () => appConfigApi.byCategory('biz_category').then(r => r.data as AppConfigOption[]),
    enabled: openEdit,
  });

  const isBpoOp = isBpo && !!brand && brand.owner?.id === account?.id;
  const canEdit = isAdmin || isBpoOp;
  const canAddShop = isAdmin || isBpo;

  const createTask = async () => {
    if (!taskTypeId) return;
    setSavingTask(true); setTaskErr('');
    try {
      const res = await tasksApi.create({ taskTypeId, brandId: id });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      setOpenTask(false);
      nav(`/tasks/${res.data.id}`);
    } catch (ex: unknown) {
      const e = ex as { response?: { data?: { message?: string | string[] } } };
      const msg = e.response?.data?.message;
      setTaskErr(Array.isArray(msg) ? msg.join(', ') : (msg ?? 'Could not create task'));
    } finally { setSavingTask(false); }
  };

  const openEditModal = () => {
    if (!brand) return;
    setEditForm({
      brandId:         brand.brandId ?? '',
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
      if (editForm.kaType) payload.kaType = editForm.kaType;
      if (isAdmin && editForm.brandId) payload.brandId = editForm.brandId;
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
      if (next.has(shopId)) next.delete(shopId);
      else next.add(shopId);
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
      qc.invalidateQueries({ queryKey: ['shops', { brandId: id, limit: 10000 }] });
      setSelectedShopIds(new Set());
      setBatchStatus('');
    } finally { setSavingBatch(false); }
  };

  const handleAddShop = async () => {
    setSavingShop(true); setShopErr('');
    try {
      await shopsApi.create({ ...shopForm, brandId: id, status: shopForm.status || 'lead' });
      qc.invalidateQueries({ queryKey: ['shops', { brandId: id, limit: 10000 }] });
      setOpenAddShop(false);
      setShopForm({ shopId: '', appShopId: '', city: '', status: 'lead' });
    } catch (ex: unknown) {
      const e = ex as { response?: { data?: { message?: string | string[] } } };
      const msg = e.response?.data?.message;
      setShopErr(Array.isArray(msg) ? msg.join(', ') : (msg ?? t('pages.brandDetail.errorCreatingShop')));
    } finally { setSavingShop(false); }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const rows = parseShopImportCsv(ev.target?.result as string);
        setBatchRows(rows);
        setBatchDone(false);
        setShopErr(rows.length === 0 ? 'CSV does not contain store rows' : '');
      } catch (error) {
        setBatchRows([]);
        setBatchDone(false);
        setShopErr((error as Error).message);
      }
      if (fileRef.current) fileRef.current.value = '';
    };
    reader.readAsText(file);
  };

  const handleDownloadShopTemplate = async () => {
    setDownloadingShopTemplate(true); setShopErr('');
    try {
      const response = await shopsApi.downloadImportTemplate();
      const url = URL.createObjectURL(response.data as Blob);
      const disposition = String(response.headers['content-disposition'] ?? '');
      const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? 'shop-import-template.csv';
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setShopErr(apiErrorMessage(error, t('pages.brandDetail.errorUploadingShops')));
    } finally {
      setDownloadingShopTemplate(false);
    }
  };

  const handleBatchUpload = async () => {
    if (!batchRows.length) return;
    setSavingShop(true); setShopErr('');
    try {
      await shopsApi.createBatch(batchRows.map(row => ({
        shopId: row.shopId,
        appShopId: row.appShopId,
        city: row.city || undefined,
        status: row.status || 'lead',
        brandId: id,
      })));
      qc.invalidateQueries({ queryKey: ['shops', { brandId: id, limit: 10000 }] });
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

  const openMenuCategoryEditor = () => {
    setMenuCategoryText(menuCategories.map(category => `${category.categoryId} | ${category.name}`).join('\n'));
    setMenuCategoryError('');
    setOpenMenuCategories(true);
  };

  const saveMenuCategories = async () => {
    const rows = menuCategoryText.split(/\r?\n/).map(row => row.trim()).filter(Boolean);
    const categories = rows.map((row, order) => {
      const separator = row.indexOf('|');
      if (separator < 1) throw new Error(`Line ${order + 1}: use category_id | Category name`);
      return { categoryId: row.slice(0, separator).trim(), name: row.slice(separator + 1).trim(), order, active: true };
    });
    if (!categories.length) throw new Error('Add at least one category');
    setSavingMenuCategories(true);
    setMenuCategoryError('');
    try {
      await brandsApi.replaceMenuCategories(id!, categories);
      await qc.invalidateQueries({ queryKey: ['brand-menu-categories', id] });
      setOpenMenuCategories(false);
    } catch (error) {
      setMenuCategoryError(apiErrorMessage(error, 'Could not save menu categories'));
    } finally {
      setSavingMenuCategories(false);
    }
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
            <button className="btn btn-primary" onClick={() => { setTaskTypeId(''); setTaskErr(''); setOpenTask(true); }}>{t('pages.brandDetail.startTask')}</button>
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
          <div className={`tab ${tab === 'menu' ? 'active' : ''}`} onClick={() => setTab('menu')}>
            Menu ({menuResult?.total ?? '—'})
          </div>
          <div className={`tab ${tab === 'promotions' ? 'active' : ''}`} onClick={() => setTab('promotions')}>
            Promotions ({promotionResult?.total ?? '—'})
          </div>
        </div>

        {tab === 'shops' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              {selectedShopIds.size > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: 'var(--orange-muted)', borderRadius: 8, border: '1px solid rgba(255,105,0,0.2)' }}>
                  <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--orange-dark)' }}>
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
                    <th>Nombre</th>
                    <th>{t('pages.brandDetail.colCity')}</th>
                    <th>Coordenadas</th>
                    <th>{t('pages.brandDetail.colStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shops.length === 0 && <tr><td colSpan={7}><div className="empty-state"><p>{t('pages.brandDetail.noShops')}</p></div></td></tr>}
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
                      <td onClick={() => nav(`/shops/${s.id}`)}>{s.name ?? '—'}</td>
                      <td onClick={() => nav(`/shops/${s.id}`)}>{s.city ?? '—'}</td>
                      <td className="td-mono" title={s.address}>{s.latitude && s.longitude ? `${s.latitude}, ${s.longitude}` : '—'}</td>
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

        {tab === 'menu' && (
          <>
            <div className="card" style={{ marginBottom: 14, padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>Commercial upload categories</div>
                  <p className="form-hint" style={{ marginTop: 3 }}>These are the only categories available in the generated Commercial Grocery Menu Upload template.</p>
                </div>
                {isAdmin && <button className="btn btn-ghost btn-sm" onClick={openMenuCategoryEditor}>Configure</button>}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                {menuCategories.map(category => <span className="badge" key={category.id}>{category.categoryId} · {category.name}</span>)}
                {!menuCategories.length && <span className="text-muted text-sm">No categories configured. The commercial template cannot be generated yet.</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
              <input
                className="form-input"
                style={{ maxWidth: 420, margin: 0 }}
                value={menuSearch}
                onChange={event => { setMenuSearch(event.target.value); setMenuPage(1); }}
                placeholder="Buscar por nombre, UPC, appItemId, ciudad o tienda fuente…"
              />
              <span className="text-muted text-sm">
                {menuResult?.shopsWithMenu ?? 0}/{shops.length} tiendas con menú
                {menuResult?.lastSyncedAt ? ` · Última descarga ${new Date(menuResult.lastSyncedAt).toLocaleString()}` : ''}
              </span>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Imagen</th><th>Nombre</th><th>UPC</th><th>appItemId</th><th>Ciudad fuente</th><th>Tienda fuente</th><th>Actualizado</th></tr></thead>
                <tbody>
                  {loadingMenu && <tr><td colSpan={7} className="text-muted">Cargando menú…</td></tr>}
                  {!loadingMenu && menuItems.length === 0 && <tr><td colSpan={7}><div className="empty-state"><p>No hay artículos almacenados para esta marca.</p></div></td></tr>}
                  {menuItems.map(item => {
                    const imageUrl = safeExternalUrl(item.imageUrl);
                    return (
                    <tr key={item.id}>
                      <td>
                        {imageUrl ? (
                          <a href={imageUrl} target="_blank" rel="noopener noreferrer" title={imageUrl} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <img src={imageUrl} alt={item.name} loading="lazy" style={{ width: 48, height: 48, objectFit: 'contain', borderRadius: 6, border: '1px solid var(--border)' }} />
                            <span className="text-sm">Abrir</span>
                          </a>
                        ) : '—'}
                      </td>
                      <td style={{ fontWeight: 600 }}>{item.name}</td>
                      <td className="td-mono">{item.upc ?? '—'}</td>
                      <td className="td-mono">{item.appItemId}</td>
                      <td>{item.sourceCity ?? '—'}</td>
                      <td className="td-mono">{item.sourceShopId ?? '—'}</td>
                      <td className="text-muted text-sm">{new Date(item.lastSeenAt).toLocaleString()}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              <Paginator page={menuPage} total={menuResult?.total ?? 0} limit={50} onChange={setMenuPage} />
            </div>
          </>
        )}
        {tab === 'promotions' && (
          <>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
              <input
                className="form-input"
                style={{ maxWidth: 360, margin: 0 }}
                value={promotionSearch}
                onChange={event => { setPromotionSearch(event.target.value); setPromotionPage(1); }}
                placeholder="Buscar tienda, actividad, UPC/SKU o archivo…"
              />
              <select
                className="form-select"
                style={{ width: 280, margin: 0 }}
                value={promotionShopId}
                onChange={event => { setPromotionShopId(event.target.value); setPromotionPage(1); }}
              >
                <option value="">Todas las tiendas</option>
                {shops.map(shop => (
                  <option key={shop.id} value={shop.appShopId}>
                    {shop.shopId} · {shop.name ?? shop.appShopId}
                  </option>
                ))}
              </select>
              <input
                className="form-input"
                style={{ width: 180, margin: 0 }}
                type="number"
                min="0"
                value={promotionActivityType}
                onChange={event => { setPromotionActivityType(event.target.value); setPromotionPage(1); }}
                placeholder="Tipo de actividad"
              />
              <span className="text-muted text-sm">
                {promotionResult?.storesWithPromotions ?? 0} tiendas con promociones
                {promotionResult?.lastFetchedAt ? ` · Última lectura ${new Date(promotionResult.lastFetchedAt).toLocaleString()}` : ''}
              </span>
              <button
                className="btn btn-primary"
                style={{ marginLeft: 'auto' }}
                disabled={!brandPromotionTaskType}
                title={brandPromotionTaskType ? 'Crear tarea de exportación' : 'El tipo de tarea todavía no está disponible'}
                onClick={() => {
                  if (!brandPromotionTaskType) return;
                  setTaskTypeId(brandPromotionTaskType.id);
                  setTaskErr('');
                  setOpenTask(true);
                }}
              >
                Descargar promociones
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tienda</th><th>Actividad</th><th>UPC / SKU</th><th>Vigencia</th><th>Tipo</th>
                    <th>Mecánica</th><th>Acción</th><th>Cuenta SFTP</th><th>Actualizado</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingPromotions && <tr><td colSpan={9} className="text-muted">Cargando promociones…</td></tr>}
                  {!loadingPromotions && promotions.length === 0 && (
                    <tr><td colSpan={9}><div className="empty-state"><p>No hay promociones almacenadas para esta marca.</p></div></td></tr>
                  )}
                  {promotions.map(promotion => (
                    <tr key={promotion.id} title={`Archivo: ${promotion.sourceFile}`}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{promotion.shop?.name ?? promotion.shop?.shopId ?? promotion.shopExternalId}</div>
                        <div className="td-mono text-muted text-sm">{promotion.shop?.shopId ?? 'Sin Shop ID'} · {promotion.shopExternalId}</div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{promotion.activityName ?? '—'}</div>
                        <div className="td-mono text-muted text-sm">{promotion.activityId}</div>
                      </td>
                      <td className="td-mono">{promotion.sku}</td>
                      <td className="text-sm">{promotion.startDate ?? '—'}<br />{promotion.endDate ?? '—'}</td>
                      <td>{promotion.activityType ?? '—'}</td>
                      <td className="text-sm" style={{ maxWidth: 300 }}>{promotionMechanics(promotion)}</td>
                      <td>{promotion.actionType ?? '—'}</td>
                      <td>{promotion.sourceAccount}</td>
                      <td className="text-muted text-sm">{new Date(promotion.fetchedAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Paginator page={promotionPage} total={promotionResult?.total ?? 0} limit={50} onChange={setPromotionPage} />
            </div>
          </>
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
                <button className="btn btn-primary" onClick={handleBatchUpload} disabled={savingShop || batchRows.length === 0 || batchRows.some(row => !!row._err)}>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', marginBottom: 10 }}>
                <p className="form-hint" style={{ margin: 0 }}>{t('pages.brandDetail.batchHint')}</p>
                <button type="button" className="btn btn-ghost btn-sm" disabled={downloadingShopTemplate} onClick={handleDownloadShopTemplate}>
                  {downloadingShopTemplate ? t('pages.brandDetail.downloadingShopTemplate') : t('pages.brandDetail.downloadShopTemplate')}
                </button>
              </div>
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
                        {['shopId', 'appShopId', 'city', 'status', 'validation'].map(h => (
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
                          <td style={{ padding: '5px 10px', color: r._err ? 'var(--red)' : 'var(--text-muted)' }}>{r._err ?? 'OK'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {batchRows.some(row => !!row._err) && (
                <div className="error-banner" style={{ marginTop: 10 }}>
                  {batchRows.filter(row => !!row._err).length} invalid row(s). Correct the CSV before uploading.
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

      {openMenuCategories && (
        <Modal
          title="Configure commercial menu categories"
          onClose={() => setOpenMenuCategories(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenMenuCategories(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => saveMenuCategories().catch(error => setMenuCategoryError((error as Error).message))} disabled={savingMenuCategories}>
              {savingMenuCategories ? 'Saving…' : 'Save categories'}
            </button>
          </>}
        >
          {menuCategoryError && <div className="error-banner" style={{ marginBottom: 12 }}>{menuCategoryError}</div>}
          <p className="form-hint" style={{ marginBottom: 10 }}>One category per line. Maximum 30. Format: <strong>category_id | Category name</strong>.</p>
          <textarea className="form-input" rows={12} value={menuCategoryText} onChange={event => setMenuCategoryText(event.target.value)} placeholder={'bebidas | Bebidas\nsnacks | Snacks'} />
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

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{t('pages.brandDetail.brandNameLabel')}</label>
              <input className="form-input" value={editForm.brandName}
                onChange={e => setEditForm(f => ({ ...f, brandName: e.target.value }))} />
            </div>
            {isAdmin && (
              <div className="form-group">
                <label className="form-label">Brand ID <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>(DiDi)</span></label>
                <input className="form-input" value={editForm.brandId}
                  onChange={e => setEditForm(f => ({ ...f, brandId: e.target.value }))} />
              </div>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">{t('pages.brandDetail.categoryLabel')}</label>
            <select className="form-select" value={editForm.category}
              onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))}>
              <option value="">{t('pages.brandDetail.categoryPlaceholder')}</option>
              {bizCategories.filter(c => c.active).map(c => (
                <option key={c.id} value={c.value}>{c.label}</option>
              ))}
            </select>
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
            <div className="form-group">
              <label className="form-label">{t('pages.brandDetail.kaTypeLabel')}</label>
              <select className="form-select" value={editForm.kaType}
                onChange={e => setEditForm(f => ({ ...f, kaType: e.target.value }))}>
                {KA_TYPES.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
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
          {taskErr && <div className="error-banner" style={{ marginBottom: 12 }}>{taskErr}</div>}
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
