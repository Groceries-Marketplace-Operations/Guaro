import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../components/layout/Topbar';
import Modal from '../components/ui/Modal';
import Paginator from '../components/ui/Paginator';
import { handlersApi, webhooksApi, invitationsApi, sectionsApi, accountsApi } from '../api';
import { useAuth } from '../auth/AuthContext';
import { useT } from '../i18n';
import type { Handler, Webhook, Section, AccountRole, Paginated } from '../types';

interface InvitationRow {
  id: string;
  token: string;
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
  const t = useT();
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
  const [copiedInvId, setCopiedInvId] = useState<string | null>(null);
  const [invForm, setInvForm] = useState({ role: 'bpo' as AccountRole, sectionId: '' });

  const [invPage, setInvPage] = useState(1);
  const INV_LIMIT = 25;

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
    const timer = setTimeout(() => { setDUserQ(userQ); setUserPage(1); }, 300);
    return () => clearTimeout(timer);
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
    } catch { setErr(t('pages.config.errorSavingAccount')); } finally { setSaving(false); }
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
    } catch { setErr(t('pages.config.errorCreatingHandler')); } finally { setSaving(false); }
  };

  const createWebhook = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      await webhooksApi.create(whForm);
      qc.invalidateQueries({ queryKey: ['webhooks'] });
      setOpenWebhook(false);
      setWhForm({ name: '', url: '', isAlerts: false });
    } catch { setErr(t('pages.config.errorCreatingWebhook')); } finally { setSaving(false); }
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
    } catch { setErr(t('pages.config.errorSavingWebhook')); } finally { setSaving(false); }
  };

  const deleteWebhook = async (w: Webhook) => {
    if (!window.confirm(t('pages.config.deleteWebhookConfirm').replace('{name}', w.name))) return;
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
      setInviteLink(`${window.location.origin}${import.meta.env.BASE_URL}invite/${res.data.token}`);
      setCopied(false);
    } catch { setErr(t('pages.config.errorCreatingInvitation')); } finally { setSaving(false); }
  };

  const copyLink = () => {
    if (!inviteLink) return;
    navigator.clipboard.writeText(inviteLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  const copyInviteLink = (inv: InvitationRow) => {
    const link = `${window.location.origin}${import.meta.env.BASE_URL}invite/${inv.token}`;
    navigator.clipboard.writeText(link).then(() => {
      setCopiedInvId(inv.id);
      setTimeout(() => setCopiedInvId(null), 2500);
    });
  };

  const deleteInvitation = async (id: string) => {
    if (!window.confirm(t('pages.config.deleteInvitationConfirm'))) return;
    try {
      await invitationsApi.delete(id);
      qc.invalidateQueries({ queryKey: ['invitations'] });
    } catch { /* ignore */ }
  };

  const deleteAccount = async (id: string, name: string) => {
    if (!window.confirm(t('pages.config.deleteAccountConfirm').replace('{name}', name))) return;
    try {
      await accountsApi.delete(id);
      qc.invalidateQueries({ queryKey: ['accounts-all'] });
    } catch (ex: unknown) {
      const e2 = ex as { response?: { data?: { message?: string } } };
      alert(e2.response?.data?.message ?? t('pages.config.errorSavingAccount'));
    }
  };

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.config') }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{t('pages.config.title')}</h1>
            <p>{t('pages.config.subtitle')}</p>
          </div>
        </div>

        <div className="tabs">
          {canSeeHandlers && (
            <div className={`tab ${tab === 'handlers' ? 'active' : ''}`} onClick={() => setTab('handlers')}>{t('pages.config.tabHandlers')} ({handlers.length})</div>
          )}
          {canSeeWebhooks && (
            <div className={`tab ${tab === 'webhooks' ? 'active' : ''}`} onClick={() => setTab('webhooks')}>{t('pages.config.tabWebhooks')} ({webhooks.length})</div>
          )}
          <div className={`tab ${tab === 'invitations' ? 'active' : ''}`} onClick={() => setTab('invitations')}>
            {t('pages.config.tabInvitations')}
          </div>
          <div className={`tab ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}>{t('pages.config.tabUsers')}</div>
        </div>

        {tab === 'handlers' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
              <button className="btn btn-primary" onClick={() => setOpenHandler(true)}><PlusIcon /> {t('pages.config.newHandler')}</button>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>{t('pages.config.colName')}</th><th>{t('pages.config.colId')}</th><th>{t('pages.config.colCreated')}</th></tr></thead>
                <tbody>
                  {handlers.length === 0 && <tr><td colSpan={3}><div className="empty-state"><p>{t('pages.config.noHandlers')}</p></div></td></tr>}
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
              <button className="btn btn-primary" onClick={() => setOpenWebhook(true)}><PlusIcon /> {t('pages.config.newWebhook')}</button>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>{t('pages.config.colName')}</th><th>{t('pages.config.colUrl')}</th><th>{t('pages.config.colType')}</th><th>{t('pages.config.colCreated')}</th><th></th></tr></thead>
                <tbody>
                  {webhooks.length === 0 && <tr><td colSpan={5}><div className="empty-state"><p>{t('pages.config.noWebhooks')}</p></div></td></tr>}
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
                          {w.isAlerts ? t('pages.config.webhookBadgeAlerts') : t('pages.config.webhookBadgeEvents')}
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
              <span className="text-muted text-sm">
                {invTotal !== 1
                  ? t('pages.config.invitationsCount').replace('{count}', String(invTotal))
                  : t('pages.config.invitationCount').replace('{count}', String(invTotal))}
              </span>
              <button className="btn btn-primary" onClick={() => setOpenInvite(true)}><PlusIcon /> {t('pages.config.newInvitation')}</button>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>{t('pages.config.colRole')}</th><th>{t('pages.config.colSection')}</th><th>{t('pages.config.colStatus')}</th><th>{t('pages.config.colUsedBy')}</th><th>{t('pages.config.colExpires')}</th><th></th></tr></thead>
                <tbody>
                  {invitations.length === 0 && (
                    <tr><td colSpan={6}><div className="empty-state"><p>{t('pages.config.noInvitations')}</p></div></td></tr>
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
                            ? <span style={{ color: 'var(--green)', fontWeight: 600, fontSize: '0.78rem' }}>{t('pages.config.invStatusUsed')}</span>
                            : expired
                            ? <span style={{ color: 'var(--red)', fontSize: '0.78rem' }}>{t('pages.config.invStatusExpired')}</span>
                            : <span style={{ color: 'var(--amber)', fontWeight: 600, fontSize: '0.78rem' }}>{t('pages.config.invStatusPending')}</span>}
                        </td>
                        <td className="text-muted text-sm">{inv.account?.name ?? '—'}</td>
                        <td className="text-muted text-sm">{new Date(inv.expiresAt).toLocaleDateString()}</td>
                        <td>
                          {isPending && (
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button
                                className="btn btn-ghost btn-sm"
                                style={{ padding: '3px 8px', color: copiedInvId === inv.id ? 'var(--green)' : undefined }}
                                onClick={() => copyInviteLink(inv)}
                                title="Copy invite link"
                              >
                                {copiedInvId === inv.id ? '✓' : <CopyIcon />}
                              </button>
                              <button
                                className="btn btn-ghost btn-sm"
                                style={{ color: 'var(--red)', padding: '3px 8px' }}
                                onClick={() => deleteInvitation(inv.id)}
                                title="Delete invitation"
                              >
                                <TrashIcon />
                              </button>
                            </div>
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
                placeholder={t('pages.config.userSearchPlaceholder')}
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
                  <option value="">{t('pages.config.userAllSections')}</option>
                  {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
              {(userQ || userSection) && (
                <button className="btn btn-ghost btn-sm" onClick={() => { setUserQ(''); setUserSection(''); setUserPage(1); }}>
                  {t('common.clear')}
                </button>
              )}
              <span className="text-muted text-sm" style={{ alignSelf: 'center', marginLeft: 'auto' }}>
                {usersTotal !== 1
                  ? t('pages.config.accountsCount').replace('{count}', String(usersTotal))
                  : t('pages.config.accountCount').replace('{count}', String(usersTotal))}
              </span>
            </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('pages.config.colName')}</th><th>{t('pages.config.colEmail')}</th><th>{t('pages.config.colRoles')}</th><th>{t('pages.config.colSection')}</th><th></th></tr></thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={5}><div className="empty-state"><p>{t('pages.config.noAccountsMatch')}</p></div></td></tr>
                )}
                {filtered.map(u => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 600 }}>{u.name}</td>
                    <td className="text-muted text-sm">{u.email || <span style={{ fontStyle: 'italic' }}>{t('common.notLinked')}</span>}</td>
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
        <Modal title={t('pages.config.modalNewHandler')} onClose={() => setOpenHandler(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenHandler(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={createHandler} disabled={saving}>{saving ? t('common.creating') : t('common.create')}</button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">{t('pages.config.handlerKeyLabel')}</label>
            <input className="form-input" placeholder="send_notification" value={handlerName}
              onChange={e => setHandlerName(e.target.value)} required autoFocus />
            <p className="form-hint">{t('pages.config.handlerKeyHint')}</p>
          </div>
        </Modal>
      )}

      {openWebhook && (
        <Modal title={t('pages.config.modalNewWebhook')} onClose={() => setOpenWebhook(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenWebhook(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={createWebhook} disabled={saving}>{saving ? t('common.creating') : t('common.create')}</button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">{t('pages.config.webhookNameLabel')}</label>
            <input className="form-input" placeholder="Slack Ops" value={whForm.name}
              onChange={e => setWhForm(f => ({ ...f, name: e.target.value }))} required />
          </div>
          <div className="form-group">
            <label className="form-label">{t('pages.config.webhookUrlLabel')}</label>
            <input className="form-input" type="url" placeholder="https://hooks.slack.com/…" value={whForm.url}
              onChange={e => setWhForm(f => ({ ...f, url: e.target.value }))} required />
          </div>
          <div className="form-group">
            <label className="form-label">{t('pages.config.webhookTypeLabel')}</label>
            <select className="form-select"
              value={whForm.isAlerts ? 'alerts' : 'task'}
              onChange={e => setWhForm(f => ({ ...f, isAlerts: e.target.value === 'alerts' }))}>
              <option value="task">{t('pages.config.webhookTypeTask')}</option>
              <option value="alerts">{t('pages.config.webhookTypeAlerts')}</option>
            </select>
          </div>
        </Modal>
      )}

      {editingWebhook && (
        <Modal title={t('pages.config.modalEditWebhook')} onClose={() => setEditingWebhook(null)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setEditingWebhook(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={saveWebhook} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">{t('pages.config.webhookNameLabel')}</label>
            <input className="form-input" value={editWhForm.name}
              onChange={e => setEditWhForm(f => ({ ...f, name: e.target.value }))} required autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">{t('pages.config.webhookUrlLabel')}</label>
            <input className="form-input" type="url" value={editWhForm.url}
              onChange={e => setEditWhForm(f => ({ ...f, url: e.target.value }))} required />
          </div>
          <div className="form-group">
            <label className="form-label">{t('pages.config.webhookTypeLabel')}</label>
            <select className="form-select"
              value={editWhForm.isAlerts ? 'alerts' : 'task'}
              onChange={e => setEditWhForm(f => ({ ...f, isAlerts: e.target.value === 'alerts' }))}>
              <option value="task">{t('pages.config.webhookTypeTask')}</option>
              <option value="alerts">{t('pages.config.webhookTypeAlerts')}</option>
            </select>
          </div>
        </Modal>
      )}

      {openInvite && (
        <Modal title={t('pages.config.modalNewInvitation')} onClose={() => setOpenInvite(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpenInvite(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={createInvitation} disabled={saving}>{saving ? t('common.creating') : t('common.generateLink')}</button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">{t('pages.config.invRoleLabel')}</label>
            <select className="form-select" value={invForm.role} onChange={e => setInvForm(f => ({ ...f, role: e.target.value as AccountRole }))}>
              <option value="user">User</option>
              <option value="bpo">BPO</option>
              {isSuperAdmin && <option value="admin">Admin</option>}
              {isSuperAdmin && <option value="director">Director</option>}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('pages.config.invSectionLabel')}</label>
            <select className="form-select" value={invForm.sectionId} onChange={e => setInvForm(f => ({ ...f, sectionId: e.target.value }))} required>
              <option value="">{t('pages.config.invSectionPlaceholder')}</option>
              {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </Modal>
      )}

      {inviteLink && (
        <Modal
          title={t('pages.config.modalInviteLinkReady')}
          onClose={() => setInviteLink(null)}
          footer={
            <button className="btn btn-primary" onClick={() => setInviteLink(null)}>{t('common.done')}</button>
          }
        >
          <p className="text-muted text-sm" style={{ marginBottom: 12 }}>
            {t('pages.config.invLinkHint')}
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
              {copied ? t('pages.config.invLinkCopied') : t('pages.config.invLinkCopy')}
            </button>
          </div>
        </Modal>
      )}
      {editingUser && (
        <Modal
          title={t('pages.config.editUserTitle').replace('{name}', editingUser.name)}
          onClose={() => setEditingUser(null)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setEditingUser(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={saveEditUser} disabled={saving || editUserRoles.length === 0}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          {isSuperAdmin && (
            <div className="form-group">
              <label className="form-label">{t('pages.config.editUserSectionLabel')}</label>
              <select className="form-select" value={editUserSection} onChange={e => setEditUserSection(e.target.value)}>
                <option value="">{t('pages.config.editUserNoSection')}</option>
                {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">{t('pages.config.editUserRolesLabel')}</label>
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
            {editUserRoles.length === 0 && <p style={{ fontSize: '0.75rem', color: 'var(--red)', marginTop: 4 }}>{t('pages.config.editUserRolesRequired')}</p>}
          </div>
          {isSuperAdmin && editingUser?.roles.includes('admin') && (
            <div className="form-group">
              <label className="form-label">{t('pages.config.editUserModulesLabel')}</label>
              <p className="form-hint" style={{ marginBottom: 8 }}>{t('pages.config.editUserModulesHint')}</p>
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
              <label className="form-label">{t('pages.config.editUserBpoPermsLabel')}</label>
              <p className="form-hint" style={{ marginBottom: 8 }}>{t('pages.config.editUserBpoPermsHint')}</p>
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
