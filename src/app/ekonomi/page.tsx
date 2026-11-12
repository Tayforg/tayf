import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { cache, Suspense } from "react";

import { BreakerStrip } from "@/components/finance/breaker-strip";
import { DataNote } from "@/components/finance/data-note";
import { Panel, PanelEmpty } from "@/components/finance/panel";
import { TickerChip, TickerTape } from "@/components/finance/ticker-chip";
import { disclosureClassLabel } from "@/lib/finance/disclosure-class";
import { fmtWhen, pctChange } from "@/lib/finance/format";
import { correctionTag, supersededDisclosureIndexes } from "@/lib/finance/kap-corrections";
import { filerName } from "@/lib/finance/kap-pickup";
import { optionalRead } from "@/lib/finance/optional-read";
import {
  fetchCircuitBreakers,
  fetchEconFeed,
  fetchQuoteStats,
  fetchRecentDisclosures,
  fetchReferencePrices,
  fetchTopTickers,
  refKey,
  type Disclosure,
  type QuoteStat,
} from "@/lib/finance/queries";
import { getQuotes } from "@/lib/finance/quotes";
import { NewTabHint } from "@/components/ui/new-tab-hint";
import { marketCueText, quoteFreshness, rebaseQuoteOnStat } from "@/lib/finance/session";
import { staticPageMetadata } from "@/lib/seo/page-metadata";
import { sourceLang } from "@/lib/sources/source-language";
import { currentTimeMs } from "@/lib/time";

import { EkonomiBodySkeleton } from "./loading";

// staticPageMetadata also sets its own og:* / twitter:* url, title and image.
export const metadata: Metadata = staticPageMetadata({
  title: "Ekonomi",
  description:
    "Borsa İstanbul şirketlerini anan haberler, KAP bildirimleri ve hisselerin günlük hareketi tek ekranda.",
  path: "/ekonomi",
});

// /ekonomi — the terminal. Three feeds share one screen:
//   news that names a listed company (article_tickers), each row carrying
//   the ticker's last price, day move and move since the headline; the
//   most-mentioned tickers of the last two days as the masthead tape with
//   relative volume and attention ratio; today's circuit breakers as a
//   strip; and the KAP disclosure stream.
// Data: migrations 049-051 via lib/finance/queries, live quotes via
// lib/finance/quotes (Yahoo, cached 5 min).
//
// h41-resilience-3: only the feed, the top tickers and the KAP stream are
// essential; their failure still throws to error.tsx. The circuit-breaker
// strip, the quote stats and the reference prices only decorate them, so each
// goes through optionalRead and degrades to its section's empty state (the
// strip says it is unavailable; a move without stats is "—"; a missing
// reference price drops the "since the headline" value).

// h159-perf-2: the header (h1 and the static subtitle, the LCP text) renders in the PPR
// shell. EkonomiPage used to be async and opened with connection(), so the whole page,
// subtitle included, streamed as one hidden segment that React reveals no earlier than
// 300 ms after the shell's first paint (measured: first paint 2260 ms, LCP 2660 ms).
// Now EkonomiPage is a plain function: the header is static copy and everything below it
// is EkonomiBody, behind the shared body skeleton. EkonomiBody awaits loadEkonomiView,
// which holds connection(), the clock and every read. An essential read that fails
// rejects the boundary, and the error boundary (error.tsx) renders as before: nothing
// here catches it.
//
// h161-cls-1: the market cue (the "Piyasa kapalı ..." line, present only when the freshest
// quote is not live) used to be a second Suspense island inside the header. It streamed in
// after the header had painted, grew the header by one line and pushed the still-visible
// body skeleton down 18 px (CLS 0.015 after the close). It is now the first element of
// EkonomiBody: it arrives in the same swap that replaces the skeleton, and during live
// trading it renders nothing, so no blank line is reserved. The header is fully static.
// tests/guards/ekonomi-static-header.test.ts pins the split.

/** Everything the body draws (cue text included), read once per request (React cache). */
export const loadEkonomiView = cache(async () => {
  // Row times are formatted against Date.now(); connection() tells PPR this
  // view runs at request time. It is only ever reached from inside a Suspense
  // boundary (EkonomiBody), never from the shell.
  await connection();
  // Taken after connection(): never read the clock in a prerender path.
  // currentTimeMs() is the repo's Date.now() wrapper (react-hooks/purity).
  const nowMs = currentTimeMs();
  const [feed, top, disclosures, breakersRead] = await Promise.all([
    fetchEconFeed(80),
    fetchTopTickers(2, 24),
    fetchRecentDisclosures(40),
    optionalRead<Disclosure[]>("circuit-breakers", fetchCircuitBreakers(), []),
  ]);
  const breakers = breakersRead.value;
  // h144-ekonomi-3: KAP files a correction as a new notice; the stream tags it as the ticker page does. The
  // match only sees the rows read here, so "düzeltildi" shows when the original is among them too.
  const supersededRows = supersededDisclosureIndexes(disclosures);
  // TS-11: normalise the ticker set ONCE, outside the cache boundary, and
  // hand every cached fetcher the same sorted array. getQuotes/fetchQuoteStats
  // each independently sort+dedupe internally too, but doing it here as well
  // means the three run against the exact same Next cache key shape instead
  // of three independently-expiring 60 s entries that can briefly disagree.
  const tickerKey = [...new Set([...top.map((t) => t.ticker), ...feed.flatMap((f) => f.tickers)])].sort();
  const [yahooQuotes, statsRead, refsRead] = await Promise.all([
    getQuotes(tickerKey),
    optionalRead<Record<string, QuoteStat>>("quote-stats", fetchQuoteStats(tickerKey), {}),
    optionalRead<Record<string, number>>("reference-prices", fetchReferencePrices(feed.map((f) => f.id).sort()), {}),
  ]);
  const stats = statsRead.value;
  const refs = refsRead.value;
  // h36-data-1: during the session Yahoo's previous close is the one from two
  // sessions back, so the day move (and the tavan/taban tag) is re-based on the
  // settled close in bist_quote_stats, and a move past the +-10 % band becomes
  // unknown ("—"). Everything below reads the re-based quotes. When the stats
  // read itself failed there is no settled close to re-base on, and Yahoo's own
  // move is the wrong one by definition: every quote loses its baseline, so its
  // move renders as "—" with no tavan/taban tag (h41-resilience-3).
  const quotes = Object.fromEntries(
    Object.entries(yahooQuotes).map(([t, q]) => [t, statsRead.failed ? { ...q, hasBaseline: false } : rebaseQuoteOnStat(q, stats[t])]),
  );

  // Market cue: when the freshest quote on screen is not from a live session,
  // say so once instead of letting every chip look like today's move. "Piyasa
  // kapalı" is claimed only when the clock says the market is closed: quotes are
  // cached for minutes, so at the open they still carry yesterday's date while
  // BIST trades (marketCueText words that case neutrally).
  let newestAsOf: string | null = null;
  let newestAsOfMs = Number.NEGATIVE_INFINITY;
  for (const q of Object.values(quotes)) {
    const ms = Date.parse(q.asOf);
    if (Number.isFinite(ms) && ms > newestAsOfMs) {
      newestAsOfMs = ms;
      newestAsOf = q.asOf;
    }
  }
  const marketCue = marketCueText(newestAsOf, nowMs);
  // A quote whose last trade is days old has no "move" to show on its chip.
  const isStale = (ticker: string): boolean => {
    const q = quotes[ticker];
    return q ? quoteFreshness(q.asOf, nowMs).kind === "halted" : false;
  };
  const staleTickers = new Set(Object.keys(quotes).filter(isStale));

  return {
    feed,
    top,
    disclosures,
    breakers,
    breakersFailed: breakersRead.failed,
    supersededRows,
    stats,
    refs,
    quotes,
    marketCue,
    staleTickers,
  };
});

export default function EkonomiPage() {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 py-6 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 font-mono text-[12px]">
        <h1 className="font-mono text-[12px] font-normal text-foreground">
          Tayf <span className="text-brand">Ekonomi</span>
        </h1>
        <div className="space-y-0.5">
          <p className="text-muted-foreground">
            Haberde adı geçen hisseler, son fiyat, gün içi değişim ve haberden bu yana hareket. Fiyatlar 15 dk gecikmeli olabilir. Yatırım tavsiyesi değildir.
          </p>
        </div>
      </div>

      <Suspense fallback={<EkonomiBodySkeleton />}>
        <EkonomiBody />
      </Suspense>
    </div>
  );
}

/**
 * The market cue line, the tape, the breaker strip, the three panels and the data note: the loaded page below
 * the header. The cue comes first and only when the freshest quote is not live; the wrapper carries the
 * font-mono text-[12px] the line inherited from the header row.
 */
export async function EkonomiBody() {
  const { feed, top, disclosures, breakers, breakersFailed, supersededRows, stats, refs, quotes, marketCue, staleTickers } =
    await loadEkonomiView();
  // A quote whose last trade is days old has no "move" to show on its chip.
  const isStale = (ticker: string): boolean => staleTickers.has(ticker);

  return (
    <>
      {marketCue ? (
        <div className="font-mono text-[12px]">
          <p className="text-muted-foreground">{marketCue}</p>
        </div>
      ) : null}

      <TickerTape items={top} quotes={quotes} stats={stats} staleTickers={staleTickers} />

      <BreakerStrip breakers={breakers} unavailable={breakersFailed} />

      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel title="Haber akışı" meta={`${feed.length} haber, hisse eşleşmeli`} className="lg:row-span-2">
          {feed.length === 0 ? (
            <PanelEmpty>
              Henüz hisse eşleşen haber yok. Eşleştirme her yeni haberde anında çalışır; ilk KAP çekimi ve şirket listesi yüklendikten sonra burası dolar.
            </PanelEmpty>
          ) : (
            <ol className="divide-y divide-border/70">
              {feed.map((item) => (
                <li key={item.id} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 px-3 py-2 sm:grid-cols-[3.25rem_7.5rem_minmax(0,1fr)]">
                  <time dateTime={item.publishedAt} className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {fmtWhen(item.publishedAt)}
                  </time>
                  <span className="hidden min-w-0 font-mono text-[11px] text-muted-foreground sm:block" lang={sourceLang(item.source)}>
                    {item.source ? (
                      <Link
                        href={`/source/${item.source.slug}`}
                        className="block truncate hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {item.source.name}
                      </Link>
                    ) : null}
                  </span>
                  <div className="min-w-0 space-y-1">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-[13px] leading-snug text-foreground hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span lang={sourceLang(item.source)}>{item.title}</span>
                      <NewTabHint />
                    </a>
                    <div className="flex min-w-0 flex-wrap gap-1">
                      {item.tickers.map((t) => {
                        const q = quotes[t];
                        // No trade since the headline (a weekend, or a headline newer
                        // than the last quote): the move since it is not measurable,
                        // and would read as a flat "+0,00% haberden".
                        const noTradeSince = q != null && Date.parse(item.publishedAt) > Date.parse(q.asOf);
                        const since = noTradeSince ? null : pctChange(refs[refKey(item.id, t)], q?.price);
                        // A headline from before the open references the previous
                        // close, which makes "since" the day move again. Say it once.
                        const redundant = since != null && q != null && Math.abs(since - q.changePct) < 0.02;
                        return <TickerChip key={t} ticker={t} quote={q} sinceNews={redundant ? null : since} stale={isStale(t)} />;
                      })}
                      {item.source ? (
                        <span className="font-mono text-[11px] text-muted-foreground sm:hidden" lang={sourceLang(item.source)}>
                          {item.source.name}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <Panel title="Gündemdeki hisseler" meta="son 2 gün, haber sayısına göre">
          {top.length === 0 ? (
            <PanelEmpty>Henüz haber sayımı yok.</PanelEmpty>
          ) : (
            <ol className="divide-y divide-border/70">
              {top.slice(0, 12).map((t, i) => (
                <li key={t.ticker} className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-baseline gap-2 px-3 py-1.5 font-mono text-[11px]">
                  <span className="tabular-nums text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0">
                    <TickerChip ticker={t.ticker} quote={quotes[t.ticker]} stale={isStale(t.ticker)} />
                    {t.title ? <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{t.title}</span> : null}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {t.articles} haber <span className="text-muted-foreground">/</span> {t.sources} kaynak
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <Panel title="KAP bildirimleri" meta="devre kesiciler hariç, en yeni üstte">
          {disclosures.length === 0 ? (
            <PanelEmpty>KAP akışı boş. kap-ingest fonksiyonu ilk çekimi yaptığında bildirimler burada listelenir.</PanelEmpty>
          ) : (
            <ol className="divide-y divide-border/70">
              {disclosures.map((d) => {
                const tag = correctionTag(d, supersededRows);
                return (
                  <li key={d.disclosureIndex} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 px-3 py-1.5 font-mono text-[11px]">
                    <time dateTime={d.publishedAt} className="tabular-nums text-muted-foreground">
                      {fmtWhen(d.publishedAt)}
                    </time>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        {d.stockCodes.slice(0, 3).map((c) => (
                          <Link key={c} href={`/ekonomi/${c}`} className="inline-flex min-h-6 items-center text-brand hover:underline">
                            {c}
                          </Link>
                        ))}
                        {d.stockCodes.length > 3 ? <span className="text-muted-foreground">+{d.stockCodes.length - 3}</span> : null}
                        {/* h108-kapdisclosures-1: the chips are the rated companies; say whose notice it is. */}
                        {d.agencyFiled ? <span className="text-muted-foreground">{`· ${filerName(d)} bildirimi`}</span> : null}
                        {d.disclosureClass ? (
                          <span className={d.disclosureClass === "FR" ? "text-amber-400" : "text-muted-foreground"}>
                            {disclosureClassLabel(d.disclosureClass)}
                          </span>
                        ) : null}
                        <a
                          href={`https://www.kap.org.tr/tr/Bildirim/${d.disclosureIndex}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={tag === "düzeltildi" ? "text-muted-foreground hover:text-brand" : "text-foreground/90 hover:text-brand"}
                        >
                          {d.subject ?? "Bildirim"}
                          <NewTabHint />
                        </a>
                        {tag === "düzeltme" ? <span className="text-[10px] text-amber-400">düzeltme</span> : null}
                        {tag === "düzeltildi" ? <span className="text-[10px] text-muted-foreground">düzeltildi</span> : null}
                      </div>
                      {d.summary ? <p className="truncate text-[10px] text-muted-foreground">{d.summary}</p> : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>
      </div>

      <DataNote />
    </>
  );
}
