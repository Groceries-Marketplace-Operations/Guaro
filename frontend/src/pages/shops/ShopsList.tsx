import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import Paginator from '../../components/ui/Paginator';
import StatusBadge from '../../components/ui/StatusBadge';
import { shopsApi, brandsApi } from '../../api';
import type { Shop, Brand, ShopStatus, Paginated } from '../../types';

const STATUSES: ShopStatus[] = ['lead', 'application', 'integrated', 'online'];
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

export default function ShopsList() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(1);
  const [statusF, setStatusF] = useState<ShopStatus | ''>('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ shopId: '', appShopId: '', brandId: '', city: '', latitude: '', longitude: '' });

  useEffect(() => {
    const t = setTimeout(() => { setDq(q); setPage(1); }, 300);
    return () => clearTimeout(t);
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

  // All brands for the create-shop dropdown (no pagination)
  const { data: brandsResult } = useQuery<Paginated<Brand>>({
    queryKey: ['brands', { limit: 5000 }],
    queryFn: () => brandsApi.list({ limit: 5000 }).then(r => r.data),
  });

  const shops  = result?.data ?? [];
  const total  = result?.total ?? 0;
  const brands = brandsResult?.data ?? [];

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
      <Topbar breadcrumb={[{ label: 'Shops' }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>Shops</h1>
            <p>{total} stores{statusF ? ` · ${statusF}` : ''}</p>
          </div>
          <div className="page-actions">
            <button className="btn btn-primary" onClick={() => setOpen(true)}><PlusIcon /> New Shop</button>
          </div>
        </div>

        <div className="toolbar">
          <div className="search-wrap">
            <SearchIcon />
            <input placeholder="Search by ID, brand or city…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className={`btn btn-sm ${statusF === '' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setStatusF(''); setPage(1); }}>All</button>
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
              <tr><th>Shop ID</th><th>Brand</th><th>City</th><th>App Shop ID</th><th>Status</th></tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={5} style={{ padding: '20px 16px', color: 'var(--text-muted)' }}>Loading…</td></tr>}
              {!isLoading && shops.length === 0 && <tr><td colSpan={5}><div className="empty-state"><p>No shops found.</p></div></td></tr>}
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
        <Modal title="New Shop" onClose={() => setOpen(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
              {saving ? 'Creating…' : 'Create Shop'}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <form onSubmit={handleCreate}>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Shop ID</label>
                <input className="form-input" placeholder="SHOP-MX-001" value={form.shopId}
                  onChange={e => setForm(f => ({ ...f, shopId: e.target.value }))} required autoFocus />
              </div>
              <div className="form-group">
                <label className="form-label">App Shop ID</label>
                <input className="form-input" placeholder="S001" value={form.appShopId}
                  onChange={e => setForm(f => ({ ...f, appShopId: e.target.value }))} required />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Brand</label>
              <select className="form-select" value={form.brandId} onChange={e => setForm(f => ({ ...f, brandId: e.target.value }))} required>
                <option value="">Select brand…</option>
                {brands.map(b => <option key={b.id} value={b.id}>{b.brandName} ({b.country})</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">City</label>
              <input className="form-input" placeholder="Mexico City" value={form.city}
                onChange={e => setForm(f => ({ ...f, city: e.target.value }))} />
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
