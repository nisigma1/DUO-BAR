import { amountError } from '../../domain/operatorInput';
import { useContext, useRef, useState } from 'react';
import type { CatalogProduct, CategoryCode } from '../../domain/types';
import { parseEuro } from '../../domain/money';
import { productDisplayName } from '../../domain/display';
import { CATEGORIES } from '../../domain/definitions';
import {
  canSupplyProduct,
  parseQuantity,
  type FieldErrors,
  type SupplyProduct,
} from '../../domain/configuration';
import { Button, EmptyState, Field, SidePanel, useFieldErrorFocus } from '../common/Controls';
import { DataState } from '../common/DataState';
import { OperatorContext } from '../../app/operatorContext';
import { useData } from '../../app/useData';
import { COFFEE_STOCK_ID, coffeePortions, coffeeStockLabel } from '../../domain/operators';

type SupplyActions = {
  onClose: () => void;
  onSaved: (product: CatalogProduct) => void;
};
type SupplyProducts =
  | { products: SupplyProduct[] }
  | { products: undefined; error: boolean; retry: () => void };
const loadSupplyProducts = () => window.fox.inventory.supplyProducts();
const newProductOption = 'new-product';

export function StaffSupplyPanel(props: SupplyActions) {
  const { data, error, retry } = useData(loadSupplyProducts);
  const catalog = data ? { products: data } : { products: undefined, error, retry };
  return <SupplyPanel {...props} {...catalog} />;
}

export function SupplyPanel(props: SupplyActions & SupplyProducts) {
  const { products, onClose, onSaved } = props;
  const { required: duo, duoMenu, operator } = useContext(OperatorContext);
  const canManageStock = !duo || operator === 'OWNER';
  const eligible = products?.filter((product) => canSupplyProduct(product, duo)) ?? [];
  const canSubmit = Boolean(products && (eligible.length > 0 || canManageStock));
  const [productId, setProductId] = useState('');
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState<CategoryCode>('PIJE');
  const [drawer, setDrawer] = useState(false),
    [paid, setPaid] = useState('');
  const [quantity, setQuantity] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const clearError = (key: string) =>
    setErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  const selected = eligible.find((p) => p.id === productId);
  const creating = canManageStock && productId === newProductOption;
  const coffee = duo && selected?.id === COFFEE_STOCK_ID;
  const displayName = (product: SupplyProduct) =>
    duo && product.id === COFFEE_STOCK_ID
      ? 'Kafe (stok i përbashkët)'
      : productDisplayName(product.name, duo || Boolean(duoMenu));
  useFieldErrorFocus(errors, busy, 'supply-form');
  let amountPreview: number | null = null;
  try {
    const value = parseQuantity(quantity);
    if (value !== null && value > 0) amountPreview = coffee ? coffeePortions(value) : value;
  } catch {
    /* Show no result for invalid input. */
  }
  const currentStock = selected?.stockQuantity ?? 0;
  const nextStock =
    (selected || creating) && amountPreview !== null ? currentStock + amountPreview : null;
  const validPreview =
    nextStock !== null &&
    Number.isFinite(nextStock) &&
    nextStock <= Number.MAX_SAFE_INTEGER &&
    nextStock > currentStock;
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    const nextErrors: FieldErrors = {};
    let amount: number | null = null;
    try {
      amount = parseQuantity(quantity);
      if (coffee && amount !== null) coffeePortions(amount);
      if (amount === null || amount <= 0)
        nextErrors.quantity = 'Sasia duhet të jetë më e madhe se zero.';
    } catch {
      nextErrors.quantity = coffee
        ? 'Shkruaj kilogramët me deri në tri shifra pas presjes.'
        : 'Vendos një sasi të vlefshme, më të madhe se zero.';
    }
    if (creating) {
      if (!name.trim()) nextErrors.name = 'Shkruaj emrin e produktit.';
    } else if (!selected) nextErrors.productId = 'Zgjidh produktin.';
    let drawerPaymentCents: number | undefined;
    if (canManageStock && drawer) {
      const issue = amountError(paid);
      if (issue) nextErrors.drawerPaymentCents = issue;
      else drawerPaymentCents = parseEuro(paid)!;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length || amount === null) return;
    submitting.current = true;
    setBusy(true);
    try {
      const supply = {
        requestId,
        quantity: amount,
        ...(drawerPaymentCents !== undefined ? { drawerPaymentCents } : {}),
      };
      const result = await (creating
        ? window.fox.inventory.createProductWithStock({
            ...supply,
            name: name.trim(),
            categoryId,
          })
        : window.fox.inventory.addSupply({ ...supply, productId }));
      if (result.ok) onSaved(result.data);
      else setErrors(result.errors);
    } catch (error) {
      console.error('FOX supply failed', error);
      setErrors({ form: 'Furnizimi nuk u konfirmua. Provo përsëri me të njëjtat të dhëna.' });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <SidePanel
      title="Shto stok"
      subtitle="Regjistro sasinë në stokun e produktit."
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Anulo
          </Button>
          <Button variant="primary" type="submit" form="supply-form" disabled={busy || !canSubmit}>
            {busy ? 'Duke regjistruar…' : creating ? 'Ruaj produktin dhe stokun' : 'Shto stok'}
          </Button>
        </>
      }
    >
      {!props.products ? (
        <DataState error={props.error} retry={props.retry} />
      ) : !canSubmit ? (
        <EmptyState
          title={duo ? 'Nuk ka produkte për furnizim' : 'Nuk ka produkte me stok aktiv'}
          helper={
            duo
              ? 'Lista e produkteve është bosh.'
              : 'Hap Edito produktin dhe vendos «Mbaj stok?» në «Po».'
          }
        />
      ) : (
        <form id="supply-form" onSubmit={save} noValidate>
          {errors.form && (
            <p role="alert" className="form-error">
              {errors.form}
            </p>
          )}
          <fieldset disabled={busy}>
            <Field id="productId" label="Produkti" error={errors.productId}>
              <select
                id="productId"
                value={productId}
                onChange={(e) => {
                  setProductId(e.target.value);
                  clearError('productId');
                }}
                data-initial-focus
                aria-invalid={Boolean(errors.productId)}
                aria-describedby={errors.productId ? 'productId-error' : undefined}
              >
                <option value="">Zgjidh produktin</option>
                {canManageStock && <option value={newProductOption}>+ Produkt i ri</option>}
                {eligible.map((p) => (
                  <option value={p.id} key={p.id}>
                    {displayName(p)}
                    {!p.active && ' · Joaktiv'}
                  </option>
                ))}
              </select>
            </Field>
            {creating && (
              <>
                <Field id="new-product-name" label="Emri i produktit" error={errors.name}>
                  <input
                    id="new-product-name"
                    value={name}
                    maxLength={200}
                    autoFocus
                    onChange={(e) => {
                      setName(e.target.value);
                      clearError('name');
                    }}
                    aria-invalid={Boolean(errors.name)}
                    aria-describedby={errors.name ? 'new-product-name-error' : undefined}
                  />
                </Field>
                <Field id="new-product-category" label="Kategoria" error={errors.categoryId}>
                  <select
                    id="new-product-category"
                    value={categoryId}
                    onChange={(e) => {
                      setCategoryId(e.target.value as CategoryCode);
                      clearError('categoryId');
                    }}
                    aria-invalid={Boolean(errors.categoryId)}
                    aria-describedby={errors.categoryId ? 'new-product-category-error' : undefined}
                  >
                    {CATEGORIES.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <p className="field-helper">
                  Çmimin e shitjes mund ta vendosësh te «Edito produktin».
                </p>
              </>
            )}
            <Field
              id="quantity"
              label={coffee ? 'Sasia (kg)' : duo || creating ? 'Sasia (copë)' : 'Sasia'}
              error={errors.quantity}
            >
              <input
                id="quantity"
                inputMode="decimal"
                placeholder={duo || creating ? (coffee ? 'p.sh. 0,5' : 'p.sh. 24') : undefined}
                value={quantity}
                onChange={(e) => {
                  setQuantity(e.target.value);
                  clearError('quantity');
                }}
                aria-invalid={Boolean(errors.quantity)}
                aria-describedby={errors.quantity ? 'quantity-error' : undefined}
              />
            </Field>
            {canManageStock && (
              <>
                <label className="finance-check">
                  <input
                    type="checkbox"
                    checked={drawer}
                    onChange={(e) => {
                      setDrawer(e.target.checked);
                      clearError('drawerPaymentCents');
                    }}
                  />
                  Paguar nga arka
                </label>
                {drawer && (
                  <Field
                    id="supply-paid"
                    label="Shuma e paguar (€)"
                    error={errors.drawerPaymentCents}
                  >
                    <input
                      id="supply-paid"
                      inputMode="decimal"
                      value={paid}
                      onChange={(e) => {
                        setPaid(e.target.value);
                        clearError('drawerPaymentCents');
                      }}
                      aria-invalid={Boolean(errors.drawerPaymentCents)}
                      aria-describedby={errors.drawerPaymentCents ? 'supply-paid-error' : undefined}
                    />
                  </Field>
                )}
                <p className="field-helper">
                  Nëse paguan nga arka, shëno shumën që nxore. Blerja e stokut nuk regjistrohet dy
                  herë si shpenzim.
                </p>
              </>
            )}
            <section className="supply-summary" aria-labelledby="supply-summary-title">
              <h3 id="supply-summary-title">Përmbledhja</h3>
              <dl>
                <div>
                  <dt>Produkti</dt>
                  <dd>{creating ? name.trim() || '—' : selected ? displayName(selected) : '—'}</dd>
                </div>
                <div>
                  <dt>Stoku tani</dt>
                  <dd>
                    {creating
                      ? 0
                      : selected
                        ? selected.stockQuantity === null
                          ? 'Pa vendosur'
                          : coffee
                            ? coffeeStockLabel(selected.stockQuantity)
                            : selected.stockQuantity
                        : '—'}
                  </dd>
                </div>
                <div>
                  <dt>Sasia që shtohet</dt>
                  <dd>
                    {amountPreview === null
                      ? '—'
                      : coffee
                        ? coffeeStockLabel(amountPreview)
                        : amountPreview}
                  </dd>
                </div>
                <div className="supply-result">
                  <dt>Stoku pas shtimit</dt>
                  <dd aria-live="polite">
                    {validPreview ? (coffee ? coffeeStockLabel(nextStock!) : nextStock) : '—'}
                  </dd>
                </div>
              </dl>
            </section>
            {selected?.stockQuantity === null && (
              <p className="notice warning-notice">
                Kjo është vendosja fillestare e stokut. Sasia e regjistruar do të bëhet stoku
                aktual; verifiko sasinë përpara konfirmimit.
              </p>
            )}
            {duo && selected && selected.trackInventory !== true && (
              <p className="field-helper">
                Nëse ndjekja e stokut mbetet e fikur pas furnizimit, pronari mund ta aktivizojë te
                «Edito produktin».
              </p>
            )}
            <p className="field-helper">Çdo furnizim ruhet në historikun e lëvizjeve të stokut.</p>
          </fieldset>
        </form>
      )}
    </SidePanel>
  );
}
