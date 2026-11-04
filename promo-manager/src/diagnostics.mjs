const DAY_MS = 24 * 60 * 60 * 1000;
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

export const DIAGNOSTIC_RULES = Object.freeze([
  { code: 'STANDARD_FORMAT', label: 'Estructura', description: 'El archivo debe cumplir el formato estándar de 14 columnas y las validaciones de tipo, fechas, acción y mecánica.' },
  { code: 'FILE_AGE', label: 'Antigüedad', description: 'Se advierte cuando el archivo de muestra tiene más de 7 días.' },
  { code: 'DATE_RANGE', label: 'Vigencia', description: 'Se señalan promociones vencidas, vigencias menores a una hora, mayores a 366 días o que comienzan con más de un año de anticipación.' },
  { code: 'PERCENT_RANGE', label: 'Porcentaje', description: 'DiDi solo admite discount_perc enteros de 5 a 99. Los valores de 1–4 y 100 deben omitirse; 0% se resuelve por separado.' },
  { code: 'QUANTITY_RANGE', label: 'Cantidades', description: 'Para tipos 4 y 8 se señalan cantidades mayores a 20 y relaciones de regalo inusualmente altas.' },
  { code: 'FIXED_PRICE_RANGE', label: 'Precio fijo', description: 'Para tipo 8 se señalan precios de $0.01–$2, precios unitarios de hasta $1 y totales mayores a $10,000.' },
  { code: 'IDENTIFIER_SHAPE', label: 'Identificadores', description: 'Como observación se muestran SKU no numéricos o con longitudes distintas de 8, 12, 13 y 14 dígitos.' },
]);

function dateValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return NaN;
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

function sampleEvidence(values) {
  return [...new Set(values.map(value => String(value)).filter(Boolean))].slice(0, 5);
}

function warningDefinition(code) {
  return ({
    DUPLICATE_SKU_REQUIRES_SELECTION: ['critical', 'UPC repetido con mecánicas diferentes'],
    ZERO_DISCOUNT_REQUIRES_SELECTION: ['critical', 'Descuento de 0%'],
    UNSUPPORTED_PERCENTAGE_REQUIRES_OMISSION: ['critical', 'Porcentaje rechazado por DiDi'],
    ONE_CENT_PRICE: ['critical', 'Precio fijo de un centavo'],
    ACTIVITY_NAME_NORMALIZED: ['warning', 'Nombres incompatibles en un Activity ID'],
    OVERLAPPING_SKUS: ['warning', 'UPC presente en varias promociones'],
    BXGY_QUANTITY_ONE: ['warning', 'Cantidad 1 en promoción de precio fijo'],
  })[code] ?? ['warning', 'Advertencia del archivo'];
}

export function analyzePromotionDataset(dataset, options = {}) {
  const file = options.file ?? {};
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const nowMs = now.valueOf();
  const issues = new Map();
  const add = (code, severity, title, message, evidence = [], count = 1) => {
    const existing = issues.get(code) ?? { code, severity, title, message, count: 0, evidence: [] };
    existing.count += Math.max(1, Number(count) || 1);
    existing.evidence = sampleEvidence([...existing.evidence, ...evidence]);
    if ((SEVERITY_ORDER[severity] ?? 9) < (SEVERITY_ORDER[existing.severity] ?? 9)) existing.severity = severity;
    issues.set(code, existing);
  };

  for (const warning of dataset.warnings ?? []) {
    const [severity, title] = warningDefinition(warning.code);
    add(
      warning.code ?? 'SOURCE_WARNING',
      severity,
      title,
      warning.message ?? 'El convertidor detectó una advertencia.',
      [warning.message, warning.activityId && `Activity ID ${warning.activityId}`, warning.sourceShopId && `Tienda ${warning.sourceShopId}`],
      warning.rows?.length ?? 1,
    );
  }

  const sourceShops = dataset.stats?.sourceShops ?? [];
  if (sourceShops.length > 1) {
    add('MULTIPLE_SOURCE_STORES', 'warning', 'El archivo contiene varias tiendas', 'La muestra esperada para una tienda contiene más de un shopid.', sourceShops, sourceShops.length);
  }
  if (file.sourceShopId && sourceShops.length && !sourceShops.includes(String(file.sourceShopId))) {
    add('FILE_STORE_MISMATCH', 'critical', 'La tienda del archivo no coincide', 'El identificador inferido del nombre del archivo no aparece en sus filas.', [`Archivo: ${file.sourceShopId}`, `Filas: ${sourceShops.join(', ')}`]);
  }

  const fileDate = dateValue(file.modifiedAt ?? file.fileTimestamp);
  if (Number.isFinite(fileDate) && nowMs - fileDate > 7 * DAY_MS) {
    add('STALE_FILE', 'warning', 'Archivo con más de 7 días', 'La muestra más reciente encontrada para la marca puede estar desactualizada.', [file.modifiedAt ?? file.fileTimestamp]);
  }
  if (options.encoding === 'windows-1252') {
    add('NON_UTF8_ENCODING', 'warning', 'Archivo fuera de UTF-8', 'El archivo solo pudo leerse usando Windows-1252; conviene normalizarlo a UTF-8.', [file.name]);
  }

  for (const promotion of dataset.promotions ?? []) {
    const payload = promotion.payload ?? {};
    const activityId = String(payload.activity_id ?? '');
    const activityLabel = `Activity ID ${activityId}`;
    const start = dateValue(payload.start_date);
    const end = dateValue(payload.end_date);
    if (Number.isFinite(end) && end < nowMs) {
      add('EXPIRED_PROMOTION', 'warning', 'Promoción vencida', 'La fecha final ya pasó al momento del diagnóstico.', [activityLabel, payload.end_date]);
    }
    if (Number.isFinite(start) && start - nowMs > 366 * DAY_MS) {
      add('DISTANT_FUTURE_PROMOTION', 'warning', 'Inicio a más de un año', 'La promoción comienza con más de 366 días de anticipación.', [activityLabel, payload.start_date]);
    }
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const duration = end - start;
      if (duration < 60 * 60 * 1000) add('VERY_SHORT_PROMOTION', 'warning', 'Vigencia menor a una hora', 'La promoción dura menos de una hora.', [activityLabel]);
      if (duration > 366 * DAY_MS) add('VERY_LONG_PROMOTION', 'warning', 'Vigencia mayor a 366 días', 'La promoción permanece activa durante más de un año.', [activityLabel]);
    }
    if (String(payload.activity_name ?? '').length > 180) {
      add('LONG_ACTIVITY_NAME', 'warning', 'Nombre cercano al límite', 'El nombre tiene más de 180 caracteres y podría truncarse al agregar el Activity ID.', [activityLabel]);
    }
    const items = Array.isArray(payload.item_activity_list) ? payload.item_activity_list : [];
    if (items.length > 5999) {
      add('ACTIVITY_REQUIRES_SPLIT', 'info', 'Activity ID dividido en varios requests', 'La actividad supera 5,999 productos; la herramienta tendrá que dividirla conservando el mismo ID.', [activityLabel, `${items.length} productos`]);
    }
    for (const item of items) {
      const sku = String(item.app_item_id ?? '');
      const evidence = [`${activityId} / SKU ${sku}`];
      if (!/^\d+$/.test(sku)) {
        add('NON_NUMERIC_ITEM_ID', 'info', 'SKU no numérico', 'El identificador no tiene forma de UPC; verifica app_item_id_type para esta marca.', evidence);
      } else if (![8, 12, 13, 14].includes(sku.length)) {
        add('UNUSUAL_ITEM_ID_LENGTH', 'info', 'Longitud de SKU poco común', 'El identificador numérico no tiene una longitud UPC/GTIN habitual.', [...evidence, `${sku.length} dígitos`]);
      }
      if (payload.activity_type === 2) {
        const percentage = Number(item.discount_perc);
        if (percentage > 0 && percentage < 5) add('VERY_LOW_PERCENTAGE', 'warning', 'Descuento menor a 5%', 'El descuento es positivo pero inusualmente bajo.', [...evidence, `${percentage}%`]);
        if (percentage >= 90) add('VERY_HIGH_PERCENTAGE', 'warning', 'Descuento de 90% o más', 'El porcentaje es válido, pero puede representar una carga extrema.', [...evidence, `${percentage}%`]);
      } else if (payload.activity_type === 4) {
        const buy = Number(item.buy_num);
        const get = Number(item.get_num);
        if (buy > 20 || get > 20) add('VERY_HIGH_MXN_QUANTITY', 'warning', 'Cantidad MxN mayor a 20', 'Las cantidades de compra o entrega son inusualmente altas.', [...evidence, `${buy} → ${get}`]);
        if (buy > 0 && get / buy > 5) add('VERY_HIGH_MXN_RATIO', 'warning', 'Relación MxN extrema', 'La cantidad recibida supera cinco veces la cantidad pagada.', [...evidence, `${buy} → ${get}`]);
      } else if (payload.activity_type === 8) {
        const quantity = Number(item.bxgy_x);
        const cents = Number(item.bxgy_y);
        if (quantity > 20) add('VERY_HIGH_FIXED_QUANTITY', 'warning', 'Cantidad de precio fijo mayor a 20', 'La promoción usa una cantidad inusualmente alta.', [...evidence, `${quantity} unidades`]);
        if (cents > 1 && cents <= 200) add('VERY_LOW_FIXED_PRICE', 'warning', 'Precio fijo de $2 o menos', 'El precio total es válido, pero muy bajo y podría indicar pesos/centavos mal interpretados.', [...evidence, `$${(cents / 100).toFixed(2)}`]);
        if (quantity > 0 && cents > 200 && cents / quantity <= 100) add('VERY_LOW_UNIT_PRICE', 'warning', 'Precio unitario de $1 o menos', 'El precio promedio por unidad es inusualmente bajo.', [...evidence, `$${(cents / quantity / 100).toFixed(2)} por unidad`]);
        if (cents > 1_000_000) add('VERY_HIGH_FIXED_PRICE', 'warning', 'Precio fijo mayor a $10,000', 'El precio total es inusualmente alto; verifica la unidad monetaria.', [...evidence, `$${(cents / 100).toFixed(2)}`]);
      }
    }
  }

  const anomalies = [...issues.values()].sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
    || b.count - a.count
    || a.title.localeCompare(b.title, 'es')
  );
  const status = anomalies.some(issue => issue.severity === 'critical')
    ? 'critical'
    : anomalies.some(issue => issue.severity === 'warning') ? 'warning' : 'healthy';
  return { status, anomalies };
}
