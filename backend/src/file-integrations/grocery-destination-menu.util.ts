type JsonObject = Record<string, unknown>;

export const GROCERY_DESTINATION_CATEGORY_SIZE = 3500;
const CATEGORY_PREFIX = 'Cate_Grocery_';
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

export function buildFlatGroceryUploads(
  sourceMenu: JsonObject,
  selectedItems: JsonObject[],
  categorySize = GROCERY_DESTINATION_CATEGORY_SIZE,
): FlatGroceryUpload[] {
  if (!Number.isInteger(categorySize) || categorySize < 1) {
    throw new Error('Destination category size must be a positive integer');
  }

  const sourceMenus = objects(sourceMenu.menus);
  const baseMenu = sourceMenus[0];
  if (!baseMenu) throw new Error('The downloaded source menu contains no menu definition');

  const uploads: FlatGroceryUpload[] = [];
  for (let offset = 0; offset < selectedItems.length; offset += categorySize) {
    const items = selectedItems
      .slice(offset, offset + categorySize)
      .map(sanitizeGroceryDestinationItem);
    const categoryNumber = uploads.length + 1;
    const categoryId = `${CATEGORY_PREFIX}${categoryNumber}`;
    const itemIds = items.map(item => text(item.app_item_id));
    if (itemIds.some(id => !id)) {
      throw new Error(`Destination category ${categoryId} contains an item without app_item_id`);
    }

    uploads.push({
      menus: [{ ...baseMenu, app_category_ids: [categoryId] }],
      categories: [{
        app_category_id: categoryId,
        category_name: categoryId,
        app_item_ids: itemIds,
        priority: categoryNumber,
      }],
      items,
      categoryIds: [categoryId],
    });
  }
  return uploads;
}
