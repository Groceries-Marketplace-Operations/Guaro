import { useState, type Dispatch, type SetStateAction } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import { autoTurnOffApi, brandsApi, shopsApi, webhooksApi } from '../../api';
import { useLang, useT } from '../../i18n';
import type {
  AutoTurnOffExecution,
  AutoTurnOffPool,
  AutoTurnOffRule,
  AutoTurnOffShopExecution,
  Brand,
  Paginated,
  Shop,
  Webhook,
} from '../../types';

type ApiError = { response?: { data?: { message?: string | string[] } } };
type FrequencyUnit = 'minutes' | 'hours' | 'days';
type StockEndpoint = 'setStock' | 'setstockSync';

interface PoolForm {
  name: string;
  country: 'MX' | 'CO' | 'CR';
  webhookId: string;
  active: boolean;
}

interface RuleForm {
  name: string;
  brandId: string;
  shopIds: string;
  upcs: string;
  stockEndpoint: StockEndpoint;
  frequency: number;
  unit: FrequencyUnit;
  startsAt: string;
  endsAt: string;
  active: boolean;
}

const emptyPool: PoolForm = { name: '', country: 'MX', webhookId: '', active: true };
function defaultStartsAt() {
  const date = new Date(Date.now() + 10 * 60_000);
  date.setSeconds(0, 0);
  return toLocalDateTimeInput(date.toISOString());
}

function newRuleForm(): RuleForm {
  return {
    name: '', brandId: '', shopIds: '', upcs: '', stockEndpoint: 'setStock', frequency: 10,
    unit: 'minutes', startsAt: defaultStartsAt(), endsAt: '', active: true,
  };
}

const statusColor: Record<string, string> = {
  pending: 'var(--text-muted)', running: 'var(--orange)', done: '#027A48', partial_success: '#B54708', failed: 'var(--red)', cancelled: '#667085',
};

function executionStatusLabel(status: string, es: boolean) {
  const labels: Record<string, [string, string]> = {
    pending: ['En cola', 'Queued'],
    running: ['Ejecutando', 'Running'],
    done: ['Exitosa', 'Successful'],
    partial_success: ['Éxito parcial', 'Partial success'],
    failed: ['Fallida', 'Failed'],
    cancelled: ['Cancelada', 'Cancelled'],
  };
  return (labels[status] ?? [status, status])[es ? 0 : 1];
}

function errorMessage(error: unknown) {
  const message = (error as ApiError).response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : (message ?? 'Unexpected error');
}

function toMinutes(value: number, unit: FrequencyUnit) {
  if (unit === 'days') return value * 1440;
  if (unit === 'hours') return value * 60;
  return value;
}

function fromMinutes(minutes: number): Pick<RuleForm, 'frequency' | 'unit'> {
  if (minutes % 1440 === 0) return { frequency: minutes / 1440, unit: 'days' };
  if (minutes % 60 === 0) return { frequency: minutes / 60, unit: 'hours' };
  return { frequency: minutes, unit: 'minutes' };
}

function parseUpcs(value: string) {
  return [...new Set(value.split(/[\s,;]+/).map(item => item.trim()).filter(Boolean))];
}

const parseShopIds = parseUpcs;

function toLocalDateTimeInput(iso: string) {
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatFrequency(minutes: number, es: boolean) {
  if (minutes % 1440 === 0) return `${minutes / 1440} ${es ? 'día(s)' : 'day(s)'}`;
  if (minutes % 60 === 0) return `${minutes / 60} ${es ? 'hora(s)' : 'hour(s)'}`;
  return `${minutes} min`;
}

function progressStep(step: string | undefined, es: boolean) {
  const key = step?.split(':')[0] ?? 'queued';
  const labels: Record<string, [string, string]> = {
    queued: ['En cola', 'Queued'],
    queued_local: ['En cola con datos locales', 'Queued with local data'],
    queued_resolved: ['Tienda resuelta; en cola', 'Store resolved; queued'],
    preparing: ['Preparando ejecución', 'Preparing execution'],
    resolving_shops: ['Resolviendo tiendas', 'Resolving stores'],
    resolving_deferred_shops: ['Resolviendo tiendas pendientes', 'Resolving deferred stores'],
    processing_shops: ['Procesando tiendas', 'Processing stores'],
    processing_local_data: ['Procesando datos locales', 'Processing local data'],
    authenticating: ['Autenticando tienda', 'Authenticating store'],
    authenticating_local: ['Autenticando para datos locales', 'Authenticating for local data'],
    authenticating_menu_retry: ['Autenticando reintento pendiente', 'Authenticating deferred retry'],
    waiting_shop_resolution: ['Pendiente al final: resolver tienda', 'Deferred: resolve store'],
    waiting_menu_download: ['Pendiente al final: descargar menú', 'Deferred: download menu'],
    downloading_menu: ['Descargando menú', 'Downloading menu'],
    downloading_deferred_menu: ['Descargando menú pendiente', 'Downloading deferred menu'],
    matching_upcs: ['Relacionando UPCs', 'Matching UPCs'],
    matching_local_upcs: ['Relacionando UPCs locales', 'Matching local UPCs'],
    updating_stock: ['Actualizando stock', 'Updating stock'],
    updating_local_stock: ['Apagando ítems locales', 'Turning off local items'],
    updating_deferred_stock: ['Apagando ítems pendientes', 'Turning off deferred items'],
    shop_not_found: ['Tienda no encontrada', 'Store not found'],
    shop_failed: ['Falló una tienda', 'A store failed'],
    shop_partial_success: ['Tienda con éxito parcial', 'Store partially succeeded'],
    queue_failed: ['Falló la cola', 'Queue failed'],
    upc_not_found: ['UPC no encontrado', 'UPC not found'],
    finalizing: ['Finalizando', 'Finalizing'],
    completed: ['Completada', 'Completed'],
    partial_success: ['Éxito parcial', 'Partial success'],
    failed: ['Fallida', 'Failed'],
    cancelled: ['Cancelada', 'Cancelled'],
  };
  return (labels[key] ?? [key, key])[es ? 0 : 1];
}

export default function AutoTurnOffItemsPage() {
  const t = useT();
  const { lang } = useLang();
  const es = lang === 'es';
  const qc = useQueryClient();
  const [poolModal, setPoolModal] = useState(false);
  const [ruleModal, setRuleModal] = useState(false);
  const [editingPool, setEditingPool] = useState<AutoTurnOffPool | null>(null);
  const [editingRule, setEditingRule] = useState<AutoTurnOffRule | null>(null);
  const [rulePoolId, setRulePoolId] = useState('');
  const [poolForm, setPoolForm] = useState<PoolForm>(emptyPool);
  const [ruleForm, setRuleForm] = useState<RuleForm>(() => newRuleForm());
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [historyPoolId, setHistoryPoolId] = useState<string | null>(null);
  const [shopResultsExecutionId, setShopResultsExecutionId] = useState<string | null>(null);
  const [shopResultsPage, setShopResultsPage] = useState(1);
  const [shopSearch, setShopSearch] = useState('');

  const copy = es ? {
    title: 'Apagado automático de ítems',
    subtitle: 'Ejecuta Stock API con stock 0 por regla, marca, tiendas y UPCs.',
    newPool: 'Nuevo pool', editPool: 'Editar pool', poolName: 'Nombre del pool', country: 'País',
    webhook: 'Webhook (opcional)', noWebhook: 'Sin webhook', active: 'Activo', inactive: 'Inactivo',
    noPools: 'No hay pools configurados.', rules: 'reglas', addRule: 'Agregar regla',
    editRule: 'Editar regla', newRule: 'Nueva regla', ruleName: 'Nombre de la regla', brand: 'Marca',
    shops: 'shop_id objetivo', upcs: 'UPCs', frequency: 'Frecuencia',
    endpoint: 'Versión de Stock API', asyncEndpoint: 'setStock (asíncrono)', syncEndpoint: 'setstockSync (síncrono)',
    shopHelp: 'Ingresa un shop_id de DiDi por línea o separado por coma. Debe tener 19 dígitos e iniciar con 57.',
    frequencyHelp: 'setStock requiere mínimo 10 minutos; setstockSync permite desde 1 minuto.',
    syncLimit: 'setstockSync permite como máximo 2,000 UPCs por regla.',
    startsAt: 'Iniciar apagado', endsAt: 'Detener automáticamente', noEnd: 'Sin fecha de término', status: 'Estado', queued: 'En cola', runningStatus: 'Ejecutando', scheduledStatus: 'Programada',
    failedStatus: 'Fallida', cancelledStatus: 'Cancelada', stop: 'Detener', stopping: 'Deteniendo…',
    partialStatus: 'Éxito parcial', shopResults: 'Resultado por tienda', hideShopResults: 'Ocultar tiendas',
    every: 'Cada', minutes: 'minutos', hours: 'horas', days: 'días',
    selectBrand: 'Selecciona una marca', selectAll: 'Seleccionar todas', clear: 'Limpiar',
    searchShop: 'Buscar tienda…', noShops: 'No hay tiendas para esta marca.',
    upcHelp: 'Uno por línea o separados por coma. Todos se enviarán con stock 0.',
    save: 'Guardar', cancel: 'Cancelar', run: 'Ejecutar ahora', running: 'Encolando…',
    history: 'Historial', hide: 'Ocultar', edit: 'Editar', remove: 'Eliminar',
    next: 'Próxima', last: 'Última', never: 'Nunca', stores: 'tiendas', items: 'UPCs',
    noRules: 'Este pool aún no tiene reglas.', noHistory: 'Aún no hay ejecuciones.',
    executed: 'ejecutada', scheduled: 'programada', manual: 'manual', succeeded: 'exitosas',
    minFrequency: 'La frecuencia mínima es de 10 minutos por la restricción de Stock API.',
    createdBy: 'Creada por', updatedBy: 'Modificada por', failureReason: 'Motivo del fallo',
    successfulItems: 'Items exitosos', failedItems: 'Items fallidos', result: 'Resultado', finished: 'Finalizada',
    endHelp: 'Opcional. Al llegar esta fecha la regla se desactiva y deja de programar ejecuciones.',
    poolPaused: 'Pool desactivado: todas las ejecuciones automáticas futuras están pausadas. Las ejecuciones que ya están corriendo continúan, “Ejecutar ahora” sigue disponible y el stock ya actualizado no se revierte.',
    pausedByPool: 'Pausada por el pool',
    storedShops: 'tiendas almacenadas para esta marca', useAllShops: 'Usar todas', addStoredShop: 'Agregar tienda almacenada',
  } : {
    title: 'Auto Turn Off Items',
    subtitle: 'Run Stock API with stock 0 by rule, brand, stores and UPCs.',
    newPool: 'New pool', editPool: 'Edit pool', poolName: 'Pool name', country: 'Country',
    webhook: 'Webhook (optional)', noWebhook: 'No webhook', active: 'Active', inactive: 'Inactive',
    noPools: 'No pools configured.', rules: 'rules', addRule: 'Add rule',
    editRule: 'Edit rule', newRule: 'New rule', ruleName: 'Rule name', brand: 'Brand',
    shops: 'Target shop_id values', upcs: 'UPCs', frequency: 'Frequency',
    endpoint: 'Stock API version', asyncEndpoint: 'setStock (asynchronous)', syncEndpoint: 'setstockSync (synchronous)',
    shopHelp: 'Enter one DiDi shop_id per line or comma-separated. It must contain 19 digits and start with 57.',
    frequencyHelp: 'setStock requires at least 10 minutes; setstockSync allows intervals from 1 minute.',
    syncLimit: 'setstockSync accepts a maximum of 2,000 UPCs per rule.',
    startsAt: 'Start turning off', endsAt: 'Stop automatically', noEnd: 'No end date', status: 'Status', queued: 'Queued', runningStatus: 'Running', scheduledStatus: 'Scheduled',
    failedStatus: 'Failed', cancelledStatus: 'Cancelled', stop: 'Stop', stopping: 'Stopping…',
    partialStatus: 'Partial success', shopResults: 'Store results', hideShopResults: 'Hide stores',
    every: 'Every', minutes: 'minutes', hours: 'hours', days: 'days',
    selectBrand: 'Select a brand', selectAll: 'Select all', clear: 'Clear',
    searchShop: 'Search store…', noShops: 'No stores found for this brand.',
    upcHelp: 'One per line or comma-separated. Every item is sent with stock 0.',
    save: 'Save', cancel: 'Cancel', run: 'Run now', running: 'Queueing…',
    history: 'History', hide: 'Hide', edit: 'Edit', remove: 'Delete',
    next: 'Next', last: 'Last', never: 'Never', stores: 'stores', items: 'UPCs',
    noRules: 'This pool has no rules yet.', noHistory: 'No executions yet.',
    executed: 'executed', scheduled: 'scheduled', manual: 'manual', succeeded: 'succeeded',
    minFrequency: 'Minimum frequency is 10 minutes due to the Stock API restriction.',
    createdBy: 'Created by', updatedBy: 'Modified by', failureReason: 'Failure reason',
    successfulItems: 'Successful items', failedItems: 'Failed items', result: 'Result', finished: 'Finished',
    endHelp: 'Optional. The rule is deactivated and no longer scheduled when this date is reached.',
    poolPaused: 'Pool disabled: all future automatic runs are paused. Already running executions continue, “Run now” remains available, and previously updated stock is not reverted.',
    pausedByPool: 'Paused by pool',
    storedShops: 'stores stored for this brand', useAllShops: 'Use all', addStoredShop: 'Add stored shop',
  };

  const { data: pools = [], isLoading } = useQuery<AutoTurnOffPool[]>({
    queryKey: ['auto-turn-off-pools'],
    queryFn: () => autoTurnOffApi.listPools().then(response => response.data as AutoTurnOffPool[]),
    refetchInterval: 5000,
  });
  const { data: webhooks = [] } = useQuery<Webhook[]>({
    queryKey: ['webhooks'],
    queryFn: () => webhooksApi.list().then(response => response.data as Webhook[]),
    enabled: poolModal,
  });
  const { data: brandsResult } = useQuery<{ data: Brand[] }>({
    queryKey: ['brands', 'auto-turn-off'],
    queryFn: () => brandsApi.list({ limit: 5000 }).then(response => response.data as { data: Brand[] }),
    enabled: ruleModal,
  });
  const { data: brandShopsResult, isLoading: loadingBrandShops } = useQuery<Paginated<Shop>>({
    queryKey: ['shops', 'auto-turn-off', ruleForm.brandId],
    queryFn: () => shopsApi.list({ brandId: ruleForm.brandId, limit: 10000 })
      .then(response => response.data as Paginated<Shop>),
    enabled: ruleModal && !!ruleForm.brandId,
  });
  const { data: historyResult } = useQuery<{ data: AutoTurnOffExecution[] }>({
    queryKey: ['auto-turn-off-executions', historyPoolId],
    queryFn: () => autoTurnOffApi.listExecutions(historyPoolId!).then(response => response.data as { data: AutoTurnOffExecution[] }),
    enabled: !!historyPoolId,
    refetchInterval: historyPoolId ? 5000 : false,
  });
  const { data: shopResults, isLoading: loadingShopResults } = useQuery<{
    data: AutoTurnOffShopExecution[]; total: number; page: number; limit: number; requestedUpcs: string[];
  }>({
    queryKey: ['auto-turn-off-execution-shops', shopResultsExecutionId, shopResultsPage],
    queryFn: () => autoTurnOffApi.listExecutionShops(shopResultsExecutionId!, shopResultsPage)
      .then(response => response.data as {
        data: AutoTurnOffShopExecution[]; total: number; page: number; limit: number; requestedUpcs: string[];
      }),
    enabled: !!shopResultsExecutionId,
    refetchInterval: shopResultsExecutionId ? 5000 : false,
  });

  const brands = brandsResult?.data ?? [];
  const brandShops = brandShopsResult?.data ?? [];
  const normalizedShopSearch = shopSearch.trim().toLowerCase();
  const filteredBrandShops = brandShops
    .filter(shop => !normalizedShopSearch
      || shop.shopId.toLowerCase().includes(normalizedShopSearch)
      || shop.appShopId.toLowerCase().includes(normalizedShopSearch)
      || (shop.city ?? '').toLowerCase().includes(normalizedShopSearch))
    .slice(0, 100);

  const refreshPools = () => qc.invalidateQueries({ queryKey: ['auto-turn-off-pools'] });

  const toggleShopResults = (executionId: string) => {
    setShopResultsPage(1);
    setShopResultsExecutionId(current => current === executionId ? null : executionId);
  };

  const openNewPool = () => {
    setEditingPool(null); setPoolForm(emptyPool); setError(''); setPoolModal(true);
  };
  const openEditPool = (pool: AutoTurnOffPool) => {
    setEditingPool(pool);
    setPoolForm({ name: pool.name, country: pool.country, webhookId: pool.webhookId ?? '', active: pool.active });
    setError(''); setPoolModal(true);
  };
  const openNewRule = (poolId: string) => {
    setRulePoolId(poolId); setEditingRule(null); setRuleForm(newRuleForm()); setShopSearch(''); setError(''); setRuleModal(true);
  };
  const openEditRule = (rule: AutoTurnOffRule) => {
    setRulePoolId(rule.poolId); setEditingRule(rule);
    setRuleForm({
      name: rule.name,
      brandId: rule.brandId,
      shopIds: rule.shopIds.join('\n'),
      upcs: rule.upcs.join('\n'),
      stockEndpoint: rule.stockEndpoint,
      ...fromMinutes(rule.intervalMinutes),
      startsAt: toLocalDateTimeInput(rule.startsAt),
      endsAt: rule.endsAt ? toLocalDateTimeInput(rule.endsAt) : '',
      active: rule.active,
    });
    setShopSearch('');
    setError(''); setRuleModal(true);
  };

  const addStoredShop = (shopId: string) => {
    if (!shopId) return;
    setRuleForm(current => ({
      ...current,
      shopIds: [...new Set([...parseShopIds(current.shopIds), shopId])].join('\n'),
    }));
  };

  const savePool = async () => {
    if (!poolForm.name.trim()) return setError(`${copy.poolName} is required`);
    setSaving(true); setError('');
    try {
      const payload = { name: poolForm.name.trim(), country: poolForm.country, active: poolForm.active, webhookId: poolForm.webhookId || null };
      if (editingPool) await autoTurnOffApi.updatePool(editingPool.id, payload);
      else await autoTurnOffApi.createPool(payload);
      await refreshPools(); setPoolModal(false);
    } catch (err) { setError(errorMessage(err)); } finally { setSaving(false); }
  };

  const saveRule = async () => {
    const intervalMinutes = toMinutes(ruleForm.frequency, ruleForm.unit);
    const shopIds = parseShopIds(ruleForm.shopIds);
    const upcs = parseUpcs(ruleForm.upcs);
    if (!ruleForm.name.trim() || !ruleForm.brandId || shopIds.length === 0 || upcs.length === 0 || !ruleForm.startsAt) {
      return setError(es ? 'Completa nombre, marca, tiendas y UPCs.' : 'Complete name, brand, stores and UPCs.');
    }
    const minimumMinutes = ruleForm.stockEndpoint === 'setStock' ? 10 : 1;
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < minimumMinutes) return setError(copy.frequencyHelp);
    if (ruleForm.stockEndpoint === 'setstockSync' && upcs.length > 2000) return setError(copy.syncLimit);
    if (ruleForm.endsAt && new Date(ruleForm.endsAt) <= new Date(ruleForm.startsAt)) {
      return setError(es ? 'La fecha de término debe ser posterior al inicio.' : 'End date must be later than start date.');
    }
    setSaving(true); setError('');
    try {
      const payload = {
        name: ruleForm.name.trim(), brandId: ruleForm.brandId, shopIds,
        upcs, stockEndpoint: ruleForm.stockEndpoint, intervalMinutes,
        startsAt: new Date(ruleForm.startsAt).toISOString(),
        endsAt: ruleForm.endsAt ? new Date(ruleForm.endsAt).toISOString() : null,
        active: ruleForm.active,
      };
      if (editingRule) await autoTurnOffApi.updateRule(editingRule.id, payload);
      else await autoTurnOffApi.createRule(rulePoolId, payload);
      await refreshPools(); setRuleModal(false);
    } catch (err) { setError(errorMessage(err)); } finally { setSaving(false); }
  };

  const togglePool = async (pool: AutoTurnOffPool) => {
    await autoTurnOffApi.updatePool(pool.id, { active: !pool.active }); await refreshPools();
  };
  const toggleRule = async (rule: AutoTurnOffRule) => {
    await autoTurnOffApi.updateRule(rule.id, { active: !rule.active }); await refreshPools();
  };
  const removePool = async (pool: AutoTurnOffPool) => {
    if (!window.confirm(`${copy.remove} ${pool.name}?`)) return;
    await autoTurnOffApi.deletePool(pool.id); await refreshPools();
  };
  const removeRule = async (rule: AutoTurnOffRule) => {
    if (!window.confirm(`${copy.remove} ${rule.name}?`)) return;
    await autoTurnOffApi.deleteRule(rule.id); await refreshPools();
  };
  const runRule = async (rule: AutoTurnOffRule) => {
    setRunningId(rule.id);
    try {
      await autoTurnOffApi.runRule(rule.id);
      setHistoryPoolId(rule.poolId);
      await qc.invalidateQueries({ queryKey: ['auto-turn-off-executions', rule.poolId] });
    } catch (err) { setError(errorMessage(err)); } finally { setRunningId(null); }
  };
  const stopRule = async (rule: AutoTurnOffRule) => {
    setStoppingId(rule.id); setError('');
    try {
      await autoTurnOffApi.stopRule(rule.id);
      await Promise.all([
        refreshPools(),
        qc.invalidateQueries({ queryKey: ['auto-turn-off-executions', rule.poolId] }),
      ]);
    } catch (err) { setError(errorMessage(err)); } finally { setStoppingId(null); }
  };

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.integrations') }, { label: copy.title }]} />
      <main className="main-content">
        <div className="page-header">
          <div className="page-header-info">
            <h1>{copy.title}</h1>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.84rem', marginTop: 4 }}>{copy.subtitle}</p>
          </div>
          <button className="btn btn-primary" onClick={openNewPool}>+ {copy.newPool}</button>
        </div>

        <div style={{ background: 'var(--orange-muted)', color: 'var(--text-secondary)', borderRadius: 8, padding: '10px 14px', fontSize: '0.8rem', marginBottom: 18 }}>
          {copy.frequencyHelp}
        </div>
        {error && !poolModal && !ruleModal && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}

        {isLoading && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {pools.map(pool => (
            <section key={pool.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '16px 20px', display: 'flex', gap: 12, alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
                <button onClick={() => togglePool(pool)} style={pill(pool.active)}>
                  {pool.active ? copy.active : copy.inactive}
                </button>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>{pool.name}</div>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 2 }}>
                    {pool.country} · {pool.rules.length} {copy.rules}{pool.webhook ? ` · ${pool.webhook.name}` : ''}
                  </div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => setHistoryPoolId(historyPoolId === pool.id ? null : pool.id)}>
                  {historyPoolId === pool.id ? copy.hide : copy.history}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => openEditPool(pool)}>{copy.edit}</button>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => removePool(pool)}>{copy.remove}</button>
                <button className="btn btn-primary btn-sm" onClick={() => openNewRule(pool.id)}>+ {copy.addRule}</button>
              </div>

              {!pool.active && (
                <div style={{ margin: '12px 16px 0', padding: '10px 12px', borderRadius: 8, background: '#FFF7ED', border: '1px solid #FED7AA', color: '#9A3412', fontSize: '0.76rem', lineHeight: 1.45 }}>
                  <strong>{copy.pausedByPool}.</strong> {copy.poolPaused}
                </div>
              )}

              <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {pool.rules.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: 4 }}>{copy.noRules}</p>}
                {pool.rules.map(rule => (
                  <div key={rule.id} style={{ border: '1px solid var(--border)', borderRadius: 9, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button onClick={() => toggleRule(rule)} style={pill(rule.active)}>
                      {rule.active ? copy.active : copy.inactive}
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: '0.88rem' }}>{rule.name}</strong>
                        <span style={tag}>{rule.brand.brandName}</span>
                        <span style={tag}>{rule.shopIds.length} {copy.stores}</span>
                        <span style={tag}>{rule.upcs.length} {copy.items}</span>
                        <span style={tag}>{rule.stockEndpoint}</span>
                        <span style={{ ...tag, color: 'var(--orange)' }}>{copy.every} {formatFrequency(rule.intervalMinutes, es)}</span>
                        <span style={{ ...tag, color: !pool.active && !['running', 'pending'].includes(rule.executions?.[0]?.status ?? '') ? '#B54708' : rule.executions?.[0] ? statusColor[rule.executions[0].status] : rule.active ? '#027A48' : '#667085' }}>
                          {copy.status}: {!pool.active && !['running', 'pending'].includes(rule.executions?.[0]?.status ?? '') ? copy.pausedByPool : rule.executions?.[0] ? executionStatusLabel(rule.executions[0].status, es) : rule.active ? copy.scheduledStatus : copy.inactive}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 6 }}>
                        {copy.startsAt}: {new Date(rule.startsAt).toLocaleString()} · {copy.endsAt}: {rule.endsAt ? new Date(rule.endsAt).toLocaleString() : copy.noEnd} · {copy.next}: {new Date(rule.nextRunAt).toLocaleString()} · {copy.last}: {rule.lastRunAt ? new Date(rule.lastRunAt).toLocaleString() : copy.never}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>
                        {copy.createdBy}: {rule.createdBy?.name ?? rule.createdBy?.email ?? '—'} ({new Date(rule.createdAt).toLocaleString()}) · {copy.updatedBy}: {rule.updatedBy?.name ?? rule.updatedBy?.email ?? '—'} ({new Date(rule.updatedAt).toLocaleString()})
                      </div>
                      {(rule.executions?.[0]?.status === 'running' || rule.executions?.[0]?.status === 'pending') && <Progress execution={rule.executions[0]} es={es} />}
                      {rule.executions?.[0]?.errorMessage && (rule.executions[0].status === 'partial_success' || rule.executions[0].status === 'failed' || rule.executions[0].status === 'cancelled') && (
                        <div style={{ color: rule.executions[0].status === 'partial_success' ? '#B54708' : 'var(--red)', fontSize: '0.72rem', marginTop: 6 }}>
                          {copy.failureReason}: {rule.executions[0].errorMessage}
                        </div>
                      )}
                    </div>
                    <button className="btn btn-primary btn-sm" disabled={runningId === rule.id || rule.executions?.[0]?.status === 'running' || rule.executions?.[0]?.status === 'pending'} onClick={() => runRule(rule)}>
                      {runningId === rule.id ? copy.running : copy.run}
                    </button>
                    {(rule.executions?.[0]?.status === 'running' || rule.executions?.[0]?.status === 'pending') && (
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} disabled={stoppingId === rule.id} onClick={() => stopRule(rule)}>
                        {stoppingId === rule.id ? copy.stopping : copy.stop}
                      </button>
                    )}
                    <button className="btn btn-ghost btn-sm" onClick={() => openEditRule(rule)}>{copy.edit}</button>
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => removeRule(rule)}>{copy.remove}</button>
                  </div>
                ))}
              </div>

              {historyPoolId === pool.id && (
                <div style={{ borderTop: '1px solid var(--border)', padding: '14px 20px' }}>
                  <div style={{ fontWeight: 700, fontSize: '0.78rem', marginBottom: 10 }}>{copy.history}</div>
                  {(historyResult?.data ?? []).length === 0 ? (
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{copy.noHistory}</p>
                  ) : (historyResult?.data ?? []).map(execution => (
                    <div key={execution.id} style={{ fontSize: '0.78rem', padding: '9px 0', borderTop: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <strong>{execution.rule.name}</strong>
                        <span style={{ color: 'var(--text-muted)' }}>{execution.rule.brand.brandName}</span>
                        <span style={{ color: statusColor[execution.status], fontWeight: 700 }}>{executionStatusLabel(execution.status, es)}</span>
                        <span>{execution.shopsSucceeded}/{execution.totalShops} {copy.succeeded}</span>
                        <span>{execution.itemsTurnedOff} {copy.items}</span>
                        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>{copy[execution.trigger]} · {new Date(execution.createdAt).toLocaleString()}</span>
                        <button className="btn btn-ghost btn-sm" onClick={() => toggleShopResults(execution.id)}>
                          {shopResultsExecutionId === execution.id ? copy.hideShopResults : copy.shopResults}
                        </button>
                      </div>
                      {(execution.status === 'running' || execution.status === 'pending') && <Progress execution={execution} es={es} />}
                      {execution.errorMessage && (
                        <div style={{ color: execution.status === 'failed' ? 'var(--red)' : '#B54708', fontSize: '0.72rem', marginTop: 6 }}>
                          {copy.failureReason}: {execution.errorMessage}
                        </div>
                      )}
                      {(execution.logs?.shops ?? []).filter(shop => shop.error).slice(0, 3).map(shop => (
                        <div key={`${execution.id}-${shop.shopId}`} style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginTop: 3 }}>
                          {shop.shopId}: {shop.error}
                        </div>
                      ))}
                      {shopResultsExecutionId === execution.id && (
                        <ShopResultsPanel
                          result={shopResults}
                          loading={loadingShopResults}
                          page={shopResultsPage}
                          setPage={setShopResultsPage}
                          es={es}
                          copy={copy}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
        {!isLoading && pools.length === 0 && <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>{copy.noPools}</div>}
      </main>

      {poolModal && (
        <Modal title={editingPool ? copy.editPool : copy.newPool} onClose={() => setPoolModal(false)} footer={(
          <><button className="btn btn-ghost" onClick={() => setPoolModal(false)}>{copy.cancel}</button><button className="btn btn-primary" disabled={saving} onClick={savePool}>{copy.save}</button></>
        )}>
          <div className="modal-body">
            {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
            <div className="form-group"><label className="form-label">{copy.poolName}</label><input className="form-input" value={poolForm.name} onChange={event => setPoolForm({ ...poolForm, name: event.target.value })} /></div>
            <div className="form-group"><label className="form-label">{copy.country}</label><select className="form-input" value={poolForm.country} disabled={!!editingPool} onChange={event => setPoolForm({ ...poolForm, country: event.target.value as PoolForm['country'] })}><option value="MX">México</option><option value="CO">Colombia</option><option value="CR">Costa Rica</option></select></div>
            <div className="form-group"><label className="form-label">{copy.webhook}</label><select className="form-input" value={poolForm.webhookId} onChange={event => setPoolForm({ ...poolForm, webhookId: event.target.value })}><option value="">{copy.noWebhook}</option>{webhooks.map(webhook => <option key={webhook.id} value={webhook.id}>{webhook.name}</option>)}</select></div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.84rem' }}><input type="checkbox" checked={poolForm.active} onChange={event => setPoolForm({ ...poolForm, active: event.target.checked })} />{copy.active}</label>
          </div>
        </Modal>
      )}

      {ruleModal && (
        <Modal title={editingRule ? copy.editRule : copy.newRule} onClose={() => setRuleModal(false)} footer={(
          <><button className="btn btn-ghost" onClick={() => setRuleModal(false)}>{copy.cancel}</button><button className="btn btn-primary" disabled={saving} onClick={saveRule}>{copy.save}</button></>
        )}>
          <div className="modal-body">
            {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
            <div className="form-group"><label className="form-label">{copy.ruleName}</label><input className="form-input" value={ruleForm.name} onChange={event => setRuleForm({ ...ruleForm, name: event.target.value })} /></div>
            <div className="form-group"><label className="form-label">{copy.brand}</label><select className="form-input" value={ruleForm.brandId} onChange={event => { setRuleForm({ ...ruleForm, brandId: event.target.value, shopIds: '' }); setShopSearch(''); }}><option value="">{copy.selectBrand}</option>{brands.filter(brand => brand.country === pools.find(pool => pool.id === rulePoolId)?.country).map(brand => <option key={brand.id} value={brand.id}>{brand.brandName} ({brand.brandId})</option>)}</select></div>
            <div className="form-group">
              <label className="form-label">{copy.endpoint}</label>
              <select className="form-input" value={ruleForm.stockEndpoint} onChange={event => setRuleForm({ ...ruleForm, stockEndpoint: event.target.value as StockEndpoint })}>
                <option value="setStock">{copy.asyncEndpoint}</option>
                <option value="setstockSync">{copy.syncEndpoint}</option>
              </select>
            </div>
            <div className="form-group"><label className="form-label">{copy.startsAt}</label><input className="form-input" type="datetime-local" value={ruleForm.startsAt} onChange={event => setRuleForm({ ...ruleForm, startsAt: event.target.value })} /></div>
            <div className="form-group"><label className="form-label">{copy.endsAt}</label><input className="form-input" type="datetime-local" value={ruleForm.endsAt} onChange={event => setRuleForm({ ...ruleForm, endsAt: event.target.value })} /><small style={{ color: 'var(--text-muted)' }}>{copy.endHelp}</small></div>
            <div className="form-group">
              <label className="form-label">{copy.frequency}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span>{copy.every}</span><input className="form-input" style={{ width: 110 }} type="number" min="1" value={ruleForm.frequency} onChange={event => setRuleForm({ ...ruleForm, frequency: Number(event.target.value) })} /><select className="form-input" value={ruleForm.unit} onChange={event => setRuleForm({ ...ruleForm, unit: event.target.value as FrequencyUnit })}><option value="minutes">{copy.minutes}</option><option value="hours">{copy.hours}</option><option value="days">{copy.days}</option></select></div>
              <small style={{ color: 'var(--text-muted)' }}>{copy.frequencyHelp}</small>
            </div>
            <div className="form-group">
              <label className="form-label">{copy.shops} ({parseShopIds(ruleForm.shopIds).length})</label>
              {!!ruleForm.brandId && (
                <div style={{ border: '1px solid var(--border)', background: 'var(--surface-2)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: brandShops.length > 0 ? 8 : 0 }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.76rem', flex: 1 }}>
                      {loadingBrandShops ? 'Loading…' : `${brandShops.length} ${copy.storedShops}`}
                    </span>
                    {brandShops.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRuleForm(current => ({ ...current, shopIds: brandShops.map(shop => shop.shopId).join('\n') }))}>{copy.useAllShops}</button>}
                  </div>
                  {brandShops.length > 0 && (
                    <>
                      <input className="form-input" style={{ marginBottom: 6 }} value={shopSearch} onChange={event => setShopSearch(event.target.value)} placeholder={copy.searchShop} />
                      <select className="form-input" value="" onChange={event => addStoredShop(event.target.value)}>
                        <option value="">{copy.addStoredShop}</option>
                        {filteredBrandShops.map(shop => <option key={shop.id} value={shop.shopId}>{shop.shopId} · {shop.appShopId}{shop.city ? ` · ${shop.city}` : ''}</option>)}
                      </select>
                    </>
                  )}
                </div>
              )}
              <textarea className="form-input" rows={5} value={ruleForm.shopIds} onChange={event => setRuleForm({ ...ruleForm, shopIds: event.target.value })} placeholder={'5764607795237028465\n5764607795237028466'} />
              <small style={{ color: 'var(--text-muted)' }}>{copy.shopHelp}</small>
            </div>
            <div className="form-group"><label className="form-label">{copy.upcs} ({parseUpcs(ruleForm.upcs).length})</label><textarea className="form-input" rows={6} value={ruleForm.upcs} onChange={event => setRuleForm({ ...ruleForm, upcs: event.target.value })} placeholder={'750100000001\n750100000002'} /><small style={{ color: 'var(--text-muted)' }}>{copy.upcHelp}</small></div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.84rem' }}><input type="checkbox" checked={ruleForm.active} onChange={event => setRuleForm({ ...ruleForm, active: event.target.checked })} />{copy.active}</label>
          </div>
        </Modal>
      )}
    </>
  );
}

const tag = { fontSize: '0.7rem', background: 'var(--surface-2)', color: 'var(--text-muted)', padding: '2px 7px', borderRadius: 999 } as const;
const pill = (active: boolean) => ({
  fontSize: '0.67rem', fontWeight: 700, padding: '3px 8px', borderRadius: 999, border: 'none', cursor: 'pointer',
  background: active ? 'var(--green-bg)' : 'var(--surface-2)', color: active ? '#027A48' : 'var(--text-muted)',
} as const);

function Progress({ execution, es }: {
  execution: Pick<AutoTurnOffExecution, 'currentStep' | 'progressPercent' | 'progressCurrent' | 'progressTotal' | 'status'>;
  es: boolean;
}) {
  const percent = Math.min(100, Math.max(0, execution.progressPercent ?? 0));
  return (
    <div style={{ marginTop: 7 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '0.7rem', marginBottom: 4 }}>
        <span>{progressStep(execution.currentStep, es)}</span>
        <span>{percent}% ({execution.progressCurrent ?? 0}/{execution.progressTotal ?? 0})</span>
      </div>
      <div className="auto-turn-off-progress">
        <div className={execution.status === 'running' ? 'is-running' : ''} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function ShopResultsPanel({ result, loading, page, setPage, es, copy }: {
  result?: {
    data: AutoTurnOffShopExecution[];
    total: number;
    page: number;
    limit: number;
    requestedUpcs: string[];
  };
  loading: boolean;
  page: number;
  setPage: Dispatch<SetStateAction<number>>;
  es: boolean;
  copy: {
    shopResults: string;
    status: string;
    successfulItems: string;
    failedItems: string;
    result: string;
    finished: string;
  };
}) {
  const totalPages = Math.max(1, Math.ceil((result?.total ?? 0) / (result?.limit ?? 50)));
  return (
    <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '8px 10px', background: 'var(--surface-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: '0.74rem' }}>{copy.shopResults} ({result?.total ?? 0})</strong>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>{es ? 'Página' : 'Page'} {page}/{totalPages}</span>
      </div>
      {loading && !result ? (
        <div style={{ padding: 12, color: 'var(--text-muted)' }}>{es ? 'Cargando…' : 'Loading…'}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)', textAlign: 'left', background: 'var(--surface)' }}>
                <th style={shopCell}>shop_id</th>
                <th style={shopCell}>app_shop_id</th>
                <th style={shopCell}>{copy.status}</th>
                <th style={shopCell}>{copy.successfulItems}</th>
                <th style={shopCell}>{copy.failedItems}</th>
                <th style={shopCell}>{copy.result}</th>
                <th style={shopCell}>{copy.finished}</th>
              </tr>
            </thead>
            <tbody>
              {(result?.data ?? []).map(shop => {
                const detail = shopResultDetail(shop, es);
                const failedItems = shopFailedItems(shop, result?.requestedUpcs ?? []);
                return (
                  <tr key={shop.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={shopCell}>{shop.shopId}</td>
                    <td style={shopCell}>{shop.appShopId ?? '—'}</td>
                    <td style={{ ...shopCell, color: statusColor[shop.status], fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {executionStatusLabel(shop.status, es)}
                    </td>
                    <td style={{ ...shopCell, color: '#027A48', textAlign: 'center' }}>{shop.itemsSucceeded}</td>
                    <td style={{ ...shopCell, color: shop.itemsFailed > 0 ? 'var(--red)' : 'var(--text-muted)', textAlign: 'center' }}>{shop.itemsFailed}</td>
                    <td style={{ ...shopCell, maxWidth: 460 }}>
                      <div title={detail}>{detail}</div>
                      {failedItems.length > 0 && (
                        <details style={{ marginTop: 6 }}>
                          <summary style={{ color: 'var(--red)', cursor: 'pointer', fontWeight: 700 }}>
                            {es ? 'Ver items fallidos' : 'View failed items'} ({failedItems.length})
                          </summary>
                          <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                            {failedItems.map((item, index) => (
                              <div key={`${shop.id}-${item.id}-${index}`} style={{ background: '#FFF4F2', borderRadius: 5, padding: '5px 7px' }}>
                                <strong>{item.kind}: {item.id}</strong>
                                <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{item.reason}</div>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </td>
                    <td style={{ ...shopCell, whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                      {shop.finishedAt ? new Date(shop.finishedAt).toLocaleString() : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ padding: 8, display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: '1px solid var(--border)' }}>
        <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))}>
          {es ? 'Anterior' : 'Previous'}
        </button>
        <button className="btn btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setPage(current => Math.min(totalPages, current + 1))}>
          {es ? 'Siguiente' : 'Next'}
        </button>
      </div>
    </div>
  );
}

function shopResultDetail(shop: AutoTurnOffShopExecution, es: boolean) {
  const value = shop.result;
  if (value?.error) return value.error;
  if (value?.missingUpcs?.length) {
    return `${value.missingUpcs.length} UPC(s) ${es ? 'no encontrados' : 'not found'}: ${value.missingUpcs.slice(0, 5).join(', ')}`;
  }
  if (value?.failedItems?.length) {
    return value.failedItems.slice(0, 5).map(item => `${item.appItemId}: ${item.reason}`).join('; ');
  }
  if (shop.status === 'done') return es ? 'Todos los items fueron apagados' : 'All items were turned off';
  return progressStep(shop.currentStep, es);
}

function shopFailedItems(shop: AutoTurnOffShopExecution, requestedUpcs: string[]) {
  const explicit = shop.result?.failedItems ?? [];
  if (explicit.length > 0) {
    return explicit.map(item => ({
      kind: item.upc ? 'UPC' : 'app_item_id',
      id: item.upc ?? item.appItemId ?? '—',
      reason: item.reason,
    }));
  }
  if (shop.itemsFailed <= 0) return [];
  const reason = shop.result?.error ?? 'Store execution failed';
  return requestedUpcs.map(upc => ({ kind: 'UPC', id: upc, reason }));
}

const shopCell = { padding: '8px 10px', fontSize: '0.7rem', verticalAlign: 'top' } as const;
