import Link from "next/link";

import { fmtPct, fmtPrice, moveClass } from "@/lib/finance/format";
import type { TickerAttention } from "@/lib/finance/queries";
import type { Quote } from "@/lib/finance/quotes";
import { cn } from "@/lib/utils";

// Inline ticker with its last price and day move. Colour is spent only on
// the move; the code itself is brand amber because it is the link.
export function TickerChip({ ticker, quote, className }: { ticker: string; quote?: Quote; className?: string }) {
  return (
    <Link
      href={`/ekonomi/${ticker}`}
      className={cn(
        "inline-flex items-baseline gap-1.5 border border-border/80 px-1.5 py-0.5 font-mono text-[11px] leading-none whitespace-nowrap transition-colors hover:border-brand/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <span className="text-brand">{ticker}</span>
      {quote ? (
        <>
          <span className="tabular-nums text-foreground/90">{fmtPrice(quote.price)}</span>
          <span className={cn("tabular-nums", moveClass(quote.changePct))}>{fmtPct(quote.changePct)}</span>
        </>
      ) : null}
    </Link>
  );
}

// The masthead strip: the most-mentioned tickers with their moves. One
// horizontal band, scrolls sideways on narrow screens instead of wrapping.
export function TickerTape({ items, quotes }: { items: TickerAttention[]; quotes: Record<string, Quote> }) {
  if (items.length === 0) return null;
  return (
    <div className="flex overflow-x-auto border border-border bg-foreground/[0.03] font-mono text-[11px] leading-none [scrollbar-width:thin]">
      {items.map((t) => {
        const q = quotes[t.ticker];
        return (
          <Link
            key={t.ticker}
            href={`/ekonomi/${t.ticker}`}
            className="flex shrink-0 flex-col gap-1.5 border-r border-border px-3 py-2 transition-colors hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex items-baseline gap-2">
              <span className="text-brand">{t.ticker}</span>
              {q ? <span className="tabular-nums">{fmtPrice(q.price)}</span> : <span className="text-muted-foreground">fiyat yok</span>}
            </span>
            <span className="flex items-baseline gap-2 text-muted-foreground">
              {q ? <span className={cn("tabular-nums", moveClass(q.changePct))}>{fmtPct(q.changePct)}</span> : null}
              <span className="tabular-nums">{t.articles} haber</span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
