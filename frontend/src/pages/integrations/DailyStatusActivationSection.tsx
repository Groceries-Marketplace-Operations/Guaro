import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fileIntegrationsApi, sftpApplicationsApi } from '../../api';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import ExecutionTiming from '../../components/integrations/ExecutionTiming';
import type { FileIntegrationRule, Paginated, SftpApplication } from '../../types';

interface ActivationForm {
  name: string;
  sftpApplicationId: string;
  active: boolean;
  dailyTime: string;
  timezone: string;
  filePattern: string;
  parallelism: number;
  maxFilesPerRun: number;
}

const EMPTY_FORM: ActivationForm = {
  name: 'Activación diaria M → A',
  sftpApplicationId: '',
  active: true,
  dailyTime: '08:15',
  timezone: 'Etc/GMT+6',
  filePattern: '*.csv',
  parallelism: 3,
  maxFilesPerRun: 1000,
};

const runningStatuses = new Set(['pending', 'running']);

function date(value?: string) {
  return value ? new Date(value).toLocaleString() : '—';
}

function apiError(reason: unknown) {
  const message = (reason as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : message ?? 'La acción no pudo completarse';
}

export default function DailyStatusActivationSection() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<FileIntegrationRule | null>(null);
  const [form, setForm] = useState<ActivationForm>(EMPTY_FORM);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data: rules = [], isLoading } = useQuery<FileIntegrationRule[]>({
    queryKey: ['file-integrations', 'daily_status_activation'],
    queryFn: () => fileIntegrationsApi.list('daily_status_activation').then(response => response.data),
    refetchInterval: query => (query.state.data as FileIntegrationRule[] | undefined)
      ?.some(rule => rule.executions.some(execution => runningStatuses.has(execution.status))) ? 3000 : 15000,
  });
  const { data: sftpData } = useQuery<Paginated<SftpApplication>>({
    queryKey: ['sftp-applications', 'daily-status-activation'],
    queryFn: () => sftpApplicationsApi.list({ page: 1, limit: 100 }).then(response => response.data),
  });
  const sftpApps = useMemo(() => sftpData?.data.filter(item => item.active) ?? [], [sftpData]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['file-integrations', 'daily_status_activation'] });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        ...form,
        kind: 'daily_status_activation',
        sourceScope: 'filename_date_today',
        delimiter: '|',
      };
      return editing ? fileIntegrationsApi.update(editing.id, payload) : fileIntegrationsApi.create(payload);
    },
    onSuccess: () => { refresh(); setOpen(false); setEditing(null); setError(''); },
    onError: reason => setError(apiError(reason)),
  });
  const action = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: 'run' | 'stop' | 'delete' }) => verb === 'run'
      ? fileIntegrationsApi.run(id)
      : verb === 'stop' ? fileIntegrationsApi.stop(id) : fileIntegrationsApi.delete(id),
    onSuccess: refresh,
    onError: reason => window.alert(apiError(reason)),
  });

  const openCreate = () => { setEditing(null); setForm({ ...EMPTY_FORM }); setError(''); setOpen(true); };
  const openEdit = (rule: FileIntegrationRule) => {
    setEditing(rule);
    setForm({
      name: rule.name,
      sftpApplicationId: rule.sftpApplicationId,
      active: rule.active,
      dailyTime: rule.dailyTime ?? '08:15',
      timezone: rule.timezone || 'Etc/GMT+6',
      filePattern: rule.filePattern,
      parallelism: rule.parallelism || 3,
      maxFilesPerRun: rule.maxFilesPerRun,
    });
    setError('');
    setOpen(true);
  };
  const valid = form.name.trim().length >= 2 && form.sftpApplicationId && /^([01]\d|2[0-3]):[0-5]\d$/.test(form.dailyTime);

  return <section>
    <div className="page-header" style={{ marginTop: 18 }}>
      <div className="page-header-info">
        <h2>Activación diaria de archivos</h2>
        <p>Procesa los CSV fechados del día y cambia únicamente las líneas que terminan en |M para que terminen en |A.</p>
      </div>
      <button className="btn btn-primary" onClick={openCreate}>+ Nueva integración</button>
    </div>
    <div className="alert alert-info" style={{ marginBottom: 18 }}>
      Antes de sobrescribir, Guaro carga y verifica un temporal, mueve el original a .tequila-backup y conserva el archivo si cualquier validación falla.
    </div>
    {isLoading && <p className="text-muted">Cargando…</p>}
    {!isLoading && rules.length === 0 && <div className="empty-state"><p>No hay activaciones diarias configuradas.</p></div>}
    <div style={{ display: 'grid', gap: 14 }}>
      {rules.map(rule => {
        const latest = rule.executions[0];
        const running = latest && runningStatuses.has(latest.status);
        const files = latest?.result?.files ?? [];
        return <article key={rule.id} className="card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{rule.name}</strong><StatusBadge status={rule.active ? 'active' : 'inactive'} />
                <span className="badge">Diario {rule.dailyTime ?? '08:15'} UTC−06:00</span>
                <span className="badge">{rule.sftpApplication.name}</span><span className="badge">{rule.filePattern}</span>
                <span className="badge">{rule.parallelism} conexiones</span>{latest && <StatusBadge status={latest.status} />}
              </div>
              <p className="text-muted" style={{ marginTop: 8, fontSize: 12 }}>
                Última: {date(rule.lastRunAt)} · Próxima: {date(rule.nextRunAt)} · Máximo: {rule.maxFilesPerRun.toLocaleString()} archivos
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" disabled={!!running || action.isPending} onClick={() => action.mutate({ id: rule.id, verb: 'run' })}>Ejecutar</button>
              {running && <button className="btn btn-ghost btn-sm" onClick={() => action.mutate({ id: rule.id, verb: 'stop' })}>Detener</button>}
              <button className="btn btn-ghost btn-sm" disabled={!!running} onClick={() => openEdit(rule)}>Editar</button>
              <button className="btn btn-ghost btn-sm" disabled={!!running} style={{ color: 'var(--red)' }} onClick={() => {
                if (window.confirm(`¿Eliminar ${rule.name}?`)) action.mutate({ id: rule.id, verb: 'delete' });
              }}>Eliminar</button>
            </div>
          </div>
          {latest && <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <span>{latest.filesProcessed}/{latest.filesScanned} archivos</span>
              <span>{latest.rowsRead.toLocaleString()} líneas</span>
              <span style={{ color: 'var(--orange-dark)' }}>{latest.rowsRemoved.toLocaleString()} actualizadas M → A</span>
              <span>Fecha objetivo: {latest.result?.matchedDate ?? '—'}</span>
              {files.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(expanded === latest.id ? null : latest.id)}>{expanded === latest.id ? 'Ocultar detalle' : 'Ver detalle'}</button>}
            </div>
            <ExecutionTiming startedAt={latest.startedAt} finishedAt={latest.finishedAt} durationMs={latest.durationMs} />
            {latest.currentFile && <p className="text-muted" style={{ marginTop: 8 }}>Procesando: {latest.currentFile}</p>}
            {latest.errorMessage && <p style={{ color: 'var(--red)', marginTop: 8 }}>{latest.errorMessage}</p>}
            {expanded === latest.id && <div className="table-wrap" style={{ marginTop: 12 }}><table>
              <thead><tr><th>Archivo</th><th>Líneas</th><th>M → A</th><th>Ya activas</th><th>Resultado</th></tr></thead>
              <tbody>{files.map(file => <tr key={file.fileName}>
                <td className="td-mono">{file.fileName}</td><td>{file.rowsRead}</td><td>{file.rowsChanged ?? file.rowsRemoved}</td><td>{file.alreadyActiveLines ?? 0}</td>
                <td>{file.error ? <span style={{ color: 'var(--red)' }}>{file.error}</span> : file.remoteReplaced ? 'Reemplazado y respaldado' : file.skipped ?? 'Sin cambios'}</td>
              </tr>)}</tbody>
            </table></div>}
          </div>}
        </article>;
      })}
    </div>

    {open && <Modal title={editing ? 'Editar activación diaria' : 'Nueva activación diaria'} onClose={() => setOpen(false)} footer={<>
      <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
      <button className="btn btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Guardando…' : 'Guardar'}</button>
    </>}>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-group"><label className="form-label">Nombre *</label><input className="form-input" value={form.name} onChange={event => setForm(value => ({ ...value, name: event.target.value }))} /></div>
      <div className="form-group"><label className="form-label">Aplicación SFTP *</label><select className="form-input" value={form.sftpApplicationId} onChange={event => setForm(value => ({ ...value, sftpApplicationId: event.target.value }))}>
        <option value="">Seleccionar…</option>{sftpApps.map(app => <option key={app.id} value={app.id}>{app.name} · {app.host}:{app.port}</option>)}
      </select></div>
      <div className="form-row">
        <div className="form-group"><label className="form-label">Patrón de archivos</label><input className="form-input" value={form.filePattern} onChange={event => setForm(value => ({ ...value, filePattern: event.target.value }))} /><p className="form-hint">Solo procesa nombres que contengan un timestamp de 14 dígitos correspondiente al día actual.</p></div>
        <div className="form-group"><label className="form-label">Hora diaria UTC−06:00</label><input className="form-input" type="time" step={60} value={form.dailyTime} onChange={event => setForm(value => ({ ...value, dailyTime: event.target.value }))} /></div>
      </div>
      <div className="form-row">
        <div className="form-group"><label className="form-label">Conexiones simultáneas</label><input className="form-input" type="number" min={1} max={5} value={form.parallelism} onChange={event => setForm(value => ({ ...value, parallelism: Number(event.target.value) }))} /></div>
        <div className="form-group"><label className="form-label">Máximo de archivos por ejecución</label><input className="form-input" type="number" min={1} max={5000} value={form.maxFilesPerRun} onChange={event => setForm(value => ({ ...value, maxFilesPerRun: Number(event.target.value) }))} /></div>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={form.active} onChange={event => setForm(value => ({ ...value, active: event.target.checked }))} /> Ejecutar automáticamente cada día</label>
    </Modal>}
  </section>;
}
