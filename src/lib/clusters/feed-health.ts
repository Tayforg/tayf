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

/** A zone counts as degraded below this share of healthy active feeds. */
export const FEED_HEALTH_MIN_SHARE = 0.7;

/** A feed's last successful fetch must be within this window to count as healthy. */
export const FEED_HEALTH_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export type ZoneHealth = {
  total: number;
  healthy: number;
  healthyShare: number;
  degraded: boolean;
};

export type ZoneFeedHealth = Record<MediaDnaZone, ZoneHealth>;

type SourceHealthRow = {
  bias: BiasCategory;
  fetch_last_status: number | null;
  fetch_last_at: string | null;
};

function emptyZoneHealth(): ZoneHealth {
  return { total: 0, healthy: 0, healthyShare: 0, degraded: true };
}

/**
 * A source counts as healthy when its last fetch returned 200/304 AND that
 * fetch happened within `FEED_HEALTH_MAX_AGE_MS` of now. A 200 from three
 * hours ago is stale — the feed may have died since — so it is counted
 * unhealthy exactly like a 5xx would be.
 */
function isHealthyRow(row: SourceHealthRow, nowMs: number): boolean {
  if (row.fetch_last_status !== 200 && row.fetch_last_status !== 304) {
    return false;
  }
  if (!row.fetch_last_at) return false;
  const ageMs = nowMs - new Date(row.fetch_last_at).getTime();
  return ageMs <= FEED_HEALTH_MAX_AGE_MS;
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
    const { data, error } = await supabase
      .from("sources")
      .select("bias, fetch_last_status, fetch_last_at")
      .eq("active", true)
      .not("rss_url", "is", null);

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

    const nowMs = Date.now();
    for (const row of rows) {
      const bucket = health[zoneOf(row.bias)];
      bucket.total += 1;
      if (isHealthyRow(row, nowMs)) bucket.healthy += 1;
    }

    for (const zone of Object.keys(health) as MediaDnaZone[]) {
      const bucket = health[zone];
      bucket.healthyShare = bucket.total > 0 ? bucket.healthy / bucket.total : 0;
      bucket.degraded =
        bucket.healthy === 0 || bucket.healthyShare < FEED_HEALTH_MIN_SHARE;
    }

    return health;
  } catch (err) {
    console.warn(
      `[feed-health] health unknown: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
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
