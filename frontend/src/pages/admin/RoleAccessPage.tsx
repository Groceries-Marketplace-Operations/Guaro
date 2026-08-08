import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import { accessControlApi } from '../../api';
import type { AccountRole } from '../../types';

interface CatalogItem { key: string; group: string; label: string; description: string; allowedRoles: AccountRole[] }
interface MatrixRole { role: AccountRole; implicitAll: boolean; permissions: string[]; sectionIds: string[] }
interface MatrixResponse {
  catalog: CatalogItem[];
  sections: Array<{ id: string; name: string; order: number }>;
  roles: MatrixRole[];
}
interface RoleDraft { permissions: string[]; sectionIds: string[] }

const ROLE_LABELS: Record<AccountRole, string> = {
  user: 'Usuario', bpo: 'BPO', admin: 'Admin', director: 'Director', super_admin: 'Super Admin',
};

export default function RoleAccessPage() {
  const qc = useQueryClient();
  const [selectedRole, setSelectedRole] = useState<AccountRole>('admin');
  const [drafts, setDrafts] = useState<Partial<Record<AccountRole, RoleDraft>>>({});
  const [message, setMessage] = useState('');
  const { data, isLoading } = useQuery<MatrixResponse>({
    queryKey: ['access-control-matrix'],
    queryFn: () => accessControlApi.matrix().then(response => response.data),
  });
  const selected = data?.roles.find(role => role.role === selectedRole);
  const permissions = drafts[selectedRole]?.permissions ?? selected?.permissions ?? [];
  const sectionIds = drafts[selectedRole]?.sectionIds ?? selected?.sectionIds ?? [];
  const setPermissions = (next: string[]) => setDrafts(previous => ({
    ...previous,
    [selectedRole]: { permissions: next, sectionIds },
  }));
  const setSectionIds = (next: string[]) => setDrafts(previous => ({
    ...previous,
    [selectedRole]: { permissions, sectionIds: next },
  }));

  const grouped = useMemo(() => {
    const groups = new Map<string, CatalogItem[]>();
    for (const item of data?.catalog ?? []) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
    return [...groups.entries()];
  }, [data]);

  const save = useMutation({
    mutationFn: (draft: RoleDraft & { role: AccountRole }) => accessControlApi.updateRole(draft.role, { permissions: draft.permissions, sectionIds: draft.sectionIds }),
    onSuccess: async (_, variables) => {
      await qc.invalidateQueries({ queryKey: ['access-control-matrix'] });
      setDrafts(previous => {
        const next = { ...previous };
        delete next[variables.role];
        return next;
      });
      setMessage('Permisos guardados. Los usuarios verán el cambio al refrescar la página.');
    },
    onError: () => setMessage('No se pudieron guardar los permisos.'),
  });

  const toggle = (value: string, values: string[], setter: (next: string[]) => void) =>
    setter(values.includes(value) ? values.filter(item => item !== value) : [...values, value]);
  const readOnly = selected?.implicitAll ?? false;

  return <>
    <Topbar breadcrumb={[{ label: 'Roles y permisos' }]} />
    <main className="main-content">
      <div className="page-header"><div className="page-header-info">
        <h1>Roles y permisos</h1>
        <p>Controla las páginas visibles, herramientas disponibles y secciones de tareas para cada rol.</p>
      </div></div>

      <div className="alert alert-info" style={{ marginBottom: 16 }}>
        Si una cuenta tiene varios roles, recibe la unión de sus permisos. Super Admin siempre conserva acceso total para evitar bloqueos administrativos.
      </div>

      <div className="tabs" style={{ marginBottom: 18 }}>
        {data?.roles.map(role => <button key={role.role} disabled={save.isPending} className={`tab ${selectedRole === role.role ? 'active' : ''}`} onClick={() => { setSelectedRole(role.role); setMessage(''); }}>
          {ROLE_LABELS[role.role]}
        </button>)}
      </div>

      {isLoading && <p className="text-muted">Cargando matriz de permisos…</p>}
      {!isLoading && <div style={{ display: 'grid', gap: 18 }}>
        {readOnly && <div className="alert alert-info">Super Admin tiene todos los permisos y todas las secciones de forma permanente.</div>}
        {grouped.map(([group, items]) => {
          const eligibleItems = items.filter(item => item.allowedRoles.includes(selectedRole));
          const allSelected = eligibleItems.length > 0 && eligibleItems.every(item => permissions.includes(item.key));
          return <section className="card" key={group} style={{ padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <div><strong>{group}</strong><p className="text-muted text-sm" style={{ marginTop: 3 }}>{items.length} permisos</p></div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
                <input type="checkbox" checked={allSelected} disabled={readOnly || !eligibleItems.length} onChange={() => {
                  const keys = eligibleItems.map(item => item.key);
                  setPermissions(allSelected ? permissions.filter(key => !keys.includes(key)) : [...new Set([...permissions, ...keys])]);
                }} /> Todo el grupo
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
              {items.map(item => {
                const eligible = readOnly || item.allowedRoles.includes(selectedRole);
                return <label key={item.key} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, display: 'flex', gap: 10, cursor: eligible && !readOnly ? 'pointer' : 'default', opacity: eligible ? 1 : 0.52 }}>
                  <input type="checkbox" checked={permissions.includes(item.key)} disabled={readOnly || !eligible} onChange={() => toggle(item.key, permissions, setPermissions)} />
                  <span><strong style={{ display: 'block', fontSize: 13 }}>{item.label}</strong><span className="text-muted" style={{ fontSize: 11 }}>{item.description}</span>{!eligible && <span className="text-muted" style={{ display: 'block', fontSize: 10, marginTop: 4 }}>No disponible para este rol por seguridad estructural.</span>}</span>
                </label>;
              })}
            </div>
          </section>;
        })}

        <section className="card" style={{ padding: 18 }}>
          <strong>Secciones de tareas</strong>
          <p className="text-muted text-sm" style={{ margin: '4px 0 12px' }}>Define qué secciones y Task Types puede consultar este rol.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {data?.sections.map(section => <label key={section.id} style={{ border: '1px solid var(--border)', borderRadius: 999, padding: '7px 12px', display: 'flex', gap: 7 }}>
              <input type="checkbox" checked={sectionIds.includes(section.id)} disabled={readOnly} onChange={() => toggle(section.id, sectionIds, setSectionIds)} /> {section.name}
            </label>)}
            {!data?.sections.length && <span className="text-muted">No hay secciones configuradas.</span>}
          </div>
        </section>

        {message && <div className={message.startsWith('Permisos guardados') ? 'alert alert-info' : 'error-banner'}>{message}</div>}
        {!readOnly && <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate({ role: selectedRole, permissions, sectionIds })}>{save.isPending ? 'Guardando…' : `Guardar permisos de ${ROLE_LABELS[selectedRole]}`}</button>
        </div>}
      </div>}
    </main>
  </>;
}
