/**
 * Sentry `dataCollection` block shared by the Node, Edge and browser inits
 * (sentry.server.config.ts / sentry.edge.config.ts / instrumentation-client.ts).
 *
 * Why this exists: @sentry/nextjs 11 removed `sendDefaultPii`. Left unset, the
 * SDK now collects the client IP (`userInfo`), every cookie and header, the raw
 * request body of incoming requests (so an error thrown while handling
 * POST /admin/login would ship the plaintext admin password), URL query
 * parameters and database query data. In 10.x the unset flag meant "off". This
 * block restores that posture explicitly; tests/guards/sentry-data-collection.test.ts
 * pins it for all three runtimes.
 *
 * tayf has no user accounts and no PII surface worth shipping, so the stance is
 * "metadata only": error, stack, route, release, and the non-identifying
 * request headers (user-agent, accept, ...) that 10.x kept. No URL query
 * strings either: the home page and /takip put reader-typed text in them.
 *
 * Plain constants, no imports: safe to bundle into the Edge runtime and the
 * browser. The SDK additionally always filters names containing auth, token,
 * secret, session, password, key, cookie, ... on top of the lists below.
 */
export const SENTRY_DATA_COLLECTION = {
  // No `user.*` from instrumentation and no `ip_address: "{{auto}}"` /
  // `infer_ip: "auto"` on events.
  userInfo: false,
  cookies: false,
  // [] disables body capture for incoming/outgoing requests and responses.
  httpBodies: [],
  httpHeaders: {
    // Substring match, case-insensitive. The IP-bearing headers are not in the
    // SDK's built-in sensitive list, so they are named here: Vercel's
    // x-forwarded-for / x-real-ip / x-vercel-forwarded-for / x-vercel-ip-*
    // (geo), Cloudflare's cf-connecting-ip, and the generic client-ip family.
    request: {
      deny: [
        "x-forwarded-for",
        "x-real-ip",
        "forwarded",
        "x-vercel-forwarded-for",
        "x-vercel-ip",
        "cf-connecting-ip",
        "true-client-ip",
        "x-client-ip",
        "x-cluster-client-ip",
        "fastly-client-ip",
        "cookie",
        "authorization",
        // The reader's search text. Referrer-Policy is strict-origin-when-cross-origin
        // (src/lib/security/headers.ts), so a same-origin click sends the FULL
        // referring url, /?q=<search text> included. @sentry/nextjs 11 copies every
        // header not denied onto the root span as `http.request.header.referer`
        // (a string[]), and onto the event's request.headers. Denied, the SDK
        // writes ['[Filtered]'] there instead; redact.ts strips the query from
        // the attribute as a second layer.
        "referer",
      ],
    },
    response: false,
  },
  // `false`, not a deny-list: the query string holds what the reader typed
  // (/?q=<search text>) and the keywords they follow (/takip?q=a,b). In
  // @sentry/core 11 a `{ deny }` list redacts only the named keys and sends
  // every other parameter, so a deny-list would ship the search text with each
  // server error. Only `false` drops the whole query. scrubSentryEvent /
  // scrubSentrySpan / scrubSentryBreadcrumb (redact.ts) strip it from the
  // URLs the SDK copies verbatim (location.href, breadcrumbs, span names). The
  // Referer header is the one URL that arrives as a HEADER, so
  // httpHeaders.request.deny above ("referer") is its control; the scrubbers
  // only back that up.
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};
