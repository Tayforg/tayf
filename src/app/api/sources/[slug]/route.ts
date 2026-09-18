import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  apiBadRequest,
  apiError,
  apiServerError,
  withApiErrors,
} from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { isValidSourceSlug } from "@/lib/validation/source-input";
import {
  registryEnvelope,
  toRegistryRecord,
  type RegistrySourceRow,
} from "@/lib/sources/registry";

/**
 * GET /api/sources/[slug] — one source's registry record plus its
 * `source_zone_history` (the versioned part of "versioned registry": every
 * bias change, including the ones the `sources_zone_history_trg` trigger
 * records with a null reason for a change made outside the
 * `set_source_bias` RPC — see migration 055). No auth, but rate limited
 * (B-SEC-05), same 60/1-per-second bucket and limiter name as the list
 * route in ../route.ts.
 *
 * `params` is a `Promise` (Next.js 16 route handler signature) and MUST be
 * awaited before the slug is validated — reading it synchronously is a
 * type error, not just a style nit.
 */
interface RouteContext {
  params: Promise<{ slug: string }>;
}

const REGISTRY_COLUMNS =
  "id, slug, name, url, bias, kind, active, zone_rationale, zone_rationale_at, trustee_since, trustee_note";

// stale-while-revalidate is capped much lower than the list route's 86400s:
// a retraction (rationale/bias correction) published through the admin
// dispute path must not be servable from a stale CDN copy for up to a day.
// s-maxage=3600 is pinned by the pack's acceptance criteria — do not change.
const REGISTRY_HEADERS = {
  "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=300",
  "Content-Type": "application/json; charset=utf-8",
};

// Short public negative-cache so repeated unknown-slug probes (unauthed,
// unrate-limited, well-formed-slug keyspace is effectively unbounded) are
// answered by the CDN instead of costing a Supabase round trip per hit.
const NOT_FOUND_HEADERS = {
  "Cache-Control": "public, s-maxage=300",
};

/**
 * Newest-first, capped at 50: a citable "recent changes" window rather than
 * an unbounded export. `.order(..., { ascending: false })` is load-bearing
 * — do not drop it, the history is meaningless (and the cap picks the
 * wrong 50 rows) without it.
 */
const ZONE_HISTORY_LIMIT = 50;

const sourcesJsonLimit = createRateLimiter("sources-json", {
  capacity: 60,
  refillPerSecond: 1,
});

export const GET = withApiErrors(
  async (request: Request, ctx: RouteContext) => {
    const rl = sourcesJsonLimit(clientKey(request));
    if (!rl.allowed) {
      return apiError(429, "Too many requests", {
        details: { retryAfterMs: rl.retryAfterMs },
      });
    }

    const { slug } = await ctx.params;
    if (!isValidSourceSlug(slug)) {
      return apiBadRequest("Invalid slug");
    }

    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("sources")
      .select(REGISTRY_COLUMNS)
      .eq("slug", slug)
      .eq("active", true)
      .maybeSingle();

    if (error) return apiServerError(error);
    if (!data) {
      // Same shape as apiNotFound("Source not found"), but with a short
      // public Cache-Control so the CDN — not Supabase — answers repeated
      // probes for unknown or deactivated slugs.
      return NextResponse.json(
        { error: "Source not found" },
        { status: 404, headers: NOT_FOUND_HEADERS },
      );
    }

    const row = data as unknown as RegistrySourceRow & { id: string };

    const { data: historyRows, error: historyError } = await supabase
      .from("source_zone_history")
      .select("old_bias, new_bias, reason, rater, changed_at")
      .eq("source_id", row.id)
      .order("changed_at", { ascending: false })
      .limit(ZONE_HISTORY_LIMIT);

    if (historyError) return apiServerError(historyError);

    return NextResponse.json(
      registryEnvelope({
        source: toRegistryRecord(row),
        zone_history: historyRows ?? [],
      }),
      { headers: REGISTRY_HEADERS },
    );
  },
);
