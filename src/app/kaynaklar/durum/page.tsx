import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";

import { PageHero } from "@/components/ui/page-hero";
import { ZONE_META } from "@/lib/bias/config";
import { formatTurkishTimeAgo } from "@/lib/time";
import {
  getSourceFeedStatuses,
  getSourceItemsPerDay,
  summariseFeedStatus,
} from "@/lib/sources/feed-status";
import { SOURCE_KIND_META } from "@/lib/sources/kind";
import { SILENCE_REASON_LABEL, type SilenceReason } from "@/lib/sources/silence-reason";
import { staticPageMetadata } from "@/lib/seo/page-metadata";
import type { MediaDnaZone } from "@/types";

// /kaynaklar/durum — the public evidence page behind every "N/M kaynak"
// denominator footnote (src/components/source/denominator-note.tsx, wired
// in at /sources and /blindspots). A share like "zone X covered 80% of a
// story" is computed against sources that actually delivered an article in
// the trailing 72 h, not the full active-source count. This page lists
// every active source — kind, last item, last HTTP status, 7-day rate, and
// a silent flag — so the denominator is never just a number a reader has
// to trust. The top-of-page totals below use the `all` tally (every active
// source, matching every row this page lists) — the VOTING-only tally that
// DenominatorNote uses elsewhere lives behind the `kind` column so a
// reader can see which listed rows actually count toward a share (A-H1).
//
// PERF-01: `rows` (the table's name/zone/kind/last-item/last-status/silent
// columns) comes from the cheap `getSourceFeedStatuses()` core query so the
// shell paints fast. `getSourceItemsPerDay()` — the only remaining caller
// of the `stats:articles(count)` aggregate this pack measured bimodal
// (177-4639 ms) — is deliberately NOT awaited here; it's passed down as a
// Promise and streamed in behind a nested <Suspense> per row, scoped to
// just the "7 günlük gün başına haber" column.
//
// Own metadata so this page doesn't inherit the root layout's title and
// `canonical: "/"` (which would mark it a duplicate of the homepage).
// staticPageMetadata also sets its own og:* / twitter:* url, title and image.
export const metadata: Metadata = staticPageMetadata({
  title: "Kaynak Durumu",
  description:
    "Tayf'ın izlediği her aktif kaynağın son haber zamanı, son HTTP durumu ve 7 günlük yayın sıklığı — yanlılık ve kör nokta paylarının hesaplandığı payda burada.",
  path: "/kaynaklar/durum",
});

const ZONE_ORDER: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

// Why a source is silent (migration 119) decides the badge colour. The classes
// are literals on purpose: Tailwind only emits what it can read, and the 800 /
// 300 / 400 text shades keep the 11 px label at WCAG 1.4.3 AA on the 15% tint
// in both themes (the old amber-700 / dark:amber-500 badge was below it).
const SILENCE_BADGE_CLASS: Record<SilenceReason, string> = {
  akis_donmus: "bg-sky-500/15 border-sky-500/30 text-sky-800 dark:text-sky-300",
  erisim_yok: "bg-rose-500/15 border-rose-500/30 text-rose-800 dark:text-rose-300",
  sessiz: "bg-amber-500/15 border-amber-500/30 text-amber-800 dark:text-amber-400",
};

const itemsPerDayFormatter = new Intl.NumberFormat("tr-TR", {
  maximumFractionDigits: 1,
});

type ItemsPerDayPromise = ReturnType<typeof getSourceItemsPerDay>;

export default async function KaynakDurumPage() {
  // connection() signals to PPR that the code below must run at request
  // time (it reads Date.now() indirectly via getSourceFeedStatuses). The
  // static shell renders while this streams in.
  await connection();

  const rows = await getSourceFeedStatuses();
  // Not awaited — see the file header (PERF-01).
  const itemsPerDayPromise = getSourceItemsPerDay();

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl space-y-6">
      <PageHero
        kicker="Kapsam düzeltmesi"
        title="Kaynak Durumu"
        subtitle="Tayf'taki her pay — yanlılık dağılımı, kör nokta — yalnızca son 72 saatte en az bir haber veren kaynaklar üzerinden hesaplanır; toplam aktif kaynak sayısı üzerinden değil. Bu sayfa o paydayı kaynak kaynak açar."
      />

      <p className="text-xs text-muted-foreground">
        Haber akışının genel durumu için{" "}
        <Link
          href="/durum"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Sistem durumu
        </Link>{" "}
        sayfasına bakın.
      </p>

      {rows === null ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Kaynak durumu şu anda bilinmiyor — veri geçici olarak
            ulaşılamıyor. Birkaç dakika içinde tekrar deneyin.
          </p>
        </div>
      ) : (
        <KaynakDurumBody rows={rows} itemsPerDayPromise={itemsPerDayPromise} />
      )}
    </div>
  );
}

// Named export (in addition to the page's default export) purely so
// page.test.tsx can render the rows/null/empty-array branches directly
// without a full React renderer capable of resolving async Server
// Components — no behaviour change.
export function KaynakDurumBody({
  rows,
  itemsPerDayPromise,
}: {
  rows: NonNullable<Awaited<ReturnType<typeof getSourceFeedStatuses>>>;
  itemsPerDayPromise: ItemsPerDayPromise;
}) {
  const { all: summary } = summariseFeedStatus(rows);
  const quarantinedCount = rows.filter((r) => r.quarantined).length;

  // Silent-first, then alphabetical (the underlying query already sorts by
  // name — Array#sort is stable, so this only reorders across the
  // silent/delivering boundary and preserves alpha order within each).
  const sortedRows = [...rows].sort((a, b) => {
    if (a.silent !== b.silent) return a.silent ? -1 : 1;
    return a.name.localeCompare(b.name, "tr");
  });

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {ZONE_ORDER.map((zone) => {
          const meta = ZONE_META[zone];
          const bucket = summary.byZone[zone];
          return (
            <div
              key={zone}
              className={`rounded-xl border ${meta.zoneBorder} ${meta.zoneBg} p-4`}
            >
              <p className={`text-xs font-semibold ${meta.zoneLabel}`}>
                {meta.label}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {bucket.total} kaynaktan{" "}
                <span className="font-mono text-foreground">
                  {bucket.delivering}
                </span>{" "}
                tanesi son 72 saatte yayın yaptı.
              </p>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        Toplam <span className="font-mono">{summary.total}</span> aktif
        kaynaktan <span className="font-mono">{summary.delivering}</span>{" "}
        tanesi son 72 saatte en az bir haber verdi;{" "}
        <span className="font-mono">{summary.silent}</span> kaynak bu
        pencerede sessiz.
        {quarantinedCount > 0 && (
          <>
            {" "}
            <span className="font-mono">{quarantinedCount}</span> besleme
            karantinada: art arda 20 kez çekilemeyen beslemeler 1 saat, 6
            saat, sonra günde bir yeniden denenir.
          </>
        )}
      </p>

      {summary.silent > 0 && (
        <p className="text-xs text-muted-foreground">
          Sessiz kaynakların yanındaki etiket nedenini söyler:{" "}
          <strong>akış donmuş</strong> — besleme yanıt veriyor ama içindeki en
          yeni haber 72 saatten eski, yani besleme güncellenmiyor;{" "}
          <strong>erişim yok</strong> — besleme son denemede alınamadı ya da
          karantinada; <strong>sessiz</strong> — besleme güncel, ama son 72
          saatte Tayf&apos;a yeni haber eklenmedi.
        </p>
      )}

      <div className="rounded-xl ring-1 ring-border/60 bg-card p-4 sm:p-6">
        <h2 id="durum-tablo" className="sr-only">
          Aktif kaynakların besleme durumu
        </h2>
        {sortedRows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Şu anda listelenecek aktif kaynak yok.
          </p>
        ) : (
          <div
            className="overflow-x-auto"
            role="region"
            aria-labelledby="durum-tablo"
            tabIndex={0}
          >
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-border/60 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                  <th
                    scope="col"
                    className="sticky left-0 z-10 bg-card py-2 pr-4 font-medium"
                  >
                    Kaynak
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Tür
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Bölge
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Son haber
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Son HTTP durumu
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    7 günlük gün başına haber
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Sessiz
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {sortedRows.map((row) => (
                  <tr key={row.slug}>
                    <td className="sticky left-0 z-10 bg-card py-2.5 pr-4 font-medium text-foreground whitespace-nowrap">
                      <Link
                        href={`/source/${row.slug}`}
                        className="hover:underline"
                      >
                        {row.name}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-muted-foreground">
                      {SOURCE_KIND_META[row.kind].label}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap">
                      <span className="inline-flex items-center gap-2 text-muted-foreground">
                        <span
                          className={`h-2 w-2 rounded-full ${ZONE_META[row.zone].dot}`}
                          aria-hidden="true"
                        />
                        {ZONE_META[row.zone].label}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-muted-foreground">
                      {row.lastItemAt ? formatTurkishTimeAgo(row.lastItemAt) : "—"}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap font-mono text-muted-foreground">
                      {row.lastHttpStatus ?? "—"}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap font-mono text-muted-foreground">
                      <Suspense fallback={<span className="text-muted-foreground">…</span>}>
                        <ItemsPerDayCell
                          slug={row.slug}
                          itemsPerDayPromise={itemsPerDayPromise}
                        />
                      </Suspense>
                    </td>
                    <td className="py-2.5">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {row.silent ? (
                          <span
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${
                              SILENCE_BADGE_CLASS[row.silenceReason ?? "sessiz"]
                            }`}
                          >
                            {SILENCE_REASON_LABEL[row.silenceReason ?? "sessiz"]}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                        {row.quarantined ? (
                          <span
                            title={`Art arda ${row.failStreak} başarısız çekim — besleme geçici olarak atlanıyor`}
                            className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 border border-rose-500/30 px-2 py-0.5 text-[11px] text-rose-800 dark:text-rose-300 font-medium whitespace-nowrap"
                          >
                            karantinada
                          </span>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

export async function ItemsPerDayCell({
  slug,
  itemsPerDayPromise,
}: {
  slug: string;
  itemsPerDayPromise: ItemsPerDayPromise;
}) {
  const map = await itemsPerDayPromise;
  const value = map ? (map[slug] ?? 0) : null;
  return <>{value === null ? "—" : itemsPerDayFormatter.format(value)}</>;
}
