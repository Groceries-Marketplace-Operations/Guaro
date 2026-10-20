import { useState, type Dispatch, type SetStateAction } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import Modal from '../../components/ui/Modal';
import { autoTurnOffApi, brandsApi, shopsApi, webhooksApi } from '../../api';
import { intlLocaleForLang, useLang, useT } from '../../i18n';
import type { Lang } from '../../i18n';
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
type ScheduleMode = 'interval' | 'daily_times';

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
  stockValue: number;
  scheduleMode: ScheduleMode;
  frequency: number;
  unit: FrequencyUnit;
  executionTimes: string[];
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
    name: '', brandId: '', shopIds: '', upcs: '', stockEndpoint: 'setStock', stockValue: 0, frequency: 10,
    scheduleMode: 'interval', unit: 'minutes', executionTimes: ['09:00'],
    startsAt: defaultStartsAt(), endsAt: '', active: true,
  };
}

const statusColor: Record<string, string> = {
  pending: 'var(--text-muted)', running: 'var(--orange)', done: 'var(--green-text)', partial_success: 'var(--amber-text)', failed: 'var(--red-text)', cancelled: 'var(--text-muted)',
};

function languageIndex(lang: Lang) {
  return lang === 'es' ? 0 : lang === 'zh-CN' ? 2 : 1;
}

function executionStatusLabel(status: string, lang: Lang) {
  const labels: Record<string, [string, string, string]> = {
    pending: ['En cola', 'Queued', '排队中'],
    running: ['Ejecutando', 'Running', '执行中'],
    done: ['Exitosa', 'Successful', '成功'],
    partial_success: ['Éxito parcial', 'Partial success', '部分成功'],
    failed: ['Fallida', 'Failed', '失败'],
    cancelled: ['Cancelada', 'Cancelled', '已取消'],
  };
  return (labels[status] ?? [status, status, status])[languageIndex(lang)];
}

function errorMessage(error: unknown, lang: Lang) {
  const message = (error as ApiError).response?.data?.message;
  const fallback = lang === 'es' ? 'Error inesperado' : lang === 'zh-CN' ? '发生意外错误' : 'Unexpected error';
  return Array.isArray(message) ? message.join(', ') : (message ?? fallback);
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

function formatFrequency(minutes: number, lang: Lang) {
  if (minutes % 1440 === 0) return `${minutes / 1440} ${lang === 'es' ? 'día(s)' : lang === 'zh-CN' ? '天' : 'day(s)'}`;
  if (minutes % 60 === 0) return `${minutes / 60} ${lang === 'es' ? 'hora(s)' : lang === 'zh-CN' ? '小时' : 'hour(s)'}`;
  return `${minutes} min`;
}

function formatRuleSchedule(rule: AutoTurnOffRule, lang: Lang) {
  if (rule.scheduleMode === 'daily_times') {
    return `${lang === 'es' ? 'A las' : lang === 'zh-CN' ? '每天' : 'At'} ${rule.executionTimes.join(', ')}`;
  }
  return `${lang === 'es' ? 'Cada' : lang === 'zh-CN' ? '每' : 'Every'} ${formatFrequency(rule.intervalMinutes, lang)}`;
}

function progressStep(step: string | undefined, lang: Lang) {
  const key = step?.split(':')[0] ?? 'queued';
  const labels: Record<string, [string, string, string]> = {
    queued: ['En cola', 'Queued', '排队中'],
    queued_local: ['En cola con datos locales', 'Queued with local data', '使用本地数据排队中'],
    queued_resolved: ['Tienda resuelta; en cola', 'Store resolved; queued', '店铺已解析；排队中'],
    preparing: ['Preparando ejecución', 'Preparing execution', '正在准备执行'],
    resolving_shops: ['Resolviendo tiendas', 'Resolving stores', '正在解析店铺'],
    resolving_deferred_shops: ['Resolviendo tiendas pendientes', 'Resolving deferred stores', '正在解析延后处理的店铺'],
    processing_shops: ['Procesando tiendas', 'Processing stores', '正在处理店铺'],
    processing_local_data: ['Procesando datos locales', 'Processing local data', '正在处理本地数据'],
    authenticating: ['Autenticando tienda', 'Authenticating store', '正在验证店铺身份'],
    authenticating_local: ['Autenticando para datos locales', 'Authenticating for local data', '正在为本地数据进行身份验证'],
    waiting_shop_resolution: ['Pendiente al final: resolver tienda', 'Deferred: resolve store', '已延后：解析店铺'],
    waiting_menu_download: ['UPC faltante en catálogo local', 'UPC missing from local catalog', '本地目录中缺少 UPC'],
    matching_upcs: ['Relacionando UPCs', 'Matching UPCs', '正在匹配 UPC'],
    matching_local_upcs: ['Relacionando UPCs locales', 'Matching local UPCs', '正在匹配本地 UPC'],
    updating_stock: ['Actualizando stock', 'Updating stock', '正在更新库存'],
    updating_local_stock: ['Apagando ítems locales', 'Turning off local items', '正在下架本地商品'],
    shop_not_found: ['Tienda no encontrada', 'Store not found', '未找到店铺'],
    shop_failed: ['Falló una tienda', 'A store failed', '某店铺处理失败'],
    shop_partial_success: ['Tienda con éxito parcial', 'Store partially succeeded', '店铺部分处理成功'],
    queue_failed: ['Falló la cola', 'Queue failed', '队列处理失败'],
    upc_not_found: ['UPC no encontrado', 'UPC not found', '未找到 UPC'],
    finalizing: ['Finalizando', 'Finalizing', '正在完成'],
    completed: ['Completada', 'Completed', '已完成'],
    partial_success: ['Éxito parcial', 'Partial success', '部分成功'],
    failed: ['Fallida', 'Failed', '失败'],
    cancelled: ['Cancelada', 'Cancelled', '已取消'],
  };
  return (labels[key] ?? [key, key, key])[languageIndex(lang)];
}

export default function AutoTurnOffItemsPage() {
  const t = useT();
  const { lang } = useLang();
  const es = lang === 'es';
  const zh = lang === 'zh-CN';
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
    subtitle: 'Ejecuta Stock API con un valor de stock configurable por regla, marca, tiendas y UPCs.',
    newPool: 'Nuevo pool', editPool: 'Editar pool', poolName: 'Nombre del pool', country: 'País',
    webhook: 'Webhook (opcional)', noWebhook: 'Sin webhook', active: 'Activo', inactive: 'Inactivo',
    noPools: 'No hay pools configurados.', rules: 'reglas', addRule: 'Agregar regla',
    editRule: 'Editar regla', newRule: 'Nueva regla', ruleName: 'Nombre de la regla', brand: 'Marca',
    shops: 'shop_id objetivo', upcs: 'UPCs', frequency: 'Frecuencia',
    schedule: 'Programación', intervalSchedule: 'Por intervalo', dailySchedule: 'Horas específicas del día',
    dailyTimes: 'Horas diarias', addTime: 'Agregar hora', removeTime: 'Quitar',
    dailyTimesHelp: 'Las horas se interpretan en la zona horaria del país del pool.',
    endpoint: 'Versión de Stock API', asyncEndpoint: 'setStock (asíncrono)', syncEndpoint: 'setstockSync (síncrono)',
    stockValue: 'Valor de stock', stockValueHelp: 'Se enviará este entero a todos los UPCs de la regla. Usa 0 para apagarlos o un valor mayor para establecer disponibilidad.',
    shopHelp: 'Ingresa un shop_id de DiDi por línea o separado por coma. Debe tener 19 dígitos e iniciar con 57.',
    frequencyHelp: 'setStock requiere mínimo 10 minutos; setstockSync permite desde 1 minuto.',
    syncLimit: 'setstockSync permite como máximo 2,000 UPCs por regla.',
    startsAt: 'Iniciar apagado', endsAt: 'Detener automáticamente', noEnd: 'Sin fecha de término', status: 'Estado', queued: 'En cola', runningStatus: 'Ejecutando', scheduledStatus: 'Programada',
    failedStatus: 'Fallida', cancelledStatus: 'Cancelada', stop: 'Detener', stopping: 'Deteniendo…',
    partialStatus: 'Éxito parcial', shopResults: 'Resultado por tienda', hideShopResults: 'Ocultar tiendas',
    every: 'Cada', minutes: 'minutos', hours: 'horas', days: 'días',
    selectBrand: 'Selecciona una marca', selectAll: 'Seleccionar todas', clear: 'Limpiar',
    searchShop: 'Buscar tienda…', noShops: 'No hay tiendas para esta marca.',
    upcHelp: 'Uno por línea o separados por coma. Todos se enviarán con el valor de stock configurado.',
    save: 'Guardar', cancel: 'Cancelar', run: 'Ejecutar ahora', running: 'Encolando…',
    history: 'Historial', hide: 'Ocultar', edit: 'Editar', remove: 'Eliminar',
    next: 'Próxima', last: 'Última', never: 'Nunca', stores: 'tiendas', items: 'UPCs',
    noRules: 'Este pool aún no tiene reglas.', noHistory: 'Aún no hay ejecuciones.',
    executed: 'ejecutada', scheduled: 'programada', manual: 'manual', succeeded: 'exitosas',
    fullShops: 'tiendas completas', partialShops: 'parciales', failedShops: 'fallidas',
    itemUpdates: 'actualizaciones exitosas', itemFailures: 'fallos de item',
    minFrequency: 'La frecuencia mínima es de 10 minutos por la restricción de Stock API.',
    createdBy: 'Creada por', updatedBy: 'Modificada por', failureReason: 'Motivo del fallo',
    successfulItems: 'Items exitosos', failedItems: 'Items fallidos', result: 'Resultado', finished: 'Finalizada',
    endHelp: 'Opcional. Al llegar esta fecha la regla se desactiva y deja de programar ejecuciones.',
    poolPaused: 'Pool desactivado: todas las ejecuciones automáticas futuras están pausadas. Las ejecuciones que ya están corriendo continúan, “Ejecutar ahora” sigue disponible y el stock ya actualizado no se revierte.',
    pausedByPool: 'Pausada por el pool',
    storedShops: 'tiendas almacenadas para esta marca', useAllShops: 'Usar todas', addStoredShop: 'Agregar tienda almacenada',
    required: 'es obligatorio', completeRequired: 'Completa nombre, marca, tiendas y UPCs.',
    addDailyTime: 'Agrega al menos una hora diaria.', timeFormat: 'Las horas deben usar el formato HH:mm.',
    stockRange: 'El valor de stock debe ser un entero entre 0 y 2,147,483,647.', endAfterStart: 'La fecha de término debe ser posterior al inicio.',
    catalogOnly: 'El apagado usa exclusivamente el catálogo local de la marca; si falta un UPC se reporta como fallido y no se descarga el menú.',
    loading: 'Cargando…', page: 'Página', previousPage: 'Anterior', nextPage: 'Siguiente',
    viewSubmittedItems: 'Ver items enviados', viewTurnedOffItems: 'Ver items apagados', unnamedItem: 'Sin nombre',
    asyncPending: 'Solicitud aceptada por setStock; pendiente de confirmación asíncrona.', viewFailedItems: 'Ver items fallidos',
    missingUpcs: 'no encontrados', allItemsTurnedOff: 'Todos los items fueron apagados', storeExecutionFailed: 'Falló la ejecución de la tienda',
    mexico: 'México', colombia: 'Colombia', costaRica: 'Costa Rica',
  } : zh ? {
    title: '自动下架商品',
    subtitle: '按规则、品牌、店铺和 UPC 使用可配置的库存值运行 Stock API。',
    newPool: '新建池', editPool: '编辑池', poolName: '池名称', country: '国家/地区',
    webhook: 'Webhook（可选）', noWebhook: '无 Webhook', active: '已启用', inactive: '未启用',
    noPools: '尚未配置池。', rules: '条规则', addRule: '添加规则',
    editRule: '编辑规则', newRule: '新建规则', ruleName: '规则名称', brand: '品牌',
    shops: '目标 shop_id', upcs: 'UPC', frequency: '频率',
    schedule: '调度', intervalSchedule: '按间隔', dailySchedule: '每日指定时间',
    dailyTimes: '每日时间', addTime: '添加时间', removeTime: '移除',
    dailyTimesHelp: '时间按池所在国家/地区的时区解释。',
    endpoint: 'Stock API 版本', asyncEndpoint: 'setStock（异步）', syncEndpoint: 'setstockSync（同步）',
    stockValue: '库存值', stockValueHelp: '此整数将发送给规则中的每个 UPC。使用 0 下架商品，或使用更大的值设置可用库存。',
    shopHelp: '每行输入一个 DiDi shop_id，或用逗号分隔。shop_id 必须包含 19 位数字且以 57 开头。',
    frequencyHelp: 'setStock 的最小间隔为 10 分钟；setstockSync 允许从 1 分钟开始。',
    syncLimit: 'setstockSync 每条规则最多接受 2,000 个 UPC。',
    startsAt: '开始下架', endsAt: '自动停止', noEnd: '无结束日期', status: '状态', queued: '排队中', runningStatus: '执行中', scheduledStatus: '已调度',
    failedStatus: '失败', cancelledStatus: '已取消', stop: '停止', stopping: '正在停止…',
    partialStatus: '部分成功', shopResults: '店铺结果', hideShopResults: '隐藏店铺',
    every: '每', minutes: '分钟', hours: '小时', days: '天',
    selectBrand: '选择品牌', selectAll: '全选', clear: '清除',
    searchShop: '搜索店铺…', noShops: '未找到该品牌的店铺。',
    upcHelp: '每行输入一个，或用逗号分隔。所有商品都将使用已配置的库存值发送。',
    save: '保存', cancel: '取消', run: '立即运行', running: '正在加入队列…',
    history: '历史记录', hide: '隐藏', edit: '编辑', remove: '删除',
    next: '下次', last: '上次', never: '从未', stores: '家店铺', items: 'UPC',
    noRules: '此池尚无规则。', noHistory: '尚无执行记录。',
    executed: '已执行', scheduled: '已调度', manual: '手动', succeeded: '成功',
    fullShops: '家完全成功的店铺', partialShops: '家部分成功', failedShops: '家失败的店铺',
    itemUpdates: '个商品更新成功', itemFailures: '个商品失败',
    minFrequency: '受 Stock API 限制，最小频率为 10 分钟。',
    createdBy: '创建者', updatedBy: '修改者', failureReason: '失败原因',
    successfulItems: '成功商品', failedItems: '失败商品', result: '结果', finished: '完成时间',
    endHelp: '可选。到达此日期后，规则将被禁用，且不再调度新的执行。',
    poolPaused: '池已禁用：所有未来的自动执行已暂停。正在运行的执行会继续，“立即运行”仍可用，已更新的库存不会回滚。',
    pausedByPool: '已由池暂停',
    storedShops: '家为此品牌存储的店铺', useAllShops: '全部使用', addStoredShop: '添加已存储的店铺',
    required: '为必填项', completeRequired: '请填写名称、品牌、店铺和 UPC。',
    addDailyTime: '请至少添加一个每日时间。', timeFormat: '时间必须使用 HH:mm 格式。',
    stockRange: '库存值必须是 0 到 2,147,483,647 之间的整数。', endAfterStart: '结束日期必须晚于开始日期。',
    catalogOnly: '下架操作仅使用品牌的本地目录；缺失的 UPC 将记为失败，且不会下载菜单。',
    loading: '加载中…', page: '页码', previousPage: '上一页', nextPage: '下一页',
    viewSubmittedItems: '查看已提交的商品', viewTurnedOffItems: '查看已下架的商品', unnamedItem: '未命名商品',
    asyncPending: 'setStock 已接受请求；正在等待异步确认。', viewFailedItems: '查看失败商品',
    missingUpcs: '未找到', allItemsTurnedOff: '所有商品已下架', storeExecutionFailed: '店铺执行失败',
    mexico: '墨西哥', colombia: '哥伦比亚', costaRica: '哥斯达黎加',
  } : {
    title: 'Auto Turn Off Items',
    subtitle: 'Run Stock API with a configurable stock value by rule, brand, stores and UPCs.',
    newPool: 'New pool', editPool: 'Edit pool', poolName: 'Pool name', country: 'Country',
    webhook: 'Webhook (optional)', noWebhook: 'No webhook', active: 'Active', inactive: 'Inactive',
    noPools: 'No pools configured.', rules: 'rules', addRule: 'Add rule',
    editRule: 'Edit rule', newRule: 'New rule', ruleName: 'Rule name', brand: 'Brand',
    shops: 'Target shop_id values', upcs: 'UPCs', frequency: 'Frequency',
    schedule: 'Schedule', intervalSchedule: 'By interval', dailySchedule: 'Specific times of day',
    dailyTimes: 'Daily times', addTime: 'Add time', removeTime: 'Remove',
    dailyTimesHelp: 'Times use the timezone of the pool country.',
    endpoint: 'Stock API version', asyncEndpoint: 'setStock (asynchronous)', syncEndpoint: 'setstockSync (synchronous)',
    stockValue: 'Stock value', stockValueHelp: 'This integer is sent for every UPC in the rule. Use 0 to turn items off or a greater value to set availability.',
    shopHelp: 'Enter one DiDi shop_id per line or comma-separated. It must contain 19 digits and start with 57.',
    frequencyHelp: 'setStock requires at least 10 minutes; setstockSync allows intervals from 1 minute.',
    syncLimit: 'setstockSync accepts a maximum of 2,000 UPCs per rule.',
    startsAt: 'Start turning off', endsAt: 'Stop automatically', noEnd: 'No end date', status: 'Status', queued: 'Queued', runningStatus: 'Running', scheduledStatus: 'Scheduled',
    failedStatus: 'Failed', cancelledStatus: 'Cancelled', stop: 'Stop', stopping: 'Stopping…',
    partialStatus: 'Partial success', shopResults: 'Store results', hideShopResults: 'Hide stores',
    every: 'Every', minutes: 'minutes', hours: 'hours', days: 'days',
    selectBrand: 'Select a brand', selectAll: 'Select all', clear: 'Clear',
    searchShop: 'Search store…', noShops: 'No stores found for this brand.',
    upcHelp: 'One per line or comma-separated. Every item is sent with the configured stock value.',
    save: 'Save', cancel: 'Cancel', run: 'Run now', running: 'Queueing…',
    history: 'History', hide: 'Hide', edit: 'Edit', remove: 'Delete',
    next: 'Next', last: 'Last', never: 'Never', stores: 'stores', items: 'UPCs',
    noRules: 'This pool has no rules yet.', noHistory: 'No executions yet.',
    executed: 'executed', scheduled: 'scheduled', manual: 'manual', succeeded: 'succeeded',
    fullShops: 'fully successful stores', partialShops: 'partial', failedShops: 'failed',
    itemUpdates: 'successful item updates', itemFailures: 'item failures',
    minFrequency: 'Minimum frequency is 10 minutes due to the Stock API restriction.',
    createdBy: 'Created by', updatedBy: 'Modified by', failureReason: 'Failure reason',
    successfulItems: 'Successful items', failedItems: 'Failed items', result: 'Result', finished: 'Finished',
    endHelp: 'Optional. The rule is deactivated and no longer scheduled when this date is reached.',
    poolPaused: 'Pool disabled: all future automatic runs are paused. Already running executions continue, “Run now” remains available, and previously updated stock is not reverted.',
    pausedByPool: 'Paused by pool',
    storedShops: 'stores stored for this brand', useAllShops: 'Use all', addStoredShop: 'Add stored shop',
    required: 'is required', completeRequired: 'Complete name, brand, stores and UPCs.',
    addDailyTime: 'Add at least one daily time.', timeFormat: 'Times must use HH:mm format.',
    stockRange: 'Stock value must be an integer between 0 and 2,147,483,647.', endAfterStart: 'End date must be later than start date.',
    catalogOnly: 'Turn off uses only the local brand catalog; a missing UPC is reported as failed and no menu is downloaded.',
    loading: 'Loading…', page: 'Page', previousPage: 'Previous', nextPage: 'Next',
    viewSubmittedItems: 'View submitted items', viewTurnedOffItems: 'View turned-off items', unnamedItem: 'Unnamed item',
    asyncPending: 'Accepted by setStock; asynchronous confirmation is pending.', viewFailedItems: 'View failed items',
    missingUpcs: 'not found', allItemsTurnedOff: 'All items were turned off', storeExecutionFailed: 'Store execution failed',
    mexico: 'Mexico', colombia: 'Colombia', costaRica: 'Costa Rica',
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
      stockValue: rule.stockValue ?? 0,
      scheduleMode: rule.scheduleMode ?? 'interval',
      executionTimes: rule.executionTimes?.length ? [...rule.executionTimes] : ['09:00'],
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
    if (!poolForm.name.trim()) return setError(`${copy.poolName} ${copy.required}`);
    setSaving(true); setError('');
    try {
      const payload = { name: poolForm.name.trim(), country: poolForm.country, active: poolForm.active, webhookId: poolForm.webhookId || null };
      if (editingPool) await autoTurnOffApi.updatePool(editingPool.id, payload);
      else await autoTurnOffApi.createPool(payload);
      await refreshPools(); setPoolModal(false);
    } catch (err) { setError(errorMessage(err, lang)); } finally { setSaving(false); }
  };

  const saveRule = async () => {
    const intervalMinutes = toMinutes(ruleForm.frequency, ruleForm.unit);
    const executionTimes = [...new Set(ruleForm.executionTimes.map(value => value.trim()).filter(Boolean))].sort();
    const shopIds = parseShopIds(ruleForm.shopIds);
    const upcs = parseUpcs(ruleForm.upcs);
    if (!ruleForm.name.trim() || !ruleForm.brandId || shopIds.length === 0 || upcs.length === 0 || !ruleForm.startsAt) {
      return setError(copy.completeRequired);
    }
    const minimumMinutes = ruleForm.stockEndpoint === 'setStock' ? 10 : 1;
    if (ruleForm.scheduleMode === 'interval'
      && (!Number.isInteger(intervalMinutes) || intervalMinutes < minimumMinutes)) return setError(copy.frequencyHelp);
    if (ruleForm.scheduleMode === 'daily_times' && executionTimes.length === 0) {
      return setError(copy.addDailyTime);
    }
    if (executionTimes.some(value => !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) {
      return setError(copy.timeFormat);
    }
    if (ruleForm.stockEndpoint === 'setstockSync' && upcs.length > 2000) return setError(copy.syncLimit);
    if (!Number.isInteger(ruleForm.stockValue) || ruleForm.stockValue < 0 || ruleForm.stockValue > 2147483647) {
      return setError(copy.stockRange);
    }
    if (ruleForm.endsAt && new Date(ruleForm.endsAt) <= new Date(ruleForm.startsAt)) {
      return setError(copy.endAfterStart);
    }
    setSaving(true); setError('');
    try {
      const payload = {
        name: ruleForm.name.trim(), brandId: ruleForm.brandId, shopIds,
        upcs, stockEndpoint: ruleForm.stockEndpoint, stockValue: ruleForm.stockValue, intervalMinutes,
        scheduleMode: ruleForm.scheduleMode,
        executionTimes: ruleForm.scheduleMode === 'daily_times' ? executionTimes : undefined,
        startsAt: new Date(ruleForm.startsAt).toISOString(),
        endsAt: ruleForm.endsAt ? new Date(ruleForm.endsAt).toISOString() : null,
        active: ruleForm.active,
      };
      if (editingRule) await autoTurnOffApi.updateRule(editingRule.id, payload);
      else await autoTurnOffApi.createRule(rulePoolId, payload);
      await refreshPools(); setRuleModal(false);
    } catch (err) { setError(errorMessage(err, lang)); } finally { setSaving(false); }
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
    } catch (err) { setError(errorMessage(err, lang)); } finally { setRunningId(null); }
  };
  const stopRule = async (rule: AutoTurnOffRule) => {
    setStoppingId(rule.id); setError('');
    try {
      await autoTurnOffApi.stopRule(rule.id);
      await Promise.all([
        refreshPools(),
        qc.invalidateQueries({ queryKey: ['auto-turn-off-executions', rule.poolId] }),
      ]);
    } catch (err) { setError(errorMessage(err, lang)); } finally { setStoppingId(null); }
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
          {copy.frequencyHelp} {copy.catalogOnly}
        </div>
        {error && !poolModal && !ruleModal && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}

        {isLoading && <p style={{ color: 'var(--text-muted)' }}>{copy.loading}</p>}
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
                <div style={{ margin: '12px 16px 0', padding: '10px 12px', borderRadius: 8, background: 'var(--amber-bg)', border: '1px solid var(--amber-border)', color: 'var(--amber-text)', fontSize: '0.76rem', lineHeight: 1.45 }}>
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
                        <span style={tag}>{copy.stockValue}: {rule.stockValue ?? 0}</span>
                        <span style={{ ...tag, color: 'var(--orange-dark)' }}>{formatRuleSchedule(rule, lang)}</span>
                        <span style={{ ...tag, color: !pool.active && !['running', 'pending'].includes(rule.executions?.[0]?.status ?? '') ? 'var(--amber-text)' : rule.executions?.[0] ? statusColor[rule.executions[0].status] : rule.active ? 'var(--green-text)' : 'var(--text-muted)' }}>
                          {copy.status}: {!pool.active && !['running', 'pending'].includes(rule.executions?.[0]?.status ?? '') ? copy.pausedByPool : rule.executions?.[0] ? executionStatusLabel(rule.executions[0].status, lang) : rule.active ? copy.scheduledStatus : copy.inactive}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 6 }}>
                        {copy.startsAt}: {new Date(rule.startsAt).toLocaleString(intlLocaleForLang(lang))} · {copy.endsAt}: {rule.endsAt ? new Date(rule.endsAt).toLocaleString(intlLocaleForLang(lang)) : copy.noEnd} · {copy.next}: {new Date(rule.nextRunAt).toLocaleString(intlLocaleForLang(lang))} · {copy.last}: {rule.lastRunAt ? new Date(rule.lastRunAt).toLocaleString(intlLocaleForLang(lang)) : copy.never}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>
                        {copy.createdBy}: {rule.createdBy?.name ?? rule.createdBy?.email ?? '—'} ({new Date(rule.createdAt).toLocaleString(intlLocaleForLang(lang))}) · {copy.updatedBy}: {rule.updatedBy?.name ?? rule.updatedBy?.email ?? '—'} ({new Date(rule.updatedAt).toLocaleString(intlLocaleForLang(lang))})
                      </div>
                      {(rule.executions?.[0]?.status === 'running' || rule.executions?.[0]?.status === 'pending') && <Progress execution={rule.executions[0]} lang={lang} />}
                      {rule.executions?.[0] && !['running', 'pending'].includes(rule.executions[0].status) && (
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 6 }}>
                          {rule.executions[0].shopsSucceeded ?? 0} {copy.fullShops} · {rule.executions[0].shopsPartial ?? 0} {copy.partialShops} · {rule.executions[0].shopsFailed ?? 0} {copy.failedShops} · {rule.executions[0].itemsTurnedOff ?? 0} {copy.itemUpdates} · {rule.executions[0].itemsFailed ?? 0} {copy.itemFailures}
                        </div>
                      )}
                      {rule.executions?.[0]?.errorMessage && (rule.executions[0].status === 'partial_success' || rule.executions[0].status === 'failed' || rule.executions[0].status === 'cancelled') && (
                        <div style={{ color: rule.executions[0].status === 'partial_success' ? 'var(--amber-text)' : 'var(--red-text)', fontSize: '0.72rem', marginTop: 6 }}>
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
                        <span style={{ color: statusColor[execution.status], fontWeight: 700 }}>{executionStatusLabel(execution.status, lang)}</span>
                        <span>{execution.shopsSucceeded ?? 0} {copy.fullShops}</span>
                        <span>{execution.shopsPartial ?? 0} {copy.partialShops}</span>
                        <span>{execution.shopsFailed ?? 0} {copy.failedShops}</span>
                        <span>{execution.itemsTurnedOff ?? 0} {copy.itemUpdates}</span>
                        <span>{execution.itemsFailed ?? 0} {copy.itemFailures}</span>
                        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>{copy[execution.trigger]} · {new Date(execution.createdAt).toLocaleString(intlLocaleForLang(lang))}</span>
                        <button className="btn btn-ghost btn-sm" onClick={() => toggleShopResults(execution.id)}>
                          {shopResultsExecutionId === execution.id ? copy.hideShopResults : copy.shopResults}
                        </button>
                      </div>
                      {(execution.status === 'running' || execution.status === 'pending') && <Progress execution={execution} lang={lang} />}
                      {execution.errorMessage && (
                        <div style={{ color: execution.status === 'failed' ? 'var(--red-text)' : 'var(--amber-text)', fontSize: '0.72rem', marginTop: 6 }}>
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
                          lang={lang}
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
            <div className="form-group"><label className="form-label">{copy.country}</label><select className="form-input" value={poolForm.country} disabled={!!editingPool} onChange={event => setPoolForm({ ...poolForm, country: event.target.value as PoolForm['country'] })}><option value="MX">{copy.mexico}</option><option value="CO">{copy.colombia}</option><option value="CR">{copy.costaRica}</option></select></div>
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
            <div className="form-group">
              <label className="form-label">{copy.stockValue}</label>
              <input
                className="form-input"
                type="number"
                min="0"
                max="2147483647"
                step="1"
                value={ruleForm.stockValue}
                onChange={event => setRuleForm({ ...ruleForm, stockValue: Number(event.target.value) })}
              />
              <small style={{ color: 'var(--text-muted)' }}>{copy.stockValueHelp}</small>
            </div>
            <div className="form-group"><label className="form-label">{copy.startsAt}</label><input className="form-input" type="datetime-local" value={ruleForm.startsAt} onChange={event => setRuleForm({ ...ruleForm, startsAt: event.target.value })} /></div>
            <div className="form-group"><label className="form-label">{copy.endsAt}</label><input className="form-input" type="datetime-local" value={ruleForm.endsAt} onChange={event => setRuleForm({ ...ruleForm, endsAt: event.target.value })} /><small style={{ color: 'var(--text-muted)' }}>{copy.endHelp}</small></div>
            <div className="form-group">
              <label className="form-label">{copy.schedule}</label>
              <select className="form-input" value={ruleForm.scheduleMode} onChange={event => setRuleForm({ ...ruleForm, scheduleMode: event.target.value as ScheduleMode })}>
                <option value="interval">{copy.intervalSchedule}</option>
                <option value="daily_times">{copy.dailySchedule}</option>
              </select>
            </div>
            {ruleForm.scheduleMode === 'interval' ? (
              <div className="form-group">
                <label className="form-label">{copy.frequency}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span>{copy.every}</span><input className="form-input" style={{ width: 110 }} type="number" min="1" value={ruleForm.frequency} onChange={event => setRuleForm({ ...ruleForm, frequency: Number(event.target.value) })} /><select className="form-input" value={ruleForm.unit} onChange={event => setRuleForm({ ...ruleForm, unit: event.target.value as FrequencyUnit })}><option value="minutes">{copy.minutes}</option><option value="hours">{copy.hours}</option><option value="days">{copy.days}</option></select></div>
                <small style={{ color: 'var(--text-muted)' }}>{copy.frequencyHelp}</small>
              </div>
            ) : (
              <div className="form-group">
                <label className="form-label">{copy.dailyTimes}</label>
                <div style={{ display: 'grid', gap: 7 }}>
                  {ruleForm.executionTimes.map((time, index) => (
                    <div key={`${index}-${time}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input className="form-input" type="time" value={time} onChange={event => setRuleForm(current => ({
                        ...current,
                        executionTimes: current.executionTimes.map((value, itemIndex) => itemIndex === index ? event.target.value : value),
                      }))} />
                      <button type="button" className="btn btn-ghost btn-sm" disabled={ruleForm.executionTimes.length === 1} onClick={() => setRuleForm(current => ({
                        ...current,
                        executionTimes: current.executionTimes.filter((_, itemIndex) => itemIndex !== index),
                      }))}>{copy.removeTime}</button>
                    </div>
                  ))}
                </div>
                <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} disabled={ruleForm.executionTimes.length >= 48} onClick={() => setRuleForm(current => ({ ...current, executionTimes: [...current.executionTimes, '12:00'] }))}>+ {copy.addTime}</button>
                <small style={{ color: 'var(--text-muted)', display: 'block', marginTop: 6 }}>{copy.dailyTimesHelp}</small>
              </div>
            )}
            <div className="form-group">
              <label className="form-label">{copy.shops} ({parseShopIds(ruleForm.shopIds).length})</label>
              {!!ruleForm.brandId && (
                <div style={{ border: '1px solid var(--border)', background: 'var(--surface-2)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: brandShops.length > 0 ? 8 : 0 }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.76rem', flex: 1 }}>
                      {loadingBrandShops ? copy.loading : `${brandShops.length} ${copy.storedShops}`}
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
  background: active ? 'var(--green-bg)' : 'var(--surface-2)', color: active ? 'var(--green-text)' : 'var(--text-muted)',
} as const);

function Progress({ execution, lang }: {
  execution: Pick<AutoTurnOffExecution, 'currentStep' | 'progressPercent' | 'progressCurrent' | 'progressTotal' | 'status'>;
  lang: Lang;
}) {
  const percent = Math.min(100, Math.max(0, execution.progressPercent ?? 0));
  return (
    <div style={{ marginTop: 7 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '0.7rem', marginBottom: 4 }}>
        <span>{progressStep(execution.currentStep, lang)}</span>
        <span>{percent}% ({execution.progressCurrent ?? 0}/{execution.progressTotal ?? 0})</span>
      </div>
      <div className="auto-turn-off-progress">
        <div className={execution.status === 'running' ? 'is-running' : ''} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function ShopResultsPanel({ result, loading, page, setPage, lang, copy }: {
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
  lang: Lang;
  copy: {
    shopResults: string;
    status: string;
    successfulItems: string;
    failedItems: string;
    result: string;
    finished: string;
    page: string;
    loading: string;
    viewSubmittedItems: string;
    viewTurnedOffItems: string;
    unnamedItem: string;
    asyncPending: string;
    viewFailedItems: string;
    previousPage: string;
    nextPage: string;
    missingUpcs: string;
    allItemsTurnedOff: string;
    storeExecutionFailed: string;
  };
}) {
  const totalPages = Math.max(1, Math.ceil((result?.total ?? 0) / (result?.limit ?? 50)));
  return (
    <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '8px 10px', background: 'var(--surface-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: '0.74rem' }}>{copy.shopResults} ({result?.total ?? 0})</strong>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>{copy.page} {page}/{totalPages}</span>
      </div>
      {loading && !result ? (
        <div style={{ padding: 12, color: 'var(--text-muted)' }}>{copy.loading}</div>
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
                const detail = shopResultDetail(shop, lang, copy);
                const failedItems = shopFailedItems(shop, result?.requestedUpcs ?? [], copy.storeExecutionFailed);
                const successfulItems = shop.result?.successfulItems ?? [];
                return (
                  <tr key={shop.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={shopCell}>{shop.shopId}</td>
                    <td style={shopCell}>{shop.appShopId ?? '—'}</td>
                    <td style={{ ...shopCell, color: statusColor[shop.status], fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {executionStatusLabel(shop.status, lang)}
                    </td>
                    <td style={{ ...shopCell, color: 'var(--green-text)', textAlign: 'center' }}>{shop.itemsSucceeded}</td>
                    <td style={{ ...shopCell, color: shop.itemsFailed > 0 ? 'var(--red)' : 'var(--text-muted)', textAlign: 'center' }}>{shop.itemsFailed}</td>
                    <td style={{ ...shopCell, maxWidth: 460 }}>
                      <div title={detail}>{detail}</div>
                      {successfulItems.length > 0 && (
                        <details style={{ marginTop: 6 }}>
                          <summary style={{ color: 'var(--green-text)', cursor: 'pointer', fontWeight: 700 }}>
                            {shop.result?.endpoint === 'setStock'
                              ? copy.viewSubmittedItems
                              : copy.viewTurnedOffItems} ({successfulItems.length})
                          </summary>
                          <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                            {successfulItems.map((item, index) => (
                              <div key={`${shop.id}-${item.appItemId}-${index}`} style={{ background: 'var(--green-bg)', borderRadius: 5, padding: '6px 8px' }}>
                                <strong>{item.name || copy.unnamedItem}</strong>
                                <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                                  UPC: {item.upc || '—'} · app_item_id: {item.appItemId}
                                </div>
                                {item.confirmation === 'accepted' && <div style={{ color: 'var(--amber-text)', marginTop: 2 }}>
                                  {copy.asyncPending}
                                </div>}
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                      {failedItems.length > 0 && (
                        <details style={{ marginTop: 6 }}>
                          <summary style={{ color: 'var(--red)', cursor: 'pointer', fontWeight: 700 }}>
                            {copy.viewFailedItems} ({failedItems.length})
                          </summary>
                          <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                            {failedItems.map((item, index) => (
                              <div key={`${shop.id}-${item.id}-${index}`} style={{ background: 'var(--red-bg)', borderRadius: 5, padding: '5px 7px' }}>
                                <strong>{item.kind}: {item.id}</strong>
                                <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{item.reason}</div>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </td>
                    <td style={{ ...shopCell, whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                      {shop.finishedAt ? new Date(shop.finishedAt).toLocaleString(intlLocaleForLang(lang)) : '—'}
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
          {copy.previousPage}
        </button>
        <button className="btn btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setPage(current => Math.min(totalPages, current + 1))}>
          {copy.nextPage}
        </button>
      </div>
    </div>
  );
}

function shopResultDetail(shop: AutoTurnOffShopExecution, lang: Lang, copy: {
  missingUpcs: string;
  allItemsTurnedOff: string;
}) {
  const value = shop.result;
  if (value?.error) return value.error;
  if (value?.missingUpcs?.length) {
    return `${value.missingUpcs.length} UPC(s) ${copy.missingUpcs}: ${value.missingUpcs.slice(0, 5).join(', ')}`;
  }
  if (value?.failedItems?.length) {
    return value.failedItems.slice(0, 5).map(item => `${item.appItemId}: ${item.reason}`).join('; ');
  }
  if (shop.status === 'done') return copy.allItemsTurnedOff;
  return progressStep(shop.currentStep, lang);
}

function shopFailedItems(shop: AutoTurnOffShopExecution, requestedUpcs: string[], fallbackReason: string) {
  const explicit = shop.result?.failedItems ?? [];
  if (explicit.length > 0) {
    return explicit.map(item => ({
      kind: item.upc ? 'UPC' : 'app_item_id',
      id: item.upc ?? item.appItemId ?? '—',
      reason: item.reason,
    }));
  }
  if (shop.itemsFailed <= 0) return [];
  const reason = shop.result?.error ?? fallbackReason;
  return requestedUpcs.map(upc => ({ kind: 'UPC', id: upc, reason }));
}

const shopCell = { padding: '8px 10px', fontSize: '0.7rem', verticalAlign: 'top' } as const;
