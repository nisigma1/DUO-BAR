import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase } from '../electron/database/connection';
import { createRepositories } from '../electron/database/repositories';
import { createOrderService } from '../electron/database/orders';
import { createCheckoutService } from '../electron/database/checkout';
import { inspectDatabase } from '../electron/database/health';
import { addDuoCatalog, hasDuoMenu } from '../electron/database/duoCatalog';
import { createConfigurationService } from '../electron/database/configuration';
import { readShiftSales } from '../electron/database/duoReports';
import { coffeeBalance } from '../electron/database/duoCoffee';
import type { NewStockProductRequest } from '../src/domain/configuration';
import {
  DUO_HOT_DRINKS,
  drinkCategory,
  hotDrinkNameKey,
  suggestHotDrinkCategory,
} from '../src/domain/hotDrinks';

let directory: string;
let file: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-duo-catalog-'));
  file = path.join(directory, 'fox.sqlite');
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

it('adds the photographed coffees with kg supplies, distinct stocks, and stable open orders', () => {
  for (const name of ['PaPlum', 'Pa plumb', 'Ekspreso pa plum', 'Nescafé Vanille'])
    expect(suggestHotDrinkCategory(name)).toBe('KAFE');
  expect(suggestHotDrinkCategory('Ice Latte')).toBe('PIJE');
  expect(suggestHotDrinkCategory('Ice Amerikane')).toBe('PIJE');
  expect(suggestHotDrinkCategory('Çaj i ftohtë')).toBeUndefined();
  expect(suggestHotDrinkCategory('Çaj kamomil')).toBe('CAJ');
  expect(hotDrinkNameKey('PaPlum')).toBe(hotDrinkNameKey('Espresso pa plumb'));

  let db = openDatabase(file);
  try {
    db.prepare("UPDATE settings SET value='DUO' WHERE key='business_name'").run();
    db.prepare(
      "UPDATE products SET selling_price_cents=120,track_inventory=1 WHERE id IN ('KAFE-1','KAFE-2')",
    ).run();
    db.prepare("UPDATE inventory_balances SET quantity=220 WHERE product_id='KAFE-1'").run();
    db.prepare("UPDATE inventory_balances SET quantity=19 WHERE product_id='KAFE-2'").run();
    const prior = createRepositories(db, true);
    const legacyOrders = createOrderService(
      db,
      {
        ...prior,
        listProducts: (forOrders) =>
          prior.listProducts(forOrders).map((product) =>
            product.id === 'KAFE-2'
              ? {
                  ...product,
                  stockQuantity: coffeeBalance(db, 'KAFE-2'),
                  coffeeRecipe: { stockProductId: 'KAFE-2', doses: 1 },
                }
              : product,
          ),
      },
      {
        operator: () => 'OWNER',
      },
    );
    const old = legacyOrders.addProduct({ tableId: 'M1', productId: 'KAFE-2' });
    if (!old.ok || !old.data.order) throw Error('Expected the pre-update decaf order');
    expect(coffeeBalance(db)).toBe(220);
    expect(coffeeBalance(db, 'KAFE-2')).toBe(18);
    db.close();

    db = openDatabase(file, '0.7.2-rc.4', true);
    const repo = createRepositories(db, true, true);
    const configuration = createConfigurationService(db, repo, true);
    const orders = createOrderService(db, repo, { operator: () => 'OWNER' });
    expect(orders.getForTable('M1').order).toEqual(old.data.order);
    const supply = (productId: string, quantity: number) =>
      configuration.addSupply({ requestId: randomUUID(), productId, quantity });
    const nescafe = 'duo-hot-v1-nescafe-classic';
    expect(supply('KAFE-2', 0.5)).toMatchObject({
      ok: true,
      data: { id: 'KAFE-1', stockQuantity: 275 },
    });
    expect(supply(nescafe, 1)).toMatchObject({ ok: true, data: { stockQuantity: 110 } });
    expect(supply('KAFE-3', 0.5)).toMatchObject({
      ok: true,
      data: { id: 'KAFE-1', stockQuantity: 330 },
    });
    expect(supply('KAFE-3', 0.0005).ok).toBe(false);
    const add = (productId: string, quantity: number) =>
      orders.addProduct({ tableId: 'M1', productId }, quantity);
    expect(add('KAFE-2', 1).ok).toBe(true);
    expect(add(nescafe, 1).ok).toBe(true);
    expect(add('KAFE-3', 2).ok).toBe(true);
    expect(add('duo-hot-v1-ice-latte', 1).ok).toBe(true);
    expect(
      orders.getForTable('M1').order?.items.filter((item) => item.productId === 'KAFE-2'),
    ).toHaveLength(2);
    expect(coffeeBalance(db)).toBe(324);
    expect(coffeeBalance(db, 'KAFE-2')).toBe(18);
    expect(coffeeBalance(db, nescafe)).toBe(109);
    const double = orders
      .getForTable('M1')
      .order!.items.find((item) => item.productId === 'KAFE-3')!;
    expect(orders.decrementItem({ tableId: 'M1', itemId: double.id }).ok).toBe(true);
    expect(coffeeBalance(db)).toBe(326);
    const paid = orders.getForTable('M1').order!;
    expect(
      createCheckoutService(db, orders, true).completeOrder({
        orderId: paid.id,
        expectedRevision: paid.revision,
      }).ok,
    ).toBe(true);
    expect(coffeeBalance(db)).toBe(326);
    expect(coffeeBalance(db, 'KAFE-2')).toBe(18);
    expect(coffeeBalance(db, nescafe)).toBe(109);

    const custom = configuration.createProductWithStock({
      requestId: randomUUID(),
      name: 'Latte special',
      categoryId: 'KAFE',
      quantity: 0.5,
    });
    expect(custom).toMatchObject({ ok: true, data: { stockQuantity: 55 } });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    if (db.open) db.close();
  }
});

it('lets the owner repeatedly set an exact total for shared and individually counted stock', () => {
  const initial = openDatabase(file);
  initial.prepare("UPDATE settings SET value='DUO' WHERE key='business_name'").run();
  initial.prepare("UPDATE inventory_balances SET quantity=489 WHERE product_id='KAFE-1'").run();
  initial.close();

  const db = openDatabase(file, '0.7.2-rc.4', true);
  try {
    const repo = createRepositories(db, true, true);
    const configuration = createConfigurationService(db, repo, true);
    const request = {
      requestId: randomUUID(),
      productId: 'KAFE-1',
      quantity: 13,
      expectedQuantity: 489,
    };
    expect(configuration.setStockCount(request)).toMatchObject({
      ok: true,
      data: { id: 'KAFE-1', stockQuantity: 1430 },
    });
    expect(configuration.setStockCount(request).ok).toBe(true);
    expect(configuration.setStockCount({ ...request, quantity: 12 }).ok).toBe(false);
    const stale = { ...request, requestId: randomUUID(), quantity: 12 };
    expect(configuration.setStockCount(stale)).toMatchObject({
      ok: false,
      errors: { form: expect.stringContaining('Stoku ka ndryshuar') },
    });
    const remove = {
      requestId: randomUUID(),
      productId: 'KAFE-2',
      quantity: 0,
      expectedQuantity: 1430,
    };
    expect(configuration.setStockCount(remove)).toMatchObject({
      ok: true,
      data: { id: 'KAFE-1', stockQuantity: 0 },
    });
    expect(configuration.setStockCount(request)).toMatchObject({
      ok: true,
      data: { stockQuantity: 0 },
    });
    expect(
      configuration.setStockCount({ ...request, requestId: randomUUID(), expectedQuantity: 0 }).ok,
    ).toBe(true);
    expect(coffeeBalance(db)).toBe(1430);

    const cola = 'duo-drinks-v1-1';
    const countCola = {
      requestId: randomUUID(),
      productId: cola,
      quantity: 20,
      expectedQuantity: null,
    };
    const orders = createOrderService(db, repo, { operator: () => 'OWNER' });
    const opened = orders.addProduct({ tableId: 'M1', productId: cola });
    if (!opened.ok || !opened.data.order?.items[0]) throw Error('Expected an open untracked order');
    expect(configuration.setStockCount(countCola)).toMatchObject({
      ok: false,
      errors: { form: expect.stringContaining('porositë e hapura') },
    });
    expect(orders.removeItem({ tableId: 'M1', itemId: opened.data.order.items[0].id }).ok).toBe(
      true,
    );
    expect(configuration.setStockCount(countCola)).toMatchObject({
      ok: true,
      data: { stockQuantity: 20, trackInventory: true },
    });
    expect(
      configuration.setStockCount({
        ...countCola,
        requestId: randomUUID(),
        quantity: 14,
        expectedQuantity: 20,
      }),
    ).toMatchObject({
      ok: true,
      data: { stockQuantity: 14 },
    });
    expect(
      db.prepare('SELECT quantity_delta FROM inventory_movements ORDER BY rowid').pluck().all(),
    ).toEqual([941, -1430, 1430, 20, -6]);
    expect(db.prepare('SELECT count(*) FROM cash_events').pluck().get()).toBe(0);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});

it('reuses a previously added PaPlum with the printed price and shared recipe', () => {
  const original = openDatabase(file);
  original.prepare("UPDATE settings SET value='DUO' WHERE key='business_name'").run();
  const config = createConfigurationService(original, createRepositories(original));
  const custom = config.createProductWithStock({
    requestId: randomUUID(),
    name: 'PaPlum',
    categoryId: 'KAFE',
    quantity: 37,
  });
  if (!custom.ok) throw Error(custom.message);
  expect(config.updateProduct({ ...custom.data, sellingPriceCents: 130 }).ok).toBe(true);
  original.close();
  const upgraded = openDatabase(file, '0.7.2-rc.4', true);
  try {
    const products = createRepositories(upgraded, true, true)
      .listProducts()
      .filter((p) => hotDrinkNameKey(p.name) === hotDrinkNameKey('Pa plumb'));
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      id: custom.data.id,
      sellingPriceCents: 120,
      stockQuantity: 37,
      coffeeRecipe: { stockProductId: 'KAFE-1', doses: 1 },
    });
  } finally {
    upgraded.close();
  }
});

it('creates a custom product and its first supply once, preserving an open DUO order', () => {
  const initial = openDatabase(file);
  initial.prepare("UPDATE settings SET value='DUO' WHERE key='business_name'").run();
  const earlier = createConfigurationService(
    initial,
    createRepositories(initial),
  ).createProductWithStock({
    requestId: randomUUID(),
    name: 'Pije para konfigurimit DUO',
    categoryId: 'PIJE',
    quantity: 12,
  });
  if (!earlier.ok) throw Error(earlier.message);
  const before = createRepositories(initial);
  expect(
    createConfigurationService(initial, before).updateProduct({
      ...earlier.data,
      sellingPriceCents: 200,
    }).ok,
  ).toBe(true);
  const pending = createOrderService(initial, before).addProduct({
    tableId: 'M3',
    productId: earlier.data.id,
  });
  if (!pending.ok || !pending.data.order)
    throw Error('Expected an open order for the retired product');
  initial.close();

  const request: NewStockProductRequest = {
    requestId: randomUUID(),
    name: '  Pije speciale e shtëpisë  ',
    categoryId: 'PIJE',
    quantity: 24,
    drawerPaymentCents: 1200,
  };
  let db = openDatabase(file, '0.7.2-rc.4', true);
  try {
    const repo = createRepositories(db, true, true);
    expect(hasDuoMenu(db)).toBe(true);
    expect(repo.listProducts().some(({ id }) => id === earlier.data.id)).toBe(false);
    const config = createConfigurationService(db, repo, true);
    const orders = createOrderService(db, repo, { operator: () => 'OWNER' });
    expect(orders.getForTable('M3').order).toEqual(pending.data.order);
    expect(
      createCheckoutService(db, orders, true).completeOrder({ orderId: pending.data.order.id }).ok,
    ).toBe(true);
    expect(
      db
        .prepare('SELECT quantity FROM inventory_balances WHERE product_id=?')
        .pluck()
        .get(earlier.data.id),
    ).toBe(11);
    const existing = orders.addProduct({ tableId: 'M1', productId: 'duo-drinks-v1-1' });
    if (!existing.ok || !existing.data.order) throw Error('Expected a saved DUO order');

    const created = config.createProductWithStock(request);
    if (!created.ok) throw Error(created.message);
    const product = created.data;
    expect(product).toMatchObject({
      name: 'Pije speciale e shtëpisë',
      categoryId: 'PIJE',
      purchaseCostCents: null,
      sellingPriceCents: null,
      stockQuantity: 24,
      trackInventory: true,
      active: true,
    });
    expect(repo.listProducts()).toHaveLength(63);
    expect(orders.addProduct({ tableId: 'M2', productId: product.id }).ok).toBe(false);
    expect(orders.getForTable('M1')).toEqual(existing.data);
    expect(config.createProductWithStock(request)).toEqual(created);
    expect(
      config.createProductWithStock({ ...request, requestId: request.requestId.toUpperCase() }),
    ).toEqual(created);
    expect(config.createProductWithStock({ ...request, name: 'Emër tjetër' }).ok).toBe(false);
    expect(config.createProductWithStock({ ...request, categoryId: 'UJE' }).ok).toBe(false);
    expect(config.createProductWithStock({ ...request, quantity: 25 }).ok).toBe(false);
    expect(config.createProductWithStock({ ...request, drawerPaymentCents: 1500 }).ok).toBe(false);

    db.close();
    db = openDatabase(file, '0.7.2-rc.4', true);
    const reopened = createRepositories(db, true, true);
    const reopenedConfig = createConfigurationService(db, reopened, true);
    expect(hasDuoMenu(db)).toBe(true);
    expect(reopened.listProducts(true)).toContainEqual(product);
    expect(reopenedConfig.createProductWithStock(request)).toEqual(created);
    expect(
      db
        .prepare('SELECT COUNT(*) FROM inventory_movements WHERE product_id=?')
        .pluck()
        .get(product.id),
    ).toBe(1);
    expect(
      db
        .prepare("SELECT kind, amount_cents FROM cash_events WHERE kind='INVENTORY_SUPPLY_OUT'")
        .all(),
    ).toEqual([{ kind: 'INVENTORY_SUPPLY_OUT', amount_cents: -1200 }]);

    const updated = reopenedConfig.updateProduct({
      ...product,
      name: 'Pija e shtëpisë',
      sellingPriceCents: 200,
    });
    expect(updated.ok).toBe(true);
    expect(reopenedConfig.createProductWithStock(request)).toEqual(updated);
    const reopenedOrders = createOrderService(db, reopened, { operator: () => 'OWNER' });
    expect(reopenedOrders.getForTable('M1')).toEqual(existing.data);
    expect(reopenedOrders.addProduct({ tableId: 'M2', productId: product.id }).ok).toBe(true);
    const stockRequest = { requestId: randomUUID(), productId: product.id, quantity: 4 };
    expect(reopenedConfig.addSupply(stockRequest)).toMatchObject({
      ok: true,
      data: { stockQuantity: 28 },
    });
    expect(reopenedConfig.archiveProduct(product.id).ok).toBe(true);
    expect(reopened.listProducts().some(({ id }) => id === product.id)).toBe(false);
    expect(reopenedConfig.createProductWithStock(request).ok).toBe(false);
    expect(reopenedOrders.getForTable('M2').order?.items[0]?.productId).toBe(product.id);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    if (db.open) db.close();
  }
});

it('upgrades the older DUO catalog without changing history or stock balances', () => {
  const original = openDatabase(file);
  const readHistory = (db: typeof original) =>
    [
      'orders',
      'order_items',
      'order_payments',
      'cash_events',
      'receipt_documents',
      'inventory_movements',
      'cafe_tables',
    ].map((table) => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  let balances;
  let history;
  try {
    original.prepare("UPDATE settings SET value='DUO' WHERE key='business_name'").run();
    original
      .prepare(
        "UPDATE products SET purchase_cost_cents=30,selling_price_cents=100,track_inventory=1 WHERE id='KAFE-1'",
      )
      .run();
    original.prepare("UPDATE inventory_balances SET quantity=5 WHERE product_id='KAFE-1'").run();
    const repo = createRepositories(original);
    const orders = createOrderService(original, repo);
    const order = orders.addProduct({ tableId: 'M1', productId: 'KAFE-1' });
    if (!order.ok || !order.data.order) throw new Error('Expected an open synthetic order');
    expect(
      createCheckoutService(original, orders).completeOrder({ orderId: order.data.order.id }).ok,
    ).toBe(true);
    balances = original.prepare('SELECT * FROM inventory_balances ORDER BY rowid').all();
    history = readHistory(original);
    // An empty v7-only table can be removed here to represent the exact v6 fixture.
    original.exec('DROP TABLE duo_order_lines; DELETE FROM schema_migrations WHERE version=7');
    expect(inspectDatabase(original, true)).toBe(6);
  } finally {
    original.close();
  }

  const updated = openDatabase(file, '0.7.2-rc.4', true);
  try {
    expect(inspectDatabase(updated, true)).toBe(7);
    expect(
      fs.readdirSync(path.join(directory, 'backups')).some((name) => name.endsWith('.sqlite')),
    ).toBe(true);
    const all = createRepositories(updated).listProducts();
    const imported = all.filter(({ id }) => id.startsWith('duo-drinks-v1-'));
    expect(updated.prepare('SELECT * FROM inventory_balances ORDER BY rowid').all()).toEqual(
      expect.arrayContaining(balances!),
    );
    expect(imported).toHaveLength(14);
    expect(imported.find(({ name }) => name === 'Tuborg')?.purchaseCostCents).toBe(104);
    expect(imported.find(({ name }) => name === 'Heineken')?.purchaseCostCents).toBeNull();
    for (const product of imported) {
      expect(product.sellingPriceCents).toBeGreaterThan(0);
      expect(product).toMatchObject({
        active: true,
        trackInventory: false,
        stockQuantity: null,
      });
    }
    expect(readHistory(updated)).toEqual(history);
    expect(updated.pragma('foreign_key_check')).toEqual([]);
  } finally {
    updated.close();
  }

  const reopened = openDatabase(file, '0.7.2-rc.4', true);
  try {
    expect(createRepositories(reopened).listProducts()).toHaveLength(62);
    expect(readHistory(reopened)).toEqual(history);
  } finally {
    reopened.close();
  }
});

it('keeps fresh, other business, non-target and locally changed catalogs out of the rollout', () => {
  const fresh = openDatabase(file, '0.7.2-rc.4', true);
  expect(createRepositories(fresh).listProducts()).toHaveLength(21);
  fresh.close();

  const otherBusiness = openDatabase(file, '0.7.2-rc.4', true);
  expect(createRepositories(otherBusiness).listProducts()).toHaveLength(21);
  otherBusiness.prepare("UPDATE settings SET value='DUO' WHERE key='business_name'").run();
  otherBusiness.close();

  const otherTerminal = openDatabase(file);
  expect(createRepositories(otherTerminal).listProducts()).toHaveLength(21);
  otherTerminal.prepare("UPDATE products SET name='Heineken' WHERE id='ALKOOL-1'").run();
  otherTerminal.close();

  const changed = openDatabase(file, '0.7.2-rc.4', true);
  try {
    const products = createRepositories(changed).listProducts();
    expect(products).toHaveLength(21);
    expect(products.filter(({ name }) => name === 'Heineken')).toHaveLength(1);
  } finally {
    changed.close();
  }
});

it('orders the printed menu and reconciles payment, stock and reopening', () => {
  const original = openDatabase(file);
  original.prepare("UPDATE settings SET value='DUO' WHERE key='business_name'").run();
  original.transaction(() => addDuoCatalog(original, new Date().toISOString()))();
  const cola = 'duo-drinks-v1-1';
  const espresso = 'KAFE-1';
  original.prepare('UPDATE products SET selling_price_cents=? WHERE id=?').run(160, cola);
  original
    .prepare(
      'UPDATE products SET active=0, selling_price_cents=120, purchase_cost_cents=50, track_inventory=1 WHERE id=?',
    )
    .run(espresso);
  original.prepare('UPDATE inventory_balances SET quantity=535 WHERE product_id=?').run(espresso);
  original.close();

  const upgraded = openDatabase(file, '0.7.2-rc.4', true);
  try {
    const repo = createRepositories(upgraded, true, true);
    const config = createConfigurationService(upgraded, repo, true);
    const menu = repo.listProducts(true);
    expect(menu).toHaveLength(62);
    expect(
      menu.filter((p) => drinkCategory(p.categoryId, true) === 'KAFE').map((p) => p.id),
    ).toEqual(
      expect.arrayContaining(
        DUO_HOT_DRINKS.filter(([, , category]) => category !== 'PIJE').map(([id]) => id),
      ),
    );
    for (const name of ['Ice Latte', 'Ice Amerikane']) {
      const iced = menu.find((p) => p.name === name)!;
      expect(iced).toMatchObject({
        categoryId: 'PIJE',
        coffeeRecipe: { stockProductId: espresso },
      });
      expect(config.updateProduct(iced).ok).toBe(true);
    }
    expect(menu.find((p) => p.id === espresso)).toMatchObject({
      active: true,
      sellingPriceCents: 100,
      purchaseCostCents: null,
      stockQuantity: 535,
    });
    expect(menu.every((product) => product.active && product.sellingPriceCents !== null)).toBe(
      true,
    );
    expect(menu.find((product) => product.id === cola)).toMatchObject({
      sellingPriceCents: 150,
      trackInventory: false,
      stockQuantity: null,
    });
    expect(repo.listProducts().some((product) => product.id === 'KAFE-1')).toBe(true);
    expect(
      upgraded.prepare('SELECT active FROM products WHERE id=?').pluck().get('duo-drinks-v1-12'),
    ).toBe(0);
    expect(menu.find((product) => product.name === 'Tequila')).toMatchObject({
      sellingPriceCents: 250,
      purchaseCostCents: null,
      stockQuantity: null,
    });
    expect(upgraded.prepare('SELECT count(*) FROM inventory_movements').pluck().get()).toBe(0);

    const count = { requestId: randomUUID(), productId: cola, quantity: 12 };
    expect(config.addSupply(count)).toMatchObject({
      ok: true,
      data: { stockQuantity: 12, trackInventory: true },
    });
    expect(config.addSupply(count)).toMatchObject({ ok: true, data: { stockQuantity: 12 } });
    const orders = createOrderService(upgraded, repo, { operator: () => 'AM' });
    const draft = {
      requestId: randomUUID(),
      tableId: 'M1',
      orderId: null,
      expectedRevision: null,
      items: [
        { productId: espresso, quantity: 1 },
        { productId: cola, quantity: 1 },
      ],
    };
    const order = orders.submitDraft(draft);
    if (!order.ok || !order.data.order) throw Error('Expected a priced order');
    expect(order.data.order.totalCents).toBe(250);
    expect(orders.submitDraft(draft).ok).toBe(true);
    expect(repo.listProducts(true).find((p) => p.id === espresso)?.stockQuantity).toBe(534);
    expect(
      createCheckoutService(upgraded, orders, true).completeOrder({ orderId: order.data.order.id })
        .ok,
    ).toBe(true);
    expect(repo.listProducts(true).find((p) => p.id === cola)?.stockQuantity).toBe(11);
    expect(repo.listProducts(true).find((p) => p.id === espresso)?.stockQuantity).toBe(534);
    expect(readShiftSales(upgraded, 'AM').totalCents).toBe(250);
    expect(readShiftSales(upgraded, 'DAY').totalCents).toBe(250);
    expect(upgraded.prepare('SELECT count(*) FROM receipt_documents').pluck().get()).toBe(1);
    upgraded.prepare('UPDATE products SET active=0,selling_price_cents=200 WHERE id=?').run(cola);
    upgraded
      .prepare('UPDATE products SET active=0,selling_price_cents=130 WHERE id=?')
      .run(espresso);
  } finally {
    upgraded.close();
  }

  const reopened = openDatabase(file, '0.7.2-rc.4', true);
  try {
    const menu = createRepositories(reopened, true, true).listProducts(true);
    expect(menu.find((p) => p.id === cola)).toMatchObject({
      active: false,
      sellingPriceCents: 200,
      stockQuantity: 11,
    });
    expect(menu.find((p) => p.id === espresso)).toMatchObject({
      active: false,
      sellingPriceCents: 130,
      stockQuantity: 534,
    });
    expect(readShiftSales(reopened, 'DAY').totalCents).toBe(250);
  } finally {
    reopened.close();
  }
});

it('applies the printed prices on a terminal that already has the previous menu', () => {
  const prior = openDatabase(file);
  try {
    prior.prepare("UPDATE settings SET value='DUO' WHERE key='business_name'").run();
    prior.transaction(() => addDuoCatalog(prior, new Date().toISOString()))();
    prior
      .prepare('INSERT INTO settings VALUES (\'duo_hot_drinks_v1\', \'["KAFE-1","KAFE-2"]\')')
      .run();
    prior.prepare("UPDATE products SET active=0,selling_price_cents=145 WHERE id='KAFE-1'").run();
    prior
      .prepare("UPDATE products SET active=0,selling_price_cents=215 WHERE id='duo-drinks-v1-1'")
      .run();
  } finally {
    prior.close();
  }
  const upgraded = openDatabase(file, '0.7.2-rc.4', true);
  try {
    const menu = createRepositories(upgraded, true, true).listProducts(true);
    expect(menu.find((p) => p.id === 'KAFE-1')).toMatchObject({
      active: true,
      sellingPriceCents: 100,
      stockQuantity: null,
    });
    expect(menu.find((p) => p.id === 'duo-drinks-v1-1')).toMatchObject({
      active: true,
      sellingPriceCents: 150,
      stockQuantity: null,
    });
    expect(upgraded.prepare('SELECT count(*) FROM inventory_movements').pluck().get()).toBe(0);
  } finally {
    upgraded.close();
  }
});
