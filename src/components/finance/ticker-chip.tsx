import Link from "next/link";

import { fmtPct, fmtPrice, fmtX, limitFlag, moveClass } from "@/lib/finance/format";
import type { QuoteStat, TickerAttention } from "@/lib/finance/queries";
import type { Quote } from "@/lib/finance/quotes";
import { cn } from "@/lib/utils";

// Inline ticker with its last price, the day move and, when known, the
// move since the headline it sits under. Colour is spent only on moves;
// the code itself is brand amber because it is the link. A price at the
// BIST limit gets a "tavan"/"taban" tag: for a retail reader that single
// word matters more than the number.
export function TickerChip({
  ticker,
  quote,
  sinceNews,
  className,
}: {
  ticker: string;
  quote?: Quote;
  /** Percent move from the price at headline time to now; null when unknown. */
  sinceNews?: number | null;
  className?: string;
}) {
  const limit = quote ? limitFlag(quote.changePct) : null;
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
          {limit ? <span className="bg-brand/20 px-1 text-[10px] text-brand">{limit}</span> : null}
          {sinceNews != null ? (
            <span className={cn("border-l border-border/80 pl-1.5 tabular-nums", moveClass(sinceNews))}>
              {fmtPct(sinceNews)} <span className="text-muted-foreground">haberden</span>
            </span>
          ) : null}
        </>
      ) : null}
    </Link>
  );
}

// The masthead strip: the most-mentioned tickers with move, relative
// volume and how unusual today's attention is. One horizontal band that
// scrolls sideways on narrow screens instead of wrapping.
export function TickerTape({
  items,
  quotes,
  stats,
}: {
  items: TickerAttention[];
  quotes: Record<string, Quote>;
  stats: Record<string, QuoteStat>;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex overflow-x-auto border border-border bg-foreground/[0.03] font-mono text-[11px] leading-none [scrollbar-width:thin]">
      {items.map((t) => {
        const q = quotes[t.ticker];
        const s = stats[t.ticker];
        const limit = q ? limitFlag(q.changePct) : null;
        return (
          <Link
            key={t.ticker}
            href={`/ekonomi/${t.ticker}`}
            className="flex shrink-0 flex-col gap-1.5 border-r border-border px-3 py-2 transition-colors hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex items-baseline gap-2">
              <span className="text-brand">{t.ticker}</span>
              {q ? <span className="tabular-nums">{fmtPrice(q.price)}</span> : <span className="text-muted-foreground">fiyat yok</span>}
              {limit ? <span className="bg-brand/20 px-1 text-[10px] text-brand">{limit}</span> : null}
            </span>
            <span className="flex items-baseline gap-2 text-muted-foreground">
              {q ? <span className={cn("tabular-nums", moveClass(q.changePct))}>{fmtPct(q.changePct)}</span> : null}
              <span className="tabular-nums">{t.articles} haber</span>
              {t.ratio != null && t.ratio >= 2 ? <span className="tabular-nums text-amber-400">ilgi {fmtX(t.ratio)}</span> : null}
              {s?.rvol != null ? (
                <span className={cn("tabular-nums", s.rvol >= 2 ? "text-amber-400" : "")}>hacim {fmtX(s.rvol)}</span>
              ) : null}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
