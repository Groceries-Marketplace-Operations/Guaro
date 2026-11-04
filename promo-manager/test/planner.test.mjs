import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, makePreviewConfig, buildPlan, replacePlannedActivityIds, replacePlannedItemIds } from '../src/planner.mjs';

function promo(source, id, type = 8, skus = ['00123']) {
  return { sourceShopId: source, sourceRows: [2], payload: {
    action: 1, activity_type: type, ...(type === 8 ? { child_type: 5 } : {}),
    activity_id: id, activity_name: `Oferta ${id}`, start_date: '2026-10-01 00:00:00', end_date: '2026-11-30 23:59:59',
    item_activity_list: skus.map(sku => ({ app_item_id: sku, ...(type === 8 ? { bxgy_x: 2, bxgy_y: 19900 } : type === 4 ? { buy_num: 1, get_num: 2 } : { discount_perc: 25 }) })),
  } };
}

const data = { promotions: [promo('692', '100', 8, ['0001', '0002']), promo('692', '101', 4, ['0001']), promo('692', '102', 2), promo('4027', '200', 8)] };
function configuration(stores) {
  return normalizeConfig({ stores: stores ?? [
    { id: 'a', authTokenEnv: 'TOKEN_A', sourceShopIds: ['692'] },
    { id: 'b', authTokenEnv: 'TOKEN_B', sourceShopIds: ['4027'] },
  ] });
}

test('los orígenes se asignan únicamente a sus destinos y el default conserva tipos4/8', () => {
  const plan = buildPlan(data, configuration());
  assert.deepEqual(plan.jobs.map(j => [j.store.id, j.payload.promo_list.map(p => p.activity_id)]), [['a', ['100', '101']], ['b', ['200']]]);
  assert.equal(plan.jobs[0].payload.auth_token, '{{auth_token}}');
  assert.equal(plan.jobs[0].payload.app_item_id_type, 0);
  assert.deepEqual(plan.jobs.flatMap(job => job.payload.promo_list).map(promotion => promotion.activity_name), [
    '100 · Oferta 100', '101 · Oferta 101', '200 · Oferta 200',
  ]);
});

test('elegir ActivityID conserva todos los SKU de esa promoción', () => {
  const plan = buildPlan(data, configuration(), { ids: ['100'], storeIds: ['a'] });
  assert.deepEqual(plan.jobs[0].payload.promo_list[0].item_activity_list.map(i => i.app_item_id), ['0001', '0002']);
});

test('enviar diferentes promociones a diferentes tiendas y cambiar app_item_id_type por destino', () => {
  const conf = configuration([
    { id: 'a', authTokenEnv: 'TOKEN_A', sourceShopIds: ['692'], includeActivityIds: ['100'] },
    { id: 'b', authTokenEnv: 'TOKEN_B', sourceShopIds: ['692'], includeActivityIds: ['101'], appItemIdType: 1 },
  ]);
  const plan = buildPlan(data, conf);
  assert.deepEqual(plan.jobs.map(j => j.payload.promo_list.map(p => p.activity_id)), [['100'], ['101']]);
  assert.equal(plan.jobs[1].payload.app_item_id_type, 1);
  plan.jobs[0].payload.promo_list[0].activity_name = 'Editado';
  assert.equal(data.promotions[0].payload.activity_name, 'Oferta 100');
});

test('activity action 2 genera un payload mínimo y conserva los IDs originales', () => {
  const plan = buildPlan(data, configuration(), {
    storeIds: ['a'], ids: ['100', '101'], types: [4, 8], activityAction: 2, appItemIdType: 1,
  });
  assert.equal(plan.selection.activityAction, 2);
  assert.equal(plan.totals.items, 0);
  assert.equal(plan.jobs[0].payload.app_item_id_type, 1);
  assert.deepEqual(plan.jobs[0].payload.promo_list, [
    { action: 2, activity_id: '100' },
    { action: 2, activity_id: '101' },
  ]);
  const groupedStops = buildPlan(data, configuration(), {
    storeIds: ['a'], activityAction: 2, groupSameTypeAndValidity: true,
  });
  assert.equal(groupedStops.selection.grouping.groups.length, 0);
});

test('actions 1 y 2 conviven en el mismo promo_list y solo crear conserva productos', () => {
  const plan = buildPlan(data, configuration(), {
    storeIds: ['a'], ids: ['100', '101'], types: [4, 8], activityAction: 1,
    activityActions: [{ activityId: '100', action: 1 }, { activityId: '101', action: 2 }],
  });
  assert.equal(plan.selection.activityAction, 'mixed');
  assert.deepEqual(plan.totals.actions, { create: 1, stop: 1 });
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0].payload.promo_list[0].action, 1);
  assert.equal(plan.jobs[0].payload.promo_list[0].item_activity_list.length, 2);
  assert.deepEqual(plan.jobs[0].payload.promo_list[1], { action: 2, activity_id: '101' });

  replacePlannedActivityIds(plan, { random: true, randomIdFactory: () => '700' });
  assert.equal(plan.jobs[0].payload.promo_list[0].activity_id, '700');
  assert.equal(plan.jobs[0].payload.promo_list[0].activity_name, '700 · Oferta 100');
  assert.equal(plan.jobs[0].payload.promo_list[1].activity_id, '101');
});

test('se conservan SKU que participan en varias promociones', () => {
  const plan = buildPlan(data, configuration(), { storeIds: ['a'] });
  assert.equal(plan.totals.items, 3);
  assert.equal(plan.totals.promotions, 2);
});

test('tipos all explícitos incluyen el tipo2', () => {
  const plan = buildPlan(data, configuration(), { types: [2, 4, 8], storeIds: ['a'] });
  assert.deepEqual(plan.jobs[0].payload.promo_list.map(p => p.activity_id), ['100', '101', '102']);
});

test('IDs, destinos u orígenes inexistentes no se ignoran', () => {
  assert.throws(() => buildPlan(data, configuration(), { ids: ['999'] }), /no encontrados/);
  assert.throws(() => buildPlan(data, configuration(), { storeIds: ['z'] }), /no encontrados/);
  assert.throws(() => buildPlan(data, configuration(), { sourceShopIds: ['9'] }), /no encontrados/);
});

test('selección vacía explícita no se convierte en todas', () => {
  for (const field of ['ids', 'storeIds', 'sourceShopIds']) assert.throws(() => buildPlan(data, configuration(), { [field]: [] }), /explícita está vacía/);
});

test('ID solicitado eliminado por tipos genera nota explícita', () => {
  const plan = buildPlan(data, configuration(), { ids: ['100', '102'], storeIds: ['a'] });
  assert.ok(plan.warnings.some(w => w.code === 'REQUESTED_IDS_FILTERED' && w.message.includes('102')));
});

test('ActivityID igual de dos orígenes se rechaza en un mismo destino', () => {
  const collision = { promotions: [promo('692', '100'), promo('4027', '100')] };
  const conf = configuration([{ id: 'a', authTokenEnv: 'TOKEN_A', sourceShopIds: ['*'] }]);
  assert.throws(() => buildPlan(collision, conf), /varios orígenes/);
  assert.equal(buildPlan(collision, conf, { sourceShopIds: ['692'] }).totals.promotions, 1);
});

test('los límites por número de promos e ítems se aplican conjuntamente', () => {
  const many = { promotions: [promo('692', '1', 8, ['a', 'b']), promo('692', '2', 8, ['c', 'd']), promo('692', '3', 8, ['e'])] };
  const plan = buildPlan(many, configuration(), { storeIds: ['a'], batchSize: 2, maxItemsPerBatch: 3 });
  assert.ok(plan.jobs.every(job => job.payload.promo_list.length <= 2));
  assert.ok(plan.jobs.every(job => job.payload.promo_list.reduce((total, activity) => total + activity.item_activity_list.length, 0) <= 3));
  assert.equal(plan.totals.items, 5);
});

test('un Activity ID puede continuar entre requests sin límite propio de items', () => {
  const itemIds = Array.from({ length: 7000 }, (_, index) => `sku-${index}`);
  const plan = buildPlan({ promotions: [promo('692', '700', 8, itemIds)] }, configuration(), { storeIds: ['a'] });
  assert.equal(plan.jobs.length, 2);
  assert.deepEqual(plan.jobs.map(job => job.payload.promo_list[0].activity_id), ['700', '700']);
  assert.deepEqual(plan.jobs.map(job => job.payload.promo_list[0].item_activity_list.length), [5999, 1001]);
  assert.equal(plan.jobs.flatMap(job => job.payload.promo_list[0].item_activity_list).length, 7000);
  assert.ok(plan.warnings.some(warning => warning.code === 'ACTIVITY_SPLIT_ACROSS_REQUESTS'));
});

test('cada request contiene menos de 500 Activity IDs', () => {
  const promotions = Array.from({ length: 500 }, (_, index) => promo('692', String(1000 + index), 8, [`sku-${index}`]));
  const plan = buildPlan({ promotions }, configuration(), { storeIds: ['a'] });
  assert.deepEqual(plan.jobs.map(job => job.payload.promo_list.length), [499, 1]);
});

test('configuración evita credenciales inline y nombres de carpeta duplicados en Windows', () => {
  assert.throws(() => configuration([{ id: 'a', authTokenEnv: 'TOKEN', sourceShopIds: ['692'], auth_token: 'secret' }]), /\.env/);
  assert.throws(() => configuration([{ id: 'A', authTokenEnv: 'TOKEN_A', sourceShopIds: ['692'] }, { id: 'a', authTokenEnv: 'TOKEN_B', sourceShopIds: ['692'] }]), /repetida/);
  assert.throws(() => configuration([{ id: '../destino', authTokenEnv: 'TOKEN', sourceShopIds: ['692'] }]), /id de texto/);
  assert.throws(() => configuration([{ id: 'a', authTokenEnv: 'TOKEN', sourceShopIds: ['692'], includeActivityId: ['100'] }]), /campos desconocidos/);
});

test('vista previa crea una carpeta independiente por tienda origen', () => {
  const conf = makePreviewConfig(['692', '4027']);
  assert.deepEqual(conf.stores.map(s => s.sourceShopIds), [['692'], ['4027']]);
  assert.equal(buildPlan(data, conf).stores.length, 2);
});

test('reemplaza manualmente el ID solo cuando hay una promoción y registra el mapeo', () => {
  const plan = buildPlan(data, configuration(), { ids: ['100'], storeIds: ['a'] });
  replacePlannedActivityIds(plan, { manualId: '987654321', reservedIds: data.promotions.map(p => p.payload.activity_id) });
  assert.equal(plan.jobs[0].payload.promo_list[0].activity_id, '987654321');
  assert.equal(plan.jobs[0].payload.promo_list[0].activity_name, '987654321 · Oferta 100');
  assert.deepEqual(plan.selection.activityIdReplacement, {
    mode: 'manual', mappings: [{ originalId: '100', sentId: '987654321' }],
  });
  assert.throws(() => replacePlannedActivityIds(buildPlan(data, configuration(), { storeIds: ['a'] }), { manualId: '999' }), /exactamente una/);
  assert.throws(() => replacePlannedActivityIds(buildPlan(data, configuration(), { ids: ['100'], storeIds: ['a'] }), { manualId: '100' }), /diferente/);
  assert.throws(() => replacePlannedActivityIds(buildPlan(data, configuration(), { ids: ['100'], storeIds: ['a'] }), { manualId: '101', reservedIds: ['100', '101'] }), /ya existe/);
});

test('genera IDs aleatorios únicos por promoción y los reutiliza entre destinos', () => {
  const conf = configuration([
    { id: 'a', authTokenEnv: 'TOKEN_A', sourceShopIds: ['692'] },
    { id: 'b', authTokenEnv: 'TOKEN_B', sourceShopIds: ['692'] },
  ]);
  const plan = buildPlan(data, conf, { ids: ['100', '101'] });
  const values = new Map([['100', '700'], ['101', '701']]);
  replacePlannedActivityIds(plan, { random: true, reservedIds: ['100', '101'], randomIdFactory: original => values.get(original) });
  assert.deepEqual(plan.jobs.map(j => j.payload.promo_list.map(p => p.activity_id)), [['700', '701'], ['700', '701']]);
  assert.deepEqual(plan.jobs.map(j => j.payload.promo_list.map(p => p.activity_name)), [
    ['700 · Oferta 100', '701 · Oferta 101'], ['700 · Oferta 100', '701 · Oferta 101'],
  ]);
  assert.deepEqual(plan.selection.activityIdReplacement.mappings, [
    { originalId: '100', sentId: '700' }, { originalId: '101', sentId: '701' },
  ]);
});

test('reemplaza un UPC como texto exacto en todos los destinos y evita colisiones', () => {
  const conf = configuration([
    { id: 'a', authTokenEnv: 'TOKEN_A', sourceShopIds: ['692'] },
    { id: 'b', authTokenEnv: 'TOKEN_B', sourceShopIds: ['692'] },
  ]);
  const plan = buildPlan(data, conf, { ids: ['100'] });
  replacePlannedItemIds(plan, [{ originalId: '0001', sentId: '0000000000999' }]);
  assert.deepEqual(plan.jobs.map(job=>job.payload.promo_list[0].item_activity_list[0].app_item_id), ['0000000000999', '0000000000999']);
  assert.deepEqual(plan.selection.itemIdReplacement.mappings, [{ originalId: '0001', sentId: '0000000000999', occurrences: 2 }]);
  assert.throws(()=>replacePlannedItemIds(buildPlan(data, configuration(), { ids: ['100'], storeIds: ['a'] }), [{ originalId: '0001', sentId: '0002' }]), /duplicado/);
  assert.throws(()=>replacePlannedItemIds(buildPlan(data, configuration(), { ids: ['100'], storeIds: ['a'] }), [{ originalId: '9999', sentId: '8888' }]), /no existe/);
});

test('agrupa promociones del mismo tipo y vigencia con un ID nuevo y productos consolidados', () => {
  const groupedData = { promotions: [
    promo('692', '100', 8, ['0001', '0002']),
    promo('692', '103', 8, ['0003']),
    promo('692', '104', 4, ['0004']),
  ] };
  const plan = buildPlan(groupedData, configuration(), {
    storeIds: ['a'],
    groupSameTypeAndValidity: true,
    groupRandomIdFactory: () => '900000001',
  });
  assert.equal(plan.totals.promotionsBeforeGrouping, 3);
  assert.equal(plan.totals.promotions, 2);
  assert.deepEqual(plan.jobs[0].payload.promo_list.map(value => value.activity_id), ['900000001', '104']);
  assert.match(plan.jobs[0].payload.promo_list[0].activity_name, /^900000001 · AGRUPADA/);
  assert.equal(plan.jobs[0].payload.promo_list[1].activity_name, '104 · Oferta 104');
  assert.deepEqual(plan.jobs[0].payload.promo_list[0].item_activity_list.map(value => value.app_item_id), ['0001', '0002', '0003']);
  assert.deepEqual(plan.selection.grouping.groups[0].sourceActivityIds, ['100', '103']);
});

test('no agrupa un SKU con mecánicas incompatibles', () => {
  const first = promo('692', '100', 8, ['0001']);
  const second = promo('692', '103', 8, ['0001']);
  second.payload.item_activity_list[0].bxgy_y = 29900;
  assert.throws(() => buildPlan({ promotions: [first, second] }, configuration(), {
    storeIds: ['a'], groupSameTypeAndValidity: true, groupRandomIdFactory: () => '900000001',
  }), /mecánicas distintas/);
});

test('conserva Shop ID y App Shop ID como metadatos no secretos de la tienda', () => {
  const conf = configuration([{
    id: 'soriana_929', name: 'Tlatelolco', city: 'Ciudad de México', shopId: '5764600000000000001', appShopId: '929',
    authTokenEnv: 'TOKEN_929', sourceShopIds: ['*'],
  }]);
  assert.equal(conf.stores[0].shopId, '5764600000000000001');
  assert.equal(conf.stores[0].appShopId, '929');
  assert.equal(conf.stores[0].city, 'Ciudad de México');
});
