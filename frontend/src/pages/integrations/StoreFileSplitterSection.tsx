import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fileIntegrationsApi, sftpApplicationsApi } from '../../api';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import type { FileIntegrationRule, Paginated, SftpApplication } from '../../types';

interface SplitterForm {
  name: string;
  sftpApplicationId: string;
  active: boolean;
  dailyTime: string;
  timezone: string;
  filePattern: string;
  selectionStrategy: 'mtime' | 'nameDate';
}

const EMPTY_FORM: SplitterForm = {
  name: '',
  sftpApplicationId: '',
  active: false,
  dailyTime: '12:05',
  timezone: 'Etc/GMT+6',
  filePattern: 'preciosdidi_*.csv',
  selectionStrategy: 'mtime',
};

const runningStatuses = new Set(['pending', 'running']);

function date(value?: string) {
  return value ? new Date(value).toLocaleString() : '—';
}

export default function StoreFileSplitterSection() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<FileIntegrationRule | null>(null);
  const [form, setForm] = useState<SplitterForm>(EMPTY_FORM);
  const [error, setError] = useState('');

  const { data: rules = [], isLoading } = useQuery<FileIntegrationRule[]>({
    queryKey: ['file-integrations', 'store_file_splitter'],
    queryFn: () => fileIntegrationsApi.list('store_file_splitter').then(response => response.data),
    refetchInterval: query => (query.state.data as FileIntegrationRule[] | undefined)
      ?.some(rule => rule.executions.some(execution => runningStatuses.has(execution.status))) ? 3000 : 15000,
  });
  const { data: sftpData } = useQuery<Paginated<SftpApplication>>({
    queryKey: ['sftp-applications', 'store-file-splitter'],
    queryFn: () => sftpApplicationsApi.list({ page: 1, limit: 100 }).then(response => response.data),
  });
  const sftpApps = useMemo(() => sftpData?.data.filter(item => item.active) ?? [], [sftpData]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['file-integrations', 'store_file_splitter'] });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name,
        kind: 'store_file_splitter',
        sftpApplicationId: form.sftpApplicationId,
        active: form.active,
        dailyTime: form.dailyTime,
        timezone: form.timezone,
        filePattern: form.filePattern,
        sourceScope: form.selectionStrategy,
        delimiter: '|',
        maxFilesPerRun: 1,
      };
      return editing ? fileIntegrationsApi.update(editing.id, payload) : fileIntegrationsApi.create(payload);
    },
    onSuccess: () => { refresh(); setOpen(false); setEditing(null); setError(''); },
    onError: (reason: unknown) => {
      const message = (reason as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'No se pudo guardar la integración');
    },
  });
  const action = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: 'run' | 'stop' | 'delete' }) => verb === 'run'
      ? fileIntegrationsApi.run(id)
      : verb === 'stop' ? fileIntegrationsApi.stop(id) : fileIntegrationsApi.delete(id),
    onSuccess: refresh,
    onError: (reason: unknown) => window.alert(
      (reason as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'La acción falló',
    ),
  });

  const openCreate = () => { setEditing(null); setForm(EMPTY_FORM); setError(''); setOpen(true); };
  const openEdit = (rule: FileIntegrationRule) => {
    setEditing(rule);
    setForm({
      name: rule.name,
      sftpApplicationId: rule.sftpApplicationId,
      active: rule.active,
      dailyTime: rule.dailyTime ?? '12:05',
      timezone: rule.timezone ?? 'Etc/GMT+6',
      filePattern: rule.filePattern,
      selectionStrategy: rule.sourceScope === 'nameDate' ? 'nameDate' : 'mtime',
    });
    setError('');
    setOpen(true);
  };

  return <section>
    <div className="page-header" style={{ marginTop: 18 }}>
      <div className="page-header-info">
        <h2>Split CSV por tienda</h2>
        <p>Lee el preciosdidi más reciente, normaliza el último campo numérico y genera un archivo por sucursal en el mismo SFTP.</p>
      </div>
      <button className="btn btn-primary" onClick={openCreate}>+ Nueva integración</button>
    </div>
    <div className="alert alert-info" style={{ marginBottom: 18 }}>
      Los archivos se publican como preciosdidi_suc_&lt;tienda&gt;_&lt;fecha&gt;_1.csv. La fecha se toma del nombre del archivo fuente.
    </div>
    {isLoading && <p className="text-muted">Cargando…</p>}
    {!isLoading && rules.length === 0 && <div className="empty-state"><p>No hay integraciones configuradas.</p></div>}
    <div style={{ display: 'grid', gap: 14 }}>
      {rules.map(rule => {
        const latest = rule.executions[0];
        const running = latest && runningStatuses.has(latest.status);
        return <article className="card" style={{ padding: 18 }} key={rule.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{rule.name}</strong>
                <StatusBadge status={rule.active ? 'active' : 'inactive'} />
                <span className="badge">{rule.sftpApplication.name}</span>
                <span className="badge">{rule.filePattern}</span>
                <span className="badge">{rule.sourceScope === 'nameDate' ? 'Fecha del nombre' : 'Modificación'}</span>
              </div>
              <div className="text-muted" style={{ marginTop: 8, fontSize: 12 }}>
                Diario {rule.dailyTime ?? '12:05'} · UTC−06:00 · Última: {date(rule.lastRunAt)} · Próxima: {date(rule.nextRunAt)}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" disabled={!!running || action.isPending} onClick={() => action.mutate({ id: rule.id, verb: 'run' })}>Ejecutar</button>
              {running && <button className="btn btn-ghost btn-sm" onClick={() => action.mutate({ id: rule.id, verb: 'stop' })}>Detener</button>}
              <button className="btn btn-ghost btn-sm" onClick={() => openEdit(rule)}>Editar</button>
              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => {
                if (window.confirm(`¿Eliminar ${rule.name}?`)) action.mutate({ id: rule.id, verb: 'delete' });
              }}>Eliminar</button>
            </div>
          </div>
          {latest && <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <StatusBadge status={latest.status} />
              <span>Fuente: {latest.result?.sourceFile ?? '—'}</span>
              <span>{latest.rowsRead.toLocaleString()} filas</span>
              <span>{latest.result?.outputs?.length ?? 0} archivos generados</span>
              {!!latest.result?.malformed && <span style={{ color: 'var(--red)' }}>{latest.result.malformed} inválidas</span>}
            </div>
            {latest.errorMessage && <p style={{ color: 'var(--red)', marginTop: 8 }}>{latest.errorMessage}</p>}
          </div>}
        </article>;
      })}
    </div>

    {open && <Modal title={editing ? 'Editar Split CSV por tienda' : 'Nueva Split CSV por tienda'} onClose={() => setOpen(false)} footer={<>
      <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
      <button className="btn btn-primary" disabled={save.isPending || !form.name || !form.sftpApplicationId || !form.filePattern} onClick={() => save.mutate()}>
        {save.isPending ? 'Guardando…' : 'Guardar'}
      </button>
    </>}>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-group"><label className="form-label">Nombre *</label><input className="form-input" value={form.name} onChange={event => setForm(value => ({ ...value, name: event.target.value }))} /></div>
      <div className="form-group"><label className="form-label">Aplicación SFTP *</label><select className="form-input" value={form.sftpApplicationId} onChange={event => setForm(value => ({ ...value, sftpApplicationId: event.target.value }))}>
        <option value="">Seleccionar…</option>
        {sftpApps.map(app => <option key={app.id} value={app.id}>{app.name} · {app.host}</option>)}
      </select></div>
      <div className="form-row">
        <div className="form-group"><label className="form-label">Patrón de archivo *</label><input className="form-input" value={form.filePattern} onChange={event => setForm(value => ({ ...value, filePattern: event.target.value }))} /></div>
        <div className="form-group"><label className="form-label">Elegir el más reciente por</label><select className="form-input" value={form.selectionStrategy} onChange={event => setForm(value => ({ ...value, selectionStrategy: event.target.value as SplitterForm['selectionStrategy'] }))}>
          <option value="mtime">Fecha de modificación</option><option value="nameDate">Fecha en el nombre</option>
        </select></div>
      </div>
      <div className="form-group"><label className="form-label">Hora diaria (UTC−06:00)</label><input className="form-input" type="time" step={60} value={form.dailyTime} onChange={event => setForm(value => ({ ...value, dailyTime: event.target.value }))} /><p className="form-hint">Se ejecutará todos los días a esta hora con desplazamiento fijo UTC−06:00.</p></div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={form.active} onChange={event => setForm(value => ({ ...value, active: event.target.checked }))} /> Ejecutar automáticamente</label>
    </Modal>}
  </section>;
}
