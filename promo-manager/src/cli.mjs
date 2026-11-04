#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { loadPromotions } from './converter.mjs';
import { normalizeConfig, makePreviewConfig, buildPlan, replacePlannedActivityIds } from './planner.mjs';
import { uploadJobs } from './uploader.mjs';

const HELP = `
PROMOCIONES DIDI: CSV/XLSX/XLS -> JSON/API

Menú interactivo:
  npm start
  node src/cli.mjs --interactive --file "archivo.xlsx"

Vista previa (predeterminada; genera JSON):
  node src/cli.mjs --file "archivo.csv" --config stores.json --stores tienda_a

Opciones:
  --file, -f RUTA             CSV, TXT delimitado, TSV, XLSX o XLS.
  --config RUTA              Configuración de destinos; por defecto stores.json.
  --stores ID,ID | all       Tiendas destino definidas en la configuración.
  --source-shops ID,ID       Filtrar shopid del archivo origen.
  --types 4,8 | all          Tipos seleccionados. Predeterminado: 4,8.
  --ids ID,ID                Solo esos ActivityID, completos con todos sus SKU.
  --ids-file RUTA            Archivo JSON (arreglo de strings) o TXT, un ID por línea.
  --exclude-ids ID,ID        Omitir ActivityID indicados.
  --new-id ID                Cambiar manualmente el ID; requiere una sola promoción.
  --random-id                Generar un ID numérico aleatorio nuevo por promoción.
  --search TEXTO            Filtrar por fragmento del nombre de promoción.
  --list                    Mostrar catálogo de promociones; no envía solicitudes.
  --batch-size N            Máximo de Activity IDs/request. Predeterminado: 499.
  --max-items N             Máximo de ítems/lote. Predeterminado: 5999.
  --item-id-type 0|1         app_item_id_type según el catálogo/API.
  --money-unit pesos|cents   Unidad de los importes del archivo. Default: pesos.
  --sheet NOMBRE            Hoja de Excel; necesaria si hay varias hojas con datos.
  --header-row N            CSV: fila inicial (encabezado o primer dato). Excel: encabezado. Default: 1.
  --delimiter CARACTER      Separador CSV; se detecta si se omite. Acepta \\t.
  --encoding utf-8|windows-1252  Codificación del CSV. Default: utf-8.
  --out DIRECTORIO          Carpeta de resultados. Default: output.
  --env-file RUTA           Variables de entorno. Default: .env (opcional).
  --send                    Enviar los lotes a la API configurada.
  --dry-run                 Generar archivos únicamente (modo predeterminado).
  --interactive, -i         Elegir promociones, tiendas y acción mediante menú.
  --help, -h                Mostrar esta ayuda.

Un ActivityID mantiene sus SKU agrupados. Los IDs originales se conservan.
El destino se determina por su auth_token; no se agrega shopid al body de la API.
`;

function list(value, allowAll = false) {
  if (value === undefined || (value === 'all' && allowAll)) return [];
  const result = [...new Set(value.split(',').map(s => s.trim()).filter(Boolean))];
  if (!result.length) throw new Error('La selección está vacía. Omite el parámetro para seleccionar todos.');
  return result;
}

function numberOption(value, name) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${name} debe ser un número entero.`);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} está fuera de rango.`);
  return n;
}

function typeList(value) {
  if (value === undefined || value === '') return undefined;
  if (value === 'all') return [2, 4, 8];
  const values = list(value);
  if (!values.length || values.some(v => !['2', '4', '8'].includes(v))) throw new Error('Usa --types 4,8 o --types all (2,4,8).');
  return values.map(Number);
}

function unquote(value) {
  const text = value.trim();
  return (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")) ? text.slice(1, -1) : text;
}

async function readConfiguration(file, explicit) {
  try {
    return { config: normalizeConfig(JSON.parse(await fs.readFile(file, 'utf8'))), configured: true };
  } catch (error) {
    if (error.code === 'ENOENT' && !explicit) return { config: normalizeConfig(), configured: false };
    if (error instanceof SyntaxError) throw new Error(`JSON inválido en ${file}: ${error.message}`);
    throw error;
  }
}

async function readIdFile(file) {
  if (!file) return [];
  const content = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '').trim();
  if (!content) throw new Error('El archivo de IDs está vacío.');
  if (content.startsWith('[')) {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed) || !parsed.length || parsed.some(x => typeof x !== 'string' || !x.trim())) {
      throw new Error('El archivo JSON de IDs debe ser un arreglo de cadenas.');
    }
    return [...new Set(parsed.map(x => x.trim()))];
  }
  const ids = [...new Set(content.split(/[\r\n,]+/).map(x => x.trim()).filter(Boolean))];
  if (!ids.length) throw new Error('El archivo de IDs no contiene identificadores.');
  return ids;
}

async function saveJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

async function atomicJson(file, data) {
  const temp = `${file}.tmp`;
  await saveJson(temp, data);
  await fs.rename(temp, file);
}

function catalog(promotions) {
  return promotions.map(p => ({
    source_shopid: p.sourceShopId,
    activity_id: p.payload.activity_id,
    activity_type: p.payload.activity_type,
    activity_name: p.payload.activity_name,
    start_date: p.payload.start_date,
    end_date: p.payload.end_date,
    items: p.payload.item_activity_list.length,
    app_item_ids: p.payload.item_activity_list.map(i => i.app_item_id),
  }));
}

function showCatalog(entries) {
  for (const p of entries) {
    console.log(`${p.source_shopid}\t${p.activity_id}\ttipo ${p.activity_type}\t${p.items} ítems\t${p.activity_name.replace(/[\r\n\t]/g, ' ')}`);
  }
}

async function newOutputDirectory(root) {
  const absolute = path.resolve(root);
  await fs.mkdir(absolute, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return fs.mkdtemp(path.join(absolute, `run-${stamp}-`));
}

function stopInventory(plan, createdAt) {
  const stores = new Map();
  for (const job of plan.jobs) {
    if (!stores.has(job.store.id)) stores.set(job.store.id, { store: job.store, promotions: new Map() });
    const entry = stores.get(job.store.id);
    for (const promotion of job.payload.promo_list) {
      if (promotion.action !== 1) continue;
      const activityId = String(promotion.activity_id);
      const previous = entry.promotions.get(activityId);
      if (previous) {
        if (!previous.batchNumbers.includes(job.batchNumber)) previous.batchNumbers.push(job.batchNumber);
        continue;
      }
      entry.promotions.set(activityId, {
        activityId,
        activityName: promotion.activity_name,
        activityType: promotion.activity_type,
        startDate: promotion.start_date,
        endDate: promotion.end_date,
        batchNumbers: [job.batchNumber],
      });
    }
  }
  return {
    version: 1,
    createdAt,
    warning: 'Inventario de referencia. No detiene promociones automáticamente; revisa los Task ID y confirma el destino antes de usar action 2.',
    stores: [...stores.values()].map(({ store, promotions: promotionMap }) => {
      const promotions = [...promotionMap.values()];
      const stopRequests = [];
      for (let index = 0; index < promotions.length; index += 499) {
        stopRequests.push({
          auth_token: '{{auth_token}}',
          app_item_id_type: store.appItemIdType,
          promo_list: promotions.slice(index, index + 499).map(promotion => ({ action: 2, activity_id: promotion.activityId })),
        });
      }
      return {
        id: store.id,
        name: store.name,
        shopId: store.shopId ?? '',
        appShopId: store.appShopId ?? '',
        promotions,
        stopRequests,
      };
    }),
  };
}

async function exportPlan(dataset, plan, sourceFile, directory) {
  const catalogEntries = catalog(dataset.promotions);
  await saveJson(path.join(directory, 'catalogo_promociones.json'), catalogEntries);
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    mode: 'preview',
    source: { ...dataset.meta, fileName: path.basename(sourceFile), sha256: createHash('sha256').update(await fs.readFile(sourceFile)).digest('hex') },
    sourceStats: dataset.stats,
    selection: plan.selection,
    totals: plan.totals,
    warnings: [...dataset.warnings, ...plan.warnings],
    stores: plan.stores,
    jobs: [],
  };
  for (const job of plan.jobs) {
    const storeDirectory = `tienda_${job.store.id}`;
    const name = `lote_${String(job.batchNumber).padStart(3, '0')}.json`;
    await fs.mkdir(path.join(directory, storeDirectory), { recursive: true });
    await saveJson(path.join(directory, storeDirectory, name), job.payload);
    manifest.jobs.push({
      storeId: job.store.id,
      storeName: job.store.name,
      tokenEnv: job.store.authTokenEnv,
      appItemIdType: job.store.appItemIdType,
      sourceShopIds: job.sourceShopIds,
      batchNumber: job.batchNumber,
      promotions: job.payload.promo_list.length,
      items: job.payload.promo_list.reduce((n, p) => n + (p.item_activity_list?.length ?? 0), 0),
      activityIds: job.payload.promo_list.map(p => p.activity_id),
      activities: job.payload.promo_list.map(p => ({
        action: p.action,
        activityId: String(p.activity_id),
        activityName: p.activity_name ?? null,
        activityType: p.activity_type ?? null,
      })),
      file: `${storeDirectory}/${name}`,
    });
  }
  manifest.files = {
    catalog: 'catalogo_promociones.json',
    stopInventory: 'promociones_para_detener.json',
    events: 'eventos.jsonl',
  };
  await saveJson(path.join(directory, 'promociones_para_detener.json'), stopInventory(plan, manifest.createdAt));
  await saveJson(path.join(directory, 'manifest.json'), manifest);
  await appendEvent(path.join(directory, 'eventos.jsonl'), {
    recordedAt: new Date().toISOString(),
    event: 'preview_generated',
    requests: plan.totals.requests,
    stores: plan.totals.stores,
    promotions: plan.totals.promotions,
    items: plan.totals.items,
  });
  return manifest;
}

async function appendEvent(file, event) {
  const handle = await fs.open(file, 'a', 0o600);
  try {
    await handle.writeFile(JSON.stringify(event) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main() {
  const { values: v } = parseArgs({
    strict: true,
    options: {
      file: { type: 'string', short: 'f' }, config: { type: 'string' }, stores: { type: 'string' },
      'source-shops': { type: 'string' }, types: { type: 'string' }, ids: { type: 'string' },
      'ids-file': { type: 'string' }, 'exclude-ids': { type: 'string' }, search: { type: 'string' },
      'new-id': { type: 'string' }, 'random-id': { type: 'boolean' },
      list: { type: 'boolean' }, 'batch-size': { type: 'string' }, 'max-items': { type: 'string' },
      'item-id-type': { type: 'string' }, 'money-unit': { type: 'string' }, sheet: { type: 'string' },
      'header-row': { type: 'string' }, delimiter: { type: 'string' }, encoding: { type: 'string' },
      out: { type: 'string' }, 'env-file': { type: 'string' }, send: { type: 'boolean' },
      'dry-run': { type: 'boolean' }, interactive: { type: 'boolean', short: 'i' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (v.help) { console.log(HELP); return; }
  if (v.send && v['dry-run']) throw new Error('Elige --send o --dry-run, no ambos.');
  if (v.send && v.list) throw new Error('--list muestra el catálogo; no se combina con --send.');
  if (v['new-id'] !== undefined && v['random-id']) throw new Error('Usa --new-id o --random-id, no ambos.');
  const interactive = v.interactive || process.argv.length === 2;
  if (interactive && !process.stdin.isTTY) throw new Error('El menú necesita una terminal. Usa --file y las opciones de --help.');
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    console.log('Promociones DiDi | CSV/XLSX/XLS');
    if (!v.file && rl) v.file = unquote(await rl.question('Archivo CSV/XLSX/XLS: '));
    if (!v.file) throw new Error('Indica --file "ruta/al/archivo.csv".');
    if (rl && !v.config) {
      const answer = unquote(await rl.question('Configuración de tiendas [stores.json]: '));
      if (answer) v.config = answer;
    }
    const configPath = path.resolve(v.config ?? 'stores.json');
    let { config, configured } = await readConfiguration(configPath, Boolean(v.config));
    const envPath = path.resolve(v['env-file'] ?? '.env');
    try { process.loadEnvFile(envPath); }
    catch (error) { if (error.code !== 'ENOENT' || v['env-file']) throw error; }
    const dataset = await loadPromotions(path.resolve(v.file), {
      sheet: v.sheet,
      headerRow: numberOption(v['header-row'], 'header-row') ?? 1,
      delimiter: v.delimiter === '\\t' ? '\t' : v.delimiter,
      encoding: v.encoding ?? 'utf-8',
      moneyUnit: v['money-unit'] ?? config.defaults.moneyUnit,
    });
    if (dataset.duplicateItemConflicts?.length) {
      throw new Error(`El archivo contiene ${dataset.duplicateItemConflicts.length} UPC repetidos que requieren elegir una fila. Usa el frontend local para resolverlos antes de generar JSON.`);
    }
    if (dataset.zeroDiscountItems?.length) {
      throw new Error(`El archivo contiene ${dataset.zeroDiscountItems.length} filas con descuento de 0% que requieren elegir entre omitir o conservar. Usa el frontend local para resolverlas.`);
    }
    if (dataset.unsupportedPercentageItems?.length) {
      throw new Error(`El archivo contiene ${dataset.unsupportedPercentageItems.length} filas con discount_perc fuera del rango de 5 a 99 aceptado por DiDi. Usa el frontend local para omitirlas antes de generar JSON.`);
    }
    console.log(`Archivo: ${dataset.stats.promotions} promociones; ${dataset.stats.items} ítems; orígenes: ${dataset.stats.sourceShops.join(', ')}.`);
    console.table(dataset.stats.byType);
    if (!configured || !config.stores.length) {
      configured = false;
      config = makePreviewConfig(dataset.stats.sourceShops, config.defaults);
      console.log('Sin tiendas configuradas: se generarán JSON por origen. Para enviar, completa stores.json.');
    }
    if (rl) {
      if (!v.types) v.types = (await rl.question(`Tipos de promoción [${config.defaults.types.join(',')}]; all = 2,4,8: `)).trim() || config.defaults.types.join(',');
      if (!v['source-shops'] && dataset.stats.sourceShops.length > 1) v['source-shops'] = (await rl.question('Tiendas origen (IDs separados por coma; Enter = todas): ')).trim() || undefined;
      if (!v.ids && !v['ids-file'] && !v.search) {
        console.log('Selección: 1) Todas las promociones de esos tipos  2) Elegir ActivityID  3) Buscar por nombre');
        const mode = (await rl.question('Opción [1]: ')).trim() || '1';
        if (mode === '2') {
          showCatalog(catalog(dataset.promotions.filter(p => typeList(v.types).includes(p.payload.activity_type))));
          v.ids = (await rl.question('ActivityID separados por coma: ')).trim();
          if (!v.ids) throw new Error('No seleccionaste ActivityID.');
        } else if (mode === '3') {
          v.search = (await rl.question('Texto del nombre: ')).trim();
          if (!v.search) throw new Error('El texto de búsqueda está vacío.');
        } else if (mode !== '1') throw new Error('Opción de selección inválida.');
      }
      console.table(config.stores.map(s => ({ id: s.id, nombre: s.name, origen: s.sourceShopIds.join(',') })));
      if (!v.stores) v.stores = (await rl.question(`Tiendas destino (IDs separados por coma o all) [${config.stores[0].id}]: `)).trim() || config.stores[0].id;
      if (!v['new-id'] && !v['random-id'] && !v.list) {
        const idMode = (await rl.question('ActivityID de salida: 1) Conservar  2) Escribir otro  3) Generar aleatorio [1]: ')).trim() || '1';
        if (idMode === '2') {
          v['new-id'] = (await rl.question('Nuevo ActivityID numérico: ')).trim();
          if (!v['new-id']) throw new Error('El nuevo ActivityID está vacío.');
        } else if (idMode === '3') v['random-id'] = true;
        else if (idMode !== '1') throw new Error('Opción de ActivityID inválida.');
      }
      if (!v.send && !v['dry-run'] && !v.list) {
        const action = (await rl.question('Acción: 1) Generar JSON  2) Enviar a API [1]: ')).trim() || '1';
        if (!['1', '2'].includes(action)) throw new Error('Acción inválida.');
        v.send = action === '2';
      }
    }
    if (v.send && !configured) throw new Error('Para enviar, crea stores.json con el token de cada tienda y su mapeo sourceShopIds.');
    if (v.send && config.stores.length > 1 && !v.stores) throw new Error('Selecciona explícitamente los destinos con --stores tienda_a o --stores all.');
    const chosenIds = [...new Set([...list(v.ids), ...await readIdFile(v['ids-file'])])];
    if (v.list) {
      const chosenTypes = typeList(v.types) ?? [2, 4, 8];
      const selectedSourceIds = list(v['source-shops']);
      const entries = catalog(dataset.promotions.filter(p =>
        chosenTypes.includes(p.payload.activity_type) &&
        (!selectedSourceIds.length || selectedSourceIds.includes(p.sourceShopId)) &&
        (!chosenIds.length || chosenIds.includes(p.payload.activity_id)) &&
        !list(v['exclude-ids']).includes(p.payload.activity_id) &&
        (!v.search || p.payload.activity_name.toLocaleLowerCase('es').includes(v.search.toLocaleLowerCase('es')))
      ));
      showCatalog(entries);
      const directory = await newOutputDirectory(v.out ?? 'output');
      await saveJson(path.join(directory, 'catalogo_promociones.json'), entries);
      console.log(`Catálogo: ${entries.length} promociones. Archivo: ${path.join(directory, 'catalogo_promociones.json')}`);
      return;
    }
    const plan = replacePlannedActivityIds(buildPlan(dataset, config, {
      types: typeList(v.types),
      ids: chosenIds.length ? chosenIds : undefined,
      excludeIds: list(v['exclude-ids']),
      sourceShopIds: v['source-shops'] === undefined ? undefined : list(v['source-shops']),
      storeIds: v.stores === undefined || v.stores === 'all' ? undefined : list(v.stores),
      search: v.search,
      batchSize: numberOption(v['batch-size'], 'batch-size'),
      maxItemsPerBatch: numberOption(v['max-items'], 'max-items'),
      appItemIdType: numberOption(v['item-id-type'], 'item-id-type'),
    }), {
      manualId: v['new-id'],
      random: v['random-id'] === true,
      reservedIds: dataset.promotions.map(p => p.payload.activity_id),
    });
    for (const replacement of plan.selection.activityIdReplacement?.mappings ?? []) {
      console.log(`ActivityID de envío: ${replacement.originalId} -> ${replacement.sentId}`);
    }
    console.table(plan.stores.map(s => ({ tienda: s.id, promociones: s.promotions, items: s.items, lotes: s.batches })));
    const warnings = [...dataset.warnings, ...plan.warnings];
    for (const warning of warnings.slice(0, 10)) console.log(`Nota: ${warning.message}`);
    if (warnings.length > 10) console.log(`${warnings.length - 10} notas adicionales en manifest.json.`);
    const directory = await newOutputDirectory(v.out ?? 'output');
    const manifest = await exportPlan(dataset, plan, v.file, directory);
    console.log(`JSON y catálogo guardados en: ${directory}`);
    if (!v.send) {
      console.log('Vista previa completada. Para enviar esta selección, ejecuta con --send.');
      return;
    }
    const apiUrl = process.env[config.api.urlEnv];
    if (!apiUrl) throw new Error(`Falta ${config.api.urlEnv} en .env o en el entorno. Los JSON ya están generados.`);
    const journal = path.join(directory, 'resultados.jsonl');
    manifest.mode = 'send';
    manifest.status = 'starting';
    await atomicJson(path.join(directory, 'manifest.json'), manifest);
    try {
      const outcome = await uploadJobs(plan.jobs, {
        ...config.api,
        apiUrl,
        env: process.env,
        onResult: event => appendEvent(journal, event),
        log: text => console.log(text),
      });
      manifest.status = outcome.stopped ? 'stopped' : 'completed';
      manifest.uploadSummary = { acceptedBatches: outcome.acceptedBatches, rejectedBatches: outcome.rejectedBatches, unknownBatches: outcome.unknownBatches, stopped: outcome.stopped };
      await atomicJson(path.join(directory, 'manifest.json'), manifest);
      await saveJson(path.join(directory, 'resultado_envio.json'), outcome);
      console.log(`API: ${outcome.acceptedBatches} lotes aceptados, ${outcome.rejectedBatches} rechazados, ${outcome.unknownBatches} con resultado desconocido.`);
      if (outcome.stopped) {
        console.log('Revisa resultados.jsonl y verifica el estado de los IDs enviados antes de repetir una solicitud.');
        process.exitCode = 2;
      }
    } catch (error) {
      manifest.status = 'error';
      if (error.summary) manifest.uploadSummary = error.summary;
      await atomicJson(path.join(directory, 'manifest.json'), manifest);
      throw error;
    }
  } finally {
    rl?.close();
  }
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
