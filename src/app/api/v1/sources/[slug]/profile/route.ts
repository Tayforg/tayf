import { NextResponse } from "next/server";

import { apiBadRequest, apiNotFound, apiServerError, withApiErrors } from "@/lib/api/errors";
import {
  apiV1Headers,
  methodNotAllowed,
  requireApiKey,
  withApiV1Headers,
} from "@/lib/api/keys";
import {
  V1_PROFILE_KARNE_COLUMNS,
  V1_PROFILE_SOURCE_COLUMNS,
  toV1SourceProfile,
} from "@/lib/api/v1-source-profile";
import { toSourceKarne } from "@/lib/sources/karne";
import {
  registryEnvelope,
  toRegistryRecord,
  type RegistrySourceRow,
} from "@/lib/sources/registry";
import { createReaderClient } from "@/lib/supabase/server";
import { isValidSourceSlug } from "@/lib/validation/source-input";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

/** GET /api/v1/sources/[slug]/profile — keyed 30-day coverage profile. */
export const GET = withApiErrors(async (request: Request, ctx: RouteContext) => {
  const auth = await requireApiKey(request);
  if (!auth.ok) return auth.response;

  const { slug } = await ctx.params;
  if (!isValidSourceSlug(slug)) {
    return withApiV1Headers(apiBadRequest("Invalid slug"), auth.tier);
  }

  const supabase = createReaderClient();
  const { data, error } = await supabase
    .from("sources")
    .select(V1_PROFILE_SOURCE_COLUMNS)
    .eq("slug", slug)
    .eq("active", true)
    .maybeSingle();

  if (error) return withApiV1Headers(apiServerError(error), auth.tier);
  if (!data) return withApiV1Headers(apiNotFound("Source not found"), auth.tier);
  const row = data as unknown as RegistrySourceRow & { id: string };

  const karne = await supabase
    .from("source_karne_30d")
    .select(V1_PROFILE_KARNE_COLUMNS)
    .eq("source_id", row.id)
    .maybeSingle();
  if (karne.error) return withApiV1Headers(apiServerError(karne.error), auth.tier);

  const parsed = karne.data ? toSourceKarne(karne.data) : null;
  const profile = parsed ? toV1SourceProfile(parsed) : null;

  return NextResponse.json(
    registryEnvelope({ source: toRegistryRecord(row), profile }),
    { headers: apiV1Headers(auth.tier) },
  );
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
