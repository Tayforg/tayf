import Link from "next/link";

import { CIRCUIT_BREAKER_DAY_LIMIT } from "@/lib/finance/disclosure-filter";
import { fmtClock } from "@/lib/finance/format";
import type { Disclosure } from "@/lib/finance/queries";

// Today's circuit-breaker strip on /ekonomi. fetchCircuitBreakers() hands the
// page the whole Istanbul day (up to CIRCUIT_BREAKER_DAY_LIMIT notices, the
// PostgREST response cap), many of them the same ticker twice; rendering every
// one made a 514 px wall of codes on a phone and pushed "Haber akışı" to y=811
// (h28-journey-3). The visible cap is presentational only: the strip shows the
// newest BREAKER_STRIP_VISIBLE distinct tickers and folds the rest into a native
// <details> (no client JS), so every ticker the read returned stays one tap away.
// The read itself is not cut at 60 any more (h48-ekonomi-3: that dropped 20 of one
// day's 74 tickers before the dedupe), the label states the true distinct-ticker
// count, and a read that returned exactly the limit says "(son 1.000 bildirim)"
// so a cut is never silent. The read is newest first, so a cut drops the day's
// earliest notices and what the strip shows is the last N ("son"). The summary
// has no aria-label: its accessible name is the visible "+N daha" plus a
// screen-reader-only " (devre kesici)", so it starts with the visible text
// (WCAG 2.5.3, Label in Name).

/** How many distinct tickers sit in the always-visible row. */
export const BREAKER_STRIP_VISIBLE = 8;

/** Newest first; a row with an unparseable date goes last. Stable. */
function byNewest(a: Disclosure, b: Disclosure): number {
  const ta = Date.parse(a.publishedAt);
  const tb = Date.parse(b.publishedAt);
  const aOk = Number.isFinite(ta);
  const bOk = Number.isFinite(tb);
  if (aOk && bOk) return tb - ta;
  if (aOk) return -1;
  if (bOk) return 1;
  return 0;
}

/**
 * Splits notices into the visible row and the folded remainder: rows without
 * a ticker are dropped, the rest are sorted newest first and deduplicated by
 * their first ticker (the newest notice wins), then cut at `visible`. No code
 * appears in both lists. The input is not mutated.
 */
export function selectBreakers(
  breakers: readonly Disclosure[],
  visible = BREAKER_STRIP_VISIBLE,
): { shown: Disclosure[]; rest: Disclosure[] } {
  const seen = new Set<string>();
  const distinct: Disclosure[] = [];
  for (const b of breakers.filter((d) => d.stockCodes[0]).sort(byNewest)) {
    const code = b.stockCodes[0];
    if (!code || seen.has(code)) continue;
    seen.add(code);
    distinct.push(b);
  }
  return { shown: distinct.slice(0, visible), rest: distinct.slice(visible) };
}

/**
 * The strip's label: the true number of distinct tickers (`distinct`), plus a
 * muted note when the read returned `rowsRead` >= the limit, i.e. may have been cut.
 */
export function breakerLabel(distinct: number, rowsRead: number): { text: string; cut: string | null } {
  return {
    text: `devre kesici bugün · ${distinct} hisse`,
    cut:
      rowsRead >= CIRCUIT_BREAKER_DAY_LIMIT
        ? `(son ${CIRCUIT_BREAKER_DAY_LIMIT.toLocaleString("tr-TR")} bildirim)`
        : null,
  };
}

function BreakerChip({ breaker }: { breaker: Disclosure }) {
  return (
    <span className="flex items-baseline gap-1.5">
      {breaker.stockCodes.slice(0, 1).map((c) => (
        <Link key={c} href={`/ekonomi/${c}`} className="inline-flex min-h-6 items-center text-brand hover:underline">
          {c}
        </Link>
      ))}
      <span className="tabular-nums text-muted-foreground">{fmtClock(breaker.publishedAt)}</span>
    </span>
  );
}

/**
 * `unavailable` is set by /ekonomi when the circuit-breaker read failed
 * (h41-resilience-3). With no notice to show, the strip then says so in one
 * muted line instead of vanishing, because an absent strip reads as "no circuit
 * breakers today". Notices that did arrive are always listed.
 */
export function BreakerStrip({ breakers, unavailable = false }: { breakers: readonly Disclosure[]; unavailable?: boolean }) {
  const { shown, rest } = selectBreakers(breakers);
  if (shown.length === 0) {
    return unavailable ? (
      <p className="border border-border bg-black/25 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        Devre kesici listesi şu an yüklenemedi.
      </p>
    ) : null;
  }

  const label = breakerLabel(shown.length + rest.length, breakers.length);
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border border-border bg-black/25 px-3 py-1.5 font-mono text-[11px]">
      <span className="text-amber-400">{label.text}</span>
      {label.cut ? <span className="text-muted-foreground">{label.cut}</span> : null}
      {shown.map((b) => (
        <BreakerChip key={b.disclosureIndex} breaker={b} />
      ))}
      {rest.length > 0 ? (
        <details className="open:w-full">
          <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {`+${rest.length} daha`}
            <span className="sr-only"> (devre kesici)</span>
          </summary>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            {rest.map((b) => (
              <BreakerChip key={b.disclosureIndex} breaker={b} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
