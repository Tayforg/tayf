import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { Panel, PanelEmpty } from "@/components/finance/panel";
import { AttentionBars, Sparkline } from "@/components/finance/sparkline";
import { fmtPct, fmtPrice, fmtWhen, istToday, moveClass } from "@/lib/finance/format";
import { fetchTickerPage } from "@/lib/finance/queries";
import { getQuotes } from "@/lib/finance/quotes";
import { cn } from "@/lib/utils";

// /ekonomi/[ticker] — one company: last price and five-session line,
// 30 days of press attention, the articles that named it, and its KAP
// disclosures with how fast (or how early) the press reacted.

const TICKER_RE = /^[A-Z0-9]{2,6}$/;

export async function generateMetadata({ params }: { params: Promise<{ ticker: string }> }): Promise<Metadata> {
  const { ticker } = await params;
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
  if (!TICKER_RE.test(ticker)) notFound();
  await connection();

  const [page, quotes] = await Promise.all([fetchTickerPage(ticker), getQuotes([ticker])]);
  if (!page.company && page.articles.length === 0 && page.disclosures.length === 0) notFound();
  const quote = quotes[ticker];

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
                <div className="text-3xl leading-none tabular-nums">{fmtPrice(quote.price)}</div>
                <div className={cn("mt-1 text-[12px] tabular-nums", moveClass(quote.changePct))}>
                  {fmtPct(quote.changePct)} <span className="text-muted-foreground">bugün</span>
                </div>
              </div>
              <Sparkline values={quote.closes} className={moveClass(quote.changePct)} width={140} height={40} />
            </>
          ) : (
            <span className="text-[12px] text-muted-foreground">fiyat alınamadı</span>
          )}
        </div>
      </header>

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
    </div>
  );
}
