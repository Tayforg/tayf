import type { ReactNode } from "react";

import { requireAdminSession } from "@/lib/admin/session";

// Ekonomi review deferred item: unauthenticated GET /admin and
// /admin/ekonomi must 307 to /admin/login on the wire, before any page
// body runs. Under cacheComponents/PPR that wire-level 307 is actually
// committed by src/middleware.ts (Edge, runs before any response
// commits) — a redirect() thrown from here can have its shell already
// flushed with 200 by the time this layout's cookie read resolves,
// degrading it to a client-side NEXT_REDIRECT inside the streamed flight
// payload instead of a real HTTP status. This call, and each page's own
// requireAdminSession() call (see admin/(protected)/page.tsx and
// admin/(protected)/ekonomi/page.tsx), stay as defence in depth alongside
// the middleware, not as the sole gate. Every admin route except
// /admin/login lives under this group; /admin/login itself sits outside it
// (src/app/admin/login/**) so there is no redirect loop.
export default async function ProtectedAdminLayout({ children }: { children: ReactNode }) {
  await requireAdminSession();
  return children;
}
