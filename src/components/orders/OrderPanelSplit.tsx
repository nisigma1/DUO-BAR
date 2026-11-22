import { useId, useRef, type CSSProperties, type ReactNode } from 'react';

const MIN_SHARE = 30;
const MAX_SHARE = 84;

export function OrderPanelSplit({
  catalog,
  details,
  catalogShare,
  onResize,
}: {
  catalog: ReactNode;
  details: ReactNode;
  catalogShare: number;
  onResize: (share: number) => void;
}) {
  const catalogId = useId();
  const split = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; startShare: number; height: number }>(
    undefined,
  );
  const resize = (share: number) =>
    onResize(Math.min(MAX_SHARE, Math.max(MIN_SHARE, Math.round(share))));

  return (
    <div
      className="order-split"
      data-order-split={Boolean(details)}
      ref={split}
      style={
        details
          ? ({
              '--order-catalog-share': `${catalogShare}fr`,
              '--order-details-share': `${100 - catalogShare}fr`,
            } as CSSProperties)
          : undefined
      }
    >
      <div id={catalogId} className="order-split-catalog">
        {catalog}
      </div>
      {details && (
        <>
          <div
            className="order-split-handle"
            data-order-split-handle
            role="separator"
            tabIndex={0}
            aria-label="Ndrysho lartësinë e listës së produkteve"
            aria-orientation="horizontal"
            aria-controls={catalogId}
            aria-valuemin={MIN_SHARE}
            aria-valuemax={MAX_SHARE}
            aria-valuenow={catalogShare}
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0 || drag.current || !split.current) return;
              const handle = event.currentTarget;
              const height = split.current.clientHeight - handle.offsetHeight;
              if (height <= 0) return;
              handle.setPointerCapture(event.pointerId);
              drag.current = {
                pointerId: event.pointerId,
                startY: event.clientY,
                startShare: catalogShare,
                height,
              };
            }}
            onPointerMove={(event) => {
              const active = drag.current;
              if (active?.pointerId === event.pointerId)
                resize(active.startShare + ((event.clientY - active.startY) / active.height) * 100);
            }}
            onLostPointerCapture={() => {
              drag.current = undefined;
            }}
            onKeyDown={(event) => {
              const shares = {
                ArrowUp: catalogShare - 5,
                ArrowDown: catalogShare + 5,
                Home: MIN_SHARE,
                End: MAX_SHARE,
              };
              if (!Object.hasOwn(shares, event.key)) return;
              event.preventDefault();
              resize(shares[event.key as keyof typeof shares]);
            }}
          >
            <span aria-hidden="true">↕</span>
          </div>
          <div className="order-split-details">{details}</div>
        </>
      )}
    </div>
  );
}
