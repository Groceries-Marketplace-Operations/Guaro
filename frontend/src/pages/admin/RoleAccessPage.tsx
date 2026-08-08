import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import { accessControlApi } from '../../api';
import type { AccountRole, Paginated } from '../../types';

interface CatalogItem {
  key: string;
  group: string;
  label: string;
  description: string;
  allowedRoles: AccountRole[];
}
interface SectionItem { id: string; name: string; order: number }
interface MatrixRole {
  role: AccountRole;
  implicitAll: boolean;
  profileCount: number;
  permissions: string[];
  sectionIds: string[];
}
interface MatrixResponse {
  catalog: CatalogItem[];
  sections: SectionItem[];
  roles: MatrixRole[];
  userOverrideCount: number;
}
interface PermissionOverride { permission: string; allowed: boolean }
interface LayeredPolicyPayload {
  permissionOverrides: PermissionOverride[];
  customSectionAccess: boolean;
  sectionIds: string[];
}
interface AccessAccount {
  id: string;
  name: string;
  email: string;
  roles: AccountRole[];
  sectionId: string | null;
  section?: { id: string; name: string } | null;
  accessProfile?: { updatedAt: string } | null;
  _count: { accessPermissionOverrides: number; accessSectionScopes: number };
}
interface AccountProfileResponse {
  account: AccessAccount;
  immutable: boolean;
  inheritedPermissions: string[];
  permissionOverrides: PermissionOverride[];
  effectivePermissions: string[];
  inheritedSectionIds: string[];
  customSectionAccess: boolean;
  sectionIds: string[];
  effectiveSectionIds: string[];
  updatedAt: string | null;
}
interface RoleSectionProfileResponse {
  role: AccountRole;
  section: SectionItem;
  basePermissions: string[];
  baseSectionIds: string[];
  permissionOverrides: PermissionOverride[];
  customSectionAccess: boolean;
  sectionIds: string[];
  effectivePermissions: string[];
  effectiveSectionIds: string[];
  updatedAt: string | null;
}

const ROLE_LABELS: Record<AccountRole, string> = {
  user: 'Usuario', bpo: 'BPO', admin: 'Admin', director: 'Director', super_admin: 'Super Admin',
};
const EDITABLE_ROLES: AccountRole[] = ['user', 'bpo', 'admin', 'director'];

function groupedCatalog(catalog: CatalogItem[]) {
  const groups = new Map<string, CatalogItem[]>();
  for (const item of catalog) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  return [...groups.entries()];
}

function SummaryPill({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'allow' | 'deny' }) {
  const colors = tone === 'allow'
    ? { background: '#ecfdf3', color: '#087443' }
    : tone === 'deny'
      ? { background: '#fff1f0', color: '#b42318' }
      : { background: 'var(--surface-2)', color: 'var(--text-secondary)' };
  return <span style={{ ...colors, borderRadius: 999, padding: '3px 8px', fontSize: 11, fontWeight: 700 }}>{children}</span>;
}

function BaseRolePanel({ matrix }: { matrix: MatrixResponse }) {
  const qc = useQueryClient();
  const [selectedRole, setSelectedRole] = useState<AccountRole>('admin');
  const [drafts, setDrafts] = useState<Partial<Record<AccountRole, { permissions: string[]; sectionIds: string[] }>>>({});
  const [message, setMessage] = useState('');
  const selected = matrix.roles.find(role => role.role === selectedRole)!;
  const permissions = drafts[selectedRole]?.permissions ?? selected.permissions;
  const sectionIds = drafts[selectedRole]?.sectionIds ?? selected.sectionIds;
  const setPermissions = (next: string[]) => setDrafts(previous => ({ ...previous, [selectedRole]: { permissions: next, sectionIds } }));
  const setSectionIds = (next: string[]) => setDrafts(previous => ({ ...previous, [selectedRole]: { permissions, sectionIds: next } }));
  const groups = useMemo(() => groupedCatalog(matrix.catalog), [matrix.catalog]);
  const save = useMutation({
    mutationFn: (payload: { role: AccountRole; permissions: string[]; sectionIds: string[] }) =>
      accessControlApi.updateRole(payload.role, { permissions: payload.permissions, sectionIds: payload.sectionIds }),
    onSuccess: async (_, variables) => {
      await qc.invalidateQueries({ queryKey: ['access-control-matrix'] });
      setDrafts(previous => { const next = { ...previous }; delete next[variables.role]; return next; });
      setMessage('Permisos base guardados. Los perfiles más específicos se mantienen sin cambios.');
    },
    onError: () => setMessage('No se pudieron guardar los permisos base.'),
  });
  const toggle = (value: string, values: string[], setter: (next: string[]) => void) =>
    setter(values.includes(value) ? values.filter(item => item !== value) : [...values, value]);
  const readOnly = selected.implicitAll;

  return <div style={{ display: 'grid', gap: 18 }}>
    <div className="alert alert-info">
      Esta es la capa base. Los perfiles Rol + Sección y Usuario pueden permitir o denegar elementos concretos sin modificar este valor general.
    </div>
    <div className="tabs">
      {matrix.roles.map(role => <button key={role.role} className={`tab ${selectedRole === role.role ? 'active' : ''}`} disabled={save.isPending} onClick={() => { setSelectedRole(role.role); setMessage(''); }}>
        {ROLE_LABELS[role.role]} {role.profileCount > 0 && <small>({role.profileCount} perfiles)</small>}
      </button>)}
    </div>
    {readOnly && <div className="alert alert-info">Super Admin tiene acceso total permanente y no acepta restricciones.</div>}
    {groups.map(([group, items]) => {
      const eligible = items.filter(item => item.allowedRoles.includes(selectedRole));
      const allSelected = eligible.length > 0 && eligible.every(item => permissions.includes(item.key));
      return <section className="card" key={group} style={{ padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div><strong>{group}</strong><p className="text-muted text-sm" style={{ marginTop: 3 }}>{items.length} permisos</p></div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
            <input type="checkbox" checked={allSelected} disabled={readOnly || !eligible.length} onChange={() => {
              const keys = eligible.map(item => item.key);
              setPermissions(allSelected ? permissions.filter(key => !keys.includes(key)) : [...new Set([...permissions, ...keys])]);
            }} /> Todo el grupo
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))', gap: 10 }}>
          {items.map(item => {
            const available = readOnly || item.allowedRoles.includes(selectedRole);
            return <label key={item.key} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, display: 'flex', gap: 10, opacity: available ? 1 : 0.5 }}>
              <input type="checkbox" checked={permissions.includes(item.key)} disabled={readOnly || !available} onChange={() => toggle(item.key, permissions, setPermissions)} />
              <span><strong style={{ display: 'block', fontSize: 13 }}>{item.label}</strong><span className="text-muted" style={{ fontSize: 11 }}>{item.description}</span>{!available && <small className="text-muted" style={{ display: 'block', marginTop: 4 }}>No disponible para este rol.</small>}</span>
            </label>;
          })}
        </div>
      </section>;
    })}
    <SectionSelector sections={matrix.sections} selected={sectionIds} disabled={readOnly} onChange={setSectionIds} title="Secciones base de tareas" />
    {message && <div className={message.startsWith('Permisos base') ? 'alert alert-info' : 'error-banner'}>{message}</div>}
    {!readOnly && <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate({ role: selectedRole, permissions, sectionIds })}>{save.isPending ? 'Guardando…' : `Guardar base de ${ROLE_LABELS[selectedRole]}`}</button></div>}
  </div>;
}

function SectionSelector({ sections, selected, disabled, onChange, title }: {
  sections: SectionItem[];
  selected: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
  title: string;
}) {
  return <section className="card" style={{ padding: 18 }}>
    <strong>{title}</strong>
    <p className="text-muted text-sm" style={{ margin: '4px 0 12px' }}>Controla los Task Types y tareas que forman parte del alcance de datos.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
      {sections.map(section => <label key={section.id} style={{ border: '1px solid var(--border)', borderRadius: 999, padding: '7px 12px', display: 'flex', gap: 7, opacity: disabled ? 0.65 : 1 }}>
        <input type="checkbox" checked={selected.includes(section.id)} disabled={disabled} onChange={() => onChange(selected.includes(section.id) ? selected.filter(id => id !== section.id) : [...selected, section.id])} /> {section.name}
      </label>)}
    </div>
  </section>;
}

function LayeredPolicyEditor({ catalog, sections, inheritedPermissions, inheritedSectionIds, initialOverrides, initialCustomSections, initialSectionIds, eligibleRoles, immutable, onSave }: {
  catalog: CatalogItem[];
  sections: SectionItem[];
  inheritedPermissions: string[];
  inheritedSectionIds: string[];
  initialOverrides: PermissionOverride[];
  initialCustomSections: boolean;
  initialSectionIds: string[];
  eligibleRoles: AccountRole[];
  immutable?: boolean;
  onSave: (payload: LayeredPolicyPayload) => Promise<unknown>;
}) {
  const initialMap = Object.fromEntries(initialOverrides.map(item => [item.permission, item.allowed ? 'allow' : 'deny'])) as Record<string, 'allow' | 'deny'>;
  const [overrides, setOverrides] = useState<Record<string, 'allow' | 'deny'>>(initialMap);
  const [customSections, setCustomSections] = useState(initialCustomSections);
  const [sectionIds, setSectionIds] = useState(initialSectionIds);
  const [message, setMessage] = useState('');
  const groups = useMemo(() => groupedCatalog(catalog), [catalog]);
  const payload = (): LayeredPolicyPayload => ({
    permissionOverrides: Object.entries(overrides).map(([permission, effect]) => ({ permission, allowed: effect === 'allow' })),
    customSectionAccess: customSections,
    sectionIds: customSections ? sectionIds : [],
  });
  const effectivePermissions = useMemo(() => {
    const values = new Set(inheritedPermissions);
    for (const [permission, effect] of Object.entries(overrides)) {
      if (effect === 'allow') values.add(permission);
      else values.delete(permission);
    }
    return [...values];
  }, [inheritedPermissions, overrides]);
  const save = useMutation({
    mutationFn: onSave,
    onSuccess: () => setMessage('Perfil guardado y aplicado.'),
    onError: () => setMessage('No se pudo guardar el perfil.'),
  });
  const reset = () => {
    setOverrides({});
    setCustomSections(false);
    setSectionIds([]);
    save.mutate({ permissionOverrides: [], customSectionAccess: false, sectionIds: [] });
  };

  return <div style={{ display: 'grid', gap: 18 }}>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <SummaryPill>{inheritedPermissions.length} heredados</SummaryPill>
      <SummaryPill tone="allow">{Object.values(overrides).filter(value => value === 'allow').length} permitidos explícitamente</SummaryPill>
      <SummaryPill tone="deny">{Object.values(overrides).filter(value => value === 'deny').length} denegados explícitamente</SummaryPill>
      <SummaryPill>{effectivePermissions.length} efectivos</SummaryPill>
    </div>
    {groups.map(([group, items]) => <section className="card" key={group} style={{ padding: 18 }}>
      <strong>{group}</strong>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: 10, marginTop: 12 }}>
        {items.map(item => {
          const available = immutable || eligibleRoles.some(role => item.allowedRoles.includes(role));
          const inherited = inheritedPermissions.includes(item.key);
          const value = overrides[item.key] ?? 'inherit';
          return <div key={item.key} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, opacity: available ? 1 : 0.48 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <span><strong style={{ display: 'block', fontSize: 13 }}>{item.label}</strong><span className="text-muted" style={{ fontSize: 11 }}>{item.description}</span></span>
              <select className="form-select" style={{ width: 122, margin: 0, flexShrink: 0 }} value={value} disabled={immutable || !available} onChange={event => {
                const next = { ...overrides };
                if (event.target.value === 'inherit') delete next[item.key];
                else next[item.key] = event.target.value as 'allow' | 'deny';
                setOverrides(next);
              }}>
                <option value="inherit">Heredar: {inherited ? 'Sí' : 'No'}</option>
                <option value="allow">Permitir</option>
                <option value="deny">Denegar</option>
              </select>
            </div>
          </div>;
        })}
      </div>
    </section>)}
    <section className="card" style={{ padding: 18 }}>
      <strong>Alcance de secciones</strong>
      <div style={{ display: 'flex', gap: 18, margin: '12px 0' }}>
        <label><input type="radio" checked={!customSections} disabled={immutable} onChange={() => setCustomSections(false)} /> Heredar ({inheritedSectionIds.length})</label>
        <label><input type="radio" checked={customSections} disabled={immutable} onChange={() => setCustomSections(true)} /> Personalizar</label>
      </div>
      {customSections
        ? <SectionSelector sections={sections} selected={sectionIds} disabled={immutable} onChange={setSectionIds} title="Secciones permitidas" />
        : <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{sections.filter(section => inheritedSectionIds.includes(section.id)).map(section => <SummaryPill key={section.id}>{section.name}</SummaryPill>)}</div>}
    </section>
    {message && <div className={message.startsWith('Perfil guardado') ? 'alert alert-info' : 'error-banner'}>{message}</div>}
    {!immutable && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
      <button className="btn btn-ghost" disabled={save.isPending} onClick={reset}>Restablecer herencia</button>
      <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(payload())}>{save.isPending ? 'Guardando…' : 'Guardar perfil'}</button>
    </div>}
  </div>;
}

function RoleSectionPanel({ matrix }: { matrix: MatrixResponse }) {
  const qc = useQueryClient();
  const [role, setRole] = useState<AccountRole>('admin');
  const [sectionChoice, setSectionChoice] = useState('');
  const sectionId = sectionChoice || matrix.sections[0]?.id || '';
  const profile = useQuery<RoleSectionProfileResponse>({
    queryKey: ['access-role-section', role, sectionId],
    queryFn: () => accessControlApi.roleSectionProfile(role, sectionId).then(response => response.data),
    enabled: Boolean(sectionId),
  });
  return <div style={{ display: 'grid', gap: 18 }}>
    <div className="alert alert-info"><strong>Ejemplo:</strong> Admin + Commercial puede tener integraciones distintas de Admin + Catalog. Las excepciones de esta capa prevalecen sobre el rol base.</div>
    <section className="card" style={{ padding: 18, display: 'grid', gridTemplateColumns: 'minmax(200px, 1fr) minmax(240px, 1fr)', gap: 14 }}>
      <div><label className="form-label">Rol</label><select className="form-select" value={role} onChange={event => setRole(event.target.value as AccountRole)}>{EDITABLE_ROLES.map(value => <option key={value} value={value}>{ROLE_LABELS[value]}</option>)}</select></div>
      <div><label className="form-label">Sección del usuario</label><select className="form-select" value={sectionId} onChange={event => setSectionChoice(event.target.value)}>{matrix.sections.map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select></div>
    </section>
    {profile.isLoading && <p className="text-muted">Cargando perfil…</p>}
    {profile.data && <LayeredPolicyEditor
      key={`${role}:${sectionId}:${profile.data.updatedAt ?? 'new'}`}
      catalog={matrix.catalog}
      sections={matrix.sections}
      inheritedPermissions={profile.data.basePermissions}
      inheritedSectionIds={profile.data.baseSectionIds}
      initialOverrides={profile.data.permissionOverrides}
      initialCustomSections={profile.data.customSectionAccess}
      initialSectionIds={profile.data.sectionIds}
      eligibleRoles={[role]}
      onSave={payload => accessControlApi.updateRoleSectionProfile(role, sectionId, payload).then(response => {
        qc.setQueryData(['access-role-section', role, sectionId], response.data);
        void qc.invalidateQueries({ queryKey: ['access-control-matrix'] });
        return response.data;
      })}
    />}
  </div>;
}

function UserPanel({ matrix }: { matrix: MatrixResponse }) {
  const qc = useQueryClient();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const accounts = useQuery<Paginated<AccessAccount>>({
    queryKey: ['access-accounts', query],
    queryFn: () => accessControlApi.accounts({ q: query, limit: 50 }).then(response => response.data),
  });
  const profile = useQuery<AccountProfileResponse>({
    queryKey: ['access-account-profile', selectedId],
    queryFn: () => accessControlApi.accountProfile(selectedId).then(response => response.data),
    enabled: Boolean(selectedId),
  });
  return <div style={{ display: 'grid', gap: 18 }}>
    <div className="alert alert-info">La excepción individual es la capa final: puede retirar o conceder un permiso a una sola persona sin afectar a compañeros con el mismo rol y sección.</div>
    <section className="card" style={{ padding: 18 }}>
      <form onSubmit={event => { event.preventDefault(); setQuery(input.trim()); }} style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <input className="form-input" value={input} onChange={event => setInput(event.target.value)} placeholder="Buscar por nombre o correo" />
        <button className="btn btn-primary" type="submit">Buscar</button>
      </form>
      <div className="table-wrap"><table><thead><tr><th>Usuario</th><th>Rol</th><th>Sección</th><th>Excepciones</th><th></th></tr></thead><tbody>
        {(accounts.data?.data ?? []).map(account => <tr key={account.id}>
          <td><strong>{account.name}</strong><div className="text-muted text-sm">{account.email}</div></td>
          <td>{account.roles.map(role => <SummaryPill key={role}>{ROLE_LABELS[role]}</SummaryPill>)}</td>
          <td>{account.section?.name ?? 'Sin sección'}</td>
          <td>{account._count.accessPermissionOverrides + account._count.accessSectionScopes}</td>
          <td><button className="btn btn-ghost btn-sm" onClick={() => setSelectedId(account.id)}>Configurar</button></td>
        </tr>)}
        {!accounts.isLoading && !accounts.data?.data.length && <tr><td colSpan={5}><div className="empty-state"><p>No se encontraron usuarios.</p></div></td></tr>}
      </tbody></table></div>
    </section>
    {profile.isLoading && <p className="text-muted">Cargando acceso individual…</p>}
    {profile.data && <>
      <section className="card" style={{ padding: 18 }}><strong>{profile.data.account.name}</strong><p className="text-muted text-sm">{profile.data.account.email} · {profile.data.account.section?.name ?? 'Sin sección'} · {profile.data.account.roles.map(role => ROLE_LABELS[role]).join(', ')}</p></section>
      {profile.data.immutable && <div className="alert alert-info">Super Admin conserva acceso total y no admite excepciones individuales.</div>}
      <LayeredPolicyEditor
        key={`${selectedId}:${profile.data.updatedAt ?? 'new'}`}
        catalog={matrix.catalog}
        sections={matrix.sections}
        inheritedPermissions={profile.data.inheritedPermissions}
        inheritedSectionIds={profile.data.inheritedSectionIds}
        initialOverrides={profile.data.permissionOverrides}
        initialCustomSections={profile.data.customSectionAccess}
        initialSectionIds={profile.data.sectionIds}
        eligibleRoles={profile.data.account.roles}
        immutable={profile.data.immutable}
        onSave={payload => accessControlApi.updateAccountProfile(selectedId, payload).then(response => {
          qc.setQueryData(['access-account-profile', selectedId], response.data);
          void qc.invalidateQueries({ queryKey: ['access-accounts'] });
          return response.data;
        })}
      />
    </>}
  </div>;
}

function AuditPanel() {
  const [page, setPage] = useState(1);
  const audits = useQuery<{ data: Array<{ id: string; scopeType: string; scopeKey: string; createdAt: string; actor: { name: string; email: string } }>; total: number; limit: number }>({
    queryKey: ['access-audits', page],
    queryFn: () => accessControlApi.audits({ page, limit: 25 }).then(response => response.data),
  });
  return <section className="card" style={{ padding: 18 }}>
    <div className="card-header" style={{ padding: 0, marginBottom: 12 }}><div><strong>Historial de cambios</strong><p className="text-muted text-sm">Quién modificó cada política y cuándo.</p></div></div>
    <div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Autor</th><th>Nivel</th><th>Objetivo</th></tr></thead><tbody>
      {(audits.data?.data ?? []).map(row => <tr key={row.id}><td>{new Date(row.createdAt).toLocaleString()}</td><td><strong>{row.actor.name}</strong><div className="text-muted text-sm">{row.actor.email}</div></td><td>{row.scopeType}</td><td className="td-mono">{row.scopeKey}</td></tr>)}
      {!audits.isLoading && !audits.data?.data.length && <tr><td colSpan={4}><div className="empty-state"><p>Aún no hay cambios registrados.</p></div></td></tr>}
    </tbody></table></div>
    {(audits.data?.total ?? 0) > 25 && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}><button className="btn btn-ghost btn-sm" disabled={page === 1} onClick={() => setPage(value => value - 1)}>Anterior</button><button className="btn btn-ghost btn-sm" disabled={page * 25 >= (audits.data?.total ?? 0)} onClick={() => setPage(value => value + 1)}>Siguiente</button></div>}
  </section>;
}

export default function RoleAccessPage() {
  const [mode, setMode] = useState<'role' | 'role_section' | 'user' | 'audit'>('role');
  const matrix = useQuery<MatrixResponse>({
    queryKey: ['access-control-matrix'],
    queryFn: () => accessControlApi.matrix().then(response => response.data),
  });
  return <>
    <Topbar breadcrumb={[{ label: 'Roles y permisos' }]} />
    <main className="main-content">
      <div className="page-header"><div className="page-header-info"><h1>Control de accesos</h1><p>Administra visibilidad, acciones y alcance de datos con políticas por capas.</p></div></div>
      <div className="card" style={{ padding: 14, marginBottom: 18, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <SummaryPill>1. Rol base</SummaryPill><span>→</span><SummaryPill>2. Rol + Sección</SummaryPill><span>→</span><SummaryPill>3. Usuario</SummaryPill><span className="text-muted text-sm">La capa más específica prevalece.</span>
      </div>
      <div className="tabs" style={{ marginBottom: 18 }}>
        <button className={`tab ${mode === 'role' ? 'active' : ''}`} onClick={() => setMode('role')}>Por rol</button>
        <button className={`tab ${mode === 'role_section' ? 'active' : ''}`} onClick={() => setMode('role_section')}>Rol + sección</button>
        <button className={`tab ${mode === 'user' ? 'active' : ''}`} onClick={() => setMode('user')}>Por usuario {matrix.data?.userOverrideCount ? `(${matrix.data.userOverrideCount})` : ''}</button>
        <button className={`tab ${mode === 'audit' ? 'active' : ''}`} onClick={() => setMode('audit')}>Historial</button>
      </div>
      {matrix.isLoading && <p className="text-muted">Cargando control de accesos…</p>}
      {matrix.isError && <div className="error-banner">No se pudo cargar la matriz.</div>}
      {matrix.data && mode === 'role' && <BaseRolePanel matrix={matrix.data} />}
      {matrix.data && mode === 'role_section' && <RoleSectionPanel matrix={matrix.data} />}
      {matrix.data && mode === 'user' && <UserPanel matrix={matrix.data} />}
      {mode === 'audit' && <AuditPanel />}
    </main>
  </>;
}
