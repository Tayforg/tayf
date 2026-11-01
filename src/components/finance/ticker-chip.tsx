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
//
// A move is only shown when it is known: a quote without a baseline
// (hasBaseline === false, so changePct is a 0 placeholder) or one the page
// flagged stale renders an em dash instead of "+0,00%" and never a limit
// tag. The dash is hidden from assistive tech and followed by a sr-only
// "değişim bilinmiyor", because a bare "—" is read as nothing or as "dash".
// `hasBaseline` undefined (a cache entry from before the field existed)
// counts as known.

/** The "move unknown" marker: visible dash plus its screen-reader text. */
function unknownMove() {
  return (
    <>
      <span aria-hidden="true" className="whitespace-nowrap text-muted-foreground">
        —
      </span>
      <span className="sr-only">değişim bilinmiyor</span>
    </>
  );
}

export function TickerChip({
  ticker,
  quote,
  sinceNews,
  stale,
  className,
}: {
  ticker: string;
  quote?: Quote;
  /** Percent move from the price at headline time to now; null when unknown. */
  sinceNews?: number | null;
  /** The quote's last trade is too old to call a "move"; show "—" for it. */
  stale?: boolean;
  className?: string;
}) {
  const knownMove = quote != null && quote.hasBaseline !== false && !stale;
  const limit = quote && knownMove ? limitFlag(quote.changePct) : null;
  return (
    <Link
      href={`/ekonomi/${ticker}`}
      className={cn(
        "inline-flex max-w-full min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 border border-border/80 px-1.5 py-0.5 font-mono text-[11px] leading-none transition-colors hover:border-brand/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <span className="whitespace-nowrap text-brand">{ticker}</span>
      {quote ? (
        <>
          <span className="whitespace-nowrap tabular-nums text-foreground/90">{fmtPrice(quote.price)}</span>
          {knownMove ? (
            <span className={cn("whitespace-nowrap tabular-nums", moveClass(quote.changePct))}>{fmtPct(quote.changePct)}</span>
          ) : (
            unknownMove()
          )}
          {limit ? <span className="whitespace-nowrap bg-brand/20 px-1 text-[10px] text-brand">{limit}</span> : null}
          {sinceNews != null ? (
            <span className={cn("whitespace-nowrap border-l border-border/80 pl-1.5 tabular-nums", moveClass(sinceNews))}>
              {fmtPct(sinceNews)} <span className="hidden text-muted-foreground sm:inline">haberden</span>
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
//
// `staleTickers` are the tickers whose last trade is too old to call a move
// (the page's isStale). Like the chip, the tape then keeps the price but shows
// "—" for the move and drops the limit tag and the relative volume, which
// describe the old session, not today.
export function TickerTape({
  items,
  quotes,
  stats,
  staleTickers,
}: {
  items: TickerAttention[];
  quotes: Record<string, Quote>;
  stats: Record<string, QuoteStat>;
  staleTickers?: ReadonlySet<string>;
}) {
  if (items.length === 0) return null;
  return (
    <div className="tayf-scroll-x flex overflow-x-auto border border-border bg-foreground/[0.03] font-mono text-[11px] leading-none">
      {items.map((t) => {
        const q = quotes[t.ticker];
        const s = stats[t.ticker];
        const stale = staleTickers?.has(t.ticker) ?? false;
        const knownMove = q != null && q.hasBaseline !== false && !stale;
        const limit = q && knownMove ? limitFlag(q.changePct) : null;
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
              {q ? (
                knownMove ? (
                  <span className={cn("tabular-nums", moveClass(q.changePct))}>{fmtPct(q.changePct)}</span>
                ) : (
                  unknownMove()
                )
              ) : null}
              <span className="tabular-nums">{t.articles} haber</span>
              {t.ratio != null && t.ratio >= 2 ? <span className="tabular-nums text-amber-400">ilgi {fmtX(t.ratio)}</span> : null}
              {s?.rvol != null && !stale ? (
                <span className={cn("tabular-nums", s.rvol >= 2 ? "text-amber-400" : "")}>hacim {fmtX(s.rvol)}</span>
              ) : null}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
