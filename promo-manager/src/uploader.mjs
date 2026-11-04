import { setTimeout as delay } from 'node:timers/promises';

const SECRET_KEY = /token|authorization|secret|password|api[_-]?key/i;
const PLACEHOLDER = /^(?:\{\{.*\}\}|<.*>|PEGA[_ -]|REEMPLAZA[_ -]|CAMBIA[_ -]|YOUR[_ -]?TOKEN|INSERT[_ -]|TOKEN[_ -]?AQUI|CHANGEME)/i;
const BAD_PATH_PARTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * JSON.parse convierte enteros grandes a Number y puede redondearlos. Antes de
 * parsear, conserva cualquier entero de 16 dígitos o más como cadena. Esto es
 * obligatorio para taskID y otros identificadores de 64 bits devueltos por DiDi.
 */
export function parseJsonPreservingLargeIntegers(raw) {
  if (typeof raw !== 'string') throw new Error('La respuesta JSON debe ser texto.');
  const safe = raw.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(safe);
}

function integerOption(value, name, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} debe ser un entero mayor o igual a ${minimum}.`);
  }
  return value;
}

function endpoint(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Configura apiUrl con la URL completa de la API de promociones.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('La URL de la API debe usar HTTPS; HTTP solo se admite para pruebas en localhost.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('La URL de la API no debe contener credenciales, parámetros de consulta ni fragmentos.');
  }
  return url.href;
}

function makeRedactor(tokens) {
  const values = [...new Set(tokens.flatMap(token => [token, encodeURIComponent(token)]))]
    .sort((a, b) => b.length - a.length);
  const text = value => {
    let result = String(value);
    for (const secret of values) result = result.split(secret).join('[REDACTED]');
    return result;
  };
  const redact = value => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        text(key), SECRET_KEY.test(key) ? '[REDACTED]' : redact(item),
      ]));
    }
    return value;
  };
  return { text, redact };
}

function lookupOwn(object, path) {
  let value = object;
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      return { found: false };
    }
    value = value[key];
  }
  return { found: true, value };
}

function summary(results, stopped = false) {
  return {
    results,
    acceptedBatches: results.filter(result => result.status === 'accepted').length,
    rejectedBatches: results.filter(result => result.status === 'rejected').length,
    unknownBatches: results.filter(result => result.status === 'unknown').length,
    stopped,
  };
}

/**
 * Envia lotes en serie. "accepted" confirma únicamente el código de aceptación
 * configurado de la respuesta, no la activación final ni la aplicación por SKU.
 * Nunca reintenta un POST ni sigue una redirección. Los tokens solo se añaden
 * al cuerpo en memoria y nunca se incluyen en resultados, callbacks o mensajes.
 * continueOnFailure permite que un error aislado no detenga otros destinos.
 */
export async function uploadJobs(jobs, options = {}) {
  if (!Array.isArray(jobs)) throw new Error('jobs debe ser una lista de lotes.');
  if (jobs.length === 0) return summary([]);

  const apiUrl = endpoint(options.apiUrl);
  const timeoutMs = integerOption(options.timeoutMs ?? 30_000, 'timeoutMs', 1);
  const delayMs = integerOption(options.delayMs ?? 500, 'delayMs', 0);
  const responseSuccessPath = options.responseSuccessPath ?? 'errno';
  const responseSuccessValue = options.responseSuccessValue ?? 0;
  const continueOnFailure = options.continueOnFailure === true;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const onResult = options.onResult ?? (async () => {});
  const log = options.log ?? console.log;
  if (typeof fetchImpl !== 'function' || typeof onResult !== 'function' || typeof log !== 'function') {
    throw new Error('fetchImpl, onResult y log deben ser funciones.');
  }
  if (typeof responseSuccessPath !== 'string' || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(responseSuccessPath)) {
    throw new Error('responseSuccessPath debe ser una ruta como errno o data.errno.');
  }
  const successPathParts = responseSuccessPath.split('.');
  if (successPathParts.some(part => BAD_PATH_PARTS.has(part))) {
    throw new Error('responseSuccessPath contiene una propiedad no admitida.');
  }
  if (!['string', 'number', 'boolean'].includes(typeof responseSuccessValue)
    || (typeof responseSuccessValue === 'number' && !Number.isFinite(responseSuccessValue))) {
    throw new Error('responseSuccessValue debe ser un número, texto o booleano concreto.');
  }

  // Toda la validación se completa antes de registrar o enviar el primer lote.
  const stores = new Map();
  const tokenOwners = new Map();
  const seenJobs = new Set();
  const prepared = jobs.map((job, index) => {
    const store = job?.store;
    if (!store || typeof store.id !== 'string' || !store.id.trim()) {
      throw new Error(`Lote ${index + 1}: falta un store.id de tipo texto.`);
    }
    if (typeof store.authTokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(store.authTokenEnv)) {
      throw new Error(`Tienda ${store.id}: authTokenEnv debe indicar el nombre de una variable de entorno.`);
    }
    if (!Number.isSafeInteger(job.batchNumber) || job.batchNumber < 1) {
      throw new Error(`Tienda ${store.id}: batchNumber debe ser un entero positivo.`);
    }
    if (![0, 1].includes(store.appItemIdType)) {
      throw new Error(`Tienda ${store.id}: appItemIdType debe ser 0 o 1, según el catálogo.`);
    }
    const payload = job.payload;
    if (!payload || !Array.isArray(payload.promo_list) || payload.promo_list.length === 0) {
      throw new Error(`Tienda ${store.id}, lote ${job.batchNumber}: promo_list está vacío o no es una lista.`);
    }
    if (payload.promo_list.length > 499) {
      throw new Error(`Tienda ${store.id}, lote ${job.batchNumber}: el request contiene ${payload.promo_list.length} Activity IDs; debe contener menos de 500.`);
    }
    const requestItems = payload.promo_list.reduce((total, promotion) =>
      total + (Array.isArray(promotion?.item_activity_list) ? promotion.item_activity_list.length : 0), 0);
    if (requestItems > 5999) {
      throw new Error(`Tienda ${store.id}, lote ${job.batchNumber}: el request contiene ${requestItems} items; debe contener menos de 6000.`);
    }
    if (payload.app_item_id_type !== store.appItemIdType) {
      throw new Error(`Tienda ${store.id}: app_item_id_type del lote no coincide con la configuración de la tienda.`);
    }
    if (payload.auth_token !== undefined && payload.auth_token !== '{{auth_token}}') {
      throw new Error(`Tienda ${store.id}: los lotes deben conservar el placeholder de auth_token; usa authTokenEnv.`);
    }
    for (const promotion of payload.promo_list) {
      if (!promotion || ![1, 2].includes(promotion.action)) {
        throw new Error(`Tienda ${store.id}, lote ${job.batchNumber}: cada promoción requiere action 1 o 2.`);
      }
      if (promotion.action === 1 && (!Array.isArray(promotion.item_activity_list) || promotion.item_activity_list.length === 0)) {
        throw new Error(`Tienda ${store.id}, lote ${job.batchNumber}: action 1 requiere item_activity_list.`);
      }
      if (promotion.action === 2) {
        if (!['string', 'number'].includes(typeof promotion.activity_id) || String(promotion.activity_id).trim() === '') {
          throw new Error(`Tienda ${store.id}, lote ${job.batchNumber}: action 2 requiere activity_id.`);
        }
        const extra = Object.keys(promotion).filter(key => !['action', 'activity_id'].includes(key));
        if (extra.length) {
          throw new Error(`Tienda ${store.id}, lote ${job.batchNumber}: action 2 debe usar el payload mínimo action + activity_id.`);
        }
      }
    }
    const rawToken = env?.[store.authTokenEnv];
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (!token || PLACEHOLDER.test(token) || /\s/.test(token)) {
      throw new Error(`Falta un token válido en ${store.authTokenEnv} para la tienda ${store.id}. No se envió ningún lote.`);
    }
    const previous = stores.get(store.id);
    if (previous && (previous.token !== token || previous.authTokenEnv !== store.authTokenEnv
      || previous.appItemIdType !== store.appItemIdType)) {
      throw new Error(`La tienda ${store.id} tiene configuraciones de autenticación o catálogo inconsistentes.`);
    }
    const owner = tokenOwners.get(token);
    if (owner !== undefined && owner !== store.id) {
      throw new Error(`Las tiendas ${owner} y ${store.id} comparten el mismo token. Configura el token propio de cada destino.`);
    }
    stores.set(store.id, { token, authTokenEnv: store.authTokenEnv, appItemIdType: store.appItemIdType });
    tokenOwners.set(token, store.id);
    const jobKey = JSON.stringify([store.id, job.batchNumber]);
    if (seenJobs.has(jobKey)) throw new Error(`Lote repetido para la tienda ${store.id}: ${job.batchNumber}.`);
    seenJobs.add(jobKey);
    let requestBody;
    try { requestBody = JSON.stringify({ ...payload, auth_token: token }); }
    catch { throw new Error(`Tienda ${store.id}, lote ${job.batchNumber}: el cuerpo no es serializable a JSON.`); }
    return {
      token,
      requestBody,
      record: {
        storeId: store.id,
        storeName: typeof store.name === 'string' ? store.name : store.id,
        batchNumber: job.batchNumber,
        promotions: payload.promo_list.length,
        items: payload.promo_list.reduce((total, p) => total + (Array.isArray(p.item_activity_list) ? p.item_activity_list.length : 0), 0),
      },
    };
  });
  const { text: redactText, redact } = makeRedactor([...tokenOwners.keys()]);
  for (const token of tokenOwners.keys()) {
    if (apiUrl.includes(token) || apiUrl.includes(encodeURIComponent(token))) {
      throw new Error('La URL de la API contiene un token; utiliza únicamente authTokenEnv.');
    }
  }

  const results = [];
  for (let index = 0; index < prepared.length; index += 1) {
    const job = prepared[index];
    const record = redact({ ...job.record, startedAt: new Date().toISOString(), status: 'sending' });
    try { await onResult(record); }
    catch (error) {
      const failure = new Error(`No se pudo registrar el intento; este lote no se envió: ${redactText(error?.message ?? error)}`);
      failure.summary = summary(results, true);
      throw failure;
    }
    log(redactText(`[${job.record.storeId}] Enviando lote ${job.record.batchNumber} (${job.record.promotions} promociones).`));
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let result;
    try {
      const response = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
        body: job.requestBody,
      });
      const raw = await response.text();
      let data;
      let jsonValid = true;
      try { data = parseJsonPreservingLargeIntegers(raw); }
      catch { jsonValid = false; data = { rawBody: raw.slice(0, 16_384), truncated: raw.length > 16_384 }; }
      result = { ...record, httpStatus: response.status, response: redact(data) };
      if (!response.ok) {
        result.status = 'rejected';
        result.reason = 'http_error';
        result.message = `La API respondió HTTP ${response.status}.`;
      } else if (!jsonValid) {
        result.status = 'unknown';
        result.reason = 'invalid_json';
        result.message = 'La respuesta HTTP fue exitosa, pero no contiene un JSON válido. Revisa el resultado antes de volver a enviar.';
      } else {
        const code = lookupOwn(data, successPathParts);
        if (!code.found || !['string', 'number', 'boolean'].includes(typeof code.value)) {
          result.status = 'unknown';
          result.reason = 'unrecognized_response';
          result.message = `La respuesta no contiene un valor reconocible en ${responseSuccessPath}.`;
        } else if (!Object.is(code.value, responseSuccessValue)) {
          result.status = 'rejected';
          result.reason = 'api_error';
          result.message = `La API devolvió un código distinto del valor de aceptación configurado en ${responseSuccessPath}.`;
        } else {
          result.status = 'accepted';
          result.reason = 'api_accepted';
          result.message = 'Solicitud aceptada por la API. Consulta su respuesta para el detalle; no confirma activación final por SKU.';
        }
      }
    } catch (error) {
      result = {
        ...record,
        status: 'unknown',
        reason: timedOut ? 'timeout' : 'network_error',
        message: timedOut
          ? `La solicitud superó ${timeoutMs} ms. Su resultado es desconocido y no se reintentó.`
          : `No se obtuvo una respuesta verificable. Su resultado es desconocido y no se reintentó: ${redactText(error?.message ?? error)}`,
      };
    } finally { clearTimeout(timer); }
    result = redact({ ...result, completedAt: new Date().toISOString() });
    results.push(result);
    try { await onResult(result); }
    catch (error) {
      const failure = new Error(`La solicitud terminó, pero no se pudo registrar su resultado. No la reenvíes automáticamente: ${redactText(error?.message ?? error)}`);
      failure.summary = summary(results, true);
      throw failure;
    }
    log(redactText(`[${job.record.storeId}] Lote ${job.record.batchNumber}: ${result.status}.`));
    if (result.status !== 'accepted' && !continueOnFailure) return summary(results, true);
    if (index + 1 < prepared.length && delayMs > 0) await delay(delayMs);
  }
  return summary(results);
}
