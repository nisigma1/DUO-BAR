import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type Database from 'better-sqlite3';
import { INITIAL_PRODUCTS } from '../../src/domain/definitions';
import { drinkNameKey, duoCoffeeRecipe } from '../../src/domain/hotDrinks';
import { COFFEE_STOCK_ID } from '../../src/domain/operators';
import type { CategoryCode } from '../../src/domain/types';
import { DUO_PRINTED_MENU } from './duoPrintedMenu';

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
export const HOT_DRINK_SETUP = 'duo_hot_drinks_v1';
const PRINTED_MENU_SETUP = 'duo_printed_menu_v1';

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

export function readPrintedMenu(db: Database.Database) {
  const saved = db
    .prepare('SELECT value FROM settings WHERE key=?')
    .pluck()
    .get(PRINTED_MENU_SETUP);
  return typeof saved === 'string'
    ? new Map(Object.entries(JSON.parse(saved) as Record<string, string>))
    : undefined;
}

// Called in the seed transaction after the authorized HP catalog is present.
export function configureDuoMenu(db: Database.Database, now: string) {
  if (!hasDuoMenu(db)) return;
  const setting = db.prepare('SELECT value FROM settings WHERE key=?').pluck();
  if (setting.get(PRINTED_MENU_SETUP)) return;
  const oldHotMenu = setting.get(HOT_DRINK_SETUP);
  const oldHotIds = new Set<string>(typeof oldHotMenu === 'string' ? JSON.parse(oldHotMenu) : []);
  const products = db
    .prepare(
      `
    SELECT p.id,p.name,b.quantity,s.key IS NOT NULL AS archived FROM products p
    LEFT JOIN inventory_balances b ON b.product_id=p.id
    LEFT JOIN settings s ON s.key='archived_product:' || p.id ORDER BY p.rowid
  `,
    )
    .all() as { id: string; name: string; quantity: number | null; archived: number }[];
  const byId = new Map(products.map((product) => [product.id, product]));
  const insert = db.prepare(`
    INSERT INTO products (id,name,category_id,selling_price_cents,track_inventory,active,created_at,updated_at)
    VALUES (?,?,?,?,?,1,?,?)
  `);
  const update = db.prepare(`
    UPDATE products SET name=?, category_id=?, selling_price_cents=?,
    track_inventory=COALESCE(track_inventory,?), active=1, updated_at=?
    WHERE id=?
  `);
  const balance = db.prepare('INSERT INTO inventory_balances VALUES (?,NULL,?)');
  const mark = db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO NOTHING');
  const restore = db.prepare("DELETE FROM settings WHERE key='archived_product:' || ?");
  const visible = new Map<string, string>();
  for (const [id, name, categoryId, price, aliases = []] of DUO_PRINTED_MENU) {
    const names = new Set([name, ...aliases].map(drinkNameKey));
    const fixed = byId.get(id);
    const matches =
      id === COFFEE_STOCK_ID
        ? []
        : products.filter(
            (p) =>
              isCustomStockProduct(p.id) &&
              !p.archived &&
              !visible.has(p.id) &&
              names.has(drinkNameKey(p.name)),
          );
    const existing =
      matches.find((p) => oldHotIds.has(p.id)) ??
      (fixed?.quantity != null ? fixed : (matches[0] ?? fixed));
    const selectedId = existing?.id ?? id;
    const stock = Number(
      Boolean(duoCoffeeRecipe({ id: selectedId, name, categoryId }, id)) ||
        existing?.quantity != null,
    );
    if (existing) {
      update.run(name, categoryId, price, stock, now, selectedId);
      if (existing.archived) restore.run(selectedId);
    } else {
      insert.run(id, name, categoryId, price, stock, now, now);
      balance.run(id, now);
    }
    visible.set(selectedId, id);
  }
  db.prepare('UPDATE products SET purchase_cost_cents=NULL WHERE id=?').run(COFFEE_STOCK_ID);

  // Keep product IDs, balances, and historical line data when taking items off the menu.
  const deactivate = db.prepare(
    'UPDATE products SET active=0,updated_at=? WHERE id=? AND active=1',
  );
  for (const product of products) {
    if (visible.has(product.id)) continue;
    mark.run('archived_product:' + product.id, now);
    deactivate.run(now, product.id);
  }
  mark.run(HOT_DRINK_SETUP, JSON.stringify([...visible.keys()]));
  mark.run(PRINTED_MENU_SETUP, JSON.stringify(Object.fromEntries(visible)));
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
