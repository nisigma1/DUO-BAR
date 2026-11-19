import { readSalesReport } from './salesReports';
import type Database from 'better-sqlite3';
import type { TableSummary, CatalogProduct, ReportSummary, Settings } from '../../src/domain/types';

import { COFFEE_STOCK_ID, isCoffee } from '../../src/domain/operators';
import { duoCoffeeRecipe, LEGACY_COFFEE_RECIPE } from '../../src/domain/hotDrinks';
import { HOT_DRINK_SETUP, isCustomStockProduct, isDuoMenuProduct } from './duoCatalog';

export function createRepositories(db: Database.Database, duo = false, duoMenu = false) {
  const configuredHot = duoMenu
    ? db.prepare('SELECT value FROM settings WHERE key=?').pluck().get(HOT_DRINK_SETUP)
    : undefined;
  const hotIds = new Set<string>(
    typeof configuredHot === 'string' ? JSON.parse(configuredHot) : [],
  );
  return {
    getSalesReport: (period: unknown) => readSalesReport(db, period),
    listTables(): TableSummary[] {
      const rows = db
        .prepare(
          `SELECT t.id,t.code,t.area,t.status,t.enabled,t.sort_order AS sortOrder,
        t.created_at AS createdAt,t.updated_at AS updatedAt,
        CASE WHEN o.id IS NULL THEN NULL ELSE COALESCE(SUM(i.quantity*i.unit_price_cents),0) END AS activeOrderTotalCents
        FROM cafe_tables t LEFT JOIN orders o ON o.table_id=t.id AND o.status='OPEN'
        LEFT JOIN order_items i ON i.order_id=o.id GROUP BY t.id ORDER BY t.sort_order`,
        )
        .all() as (Omit<TableSummary, 'enabled'> & { enabled: number })[];
      if (
        rows.some(
          (row) =>
            row.activeOrderTotalCents !== null && !Number.isSafeInteger(row.activeOrderTotalCents),
        )
      )
        throw new Error('Active order total exceeds safe integer cents');
      return rows.map((row) => ({ ...row, enabled: row.enabled === 1 }));
    },
    listProducts(forOrders = false): CatalogProduct[] {
      const rows = db
        .prepare(
          `SELECT p.id,p.name,p.category_id AS categoryId,c.name AS categoryName,
        p.selling_price_cents AS sellingPriceCents,p.purchase_cost_cents AS purchaseCostCents,
        p.track_inventory AS trackInventory,p.low_stock_threshold AS lowStockThreshold,p.active,
        p.created_at AS createdAt,p.updated_at AS updatedAt,b.quantity AS stockQuantity
        FROM products p JOIN categories c ON c.id=p.category_id
        LEFT JOIN inventory_balances b ON b.product_id=p.id
        WHERE NOT EXISTS (SELECT 1 FROM settings s WHERE s.key='archived_product:' || p.id)
        ORDER BY c.sort_order,p.rowid`,
        )
        .all() as (Omit<CatalogProduct, 'active' | 'trackInventory'> & {
        active: number;
        trackInventory: number | null;
      })[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      const visible = duoMenu
        ? rows.filter(
            (row) =>
              isDuoMenuProduct(row.id) ||
              row.id === COFFEE_STOCK_ID ||
              hotIds.has(row.id) ||
              (hotIds.size > 0 && row.categoryId === 'CAJ' && row.sellingPriceCents !== null) ||
              isCustomStockProduct(row.id),
          )
        : rows;
      return visible.map((row) => {
        const coffeeRecipe = duoMenu ? duoCoffeeRecipe(row) : undefined;
        const recipe = coffeeRecipe ?? (duo && isCoffee(row.id) ? LEGACY_COFFEE_RECIPE : undefined);
        const holder = recipe && byId.get(recipe.stockProductId);
        return {
          ...row,
          active: row.active === 1,
          trackInventory:
            forOrders && recipe
              ? true
              : row.trackInventory === null
                ? null
                : row.trackInventory === 1,
          stockQuantity:
            forOrders && recipe
              ? holder && holder.trackInventory === 1
                ? holder.stockQuantity
                : null
              : row.stockQuantity,
          ...(coffeeRecipe ? { coffeeRecipe } : {}),
        };
      });
    },
    getSettings(): Settings {
      const row = db.prepare("SELECT value FROM settings WHERE key='business_name'").get() as
        | { value: string }
        | undefined;
      if (!row) throw new Error('Business name is missing');
      return { businessName: row.value };
    },
    getSummary(): ReportSummary {
      // Both IPC entry points use the same historical accounting and overflow checks.
      return readSalesReport(db, 'ALL').summary;
    },
  };
}
