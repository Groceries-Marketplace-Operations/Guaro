import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../components/layout/Topbar';
import Modal from '../components/ui/Modal';
import Paginator from '../components/ui/Paginator';
import { handlersApi, webhooksApi, invitationsApi, sectionsApi, accountsApi } from '../api';
import { useAuth } from '../auth/AuthContext';
import type { Handler, Webhook, Section, AccountRole, Paginated } from '../types';

interface InvitationRow {
  id: string;
  rol: string;
  section?: { name: string };
  usedAt?: string | null;
  expiresAt: string;
  createdAt: string;
  account?: { id: string; name: string; email: string } | null;
}

interface AccountRow {
  id: string;
  name: string;
  email: string;
  roles: string[];
  sectionId?: string | null;
  adminModules?: string[];
  bpoPermissions?: string[];
}

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
const CopyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="14" height="14">
    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
);

const ADMIN_MODULES = [
  { key: 'applications', label: 'Applications' },
  { key: 'bpo_team',     label: 'BPO Team' },
  { key: 'webhooks',     label: 'Webhooks (Config)' },
  { key: 'handlers',     label: 'Handlers (Config)' },
] as const;

const BPO_PERMISSIONS = [
  { key: 'create_brand',       label: 'Create Brand' },
  { key: 'create_application', label: 'Create Application' },
] as const;

export default function Config() {
  const qc = useQueryClient();
  const { account } = useAuth();
  const isSuperAdmin = account?.roles.includes('super_admin') ?? false;
  const isAdmin = account?.roles.includes('admin') ?? false;
  const adminMods = account?.adminModules ?? [];
  const canSeeHandlers = isSuperAdmin || adminMods.includes('handlers');
  const canSeeWebhooks = isSuperAdmin || adminMods.includes('webhooks');
  const defaultTab = canSeeHandlers ? 'handlers' : canSeeWebhooks ? 'webhooks' : 'invitations';
  const [tab, setTab] = useState<'handlers' | 'webhooks' | 'invitations' | 'users'>(defaultTab);

  const [openHandler, setOpenHandler] = useState(false);
  const [openWebhook, setOpenWebhook] = useState(false);
  const [openInvite, setOpenInvite] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const [handlerName, setHandlerName] = useState('');
  const [whForm, setWhForm] = useState({ name: '', url: '', isAlerts: false });
  const [editingWebhook, setEditingWebhook] = useState<Webhook | null>(null);
  const [editWhForm, setEditWhForm] = useState({ name: '', url: '', isAlerts: false });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [invForm, setInvForm] = useState({ role: 'bpo' as AccountRole, sectionId: '' });

  // Invitations pagination
  const [invPage, setInvPage] = useState(1);
  const INV_LIMIT = 25;

  // Users tab filters + edit + pagination
  const [userQ, setUserQ] = useState('');
  const [dUserQ, setDUserQ] = useState('');
  const [userSection, setUserSection] = useState('');
  const [userPage, setUserPage] = useState(1);
  const USER_LIMIT = 25;
  const [editingUser, setEditingUser] = useState<AccountRow | null>(null);
  const [editUserSection, setEditUserSection] = useState('');
  const [editUserRoles, setEditUserRoles] = useState<string[]>([]);
  const [editUserModules, setEditUserModules] = useState<string[]>([]);
  const [editBpoPermissions, setEditBpoPermissions] = useState<string[]>([]);

  useEffect(() => {
    const t = setTimeout(() => { setDUserQ(userQ); setUserPage(1); }, 300);
    return () => clearTimeout(t);
  }, [userQ]);

  const { data: handlers = [] } = useQuery<Handler[]>({ queryKey: ['handlers'], queryFn: () => handlersApi.list().then(r => r.data) });
  const { data: webhooks = [] } = useQuery<Webhook[]>({ queryKey: ['webhooks'], queryFn: () => webhooksApi.list().then(r => r.data) });
  const { data: invResult } = useQuery<Paginated<InvitationRow>>({
    queryKey: ['invitations', { page: invPage, limit: INV_LIMIT }],
    queryFn: () => invitationsApi.list({ page: invPage, limit: INV_LIMIT }).then(r => r.data as Paginated<InvitationRow>),
    enabled: tab === 'invitations',
  });
  const invitations = invResult?.data ?? [];
  const invTotal = invResult?.total ?? 0;

  const { data: sections = [] } = useQuery<Section[]>({ queryKey: ['sections'], queryFn: () => sectionsApi.list().then(r => r.data) });
  const usersParams = { page: userPage, limit: USER_LIMIT };
  const { data: usersResult } = useQuery<Paginated<AccountRow>>({
    queryKey: ['accounts-all', usersParams],
    queryFn: () => accountsApi.list(usersParams).then(r => r.data as Paginated<AccountRow>),
    enabled: tab === 'users',
  });
  const usersRaw: AccountRow[] = usersResult?.data ?? [];
  const usersTotal = usersResult?.total ?? 0;

  const openEditUser = (u: AccountRow) => {
    setEditingUser(u);
    setEditUserSection(u.sectionId ?? '');
    setEditUserRoles([...u.roles]);
    setEditUserModules([...(u.adminModules ?? [])]);
    setEditBpoPermissions([...(u.bpoPermissions ?? [])]);
    setErr('');
  };

  const saveEditUser = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      const isTargetAdmin = editingUser!.roles.includes('admin');
      const isTargetBpo = editingUser!.roles.includes('bpo');
      await accountsApi.update(editingUser!.id, {
        sectionId: editUserSection || null,
        roles: editUserRoles,
        ...(isSuperAdmin && isTargetAdmin ? { adminModules: editUserModules } : {}),
        ...(isSuperAdmin && isTargetBpo ? { bpoPermissions: editBpoPermissions } : {}),
      });
      qc.invalidateQueries({ queryKey: ['accounts-all'] });
      setEditingUser(null);
    } catch { setErr('Error saving account'); } finally { setSaving(false); }
  };

  const EDITABLE_ROLES = (isSuperAdmin
    ? ['user', 'bpo', 'admin', 'director']
    : ['user', 'bpo']) as readonly string[];
  const createHandler = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      await handlersApi.create({ name: handlerName });
      qc.invalidateQueries({ queryKey: ['handlers'] });
      setOpenHandler(false); setHandlerName('');
    } catch { setErr('Error creating handler'); } finally { setSaving(false); }
  };

  const createWebhook = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      await webhooksApi.create(whForm);
      qc.invalidateQueries({ queryKey: ['webhooks'] });
      setOpenWebhook(false);
      setWhForm({ name: '', url: '', isAlerts: false });
    } catch { setErr('Error creating webhook'); } finally { setSaving(false); }
  };

  const openEditWebhook = (w: Webhook) => {
    setEditingWebhook(w);
    setEditWhForm({ name: w.name, url: w.url, isAlerts: w.isAlerts });
    setErr('');
  };

  const saveWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingWebhook) return;
    setSaving(true); setErr('');
    try {
      await webhooksApi.update(editingWebhook.id, editWhForm);
      qc.invalidateQueries({ queryKey: ['webhooks'] });
      setEditingWebhook(null);
    } catch { setErr('Error saving webhook'); } finally { setSaving(false); }
  };

  const deleteWebhook = async (w: Webhook) => {
    if (!window.confirm(`Delete webhook "${w.name}"?`)) return;
    try {
      await webhooksApi.delete(w.id);
      qc.invalidateQueries({ queryKey: ['webhooks'] });
    } catch { /* ignore */ }
  };

  const copyUrl = (w: Webhook) => {
    navigator.clipboard.writeText(w.url).then(() => {
      setCopiedId(w.id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const createInvitation = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      const res = await invitationsApi.create(invForm);
      qc.invalidateQueries({ queryKey: ['invitations'] });
      setOpenInvite(false);
      setInviteLink(`${window.location.origin}/invite/${res.data.token}`);
      setCopied(false);
    } catch { setErr('Error creating invitation'); } finally { setSaving(false); }
  };

  const copyLink = () => {
    if (!inviteLink) return;
    navigator.clipboard.writeText(inviteLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  const deleteInvitation = async (id: string) => {
    if (!window.confirm('Delete this invitation?')) return;
    try {
      await invitationsApi.delete(id);
      qc.invalidateQueries({ queryKey: ['invitations'] });
    } catch { /* ignore */ }
  };

  const deleteAccount = async (id: string, name: string) => {
    if (!window.confirm(`Delete account "${name}"? This cannot be undone.`)) return;
    try {
      await accountsApi.delete(id);
      qc.invalidateQueries({ queryKey: ['accounts-all'] });
    } catch (ex: unknown) {
      const e2 = ex as { response?: { data?: { message?: string } } };
      alert(e2.response?.data?.message ?? 'Error deleting account');
    }
  };

  return (
    <>
      <Topbar breadcrumb={[{ label: 'Config' }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>Configuration</h1>
            <p>Handlers, webhooks and team invitations</p>
          </div>
        </div>

        <div className="tabs">
          {canSeeHandlers && (
            <div className={`tab ${tab === 'handlers' ? 'active' : ''}`} onClick={() => setTab('handlers')}>Handlers ({handlers.length})</div>
          )}
          {canSeeWebhooks && (
            <div className={`tab ${tab === 'webhooks' ? 'active' : ''}`} onClick={() => setTab('webhooks')}>Webhooks ({webhooks.length})</div>
          )}
          <div className={`tab ${tab === 'invitations' ? 'active' : ''}`} onClick={() => setTab('invitations')}>
            Invitations
          </div>
          <div className={`tab ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}>Users</div>
        </div>

        {tab === 'handlers' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
              <button className="btn btn-primary" onClick={() => setOpenHandler(true)}><PlusIcon /> New Handler</button>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Name</th><th>ID</th><th>Created</th></tr></thead>
                <tbody>
                  {handlers.length === 0 && <tr><td colSpan={3}><div className="empty-state"><p>No handlers yet.</p></div></td></tr>}
                  {handlers.map(h => (
                    <tr key={h.id}>
                      <td className="td-mono" style={{ fontWeight: 600 }}>{h.name}</td>
                      <td className="td-id">{h.id}</td>
                      <td className="text-muted text-sm">{new Date(h.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'webhooks' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
              <button className="btn btn-primary" onClick={() => setOpenWebhook(true)}><PlusIcon /> New Webhook</button>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Name</th><th>URL</th><th>Type</th><th>Created</th><th></th></tr></thead>
                <tbody>
                  {webhooks.length === 0 && <tr><td colSpan={5}><div className="empty-state"><p>No webhooks yet.</p></div></td></tr>}
                  {webhooks.map(w => (
                    <tr key={w.id}>
                      <td style={{ fontWeight: 600 }}>{w.name}</td>
                      <td style={{ maxWidth: 260 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span className="td-mono" style={{
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            fontSize: '0.75rem', color: 'var(--text-secondary)', flex: 1, minWidth: 0,
                          }} title={w.url}>{w.url}</span>
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ flexShrink: 0, padding: '3px 7px', color: copiedId === w.id ? 'var(--green)' : 'var(--text-muted)' }}
                            onClick={() => copyUrl(w)}
                            title="Copy URL"
                          >
                            {copiedId === w.id ? '✓' : <CopyIcon />}
                          </button>
                        </div>
                      </td>
                      <td>
                        <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                          background: w.isAlerts ? 'var(--red-bg)' : 'var(--green-bg)',
                          color: w.isAlerts ? 'var(--red)' : '#027A48' }}>
                          {w.isAlerts ? 'Alerts' : 'Events'}
                        </span>
                      </td>
                      <td className="text-muted text-sm">{new Date(w.createdAt).toLocaleDateString()}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-ghost btn-sm" style={{ padding: '3px 8px' }}
                            onClick={() => openEditWebhook(w)} title="Edit">
                            <EditIcon />
                          </button>
                          <button className="btn btn-ghost btn-sm" style={{ padding: '3px 8px', color: 'var(--red)' }}
                            onClick={() => deleteWebhook(w)} title="Delete">
                            <TrashIcon />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'invitations' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span className="text-muted text-sm">{invTotal} invitation{invTotal !== 1 ? 's' : ''}</span>
              <button className="btn btn-primary" onClick={() => setOpenInvite(true)}><PlusIcon /> New Invitation</button>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Role</th><th>Section</th><th>Status</th><th>Used by</th><th>Expires</th><th></th></tr></thead>
                <tbody>
                  {invitations.length === 0 && (
                    <tr><td colSpan={6}><div className="empty-state"><p>No invitations yet.</p></div></td></tr>
                  )}
                  {invitations.map(inv => {
                    const isPending = !inv.usedAt;
                    const expired = !inv.usedAt && new Date(inv.expiresAt) < new Date();
                    return (
                      <tr key={inv.id}>
                        <td>
                          <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--blue-bg)', color: 'var(--blue)' }}>
                            {inv.rol}
                          </span>
                        </td>
                        <td className="text-muted">{inv.section?.name ?? '—'}</td>
                        <td>
                          {inv.usedAt
                            ? <span style={{ color: 'var(--green)', fontWeight: 600, fontSize: '0.78rem' }}>Used</span>
                            : expired
                            ? <span style={{ color: 'var(--red)', fontSize: '0.78rem' }}>Expired</span>
                            : <span style={{ color: 'var(--amber)', fontWeight: 600, fontSize: '0.78rem' }}>Pending</span>}
                        </td>
                        <td className="text-muted text-sm">{inv.account?.name ?? '—'}</td>
                        <td className="text-muted text-sm">{new Date(inv.expiresAt).toLocaleDateString()}</td>
                        <td>
                          {isPending && (
                            <button
                              className="btn btn-ghost btn-sm"
                              style={{ color: 'var(--red)', padding: '3px 8px' }}
                              onClick={() => deleteInvitation(inv.id)}
                              title="Delete invitation"
                            >
                              <TrashIcon />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Paginator page={invPage} total={invTotal} limit={INV_LIMIT} onChange={setInvPage} />
          </>
        )}

        {tab === 'users' && (() => {
          const qLow = dUserQ.toLowerCase();
          const filtered = usersRaw.filter(u => {
            if (dUserQ && !u.name.toLowerCase().includes(qLow) && !u.email.toLowerCase().includes(qLow)) return false;
            if (userSection && u.sectionId !== userSection) return false;
            return true;
          });
          return (
          <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
              <input
                className="form-input"
                style={{ width: 240, margin: 0 }}
                placeholder="Search by name or email…"
                value={userQ}
                onChange={e => setUserQ(e.target.value)}
              />
              {isSuperAdmin && (
                <select
                  className="form-select"
                  style={{ width: 180, margin: 0 }}
                  value={userSection}
                  onChange={e => setUserSection(e.target.value)}
                >
                  <option value="">All sections</option>
                  {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
              {(userQ || userSection) && (
                <button className="btn btn-ghost btn-sm" onClick={() => { setUserQ(''); setUserSection(''); setUserPage(1); }}>
                  Clear
                </button>
              )}
              <span className="text-muted text-sm" style={{ alignSelf: 'center', marginLeft: 'auto' }}>
                {usersTotal} account{usersTotal !== 1 ? 's' : ''}
              </span>
            </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Section</th><th></th></tr></thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={5}><div className="empty-state"><p>No accounts match the filters.</p></div></td></tr>
                )}
                {filtered.map(u => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 600 }}>{u.name}</td>
                    <td className="text-muted text-sm">{u.email || <span style={{ fontStyle: 'italic' }}>not linked</span>}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {u.roles.map(r => (
                          <span key={r} style={{
                            fontSize: '0.68rem', fontWeight: 700, padding: '1px 7px', borderRadius: 999,
                            background: r === 'super_admin' ? 'var(--orange)' : r === 'admin' ? 'var(--blue-bg)' : 'var(--surface-2)',
                            color: r === 'super_admin' ? '#fff' : r === 'admin' ? 'var(--blue)' : 'var(--text-secondary)',
                            border: '1px solid var(--border)',
                          }}>
                            {r}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="text-muted text-sm">
                      {sections.find(s => s.id === u.sectionId)?.name ?? '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {(isSuperAdmin || (isAdmin && !u.roles.includes('admin') && !u.roles.includes('director'))) &&
                          !u.roles.includes('super_admin') && (
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ padding: '3px 8px' }}
                            onClick={() => openEditUser(u)}
                            title="Edit roles"
                          >
                            <EditIcon />
                          </button>
                        )}
                        {!u.roles.includes('super_admin') && (
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ color: 'var(--red)', padding: '3px 8px' }}
                            onClick={() => deleteAccount(u.id, u.name)}
                            title="Delete account"
                          >
                            <TrashIcon />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Paginator page={userPage} total={usersTotal} limit={USER_LIMIT} onChange={setUserPage} />
          </>
          );
        })()}
      </main>

      {openHandler && (
        <Modal title="New Handler" onClose={() => setOpenHandler(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenHandler(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={createHandler} disabled={saving}>{saving ? 'Creating…' : 'Create'}</button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">Handler key</label>
            <input className="form-input" placeholder="send_notification" value={handlerName}
              onChange={e => setHandlerName(e.target.value)} required autoFocus />
            <p className="form-hint">Must match the key registered in the HANDLER_REGISTRY.</p>
          </div>
        </Modal>
      )}

      {openWebhook && (
        <Modal title="New Webhook" onClose={() => setOpenWebhook(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenWebhook(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={createWebhook} disabled={saving}>{saving ? 'Creating…' : 'Create'}</button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">Name</label>
            <input className="form-input" placeholder="Slack Ops" value={whForm.name}
              onChange={e => setWhForm(f => ({ ...f, name: e.target.value }))} required />
          </div>
          <div className="form-group">
            <label className="form-label">URL</label>
            <input className="form-input" type="url" placeholder="https://hooks.slack.com/…" value={whForm.url}
              onChange={e => setWhForm(f => ({ ...f, url: e.target.value }))} required />
          </div>
          <div className="form-check">
            <input type="checkbox" id="isalerts" checked={whForm.isAlerts}
              onChange={e => setWhForm(f => ({ ...f, isAlerts: e.target.checked }))} />
            <label htmlFor="isalerts" style={{ fontSize: '0.83rem', cursor: 'pointer' }}>Alerts webhook (receives system/timeout alerts)</label>
          </div>
        </Modal>
      )}

      {editingWebhook && (
        <Modal title="Edit Webhook" onClose={() => setEditingWebhook(null)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setEditingWebhook(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveWebhook} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">Name</label>
            <input className="form-input" value={editWhForm.name}
              onChange={e => setEditWhForm(f => ({ ...f, name: e.target.value }))} required autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">URL</label>
            <input className="form-input" type="url" value={editWhForm.url}
              onChange={e => setEditWhForm(f => ({ ...f, url: e.target.value }))} required />
          </div>
          <div className="form-check">
            <input type="checkbox" id="edit-isalerts" checked={editWhForm.isAlerts}
              onChange={e => setEditWhForm(f => ({ ...f, isAlerts: e.target.checked }))} />
            <label htmlFor="edit-isalerts" style={{ fontSize: '0.83rem', cursor: 'pointer' }}>Alerts webhook</label>
          </div>
        </Modal>
      )}

      {openInvite && (
        <Modal title="New Invitation" onClose={() => setOpenInvite(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenInvite(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={createInvitation} disabled={saving}>{saving ? 'Creating…' : 'Generate Link'}</button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">Role</label>
            <select className="form-select" value={invForm.role} onChange={e => setInvForm(f => ({ ...f, role: e.target.value as AccountRole }))}>
              <option value="user">User</option>
              <option value="bpo">BPO</option>
              {isSuperAdmin && <option value="admin">Admin</option>}
              {isSuperAdmin && <option value="director">Director</option>}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Section</label>
            <select className="form-select" value={invForm.sectionId} onChange={e => setInvForm(f => ({ ...f, sectionId: e.target.value }))} required>
              <option value="">Select section…</option>
              {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </Modal>
      )}

      {inviteLink && (
        <Modal
          title="Invitation link ready"
          onClose={() => setInviteLink(null)}
          footer={
            <button className="btn btn-primary" onClick={() => setInviteLink(null)}>Done</button>
          }
        >
          <p className="text-muted text-sm" style={{ marginBottom: 12 }}>
            Share this link with the person you're inviting. It expires in 7 days and can only be used once.
          </p>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: '10px 12px',
          }}>
            <span style={{
              flex: 1, fontFamily: 'var(--font-mono)', fontSize: '0.75rem',
              color: 'var(--text-secondary)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {inviteLink}
            </span>
            <button
              className={`btn btn-sm ${copied ? 'btn-primary' : 'btn-ghost'}`}
              onClick={copyLink}
              style={{ flexShrink: 0 }}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>
        </Modal>
      )}
      {editingUser && (
        <Modal
          title={`Edit — ${editingUser.name}`}
          onClose={() => setEditingUser(null)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setEditingUser(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveEditUser} disabled={saving || editUserRoles.length === 0}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          {isSuperAdmin && (
            <div className="form-group">
              <label className="form-label">Section / Team</label>
              <select className="form-select" value={editUserSection} onChange={e => setEditUserSection(e.target.value)}>
                <option value="">No section</option>
                {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">Roles</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8 }}>
              {EDITABLE_ROLES.map(role => (
                <label key={role} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.85rem' }}>
                  <input
                    type="checkbox"
                    checked={editUserRoles.includes(role)}
                    onChange={e => {
                      if (e.target.checked) setEditUserRoles(r => [...r, role]);
                      else setEditUserRoles(r => r.filter(x => x !== role));
                    }}
                    style={{ accentColor: 'var(--orange)', width: 15, height: 15 }}
                  />
                  <span style={{ fontWeight: 500 }}>{role}</span>
                </label>
              ))}
            </div>
            {editUserRoles.length === 0 && <p style={{ fontSize: '0.75rem', color: 'var(--red)', marginTop: 4 }}>At least one role is required.</p>}
          </div>
          {isSuperAdmin && editingUser?.roles.includes('admin') && (
            <div className="form-group">
              <label className="form-label">Module access</label>
              <p className="form-hint" style={{ marginBottom: 8 }}>Users and Invitations are always visible. Select additional modules this admin can access.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8 }}>
                {ADMIN_MODULES.map(({ key, label }) => (
                  <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.85rem' }}>
                    <input
                      type="checkbox"
                      checked={editUserModules.includes(key)}
                      onChange={e => {
                        if (e.target.checked) setEditUserModules(m => [...m, key]);
                        else setEditUserModules(m => m.filter(x => x !== key));
                      }}
                      style={{ accentColor: 'var(--orange)', width: 15, height: 15 }}
                    />
                    <span style={{ fontWeight: 500 }}>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {isSuperAdmin && editingUser?.roles.includes('bpo') && (
            <div className="form-group">
              <label className="form-label">BPO permissions</label>
              <p className="form-hint" style={{ marginBottom: 8 }}>Select which create actions this BPO can perform.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8 }}>
                {BPO_PERMISSIONS.map(({ key, label }) => (
                  <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.85rem' }}>
                    <input
                      type="checkbox"
                      checked={editBpoPermissions.includes(key)}
                      onChange={e => {
                        if (e.target.checked) setEditBpoPermissions(p => [...p, key]);
                        else setEditBpoPermissions(p => p.filter(x => x !== key));
                      }}
                      style={{ accentColor: 'var(--orange)', width: 15, height: 15 }}
                    />
                    <span style={{ fontWeight: 500 }}>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
