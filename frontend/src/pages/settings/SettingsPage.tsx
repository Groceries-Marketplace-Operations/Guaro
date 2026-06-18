import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import { appConfigApi, assignmentRulesApi, accountsApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useT } from '../../i18n';
import type { AppConfigOption, BrandAssignmentRule, Account } from '../../types';

const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="14" height="14">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="13" height="13">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
    <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
  </svg>
);
const EditIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="13" height="13">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);

type Tab = 'assignment' | 'catalog';

const CATEGORY_LABELS: Record<string, string> = {
  country: 'Countries',
  ka_type: 'KA Types',
  menu_integration: 'Menu Integration',
  picking_mode: 'Picking Mode',
  payment_mode: 'Payment Mode',
  shop_status: 'Shop Status',
};

const CATEGORY_ORDER = ['country', 'ka_type', 'menu_integration', 'picking_mode', 'payment_mode', 'shop_status'];

export default function SettingsPage() {
  const { account } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const t = useT();
  const isSA = account?.roles.includes('super_admin') ?? false;

  if (!isSA) {
    nav('/');
    return null;
  }

  const [tab, setTab] = useState<Tab>('assignment');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const [editingRule, setEditingRule] = useState<BrandAssignmentRule | null>(null);
  const [ruleModo, setRuleModo] = useState<'fixed' | 'round_robin'>('round_robin');
  const [addingCandidateRuleId, setAddingCandidateRuleId] = useState<string | null>(null);
  const [candidateAccountId, setCandidateAccountId] = useState('');

  const [addingCat, setAddingCat] = useState<string | null>(null);
  const [newOptForm, setNewOptForm] = useState({ value: '', label: '' });
  const [editingOpt, setEditingOpt] = useState<AppConfigOption | null>(null);
  const [editOptLabel, setEditOptLabel] = useState('');

  const { data: rulesRaw = [] } = useQuery<BrandAssignmentRule[]>({
    queryKey: ['assignment-rules'],
    queryFn: () => assignmentRulesApi.list().then(r => r.data as BrandAssignmentRule[]),
  });

  const { data: configRaw = {} } = useQuery<Record<string, AppConfigOption[]>>({
    queryKey: ['app-config'],
    queryFn: () => appConfigApi.all().then(r => r.data),
  });

  const { data: bposResult } = useQuery<{ data: Account[] }>({
    queryKey: ['accounts', 'bpo'],
    queryFn: () => accountsApi.list({ role: 'bpo', limit: 200 }).then(r => r.data as { data: Account[] }),
    enabled: tab === 'assignment',
  });
  const bpos: Account[] = bposResult?.data ?? [];

  const openEditRule = (rule: BrandAssignmentRule) => {
    setEditingRule(rule);
    setRuleModo(rule.modo);
    setErr('');
  };

  const saveRule = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      await assignmentRulesApi.update(editingRule!.id, ruleModo);
      qc.invalidateQueries({ queryKey: ['assignment-rules'] });
      setEditingRule(null);
    } catch { setErr(t('pages.settings.errorSavingRule')); } finally { setSaving(false); }
  };

  const openAddCandidate = (ruleId: string) => {
    setAddingCandidateRuleId(ruleId);
    setCandidateAccountId('');
    setErr('');
  };

  const addCandidate = async (e: React.FormEvent) => {
    e.preventDefault(); if (!candidateAccountId) return;
    setSaving(true); setErr('');
    try {
      await assignmentRulesApi.addCandidate(addingCandidateRuleId!, candidateAccountId);
      qc.invalidateQueries({ queryKey: ['assignment-rules'] });
      setAddingCandidateRuleId(null);
    } catch { setErr(t('pages.settings.errorAddingCandidate')); } finally { setSaving(false); }
  };

  const removeCandidate = async (ruleId: string, accountId: string) => {
    if (!window.confirm(t('pages.settings.removeFromPool'))) return;
    try {
      await assignmentRulesApi.removeCandidate(ruleId, accountId);
      qc.invalidateQueries({ queryKey: ['assignment-rules'] });
    } catch { /* ignore */ }
  };

  const toggleActive = async (opt: AppConfigOption) => {
    try {
      await appConfigApi.patch(opt.id, { active: !opt.active });
      qc.invalidateQueries({ queryKey: ['app-config'] });
    } catch { /* ignore */ }
  };

  const openAddOpt = (category: string) => {
    setAddingCat(category);
    setNewOptForm({ value: '', label: '' });
    setErr('');
  };

  const saveNewOpt = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      await appConfigApi.upsert({ category: addingCat, ...newOptForm, active: true });
      qc.invalidateQueries({ queryKey: ['app-config'] });
      setAddingCat(null);
    } catch { setErr(t('pages.settings.errorCreatingOption')); } finally { setSaving(false); }
  };

  const openEditOpt = (opt: AppConfigOption) => {
    setEditingOpt(opt);
    setEditOptLabel(opt.label);
    setErr('');
  };

  const saveEditOpt = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      await appConfigApi.patch(editingOpt!.id, { label: editOptLabel });
      qc.invalidateQueries({ queryKey: ['app-config'] });
      setEditingOpt(null);
    } catch { setErr(t('pages.settings.errorSavingOption')); } finally { setSaving(false); }
  };

  const deleteOpt = async (opt: AppConfigOption) => {
    if (!window.confirm(t('pages.settings.deleteOptionConfirm').replace('{label}', opt.label))) return;
    try {
      await appConfigApi.remove(opt.id);
      qc.invalidateQueries({ queryKey: ['app-config'] });
    } catch { /* ignore */ }
  };

  const ruleModeLabel = (m: string) => m === 'fixed' ? t('pages.settings.modeFixed').split(' — ')[0] + ' (1 BPO)' : 'Round Robin';
  const kaLabel: Record<string, string> = { KA: 'KA', CKA: 'CKA', SME: 'SME' };
  const countryLabel: Record<string, string> = { CO: '🇨🇴 CO', MX: '🇲🇽 MX', CR: '🇨🇷 CR' };

  const sortedRules = [...rulesRaw].sort((a, b) => {
    const kaOrder = ['KA', 'CKA', 'SME'];
    const countryOrder = ['CO', 'MX', 'CR'];
    if (a.kaType !== b.kaType) return kaOrder.indexOf(a.kaType) - kaOrder.indexOf(b.kaType);
    return countryOrder.indexOf(a.country) - countryOrder.indexOf(b.country);
  });

  const orderedCategories = CATEGORY_ORDER.filter(c => configRaw[c]);
  const extraCategories = Object.keys(configRaw).filter(c => !CATEGORY_ORDER.includes(c));

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.settings') }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{t('pages.settings.title')}</h1>
            <p>{t('pages.settings.subtitle')}</p>
          </div>
        </div>

        <div className="tabs">
          <div className={`tab ${tab === 'assignment' ? 'active' : ''}`} onClick={() => setTab('assignment')}>
            {t('pages.settings.tabAssignment')}
          </div>
          <div className={`tab ${tab === 'catalog' ? 'active' : ''}`} onClick={() => setTab('catalog')}>
            {t('pages.settings.tabCatalog')}
          </div>
        </div>

        {tab === 'assignment' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 4 }}>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              {t('pages.settings.assignmentHint')}
            </p>

            {sortedRules.map(rule => (
              <div key={rule.id} className="card" style={{ padding: '16px 20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>{kaLabel[rule.kaType]} — {countryLabel[rule.country]}</span>
                    <span style={{
                      fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                      background: rule.modo === 'fixed' ? 'var(--blue-bg)' : 'var(--orange-muted)',
                      color: rule.modo === 'fixed' ? 'var(--blue)' : 'var(--orange)',
                    }}>
                      {ruleModeLabel(rule.modo)}
                    </span>
                  </div>
                  <button className="btn btn-ghost btn-sm" style={{ padding: '4px 10px' }} onClick={() => openEditRule(rule)}>
                    <EditIcon /> {t('pages.settings.editMode')}
                  </button>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t('pages.settings.bpoPool')}</span>
                  {rule.candidates.length === 0 && (
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>{t('pages.settings.noBposAssigned')}</span>
                  )}
                  {rule.candidates.map(c => (
                    <div key={c.accountId} style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      background: 'var(--surface-2)', border: '1px solid var(--border)',
                      borderRadius: 999, padding: '3px 10px 3px 12px', fontSize: '0.8rem',
                    }}>
                      <span>{c.account.name}</span>
                      <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{c.account.email}</span>
                      <button
                        onClick={() => removeCandidate(rule.id, c.accountId)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 2, marginLeft: 2 }}
                        title="Remove"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button className="btn btn-ghost btn-sm" style={{ padding: '3px 10px', fontSize: '0.78rem' }}
                    onClick={() => openAddCandidate(rule.id)}>
                    <PlusIcon /> {t('pages.settings.addBpo')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'catalog' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: 4 }}>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              {t('pages.settings.catalogHint')}
            </p>

            {[...orderedCategories, ...extraCategories].map(cat => {
              const opts: AppConfigOption[] = configRaw[cat] ?? [];
              return (
                <div key={cat} className="card" style={{ padding: '16px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{CATEGORY_LABELS[cat] ?? cat}</span>
                    <button className="btn btn-ghost btn-sm" style={{ padding: '4px 10px' }} onClick={() => openAddOpt(cat)}>
                      <PlusIcon /> {t('pages.settings.addOption')}
                    </button>
                  </div>
                  <div className="table-wrap" style={{ border: 'none', borderRadius: 0, margin: 0 }}>
                    <table>
                      <thead>
                        <tr>
                          <th>{t('pages.settings.colValue')}</th>
                          <th>{t('pages.settings.colLabel')}</th>
                          <th>{t('pages.settings.colStatus')}</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {opts.length === 0 && (
                          <tr><td colSpan={4}><div className="empty-state" style={{ padding: 12 }}><p>{t('pages.settings.noOptions')}</p></div></td></tr>
                        )}
                        {opts.map(opt => (
                          <tr key={opt.id} style={{ opacity: opt.active ? 1 : 0.55 }}>
                            <td className="td-mono" style={{ fontWeight: 600, fontSize: '0.8rem' }}>{opt.value}</td>
                            <td>{opt.label}</td>
                            <td>
                              <button
                                onClick={() => toggleActive(opt)}
                                style={{
                                  fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                                  border: 'none', cursor: 'pointer',
                                  background: opt.active ? 'var(--green-bg)' : 'var(--surface-2)',
                                  color: opt.active ? '#027A48' : 'var(--text-muted)',
                                }}
                              >
                                {opt.active ? t('common.active') : t('common.inactive')}
                              </button>
                            </td>
                            <td>
                              <div style={{ display: 'flex', gap: 4 }}>
                                <button className="btn btn-ghost btn-sm" style={{ padding: '3px 8px' }}
                                  onClick={() => openEditOpt(opt)} title={t('common.rename')}>
                                  <EditIcon />
                                </button>
                                <button className="btn btn-ghost btn-sm" style={{ padding: '3px 8px', color: 'var(--red)' }}
                                  onClick={() => deleteOpt(opt)} title={t('common.delete')}>
                                  <TrashIcon />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {editingRule && (
        <Modal title={t('pages.settings.modalEditRule').replace('{name}', `${editingRule.kaType} × ${editingRule.country}`)}
          onClose={() => setEditingRule(null)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setEditingRule(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={saveRule} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">{t('pages.settings.assignmentModeLabel')}</label>
            <select className="form-select" value={ruleModo} onChange={e => setRuleModo(e.target.value as 'fixed' | 'round_robin')}>
              <option value="fixed">{t('pages.settings.modeFixed')}</option>
              <option value="round_robin">{t('pages.settings.modeRoundRobin')}</option>
            </select>
          </div>
          <p className="form-hint">{t('pages.settings.modeHint')}</p>
        </Modal>
      )}

      {addingCandidateRuleId && (
        <Modal title={t('pages.settings.modalAddBpo')}
          onClose={() => setAddingCandidateRuleId(null)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setAddingCandidateRuleId(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={addCandidate} disabled={saving || !candidateAccountId}>
              {saving ? t('pages.settings.adding') : t('common.add')}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">{t('pages.settings.bpoLabel')}</label>
            <select className="form-select" value={candidateAccountId} onChange={e => setCandidateAccountId(e.target.value)}>
              <option value="">{t('pages.settings.bpoPlaceholder')}</option>
              {bpos.map(b => (
                <option key={b.id} value={b.id}>{b.name} ({b.email})</option>
              ))}
            </select>
          </div>
        </Modal>
      )}

      {addingCat && (
        <Modal title={t('pages.settings.modalAddOption').replace('{category}', CATEGORY_LABELS[addingCat] ?? addingCat)}
          onClose={() => setAddingCat(null)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setAddingCat(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={saveNewOpt} disabled={saving || !newOptForm.value || !newOptForm.label}>
              {saving ? t('pages.settings.creating') : t('common.create')}
            </button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">{t('pages.settings.optValueLabel')}</label>
            <input className="form-input" value={newOptForm.value} placeholder={t('pages.settings.optValuePlaceholder')}
              onChange={e => setNewOptForm(f => ({ ...f, value: e.target.value }))} autoFocus />
            <p className="form-hint">{t('pages.settings.optValueHint')}</p>
          </div>
          <div className="form-group">
            <label className="form-label">{t('pages.settings.optLabelLabel')}</label>
            <input className="form-input" value={newOptForm.label} placeholder={t('pages.settings.optLabelPlaceholder')}
              onChange={e => setNewOptForm(f => ({ ...f, label: e.target.value }))} />
          </div>
        </Modal>
      )}

      {editingOpt && (
        <Modal title={t('pages.settings.modalRename').replace('{value}', editingOpt.value)}
          onClose={() => setEditingOpt(null)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setEditingOpt(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={saveEditOpt} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">{t('pages.settings.renameLabelLabel')}</label>
            <input className="form-input" value={editOptLabel} onChange={e => setEditOptLabel(e.target.value)} autoFocus />
          </div>
        </Modal>
      )}
    </>
  );
}
