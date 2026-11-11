import type { Metadata } from "next";
import Link from "next/link";

import { PageHero } from "@/components/ui/page-hero";
import { formatTurkishDate } from "@/lib/time";
import {
  getQualitySnapshots,
  type QualitySnapshot,
} from "@/lib/quality/snapshots";
import { staticPageMetadata } from "@/lib/seo/page-metadata";
import { TIME_WINDOW_HOURS } from "../../../supabase/functions/_shared/cluster/constants";

// /kalite — M-09, the pipeline's own quality scoreboard. Publishes the
// exact numbers `node scripts/audit-clusters.mjs --json --persist` writes once
// a day to `cluster_quality_snapshots` (.github/workflows/cluster-audit.yml),
// read via src/lib/quality/snapshots.ts (unit tested there — this file trusts
// its null-safe, never-throw contract and only decides how to render null /
// [] / real rows).
//
// Basis and timing are stated as they are (h41-derived-1). The audit reads only
// politika/son_dakika articles (scripts/audit-clusters.mjs POLITICS_CATEGORIES),
// so every count here is politics-only. The workflow is scheduled for 03:00 UTC
// but GitHub starts scheduled runs late (observed 07:35-10:38 UTC) and skips
// some days, so the page never claims a fixed hour or "every night": it says the
// job runs once a day, prints each row's real `taken_at`, and counts the days
// with no measurement. The chart places points by Istanbul calendar day for the
// same reason (a missing day shows as a wider step, see chartX).
//
// The explanations match what the numbers count (h90-kalite-1, re-checked with
// read-only SQL over snapshot 61's 48 h window, 2026-11-09). The audit selects
// articles by category only, so aggregator and niche sources are inside every
// count (aggregators 749 of 3,056 articles), while /trends counts only the
// voting kinds (outlet, wire). DHA and İHA have never supplied an article, so
// agency republishing is not what makes the singleton rate high: of 1,188
// singleton clusters 444 are aggregator-only (434 haberler-com), 671 outlet-only
// and just 29 wire-only, and an aggregator article lands in a singleton 63% of
// the time against 27-33% for outlet, niche and wire articles. A singleton is
// one article INSIDE the audit window; only 31 of the 1,188 have older members
// outside it, which the definition says are not counted. `blindspot_flip_rate`
// compares the stored flag with detectBlindspot() only, so veto-withdrawn
// claims are not in it. The window length in the singleton definition comes
// from the snapshot (fallback: the clusterer's own TIME_WINDOW_HOURS), not from
// a literal.
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
    "Tayf'ın kümeleme ardışık düzeninin günde bir kez kendi üzerinde ölçtüğü kalite sayıları (yalnızca siyaset haberleri): haber ve küme sayısı, tekil küme oranı, kaynak çeşitliliği ve kör nokta tutarsızlık oranı.",
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

// Labels for cluster pairs do not exist yet (jev_gold_labels is empty and holds
// article-level labels, not pairs), so the sentence says exactly that.
const PRECISION_RECALL_SENTENCE =
  "Kesinlik ve duyarlılık henüz ölçülmedi: bunun için elle etiketlenmiş bir küme çifti seti gerekiyor ve bu set henüz yok.";

function formatPercent(rate: number): string {
  return `%${Math.round(rate * 100)}`;
}

function formatDecimal(n: number): string {
  return n.toFixed(1).replace(".", ",");
}

function formatCount(n: number): string {
  return n.toLocaleString("tr-TR");
}

const ISTANBUL_TZ = "Europe/Istanbul";
const DAY_MS = 86_400_000;

// Built once per module; the formats are pinned to Istanbul like formatTurkishDate.
const ISTANBUL_TIME_FORMAT = new Intl.DateTimeFormat("tr-TR", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: ISTANBUL_TZ,
});
const ISTANBUL_DATE_PARTS = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  timeZone: ISTANBUL_TZ,
});

/**
 * The instant a row was really measured: '5 Kasım 2026 13:26' (Istanbul).
 * The job is scheduled for 03:00 UTC but GitHub runs it hours late, so the
 * date alone would hide when the numbers were taken.
 */
function formatMeasuredAt(iso: string): string {
  const date = formatTurkishDate(iso);
  if (date === "") return "";
  return `${date} ${ISTANBUL_TIME_FORMAT.format(new Date(iso))}`;
}

/**
 * The Istanbul calendar day of an instant as a whole day number (days from
 * 1970-01-01 to that civil date), so two instants can be subtracted into
 * calendar days. NaN for an unparseable timestamp.
 */
function istanbulDayNumber(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return NaN;
  const parts = ISTANBUL_DATE_PARTS.formatToParts(t);
  const part = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / DAY_MS;
}

/**
 * Horizontal position of a snapshot in the chart's plot box. Points are
 * placed by Istanbul calendar-day offset from the first snapshot, not by row
 * index, so a day with no measurement leaves a visible, proportional gap
 * instead of silently collapsing (10-12, 10-13, 10-15: the middle point sits
 * at one third, not one half). The first snapshot lands on `plotLeft`, the
 * last on `plotLeft + plotWidth`.
 *
 * If every snapshot falls on one Istanbul day (two manual runs, say) there is
 * no day offset to use, so the time of day spreads them instead. An
 * unparseable timestamp sits on the left edge rather than producing NaN.
 */
export function chartX(
  takenAtIso: string,
  firstIso: string,
  lastIso: string,
  plotLeft: number,
  plotWidth: number,
): number {
  const day = istanbulDayNumber(takenAtIso);
  const firstDay = istanbulDayNumber(firstIso);
  const lastDay = istanbulDayNumber(lastIso);

  let fraction = 0;
  if (Number.isFinite(day) && Number.isFinite(firstDay) && Number.isFinite(lastDay)) {
    if (lastDay > firstDay) {
      fraction = (day - firstDay) / (lastDay - firstDay);
    } else {
      const at = new Date(takenAtIso).getTime();
      const start = new Date(firstIso).getTime();
      const end = new Date(lastIso).getTime();
      fraction = end > start ? (at - start) / (end - start) : 0;
    }
  }
  return plotLeft + Math.min(1, Math.max(0, fraction)) * plotWidth;
}

/**
 * Istanbul calendar days between the first and last snapshot (inclusive) that
 * have no snapshot at all. Counts distinct days, not rows, so a second run on
 * one day cannot hide an empty day elsewhere.
 */
function countMissingDays(snapshots: ReadonlyArray<{ takenAt: string }>): number {
  const days = new Set<number>();
  for (const s of snapshots) {
    const day = istanbulDayNumber(s.takenAt);
    if (Number.isFinite(day)) days.add(day);
  }
  if (days.size < 2) return 0;
  const all = [...days];
  const spanned = Math.max(...all) - Math.min(...all) + 1;
  return spanned - days.size;
}

/**
 * Length of the audit window the Definitions talk about: the latest snapshot's
 * own `windowHours`, or the clusterer's TIME_WINDOW_HOURS when there is no
 * snapshot (unavailable / empty) or the stored value is not a positive number.
 */
function definitionWindowHours(snapshots: QualitySnapshot[] | null): number {
  const hours = snapshots?.[0]?.windowHours;
  return hours !== undefined && hours > 0 ? hours : TIME_WINDOW_HOURS;
}

export default async function QualityPage() {
  const snapshots = await getQualitySnapshots();

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-10">
      <PageHero
        kicker="Şeffaflık"
        title="Küme kalitesi"
        subtitle="Tayf, kendi kümeleme ardışık düzeninin kalitesini günde bir kez ölçer ve burada — dışarıdan bir denetim değil, sistemin kendi üzerinde çalıştırdığı bir ölçüm olarak — yayımlar."
      />

      <section className="space-y-3">
        <p className={proseClass}>
          Bu sayfadaki her sayı, günlük denetim işinin (
          <code className="font-mono text-xs">.github/workflows/cluster-audit.yml</code>
          ) çalıştırdığı <code className="font-mono text-xs">scripts/audit-clusters.mjs</code>{" "}
          betiğinin, çalıştığı andan geriye son 48 saatin verisi üzerinde
          hesapladığı ve <code className="font-mono text-xs">cluster_quality_snapshots</code>{" "}
          tablosuna yazdığı sonuçtur. İş günde bir kez çalışır; GitHub
          zamanlanmış işleri geciktirebildiği için ölçüm saati değişir ve bazı
          günler ölçüm alınamayabilir. Aşağıda son 30 ölçüm gösterilir.
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

      <Definitions windowHours={definitionWindowHours(snapshots)} />
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
        Henüz hiç denetim ölçümü kaydedilmedi. İlk kayıt, günlük denetim işi
        ilk kez çalıştığında burada görünecek.
      </p>
    </div>
  );
}

function StatTiles({ latest }: { latest: QualitySnapshot }) {
  const tiles: Array<{ label: string; value: string }> = [
    {
      label: `Siyaset haberi (${latest.windowHours} saat)`,
      value: formatCount(latest.articleCount),
    },
    {
      label: "Küme sayısı (tek haberliler dahil)",
      value: formatCount(latest.clusterCount),
    },
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
          {formatMeasuredAt(latest.takenAt)}
        </span>{" "}
        (İstanbul saati) · son {latest.windowHours} saatlik pencere
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
          Grafik için en az iki ölçüm gerekiyor — henüz yalnızca bir kayıt var.
        </p>
      </section>
    );
  }

  const rates = chrono.map((s) => s.singletonRate);
  const minRate = Math.min(...rates);
  const maxRate = Math.max(...rates);
  const span = maxRate - minRate || 1;

  const first = chrono[0]!;
  const last = chrono[n - 1]!;

  const points = chrono.map((s) => {
    const x = chartX(s.takenAt, first.takenAt, last.takenAt, PAD_LEFT, PLOT_W);
    const y = PAD_TOP + PLOT_H - ((s.singletonRate - minRate) / span) * PLOT_H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const missingDays = countMissingDays(chrono);
  const firstDate = formatTurkishDate(first.takenAt);
  const lastDate = formatTurkishDate(last.takenAt);

  return (
    <section className={cardClass + " space-y-2"}>
      <h2 className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
        {`Tekil küme oranı — son ${n} ölçüm`}
      </h2>
      {/* pl-10 is the gutter the percent labels sit in (right-full of the plot box). */}
      <div className="w-full pl-10">
        <div className="relative w-full">
          <svg
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            role="img"
            aria-label={`Son ${n} ölçümde (${firstDate}–${lastDate}) tekil küme oranı %${Math.round(minRate * 100)} ile %${Math.round(maxRate * 100)} arasında değişti; en son değer %${Math.round(last.singletonRate * 100)}.`}
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
      {missingDays > 0 ? (
        <p className="text-xs text-muted-foreground">
          {`Bu aralıkta ${missingDays} gün ölçüm yok.`}
        </p>
      ) : null}
    </section>
  );
}

function SnapshotsTable({ snapshots }: { snapshots: QualitySnapshot[] }) {
  return (
    <section className={cardClass}>
      <h2 id="kalite-tablo" className="sr-only">
        Günlük kalite ölçümleri
      </h2>
      <div
        className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        role="region"
        aria-labelledby="kalite-tablo"
        tabIndex={0}
      >
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Kalite ölçümleri</caption>
          <thead>
            <tr className="border-b border-border/60 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              <th scope="col" className="py-2 pr-4 font-medium">
                Tarih ve saat (İstanbul saati)
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Siyaset haberi
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
                {/* The date names the row (WCAG 1.3.1, H63); th defaults to
                    bold and centred, hence text-left and font-normal. */}
                <th
                  scope="row"
                  className="py-2.5 pr-4 text-left font-normal whitespace-nowrap text-muted-foreground"
                >
                  {formatMeasuredAt(s.takenAt)}
                </th>
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

function Definitions({ windowHours }: { windowHours: number }) {
  return (
    <section className="space-y-3">
      <h2 className="font-serif text-xl sm:text-2xl font-normal tracking-tight border-b border-border/60 pb-2">
        Tanımlar
      </h2>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div className={ruleCard}>
          <dt className={ruleTerm}>Kapsam</dt>
          <dd className={ruleDef}>
            Denetim yalnızca politika ve son dakika kategorisindeki haberleri
            ve bu haberlerin kümelerini sayar. Tüm kaynak türleri dahildir:
            haber siteleri ve ajansların yanında toplayıcı ve niş kaynaklar da
            (ör. Haberler.com) sayılır. Bu yüzden sayılar, tüm kategorileri ama
            yalnızca spektruma sayılan kaynakları (haber siteleri ve ajanslar)
            sayan /trends ile doğrudan karşılaştırılamaz; küme sayısına tek
            haberli kümeler de dahildir.
          </dd>
        </div>
        <div className={ruleCard}>
          <dt className={ruleTerm}>Tekil küme (singleton)</dt>
          <dd className={ruleDef}>
            {`Son ${windowHours} saatlik pencerede yalnızca bir siyaset haberi bulunan küme: kümeleyici o haberi pencere içindeki başka hiçbir haberle eşleştirecek kadar benzer bulamamıştır (kümenin pencereden önceki eski üyeleri sayılmaz). Tekil kümelerin önemli bir kısmı yüksek hacimli toplayıcı kaynakların yeniden yayımladığı ya da başka hiçbir kaynağın yazmadığı haberlerdir; aynı ajans metnini kopyalayan haberler ise genellikle birleşir. "Tek kaynak" her zaman "diğerleri görmezden geldi" anlamına gelmez.`}
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
            hesaplanmadığı anlamına gelir. Veto kurallarıyla geri çekilen kör
            nokta iddiaları bu orana girmez; oran yalnızca saklanan bayrağın
            yeniden hesaplamayla uyuşup uyuşmadığını ölçer.
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
