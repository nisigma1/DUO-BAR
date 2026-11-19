import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type Database from 'better-sqlite3';
import { INITIAL_PRODUCTS } from '../../src/domain/definitions';
import { drinkNameKey, DUO_HOT_DRINKS } from '../../src/domain/hotDrinks';
import { COFFEE_STOCK_ID } from '../../src/domain/operators';
import type { CategoryCode } from '../../src/domain/types';

// Purchase cost and owner-editable launch price in cents per unit named on each row.
const drinks = [
  ['Coca-Cola 0.25 L', 'PIJE', 50, 150],
  ['Fanta 0.25 L', 'PIJE', 50, 150],
  ['Sprite 0.25 L', 'PIJE', 50, 150],
  ['Coca-Cola Zero 0.25 L', 'PIJE', 50, 150],
  ['Schweppes 0.25 L', 'PIJE', 54, 170],
  ['Schweppes Tonic 0.25 L', 'PIJE', 54, 170],
  ['Çaj i ftohtë 0.33 L', 'PIJE', 48, 170],
  ['Santal Portokall 100% 0.20 L', 'PIJE', 83, 200],
  ['Alexandria Verë e Kuqe 0.187 L', 'ALKOOL', 180, 400],
  ['Alexandria Verë e Bardhë 0.187 L', 'ALKOOL', 180, 400],
  ['Badel Vigor Vodka 1 L', 'ALKOOL', 990, 2500],
  ['Tequila Rio Club 0.70 L', 'ALKOOL', 990, 3000],
  ['Red Bull 0.25 L', 'PIJE', 116, 350],
  ['Jägermeister 1 L', 'ALKOOL', 1890, 4000],
  ['Baileys 0.70 L', 'ALKOOL', 2290, 4500],
  ['Tuborg 0.33 L', 'ALKOOL', 104, 250],
  ['Fructal Dredhëz 0.20 L', 'PIJE', 72, 170],
  ['Malibu 1 L', 'ALKOOL', 1910, 4000],
  ['Heineken', 'ALKOOL', null, 300],
] as const satisfies ReadonlyArray<readonly [string, CategoryCode, number | null, number]>;

const productId = (index: number) => 'duo-drinks-v1-' + (index + 1);
const menuIds = new Set(drinks.map((_, index) => productId(index)));
const PRICE_SETUP = 'duo_menu_prices_v1';
const ESPRESSO_SETUP = 'duo_menu_espresso_v1';
export const HOT_DRINK_SETUP = 'duo_hot_drinks_v1';

export const CUSTOM_STOCK_PRODUCT_PREFIX = 'custom-stock-v1-';

export function isCustomStockProduct(id: string) {
  return (
    id.startsWith(CUSTOM_STOCK_PRODUCT_PREFIX) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      id.slice(CUSTOM_STOCK_PRODUCT_PREFIX.length),
    )
  );
}

export function isDuoMenuProduct(id: string) {
  return menuIds.has(id);
}

export function hasDuoMenu(db: Database.Database) {
  const ids = db.prepare('SELECT id FROM products').pluck().all() as string[];
  return ids.filter(isDuoMenuProduct).length === menuIds.size;
}

// Called in the seed transaction after the authorized HP catalog is present.
export function configureDuoMenu(db: Database.Database, now: string) {
  if (!hasDuoMenu(db)) return;
  const configured = db.prepare('SELECT 1 FROM settings WHERE key=?');
  const mark = db.prepare("INSERT INTO settings VALUES (?, '1')");
  if (!configured.get(PRICE_SETUP)) {
    const save =
      db.prepare(`UPDATE products SET active=1, updated_at=?, selling_price_cents=COALESCE(selling_price_cents, ?),
      track_inventory=COALESCE(track_inventory, (SELECT quantity IS NOT NULL FROM inventory_balances WHERE product_id=products.id))
      WHERE id=?`);
    for (const [index, [, , , price]] of drinks.entries()) save.run(now, price, productId(index));
    mark.run(PRICE_SETUP);
  }
  if (
    !configured.get(ESPRESSO_SETUP) &&
    db.prepare('SELECT 1 FROM products WHERE id=?').get(COFFEE_STOCK_ID)
  ) {
    db.prepare('UPDATE products SET active=1, updated_at=? WHERE id=? AND active=0').run(
      now,
      COFFEE_STOCK_ID,
    );
    mark.run(ESPRESSO_SETUP);
  }
  if (configured.get(HOT_DRINK_SETUP)) return;
  const products = db
    .prepare(
      `
    SELECT p.id,p.name,s.key IS NOT NULL AS archived FROM products p
    LEFT JOIN settings s ON s.key='archived_product:' || p.id ORDER BY p.rowid
  `,
    )
    .all() as { id: string; name: string; archived: number }[];
  const insert = db.prepare(`
    INSERT INTO products (id,name,category_id,selling_price_cents,track_inventory,active,created_at,updated_at)
    VALUES (?,?,?,?,?,1,?,?)
  `);
  const update = db.prepare(`
    UPDATE products SET name=CASE WHEN selling_price_cents IS NULL AND ? THEN ? ELSE name END,
    category_id=?, selling_price_cents=COALESCE(selling_price_cents,?),
    track_inventory=COALESCE(track_inventory,?), active=CASE WHEN selling_price_cents IS NULL AND ? THEN 1 ELSE active END, updated_at=?
    WHERE id=?
  `);
  const balance = db.prepare('INSERT INTO inventory_balances VALUES (?,NULL,?)');
  const visible: string[] = [];
  for (const [id, name, category, price, aliases] of DUO_HOT_DRINKS) {
    const names = new Set([name, ...aliases].map(drinkNameKey));
    const stock = category === 'KAFE' ? 1 : 0;
    const matched =
      id === COFFEE_STOCK_ID
        ? undefined
        : products.find(
            (p) => isCustomStockProduct(p.id) && !p.archived && names.has(drinkNameKey(p.name)),
          );
    const existing = matched ?? products.find((p) => p.id === id);
    if (existing) {
      if (!existing.archived)
        update.run(
          Number(!matched),
          name,
          category,
          price,
          stock,
          Number(!matched),
          now,
          existing.id,
        );
      visible.push(existing.id);
    } else {
      insert.run(id, name, category, price, stock, now, now);
      balance.run(id, now);
      visible.push(id);
    }
  }
  db.prepare('INSERT INTO settings VALUES (?,?)').run(HOT_DRINK_SETUP, JSON.stringify(visible));
}

export function isDuoCatalogTerminal(): boolean {
  // Windows computer name of the DUO terminal, stored as a normalized digest.
  return (
    process.platform === 'win32' &&
    createHash('sha256').update(hostname().toLowerCase()).digest('hex') ===
      '093c398232d67bae6e4b8ee594e7444b513f93494407309234fd7a9019fa7cad'
  );
}

// Called inside the immediate seed transaction, before normal seeding.
export function addDuoCatalog(db: Database.Database, now: string): void {
  const business = db.prepare("SELECT value FROM settings WHERE key='business_name'").pluck().get();
  if (typeof business !== 'string' || business.trim().toUpperCase() !== 'DUO') return;

  const products = db.prepare('SELECT id,name,category_id FROM products').all() as {
    id: string;
    name: string;
    category_id: CategoryCode;
  }[];
  const legacy = products.filter((product) => !isCustomStockProduct(product.id));
  const byId = new Map(legacy.map((product) => [product.id, product]));
  // Exact baseline also prevents a second import and avoids guessing after local catalog edits.
  if (
    legacy.length !== INITIAL_PRODUCTS.length ||
    !INITIAL_PRODUCTS.every(({ id, name, categoryId }) => {
      const existing = byId.get(id);
      return existing?.name.normalize('NFC') === name && existing.category_id === categoryId;
    })
  )
    return;

  const insert = db.prepare(
    'INSERT INTO products (id,name,category_id,purchase_cost_cents,active,created_at,updated_at) VALUES (?,?,?,?,0,?,?)',
  );
  const balance = db.prepare('INSERT INTO inventory_balances VALUES (?,NULL,?)');
  for (const [index, [name, category, purchaseCost]] of drinks.entries()) {
    const id = productId(index);
    insert.run(id, name, category, purchaseCost, now, now);
    balance.run(id, now);
  }
}
