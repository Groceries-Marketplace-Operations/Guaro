import { type ChangeEvent, type FormEvent, useDeferredValue, useMemo, useState } from 'react';
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

interface SelectedListShop extends DidiStoreBindingShop {
  sourcePage: number;
}

interface CachedShopMatch {
  pageNo: number;
  shop: DidiStoreBindingShop;
}

const BIND_MAX_SHOPS = 50;
const UNBIND_MAX_SHOPS = 1;
const SHOP_PAGE_SIZE = 100;
const MAX_IMPORT_BYTES = 256 * 1024;
const MAX_IMPORT_CHARS = 32_000;
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
  if (shop.mappingConflict) return false;
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
  const [pageDraft, setPageDraft] = useState('1');
  const [selectedListShops, setSelectedListShops] = useState<Map<string, SelectedListShop>>(() => new Map());
  const [manualInput, setManualInput] = useState('');
  const [importMessage, setImportMessage] = useState('');
  const [selectionNotice, setSelectionNotice] = useState('');
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
  const listSource = operation === 'bind' ? 'local' : 'remote';
  const deferredShopSearch = useDeferredValue(shopSearch.trim());

  const shopsQuery = useQuery<DidiStoreBindingShopsResponse>({
    queryKey: [
      'didi-store-bindings',
      'shops',
      applicationId,
      listSource,
      shopPage,
      listSource === 'local' ? deferredShopSearch : '',
    ],
    queryFn: () => (listSource === 'local'
      ? didiStoreBindingsApi.localShops(applicationId, deferredShopSearch, shopPage).then(response => response.data)
      : didiStoreBindingsApi.shops(applicationId, shopPage).then(response => response.data)),
    enabled: !!applicationId && shopsLoadRequested,
    staleTime: listSource === 'remote' ? 5 * 60_000 : 0,
    refetchOnMount: listSource === 'local' ? 'always' : false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
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
        bound: response?.source === 'local'
          ? shop.bound
          : shop.bound ?? (shop.bindingStatus ? undefined : true),
      });
    }
    return [...unique.values()];
  }, [shopsLoadRequested, shopsQuery.data, shopsQuery.isError, shopsQuery.isFetching]);

  const visibleShops = useMemo(() => {
    const query = shopSearch.trim().toLowerCase();
    if (!query) return availableShops;
    return availableShops.filter(shop => [shop.shopId, shop.appShopId, shop.name, shop.brandName, shop.city]
      .some(value => value?.toLowerCase().includes(query)));
  }, [availableShops, shopSearch]);

  const manual = useMemo(() => parseManualShops(manualInput), [manualInput]);
  const selection = useMemo(() => {
    const shops: DidiStoreBindingShop[] = [];
    const byShopId = new Map<string, DidiStoreBindingShop>();
    const byAppShopId = new Map<string, DidiStoreBindingShop>();
    const errors = [...manual.errors];

    const addShop = (shop: DidiStoreBindingShop, source: string) => {
      const existing = byShopId.get(shop.shopId);
      if (existing && existing.appShopId !== shop.appShopId) {
        errors.push(`${shop.shopId}: ${source} usa un app_shop_id distinto al ya seleccionado.`);
      } else if (byAppShopId.has(shop.appShopId) && byAppShopId.get(shop.appShopId)?.shopId !== shop.shopId) {
        errors.push(`${shop.appShopId}: ${source} usa un shop_id distinto al ya seleccionado.`);
      } else if (!existing) {
        shops.push(shop);
        byShopId.set(shop.shopId, shop);
        byAppShopId.set(shop.appShopId, shop);
      }
    };

    for (const shop of selectedListShops.values()) addShop(shop, `la selección de página ${shop.sourcePage}`);
    for (const shop of manual.shops) addShop(shop, 'la importación manual');

    if (shops.length > maxShops) {
      errors.push(`El máximo para ${operation === 'bind' ? 'Bind' : 'Unbind'} es de ${maxShops} tienda${maxShops === 1 ? '' : 's'} por solicitud.`);
    }
    return { shops, errors };
  }, [manual, maxShops, operation, selectedListShops]);

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
    setPageDraft('1');
    setSelectedListShops(new Map());
    setManualInput('');
    setImportMessage('');
    setSelectionNotice('');
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
    setShopPage(1);
    setPageDraft('1');
    setShopSearch('');
    setSelectedListShops(new Map());
    setManualInput('');
    setImportMessage('');
    setSelectionNotice('');
    setConfirmOpen(false);
    setConfirmation('');
    setRiskAcknowledged(false);
    setProductionReason('');
    resetOutput();
  };

  const toggleShop = (shop: DidiStoreBindingShop) => {
    if (confirmOpen || mutation.isPending) return;
    const key = shopKey(shop);
    if (operation === 'bind' && !selectedListShops.has(key) && selection.shops.length >= BIND_MAX_SHOPS) {
      setSelectionNotice(`Ya alcanzaste el máximo de ${BIND_MAX_SHOPS} tiendas. Quita una selección o una fila importada para agregar otra.`);
      return;
    }
    const sourcePage = authoritativeResponse?.pageNo ?? shopPage;
    setSelectedListShops(current => {
      if (operation === 'unbind') return new Map([[key, { ...shop, sourcePage }]]);
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else next.set(key, { ...shop, sourcePage });
      return next;
    });
    setSelectionNotice('');
    resetOutput();
  };

  const selectVisible = () => {
    if (confirmOpen || mutation.isPending) return;
    const sourcePage = authoritativeResponse?.pageNo ?? shopPage;
    let remaining = Math.max(0, BIND_MAX_SHOPS - selection.shops.length);
    let eligibleNotAdded = 0;
    const next = new Map(selectedListShops);
    for (const shop of visibleShops) {
      const key = shopKey(shop);
      if (!isEligible(shop, operation) || next.has(key)) continue;
      if (remaining <= 0) {
        eligibleNotAdded += 1;
        continue;
      }
      next.set(key, { ...shop, sourcePage });
      remaining -= 1;
    }
    setSelectedListShops(next);
    setSelectionNotice(eligibleNotAdded > 0
      ? `Se conservó el límite de ${BIND_MAX_SHOPS}; ${eligibleNotAdded} tienda(s) visibles no se agregaron.`
      : '');
    resetOutput();
  };

  const clearSelection = () => {
    if (confirmOpen || mutation.isPending) return;
    setSelectedListShops(new Map());
    setManualInput('');
    setImportMessage('');
    setSelectionNotice('');
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
  const unbindRequiresListSelection = operation === 'unbind';
  const selectedListEntries = useMemo(() => [...selectedListShops.values()], [selectedListShops]);
  const unbindSourcePage = selectedListEntries[0]?.sourcePage;
  const currentPageNo = authoritativeResponse?.pageNo ?? shopPage;
  const remotePageSize = authoritativeResponse?.pageSize ?? SHOP_PAGE_SIZE;
  const remoteTotal = authoritativeResponse?.total ?? availableShops.length;
  const remoteTotalPages = Math.max(1, authoritativeResponse?.totalPages ?? 1);
  const rangeStart = availableShops.length > 0 ? ((currentPageNo - 1) * remotePageSize) + 1 : 0;
  const rangeEnd = availableShops.length > 0
    ? Math.min(remoteTotal, rangeStart + availableShops.length - 1)
    : 0;
  const cachedPageMatches: CachedShopMatch[] = (() => {
    const query = shopSearch.trim().toLowerCase();
    if (!applicationId || listSource !== 'remote' || !query) return [];
    const matches: CachedShopMatch[] = [];
    const seen = new Set<string>();
    const cachedPages = queryClient.getQueriesData<DidiStoreBindingShopsResponse>({
      queryKey: ['didi-store-bindings', 'shops', applicationId],
    });
    for (const [key, response] of cachedPages) {
      if (!response) continue;
      const keyParts = key as readonly unknown[];
      if (keyParts[3] !== 'remote') continue;
      const pageNo = Number(response.pageNo ?? keyParts[4]);
      if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo === currentPageNo) continue;
      const values = response.shops ?? response.data ?? [];
      for (const shop of values) {
        if (!shop.shopId || !shop.appShopId) continue;
        const found = [shop.shopId, shop.appShopId, shop.name, shop.shopName, shop.brandName, shop.city]
          .some(value => value?.toLowerCase().includes(query));
        const keyForMatch = `${pageNo}:${shopKey(shop)}`;
        if (!found || seen.has(keyForMatch)) continue;
        seen.add(keyForMatch);
        matches.push({ pageNo, shop });
        if (matches.length >= 8) return matches;
      }
    }
    return matches;
  })();
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
    && (!unbindRequiresListSelection || (
      manual.shops.length === 0
      && selectedListShops.size === 1
      && Number.isInteger(unbindSourcePage)
    ))
    && !mutation.isPending;
  const canExecute = confirmation === expectedConfirmation
    && (!requiresRiskAcknowledgement || riskAcknowledged)
    && (!isProduction || productionReason.trim().length >= 10)
    && !mutation.isPending;

  const navigateToPage = (requestedPage: number) => {
    if (!shopsLoadRequested || shopsQuery.isFetching || confirmOpen || mutation.isPending) return;
    const target = Math.min(remoteTotalPages, Math.max(1, Math.trunc(requestedPage)));
    setPageDraft(String(target));
    setSelectionNotice('');
    if (target === shopPage) {
      void shopsQuery.refetch();
      return;
    }
    setShopPage(target);
  };

  const submitPageJump = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const requestedPage = Number(pageDraft);
    if (!Number.isInteger(requestedPage)) {
      setSelectionNotice('Escribe un número de página válido.');
      return;
    }
    navigateToPage(requestedPage);
  };

  const removeSelectedListShop = (key: string) => {
    if (confirmOpen || mutation.isPending) return;
    setSelectedListShops(current => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
    setSelectionNotice('');
    resetOutput();
  };

  const importShopFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || unbindRequiresListSelection || confirmOpen || mutation.isPending) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setImportMessage('Error: el archivo supera 256 KB. Importa sólo las filas necesarias para este lote.');
      return;
    }
    try {
      const contents = await file.text();
      if (!contents.trim()) {
        setImportMessage('Error: el archivo está vacío.');
        return;
      }
      if (contents.length > MAX_IMPORT_CHARS) {
        setImportMessage(`Error: el archivo supera ${MAX_IMPORT_CHARS.toLocaleString('es-MX')} caracteres. Importa sólo las filas necesarias para este lote.`);
        return;
      }
      setManualInput(contents);
      setImportMessage(`${file.name} cargado. Se validarán como máximo ${maxShops} tienda(s) para esta operación.`);
      setSelectionNotice('');
      resetOutput();
    } catch {
      setImportMessage('Error: no se pudo leer el archivo seleccionado.');
    }
  };

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
      ...(operation === 'unbind' ? {
        remotePageNo: unbindSourcePage,
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
        ? 'Bind usa el catálogo local de Guaro: puedes buscar entre miles de tiendas, fijar selecciones entre páginas o importar hasta 50 pares shop_id/app_shop_id.'
        : 'Unbind usa exclusivamente el listado remoto de DiDi. Sólo se permite una tienda y el backend vuelve a verificar su página antes de modificarla.'}
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
        <strong>ADVERTENCIA TEST / PROD:</strong> todavía no se ha verificado el entorno. Confirma el nombre y el App ID; esta aplicación podría pertenecer a PRODUCCIÓN.
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={confirmOpen || mutation.isPending} style={{ background: 'var(--red-text)', borderColor: 'var(--red-text)' }} onClick={() => { setShopPage(1); setPageDraft('1'); setShopsLoadRequested(true); }}>
            {operation === 'bind' ? 'Cargar catálogo local y verificar entorno' : 'Consultar DiDi y verificar entorno'}
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
          <label className="form-label">{operation === 'bind' ? 'Buscar en todo el catálogo local' : 'Filtrar la página remota actual'}</label>
          <input
            className="form-input"
            value={shopSearch}
            maxLength={128}
            disabled={!shopsLoadRequested || confirmOpen || mutation.isPending || (operation === 'unbind' && shopsQuery.isFetching)}
            placeholder="Nombre, marca, ciudad, shop_id o app_shop_id"
            onChange={event => {
              setShopSearch(event.target.value);
              if (operation === 'bind') {
                setShopPage(1);
                setPageDraft('1');
              }
            }}
          />
          <p className="form-hint">{operation === 'bind'
            ? 'La búsqueda se ejecuta en Guaro sobre todas las tiendas de la aplicación; no recorre páginas de DiDi.'
            : 'DiDi no ofrece filtro por tienda y limita cada página a 100. Filtra la página/cache ya visitada o salta directamente a otra; tu selección permanece fijada.'}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {operation === 'bind' && <button type="button" className="btn btn-ghost btn-sm" disabled={confirmOpen || mutation.isPending || !visibleShops.some(shop => isEligible(shop, operation))} onClick={selectVisible}>Seleccionar hasta {BIND_MAX_SHOPS}</button>}
          <button type="button" className="btn btn-ghost btn-sm" disabled={confirmOpen || mutation.isPending || (selectedListShops.size === 0 && !manualInput)} onClick={clearSelection}>Limpiar selección</button>
        </div>
      </div>

      {authoritativeResponse && <div role="status" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="badge">{remoteTotal.toLocaleString('es-MX')} {shopSearch.trim() && operation === 'bind' ? 'coincidencias' : 'tiendas'}</span>
        <span className="badge">{availableShops.length.toLocaleString('es-MX')} en esta página</span>
        <span className="badge">{remotePageSize} por página</span>
        <span className="badge">Página {currentPageNo.toLocaleString('es-MX')} / {remoteTotalPages.toLocaleString('es-MX')}</span>
        <span className="badge" style={{ color: selection.shops.length >= maxShops ? 'var(--amber-text)' : undefined }}>{selection.shops.length} / {maxShops} seleccionadas</span>
        {operation === 'unbind' && authoritativeResponse.remoteSnapshot && <span className="badge" title={`Estado de cache: ${authoritativeResponse.remoteSnapshot.cacheStatus}`}>
          Snapshot DiDi {new Date(authoritativeResponse.remoteSnapshot.fetchedAt).toLocaleTimeString()}
        </span>}
        <button type="button" className="btn btn-ghost btn-sm" disabled={shopsQuery.isFetching || confirmOpen || mutation.isPending} onClick={() => void shopsQuery.refetch()}>Actualizar página</button>
      </div>}
      {operation === 'bind' && deferredShopSearch !== shopSearch.trim() && <p className="text-muted" style={{ padding: '5px 0' }}>Preparando búsqueda…</p>}
      {shopsLoadRequested && shopsQuery.isFetching && <p className="text-muted" style={{ padding: 12 }}>{operation === 'bind' ? 'Consultando catálogo local…' : 'Consultando página remota en DiDi…'}</p>}
      {shopsLoadRequested && shopsQuery.isError && <div className="error-banner">
        {apiError(shopsQuery.error, 'No se pudo cargar el listado de tiendas.')}
        <div style={{ marginTop: 8 }}><button type="button" className="btn btn-ghost btn-sm" disabled={confirmOpen || mutation.isPending} onClick={() => void shopsQuery.refetch()}>Reintentar carga explícita</button></div>
      </div>}
      {!applicationId && <div className="empty-state"><p>Selecciona una aplicación TEST o de producción para consultar sus tiendas.</p></div>}
      {shopsLoadRequested && applicationId && !shopsQuery.isFetching && !shopsQuery.isError && availableShops.length === 0 && <div className="empty-state"><p>{operation === 'bind'
        ? shopSearch.trim() ? 'No hay tiendas locales que coincidan. Ajusta la búsqueda o importa el lote abajo.' : 'La aplicación no tiene tiendas locales. Puedes importar el lote abajo.'
        : shopSearch.trim() ? 'No hay coincidencias en esta página remota. Conserva el filtro y salta a otra página.' : 'DiDi no devolvió tiendas vinculadas en esta página.'}</p></div>}
      {visibleShops.length > 0 && <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
        <table>
          <thead><tr><th aria-label="Seleccionar" /><th>Tienda</th><th>Shop ID</th><th>App Shop ID</th><th>{operation === 'bind' ? 'Fuente' : 'Vinculación'}</th></tr></thead>
          <tbody>{visibleShops.map(shop => {
            const eligible = isEligible(shop, operation);
            const key = shopKey(shop);
            return <tr key={key} style={!eligible ? { opacity: .58 } : undefined}>
              <td><input type={operation === 'unbind' ? 'radio' : 'checkbox'} name={operation === 'unbind' ? 'didi-unbind-shop' : undefined} checked={selectedListShops.has(key)} disabled={!eligible || confirmOpen || mutation.isPending} aria-label={`${operation === 'unbind' ? 'Elegir para Unbind' : 'Seleccionar'} ${shop.name ?? shop.shopId}`} onChange={() => toggleShop(shop)} /></td>
              <td>{shop.name ?? '—'}{(shop.brandName || shop.city) && <div className="text-muted" style={{ fontSize: 11 }}>{[shop.brandName, shop.city].filter(Boolean).join(' · ')}</div>}</td>
              <td className="td-mono">{shop.shopId}</td>
              <td className="td-mono">{shop.appShopId}</td>
              <td>{operation === 'bind'
                ? <span className="badge" style={shop.mappingConflict ? { color: 'var(--red-text)' } : undefined}>{shop.mappingConflict ? 'Mapping duplicado' : 'Guaro local'}</span>
                : <span className={`status ${bindingState(shop) === 'bound' ? 's-done' : bindingState(shop) === 'unbound' ? 's-pending' : 's-blocked'}`}>{bindingLabel(shop)}</span>}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
      {authoritativeResponse && <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
        <span className="text-muted" style={{ fontSize: 12 }}>{rangeStart > 0 ? `Mostrando ${rangeStart.toLocaleString('es-MX')}–${rangeEnd.toLocaleString('es-MX')} de ${remoteTotal.toLocaleString('es-MX')}` : 'Página sin resultados'}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={shopPage <= 1 || shopsQuery.isFetching || confirmOpen || mutation.isPending} onClick={() => navigateToPage(1)}>Primera</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={shopPage <= 1 || shopsQuery.isFetching || confirmOpen || mutation.isPending} onClick={() => navigateToPage(shopPage - 1)}>Anterior</button>
          <form onSubmit={submitPageJump} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <label htmlFor="didi-shop-page" className="text-muted" style={{ fontSize: 12 }}>Ir a</label>
            <input id="didi-shop-page" className="form-input td-mono" style={{ width: 76, padding: '5px 7px' }} type="number" min={1} max={remoteTotalPages} value={pageDraft} disabled={shopsQuery.isFetching || confirmOpen || mutation.isPending} onChange={event => setPageDraft(event.target.value)} />
            <button type="submit" className="btn btn-ghost btn-sm" disabled={shopsQuery.isFetching || confirmOpen || mutation.isPending}>Ir</button>
          </form>
          <button type="button" className="btn btn-ghost btn-sm" disabled={shopPage >= remoteTotalPages || shopsQuery.isFetching || confirmOpen || mutation.isPending} onClick={() => navigateToPage(shopPage + 1)}>Siguiente</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={shopPage >= remoteTotalPages || shopsQuery.isFetching || confirmOpen || mutation.isPending} onClick={() => navigateToPage(remoteTotalPages)}>Última</button>
        </div>
      </div>}
      {operation === 'unbind' && shopSearch.trim() && cachedPageMatches.length > 0 && <div style={{ marginTop: 12, padding: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
        <strong style={{ fontSize: 12 }}>Coincidencias en páginas ya consultadas</strong>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 8 }}>
          {cachedPageMatches.map(match => <button key={`${match.pageNo}:${shopKey(match.shop)}`} type="button" className="btn btn-ghost btn-sm" disabled={confirmOpen || mutation.isPending || shopsQuery.isFetching} onClick={() => navigateToPage(match.pageNo)}>
            Pág. {match.pageNo} · {match.shop.name ?? match.shop.appShopId}
          </button>)}
        </div>
      </div>}
      {selectedListEntries.length > 0 && <div style={{ marginTop: 14, padding: 12, background: 'var(--surface-2)', borderRadius: 'var(--radius-md)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 12 }}>Selección fijada entre páginas ({selectedListEntries.length})</strong>
          <span className="text-muted" style={{ fontSize: 11 }}>Cambiar de página no elimina estas tiendas.</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 9, maxHeight: 145, overflowY: 'auto' }}>
          {selectedListEntries.map(shop => <span key={shopKey(shop)} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="td-mono">{shop.appShopId}</span>{operation === 'unbind' && <span>· pág. {shop.sourcePage}</span>}
            <button type="button" aria-label={`Quitar ${shop.appShopId}`} disabled={confirmOpen || mutation.isPending} onClick={() => removeSelectedListShop(shopKey(shop))} style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0 }}>×</button>
          </span>)}
        </div>
      </div>}
      {selectionNotice && <div className="error-banner" style={{ marginTop: 10 }}>{selectionNotice}</div>}
    </div>

    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
      {unbindRequiresListSelection ? <div style={{ ...operationNoticeStyle('unbind'), marginBottom: 10 }}>
        <strong>Unbind sólo desde el listado remoto.</strong> Elige una tienda arriba. Guaro conserva la página de origen y el backend vuelve a consultar esa misma página antes de solicitar el token o ejecutar Unbind, tanto en TEST como en PRODUCCIÓN.
      </div> : <>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 10 }}>
          <div>
            <strong>Importar o pegar lote para Bind</strong>
            <p className="text-muted" style={{ marginTop: 4, fontSize: 12 }}>CSV, TSV o TXT; una pareja <span className="td-mono">shop_id,app_shop_id</span> por línea. El encabezado es opcional.</p>
          </div>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            <span className="badge">{manual.shops.length} filas válidas</span>
            <span className="badge">{Math.max(0, BIND_MAX_SHOPS - selection.shops.length)} espacios disponibles</span>
          </div>
        </div>
        <div className="form-group" style={{ marginBottom: 8 }}>
          <label className="form-label" htmlFor="didi-bind-file">Importar archivo</label>
          <input
            id="didi-bind-file"
            className="form-input"
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            disabled={!shopsLoadRequested || shopsQuery.isError || confirmOpen || mutation.isPending}
            onChange={event => void importShopFile(event)}
          />
          <p className="form-hint">Máximo 256 KB. El archivo reemplaza el texto pegado, pero conserva las tiendas fijadas desde el catálogo.</p>
        </div>
        {importMessage && <div className={importMessage.startsWith('Error:') ? 'error-banner' : 'text-muted'} style={{ marginBottom: 9, fontSize: 12 }}>{importMessage}</div>}
        <div className="form-group" style={{ marginBottom: 8 }}>
          <label className="form-label" htmlFor="didi-bind-paste">Pegar filas</label>
          <textarea
            id="didi-bind-paste"
            className="form-input td-mono"
            rows={8}
            maxLength={MAX_IMPORT_CHARS}
            value={manualInput}
            disabled={!shopsLoadRequested || shopsQuery.isError || confirmOpen || mutation.isPending}
            placeholder={'shop_id,app_shop_id\n5764012345678901234,SUCURSAL-001\n5764012345678901235,SUCURSAL-002'}
            onChange={event => {
              setManualInput(event.target.value);
              setImportMessage('');
              setSelectionNotice('');
              resetOutput();
            }}
          />
          <p className="form-hint">Máximo {MAX_IMPORT_CHARS.toLocaleString('es-MX')} caracteres. Se eliminan duplicados exactos entre catálogo e importación. Conflictos de shop_id o app_shop_id se bloquean antes de confirmar.</p>
        </div>
      </>}
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
