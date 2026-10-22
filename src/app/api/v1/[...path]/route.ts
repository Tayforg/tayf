import { NextResponse } from "next/server";

import { withApiErrors } from "@/lib/api/errors";
import { apiV1Headers, v1NotFound } from "@/lib/api/keys";

/**
 * Catch-all for every UNMATCHED `/api/v1/*` path.
 *
 * Next resolves static and single-segment routes (`/api/v1/clusters`,
 * `/api/v1/clusters/[id]`, ...) before a catch-all, so this only ever sees
 * paths no route owns -- a typo, a removed endpoint, `/api/v1/clusters/a/b`.
 * Without it those got Next's HTML 404, which a client doing `res.json()`
 * chokes on and which carries no CORS headers, so a browser consumer could not
 * even read the status.
 *
 * Deliberately keyless, database-free and limiter-free: a 404 reveals nothing
 * and costs nothing, and charging the per-IP floor here would let a stray
 * typo-loop starve the same IP's real calls.
 */
export const GET = withApiErrors(async () => v1NotFound());
export const HEAD = withApiErrors(async () => v1NotFound());
export const POST = withApiErrors(async () => v1NotFound());
export const PUT = withApiErrors(async () => v1NotFound());
export const PATCH = withApiErrors(async () => v1NotFound());
export const DELETE = withApiErrors(async () => v1NotFound());

// Same keyless preflight every real route answers, so a browser can then read
// the 404 cross-origin.
export const OPTIONS = withApiErrors(async () =>
  new NextResponse(null, { status: 204, headers: apiV1Headers("free") }),
);
