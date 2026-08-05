import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import Paginator from '../../components/ui/Paginator';
import StatusBadge from '../../components/ui/StatusBadge';
import { sftpApplicationsApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import type { Paginated, SftpApplication } from '../../types';

const EMPTY_FORM = { name: '', host: '', port: 22, username: '', password: '', rootPath: '', active: true };

export default function SftpApplicationsPage() {
  const { account } = useAuth();
  const qc = useQueryClient();
  const isAdmin = account?.roles.some(role => role === 'admin' || role === 'super_admin');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<SftpApplication | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery<Paginated<SftpApplication>>({
    queryKey: ['sftp-applications', page, q],
    queryFn: () => sftpApplicationsApi.list({ page, limit: 25, q: q || undefined }).then(response => response.data),
    enabled: !!isAdmin,
  });
  const save = useMutation({
    mutationFn: () => editing
      ? sftpApplicationsApi.update(editing.id, {
        ...form,
        password: form.password || undefined,
      })
      : sftpApplicationsApi.create(form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sftp-applications'] });
      setOpen(false);
      setEditing(null);
      setForm(EMPTY_FORM);
      setError('');
    },
    onError: (err: unknown) => {
      const response = err as { response?: { data?: { message?: string | string[] } } };
      const message = response.response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'No se pudo guardar la aplicación SFTP');
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => sftpApplicationsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sftp-applications'] }),
  });
  const testConnection = useMutation({
    mutationFn: (id: string) => sftpApplicationsApi.test(id),
    onSuccess: response => window.alert(`Conexión correcta: ${response.data.files} archivo(s) en ${response.data.rootPath}; ${response.data.durationMs} ms`),
    onError: (reason: unknown) => {
      const message = (reason as { response?: { data?: { message?: string } } }).response?.data?.message;
      window.alert(`La conexión falló: ${message ?? 'revisa host, puerto, usuario, contraseña y ruta'}`);
    },
  });

  if (!isAdmin) return <Navigate to="/" replace />;

  const openCreate = () => { setEditing(null); setForm(EMPTY_FORM); setError(''); setOpen(true); };
  const openEdit = (item: SftpApplication) => {
    setEditing(item);
    setForm({
      name: item.name,
      host: item.host,
      port: item.port,
      username: item.username,
      password: '',
      rootPath: item.rootPath ?? '',
      active: item.active,
    });
    setError('');
    setOpen(true);
  };

  return <>
    <Topbar breadcrumb={[{ label: 'Aplicaciones SFTP' }]} />
    <main className="main-content">
      <div className="page-header">
        <div className="page-header-info">
          <h1>Aplicaciones SFTP</h1>
          <p>Credenciales cifradas usadas por Promociones SFTP y Custom integrations.</p>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Nueva aplicación SFTP</button>
      </div>
      <div className="alert alert-info" style={{ marginBottom: 16 }}>
        Las contraseñas se cifran y nunca se muestran nuevamente. Usa Probar para validar acceso de lectura a la ruta configurada.
      </div>
      <input className="form-input" style={{ width: 320, marginBottom: 16 }} placeholder="Buscar por nombre, host o usuario…"
        value={q} onChange={event => { setQ(event.target.value); setPage(1); }} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Nombre</th><th>Host</th><th>Puerto</th><th>Usuario</th><th>Ruta raíz</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            {isLoading && <tr><td colSpan={7} className="text-muted">Cargando…</td></tr>}
            {!isLoading && !data?.data.length && <tr><td colSpan={7}><div className="empty-state"><p>No hay aplicaciones SFTP.</p></div></td></tr>}
            {data?.data.map(item => <tr key={item.id}>
              <td style={{ fontWeight: 650 }}>{item.name}</td>
              <td className="td-mono">{item.host}</td>
              <td>{item.port}</td>
              <td>{item.username}</td>
              <td className="td-mono">{item.rootPath || '—'}</td>
              <td><StatusBadge status={item.active ? 'active' : 'inactive'} /></td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="btn btn-ghost btn-sm" disabled={testConnection.isPending} onClick={() => testConnection.mutate(item.id)}>Probar</button>
                <button className="btn btn-ghost btn-sm" onClick={() => openEdit(item)}>Editar</button>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => {
                  if (window.confirm(`¿Eliminar ${item.name}?`)) remove.mutate(item.id);
                }}>Eliminar</button>
              </td>
            </tr>)}
          </tbody>
        </table>
        <Paginator page={page} total={data?.total ?? 0} limit={25} onChange={setPage} />
      </div>
    </main>

    {open && <Modal title={editing ? 'Editar aplicación SFTP' : 'Nueva aplicación SFTP'} onClose={() => setOpen(false)}
      footer={<>
        <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
        <button className="btn btn-primary" disabled={save.isPending || !form.name || !form.host || !form.username || (!editing && !form.password)}
          onClick={() => save.mutate()}>{save.isPending ? 'Guardando…' : 'Guardar'}</button>
      </>}>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-row">
        <div className="form-group"><label className="form-label">Nombre *</label><input className="form-input" value={form.name} onChange={e => setForm(v => ({ ...v, name: e.target.value }))} /></div>
        <div className="form-group"><label className="form-label">Host *</label><input className="form-input" placeholder="sftp.example.com" value={form.host} onChange={e => setForm(v => ({ ...v, host: e.target.value }))} /></div>
      </div>
      <div className="form-row">
        <div className="form-group"><label className="form-label">Puerto *</label><input className="form-input" type="number" min={1} max={65535} value={form.port} onChange={e => setForm(v => ({ ...v, port: Number(e.target.value) }))} /></div>
        <div className="form-group"><label className="form-label">Usuario *</label><input className="form-input" value={form.username} onChange={e => setForm(v => ({ ...v, username: e.target.value }))} /></div>
      </div>
      <div className="form-group"><label className="form-label">Contraseña {editing ? '(dejar vacía para conservarla)' : '*'}</label><input className="form-input" type="password" autoComplete="new-password" value={form.password} onChange={e => setForm(v => ({ ...v, password: e.target.value }))} /></div>
      <div className="form-group"><label className="form-label">Ruta raíz</label><input className="form-input" placeholder="/uploads" value={form.rootPath} onChange={e => setForm(v => ({ ...v, rootPath: e.target.value }))} /></div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={form.active} onChange={e => setForm(v => ({ ...v, active: e.target.checked }))} /> Activa</label>
    </Modal>}
  </>;
}
