import { clusterDisplayTitle } from "@/lib/clusters/display-headline";
import { isExtractiveModelId } from "@/lib/clusters/neutral-title";
import { cacheLife, cacheTag } from "next/cache";
import { cache } from "react";

import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import { normalizeSourceKind } from "@/lib/bias/config";
import { zoneCountsOf } from "@/lib/bias/zone-summary";
import { cleanOutboundUrl } from "@/lib/articles/outbound-url";
import {
  attemptCached,
  resolveCachedOrRetry,
  resolveCachedOrThrow,
} from "@/lib/cache-resilience";
import { isOptimizableImageUrl, isPlaceholderImageUrl } from "@/lib/images/image-url";
import {
  degradedSilentZone,
  getZoneFeedHealth,
  shouldSuppressBlindspot,
  type ZoneFeedHealth,
} from "@/lib/clusters/feed-health";
import { logRecallVeto, publicBlindspotClaim } from "@/lib/clusters/recall-veto";
import { wireSignalOf, type WireSignal } from "@/lib/clusters/wire";
import { createReaderClient } from "@/lib/supabase/server";
import { repairEntityResidue } from "../../../supabase/functions/_shared/rss/entities";
import type { BiasCategory, BiasDistribution, MediaDnaZone, Source } from "@/types";

// Names the pole zone whose degraded feeds caused a blindspot to be
// suppressed, via the shared `degradedSilentZone` helper (feed-health.ts)
// so this call site can't drift from blindspots-query.ts /
// politics-query.ts on which zone a suppression log names.
function logSuppression(
  clusterId: string,
  dominantZone: MediaDnaZone,
  health: ZoneFeedHealth | null | undefined,
): void {
  const silentZone = health ? degradedSilentZone(dominantZone, health) : null;
  if (!silentZone || !health) {
    // Cannot happen right after shouldSuppressBlindspot returned true (same
    // underlying condition) — kept as a total branch that logs without
    // inventing a zone rather than assuming one.
    console.log(
      `[feed-health] suppressed blindspot for cluster ${clusterId} (silent zone unknown)`,
    );
    return;
  }
  const stats = health[silentZone];
  console.log(
    `[feed-health] suppressed blindspot for cluster ${clusterId} (silent zone ${silentZone}: ${stats.healthy}/${stats.total} feeds healthy)`,
  );
}

/**
 * Derive the dominant Medya DNA zone from an already-normalized
 * `BiasDistribution`, reusing `zoneCountsOf` (src/lib/bias/zone-summary.ts)
 * instead of a second tally implementation. Ties break in `ZONE_ORDER`
 * (iktidar, bagimsiz, muhalefet), matching the contract's own tie-break.
 */
function dominantZoneOf(distribution: BiasDistribution): MediaDnaZone | null {
  const counts = zoneCountsOf(distribution);
  const order: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];
  let best: MediaDnaZone | null = null;
  for (const zone of order) {
    if (counts[zone] > 0 && (best === null || counts[zone] > counts[best])) {
      best = zone;
    }
  }
  return best;
}

// Cluster detail fetcher used by /clusters/[id].
//
// Perf strategy:
//   The page needs three things: the cluster row, its member articles
//   (with their sources), and the full 144-source directory for the
//   MediaDNA grid. A naive implementation would do 4 sequential round-
//   trips (cluster → cluster_articles → articles → sources). This module
//   collapses that to two round-trips by using a PostgREST embedded select
//   for members (cluster_articles → articles → sources in one shot): the
//   cluster row is read FIRST, then the members and the sources directory
//   run in parallel. Both selects also carry `kind` (aggregator/wire/
//   niche/outlet) so the page can partition voting vs non-voting members
//   without a third round-trip; `allSources[i].kind` passes through the
//   raw CHECK-constrained column, while every member's `source.kind` is
//   normalized via `normalizeSourceKind` so it's always a real `SourceKind`.
//
//   Why the cluster row goes first (h30-abuse-2): the route accepts any
//   well-formed UUID, so an unknown id (or a flood of random ones) used to
//   cost three PostgREST reads, including the 41 kB sources directory. A
//   missing row now ends after ONE clusters read; a real-cluster miss pays
//   one extra round-trip (row before members), which buys that single-read
//   unknown path. The id is also lower-cased before it becomes a cache key,
//   tag or filter, so `ABC…` and `abc…` share one remote-cache entry.
//
//   The sources directory is the same for every cluster, so it lives in its
//   own parameterless `"use cache: remote"` body (getActiveSourceDirectoryCached,
//   tag `sources`, `source-directory` life): it is read once per cache life,
//   not once per cluster id. Nested inside the detail body, it also means a
//   `revalidateTag("sources")` invalidates every cluster-detail entry that
//   embedded the directory.
//
//   The detail body is wrapped in `"use cache: remote"` keyed per cluster id,
//   so repeat hits skip Supabase entirely.
//
//   Reads run on the capped reader client (4 s, see createReaderClient):
//   on a cold database a visitor gets a fast failure instead of an 8 s
//   wait, and a failure is cached for `minutes` only (never `cluster-feed`).

export interface ClusterDetailMember {
  source: Source;
  article: {
    id: string;
    title: string;
    url: string;
    published_at: string;
    image_url: string | null;
    content_hash: string | null;
    // Raw RSS description; the cluster summary is the seed article's copy of it.
    description?: string | null;
  };
}

export interface ClusterDetail {
  cluster: {
    id: string;
    title_tr: string;
    title_original: string | null;
    /** How the displayed title was produced when it differs from the
     *  original: "llm" for a model rewrite, "extractive" for a cleaned
     *  member headline. null when title_original is null. */
    title_method: "llm" | "extractive" | null;
    summary_tr: string;
    article_count: number;
    bias_distribution: BiasDistribution;
    is_blindspot: boolean;
    blindspot_side: BiasCategory | null;
    first_published: string;
    updated_at: string;
    /** seo-3 (migration 037): archived → noindex,follow on the detail page. */
    is_archived: boolean;
    /** Migration 099: the surviving cluster this one was merged into. Set
     *  only when it is a UUID different from `id`. Optional so pre-099
     *  fixtures compile. */
    merged_into?: string | null;
    /** Migration 067 topic label ('politika' or a /konu hub slug), or null
     *  when unset or not a string. Picks the feed of the page's "İlgili
     *  haberler" block. Optional so fixtures and cache entries written before
     *  the column was read still compile. */
    topic7?: string | null;
  };
  members: ClusterDetailMember[];
  allSources: Source[]; // all 144, for MediaDNA rendering
  // True when the source-directory read FAILED, so `allSources` is `[]`
  // because of an error and not because the directory is empty (a live
  // directory never is). Such a detail is cached for `minutes` only, never
  // for the cluster-feed window, and is never remembered as a last-good
  // value. Optional so pre-existing fixtures compile.
  sourcesUnavailable?: boolean;
  wire: WireSignal;
  // True only when the feed-health gate withdrew this cluster's blindspot
  // claim for this render (see the suppression block below) — lets the
  // page distinguish "genuinely not a blindspot" from "was a blindspot,
  // but the silent pole's feeds are too broken to trust the silence" so it
  // can show a different explanation instead of silently changing wording.
  blindspotSuppressed: boolean;
  // True only when the migration-071 recall veto withdrew this cluster's
  // blindspot claim: Jev matched same-event coverage from the silent side
  // that the clusterer put in another cluster. A matching fact, not a feed
  // outage, so it is independent of `blindspotSuppressed` (never both).
  blindspotRecallVetoed: boolean;
}

/**
 * BL-13 rights gate: members whose source has `image_allowed === false`
 * must never be offered as a hero/card image candidate — that outlet has
 * asked Tayf not to reuse its photos. `undefined` (a fixture/row predating
 * migration 047) is treated as allowed so nothing regresses. Exported so
 * the cluster detail page derives its hero-candidate list (and per-URL
 * photo credits) from one tested source of truth instead of re-deriving
 * the gate inline; callers should build `heroCandidates`/`heroCredits`
 * from this filtered list, falling back to the next eligible member or to
 * no image at all when it's empty.
 */
export function imageEligibleMembers(
  members: ClusterDetailMember[]
): ClusterDetailMember[] {
  return members.filter((m) => m.source.image_allowed !== false);
}

// Row shape of the cluster query. Matches the columns selected below.
// `bias_distribution` is stored as Postgres jsonb, so we type it as `unknown`
// at the query boundary and narrow via `normalizeDistribution` before
// exposing it to the page renderer.
type ClusterRow = {
  id: string;
  title_tr: string;
  /**
   * H2-WORKER neutral-headline pipeline (migration 019 + headline-worker.mjs):
   * the LLM-rewritten neutral version of `title_tr`. NULL until the rewrite
   * worker has processed the cluster. We coalesce
   * `title_tr_neutral ?? title_tr` at render time so neutralized titles
   * win as soon as they exist without overwriting the original.
   */
  title_tr_neutral: string | null;
  /** Provenance for title_tr_neutral (migration 046): an LLM model id, or an
   *  `extractive-*` id (any version; read it with isExtractiveModelId, never
   *  with ===) when the headline cron picked a member headline instead of
   *  calling an LLM. NULL when nothing was written. */
  title_neutral_model: string | null;
  summary_tr: string;
  article_count: number;
  bias_distribution: unknown;
  is_blindspot: boolean;
  blindspot_side: BiasCategory | null;
  /** Migration 071 recall veto. Optional: pre-071 rows/fixtures pass through. */
  blindspot_recall_veto?: boolean | null;
  first_published: string;
  updated_at: string;
  /** seo-3 (migration 037): true once the retention cron has archived this
   *  cluster — the detail page still serves it but must go noindex. */
  is_archived: boolean;
  /** Migration 099. Optional: pre-099 rows/fixtures pass through. */
  merged_into?: string | null;
  /** Migration 067. Optional: fixtures that predate the read pass through. */
  topic7?: string | null;
};

const MERGED_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Narrow the jsonb `bias_distribution` blob into a strongly typed
 * `BiasDistribution`. The cluster pipeline writes the canonical shape but we
 * still validate at the query boundary so a stale row, an admin-side hand
 * edit, or a future schema change can never crash the renderer.
 */
function normalizeDistribution(raw: unknown): BiasDistribution {
  const empty = emptyBiasDistribution();
  if (!raw || typeof raw !== "object") return empty;
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(empty) as BiasCategory[]) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      empty[key] = v;
    }
  }
  return empty;
}

// Shape returned by the embedded PostgREST select for cluster members.
// cluster_articles → articles (one) → sources (one). PostgREST returns
// the nested relations as objects (not arrays) because the FK is
// single-valued (many-to-one).
type EmbeddedSourceRow = {
  id: string;
  name: string;
  slug: string;
  url: string;
  rss_url: string;
  bias: BiasCategory;
  logo_url: string | null;
  active: boolean;
  kind: string | null;
  /**
   * BL-13 per-source rights flags (migration 047). `undefined` (a fixture
   * predating the column, or a legacy select shape) is treated as `true`
   * (allowed) when building `ClusterDetailMember.source` below.
   */
  image_allowed?: boolean;
  excerpt_allowed?: boolean;
  /**
   * Trusteeship plumbing (pack G3, migration 055). Optional for the same
   * reason as the rights flags above — a fixture/legacy select shape that
   * predates the column must still compile and default to "not trusteed"
   * (`null`), never `undefined`, on `ClusterDetailMember.source` below.
   */
  trustee_since?: string | null;
  trustee_note?: string | null;
};

type EmbeddedArticleRow = {
  id: string;
  title: string;
  url: string;
  published_at: string;
  image_url: string | null;
  content_hash: string | null;
  description: string | null;
  source: EmbeddedSourceRow | null;
};

type EmbeddedClusterArticleRow = {
  article: EmbeddedArticleRow | null;
};

// Columns of the sources directory read (see fetchActiveSourceDirectory).
const SOURCE_DIRECTORY_COLUMNS =
  "id, name, slug, url, rss_url, bias, logo_url, active, kind";

// Raw, uncached read of the active sources directory (the MediaDNA grid's
// "who exists" list). It THROWS on a query error so the cache body below can
// pick a lifetime from the outcome via `attemptCached`; it is never called
// from anywhere else.
async function fetchActiveSourceDirectory(): Promise<Source[]> {
  const supabase = createReaderClient();
  const { data, error } = await supabase
    .from("sources")
    .select(SOURCE_DIRECTORY_COLUMNS)
    .eq("active", true)
    .order("name")
    .returns<Source[]>();
  if (error) {
    throw new Error(`sources query failed: ${error.message}`);
  }
  return data ?? [];
}

// The active sources directory in its OWN cache entry (h30-abuse-2). It is the
// same list for every cluster, so it must not be re-read (41 kB) per cluster id
// or per cache variant of one. Parameterless on purpose: one remote-cache entry,
// whatever the id. `cacheTag` first, then `attemptCached` (never rejects, so
// nothing crosses the cache boundary), then exactly one `cacheLife`, picked from
// the outcome: a directory keeps `source-directory`, a failed read is memoised
// for `minutes` only. NO live retry of the directory: the failure marks the
// detail `sourcesUnavailable`, which is itself cached for `minutes` only.
// tests/guards/cache-life-after-attempt.test.ts pins this shape.
async function getActiveSourceDirectoryCached() {
  "use cache: remote";
  cacheTag("sources");
  const r = await attemptCached("cluster-detail-sources", fetchActiveSourceDirectory);
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("source-directory");
  else cacheLife("minutes");
  return r;
}

// Internal (uncached) implementation. The exported `getClusterDetail`
// wraps this with `unstable_cache` below.
async function fetchClusterDetail(id: string): Promise<ClusterDetail | null> {
  try {
    const supabase = createReaderClient();

    // Round-trip 1: the cluster row alone. A missing cluster must end here
    // (h30-abuse-2): reading the members and the sources directory alongside
    // it made an unknown UUID cost three reads. We keep the row and the
    // embedded cluster_articles tree as separate calls because a single embed
    // from `clusters` would pull the same cluster columns back in every
    // member row.
    const clusterRes = await supabase
      .from("clusters")
      .select(
        "id, title_tr, title_tr_neutral, title_neutral_model, summary_tr, article_count, bias_distribution, is_blindspot, blindspot_side, blindspot_recall_veto, first_published, updated_at, is_archived, merged_into, topic7"
      )
      .eq("id", id)
      .maybeSingle<ClusterRow>();

    if (clusterRes.error) {
      // Throw — returning null here reads as "no such cluster", the page
      // calls notFound(), and `"use cache"` pins that null for the detail
      // TTL: a real cluster would serve a cached 404 for minutes after a
      // transient failure. A throw keeps the bad result out of the cache.
      throw new Error(
        `[cluster-detail] cluster query error: ${clusterRes.error.message}`
      );
    }
    if (!clusterRes.data) {
      // No such cluster — let the page call `notFound()`. This is the whole
      // cost of an unknown id: one clusters read.
      return null;
    }

    // Round-trip 2: the members (embedded articles + sources) in parallel
    // with the sources directory, which is its own cache entry.
    const [membersRes, dir] = await Promise.all([
      supabase
        .from("cluster_articles")
        .select(
          `article:articles (
             id, title, url, published_at, image_url, content_hash, description,
             source:sources ( id, name, slug, url, rss_url, bias, logo_url, active, kind, image_allowed, excerpt_allowed, trustee_since, trustee_note )
           )`
        )
        .eq("cluster_id", id)
        .returns<EmbeddedClusterArticleRow[]>(),
      getActiveSourceDirectoryCached(),
    ]);

    if (membersRes.error) {
      // Members are the page's content — a memberless detail must not be
      // rendered and cached. Same rationale as the cluster query above.
      throw new Error(
        `[cluster-detail] members query error: ${membersRes.error.message}`
      );
    }
    if (!dir.ok) {
      // Supplemental only (MediaDna source-directory dimming) — degrade to
      // an empty list rather than failing the whole page. The result carries
      // `sourcesUnavailable: true`, which keeps it out of the long cache
      // window (getClusterDetailCached) and lets the page say so.
      console.warn("[cluster-detail] sources query error:", dir.error);
    }

    const clusterRow = clusterRes.data;
    const distribution = normalizeDistribution(clusterRow.bias_distribution);

    // Read-path-only suppression, mirroring /blindspots: a shared link must
    // never show a blindspot claim the feed has already withdrawn. This
    // never writes clusters.is_blindspot — only the value returned here.
    // Only pay for the health fetch when the DB already flagged the
    // cluster (the common case is not a blindspot at all).
    //
    // Migration 071 recall veto runs FIRST: a vetoed cluster skips the
    // feed-health fetch entirely (the veto is a matching fact, not a feed
    // outage, so blindspotSuppressed stays false).
    //
    // h37-content-1: the claim also waits BLINDSPOT.feedDelayHours after
    // first_published, like /blindspots, so the page, share card, embed and
    // oEmbed show no "Kör nokta" for a story still inside that wait. A held-back
    // claim is not a recall withdrawal (blindspotRecallVetoed stays false) and
    // never shows a pill, but it still asks the feed-health gate: a feed outage
    // is a current event, so the clusters it touches are mostly younger than the
    // delay, and "bazı kaynaklara şu an ulaşamıyoruz" (feedDegraded on the page,
    // the 'suppressed' section of the weekly report) must survive the wait. A
    // pending claim whose silent pole is degraded therefore reads as it did
    // before the wait existed: blindspotSuppressed true, no claim, no side.
    // ONE clock read: this fetcher only runs inside the "use cache: remote"
    // attempt or after the request scope on the live retry, never in an
    // uncached render.
    const veto = publicBlindspotClaim(clusterRow, Date.now());
    if (veto.vetoed) logRecallVeto(id);
    let isBlindspot = veto.isBlindspot;
    let blindspotSide = veto.blindspotSide;
    let blindspotSuppressed = false;
    if (isBlindspot || veto.pending) {
      const dominantZone = dominantZoneOf(distribution);
      if (dominantZone) {
        const health = await getZoneFeedHealth();
        if (shouldSuppressBlindspot(dominantZone, health)) {
          isBlindspot = false;
          // Mirror the DB invariant (migration 032): blindspot_side is
          // non-null only when is_blindspot is true. politics-query.ts's
          // buildClusterBundle nulls both together for the same reason —
          // a withdrawn claim must not still expose the side it withdrew.
          blindspotSide = null;
          blindspotSuppressed = true;
          logSuppression(id, dominantZone, health);
        }
      }
    }

    // Normalize the embedded shape to the ClusterDetailMember contract.
    // Drop rows where the embedded article or its source is null —
    // those would indicate a dangling FK which shouldn't happen, but
    // we guard defensively rather than crash the page.
    const members: ClusterDetailMember[] = [];
    for (const row of membersRes.data ?? []) {
      const article = row.article;
      if (!article) continue;
      const source = article.source;
      if (!source) continue;
      members.push({
        source: {
          id: source.id,
          name: source.name,
          slug: source.slug,
          url: source.url,
          rss_url: source.rss_url,
          bias: source.bias,
          logo_url: source.logo_url,
          active: source.active,
          kind: normalizeSourceKind(source.kind),
          // BL-13 rights gate: default missing flags to `true` (allowed)
          // right at the query boundary so every downstream consumer
          // (imageEligibleMembers below, summary-attribution.ts) always
          // sees a concrete boolean instead of having to re-derive the
          // "undefined means allowed" rule itself.
          image_allowed: source.image_allowed ?? true,
          excerpt_allowed: source.excerpt_allowed ?? true,
          // Trusteeship plumbing (pack G3): default missing/legacy rows to
          // "not trusteed" rather than leaving `undefined` on the Source
          // shape every other reader now expects `string | null` from.
          trustee_since: source.trustee_since ?? null,
          trustee_note: source.trustee_note ?? null,
        },
        article: {
          id: article.id,
          title: article.title,
          // h24-feeds-3: the stored url is the upsert key and stays as the
          // feed gave it; the page gets the href with Diken's literal
          // '&#038;' decoded and utm_*/fbclid/gclid tags dropped. Every
          // consumer (hrefs, JSON-LD isBasedOn, timeline, framing, embed)
          // reads this field.
          url: cleanOutboundUrl(article.url),
          published_at: article.published_at,
          // gif-filter (http-1): an animated GIF is nulled at the query
          // boundary (22 MB haber7 / elips-haber placeholder that
          // /_next/image passes through unmodified), so the hero, credits and
          // alt text fall to the next member's image automatically.
          // db-4: a publisher logo card / 'son dakika' stand-in is nulled the
          // same way.
          image_url:
            isOptimizableImageUrl(article.image_url) &&
            !isPlaceholderImageUrl(article.image_url)
              ? article.image_url
              : null,
          content_hash: article.content_hash,
          description: article.description ?? null,
        },
      });
    }

    // Sort by published_at ASC FIRST so the dedupe pass below
    // deterministically keeps the EARLIEST article per source.
    const sortedMembers = [...members].sort(
      (a, b) =>
        new Date(a.article.published_at).getTime() -
        new Date(b.article.published_at).getTime()
    );

    // Server-side dedupe (defense in depth):
    // If the cluster has multiple articles from the same source, keep
    // the earliest one. R2's audit found 1.87% of clusters have this —
    // the proper DB fix is D6, this is a guard so the UI never receives
    // the same (cluster_id, source_id) pair twice.
    const seenSources = new Set<string>();
    const dedupedMembers: ClusterDetailMember[] = [];
    for (const m of sortedMembers) {
      if (seenSources.has(m.source.id)) continue;
      seenSources.add(m.source.id);
      dedupedMembers.push(m);
    }
    const droppedDupes = sortedMembers.length - dedupedMembers.length;
    if (droppedDupes > 0) {
      console.log(
        `[cluster-detail-query] dropped ${droppedDupes} duplicate source(s) for cluster ${id}`
      );
    }

    // Re-sort newest-first for display — matches the /clusters list ordering.
    dedupedMembers.sort(
      (a, b) =>
        new Date(b.article.published_at).getTime() -
        new Date(a.article.published_at).getTime()
    );

    // Cluster titles were stored before the ingest entity fix, so 49 archived
    // rows still carry "&quot;" / "&amp;" in `title_tr` (their neutral title is
    // empty). Repair at the one place the detail is shaped. `repairEntityResidue`
    // is pure and never throws, so it is safe inside this cached body; the
    // `typeof` guard keeps a corrupt non-string value (the columns are text, so
    // this is belt and braces) from becoming a TypeError that would cross the
    // cache boundary.
    const repairTitle = (t: string): string =>
      typeof t === "string" ? repairEntityResidue(t) : "";
    const originalTitle = repairTitle(clusterRow.title_tr);
    const storedNeutralTitle = clusterRow.title_tr_neutral
      ? repairTitle(clusterRow.title_tr_neutral)
      : "";

    // h42-latency-1: the headline cron writes the first neutral title on a */5
    // tick, so a new cluster used to show the seed article's raw outlet headline
    // here (page <h1>, <title>, og:title, JSON-LD) until then. A cluster of 2+
    // members that the cron would still title gets the cron's own first pick,
    // computed from the member titles already loaded (the whole list, pre-dedupe,
    // as the cron reads it). It is the neutral title for every purpose below, so
    // the "Özgün başlık" disclosure still shows the outlet's original, and the
    // value agrees with what the cron writes a moment later. Archived clusters
    // are skipped by the cron, so they keep title_tr. Pure, no write, and the
    // result passes through the same entity repair as a stored title.
    const picked =
      storedNeutralTitle.trim().length === 0 && !clusterRow.is_archived
        ? clusterDisplayTitle(
            { title_tr: clusterRow.title_tr, title_tr_neutral: null },
            members.map((m) => ({ title: m.article.title, published_at: m.article.published_at })),
          )
        : null;
    const neutralTitle = picked?.picked ? repairTitle(picked.title) : storedNeutralTitle;
    const headlines = {
      original: originalTitle,
      neutral: neutralTitle.trim().length > 0 ? neutralTitle : null,
      // Compared after repair: a neutral title that differs from the original
      // only by entity encoding replaced nothing, so it discloses nothing.
      replaced:
        neutralTitle.trim().length > 0 &&
        neutralTitle.trim() !== originalTitle.trim(),
    };

    return {
      cluster: {
        id: clusterRow.id,
        // H2 neutral-headline coalesce: prefer the LLM-rewritten neutral
        // title once H2-WORKER has produced it. Falls back to the original
        // seed-inherited title for clusters that haven't been rewritten yet.
        // Empty strings are coalesced too — an empty neutral title means
        // the rewriter wrote junk and we'd rather show the original.
        //
        // Both titles are entity-repaired once, here (see `headlines`), so
        // the H1, <title>, og:title, JSON-LD and the fallback meta
        // description all read clean text.
        title_tr: headlines.neutral ?? headlines.original,
        // Set only when the neutral rewrite actually replaced the original
        // title, so the page can offer "Özgün başlık" disclosure — null
        // means there's nothing to disclose (no rewrite happened, or the
        // rewrite produced the same text as the original, which discloses
        // nothing new).
        title_original: headlines.replaced ? headlines.original : null,
        // A title picked here from the member headlines is extractive, though no
        // model id is stored until the cron's first write.
        title_method: headlines.replaced
          ? picked?.picked || isExtractiveModelId(clusterRow.title_neutral_model)
            ? "extractive"
            : "llm"
          : null,
        summary_tr: clusterRow.summary_tr,
        // The DB-stored article_count may be stale between the recluster
        // pass and this page render. Reflect the post-dedupe truth.
        article_count: dedupedMembers.length,
        bias_distribution: distribution,
        is_blindspot: isBlindspot,
        blindspot_side: blindspotSide,
        first_published: clusterRow.first_published,
        updated_at: clusterRow.updated_at,
        is_archived: clusterRow.is_archived,
        merged_into:
          typeof clusterRow.merged_into === "string" &&
          MERGED_UUID_RE.test(clusterRow.merged_into) &&
          clusterRow.merged_into.toLowerCase() !== clusterRow.id.toLowerCase()
            ? clusterRow.merged_into.toLowerCase()
            : null,
        topic7: typeof clusterRow.topic7 === "string" ? clusterRow.topic7 : null,
      },
      members: dedupedMembers,
      allSources: dir.ok ? dir.data : [],
      sourcesUnavailable: !dir.ok,
      wire: wireSignalOf(
        dedupedMembers.map((m) => ({
          id: m.article.id,
          content_hash: m.article.content_hash,
          title: m.article.title,
        }))
      ),
      blindspotSuppressed,
      blindspotRecallVetoed: veto.vetoed,
    };
  } catch (err) {
    // Rethrow — swallowing to null would cache a 404 for a real cluster.
    console.warn("[cluster-detail] unexpected error:", err);
    throw err;
  }
}

// Build-safety: `attemptCached` swallows whatever `fetchClusterDetail`
// throws instead of letting it cross the `"use cache: remote"` boundary —
// a throw here fails `next build`'s prerender even when every caller
// catches (see src/lib/cache-resilience.ts). A genuine "not found"
// (`null`, no error) is NOT a failure — it flows through as
// `{ ok: true, data: null }`. Not exported: every caller must go through
// `getClusterDetail`'s UUID guard below so a malformed id (e.g.
// `/cluster/not-a-uuid`) never reaches Supabase or this cache layer.
//
// Cache lifetime follows the outcome (same shape as daily-zones.ts): a
// success keeps the `cluster-feed` window, a failed attempt is memoised for
// `minutes` only, so a cold-read timeout is retried within a minute instead
// of being pinned for the whole window. A detail whose sources-directory read
// failed (`sourcesUnavailable`) is a degraded success: it gets `minutes` too,
// so a transient blip in that one query is not pinned as "no sources" for the
// whole `cluster-feed` window. Exactly one `cacheLife` call per invocation
// (the nested directory body, getActiveSourceDirectoryCached, makes its own
// one call on its own entry); `cacheTag` comes first so the entry is tagged on
// every path. The nested directory body also tags this entry `sources`.
//
// The one piece of new logic in this body is the `at` stamp: the epoch ms of
// the database read, so a cache hit can be remembered as a last-good value
// without reading the clock on the hit path (cache-resilience.ts, section 4).
// It is stamped only for a real, complete detail: not for a missing cluster
// (`null`) and not for a degraded one.
async function getClusterDetailCached(id: string) {
  "use cache: remote";
  cacheTag(`cluster-detail:${id}`, "clusters");
  const r = await attemptCached("cluster-detail", () => fetchClusterDetail(id));
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok && !r.data?.sourcesUnavailable) cacheLife("cluster-feed");
  else cacheLife("minutes");
  return r.ok && r.data !== null && !r.data.sourcesUnavailable
    ? { ...r, at: Date.now() }
    : r;
}

// UUID guard (reader-queries E3): `clusters.id` is a Postgres `uuid`
// column, so a malformed id can never match a row — but before this guard
// existed, a request like `/cluster/not-a-uuid` still reached
// `getClusterDetailCached`, paying for (and populating) a cache entry for
// a lookup that was guaranteed to return null. Rejecting the id here,
// before it ever becomes part of the cache key, is free (a static regex
// test) and keeps that cache layer's key space bounded to actual UUIDs.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What may be remembered as a last-good detail (cache-resilience.ts, section
// 4): a real cluster whose sources-directory read worked. A `sourcesUnavailable`
// detail is served to the request that fetched it, but a newer degraded copy
// must never replace the complete one that an outage would later serve.
function isCompleteDetail(detail: ClusterDetail | null): boolean {
  return detail !== null && !detail.sourcesUnavailable;
}

// Public entry point. With Cache Components the `id` argument is
// automatically part of the cache key — no per-id wrapper Map needed.
// Callers / workers can invalidate a single cluster with
// `revalidateTag(\`cluster-detail:\${id}\`)`.
//
// On a cache-attempt failure this retries the query live once (so a
// transient Supabase blip does not pin a false 404 for the whole
// `cluster-feed` cacheLife window) before falling back to the last good
// detail this instance saw for the id (under 60 min old), and only then to
// `null`; never throws. Concurrent live retries for one id share one read
// (key `cluster-detail:<id>`; the id is a validated UUID, so the key space
// is bounded).
export async function getClusterDetail(
  id: string
): Promise<ClusterDetail | null> {
  if (!UUID_RE.test(id)) return null;
  // Fold case before the id becomes a cache key, tag, last-good key or filter:
  // UUID_RE is case-insensitive, and `ABC…` / `abc…` are the same row
  // (h30-abuse-2), so they must share one remote-cache entry.
  const key = id.toLowerCase();
  return resolveCachedOrRetry(
    { label: "cluster-detail", key: `cluster-detail:${key}`, remember: isCompleteDetail },
    () => getClusterDetailCached(key),
    () => fetchClusterDetail(key),
    null,
  );
}

/**
 * Throwing sibling of `getClusterDetail` for the cluster page and its
 * `generateMetadata`. `getClusterDetail` maps a sustained outage to `null`,
 * which the page reads as "no such cluster" and turns into a 404 -- a Supabase
 * timeout must not look like a missing story (search engines would drop it).
 * This variant resolves `null` ONLY for a malformed id or a row that is
 * genuinely absent, and otherwise REJECTS: the cached attempt failed and the
 * live retry did too, so the error propagates to `error.tsx` (noindex) and
 * `generateMetadata` answers with a noindex "unavailable" shell. The one
 * exception is a last good detail this instance saw for the id less than
 * 60 min ago, which is served instead of the rejection (stale-if-error); the
 * live retry waits for a request scope first, so a prerender postpones
 * rather than reading live.
 *
 * Wrapped in React `cache` so `generateMetadata` and the page body in one
 * request share a single result (and a single live retry) per id. Never call
 * it from a `"use cache"` body: it can throw.
 *
 * Kart, opengraph-image and rozet (alongside the cluster page, embed and
 * oembed) use this throwing variant and answer a rejection with an uncached
 * 503 / generic card. `getClusterDetail` keeps its never-throw contract for
 * the one caller that must degrade silently: yelpaze.
 */
export const getClusterDetailOrThrow = cache(
  async (id: string): Promise<ClusterDetail | null> => {
    if (!UUID_RE.test(id)) return null;
    // Same case fold as getClusterDetail (h30-abuse-2).
    const key = id.toLowerCase();
    return resolveCachedOrThrow(
      { label: "cluster-detail", key: `cluster-detail:${key}`, remember: isCompleteDetail },
      () => getClusterDetailCached(key),
      () => fetchClusterDetail(key),
    );
  },
);

