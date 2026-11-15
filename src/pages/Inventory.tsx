import { useData } from '../app/useData';
import { useContext, useEffect, useState } from 'react';
import { DataState } from '../components/common/DataState';
import { productDisplayName } from '../domain/display';
import { formatMoney } from '../domain/money';
import { CATEGORIES } from '../domain/definitions';
import { inventorySummary, stockState, unitProfit } from '../domain/configuration';
import type { CatalogProduct, CategoryCode } from '../domain/types';
import { Button, EmptyState, Icon, PageHeader, StockBadge } from '../components/common/Controls';
import { ProductEditor } from '../components/inventory/ProductEditor';
import { SupplyPanel } from '../components/inventory/SupplyPanel';
import { StockLossPanel } from '../components/inventory/StockLossPanel';
import { OperatorContext } from '../app/operatorContext';
import { COFFEE_STOCK_ID, coffeeStockLabel, isCoffee } from '../domain/operators';
const load = () => window.fox.products.list();
export function Inventory() {
  const { required: duo, duoMenu } = useContext(OperatorContext);
  const { data: products, error, retry, setData } = useData(load);
  const [category, setCategory] = useState<CategoryCode | ''>('');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<{ product: CatalogProduct; archive: boolean }>();
  const [supply, setSupply] = useState(false);
  const [loss, setLoss] = useState(false);
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(''), 5000);
    return () => clearTimeout(timer);
  }, [feedback]);
  const onSaved = (product: CatalogProduct, message: string) => {
    setData((current) => current?.map((p) => (p.id === product.id ? product : p)));
    setEditor(undefined);
    setSupply(false);
    setFeedback(message);
  };
  const normalize = (value: string) =>
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('sq-AL');
  const categories = duoMenu
    ? CATEGORIES.filter((category) =>
        products?.some((product) => product.categoryId === category.id),
      )
    : CATEGORIES;
  const filtered =
    products?.filter(
      (p) =>
        (!category || p.categoryId === category) &&
        normalize(p.name).includes(normalize(search.trim())),
    ) ?? [];
  const summary = products
    ? inventorySummary(
        products.map((product) =>
          duo && isCoffee(product.id) && product.id !== COFFEE_STOCK_ID
            ? { ...product, trackInventory: false }
            : product,
        ),
      )
    : null;
  const coffee = duo ? products?.find((product) => product.id === COFFEE_STOCK_ID) : undefined;
  const header = (
    <PageHeader
      title="Stoku"
      helper="Produktet, Ã§mimet dhe stoku."
      actions={
        <>
          <Button variant="primary" onClick={() => setSupply(true)} disabled={!products}>
            <Icon name="plus" />
            Shto stok
          </Button>
          <Button data-stock-loss onClick={() => setLoss(true)} disabled={!products}>
            Hiq si humbje
          </Button>
        </>
      }
    />
  );
  if (!products || !summary)
    return (
      <>
        {header}
        <DataState error={error} retry={retry} />
      </>
    );
  return (
    <div data-page="inventory">
      {header}
      <dl className="summary-strip">
        <div>
          <dt>Produkte</dt>
          <dd>{summary.total}</dd>
          <small title="Blerja dhe Ã§mimi i shitjes janÃ« tÃ« dy tÃ« vendosur.">
            Ã‡mime tÃ« plota (blerje + shitje): {summary.fullyPriced}
          </small>
        </div>
        <div>
          <dt>Aktive</dt>
          <dd>{summary.active}</dd>
        </div>
        <div>
          <dt>Stok i ulÃ«t</dt>
          <dd>{summary.low}</dd>
        </div>
        <div>
          <dt>Vlera e mallit</dt>
          <dd className={summary.inventoryValueCents === null ? 'incomplete-value' : ''}>
            {summary.inventoryValueCents === null
              ? 'Pa tÃ« dhÃ«na tÃ« plota'
              : formatMoney(summary.inventoryValueCents)}
          </dd>
          <small>Sipas Ã§mimit tÃ« blerjes</small>
        </div>
      </dl>
      {coffee && (
        <p className="notice">
          Stoku i kafesÃ«:{' '}
          <strong>
            {coffee.stockQuantity === null ? 'Pa vendosur' : coffeeStockLabel(coffee.stockQuantity)}
          </strong>
        </p>
      )}
      <div className="inventory-surface">
        <div className="inventory-toolbar">
          <div className="category-filters" role="group" aria-label="Filtro sipas kategorisÃ«">
            <Button variant="ghost" onClick={() => setCategory('')} aria-pressed={category === ''}>
              TÃ« gjitha
            </Button>
            {categories.map((c) => (
              <Button
                variant="ghost"
                key={c.id}
                onClick={() => setCategory(c.id)}
                aria-pressed={category === c.id}
              >
                {c.name}
              </Button>
            ))}
          </div>
          <div className="search-control">
            <Icon name="search" />
            <label className="sr-only" htmlFor="product-search">
              KÃ«rko produkt
            </label>
            <input
              id="product-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="KÃ«rko produkt..."
              type="search"
            />
          </div>
        </div>
        <div className="table-caption">
          <span>
            {filtered.length} produkte{category || search ? ` nga ${summary.total}` : ''}
          </span>
          <span className="feedback" role="status">
            {feedback && (
              <>
                <Icon name="check" />
                {feedback}
              </>
            )}
          </span>
          <span>Â«â€”Â» = Pa vendosur</span>
        </div>
        {filtered.length ? (
          <div className="catalog-scroll">
            <table className="catalog">
              <thead>
                <tr>
                  <th>Produkti</th>
                  <th>Kategoria</th>
                  <th className="numeric">Stoku</th>
                  <th className="numeric">Blerja</th>
                  <th className="numeric">Shitja</th>
                  <th className="numeric">Fitimi pÃ«r copÃ«</th>
                  <th className="product-status">Statusi</th>
                  <th className="actions-heading">Veprime</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((product) => {
                  const state = stockState(product);
                  return (
                    <tr
                      key={product.id}
                      className={product.active ? '' : 'inactive-row'}
                      onClick={() => setEditor({ product, archive: false })}
                    >
                      <td className="product-name">
                        {productDisplayName(product.name, duo || Boolean(duoMenu))}
                      </td>
                      <td>{product.categoryName}</td>
                      <td className="stock-cell numeric">
                        {duo && isCoffee(product.id) && product.id !== COFFEE_STOCK_ID ? (
                          'Stok i pÃ«rbashkÃ«t'
                        ) : (
                          <>
                            {product.trackInventory === true && product.stockQuantity !== null && (
                              <strong>
                                {duo && product.id === COFFEE_STOCK_ID
                                  ? coffeeStockLabel(product.stockQuantity)
                                  : product.stockQuantity}
                              </strong>
                            )}
                            {duoMenu && product.stockQuantity === null ? (
                              <span>Pa numÃ«ruar</span>
                            ) : (
                              state !== 'KNOWN' && <StockBadge state={state} />
                            )}
                          </>
                        )}
                      </td>
                      <td className="numeric">
                        {product.purchaseCostCents === null
                          ? 'â€”'
                          : formatMoney(product.purchaseCostCents)}
                      </td>
                      <td className="numeric">
                        {product.sellingPriceCents === null
                          ? 'Pa Ã§mim'
                          : formatMoney(product.sellingPriceCents)}
                      </td>
                      <td className="numeric">
                        {unitProfit(product) === null ? 'â€”' : formatMoney(unitProfit(product))}
                      </td>
                      <td className="product-status">{product.active ? 'Aktiv' : 'Joaktiv'}</td>
                      <td className="row-actions">
                        <Button
                          variant="ghost"
                          aria-label={`Edito ${productDisplayName(product.name, duo || Boolean(duoMenu))}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditor({ product, archive: false });
                          }}
                        >
                          <Icon name="edit" />
                          Edito
                        </Button>
                        {(!duo || product.id !== COFFEE_STOCK_ID) && (
                          <Button
                            data-remove-product-row={product.id}
                            variant="danger"
                            aria-label={`Hiq produktin ${productDisplayName(product.name, duo || Boolean(duoMenu))}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditor({ product, archive: true });
                            }}
                          >
                            Hiq produktin
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="Nuk u gjet asnjÃ« produkt"
            helper="Provo njÃ« emÃ«r tjetÃ«r ose ndrysho filtrin e kategorisÃ«."
            icon="search"
          />
        )}
      </div>
      {editor && (
        <ProductEditor
          product={editor.product}
          canArchive={!duo || editor.product.id !== COFFEE_STOCK_ID}
          initiallyConfirmArchive={editor.archive}
          onArchived={(id) => {
            if (
              category &&
              products.filter((p) => p.categoryId === category).every((p) => p.id === id)
            )
              setCategory('');
            setData((current) => current?.filter((p) => p.id !== id));
            setEditor(undefined);
            setFeedback('Produkti u hoq.');
          }}
          onClose={() => setEditor(undefined)}
          onSaved={(product) => onSaved(product, 'Produkti u ruajt.')}
        />
      )}
      {supply && (
        <SupplyPanel
          products={products}
          onClose={() => setSupply(false)}
          onSaved={(product) => onSaved(product, 'Furnizimi u regjistrua.')}
        />
      )}
      {loss && (
        <StockLossPanel
          products={products}
          onClose={() => setLoss(false)}
          onSaved={() => {
            setLoss(false);
            setFeedback('Humbja u regjistrua dhe stoku u pÃ«rditÃ«sua.');
            retry();
          }}
        />
      )}
    </div>
  );
}
