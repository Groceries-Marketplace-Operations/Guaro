import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Modal from '../../components/ui/Modal';
import { accessControlApi } from '../../api';
import type { AccountRole } from '../../types';

interface AreaAccount {
  id: string;
  name: string;
  email: string;
  roles: AccountRole[];
  section?: { id: string; name: string } | null;
  immutable: boolean;
}

interface AreaPermission { key: string; label: string }
interface AreaMember {
  account: Omit<AreaAccount, 'immutable'>;
  immutable: boolean;
  permissions: string[];
}
interface AccessArea {
  key: 'admin' | 'integrations';
  name: string;
  permissions: AreaPermission[];
  members: AreaMember[];
}
interface AreaAccessResponse {
  accounts: AreaAccount[];
  areas: AccessArea[];
}
interface EditorState {
  areaKey: AccessArea['key'];
  accountId: string;
  permissions: string[];
}

const ROLE_LABELS: Record<AccountRole, string> = {
  user: 'Usuario', bpo: 'BPO', admin: 'Admin', director: 'Director', super_admin: 'Super Admin',
};

function errorMessage(error: unknown) {
  const response = error as { response?: { data?: { message?: string | string[] } } };
  const message = response.response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : message ?? 'No se pudo actualizar el acceso.';
}

export default function AreaAccessPanel() {
  const qc = useQueryClient();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const access = useQuery<AreaAccessResponse>({
    queryKey: ['access-area-summary'],
    queryFn: () => accessControlApi.areaAccess().then(response => response.data),
  });
  const update = useMutation({
    mutationFn: (value: EditorState) => accessControlApi.updateAreaAccess(value.areaKey, value.accountId, value.permissions),
    onSuccess: async () => {
      setEditor(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['access-area-summary'] }),
        qc.invalidateQueries({ queryKey: ['access-account-profile'] }),
        qc.invalidateQueries({ queryKey: ['access-accounts'] }),
        qc.invalidateQueries({ queryKey: ['access-audits'] }),
      ]);
    },
  });

  const openEditor = (area: AccessArea, member?: AreaMember) => {
    setEditor({
      areaKey: area.key,
      accountId: member?.account.id ?? '',
      permissions: member?.permissions ?? area.permissions.map(permission => permission.key),
    });
    update.reset();
  };

  const selectAccount = (area: AccessArea, accountId: string) => {
    const existing = area.members.find(member => member.account.id === accountId);
    setEditor({
      areaKey: area.key,
      accountId,
      permissions: existing?.permissions ?? area.permissions.map(permission => permission.key),
    });
  };

  const remove = (area: AccessArea, member: AreaMember) => {
    if (!window.confirm(`¿Retirar todo el acceso a ${area.name} de ${member.account.name}?`)) return;
    update.mutate({ areaKey: area.key, accountId: member.account.id, permissions: [] });
  };

  if (access.isLoading) return <p className="text-muted">Cargando accesos por área…</p>;
  if (access.isError || !access.data) return <div className="error-banner">No se pudieron cargar los accesos por área.</div>;

  const editingArea = editor ? access.data.areas.find(area => area.key === editor.areaKey) : undefined;
  const editableAccounts = access.data.accounts.filter(account => !account.immutable);

  return <div style={{ display: 'grid', gap: 18 }}>
    <div className="alert alert-info">
      Aquí puedes ver quién tiene acceso efectivo a cada apartado. Agregar o eliminar genera una excepción individual y no cambia los permisos de otros usuarios con el mismo rol.
    </div>

    {access.data.areas.map(area => <section className="card" key={area.key} style={{ padding: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div><h2 style={{ margin: 0 }}>{area.name}</h2><p className="text-muted text-sm" style={{ marginTop: 4 }}>{area.members.length} personas con acceso</p></div>
        <button className="btn btn-primary" onClick={() => openEditor(area)}>+ Agregar persona</button>
      </div>
      <div className="table-wrap"><table><thead><tr><th>Persona</th><th>Rol y sección</th><th>Accesos efectivos</th><th></th></tr></thead><tbody>
        {area.members.map(member => <tr key={member.account.id}>
          <td><strong>{member.account.name}</strong><div className="text-muted text-sm">{member.account.email}</div></td>
          <td>{member.account.roles.map(role => ROLE_LABELS[role]).join(', ')}<div className="text-muted text-sm">{member.account.section?.name ?? 'Sin sección'}</div></td>
          <td><div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{member.permissions.map(permission => {
            const label = area.permissions.find(item => item.key === permission)?.label ?? permission;
            return <span key={permission} className="badge badge-gray">{label}</span>;
          })}</div></td>
          <td style={{ whiteSpace: 'nowrap' }}>
            {member.immutable
              ? <span className="text-muted text-sm">Permanente</span>
              : <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => openEditor(area, member)}>Editar</button>
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} disabled={update.isPending} onClick={() => remove(area, member)}>Eliminar</button>
                </div>}
          </td>
        </tr>)}
        {!area.members.length && <tr><td colSpan={4}><div className="empty-state"><p>No hay personas con acceso.</p></div></td></tr>}
      </tbody></table></div>
    </section>)}

    {editor && editingArea && <Modal
      title={`Acceso a ${editingArea.name}`}
      onClose={() => setEditor(null)}
      footer={<>
        <button className="btn btn-ghost" onClick={() => setEditor(null)}>Cancelar</button>
        <button className="btn btn-primary" disabled={!editor.accountId || update.isPending} onClick={() => update.mutate(editor)}>{update.isPending ? 'Guardando…' : 'Guardar acceso'}</button>
      </>}
    >
      <div className="modal-body" style={{ display: 'grid', gap: 16 }}>
        <div><label className="form-label">Persona *</label><select className="form-select" value={editor.accountId} onChange={event => selectAccount(editingArea, event.target.value)}>
          <option value="">Selecciona una persona…</option>
          {editableAccounts.map(account => <option key={account.id} value={account.id}>{account.name} · {account.email}</option>)}
        </select></div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}><strong>Accesos</strong><label className="text-sm"><input type="checkbox" checked={editor.permissions.length === editingArea.permissions.length} onChange={event => setEditor(value => value ? ({ ...value, permissions: event.target.checked ? editingArea.permissions.map(permission => permission.key) : [] }) : value)} /> Seleccionar todos</label></div>
          <div style={{ display: 'grid', gap: 8 }}>{editingArea.permissions.map(permission => <label key={permission.key} style={{ border: '1px solid var(--border)', borderRadius: 9, padding: 10, display: 'flex', gap: 9 }}><input type="checkbox" checked={editor.permissions.includes(permission.key)} onChange={() => setEditor(value => value ? ({ ...value, permissions: value.permissions.includes(permission.key) ? value.permissions.filter(key => key !== permission.key) : [...value.permissions, permission.key] }) : value)} /> {permission.label}</label>)}</div>
        </div>
        {update.isError && <div className="error-banner">{errorMessage(update.error)}</div>}
      </div>
    </Modal>}
  </div>;
}
