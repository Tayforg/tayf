import { cacheLife, cacheTag } from "next/cache";

import { zoneOf } from "@/lib/bias/config";
import { createServerClient } from "@/lib/supabase/server";
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
 * 200/304 within `FEED_HEALTH_MAX_AGE_MS` (the "fetch status" axis). */
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
  /** Status 200/304 within `FEED_HEALTH_MAX_AGE_MS` (the old `healthy`). */
  fetchOk: number;
  fetchOkShare: number;
  /** >=1 article published in the trailing `FEED_YIELD_WINDOW_MS`. */
  delivering: number;
  deliveringShare: number;
  /** fetchOk AND delivering — the two-axis AND rule. */
  healthy: number;
  healthyShare: number;
  degraded: boolean;
};

export type ZoneFeedHealth = Record<MediaDnaZone, ZoneHealth>;

type SourceHealthRow = {
  bias: BiasCategory;
  fetch_last_status: number | null;
  fetch_last_at: string | null;
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
 */
function isFetchOkRow(row: SourceHealthRow, nowMs: number): boolean {
  if (row.fetch_last_status !== 200 && row.fetch_last_status !== 304) {
    return false;
  }
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
 * Per-zone feed health across every active, RSS-backed source. `null`
 * means "health unknown" (a Supabase error) — callers must fail OPEN on
 * null, i.e. behave exactly as if this function did not exist.
 */
export async function getZoneFeedHealth(): Promise<ZoneFeedHealth | null> {
  "use cache";
  cacheLife("source-directory");
  cacheTag("sources");

  try {
    const supabase = createServerClient();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const yieldSince = new Date(nowMs - FEED_YIELD_WINDOW_MS).toISOString();
    const { data, error } = await supabase
      .from("sources")
      .select("bias, fetch_last_status, fetch_last_at, recent:articles(id)")
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
      if (delivering) bucket.delivering += 1;
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

/**
 * The per-zone yield denominator: how many active, RSS-backed sources in
 * `zone` actually delivered in the trailing `FEED_YIELD_WINDOW_MS`, per
 * `getZoneFeedHealth()`. Currently used only by this module's own test
 * suite (feed-health.test.ts) — despite an earlier version of this comment
 * claiming otherwise, /kaynaklar/durum and the /sources and /blindspots
 * share footnotes do NOT read the denominator from here; they compute
 * their own directory-wide (not per-zone) N/M pair via
 * `summariseFeedStatus()` / `getFeedStatusSummary()` in
 * src/lib/sources/feed-status.ts (verified by grep — nothing outside this
 * file's test imports `zoneYieldDenominator`).
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
