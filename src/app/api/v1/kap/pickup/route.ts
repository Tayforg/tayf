import { NextResponse } from "next/server";

import { apiBadRequest, apiServerError, withApiErrors } from "@/lib/api/errors";
import {
  apiV1Headers,
  methodNotAllowed,
  requireApiKey,
  withApiV1Headers,
} from "@/lib/api/keys";
import { parsePickupParams, toV1PickupBody } from "@/lib/api/v1-kap-pickup";
import { fetchTickerPickup } from "@/lib/finance/kap-pickup-query";
import { createServerClient } from "@/lib/supabase/server";
import { registryEnvelope } from "@/lib/sources/registry";

/**
 * GET /api/v1/kap/pickup — keyed public API mirror of the "Medyada yankı"
 * panel on /ekonomi/[ticker]. Both free and partner tiers are allowed,
 * exactly like the other v1 endpoints; responses are uncached
 * (`private, no-store` via apiV1Headers). Never returns an article title
 * or URL — see toV1PickupBody's header comment.
 */
export const GET = withApiErrors(async (request: Request) => {
  const auth = await requireApiKey(request);
  if (!auth.ok) return auth.response;

  const parsed = parsePickupParams(new URL(request.url).searchParams, new Date());
  if ("error" in parsed) {
    return withApiV1Headers(apiBadRequest(parsed.error), auth.tier);
  }

  try {
    const r = await fetchTickerPickup(createServerClient(), parsed.ticker, parsed.sinceMs, parsed.nowMs, {
      limit: parsed.limit,
    });
    return NextResponse.json(registryEnvelope({ ...toV1PickupBody(r) }), { headers: apiV1Headers(auth.tier) });
  } catch (err) {
    return withApiV1Headers(apiServerError(err), auth.tier);
  }
});

export const OPTIONS = withApiErrors(async () =>
  new NextResponse(null, { status: 204, headers: apiV1Headers("free") }),
);

// Every other method gets the JSON 405 envelope with an `Allow` header (and
// CORS) rather than Next's bodyless default. HEAD is derived from GET by Next.
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
