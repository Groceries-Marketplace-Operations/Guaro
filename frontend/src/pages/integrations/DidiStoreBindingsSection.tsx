import { type ChangeEvent, type FormEvent, useDeferredValue, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { didiStoreBindingsApi } from '../../api';
import Modal from '../../components/ui/Modal';
import type {
  Application,
  DidiStoreBindingAction,
  DidiStoreBindingExecutionCreateRequest,
  DidiStoreBindingShop,
  DidiStoreBindingShopsResponse,
} from '../../types';
import ApplicationSearchField from './ApplicationSearchField';
import DidiStoreBindingExecutionsPanel from './DidiStoreBindingExecutionsPanel';

type Operation = DidiStoreBindingAction;

interface SelectedListShop extends DidiStoreBindingShop {
  sourcePage: number;
}

interface CachedShopMatch {
  pageNo: number;
  shop: DidiStoreBindingShop;
}

const MASSIVE_MAX_SHOPS = 7_000;
const BIND_PROVIDER_BATCH_SIZE = 50;
const SHOP_PAGE_SIZE = 100;
const MAX_IMPORT_BYTES = 6 * 1024 * 1024;
const MAX_IMPORT_CHARS = 2 * 1024 * 1024;
const shopIdPattern = /^57\d{17}$/;

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

function splitImportedLine(line: string) {
  const candidates = [',', '\t', ';', '|'];
  const counts = new Map(candidates.map(delimiter => [delimiter, 0]));
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && counts.has(character)) {
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }
  }
  if (quoted) return { values: [] as string[], error: 'hay una comilla sin cerrar' };
  const delimiter = candidates.reduce((best, candidate) =>
    (counts.get(candidate) ?? 0) > (counts.get(best) ?? 0) ? candidate : best, candidates[0]);
  if ((counts.get(delimiter) ?? 0) === 0) return { values: line.trim().split(/\s+/), error: '' };

  const values: string[] = [];
  let value = '';
  quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === delimiter) {
      values.push(value.trim());
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return { values, error: '' };
}

function parseManualShops(value: string, operation: Operation) {
  const shops: SelectedListShop[] = [];
  const errors: string[] = [];
  const byShopId = new Map<string, DidiStoreBindingShop>();
  const byAppShopId = new Map<string, DidiStoreBindingShop>();

  value.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    if (/^shop_?id(?:\s*[,;|\t]\s*|\s+)app_?shop_?id(?:\s*[,;|\t]\s*|\s+remote_?page_?no)?$/i.test(line)) return;

    const parsed = splitImportedLine(line);
    if (parsed.error) {
      errors.push(`Línea ${index + 1}: ${parsed.error}.`);
      return;
    }
    const values = parsed.values;
    const normalizedHeader = values.map(item => item.toLowerCase().replace(/[^a-z]/g, ''));
    if (normalizedHeader[0] === 'shopid' && normalizedHeader[1] === 'appshopid'
      && (operation === 'bind' || normalizedHeader[2] === 'remotepageno')) return;
    const expectedColumns = operation === 'unbind' ? 3 : 2;
    if (values.length !== expectedColumns) {
      errors.push(`Línea ${index + 1}: usa ${operation === 'unbind' ? 'shop_id,app_shop_id,remote_page_no' : 'shop_id,app_shop_id'}.`);
      return;
    }

    const [shopId, appShopId, remotePageRaw] = values.map(item => item.trim());
    if (!shopIdPattern.test(shopId)) {
      errors.push(`Línea ${index + 1}: shop_id debe tener 19 dígitos y comenzar con 57.`);
      return;
    }
    if (!appShopId || appShopId.length > 128) {
      errors.push(`Línea ${index + 1}: app_shop_id es obligatorio y admite hasta 128 caracteres.`);
      return;
    }
    const remotePageNo = operation === 'unbind' ? Number(remotePageRaw) : 1;
    if (operation === 'unbind' && (!Number.isInteger(remotePageNo) || remotePageNo < 1 || remotePageNo > 10_000)) {
      errors.push(`Línea ${index + 1}: remote_page_no debe ser un entero entre 1 y 10000.`);
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
      const shop = { shopId, appShopId, sourcePage: remotePageNo };
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

function newIdempotencyKey() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
  return operation === 'unbind' && count === 1
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
  const [batchError, setBatchError] = useState('');
  const [activeExecutionId, setActiveExecutionId] = useState<string>();
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const maxShops = MASSIVE_MAX_SHOPS;
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

  const manual = useMemo(() => parseManualShops(manualInput, operation), [manualInput, operation]);
  const selection = useMemo(() => {
    const shops: SelectedListShop[] = [];
    const byShopId = new Map<string, SelectedListShop>();
    const byAppShopId = new Map<string, SelectedListShop>();
    const errors = [...manual.errors];

    const addShop = (shop: SelectedListShop, source: string) => {
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
      errors.push(`El máximo por operación masiva es de ${maxShops.toLocaleString('es-MX')} tiendas.`);
    }
    return { shops, errors };
  }, [manual, maxShops, selectedListShops]);

  const resetOutput = () => {
    setBatchError('');
    setIdempotencyKey(newIdempotencyKey());
  };

  const mutation = useMutation({
    mutationFn: (request: DidiStoreBindingExecutionCreateRequest) =>
      didiStoreBindingsApi.createExecution(request),
    retry: false,
    onSuccess: (response, variables) => {
      setActiveExecutionId(response.data.execution.id);
      setConfirmOpen(false);
      setConfirmation('');
      setRiskAcknowledged(false);
      setProductionReason('');
      setSelectedListShops(new Map());
      setManualInput('');
      setImportMessage('');
      setSelectionNotice('');
      setBatchError('');
      setIdempotencyKey(newIdempotencyKey());
      void queryClient.invalidateQueries({
        queryKey: ['didi-store-bindings', 'shops', variables.applicationId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['didi-store-bindings', 'executions', variables.applicationId],
      });
    },
    onError: reason => {
      setBatchError(`${apiError(reason, 'No se pudo confirmar la creación de la operación.')} La clave idempotente se conserva: puedes volver a enviarla sin duplicar el trabajo.`);
    },
  });

  const selectAllMutation = useMutation({
    mutationFn: () => didiStoreBindingsApi.selection(applicationId, shopSearch.trim()),
    onSuccess: response => {
      if (response.data.application?.id !== applicationId) {
        setSelectionNotice('La respuesta no coincide con la aplicación seleccionada; no se modificó la selección.');
        return;
      }
      const next = new Map(selectedListShops);
      const combinedKeys = new Set(selection.shops.map(shopKey));
      let added = 0;
      let omittedByLimit = 0;
      for (const shop of response.data.shops) {
        if (!shop.shopId || !shop.appShopId || shop.mappingConflict || !isEligible(shop, 'bind')) continue;
        const key = shopKey(shop);
        if (combinedKeys.has(key)) continue;
        if (combinedKeys.size >= MASSIVE_MAX_SHOPS) {
          omittedByLimit += 1;
          continue;
        }
        next.set(shopKey(shop), { ...shop, sourcePage: 1 });
        combinedKeys.add(key);
        added += 1;
      }
      setSelectedListShops(next);
      setSelectionNotice([
        `${added.toLocaleString('es-MX')} coincidencia(s) agregadas; se conservaron las selecciones previas.`,
        response.data.conflicts ? `${response.data.conflicts.toLocaleString('es-MX')} conflicto(s) quedaron bloqueados.` : '',
        omittedByLimit ? `${omittedByLimit.toLocaleString('es-MX')} coincidencia(s) no se agregaron por el límite del trabajo.` : '',
        response.data.truncated ? `La selección fue truncada al máximo de ${response.data.max.toLocaleString('es-MX')}.` : '',
      ].filter(Boolean).join(' '));
      resetOutput();
    },
    onError: reason => setSelectionNotice(apiError(reason, 'No se pudieron seleccionar todas las coincidencias.')),
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
    setActiveExecutionId(undefined);
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
    setActiveExecutionId(undefined);
    resetOutput();
  };

  const toggleShop = (shop: DidiStoreBindingShop) => {
    if (confirmOpen || mutation.isPending) return;
    const key = shopKey(shop);
    if (!selectedListShops.has(key) && selection.shops.length >= MASSIVE_MAX_SHOPS) {
      setSelectionNotice(`Ya alcanzaste el máximo de ${MASSIVE_MAX_SHOPS.toLocaleString('es-MX')} tiendas. Quita una selección o una fila importada para agregar otra.`);
      return;
    }
    const sourcePage = authoritativeResponse?.pageNo ?? shopPage;
    setSelectedListShops(current => {
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
    let remaining = Math.max(0, MASSIVE_MAX_SHOPS - selection.shops.length);
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
      ? `Se conservó el límite de ${MASSIVE_MAX_SHOPS.toLocaleString('es-MX')}; ${eligibleNotAdded} tienda(s) visibles no se agregaron.`
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
  const selectedListEntries = useMemo(() => [...selectedListShops.values()], [selectedListShops]);
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
    () => isProduction && selection.shops.length > 0 && (operation === 'bind' || selection.shops.length > 1)
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
    batchFingerprint || undefined,
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
    && (operation !== 'unbind' || selection.shops.every(shop => Number.isInteger(shop.sourcePage) && shop.sourcePage >= 1 && shop.sourcePage <= 10_000))
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
    if (!file || confirmOpen || mutation.isPending) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setImportMessage('Error: el archivo supera 6 MB. Divide o simplifica el archivo sin superar 7,000 tiendas.');
      return;
    }
    try {
      const contents = await file.text();
      if (!contents.trim()) {
        setImportMessage('Error: el archivo está vacío.');
        return;
      }
      if (contents.length > MAX_IMPORT_CHARS) {
        setImportMessage('Error: el archivo supera 2 millones de caracteres. Divide o simplifica el archivo.');
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
    const request: DidiStoreBindingExecutionCreateRequest = {
      idempotencyKey,
      applicationId,
      action: operation,
      shops: selection.shops.map(shop => ({
        shopId: shop.shopId,
        appShopId: shop.appShopId,
        ...(operation === 'unbind' ? { remotePageNo: shop.sourcePage } : {}),
      })),
      confirmation,
      ...(isProduction ? {
        reason: productionReason.trim(),
        productionAcknowledged: true,
      } : {}),
    };
    setBatchError('');
    mutation.mutate(request);
  };

  const loadFailedForReview = (action: DidiStoreBindingAction, shops: SelectedListShop[]) => {
    setOperation(action);
    setSelectedListShops(new Map(shops.slice(0, MASSIVE_MAX_SHOPS).map(shop => [shopKey(shop), shop])));
    setManualInput('');
    setImportMessage('');
    setShopSearch('');
    setShopPage(1);
    setPageDraft('1');
    setSelectionNotice(`${shops.length.toLocaleString('es-MX')} fallida(s) definitiva(s) cargadas. Revísalas y confirma manualmente; no se ejecutó ningún reintento.`);
    setConfirmOpen(false);
    setConfirmation('');
    setRiskAcknowledged(false);
    setProductionReason('');
    resetOutput();
  };

  const unbindRemotePages = operation === 'unbind'
    ? new Set(selection.shops.map(shop => shop.sourcePage)).size
    : 0;
  const unbindListEstimateMinutes = Math.ceil((unbindRemotePages * 20) / 60);

  return <section style={{ marginBottom: 22 }}>
    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ maxWidth: 760 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong>DiDi Bind / Unbind masivo</strong>
            <span className="badge" style={{ color: 'var(--amber-text)' }}>TEST / PROD</span>
            <span className="badge">Hasta {MASSIVE_MAX_SHOPS.toLocaleString('es-MX')} tiendas</span>
            <span className="badge">Trabajo en segundo plano</span>
          </div>
          <p className="text-muted" style={{ marginTop: 7, fontSize: 12 }}>
            Prepara, confirma una vez y sigue el avance sin mantener abierta esta pantalla. DiDi recibe Bind en lotes internos de {BIND_PROVIDER_BATCH_SIZE} y Unbind una tienda a la vez. En producción se conserva la confirmación reforzada y la auditoría.
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
        ? `Bind usa el catálogo local de Guaro. Puedes seleccionar hasta ${MASSIVE_MAX_SHOPS.toLocaleString('es-MX')} coincidencias o importarlas; el backend las enviará a DiDi en lotes de ${BIND_PROVIDER_BATCH_SIZE}.`
        : 'Unbind admite hasta 7,000 tiendas y requiere la página remota exacta de cada una. El backend agrupa las tiendas por página, recorre las páginas de mayor a menor y ejecuta cada Unbind individualmente después de revalidarla.'}
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
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={confirmOpen || mutation.isPending || !visibleShops.some(shop => isEligible(shop, operation))} onClick={selectVisible}>Seleccionar página</button>
          {operation === 'bind' && <button type="button" className="btn btn-ghost btn-sm" disabled={confirmOpen || mutation.isPending || selectAllMutation.isPending || !shopsLoadRequested || shopsQuery.isError} onClick={() => selectAllMutation.mutate()}>
            {selectAllMutation.isPending ? 'Seleccionando…' : shopSearch.trim() ? 'Seleccionar todas las coincidencias' : 'Seleccionar todo el catálogo'}
          </button>}
          <button type="button" className="btn btn-ghost btn-sm" disabled={confirmOpen || mutation.isPending || (selectedListShops.size === 0 && !manualInput)} onClick={clearSelection}>Limpiar selección</button>
        </div>
      </div>

      {authoritativeResponse && <div role="status" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="badge">{remoteTotal.toLocaleString('es-MX')} {shopSearch.trim() && operation === 'bind' ? 'coincidencias' : 'tiendas'}</span>
        <span className="badge">{availableShops.length.toLocaleString('es-MX')} en esta página</span>
        <span className="badge">{remotePageSize} por página</span>
        <span className="badge">Página {currentPageNo.toLocaleString('es-MX')} / {remoteTotalPages.toLocaleString('es-MX')}</span>
        <span className="badge" style={{ color: selection.shops.length >= maxShops ? 'var(--amber-text)' : undefined }}>{selection.shops.length.toLocaleString('es-MX')} / {maxShops.toLocaleString('es-MX')} seleccionadas</span>
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
              <td><input type="checkbox" checked={selectedListShops.has(key)} disabled={!eligible || confirmOpen || mutation.isPending} aria-label={`Seleccionar ${shop.name ?? shop.shopId} para ${operation === 'bind' ? 'Bind' : 'Unbind'}`} onChange={() => toggleShop(shop)} /></td>
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
          <strong style={{ fontSize: 12 }}>Selección fijada entre páginas ({selectedListEntries.length.toLocaleString('es-MX')})</strong>
          <span className="text-muted" style={{ fontSize: 11 }}>Vista previa de hasta 100; cambiar de página no elimina la selección.</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 9, maxHeight: 145, overflowY: 'auto' }}>
          {selectedListEntries.slice(0, 100).map(shop => <span key={shopKey(shop)} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="td-mono">{shop.appShopId}</span>{operation === 'unbind' && <span>· pág. {shop.sourcePage}</span>}
            <button type="button" aria-label={`Quitar ${shop.appShopId}`} disabled={confirmOpen || mutation.isPending} onClick={() => removeSelectedListShop(shopKey(shop))} style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0 }}>×</button>
          </span>)}
          {selectedListEntries.length > 100 && <span className="badge">+ {(selectedListEntries.length - 100).toLocaleString('es-MX')} no mostradas</span>}
        </div>
      </div>}
      {selectionNotice && <div className="error-banner" style={{ marginTop: 10 }}>{selectionNotice}</div>}
    </div>

    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 10 }}>
        <div>
          <strong>Importar o pegar lote para {operation === 'bind' ? 'Bind' : 'Unbind'}</strong>
          <p className="text-muted" style={{ marginTop: 4, fontSize: 12 }}>
            CSV, TSV o TXT; usa <span className="td-mono">shop_id,app_shop_id{operation === 'unbind' ? ',remote_page_no' : ''}</span>. El encabezado es opcional.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          <span className="badge">{manual.shops.length.toLocaleString('es-MX')} filas válidas</span>
          <span className="badge">{Math.max(0, MASSIVE_MAX_SHOPS - selection.shops.length).toLocaleString('es-MX')} espacios disponibles</span>
        </div>
      </div>
      {operation === 'unbind' && <div style={{ ...operationNoticeStyle('unbind'), marginBottom: 12 }}>
        Cada fila importada de Unbind debe indicar la página donde fue observada en el listado remoto. Guaro la volverá a consultar antes de modificar la tienda; nunca adivina la página.
      </div>}
      <div className="form-group" style={{ marginBottom: 8 }}>
        <label className="form-label" htmlFor="didi-binding-file">Importar archivo</label>
        <input
          id="didi-binding-file"
          className="form-input"
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
          disabled={!shopsLoadRequested || shopsQuery.isError || confirmOpen || mutation.isPending}
          onChange={event => void importShopFile(event)}
        />
        <p className="form-hint">Máximo 6 MB y 7,000 tiendas. El archivo reemplaza el texto pegado, pero conserva las tiendas fijadas desde el listado.</p>
      </div>
      {importMessage && <div className={importMessage.startsWith('Error:') ? 'error-banner' : 'text-muted'} style={{ marginBottom: 9, fontSize: 12 }}>{importMessage}</div>}
      <div className="form-group" style={{ marginBottom: 8 }}>
        <label className="form-label" htmlFor="didi-binding-paste">Pegar filas</label>
        <textarea
          id="didi-binding-paste"
          className="form-input td-mono"
          rows={8}
          maxLength={MAX_IMPORT_CHARS}
          value={manualInput}
          disabled={!shopsLoadRequested || shopsQuery.isError || confirmOpen || mutation.isPending}
          placeholder={operation === 'bind'
            ? 'shop_id,app_shop_id\n5764012345678901234,SUCURSAL-001\n5764012345678901235,SUCURSAL-002'
            : 'shop_id,app_shop_id,remote_page_no\n5764012345678901234,SUCURSAL-001,3\n5764012345678901235,SUCURSAL-002,8'}
          onChange={event => {
            setManualInput(event.target.value);
            setImportMessage('');
            setSelectionNotice('');
            resetOutput();
          }}
        />
        <p className="form-hint">Se eliminan duplicados exactos. IDs repetidos con mapeos distintos, páginas inválidas y conflictos del catálogo se bloquean antes de confirmar.</p>
      </div>
      {canonicalProductionBatch && !batchFingerprint && !fingerprintError && <p className="text-muted" style={{ fontSize: 12 }}>Calculando fingerprint SHA-256 del lote de producción…</p>}
      {batchFingerprint && <p className="text-muted td-mono" style={{ fontSize: 12 }}>Fingerprint del lote: {batchFingerprint}</p>}
      {fingerprintError && <div className="error-banner">No es seguro continuar: {fingerprintError}</div>}
      {selection.errors.length > 0 && <div className="error-banner">
        {selection.errors.slice(0, 5).map((error, index) => <div key={`${index}:${error}`}>{error}</div>)}
        {selection.errors.length > 5 && <div>Y {selection.errors.length - 5} error(es) más.</div>}
      </div>}
      {operation === 'bind' && selection.shops.length > 0 && <p className="text-muted" style={{ marginBottom: 10, fontSize: 12 }}>
        DiDi procesará internamente {Math.ceil(selection.shops.length / BIND_PROVIDER_BATCH_SIZE).toLocaleString('es-MX')} lote(s) de hasta {BIND_PROVIDER_BATCH_SIZE} tiendas.
      </p>}
      {operation === 'unbind' && selection.shops.length > 0 && <p className="text-muted" style={{ marginBottom: 10, fontSize: 12 }}>
        {selection.shops.length.toLocaleString('es-MX')} Unbind individual(es) en {unbindRemotePages.toLocaleString('es-MX')} página(s), procesadas de mayor a menor. Sólo la revalidación del listado puede requerir aproximadamente {unbindListEstimateMinutes} min por el límite de DiDi de una página cada 20 s; el tiempo total será mayor por los Unbind individuales.
      </p>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span className="text-muted" style={{ fontSize: 12 }}>{selection.shops.length.toLocaleString('es-MX')}/{maxShops.toLocaleString('es-MX')} tienda(s) listas para {operation === 'bind' ? 'vincular' : 'desvincular'}.</span>
        <button type="button" className="btn btn-primary" style={operation === 'unbind' || isProduction ? { background: 'var(--red-text)', borderColor: 'var(--red-text)' } : undefined} disabled={!canReview} onClick={() => { setConfirmation(''); setRiskAcknowledged(false); setProductionReason(''); setConfirmOpen(true); }}>
          Revisar y confirmar
        </button>
      </div>
    </div>

    {batchError && <div className="error-banner">{batchError}</div>}
    <DidiStoreBindingExecutionsPanel
      key={activeExecutionId ?? applicationId}
      applicationId={applicationId}
      activeExecutionId={activeExecutionId}
      onActiveExecutionChange={setActiveExecutionId}
      onLoadFailed={loadFailedForReview}
    />

    {confirmOpen && <Modal title={`${isProduction ? 'PRODUCCIÓN · ' : ''}${operation === 'bind' ? 'Confirmar Bind masivo' : 'Confirmar Unbind masivo'}`} onClose={() => { if (!mutation.isPending) setConfirmOpen(false); }} footer={<>
      <button className="btn btn-ghost" disabled={mutation.isPending} onClick={() => setConfirmOpen(false)}>Cancelar</button>
      <button className="btn btn-primary" style={operation === 'unbind' || isProduction ? { background: 'var(--red-text)', borderColor: 'var(--red-text)' } : undefined} disabled={!canExecute || !canReview} onClick={execute}>
        {mutation.isPending ? 'Creando operación…' : mutation.isError ? 'Reenviar de forma segura' : 'Crear operación masiva'}
      </button>
    </>}>
      <div style={operationNoticeStyle(operation)}>
        {operation === 'bind'
          ? `Se pondrán en cola ${selection.shops.length.toLocaleString('es-MX')} tienda(s) en ${application?.appName}, divididas en ${Math.ceil(selection.shops.length / BIND_PROVIDER_BATCH_SIZE).toLocaleString('es-MX')} lote(s) internos. Los resultados pueden ser parciales.`
          : `Se pondrán en cola ${selection.shops.length.toLocaleString('es-MX')} Unbind individual(es) de ${application?.appName}, agrupados en ${unbindRemotePages.toLocaleString('es-MX')} página(s) y procesados de mayor a menor. Esta acción puede interrumpir su operación en DiDi.`}
      </div>
      <p className="text-muted td-mono" style={{ marginBottom: 12, fontSize: 12 }}>
        Entorno {environment?.toUpperCase()} · {authoritativeApplication?.appName} · App ID {authoritativeApplication?.appId} · {authoritativeApplication?.country}
      </p>
      <p className="text-muted" style={{ marginBottom: 8, fontSize: 11 }}>Vista previa de las primeras {Math.min(100, selection.shops.length).toLocaleString('es-MX')} de {selection.shops.length.toLocaleString('es-MX')} tiendas.</p>
      <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 14 }}><table>
        <thead><tr><th>Shop ID</th><th>App Shop ID</th>{operation === 'unbind' && <th>Página DiDi</th>}</tr></thead>
        <tbody>{selection.shops.slice(0, 100).map(shop => <tr key={shopKey(shop)}><td className="td-mono">{shop.shopId}</td><td className="td-mono">{shop.appShopId}</td>{operation === 'unbind' && <td>{shop.sourcePage}</td>}</tr>)}</tbody>
      </table></div>
      {selection.shops.length > 100 && <p className="text-muted" style={{ margin: '-6px 0 14px', fontSize: 11 }}>{(selection.shops.length - 100).toLocaleString('es-MX')} tienda(s) adicionales no se renderizan en la vista previa; sí forman parte de la operación.</p>}
      {requiresRiskAcknowledgement && <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginBottom: 14 }}>
        <input type="checkbox" checked={riskAcknowledged} onChange={event => setRiskAcknowledged(event.target.checked)} />
        <span>{isProduction
          ? `Confirmo que ${operation === 'bind' ? 'Bind' : 'Unbind'} está autorizado para esta aplicación de PRODUCCIÓN y acepto el impacto operativo.`
          : 'Entiendo que Unbind es destructivo y confirmé que estas tiendas pueden perder acceso a menú, stock y pedidos.'}</span>
      </label>}
      {batchError && <div className="error-banner" style={{ marginBottom: 12 }}>{batchError}</div>}
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
