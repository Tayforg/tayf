import type { Metadata } from "next";
import Link from "next/link";

import { PageHero } from "@/components/ui/page-hero";
import { DistinctiveWords } from "@/components/weekly/distinctive-words";
import {
  Blindspots,
  cardClass,
  metaClass,
  proseClass,
  rowClass,
  sectionTitleClass,
  WidestSpectrum,
  ZoneShares,
} from "@/components/weekly/week-sections";
import { BIAS_LABELS } from "@/lib/bias/config";
import { getZoneFeedHealth } from "@/lib/clusters/feed-health";
import { formatDdMmYyyy } from "@/lib/format/date-tr";
import { getFeedStatusSummary } from "@/lib/sources/feed-status";
import { getWeeklyDistinctiveWords } from "@/lib/weekly/distinctive-words-query";
import { getRecentWeekKeys } from "@/lib/weekly/week-archive";
import {
  getWeeklyClusters,
  getWeeklyLabelChanges,
  summariseWeek,
  WEEKLY_CLUSTER_LIMIT,
  type WeeklyLabelChange,
} from "@/lib/weekly/weekly-query";

// /hafta — P-07 "Medya Hava Durumu", the weekly content spine: what each
// Medya DNA zone led with over the trailing 7 days, the stories that drew
// the widest spectrum, the blindspots, how many sources went silent, and
// which labels moved.
//
// The four data sections (ZoneShares, BasisNote, WidestSpectrum,
// Blindspots) live in src/components/weekly/week-sections.tsx so
// /hafta/[hafta] (the ISO-week archive, owned-channels Part B) can render
// the identical markup without duplicating it. This page's own output is
// unchanged from before that extraction.
//
// "Aynı hafta, farklı kelimeler" (src/components/weekly/distinctive-words.tsx)
// is an LLM-free, always-rendered companion section: it shows the headline
// words/phrases each Medya DNA zone uses significantly more than the other
// two over the trailing 7 days (Fightin' Words), sourced independently of
// the cluster read above so it still renders when clusters === null.
//
// No `export const dynamic` / `revalidate`: under cacheComponents every
// fetcher is a "use cache" function that resolves to null on error, so this
// page prerenders into its honest unavailable state rather than failing the
// build.

export const metadata: Metadata = {
  title: "Haftanın yelpazesi",
  description:
    "Son 7 günde hangi taraf neyi öne çıkardı: bölge payları, en geniş yelpazeli haberler, kör noktalar, sessiz kaynaklar ve etiket değişiklikleri.",
  alternates: { canonical: "/hafta" },
};

const UNAVAILABLE_COPY =
  "Haftalık özet şu anda hesaplanamıyor. Birkaç dakika içinde tekrar deneyin.";
const EMPTY_COPY = "Bu hafta yeterli küme oluşmadı.";

export default async function WeeklyPage() {
  const [clusters, health, feedStatus, labelChanges, words, recentWeeks] =
    await Promise.all([
      getWeeklyClusters(),
      getZoneFeedHealth(),
      getFeedStatusSummary(),
      getWeeklyLabelChanges(),
      getWeeklyDistinctiveWords(),
      getRecentWeekKeys(),
    ]);

  const summary =
    clusters !== null && clusters.length > 0
      ? summariseWeek(clusters, health)
      : null;

  // The cluster window is hard-capped and ordered by size, so hitting the
  // cap means the figures below are the biggest WEEKLY_CLUSTER_LIMIT
  // clusters, not the whole week. Say so rather than publishing a truncated
  // total as "the week".
  const truncated = clusters !== null && clusters.length >= WEEKLY_CLUSTER_LIMIT;

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-10">
      <PageHero
        kicker="Haftalık"
        title="Haftanın yelpazesi"
        subtitle="Son 7 günün medya hava durumu: hangi taraf neyi öne çıkardı, hangi haber en geniş yelpazeyi topladı, neyi yalnızca bir taraf gördü."
      />

      {clusters === null ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
          <p className="text-sm text-muted-foreground">{UNAVAILABLE_COPY}</p>
        </div>
      ) : summary === null ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
          <p className="text-sm text-muted-foreground">{EMPTY_COPY}</p>
        </div>
      ) : (
        <>
          <ZoneShares
            summary={summary}
            health={health}
            feedStatus={feedStatus}
            truncated={truncated}
          />
          <WidestSpectrum summary={summary} />
          <Blindspots summary={summary} health={health} />
        </>
      )}

      <DistinctiveWords data={words} />

      <SilentSources feedStatus={feedStatus} />
      <LabelChanges changes={labelChanges} />
      <WeekArchiveNav previous={recentWeeks.previous} />
    </div>
  );
}

function SilentSources({
  feedStatus,
}: {
  feedStatus: { delivering: number; total: number } | null;
}) {
  return (
    <section className={`${cardClass} space-y-3`}>
      <h2 className={sectionTitleClass}>Sessiz kaynaklar</h2>
      <p className="text-sm text-foreground/90">
        {feedStatus === null
          ? "Sessiz kaynak sayısı bilinmiyor."
          : // `delivering` is measured over FEED_YIELD_WINDOW_MS (72 h), not
            // the 7-day page window — the copy states the window the data
            // actually covers.
            `${feedStatus.total - feedStatus.delivering} kaynak son 72 saatte hiç haber vermedi (${feedStatus.delivering} / ${feedStatus.total} kaynak haber verdi).`}
      </p>
      <Link
        href="/kaynaklar/durum"
        className="text-xs underline decoration-dotted underline-offset-2 text-muted-foreground hover:text-foreground"
      >
        Kaynak durumu
      </Link>
    </section>
  );
}

function LabelChanges({ changes }: { changes: WeeklyLabelChange[] | null }) {
  return (
    <section className={`${cardClass} space-y-3`}>
      <h2 className={sectionTitleClass}>Etiket değişiklikleri</h2>
      {changes === null ? (
        <p className={proseClass}>Etiket geçmişi okunamadı.</p>
      ) : changes.length === 0 ? (
        <p className={proseClass}>Bu hafta etiket değişmedi.</p>
      ) : (
        <ul className="space-y-2">
          {changes.map((change) => {
            // formatDdMmYyyy returns "" for an unparseable date and its
            // contract is that callers gate on that empty string — an
            // ungated call would render a dangling "()".
            const changedOn = formatDdMmYyyy(change.changedAt);

            return (
            <li key={`${change.slug}-${change.changedAt}`} className={rowClass}>
              <span className="text-sm text-foreground/90">
                {`${change.name}: ${change.oldBias ? BIAS_LABELS[change.oldBias] : "—"} → ${BIAS_LABELS[change.newBias]}${changedOn ? ` (${changedOn})` : ""}`}
              </span>
              {change.reason ? (
                <span className={metaClass}>{change.reason}</span>
              ) : null}
            </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Part B (owned-channels): links into the ISO-week archive
 * (/hafta/[hafta]). Deliberately NOT an `<h2>` — /hafta's five existing
 * section headings (see page.test.tsx) stay exactly five; this is a
 * footer-style nav, not a sixth content section.
 */
function WeekArchiveNav({ previous }: { previous: string[] }) {
  if (previous.length === 0) return null;

  return (
    <nav aria-label="Geçmiş haftalar" className={`${cardClass} space-y-2`}>
      <p className="text-sm font-medium text-foreground">Geçmiş haftalar:</p>
      <ul className="flex flex-wrap gap-3">
        {previous.map((key) => {
          const weekNo = key.split("-W")[1];
          const label = weekNo ? `${Number(weekNo)}. hafta` : key;
          return (
            <li key={key}>
              <Link
                href={`/hafta/${key}`}
                className="text-sm font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-primary"
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
