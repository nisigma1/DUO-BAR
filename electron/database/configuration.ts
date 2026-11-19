import type Database from 'better-sqlite3';
import {
  canSupplyProduct,
  validateProductUpdate,
  validateSupply,
  type MutationResult,
  type NewStockProductRequest,
  type ProductUpdate,
  type SupplyRequest,
} from '../../src/domain/configuration';
import type { CatalogProduct, Settings } from '../../src/domain/types';
import type { createRepositories } from './repositories';
import { COFFEE_STOCK_ID, coffeePortions, isCoffee } from '../../src/domain/operators';
import { CUSTOM_STOCK_PRODUCT_PREFIX, HOT_DRINK_SETUP } from './duoCatalog';
import { exactQuantity, assertCashTotals } from './numericSafety';
export function createConfigurationService(
  db: Database.Database,
  repositories: ReturnType<typeof createRepositories>,
  duo = false,
) {
  const find = (id: string) => repositories.listProducts().find((product) => product.id === id);
  const failure = (errors: Record<string, string>): MutationResult<CatalogProduct> => ({
    ok: false,
    errors,
    message: 'Kontrollo të dhënat e vendosura.',
  });
  const configuration = {
    archiveProduct(input: unknown): MutationResult<string> {
      const reject = (message: string): MutationResult<string> => ({
        ok: false,
        errors: { form: message },
        message,
      });
      if (typeof input !== 'string' || !input.trim() || input.length > 200)
        return reject('Produkti nuk është i vlefshëm.');
      if (duo && input === COFFEE_STOCK_ID)
        return reject('Espresso mban stokun e përbashkët të kafesë. Mund ta shënosh Joaktiv.');
      return db
        .transaction(() => {
          const key = `archived_product:${input}`;
          if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get(key)) {
            if (!find(input)) return reject('Produkti nuk u gjet.');
            const now = new Date().toISOString();
            db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(key, now);
            db.prepare('UPDATE products SET active=0,updated_at=? WHERE id=?').run(now, input);
          }
          return { ok: true, data: input } as const;
        })
        .immediate();
    },
    updateBusinessName(input: unknown): MutationResult<Settings> {
      const invalid = (): MutationResult<Settings> => ({
        ok: false,
        errors: { businessName: 'Shkruaj emrin e biznesit, deri në 100 shkronja.' },
        message: 'Kontrollo emrin e biznesit.',
      });
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).length !== 1 ||
        !Object.hasOwn(input, 'businessName')
      )
        return invalid();
      const raw = (input as { businessName: unknown }).businessName;
      if (typeof raw !== 'string') return invalid();
      const name = raw.trim();
      if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) return invalid();
      return db
        .transaction(() => {
          const updated = db
            .prepare("UPDATE settings SET value=? WHERE key='business_name'")
            .run(name);
          if (updated.changes !== 1) throw Error('FOX_BUSINESS_SETTING_MISSING');
          return { ok: true, data: repositories.getSettings() } as const;
        })
        .immediate();
    },
    updateProduct(input: unknown): MutationResult<CatalogProduct> {
      const errors = validateProductUpdate(input);
      if (Object.keys(errors).length) return failure(errors);
      const value = input as ProductUpdate;
      if (duo && value.id === COFFEE_STOCK_ID && value.trackInventory !== true)
        return failure({ trackInventory: 'Stoku i përbashkët i kafesë duhet të ndiqet.' });
      return db
        .transaction(() => {
          const existing = find(value.id);
          if (!existing) return failure({ form: 'Produkti nuk u gjet.' });
          if (existing.coffeeRecipe?.stockProductId === value.id && value.trackInventory !== true)
            return failure({ trackInventory: 'Stoku i kafesë duhet të ndiqet.' });
          if (existing.coffeeRecipe && value.categoryId !== existing.categoryId)
            return failure({
              categoryId: 'Produkti ka stok kafeje në kg. Mbaje te kategoria aktuale.',
            });
          db.prepare(
            `UPDATE products SET name=@name, category_id=@categoryId,
          purchase_cost_cents=@purchaseCostCents,selling_price_cents=@sellingPriceCents,
          track_inventory=@trackInventory,low_stock_threshold=@lowStockThreshold,
          active=@active,updated_at=@now WHERE id=@id`,
          ).run({
            id: value.id,
            name: value.name.trim(),
            categoryId: value.categoryId,
            purchaseCostCents: value.purchaseCostCents,
            sellingPriceCents: value.sellingPriceCents,
            trackInventory: value.trackInventory === null ? null : Number(value.trackInventory),
            lowStockThreshold: value.lowStockThreshold,
            active: Number(value.active),
            now: new Date().toISOString(),
          });
          return { ok: true, data: find(value.id)! } as const;
        })
        .immediate();
    },
    createProductWithStock(input: unknown): MutationResult<CatalogProduct> {
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) =>
            !['requestId', 'name', 'categoryId', 'quantity', 'drawerPaymentCents'].includes(key),
        )
      )
        return failure({ form: 'Kërkesa nuk është e vlefshme.' });

      const { requestId, name, categoryId, quantity, drawerPaymentCents } =
        input as NewStockProductRequest;
      const errors = {
        ...validateProductUpdate({
          id: CUSTOM_STOCK_PRODUCT_PREFIX,
          name,
          categoryId,
          sellingPriceCents: null,
          purchaseCostCents: null,
          trackInventory: true,
          lowStockThreshold: null,
          active: true,
        }),
        ...validateSupply({
          requestId,
          productId: CUSTOM_STOCK_PRODUCT_PREFIX,
          quantity,
          drawerPaymentCents,
        }),
      };
      if (typeof name === 'string' && /[\u0000-\u001f\u007f]/.test(name))
        errors.name = 'Shkruaj emrin e produktit në një rresht.';
      if (Object.keys(errors).length) return failure(errors);
      if (
        duo &&
        categoryId === 'KAFE' &&
        db.prepare('SELECT 1 FROM settings WHERE key=?').get(HOT_DRINK_SETUP)
      ) {
        try {
          coffeePortions(quantity);
        } catch (error) {
          return failure({ quantity: (error as Error).message });
        }
      }

      const token = requestId.toLowerCase();
      const productId = CUSTOM_STOCK_PRODUCT_PREFIX + token;
      const productName = name.trim().normalize('NFC');
      const key = `stock_product_request:${token}`;
      const fingerprint = JSON.stringify([
        productName,
        categoryId,
        quantity,
        drawerPaymentCents ?? null,
      ]);
      const conflict = () =>
        failure({
          form: 'Kjo kërkesë është përdorur me të dhëna të tjera. Hap një furnizim të ri.',
        });
      return db
        .transaction(() => {
          const prior = db.prepare('SELECT value FROM settings WHERE key=?').pluck().get(key);
          if (prior !== undefined) {
            if (prior !== fingerprint) return conflict();
            const existing = find(productId);
            return existing
              ? ({ ok: true, data: existing } as const)
              : failure({ form: 'Ky produkt është hequr nga stoku.' });
          }
          if (db.prepare('SELECT 1 FROM inventory_movements WHERE id=?').get(token))
            return conflict();

          const now = new Date().toISOString();
          db.prepare(
            'INSERT INTO products (id,name,category_id,track_inventory,active,created_at,updated_at) VALUES (?,?,?,1,1,?,?)',
          ).run(productId, productName, categoryId, now, now);
          db.prepare(
            'INSERT INTO inventory_balances (product_id,quantity,updated_at) VALUES (?,NULL,?)',
          ).run(productId, now);
          const supplied = configuration.addSupply({
            requestId: token,
            productId,
            quantity,
            drawerPaymentCents,
          });
          if (!supplied.ok) throw new Error('Could not record initial product supply');
          db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(key, fingerprint);
          return supplied;
        })
        .immediate();
    },
    addSupply(input: unknown): MutationResult<CatalogProduct> {
      const errors = validateSupply(input);
      if (Object.keys(errors).length) return failure(errors);
      const value = input as SupplyRequest;
      return db
        .transaction(() => {
          const selected = find(value.productId);
          if (!selected) return failure({ productId: 'Produkti nuk u gjet.' });
          if (
            !selected.coffeeRecipe &&
            duo &&
            isCoffee(value.productId) &&
            value.productId !== COFFEE_STOCK_ID
          )
            return failure({ productId: 'Përdor stokun e përbashkët të kafesë.' });
          const stockId = selected.coffeeRecipe?.stockProductId ?? selected.id;
          const product = stockId === selected.id ? selected : find(stockId);
          if (!product) return failure({ productId: 'Produkti nuk u gjet.' });
          let incoming = value.quantity;
          try {
            if (selected.coffeeRecipe || (duo && stockId === COFFEE_STOCK_ID))
              incoming = coffeePortions(incoming);
          } catch (error) {
            return failure({ quantity: (error as Error).message });
          }
          // The movement's primary key is the submission token: a retry cannot add stock twice.
          const existing = db
            .prepare('SELECT product_id,type,quantity_delta FROM inventory_movements WHERE id=?')
            .get(value.requestId) as
            | { product_id: string; type: string; quantity_delta: number }
            | undefined;
          if (existing) {
            const cash = db
              .prepare('SELECT -amount_cents AS paid FROM cash_events WHERE supply_id=?')
              .get(value.requestId) as { paid: number } | undefined;
            if (cash?.paid !== value.drawerPaymentCents)
              return failure({ form: 'Ky furnizim është regjistruar me pagesë tjetër.' });
            if (
              existing.product_id !== stockId ||
              existing.type !== 'SUPPLY' ||
              existing.quantity_delta !== incoming
            )
              return failure({
                form: 'Ky furnizim është regjistruar me të dhëna të tjera. Hap një furnizim të ri.',
              });
            return { ok: true, data: product } as const;
          }
          if (!canSupplyProduct(product, duo)) {
            return failure({
              productId: product.active
                ? 'Aktivizo ndjekjen e stokut te produkti para furnizimit.'
                : 'Aktivizo produktin para furnizimit.',
            });
          }
          const firstCount =
            duo &&
            product.trackInventory !== true &&
            (product.stockQuantity === null || Boolean(product.coffeeRecipe));
          // Starting tracking while a bill contains this product could charge
          // already served items against the newly counted stock.
          const startTracking =
            firstCount &&
            !db
              .prepare(
                `SELECT 1 FROM orders o JOIN order_items i ON i.order_id=o.id
               WHERE o.status='OPEN' AND i.product_id=? LIMIT 1`,
              )
              .get(product.id);
          let quantity: number;
          try {
            quantity = exactQuantity(product.stockQuantity ?? 0, incoming);
          } catch {
            return failure({ quantity: 'Sasia nuk mund të ruhet saktë.' });
          }
          if (
            !Number.isFinite(quantity) ||
            quantity > Number.MAX_SAFE_INTEGER ||
            quantity <= (product.stockQuantity ?? 0)
          )
            return failure({ quantity: 'Sasia është jashtë kufirit të lejuar.' });
          const now = new Date().toISOString();
          db.prepare(
            `INSERT INTO inventory_movements (id,product_id,type,quantity_delta,related_order_id,note,created_at)
          VALUES (?,?,'SUPPLY',?,NULL,?,?)`,
          ).run(
            value.requestId,
            product.id,
            incoming,
            product.stockQuantity === null
              ? 'Vendosja fillestare e stokut përmes furnizimit'
              : null,
            now,
          );
          const result = db
            .prepare('UPDATE inventory_balances SET quantity=?,updated_at=? WHERE product_id=?')
            .run(quantity, now, product.id);
          if (result.changes !== 1) throw new Error('Inventory balance is missing');
          if (startTracking)
            db.prepare('UPDATE products SET track_inventory=1,updated_at=? WHERE id=?').run(
              now,
              product.id,
            );
          if (value.drawerPaymentCents !== undefined) {
            db.prepare(
              'INSERT INTO cash_sessions SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM cash_sessions s WHERE NOT EXISTS(SELECT 1 FROM cash_closes c WHERE c.session_id=s.id))',
            ).run('supply-session:' + value.requestId, now);
            db.prepare(
              `INSERT INTO cash_events(id,session_id,kind,amount_cents,supply_id,reason,note,created_at,request_json) SELECT ?,id,'INVENTORY_SUPPLY_OUT',?,?,'Furnizim nga arka','',?,? FROM cash_sessions s WHERE NOT EXISTS(SELECT 1 FROM cash_closes c WHERE c.session_id=s.id)`,
            ).run(
              'supply:' + value.requestId,
              -value.drawerPaymentCents,
              value.requestId,
              now,
              JSON.stringify(value),
            );
            assertCashTotals(db);
          }
          return { ok: true, data: find(product.id)! } as const;
        })
        .immediate();
    },
  };
  return configuration;
}
