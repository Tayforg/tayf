import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ComponentProps } from "react";
import { notFound, permanentRedirect } from "next/navigation";
import { AlertTriangle, ArrowLeft, Copy } from "lucide-react";

import { BiasBadge } from "@/components/story/bias-badge";
import { BalanceChip } from "@/components/story/balance-chip";
import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { ClusterCardImage } from "@/components/story/cluster-card-image";
import {
  CLUSTER_HERO_QUALITY,
  CLUSTER_HERO_SIZES,
} from "@/components/story/cluster-card";
import { MediaDna } from "@/components/story/media-dna";
import { toMediaDnaSources } from "@/components/story/media-dna-sources";
import { FramingComparison } from "@/components/story/framing-comparison";
import { FramingReceiptCard } from "@/components/story/framing-receipt";
import { CrossSpectrumCaption } from "@/components/story/cross-spectrum-caption";
import { ShareButton } from "@/components/story/share-button";
import { BookmarkButton } from "@/components/bookmark/bookmark-button";
import { CompareButton } from "@/components/compare/compare-button";
import { SourceKunye } from "@/components/story/source-kunye";
import { OwnershipLine } from "@/components/story/ownership-line";
import { StoryTimeline } from "@/components/story/story-timeline";
import { FactCheckBox } from "@/components/story/fact-check-box";
import { ThreadLink } from "@/components/story/thread-link";
import { RelatedStories } from "@/components/story/related-stories";
import { getClusterFactChecks } from "@/lib/fact-checks/cluster-fact-checks-query";
import { getPublishedThreadForCluster } from "@/lib/story-threads/public-query";
import { getSourceMetadata } from "@/lib/sources/factuality";
import {
  detectCrossSpectrum,
  summarizeSurprises,
} from "@/lib/bias/cross-spectrum";
import {
  getClusterDetailOrThrow,
  imageEligibleMembers,
} from "@/lib/clusters/cluster-detail-query";
import {
  getCachedClusterFramingReceipt,
  isFramingReceiptPublic,
  shouldShowPublicFramingReceipt,
} from "@/lib/clusters/framing-receipt";
import { getZoneFeedHealth } from "@/lib/clusters/feed-health";
import { pickHeroCandidates } from "@/lib/images/hero-candidates";
import { normalizeImageUrl } from "@/lib/images/image-url";
import { getPoliticsClusters } from "@/lib/clusters/politics-query";
import {
  buildRelatedBlock,
  relatedFeedFor,
  relatedHubLink,
  relatedTopicLabel,
  type RelatedCandidate,
} from "@/lib/clusters/related-clusters";
import { getTopicClusters } from "@/lib/clusters/topic-query";
import { hasIndexableTitle } from "@/lib/seo/indexable-title";
import { awaitRequestScope, coalesce } from "@/lib/cache-resilience";
import { hasStoryCardCoverage, storyCardHref } from "@/lib/cards/story-card";
import { buildShareText } from "@/lib/clusters/share";
import { wireBadgeLabel, wireBadgeTitle } from "@/lib/clusters/wire";
import { clusterUpdateCue } from "@/lib/clusters/update-cue";
import {
  buildStoryTimeline,
  missingZones,
  STORY_TIMELINE_MIN_SOURCES,
  timelineMembersFrom,
  votingSourceCount,
  type StoryTimeline as StoryTimelineData,
} from "@/lib/clusters/story-timeline";
import { getMemberSeenAt } from "@/lib/clusters/story-timeline-query";
import {
  describeForMeta,
  summaryAttribution,
  summaryLabel,
} from "@/lib/clusters/summary-attribution";
import { isAllOpinion } from "@/lib/articles/opinion-url";
import { ReadAcrossSpectrum } from "@/components/story/read-across-spectrum";
import { RelativeTime } from "@/components/story/relative-time";
import { StaleCopyNotice } from "@/components/pwa/stale-copy-notice";
import { currentTimeMs } from "@/lib/time";
import { partitionByVote, sourceKindOf, SOURCE_KIND_META } from "@/lib/sources/kind";
import {
  clusterTextLang,
  headlineLang as memberHeadlineLang,
  isLanguageIsolatedCluster,
  sourceLang,
} from "@/lib/sources/source-language";
import {
  buildTayfOrganization,
  newsArticleInLanguage,
  serializeJsonLd,
} from "@/lib/seo/json-ld";
import { siteUrl } from "@/lib/site-url";
import { oembedDiscoveryHref } from "@/lib/embed/embed-snippet";
import { balanceFromDistribution } from "@/lib/bias/balance";
import { zoneOf } from "@/lib/bias/config";
import { uniqueSources } from "@/lib/bias/zone-summary";
import { NewTabHint } from "@/components/ui/new-tab-hint";
import type { MediaDnaZone } from "@/types";
import { isContentlessTitle } from "../../../../supabase/functions/_shared/rss/entities";

/**
 * "Kim önce yazdı?" data. Both lookups are skipped below the 3-source floor
 * (judged on VOTING members only), and feed health (only used to word an
 * absent zone) is skipped when every voting zone has a member. Both fail open
 * to null — a missing created_at map just means published times are used
 * as-is. Non-voting (toplayıcı / niş) members are plotted for context but
 * never reach the floor, the first mover or the zone checks; `getMemberSeenAt`
 * already covers every cluster member, so they cost no extra query.
 *
 * `languageIsolated` (h59-english-1: every member an English-language outlet)
 * words no zone as absent, so the feed-health read that only explains an absent
 * zone is skipped too.
 */
async function loadStoryTimeline(
  clusterId: string,
  votingMembers: Parameters<typeof timelineMembersFrom>[0],
  nonVotingMembers: Parameters<typeof timelineMembersFrom>[0],
  languageIsolated: boolean,
): Promise<StoryTimelineData | null> {
  const members = timelineMembersFrom(votingMembers);
  if (votingSourceCount(members) < STORY_TIMELINE_MIN_SOURCES) return null;
  const [seenAt, health] = await Promise.all([
    getMemberSeenAt(clusterId),
    !languageIsolated && missingZones(members).length > 0
      ? getZoneFeedHealth()
      : Promise.resolve(null),
  ]);
  return buildStoryTimeline(
    members,
    seenAt,
    health,
    timelineMembersFrom(nonVotingMembers),
    languageIsolated,
  );
}

// "Bu hikayenin devamı" pill. Rendered inside <Suspense fallback={null}> so the
// published-thread read can never hold the article. `getPublishedThreadForCluster`
// never throws (null when off, unthreaded or on an outage). Module-private: a
// page file may only export the Next.js route API (tests locate it by name).
async function ClusterThreadSlot({ id }: { id: string }) {
  const thread = await getPublishedThreadForCluster(id);
  return thread ? <ThreadLink slug={thread.slug} title={thread.title} /> : null;
}

// "Bu konuda doğrulama" box, in its own <Suspense fallback={null}> for the same
// reason. `getClusterFactChecks` never throws (a failed read logs and resolves
// to []). Module-private like ClusterThreadSlot.
async function ClusterFactCheckSlot({ id }: { id: string }) {
  const factChecks = await getClusterFactChecks(id);
  return factChecks.length > 0 ? <FactCheckBox items={factChecks} /> : null;
}

// "İlgili haberler": up to five other recent multi-article clusters on the same
// topic, plus the topic's hub link. It adds NO query of its own: it reads the
// feed /konu/<slug> page 1 (and its RSS) already reads, or, for 'politika'
// (which has no hub), the home feed's shared remote entry. Rendered last, in
// its own <Suspense fallback={null}>, so a slow feed can never hold the article
// and the late arrival shifts nothing above it. The WHOLE body is guarded:
// `getTopicClusters` never throws (null means a failed read) but
// `getPoliticsClusters` rethrows a sustained outage, and an optional block must
// never reach error.tsx. A topic that is null, unknown or missing (a cache
// entry written before the column was read) yields no block. The topic read is
// also bounded per hub slug (see the comment at the call): `getTopicClusters`
// has no single-flight key, so without that bound every crawled cluster page
// would run its own live feed read for as long as the feed's failed cache
// sentinel lives. Module-private, like the slots above: a page file may only
// export the Next.js route API.
async function ClusterRelatedSlot({
  clusterId,
  topic7,
  headline,
}: {
  clusterId: string;
  topic7: string | null;
  headline: string;
}) {
  // The element is built after the try block (react-hooks/error-boundaries
  // forbids constructing JSX inside it); building one cannot throw.
  let props: ComponentProps<typeof RelatedStories>;
  try {
    const feed = relatedFeedFor(topic7);
    if (!feed) return null;
    let bundles: readonly RelatedCandidate[];
    if (feed.kind === "topic") {
      // `getTopicClusters` passes no key to its resolver, so while its cached
      // attempt holds a failed sentinel (memoised for `minutes`) every call
      // runs its own live, uncoalesced read: a 31-row embedded select held for
      // up to READER_TIMEOUT_MS, once per crawled or shared cluster page. Bound
      // it here, per hub slug (six keys, from the TOPIC_SLUGS whitelist, never
      // user input): concurrent views share ONE in-flight read, and a failed
      // one arms the 5 s negative cooldown. null is the fetcher's failure
      // value, so it is turned into a rejection for the cooldown to see; the
      // catch below then yields no block. A healthy read (a cache hit) is
      // unchanged. `coalesce` reads the clock, hence the request-scope await
      // first; this slot already streams inside its own <Suspense>.
      await awaitRequestScope();
      const res = await coalesce(`related:konu:${feed.slug}`, async () => {
        const read = await getTopicClusters(feed.slug, 1);
        if (!read) throw new Error("konu feed unavailable");
        return read;
      });
      bundles = res.bundles;
    } else {
      bundles = (await getPoliticsClusters()).bundles;
    }
    const { mode, items } = buildRelatedBlock({
      currentId: clusterId,
      currentTitle: headline,
      topic: feed.kind === "topic" ? feed.slug : "politika",
      bundles,
    });
    if (items.length === 0) return null;
    const hub = relatedHubLink(feed);
    props = {
      items,
      mode,
      topicLabel: relatedTopicLabel(feed),
      hubHref: hub.href,
      hubLabel: hub.label,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[cluster-related] omitted:", message);
    return null;
  }
  return <RelatedStories {...props} />;
}

// A cluster whose stored title has no letter or digit once decoded ('&nbsp',
// '-', '…') has no headline to show or to index (hunt-10: /cluster/46467982-…
// was served as "&amp;nbsp — Tayf", indexable). Reader side only, no data
// rewrite: the page and its metadata fall back to this neutral label and the
// metadata goes noindex. Module-private: a page file may only export the
// Next.js route API.
const NO_HEADLINE_FALLBACK = "Haber";

// One definition of "this page is offered to the index", shared by the robots
// tag in generateMetadata and the "İlgili haberler" gate in the page body. An
// archived cluster, a headline-less one (hunt-10), a single-article one
// (h31-seo-1: ~71% of new clusters, one outlet's headline and lead sentence)
// and one whose served title is a question or an SEO explainer (h34-reader-2:
// "Saniye Caran kimdir? ... kaç yaşında, nereli?", 16 of them in 3 days, all
// served index,follow) are noindex; they also get no related block, which would
// add feed reads to most renders and give no indexable crawl path. The question
// test is hasIndexableTitle (src/lib/seo/indexable-title.ts) on the title the
// page serves (`title_tr`, which is the neutral title when there is one); the
// month and news sitemaps and the IndexNow ping apply the very same test, so
// none of them lists a URL this tag refuses. Module-private: a page file may
// only export the Next.js route API.
function isIndexableCluster(
  cluster: { is_archived: boolean; article_count: number; title_tr: string },
  hasHeadline: boolean,
): boolean {
  return (
    !cluster.is_archived &&
    hasHeadline &&
    cluster.article_count >= 2 &&
    hasIndexableTitle({ title_tr: cluster.title_tr })
  );
}

interface PageProps {
  // Next.js 16: dynamic-route `params` is a Promise and must be awaited.
  params: Promise<{ id: string }>;
}

// Dynamic SEO metadata. Per Next.js 16, dynamic-route metadata must be
// produced by an exported async `generateMetadata` (the static `metadata`
// object can't access `params`). The fetch goes through the same
// `getClusterDetailOrThrow` the page uses (React `cache` shares one result
// per request), so it's effectively free on warm hits.
//
// A timeout is NOT a 404: `getClusterDetailOrThrow` rejects on a sustained
// read failure and resolves null only for a malformed id or a genuinely
// missing row. The catch below answers a failure with a noindex "unavailable"
// shell; only the null read calls notFound(), after the catch, so a transient
// error can never turn into a 404.
//
// A4: a missing cluster calls notFound() here instead of returning a bespoke
// "Sayfa bulunamadı" shell, so the head carries the not-found.tsx metadata
// (its own title and description, noindex) rather than an inherited homepage
// description. Measured 2026-11-02 on a production build (`next build` +
// `next start`, unknown valid uuid): the wire status is still 200 for
// Googlebot, bingbot, GPTBot and a Chrome UA alike. htmlLimitedBots does make
// the crawlers block on metadata (the title lands in <head>), but the status
// is already fixed: Cache Components needs the Suspense boundary of
// src/app/loading.tsx above any runtime `params` read, so the shell flushes a
// 200 before this DB-backed check resolves and notFound() only swaps the
// streamed content. A malformed id is the only wire 404, from the shape gate
// in src/middleware.ts. A real 404 for an unknown valid id needs a check
// before streaming (middleware), which that file's header explains and
// declines for clusters.
export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  let detail: Awaited<ReturnType<typeof getClusterDetailOrThrow>>;
  try {
    detail = await getClusterDetailOrThrow(id);
  } catch {
    return {
      title: "Haber şu anda yüklenemiyor",
      robots: { index: false, follow: true },
      alternates: { canonical: null },
    };
  }

  if (!detail) notFound();

  if (detail.cluster.merged_into) {
    // Migration 099: merged clusters are archived; keep them out of the index
    // and point search engines at the survivor.
    return {
      title: "Haber taşındı",
      robots: { index: false, follow: true },
      alternates: { canonical: `/cluster/${detail.cluster.merged_into}` },
    };
  }

  const { cluster, members, wire } = detail;
  // No letter or digit in the stored title (`isContentlessTitle`): show the
  // neutral label and keep the page out of the index (robots below).
  const hasHeadline = !isContentlessTitle(cluster.title_tr);
  const headline = hasHeadline ? cluster.title_tr : NO_HEADLINE_FALLBACK;
  // Postgres resolves a uuid case-insensitively, so a pasted/uppercased link
  // renders this page. Every self-referencing URL below uses the one
  // lowercase form (the form every internal link and the sitemap emit), so
  // crawlers and unfurlers never see two canonical URLs for one story. The
  // canonical fix only: no middleware redirect.
  const canonicalId = id.toLowerCase();
  // Attributed summary (or null when blank / a bare wire copy) — see
  // summary-attribution.ts. describeForMeta keeps the result under the
  // ~160 char SERP cap on its own. `agreeWithTitle` (h31-reader-3 v2) is the
  // same on both summaryAttribution calls of this file (here and in the page
  // body, whose result the JSON-LD reuses), so the meta description, the JSON-LD
  // and the page never disagree about whose words the summary is. `members` goes
  // in whole: every member keeps its `article.title`, which the title-agreement
  // choice reads to keep a description that only repeats its own headline out of
  // the Özet (SummaryMember.article.title, h95-summaries-1); the body call below
  // passes the same list.
  const description = describeForMeta({
    count: wire.effectiveArticleCount,
    attribution: summaryAttribution({
      summary: cluster.summary_tr,
      members,
      wire,
      agreeWithTitle: hasHeadline ? cluster.title_tr : undefined,
    }),
    // Never build the "tek haber: <title>" fallback sentence from junk.
    title: hasHeadline ? cluster.title_tr : undefined,
  });

  return {
    // Plain title — the root layout's `title.template = "%s — Tayf"` adds
    // the suffix automatically. Returning `${title} — Tayf` here would
    // double-suffix to `title — Tayf — Tayf` (caught by gstack site audit).
    title: headline,
    description,
    // Without an explicit canonical, Next's metadata inheritance propagates
    // the root layout's `canonical: "/"` here — telling crawlers every
    // cluster page is a duplicate of the homepage and deindexing the long
    // tail. Same pattern as source/[slug].
    // `types` emits the oEmbed discovery <link> so WordPress, Iframely and
    // Embedly can turn a pasted story URL into the /embed/ widget.
    alternates: {
      canonical: `/cluster/${canonicalId}`,
      types: {
        "application/json+oembed": [
          { url: oembedDiscoveryHref(siteUrl(), canonicalId), title: headline },
        ],
      },
    },
    // seo-3: an archived cluster (migration 037's retention cron) still
    // serves a real 200 — old shared links must keep working — but it must
    // stop competing for crawl budget / index slots against live clusters.
    // Omitted entirely (undefined) for non-archived clusters so metadata
    // inheritance from the root layout's default robots stays in effect.
    // A headline-less cluster is kept out of the index the same way, and so is
    // one whose served title is a question or an SEO explainer (h34-reader-2),
    // and so is a single-article cluster (h31-seo-1): it is one outlet's headline and
    // lead sentence, a thin duplicate of that outlet's own article, and ~71%
    // of new clusters. The sitemaps, the news sitemap and IndexNow require
    // article_count >= 2 and skip a question / explainer title through the same
    // hasIndexableTitle, so the page agrees with them on both counts. The
    // canonical, og:url and JSON-LD stay as they are: shared links still work,
    // and the page indexes itself the moment a second outlet joins.
    ...(!isIndexableCluster(cluster, hasHeadline)
      ? { robots: { index: false, follow: true } }
      : {}),
    openGraph: {
      title: headline,
      description,
      type: "article",
      url: `/cluster/${canonicalId}`,
      // Deliberately no `images` key here (not even `[]`): Next's
      // `mergeStaticMetadata` (next/dist/lib/metadata/resolve-metadata.js)
      // only wires in the generated `opengraph-image.tsx` card when this
      // object has NO OWN `images` property. Setting one — as this used
      // to, pointing at the raw first article photo — silently disabled
      // the generated Medya DNA card. See the comment atop
      // `opengraph-image.tsx` for the full rule.
      locale: "tr_TR",
      siteName: "Tayf",
    },
    twitter: {
      card: "summary_large_image",
      title: headline,
      description,
      // Same reasoning as `openGraph.images` above — omitted so the
      // `twitter-image.tsx` file convention wires in automatically.
    },
  };
}

export default async function ClusterDetailPage({ params }: PageProps) {
  const { id } = await params;

  // Null = genuinely missing -> notFound(). A read failure REJECTS and
  // propagates to ./error.tsx (noindex) rather than masquerading as a 404.
  const detail = await getClusterDetailOrThrow(id);
  if (!detail) notFound();
  // Streamed fallback for merged clusters when the middleware gate was cold or
  // the merge is older than its 1000-row window (migration 099).
  if (detail.cluster.merged_into) permanentRedirect(`/cluster/${detail.cluster.merged_into}`);

  const { cluster, members, allSources, wire, blindspotSuppressed } = detail;
  // Same fallback as generateMetadata: the h1 and the JSON-LD headline never
  // show an entity-only title as text.
  const hasHeadline = !isContentlessTitle(cluster.title_tr);
  const headline = hasHeadline ? cluster.title_tr : NO_HEADLINE_FALLBACK;

  // WCAG 3.1.2 (h23-a11y-1): 'en' when EVERY member (voting or not) is an
  // English outlet. The h1 is skipped for the neutral LLM rewrite (title_method
  // 'llm' is Turkish) and for the Turkish "Haber" fallback. The original-title
  // disclosure is the seed member's own title, so it takes the same member rule
  // as the h1 (react-h59-1): `textLang`, else `memberHeadlineLang` over the
  // members (`originalLang`). A mixed cluster's seed can be an English member's
  // title while the h1 is the Turkish one.
  // h59-english-2: a mixed cluster cannot claim the headline wholesale, but an
  // extractive headline IS one member's title (749b0eea showed Daily Sabah's
  // 'NATO chief visits Türkiye ahead of key summit' beside A Haber's Turkish
  // one), so it takes the home card's rule: 'en' only when an English member's
  // title is the headline and no Turkish member carries it too.
  const textLang = clusterTextLang(members.map((m) => m.source));
  const memberLangs = members.map((m) => ({
    title: m.article.title,
    lang: sourceLang(m.source),
  }));
  const headlineLang =
    cluster.title_method === "llm" || !hasHeadline
      ? undefined
      : (textLang ?? memberHeadlineLang(cluster.title_tr, memberLangs));
  const originalLang = cluster.title_original
    ? (textLang ?? memberHeadlineLang(cluster.title_original, memberLangs))
    : undefined;
  // h59-english-1: every member is an English-language outlet, i.e. `textLang`
  // is 'en'. Such a story formed among English articles only, so no Bağımsız or
  // Muhalefet outlet could have matched it. Computed once here and threaded
  // into the timeline, the read-across slot (which prints the one English-only
  // note) and the framing block (whose empty columns say "not compared"), all
  // instead of a zone-absence claim, and into the JSON-LD language. Voting or
  // not: the same members `textLang` looks at.
  const languageIsolated = isLanguageIsolatedCluster(members.map((m) => m.source));

  // Toplayıcı / niş kaynaklar are cluster members but never vote — split
  // them out once here so every voting-sensitive computation below reads
  // from `votingMembers` while member-count/listing computations keep
  // reading from the full `members` list.
  const { voting: votingMembers, nonVoting: nonVotingMembers } =
    partitionByVote(members);

  // browser-qa-11: zone-keyed count of non-voting (toplayıcı / niş) members,
  // deduped by source.slug (a single niche outlet can appear as multiple
  // articles/members) — passed to <ReadAcrossSpectrum> so a genuine
  // blindspot's empty-state copy can name who actually wrote from the
  // silent side instead of implying total silence.
  const dedupedNonVoting = Array.from(
    new Map(nonVotingMembers.map((m) => [m.source.slug, m])).values(),
  );
  const nonVotingZoneCounts: Record<MediaDnaZone, number> = {
    iktidar: 0,
    bagimsiz: 0,
    muhalefet: 0,
  };
  for (const m of dedupedNonVoting) {
    const z = zoneOf(m.source.bias);
    nonVotingZoneCounts[z] += 1;
  }
  // h58-postship-2: the same fact as a set, for the framing comparison. An empty
  // column there says "bu tarafta sessizlik" only when no toplayıcı / niş source
  // of that zone wrote either; otherwise it says what the spectrum shows. Words
  // only: nothing here is a vote or a count.
  const nonVotingZones = new Set<MediaDnaZone>(
    nonVotingMembers.map((m) => zoneOf(m.source.bias)),
  );
  // h106-blindspotbadges-1: the empty columns Tayf's own Jev recall stage matched
  // with this story's event (a similar story sits in another cluster). The detail
  // fetcher computed them on the very voting members listed here; a detail cached
  // before the field existed has none (`?? []`). Words only, like the set above:
  // an empty column then says "benzer haber başka kümede olabilir" instead of
  // claiming silence, and nothing is counted from it.
  const recallMatchedZones = new Set<MediaDnaZone>(detail.recallMatchedZones ?? []);

  // Derive inputs for the cross-spectrum surprise detector from only the
  // VOTING member list. `detectCrossSpectrum` also filters internally via
  // `isVotingSource`, so passing the full list would be safe too — this
  // just keeps the page's own intent explicit. `memberSources` may
  // contain the same source more than once (a single outlet can publish
  // multiple articles in a cluster); that's fine — `detectCrossSpectrum`
  // treats each row as a vote.
  const memberSources = votingMembers.map((m) => m.source);
  // Uses the default threshold — SURPRISE.dominantShare in the bias-zone
  // contract (supabase/functions/_shared/cluster/blindspot.ts).
  const surpriseResult = detectCrossSpectrum(memberSources);
  const surpriseLines = summarizeSurprises(
    surpriseResult,
    cluster.title_tr,
    2,
  );

  // Set of slugs that actually appear in this cluster — used by MediaDna
  // to highlight participating outlets and dim the rest of the 144-source
  // directory. Built over ALL members (not just voting ones) so aggregator
  // / niche chips still light up in Medya DNA — they're just dimmed there,
  // never counted in the vote.
  const highlightSlugs = new Set(members.map((m) => m.source.slug));

  // A1-CHIPWIRE: compact factuality + ownership lineage strip. One entry per
  // unique participating source (ALL members, voting or not — factuality/
  // ownership are properties of the source, unrelated to whether its kind
  // votes in the spectrum), filtered to those we've hand-tagged in
  // `SOURCE_METADATA` — `<SourceChips>` no-ops for unknown slugs, so filtering
  // here just prevents empty `<li>` wrappers from bloating the markup.
  const uniqueMemberSources = uniqueSources(members);
  const uniqueRatedSources = uniqueMemberSources.filter(
    (s) => getSourceMetadata(s.slug) !== null,
  );

  // Hero image — pass the FULL list of candidate image URLs so the
  // client component can fall back in sequence when a CDN returns 404.
  // Previously we picked only the first non-null image and hit the
  // placeholder any time that specific URL happened to be broken, even
  // if 14 other members of the cluster had working images.
  //
  // BL-13 rights gate: drop any member whose source has asked Tayf not to
  // reuse its photos (image_allowed: false) before candidates are built,
  // so a blocked outlet's image can never become the hero (or a
  // fallback) — the next eligible member's image is used instead, or no
  // hero image at all when none remain. `undefined` (fixtures/rows
  // predating migration 047, or a source not covered by the supplemental
  // sources query error path) is treated as allowed. Delegated to
  // cluster-detail-query.ts's unit-tested `imageEligibleMembers` (single
  // source of truth for the gate) rather than re-implemented here —
  // cluster-page.test.tsx's module mock preserves it via `importOriginal`.
  const imageEligible = imageEligibleMembers(members);
  // h99-clientjs-1: only the first HERO_CANDIDATE_CAP USABLE urls cross into
  // the client component (every one is serialised into the RSC payload; a
  // 44-member cluster used to send 44 plus a credit for each). The same
  // normalise + allowlist + dedupe ClusterCardImage applies runs here first,
  // so the hero and the fallback order within the cap do not change.
  const heroCandidates = pickHeroCandidates(
    imageEligible.map((m) => m.article.image_url),
  );
  const heroSrc = heroCandidates[0] ?? null;
  // The logo tier names the outlet that owns the photo the hero starts with:
  // the first member whose normalised image is `heroSrc`. With no usable
  // candidate it is the first member that has any image_url, as before.
  const heroMember =
    (heroSrc === null
      ? undefined
      : imageEligible.find(
          (m) => normalizeImageUrl(m.article.image_url) === heroSrc,
        )) ??
    imageEligible.find((m) => !!m.article.image_url) ??
    null;

  // Per-candidate-URL photo credit (R1-F1 fix). Keyed by the normalised
  // image URL (the spelling ClusterCardImage looks credits up by) rather than
  // tied to `heroMember`/`heroSrc` alone, so the credit
  // `ClusterCardImage` renders always names the outlet whose photo is
  // actually on screen — even after its client-side fallback chain
  // advances past the first candidate when a CDN 404s. First member to
  // claim a URL wins, matching the `Set`-based dedup order
  // `ClusterCardImage` applies to (src, ...srcs) internally. Built from
  // `imageEligible` (not `members`) so a blocked outlet's photo can never
  // be credited even indirectly, and only for the URLs in `heroCandidates`
  // (h99-clientjs-1): a photo that is not sent to the client is never shown,
  // so its credit would be dead payload.
  const heroCreditUrls = new Set(heroCandidates);
  const heroCredits: Record<string, { href: string; name: string }> = {};
  for (const m of imageEligible) {
    const url = normalizeImageUrl(m.article.image_url);
    if (url === null || !heroCreditUrls.has(url)) continue;
    heroCredits[url] ??= { href: m.article.url, name: m.source.name };
  }

  // bias_distribution is stored as jsonb in Postgres but the query layer
  // (`cluster-detail-query.ts`) already normalizes it to a proper
  // `BiasDistribution` at the boundary, so it's safe to use directly here.
  const biasDistribution = cluster.bias_distribution;
  // Sum of every bias key = how many votes the STORED distribution carries.
  // Zero means either nobody classified wrote, or (pre-034 rows) the
  // distribution simply hasn't been touched yet.
  const distributionTotal = Object.values(biasDistribution).reduce(
    (a, b) => a + b,
    0,
  );
  // Denge puanı: same 3-zone basis as the spectrum bar above it. `null` below
  // the classified-source floor (rendered as the "Az kaynak" chip).
  const balance = balanceFromDistribution(biasDistribution);
  // The stored jsonb is voting-only just for rows the post-034 consumer wrote
  // or the 48h backfill touched; older clusters still carry all-member counts
  // (one vote per article, every kind). `members` is deduped per source while
  // votes are per article, so equality here is a conservative "the bar agrees
  // with the live partition" check: a pre-034 row with >=1 non-voting member
  // can never satisfy it, and a post-034 row with duplicate-source articles
  // merely falls back to the neutral caption below.
  const distributionIsVotingOnly = distributionTotal === votingMembers.length;
  const spectrumCaption: string | null =
    distributionTotal === 0
      ? votingMembers.length === 0
        ? "Bu kümede sınıflandırılan kaynak yok — yalnızca toplayıcı / niş kaynaklar yazdı"
        : null
      : distributionIsVotingOnly
        ? `Spektrum ${distributionTotal} sınıflandırılmış kaynaktan oluşturuldu${
            nonVotingMembers.length > 0
              ? ` · ${nonVotingMembers.length} toplayıcı / niş kaynak sayılmadı`
              : ""
          }`
        : `Spektrum ${distributionTotal} kaynaktan oluşturuldu`;

  // Share loop: argue the bias story in the share text itself, before the
  // click — computed server-side so it's identical for every visitor
  // (no client-side zone math duplicated in `ShareButton`).
  const shareText = buildShareText({
    articleCount: wire.effectiveArticleCount,
    distribution: biasDistribution,
    isBlindspot: cluster.is_blindspot,
    blindspotSide: cluster.blindspot_side,
    wire: {
      isWireRedistribution: wire.isWireRedistribution,
      memberCount: wire.memberCount,
    },
    // h57-outbound-1: one entry per source, so "sadece X yazdı" becomes
    // "spektrumda sadece X" when a toplayıcı / niş source from another zone
    // also carried the story (the very sources listed under "Toplayıcı / niş
    // kaynaklar" below).
    sources: uniqueMemberSources,
  });

  // Attributed cluster summary — see summary-attribution.ts. Null hides the
  // summary block entirely (blank text, or a bare wire-copy nobody wrote). The
  // seed's description is kept while it agrees with the headline above it and
  // swapped for the member that agrees best when it does not (h31-reader-3 v2).
  const summary = summaryAttribution({
    summary: cluster.summary_tr,
    members,
    wire,
    agreeWithTitle: hasHeadline ? cluster.title_tr : undefined,
  });
  // h54-editorial-3: every member's article URL is an opinion path (/yazarlar/...):
  // the cluster is columns and nothing else, and the header says so beside the
  // source count. Derived from the URLs at read time; nothing is stored.
  const allOpinion = isAllOpinion(members);

  // T11 (migration 068) — Çerçeveleme makbuzu. The flag is checked FIRST,
  // synchronously, so a flag-off deploy (the default — see pack.md's ops
  // step 11) adds exactly zero Supabase queries to this, the hottest public
  // page. The receipt itself is counts-only and never names an outlet —
  // see FramingReceiptCard's own doc comment.
  const receipt = isFramingReceiptPublic()
    ? await getCachedClusterFramingReceipt(id)
    : null;

  // "Kim önce yazdı?" — per-story first-mover timeline. Only voting members
  // can be first or make a zone "join" (an aggregator reposting first must
  // not); non-voting members are just plotted as hollow rings.
  const storyTimeline = await loadStoryTimeline(
    id,
    votingMembers,
    nonVotingMembers,
    languageIsolated,
  );
  // The story-thread pill and the fact-check box are optional widgets: each is
  // read by its own async slot (ClusterThreadSlot / ClusterFactCheckSlot) inside
  // its own <Suspense fallback={null}>, so a slow or stalled read can delay or
  // hide that one widget, never the article (hunt-27 resilience-1; both used to
  // be awaited here before the body).

  // Schema.org NewsArticle structured data. Lets Google surface the
  // cluster in news-rich results and gives social previews a clean
  // headline/date/image triple. Authors are listed as the source
  // outlets (capped at 5) since a cluster is the union of multiple
  // independent stories — there's no single byline.
  // Header age: the bare time-ago is the story's age (first_published). A
  // separate "Güncellendi" cue appears only when a member published
  // meaningfully later — `updated_at` alone moves on every recompute and used
  // to make a 2-hour-old story read "30 dakika önce". The cue itself is pure
  // over the row values; JSON-LD dates below are unchanged.
  const updateCue = clusterUpdateCue(
    cluster.first_published,
    cluster.updated_at,
    members.map((m) => m.article.published_at),
  );

  // h47-time-1: the one clock read of this file (currentTimeMs() is the repo's
  // Date.now() wrapper; react-hooks/purity forbids the direct call), and the
  // instant this page was rendered. The service worker keeps story pages for
  // up to 14 days and serves them offline, on a timeout or on a 5xx, so a saved
  // copy would show ages frozen at render time. Every age below is a
  // <RelativeTime> against this stamp (its server text is unchanged; after
  // mount it re-bases to the reader's clock) and <StaleCopyNotice> compares it
  // with the instant the document loaded to say "this is an old copy" past 30
  // minutes.
  // Taken here, in the per-request body after the data awaits above, and
  // nowhere else: in a static PPR shell or a "use cache" body it would be the
  // build or the cache fill, and every reader would be told a fresh page is an
  // old copy (tests/guards/cluster-relative-time.test.ts). It never reaches the
  // JSON-LD, the metadata or a cache key.
  const renderNowMs = currentTimeMs();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline,
    // h59-english-1: 'en' only for an all-English cluster whose <h1> is the
    // English member headline; every other cluster is the site's 'tr-TR'.
    inLanguage: newsArticleInLanguage({ languageIsolated, headlineLang }),
    datePublished: cluster.first_published,
    dateModified: cluster.updated_at,
    description: describeForMeta({
      count: wire.effectiveArticleCount,
      attribution: summary,
      title: hasHeadline ? cluster.title_tr : undefined,
    }),
    // Always the generated Medya DNA card from opengraph-image.tsx (already
    // the live og:image for this route) — never the outlet's raw CDN photo.
    // Pointing schema.org `image` at that photo advertised someone else's
    // photograph as this page's primary image (deck TOP-4 / SEC-05 sibling
    // finding). siteUrl() is required because schema.org `image` must be an
    // absolute URL.
    image: [`${siteUrl()}/cluster/${id.toLowerCase()}/opengraph-image`],
    // seo-4/seo-5: Tayf is the byline and the publisher — a cluster is the
    // union of multiple independent outlets' coverage, so no single outlet
    // can honestly be named "the author". The outlets themselves are
    // credited via `isBasedOn` below instead of masquerading as bylines.
    publisher: buildTayfOrganization(),
    author: [{ "@type": "Organization", name: "Tayf", url: siteUrl() }],
    // seo-7: up to 5 member article URLs this cluster is based on. Only
    // http(s) URLs qualify — a falsy or malformed `article.url` is dropped
    // rather than publishing a broken schema.org reference — and the key is
    // omitted entirely (not `[]`) when nothing qualifies.
    ...(() => {
      const isBasedOn = members
        .slice(0, 5)
        .map((m) => m.article.url)
        .filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
      return isBasedOn.length > 0 ? { isBasedOn } : {};
    })(),
  };

  return (
    <>
      {/* This is finding SEC-05: values here are NOT guaranteed script-safe
          just because they "come from our own DB". `title_tr` is only
          protected by an upstream `stripTags()` pass over the raw RSS feed,
          and `title_tr_neutral` (the LLM-rewritten headline — see
          cluster-detail-query.ts) has no such guard at all, so a "</script"
          substring can reach here. The escape therefore happens at this
          render boundary instead, via `serializeJsonLd` (src/lib/seo/
          json-ld.ts), which turns every "<" into the JSON-safe "\u003c"
          so it can never terminate the element early.
          dangerouslySetInnerHTML is still the only way to embed JSON-LD
          without React re-escaping the (already-safe) angle brackets and
          breaking the schema. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />
      <div className="container mx-auto px-5 sm:px-4 py-8 max-w-5xl space-y-8">
      {/* Back nav rendered inline (instead of importing ClusterBackNav) so
          U8-MOBILE could give it a 44px tap area + touch-manipulation hint
          without editing files outside the audited set. */}
      <Link
        href="/"
        className="inline-flex min-h-[44px] touch-manipulation items-center gap-1.5 -ml-2 px-2 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={2.5} />
        <span>Haberler</span>
      </Link>

      {/* h47-time-1: an empty, screen-reader-only live region on the server and
          on the first client render; after mount it says so when this document
          is a copy the service worker kept for more than 30 minutes
          (src/components/pwa/stale-copy-notice.tsx). */}
      <StaleCopyNotice renderedAtMs={renderNowMs} />

      {/* Hero — the cluster's "real" hero (R4 audit #4). Image on the left
          (or banner below md), title + meta + spectrum on the right. The
          image reuses ClusterCardImage at a larger fixed size; the meta row
          repeats the home-card pattern (time-ago • source count • blindspot
          pill) so context carries over from the list.
          h73-breakpoints-1: the row stays stacked below md (768 px) and goes
          side by side from md, with a 288 px photo column (md:w-72) that grows
          to 384 px from lg (lg:w-96). From sm it used to be 384 px, which left
          the headline a 174-234 px column at 640-767 px. The photo box stays
          4:3 like the width=768/height=576 props (288x216 at md via md:h-54,
          384x288 from lg via lg:h-72), so a 4:3 photo is painted at exactly
          the column width the `sizes` slot declares; a square 288x288 md box
          would paint it 384 px wide and the 288 px slot would upscale it.
          CLUSTER_HERO_SIZES (cluster-card.tsx) and the loading skeleton follow
          the same switch. */}
      <section className="rounded-xl border border-border/60 bg-card/40 overflow-hidden">
        <div className="flex flex-col md:flex-row">
          <div className="w-full md:w-72 md:shrink-0 lg:w-96">
            {/* Credit line (deck TOP-3 / quick win): rendered by
                ClusterCardImage itself, keyed off the same `idx`/
                `candidates[idx]` state that drives the visible image (see
                R1-F1) — so it always names the outlet whose photo is
                actually on screen, including after the client-side
                fallback chain advances past `heroSrc`. Only appears for
                the tier-1 real-photo branch; never for the logo or
                placeholder tiers.

                The photo is decorative for assistive tech (alt=""): the
                headline is the adjacent <h1>, so naming the photo with it
                would make a screen reader read the same text twice (as
                ClusterCard's thumbnails do; h67-landmarks-2). The credit line
                above still identifies the photo. `lang={headlineLang}` is kept
                so the hero gets the right language if it is ever named again
                ('en' for an all-English cluster or a mixed one whose headline
                is an English member's own title (h59-english-2), nothing for a
                Turkish headline); while alt="" it has no effect for assistive
                tech, since it only tags the aria-hidden logo caption. */}
            <ClusterCardImage
              src={heroSrc}
              srcs={heroCandidates.slice(1)}
              logoSrc={
                heroMember?.source.logo_url ??
                members[0]?.source.logo_url ??
                null
              }
              logoAlt={
                heroMember?.source.name ?? members[0]?.source.name ?? "Kaynak"
              }
              credits={heroCredits}
              alt=""
              lang={headlineLang}
              width={768}
              height={576}
              sizes={CLUSTER_HERO_SIZES}
              quality={CLUSTER_HERO_QUALITY}
              minIntrinsicWidth={320}
              priority
              fetchPriority="high"
              className="h-44 sm:h-60 md:h-54 lg:h-72 w-full object-cover"
            />
          </div>

          <div className="flex-1 min-w-0 p-5 sm:p-6 space-y-4">
            <div className="space-y-2">
              {/* A4 polish: promote "Kör nokta" to a full ribbon ABOVE the
                  title (mirrors U1's home-card pattern) so the brand feature
                  reads as the dominant affordance instead of meta filler.
                  h72-newreader-1: the ribbon links the definition (the rule
                  these counts come from lives at /metodoloji#kor-nokta); it
                  is not nested in another link, and keeps its amber pill. */}
              {cluster.is_blindspot && (
                <Link
                  href="/metodoloji#kor-nokta"
                  className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-800 dark:text-amber-400 hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <AlertTriangle
                    className="h-3.5 w-3.5"
                    strokeWidth={2.5}
                    aria-hidden="true"
                  />
                  Kör nokta · Bu ne demek?
                </Link>
              )}
              <h1
                lang={headlineLang}
                className="font-serif text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight leading-[1.05] text-foreground"
              >
                {headline}
              </h1>
              {cluster.title_original && (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <Link
                    href="/metodoloji#basliklar"
                    className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                  >
                    {cluster.title_method === "extractive"
                      ? "Kaynak başlıklarından seçildi"
                      : "AI ile tarafsızlaştırıldı"}
                  </Link>
                  <details className="inline">
                    <summary className="inline cursor-pointer list-none underline decoration-dotted underline-offset-2 hover:text-foreground">
                      Özgün başlık
                    </summary>
                    <span lang={originalLang} className="block mt-1">
                      {cluster.title_original}
                    </span>
                  </details>
                </div>
              )}
              {/* Mobile tap targets (h16-mobile-2): one wrapper, two
                  display:contents groups. From sm up `contents` makes the
                  children flex items of this row, exactly the old single
                  row; below sm each group is its own full-width row, so the
                  44 px actions never share a line with the meta text. The
                  bullets live inside their span (mr-2 = the old gap-2), so
                  no • can be a lone flex child that wraps to a line end.
                  h32-a11y-1 (WCAG 1.4.10 reflow at 320 px): the actions row
                  carries min-w-0 max-w-full and the share channel group may
                  wrap, so no chip or link is clipped by the card's
                  overflow-hidden (tests/guards/cluster-actions-reflow.test.ts).
                  h32-a11y-2: the "bağımsız başlık" link has its • in a span of
                  its own, outside the link. */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="contents max-sm:flex max-sm:basis-full max-sm:flex-wrap max-sm:items-center max-sm:gap-2 text-[12px] font-medium text-muted-foreground">
                  <span>
                    <RelativeTime iso={cluster.first_published} nowMs={renderNowMs} />
                  </span>
                  {updateCue && (
                    <span>
                      <span aria-hidden="true" className="mr-2">•</span>
                      Güncellendi: <RelativeTime iso={updateCue} nowMs={renderNowMs} />
                    </span>
                  )}
                  <span>
                    <span aria-hidden="true" className="mr-2">•</span>
                    {wire.effectiveArticleCount} kaynak
                  </span>
                  {/* h54-editorial-3: every member is an opinion column (URL
                      path /yazarlar/, /kose-yazilari/, ...). Neutral chip, not
                      amber (Kör nokta) and not violet (wire redistribution). */}
                  {allOpinion && (
                    <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 font-medium text-foreground">
                      Köşe yazısı
                    </span>
                  )}
                  {/* Honest source count v2 (reader-data): when several of
                      the shown sources used the exact same headline (folded
                      for case/punctuation/quotes), say so without calling it
                      "kopya" — a short factual headline can coincide
                      naturally, so the "N kaynak" number itself is untouched. */}
                  {wire.memberCount >= 3 &&
                    typeof wire.independentHeadlineCount === "number" &&
                    wire.independentHeadlineCount < wire.effectiveArticleCount && (
                      <span>
                        <span aria-hidden="true" className="mr-2">•</span>
                        <Link
                          href="/metodoloji#tek-kaynak"
                          title="Aynı başlığı kullanan kaynaklar tek başlık sayılır."
                          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                        >
                          {wire.independentHeadlineCount} bağımsız başlık
                        </Link>
                      </span>
                    )}
                  {/* wire-redistribution: violet, not amber — amber above is
                      reserved for the Kör nokta ribbon so the two claims
                      (single-source dispatch vs. one-sided coverage) don't
                      collapse into one visual cue. */}
                  {wire.isWireRedistribution && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 border border-violet-500/30 px-2 py-0.5 text-violet-800 dark:text-violet-400 font-medium"
                      title={wireBadgeTitle(wire.effectiveArticleCount)}
                    >
                      <Copy className="h-3 w-3" />
                      {wireBadgeLabel(wire.memberCount, wire.effectiveArticleCount)}
                    </span>
                  )}
                </div>
                <div
                  data-row="actions"
                  className="contents max-sm:flex max-sm:basis-full max-sm:flex-wrap max-sm:items-center max-sm:gap-2 min-w-0 max-w-full font-medium"
                >
                  {/* Same fallback as the h1: the share sheet gets "Haber", and
                      the bookmark gets no title (null = the generic "Kaydet"
                      label, and /saved never stores a made-up headline). */}
                  <ShareButton
                    clusterId={id}
                    title={headline}
                    text={shareText}
                    cardHref={storyCardHref(id, cluster.title_tr, hasStoryCardCoverage(members))}
                  />
                  <BookmarkButton
                    clusterId={id}
                    storyTitle={hasHeadline ? cluster.title_tr : null}
                  />
                  <CompareButton clusterId={id} />
                  <Link
                    href={`/metodoloji?cluster=${id}#duzeltme`}
                    rel="nofollow"
                    prefetch={false}
                    className="inline-flex items-center max-sm:min-h-11 text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                  >
                    Düzeltme talebi
                  </Link>
                </div>
              </div>
            </div>

            <div className="spectrum-glow">
              <BiasSpectrum distribution={biasDistribution} />
              {/* Spectrum caption: how many classified (voting) sources the
                  bar above was built from, plus how many toplayıcı / niş
                  members were left out of it. `BiasSpectrum` itself returns
                  null at total 0, so this caption is what carries the
                  "nobody classified covered this" message in that case.
                  A stored distribution that does not match the live voting
                  partition (a pre-034 row the 48h backfill hasn't reached
                  yet) gets the neutral "Spektrum N kaynaktan oluşturuldu"
                  caption instead, with no exclusion claim. */}
              {spectrumCaption && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">{spectrumCaption}</p>
              )}
              {/* Denge puanı: how evenly the voting sources above spread over
                  the three zones (0-100). Only when the bar exists; the chip
                  itself says "Az kaynak" below the source floor. Explained at
                  /metodoloji#denge-puani. */}
              {distributionTotal > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <BalanceChip balance={balance} variant="full" />
                  <Link
                    href="/metodoloji#denge-puani"
                    className="inline-flex items-center max-sm:min-h-11 underline decoration-dotted underline-offset-2 hover:text-foreground"
                  >
                    Denge puanı nedir?
                  </Link>
                </div>
              )}
            </div>

            {storyTimeline && <StoryTimeline timeline={storyTimeline} />}

            <Suspense fallback={null}>
              <ClusterThreadSlot id={id} />
            </Suspense>

            <OwnershipLine members={members} />

            {/* "Karşı tarafı oku" — a one-tap next action for a visitor
                landing from a shared link, placed directly under the
                spectrum and above the summary so it clears the fold on a
                667px-tall viewport (the mobile hero image above is capped
                at h-44 for the same reason). Only voting members are
                candidates — an aggregator/niche member labelled center
                must never become the "karşı taraf". */}
            <ReadAcrossSpectrum
              members={votingMembers}
              nowMs={renderNowMs}
              isBlindspot={cluster.is_blindspot}
              feedDegraded={blindspotSuppressed}
              nonVotingZoneCounts={nonVotingZoneCounts}
              languageIsolated={languageIsolated}
            />

            {/* Summary attribution (idea #7): clusters.summary_tr is one
                outlet's raw RSS description, not Tayf's own words — it must
                carry a byline. `summary` is null for a blank summary or a
                bare wire-copy nobody actually wrote (summary-attribution.ts). */}
            {summary && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <span>{summaryLabel(summary)}</span>
                  {summary.source && (
                    <BiasBadge bias={summary.source.bias} size="sm" />
                  )}
                </div>
                <p
                  lang={summary.source ? sourceLang({ name: summary.source.name }) : undefined}
                  className="text-sm sm:text-base text-muted-foreground leading-relaxed"
                >
                  {summary.text}
                </p>
              </div>
            )}
            <Suspense fallback={null}>
              <ClusterFactCheckSlot id={id} />
            </Suspense>

            {/* A1-CHIPWIRE: factuality + ownership lineage per participating
                source. Renders nothing when no member source has been tagged,
                so stories covered only by untagged outlets won't get an empty
                wrapper. Kept inside the hero section (below the summary) so
                the chips read as part of the cluster's "at-a-glance" header
                instead of colliding with the framing comparison below.
                h49-browser-1: shows the first few rows and folds the rest
                behind a native <details> (see <SourceKunye>). */}
            <SourceKunye sources={uniqueRatedSources} />
          </div>
        </div>
      </section>

      {/* Gradient rule between hero and subsequent sections */}
      <div className="h-px bg-gradient-to-r from-transparent via-brand/20 to-transparent my-6" />

      {/* Cross-spectrum surprise caption — moved above the chips per R4 #8.
          The caption is editorially valuable and was previously buried below
          the 144-source Medya DNA grid. Only renders when there's something
          interesting to say (handled inside the component too). */}
      {surpriseLines.length > 0 && (
        <>
          <CrossSpectrumCaption lines={surpriseLines} />
          <div className="h-px bg-gradient-to-r from-transparent via-brand/20 to-transparent my-6" />
        </>
      )}

      {/* "Aynı Haber, Farklı Dünyalar" — per-zone framing comparison. The
          outlets' own headlines side by side; replaces the old chip-only
          ClusterStance grid. Voting members only — an aggregator/niche
          member labelled center must never fill the Bağımsız column.
          An empty column says "spektruma sayılan kaynaklardan haber yok"
          instead of "bu tarafta sessizlik" when a toplayıcı / niş source of
          that zone covered the story (nonVotingZones, h58-postship-2); they
          stay out of the columns and the counts. A column Jev's recall stage
          matched with this event in another cluster (recallMatchedZones,
          h106-blindspotbadges-1) reads "bu kümede yok · benzer haber başka
          kümede olabilir" rather than "sessizlik". For an all-English cluster
          (languageIsolated, h59-english-1) an empty column reads "Türkçe
          kaynaklarla karşılaştırılmadı" and the read-across slot carries the one note.
          Omitted entirely when no voting member exists — the spectrum
          caption already says only toplayıcı / niş sources wrote, and an
          empty three-column card would read as broken. */}
      {votingMembers.length > 0 && (
        <div className="rounded-xl border border-border/60 bg-card/40 p-4 sm:p-5 hover-lift animate-fade-up stagger-1">
          <FramingComparison
            members={votingMembers}
            nowMs={renderNowMs}
            nonVotingZones={nonVotingZones}
            languageIsolated={languageIsolated}
            recallMatchedZones={recallMatchedZones}
          />
        </div>
      )}

      {/* T11 (migration 068) — Çerçeveleme makbuzu. shouldShowPublicFramingReceipt
          re-checks the flag AND the scored>=3 floor here too (belt and
          suspenders with the fetch guard above); the card itself renders
          counts only, never an outlet name. */}
      {shouldShowPublicFramingReceipt(receipt) && receipt && (
        <FramingReceiptCard receipt={receipt} />
      )}

      {/* Toplayıcı / niş kaynaklar — cluster members whose kind never votes
          in the spectrum above, kept visible but visually separated (dashed
          border, tinted background) so the distinction is legible without
          hiding them. Not dimmed with opacity: that dropped the muted text
          below WCAG 1.4.3 (tests/guards/text-contrast-tokens.test.ts). */}
      {nonVotingMembers.length > 0 && (
        <section
          aria-label="Toplayıcı / niş kaynaklar"
          className="rounded-xl border border-dashed border-border/50 bg-card/20 p-4 animate-fade-up stagger-2"
        >
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-serif text-sm font-semibold">
              Toplayıcı / niş kaynaklar
            </h2>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {nonVotingMembers.length} kaynak · spektruma sayılmaz
            </span>
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5">
            {nonVotingMembers.map((m) => (
              <li key={m.article.id}>
                <a
                  href={m.article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={m.article.title}
                  className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground underline decoration-dotted underline-offset-2"
                >
                  <span
                    lang={sourceLang({ slug: m.source.slug, name: m.source.name })}
                    className="font-mono text-[10px] uppercase tracking-wider"
                  >
                    {m.source.name}
                  </span>
                  <span className="rounded-full border border-border/50 px-1.5 text-[10px]">
                    {SOURCE_KIND_META[sourceKindOf(m.source)].label}
                  </span>
                  <NewTabHint />
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-muted-foreground">
            <Link
              href="/metodoloji#kaynaklar"
              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              Neden sayılmıyor?
            </Link>
          </p>
        </section>
      )}

      <div className="h-px bg-gradient-to-r from-transparent via-brand/20 to-transparent my-6" />

      {/* Chart — Medya DNA'sı (all 144 sources, this cluster's highlighted).
          Now last in the page order; collapsed-by-default thanks to U4. */}
      <div className="rounded-xl border border-border/60 bg-card/40 p-4 hover-lift animate-fade-up stagger-2">
        <MediaDna sources={toMediaDnaSources(allSources)} highlightSlugs={highlightSlugs} />
      </div>

      {/* İlgili haberler: last child, so its streamed arrival moves nothing
          above it. Indexable pages only (see isIndexableCluster). */}
      {isIndexableCluster(cluster, hasHeadline) && (
        <Suspense fallback={null}>
          <ClusterRelatedSlot
            clusterId={cluster.id}
            topic7={cluster.topic7 ?? null}
            headline={headline}
          />
        </Suspense>
      )}
      </div>
    </>
  );
}
