// supabase/functions/_shared/safe-fetch.ts
//
// SSRF-safe fetch primitive shared by the image-backfill Edge Function. This
// is the audit T3 P1-5 fix: every outbound HTTP fetch in og-image.ts MUST go
// through `safeFetch` so we can't be tricked into pulling instance metadata,
// link-local addresses, RFC 1918 ranges, or other private targets via a
// hostile article URL, an attacker-controlled Location header, or DNS
// rebinding.
//
// Guarantees:
//   1. Resolves the target hostname via Deno.resolveDns for BOTH A and AAAA
//      records. Any record that falls inside the private/special-purpose
//      block list (RFC 1918, CGNAT, loopback, link-local, ULA, IPv4-mapped
//      IPv6, multicast, reserved, etc.) causes the request to be rejected
//      before a connection is opened.
//   2. For plain HTTP, after the allow-check we run a second DNS
//      validation via resolveAndPin() and reject the request if the
//      resolution is blocked — but then dial the HOSTNAME URL, not the
//      resolved IP literal. An earlier revision rewrote the dial to the
//      literal IP and set a "host" header to preserve virtual hosting;
//      Deno's fetch treats `Host` as a forbidden header and silently
//      drops it, so the origin received `Host: <ip>` and any
//      Cloudflare-fronted or vhosted target answered 403 (this was a
//      production defect: PR #43 routed the RSS fetcher through
//      safeResponse and 14 of 118 http: feeds started failing). We
//      therefore accept, for HTTP, the same residual same-resolver
//      DNS-rebinding TOCTOU that HTTPS already accepts below — the dial
//      re-resolves the hostname itself, so a rebinding attacker who
//      flips DNS between our check and the platform fetch's own lookup
//      is not caught. For HTTPS we keep the hostname in the URL so
//      SNI/TLS verifies — that residual rebinding risk is the price of
//      correct TLS handshakes.
//   3. Redirects are manual (`redirect: "manual"`). Each Location header is
//      re-validated through the same allowlist on every hop, with a maximum
//      of MAX_REDIRECTS hops. This blocks the "first-fetch is public, then
//      redirect to 169.254.169.254" exfiltration pattern.
//   4. Only http(s) URLs are allowed. file://, ftp://, gopher://, etc. are
//      rejected before resolution.
//   5. The streamed body is bounded by `maxBytes` (the caller-supplied cap,
//      typically 50 KB). The HTML-aware early-stop on `</head>` lives in
//      the og-image extractor; this module only enforces the byte ceiling.
//   6. IPv4-mapped IPv6 literals (`::ffff:127.0.0.1` etc.) and
//      IPv4-compatible literals are unwrapped before block-checking so
//      `http://[::ffff:169.254.169.254]/` cannot dodge the IPv4 list.
//
// IMPORTANT: this module is Deno-only. Node fetch has no equivalent of
// Deno.resolveDns; the Vercel cron path uses a different code path that
// will be retired by B7.

// ---------------------------------------------------------------------------
// Private / special-purpose IP ranges. Mirrors the audit T3 P1-5 requirement.
// Each entry is parsed once at module load and matched against every record
// returned by Deno.resolveDns.
//
// IPv4 blocks (RFC-numbered):
//   10.0.0.0/8        — RFC 1918 private
//   172.16.0.0/12     — RFC 1918 private
//   192.168.0.0/16    — RFC 1918 private
//   127.0.0.0/8       — loopback
//   169.254.0.0/16    — link-local (covers AWS/GCP/Azure metadata 169.254.169.254)
//   0.0.0.0/8         — "this network", current network
//   100.64.0.0/10     — RFC 6598 CGNAT shared address space
//
// IPv6 blocks:
//   ::1/128           — loopback (single host)
//   fc00::/7          — RFC 4193 unique local addresses (ULA)
//   fe80::/10         — link-local
//   2001:db8::/32     — RFC 3849 documentation prefix
//
// Note: we DO NOT block public-but-suspicious ranges like multicast or
// reserved/unassigned — those are not in the audit requirement, and a
// global allowlist would be too strict for legitimate news CDNs.
// ---------------------------------------------------------------------------

interface IPv4Block {
  readonly kind: "v4";
  readonly base: number; // network address as a uint32
  readonly mask: number; // network mask as a uint32
  readonly label: string;
}

interface IPv6Block {
  readonly kind: "v6";
  // 128-bit network address split into two 64-bit halves. For prefix <= 64
  // we only consult `high`; for /65–/128 we also need `low`. The /128 path
  // previously hard-coded `low === 1n`, which silently mis-handled any
  // future /128 entry other than ::1 (Round-6 P2 fix).
  readonly high: bigint;
  readonly low: bigint;
  readonly prefix: number; // 0..128
  readonly label: string;
}

type IPBlock = IPv4Block | IPv6Block;

function parseIPv4(addr: string): number | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  // JS bitwise ops are 32-bit signed; coerce to uint32 for consistent compare.
  return result >>> 0;
}

function parseIPv4Block(cidr: string, label: string): IPv4Block {
  const [addr, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  const base = parseIPv4(addr);
  if (base === null || !Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`invalid IPv4 CIDR: ${cidr}`);
  }
  // prefix=0 → mask=0; prefix=32 → mask=0xffffffff. The conditional avoids
  // the "x << 32 === x" JS quirk.
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  return { kind: "v4", base: (base & mask) >>> 0, mask, label };
}

/**
 * Parse a textual IPv6 address into its high and low 64-bit halves. Returns
 * null on malformed input. Supports `::` shorthand and IPv4-mapped suffixes
 * (`::ffff:1.2.3.4`).
 */
function parseIPv6(addr: string): { high: bigint; low: bigint } | null {
  // Strip a possible zone id (e.g. `fe80::1%eth0`).
  const zoneAt = addr.indexOf("%");
  if (zoneAt !== -1) addr = addr.slice(0, zoneAt);

  // Handle IPv4-mapped tail: split off and convert to two hex groups.
  let tail = "";
  const dotAt = addr.lastIndexOf(".");
  if (dotAt !== -1) {
    const colonAt = addr.lastIndexOf(":", dotAt);
    if (colonAt === -1) return null;
    const v4 = parseIPv4(addr.slice(colonAt + 1));
    if (v4 === null) return null;
    const hi = (v4 >>> 16) & 0xffff;
    const lo = v4 & 0xffff;
    tail = `${hi.toString(16)}:${lo.toString(16)}`;
    addr = addr.slice(0, colonAt + 1) + tail;
  }

  let head: string[];
  let rest: string[];
  if (addr.includes("::")) {
    const [headStr, restStr] = addr.split("::");
    head = headStr ? headStr.split(":") : [];
    rest = restStr ? restStr.split(":") : [];
  } else {
    head = addr.split(":");
    rest = [];
  }

  const total = head.length + rest.length;
  if (total > 8) return null;
  const zeros = 8 - total;
  if (zeros < 0) return null;
  if (!addr.includes("::") && total !== 8) return null;

  const groups: string[] = [...head, ...new Array(zeros).fill("0"), ...rest];
  if (groups.length !== 8) return null;

  let high = 0n;
  let low = 0n;
  for (let i = 0; i < 8; i++) {
    const g = groups[i];
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = BigInt(parseInt(g, 16));
    if (i < 4) high = (high << 16n) | v;
    else low = (low << 16n) | v;
  }
  return { high, low };
}

function parseIPv6Block(cidr: string, label: string): IPv6Block {
  const [addr, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  const parsed = parseIPv6(addr);
  if (parsed === null || !Number.isFinite(prefix) || prefix < 0 || prefix > 128) {
    throw new Error(`invalid IPv6 CIDR: ${cidr}`);
  }
  // Blocks may sit anywhere in 0..128. Store both halves so /65–/128 matches
  // work; for prefix <= 64 the low half is unused (matchIPv6Block ignores it).
  return { kind: "v6", high: parsed.high, low: parsed.low, prefix, label };
}

const BLOCKED_BLOCKS: readonly IPBlock[] = [
  // IPv4 — every range that is unsafe to dial from an unprivileged
  // outbound fetcher. RFC1918 + loopback + link-local + this-net + CGNAT
  // are obvious; Round-6 P2 added the reserved / TEST-NET / benchmark /
  // future-use / multicast / broadcast blocks so a misconfigured outlet
  // (or an attacker who can pick an IP) cannot trick us into a sensitive
  // dial. The "this-network" /8 covers 0.0.0.0 itself.
  parseIPv4Block("10.0.0.0/8", "RFC1918 10.0.0.0/8"),
  parseIPv4Block("172.16.0.0/12", "RFC1918 172.16.0.0/12"),
  parseIPv4Block("192.168.0.0/16", "RFC1918 192.168.0.0/16"),
  parseIPv4Block("127.0.0.0/8", "loopback 127.0.0.0/8"),
  parseIPv4Block("169.254.0.0/16", "link-local 169.254.0.0/16"),
  parseIPv4Block("0.0.0.0/8", "this-network 0.0.0.0/8"),
  parseIPv4Block("100.64.0.0/10", "CGNAT 100.64.0.0/10"),
  parseIPv4Block("198.18.0.0/15", "benchmark 198.18.0.0/15"),
  parseIPv4Block("192.0.0.0/24", "IETF protocol 192.0.0.0/24"),
  parseIPv4Block("192.0.2.0/24", "TEST-NET-1 192.0.2.0/24"),
  parseIPv4Block("198.51.100.0/24", "TEST-NET-2 198.51.100.0/24"),
  parseIPv4Block("203.0.113.0/24", "TEST-NET-3 203.0.113.0/24"),
  parseIPv4Block("224.0.0.0/4", "multicast 224.0.0.0/4"),
  // future-use 240.0.0.0/4 covers 255.255.255.255 (limited broadcast),
  // so no separate /32 entry is needed for the broadcast literal.
  parseIPv4Block("240.0.0.0/4", "future-use 240.0.0.0/4"),
  // IPv6.
  parseIPv6Block("::/128", "unspecified ::"),
  parseIPv6Block("::1/128", "IPv6 loopback ::1"),
  parseIPv6Block("fc00::/7", "IPv6 ULA fc00::/7"),
  parseIPv6Block("fe80::/10", "IPv6 link-local fe80::/10"),
  parseIPv6Block("2001:db8::/32", "IPv6 doc 2001:db8::/32"),
  parseIPv6Block("ff00::/8", "IPv6 multicast ff00::/8"),
];

function matchIPv4Block(addr: number, block: IPv4Block): boolean {
  return ((addr & block.mask) >>> 0) === block.base;
}

function matchIPv6Block(parsed: { high: bigint; low: bigint }, block: IPv6Block): boolean {
  if (block.prefix === 128) {
    // Exact 128-bit match. Previously hard-coded `low === 1n`, which
    // worked only for ::1 and would silently bypass any future /128
    // entry (e.g. ::, which the unspecified-address block now also uses).
    return parsed.high === block.high && parsed.low === block.low;
  }
  if (block.prefix > 64) {
    // /65..127: match the full high half AND the top (prefix-64) bits of
    // the low half.
    if (parsed.high !== block.high) return false;
    const shift = BigInt(128 - block.prefix);
    return (parsed.low >> shift) === (block.low >> shift);
  }
  // /0..64: only the top (prefix) bits of the high half matter.
  const shift = BigInt(64 - block.prefix);
  if (shift < 0n) return false;
  return (parsed.high >> shift) === (block.high >> shift);
}

/**
 * If `parsed` is an IPv4-mapped (`::ffff:0:0/96`) or IPv4-compatible
 * (`::/96`, excluding `::` and `::1`) IPv6 literal, extract the embedded
 * IPv4 address as a uint32. Returns null if the address is a pure v6.
 *
 * This is the heart of the Round-6 P0 fix: without it,
 * `http://[::ffff:127.0.0.1]/` and `http://[::ffff:169.254.169.254]/`
 * dodge every IPv4 block and reach loopback / the EC2 metadata service.
 */
function ipv4MappedToV4(parsed: { high: bigint; low: bigint }): number | null {
  if (parsed.high !== 0n) return null;
  // IPv4-mapped: ::ffff:0:0/96 — top 80 bits zero, next 16 bits 0xffff.
  if ((parsed.low >> 32n) === 0xffffn) {
    return Number(parsed.low & 0xffffffffn) >>> 0;
  }
  // IPv4-compatible: ::0:0:0:0:X.Y.Z.W (deprecated but historically routable).
  // Exclude :: (unspecified) and ::1 (loopback) — those are caught by their
  // own /128 blocks; everything else that fits in the low 32 bits is treated
  // as the embedded v4.
  if ((parsed.low >> 32n) === 0n && parsed.low !== 0n && parsed.low !== 1n) {
    return Number(parsed.low & 0xffffffffn) >>> 0;
  }
  return null;
}

/**
 * Test whether a literal IP address (v4 or v6) falls in any blocked range.
 * Returns the offending block label on match, null otherwise.
 *
 * Non-literal input (e.g. a hostname like "example.com") also returns null —
 * meaning "this is not a literal IP I can classify". Callers MUST treat the
 * null return as "fall through to hostname normalisation + DNS resolution",
 * NOT as "address is safe". The previous contract that returned a truthy
 * string for unparseable input was a footgun: assertHostnameIsPublic would
 * mis-classify every hostname as a "literal IP in blocked range" and refuse
 * every outbound request.
 */
export function isPrivateAddress(ip: string): string | null {
  const v4 = parseIPv4(ip);
  if (v4 !== null) {
    for (const block of BLOCKED_BLOCKS) {
      if (block.kind === "v4" && matchIPv4Block(v4, block)) return block.label;
    }
    return null;
  }
  const v6 = parseIPv6(ip);
  if (v6 !== null) {
    // Round-6 P0 fix: before running the v6 block list, unwrap any
    // IPv4-mapped / IPv4-compatible literal and re-test the embedded v4
    // against every v4 block. Without this, `::ffff:127.0.0.1`,
    // `::ffff:169.254.169.254`, etc. silently pass the guard.
    const mapped = ipv4MappedToV4(v6);
    if (mapped !== null) {
      for (const block of BLOCKED_BLOCKS) {
        if (block.kind === "v4" && matchIPv4Block(mapped, block)) {
          return `${block.label} (via IPv4-mapped IPv6)`;
        }
      }
      // Mapped-but-public: still reject. Legitimate clients have no reason
      // to dial a public v4 through the IPv4-mapped form; the only common
      // use cases are intentional SSRF evasion and broken middleboxes.
      return "IPv4-mapped IPv6 literal (use the bare IPv4 form instead)";
    }
    for (const block of BLOCKED_BLOCKS) {
      if (block.kind === "v6" && matchIPv6Block(v6, block)) return block.label;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hostname resolution + allowlist
// ---------------------------------------------------------------------------

/**
 * Resolve a hostname to every A and AAAA record and reject the request if
 * ANY record falls in a blocked range. Treating "any private record blocks"
 * (rather than "all private records block") closes DNS-rebinding pinholes
 * where an attacker advertises both a public and a private A.
 *
 * Returns null if the host is safe, or a human-readable reason string if it
 * should be blocked.
 */
/**
 * Resolve a hostname and return the public address the DNS lookup resolved
 * to, or a reason string if the host should be blocked.
 *
 * Returns `{ pinIp, ipFamily }` on success. NOTE: `safeResponse` currently
 * calls this only to reject blocked resolutions for plain HTTP — it does
 * NOT rewrite the dial URL to `pinIp`. Rewriting the dial to the literal
 * (an earlier revision did this to close the DNS-rebinding TOCTOU window)
 * requires setting a `Host` header to keep virtual hosting working, but
 * Deno's fetch treats `Host` as a forbidden header and silently drops it,
 * so the origin receives `Host: <ip>` and Cloudflare-fronted / vhosted
 * targets answer 403. The dial therefore uses the hostname URL and accepts
 * the same residual same-resolver rebinding risk HTTPS already accepts —
 * see the module doc comment.
 */
export async function resolveAndPin(
  hostname: string,
): Promise<{ pinIp: string; ipFamily: "v4" | "v6" } | string> {
  const reason = await assertHostnameIsPublic(hostname);
  if (reason !== null) return reason;
  // The literal-IP fast path in assertHostnameIsPublic already validated the
  // address; pin to the literal itself so the fetch dials exactly what we
  // checked.
  const bareHost = hostname.replace(/^\[|\]$/g, "");
  if (parseIPv4(bareHost) !== null) {
    return { pinIp: bareHost, ipFamily: "v4" };
  }
  if (parseIPv6(bareHost) !== null) {
    return { pinIp: bareHost, ipFamily: "v6" };
  }
  // Hostname path. Re-resolve and pick the first public record. This second
  // resolution is racing with the one inside assertHostnameIsPublic, but
  // because we ALSO re-validate the pinned literal below, a rebinding
  // attacker who flips between public and private records will be caught.
  const [a4, a6] = await Promise.allSettled([
    Deno.resolveDns(bareHost, "A"),
    Deno.resolveDns(bareHost, "AAAA"),
  ]);
  const v4s = a4.status === "fulfilled" ? a4.value : [];
  const v6s = a6.status === "fulfilled" ? a6.value : [];
  for (const addr of v4s) {
    if (isPrivateAddress(addr) === null) return { pinIp: addr, ipFamily: "v4" };
  }
  for (const addr of v6s) {
    if (isPrivateAddress(addr) === null) return { pinIp: addr, ipFamily: "v6" };
  }
  return "no public IP found in DNS records (rebinding attempt rejected)";
}

export async function assertHostnameIsPublic(hostname: string): Promise<string | null> {
  // Literal IP fast path — skip DNS, just validate the literal. Only treat
  // the hostname as a literal IP if it actually parses as one; otherwise
  // isPrivateAddress's null return means "not an IP I can classify" and we
  // must fall through to hostname normalisation + DNS resolution below.
  const bareHost = hostname.replace(/^\[|\]$/g, "");
  const isLiteralIp =
    parseIPv4(bareHost) !== null || parseIPv6(bareHost) !== null;
  if (isLiteralIp) {
    const literal = isPrivateAddress(bareHost);
    if (literal !== null) {
      return `literal IP in blocked range (${literal})`;
    }
    // Literal IP that wasn't in a blocked range: safe.
    return null;
  }

  // Hostnames must look like real DNS names. Empty / overly long / control
  // chars are refused outright.
  if (!hostname || hostname.length > 253) return "invalid hostname length";
  if (!/^[a-zA-Z0-9.\-]+$/.test(hostname)) return "hostname contains invalid characters";
  // Disallow "localhost" and trailing-dot variants — even if they don't
  // resolve to 127.0.0.1 on every system, we have no legitimate use case for
  // them in an outbound og:image fetch.
  const normalised = hostname.replace(/\.$/, "").toLowerCase();
  if (normalised === "localhost" || normalised.endsWith(".localhost")) {
    return "localhost host";
  }

  // Resolve A + AAAA in parallel. Either resolver throwing means the host
  // didn't have that record type; both throwing is a real failure.
  const settled = await Promise.allSettled([
    Deno.resolveDns(hostname, "A"),
    Deno.resolveDns(hostname, "AAAA"),
  ]);

  const addrs: string[] = [];
  let resolvedSomething = false;
  for (const result of settled) {
    if (result.status === "fulfilled") {
      resolvedSomething = true;
      for (const a of result.value) addrs.push(a);
    }
  }
  if (!resolvedSomething) return "DNS resolution failed";
  if (addrs.length === 0) return "hostname has no A or AAAA records";

  for (const addr of addrs) {
    const offender = isPrivateAddress(addr);
    if (offender !== null) {
      return `resolved address ${addr} in blocked range (${offender})`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL allowlist
// ---------------------------------------------------------------------------

/**
 * Validate a URL string: must be http(s), must parse, and the hostname must
 * resolve to only public addresses. Returns a parsed URL on success, or a
 * string reason on failure.
 */
export async function validateOutboundUrl(rawUrl: string): Promise<URL | string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "URL did not parse";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `protocol ${parsed.protocol} not allowed (http/https only)`;
  }
  // Strip IPv6 brackets for the resolver.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const reason = await assertHostnameIsPublic(host);
  if (reason !== null) return reason;
  return parsed;
}

// ---------------------------------------------------------------------------
// safeFetch — DNS-validated, manual-redirect, bounded-body HTTP fetcher
// ---------------------------------------------------------------------------

export interface SafeFetchOptions {
  /** Request headers; same shape as RequestInit.headers. */
  readonly headers?: HeadersInit;
  /** Per-request timeout. Defaults to 8000ms. */
  readonly timeoutMs?: number;
  /** Maximum number of bytes streamed from the body. Defaults to 50 KiB. */
  readonly maxBytes?: number;
  /**
   * Optional early-stop predicate. Invoked after each chunk decode with the
   * current accumulated text. If it returns true, the read loop exits. Used
   * by og-image.ts to stop at `</head>` without reading the full cap.
   */
  readonly shouldStopReading?: (accumulated: string) => boolean;
  /** Maximum redirect hops. Defaults to 3. */
  readonly maxRedirects?: number;
}

export interface SafeFetchResult {
  /** Final HTTP status code after redirect handling. */
  readonly status: number;
  /** Final response headers. */
  readonly headers: Headers;
  /** UTF-8-decoded body, truncated to `maxBytes`. */
  readonly body: string;
  /** Final URL after redirects. */
  readonly finalUrl: string;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 50_000;
const DEFAULT_MAX_REDIRECTS = 3;

/**
 * Thrown for any safeFetch-detected violation (SSRF, oversized body, invalid
 * URL, redirect chain exceeded). Callers in og-image.ts catch this broadly
 * and return null — we never leak an SSRF target back to a caller.
 */
export class SafeFetchError extends Error {
  override readonly name = "SafeFetchError";
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// safeResponse — the shared SSRF-guarded redirect loop, body unread
// ---------------------------------------------------------------------------
//
// `safeFetch` below (og-image extraction) and `fetchFeed` in
// `rss/fetcher.ts` (RSS ingest) both need the SAME allow-check + manual-
// redirect + literal-IP-pin behaviour, but they disagree on everything
// about the body: safeFetch wants a UTF-8 string capped at ~50 KB with an
// 8 s budget; fetchFeed wants raw bytes (for its charset-aware decoder and
// the migration-041 body-hash short-circuit), a multi-MB cap, and a 10 s
// budget. Rather than duplicate the guard, `safeResponse` does everything
// UP TO the body — DNS/pin/redirect validation — and hands back the live
// Response for the caller to read under its own rules.

export interface SafeResponseOptions {
  /** Request headers; same shape as RequestInit.headers. */
  readonly headers?: HeadersInit;
  /** Per-request timeout, used only when `signal` is not supplied. Defaults to 8000ms. */
  readonly timeoutMs?: number;
  /**
   * Caller-owned abort signal. When supplied, takes precedence over
   * `timeoutMs` — this lets `safeFetch` share ONE abort budget across both
   * the redirect loop here and its own subsequent body read.
   */
  readonly signal?: AbortSignal;
  /** Maximum redirect hops. Defaults to 3. */
  readonly maxRedirects?: number;
}

export interface SafeResponseResult {
  /** The unread Response for the final (non-redirect) hop. */
  readonly response: Response;
  /** Final URL after redirect handling. */
  readonly finalUrl: string;
}

/**
 * SSRF-safe outbound fetch that stops short of reading the body. Validates
 * the URL (DNS + private-block check) on every hop, disables automatic
 * redirects, re-validates every Location header through the same
 * allowlist, and — for plain HTTP — runs a second DNS validation via
 * resolveAndPin() to reject blocked resolutions. The dial itself always
 * uses the hostname URL (for both HTTP and HTTPS) — see the module doc
 * comment for why HTTP is no longer pinned to the resolved literal.
 *
 * Callers own the body: `response.body` is still open (except for a 3xx
 * hop, which this function drains itself before looping/returning) and
 * MUST be read or cancelled by the caller. Throws SafeFetchError on any
 * policy violation (bad protocol, blocked DNS/literal, blocked redirect
 * target, redirect chain too long).
 */
export async function safeResponse(
  rawUrl: string,
  opts: SafeResponseOptions = {},
): Promise<SafeResponseResult> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  // The caller reads the body AFTER this function returns, so we must NOT
  // start a bare `setTimeout` here — there would be no way for the caller to
  // clear it once control leaves this function, and an uncleared timer would
  // leak. When the caller supplies its own `signal` (safeFetch does, so one
  // budget covers the redirect loop AND its body read) we use that;
  // otherwise `AbortSignal.timeout` self-expires and needs no clearing.
  const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let currentUrl = rawUrl;
  let hops = 0;

  while (true) {
    const validated = await validateOutboundUrl(currentUrl);
    if (typeof validated === "string") {
      throw new SafeFetchError(`URL rejected: ${validated} (url=${currentUrl})`);
    }

    // For plain HTTP, run a second DNS validation via resolveAndPin() so a
    // resolution that flips into a blocked range is still rejected. We do
    // NOT use the pinned literal for the dial, and we do NOT set a `host`
    // header: an earlier revision rewrote the dial URL to the resolved IP
    // literal and set `host` to the original hostname to keep virtual
    // hosting working, but Deno's fetch treats `Host` as a forbidden
    // header and silently drops it — the origin then received
    // `Host: <ip>` and any Cloudflare-fronted or vhosted target answered
    // 403 (production defect, see module doc comment point 2). We instead
    // dial the hostname URL for HTTP exactly as we already do for HTTPS,
    // accepting the same residual same-resolver DNS-rebinding TOCTOU that
    // HTTPS accepts.
    const dialUrl = validated.toString();
    const dialHeaders = new Headers(opts.headers ?? undefined);
    if (validated.protocol === "http:") {
      const pinned = await resolveAndPin(validated.hostname);
      if (typeof pinned === "string") {
        throw new SafeFetchError(`pin rejected: ${pinned} (url=${currentUrl})`);
      }
    }

    const response = await fetch(dialUrl, {
      method: "GET",
      signal,
      headers: dialHeaders,
      redirect: "manual",
    });

    // 3xx with a Location header → cancel the current body, validate the
    // next hop, and loop. We do NOT follow without re-validating; we do NOT
    // follow more than `maxRedirects` hops.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      // Discard the body of the redirect response. Some servers send a
      // small "Redirecting to ..." HTML even on 3xx; we don't need it, and
      // this runs whether or not we end up following (no-Location also
      // drains below via the same cancel call).
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      if (!location) {
        // 3xx without Location: nothing more we can do, return as-is.
        // (Most clients treat this as an error; we surface it via status.)
        // The body is already cancelled above, matching safeFetch's
        // pre-refactor `body: ""` contract for this case.
        return { response, finalUrl: validated.toString() };
      }
      if (hops >= maxRedirects) {
        throw new SafeFetchError(
          `redirect chain exceeded ${maxRedirects} hops (last=${currentUrl} → ${location})`,
        );
      }
      // Resolve Location relative to the validated URL — Location may be
      // absolute or relative per RFC 7231 §7.1.2.
      let nextUrl: string;
      try {
        nextUrl = new URL(location, validated).toString();
      } catch {
        throw new SafeFetchError(`unparseable Location header: ${location}`);
      }
      currentUrl = nextUrl;
      hops += 1;
      continue;
    }

    // Non-redirect (including 304): return the response as-is, unread, for
    // the caller to consume under its own body-reading rules.
    const finalUrl = response.url || currentUrl;
    return { response, finalUrl };
  }
}

/**
 * SSRF-safe outbound fetch. Thin decode-and-cap wrapper over `safeResponse`:
 * it owns the timeout/AbortController lifecycle and the bounded UTF-8 body
 * read; all DNS/redirect/pin validation lives in `safeResponse`.
 *
 * Throws SafeFetchError on any policy violation. Callers should catch and
 * return null — see og-image.ts for the canonical pattern.
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Pass our own controller signal through so the redirect loop AND the
    // body read below share one timeout budget — safeResponse never starts
    // its own timer when a signal is supplied.
    const { response, finalUrl } = await safeResponse(rawUrl, {
      headers: opts.headers,
      signal: controller.signal,
      maxRedirects,
    });

    // ---- Bounded body read ------------------------------------------------
    const reader = response.body?.getReader();
    if (!reader) {
      return {
        status: response.status,
        headers: response.headers,
        body: "",
        finalUrl,
      };
    }
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let accumulated = "";
    let bytesRead = 0;
    try {
      while (bytesRead < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        // Slice the final chunk to the maxBytes boundary so the caller never
        // sees more than the requested ceiling.
        let chunk: Uint8Array = value;
        if (bytesRead > maxBytes) {
          const overshoot = bytesRead - maxBytes;
          chunk = value.subarray(0, value.byteLength - overshoot);
          accumulated += decoder.decode(chunk, { stream: false });
          break;
        }
        accumulated += decoder.decode(chunk, { stream: true });
        if (opts.shouldStopReading && opts.shouldStopReading(accumulated)) break;
      }
    } finally {
      // Always cancel the reader to free the socket. cancel() can itself
      // throw if the socket was already torn down — swallow so safeFetch's
      // contract (only SafeFetchError or fetch-level errors propagate) holds.
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }

    return {
      status: response.status,
      headers: response.headers,
      body: accumulated,
      finalUrl,
    };
  } finally {
    clearTimeout(timer);
  }
}
