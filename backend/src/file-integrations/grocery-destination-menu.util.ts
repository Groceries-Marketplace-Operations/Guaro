type JsonObject = Record<string, unknown>;

export const GROCERY_DESTINATION_CATEGORY_SIZE = 3500;
const CATEGORY_PREFIX = 'Cate_Grocery_';

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
  modifierGroups: JsonObject[];
  categoryIds: string[];
}

export function buildFlatGroceryUploads(
  sourceMenu: JsonObject,
  selectedItems: JsonObject[],
  modifierGroups = objects(sourceMenu.modifier_groups),
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
    const items = selectedItems.slice(offset, offset + categorySize);
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
      modifierGroups,
      categoryIds: [categoryId],
    });
  }
  return uploads;
}
