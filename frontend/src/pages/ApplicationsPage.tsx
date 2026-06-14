import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../components/layout/Topbar';
import Modal from '../components/ui/Modal';
import Paginator from '../components/ui/Paginator';
import { applicationsApi } from '../api';
import type { Application, Country, Paginated } from '../types';

const COUNTRY_EMOJI: Record<Country, string> = { MX: '🇲🇽', CO: '🇨🇴', CR: '🇨🇷' };
const COUNTRIES: Country[] = ['MX', 'CO', 'CR'];
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

export default function ApplicationsPage() {
  const qc = useQueryClient();

  // filters
  const [q, setQ] = useState('');
  const [country, setCountry] = useState<Country | ''>('');
  const [page, setPage] = useState(1);

  // create modal
  const [openCreate, setOpenCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ appId: '', appName: '', country: 'MX' as Country, appSecret: '' });

  // edit modal
  const [editApp, setEditApp] = useState<Application | null>(null);
  const [editForm, setEditForm] = useState({ appName: '', appSecret: '' });

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const params = { page, limit: LIMIT, ...(q ? { q } : {}), ...(country ? { country } : {}) };

  const { data: result, isLoading } = useQuery<Paginated<Application>>({
    queryKey: ['applications', params],
    queryFn: () => applicationsApi.list(params).then(r => r.data as Paginated<Application>),
  });

  const apps = result?.data ?? [];
  const total = result?.total ?? 0;

  const resetFilters = useCallback(() => { setQ(''); setCountry(''); setPage(1); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      await applicationsApi.create(createForm);
      qc.invalidateQueries({ queryKey: ['applications'] });
      setOpenCreate(false);
      setCreateForm({ appId: '', appName: '', country: 'MX', appSecret: '' });
    } catch (ex: unknown) {
      const e2 = ex as { response?: { data?: { message?: string | string[] } } };
      const msg = e2.response?.data?.message;
      setErr(Array.isArray(msg) ? msg.join(', ') : (msg ?? 'Error'));
    } finally { setSaving(false); }
  };

  const openEdit = (a: Application) => {
    setEditApp(a);
    setEditForm({ appName: a.appName, appSecret: '' });
    setErr('');
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editApp) return;
    setSaving(true); setErr('');
    const payload: Record<string, string> = {};
    if (editForm.appName) payload.appName = editForm.appName;
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
    if (!window.confirm(`Delete application "${a.appName}"?`)) return;
    try {
      await applicationsApi.delete(a.id);
      qc.invalidateQueries({ queryKey: ['applications'] });
    } catch { /* ignore */ }
  };

  return (
    <>
      <Topbar breadcrumb={[{ label: 'Applications' }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>Applications</h1>
            <p>{total} application{total !== 1 ? 's' : ''}</p>
          </div>
          <div className="page-actions">
            <button className="btn btn-primary" onClick={() => { setOpenCreate(true); setErr(''); }}>
              <PlusIcon /> New Application
            </button>
          </div>
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <input
            className="form-input"
            style={{ width: 260, margin: 0 }}
            placeholder="Search by name or App ID…"
            value={q}
            onChange={e => { setQ(e.target.value); setPage(1); }}
          />
          <select
            className="form-select"
            style={{ width: 140, margin: 0 }}
            value={country}
            onChange={e => { setCountry(e.target.value as Country | ''); setPage(1); }}
          >
            <option value="">All countries</option>
            {COUNTRIES.map(c => <option key={c} value={c}>{COUNTRY_EMOJI[c]} {c}</option>)}
          </select>
          {(q || country) && (
            <button className="btn btn-ghost btn-sm" onClick={resetFilters}>Clear filters</button>
          )}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>App ID</th><th>Country</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={5} style={{ padding: '20px 16px', color: 'var(--text-muted)' }}>Loading…</td></tr>}
              {!isLoading && apps.length === 0 && (
                <tr><td colSpan={5}>
                  <div className="empty-state">
                    <h3>No applications</h3>
                    <p>Create an application to link it to brands during setup.</p>
                  </div>
                </td></tr>
              )}
              {apps.map(a => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 600 }}>{a.appName}</td>
                  <td className="td-mono">{a.appId}</td>
                  <td>{COUNTRY_EMOJI[a.country]} {a.country}</td>
                  <td className="text-muted text-sm">{new Date(a.createdAt).toLocaleDateString()}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn btn-ghost btn-sm" style={{ padding: '3px 8px' }}
                        onClick={() => openEdit(a)} title="Edit">
                        <EditIcon />
                      </button>
                      <button className="btn btn-ghost btn-sm" style={{ padding: '3px 8px', color: 'var(--red)' }}
                        onClick={() => handleDelete(a)} title="Delete">
                        <TrashIcon />
                      </button>
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

      {/* Create modal */}
      {openCreate && (
        <Modal title="New Application" onClose={() => { setOpenCreate(false); setErr(''); }}
          footer={<>
            <button className="btn btn-ghost" onClick={() => { setOpenCreate(false); setErr(''); }}>Cancel</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
              {saving ? 'Creating…' : 'Create'}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">App ID <span style={{ color: 'var(--red)' }}>*</span></label>
              <input className="form-input" placeholder="APP-MX-001" value={createForm.appId}
                onChange={e => setCreateForm(f => ({ ...f, appId: e.target.value }))} required autoFocus />
            </div>
            <div className="form-group">
              <label className="form-label">App Name <span style={{ color: 'var(--red)' }}>*</span></label>
              <input className="form-input" placeholder="DiDi Mexico" value={createForm.appName}
                onChange={e => setCreateForm(f => ({ ...f, appName: e.target.value }))} required />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Country <span style={{ color: 'var(--red)' }}>*</span></label>
              <select className="form-select" value={createForm.country}
                onChange={e => setCreateForm(f => ({ ...f, country: e.target.value as Country }))}>
                {COUNTRIES.map(c => <option key={c} value={c}>{COUNTRY_EMOJI[c]} {c}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">App Secret <span style={{ color: 'var(--red)' }}>*</span></label>
              <input className="form-input" type="password" placeholder="••••••••" value={createForm.appSecret}
                onChange={e => setCreateForm(f => ({ ...f, appSecret: e.target.value }))} required />
              <p className="form-hint">Stored encrypted — never exposed in responses.</p>
            </div>
          </div>
        </Modal>
      )}

      {/* Edit modal */}
      {editApp && (
        <Modal title={`Edit — ${editApp.appName}`} onClose={() => { setEditApp(null); setErr(''); }}
          footer={<>
            <button className="btn btn-ghost" onClick={() => { setEditApp(null); setErr(''); }}>Cancel</button>
            <button className="btn btn-primary" onClick={handleEdit} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <p className="text-muted text-sm" style={{ marginBottom: 14 }}>
            App ID (<span className="td-mono">{editApp.appId}</span>) and country ({COUNTRY_EMOJI[editApp.country]} {editApp.country}) cannot be changed.
          </p>
          <div className="form-group">
            <label className="form-label">App Name</label>
            <input className="form-input" value={editForm.appName}
              onChange={e => setEditForm(f => ({ ...f, appName: e.target.value }))} autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">New App Secret <span className="text-muted">(leave blank to keep current)</span></label>
            <input className="form-input" type="password" placeholder="••••••••" value={editForm.appSecret}
              onChange={e => setEditForm(f => ({ ...f, appSecret: e.target.value }))} />
            <p className="form-hint">Stored encrypted. Only fill to rotate the secret.</p>
          </div>
        </Modal>
      )}
    </>
  );
}
