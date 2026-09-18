import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { apiError, apiServerError, withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import {
  registryEnvelope,
  toRegistryRecord,
  type RegistrySourceRow,
} from "@/lib/sources/registry";

/**
 * GET /api/sources — the public, attribution-licensed registry JSON (S-20 +
 * M-04). No auth (this is the surface `/llms.txt` points crawlers at), but
 * rate limited (B-SEC-05): a 60-token bucket refilling at 1/sec is generous
 * for a crawler/legit consumer while still bounding a scraping burst.
 *
 * Cache-Control is set explicitly on the `NextResponse` rather than via a
 * route-segment `revalidate` export — this is a Route Handler, not a
 * cached page, so the segment config wouldn't apply to the CDN response at
 * all and the header would silently do nothing.
 */
const REGISTRY_COLUMNS =
  "slug, name, url, bias, kind, active, zone_rationale, zone_rationale_at, trustee_since, trustee_note";

const REGISTRY_HEADERS = {
  "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
  "Content-Type": "application/json; charset=utf-8",
};

const sourcesJsonLimit = createRateLimiter("sources-json", {
  capacity: 60,
  refillPerSecond: 1,
});

export const GET = withApiErrors(async (request: Request) => {
  const rl = sourcesJsonLimit(clientKey(request));
  if (!rl.allowed) {
    return apiError(429, "Too many requests", {
      details: { retryAfterMs: rl.retryAfterMs },
    });
  }

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("sources")
    .select(REGISTRY_COLUMNS)
    .eq("active", true)
    .order("name");

  if (error) return apiServerError(error);

  const rows = (data ?? []) as unknown as RegistrySourceRow[];
  const sources = rows.map(toRegistryRecord);

  return NextResponse.json(
    registryEnvelope({ count: sources.length, sources }),
    { headers: REGISTRY_HEADERS },
  );
});
