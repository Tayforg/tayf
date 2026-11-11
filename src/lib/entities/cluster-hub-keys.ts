import { RISING_ENTITIES, type RisingEntity } from "@/lib/trends/rising-entities";
import {
  entityHubHeadlineOnly,
  entityHubPatterns,
  entityHubSpec,
  foldEntityText,
} from "./entity-hub";

// The /gundem entity hubs a story names (h136-roadmap-1). Pure helpers: no I/O,
// no clock, no Next import. Two readers share this module:
//   * the story page (src/app/cluster/[id]/page.tsx), through clusterHubKeys /
//     clusterHubKeysFromDetail, to link the hubs the headline names;
//   * related-clusters.ts, which scores two titles by the keys they share and
//     imports the matcher lists below instead of building its own.
//
// The matching rule is the hub's. entity_cluster_ids_v3 (migration 170) runs
// entityHubPatterns(entity) as PostgreSQL regexes on the folded text of a
// cluster; here the same patterns run as JavaScript regexes on the same text,
// with the only translation the shared toRegExps below (the PostgreSQL word
// anchors \m and \M are \b in JavaScript). The patterns are the hub's DEFAULT
// spec, so `requires` (meclis, tcmb), `excludes`, `hubExcludes` (the foreign
// vetoes of the generic-word hubs, #269), `notAfter` and `quantityGuard` all
// apply, and a headline-only hub (akp) reads the two titles and nothing else.
//
// What the JS result is not (so a reader of this file does not over-trust it):
//   * The RPC ALSO needs a stemmed search_tsv tsquery hit (the recall prefilter on
//     `p_queries`) which a regex cannot reproduce. A story the regex accepts but
//     the stemmer misses is not on the hub, so the JS result is a SMALL SUPERSET
//     of the hub's membership (the 14-day measure is in entity-hub.ts: a prefilter
//     ceiling one row above the listed count on meclis, equal on the rest).
//   * The hub windows on clusters.updated_at (14 days) and lists the newest 20 of
//     the matches. A chip on an old story's page can therefore lead to a hub that
//     no longer lists it (or never listed it among its newest 20). That is why the
//     chips say "Bu haberdeki gündem başlıkları" (the topics this story names) and
//     never that the story is listed there.
//
// Measured read-only on production, 2026-11-11 ~20:45Z, with the app's exact
// queries and patterns (entityHubQueries, entityHubPatterns, headline-only for
// akp) through entity_cluster_ids_v3 and the body of that function as a plain select:
//   * the 200 most recently updated live clusters (an 11-hour span) carry 197 chips;
//     the hubs' membership among those 200 is the same 197 (cluster, hub) pairs, so
//     chips equal membership both ways: 0 chips to a hub that does not match the
//     story and 0 matches without a chip. The stemmed prefilter dropped none of them.
//   * the other way round, the newest 50 stories of each of the 58 non-empty hubs
//     (1,477 listings, chp 50 of 50 and akp 50 of 50 among them) all carry their
//     hub's key: 0 misses without the cap, 4 with the cap of five (stories naming
//     six or more hubs).
//   * of the 197 chips, 168 sit on a hub whose DISPLAYED list (the newest 20)
//     holds the story and 196 on one whose newest 50 does; the 29 others are
//     matches that the hub counts ("Son 14 günde N küme") but does not show, 27 of
//     them erdogan (453 clusters in 14 days, 20 shown), 1 akp and 1 meclis.

/**
 * Most chips a story page shows. Five, because the stories that name a hub name few:
 * over the newest 50 stories of each of the 58 non-empty hubs (1,098 distinct
 * stories, same read) 521 name one hub, 396 two, 125 three, 41 four, 10 five, 4 six
 * and 1 seven, so five shows every hub of 99.5% of them (p95 four) and drops the
 * later entries of RISING_ENTITIES order (countries, topics) only from the five that
 * name six or more. A 320 px text column on a phone holds two or three chips a row,
 * so five chips are three rows (44 px each) at the very most; the cap bounds how far
 * the chips push the summary down. The median story shows one chip, the p95 two
 * (the 200 newest stories: 84 with one, 40 with two, 9 with three to five).
 */
export const CLUSTER_HUB_KEYS_MAX = 5;

/**
 * The text a story is tested on is cut at this many characters (titles are 60 to
 * 150, a summary lead a few hundred). It only bounds the work on a pathological
 * summary: the RPC reads the whole first line, so a name or a veto cue that sits
 * past this point is not seen here.
 */
export const CLUSTER_HUB_TEXT_MAX_CHARS = 2000;

export interface EntityMatcher {
  key: string;
  patterns: readonly RegExp[];
}

/** An {@link EntityMatcher} with the hub's text mode: true = titles only (akp). */
export interface HubMatcher extends EntityMatcher {
  headlineOnly: boolean;
}

/**
 * The hub's PostgreSQL patterns as JavaScript regexes: only the word anchors
 * \m and \M differ, and \b stands for both (the twin entity-hub.test.ts uses).
 * Patterns come from curated data only, never from a title.
 */
export function toRegExps(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p.replace(/\\[mM]/g, "\\b")));
}

let hubMatcherList: readonly HubMatcher[] | null = null;
let stemMatcherList: readonly EntityMatcher[] | null = null;

/**
 * One matcher per curated entity, in RISING_ENTITIES order, built once on first
 * use from the hub's own default spec (requires and hubExcludes included).
 */
export function hubMatchers(): readonly HubMatcher[] {
  if (hubMatcherList === null) {
    hubMatcherList = RISING_ENTITIES.map((entity: RisingEntity) => ({
      key: entity.key,
      patterns: toRegExps(entityHubPatterns(entity)),
      headlineOnly: entityHubHeadlineOnly(entity),
    }));
  }
  return hubMatcherList;
}

/**
 * The same matchers without the hub's `requires` cue and without its hub-only
 * foreign veto `hubExcludes` (the shared `excludes` and every other guard
 * stay). They decide only whose WORDS are excluded from the shared stems of two
 * titles, never whether a title carries the entity key. Like `requires`, a
 * hub-only foreign veto withholds the KEY ("Çin borsası" is not the Borsa hub),
 * but the entity's words are still not "the shared stem": otherwise "borsa" or
 * "enflasyon" alone would relate "Çin borsası sert düştü" to a Chinese
 * bourse-regulator story (h129; the h37-clusters-1 rule).
 */
export function stemMatchers(): readonly EntityMatcher[] {
  if (stemMatcherList === null) {
    stemMatcherList = RISING_ENTITIES.map((entity: RisingEntity) => ({
      key: entity.key,
      patterns: toRegExps(
        entityHubPatterns(entity, {
          ...entityHubSpec(entity),
          requires: undefined,
          hubExcludes: undefined,
        }),
      ),
    }));
  }
  return stemMatcherList;
}

/** The cluster columns the hub RPC reads, plus its three eligibility columns. */
export interface ClusterHubRow {
  title_tr: string | null;
  title_tr_neutral: string | null;
  summary_tr: string | null;
  article_count: number;
  is_archived: boolean;
  merged_into: string | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The keys of the hubs a cluster names, in RISING_ENTITIES order, at most `max`
 * (default {@link CLUSTER_HUB_KEYS_MAX}). [] unless the cluster is one a hub
 * lists at all: article_count >= 2, not archived, not merged away (migration
 * 170's own predicate).
 *
 * The text is the RPC's: title_tr, a space, title_tr_neutral, and, unless the
 * hub is headline-only (akp), a space and the FIRST LINE of summary_tr. It is cut
 * at {@link CLUSTER_HUB_TEXT_MAX_CHARS}, then folded like migration 112
 * (foldEntityText), and tested against the hub's patterns. The cut comes before the
 * fold because the fold never changes a length, and it bounds the work.
 *
 * A superset of the hub's membership by the stemmed prefilter and a story the
 * hub's 14-day, newest-20 window no longer shows: see the header of this file.
 */
export function clusterHubKeys(c: ClusterHubRow, max: number = CLUSTER_HUB_KEYS_MAX): string[] {
  if (c === null || typeof c !== "object") return [];
  if (typeof c.article_count !== "number" || !(c.article_count >= 2)) return [];
  if (c.is_archived) return [];
  if (c.merged_into !== null && c.merged_into !== undefined) return [];

  const cap = Number.isNaN(max) ? CLUSTER_HUB_KEYS_MAX : Math.max(0, Math.floor(max));
  if (cap === 0) return [];

  const titles = `${text(c.title_tr)} ${text(c.title_tr_neutral)}`;
  // split with a limit of 1 stops at the first line break, like split_part(.., E'\n', 1).
  const lead = text(c.summary_tr).split("\n", 1)[0] ?? "";
  let headlineText: string | null = null;
  let leadText: string | null = null;

  const keys: string[] = [];
  for (const m of hubMatchers()) {
    let folded: string;
    if (m.headlineOnly) {
      headlineText ??= foldEntityText(titles.slice(0, CLUSTER_HUB_TEXT_MAX_CHARS));
      folded = headlineText;
    } else {
      leadText ??= foldEntityText(`${titles} ${lead}`.slice(0, CLUSTER_HUB_TEXT_MAX_CHARS));
      folded = leadText;
    }
    if (m.patterns.some((re) => re.test(folded))) {
      keys.push(m.key);
      if (keys.length >= cap) break;
    }
  }
  return keys;
}

/**
 * The cluster of the story page (ClusterDetail["cluster"]) in the shape the RPC
 * reads. `title_tr` there is the DISPLAYED headline (the neutral rewrite when
 * there is one), and `title_original` is the outlet's original, set only when a
 * rewrite replaced it; the RPC reads the stored pair, so the two are mapped
 * back: original in title_tr and the rewrite in title_tr_neutral. With no
 * rewrite the single title stands alone (the stored neutral title is then empty
 * or the same text, and a repeated text changes no regex outcome).
 *
 * Two small differences from the stored row stay, both toward the page showing
 * a chip the hub lists a moment later or not at all, never a wrong name: the
 * page's article_count is the deduplicated member count (the RPC reads the stored
 * one), and a neutral title the page picked from the member headlines before the
 * headline cron wrote it (cluster-detail-query.ts, h42-latency-1) is not stored yet.
 */
export interface ClusterHubDetailRow {
  title_tr: string;
  title_original: string | null;
  summary_tr: string | null;
  article_count: number;
  is_archived: boolean;
  merged_into?: string | null;
}

export function clusterHubKeysFromDetail(
  c: ClusterHubDetailRow,
  max: number = CLUSTER_HUB_KEYS_MAX,
): string[] {
  if (c === null || typeof c !== "object") return [];
  const rewritten = typeof c.title_original === "string" && c.title_original !== "";
  return clusterHubKeys(
    {
      title_tr: rewritten ? c.title_original : c.title_tr,
      title_tr_neutral: rewritten ? c.title_tr : null,
      summary_tr: c.summary_tr,
      article_count: c.article_count,
      is_archived: c.is_archived,
      merged_into: c.merged_into ?? null,
    },
    max,
  );
}
