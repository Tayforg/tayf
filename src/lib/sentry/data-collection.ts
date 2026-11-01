/**
 * Sentry `dataCollection` block shared by the Node, Edge and browser inits
 * (sentry.server.config.ts / sentry.edge.config.ts / sentry.client.config.ts).
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
 * request headers (user-agent, accept, ...) that 10.x kept.
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
      ],
    },
    response: false,
  },
  urlQueryParams: { deny: ["token", "key", "secret"] },
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};
