import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import { DataNote } from "@/components/finance/data-note";
import { IntradayChart } from "@/components/finance/intraday-chart";
import { Panel, PanelEmpty } from "@/components/finance/panel";
import { AttentionBars, Sparkline } from "@/components/finance/sparkline";
import { fmtPct, fmtPrice, fmtWhen, fmtX, istToday, limitFlag, moveClass } from "@/lib/finance/format";
import { fetchIntraday, fetchQuoteStats, fetchTickerPage } from "@/lib/finance/queries";
import { getQuotes } from "@/lib/finance/quotes";
import { createServerClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

// /ekonomi/[ticker] — one company: last price and five-session line, the
// session's 5-minute chart with headlines marked on it, 30 days of press
// attention, the articles that named it, and its KAP disclosures with how
// fast (or how early) the press reacted.

const TICKER_RE = /^[A-Z0-9]{2,6}$/;

const NOT_FOUND_METADATA: Metadata = {
  title: "Hisse bulunamadı",
  robots: { index: false, follow: false },
};

/**
 * SEC-04/SEC-11: a cheap existence probe run BEFORE `connection()` in both
 * the page body and generateMetadata, wrapped in React's per-request
 * `cache()` so the two callers share one set of round trips instead of
 * issuing them twice. `connection()` is what opts this segment into the
 * loading.tsx-backed dynamic Suspense boundary (see that file's header
 * comment); a notFound() thrown after that point only swaps streamed
 * content, not the HTTP status.
 *
 * Measured behaviour against the production build (`next build` + `next
 * start`, cacheComponents/PPR on): calling notFound() synchronously in the
 * page body before connection() DOES keep a real 404 on the wire for a
 * MALFORMED ticker (fails TICKER_RE below, never reaches this function —
 * see TickerPage). A well-formed but genuinely UNKNOWN ticker still streams
 * a 200 shell with 404 content, because the segment's own loading.tsx
 * Suspense boundary flushes before this async check resolves; that half of
 * the requirement is instead enforced by src/middleware.ts's ticker-shape
 * check ahead of any render (middleware cannot cheaply probe the database,
 * so it only rejects malformed segments — an unknown-but-well-formed ticker
 * is a documented, explicit deviation: it streams 200/404-content, not a
 * wire 404).
 *
 * lib/finance/queries.ts has no existence helper cheaper than the full
 * fetchTickerPage() company query, so this is added here per the worker
 * brief. The primary probe mirrors fetchTickerPage's real company-lookup
 * shape: BIST companies key on the plural `tickers` array column (a
 * company can list more than one share class), not a singular `ticker`
 * column, so it uses `.contains(...)` rather than `.eq(...)`, and reads
 * `.limit(1)` array results the same way fetchTickerPage does rather than
 * `.maybeSingle()` (which 500s on >1 match instead of just taking the
 * first row).
 *
 * A miss on bist_companies is not final: a freshly listed or aliased
 * ticker — or one still behind the company-sync breaker's up-to-6h window
 * — can have real article/disclosure coverage before its company row
 * exists (see TickerPage's own tolerance of a null `page.company`), so
 * this only 404s when bist_companies AND article_tickers AND
 * kap_disclosures all miss. Any query error fails OPEN (treated as
 * "exists") rather than 500ing the page or generateMetadata over a
 * transient read.
 */
const tickerExists = cache(async (ticker: string): Promise<boolean> => {
  const supabase = createServerClient();
  const { data: companyRows, error: companyError } = await supabase
    .from("bist_companies")
    .select("kap_member_oid")
    .contains("tickers", [ticker])
    .limit(1);
  if (companyError) {
    console.error(`[ekonomi] tickerExists: bist_companies probe failed: ${companyError.message}`);
    return true;
  }
  if ((companyRows ?? []).length > 0) return true;

  const [articlesRes, disclosuresRes] = await Promise.all([
    supabase.from("article_tickers").select("ticker").eq("ticker", ticker).limit(1),
    supabase.from("kap_disclosures").select("disclosure_index").contains("stock_codes", [ticker]).limit(1),
  ]);
  if (articlesRes.error) {
    console.error(`[ekonomi] tickerExists: article_tickers probe failed: ${articlesRes.error.message}`);
  }
  if (disclosuresRes.error) {
    console.error(`[ekonomi] tickerExists: kap_disclosures probe failed: ${disclosuresRes.error.message}`);
  }
  return (articlesRes.data ?? []).length > 0 || (disclosuresRes.data ?? []).length > 0;
});

export async function generateMetadata({ params }: { params: Promise<{ ticker: string }> }): Promise<Metadata> {
  const { ticker: raw } = await params;
  const ticker = raw.toUpperCase();
  // SEC-04/SEC-11: generateMetadata runs independently of (and before) the
  // page body, so both the shape gate AND the existence probe that guard
  // the page's outbound lookups have to be applied here too — otherwise a
  // junk or unknown segment gets echoed straight into
  // <title>/<meta description>/canonical.
  if (!TICKER_RE.test(ticker) || !(await tickerExists(ticker))) {
    return NOT_FOUND_METADATA;
  }
  return {
    title: `${ticker} — hisse haberleri ve KAP bildirimleri`,
    description: `${ticker} hissesini anan haberler, son fiyat, 30 günlük basın ilgisi ve KAP bildirimleri.`,
    alternates: { canonical: `/ekonomi/${ticker}` },
  };
}

function lagLabel(minutes: number | null): string {
  if (minutes === null) return "veri yok";
  const abs = Math.abs(minutes);
  const text = abs >= 1440 ? `${Math.round(abs / 1440)} gün` : abs >= 60 ? `${Math.round(abs / 60)} saat` : `${Math.round(abs)} dk`;
  return minutes < 0 ? `${text} önce` : `${text} sonra`;
}

export default async function TickerPage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker: raw } = await params;
  const ticker = raw.toUpperCase();
  // SEC-04/SEC-11: both checks run — and can notFound() — synchronously in
  // the page body BEFORE connection(). The shape check commits a real HTTP
  // 404 for a malformed segment (see src/middleware.ts, which enforces the
  // same shape at the edge). The existence probe additionally protects
  // against rendering the full data fetch for a ticker with zero coverage
  // anywhere, but for a well-formed unknown ticker it only swaps streamed
  // content — see tickerExists()'s header comment for the measured detail.
  if (!TICKER_RE.test(ticker)) notFound();
  if (!(await tickerExists(ticker))) notFound();
  await connection();

  // tickerExists() confirms the ticker has SOME coverage (a bist_companies
  // row, or at least one article/disclosure), not specifically a company
  // row — see its header comment (E-06) — so `page.company` can still
  // legitimately be null here for a real, freshly-listed or alias-only
  // ticker. Every render below already treats `page.company` as nullable.
  const page = await fetchTickerPage(ticker);

  const [quotes, stats, intraday] = await Promise.all([
    getQuotes([ticker]),
    fetchQuoteStats([ticker]),
    fetchIntraday(ticker),
  ]);
  const quote = quotes[ticker];
  const stat = stats[ticker];
  const limit = quote ? limitFlag(quote.changePct) : null;
  const sessionDay = intraday.day;
  const markers = sessionDay
    ? [
        ...page.articles.filter((a) => istToday(new Date(a.publishedAt).getTime()) === sessionDay).map((a) => ({ ts: a.publishedAt, label: a.title })),
        ...page.disclosures.filter((d) => istToday(new Date(d.publishedAt).getTime()) === sessionDay).map((d) => ({ ts: d.publishedAt, label: `KAP: ${d.subject ?? "bildirim"}` })),
      ].sort((a, b) => a.ts.localeCompare(b.ts))
    : [];

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 py-6 space-y-3">
      <nav className="font-mono text-[11px] text-muted-foreground">
        <Link href="/ekonomi" className="hover:text-foreground">
          Ekonomi
        </Link>
        <span className="mx-2 text-foreground/40">/</span>
        <span className="text-brand">{ticker}</span>
      </nav>

      <header className="grid gap-4 border border-border bg-black/25 px-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <div className="min-w-0 space-y-1">
          <h1 className="font-mono text-3xl leading-none text-brand">{ticker}</h1>
          <p className="truncate text-[13px] text-foreground/90">{page.company?.title ?? "Şirket kaydı bulunamadı"}</p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {page.company?.city ? `${page.company.city} ` : ""}
            {page.company && !page.company.sharesTraded ? "işlem görmüyor" : ""}
            {page.company && page.company.tickers.length > 1 ? `paylar: ${page.company.tickers.join(" ")}` : ""}
          </p>
        </div>
        <div className="flex items-end gap-4 font-mono">
          {quote ? (
            <>
              <div className="text-right">
                <div className="flex items-baseline justify-end gap-2">
                  {limit ? <span className="bg-brand/20 px-1.5 py-0.5 text-[11px] text-brand">{limit}</span> : null}
                  <span className="text-3xl leading-none tabular-nums">{fmtPrice(quote.price)}</span>
                </div>
                <div className={cn("mt-1 text-[12px] tabular-nums", moveClass(quote.changePct))}>
                  {fmtPct(quote.changePct)} <span className="text-muted-foreground">bugün</span>
                </div>
                {stat?.rvol != null ? (
                  <div className={cn("mt-0.5 text-[11px] tabular-nums", stat.rvol >= 2 ? "text-amber-400" : "text-muted-foreground")}>
                    hacim {fmtX(stat.rvol)} <span className="text-muted-foreground">20 günlük ortalamanın</span>
                  </div>
                ) : null}
              </div>
              <Sparkline values={quote.closes} className={moveClass(quote.changePct)} width={140} height={40} />
            </>
          ) : (
            <span className="text-[12px] text-muted-foreground">fiyat alınamadı</span>
          )}
        </div>
      </header>

      <Panel
        title="Seans içi"
        meta={sessionDay ? `${sessionDay.split("-").reverse().join(".")}, 5 dakikalık kapanışlar, haberler işaretli` : "5 dakikalık veri henüz yok"}
      >
        {intraday.bars.length < 2 ? (
          <PanelEmpty>Bu hisse için seans içi veri henüz toplanmadı. Haberde geçen hisseler seans boyunca 5 dakikada bir kaydedilir.</PanelEmpty>
        ) : (
          <IntradayChart bars={intraday.bars} markers={markers} prevClose={stat?.prevClose ?? quote?.prevClose ?? null} />
        )}
      </Panel>

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="Basın ilgisi" meta="son 30 gün, günlük haber sayısı">
          <AttentionBars days={page.attention} today={istToday()} />
        </Panel>
        <Panel title="KAP ile basın arası" meta="son 30 gün">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-3 py-3 font-mono text-[11px] sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">bildirim</dt>
              <dd className="text-lg tabular-nums">{page.coverage.disclosures}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">basında yer bulan</dt>
              <dd className="text-lg tabular-nums">{page.coverage.covered}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">ilk haber, medyan</dt>
              <dd className="text-lg tabular-nums">{lagLabel(page.coverage.medianLagMinutes)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">basın KAP&apos;tan önce</dt>
              <dd className={cn("text-lg tabular-nums", page.coverage.pressAhead > 0 ? "text-amber-400" : "")}>{page.coverage.pressAhead}</dd>
            </div>
          </dl>
          <p className="border-t border-border/70 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
            Bildirimden 2 gün önce ile 5 gün sonra arasında hisseyi anan haberler sayılır. Negatif gecikme, basının KAP&apos;tan önce yazdığını gösterir.
          </p>
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title="Haberler" meta={`${page.articles.length} haber`}>
          {page.articles.length === 0 ? (
            <PanelEmpty>Bu hisseyi anan haber henüz eşleşmedi.</PanelEmpty>
          ) : (
            <ol className="divide-y divide-border/70">
              {page.articles.map((a) => (
                <li key={a.id} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 px-3 py-2 sm:grid-cols-[3.25rem_7.5rem_minmax(0,1fr)]">
                  <time dateTime={a.publishedAt} className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {fmtWhen(a.publishedAt)}
                  </time>
                  <span className="hidden truncate font-mono text-[11px] text-muted-foreground sm:block">{a.source?.name}</span>
                  <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-[13px] leading-snug hover:text-brand">
                    {a.title}
                  </a>
                </li>
              ))}
            </ol>
          )}
        </Panel>
        <Panel title="KAP bildirimleri" meta="son 30 gün">
          {page.disclosures.length === 0 ? (
            <PanelEmpty>Son 30 günde bildirim yok.</PanelEmpty>
          ) : (
            <ol className="divide-y divide-border/70">
              {page.disclosures.map((d) => (
                <li key={d.disclosureIndex} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 px-3 py-1.5 font-mono text-[11px]">
                  <time dateTime={d.publishedAt} className="tabular-nums text-muted-foreground">
                    {fmtWhen(d.publishedAt)}
                  </time>
                  <div className="min-w-0">
                    <a
                      href={`https://www.kap.org.tr/tr/Bildirim/${d.disclosureIndex}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-foreground/90 hover:text-brand"
                    >
                      {d.subject ?? "Bildirim"}
                    </a>
                    {d.summary ? <p className="truncate text-[10px] text-muted-foreground">{d.summary}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>

      <DataNote />
    </div>
  );
}
