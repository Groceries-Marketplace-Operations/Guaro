import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission } from '../../auth/permissions';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import { fileIntegrationsApi, sftpApplicationsApi } from '../../api';
import type { FileIntegrationKind, FileIntegrationRule, SftpApplication } from '../../types';
import TargetedMenuSection from './TargetedMenuSection';
import CrossAppMenuCopySection from './CrossAppMenuCopySection';
import OfferMenuUploadSection from './OfferMenuUploadSection';
import StoreFileSplitterSection from './StoreFileSplitterSection';
import DailyStatusActivationSection from './DailyStatusActivationSection';
import MassiveRtboSection from './MassiveRtboSection';
import DidiStoreBindingsSection from './DidiStoreBindingsSection';
import UpcActivityPriceSection from './UpcActivityPriceSection';
import ExecutionTiming from '../../components/integrations/ExecutionTiming';

interface RuleForm {
  name: string;
  kind: FileIntegrationKind;
  filterMode: 'amount' | 'code' | 'amount_and_code';
  country: string;
  sftpApplicationId: string;
  active: boolean;
  intervalMinutes: number;
  filePattern: string;
  sourceScope: string;
  thresholdAmount: number;
  delimiter: string;
  priceColumn: number;
  upcColumn: number;
  excludedUpcs: string;
  maxFilesPerRun: number;
}

type CustomIntegrationSection = 'massive-rtbo' | 'didi-store-bindings' | 'daily-activation' | 'store-splitter' | 'offer-menu' | 'targeted-menu' | 'upc-activity-price' | 'cross-app';

const runningStatuses = new Set(['pending', 'running']);
const MAX_SFTP_FILTER_CODES = 100_000;
const MAX_SFTP_FILTER_CODES_LABEL = MAX_SFTP_FILTER_CODES.toLocaleString('es-MX');
const MAX_SFTP_CODE_FILE_BYTES = 7_000_000;

function initialForm(kind: FileIntegrationKind): RuleForm {
  return kind === 'price_filter'
    ? { name: '', kind, filterMode: 'code', country: '', sftpApplicationId: '', active: false, intervalMinutes: 1440,
      filePattern: '*', sourceScope: 'all', thresholdAmount: 374000, delimiter: '', priceColumn: 4, upcColumn: 0, excludedUpcs: '', maxFilesPerRun: 700 }
    : { name: '', kind, filterMode: 'amount', country: '', sftpApplicationId: '', active: false, intervalMinutes: 1440,
      filePattern: '*', sourceScope: 'all', thresholdAmount: 0, delimiter: '', priceColumn: 0, upcColumn: 0, excludedUpcs: '', maxFilesPerRun: 20 };
}

function listValues(value: string) {
  return [...new Set(value.split(/[\s,;]+/).map(item => {
    const trimmed = item.trim().replace(/^['"]|['"]$/g, '').trim();
    return /^\d+[.]0+$/.test(trimmed) ? trimmed.replace(/[.]0+$/, '') : trimmed;
  }).filter(Boolean))];
}

function date(value?: string) {
  return value ? new Date(value).toLocaleString() : '—';
}

function filterModeLabel(mode?: FileIntegrationRule['filterMode']) {
  return mode === 'code' ? 'Por código' : mode === 'amount_and_code' ? 'Monto y código' : 'Por monto';
}

function saveBase64(fileName: string, contentBase64: string, mimeType: string) {
  const bytes = Uint8Array.from(atob(contentBase64), char => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url; link.download = fileName; link.click();
  URL.revokeObjectURL(url);
}

export default function FileIntegrationsPage({ kind, standaloneSftp = false }: { kind: FileIntegrationKind; standaloneSftp?: boolean }) {
  const qc = useQueryClient();
  const { account } = useAuth();
  const isFilter = kind === 'price_filter';
  const title = standaloneSftp ? 'Procesamiento SFTP' : isFilter ? 'Custom integrations' : 'Lectura de promociones complejas SFTP';
  const canConfigure = !standaloneSftp || hasPermission(account, 'integrations.sftp_processing.configure');
  const canExecute = !standaloneSftp || hasPermission(account, 'integrations.sftp_processing.execute');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<FileIntegrationRule | null>(null);
  const [form, setForm] = useState<RuleForm>(() => initialForm(kind));
  const [error, setError] = useState('');
  const [codeImportError, setCodeImportError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [customSection, setCustomSection] = useState<CustomIntegrationSection>('targeted-menu');
  const showSftp = standaloneSftp || !isFilter;
  const [ruleSearch, setRuleSearch] = useState('');
  const [ruleState, setRuleState] = useState('all');
  const [ruleMode, setRuleMode] = useState('all');
  const selectedSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isFilter && !standaloneSftp) {
      selectedSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [customSection, isFilter, standaloneSftp]);

  const { data: rules = [], isLoading, isError: rulesFailed } = useQuery<FileIntegrationRule[]>({
    queryKey: ['file-integrations', kind],
    queryFn: () => fileIntegrationsApi.list(kind).then(response => response.data),
    enabled: showSftp,
    refetchInterval: query => (query.state.data as FileIntegrationRule[] | undefined)
      ?.some(rule => rule.executions.some(execution => runningStatuses.has(execution.status))) ? 3000 : 15000,
  });
  const { data: sftpApps = [], isLoading: sftpAppsLoading, isError: sftpAppsFailed } = useQuery<Pick<SftpApplication, 'id' | 'name' | 'host' | 'active'>[]>({
    queryKey: ['sftp-applications', 'file-integrations', standaloneSftp ? 'processing-options' : 'catalog-list'],
    queryFn: () => standaloneSftp
      ? fileIntegrationsApi.sftpOptions().then(response => response.data)
      : sftpApplicationsApi.list({ page: 1, limit: 100 }).then(response => response.data.data),
    enabled: showSftp && canConfigure,
  });
  const availableSftpApps = useMemo(() => [...sftpApps].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)), [sftpApps]);
  const selectedSftpApp = sftpApps.find(item => item.id === form.sftpApplicationId);
  const canUseCityClub = form.country === 'MX'
    && /soriana|city\s*club/i.test(selectedSftpApp?.name ?? editing?.sftpApplication.name ?? '');
  const duplicateRule = isFilter && !editing && form.sftpApplicationId
    ? rules.find(rule => rule.sftpApplicationId === form.sftpApplicationId
      && rule.filePattern === (form.filePattern.trim() || '*')
      && rule.sourceScope === (form.sourceScope.trim() || 'all'))
    : undefined;
  const codeValues = useMemo(() => listValues(form.excludedUpcs), [form.excludedUpcs]);
  const needsAmount = form.filterMode !== 'code';
  const needsCodes = form.filterMode !== 'amount';
  const willResetTracking = Boolean(editing && isFilter && (
    (editing.country ?? '') !== form.country
    || editing.sftpApplicationId !== form.sftpApplicationId
    || editing.filePattern !== (form.filePattern.trim() || '*')
    || editing.sourceScope !== form.sourceScope
    || (editing.filterMode ?? 'amount') !== form.filterMode
    || (editing.delimiter ?? '') !== form.delimiter.trim()
    || (editing.priceColumn ?? null) !== (needsAmount ? form.priceColumn : null)
    || (editing.upcColumn ?? null) !== (needsCodes ? form.upcColumn : null)
    || editing.excludedUpcs.join('\n') !== (needsCodes ? codeValues.join('\n') : '')
    || (editing.thresholdAmount == null ? null : Number(editing.thresholdAmount)) !== (needsAmount ? form.thresholdAmount : null)
  ));
  const filteredRules = useMemo(() => rules.filter(rule => {
    const mode = rule.filterMode ?? 'amount';
    const latest = rule.executions[0];
    const matchesText = `${rule.name} ${rule.sftpApplication.name} ${rule.country ?? ''} ${rule.filePattern}`
      .toLocaleLowerCase().includes(ruleSearch.trim().toLocaleLowerCase());
    const matchesState = ruleState === 'all' || (ruleState === 'active' && rule.active)
      || (ruleState === 'inactive' && !rule.active)
      || (ruleState === 'running' && latest && runningStatuses.has(latest.status))
      || (ruleState === 'failed' && (rule.fileState?.failed ?? 0) > 0);
    return matchesText && matchesState && (ruleMode === 'all' || mode === ruleMode);
  }), [rules, ruleSearch, ruleState, ruleMode]);
  const recentExecutions = useMemo(() => rules.flatMap(rule => rule.executions.map(execution => ({ rule, execution })))
    .sort((a, b) => Date.parse(b.execution.createdAt) - Date.parse(a.execution.createdAt)).slice(0, 8), [rules]);
  const dashboard = useMemo(() => ({
    active: rules.filter(rule => rule.active).length,
    running: rules.filter(rule => rule.executions.some(execution => runningStatuses.has(execution.status))).length,
    pending: rules.reduce((sum, rule) => sum + (rule.fileState?.pending ?? 0), 0),
    failed: rules.reduce((sum, rule) => sum + (rule.fileState?.failed ?? 0), 0),
    processed: rules.reduce((sum, rule) => sum + (rule.fileState?.done ?? 0), 0),
  }), [rules]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['file-integrations', kind] });
  const save = useMutation({
    mutationFn: () => {
      const data = {
        ...form,
        country: form.country || undefined,
        filterMode: isFilter ? form.filterMode : undefined,
        thresholdAmount: isFilter && needsAmount ? form.thresholdAmount : undefined,
        priceColumn: isFilter && needsAmount ? form.priceColumn : undefined,
        upcColumn: isFilter && needsCodes ? form.upcColumn : undefined,
        excludedUpcs: isFilter ? (needsCodes ? codeValues : []) : undefined,
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

  const openCreate = () => { setEditing(null); setForm(initialForm(kind)); setError(''); setCodeImportError(''); setOpen(true); };
  const openEdit = (rule: FileIntegrationRule) => {
    setEditing(rule);
    setForm({
      name: rule.name, kind, filterMode: rule.filterMode ?? (rule.excludedUpcs.length ? 'amount_and_code' : 'amount'), country: rule.country ?? '', sftpApplicationId: rule.sftpApplicationId,
      active: rule.active && rule.sftpApplication.active, intervalMinutes: rule.intervalMinutes ?? 1440, filePattern: rule.filePattern,
      sourceScope: rule.sourceScope, thresholdAmount: Number(rule.thresholdAmount ?? 0), delimiter: rule.delimiter ?? '',
      priceColumn: rule.priceColumn ?? 0, upcColumn: rule.upcColumn ?? (rule.country === 'CO' ? 0 : 1),
      excludedUpcs: (rule.excludedUpcs ?? []).join('\n'), maxFilesPerRun: rule.maxFilesPerRun,
    });
    setError(''); setCodeImportError(''); setOpen(true);
  };

  const importCodeFile = async (file?: File) => {
    if (!file) return;
    if (file.size > MAX_SFTP_CODE_FILE_BYTES) {
      setCodeImportError(`El archivo supera ${MAX_SFTP_CODE_FILE_BYTES / 1_000_000} MB. Usa una lista de códigos en TXT o CSV de una columna.`);
      return;
    }
    try {
      const imported = listValues(await file.text());
      if (imported.length === 0) throw new Error('El archivo no contiene códigos.');
      if (imported.some(code => code.length > 64)) throw new Error('Hay códigos de más de 64 caracteres.');
      setForm(current => ({ ...current, excludedUpcs: listValues(`${current.excludedUpcs}\n${imported.join('\n')}`).join('\n') }));
      setCodeImportError('');
    } catch (reason) {
      setCodeImportError(reason instanceof Error ? reason.message : 'No se pudo leer el archivo.');
    }
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
          <p>{standaloneSftp
          ? 'Configura qué UPC y montos se eliminan de los archivos. Revisa la ejecución y sus incidencias desde aquí.'
            : isFilter
            ? 'Herramientas especializadas para automatizaciones SFTP y administración de menús entre tiendas y aplicaciones.'
            : 'Lee la promoción vigente más reciente por tienda, la almacena localmente y registra volumen, estado y duración.'}</p>
        </div>
        {showSftp && canConfigure && <button className="btn btn-primary" onClick={openCreate}>+ Nueva regla</button>}
      </div>
      {isFilter && !standaloneSftp && <nav className="custom-integration-nav" aria-label="Herramientas de integración">
        <button type="button" className={customSection === 'targeted-menu' ? 'is-active' : ''} onClick={() => setCustomSection('targeted-menu')} aria-selected={customSection === 'targeted-menu'}>
          <span className="custom-integration-icon">TM</span>
          <span><strong>Targeted Menu Upload</strong><small>Carga UPC seleccionados en tiendas específicas</small></span>
        </button>
        <button type="button" className={customSection === 'upc-activity-price' ? 'is-active' : ''} onClick={() => setCustomSection('upc-activity-price')} aria-selected={customSection === 'upc-activity-price'}>
          <span className="custom-integration-icon">AP</span>
          <span><strong>UPC Activity Price</strong><small>Iguala activity_price al precio base en un horario controlado</small></span>
          <span className="badge">08:00–13:00</span>
        </button>
        <button type="button" className={customSection === 'massive-rtbo' ? 'is-active' : ''} onClick={() => setCustomSection('massive-rtbo')} aria-selected={customSection === 'massive-rtbo'}>
          <span className="custom-integration-icon">RT</span>
          <span><strong>Massive RTBO</strong><small>Actualiza promise_produce_time por aplicación y tienda</small></span>
        </button>
        <button type="button" className={customSection === 'didi-store-bindings' ? 'is-active' : ''} onClick={() => setCustomSection('didi-store-bindings')} aria-selected={customSection === 'didi-store-bindings'}>
          <span className="custom-integration-icon">BU</span>
          <span><strong>DiDi Bind / Unbind</strong><small>Vinculación segura para aplicaciones TEST y producción</small></span>
          <span className="badge">TEST / PROD</span>
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
      {standaloneSftp && <div className="sftp-processing-dashboard">
        <div className="sftp-processing-guide card">
          <div><span className="sftp-processing-guide-step">1</span><strong>Configura la regla</strong><small>Elige UPC, monto máximo o ambos criterios.</small></div>
          <div><span className="sftp-processing-guide-step">2</span><strong>Ejecuta o programa</strong><small>Solo archivos modificados hoy en la cuenta y patrón elegidos.</small></div>
          <div><span className="sftp-processing-guide-step">3</span><strong>Revisa el resultado</strong><small>El historial y los respaldos vencen a las 24 horas.</small></div>
        </div>
        <div className="sftp-processing-kpis" aria-label="Resumen de procesamiento SFTP">
          {[
            ['Reglas', rules.length, `${dashboard.active} activas`],
            ['En ejecución', dashboard.running, 'Reglas trabajando ahora'],
            ['Archivos pendientes', dashboard.pending, 'En espera de procesamiento'],
            ['Archivos fallidos', dashboard.failed, 'Requieren revisión'],
          ].map(([label, value, help]) => <div className="card sftp-processing-kpi" key={label}>
            <span>{label}</span><strong>{isLoading ? '—' : Number(value).toLocaleString('es-MX')}</strong><small>{help}</small>
          </div>)}
        </div>
        <section className="card sftp-processing-activity">
          <div className="sftp-processing-section-heading">
            <div><h2>Actividad de las últimas 24 horas</h2><p>Los reportes y respaldos antiguos se limpian periódicamente; si falta un original, su respaldo se conserva para recuperación.</p></div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => refresh()}>Actualizar</button>
          </div>
          {isLoading ? <p className="text-muted">Cargando actividad…</p> : recentExecutions.length === 0 ? <p className="text-muted">Todavía no hay ejecuciones registradas.</p> : <div className="table-wrap"><table>
            <thead><tr><th>Regla</th><th>Estado</th><th>Archivos</th><th>Filas eliminadas</th><th>Inicio</th></tr></thead>
            <tbody>{recentExecutions.map(({ rule, execution }) => <tr key={execution.id}>
              <td><strong>{rule.name}</strong><div className="text-muted" style={{ fontSize: 11 }}>{rule.sftpApplication.name}</div></td>
              <td><StatusBadge status={execution.status} /></td>
              <td>{execution.filesProcessed.toLocaleString('es-MX')} / {execution.filesScanned.toLocaleString('es-MX')}</td>
              <td>{execution.rowsRemoved.toLocaleString('es-MX')}</td>
              <td>{date(execution.startedAt ?? execution.createdAt)}</td>
            </tr>)}</tbody>
          </table></div>}
        </section>
        <div className="sftp-processing-section-heading" id="sftp-processing-rules">
          <div><h2>Reglas de procesamiento</h2><p>Busca por nombre, cuenta SFTP, país o patrón de archivo.</p></div>
          <span className="badge">{filteredRules.length} de {rules.length}</span>
        </div>
        <div className="sftp-processing-filters">
          <input className="form-input" type="search" aria-label="Buscar reglas" placeholder="Buscar regla o cuenta SFTP…" value={ruleSearch} onChange={event => setRuleSearch(event.target.value)} />
          <select className="form-input" aria-label="Filtrar por estado" value={ruleState} onChange={event => setRuleState(event.target.value)}>
            <option value="all">Todos los estados</option><option value="active">Activas</option><option value="inactive">Inactivas</option><option value="running">En ejecución</option><option value="failed">Con archivos fallidos</option>
          </select>
          <select className="form-input" aria-label="Filtrar por tipo de regla" value={ruleMode} onChange={event => setRuleMode(event.target.value)}>
            <option value="all">Todos los tipos</option><option value="amount">Por monto</option><option value="code">Por código</option><option value="amount_and_code">Monto y código</option>
          </select>
        </div>
      </div>}
      {showSftp && !standaloneSftp && <div className="alert alert-info" style={{ marginBottom: 18 }}>
        {isFilter
          ? 'Un UPC incluido o un monto superior al límite elimina la fila. El original se respalda antes de sustituir el archivo. El historial y los respaldos de esta sección se conservan 24 horas; los respaldos sin original disponible quedan protegidos.'
          : 'Funciona como Auto Menu Fetch para promociones: conserva una instantánea local por App Shop ID. Las credenciales permanecen cifradas.'}
      </div>}
      {isFilter && !showSftp && <div ref={selectedSectionRef} style={{ scrollMarginTop: 76 }}>
        {customSection === 'targeted-menu' && <TargetedMenuSection />}
        {customSection === 'upc-activity-price' && <UpcActivityPriceSection />}
        {customSection === 'massive-rtbo' && <MassiveRtboSection />}
        {customSection === 'didi-store-bindings' && <DidiStoreBindingsSection />}
        {customSection === 'store-splitter' && <StoreFileSplitterSection />}
        {customSection === 'daily-activation' && <DailyStatusActivationSection />}
        {customSection === 'offer-menu' && <OfferMenuUploadSection />}
        {customSection === 'cross-app' && <CrossAppMenuCopySection />}
      </div>}
      {showSftp && <>
      {rulesFailed && <div className="error-banner">No se pudieron cargar las reglas SFTP. Intenta actualizar la página.</div>}
      {isLoading && <p className="text-muted">Cargando…</p>}
      {!isLoading && rules.length === 0 && <div className="empty-state"><p>No hay configuraciones.</p></div>}
      {standaloneSftp && !isLoading && rules.length > 0 && filteredRules.length === 0 && <div className="empty-state"><p>No hay reglas que coincidan con los filtros.</p></div>}
      <div style={{ display: 'grid', gap: 14 }}>
        {(standaloneSftp ? filteredRules : rules).map(rule => {
          const latest = rule.executions[0];
          const running = latest && runningStatuses.has(latest.status);
          const mode = rule.filterMode ?? 'amount';
          const amountLabel = rule.thresholdAmount == null ? '—' : Number(rule.thresholdAmount).toLocaleString('es-MX');
          return <section key={rule.id} className="card" style={{ padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong>{rule.name}</strong><StatusBadge status={rule.active ? 'active' : 'inactive'} />
                  {rule.country && <span className="badge">{rule.country}</span>}
                  <span className="badge">{rule.sftpApplication.name}</span>
                  <span className="badge">Archivos: {rule.filePattern}</span>
                  {isFilter && <span className="badge">Alcance: {rule.sourceScope === 'city_club' ? 'solo City Club' : 'cuenta SFTP y patrón'}</span>}
                  {isFilter && <span className="badge">Hoy · {rule.country === 'CO' ? 'Bogotá' : 'Ciudad de México'}</span>}
                  {isFilter && <span className="badge">{filterModeLabel(mode)}</span>}
                  {isFilter && mode !== 'code' && <span className="badge">Monto &gt; {amountLabel}</span>}
                  {isFilter && mode !== 'amount' && <span className="badge" style={{ color: 'var(--red-text)' }}>{rule.excludedUpcs.length.toLocaleString('es-MX')} UPC</span>}
                  {isFilter && !rule.sftpApplication.active && <span className="badge" style={{ color: 'var(--red-text)' }}>Cuenta SFTP inactiva</span>}
                </div>
                {isFilter && <p className="sftp-processing-criteria">
                  <strong>Se elimina la fila si </strong>
                  {mode === 'amount' ? `el monto supera ${amountLabel}.`
                    : mode === 'code' ? `el UPC está en la lista de ${rule.excludedUpcs.length.toLocaleString('es-MX')}.`
                      : `el UPC está en la lista de ${rule.excludedUpcs.length.toLocaleString('es-MX')} o el monto supera ${amountLabel}.`}
                </p>}
                {isFilter && rule.country === 'MX' && /city\s*club/i.test(rule.name) && rule.sourceScope !== 'city_club' &&
                  <p className="sftp-processing-notice">El nombre menciona City Club, pero el alcance actual depende solo de la cuenta y del patrón {rule.filePattern}. Comprueba que ese patrón no incluya otras tiendas.</p>}
                <div className="text-muted" style={{ marginTop: 8, fontSize: 12 }}>
                  Cada {rule.intervalMinutes ?? '—'} min · Máx. {rule.maxFilesPerRun} {isFilter ? 'archivos' : 'tiendas'} · Última: {date(rule.lastRunAt)} · Próxima: {date(rule.nextRunAt)}
                </div>
                {isFilter && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 9, fontSize: 12 }}>
                  <span className="badge">Inventario: {rule.fileState?.total ?? 0}</span>
                  <span className="badge" style={{ color: 'var(--amber-text)' }}>Pendientes: {rule.fileState?.pending ?? 0}</span>
                  <span className="badge" style={{ color: 'var(--orange-dark)' }}>Procesando: {rule.fileState?.running ?? 0}</span>
                  <span className="badge" style={{ color: 'var(--green-text)' }}>Procesados: {rule.fileState?.done ?? 0}</span>
                  <span className="badge" style={{ color: 'var(--red)' }}>Fallidos: {rule.fileState?.failed ?? 0}</span>
                </div>}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {canExecute && <button className="btn btn-primary btn-sm" disabled={!!running || action.isPending || !rule.sftpApplication.active} onClick={() => action.mutate({ id: rule.id, verb: 'run' })}>Ejecutar ahora</button>}
                {running && canExecute && <button className="btn btn-ghost btn-sm" onClick={() => action.mutate({ id: rule.id, verb: 'stop' })}>Detener</button>}
                {canConfigure && <button className="btn btn-ghost btn-sm" onClick={() => openEdit(rule)}>Configurar regla</button>}
                {canConfigure && <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => {
                  if (window.confirm(`¿Eliminar ${rule.name}?`)) action.mutate({ id: rule.id, verb: 'delete' });
                }}>Eliminar</button>}
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
                <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(expanded === latest.id ? null : latest.id)}>{expanded === latest.id ? 'Ocultar detalle' : 'Ver detalle'}</button>
              </div>
              <ExecutionTiming startedAt={latest.startedAt} finishedAt={latest.finishedAt} durationMs={latest.durationMs} />
              {latest.currentFile && <p className="text-muted" style={{ marginTop: 8 }}>Procesando: {latest.currentFile}</p>}
              {latest.errorMessage && <p style={{ color: 'var(--red)', marginTop: 8 }}>{latest.errorMessage}</p>}
              {expanded === latest.id && <div className="table-wrap" style={{ marginTop: 12 }}><table>
                <thead><tr><th>Archivo</th><th>Filas</th><th>Conservadas</th><th>Eliminadas</th><th>Resultado</th></tr></thead>
                <tbody>{(latest.result?.files ?? []).map(file => <tr key={file.fileName}>
                  <td className="td-mono">{file.fileName}</td><td>{file.rowsRead}</td><td>{file.rowsKept}</td><td>{file.rowsRemoved}<div className="text-muted" style={{ fontSize: '.65rem' }}>{file.rowsRemovedByAmount ?? 0} por monto · {file.rowsRemovedByUpc ?? 0} por UPC</div></td>
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

    {open && canConfigure && <Modal className={isFilter ? 'modal--sftp-rule' : ''} title={editing ? 'Editar regla SFTP' : 'Nueva regla SFTP'} onClose={() => setOpen(false)} footer={<>
      <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancelar</button>
      <button className="btn btn-primary" disabled={save.isPending || !!duplicateRule || !form.name.trim() || !form.sftpApplicationId || (isFilter && !form.country) || (needsAmount && form.thresholdAmount <= 0) || (needsCodes && codeValues.length === 0) || codeValues.length > MAX_SFTP_FILTER_CODES || codeValues.some(code => code.length > 64)} onClick={() => {
        if (willResetTracking && !window.confirm('Cambiar la selección o los filtros reiniciará el seguimiento. La próxima ejecución revisará de nuevo los archivos modificados hoy. ¿Guardar los cambios?')) return;
        save.mutate();
      }}>{save.isPending ? 'Guardando…' : editing ? 'Guardar cambios' : 'Guardar regla'}</button>
    </>}>
      {error && <div className="error-banner">{error}</div>}
      {willResetTracking && <div className="sftp-processing-notice">Cambiaste la selección o los filtros. Al guardar, se reiniciará el seguimiento y la próxima ejecución revisará de nuevo los archivos modificados hoy.</div>}
      <div className="form-group"><label className="form-label">Nombre *</label><input className="form-input" value={form.name} onChange={event => setForm(value => ({ ...value, name: event.target.value }))} /></div>
      <div className="form-row">
        <div className="form-group"><label className="form-label">Aplicación SFTP *</label><select className="form-input" value={form.sftpApplicationId} onChange={event => {
          const id = event.target.value;
          const selected = sftpApps.find(app => app.id === id);
          setForm(value => ({ ...value, sftpApplicationId: id,
            active: selected?.active ? value.active : false,
            sourceScope: selected && value.country === 'MX' && /soriana|city\s*club/i.test(selected.name)
              ? value.sourceScope : 'all' }));
        }}><option value="">Seleccionar…</option>{availableSftpApps.map(app => <option key={app.id} value={app.id}>{app.name} · {app.host}{!app.active ? ' · Inactiva' : ''}</option>)}</select>
          {sftpAppsLoading && <p className="form-hint">Cargando cuentas SFTP…</p>}
          {sftpAppsFailed && <p className="form-hint" style={{ color: 'var(--red)' }}>No se pudieron cargar las cuentas SFTP. Actualiza la página e inténtalo de nuevo.</p>}
          {!sftpAppsLoading && !sftpAppsFailed && sftpApps.length === 0 && <p className="form-hint">No hay cuentas SFTP registradas.</p>}
          {selectedSftpApp && !selectedSftpApp.active && <p className="form-hint">Puedes preparar la regla con esta cuenta inactiva. Para ejecutarla, primero activa la cuenta en Aplicaciones SFTP.</p>}
        </div>
        <div className="form-group"><label className="form-label">Patrón de archivos</label><input className="form-input" value={form.filePattern} onChange={event => setForm(value => ({ ...value, filePattern: event.target.value }))} /><p className="form-hint">* incluye todos los archivos de la carpeta principal de esta cuenta; PVP* limita por nombre.</p></div>
      </div>
      {duplicateRule && <div className="sftp-processing-notice">Ya existe una regla para esta cuenta, patrón y alcance: <strong>{duplicateRule.name}</strong>. Agrega los códigos a esa regla para evitar procesar el mismo archivo dos veces. <button type="button" className="btn btn-ghost btn-sm" onClick={() => openEdit(duplicateRule)}>Editar regla existente</button></div>}
      {isFilter && <>
        <div className="form-group"><label className="form-label">¿Qué filas se eliminan? *</label><select className="form-input" value={form.filterMode} onChange={event => setForm(value => ({ ...value, filterMode: event.target.value as RuleForm['filterMode'] }))}>
          <option value="amount_and_code">UPC de la lista O monto superior al límite</option><option value="code">Solo UPC de la lista</option><option value="amount">Solo monto superior al límite</option>
        </select><p className="form-hint">Con ambos criterios, basta que se cumpla uno. Combina los filtros si usan los mismos archivos para evitar dos reemplazos.</p></div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">País *</label><select className="form-input" value={form.country} onChange={event => {
            const country = event.target.value; setForm(value => ({ ...value, country, thresholdAmount: country === 'CO' ? 374000 : country === 'MX' ? 3000 : value.thresholdAmount, sourceScope: 'all', upcColumn: country === 'CO' ? 0 : 1 }));
          }}><option value="">Seleccionar país…</option><option value="MX">México</option><option value="CO">Colombia</option></select></div>
          {needsAmount && <div className="form-group"><label className="form-label">Monto máximo permitido *</label><input className="form-input" type="number" min={0.01} value={form.thresholdAmount} onChange={event => setForm(value => ({ ...value, thresholdAmount: Number(event.target.value) }))} /><p className="form-hint">Se elimina si el monto es mayor; si es igual, se conserva.</p></div>}
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Alcance dentro de la cuenta SFTP</label><select className="form-input" value={form.sourceScope} onChange={event => setForm(value => ({ ...value, sourceScope: event.target.value }))}><option value="all">Todos los archivos que coincidan con el patrón</option>{canUseCityClub && <option value="city_club">Solo tiendas City Club</option>}</select><p className="form-hint">Solo archivos modificados hoy en la carpeta principal de esta cuenta. {canUseCityClub ? 'Para City Club, el ID del archivo se compara con las tiendas de esa marca en Guaro.' : selectedSftpApp?.name.toLowerCase().includes('cencosud') ? 'En Cencosud, * incluye Metro, Easy y Jumbo.' : 'El patrón y la cuenta determinan qué archivos se incluyen.'}</p></div>
          {needsAmount && <div className="form-group"><label className="form-label">Columna del monto (inicia en 0)</label><input className="form-input" type="number" min={0} value={form.priceColumn} onChange={event => setForm(value => ({ ...value, priceColumn: Number(event.target.value) }))} /><p className="form-hint">La columna 4 es la quinta posición. Verifica el separador y la estructura de los archivos de esta cuenta.</p></div>}
        </div>
        {needsCodes && <div className="sftp-processing-code-input">
          <div className="form-group"><label className="form-label">Códigos a eliminar * ({codeValues.length.toLocaleString('es-MX')} / {MAX_SFTP_FILTER_CODES_LABEL})</label>
            <textarea className="form-input td-mono" rows={8} placeholder="Pega un código por línea o separados por espacio, coma o punto y coma" value={form.excludedUpcs} onChange={event => setForm(value => ({ ...value, excludedUpcs: event.target.value }))} />
            <p className="form-hint">Se comparan como texto: se conservan los ceros iniciales y se normaliza un sufijo .0. No se crean miles de etiquetas en pantalla.</p>
          </div>
          <div className="form-group"><label className="form-label">Importar códigos desde TXT o CSV de una columna</label>
            <input className="form-input" type="file" accept=".txt,.csv,.tsv,text/plain,text/csv" onChange={event => { void importCodeFile(event.target.files?.[0]); event.target.value = ''; }} />
            <p className="form-hint">La importación agrega códigos únicos a los ya pegados. Máximo 2 MB por archivo.</p>
            <label className="form-label" style={{ marginTop: 14 }}>Columna del código (inicia en 0)</label>
            <input className="form-input" type="number" min={0} max={200} value={form.upcColumn} onChange={event => setForm(value => ({ ...value, upcColumn: Number(event.target.value) }))} />
            <p className="form-hint">{selectedSftpApp?.name.toLowerCase().includes('cencosud') ? 'En los CSV actuales de Cencosud, el código está en la columna 0.' : 'Indica la posición real del UPC en los archivos de esta cuenta.'}</p>
            {codeValues.length > 0 && <p className="form-hint">Muestra: <span className="td-mono">{codeValues.slice(0, 8).join(', ')}{codeValues.length > 8 ? '…' : ''}</span></p>}
          </div>
          {codeImportError && <div className="error-banner">{codeImportError}</div>}
          {codeValues.length > MAX_SFTP_FILTER_CODES && <div className="error-banner">La regla admite hasta {MAX_SFTP_FILTER_CODES_LABEL} códigos únicos.</div>}
          {codeValues.some(code => code.length > 64) && <div className="error-banner">Los códigos deben tener máximo 64 caracteres.</div>}
        </div>}
      </>}
      <div className="form-row">
        <div className="form-group"><label className="form-label">Recurrencia (minutos)</label><input className="form-input" type="number" min={5} value={form.intervalMinutes} onChange={event => setForm(value => ({ ...value, intervalMinutes: Number(event.target.value) }))} /></div>
        <div className="form-group"><label className="form-label">Máximo de {isFilter ? 'archivos' : 'tiendas'} por ejecución</label><input className="form-input" type="number" min={1} max={isFilter ? 1000 : 20} value={form.maxFilesPerRun} onChange={event => setForm(value => ({ ...value, maxFilesPerRun: Number(event.target.value) }))} /></div>
      </div>
      <div className="form-group"><label className="form-label">Delimitador (vacío = autodetectar)</label><input className="form-input" placeholder="|, ;, , o \\t" value={form.delimiter} onChange={event => setForm(value => ({ ...value, delimiter: event.target.value }))} /></div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input type="checkbox" checked={form.active} disabled={!selectedSftpApp?.active} onChange={event => setForm(value => ({ ...value, active: event.target.checked }))} /> Ejecutar automáticamente</label>
      {!editing && <p className="form-hint">Las reglas nuevas empiezan inactivas. Actívalas solo después de revisar la cuenta SFTP, el patrón y los códigos.</p>}
    </Modal>}
  </>;
}
