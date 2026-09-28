import { parseLimit } from "@/lib/api/v1-clusters";
import { PICKUP_WINDOW_HOURS } from "@/lib/finance/kap-pickup";
import type { TickerPickup } from "@/lib/finance/kap-pickup-query";

/**
 * kap-media-pickup — `GET /api/v1/kap/pickup` param parsing + wire mapping.
 *
 * `toV1PickupBody` names every field it copies off `TickerPickup` — no
 * article id/title/url is ever read here, mirroring v1-clusters.ts's
 * `toV1ClusterRecord` discipline (a reviewer has to add a new *read*, not
 * just widen a select string, to leak article content through this
 * endpoint).
 */

export const V1_PICKUP_DEFAULT_DAYS = 30;
export const V1_PICKUP_MAX_DAYS = 90;
const DAY_MS = 86_400_000;

export const PICKUP_TICKER_RE = /^[A-Z0-9]{2,6}$/;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

export interface PickupParams {
  ticker: string;
  sinceMs: number;
  nowMs: number;
  limit: number;
}

export function parsePickupParams(
  sp: URLSearchParams,
  now: Date,
): PickupParams | { error: string } {
  const nowMs = now.getTime();

  const rawTicker = sp.get("ticker");
  if (rawTicker === null || rawTicker.trim() === "") {
    return { error: "Invalid ticker" };
  }
  const ticker = rawTicker.trim().toUpperCase();
  if (!PICKUP_TICKER_RE.test(ticker)) {
    return { error: "Invalid ticker" };
  }

  const rawSince = sp.get("since");
  const floorMs = nowMs - V1_PICKUP_MAX_DAYS * DAY_MS;
  let sinceMs: number;
  if (rawSince === null || rawSince.trim() === "") {
    sinceMs = nowMs - V1_PICKUP_DEFAULT_DAYS * DAY_MS;
  } else {
    if (!ISO_RE.test(rawSince)) {
      return { error: "Invalid since: must be an ISO 8601 timestamp" };
    }
    const parsed = new Date(rawSince);
    if (Number.isNaN(parsed.getTime())) {
      return { error: "Invalid since: must be an ISO 8601 timestamp" };
    }
    if (parsed.getTime() > nowMs) {
      return { error: "Invalid since: must not be in the future" };
    }
    sinceMs = parsed.getTime() < floorMs ? floorMs : parsed.getTime();
  }

  const limitResult = parseLimit(sp.get("limit"));
  if (typeof limitResult !== "number") {
    return { error: limitResult.error };
  }

  return { ticker, sinceMs, nowMs, limit: limitResult };
}

export interface V1PickupDisclosure {
  disclosure_index: number;
  disclosed_at: string;
  subject: string | null;
  disclosure_class: string | null;
  kap_url: string;
  articles: number;
  outlets: number;
  first_lag_minutes: number | null;
  zones: Record<string, number>;
  sources: Array<{ slug: string; zone: string }>;
  window_complete: boolean;
  overlapping_disclosures: number;
}

export interface V1PickupBody {
  ticker: string;
  window_hours: number;
  since: string;
  until: string;
  relevance_filter: { task: string; min_prob: number; applied: boolean };
  truncated: boolean;
  totals: {
    disclosures: number;
    picked_up: number;
    pickup_rate: number | null;
    median_first_lag_minutes: number | null;
    outlets: number;
    zones: Record<string, number>;
  };
  count: number;
  disclosures: V1PickupDisclosure[];
}

export function toV1PickupBody(r: TickerPickup): V1PickupBody {
  return {
    ticker: r.ticker,
    window_hours: PICKUP_WINDOW_HOURS,
    since: r.since,
    until: r.until,
    relevance_filter: { task: "ticker_relevance", min_prob: 0.2, applied: r.relevanceApplied },
    truncated: r.truncated,
    totals: {
      disclosures: r.totals.disclosures,
      picked_up: r.totals.pickedUp,
      pickup_rate: r.totals.pickupRate,
      median_first_lag_minutes: r.totals.medianFirstLagMinutes,
      outlets: r.totals.outlets,
      zones: r.totals.zones,
    },
    count: r.pickups.length,
    disclosures: r.pickups.map((p) => ({
      disclosure_index: p.disclosureIndex,
      disclosed_at: p.disclosedAt,
      subject: p.subject,
      disclosure_class: p.disclosureClass,
      kap_url: p.kapUrl,
      articles: p.articles,
      outlets: p.outlets,
      first_lag_minutes: p.firstLagMinutes,
      zones: p.zones,
      sources: p.sources,
      window_complete: p.windowComplete,
      overlapping_disclosures: p.overlapping,
    })),
  };
}
