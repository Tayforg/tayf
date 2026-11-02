import type { Metadata } from "next";
import Link from "next/link";

import { PageHero } from "@/components/ui/page-hero";
import { formatTurkishDate } from "@/lib/time";
import {
  getQualitySnapshots,
  type QualitySnapshot,
} from "@/lib/quality/snapshots";
import { staticPageMetadata } from "@/lib/seo/page-metadata";

// /kalite — M-09, the pipeline's own quality scoreboard. Publishes the
// exact numbers `node scripts/audit-clusters.mjs --json --persist` writes
// nightly to `cluster_quality_snapshots` (.github/workflows/cluster-audit.yml,
// 03:00 UTC), read via src/lib/quality/snapshots.ts (unit tested there —
// this file trusts its null-safe, never-throw contract and only decides how
// to render null / [] / real rows).
//
// Precision and recall are deliberately NOT shown as numbers here — see the
// section below the table. `report.mjs`'s precision/recall PROBES exist
// (precision_probe_count / recall_probe_count), but they are pair-level
// heuristics for the audit's own console banners, not a measurement against
// a human-labelled gold set. Showing them as "precision: X%" would imply an
// accuracy claim the pipeline cannot back yet.

// staticPageMetadata also sets its own og:* / twitter:* url, title and image.
export const metadata: Metadata = staticPageMetadata({
  title: "Küme kalitesi",
  description:
    "Tayf'ın kümeleme ardışık düzeninin her gece kendi üzerinde ölçtüğü kalite sayıları: haber ve küme sayısı, tekil küme oranı, kaynak çeşitliliği ve kör nokta tutarsızlık oranı.",
  path: "/kalite",
});

// Shared class tokens — literal strings only (Tailwind 4 has no runtime
// scanner, so every className must be a string it can see at build time).
// Mirrors /metodoloji's token set.
const cardClass = "rounded-xl ring-1 ring-border/60 bg-card/60 p-4 sm:p-6";
const proseClass = "max-w-[65ch] text-sm text-muted-foreground leading-relaxed";
const ruleCard = "rounded-lg ring-1 ring-border/50 bg-muted/20 p-3 space-y-1";
const ruleTerm =
  "text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground";
const ruleDef = "text-sm text-foreground/90 leading-relaxed";

const PRECISION_RECALL_SENTENCE =
  "Kesinlik ve duyarlılık henüz ölçülmedi: 300 haberlik altın set etiketlenince burada yayımlanacak.";

function formatPercent(rate: number): string {
  return `%${Math.round(rate * 100)}`;
}

function formatDecimal(n: number): string {
  return n.toFixed(1).replace(".", ",");
}

function formatCount(n: number): string {
  return n.toLocaleString("tr-TR");
}

export default async function QualityPage() {
  const snapshots = await getQualitySnapshots();

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-10">
      <PageHero
        kicker="Şeffaflık"
        title="Küme kalitesi"
        subtitle="Tayf, kendi kümeleme ardışık düzeninin kalitesini her gece ölçer ve burada — dışarıdan bir denetim değil, sistemin kendi üzerinde çalıştırdığı bir ölçüm olarak — yayımlar."
      />

      <section className="space-y-3">
        <p className={proseClass}>
          Bu sayfadaki her sayı, günlük denetim işinin (
          <code className="font-mono text-xs">.github/workflows/cluster-audit.yml</code>
          , 03:00 UTC) çalıştırdığı <code className="font-mono text-xs">scripts/audit-clusters.mjs</code>{" "}
          betiğinin, aynı gece kümelemenin ürettiği verinin üzerinde
          hesapladığı ve <code className="font-mono text-xs">cluster_quality_snapshots</code>{" "}
          tablosuna yazdığı sonuçtur. Aşağıda son 30 gecelik kayıt gösterilir.
        </p>
      </section>

      {snapshots === null ? (
        <UnavailableState />
      ) : snapshots.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <StatTiles latest={snapshots[0]!} />
          <SingletonRateChart snapshots={snapshots} />
          <SnapshotsTable snapshots={snapshots} />
        </>
      )}

      <section className={cardClass}>
        <p className={proseClass}>{PRECISION_RECALL_SENTENCE}</p>
      </section>

      <Definitions />
    </div>
  );
}

function UnavailableState() {
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
      <p className="text-sm text-muted-foreground">
        Kalite ölçümleri şu anda bilinmiyor — veri geçici olarak
        ulaşılamıyor. Birkaç dakika içinde tekrar deneyin.
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
      <p className="text-sm text-muted-foreground">
        Henüz hiç gece denetimi kaydedilmedi. İlk kayıt, günlük denetim işi
        (03:00 UTC) ilk kez çalıştığında burada görünecek.
      </p>
    </div>
  );
}

function StatTiles({ latest }: { latest: QualitySnapshot }) {
  const tiles: Array<{ label: string; value: string }> = [
    { label: "Haber sayısı", value: formatCount(latest.articleCount) },
    { label: "Küme sayısı", value: formatCount(latest.clusterCount) },
    { label: "Tekil küme oranı", value: formatPercent(latest.singletonRate) },
    {
      label: "Kaynak çeşitliliği",
      value: formatDecimal(latest.sourceDiversity.avg_sources_per_multi_cluster),
    },
    {
      label: "Kör nokta tutarsızlık oranı",
      value: formatPercent(latest.blindspotFlipRate),
    },
  ];

  return (
    <section className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Son ölçüm:{" "}
        <span className="font-mono text-foreground">
          {formatTurkishDate(latest.takenAt)}
        </span>{" "}
        · son {latest.windowHours} saatlik pencere
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {tiles.map((tile) => (
          <div key={tile.label} className={cardClass}>
            <p className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              {tile.label}
            </p>
            <p className="mt-1 font-mono text-xl text-foreground">{tile.value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// SVG geometry — constants so the layout is trivial to reason about.
// viewBox is unitless so the parent container can scale it via CSS
// (mirrors src/app/trends/page.tsx and src/components/finance/sparkline.tsx).
//
// The SVG draws only geometry (two gridlines and the line). Every label is
// HTML around it: text inside the SVG is sized in viewBox units, so in a
// 640-unit viewBox on a 390 px phone a 9-unit label rendered at about 5 px,
// while an HTML label stays at its real 11 px (h25-visual-2; the same fix as
// the intraday chart on /ekonomi, #169). The chart is fluid and never needs a
// minimum width, so it neither scrolls nor clips the end date.
//
// The percent labels sit in a gutter to the left of the plot box, placed from
// the same PAD_TOP / PLOT_H the gridlines use, so a label cannot drift off its
// line. The dates sit in a row under the plot, inset by the same padding as
// the plot's left and right edges.
const CHART_W = 640;
const CHART_H = 160;
// Only enough room to keep the 2-unit line and its round caps inside the viewBox.
const PAD_LEFT = 4;
const PAD_RIGHT = 4;
const PAD_TOP = 12;
const PAD_BOTTOM = 12;
const PLOT_W = CHART_W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = CHART_H - PAD_TOP - PAD_BOTTOM;

/** Vertical anchors of the %max and %min labels, in percent of the svg height. */
const MAX_LABEL_TOP_PCT = (PAD_TOP / CHART_H) * 100;
const MIN_LABEL_TOP_PCT = ((PAD_TOP + PLOT_H) / CHART_H) * 100;

// Literal class strings only (Tailwind 4 has no runtime scanner). right-full
// puts a rate label just left of the plot box, inside the pl-10 gutter.
const RATE_LABEL_CLASS =
  "absolute right-full mr-1 -translate-y-1/2 whitespace-nowrap font-mono text-[11px] leading-none tabular-nums text-muted-foreground";
const DATE_LABEL_CLASS =
  "whitespace-nowrap font-mono text-[11px] leading-none tabular-nums text-muted-foreground";

function SingletonRateChart({ snapshots }: { snapshots: QualitySnapshot[] }) {
  // `snapshots` is newest-first (the fetcher's contract); the chart reads
  // chronologically left-to-right, so reverse for plotting.
  const chrono = [...snapshots].reverse();
  const n = chrono.length;

  if (n < 2) {
    return (
      <section className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Grafik için en az iki gecelik kayıt gerekiyor — henüz yalnızca bir
          kayıt var.
        </p>
      </section>
    );
  }

  const rates = chrono.map((s) => s.singletonRate);
  const minRate = Math.min(...rates);
  const maxRate = Math.max(...rates);
  const span = maxRate - minRate || 1;

  const points = chrono.map((s, i) => {
    const x = PAD_LEFT + (i / (n - 1)) * PLOT_W;
    const y = PAD_TOP + PLOT_H - ((s.singletonRate - minRate) / span) * PLOT_H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const first = chrono[0]!;
  const last = chrono[n - 1]!;
  const firstDate = formatTurkishDate(first.takenAt);
  const lastDate = formatTurkishDate(last.takenAt);

  return (
    <section className={cardClass + " space-y-2"}>
      <h2 className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
        Tekil küme oranı — son {n} gece
      </h2>
      {/* pl-10 is the gutter the percent labels sit in (right-full of the plot box). */}
      <div className="w-full pl-10">
        <div className="relative w-full">
          <svg
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            role="img"
            aria-label={`Son ${n} gecelik kayıtta (${firstDate}–${lastDate}) tekil küme oranı %${Math.round(minRate * 100)} ile %${Math.round(maxRate * 100)} arasında değişti; en son değer %${Math.round(last.singletonRate * 100)}.`}
            className="block h-auto w-full"
          >
            <g
              className="text-muted-foreground"
              stroke="currentColor"
              strokeOpacity={0.15}
              strokeWidth={1}
            >
              <line x1={PAD_LEFT} x2={CHART_W - PAD_RIGHT} y1={PAD_TOP} y2={PAD_TOP} />
              <line
                x1={PAD_LEFT}
                x2={CHART_W - PAD_RIGHT}
                y1={PAD_TOP + PLOT_H}
                y2={PAD_TOP + PLOT_H}
              />
            </g>
            <polyline
              points={points.join(" ")}
              fill="none"
              className="text-brand"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <span
            aria-hidden="true"
            data-chart-label
            className={RATE_LABEL_CLASS}
            style={{ top: `${MAX_LABEL_TOP_PCT.toFixed(2)}%` }}
          >
            %{Math.round(maxRate * 100)}
          </span>
          <span
            aria-hidden="true"
            data-chart-label
            className={RATE_LABEL_CLASS}
            style={{ top: `${MIN_LABEL_TOP_PCT.toFixed(2)}%` }}
          >
            %{Math.round(minRate * 100)}
          </span>
        </div>
        {/* Percent padding is of this row's containing block, the plot's own width. */}
        <div
          className="mt-1 flex justify-between gap-2"
          style={{
            paddingLeft: `${((PAD_LEFT / CHART_W) * 100).toFixed(2)}%`,
            paddingRight: `${((PAD_RIGHT / CHART_W) * 100).toFixed(2)}%`,
          }}
        >
          <span aria-hidden="true" data-chart-label className={DATE_LABEL_CLASS}>
            {firstDate}
          </span>
          <span aria-hidden="true" data-chart-label className={DATE_LABEL_CLASS}>
            {lastDate}
          </span>
        </div>
      </div>
    </section>
  );
}

function SnapshotsTable({ snapshots }: { snapshots: QualitySnapshot[] }) {
  return (
    <section className={cardClass}>
      <h2 id="kalite-tablo" className="sr-only">
        Gece gece kalite ölçümleri
      </h2>
      <div
        className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        role="region"
        aria-labelledby="kalite-tablo"
        tabIndex={0}
      >
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border/60 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              <th scope="col" className="py-2 pr-4 font-medium">
                Tarih
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Haber
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Küme
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Tekil küme oranı
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Kaynak çeşitliliği
              </th>
              <th scope="col" className="py-2 font-medium">
                Kör nokta tutarsızlık
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {snapshots.map((s) => (
              <tr key={s.id}>
                <td className="py-2.5 pr-4 whitespace-nowrap text-muted-foreground">
                  {formatTurkishDate(s.takenAt)}
                </td>
                <td className="py-2.5 pr-4 font-mono text-foreground">
                  {formatCount(s.articleCount)}
                </td>
                <td className="py-2.5 pr-4 font-mono text-foreground">
                  {formatCount(s.clusterCount)}
                </td>
                <td className="py-2.5 pr-4 font-mono text-foreground">
                  {formatPercent(s.singletonRate)}
                </td>
                <td className="py-2.5 pr-4 font-mono text-foreground">
                  {formatDecimal(s.sourceDiversity.avg_sources_per_multi_cluster)}
                </td>
                <td className="py-2.5 font-mono text-foreground">
                  {formatPercent(s.blindspotFlipRate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Definitions() {
  return (
    <section className="space-y-3">
      <h2 className="font-serif text-xl sm:text-2xl font-normal tracking-tight border-b border-border/60 pb-2">
        Tanımlar
      </h2>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div className={ruleCard}>
          <dt className={ruleTerm}>Tekil küme (singleton)</dt>
          <dd className={ruleDef}>
            Sadece bir makaleden oluşan küme — kümeleyici, o haberi başka
            hiçbir kaynağın haberiyle eşleştirecek kadar benzer bulamamış
            demektir. Oran yüksek çünkü çoğu kaynak ajans (AA, DHA, İHA)
            haberini kendi URL&apos;sinden yeniden yayımlar ve kümeleyici
            yalnızca güçlü benzerlikte birleştirir — &quot;tek kaynak&quot;
            her zaman &quot;diğerleri görmezden geldi&quot; anlamına gelmez.
          </dd>
        </div>
        <div className={ruleCard}>
          <dt className={ruleTerm}>Küme (cluster)</dt>
          <dd className={ruleDef}>
            Aynı zaman penceresi içinde birbirine yeterince benzeyen
            makalelerin gruplandığı birim; bir kümenin bir veya daha çok
            üyesi (makalesi) olabilir.
          </dd>
        </div>
        <div className={ruleCard}>
          <dt className={ruleTerm}>Kaynak çeşitliliği</dt>
          <dd className={ruleDef}>
            En az iki üyeli kümelerde, kümedeki farklı kaynak sayısının
            ortalaması. Tek üyeli (tekil) kümeler bu ortalamaya girmez —
            zaten tanım gereği tek bir kaynağa sahiptirler.
          </dd>
        </div>
        <div className={ruleCard}>
          <dt className={ruleTerm}>Kör nokta tutarsızlık oranı</dt>
          <dd className={ruleDef}>
            En az beş üyeli kümelerde, veritabanında saklanan kör nokta
            bayrağı ile kümenin güncel yanlılık dağılımından yeniden
            hesaplanan sonucun uyuşmadığı kümelerin oranı. Sıfırdan
            yüksekse, veri değiştikten sonra bayrağın yeniden
            hesaplanmadığı anlamına gelir.
          </dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        Bu sayıların nasıl hesaplandığına dair tam yöntem için{" "}
        <Link
          href="/metodoloji"
          className="text-brand underline decoration-dotted underline-offset-2 hover:decoration-solid"
        >
          Metodoloji
        </Link>{" "}
        sayfasına bakın.
      </p>
    </section>
  );
}
