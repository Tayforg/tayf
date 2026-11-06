import { cacheLife, cacheTag } from "next/cache";

import { isVotingKind, zoneOf } from "@/lib/bias/config";
import {
  createReaderClient,
  createServerClient,
  type ReadProfile,
} from "@/lib/supabase/server";
import type { BiasCategory, MediaDnaZone } from "@/types";

// Per-zone RSS feed health, read from `sources.fetch_last_status` /
// `fetch_last_at` (written every ~3 minutes by
// supabase/functions/ingest/index.ts via `ingest_set_source_fetch_state`,
// migration 041's own comment anticipated this: "not read by any query
// path" — this module is the first reader).
//
// Why this exists: a blindspot ("kör nokta") claim says "this zone chose
// not to cover the story". If that zone's feeds are actually broken (dead
// RSS, 4xx/5xx, or simply haven't delivered in hours), the silence is an
// infrastructure failure, not an editorial choice. `shouldSuppressBlindspot`
// below is the read-path-only gate every blindspot-rendering surface calls
// before trusting `is_blindspot` / `blindspot_side` as read from the DB.
// This module never writes those columns — see politics-query.ts,
// search-query.ts and their siblings for the read-path application.
//
// Fail-open discipline (mirrors src/lib/sources/active-count.ts verbatim):
// never throw. A Supabase error means "health unknown", and every caller
// must treat null as "do not suppress" — failing closed here would empty
// the whole /blindspots feed (and the weekly digest's featured slot) on a
// single transient Supabase blip, which is a bigger, more visible
// regression than a brief unverified claim.
//
// Two-axis "healthy" (status AND yield): a source can answer HTTP 200/304
// on schedule while its upstream has quietly stopped publishing (dead CMS,
// re-pointed RSS, silently empty feed) — the crawler never sees an error,
// so the status axis alone reads "healthy" for a feed that has delivered
// nothing. `getZoneFeedHealth` therefore also probes whether the source
// delivered >=1 article in the trailing `FEED_YIELD_WINDOW_MS` (the
// "yield"), using the same embedded existence-probe pattern
// src/lib/sources/active-count.ts already uses (`recent:articles(id)` +
// `.limit(1, { referencedTable: "recent" })`, served by
// idx_articles_source_published from migration 044, ~11 ms — never the
// `stats:articles(count)` per-source aggregate that costs ~4.5 s). A
// source counts as healthy only when BOTH axes are true.

/** A zone counts as degraded below this share of feeds that answered
 * 200/304 (with `fetch_fail_streak` 0) within `FEED_HEALTH_MAX_AGE_MS` (the
 * "fetch status" axis). */
export const FEED_HEALTH_MIN_SHARE = 0.7;

/** A feed's last successful fetch must be within this window to count as fetch-ok. */
export const FEED_HEALTH_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** The trailing window a source must have delivered >=1 article in to
 * count as "delivering" (the yield axis). */
export const FEED_YIELD_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * A zone counts as degraded on the yield axis below this share of active
 * sources that delivered >=1 article in `FEED_YIELD_WINDOW_MS`.
 *
 * Evidence (threshold step, pack A / M-01, measured via `sbq.py` against
 * production `sources`/`articles`, 2026-09-18), grouped by bias and mapped
 * to zone via `BIAS_TO_ZONE`:
 *
 *   iktidar   = pro_government (17 total / 15 fetchOk / 12 delivering)
 *             + gov_leaning    (19 total / 14 fetchOk / 12 delivering)
 *             = 36 total, 29 fetchOk (80.6%), 24 delivering (66.7%)
 *   bagimsiz  = center          (57 total / 49 fetchOk / 33 delivering)
 *             = 57 total, 49 fetchOk (86.0%), 33 delivering (57.9%)
 *   muhalefet = opposition          (7 total /  6 fetchOk /  5 delivering)
 *             + opposition_leaning (18 total / 15 fetchOk / 10 delivering)
 *             = 25 total, 21 fetchOk (84.0%), 15 delivering (60.0%)
 *
 * A single 0.7 gate against the AND-rule `healthyShare` would put every
 * zone permanently degraded (worst-case pole yield is 60%), which would
 * make `shouldSuppressBlindspot()` fire on every render and silently empty
 * /blindspots. Splitting `degraded` onto two independent axes (see
 * `getZoneFeedHealth` below) and setting this constant to 0.5 keeps BOTH
 * pole zones non-degraded on the numbers above with >=0.05 headroom
 * (muhalefet: 0.60 - 0.5 = 0.10; iktidar: 0.667 - 0.5 = 0.167) — the
 * measured-per-zone pin test in feed-health.test.ts asserts that headroom
 * stays loud if production drifts.
 */
export const FEED_HEALTH_MIN_YIELD_SHARE = 0.5;

export type ZoneHealth = {
  /** Active, RSS-backed sources in the zone. */
  total: number;
  /** Status 200/304 within `FEED_HEALTH_MAX_AGE_MS` with no fail streak (the old `healthy`). */
  fetchOk: number;
  fetchOkShare: number;
  /** >=1 article published in the trailing `FEED_YIELD_WINDOW_MS`, every
   * source kind included (aggregator and niche feeds too — /hafta labels this
   * count "toplayıcı / niş dahil"). Gates `degraded` via `deliveringShare`. */
  delivering: number;
  /** The `delivering` subset whose kind votes in bias_distribution
   * (`isVotingKind`: outlet and wire; a null, missing or unknown kind counts as
   * outlet). The only denominator that shares a basis with a voting-members-only
   * numerator such as the Manşet Kartı's per-zone count; reporting-only, it
   * never feeds `degraded`. Always <= `delivering`. */
  votingDelivering: number;
  deliveringShare: number;
  /** fetchOk AND delivering — the two-axis AND rule. */
  healthy: number;
  healthyShare: number;
  degraded: boolean;
};

export type ZoneFeedHealth = Record<MediaDnaZone, ZoneHealth>;

type SourceHealthRow = {
  bias: BiasCategory;
  /**
   * `sources.kind`. `unknown` and optional for the same reason as `recent`
   * (unchecked cast over raw PostgREST output; legacy rows and test doubles
   * omit it): `isVotingKind` reads an absent, null or unrecognised value as a
   * voting `outlet`, so a missing kind never drops a source from the voting
   * count.
   */
  kind?: unknown;
  fetch_last_status: number | null;
  fetch_last_at: string | null;
  /**
   * `sources.fetch_fail_streak`. Optional at the type level for the same
   * reason as `recent` (unchecked cast over raw PostgREST output; legacy rows
   * and test doubles omit it): an absent or null value reads as 0.
   */
  fetch_fail_streak?: number | null;
  /**
   * Existence-probe embed: at most one row, never a count. Optional at the
   * type level — the value comes from an unchecked `as SourceHealthRow[]`
   * cast over raw PostgREST output below, so a future select that drops or
   * renames the alias must degrade to "not delivering" instead of a
   * TypeError (SEC-01).
   */
  recent?: Array<{ id: string }>;
};

function emptyZoneHealth(): ZoneHealth {
  return {
    total: 0,
    fetchOk: 0,
    fetchOkShare: 0,
    delivering: 0,
    votingDelivering: 0,
    deliveringShare: 0,
    healthy: 0,
    healthyShare: 0,
    degraded: true,
  };
}

/**
 * A source counts as fetch-ok when its last fetch returned 200/304 AND
 * that fetch happened within `FEED_HEALTH_MAX_AGE_MS` of now. A 200 from
 * three hours ago is stale — the feed may have died since — so it is
 * counted not-ok exactly like a 5xx would be.
 *
 * A 200/304 with `fetch_fail_streak > 0` is not fetch-ok either. ingest stores
 * the 2xx status of an unparseable body (an HTML page instead of a feed) and
 * counts it as a failure; only a parsed 2xx/304 resets the streak to 0. So a
 * success code next to a positive streak means the last answer was refused.
 * Without this check such a feed, quarantined and retried once a day, re-stamps
 * `fetch_last_at` on every retry and inflates its zone's `fetchOkShare` for the
 * next `FEED_HEALTH_MAX_AGE_MS`. A null or absent streak (legacy rows, test
 * doubles) reads as 0.
 */
function isFetchOkRow(row: SourceHealthRow, nowMs: number): boolean {
  if (row.fetch_last_status !== 200 && row.fetch_last_status !== 304) {
    return false;
  }
  if ((row.fetch_fail_streak ?? 0) > 0) return false;
  if (!row.fetch_last_at) return false;
  const ageMs = nowMs - new Date(row.fetch_last_at).getTime();
  return ageMs <= FEED_HEALTH_MAX_AGE_MS;
}

/**
 * A source counts as delivering when the `recent` existence-probe embed
 * returned >=1 row, i.e. it published at least one article in the
 * trailing `FEED_YIELD_WINDOW_MS`. `row.recent` is optional at the type
 * level (see `SourceHealthRow`), so this defends against an absent key,
 * not just an empty array.
 */
function isDeliveringRow(row: SourceHealthRow): boolean {
  return (row.recent?.length ?? 0) > 0;
}

/**
 * Pure — the SEC-02 two-axis-plus-floor `degraded` rule, extracted so it is
 * directly unit-testable against a hand-built `{ healthy, fetchOkShare,
 * deliveringShare }` triple. Illustrative note: because
 * `FEED_HEALTH_MIN_SHARE + FEED_HEALTH_MIN_YIELD_SHARE` (0.7 + 0.5 = 1.2)
 * exceeds 1, a real query result can never have BOTH `fetchOkShare` and
 * `deliveringShare` clear their thresholds while `healthy` is 0 (pigeonhole:
 * the fetch-ok and delivering sets are forced to overlap) — the `healthy
 * === 0` floor is therefore a defensive backstop against a future change to
 * either threshold constant, not something today's production data can
 * trigger on its own (see the pinned per-zone numbers in the test below).
 * `healthyShare` itself is reporting-only and never gates `degraded`.
 */
export function isZoneDegraded(
  healthy: number,
  fetchOkShare: number,
  deliveringShare: number,
): boolean {
  return (
    healthy === 0 ||
    fetchOkShare < FEED_HEALTH_MIN_SHARE ||
    deliveringShare < FEED_HEALTH_MIN_YIELD_SHARE
  );
}

/**
 * The uncached, never-throwing computation. `null` means "health unknown"
 * (a Supabase error, an AbortError from the 4 s reader cap, or a client
 * construction failure). The clock is read in here, inside the cache scope
 * of `getZoneFeedHealthCached` below.
 */
async function computeZoneFeedHealth(
  profile: ReadProfile,
): Promise<ZoneFeedHealth | null> {
  try {
    // "reader" (pages) fails fast at 4 s; "batch" (social + alerts-webhooks
    // crons, reached through their shared fetchers) keeps the plain client so
    // a cold read can use the 8 s statement_timeout instead of skipping the
    // run.
    const supabase =
      profile === "batch" ? createServerClient() : createReaderClient();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const yieldSince = new Date(nowMs - FEED_YIELD_WINDOW_MS).toISOString();
    const { data, error } = await supabase
      .from("sources")
      .select(
        "bias, kind, fetch_last_status, fetch_last_at, fetch_fail_streak, recent:articles(id)",
      )
      .eq("active", true)
      .not("rss_url", "is", null)
      .gte("recent.published_at", yieldSince)
      // SEC-01: bound the probe on both sides. Without this upper bound, a
      // source-controlled future pubDate (confirmed live in production —
      // see supabase/functions/_shared/rss/normalize.ts's unclamped
      // `parseDate()`) satisfies `published_at >= now-72h` forever and
      // counts as permanently delivering, which can keep a zone's
      // `deliveringShare` propped up and `degraded` false regardless of
      // reality.
      .lte("recent.published_at", nowIso)
      .limit(1, { referencedTable: "recent" });

    if (error) {
      // Never throw — see the file header. A "use cache" throw during
      // prerender fails the Vercel build even though callers catch.
      console.warn(`[feed-health] health unknown: ${error.message}`);
      return null;
    }

    const rows = (data ?? []) as SourceHealthRow[];
    const health: ZoneFeedHealth = {
      iktidar: emptyZoneHealth(),
      bagimsiz: emptyZoneHealth(),
      muhalefet: emptyZoneHealth(),
    };

    for (const row of rows) {
      const bucket = health[zoneOf(row.bias)];
      bucket.total += 1;
      const fetchOk = isFetchOkRow(row, nowMs);
      const delivering = isDeliveringRow(row);
      if (fetchOk) bucket.fetchOk += 1;
      if (delivering) {
        bucket.delivering += 1;
        // Same predicate every voting surface uses (zone-line.ts, the cluster
        // page, bias_distribution): outlet and wire vote, aggregator and niche
        // do not, a null / absent / unknown kind is an outlet. Counted inside
        // the delivering branch so votingDelivering is always a subset.
        if (isVotingKind(row.kind)) bucket.votingDelivering += 1;
      }
      if (fetchOk && delivering) bucket.healthy += 1;
    }

    for (const zone of Object.keys(health) as MediaDnaZone[]) {
      const bucket = health[zone];
      bucket.fetchOkShare = bucket.total > 0 ? bucket.fetchOk / bucket.total : 0;
      bucket.deliveringShare =
        bucket.total > 0 ? bucket.delivering / bucket.total : 0;
      bucket.healthyShare = bucket.total > 0 ? bucket.healthy / bucket.total : 0;
      // SEC-02: restore the `healthy === 0` floor the old single-axis rule
      // had (`bucket.healthy === 0 || bucket.healthyShare < ...`) — see
      // `isZoneDegraded`'s doc comment for why it's a defensive floor
      // rather than something today's production data can trigger.
      bucket.degraded = isZoneDegraded(
        bucket.healthy,
        bucket.fetchOkShare,
        bucket.deliveringShare,
      );
    }

    return health;
  } catch (err) {
    console.warn(
      `[feed-health] health unknown: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// `profile` is an argument on purpose: it becomes part of the `"use cache"`
// key, so a capped "reader" entry (and a cached `null` from a 4 s abort) is
// never served to a "batch" cron, and the cron's own miss runs uncapped.
//
// Exactly ONE `cacheLife` per invocation, chosen after the compute: a `null`
// (health unknown) is cached only for the short `minutes` lifetime so one
// blip does not blank the blindspot feed-health gate for the whole
// `source-directory` window; a real result keeps the normal lifetime.
// `cacheTag` is called before the await. The body never throws (a throw
// across the cache boundary fails `next build`'s prerender).
async function getZoneFeedHealthCached(
  profile: ReadProfile,
): Promise<ZoneFeedHealth | null> {
  "use cache: remote";
  cacheTag("sources");
  const health = await computeZoneFeedHealth(profile);
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (health === null) cacheLife("minutes");
  else cacheLife("source-directory");
  return health;
}

/**
 * Per-zone feed health across every active, RSS-backed source. `null`
 * means "health unknown" (a Supabase error) — callers must fail OPEN on
 * null, i.e. behave exactly as if this function did not exist.
 *
 * Uncached public entry: serves BOTH pages and crons (via politics-query /
 * blindspots-query and the social + alerts-webhooks crons directly), so it
 * takes a `ReadProfile` like those fetchers. Defaults to the capped
 * "reader"; crons pass `{ profile: "batch" }`. The profile is forwarded as a
 * string, never the options object, so it is a stable cache-key argument.
 */
export async function getZoneFeedHealth(opts?: {
  profile?: ReadProfile;
}): Promise<ZoneFeedHealth | null> {
  return getZoneFeedHealthCached(opts?.profile ?? "reader");
}

/**
 * The per-zone ALL-KINDS yield count: how many active, RSS-backed sources in
 * `zone` of ANY kind (aggregator and niche feeds included) actually delivered
 * in the trailing `FEED_YIELD_WINDOW_MS`, per `getZoneFeedHealth()`.
 *
 * Callers: the /hafta zone rows (src/components/weekly/week-sections.tsx,
 * which labels the figure "toplayıcı / niş dahil") and the /rapor coverage
 * section (src/lib/reports/yelpaze.ts, whose numerator is likewise every
 * member of the zone, whatever its kind). Both pair it with an all-kinds
 * numerator, so its meaning must not change.
 *
 * Do NOT use it under a numerator that counts voting sources only (the Manşet
 * Kartı's "N / M kaynak"): the two would not share a basis and the fraction
 * is understated by every delivering aggregator and niche feed. Use
 * `zoneVotingYieldDenominator` there.
 *
 * (/kaynaklar/durum and the /sources and /blindspots share footnotes read
 * neither helper: they compute their own directory-wide, not per-zone, N/M
 * pair via `summariseFeedStatus()` / `getFeedStatusSummary()` in
 * src/lib/sources/feed-status.ts.)
 *
 * `null` when `health` is null (health unknown) — callers must render the
 * wording-without-numbers fallback rather than fabricate a figure.
 */
export function zoneYieldDenominator(
  health: ZoneFeedHealth | null,
  zone: MediaDnaZone,
): number | null {
  if (!health) return null;
  return health[zone].delivering;
}

/**
 * The per-zone VOTING yield denominator: how many active, RSS-backed sources
 * in `zone` whose kind votes in bias_distribution (outlet, wire — see
 * `isVotingKind`) delivered in the trailing `FEED_YIELD_WINDOW_MS`. This is
 * the denominator for any "N / M" whose N counts voting sources only, such as
 * the Manşet Kartı (src/lib/cards/story-card.ts buckets voting members into
 * zones and leaves aggregator and niche members out). Taking both from the
 * voting set is what keeps the fraction honest: a Bağımsız zone with 24
 * voting and 13 non-voting delivering feeds reads "2 / 24", not "2 / 37".
 *
 * `null` when `health` is null (health unknown); `0` is a real answer (no
 * voting source in the zone delivered) and callers must tell it apart from
 * null.
 */
export function zoneVotingYieldDenominator(
  health: ZoneFeedHealth | null,
  zone: MediaDnaZone,
): number | null {
  if (!health) return null;
  return health[zone].votingDelivering;
}

// The two Medya DNA "pole" zones the blindspot contract cares about.
// `bagimsiz` is deliberately excluded here — NOT because the contract
// restricts which zone can dominate (it doesn't: `dominantZone` can be
// "bagimsiz" too, e.g. a story covered >=80% by center/international/
// pro_kurdish outlets is a valid blindspot). `bagimsiz` is excluded because
// it is never the "silent side" of a blindspot narrative — only iktidar/
// muhalefet are meaningful opposite poles, so a degraded `bagimsiz` zone
// alone must never suppress anything.
const POLE_ZONES: readonly MediaDnaZone[] = ["iktidar", "muhalefet"];

/**
 * True when a blindspot claim for `dominantZone` should be withheld
 * because another pole zone's feeds are too broken for its silence to mean
 * anything.
 *
 * Contract semantics (per 032_blindspot_contract_recompute.sql:21-23):
 * `blindspot_side` names the bias category — and therefore the zone — that
 * DID cover the story (the dominant one), not the side that stayed silent.
 * The silent side is the OPPOSITE pole from `dominantZone`. Getting this
 * backwards inverts the whole gate: it would suppress the claim when the
 * covering zone's own feeds are shaky (irrelevant) and stay silent when the
 * actually-absent zone is the one that's broken (exactly the honesty gap
 * this pack closes).
 *
 * Pure and total: `false` whenever health is unknown (null/undefined) —
 * fail open, never suppress on missing data.
 */
export function shouldSuppressBlindspot(
  dominantZone: MediaDnaZone,
  health: ZoneFeedHealth | null | undefined,
): boolean {
  if (!health) return false;
  for (const zone of POLE_ZONES) {
    if (zone === dominantZone) continue;
    if (health[zone].degraded) return true;
  }
  return false;
}

/**
 * The single pole zone (iktidar/muhalefet) responsible for a suppressed
 * blindspot's silence — the first `POLE_ZONES` entry that is not
 * `dominantZone` and is degraded. Every blindspot-suppression log line
 * shares this one lookup so the three call sites (blindspots-query.ts,
 * cluster-detail-query.ts, politics-query.ts) can't drift on which zone
 * they name.
 *
 * Returns `null` when no pole zone is degraded — this can't happen right
 * after `shouldSuppressBlindspot(dominantZone, health)` has returned
 * `true` (same underlying condition), but callers must still handle it by
 * logging without a zone rather than inventing one.
 */
export function degradedSilentZone(
  dominantZone: MediaDnaZone,
  health: ZoneFeedHealth,
): MediaDnaZone | null {
  for (const zone of POLE_ZONES) {
    if (zone !== dominantZone && health[zone].degraded) return zone;
  }
  return null;
}
