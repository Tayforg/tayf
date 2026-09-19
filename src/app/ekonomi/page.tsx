import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { DataNote } from "@/components/finance/data-note";
import { Panel, PanelEmpty } from "@/components/finance/panel";
import { TickerChip, TickerTape } from "@/components/finance/ticker-chip";
import { fmtClock, fmtWhen, pctChange } from "@/lib/finance/format";
import {
  fetchCircuitBreakers,
  fetchEconFeed,
  fetchQuoteStats,
  fetchRecentDisclosures,
  fetchReferencePrices,
  fetchTopTickers,
  refKey,
} from "@/lib/finance/queries";
import { getQuotes } from "@/lib/finance/quotes";

export const metadata: Metadata = {
  title: "Ekonomi",
  description:
    "Borsa İstanbul şirketlerini anan haberler, KAP bildirimleri ve hisselerin günlük hareketi tek ekranda.",
  alternates: { canonical: "/ekonomi" },
};

// /ekonomi — the terminal. Three feeds share one screen:
//   news that names a listed company (article_tickers), each row carrying
//   the ticker's last price, day move and move since the headline; the
//   most-mentioned tickers of the last two days as the masthead tape with
//   relative volume and attention ratio; today's circuit breakers as a
//   strip; and the KAP disclosure stream.
// Data: migrations 049-051 via lib/finance/queries, live quotes via
// lib/finance/quotes (Yahoo, cached 5 min).

const CLASS_LABEL: Record<string, string> = { FR: "finansal rapor", ODA: "özel durum", DG: "duyuru", DKB: "diğer" };

export default async function EkonomiPage() {
  // Row times are formatted against Date.now(); connection() tells PPR this
  // body runs at request time (loading.tsx is the Suspense boundary).
  await connection();
  const [feed, top, disclosures, breakers] = await Promise.all([
    fetchEconFeed(80),
    fetchTopTickers(2, 24),
    fetchRecentDisclosures(40),
    fetchCircuitBreakers(),
  ]);
  // TS-11: normalise the ticker set ONCE, outside the cache boundary, and
  // hand every cached fetcher the same sorted array. getQuotes/fetchQuoteStats
  // each independently sort+dedupe internally too, but doing it here as well
  // means the three run against the exact same Next cache key shape instead
  // of three independently-expiring 60 s entries that can briefly disagree.
  const tickerKey = [...new Set([...top.map((t) => t.ticker), ...feed.flatMap((f) => f.tickers)])].sort();
  const [quotes, stats, refs] = await Promise.all([
    getQuotes(tickerKey),
    fetchQuoteStats(tickerKey),
    fetchReferencePrices(feed.map((f) => f.id).sort()),
  ]);

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 py-6 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 font-mono text-[12px]">
        <h1 className="font-mono text-[12px] font-normal text-foreground">
          Tayf <span className="text-brand">Ekonomi</span>
        </h1>
        <p className="text-muted-foreground">
          Haberde adı geçen hisseler, son fiyat, gün içi değişim ve haberden bu yana hareket. Fiyatlar 15 dk gecikmeli olabilir. Yatırım tavsiyesi değildir.
        </p>
      </div>

      <TickerTape items={top} quotes={quotes} stats={stats} />

      {breakers.length > 0 ? (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border border-border bg-black/25 px-3 py-1.5 font-mono text-[11px]">
          <span className="text-amber-400">devre kesici bugün</span>
          {breakers.map((b) => (
            <span key={b.disclosureIndex} className="flex items-baseline gap-1.5">
              {b.stockCodes.slice(0, 1).map((c) => (
                <Link key={c} href={`/ekonomi/${c}`} className="text-brand hover:underline">
                  {c}
                </Link>
              ))}
              <span className="tabular-nums text-muted-foreground">{fmtClock(b.publishedAt)}</span>
            </span>
          ))}
        </div>
      ) : null}

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
                  <span className="hidden truncate font-mono text-[11px] text-muted-foreground sm:block">
                    {item.source ? (
                      <Link href={`/source/${item.source.slug}`} className="hover:text-foreground">
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
                      {item.title}
                    </a>
                    <div className="flex flex-wrap gap-1">
                      {item.tickers.map((t) => (
                        <TickerChip
                          key={t}
                          ticker={t}
                          quote={quotes[t]}
                          sinceNews={pctChange(refs[refKey(item.id, t)], quotes[t]?.price)}
                        />
                      ))}
                      {item.source ? <span className="font-mono text-[11px] text-muted-foreground sm:hidden">{item.source.name}</span> : null}
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
                    <TickerChip ticker={t.ticker} quote={quotes[t.ticker]} />
                    {t.title ? <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{t.title}</span> : null}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {t.articles} haber <span className="text-foreground/40">/</span> {t.sources} kaynak
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
              {disclosures.map((d) => (
                <li key={d.disclosureIndex} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 px-3 py-1.5 font-mono text-[11px]">
                  <time dateTime={d.publishedAt} className="tabular-nums text-muted-foreground">
                    {fmtWhen(d.publishedAt)}
                  </time>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      {d.stockCodes.slice(0, 3).map((c) => (
                        <Link key={c} href={`/ekonomi/${c}`} className="text-brand hover:underline">
                          {c}
                        </Link>
                      ))}
                      {d.stockCodes.length > 3 ? <span className="text-muted-foreground">+{d.stockCodes.length - 3}</span> : null}
                      {d.disclosureClass ? (
                        <span className={d.disclosureClass === "FR" ? "text-amber-400" : "text-muted-foreground"}>
                          {CLASS_LABEL[d.disclosureClass] ?? d.disclosureClass.toLowerCase()}
                        </span>
                      ) : null}
                      <a
                        href={`https://www.kap.org.tr/tr/Bildirim/${d.disclosureIndex}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-foreground/90 hover:text-brand"
                      >
                        {d.subject ?? "Bildirim"}
                      </a>
                    </div>
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
