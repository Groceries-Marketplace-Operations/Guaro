import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import { fileIntegrationsApi, sftpApplicationsApi } from '../../api';
import type { FileIntegrationKind, FileIntegrationRule, Paginated, SftpApplication } from '../../types';
import TargetedMenuSection from './TargetedMenuSection';
import CrossAppMenuCopySection from './CrossAppMenuCopySection';
import OfferMenuUploadSection from './OfferMenuUploadSection';
import StoreFileSplitterSection from './StoreFileSplitterSection';
import DailyStatusActivationSection from './DailyStatusActivationSection';

interface RuleForm {
  name: string;
  kind: FileIntegrationKind;
  country: string;
  sftpApplicationId: string;
  active: boolean;
  intervalMinutes: number;
  filePattern: string;
  sourceScope: string;
  thresholdAmount: number;
  delimiter: string;
  priceColumn: number;
  maxFilesPerRun: number;
}

type CustomIntegrationSection = 'sftp' | 'daily-activation' | 'store-splitter' | 'offer-menu' | 'targeted-menu' | 'cross-app';

const runningStatuses = new Set(['pending', 'running']);

function initialForm(kind: FileIntegrationKind): RuleForm {
  return kind === 'price_filter'
    ? { name: '', kind, country: 'MX', sftpApplicationId: '', active: false, intervalMinutes: 1440,
      filePattern: '*', sourceScope: 'city_club', thresholdAmount: 3000, delimiter: '', priceColumn: 4, maxFilesPerRun: 700 }
    : { name: '', kind, country: '', sftpApplicationId: '', active: false, intervalMinutes: 1440,
      filePattern: '*', sourceScope: 'all', thresholdAmount: 0, delimiter: '', priceColumn: 0, maxFilesPerRun: 20 };
}

function date(value?: string) {
  return value ? new Date(value).toLocaleString() : '—';
}

function duration(ms?: number) {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function saveBase64(fileName: string, contentBase64: string, mimeType: string) {
  const bytes = Uint8Array.from(atob(contentBase64), char => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url; link.download = fileName; link.click();
  URL.revokeObjectURL(url);
}

export default function FileIntegrationsPage({ kind }: { kind: FileIntegrationKind }) {
  const qc = useQueryClient();
  const isFilter = kind === 'price_filter';
  const title = isFilter ? 'Custom integrations' : 'Lectura de promociones complejas SFTP';
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<FileIntegrationRule | null>(null);
  const [form, setForm] = useState<RuleForm>(() => initialForm(kind));
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [customSection, setCustomSection] = useState<CustomIntegrationSection>('sftp');
  const showSftp = !isFilter || customSection === 'sftp';

  const { data: rules = [], isLoading } = useQuery<FileIntegrationRule[]>({
    queryKey: ['file-integrations', kind],
    queryFn: () => fileIntegrationsApi.list(kind).then(response => response.data),
    refetchInterval: query => (query.state.data as FileIntegrationRule[] | undefined)
      ?.some(rule => rule.executions.some(execution => runningStatuses.has(execution.status))) ? 3000 : 15000,
  });
  const { data: sftpData } = useQuery<Paginated<SftpApplication>>({
    queryKey: ['sftp-applications', 'file-integrations'],
    queryFn: () => sftpApplicationsApi.list({ page: 1, limit: 100 }).then(response => response.data),
  });
  const sftpApps = useMemo(() => sftpData?.data.filter(item => item.active) ?? [], [sftpData]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['file-integrations', kind] });
  const save = useMutation({
    mutationFn: () => {
      const data = {
        ...form,
        country: form.country || undefined,
        thresholdAmount: isFilter ? form.thresholdAmount : undefined,
        priceColumn: isFilter ? form.priceColumn : undefined,
        intervalMinutes: form.intervalMinutes || undefined,
        delimiter: form.delimiter || undefined,
      };
      return editing ? fileIntegrationsApi.update(editing.id, data) : fileIntegrationsApi.create(data);
    },
    onSuccess: () => { refresh(); setOpen(false); setEditing(null); setError(''); },
    onError: (reason: unknown) => setError(((reason as { response?: { data?: { message?: string | string[] } } }).response?.data?.message ?? 'No se pudo guardar').toString()),
  });
  const action = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: 'run' | 'stop' | 'delete' }) => verb === 'run'
      ? fileIntegrationsApi.run(id) : verb === 'stop' ? fileIntegrationsApi.stop(id) : fileIntegrationsApi.delete(id),
    onSuccess: refresh,
    onError: (reason: unknown) => window.alert(((reason as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'La acción falló')),
  });

  const openCreate = () => { setEditing(null); setForm(initialForm(kind)); setError(''); setOpen(true); };
  const openEdit = (rule: FileIntegrationRule) => {
    setEditing(rule);
    setForm({
      name: rule.name, kind, country: rule.country ?? '', sftpApplicationId: rule.sftpApplicationId,
      active: rule.active, intervalMinutes: rule.intervalMinutes ?? 1440, filePattern: rule.filePattern,
      sourceScope: rule.sourceScope, thresholdAmount: Number(rule.thresholdAmount ?? 0), delimiter: rule.delimiter ?? '',
      priceColumn: rule.priceColumn ?? 0, maxFilesPerRun: rule.maxFilesPerRun,
    });
    setError(''); setOpen(true);
  };

  const download = async (executionId: string, fileName: string) => {
    const response = await fileIntegrationsApi.download(executionId, fileName);
    const value = response.data as { fileName: string; contentBase64: string; mimeType: string };
    saveBase64(value.fileName, value.contentBase64, value.mimeType);
  };

  return <>
    <Topbar breadcrumb={[{ label: title }]} />
    <main className="main-content">
      <div className="page-header">
        <div className="page-header-info">
          <h1>{title}</h1>
          <p>{isFilter
            ? 'Herramientas especializadas para automatizaciones SFTP y administración de menús entre tiendas y aplicaciones.'
            : 'Lee la promoción vigente más reciente por tienda, la almacena localmente y registra volumen, estado y duración.'}</p>
        </div>
        {showSftp && <button className="btn btn-primary" onClick={openCreate}>+ Nueva configuración</button>}
      </div>
      {isFilter && <nav className="custom-integration-nav" aria-label="Herramientas de integración">
        <button type="button" className={customSection === 'sftp' ? 'is-active' : ''} onClick={() => setCustomSection('sftp')} aria-selected={customSection === 'sftp'}>
          <span className="custom-integration-icon">SF</span>
          <span><strong>Procesamiento SFTP</strong><small>Filtrado, respaldo y sustitución controlada de archivos</small></span>
          <span className="badge">{rules.length} reglas</span>
        </button>
        <button type="button" className={customSection === 'targeted-menu' ? 'is-active' : ''} onClick={() => setCustomSection('targeted-menu')} aria-selected={customSection === 'targeted-menu'}>
          <span className="custom-integration-icon">TM</span>
          <span><strong>Targeted Menu Upload</strong><small>Carga UPC seleccionados en tiendas específicas</small></span>
        </button>
        <button type="button" className={customSection === 'store-splitter' ? 'is-active' : ''} onClick={() => setCustomSection('store-splitter')} aria-selected={customSection === 'store-splitter'}>
          <span className="custom-integration-icon">ST</span>
          <span><strong>Split CSV por tienda</strong><small>Divide preciosdidi por sucursal y publica los archivos resultantes</small></span>
        </button>
        <button type="button" className={customSection === 'daily-activation' ? 'is-active' : ''} onClick={() => setCustomSection('daily-activation')} aria-selected={customSection === 'daily-activation'}>
          <span className="custom-integration-icon">MA</span>
          <span><strong>Activación diaria M → A</strong><small>Actualiza los CSV fechados del día a las 08:15 UTC−06:00</small></span>
        </button>
        <button type="button" className={customSection === 'offer-menu' ? 'is-active' : ''} onClick={() => setCustomSection('offer-menu')} aria-selected={customSection === 'offer-menu'}>
          <span className="custom-integration-icon">OF</span>
          <span><strong>SFTP Offer Menu</strong><small>Procesa offer*.csv y programa cargas grocery por tienda</small></span>
        </button>
        <button type="button" className={customSection === 'cross-app' ? 'is-active' : ''} onClick={() => setCustomSection('cross-app')} aria-selected={customSection === 'cross-app'}>
          <span className="custom-integration-icon">CA</span>
          <span><strong>Cross-App Menu Copy</strong><small>Copia menús entre aplicaciones y reutiliza ejecuciones</small></span>
        </button>
      </nav>}
      {showSftp && <div className="alert alert-info" style={{ marginBottom: 18 }}>
        {isFilter
          ? 'El sistema registra un solo estado por archivo, procesa primero los más antiguos y conserva pendientes o fallidos para la siguiente ejecución. Antes de reemplazar, genera Antes/Después, verifica el temporal y mueve el original a /upload/.tequila-backup/<ejecución>/.'
          : 'Funciona como Auto Menu Fetch para promociones: conserva una instantánea local por App Shop ID. Las credenciales permanecen cifradas.'}
      </div>}
      {isFilter && customSection === 'targeted-menu' && <TargetedMenuSection />}
      {isFilter && customSection === 'store-splitter' && <StoreFileSplitterSection />}
      {isFilter && customSection === 'daily-activation' && <DailyStatusActivationSection />}
      {isFilter && customSection === 'offer-menu' && <OfferMenuUploadSection />}
      {isFilter && customSection === 'cross-app' && <CrossAppMenuCopySection />}
      {showSftp && <>
      {isLoading && <p className="text-muted">Cargando…</p>}
      {!isLoading && rules.length === 0 && <div className="empty-state"><p>No hay configuraciones.</p></div>}
      <div style={{ display: 'grid', gap: 14 }}>
        {rules.map(rule => {
          const latest = rule.executions[0];
          const running = latest && runningStatuses.has(latest.status);
          return <section key={rule.id} className="card" style={{ padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong>{rule.name}</strong><StatusBadge status={rule.active ? 'active' : 'inactive'} />
                  {rule.country && <span className="badge">{rule.country}</span>}
                  <span className="badge">{rule.sftpApplication.name}</span>
                  <span className="badge">{rule.filePattern}</span>
                  {isFilter && <span className="badge">&gt; {rule.thresholdAmount}</span>}
                </div>
                <div className="text-muted" style={{ marginTop: 8, fontSize: 12 }}>
                  Cada {rule.intervalMinutes ?? '—'} min · Máx. {rule.maxFilesPerRun} {isFilter ? 'archivos' : 'tiendas'} · Última: {date(rule.lastRunAt)} · Próxima: {date(rule.nextRunAt)}
                </div>
                {isFilter && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 9, fontSize: 12 }}>
                  <span className="badge">Inventario: {rule.fileState?.total ?? 0}</span>
                  <span className="badge" style={{ color: '#B54708' }}>Pendientes: {rule.fileState?.pending ?? 0}</span>
                  <span className="badge" style={{ color: 'var(--orange)' }}>Procesando: {rule.fileState?.running ?? 0}</span>
                  <span className="badge" style={{ color: '#027A48' }}>Procesados: {rule.fileState?.done ?? 0}</span>
                  <span className="badge" style={{ color: 'var(--red)' }}>Fallidos: {rule.fileState?.failed ?? 0}</span>
                </div>}
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
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                <StatusBadge status={latest.status} />
                <span>{latest.filesProcessed}/{latest.filesScanned} archivos</span>
                {isFilter && latest.result?.pendingFiles !== undefined && <span>{latest.result.pendingFiles} pendientes al terminar</span>}
                <span>{latest.rowsRead.toLocaleString()} filas</span>
                {isFilter && <><span style={{ color: 'var(--red)' }}>{latest.rowsRemoved.toLocaleString()} eliminadas</span><span>{latest.rowsKept.toLocaleString()} conservadas</span></>}
                {!isFilter && <span>{latest.rowsKept.toLocaleString()} promociones guardadas</span>}
                <span>{duration(latest.durationMs)}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(expanded === latest.id ? null : latest.id)}>{expanded === latest.id ? 'Ocultar detalle' : 'Ver detalle'}</button>
              </div>
              {latest.currentFile && <p className="text-muted" style={{ marginTop: 8 }}>Procesando: {latest.currentFile}</p>}
              {latest.errorMessage && <p style={{ color: 'var(--red)', marginTop: 8 }}>{latest.errorMessage}</p>}
              {expanded === latest.id && <div className="table-wrap" style={{ marginTop: 12 }}><table>
                <thead><tr><th>Archivo</th><th>Filas</th><th>Conservadas</th><th>Eliminadas</th><th>Resultado</th></tr></thead>
                <tbody>{(latest.result?.files ?? []).map(file => <tr key={file.fileName}>
                  <td className="td-mono">{file.fileName}</td><td>{file.rowsRead}</td><td>{file.rowsKept}</td><td>{file.rowsRemoved}</td>
                  <td>{file.error ? <span style={{ color: 'var(--red)' }}>{file.error}</span> : file.skipped ?? (isFilter
                    ? <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {file.beforeFile && file.afterFile && <>
                        <button className="btn btn-ghost btn-sm" onClick={() => download(latest.id, file.beforeFile!)}>Antes</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => download(latest.id, file.afterFile!)}>Después</button>
                      </>}
                      <span className="badge">{file.remoteReplaced ? 'Original reemplazado' : 'Sin cambios remotos'}</span>
                    </span> : `${file.promotionsStored ?? file.rowsKept} promociones`)}</td>
                </tr>)}</tbody>
              </table></div>}
            </div>}
          </section>;
        })}
      </div>
      </>}
    </main>

    {open && <Modal title={editing ? 'Editar configuración' : 'Nueva configuración'} onClose={() => setOpen(false)} footer={<>
      <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
      <button className="btn btn-primary" disabled={save.isPending || !form.name || !form.sftpApplicationId} onClick={() => save.mutate()}>{save.isPending ? 'Guardando…' : 'Guardar'}</button>
    </>}>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-group"><label className="form-label">Nombre *</label><input className="form-input" value={form.name} onChange={event => setForm(value => ({ ...value, name: event.target.value }))} /></div>
      <div className="form-row">
        <div className="form-group"><label className="form-label">Aplicación SFTP *</label><select className="form-input" value={form.sftpApplicationId} onChange={event => setForm(value => ({ ...value, sftpApplicationId: event.target.value }))}><option value="">Seleccionar…</option>{sftpApps.map(app => <option key={app.id} value={app.id}>{app.name} · {app.host}</option>)}</select></div>
        <div className="form-group"><label className="form-label">Patrón de archivos</label><input className="form-input" value={form.filePattern} onChange={event => setForm(value => ({ ...value, filePattern: event.target.value }))} /></div>
      </div>
      {isFilter && <>
        <div className="form-row">
          <div className="form-group"><label className="form-label">País *</label><select className="form-input" value={form.country} onChange={event => {
            const country = event.target.value; setForm(value => ({ ...value, country, thresholdAmount: country === 'CO' ? 374000 : 3000, sourceScope: country === 'MX' ? 'city_club' : 'all' }));
          }}><option value="MX">México</option><option value="CO">Colombia</option></select></div>
          <div className="form-group"><label className="form-label">Eliminar montos mayores a *</label><input className="form-input" type="number" min={0.01} value={form.thresholdAmount} onChange={event => setForm(value => ({ ...value, thresholdAmount: Number(event.target.value) }))} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Alcance</label><select className="form-input" value={form.sourceScope} onChange={event => setForm(value => ({ ...value, sourceScope: event.target.value }))}><option value="city_club">Solo City Club</option><option value="all">Todos los archivos</option></select></div>
          <div className="form-group"><label className="form-label">Columna del monto (inicia en 0)</label><input className="form-input" type="number" min={0} value={form.priceColumn} onChange={event => setForm(value => ({ ...value, priceColumn: Number(event.target.value) }))} /><p className="form-hint">En los archivos PVP actuales es la columna 4: la quinta posición separada por “|”.</p></div>
        </div>
      </>}
      <div className="form-row">
        <div className="form-group"><label className="form-label">Recurrencia (minutos)</label><input className="form-input" type="number" min={5} value={form.intervalMinutes} onChange={event => setForm(value => ({ ...value, intervalMinutes: Number(event.target.value) }))} /></div>
        <div className="form-group"><label className="form-label">Máximo de {isFilter ? 'archivos' : 'tiendas'} por ejecución</label><input className="form-input" type="number" min={1} max={isFilter ? 1000 : 20} value={form.maxFilesPerRun} onChange={event => setForm(value => ({ ...value, maxFilesPerRun: Number(event.target.value) }))} /></div>
      </div>
      <div className="form-group"><label className="form-label">Delimitador (vacío = autodetectar)</label><input className="form-input" placeholder="|, ;, , o \\t" value={form.delimiter} onChange={event => setForm(value => ({ ...value, delimiter: event.target.value }))} /></div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input type="checkbox" checked={form.active} onChange={event => setForm(value => ({ ...value, active: event.target.checked }))} /> Ejecutar automáticamente</label>
    </Modal>}
  </>;
}
