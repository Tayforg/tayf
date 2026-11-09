import Link from "next/link";

import { fmtPct, fmtPrice, fmtX, limitFlag, moveClass } from "@/lib/finance/format";
import type { QuoteStat, TickerAttention } from "@/lib/finance/queries";
import type { Quote } from "@/lib/finance/quotes";
import { quoteSessionDay, rvolLabel } from "@/lib/finance/session";
import { cn } from "@/lib/utils";

import { StripFocusReveal } from "./strip-focus-reveal";

// Inline ticker with its last price, the day move and, when known, the
// move since the headline it sits under. Colour is spent only on moves;
// the code itself is brand amber because it is the link. A price at the
// BIST limit gets a "tavan"/"taban" tag: for a retail reader that single
// word matters more than the number. The tag is tick-aware (limitFlag with the
// previous close and the price): 0,66 -> 0,60 is taban although it is -9,09 %.
//
// The chip's vertical padding (py-1.5 around an 11 px line and a 1 px border)
// makes it 25 px tall, over the 24 px minimum target size of WCAG 2.5.8; the
// old py-0.5 chip was 15 px.
//
// A move is only shown when it is known: a quote without a baseline
// (hasBaseline === false, so changePct is a 0 placeholder) or one the page
// flagged stale renders an em dash instead of "%0,00" and never a limit
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
  const limit = quote && knownMove ? limitFlag(quote.changePct, quote.prevClose, quote.price) : null;
  return (
    <Link
      href={`/ekonomi/${ticker}`}
      className={cn(
        "inline-flex max-w-full min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 border border-border/80 px-1.5 py-1.5 font-mono text-[11px] leading-none transition-colors hover:border-brand/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
// scrolls sideways on narrow screens instead of wrapping. overflow-x-auto
// clips anything painted outside a link's box, so the focus ring is inset
// (drawn inside the link); the standalone chip has no clipping ancestor and
// keeps its outside ring. The strip is positioned (`relative`) so absolutely
// positioned descendants (the sr-only move text) are contained and clipped by
// the scroller instead of widening the page. The root is StripFocusReveal (a
// thin "use client" div): on a keyboard Tab it scrolls a partly clipped chip
// fully into view, which Blink does not do once 32 px of it show
// (h65-keyboard-1). TickerTape itself stays a server component.
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
    <StripFocusReveal className="tayf-scroll-x relative flex overflow-x-auto border border-border bg-foreground/[0.03] font-mono text-[11px] leading-none">
      {items.map((t) => {
        const q = quotes[t.ticker];
        const s = stats[t.ticker];
        const stale = staleTickers?.has(t.ticker) ?? false;
        const knownMove = q != null && q.hasBaseline !== false && !stale;
        const limit = q && knownMove ? limitFlag(q.changePct, q.prevClose, q.price) : null;
        // h99-financenumbers-1: the stat is the daily bar of stat.lastDay. During a session that is the
        // PREVIOUS session next to today's price and move, so its volume names its day (muted, never amber:
        // yesterday's volume is not today's signal). Without a quote there is no day to compare with.
        const vol = s && !stale ? rvolLabel(s, quoteSessionDay(q?.asOf)) : null;
        return (
          <Link
            key={t.ticker}
            href={`/ekonomi/${t.ticker}`}
            className="flex shrink-0 flex-col gap-1.5 border-r border-border px-3 py-2 transition-colors hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
              {vol ? (
                vol.dayLabel ? (
                  <span title={`${vol.dayLabel} seansının hacmi`} className="tabular-nums">
                    hacim {fmtX(vol.rvol)}
                    <span className="text-muted-foreground"> · {vol.dayLabel}</span>
                  </span>
                ) : (
                  <span className={cn("tabular-nums", vol.rvol >= 2 ? "text-amber-400" : "")}>hacim {fmtX(vol.rvol)}</span>
                )
              ) : null}
            </span>
          </Link>
        );
      })}
    </StripFocusReveal>
  );
}
