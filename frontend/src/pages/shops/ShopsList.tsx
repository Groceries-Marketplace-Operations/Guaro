import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import Paginator from '../../components/ui/Paginator';
import StatusBadge from '../../components/ui/StatusBadge';
import { shopsApi, brandsApi } from '../../api';
import { useT } from '../../i18n';
import type { Shop, Brand, ShopStatus, Paginated } from '../../types';

const STATUSES: ShopStatus[] = ['lead', 'application', 'integrated', 'online'];
const LIMIT = 25;

const XSmall = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="12" height="12">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

function BrandCombobox({ value, onChange }: { value: string; onChange: (id: string, name: string) => void }) {
  const [query, setQuery]       = useState('');
  const [dQuery, setDQuery]     = useState('');
  const [dropOpen, setDropOpen] = useState(false);
  const [label, setLabel]       = useState('');
  const containerRef            = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data: brands = [] } = useQuery<Brand[]>({
    queryKey: ['brands-search', dQuery],
    queryFn: () => brandsApi.list({ q: dQuery, limit: 20 }).then(r => (r.data as { data: Brand[] }).data),
    enabled: dropOpen && dQuery.length >= 1,
  });

  const select = (b: Brand) => {
    onChange(b.id, `${b.brandName} (${b.country})`);
    setLabel(`${b.brandName} (${b.country})`);
    setQuery('');
    setDropOpen(false);
  };

  const clear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('', '');
    setLabel('');
    setQuery('');
  };

  const handleBlur = useCallback((e: React.FocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) setDropOpen(false);
  }, []);

  const displayValue = dropOpen ? query : (label || '');

  return (
    <div ref={containerRef} style={{ position: 'relative' }} onBlur={handleBlur}>
      <div style={{ position: 'relative' }}>
        <input
          className="form-input"
          placeholder="Type to search brand…"
          value={displayValue}
          onChange={e => { setQuery(e.target.value); setDropOpen(true); if (!e.target.value) onChange('', ''); }}
          onFocus={() => { setDropOpen(true); if (label) setQuery(''); }}
          style={{ paddingRight: value ? 32 : 12 }}
          required
        />
        {value && (
          <button type="button" onMouseDown={clear} tabIndex={-1}
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 2 }}>
            <XSmall />
          </button>
        )}
      </div>
      {dropOpen && dQuery.length >= 1 && (
        <div style={{ position: 'absolute', zIndex: 200, top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', maxHeight: 240, overflowY: 'auto' }}>
          {brands.length === 0 ? (
            <div style={{ padding: '10px 14px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>No brands found for "{dQuery}"</div>
          ) : brands.map(b => (
            <div key={b.id} onMouseDown={() => select(b)}
              style={{ padding: '9px 14px', cursor: 'pointer', fontSize: '0.84rem', background: value === b.id ? 'rgba(255,105,0,0.08)' : 'transparent', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              onMouseEnter={e => (e.currentTarget.style.background = value === b.id ? 'rgba(255,105,0,0.12)' : 'var(--surface-2)')}
              onMouseLeave={e => (e.currentTarget.style.background = value === b.id ? 'rgba(255,105,0,0.08)' : 'transparent')}>
              <span style={{ fontWeight: value === b.id ? 600 : 400 }}>{b.brandName}</span>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{b.brandId} · {b.country}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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

export default function ShopsList() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(1);
  const [statusF, setStatusF] = useState<ShopStatus | ''>('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ shopId: '', appShopId: '', brandId: '', city: '', latitude: '', longitude: '' });

  useEffect(() => {
    const timer = setTimeout(() => { setDq(q); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  const params = {
    page, limit: LIMIT,
    ...(dq      && { q: dq }),
    ...(statusF && { status: statusF }),
  };

  const { data: result, isLoading } = useQuery<Paginated<Shop>>({
    queryKey: ['shops', params],
    queryFn: () => shopsApi.list(params).then(r => r.data),
  });

  const shops = result?.data ?? [];
  const total = result?.total ?? 0;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      await shopsApi.create(form);
      qc.invalidateQueries({ queryKey: ['shops'] });
      setOpen(false);
      setForm({ shopId: '', appShopId: '', brandId: '', city: '', latitude: '', longitude: '' });
    } catch (ex: unknown) {
      const e2 = ex as { response?: { data?: { message?: string } } };
      setErr(Array.isArray(e2.response?.data?.message) ? (e2.response!.data!.message as unknown as string[]).join(', ') : (e2.response?.data?.message ?? 'Error'));
    } finally { setSaving(false); }
  };

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.brands') }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{t('pages.shopsList.title')}</h1>
            <p>
              {statusF
                ? t('pages.shopsList.subtitleFiltered').replace('{total}', String(total)).replace('{status}', statusF)
                : t('pages.shopsList.subtitle').replace('{total}', String(total))}
            </p>
          </div>
          <div className="page-actions">
            <button className="btn btn-primary" onClick={() => setOpen(true)}><PlusIcon /> {t('pages.shopsList.newShop')}</button>
          </div>
        </div>

        <div className="toolbar">
          <div className="search-wrap">
            <SearchIcon />
            <input placeholder={t('pages.shopsList.searchPlaceholder')} value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className={`btn btn-sm ${statusF === '' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setStatusF(''); setPage(1); }}>{t('common.all')}</button>
            {STATUSES.map(s => (
              <button key={s} className={`btn btn-sm ${statusF === s ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setStatusF(s); setPage(1); }}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('pages.shopsList.colShopId')}</th>
                <th>{t('pages.shopsList.colBrand')}</th>
                <th>{t('pages.shopsList.colCity')}</th>
                <th>{t('pages.shopsList.colAppShopId')}</th>
                <th>{t('pages.shopsList.colStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={5} style={{ padding: '20px 16px', color: 'var(--text-muted)' }}>{t('common.loading')}</td></tr>}
              {!isLoading && shops.length === 0 && <tr><td colSpan={5}><div className="empty-state"><p>{t('pages.shopsList.noShops')}</p></div></td></tr>}
              {shops.map(s => (
                <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/shops/${s.id}`)}>
                  <td className="td-mono">{s.shopId}</td>
                  <td style={{ fontWeight: 600 }}>{s.brand?.brandName ?? '—'}</td>
                  <td>{s.city ?? '—'}</td>
                  <td className="td-mono">{s.appShopId}</td>
                  <td><StatusBadge status={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <Paginator page={page} total={total} limit={LIMIT} onChange={setPage} />
        </div>
      </main>

      {open && (
        <Modal title={t('pages.shopsList.modalTitle')} onClose={() => setOpen(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
              {saving ? t('pages.shopsList.creating') : t('pages.shopsList.createShop')}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <form onSubmit={handleCreate}>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">{t('pages.shopsList.shopIdLabel')}</label>
                <input className="form-input" placeholder="SHOP-MX-001" value={form.shopId}
                  onChange={e => setForm(f => ({ ...f, shopId: e.target.value }))} required autoFocus />
              </div>
              <div className="form-group">
                <label className="form-label">{t('pages.shopsList.appShopIdLabel')}</label>
                <input className="form-input" placeholder="S001" value={form.appShopId}
                  onChange={e => setForm(f => ({ ...f, appShopId: e.target.value }))} required />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">{t('pages.shopsList.brandLabel')}</label>
              <BrandCombobox
                value={form.brandId}
                onChange={(id, _name) => { setForm(f => ({ ...f, brandId: id })); }}
              />
            </div>
            <div className="form-group">
              <label className="form-label">{t('pages.shopsList.cityLabel')}</label>
              <input className="form-input" placeholder="Mexico City" value={form.city}
                onChange={e => setForm(f => ({ ...f, city: e.target.value }))} />
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
