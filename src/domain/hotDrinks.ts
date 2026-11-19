import { CATEGORIES } from './definitions';
import { COFFEE_STOCK_ID, isCoffee } from './operators';
import type { CatalogProduct, CategoryCode } from './types';

// Names and selling prices from the DUO menu.
export const DUO_HOT_DRINKS = [
  ['KAFE-1', 'Espresso', 'KAFE', 100, ['ekspreso']],
  ['KAFE-3', 'Double Espresso', 'KAFE', 180, ['espresso dopio', 'ekspreso dopio']],
  ['KAFE-4', 'Makiato e vogël', 'KAFE', 100, ['makiato i vogël']],
  ['KAFE-5', 'Makiato e madhe', 'KAFE', 150, ['makiato i madh']],
  ['KAFE-2', 'Pa plumb', 'KAFE', 120, ['pa plum', 'espresso pa plumb', 'espresso pa plum']],
  ['KAFE-8', 'Amerikane', 'KAFE', 100, ['amerikano', 'americano']],
  ['KAFE-6', 'Cappuccino', 'KAFE', 150, ['kapuçino', 'kapuccino']],
  ['duo-hot-v1-nescafe-classic', 'Nescafé Classic', 'KAFE', 150, []],
  ['duo-hot-v1-nescafe-vanille', 'Nescafé Vanille', 'KAFE', 150, ['nescafé vanilje']],
  ['duo-hot-v1-bambi', 'Bambi', 'CAJ', 150, []],
  ['duo-hot-v1-tea', 'Çaj', 'CAJ', 100, []],
  ['duo-hot-v1-chocolate', 'Çokollatë e nxehtë', 'CAJ', 200, []],
  ['KAFE-7', 'Latte Caffè', 'KAFE', 150, ['latte makiato', 'caffè latte']],
  ['duo-hot-v1-ice-latte', 'Ice Latte', 'PIJE', 200, ['iced latte']],
  ['duo-hot-v1-ice-americano', 'Ice Amerikane', 'PIJE', 180, ['ice americano', 'iced americano']],
  ['duo-hot-v1-no-foam', 'Pa shkumë', 'KAFE', 120, []],
  ['duo-hot-v1-espresso-50', 'Espresso 50', 'KAFE', 100, []],
  ['duo-hot-v1-espresso-70', 'Espresso 70', 'KAFE', 100, []],
  ['duo-hot-v1-long-espresso', 'Espresso e gjatë', 'KAFE', 100, []],
  ['duo-hot-v1-short-espresso', 'Espresso e shkurtër', 'KAFE', 100, ['espresso e shkurtë']],
] as const satisfies ReadonlyArray<
  readonly [string, string, CategoryCode, number, readonly string[]]
>;

export const drinkNameKey = (name: string) =>
  name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/ekspreso/g, 'espresso');

const menuNames = new Map(
  DUO_HOT_DRINKS.flatMap((entry) =>
    [entry[1], ...entry[4]].map((name) => [drinkNameKey(name), entry] as const),
  ),
);
export const hotDrinkNameKey = (name: string) => {
  const key = drinkNameKey(name);
  return menuNames.get(key)?.[0] ?? key;
};

export function suggestHotDrinkCategory(name: string): CategoryCode | undefined {
  const key = drinkNameKey(name);
  if (!key || /^(?:caj|tea|icetea|icedtea).*(?:ftoht|cold)|^(?:ice|iced)tea/.test(key)) return;
  const menu = menuNames.get(key);
  if (menu) return menu[2];
  if (
    /espresso|makiato|macchiato|cappuccino|kapucino|americano|amerikane|amerikano|nescafe|latte|^kafe|^paplumb?/.test(
      key,
    )
  )
    return 'KAFE';
  if (/^caj|^tea|^cokollateenxehte|^hotchocolate/.test(key)) return 'CAJ';
}

export type CoffeeRecipe = { stockProductId: string; doses: number };
export const LEGACY_COFFEE_RECIPE: CoffeeRecipe = { stockProductId: COFFEE_STOCK_ID, doses: 1 };

export function duoCoffeeRecipe(
  product: Pick<CatalogProduct, 'id' | 'name' | 'categoryId'>,
  catalogId = hotDrinkNameKey(product.name),
): CoffeeRecipe | undefined {
  const iced =
    product.id === 'duo-hot-v1-ice-latte' ||
    product.id === 'duo-hot-v1-ice-americano' ||
    (product.categoryId === 'PIJE' &&
      (catalogId === 'duo-hot-v1-ice-latte' || catalogId === 'duo-hot-v1-ice-americano'));
  if (!iced && !isCoffee(product.id) && product.categoryId !== 'KAFE') return;
  const custom = product.id.startsWith('custom-stock-v1-');
  const dedicated =
    product.id.startsWith('duo-hot-v1-nescafe-') || (custom && !iced && catalogId !== 'KAFE-2');
  return {
    stockProductId: dedicated ? product.id : COFFEE_STOCK_ID,
    doses:
      product.id === 'KAFE-3' ||
      catalogId === 'KAFE-3' ||
      (custom && /(?:double|dopio|dyfish)/.test(drinkNameKey(product.name)))
        ? 2
        : 1,
  };
}

export const duoDrinkCategories = CATEGORIES.filter(({ id }) => id !== 'CAJ').map((category) =>
  category.id === 'KAFE'
    ? { ...category, name: 'Pijet e ngrohta' }
    : category.id === 'PIJE'
      ? { ...category, name: 'Pijet e ftohta' }
      : category,
);

export function drinkCategory(id: CategoryCode, duoMenu: boolean): CategoryCode {
  return duoMenu && id === 'CAJ' ? 'KAFE' : id;
}
