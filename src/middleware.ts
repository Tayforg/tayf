import { NextResponse, type NextRequest } from "next/server";

// Edge middleware — runs before any response commits, so (unlike a
// notFound()/redirect() thrown from inside a cacheComponents/PPR page or
// layout body, which can only swap already-streamed content) the statuses
// below are real on the wire.
//
// Three independent gates share this one file because Next only loads a
// single src/middleware.ts:
//
//  1. /ekonomi/:ticker — a malformed ticker segment (fails the same shape
//     regex the page itself uses) 404s here instead of streaming a 200
//     shell. This does NOT probe the database for a well-formed-but-
//     unknown ticker — that would reintroduce the per-request Supabase
//     round trip PPR was trying to avoid — so an unknown-but-well-formed
//     ticker still streams 200/404-content; see
//     src/app/ekonomi/[ticker]/page.tsx's tickerExists() header comment
//     for the measured detail and the documented deviation.
//
//  2. /konu/:slug — same hazard as /ekonomi/:ticker: permanentRedirect()/
//     notFound() inside src/app/konu/[slug]/page.tsx run after `await
//     params` inside the src/app/loading.tsx Suspense boundary, so PPR has
//     already flushed a 200 shell by the time they run. /konu is a closed
//     six-value vocabulary, so the gate here is a plain Set membership
//     check (KONU_SLUGS, mirrored from topic-query.ts's TOPIC_SLUGS — see
//     the parity guard in tests/app/konu-routes.test.ts) plus one literal
//     redirect for "politika". Not imported from
//     @/lib/clusters/topic-query: that module pulls in next/cache and
//     @supabase/supabase-js transitively, neither of which belong in the
//     Edge middleware bundle.
//
//  3. /admin/:path* (except /admin/login) — unauthenticated requests get a
//     real 307 to /admin/login here. The (protected) layout's own
//     requireAdminSession() call, and each page's own call, stay as
//     defence in depth; this middleware is not the only check.
//
// session.ts's admin_session verifier imports `server-only` and
// `node:crypto`, so it cannot be imported into Edge middleware as-is. This
// re-implements the same HMAC-SHA256 verification with Web Crypto
// (`crypto.subtle`) against the identical `${body}.${signature}` token
// shape and `expiresAt` check — not a weaker cookie-presence check.

export const config = {
  matcher: ["/admin", "/admin/:path*", "/ekonomi/:ticker", "/konu/:slug"],
};

const TICKER_RE = /^[A-Z0-9]{2,6}$/i;
// Mirrors topic-query.ts's TOPIC_SLUGS as inline literals (not imported —
// see the header comment above). Pinned against the real export by
// tests/app/konu-routes.test.ts.
const KONU_SLUGS = new Set(["dunya", "ekonomi", "spor", "yasam", "teknoloji", "genel"]);
const ADMIN_COOKIE_NAME = "admin_session";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeToString(input: string): string {
  const padded = input.length % 4 === 0 ? input : input + "=".repeat(4 - (input.length % 4));
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return new Uint8Array(sig);
}

/** Constant-time string compare (no node:crypto timingSafeEqual on Edge). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mirrors src/lib/admin/session.ts's parseToken, minus the cookie I/O. */
async function verifyAdminToken(token: string | undefined, secret: string): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = base64UrlEncode(await hmacSha256(secret, body));
  if (!timingSafeEqualStr(sig, expected)) return false;

  try {
    const parsed = JSON.parse(base64UrlDecodeToString(body)) as unknown;
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { expiresAt?: unknown }).expiresAt !== "number") {
      return false;
    }
    return (parsed as { expiresAt: number }).expiresAt >= Date.now();
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/konu/")) {
    const slug = pathname.slice("/konu/".length);
    if (slug === "politika") return NextResponse.redirect(new URL("/", req.url), 308);
    if (!KONU_SLUGS.has(slug)) return new NextResponse(null, { status: 404 });
    return NextResponse.next();
  }

  if (pathname.startsWith("/ekonomi/")) {
    const ticker = pathname.slice("/ekonomi/".length);
    if (!TICKER_RE.test(ticker)) {
      return new NextResponse(null, { status: 404 });
    }
    return NextResponse.next();
  }

  if (pathname === "/admin/login" || pathname.startsWith("/admin/login/")) {
    return NextResponse.next();
  }

  const secret = process.env.ADMIN_SESSION_SECRET;
  const token = req.cookies.get(ADMIN_COOKIE_NAME)?.value;
  const authenticated = secret ? await verifyAdminToken(token, secret) : false;
  if (!authenticated) {
    return NextResponse.redirect(new URL("/admin/login", req.url), 307);
  }
  return NextResponse.next();
}
