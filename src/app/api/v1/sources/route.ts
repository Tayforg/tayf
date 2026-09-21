import { NextResponse } from "next/server";

import { apiServerError, withApiErrors } from "@/lib/api/errors";
import { apiV1Headers, requireApiKey, withApiV1Headers } from "@/lib/api/keys";
import { createServerClient } from "@/lib/supabase/server";
import {
  registryEnvelope,
  toRegistryRecord,
  type RegistrySourceRow,
} from "@/lib/sources/registry";

/**
 * GET /api/v1/sources — keyed mirror of the free GET /api/sources.
 *
 * COPIED LITERALLY from src/app/api/sources/route.ts's REGISTRY_COLUMNS,
 * not imported — per the W3 brief, /api/sources and its column list stay
 * completely untouched and this module must not create a dependency on
 * that route file. `toRegistryRecord` IS shared (from
 * @/lib/sources/registry, a read-only import), which is what keeps the
 * two routes' record shape identical.
 */
const REGISTRY_COLUMNS =
  "slug, name, url, bias, kind, active, zone_rationale, zone_rationale_at, trustee_since, trustee_note";

export const GET = withApiErrors(async (request: Request) => {
  const auth = await requireApiKey(request);
  if (!auth.ok) return auth.response;

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("sources")
    .select(REGISTRY_COLUMNS)
    .eq("active", true)
    .order("name");

  if (error) return withApiV1Headers(apiServerError(error), auth.tier);

  const rows = (data ?? []) as unknown as RegistrySourceRow[];
  const sources = rows.map(toRegistryRecord);

  return NextResponse.json(
    registryEnvelope({ count: sources.length, sources }),
    { headers: apiV1Headers(auth.tier) },
  );
});

export const OPTIONS = withApiErrors(async () =>
  new NextResponse(null, { status: 204, headers: apiV1Headers("free") }),
);
