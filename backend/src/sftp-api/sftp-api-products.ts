import { Item, minorUnits, Mode } from './sftp-api.util';

export type AdditionalProduct = { app_item_id: string; price: number; stock: number };

export function validateAdditionalProducts(value: unknown): AdditionalProduct[] {
  if (!Array.isArray(value) || value.length > 3000) throw new Error('Indica una lista JSON de hasta 3,000 productos');
  const ids = new Set<string>();
  return value.map((product, index) => {
    const fail = (message: string): never => { throw new Error(`Producto ${index + 1}: ${message}`); };
    if (!product || typeof product !== 'object' || Array.isArray(product)) return fail('objeto inválido');
    const { app_item_id: id, price, stock } = product;
    if (typeof id !== 'string' || !/^[\p{L}\p{N}]{1,50}$/u.test(id)) return fail('app_item_id debe tener de 1 a 50 letras o números');
    if (ids.has(id)) return fail('app_item_id duplicado');
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return fail('price debe ser positivo y estar expresado en pesos');
    if (!minorUnits(String(price))) return fail('price debe equivaler al menos a un centavo');
    if (typeof stock !== 'number' || !Number.isSafeInteger(stock) || stock < 0) return fail('stock debe ser un entero no negativo');
    ids.add(id);
    return { app_item_id: id, price, stock };
  });
}

export function appendAdditionalProducts(stores: Map<string, Map<string, Item>>, products: unknown, mode: Mode, reports: string[]) {
  if (mode !== 'full') return;
  const additions = validateAdditionalProducts(products ?? []);
  for (const [shop, items] of stores) {
    // Reuse the categories already required by the SFTP menu.
    const capacity = Math.min(30_000, Math.ceil(items.size / 3000) * 3000);
    const missing = additions.filter(product => !items.has(product.app_item_id));
    if (items.size + missing.length > capacity) throw new Error(`Tienda ${shop}: los productos adicionales exceden la capacidad de las categorías existentes (${capacity})`);
    for (const product of additions) {
      const id = product.app_item_id;
      if (items.has(id)) {
        reports.push(`Tienda ${shop}, producto adicional ${id}: se conserva el producto del archivo SFTP.`);
        continue;
      }
      items.set(id, { app_item_id: id, upc: id, item_name: id, price: minorUnits(String(product.price)), stock: product.stock, status: product.stock > 0 ? 1 : 2 });
    }
  }
}
