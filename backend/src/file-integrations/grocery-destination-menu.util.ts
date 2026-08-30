type JsonObject = Record<string, unknown>;

export const GROCERY_DESTINATION_CATEGORY_SIZE = 3500;
const CATEGORY_PREFIX = 'Cate_Grocery_';
export const ALLOWED_GROCERY_CATEGORY_NAMES = [
  'Panadería y Galletas',
  'Botanas',
  'Comidas Preparadas',
  'Bebidas',
  'Cerveza',
  'Abarrotes',
  'Vinos y Licores',
  'Comida Refrigerada',
  'Productos Lácteos',
  'Helados',
  'Embutidos',
  'Medicamentos',
  'Bienestar Sexual',
  'Belleza y Cuidado Personal',
  'Electrónicos',
  'Otros',
  'Mascotas',
  'Despensa y Productos Secos',
  'Jugos y Bebidas',
  'Higiene y Belleza',
  'Snacks y Botanas',
  'Cervezas, Vinos y Licores',
  'Congelados y Comidas Preparadas',
  'Farmacia',
  'Panadería y Tortillería',
  'Lácteos y Huevo',
  'Carnes Frías y Embutidos',
  'Carnes, Pescados y Mariscos',
  'Frutas y Verduras',
  'Bebés',
  'Artículos Variados y De Fiesta',
  'Cristalería',
  'Artículos De Oficina',
  'Ropa',
  'Otros',
  'Champagne y espumoso',
  'Cerveza',
  'Brandy',
  'Botanas',
  'Agua mineral',
  'Bebidas, Dulces & Snacks',
  'Congelados',
  'Despensa',
  'Lácteos',
  'Bebés',
  'Limpieza del hogar',
  'Cuidado de la Ropa',
  'Artículos para el hogar y autos',
  'Farmacia',
  'Cuidado Personal y Belleza',
  'Medicamentos',
  'Dermocosmética',
  'Suplementos y Vitamínicos',
  'Especialidades',
  'Diabetes',
] as const;
const DESTINATION_ITEM_FIELDS = [
  'upc',
  'app_item_id',
  'price',
  'activity_price',
  'item_name',
  'short_desc',
  'status',
] as const;

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter(entry => entry && typeof entry === 'object') as JsonObject[]
    : [];
}

export interface FlatGroceryUpload {
  menus: JsonObject[];
  categories: JsonObject[];
  items: JsonObject[];
  categoryIds: string[];
  modifierGroups?: JsonObject[];
}

export function groceryMergePolicyForBatch(mergePolicy: number, batchIndex: number) {
  if (![0, 1].includes(mergePolicy)) throw new Error('Grocery merge policy must be 0 or 1');
  if (!Number.isInteger(batchIndex) || batchIndex < 0) throw new Error('Grocery batch index must be a non-negative integer');
  return batchIndex === 0 ? mergePolicy : 0;
}

export function sanitizeGroceryDestinationItem(item: JsonObject): JsonObject {
  return Object.fromEntries(
    DESTINATION_ITEM_FIELDS
      .filter(field => Object.prototype.hasOwnProperty.call(item, field))
      .map(field => [field, item[field]]),
  );
}

export function isGroceryDestinationItemUploadable(item: JsonObject) {
  return Boolean(text(item.app_item_id) && text(item.upc));
}

export function countMatchingGroceryDestinationItems(
  expectedItems: JsonObject[],
  actualItems: JsonObject[],
) {
  return expectedItems.length - findGroceryDestinationItemMismatches(expectedItems, actualItems).length;
}

export function findGroceryDestinationItemMismatches(
  expectedItems: JsonObject[],
  actualItems: JsonObject[],
) {
  const actualById = new Map(
    actualItems
      .map(item => [text(item.app_item_id), item] as const)
      .filter(([appItemId]) => Boolean(appItemId)),
  );
  return expectedItems.filter(expected => {
    const actual = actualById.get(text(expected.app_item_id));
    if (!actual || text(actual.upc) !== text(expected.upc)) return true;
    const sameFields = DESTINATION_ITEM_FIELDS
      .filter(field => field !== 'app_item_id' && field !== 'upc' && Object.prototype.hasOwnProperty.call(expected, field))
      .every(field => text(actual[field]) === text(expected[field]));
    return !sameFields;
  });
}

export function buildFlatGroceryUploads(
  sourceMenu: JsonObject,
  selectedItems: JsonObject[],
  categorySize = GROCERY_DESTINATION_CATEGORY_SIZE,
  combineCategories = false,
): FlatGroceryUpload[] {
  if (!Number.isInteger(categorySize) || categorySize < 1) {
    throw new Error('Destination category size must be a positive integer');
  }

  const sourceMenus = objects(sourceMenu.menus);
  const baseMenu = sourceMenus[0];
  if (!baseMenu) throw new Error('The downloaded source menu contains no menu definition');

  const categories: JsonObject[] = [];
  const categoryIds: string[] = [];
  const items: JsonObject[] = [];
  const requiredCategories = Math.ceil(selectedItems.length / categorySize);
  if (combineCategories && requiredCategories > ALLOWED_GROCERY_CATEGORY_NAMES.length) {
    throw new Error(
      `The menu needs ${requiredCategories} category blocks but only ${ALLOWED_GROCERY_CATEGORY_NAMES.length} approved names are configured`,
    );
  }

  for (let offset = 0; offset < selectedItems.length; offset += categorySize) {
    const chunk = selectedItems.slice(offset, offset + categorySize).map(sanitizeGroceryDestinationItem);
    const categoryNumber = categories.length + 1;
    const categoryId = `${CATEGORY_PREFIX}${categoryNumber}`;
    const categoryName = combineCategories
      ? ALLOWED_GROCERY_CATEGORY_NAMES[categoryNumber - 1]
      : categoryId;
    const itemIds = chunk.map(item => text(item.app_item_id));
    if (itemIds.some(id => !id)) {
      throw new Error(`Destination category ${categoryId} contains an item without app_item_id`);
    }
    if (chunk.some(item => !text(item.upc))) {
      throw new Error(`Destination category ${categoryId} contains an item without UPC`);
    }
    categories.push({
      app_category_id: categoryId,
      category_name: categoryName,
      app_item_ids: itemIds,
      priority: categoryNumber,
    });
    categoryIds.push(categoryId);
    items.push(...chunk);
  }

  const combined = {
    menus: [{ ...baseMenu, app_category_ids: categoryIds }],
    categories,
    items,
    categoryIds,
  };
  if (combineCategories) return [combined];

  const itemById = new Map(items.map(item => [text(item.app_item_id), item]));
  return categories.map((category, index) => {
    const categoryId = categoryIds[index];
    const itemIds = category.app_item_ids as string[];
    return {
      menus: [{ ...baseMenu, app_category_ids: [categoryId] }],
      categories: [category],
      items: itemIds.map(itemId => itemById.get(itemId)!).filter(Boolean),
      categoryIds: [categoryId],
    };
  });
}
