import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import { sectionsApi } from '../../api';
import { useT } from '../../i18n';
import type { AccountRole, Section } from '../../types';

type RoleAccessResponse = {
  sections: Array<Pick<Section, 'id' | 'name' | 'order'>>;
  roles: Array<{ role: AccountRole; implicitAll: boolean; sectionIds: string[] }>;
};

const ROLE_LABELS: Record<AccountRole, string> = {
  user: 'User', bpo: 'BPO', admin: 'Admin', director: 'Director', super_admin: 'Super Admin',
};

const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);

export default function SectionsList() {
  const qc = useQueryClient();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const { data: sections = [], isLoading } = useQuery<Section[]>({
    queryKey: ['sections'],
    queryFn: () => sectionsApi.list().then(r => r.data),
  });
  const { data: roleAccess } = useQuery<RoleAccessResponse>({
    queryKey: ['section-role-access'],
    queryFn: () => sectionsApi.roleAccess().then(r => r.data),
  });

  const moveSection = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= sections.length) return;
    const reordered = [...sections];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setSaving(true); setErr('');
    try {
      await sectionsApi.reorder(reordered.map((section, order) => ({ id: section.id, order })));
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['sections'] }),
        qc.invalidateQueries({ queryKey: ['section-role-access'] }),
        qc.invalidateQueries({ queryKey: ['task-types'] }),
      ]);
    } catch (ex: unknown) {
      const e2 = ex as { response?: { data?: { message?: string } } };
      setErr(e2.response?.data?.message ?? 'No se pudo actualizar el orden.');
    } finally { setSaving(false); }
  };

  const toggleRoleSection = async (role: AccountRole, sectionId: string) => {
    const current = roleAccess?.roles.find(item => item.role === role);
    if (!current || current.implicitAll) return;
    const sectionIds = current.sectionIds.includes(sectionId)
      ? current.sectionIds.filter(id => id !== sectionId)
      : [...current.sectionIds, sectionId];
    setSaving(true); setErr('');
    try {
      await sectionsApi.updateRoleAccess(role, sectionIds);
      await qc.invalidateQueries({ queryKey: ['section-role-access'] });
    } catch (ex: unknown) {
      const e2 = ex as { response?: { data?: { message?: string } } };
      setErr(e2.response?.data?.message ?? 'No se pudieron actualizar los permisos.');
    } finally { setSaving(false); }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('');
    try {
      await sectionsApi.create({ name });
      qc.invalidateQueries({ queryKey: ['sections'] });
      setOpen(false); setName('');
    } catch (ex: unknown) {
      const e2 = ex as { response?: { data?: { message?: string } } };
      setErr(e2.response?.data?.message ?? 'Error');
    } finally { setSaving(false); }
  };

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.sections') }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{t('pages.sections.title')}</h1>
            <p>{t('pages.sections.subtitle')}</p>
          </div>
          <button className="btn btn-primary" onClick={() => setOpen(true)}><PlusIcon /> {t('pages.sections.newSection')}</button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('pages.sections.colName')}</th>
                <th>{t('pages.sections.colTaskTypes')}</th>
                <th>{t('pages.sections.colMembers')}</th>
                <th>{t('pages.sections.colCreated')}</th>
                <th style={{ textAlign: 'right' }}>Orden</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={5} style={{ padding: '20px 16px', color: 'var(--text-muted)' }}>{t('common.loading')}</td></tr>}
              {!isLoading && sections.length === 0 && (
                <tr><td colSpan={5}><div className="empty-state"><h3>{t('pages.sections.noSections')}</h3><p>{t('pages.sections.noSectionsHint')}</p></div></td></tr>
              )}
              {sections.map((s, index) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{s.name}</td>
                  <td>{s._count?.taskTypes ?? 0}</td>
                  <td>{s._count?.accounts ?? 0}</td>
                  <td className="text-muted text-sm">{new Date(s.createdAt).toLocaleDateString()}</td>
                  <td><div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
                    <button className="btn btn-ghost btn-sm" disabled={saving || index === 0} onClick={() => moveSection(index, -1)} title="Mover arriba">↑</button>
                    <button className="btn btn-ghost btn-sm" disabled={saving || index === sections.length - 1} onClick={() => moveSection(index, 1)} title="Mover abajo">↓</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card" style={{ marginTop: 20 }}>
          <div className="card-header"><div>
            <div className="card-title">Acceso de secciones por rol</div>
            <p className="text-muted text-sm" style={{ marginTop: 4 }}>Activa las secciones que cada rol puede consultar y usar al crear tasks. Super Admin siempre conserva acceso total.</p>
          </div></div>
          {err && <div className="error-banner" style={{ marginBottom: 12 }}>{err}</div>}
          <div className="table-wrap" style={{ border: 0 }}><table>
            <thead><tr><th>Rol</th>{roleAccess?.sections.map(section => <th key={section.id}>{section.name}</th>)}</tr></thead>
            <tbody>{roleAccess?.roles.map(role => <tr key={role.role}>
              <td style={{ fontWeight: 700 }}>{ROLE_LABELS[role.role]}</td>
              {roleAccess.sections.map(section => <td key={section.id}>
                <input
                  type="checkbox"
                  checked={role.implicitAll || role.sectionIds.includes(section.id)}
                  disabled={saving || role.implicitAll}
                  onChange={() => toggleRoleSection(role.role, section.id)}
                  aria-label={`${ROLE_LABELS[role.role]} · ${section.name}`}
                />
              </td>)}
            </tr>)}</tbody>
          </table></div>
        </div>
      </main>

      {open && (
        <Modal title={t('pages.sections.modalTitle')} onClose={() => setOpen(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>{saving ? t('pages.sections.creating') : t('common.create')}</button>
          </>}
        >
          {err && <div className="error-banner">{err}</div>}
          <div className="form-group">
            <label className="form-label">{t('pages.sections.sectionNameLabel')}</label>
            <input className="form-input" placeholder="Operations MX" value={name}
              onChange={e => setName(e.target.value)} required autoFocus />
          </div>
        </Modal>
      )}
    </>
  );
}
