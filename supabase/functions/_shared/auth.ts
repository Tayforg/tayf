// supabase/functions/_shared/auth.ts
//
// Bearer auth for Edge Function handlers.
//
// THIS HANDLER IS THE ONLY AUTH GATE. All 7 Edge Functions run with
// `verify_jwt = false` and are deployed with `--no-verify-jwt`
// (docs/migration-guide.md), so the Supabase gateway does NOT check a JWT in
// front of them: every request that reaches a function reaches
// `requireServiceRoleBearer` first, and nothing else stands between the public
// internet and the worker endpoints. Never remove this call from a handler,
// never move it behind method checks or body parsing, and never weaken it
// (e.g. accept an empty secret, skip the comparison, or log the presented
// token).
//
// Beyond being the gate, the explicit check gives us:
//
//   1. Tests against a local supabase stack can exercise the auth path with
//      a known-good bearer token without involving JWT signing.
//   2. A deterministic JSON-shaped 401 rather than the generic gateway error,
//      so observability dashboards can distinguish "auth failed" from
//      "function crashed".
//
// The expected bearer value is `SUPABASE_SERVICE_ROLE_KEY` (or the operator's
// `WORKER_CRON_SECRET`) from the runtime env. Comparison is constant-time via
// byte-by-byte XOR over the UTF-8 encoding so a timing oracle cannot leak the
// key prefix.
//
// The gate runs BEFORE authentication, so it is also reachable by anyone: its
// own cost must not be attacker-controlled. The header is therefore
// length-capped (MAX_AUTHORIZATION_LENGTH) before any regex runs, and the
// parse itself (`parseBearer`) is linear.

const JSON_HEADERS = { "content-type": "application/json" } as const;

function unauthorized(reason: string): Response {
  return new Response(
    JSON.stringify({ ok: false, error: "unauthorized", reason }),
    { status: 401, headers: JSON_HEADERS },
  );
}

/**
 * Constant-time equality on two UTF-8 byte strings. Returns false immediately
 * on length mismatch (length itself is not a secret — keys are fixed-width
 * per Supabase project), then XORs every pair of bytes so the loop always
 * runs in O(min(a, b)) regardless of where the first differing byte sits.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i]! ^ bb[i]!;
  }
  return diff === 0;
}

/**
 * Longest `Authorization` header we are willing to parse. Real values are a
 * scheme plus a service-role key or cron secret (a few hundred characters at
 * most, `sb_secret_*` keys are ~40); 1 KiB leaves ample headroom while making
 * the work an unauthenticated caller can force constant-bounded.
 */
export const MAX_AUTHORIZATION_LENGTH = 1024;

// `\s` and `\S` are complementary classes, so no two adjacent quantifiers can
// match the same character and the regex engine has exactly one way to split
// any input: matching and failing are both linear. (The previous
// `Bearer\s+(.+?)\s*$` let `.+?` and the trailing `\s*` fight over every
// space in a long run: quadratic, ~1 s at 50k characters.)
const BEARER_RE = /^\s*Bearer\s+(\S+)\s*$/i;

/**
 * Extracts the token from an `Authorization: Bearer <token>` header value, or
 * returns `null` if the value is not exactly a Bearer scheme followed by one
 * whitespace-free token. The scheme is case-insensitive (RFC 6750), any run of
 * whitespace may separate scheme and token, and surrounding whitespace is
 * ignored so multi-space pastes from operator runbooks still validate.
 *
 * Pure and linear in the header length; callers are still expected to cap the
 * length first (see `MAX_AUTHORIZATION_LENGTH`).
 */
export function parseBearer(header: string): string | null {
  const match = BEARER_RE.exec(header);
  return match ? (match[1] ?? null) : null;
}

/**
 * Returns a 401 `Response` if the request is missing a valid
 * `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` header, or `null` if
 * the bearer matches. Callers should:
 *
 *     const denied = requireServiceRoleBearer(req);
 *     if (denied) return denied;
 *
 * at the very top of `Deno.serve`, ahead of method checks and body parsing.
 *
 * Misconfiguration (the env var itself being unset) is treated as a hard 401
 * so a stripped deploy cannot accidentally accept the empty string as a
 * valid bearer.
 */
export function requireServiceRoleBearer(req: Request): Response | null {
  // Two accepted bearers, both constant-time compared:
  //   1. SUPABASE_SERVICE_ROLE_KEY — auto-injected by the runtime. On
  //      projects using the new API-key system this is the (reveal-once,
  //      otherwise-unretrievable) `sb_secret_*` key.
  //   2. WORKER_CRON_SECRET — an operator-set secret used by the pg_cron
  //      drains, which cannot read the runtime's injected service key. The
  //      same value lives in Supabase Vault and is sent by the cron's
  //      net.http_post Authorization header. This is the path the
  //      worker-stream pipeline actually uses to invoke the drains.
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const cronSecret = Deno.env.get("WORKER_CRON_SECRET") ?? "";
  if (serviceKey.length === 0 && cronSecret.length === 0) {
    return unauthorized("server-misconfigured");
  }

  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header) {
    return unauthorized("missing-authorization");
  }

  // Length cap FIRST, before any regex touches attacker-controlled input.
  if (header.length > MAX_AUTHORIZATION_LENGTH) {
    return unauthorized("malformed-authorization");
  }

  const presented = parseBearer(header);
  if (presented === null) {
    return unauthorized("malformed-authorization");
  }

  // Both comparisons are evaluated unconditionally (no `||` short-circuit
  // between them) so response time does not reveal which secret matched.
  const okService = serviceKey.length > 0 && constantTimeEqual(presented, serviceKey);
  const okCron = cronSecret.length > 0 && constantTimeEqual(presented, cronSecret);
  if (!okService && !okCron) {
    return unauthorized("bad-bearer");
  }
  return null;
}
