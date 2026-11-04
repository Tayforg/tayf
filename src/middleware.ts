import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

import { API_V1_ERROR_HEADERS } from "@/lib/api/v1-cors";
import { createMergedClusterGate } from "@/lib/seo/merged-cluster-gate";
import { createSourceSlugGate } from "@/lib/seo/source-slug-gate";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";
import { isServableWeekKey } from "@/lib/weekly/week-key";

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
//  3. /cluster/:id — a segment that fails the UUID shape gate (and
//     contains no further "/") rewrites to the not-found sink below instead
//     of streaming a 200 shell for something that can never resolve. This
//     does NOT probe the database for a well-formed-but-unknown id — same
//     deliberate deviation as /ekonomi/:ticker and /konu/:slug above — an
//     unknown-but-well-formed UUID still streams through to the page's own
//     notFound(). A cluster that was MERGED into another (migration 099) gets
//     a real 308 to the survivor: src/lib/seo/merged-cluster-gate.ts keeps a
//     per-isolate map of merged ids (5 min TTL, newest 1000, anon-key
//     PostgREST read) refreshed in the background via event.waitUntil. That
//     is a set of merged ids, not a per-request probe: lookup() is a
//     synchronous Map read, so it adds zero latency. A cold isolate or a merge
//     older than the 1000-row window falls back to the page's own
//     permanentRedirect(). The gate's matcher is the single literal segment
//     '/cluster/:id', never a ':path*' — that would run the UUID check and the
//     merged-cluster lookup on /cluster/<id>/kart and the per-cluster
//     /opengraph-image route too. Those nested routes are matched by
//     '/cluster/:id/:sub' instead and only get the decode-only answer of gate 8
//     plus the case fold below: the UUID/merge logic stays single-segment.
//
//     Canonical lower-case ids (h32-livebk-1). A UUID is case-insensitive, but
//     every spelling used to render its own full page (own CDN entry, own OG
//     render, the raw id in client props and share URLs, and a bookmark that
//     /saved could not remove). The gate now answers EVERY non-lower-case
//     spelling with exactly one 308 to the lower-case form, merged target
//     included (lookup() is keyed by the lower-case id, so the upper-case form
//     of a merged id goes straight to the survivor, never through a chain).
//     The three nested routes the cluster page owns (/opengraph-image,
//     /twitter-image, /kart) get the same 308 to the lower-case path, with no
//     merged lookup; any other sub (and a non-UUID head) stays decode-only. The
//     query string is kept. A malformed escape is still gate 8's 400, answered
//     first. /embed/cluster/:id does not share this gate (it is decode-only
//     below) and is out of scope. The page itself can therefore only ever
//     render a lower-case id.
//
//  4. /source/:slug — a real 404 for a slug that is not in `sources`. The
//     key space is small (tens of rows), so src/lib/seo/source-slug-gate.ts
//     keeps a per-isolate Set of slugs (5 min TTL, anon-key PostgREST read),
//     confirms an absent slug with one targeted lookup (so a source just
//     added via /admin never 404s off a stale set) and negative-caches
//     misses for 60 s. Any lookup failure ("unknown") fails open to the
//     page's own soft 404 with noindex. The gate's matcher is the literal
//     segment "/source/:slug" — never ":path*" — so the nested routes are
//     matched by '/source/:slug/:sub' instead. Of those, only the two social
//     images (/source/<slug>/opengraph-image and /twitter-image, the exact path
//     Next puts in og:image; its content hash is a query string) use the slug
//     check, because they render a PNG on demand for ANY slug (h30-abuse-5): an
//     unknown slug gets an empty 404 (no rewrite: an image URL must not render a
//     page), a lookup failure fails open to the route. The 404 keeps
//     `public, s-maxage=300`, but that header only helps a DOWNSTREAM shared
//     cache: Vercel runs routing middleware BEFORE its CDN cache, so this answer
//     is not served by the CDN. What bounds a flood of one bad slug is the 60 s
//     per-isolate negative cache in source-slug-gate. Every other nested path
//     stays on gate 8's decode-only answer, with no lookup.
//
//  5. /admin/:path* (except /admin/login) — unauthenticated requests get a
//     real 307 to /admin/login here. The (protected) layout's own
//     requireAdminSession() call, and each page's own call, stay as
//     defence in depth; this middleware is not the only check. Only /admin
//     and /admin/* (any case) reach the session check. Any other path that
//     falls through the public gates above (a mis-cased prefix such as
//     /Konu/dunya or /GUNDEM/erdogan, or a dot-segment URL like
//     /gundem/%2e%2e that the URL parser normalises to "/") gets
//     notFoundRewrite — never NextResponse.next() and never the login
//     redirect. The matcher is case-insensitive, which is why these paths
//     reach this function at all.
//
//  6. /gundem/:key — the entity hubs (roadmap G2). The key space is the closed,
//     curated vocabulary in src/lib/trends/rising-entities.ts (62 slugs), so
//     the gate is a plain Set membership check (GUNDEM_KEYS): an unknown key
//     rewrites to the not-found sink below instead of streaming a 200 shell,
//     for the same PPR reason as /konu/:slug. Unlike /konu this DOES import
//     the list: rising-entities.ts is a pure data module with no imports of
//     its own (pinned by tests/app/gundem-routes.test.ts), so it adds no
//     next/cache or Supabase code to the Edge bundle. The matcher is the
//     single literal segment '/gundem/:key', never ':path*'; the index page
//     /gundem is static and stays unmatched.
//
//  7. /hafta/:hafta — the ISO-week archive. A key that is not 'YYYY-Www', is
//     before WEEK_ARCHIVE_FIRST ('2026-W38') or is after the current Istanbul
//     week (/hafta/garbage, /hafta/2026-W4, /hafta/2026-w44, /hafta/2099-W01)
//     rewrites to the not-found sink instead of streaming a 200 shell, for the
//     same PPR reason as /konu/:slug. isServableWeekKey comes from
//     src/lib/weekly/week-key.ts, a pure module with no imports (pinned by its
//     test), so it adds no next/cache or Supabase code to the Edge bundle. The
//     page's own notFound() stays as defence in depth. The rolling /hafta page
//     is static and stays unmatched; the matcher is the single literal segment
//     '/hafta/:hafta', never ':path*'.
//
//  8. Malformed percent-encoding — every dynamic route (and, via gate 9, every
//     static route handler followed by an escape). A segment such as %ff
//     makes decodeURIComponent throw a URIError inside the route handler, which
//     used to surface as a 500 (and a Sentry event). Here the same decode is
//     tried once and a failure answers 400 (a JSON body on the two API
//     surfaces, text/plain elsewhere; /api/v1 carries the CORS + cache headers
//     of apiV1Headers minus X-Tayf-Tier, see src/lib/api/v1-cors.ts). A
//     well-formed path returns NextResponse.next() and does no other work: no
//     auth, no rate limit, no I/O. The /embed frame headers come from
//     next.config (buildSecurityHeaders) and are untouched.
//
//     #148 listed five surfaces (/api/v1/clusters/:id, /api/v1/sources/:slug/
//     profile, /api/sources/:slug, /embed/cluster/:id, /rss/:topic) and left
//     the rest on a 500. Hunt 12 (h12-security-1, incomplete coverage of #148)
//     closed it: the nested /cluster/:id/:sub and /source/:slug/:sub routes,
//     /rozet, /sitemaps, /rapor (+ /markdown), /hikaye, /api/admin/corrections/
//     :id and the two catch-all route directories /api/v1/[...path] and
//     /embed/[...rest] (the only two matcher wildcards besides /admin; both
//     are decode-only, so a wildcard here never gates anything). The nested
//     /cluster and /source paths are decoded in their own branches above, so
//     the UUID, merge and slug gates keep their single-segment contract.
//     /admin/rapor/:clusterId is covered by the /admin scope: an anonymous
//     request is redirected to the login, only an authenticated admin reaches
//     the route. tests/guards/middleware-bad-encoding.test.ts walks src/app
//     and fails when a dynamic route is neither matched nor answered here.
//     tests/guards/middleware-matcher.test.ts pins that every matcher entry has
//     its pathname.startsWith() branch above the admin-scope check (or, for the
//     '<base>%:suffix' entries of gate 9, the one staticHandlerBase() call), so a
//     new matcher can never silently 404 a whole surface.
//
//  9. Static route handlers with an encoded '/' or backslash after the path
//     (/rss.xml%2F, /api/health%5C, ...). Next finds no static route for the
//     path, falls back to a pages-router require of '<base>%2F.js' and answers an
//     HTML 500 with MODULE_NOT_FOUND (h17-contracts-1; only probe paths hit it).
//     STATIC_HANDLER_BASES lists every route.ts / route.tsx under src/app that
//     has no dynamic segment (the /api/v1/<child> routes are answered by the
//     '/api/v1/:path*' wildcard and the v1 catch-all instead); each has the
//     matcher entry '<base>%:suffix', which is path-to-regexp for '<base>', a
//     literal '%' and at least one character that is not '/'. So the bare path,
//     '<base>/x' and '<base>x' are never matched and never pay for the
//     middleware: only an escape continuation is. (The literal '%' matters: a
//     plain '<base>:suffix' would match '/api/admin/jev-gold/label' + 'er', the
//     real handler /api/admin/jev-gold/labeler.) A remainder with '%2f' or '%5c'
//     (any case) answers the same not-found sink as the gates above; any other
//     remainder is gate 8's decode-only answer (400 on a malformed escape, else
//     next). The branch is plain string comparison after the /hafta gate, so the
//     hot gates above never pay for it. tests/guards/middleware-matcher.test.ts
//     walks src/app and fails when a static handler is not listed, and proves the
//     compiled matcher with Next's own unstable_doesMiddlewareMatch.
//
// 10. /_next/image with a '#' in its `url` (h30-abuse-4 follow-up). Next's
//     remotePatterns compare `URL.search` and cannot see a fragment, and the
//     optimizer hashes the URL WITH its fragment into the cache key, so
//     `?url=<allowed host>/a.jpg%23N` was a fresh origin fetch + transform +
//     cache write per N (fetch() drops the fragment: the origin serves the same
//     bytes every time). The matcher entry is the one object entry,
//     `{ source: '/_next/image', has: [{ type: 'query', key: 'url', value: <any
//     string containing '#'> }] }`, so the middleware runs for those requests
//     ONLY: an ordinary image request (the CDN-cached hot path) never pays for
//     it. Such a request answers an uncacheable 400 before the optimizer. No
//     I/O. isAllowedRemoteImageUrl (src/lib/images/remote-image-hosts.ts)
//     refuses a '#' too, so the render side never emits one. The value regexp
//     is [\s\S]*#[\s\S]*, not .*#.*: a '.' does not match a newline, which
//     the URL parser strips, and `a.jpg\n#1` would otherwise slip past.
//     tests/guards/middleware-matcher.test.ts pins the entry under Next's own
//     matcher.
//     Scope: this closes the vector for `next start` (self-hosted) only. On
//     Vercel, /_next/image is served by the platform image service, which
//     never runs this middleware and ignores the fragment: checked on prod on
//     2026-11-04, `…a.jpg%231` and `…a.jpg%232` were both x-vercel-cache HIT on
//     the plain URL's entry, so there is no per-fragment origin fetch to stop.
//     The query-string half (remotePatterns `search: ""`) does hold on Vercel:
//     `…a.jpg%3Fcb%3DN` answers 400.
//
// The only clock read is Date.now() in gate 7. It runs per request in the Edge
// middleware, never during prerender, and nothing here does any I/O.
//
// Why /cluster/:id stays shape-only (no existence check), and why the
// investigation says a page-level fix cannot work: under cacheComponents,
// runtime `params` must be read inside a Suspense boundary. src/app/
// loading.tsx and the segment loading.tsx files provide one, so the static
// shell has already flushed a 200 before any page-level notFound() runs; a
// cached existence check in generateMetadata does not help either, because
// metadata that depends on params also streams after the shell (see the
// bundled Next docs: not-found.md "Calling notFound() after streaming has
// started" and loading.md "Status Codes"). Only a check before streaming,
// i.e. here, yields a real status. For clusters we do not do it:
//   - cluster ids are unbounded, so no per-isolate set can hold them;
//   - a per-request PostgREST probe would sit in front of every view of the
//     most-shared page, whose PPR shell is otherwise CDN-served;
//   - a missing cluster already renders "Sayfa bulunamadı" with noindex
//     (generateMetadata plus the noindex that notFound injects).
// Revisit if Search Console reports soft-404 volume.
//
// Real 404s: gates 1-3 used to return `new NextResponse(null, { status:
// 404 })` — a real status code, but a 0-byte body with none of the site's
// chrome (header/footer/theme) and none of the honest not-found copy.
// `notFoundRewrite` below rewrites to a path no route matches
// (NOT_FOUND_REWRITE_PATH), so Next falls through to `app/not-found.tsx` —
// same 404 status on the wire, now with the real page.
//
// session.ts's admin_session verifier imports `server-only` and
// `node:crypto`, so it cannot be imported into Edge middleware as-is. This
// re-implements the same verification with Web Crypto (`crypto.subtle`)
// against the identical `${body}.${signature}` token shape: the payload is a
// bare `{expiresAt, iat}`, the signature is HMAC-SHA256(signingKey, body), and
// signingKey = PBKDF2-HMAC-SHA256(ADMIN_PASSWORD, salt = "tayf-admin-session-key:"
// + ADMIN_SESSION_SECRET, 100 000 iterations, 32 bytes). The session is bound to
// the password through that KEY, not through a payload field, so rotating the
// password (or the secret) ends every session here too, exactly as in
// requireAdminSession — not a weaker cookie-presence check. Either env var
// missing means not authenticated. The key is derived once per isolate per
// (secret, password) pair and only after cheap structural checks (cookie shape,
// signature length), so junk cookies never trigger a PBKDF2 run.

export const config = {
  matcher: [
    "/admin",
    "/admin/:path*",
    "/ekonomi/:ticker",
    "/konu/:slug",
    "/cluster/:id",
    "/source/:slug",
    "/gundem/:key",
    "/hafta/:hafta",
    "/api/v1/clusters/:id",
    "/api/v1/sources/:slug/profile",
    "/api/sources/:slug",
    "/embed/cluster/:id",
    "/rss/:topic",
    // Hunt 12 (h12-security-1): decode-only, see gate 8. The two wildcards exist
    // only for the catch-all route dirs /api/v1/[...path] and /embed/[...rest];
    // they also match the bare /api/v1 and /embed, which pass straight through.
    "/cluster/:id/:sub",
    "/source/:slug/:sub",
    "/rozet/:file",
    "/sitemaps/:file",
    "/rapor/:token",
    "/rapor/:token/:sub",
    "/hikaye/:slug",
    "/api/admin/corrections/:id",
    "/api/v1/:path*",
    "/embed/:path*",
    // h17-contracts-1, gate 9: one '<base>%:suffix' per static route handler (a
    // route.ts / route.tsx with no dynamic segment). Path-to-regexp reads it as
    // '<base>' + '%' + at least one character that is not '/', so only the
    // percent-escape probes ('<base>%2F', '<base>%5C', '<base>%ff') reach the
    // middleware: never the bare handler, '<base>/x' or '<base>x'. The literal '%'
    // is what keeps '/api/admin/jev-gold/label' from matching the real handler
    // '/api/admin/jev-gold/labeler' (a plain '<base>:suffix' would). Literal
    // strings on purpose: Next analyses this config statically. Keep in step with
    // STATIC_HANDLER_BASES below; the matcher guard fails when a static route is
    // missing here.
    "/api/admin%:suffix",
    "/api/admin/api-keys%:suffix",
    "/api/admin/api-keys/revoke%:suffix",
    "/api/admin/api-keys/webhook%:suffix",
    "/api/admin/cluster-merge%:suffix",
    "/api/admin/jev-admission/review%:suffix",
    "/api/admin/jev-alerts/ack%:suffix",
    "/api/admin/jev-gold/label%:suffix",
    "/api/admin/jev-gold/labeler%:suffix",
    "/api/admin/jev-gold/seed%:suffix",
    "/api/admin/jev-regression/freeze%:suffix",
    "/api/admin/jev-regression/run%:suffix",
    "/api/admin/jev-shadow/review%:suffix",
    "/api/admin/jev-unlink%:suffix",
    "/api/admin/jev-unlink/bulk%:suffix",
    "/api/admin/rapor/revoke%:suffix",
    "/api/admin/rapor/share%:suffix",
    "/api/admin/story-threads/candidates%:suffix",
    "/api/admin/story-threads/thread%:suffix",
    "/api/corrections%:suffix",
    "/api/cron/alerts-webhooks%:suffix",
    "/api/cron/digest%:suffix",
    "/api/cron/fact-checks%:suffix",
    "/api/cron/headline%:suffix",
    "/api/cron/social%:suffix",
    "/api/health%:suffix",
    "/api/metrics%:suffix",
    "/api/newsletter%:suffix",
    "/api/newsletter/confirm%:suffix",
    "/api/newsletter/unsubscribe%:suffix",
    "/api/oembed%:suffix",
    "/api/oyun%:suffix",
    "/api/oyun/cerceve%:suffix",
    "/api/oyun/cerceve/next%:suffix",
    "/api/revalidate%:suffix",
    "/api/sources%:suffix",
    "/api/takip%:suffix",
    "/api/timeline/head%:suffix",
    "/api/unmatched%:suffix",
    "/api/v1%:suffix",
    "/blindspots/rss.xml%:suffix",
    "/indexnow-key.txt%:suffix",
    "/llms.txt%:suffix",
    "/robots.txt%:suffix",
    "/rss.xml%:suffix",
    "/sitemap.xml%:suffix",
    "/sw.js%:suffix",
    // Gate 10: the one object entry. `has` keeps the middleware off every ordinary
    // /_next/image request; only a `url` containing '#' reaches it. The value is a
    // regexp matched against the whole decoded `url`; [\s\S] (not '.') so a
    // newline before the '#' cannot hide it. A literal object on purpose: Next
    // analyses this config statically.
    {
      source: "/_next/image",
      has: [{ type: "query", key: "url", value: "[\\s\\S]*#[\\s\\S]*" }],
    },
  ],
};

// Gate 9: the static route handlers, one per '<base>%:suffix' matcher entry above
// (/api/v1 included: its children belong to the wildcard, the bare root to the
// catch-all). Inline literals, no imports, like KONU_SLUGS.
const STATIC_HANDLER_BASES: readonly string[] = [
  "/api/admin",
  "/api/admin/api-keys",
  "/api/admin/api-keys/revoke",
  "/api/admin/api-keys/webhook",
  "/api/admin/cluster-merge",
  "/api/admin/jev-admission/review",
  "/api/admin/jev-alerts/ack",
  "/api/admin/jev-gold/label",
  "/api/admin/jev-gold/labeler",
  "/api/admin/jev-gold/seed",
  "/api/admin/jev-regression/freeze",
  "/api/admin/jev-regression/run",
  "/api/admin/jev-shadow/review",
  "/api/admin/jev-unlink",
  "/api/admin/jev-unlink/bulk",
  "/api/admin/rapor/revoke",
  "/api/admin/rapor/share",
  "/api/admin/story-threads/candidates",
  "/api/admin/story-threads/thread",
  "/api/corrections",
  "/api/cron/alerts-webhooks",
  "/api/cron/digest",
  "/api/cron/fact-checks",
  "/api/cron/headline",
  "/api/cron/social",
  "/api/health",
  "/api/metrics",
  "/api/newsletter",
  "/api/newsletter/confirm",
  "/api/newsletter/unsubscribe",
  "/api/oembed",
  "/api/oyun",
  "/api/oyun/cerceve",
  "/api/oyun/cerceve/next",
  "/api/revalidate",
  "/api/sources",
  "/api/takip",
  "/api/timeline/head",
  "/api/unmatched",
  "/api/v1",
  "/blindspots/rss.xml",
  "/indexnow-key.txt",
  "/llms.txt",
  "/robots.txt",
  "/rss.xml",
  "/sitemap.xml",
  "/sw.js",
];

/**
 * The static handler whose path `pathname` continues without a '/' ('<base>x',
 * '<base>%2F'), or null. The bare path and '<base>/x' are null. Plain
 * string comparison; a base can be a prefix of another ('/api/admin' of
 * '/api/admin/api-keys'), so every base is tried rather than the first prefix hit.
 */
function staticHandlerBase(pathname: string): string | null {
  // Longest match wins: '/api/admin/jev-gold/label' is a prefix of the real
  // handler '/api/admin/jev-gold/labeler', so first-match would file a
  // '/api/admin/jev-gold/labeler%..' request under the shorter base.
  let found: string | null = null;
  for (const base of STATIC_HANDLER_BASES) {
    if (
      pathname.startsWith(base) &&
      pathname.length > base.length &&
      pathname[base.length] !== "/" &&
      (found === null || base.length > found.length)
    ) {
      found = base;
    }
  }
  return found;
}

// Module-level so the slug Set and negative cache persist across requests
// within an isolate.
const sourceGate = createSourceSlugGate();
const mergedGate = createMergedClusterGate();

const TICKER_RE = /^[A-Z0-9]{2,6}$/i;
// Mirrors topic-query.ts's TOPIC_SLUGS as inline literals (not imported —
// see the header comment above). Pinned against the real export by
// tests/app/konu-routes.test.ts.
const KONU_SLUGS = new Set(["dunya", "ekonomi", "spor", "yasam", "teknoloji", "genel"]);
// The /gundem entity hub keys, taken from the curated vocabulary itself (gate 6
// above) so the gate and generateStaticParams can never drift apart.
const GUNDEM_KEYS = new Set(RISING_ENTITIES.map((e) => e.key));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The nested routes under /cluster/<id> that gate 3 folds to a lower-case id
// (h32-livebk-1): the per-cluster OG and Twitter images and the /kart card.
const CLUSTER_CASE_SUBS: ReadonlySet<string> = new Set(["opengraph-image", "twitter-image", "kart"]);
// No route matches this path — Next renders app/not-found.tsx with a real
// 404 status and the site's own chrome, instead of a 0-byte response.
const NOT_FOUND_REWRITE_PATH = "/__tayf-not-found";
const ADMIN_COOKIE_NAME = "admin_session";

function notFoundRewrite(req: NextRequest): NextResponse {
  return NextResponse.rewrite(new URL(NOT_FOUND_REWRITE_PATH, req.url));
}

// The admin shell is session-gated, never shared content. Without a header Next
// serves it (and the 307 to the login page) as `public, max-age=0,
// must-revalidate`, which lets a shared cache hold the login page and the
// redirect. Every response of the admin branch below carries this instead; the
// /api/admin handlers do the same through withAdminNoStore.
const ADMIN_PAGE_CACHE_CONTROL = "private, no-store";

function adminNoStore<T extends Response>(res: T): T {
  res.headers.set("Cache-Control", ADMIN_PAGE_CACHE_CONTROL);
  return res;
}

const BAD_ENCODING_MESSAGE = "Bad request: malformed URL encoding";
const BAD_ENCODING_JSON = JSON.stringify({ error: BAD_ENCODING_MESSAGE });

/** "v1": /api/v1 JSON with the apiV1 CORS set; "json": /api/sources JSON;
 * "text": /embed and /rss plain text. All are 400 and uncacheable. */
type BadEncodingKind = "v1" | "json" | "text";

function badEncoding(kind: BadEncodingKind): NextResponse {
  if (kind === "v1") {
    return new NextResponse(BAD_ENCODING_JSON, { status: 400, headers: { ...API_V1_ERROR_HEADERS } });
  }
  if (kind === "json") {
    return new NextResponse(BAD_ENCODING_JSON, {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new NextResponse(BAD_ENCODING_MESSAGE, {
    status: 400,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

const IMAGE_FRAGMENT_MESSAGE = "Bad request: image URL must not contain a fragment";

/**
 * Gate 10's answer: an uncacheable 400, so the refusal is never stored under a
 * URL the next variant would not hit anyway. No I/O.
 */
function imageFragmentRefused(): NextResponse {
  return new NextResponse(IMAGE_FRAGMENT_MESSAGE, {
    status: 400,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

/**
 * Gate 8 for a route that has no other edge gate: the path decodes (and passes
 * through untouched) or it answers 400. No I/O, no auth, no other work.
 */
function decodeOnly(pathname: string, kind: BadEncodingKind): NextResponse {
  return pathDecodes(pathname) ? NextResponse.next() : badEncoding(kind);
}

/** True when the whole pathname percent-decodes (no malformed '%' escape). */
function pathDecodes(pathname: string): boolean {
  try {
    decodeURIComponent(pathname);
    return true;
  } catch {
    return false;
  }
}

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

/** Constant-time string compare (no node:crypto timingSafeEqual on Edge). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Keep in sync with src/lib/admin/session.ts (24 h sessions, 60 s clock skew,
// 43-char base64url signature, signing key = PBKDF2-HMAC-SHA256 with the salt
// label, cost and length below; see deriveSessionSigningKey there and
// adminSigningKey below).
const ADMIN_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ADMIN_CLOCK_SKEW_MS = 60_000;
const ADMIN_SIGNATURE_LENGTH = 43;
const ADMIN_KEY_SALT_LABEL = "tayf-admin-session-key:";
const ADMIN_KEY_ITERATIONS = 100_000;
const ADMIN_KEY_BITS = 256;

// The last (secret, password) pair and its HMAC key. PBKDF2 at 100k iterations
// costs tens of milliseconds and every admin request needs the same key, so it
// is derived once per isolate per pair. The promise is cached, not the result,
// so concurrent requests share one derivation; a failed derivation is dropped
// and retried. A single slot suffices (the pair only changes with the env), and
// the two strings are compared separately. In memory only (the inputs are
// already in process.env); never logged.
let cachedAdminSigningKey: { secret: string; password: string; key: Promise<CryptoKey> } | null = null;

/**
 * Web Crypto twin of deriveSessionSigningKey in src/lib/admin/session.ts:
 * PBKDF2-HMAC-SHA256(password = utf8(ADMIN_PASSWORD),
 * salt = utf8("tayf-admin-session-key:" + ADMIN_SESSION_SECRET), 100 000
 * iterations, 256 bits), imported as a non-extractable HMAC-SHA-256 key. The
 * password only ever feeds the PBKDF2 key material; the HMAC input is the token
 * body, which holds nothing derived from it.
 */
function adminSigningKey(secret: string, password: string): Promise<CryptoKey> {
  const hit = cachedAdminSigningKey;
  if (hit && hit.secret === secret && hit.password === password) return hit.key;
  const key = (async () => {
    const enc = new TextEncoder();
    const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: enc.encode(ADMIN_KEY_SALT_LABEL + secret),
        iterations: ADMIN_KEY_ITERATIONS,
      },
      material,
      ADMIN_KEY_BITS,
    );
    return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  })();
  const entry = { secret, password, key };
  cachedAdminSigningKey = entry;
  key.catch(() => {
    if (cachedAdminSigningKey === entry) cachedAdminSigningKey = null;
  });
  return key;
}

/** Mirrors src/lib/admin/session.ts's parseToken, minus the cookie I/O. */
async function verifyAdminToken(
  token: string | undefined,
  secret: string,
  password: string,
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // 0. Cheap structural check before any key derivation: a signature of the
  // wrong length can never match.
  if (sig.length !== ADMIN_SIGNATURE_LENGTH) return false;

  // 1. Signature. This needs the signing key, so the (memoized) PBKDF2
  // derivation happens here: one per isolate per (secret, password) pair. Any
  // crypto failure fails closed (unauthenticated), never as a thrown 500.
  let expected: string;
  try {
    const key = await adminSigningKey(secret, password);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    expected = base64UrlEncode(new Uint8Array(mac));
  } catch {
    return false;
  }
  if (!timingSafeEqualStr(sig, expected)) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecodeToString(body));
  } catch {
    return false;
  }

  // 2. Shape (a legacy `{expiresAt}` token fails here). Unknown fields, such as
  // the old `pwd`, are ignored: the key binds the session to the password.
  if (!parsed || typeof parsed !== "object") return false;
  const { expiresAt, iat } = parsed as Record<string, unknown>;
  if (
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    typeof iat !== "number" ||
    !Number.isFinite(iat)
  ) {
    return false;
  }

  // 3-5. Lifetime.
  const now = Date.now();
  if (expiresAt < now) return false;
  if (iat > now + ADMIN_CLOCK_SKEW_MS) return false;
  if (now - iat > ADMIN_SESSION_MAX_AGE_MS) return false;
  if (expiresAt - iat > ADMIN_SESSION_MAX_AGE_MS) return false;

  return true;
}

export async function middleware(req: NextRequest, event?: NextFetchEvent): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // Gate 10. The matcher sends only a `url` containing '#' here; a request that
  // somehow arrives without one passes through to the optimizer untouched.
  if (pathname.startsWith("/_next/image")) {
    return req.nextUrl.searchParams.getAll("url").some((u) => u.includes("#"))
      ? imageFragmentRefused()
      : NextResponse.next();
  }

  if (pathname.startsWith("/konu/")) {
    const slug = pathname.slice("/konu/".length);
    if (slug === "politika") return NextResponse.redirect(new URL("/", req.url), 308);
    if (!KONU_SLUGS.has(slug)) return notFoundRewrite(req);
    return NextResponse.next();
  }

  if (pathname.startsWith("/ekonomi/")) {
    const ticker = pathname.slice("/ekonomi/".length);
    if (!TICKER_RE.test(ticker)) {
      return notFoundRewrite(req);
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/cluster/")) {
    const segment = pathname.slice("/cluster/".length);
    // A nested path (/cluster/<id>/kart, /cluster/<id>/opengraph-image) reaches
    // here through '/cluster/:id/:sub'. No UUID shape gate and no merged-cluster
    // lookup (those stay single-segment), and it must neither 404 nor fall into
    // the admin branch below. Gate 8's decode check runs first; the only other
    // work is the case fold: a UUID head that is not lower case, on one of the
    // three routes the cluster page owns, is 308'd to the lower-case path.
    const slash = segment.indexOf("/");
    if (slash !== -1) {
      if (!pathDecodes(pathname)) return badEncoding("text");
      const head = segment.slice(0, slash);
      const sub = segment.slice(slash + 1);
      if (UUID_RE.test(head) && head !== head.toLowerCase() && CLUSTER_CASE_SUBS.has(sub)) {
        const url = req.nextUrl.clone();
        url.pathname = `/cluster/${head.toLowerCase()}/${sub}`;
        return NextResponse.redirect(url, 308);
      }
      return NextResponse.next();
    }
    if (!UUID_RE.test(segment)) return notFoundRewrite(req);

    // Merged clusters (migration 099): background refresh, synchronous lookup.
    const refresh = mergedGate.refreshIfStale();
    if (event) event.waitUntil(refresh);
    else void refresh.catch(() => {});
    // Canonical form: lower case, or the survivor of a merge. Anything that is
    // not already spelled exactly so gets ONE 308, so an upper-case spelling of
    // a merged id goes straight to the survivor.
    const lower = segment.toLowerCase();
    const target = mergedGate.lookup(lower) ?? lower;
    if (target !== segment) {
      const url = req.nextUrl.clone();
      url.pathname = `/cluster/${target}`;
      return NextResponse.redirect(url, 308);
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/source/")) {
    const rest = pathname.slice("/source/".length);
    const slash = rest.indexOf("/");
    if (slash !== -1) {
      // A nested path: /source/<slug>/<sub>. Only the two social-image routes
      // are gated (h30-abuse-5): they render a PNG on demand for ANY slug, so
      // an unknown one is answered here, before the render. Everything else
      // stays decode-only with no lookup.
      const head = rest.slice(0, slash);
      const sub = rest.slice(slash + 1);
      if (sub !== "opengraph-image" && sub !== "twitter-image") {
        return decodeOnly(pathname, "text");
      }
      // A malformed escape is the 400 of gate 8, whatever the slug is: check it
      // first, so a bad encoding never reaches the lookup.
      if (!pathDecodes(pathname)) return badEncoding("text");
      // An image URL has no page chrome to show: an empty 404. Vercel runs
      // routing middleware BEFORE its CDN cache, so this answer is not served by
      // the CDN: what bounds a flood of one bad slug is the 60 s per-isolate
      // negative cache in source-slug-gate (a repeat is one Map read, no
      // lookup). The s-maxage only helps a downstream shared cache. Fail open
      // as the page does: "unknown" (lookup failed) and "exists" both continue
      // to the image route.
      return (await sourceGate.check(head)) === "missing"
        ? new NextResponse(null, {
            status: 404,
            headers: { "cache-control": "public, s-maxage=300" },
          })
        : NextResponse.next();
    }
    // Fail open: "unknown" falls through to the page's own soft 404.
    return (await sourceGate.check(rest)) === "missing"
      ? notFoundRewrite(req)
      : NextResponse.next();
  }

  if (pathname.startsWith("/gundem/")) {
    const key = pathname.slice("/gundem/".length);
    // Unknown keys (and any nested path, which includes a "/") get the real 404.
    return GUNDEM_KEYS.has(key) ? NextResponse.next() : notFoundRewrite(req);
  }

  if (pathname.startsWith("/hafta/")) {
    const key = pathname.slice("/hafta/".length);
    // Bad shape, before launch, future week and any nested path (a "/" never
    // parses) get the real 404; the page keeps its own notFound() as a backstop.
    return isServableWeekKey(key, Date.now()) ? NextResponse.next() : notFoundRewrite(req);
  }

  // Gate 9: a static route handler followed by an escape ('<base>%:suffix'). An
  // encoded '/' or backslash is the not-found sink (Next would answer a 500); any
  // other remainder is decode-only. The matcher never sends the bare handler here.
  const base = staticHandlerBase(pathname);
  if (base !== null) {
    const rest = pathname.slice(base.length).toLowerCase();
    if (rest.indexOf("%2f") !== -1 || rest.indexOf("%5c") !== -1) return notFoundRewrite(req);
    return decodeOnly(pathname, base === "/api/v1" ? "v1" : base.startsWith("/api/") ? "json" : "text");
  }

  // Gate 8, decode-only surfaces with no other edge gate (hunt 12).
  if (
    pathname.startsWith("/rozet/") ||
    pathname.startsWith("/sitemaps/") ||
    pathname.startsWith("/rapor/") ||
    pathname.startsWith("/hikaye/")
  ) {
    return decodeOnly(pathname, "text");
  }

  if (pathname.startsWith("/api/admin/corrections/")) {
    return decodeOnly(pathname, "json");
  }

  // The bare roots of the two catch-all route dirs ('/api/v1/:path*' and
  // '/embed/:path*' also match them) have nothing to decode: straight through.
  if (pathname === "/api/v1" || pathname === "/embed") return NextResponse.next();

  // The five #148 prefixes stay listed one by one (the matcher guard pins a
  // startsWith branch per matcher entry); /api/v1/ and /embed/ now also take the
  // catch-all route dirs.
  if (
    pathname.startsWith("/api/v1/clusters/") ||
    pathname.startsWith("/api/v1/sources/") ||
    pathname.startsWith("/api/v1/") ||
    pathname.startsWith("/api/sources/") ||
    pathname.startsWith("/embed/cluster/") ||
    pathname.startsWith("/embed/") ||
    pathname.startsWith("/rss/")
  ) {
    const kind: BadEncodingKind = pathname.startsWith("/api/v1/")
      ? "v1"
      : pathname.startsWith("/api/")
        ? "json"
        : "text";
    return decodeOnly(pathname, kind);
  }

  // Admin scope: only /admin and /admin/* (any case) may reach the session
  // check below. Everything else that fell through the public gates (mis-cased
  // /Konu/..., /GUNDEM/..., or a dot-segment URL normalised to "/") gets the
  // real 404 instead of a 307 to the login page. Mis-cased admin paths stay in
  // scope on purpose: they end at the session check, which fails closed.
  const lower = pathname.toLowerCase();
  if (lower !== "/admin" && !lower.startsWith("/admin/")) return notFoundRewrite(req);

  if (pathname === "/admin/login" || pathname.startsWith("/admin/login/")) {
    return adminNoStore(NextResponse.next());
  }

  const secret = process.env.ADMIN_SESSION_SECRET;
  const password = process.env.ADMIN_PASSWORD;
  const token = req.cookies.get(ADMIN_COOKIE_NAME)?.value;
  const authenticated =
    secret && password ? await verifyAdminToken(token, secret, password) : false;
  if (!authenticated) {
    return adminNoStore(NextResponse.redirect(new URL("/admin/login", req.url), 307));
  }
  return adminNoStore(NextResponse.next());
}
