import { NextResponse } from "next/server";
import {
  ALLOW_GET_ONLY,
  apiBadRequest,
  apiMethodNotAllowed,
  apiOptionsAllow,
  apiTooManyRequests,
  withApiErrors,
} from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { isValidSourceSlug } from "@/lib/validation/source-input";
import { registryEnvelope, toRegistryRecord } from "@/lib/sources/registry";
import {
  getRegistryDetail,
  getRegistryRows,
} from "@/lib/sources/registry-query";

/**
 * GET /api/sources/[slug] — one source's registry record plus its
 * `source_zone_history` (the versioned part of "versioned registry": every
 * bias change, including the ones the `sources_zone_history_trg` trigger
 * records with a null reason for a change made outside the
 * `set_source_bias` RPC — see migration 055) and the aggregate reader
 * agreement from /oyun (`reader_agreement: {n, share} | null`, U-03). No auth, but rate limited
 * (B-SEC-05), same 60/1-per-second bucket and limiter name as the list
 * route in ../route.ts.
 *
 * Cache-key discipline: the slug from the URL is only ever compared against
 * the cached registry rows (`getRegistryRows()`, no argument). The detail is
 * then read by the matching row's ID (`getRegistryDetail(row.id)`), so the key
 * space is bounded by the real sources and neither a query string nor an
 * invented slug can mint a cache entry or a Supabase read. This handler never
 * reads `searchParams`.
 *
 * `params` is a `Promise` (Next.js 16 route handler signature) and MUST be
 * awaited before the slug is validated — reading it synchronously is a
 * type error, not just a style nit.
 */
interface RouteContext {
  params: Promise<{ slug: string }>;
}

// stale-while-revalidate is capped much lower than the list route's 86400s:
// a retraction (rationale/bias correction) published through the admin
// dispute path must not be servable from a stale CDN copy for up to a day.
// s-maxage=3600 is pinned by the pack's acceptance criteria — do not change.
const REGISTRY_HEADERS = {
  "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=300",
  "Content-Type": "application/json; charset=utf-8",
};

// Short public negative-cache so repeated unknown-slug probes (unauthed,
// well-formed-slug keyspace is effectively unbounded) are answered by the CDN
// instead of costing a registry lookup per hit.
const NOT_FOUND_HEADERS = {
  "Cache-Control": "public, s-maxage=300",
};

const sourcesJsonLimit = createRateLimiter("sources-json", {
  capacity: 60,
  refillPerSecond: 1,
});

export const GET = withApiErrors(
  async (request: Request, ctx: RouteContext) => {
    const rl = sourcesJsonLimit(clientKey(request));
    if (!rl.allowed) return apiTooManyRequests(rl.retryAfterMs);

    const { slug } = await ctx.params;
    if (!isValidSourceSlug(slug)) {
      return apiBadRequest("Invalid slug");
    }

    // The registry rows are active sources only, so a deactivated slug is a
    // 404 here exactly as it was when the route filtered on `active` itself.
    const rows = await getRegistryRows();
    const row = rows.find((r) => r.slug === slug);
    if (!row) {
      // Same shape as apiNotFound("Source not found"), but with a short
      // public Cache-Control so the CDN answers repeated probes for unknown
      // or deactivated slugs.
      return NextResponse.json(
        { error: "Source not found" },
        { status: 404, headers: NOT_FOUND_HEADERS },
      );
    }

    const detail = await getRegistryDetail(row.id);

    // `generated_at` is stamped here, per request, never inside the cached
    // reader: it must say when THIS response was built.
    return NextResponse.json(
      registryEnvelope({
        source: toRegistryRecord(row),
        zone_history: detail.zone_history,
        reader_agreement: detail.reader_agreement,
      }),
      { headers: REGISTRY_HEADERS },
    );
  },
);

// Every other method gets the JSON 405 with `Allow` (RFC 9110 15.5.6) instead of
// Next's bodyless default, and OPTIONS is explicit: without it Next's automatic
// OPTIONS would advertise POST, PUT, PATCH and DELETE. HEAD is derived from GET.
// The refusals read no request state, so they cost no rate-limit token.
const refuse = async () => apiMethodNotAllowed(ALLOW_GET_ONLY);
export const POST = refuse;
export const PUT = refuse;
export const PATCH = refuse;
export const DELETE = refuse;

export function OPTIONS(): Response {
  return apiOptionsAllow(ALLOW_GET_ONLY);
}
