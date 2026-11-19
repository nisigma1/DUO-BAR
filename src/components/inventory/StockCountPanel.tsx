import { useRef, useState } from 'react';
import { parseQuantity, stockHolderId, type FieldErrors } from '../../domain/configuration';
import { COFFEE_STOCK_ID, coffeePortions, coffeeStockLabel } from '../../domain/operators';
import type { CatalogProduct } from '../../domain/types';
import { Button, Field, SidePanel, useFieldErrorFocus } from '../common/Controls';

export function StockCountPanel({
  products,
  duo,
  onClose,
  onSaved,
}: {
  products: CatalogProduct[];
  duo: boolean;
  onClose: () => void;
  onSaved: (product: CatalogProduct) => void;
}) {
  const eligible = products.filter((product) => stockHolderId(product, duo) === product.id);
  const [productId, setProductId] = useState(() =>
    duo && eligible.some(({ id }) => id === COFFEE_STOCK_ID) ? COFFEE_STOCK_ID : '',
  );
  const [quantity, setQuantity] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const request = useRef<{ signature: string; id: string }>(undefined);
  const selected = eligible.find(({ id }) => id === productId);
  const coffee = Boolean(selected?.coffeeRecipe || (duo && selected?.id === COFFEE_STOCK_ID));
  useFieldErrorFocus(errors, busy, 'stock-count-form');

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    if (!selected) {
      setErrors({ productId: 'Zgjidh produktin.' });
      return;
    }
    let total: number;
    try {
      total = parseQuantity(quantity)!;
      if (coffee && total !== 0) coffeePortions(total);
    } catch (error) {
      setErrors({ quantity: (error as Error).message });
      return;
    }
    const expectedQuantity = selected.stockQuantity;
    const signature = JSON.stringify([productId, total, expectedQuantity]);
    if (request.current?.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    submitting.current = true;
    setBusy(true);
    setErrors({});
    try {
      const result = await window.fox.inventory.setStockCount({
        requestId: request.current.id,
        productId,
        quantity: total,
        expectedQuantity,
      });
      if (result.ok) onSaved(result.data);
      else setErrors(result.errors);
    } catch {
      setErrors({ form: 'Ruajtja nuk u konfirmua. Provo përsëri me të njëjtat të dhëna.' });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <SidePanel
      eyebrow=""
      title="Ndrysho stokun"
      subtitle="Shkruaj sasinë totale që ke në stok. Mund të vendosësh edhe zero."
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Anulo
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="stock-count-form"
            disabled={busy || !selected}
          >
            {busy ? 'Duke ruajtur…' : 'Ruaj stokun'}
          </Button>
        </>
      }
    >
      <form id="stock-count-form" onSubmit={save} noValidate>
        {errors.form && (
          <p role="alert" className="form-error">
            {errors.form}
          </p>
        )}
        <fieldset disabled={busy}>
          <Field id="stock-count-product" label="Produkti" error={errors.productId}>
            <select
              id="stock-count-product"
              data-initial-focus
              value={productId}
              aria-invalid={!!errors.productId}
              onChange={(event) => {
                setProductId(event.target.value);
                setQuantity('');
                setErrors({});
              }}
            >
              <option value="">Zgjidh produktin</option>
              {eligible.map((product) => (
                <option key={product.id} value={product.id}>
                  {duo && product.id === COFFEE_STOCK_ID
                    ? 'Kafe (stok i përbashkët)'
                    : product.name}
                </option>
              ))}
            </select>
          </Field>
          {selected && (
            <p className="notice">
              Gjendja aktuale{' '}
              <strong>
                {selected.stockQuantity === null
                  ? 'Pa numëruar'
                  : coffee
                    ? coffeeStockLabel(selected.stockQuantity)
                    : selected.stockQuantity}
              </strong>
            </p>
          )}
          <Field
            id="stock-count-quantity"
            label={coffee ? 'Gjithsej (kg)' : 'Gjithsej'}
            error={errors.quantity}
          >
            <input
              id="stock-count-quantity"
              inputMode="decimal"
              value={quantity}
              aria-invalid={!!errors.quantity}
              onChange={(event) => {
                setQuantity(event.target.value);
                setErrors({});
              }}
            />
          </Field>
        </fieldset>
      </form>
    </SidePanel>
  );
}
