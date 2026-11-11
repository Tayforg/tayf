import { cacheLife, cacheTag } from "next/cache";

import type {
  ClusterCardArticle,
  ClusterCardCluster,
} from "@/components/story/cluster-card";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import { BLINDSPOT } from "@/lib/bias/config";
import { attemptCached, resolveCachedOrThrow } from "@/lib/cache-resilience";
import { isOptimizableImageUrl, isPlaceholderImageUrl } from "@/lib/images/image-url";
import {
  dedupeBySource,
  passesFeedFilters,
  zoneTallyOf,
  type EmbeddedArticle,
} from "@/lib/clusters/blindspot-feed";
import {
  BLINDSPOT_LIST_LOOKBACK_DAYS,
  DEFAULT_PICK_SIZE,
  pickBlindspotList,
  sortBlindspotClaims,
} from "@/lib/clusters/blindspot-pick";
import {
  degradedSilentZone,
  getZoneFeedHealth,
  shouldSuppressBlindspot,
  type ZoneFeedHealth,
} from "@/lib/clusters/feed-health";
import type { BundleSource } from "@/lib/clusters/politics-query";
import {
  fetchRecallMatchedZones,
  recallQualifiedZones,
} from "@/lib/clusters/recall-matched-zones";
import {
  buildSilenceDigest,
  type SilenceDigest,
} from "@/lib/clusters/silence-digest";
import { wireSignalOf } from "@/lib/clusters/wire";
import {
  createReaderClient,
  createServerClient,
  type ReadProfile,
} from "@/lib/supabase/server";
import type { BiasCategory, BiasDistribution, MediaDnaZone } from "@/types";

// Names the pole zone whose degraded feeds caused a blindspot to be
// suppressed, via the shared `degradedSilentZone` helper (feed-health.ts)
// so this call site can't drift from cluster-detail-query.ts /
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

// Fetcher for /blindspots — extracted out of the page component so the
// cluster-page.test.ts-style unit tests can exercise it without rendering
// JSX, and so other surfaces (e.g. the weekly digest cron) can reuse the
// same list.
//
// reader-queries fix: the previous single embedded select ran the
// cluster_articles -> articles -> sources lateral JOIN for every one of up
// to CANDIDATE_LIMIT (200) candidate rows BEFORE the final ORDER BY/LIMIT
// could discard any of them — PostgREST/Postgres has no way to push the
// candidate-selection order-by-limit below the embed. The audit measured
// 8s statement timeouts on this shape (digest 2792684209). Splitting into
// a lean id-only Step A (cheap: the existing partial index) and a
// Step-B embed fetch BATCHED over just those ids removes the full-embed
// cost from every candidate this feed will never render.
//
// h53-consistency-1: the list is EVERY public claim of the trailing
// BLINDSPOT_LIST_LOOKBACK_DAYS days, not "the 30 most lopsided of the 50 most
// recently updated". Step A used to take the 200 most recently updated flagged
// clusters (back to mid-October) and Step B stopped after the first batch of 50
// once 30 bundles passed; the 30 were then cut by share alone. On 2026-11-06 the
// week held 41 Iktidar and 9 Muhalefet claims and the page showed 28 : 2, its
// "Bu listede kim yer vermedi?" box read 25 : 2, and /metodoloji's promise that
// a story appears 24 hours after its first publication was broken for 20
// claims. Now:
//   - Step A is bounded below by first_published (the window) and above by
//     BLINDSPOT_CANDIDATE_SAFETY_CAP, a safety bound and not a sample;
//   - Step B embeds every candidate (at most CAP / EMBED_BATCH_SIZE = 3
//     batches), concurrently with the feed-health read;
//   - blindspot-pick.ts gives the 30 full cards (side-balanced round-robin);
//   - every other passing claim comes back as a slim `more` row, and the
//     counts and the silence digest are computed here over ALL claims, so the
//     cached payload stays small (30 bundles + slim rows + two tiny objects).
//
// Step A plan -- `EXPLAIN (ANALYZE, BUFFERS)` against production, 2026-11-06,
// read-only, with the window bound:
//
//   Limit (actual time=1.838..1.847 rows=46)
//     -> Sort (Sort Key: updated_at DESC)
//        -> Bitmap Heap Scan on clusters (rows=46, Rows Removed by Filter: 33)
//           Recheck Cond: is_blindspot AND first_published < now() - 24 h
//                         AND first_published >= now() - 7 days
//           Filter: NOT blindspot_recall_veto AND NOT is_archived
//                   AND article_count >= 3
//           -> BitmapAnd
//              -> Bitmap Index Scan on clusters_blindspot_checked_idx (rows=1248)
//              -> Bitmap Index Scan on idx_clusters_first_published (rows=6118)
//   Execution Time: 1.9 ms (cost 155; buffers: shared hit=133)
//
// The unbounded Step A it replaces took 13.4 ms (cost 222, 963 rows scanned for
// the 200 returned), so the bound makes it cheaper, not dearer. That week had
// 46 candidates, all of them live claims: the cap of 150 is about 3x headroom,
// and it is a bound on embed work (3 batches), not a way to pick claims. When
// it is reached the oldest-updated candidates fall off and a warning says so.
// Step B for those 46 ids (an embed-shaped join) ran in about 116 ms.
const PREFILTER_MIN_ARTICLE_COUNT = 3;
// Trailing window of the list, in days (first_published >= now - this); defined
// beside the pick so the page can name it without importing this module.
export { BLINDSPOT_LIST_LOOKBACK_DAYS };
/**
 * Upper bound on Step A ids, hence on Step B work: 150 / EMBED_BATCH_SIZE = at
 * most 3 embed batches. A safety bound, not a sample: a full week held 46.
 */
export const BLINDSPOT_CANDIDATE_SAFETY_CAP = 150;
/** Full cards on the page; every other claim is a compact row. The same binding /metodoloji quotes. */
const DISPLAY_LIMIT = DEFAULT_PICK_SIZE;
export const EMBED_BATCH_SIZE = 50;
const DAY_MS = 24 * 3_600_000;

type EmbeddedClusterArticle = {
  articles: EmbeddedArticle | null;
};

export type EmbeddedClusterRow = {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  summary_tr: string;
  bias_distribution: unknown;
  is_blindspot: boolean;
  blindspot_side: BiasCategory | null;
  /** Migration 071; filtered DB-side (always false on returned rows). */
  blindspot_recall_veto?: boolean | null;
  /**
   * Migration 064: Jev's blindspot_recall stage found a likely same-event article
   * from the silent side. Not filtered on (a suspect claim that survives the veto
   * stays public by design); only read to decide which claims get the recall
   * lookup (h106-blindspotbadges-1). Optional: fixtures and rows fetched before
   * the column was read pass through as "not flagged".
   */
  blindspot_recall_suspect?: boolean | null;
  article_count: number;
  first_published: string;
  updated_at: string;
  cluster_articles: EmbeddedClusterArticle[] | null;
};

const EMBED_SELECT = `id, title_tr, title_tr_neutral, summary_tr, bias_distribution, is_blindspot, blindspot_side, blindspot_recall_veto, blindspot_recall_suspect, article_count, first_published, updated_at,
         cluster_articles (
           articles (
             id, title, url, image_url, published_at, source_id, category, content_hash, politics_admitted_at,
             sources ( id, name, bias, logo_url, kind, image_allowed, excerpt_allowed )
           )
         )`;

export interface BlindspotBundle {
  cluster: ClusterCardCluster;
  articles: ClusterCardArticle[];
  /**
   * Every de-duplicated source, each with its `kind`. Includes the
   * non-voting kinds (aggregator, niche); a zone line must tally them with
   * `votingZoneCounts` (feeds/zone-line.ts), or read `votingZoneCounts`
   * below directly.
   */
  sources: BundleSource[];
  dominantZone: MediaDnaZone;
  dominantPct: number;
  /**
   * Per-zone count of VOTING sources (outlet, wire) on the de-duplicated
   * member set: the very tally `dominantZone` / `dominantPct` are derived
   * from. Unlike `sources` it excludes the non-voting kinds (aggregator,
   * niche), so a consumer asking "did zone Y cover this story" gets the same
   * answer the card's "%100 tek tarafta" label is built on.
   */
  votingZoneCounts: Record<MediaDnaZone, number>;
  /**
   * h106-blindspotbadges-1: the silent zones (not dominant, no voting member) in
   * which the site's own Jev recall stage matched a voting source with the same
   * event, so the claim cannot honestly say nobody there covered it (the story
   * may sit in another cluster). Sorted, de-duplicated, [] unless the cluster is
   * flagged blindspot_recall_suspect and the lookup answered. WORDING ONLY: the
   * claim, the veto, every count and share ignore it; the card says "Kümede
   * sadece X" instead of "Sadece X yazdı" and the silence digest leaves that zone
   * out of that claim's "yer vermedi". A plain array so it survives the cache
   * payload; a payload cached before this field existed lacks it, and readers
   * treat that as [].
   */
  recallMatchedZones: MediaDnaZone[];
  isWireRedistribution: boolean;
  effectiveArticleCount: number;
}

/**
 * A claim that passes the blindspot contract but did not get one of the
 * DISPLAY_LIMIT full cards. Slim on purpose: it is part of the cached payload
 * and /blindspots renders it as one compact line (title link, "%P <Taraf>",
 * "N kaynak"), so it carries no cluster, article or source objects. The voting
 * tally rides along so the percent can come from the same largest-remainder
 * rule as the card's chip and bar (dominantPct is only the sort key).
 */
export interface BlindspotMoreRow {
  id: string;
  /** title_tr_neutral ?? title_tr, as on the card. */
  title: string;
  dominantZone: MediaDnaZone;
  dominantPct: number;
  /** Every de-duplicated member, as the card's "N kaynak". */
  sourceCount: number;
  /**
   * When the claim was first published (clusters.first_published), the date a
   * card's feed item carries. Not updated_at: that moves with every new member,
   * so a compact row dated by it would sort above every card in a date-sorted
   * reader and move again when the row is promoted to a card. The RSS feed dates
   * its items by this.
   */
  firstPublished: string;
  /**
   * The cluster's own last update (clusters.updated_at). The RSS feed never
   * reads it (see `firstPublished`); the alerts feed and webhooks do, to derive
   * a compact row's `alert_at` exactly as for a card (`alertAtOf`:
   * max(updated_at, first_published + the feed delay)). A payload cached before
   * this field existed lacks it; `alertAtOf` then falls back to the delay alone.
   */
  updatedAt: string;
  votingZoneCounts: Record<MediaDnaZone, number>;
  /** The card's `recallMatchedZones` (h106-blindspotbadges-1), kept so a row promoted to a card words itself the same way. */
  recallMatchedZones: MediaDnaZone[];
}

/** Everything /blindspots, its feeds and the crons read from one fetch. */
export interface BlindspotsData {
  /** The full cards: DISPLAY_LIMIT claims, side-balanced, most lopsided first. */
  bundles: BlindspotBundle[];
  /** Every other passing claim of the window, most lopsided first. */
  more: BlindspotMoreRow[];
  /** bundles.length + more.length: every public claim of the window. */
  claimCount: number;
  /** Claims per dominant zone over the whole window; sums to claimCount. */
  sideCounts: Record<MediaDnaZone, number>;
  /** "Bu listede kim yer vermedi?", counted over ALL claims, not the cards. */
  digest: SilenceDigest;
}

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

/**
 * Per-row candidate -> bundle assembly, extracted verbatim (no behaviour
 * change) from the old inline loop: same-source dedupe, the feed quality
 * filter, the live zone re-tally against the BLINDSPOT contract, the
 * feed-health suppression gate (+ its log line), the BL-13 image rights
 * gate, and the ClusterCard-shaped output. Returns `null` when the
 * candidate doesn't clear the contract (or was suppressed) so the caller
 * can filter with a plain `.filter(Boolean)`-style loop.
 */
function toBlindspotBundle(
  c: EmbeddedClusterRow,
  health: ZoneFeedHealth | null,
): BlindspotBundle | null {
  const members: EmbeddedArticle[] = [];
  for (const ca of c.cluster_articles ?? []) {
    if (ca.articles) members.push(ca.articles);
  }
  if (members.length === 0) return null;

  // Same dedupe-by-source rule the politics page uses, so the zone
  // distribution is computed against unique outlets.
  const deduped = dedupeBySource(members);

  // Filter on the served headline: the card shows title_tr_neutral ?? title_tr
  // (below), so the SEO-explainer gate must judge that, not the stored seed.
  if (!passesFeedFilters({ title_tr: c.title_tr_neutral ?? c.title_tr }, deduped).ok) {
    return null;
  }

  // Live tally over unique outlets — re-checked against the contract so a
  // cluster whose `is_blindspot` flag has gone stale can never surface.
  const tally = zoneTallyOf(deduped);
  if (
    !tally.dominantZone ||
    tally.total < BLINDSPOT.minSources ||
    tally.dominantShare < BLINDSPOT.dominantShare
  ) {
    return null;
  }
  const dominantZone: MediaDnaZone = tally.dominantZone;

  // A degraded-feed cluster never enters the /blindspots feed at all — per
  // 032_blindspot_contract_recompute.sql:21-23, blindspot_side is the side
  // that DID cover, so the silent side is the opposite pole, not
  // blindspot_side.
  if (shouldSuppressBlindspot(dominantZone, health)) {
    logSuppression(c.id, dominantZone, health);
    return null;
  }

  const dominantPct = tally.dominantShare;
  const wire = wireSignalOf(
    deduped.map((m) => ({ id: m.id, content_hash: m.content_hash })),
  );

  // Re-sort newest-first for the rendered list, matching ClusterCard's
  // expected ordering.
  deduped.sort(
    (a, b) =>
      new Date(b.published_at).getTime() - new Date(a.published_at).getTime(),
  );

  const sourceMap = new Map<string, BundleSource>();
  for (const m of deduped) {
    if (m.sources && !sourceMap.has(m.sources.id)) {
      sourceMap.set(m.sources.id, {
        id: m.sources.id,
        name: m.sources.name,
        bias: m.sources.bias,
        // browser-3: the headline rows render a favicon from this field
        // (ClusterCardSource.logo_url); it was missing from the embed, so
        // every /blindspots row showed no logo.
        logo_url: m.sources.logo_url ?? null,
        kind: m.sources.kind ?? null,
      });
    }
  }

  return {
    cluster: {
      id: c.id,
      // H2 neutral-headline coalesce, same rule as politics-query.
      title_tr: c.title_tr_neutral ?? c.title_tr,
      summary_tr: c.summary_tr,
      bias_distribution: normalizeDistribution(c.bias_distribution),
      is_blindspot: c.is_blindspot,
      blindspot_side: c.blindspot_side,
      article_count: deduped.length,
      first_published: c.first_published,
      updated_at: c.updated_at,
    },
    articles: deduped.map((m) => ({
      id: m.id,
      title: m.title,
      url: m.url,
      // BL-13 rights gate: a source that has asked Tayf not to reuse its
      // photos gets image_allowed = false — null the URL here so it can
      // never surface as a hero/card image candidate. `undefined` (legacy
      // rows/fixtures predating migration 047) is treated as allowed.
      // gif-filter (http-1): an animated GIF is nulled too (22 MB haber7 /
      // elips-haber placeholder that /_next/image passes through unmodified).
      // db-4: a publisher logo card / 'son dakika' stand-in is nulled too, so
      // the hero falls through to the next member's photo or the logo tier.
      image_url:
        m.sources?.image_allowed === false ||
        !isOptimizableImageUrl(m.image_url) ||
        isPlaceholderImageUrl(m.image_url)
          ? null
          : m.image_url,
      published_at: m.published_at,
      source_id: m.source_id,
    })),
    sources: Array.from(sourceMap.values()),
    dominantZone,
    dominantPct,
    // Copied from the same `tally` that produced dominantZone/dominantPct.
    votingZoneCounts: { ...tally.counts },
    // Filled in by withRecallMatchedZones for the few flagged claims.
    recallMatchedZones: [],
    isWireRedistribution: wire.isWireRedistribution,
    effectiveArticleCount: wire.effectiveArticleCount,
  };
}

// "reader" (/blindspots, RSS, public alerts API) fails fast at 4 s; "batch"
// (digest, social and alerts-webhooks crons) keeps the plain client so a cold
// read can use the 8 s statement_timeout instead of skipping the run.
function clientFor(profile: ReadProfile) {
  return profile === "batch" ? createServerClient() : createReaderClient();
}

/** Step A: the lean id-only candidate select — no embed, so the cost never
 * scales with the number of candidates that end up discarded. */
async function fetchCandidateIds(profile: ReadProfile): Promise<string[]> {
  const supabase = clientFor(profile);
  const now = Date.now();
  const blindspotCutoffIso = new Date(
    now - BLINDSPOT.feedDelayHours * 3600 * 1000,
  ).toISOString();
  const lookbackIso = new Date(
    now - BLINDSPOT_LIST_LOOKBACK_DAYS * DAY_MS,
  ).toISOString();

  const { data, error, status } = await supabase
    .from("clusters")
    .select("id")
    .gte("article_count", PREFILTER_MIN_ARTICLE_COUNT)
    .eq("is_blindspot", true)
    .eq("blindspot_recall_veto", false)
    .eq("is_archived", false)
    .lt("first_published", blindspotCutoffIso)
    .gte("first_published", lookbackIso)
    .order("updated_at", { ascending: false })
    .limit(BLINDSPOT_CANDIDATE_SAFETY_CAP)
    .returns<Array<{ id: string }>>();

  if (error) {
    // `cause` keeps the PostgREST code and response status, so an outage is still classifiable
    // (isUpstreamUnavailable) behind the prefixed message; see alert-query.ts.
    throw new Error(`[blindspots] candidate select error: ${error.message}`, {
      cause: { ...error, status },
    });
  }
  const ids = (data ?? []).map((r) => r.id);
  if (ids.length >= BLINDSPOT_CANDIDATE_SAFETY_CAP) {
    console.warn(
      `[blindspots] candidate cap ${BLINDSPOT_CANDIDATE_SAFETY_CAP} reached; the oldest-updated claims of the ${BLINDSPOT_LIST_LOOKBACK_DAYS}-day window are not listed`,
    );
  }
  return ids;
}

/** Step B: fetch the embed for one batch of ids (order/limit-free — the
 * candidate ORDER already came from Step A). */
export async function fetchEmbedBatch(
  ids: string[],
  profile: ReadProfile,
): Promise<EmbeddedClusterRow[]> {
  const supabase = clientFor(profile);
  const { data, error, status } = await supabase
    .from("clusters")
    .select(EMBED_SELECT)
    .in("id", ids)
    .returns<EmbeddedClusterRow[]>();

  if (error) {
    throw new Error(`[blindspots] embedded select error: ${error.message}`, {
      cause: { ...error, status },
    });
  }
  return data ?? [];
}

function zeroSideCounts(): Record<MediaDnaZone, number> {
  return { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
}

/** The slim form of a claim that did not get a card. */
function toMoreRow(b: BlindspotBundle): BlindspotMoreRow {
  return {
    id: b.cluster.id,
    title: b.cluster.title_tr,
    dominantZone: b.dominantZone,
    dominantPct: b.dominantPct,
    sourceCount: b.sources.length,
    firstPublished: b.cluster.first_published,
    updatedAt: b.cluster.updated_at,
    votingZoneCounts: { ...b.votingZoneCounts },
    recallMatchedZones: [...b.recallMatchedZones],
  };
}

/**
 * h106-blindspotbadges-1: gives each claim whose cluster is flagged
 * blindspot_recall_suspect the silent zones Jev matched (`recallMatchedZones`).
 * ONE extra request, and only when at least one claim that survived the live
 * contract is flagged (none means no request at all); it rides the caller's read
 * profile like every other read here. Wording only: nothing is added to or
 * removed from `claims`, and no flag, veto, count or share is read from the
 * answer. `fetchRecallMatchedZones` never throws and answers an empty Map on any
 * error, which leaves every claim exactly as built (today's strings).
 */
async function withRecallMatchedZones(
  claims: BlindspotBundle[],
  flaggedIds: ReadonlySet<string>,
  profile: ReadProfile,
): Promise<BlindspotBundle[]> {
  const ids = claims.map((c) => c.cluster.id).filter((id) => flaggedIds.has(id));
  if (ids.length === 0) return claims;
  const matched = await fetchRecallMatchedZones(clientFor(profile), ids);
  if (matched.size === 0) return claims;
  return claims.map((claim) =>
    flaggedIds.has(claim.cluster.id)
      ? {
          ...claim,
          recallMatchedZones: recallQualifiedZones(
            claim.votingZoneCounts,
            claim.dominantZone,
            matched.get(claim.cluster.id),
          ),
        }
      : claim,
  );
}

/** The digest of `claims`, annotated with how many of them are full cards. */
function scopedDigest(
  claims: readonly BlindspotBundle[],
  shown: number,
): SilenceDigest {
  return {
    ...buildSilenceDigest(claims),
    scope: { windowDays: BLINDSPOT_LIST_LOOKBACK_DAYS, shown },
  };
}

// Internal (uncached) implementation. The exported `getBlindspots` wraps
// this with `"use cache"` below.
async function fetchBlindspots(profile: ReadProfile): Promise<BlindspotsData> {
  const ids = await fetchCandidateIds(profile);
  if (ids.length === 0) {
    return {
      bundles: [],
      more: [],
      claimCount: 0,
      sideCounts: zeroSideCounts(),
      digest: scopedDigest([], 0),
    };
  }

  const order = new Map(ids.map((id, i) => [id, i]));
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += EMBED_BATCH_SIZE) {
    batches.push(ids.slice(i, i + EMBED_BATCH_SIZE));
  }

  // Every candidate is embedded (no early stop at DISPLAY_LIMIT: the pick
  // below needs ALL passing claims), the batches and the one feed-health read
  // all in flight together. The cap keeps this to at most 3 batches.
  const [health, batchRows] = await Promise.all([
    getZoneFeedHealth({ profile }),
    Promise.all(batches.map((batchIds) => fetchEmbedBatch(batchIds, profile))),
  ]);

  const rows = batchRows
    .flat()
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const built: BlindspotBundle[] = [];
  const flaggedIds = new Set<string>();
  for (const row of rows) {
    const bundle = toBlindspotBundle(row, health);
    if (!bundle) continue;
    built.push(bundle);
    // A literal `true` only: null, false and a row from before the column was
    // read are all "not flagged".
    if (row.blindspot_recall_suspect === true) flaggedIds.add(row.id);
  }
  const claims = await withRecallMatchedZones(built, flaggedIds, profile);

  // Side-balanced cards, most lopsided first (a 100% cluster is a starker
  // blindspot than an 86% one); everything else is a slim row in the same order.
  const bundles = pickBlindspotList(claims, DISPLAY_LIMIT);
  const carded = new Set(bundles.map((b) => b.cluster.id));
  const more = sortBlindspotClaims(
    claims.filter((c) => !carded.has(c.cluster.id)),
  ).map(toMoreRow);

  const sideCounts = zeroSideCounts();
  for (const claim of claims) sideCounts[claim.dominantZone] += 1;

  return {
    bundles,
    more,
    claimCount: bundles.length + more.length,
    sideCounts,
    digest: scopedDigest(claims, bundles.length),
  };
}

// Build-safety: `attemptCached` swallows whatever `fetchBlindspots` throws
// instead of letting it cross the `"use cache: remote"` boundary — a throw
// here fails `next build`'s prerender even when every caller catches (see
// src/lib/cache-resilience.ts).
//
// `profile` is an argument on purpose: it becomes part of the cache key, so a
// capped "reader" entry (and its cached `{ ok: false }` sentinel) is never
// served to a "batch" cron, and the cron's own miss runs uncapped.
//
// Exactly ONE `cacheLife` per invocation, chosen after the attempt: a failed
// attempt (typically the 4 s reader abort on a cold database) is memoised for
// `minutes` only, so a blip cannot park the `{ ok: false }` sentinel for a
// whole `cluster-feed` window; a success keeps the normal lifetime.
//
// The `{ ok: false }` result replaces the previous good entry under the same
// key and Next does not serve that entry past it: the public entry's live
// retry and its per-instance last-good result cover the gap. The one piece of
// new logic in this body is the `at` stamp: the epoch ms of the database read,
// so a cache hit can be remembered as a last-good value without reading the
// clock on the hit path (cache-resilience.ts, section 4).
async function getBlindspotsCached(profile: ReadProfile) {
  "use cache: remote";
  cacheTag("clusters", "clusters-politics");
  const r = await attemptCached("blindspots-query", () =>
    fetchBlindspots(profile),
  );
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("cluster-feed");
  else cacheLife("minutes");
  return r.ok ? { ...r, at: Date.now() } : r;
}

// Public cached entry point. The /blindspots page and the weekly digest
// cron both call this identical signature — the cache layer is invisible
// from the call site. Still THROWS on failure (unchanged contract): the
// digest cron, the social cron and rss/[topic] depend on that — they each
// catch it themselves (the digest cron sends its stories without the Kör Nokta
// and counts a substep error, h126-digest-1; the social cron skips). On a
// cache-attempt failure this retries the query
// live once (bypassing the cache boundary; the live result is not memoised,
// the cached ok:false result is) before letting a genuine, still-failing
// outage propagate as a throw.
//
// Reader calls (pages, feeds) are additionally stale-if-error and
// single-flight, keyed "blindspots:reader": when the attempt AND the live
// retry both fail, the last good result this instance saw (under 60 min old)
// is served instead of the throw, concurrent live retries share one read,
// and a failed read cools down for 5 s. Batch calls (the crons) pass no key:
// they never get stale data and never coalesce.
//
// The live retry waits for a request scope first (resolveCachedOrThrow ->
// awaitRequestScope): during a prerender it postpones instead of fetching
// live, which is safe because crons and route handlers already have one.
export async function getBlindspots(
  opts?: { profile?: ReadProfile },
): Promise<BlindspotsData> {
  const profile = opts?.profile ?? "reader";
  return resolveCachedOrThrow(
    {
      label: "blindspots-query",
      key: profile === "reader" ? "blindspots:reader" : undefined,
    },
    () => getBlindspotsCached(profile),
    () => fetchBlindspots(profile),
  );
}

export type BlindspotsResult = ({ ok: true } & BlindspotsData) | { ok: false };

/**
 * Never-throw wrapper for /blindspots' page component — sits OUTSIDE the
 * cache boundary (mirroring search-query.ts's searchClusters) so a failure
 * is never memoised as "no blindspots" for the cache window.
 */
export async function getBlindspotsSafe(): Promise<BlindspotsResult> {
  try {
    return { ok: true, ...(await getBlindspots()) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[blindspots] unavailable: ${message}`);
    return { ok: false };
  }
}
