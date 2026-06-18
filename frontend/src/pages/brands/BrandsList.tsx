import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import Paginator from '../../components/ui/Paginator';
import { brandsApi, applicationsApi, webhooksApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useT } from '../../i18n';
import type { Brand, Country, KaType, MenuIntegration, PickingMode, PaymentMode, Paginated, Application, Webhook } from '../../types';

const COUNTRIES: Country[] = ['MX', 'CO', 'CR'];
const KA_TYPES: KaType[] = ['KA', 'CKA', 'SME'];
const MENU_INTEGRATIONS: MenuIntegration[] = ['api', 'api_whitelist', 'sftp', 'spreadsheets', 'bapp'];
const PICKING_MODES: PickingMode[] = ['merchant_picking_bapp', 'merchant_picking_dapp', 'dos_en_uno'];
const PAYMENT_MODES: PaymentMode[] = ['food_mode', 'prepaid_card', 'qr_code'];
const LIMIT = 25;

const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);
const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);
const XIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="12" height="12">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

const COUNTRY_EMOJI: Record<Country, string> = { MX: '🇲🇽', CO: '🇨🇴', CR: '🇨🇷' };
const KA_STYLE: Record<KaType, { background: string; color: string }> = {
  KA:  { background: 'var(--orange-muted)', color: 'var(--orange-dark)' },
  CKA: { background: 'var(--blue-bg)',      color: 'var(--blue)'       },
  SME: { background: 'var(--green-bg)',     color: '#027A48'           },
};

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px 2px 10px', borderRadius: 999,
      background: 'var(--orange)', color: '#fff',
      fontSize: '0.72rem', fontWeight: 600,
    }}>
      {label}
      <button onClick={onRemove} style={{
        background: 'none', border: 'none', cursor: 'pointer', color: '#fff',
        padding: 0, display: 'flex', alignItems: 'center', opacity: 0.8,
      }}>
        <XIcon />
      </button>
    </span>
  );
}

function pill(val?: string | null) {
  if (!val) return <span className="text-muted">—</span>;
  return <span style={{ fontSize: '0.7rem', padding: '1px 7px', borderRadius: 999, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>{val.replace(/_/g, ' ')}</span>;
}

export default function BrandsList() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { account } = useAuth();
  const t = useT();
  const isBpo = account?.roles.includes('bpo') && !account?.roles.includes('admin') && !account?.roles.includes('super_admin');
  const isAdmin = account?.roles.includes('admin') || account?.roles.includes('super_admin');
  const canCreateBrand = isAdmin || (isBpo && (account?.bpoPermissions ?? []).includes('create_brand'));
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(1);
  const [myBrands, setMyBrands] = useState(false);
  const [countryF, setCountryF] = useState<Country | ''>('');
  const [kaF, setKaF]           = useState<KaType | ''>('');
  const [menuF, setMenuF]       = useState<MenuIntegration | ''>('');
  const [pickF, setPickF]       = useState<PickingMode | ''>('');
  const [payF, setPayF]         = useState<PaymentMode | ''>();
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({
    brandId: '', brandName: '',
    country: 'MX' as Country,
    kaType: 'KA' as KaType,
    menuIntegration: '' as MenuIntegration | '',
    pickingMode: '' as PickingMode | '',
    paymentMode: '' as PaymentMode | '',
    applicationId: '',
    webhookIds: [] as string[],
  });

  const { data: applications = [] } = useQuery<Application[]>({
    queryKey: ['applications', { limit: 100 }],
    queryFn: () => applicationsApi.list({ limit: 100 }).then(r => (r.data as { data: Application[] }).data),
    enabled: open,
  });
  const { data: allWebhooks = [] } = useQuery<Webhook[]>({
    queryKey: ['webhooks'],
    queryFn: () => webhooksApi.list().then(r => r.data),
    enabled: open,
  });

  const appsForCountry = applications.filter(a => a.country === form.country);

  useEffect(() => {
    const timer = setTimeout(() => { setDq(q); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  const go = (fn: () => void) => () => { fn(); setPage(1); };

  const params = {
    page, limit: LIMIT,
    ...(dq       && { q: dq }),
    ...(countryF && { country: countryF }),
    ...(kaF      && { kaType: kaF }),
    ...(menuF    && { menuIntegration: menuF }),
    ...(pickF    && { pickingMode: pickF }),
    ...(payF     && { paymentMode: payF }),
    ...(myBrands && { myBrands: true }),
  };

  const { data: result, isLoading } = useQuery<Paginated<Brand>>({
    queryKey: ['brands', params],
    queryFn: () => brandsApi.list(params).then(r => r.data),
  });

  const brands = result?.data ?? [];
  const total  = result?.total ?? 0;

  const resetForm = () => setForm({
    brandId: '', brandName: '', country: 'MX', kaType: 'KA',
    menuIntegration: '', pickingMode: '', paymentMode: '',
    applicationId: '', webhookIds: [],
  });

  const toggleWebhook = (id: string) =>
    setForm(f => ({
      ...f,
      webhookIds: f.webhookIds.includes(id) ? f.webhookIds.filter(w => w !== id) : [...f.webhookIds, id],
    }));

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      const payload = {
        brandId: form.brandId,
        brandName: form.brandName,
        country: form.country,
        kaType: form.kaType,
        ...(form.menuIntegration && { menuIntegration: form.menuIntegration }),
        ...(form.pickingMode     && { pickingMode: form.pickingMode }),
        ...(form.paymentMode     && { paymentMode: form.paymentMode }),
        ...(form.applicationId   && { applicationId: form.applicationId }),
        ...(form.webhookIds.length && { webhookIds: form.webhookIds }),
      };
      await brandsApi.create(payload);
      qc.invalidateQueries({ queryKey: ['brands'] });
      setOpen(false);
      resetForm();
    } catch (ex: unknown) {
      const e2 = ex as { response?: { data?: { message?: string } } };
      setErr(Array.isArray(e2.response?.data?.message) ? (e2.response!.data!.message as unknown as string[]).join(', ') : (e2.response?.data?.message ?? 'Error'));
    } finally { setSaving(false); }
  };

  const anyFilter = countryF || kaF || menuF || pickF || payF;
  const clearFilters = () => { setCountryF(''); setKaF(''); setMenuF(''); setPickF(''); setPayF(''); setMyBrands(false); setPage(1); };

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.brands') }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{t('pages.brandsList.title')}</h1>
            <p>{anyFilter ? t('pages.brandsList.subtitleFiltered').replace('{total}', String(total)) : t('pages.brandsList.subtitle').replace('{total}', String(total))}</p>
          </div>
          <div className="page-actions">
            {isBpo && (
              <button
                className={`btn ${myBrands ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => { setMyBrands(m => !m); setPage(1); }}
              >
                {t('pages.brandsList.myBrands')}
              </button>
            )}
            {canCreateBrand && (
              <button className="btn btn-primary" onClick={() => setOpen(true)}>
                <PlusIcon /> {t('pages.brandsList.newBrand')}
              </button>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <div className="search-wrap">
              <SearchIcon />
              <input placeholder={t('pages.brandsList.searchPlaceholder')} value={q} onChange={e => setQ(e.target.value)} />
            </div>
            {anyFilter && (
              <button className="btn btn-ghost btn-sm" onClick={clearFilters}
                style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)' }}>
                <XIcon /> {t('pages.brandsList.clearFilters')}
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select className="form-select" style={{ flex: '0 0 auto', minWidth: 120 }} value={countryF}
              onChange={e => go(() => setCountryF(e.target.value as Country | ''))()}>
              <option value="">{t('pages.brandsList.allCountries')}</option>
              {COUNTRIES.map(c => <option key={c} value={c}>{COUNTRY_EMOJI[c]} {c}</option>)}
            </select>
            <select className="form-select" style={{ flex: '0 0 auto', minWidth: 120 }} value={kaF}
              onChange={e => go(() => setKaF(e.target.value as KaType | ''))()}>
              <option value="">{t('pages.brandsList.allTypes')}</option>
              {KA_TYPES.map(k => <option key={k} value={k}>{k}</option>)}
            </select>
            <select className="form-select" style={{ flex: '0 0 auto', minWidth: 150 }} value={menuF}
              onChange={e => go(() => setMenuF(e.target.value as MenuIntegration | ''))()}>
              <option value="">{t('pages.brandsList.allMenus')}</option>
              {MENU_INTEGRATIONS.map(m => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}
            </select>
            <select className="form-select" style={{ flex: '0 0 auto', minWidth: 180 }} value={pickF}
              onChange={e => go(() => setPickF(e.target.value as PickingMode | ''))()}>
              <option value="">{t('pages.brandsList.allPickingModes')}</option>
              {PICKING_MODES.map(p => <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>)}
            </select>
            <select className="form-select" style={{ flex: '0 0 auto', minWidth: 160 }} value={payF}
              onChange={e => go(() => setPayF(e.target.value as PaymentMode | ''))()}>
              <option value="">{t('pages.brandsList.allPayments')}</option>
              {PAYMENT_MODES.map(p => <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>)}
            </select>
          </div>

          {anyFilter && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {countryF && <FilterChip label={`${COUNTRY_EMOJI[countryF]} ${countryF}`} onRemove={go(() => setCountryF(''))} />}
              {kaF      && <FilterChip label={kaF} onRemove={go(() => setKaF(''))} />}
              {menuF    && <FilterChip label={menuF.replace(/_/g, ' ')} onRemove={go(() => setMenuF(''))} />}
              {pickF    && <FilterChip label={pickF.replace(/_/g, ' ')} onRemove={go(() => setPickF(''))} />}
              {payF     && <FilterChip label={payF.replace(/_/g, ' ')} onRemove={go(() => setPayF(''))} />}
            </div>
          )}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('pages.brandsList.colBrand')}</th>
                <th>{t('pages.brandsList.colId')}</th>
                <th>{t('pages.brandsList.colCountry')}</th>
                <th>{t('pages.brandsList.colType')}</th>
                <th>{t('pages.brandsList.colMenu')}</th>
                <th>{t('pages.brandsList.colPicking')}</th>
                <th>{t('pages.brandsList.colPayment')}</th>
                <th>{t('pages.brandsList.colOp')}</th>
                <th>{t('pages.brandsList.colShops')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={9} style={{ padding: '20px 16px', color: 'var(--text-muted)' }}>{t('common.loading')}</td></tr>
              )}
              {!isLoading && brands.length === 0 && (
                <tr><td colSpan={9}>
                  <div className="empty-state">
                    <h3>{t('pages.brandsList.noBrandsFound')}</h3>
                    <p>{t('pages.brandsList.noBrandsHint')}</p>
                  </div>
                </td></tr>
              )}
              {brands.map(b => (
                <tr key={b.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/brands/${b.id}`)}>
                  <td style={{ fontWeight: 600 }}>{b.brandName}</td>
                  <td className="td-mono">{b.brandId}</td>
                  <td>{COUNTRY_EMOJI[b.country]} {b.country}</td>
                  <td>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, ...KA_STYLE[b.kaType] }}>
                      {b.kaType}
                    </span>
                  </td>
                  <td>{pill(b.menuIntegration)}</td>
                  <td>{pill(b.pickingMode)}</td>
                  <td>{pill(b.paymentMode)}</td>
                  <td>{b.owner?.name ?? <span className="text-muted">—</span>}</td>
                  <td>{b._count?.shops ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Paginator page={page} total={total} limit={LIMIT} onChange={setPage} />
        </div>
      </main>

      {open && (
        <Modal title={t('pages.brandsList.modalTitle')} onClose={() => { setOpen(false); resetForm(); setErr(''); }}
          footer={<>
            <button className="btn btn-ghost" onClick={() => { setOpen(false); resetForm(); setErr(''); }}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
              {saving ? t('pages.brandsList.creating') : t('pages.brandsList.createBrand')}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <form onSubmit={handleCreate}>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">{t('pages.brandsList.brandIdLabel')} <span style={{ color: 'var(--red)' }}>*</span></label>
                <input className="form-input" placeholder="BRAND-MX-001" value={form.brandId}
                  onChange={e => setForm(f => ({ ...f, brandId: e.target.value }))} required autoFocus />
              </div>
              <div className="form-group">
                <label className="form-label">{t('pages.brandsList.brandNameLabel')} <span style={{ color: 'var(--red)' }}>*</span></label>
                <input className="form-input" placeholder="KFC Mexico" value={form.brandName}
                  onChange={e => setForm(f => ({ ...f, brandName: e.target.value }))} required />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">{t('pages.brandsList.countryLabel')} <span style={{ color: 'var(--red)' }}>*</span></label>
                <select className="form-select" value={form.country}
                  onChange={e => setForm(f => ({ ...f, country: e.target.value as Country, applicationId: '' }))}>
                  {COUNTRIES.map(c => <option key={c} value={c}>{COUNTRY_EMOJI[c]} {c}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">{t('pages.brandsList.kaTypeLabel')} <span style={{ color: 'var(--red)' }}>*</span></label>
                <select className="form-select" value={form.kaType} onChange={e => setForm(f => ({ ...f, kaType: e.target.value as KaType }))}>
                  {KA_TYPES.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
              </div>
            </div>

            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '12px 0 8px' }}>
              {t('pages.brandsList.integrationsSection')}
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">{t('pages.brandsList.menuLabel')}</label>
                <select className="form-select" value={form.menuIntegration}
                  onChange={e => setForm(f => ({ ...f, menuIntegration: e.target.value as MenuIntegration | '' }))}>
                  <option value="">—</option>
                  {MENU_INTEGRATIONS.map(m => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">{t('pages.brandsList.pickingModeLabel')}</label>
                <select className="form-select" value={form.pickingMode}
                  onChange={e => setForm(f => ({ ...f, pickingMode: e.target.value as PickingMode | '' }))}>
                  <option value="">—</option>
                  {PICKING_MODES.map(p => <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>)}
                </select>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">{t('pages.brandsList.paymentModeLabel')}</label>
              <select className="form-select" value={form.paymentMode}
                onChange={e => setForm(f => ({ ...f, paymentMode: e.target.value as PaymentMode | '' }))}>
                <option value="">—</option>
                {PAYMENT_MODES.map(p => <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>)}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">{t('pages.brandsList.applicationLabel')}</label>
              <select className="form-select" value={form.applicationId}
                onChange={e => setForm(f => ({ ...f, applicationId: e.target.value }))}>
                <option value="">{t('pages.brandsList.applicationNone')}</option>
                {appsForCountry.map(a => (
                  <option key={a.id} value={a.id}>{a.appName} ({a.appId})</option>
                ))}
              </select>
              {appsForCountry.length === 0 && (
                <p className="form-hint">
                  {t('pages.brandsList.noAppsForCountry').replace('{country}', `${COUNTRY_EMOJI[form.country]} ${form.country}`)}{' '}
                  <a href="/applications" target="_blank" rel="noreferrer" style={{ color: 'var(--orange)' }}>{t('pages.brandsList.createOneArrow')}</a>
                </p>
              )}
            </div>

            {allWebhooks.length > 0 && (
              <div className="form-group">
                <label className="form-label">{t('pages.brandsList.webhooksLabel')}</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                  {allWebhooks.map(w => (
                    <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.83rem' }}>
                      <input type="checkbox" checked={form.webhookIds.includes(w.id)} onChange={() => toggleWebhook(w.id)} />
                      <span>{w.name}</span>
                      <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '1px 6px', borderRadius: 999,
                        background: w.isAlerts ? 'var(--red-bg)' : 'var(--green-bg)',
                        color: w.isAlerts ? 'var(--red)' : '#027A48' }}>
                        {w.isAlerts ? 'alerts' : 'events'}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </form>
        </Modal>
      )}
    </>
  );
}
