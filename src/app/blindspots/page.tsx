import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { Eye, EyeOff } from "lucide-react";
import { staticPageMetadata } from "@/lib/seo/page-metadata";

// Own metadata so the page doesn't inherit the root layout's title and
// `canonical: "/"` (which would mark this page a duplicate of the homepage).
// staticPageMetadata also sets its own og:* / twitter:* url, title and image.
export const metadata: Metadata = staticPageMetadata({
  title: "Kör noktalar",
  description:
    "Bir tarafın haberi verdiği, diğer taraflardan az ya da hiç haber çıkmayan hikâyeler. Türk medyasındaki kör noktaları tek ekranda görün.",
  path: "/blindspots",
  alternateTypes: { "application/rss+xml": "/rss/kor-noktalar.xml" },
});

import Link from "next/link";
import { ClusterCard } from "@/components/story/cluster-card";
import { NewsletterForm } from "@/components/newsletter/newsletter-form";
import { PageHero } from "@/components/ui/page-hero";
import { RetryButton } from "@/components/ui/retry-button";
import { DenominatorNote } from "@/components/source/denominator-note";
import {
  NearBlindspotList,
  nearBlindspotCountLabel,
} from "@/components/blindspots/near-blindspot-section";
import { SilenceDigestBand } from "@/components/blindspots/silence-digest-band";
import { getNearBlindspotsSafe } from "@/lib/clusters/near-blindspots-query";
import { BLINDSPOT_LIST_LOOKBACK_DAYS } from "@/lib/clusters/blindspot-pick";
import { RECALL_MATCH_NOTE } from "@/lib/clusters/recall-matched-zones";
import { blindspotCountLine } from "@/lib/clusters/silence-digest";
import { isMailConfigured } from "@/lib/email/resend";
import { ZONE_META } from "@/lib/bias/config";
import {
  dominantZonePercent,
  isOnlyZone,
  nonVotingOutsideZone,
} from "@/lib/bias/zone-summary";
import { cardEnterClass } from "@/lib/ui/card-enter";
import {
  getBlindspotsSafe,
  type BlindspotBundle,
  type BlindspotMoreRow,
} from "@/lib/clusters/blindspots-query";
import { getFeedStatusSummary } from "@/lib/sources/feed-status";

// /blindspots — Tayf's "Kör noktalar" feed. The fetch/filter/tally logic
// lives in blindspots-query.ts (see that file for the BLINDSPOT contract,
// dedupe, and quality-filter rationale) so it can be unit-tested and reused
// (e.g. by the weekly digest cron) without rendering JSX.
//
// reader-queries D2: the page's static shell (container, PageHero, the RSS
// link) now renders synchronously so it's part of the prerendered shell;
// the data-dependent part streams in behind its own <Suspense> boundary as
// `BlindspotsFeed`, which never lets a Supabase failure reach the error
// boundary — `getBlindspotsSafe()` degrades to a retry affordance instead.
//
// The page owns exactly ONE boundary. "Kör noktaya yakın" is nested inside
// the feed (see BlindspotsFeed): React reveals a nested boundary only after
// its parent has revealed, so the band can never paint before the feed and
// push it down (perf-4 layout shift).
export default function BlindspotsPage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-5">
      <PageHero
        kicker="Sadece bir tarafın gördüğü"
        title="Kör noktalar"
        subtitle="Bir tarafın haberi verdiği, diğer taraflardan az ya da hiç haber çıkmayan hikâyeler. Bu bir yok sayma iddiası değil: yalnızca spektruma sayılan kaynaklar sayılır."
      />

      <p className="text-xs text-muted-foreground">
        {/* Plain <a>, not next/link: Link would prefetch this DB-backed route
            handler as an RSC request whenever it scrolls into view (perf-6).
            Pinned by tests/guards/feed-links-plain-anchor.test.ts. */}
        <a
          href="/rss/kor-noktalar.xml"
          type="application/rss+xml"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          RSS
        </a>
        {" · "}
        {/* h72-newreader-1: the definition link. A plain <a> like the RSS link
            above: /metodoloji is static, so a prefetch buys nothing. */}
        <a
          href="/metodoloji#kor-nokta"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Kör nokta nasıl belirleniyor?
        </a>
      </p>

      <Suspense fallback={<BlindspotsSkeleton />}>
        <BlindspotsFeed />
      </Suspense>
    </div>
  );
}

function BlindspotsSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl ring-1 ring-border/60 bg-card/60 p-5 flex gap-4 animate-pulse"
        >
          <div className="h-28 w-40 rounded-lg bg-muted/50 shrink-0" />
          <div className="flex-1 space-y-3">
            <div className="h-5 w-3/4 rounded bg-muted/70" />
            <div className="h-3 w-1/2 rounded bg-muted/40" />
            <div className="h-2 w-full rounded-full bg-muted/40" />
          </div>
        </div>
      ))}
    </div>
  );
}

// Exported (in addition to the default page export) so tests can render
// the data-dependent body directly without needing a full Suspense-aware
// renderer — see page.test.tsx.
export async function BlindspotsFeed() {
  // connection() signals to PPR that the code below must run at request
  // time (Date.now() is non-deterministic). The static shell (page.tsx
  // above) already streamed; this boundary's own loading.tsx-style
  // fallback covers the wait.
  await connection();

  // The feed awaits ONLY the blindspot read. The DenominatorNote's
  // feed-status summary is an optional widget and lives in its own Suspense
  // slot (BlindspotsDenominator below): a slow or stalled summary read can
  // delay or hide that one line, never the feed (hunt-27 resilience-1; it used
  // to share a Promise.all with this read).
  const result = await getBlindspotsSafe();

  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const countLine = result.ok
    ? blindspotCountLine(
        result.claimCount,
        result.sideCounts,
        BLINDSPOT_LIST_LOOKBACK_DAYS,
      )
    : null;

  return (
    <>
      {/* perf-4 (h55-browser-1): this slot sits ABOVE the count line, so a null
          fallback let the summary resolve after the feed had streamed and
          insert a 48-68 px line that pushed the whole feed down. The fallback
          is the fail-open, numberless DenominatorNote instead: its line box
          exists from the feed's first paint, and the late summary only swaps
          "kaynaklar" for "N/M kaynak" in place. The note stays first, and the
          feed still never awaits the summary (hunt-27). */}
      <Suspense fallback={<DenominatorNote delivering={null} total={null} />}>
        <BlindspotsDenominator />
      </Suspense>

      {!result.ok ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border/60 bg-card/40 px-6 py-16 text-center">
          {/* Failed state only: keep it out of the index. PLACEMENT CAVEAT:
              this renders inside the <Suspense> boundary around
              BlindspotsFeed, so it is streamed into <body>, not hoisted into
              <head> (React 19 only hoists shell content). Whether Googlebot
              honours a body robots meta is unproven: verify with Search
              Console URL Inspection (rendered HTML) on a staging deploy
              pointed at a dead DB, and if it is ignored emit robots from
              generateMetadata via getBlindspotsSafe instead. Absent from the
              ok and ok-but-empty paths. */}
          <meta name="robots" content="noindex" />
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
            <EyeOff className="h-7 w-7" aria-hidden="true" />
          </div>
          <p className="font-serif text-sm font-medium text-foreground">
            Kör noktalar şu an yüklenemedi, birkaç dakika içinde tekrar
            deneyin.
          </p>
          <RetryButton />
        </div>
      ) : result.bundles.length === 0 ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Şu an için belirgin bir kör nokta yok. Her taraftan haberler dengeli
            dağılmış.
          </p>
        </div>
      ) : (
        <>
          {/* h53-consistency-1: the list is every public claim of the trailing
              7 days. The count line and the band below are counted by the
              fetcher over ALL of them (no extra query, no clock read here);
              only the first DISPLAY_LIMIT get a full card, the rest follow as
              compact rows. */}
          {countLine && (
            <p className="text-sm text-muted-foreground">{countLine}</p>
          )}
          <SilenceDigestBand digest={result.digest} />
          {/* h67-landmarks-1: the cards are <h3>s (BlindspotCard), so they need
              an <h2> parent. The band's own h2 ("Bu listede kim yer vermedi?")
              names the band, not the list. Screen-reader only: nothing moves. */}
          <h2 className="sr-only">Kör nokta haberleri</h2>
          <div className="space-y-4">
            {result.bundles.map((b, i) => {
              const hoursAgo =
                (nowMs - new Date(b.cluster.updated_at).getTime()) / 3_600_000;
              const prevZone =
                i > 0 ? result.bundles[i - 1]?.dominantZone ?? null : null;
              const showDivider = i > 0 && b.dominantZone !== prevZone;
              return (
                <div key={b.cluster.id}>
                  {showDivider && (
                    <div className="h-px bg-gradient-to-r from-transparent via-border/30 to-transparent my-6" />
                  )}
                  <div className={cardEnterClass(i, "cap6") || undefined}>
                    <BlindspotCard
                      bundle={b}
                      index={i}
                      isAging={hoursAgo > 48}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {result.more.length > 0 && <MoreBlindspotList rows={result.more} />}
        </>
      )}

      {isMailConfigured() && (
        <div className="rounded-xl border border-border/60 bg-card/40 p-4 sm:p-5 max-w-sm">
          <NewsletterForm />
        </div>
      )}

      {/* "Kör noktaya yakın" (display only, not blindspots) is the LAST child,
          in every state (ok, empty, failed), so the visual order is unchanged.
          Nested boundary: React reveals it only after this feed has revealed,
          so it always streams in below already-laid-out content and cannot
          shift it (perf-4). It still never blocks or couples to the feed:
          the feed does not await it, a slow or failed fetch only delays or
          hides the band (no skeleton, fallback null), and SilenceDigestBand
          and DenominatorNote above use the main bundles only. */}
      <Suspense fallback={null}>
        <NearBlindspotsSection />
      </Suspense>
    </>
  );
}

// The "N of M sources counted" line above the feed. DenominatorNote wants one
// directory-wide, voting-kind N/M pair, not a per-zone breakdown (a blindspot
// bundle can span either pole), so this reads the cheap
// `getFeedStatusSummary()` existence probe from src/lib/sources/feed-status.ts
// rather than A1's `getZoneFeedHealth()`/`zoneYieldDenominator`. Rendered by
// BlindspotsFeed in its own <Suspense> at the position the note always had.
// The boundary's fallback is the same note without numbers, so the slot
// reserves its line from the first paint and this component only swaps in the
// figures (h55-browser-1). `getFeedStatusSummary()` never throws (null
// degrades the note to that same wording). Module-private on purpose: tests
// locate it by name (page.test.tsx).
async function BlindspotsDenominator() {
  await connection();
  const feedSummary = await getFeedStatusSummary();
  return (
    <DenominatorNote
      delivering={feedSummary?.delivering ?? null}
      total={feedSummary?.total ?? null}
    />
  );
}

// "Kör noktaya yakın" (just below the blindspot threshold). Exported like
// BlindspotsFeed so tests can render it directly. Mounted by BlindspotsFeed
// in its own nested <Suspense>, but deliberately NOT awaited or fed into it:
// the feed's SilenceDigestBand and DenominatorNote are built from the main
// bundles only, and these stories are not blindspots.
// `getNearBlindspotsSafe()` never throws; `null` hides the section.
export async function NearBlindspotsSection() {
  await connection();
  return <NearBlindspotList items={await getNearBlindspotsSafe()} />;
}

// "Diğer kör noktalar": the claims of the window that did not get one of the
// full cards, one line each (title, "%P Taraf", "N kaynak"), no images. Same
// shape as the "Kör noktaya yakın" rows. The percent comes from the row's
// voting tally by largest remainder (dominantZonePercent), the very rule the
// card's chip and bar use, so a row never prints a number its cluster page
// disagrees with. The links do not prefetch: this list can hold a hundred
// request-time cluster pages.
function MoreBlindspotList({ rows }: { rows: BlindspotMoreRow[] }) {
  return (
    <section
      aria-labelledby="diger-kor-noktalar"
      className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-4 sm:p-5"
    >
      <h2 id="diger-kor-noktalar" className="font-serif text-sm font-semibold">
        Diğer kör noktalar
      </h2>
      <p className="max-w-[65ch] text-xs text-muted-foreground leading-relaxed">
        {`Son ${BLINDSPOT_LIST_LOOKBACK_DAYS} günün, kart olarak gösterilmeyen ${rows.length} kör noktası; en belirgin olandan başlıyor.`}
      </p>
      <ul className="divide-y divide-border/40">
        {rows.map((row) => {
          const meta = ZONE_META[row.dominantZone];
          const pct = dominantZonePercent(row.votingZoneCounts, row.dominantZone);
          const votingTotal =
            row.votingZoneCounts.iktidar +
            row.votingZoneCounts.bagimsiz +
            row.votingZoneCounts.muhalefet;
          return (
            <li
              key={row.id}
              className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <Link
                href={`/cluster/${row.id}`}
                prefetch={false}
                className="min-w-0 font-serif text-sm font-medium text-foreground underline-offset-2 hover:underline"
              >
                {row.title}
              </Link>
              <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px]">
                <span
                  className={`inline-flex items-center rounded-full ${meta.chipBg} ${meta.chipBorder} border px-2.5 py-0.5 font-serif font-semibold ${meta.chipText}`}
                >
                  {`%${pct} ${meta.label}`}
                </span>
                <span
                  className="text-muted-foreground"
                  title="Toplayıcı ve niş kaynaklar spektruma sayılmaz."
                >
                  {nearBlindspotCountLabel(row.sourceCount, votingTotal)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface BlindspotCardProps {
  bundle: BlindspotBundle;
  index: number;
  isAging?: boolean;
}

// Composes the existing <ClusterCard> with a "Sadece X yazdı" ribbon (or the
// qualified "Spektrumda sadece X" when a non-voting source from another zone
// also wrote the story, or "Kümede sadece X" when Jev matched the silent zone in
// another cluster) and a
// dominant-zone tint frame. We deliberately do NOT duplicate ClusterCard's
// markup — the ribbon sits above and the tint is a parent ring + bg layer
// so any future ClusterCard tweak (e.g. layout, image rules) is inherited
// for free.
function BlindspotCard({ bundle, index, isAging }: BlindspotCardProps) {
  const meta = ZONE_META[bundle.dominantZone];
  // Both read the voting tally the card's bar is drawn from, so the chip and
  // the bar print the same number (largest remainder: 11/1/1 is 84, not
  // Math.round's 85). "Sadece" is decided on the counts, not on a rounded
  // 100: 250/1/0 reads 100 but another zone still has a source.
  const pct = dominantZonePercent(bundle.votingZoneCounts, bundle.dominantZone);
  const only = isOnlyZone(bundle.votingZoneCounts, bundle.dominantZone);
  const pctLabel = `%${pct}`;
  // h43-blindspots-1: "only" is a claim about the voting sources. When a
  // toplayıcı / niş source from another zone also carried the story, "yazdı"
  // would be false, so the chip says what the spectrum shows and the side note
  // names the uncounted outsiders. The flag rule and every count are untouched;
  // with no such outsider both strings are exactly what they always were.
  // h116-claims-1: the number counts only the toplayıcı / niş sources from
  // ANOTHER zone, the ones that make "yazdı" false. A toplayıcı / niş source
  // inside the dominant zone is not in it, so it can sit beside the card's
  // "7 kaynak (5 sınıflandırılmış)" pill without the two adding up; the note
  // says "başka bölgeden" so a bare "+1" is not read as every uncounted source.
  const outsiders = only ? nonVotingOutsideZone(bundle.sources, bundle.dominantZone) : 0;
  // h106-blindspotbadges-1: "only" is also a claim about the whole story. When the
  // site's own Jev recall stage matched the silent zone with the same event (filed
  // in another cluster; the fetcher hands the zones over as recallMatchedZones),
  // "Sadece X yazdı" is not something the data supports, so the chip says what
  // THIS cluster shows and the side note adds the qualifier. The claim stays
  // public and no count, share or flag moves. A bundle cached before the field
  // existed has none (`?? []`), and an empty list leaves every string as it was.
  const recallMatched = only && (bundle.recallMatchedZones ?? []).length > 0;
  const recallNote = recallMatched ? ` · ${RECALL_MATCH_NOTE}` : "";
  // Precedence: the toplayıcı / niş qualifier keeps the chip text ("Spektrumda
  // sadece X" is already not absolute) and the recall phrase joins its side note.
  const chipLabel = !only
    ? `${pctLabel} ${meta.label}`
    : outsiders > 0
      ? `Spektrumda sadece ${meta.label}`
      : recallMatched
        ? `Kümede sadece ${meta.label}`
        : `Sadece ${meta.label} yazdı`;
  // One string (leading space kept) so the markup stays a single text node.
  const sideNote =
    outsiders > 0
      ? ` tek tarafta · başka bölgeden +${outsiders} toplayıcı/niş kaynak (sayılmaz)${recallNote}`
      : ` tek tarafta${recallNote}`;

  return (
    <div
      className={`rounded-xl border ${meta.zoneBorder} ${meta.zoneBg} p-2 sm:p-3 space-y-2`}
    >
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full ${meta.chipBg} ${meta.chipBorder} border px-2.5 py-1 text-[11px] font-serif font-semibold ${meta.chipText}`}
          >
            <Eye className="h-3 w-3" aria-hidden="true" />
            {chipLabel}
          </span>
          {only && (
            <span className="text-[11px] text-muted-foreground">
              <span className="font-mono">{pctLabel}</span>
              {sideNote}
            </span>
          )}
        </div>
      </div>

      <ClusterCard
        cluster={bundle.cluster}
        articles={bundle.articles}
        sources={bundle.sources}
        index={index}
        isAging={isAging}
        isWireRedistribution={bundle.isWireRedistribution}
        effectiveArticleCount={bundle.effectiveArticleCount}
        headingLevel={3}
      />
    </div>
  );
}
