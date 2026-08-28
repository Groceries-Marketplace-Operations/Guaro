import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { didiStoreBindingsApi } from '../../api';
import Modal from '../../components/ui/Modal';
import type {
  Application,
  DidiStoreBindingRequest,
  DidiStoreBindingResponse,
  DidiStoreBindingResult,
  DidiStoreBindingShop,
  DidiStoreBindingShopsResponse,
} from '../../types';
import ApplicationSearchField from './ApplicationSearchField';

type Operation = 'bind' | 'unbind';
type RowStatus = 'ready' | 'processing' | 'succeeded' | 'failed' | 'skipped' | 'unconfirmed';

interface ResultRow {
  shopId: string;
  appShopId: string;
  status: RowStatus;
  message?: string;
}

interface MutationVariables {
  operation: Operation;
  request: DidiStoreBindingRequest;
}

const BIND_MAX_SHOPS = 50;
const UNBIND_MAX_SHOPS = 1;
const shopIdPattern = /^57\d{17}$/;
const successfulStatuses = new Set(['success', 'succeeded', 'done', 'bound', 'unbound']);
const failedStatuses = new Set(['error', 'failed', 'rejected']);
const skippedStatuses = new Set(['skip', 'skipped']);
const unconfirmedStatuses = new Set(['unconfirmed', 'unknown']);

function shopKey(shop: Pick<DidiStoreBindingShop, 'shopId' | 'appShopId'>) {
  return `${shop.shopId}\u0000${shop.appShopId}`;
}

function bindingState(shop: DidiStoreBindingShop): 'bound' | 'unbound' | 'unknown' {
  if (shop.bound === true) return 'bound';
  if (shop.bound === false) return 'unbound';
  const value = shop.bindingStatus?.toLowerCase().replace(/[\s-]+/g, '_');
  if (value && ['bound', 'linked', 'active'].includes(value)) return 'bound';
  if (value && ['unbound', 'not_bound', 'unlinked', 'inactive'].includes(value)) return 'unbound';
  return 'unknown';
}

function isEligible(shop: DidiStoreBindingShop, operation: Operation) {
  const state = bindingState(shop);
  return state === 'unknown' || (operation === 'bind' ? state === 'unbound' : state === 'bound');
}

function bindingLabel(shop: DidiStoreBindingShop) {
  const state = bindingState(shop);
  if (state === 'bound') return 'Vinculada';
  if (state === 'unbound') return 'No vinculada';
  return 'Sin confirmar';
}

function parseManualShops(value: string) {
  const shops: DidiStoreBindingShop[] = [];
  const errors: string[] = [];
  const byShopId = new Map<string, DidiStoreBindingShop>();
  const byAppShopId = new Map<string, DidiStoreBindingShop>();

  value.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    if (/^shop_?id(?:\s*[,;|\t]\s*|\s+)app_?shop_?id$/i.test(line)) return;

    let values = line.split(/\s*[,;|\t]\s*/).filter(Boolean);
    if (values.length === 1) values = line.split(/\s+/).filter(Boolean);
    if (values.length !== 2) {
      errors.push(`Línea ${index + 1}: usa exactamente shop_id,app_shop_id.`);
      return;
    }

    const [shopId, appShopId] = values.map(item => item.trim());
    if (!shopIdPattern.test(shopId)) {
      errors.push(`Línea ${index + 1}: shop_id debe tener 19 dígitos y comenzar con 57.`);
      return;
    }
    if (!appShopId || appShopId.length > 128) {
      errors.push(`Línea ${index + 1}: app_shop_id es obligatorio y admite hasta 128 caracteres.`);
      return;
    }

    const existing = byShopId.get(shopId);
    if (existing && existing.appShopId !== appShopId) {
      errors.push(`Línea ${index + 1}: shop_id está repetido con otro app_shop_id.`);
      return;
    }
    const existingMapping = byAppShopId.get(appShopId);
    if (existingMapping && existingMapping.shopId !== shopId) {
      errors.push(`Línea ${index + 1}: app_shop_id está repetido con otro shop_id.`);
      return;
    }
    if (!existing) {
      const shop = { shopId, appShopId };
      byShopId.set(shopId, shop);
      byAppShopId.set(appShopId, shop);
      shops.push(shop);
    }
  });

  return { shops, errors };
}

function apiError(reason: unknown, fallback: string) {
  const message = (reason as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
  return Array.isArray(message) ? message.join(', ') : message ?? fallback;
}

function resultStatus(result: DidiStoreBindingResult): RowStatus {
  const status = result.status?.trim().toLowerCase() ?? '';
  if (result.success === true || successfulStatuses.has(status)) return 'succeeded';
  if (unconfirmedStatuses.has(status)) return 'unconfirmed';
  if (skippedStatuses.has(status)) return 'skipped';
  if (result.success === false || failedStatuses.has(status)) return 'failed';
  return 'unconfirmed';
}

function resultMessage(result: DidiStoreBindingResult) {
  const errno = result.errno === undefined || result.errno === null ? '' : `errno=${result.errno}`;
  return [result.reason, result.error, result.message, errno].filter(Boolean).join(' · ') || undefined;
}

function statusView(status: RowStatus) {
  const values: Record<RowStatus, { className: string; label: string }> = {
    ready: { className: 's-pending', label: 'Lista' },
    processing: { className: 's-running', label: 'Procesando' },
    succeeded: { className: 's-done', label: 'Confirmada' },
    failed: { className: 's-failed', label: 'Fallida' },
    skipped: { className: 's-cancelled', label: 'Omitida' },
    unconfirmed: { className: 's-blocked', label: 'Sin confirmar' },
  };
  const value = values[status];
  return <span className={`status ${value.className}`}>{value.label}</span>;
}

function confirmationPhrase(
  operation: Operation,
  count: number,
  environment?: string,
  appId?: string,
  shopId?: string,
  batchFingerprint?: string,
) {
  const action = `${operation === 'bind' ? 'VINCULAR' : 'DESVINCULAR'} ${count} TIENDAS`;
  if (environment !== 'production') return action;
  return operation === 'unbind'
    ? `PRODUCCION ${action} APP_ID ${appId ?? ''} SHOP_ID ${shopId ?? ''}`
    : `PRODUCCION ${action} APP_ID ${appId ?? ''} LOTE ${batchFingerprint ?? ''}`;
}

function canonicalBatch(shops: Array<Pick<DidiStoreBindingShop, 'shopId' | 'appShopId'>>) {
  return shops
    .map(shop => `${shop.shopId}\u0000${shop.appShopId}`)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .join('\n');
}

async function sha256BatchFingerprint(canonical: string) {
  if (!window.crypto?.subtle) throw new Error('SHA-256 no está disponible en este navegador.');
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
    .toUpperCase();
}

function operationNoticeStyle(operation: Operation) {
  const destructive = operation === 'unbind';
  return {
    marginBottom: 14,
    padding: '11px 14px',
    border: `1px solid ${destructive ? 'var(--red-border)' : 'var(--blue-border)'}`,
    borderRadius: 'var(--radius-md)',
    background: destructive ? 'var(--red-bg)' : 'var(--blue-bg)',
    color: destructive ? 'var(--red-text)' : 'var(--blue-text)',
    fontSize: 12,
    lineHeight: 1.45,
  };
}

export default function DidiStoreBindingsSection() {
  const queryClient = useQueryClient();
  const [operation, setOperation] = useState<Operation>('bind');
  const [applicationId, setApplicationId] = useState('');
  const [applicationSearch, setApplicationSearch] = useState('');
  const [application, setApplication] = useState<Application | null>(null);
  const [shopsLoadRequested, setShopsLoadRequested] = useState(false);
  const [shopPage, setShopPage] = useState(1);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [manualInput, setManualInput] = useState('');
  const [shopSearch, setShopSearch] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [productionReason, setProductionReason] = useState('');
  const [resultRows, setResultRows] = useState<ResultRow[]>([]);
  const [serverSummary, setServerSummary] = useState<DidiStoreBindingResponse['summary']>();
  const [operationMeta, setOperationMeta] = useState<Pick<DidiStoreBindingResponse, 'operationId' | 'auditPersisted' | 'durationMs'>>();
  const [batchError, setBatchError] = useState('');
  const maxShops = operation === 'bind' ? BIND_MAX_SHOPS : UNBIND_MAX_SHOPS;

  const shopsQuery = useQuery<DidiStoreBindingShopsResponse>({
    queryKey: ['didi-store-bindings', 'shops', applicationId, shopPage],
    queryFn: () => didiStoreBindingsApi.shops(applicationId, shopPage).then(response => response.data),
    enabled: !!applicationId && shopsLoadRequested,
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });

  const availableShops = useMemo(() => {
    const response = shopsLoadRequested && !shopsQuery.isFetching && !shopsQuery.isError
      ? shopsQuery.data
      : undefined;
    const values = response?.shops ?? response?.data ?? [];
    const unique = new Map<string, DidiStoreBindingShop>();
    for (const shop of values) {
      if (!shop.shopId || !shop.appShopId) continue;
      unique.set(shopKey(shop), {
        ...shop,
        name: shop.name ?? shop.shopName,
        bound: shop.bound ?? (shop.bindingStatus ? undefined : true),
      });
    }
    return [...unique.values()];
  }, [shopsLoadRequested, shopsQuery.data, shopsQuery.isError, shopsQuery.isFetching]);

  const visibleShops = useMemo(() => {
    const query = shopSearch.trim().toLowerCase();
    if (!query) return availableShops;
    return availableShops.filter(shop => [shop.shopId, shop.appShopId, shop.name, shop.city]
      .some(value => value?.toLowerCase().includes(query)));
  }, [availableShops, shopSearch]);

  const manual = useMemo(() => parseManualShops(manualInput), [manualInput]);
  const selection = useMemo(() => {
    const shops = availableShops.filter(shop => selectedKeys.has(shopKey(shop)));
    const byShopId = new Map(shops.map(shop => [shop.shopId, shop]));
    const byAppShopId = new Map(shops.map(shop => [shop.appShopId, shop]));
    const errors = [...manual.errors];

    for (const shop of manual.shops) {
      const existing = byShopId.get(shop.shopId);
      if (existing && existing.appShopId !== shop.appShopId) {
        errors.push(`${shop.shopId}: el listado y la entrada manual tienen app_shop_id distintos.`);
      } else if (byAppShopId.has(shop.appShopId) && byAppShopId.get(shop.appShopId)?.shopId !== shop.shopId) {
        errors.push(`${shop.appShopId}: el listado y la entrada manual tienen shop_id distintos.`);
      } else if (!existing) {
        shops.push(shop);
        byShopId.set(shop.shopId, shop);
        byAppShopId.set(shop.appShopId, shop);
      }
    }
    if (shops.length > maxShops) errors.push(`El máximo para ${operation === 'bind' ? 'Bind' : 'Unbind'} es de ${maxShops} tienda${maxShops === 1 ? '' : 's'} por solicitud.`);
    return { shops, errors };
  }, [availableShops, manual, maxShops, operation, selectedKeys]);

  const resetOutput = () => {
    setResultRows([]);
    setServerSummary(undefined);
    setOperationMeta(undefined);
    setBatchError('');
  };

  const mutation = useMutation({
    mutationFn: ({ operation: requestedOperation, request }: MutationVariables) =>
      requestedOperation === 'bind'
        ? didiStoreBindingsApi.bind(request)
        : didiStoreBindingsApi.unbind(request),
    onSuccess: (response, variables) => {
      const results = response.data.results ?? [];
      const byPair = new Map<string, DidiStoreBindingResult>();
      const byAppShopId = new Map<string, DidiStoreBindingResult>();
      for (const result of results) {
        if (result.appShopId) byAppShopId.set(result.appShopId, result);
        if (result.shopId && result.appShopId) byPair.set(`${result.shopId}\u0000${result.appShopId}`, result);
      }
      const rows = variables.request.shops.map(shop => {
        const result = byPair.get(`${shop.shopId}\u0000${shop.appShopId}`) ?? byAppShopId.get(shop.appShopId);
        return result
          ? { ...shop, status: resultStatus(result), message: resultMessage(result) }
          : { ...shop, status: 'unconfirmed' as const, message: 'El backend no devolvió un resultado individual.' };
      });
      setResultRows(rows);
      setServerSummary(response.data.summary);
      setOperationMeta({
        operationId: response.data.operationId,
        auditPersisted: response.data.auditPersisted,
        durationMs: response.data.durationMs,
      });
      const warnings: string[] = [];
      if (rows.some(row => row.status === 'unconfirmed')) warnings.push('Hay tiendas sin confirmación individual. Verifica su estado antes de repetir la operación.');
      const explicitSucceeded = rows.filter(row => row.status === 'succeeded').length;
      const explicitFailed = rows.filter(row => row.status === 'failed').length;
      const explicitUnconfirmed = rows.filter(row => row.status === 'unconfirmed').length;
      if (response.data.summary?.total !== undefined && response.data.summary.total !== rows.length) warnings.push('El total del resumen no coincide con los resultados individuales.');
      if (response.data.summary?.succeeded !== undefined && response.data.summary.succeeded !== explicitSucceeded) warnings.push('El número de éxitos del resumen no coincide con las confirmaciones individuales.');
      if (response.data.summary?.failed !== undefined && response.data.summary.failed !== explicitFailed) warnings.push('El número de fallos del resumen no coincide con los resultados individuales.');
      if (response.data.summary?.unconfirmed !== undefined && response.data.summary.unconfirmed !== explicitUnconfirmed) warnings.push('El número de estados sin confirmar del resumen no coincide con los resultados individuales.');
      if (response.data.auditPersisted === false) warnings.push('La operación respondió, pero el backend no pudo finalizar su registro de auditoría.');
      if (response.data.auditPersisted === undefined) warnings.push('El backend no confirmó el estado del registro de auditoría.');
      setBatchError(warnings.join(' '));
      setConfirmOpen(false);
      setConfirmation('');
      setRiskAcknowledged(false);
      setProductionReason('');
      void queryClient.invalidateQueries({
        queryKey: ['didi-store-bindings', 'shops', variables.request.applicationId],
      });
    },
    onError: (reason, variables) => {
      setResultRows(variables.request.shops.map(shop => ({
        ...shop,
        status: 'unconfirmed',
        message: 'La solicitud no pudo confirmarse. Consulta el estado antes de reintentar.',
      })));
      setServerSummary(undefined);
      setOperationMeta(undefined);
      setBatchError(apiError(reason, 'No se pudo confirmar la operación con DiDi.'));
      setConfirmOpen(false);
      setConfirmation('');
      setRiskAcknowledged(false);
      setProductionReason('');
    },
  });

  const selectApplication = (id: string, label: string, value?: Application) => {
    if (confirmOpen || mutation.isPending) return;
    setApplicationId(id);
    setApplicationSearch(label);
    setApplication(value ?? null);
    setShopsLoadRequested(false);
    setShopPage(1);
    setSelectedKeys(new Set());
    setManualInput('');
    setShopSearch('');
    setConfirmOpen(false);
    setConfirmation('');
    setRiskAcknowledged(false);
    setProductionReason('');
    resetOutput();
  };

  const changeOperation = (value: Operation) => {
    if (confirmOpen || mutation.isPending) return;
    setOperation(value);
    setSelectedKeys(new Set());
    setManualInput('');
    setConfirmOpen(false);
    setConfirmation('');
    setRiskAcknowledged(false);
    setProductionReason('');
    resetOutput();
  };

  const toggleShop = (shop: DidiStoreBindingShop) => {
    if (confirmOpen || mutation.isPending) return;
    const key = shopKey(shop);
    setSelectedKeys(current => {
      if (operation === 'unbind') return new Set([key]);
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    resetOutput();
  };

  const selectVisible = () => {
    if (confirmOpen || mutation.isPending) return;
    setSelectedKeys(current => {
      const next = new Set(current);
      for (const shop of visibleShops) {
        if (next.size >= BIND_MAX_SHOPS) break;
        if (isEligible(shop, operation)) next.add(shopKey(shop));
      }
      return next;
    });
    resetOutput();
  };

  const clearSelection = () => {
    if (confirmOpen || mutation.isPending) return;
    setSelectedKeys(new Set());
    setManualInput('');
    resetOutput();
  };

  const authoritativeResponse = shopsLoadRequested && !shopsQuery.isFetching && !shopsQuery.isError
    ? shopsQuery.data
    : undefined;
  const authoritativeApplication = authoritativeResponse?.application;
  const environment = authoritativeApplication?.environment?.toLowerCase();
  const isProduction = environment === 'production';
  const verifiedEnvironment = environment === 'test' || isProduction;
  const applicationMatches = authoritativeApplication?.id === applicationId
    && authoritativeApplication?.appId === application?.appId;
  const writesAllowed = operation === 'bind'
    ? authoritativeResponse?.guards?.canBind === true
    : authoritativeResponse?.guards?.canUnbind === true;
  const requiresRiskAcknowledgement = operation === 'unbind' || isProduction;
  const productionUnbindRequiresListSelection = isProduction && operation === 'unbind';
  const canonicalProductionBatch = useMemo(
    () => operation === 'bind' && isProduction && selection.shops.length > 0
      ? canonicalBatch(selection.shops)
      : '',
    [isProduction, operation, selection.shops],
  );
  const fingerprintQuery = useQuery<string>({
    queryKey: ['didi-store-bindings', 'batch-fingerprint', canonicalProductionBatch],
    queryFn: () => sha256BatchFingerprint(canonicalProductionBatch),
    enabled: !!canonicalProductionBatch,
    staleTime: Infinity,
    retry: false,
  });
  const batchFingerprint = canonicalProductionBatch ? fingerprintQuery.data ?? '' : '';
  const fingerprintError = canonicalProductionBatch && fingerprintQuery.isError
    ? (fingerprintQuery.error instanceof Error ? fingerprintQuery.error.message : 'No se pudo calcular el fingerprint del lote.')
    : '';
  const fingerprintReady = !canonicalProductionBatch || !!batchFingerprint;
  const expectedConfirmation = confirmationPhrase(
    operation,
    selection.shops.length,
    environment,
    authoritativeApplication?.appId,
    operation === 'unbind' ? selection.shops[0]?.shopId : undefined,
    operation === 'bind' ? batchFingerprint : undefined,
  );
  const canReview = !!applicationId
    && !!application
    && shopsLoadRequested
    && applicationMatches
    && verifiedEnvironment
    && writesAllowed
    && fingerprintReady
    && !shopsQuery.isFetching
    && selection.shops.length > 0
    && selection.shops.length <= maxShops
    && selection.errors.length === 0
    && (!productionUnbindRequiresListSelection || (manual.shops.length === 0 && selectedKeys.size === 1))
    && !mutation.isPending;
  const canExecute = confirmation === expectedConfirmation
    && (!requiresRiskAcknowledgement || riskAcknowledged)
    && (!isProduction || productionReason.trim().length >= 10)
    && !mutation.isPending;

  const execute = () => {
    if (!canExecute || !canReview) return;
    const request: DidiStoreBindingRequest = {
      applicationId,
      shops: selection.shops.map(shop => ({ shopId: shop.shopId, appShopId: shop.appShopId })),
      confirmation,
      ...(isProduction ? {
        reason: productionReason.trim(),
        productionAcknowledged: true,
      } : {}),
      ...(isProduction && operation === 'unbind' ? {
        remotePageNo: authoritativeResponse?.pageNo ?? shopPage,
      } : {}),
    };
    setResultRows(request.shops.map(shop => ({ ...shop, status: 'processing' })));
    setServerSummary(undefined);
    setOperationMeta(undefined);
    setBatchError('');
    mutation.mutate({ operation, request });
  };

  const resultCounts = useMemo(() => ({
    succeeded: resultRows.filter(row => row.status === 'succeeded').length,
    failed: resultRows.filter(row => row.status === 'failed').length,
    skipped: resultRows.filter(row => row.status === 'skipped').length,
    unconfirmed: resultRows.filter(row => row.status === 'unconfirmed').length,
  }), [resultRows]);

  return <section style={{ marginBottom: 22 }}>
    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ maxWidth: 760 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong>DiDi Bind masivo / Unbind controlado</strong>
            <span className="badge" style={{ color: 'var(--amber-text)' }}>TEST / PROD</span>
            <span className="badge">Bind máx. {BIND_MAX_SHOPS}</span>
            <span className="badge">Unbind máx. {UNBIND_MAX_SHOPS}</span>
          </div>
          <p className="text-muted" style={{ marginTop: 7, fontSize: 12 }}>
            Vincula hasta {BIND_MAX_SHOPS} tiendas por lote. Unbind se ejecuta de una en una. En producción se exige Super Admin, motivo, aceptación de impacto y una frase ligada al app_id. Guaro nunca muestra app_secret o auth_token.
          </p>
        </div>
        <div role="group" aria-label="Operación" style={{ display: 'flex', gap: 8 }}>
          <button type="button" className={`btn ${operation === 'bind' ? 'btn-primary' : 'btn-ghost'}`} disabled={confirmOpen || mutation.isPending} onClick={() => changeOperation('bind')}>Bind</button>
          <button type="button" className={`btn ${operation === 'unbind' ? 'btn-primary' : 'btn-ghost'}`} style={operation === 'unbind' ? { background: 'var(--red-text)', borderColor: 'var(--red-text)' } : { color: 'var(--red-text)' }} disabled={confirmOpen || mutation.isPending} onClick={() => changeOperation('unbind')}>Unbind</button>
        </div>
      </div>
    </div>

    <div style={operationNoticeStyle(operation)}>
      {operation === 'bind'
        ? 'Bind agrega la relación con DiDi. Las tiendas que el listado ya reconoce como vinculadas no pueden seleccionarse.'
        : 'Unbind rompe la relación con DiDi y puede interrumpir menú, stock y pedidos. Por seguridad sólo se permite una tienda por operación.'}
    </div>

    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
      <div className="form-group">
        <label className="form-label">Aplicación DiDi *</label>
        <ApplicationSearchField
          value={applicationId}
          displayValue={applicationSearch}
          onChange={selectApplication}
          disabled={confirmOpen || mutation.isPending}
          placeholder="Busca por nombre o App ID…"
          emptyMessage="No hay aplicaciones que coincidan."
        />
        <p className="form-hint">El backend exige un entorno persistido y decide las capacidades. TEST además debe coincidir con la allowlist exacta; sin entorno queda bloqueada.</p>
      </div>
      {application && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <span className="badge" style={isProduction ? { color: 'var(--red-text)' } : { color: 'var(--amber-text)' }}>{authoritativeApplication?.environment?.toUpperCase() ?? 'ENTORNO SIN VERIFICAR'}</span>
        <span className="badge">{application.appName}</span>
        <span className="badge td-mono">App ID {application.appId}</span>
        <span className="badge">{application.country}</span>
      </div>}
      {application && !shopsLoadRequested && <div style={{ ...operationNoticeStyle('unbind'), marginBottom: 14 }}>
        <strong>ADVERTENCIA TEST / PROD:</strong> todavía no se ha consultado DiDi. Confirma el nombre y el App ID; esta aplicación podría pertenecer a PRODUCCIÓN.
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={confirmOpen || mutation.isPending} style={{ background: 'var(--red-text)', borderColor: 'var(--red-text)' }} onClick={() => { setShopPage(1); setShopsLoadRequested(true); }}>
            Cargar tiendas y verificar entorno
          </button>
        </div>
      </div>}
      {shopsLoadRequested && applicationId && authoritativeResponse && (!verifiedEnvironment || !applicationMatches) && <div className="error-banner">
        El backend no pudo confirmar de forma consistente el entorno y la identidad de esta aplicación. La operación queda bloqueada.
      </div>}
      {shopsLoadRequested && applicationId && authoritativeResponse && verifiedEnvironment && !writesAllowed && <div className="error-banner">
        {isProduction && authoritativeResponse.guards?.productionRoleAllowed === false
          ? 'Producción requiere una cuenta Super Admin además del permiso de ejecución.'
          : `La operación ${operation === 'bind' ? 'Bind' : 'Unbind'} está deshabilitada por configuración para este entorno.`}
      </div>}
      {isProduction && <div className="error-banner" style={{ marginBottom: 14 }}>
        PRODUCCIÓN: cualquier cambio puede afectar menú, stock y pedidos reales. Verifica app_id y tiendas antes de continuar.
      </div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'end', flexWrap: 'wrap', marginBottom: 10 }}>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 260, flex: '1 1 340px' }}>
          <label className="form-label">Buscar en el listado</label>
          <input className="form-input" value={shopSearch} disabled={!shopsLoadRequested || shopsQuery.isFetching || shopsQuery.isError || confirmOpen || mutation.isPending} placeholder="Nombre, ciudad, shop_id o app_shop_id" onChange={event => setShopSearch(event.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {operation === 'bind' && <button type="button" className="btn btn-ghost btn-sm" disabled={confirmOpen || mutation.isPending || !visibleShops.some(shop => isEligible(shop, operation))} onClick={selectVisible}>Seleccionar hasta {BIND_MAX_SHOPS}</button>}
          <button type="button" className="btn btn-ghost btn-sm" disabled={confirmOpen || mutation.isPending || (selectedKeys.size === 0 && !manualInput)} onClick={clearSelection}>Limpiar</button>
        </div>
      </div>

      {shopsLoadRequested && shopsQuery.isFetching && <p className="text-muted" style={{ padding: 12 }}>Consultando tiendas disponibles…</p>}
      {shopsLoadRequested && shopsQuery.isError && <div className="error-banner">
        {apiError(shopsQuery.error, 'No se pudo cargar el listado de tiendas.')}
        <div style={{ marginTop: 8 }}><button type="button" className="btn btn-ghost btn-sm" disabled={confirmOpen || mutation.isPending} onClick={() => void shopsQuery.refetch()}>Reintentar carga explícita</button></div>
      </div>}
      {!applicationId && <div className="empty-state"><p>Selecciona una aplicación TEST o de producción para consultar sus tiendas.</p></div>}
      {shopsLoadRequested && applicationId && !shopsQuery.isFetching && !shopsQuery.isError && availableShops.length === 0 && <div className="empty-state"><p>La integración no devolvió tiendas. Puedes agregarlas manualmente abajo.</p></div>}
      {visibleShops.length > 0 && <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
        <table>
          <thead><tr><th aria-label="Seleccionar" /><th>Tienda</th><th>Shop ID</th><th>App Shop ID</th><th>Vinculación</th></tr></thead>
          <tbody>{visibleShops.map(shop => {
            const eligible = isEligible(shop, operation);
            const key = shopKey(shop);
            return <tr key={key} style={!eligible ? { opacity: .58 } : undefined}>
              <td><input type={operation === 'unbind' ? 'radio' : 'checkbox'} name={operation === 'unbind' ? 'didi-unbind-shop' : undefined} checked={selectedKeys.has(key)} disabled={!eligible || confirmOpen || mutation.isPending} aria-label={`${operation === 'unbind' ? 'Elegir para Unbind' : 'Seleccionar'} ${shop.name ?? shop.shopId}`} onChange={() => toggleShop(shop)} /></td>
              <td>{shop.name ?? '—'}{shop.city && <div className="text-muted" style={{ fontSize: 11 }}>{shop.city}</div>}</td>
              <td className="td-mono">{shop.shopId}</td>
              <td className="td-mono">{shop.appShopId}</td>
              <td><span className={`status ${bindingState(shop) === 'bound' ? 's-done' : bindingState(shop) === 'unbound' ? 's-pending' : 's-blocked'}`}>{bindingLabel(shop)}</span></td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
      {(authoritativeResponse?.totalPages ?? 1) > 1 && <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <button type="button" className="btn btn-ghost btn-sm" disabled={shopPage <= 1 || shopsQuery.isFetching || confirmOpen || mutation.isPending} onClick={() => { setSelectedKeys(new Set()); setShopSearch(''); setShopPage(page => Math.max(1, page - 1)); }}>Anterior</button>
        <span className="text-muted" style={{ fontSize: 12 }}>Página {authoritativeResponse?.pageNo ?? shopPage} de {authoritativeResponse?.totalPages}</span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={shopPage >= (authoritativeResponse?.totalPages ?? 1) || shopsQuery.isFetching || confirmOpen || mutation.isPending} onClick={() => { setSelectedKeys(new Set()); setShopSearch(''); setShopPage(page => page + 1); }}>Siguiente</button>
      </div>}
    </div>

    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
      <div className="form-group" style={{ marginBottom: 8 }}>
        <label className="form-label">{operation === 'unbind' ? 'Agregar una tienda manualmente' : 'Agregar tiendas manualmente'}</label>
        <textarea
          className="form-input td-mono"
          rows={6}
          value={manualInput}
          disabled={!shopsLoadRequested || shopsQuery.isFetching || shopsQuery.isError || productionUnbindRequiresListSelection || confirmOpen || mutation.isPending}
          placeholder={'shop_id,app_shop_id\n5764012345678901234,SUCURSAL-001'}
          onChange={event => { setManualInput(event.target.value); resetOutput(); }}
        />
        <p className="form-hint">{productionUnbindRequiresListSelection
          ? 'En PRODUCCIÓN elige una tienda del listado: el backend volverá a verificar esa página remota justo antes de Unbind.'
          : operation === 'unbind' ? 'Unbind admite exactamente una pareja shop_id,app_shop_id.' : 'Una tienda por línea. Usa shop_id,app_shop_id. Se eliminan duplicados exactos entre el listado y la entrada manual.'}</p>
      </div>
      {canonicalProductionBatch && !batchFingerprint && !fingerprintError && <p className="text-muted" style={{ fontSize: 12 }}>Calculando fingerprint SHA-256 del lote de producción…</p>}
      {batchFingerprint && <p className="text-muted td-mono" style={{ fontSize: 12 }}>Fingerprint del lote: {batchFingerprint}</p>}
      {fingerprintError && <div className="error-banner">No es seguro continuar: {fingerprintError}</div>}
      {selection.errors.length > 0 && <div className="error-banner">
        {selection.errors.slice(0, 5).map(error => <div key={error}>{error}</div>)}
        {selection.errors.length > 5 && <div>Y {selection.errors.length - 5} error(es) más.</div>}
      </div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span className="text-muted" style={{ fontSize: 12 }}>{selection.shops.length}/{maxShops} tienda(s) listas para {operation === 'bind' ? 'vincular' : 'desvincular'}.</span>
        <button type="button" className="btn btn-primary" style={operation === 'unbind' || isProduction ? { background: 'var(--red-text)', borderColor: 'var(--red-text)' } : undefined} disabled={!canReview} onClick={() => { setConfirmation(''); setRiskAcknowledged(false); setProductionReason(''); setConfirmOpen(true); }}>
          Revisar y confirmar
        </button>
      </div>
    </div>

    {batchError && <div className="error-banner">{batchError}</div>}
    {resultRows.length > 0 && <div className="card" style={{ padding: 18 }} aria-live="polite">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <strong>Resultado por tienda</strong>
          <p className="text-muted" style={{ marginTop: 5, fontSize: 12 }}>Sólo se marca como confirmada una tienda con resultado individual explícito del backend.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span className="badge" style={{ color: 'var(--green-text)' }}>{resultCounts.succeeded} confirmadas</span>
          <span className="badge" style={{ color: 'var(--red-text)' }}>{resultCounts.failed} fallidas</span>
          <span className="badge">{resultCounts.skipped} omitidas</span>
          <span className="badge" style={{ color: 'var(--purple-text)' }}>{resultCounts.unconfirmed} sin confirmar</span>
        </div>
      </div>
      {serverSummary && <p className="text-muted" style={{ marginTop: 9, fontSize: 11 }}>
        Resumen del servidor: {serverSummary.succeeded ?? 0} correctas · {serverSummary.failed ?? 0} fallidas · {serverSummary.unconfirmed ?? 0} sin confirmar · {serverSummary.skipped ?? 0} omitidas · {serverSummary.requested ?? serverSummary.total ?? resultRows.length} solicitadas.
      </p>}
      {operationMeta && <p className="text-muted td-mono" style={{ marginTop: 5, fontSize: 11 }}>
        Operación {operationMeta.operationId ?? 'sin identificador'} · {operationMeta.durationMs ?? 'duración sin confirmar'}{operationMeta.durationMs === undefined ? '' : ' ms'} · auditoría {operationMeta.auditPersisted === true ? 'registrada' : operationMeta.auditPersisted === false ? 'pendiente' : 'sin confirmar'}
      </p>}
      <div className="table-wrap" style={{ marginTop: 12 }}><table>
        <thead><tr><th>Shop ID</th><th>App Shop ID</th><th>Estado</th><th>Detalle</th></tr></thead>
        <tbody>{resultRows.map(row => <tr key={`${row.shopId}:${row.appShopId}`}>
          <td className="td-mono">{row.shopId}</td>
          <td className="td-mono">{row.appShopId}</td>
          <td>{statusView(row.status)}</td>
          <td style={row.status === 'failed' || row.status === 'unconfirmed' ? { color: 'var(--red-text)' } : undefined}>{row.message ?? '—'}</td>
        </tr>)}</tbody>
      </table></div>
    </div>}

    {confirmOpen && <Modal title={`${isProduction ? 'PRODUCCIÓN · ' : ''}${operation === 'bind' ? 'Confirmar Bind masivo' : 'Confirmar Unbind controlado'}`} onClose={() => { if (!mutation.isPending) setConfirmOpen(false); }} footer={<>
      <button className="btn btn-ghost" disabled={mutation.isPending} onClick={() => setConfirmOpen(false)}>Cancelar</button>
      <button className="btn btn-primary" style={operation === 'unbind' || isProduction ? { background: 'var(--red-text)', borderColor: 'var(--red-text)' } : undefined} disabled={!canExecute || !canReview} onClick={execute}>
        {mutation.isPending ? 'Procesando…' : operation === 'bind' ? 'Ejecutar Bind' : 'Ejecutar Unbind'}
      </button>
    </>}>
      <div style={operationNoticeStyle(operation)}>
        {operation === 'bind'
          ? `Se intentará vincular ${selection.shops.length} tienda(s) en ${application?.appName}. Los resultados pueden ser parciales.`
          : `Se intentará desvincular ${selection.shops.length} tienda(s) de ${application?.appName}. Esta acción puede interrumpir su operación en DiDi.`}
      </div>
      <p className="text-muted td-mono" style={{ marginBottom: 12, fontSize: 12 }}>
        Entorno {environment?.toUpperCase()} · {authoritativeApplication?.appName} · App ID {authoritativeApplication?.appId} · {authoritativeApplication?.country}
      </p>
      <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 14 }}><table>
        <thead><tr><th>Shop ID</th><th>App Shop ID</th></tr></thead>
        <tbody>{selection.shops.map(shop => <tr key={shopKey(shop)}><td className="td-mono">{shop.shopId}</td><td className="td-mono">{shop.appShopId}</td></tr>)}</tbody>
      </table></div>
      {requiresRiskAcknowledgement && <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginBottom: 14 }}>
        <input type="checkbox" checked={riskAcknowledged} onChange={event => setRiskAcknowledged(event.target.checked)} />
        <span>{isProduction
          ? `Confirmo que ${operation === 'bind' ? 'Bind' : 'Unbind'} está autorizado para esta aplicación de PRODUCCIÓN y acepto el impacto operativo.`
          : 'Entiendo que Unbind es destructivo y confirmé que esta tienda puede perder acceso a menú, stock y pedidos.'}</span>
      </label>}
      {isProduction && <div className="form-group">
        <label className="form-label">Motivo o ticket de producción *</label>
        <textarea className="form-input" rows={3} maxLength={500} value={productionReason} onChange={event => setProductionReason(event.target.value)} placeholder="Ej. CHG-2048 aprobado para onboarding de tiendas" />
        <p className="form-hint">Mínimo 10 caracteres. Quedará almacenado en la auditoría.</p>
      </div>}
      <div className="form-group">
        <label className="form-label">Escribe exactamente <span className="td-mono">{expectedConfirmation}</span></label>
        <input className="form-input td-mono" value={confirmation} autoComplete="off" spellCheck={false} onChange={event => setConfirmation(event.target.value)} />
      </div>
    </Modal>}
  </section>;
}
