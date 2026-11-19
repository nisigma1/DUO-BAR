import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { COFFEE_STOCK_ID } from '../../src/domain/operators';
import { LEGACY_COFFEE_RECIPE, type CoffeeRecipe } from '../../src/domain/hotDrinks';
import { exactQuantity } from './numericSafety';

export function coffeeBalance(db: Database.Database, stockProductId = COFFEE_STOCK_ID) {
  const row = db
    .prepare(
      'SELECT p.track_inventory,b.quantity FROM products p JOIN inventory_balances b ON b.product_id=p.id WHERE p.id=?',
    )
    .get(stockProductId) as { track_inventory: number | null; quantity: number | null } | undefined;
  return row?.track_inventory === 1 ? row.quantity : null;
}

const recipeKey = (itemId: string) => 'duo_coffee_item:' + itemId;

export function readCoffeeRecipe(db: Database.Database, itemId: string): CoffeeRecipe | undefined {
  const stored = db
    .prepare('SELECT value FROM settings WHERE key=?')
    .pluck()
    .get(recipeKey(itemId));
  return typeof stored === 'string' ? (JSON.parse(stored) as CoffeeRecipe) : undefined;
}

export function saveCoffeeRecipe(db: Database.Database, itemId: string, recipe: CoffeeRecipe) {
  db.prepare('INSERT INTO settings VALUES (?,?)').run(recipeKey(itemId), JSON.stringify(recipe));
}

export function sameCoffeeRecipe(a?: CoffeeRecipe, b?: CoffeeRecipe) {
  return a?.stockProductId === b?.stockProductId && a?.doses === b?.doses;
}

export function removeCoffeeRecipe(db: Database.Database, itemId: string) {
  db.prepare('DELETE FROM settings WHERE key=?').run(recipeKey(itemId));
}

// A confirmed portion changes available stock immediately. Checkout reads the
// recorded quantity on the item and only deducts portions not yet charged.
export function changeCoffeeStock(
  db: Database.Database,
  orderId: string,
  delta: number,
  now: string,
  { stockProductId } = LEGACY_COFFEE_RECIPE,
) {
  const current = coffeeBalance(db, stockProductId);
  if (current === null || !Number.isFinite(current)) return 'Vendos stokun e kafesë te Stoku.';
  if (delta < 0 && current < -delta) return 'Nuk ka mjaftueshëm kafe në stok.';
  const next = exactQuantity(current, delta);
  db.prepare('UPDATE inventory_balances SET quantity=?,updated_at=? WHERE product_id=?').run(
    next,
    now,
    stockProductId,
  );
  db.prepare(
    'INSERT INTO inventory_movements(id,product_id,type,quantity_delta,related_order_id,note,created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(
    randomUUID(),
    stockProductId,
    delta < 0 ? 'MANUAL_ADJUSTMENT' : 'REVERSAL',
    delta,
    orderId,
    delta < 0 ? 'Kafe e konfirmuar në porosi' : 'Kafe e kthyer në stok',
    now,
  );
  return null;
}
