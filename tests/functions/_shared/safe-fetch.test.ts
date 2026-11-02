import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Direct coverage for supabase/functions/_shared/safe-fetch.ts (audit T3 P1-5).
//
// The image-consumer test already exercises safeFetch *transitively* (through
// a vi.mock of the module that swaps in a deny-list stub), but Round-2 QA
// flagged that the module itself had zero direct tests — so a regression in
// the IPv6 parser, the DNS-rebinding allowlist, the manual-redirect loop, or
// the protocol gate would slip through. This file imports the REAL module
// (no vi.mock on safe-fetch.ts) and drives it through the audit's threat
// matrix: literal metadata addresses, IPv6 special-purpose blocks, CGNAT,
// hostnames whose DNS records point into private space (including the mixed
// public-plus-private DNS-rebinding shape), redirect-into-metadata, and
// non-http schemes.
//
// Deno globals (resolveDns + serve) don't exist in the vitest Node env, so
// we stub them per-test with vi.stubGlobal and tear the stubs down after each
// case to keep the suite hermetic.
// ---------------------------------------------------------------------------

import {
  assertHostnameIsPublic,
  isPrivateAddress,
  resolveAndPin,
  safeFetch,
  SafeFetchError,
  safeResponse,
  validateOutboundUrl,
} from "../../../supabase/functions/_shared/safe-fetch.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DenoStub {
  resolveDns: ReturnType<typeof vi.fn>;
  // safe-fetch.ts itself never calls Deno.serve, but the function-level
  // tests in the rest of the suite assume Deno.serve exists, so we provide a
  // no-op to mirror that environment shape.
  serve: ReturnType<typeof vi.fn>;
}

/**
 * Install a Deno global whose `resolveDns` returns `aRecords` for "A"
 * lookups and `aaaaRecords` for "AAAA" lookups. Either array may be empty
 * (resolver rejects with a "NotFound"-shaped error, which Promise.allSettled
 * surfaces as a rejection — the same shape Deno.resolveDns has in production
 * when only one record family exists).
 */
function stubResolveDns(
  aRecords: string[],
  aaaaRecords: string[] = [],
): DenoStub {
  const resolveDns = vi.fn(async (_host: string, recordType: string) => {
    if (recordType === "A") {
      if (aRecords.length === 0) {
        throw new Error("NotFound");
      }
      return aRecords;
    }
    if (recordType === "AAAA") {
      if (aaaaRecords.length === 0) {
        throw new Error("NotFound");
      }
      return aaaaRecords;
    }
    throw new Error(`unexpected record type ${recordType}`);
  });
  const stub: DenoStub = { resolveDns, serve: vi.fn() };
  vi.stubGlobal("Deno", stub);
  return stub;
}

/**
 * Stub global fetch with a queue of responses. Each call shifts the next
 * Response off the queue. Used to drive the manual-redirect loop through a
 * 302 → metadata flow without ever touching the network.
 */
function queueFetchResponses(responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchStub = vi.fn(async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error("fetch stub queue exhausted");
    }
    return next;
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// isPrivateAddress — pure literal-IP classifier
// ---------------------------------------------------------------------------

describe("isPrivateAddress", () => {
  it("flags the AWS / GCP / Azure metadata IPv4 literal", () => {
    const label = isPrivateAddress("169.254.169.254");
    expect(label).not.toBeNull();
    expect(label).toMatch(/link-local/i);
  });

  it("flags IPv6 loopback ::1", () => {
    expect(isPrivateAddress("::1")).toMatch(/loopback/i);
  });

  it("flags CGNAT 100.64.0.1 (RFC 6598)", () => {
    expect(isPrivateAddress("100.64.0.1")).toMatch(/CGNAT/i);
  });

  it("flags IPv6 ULA fc00::1 (RFC 4193)", () => {
    expect(isPrivateAddress("fc00::1")).toMatch(/ULA/i);
  });

  it("flags IPv6 link-local fe80::1", () => {
    expect(isPrivateAddress("fe80::1")).toMatch(/link-local/i);
  });

  it("flags IPv6 documentation 2001:db8::1 (RFC 3849)", () => {
    expect(isPrivateAddress("2001:db8::1")).toMatch(/doc/i);
  });

  it("accepts a routable public IPv4 (1.1.1.1)", () => {
    expect(isPrivateAddress("1.1.1.1")).toBeNull();
  });

  // Round-6 P0 regression — IPv4-mapped IPv6 must not bypass the v4 blocks.
  // Before the fix, every literal below returned null and a hostile feed
  // could pull EC2 IMDS, AWS metadata, loopback, or RFC1918 over an HTTP
  // request to `http://[::ffff:<addr>]/`.
  it("flags ::ffff:169.254.169.254 (IPv4-mapped IMDS)", () => {
    expect(isPrivateAddress("::ffff:169.254.169.254")).toMatch(/link-local/i);
  });

  it("flags ::ffff:127.0.0.1 (IPv4-mapped loopback)", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toMatch(/loopback/i);
  });

  it("flags ::ffff:10.0.0.1 (IPv4-mapped RFC1918)", () => {
    expect(isPrivateAddress("::ffff:10.0.0.1")).toMatch(/RFC1918/i);
  });

  it("rejects ::ffff:1.1.1.1 (mapped-but-public also blocked)", () => {
    // Legitimate clients have no reason to dial public IPv4 through the
    // mapped form; the only common case is intentional SSRF evasion.
    expect(isPrivateAddress("::ffff:1.1.1.1")).toMatch(/IPv4-mapped/i);
  });

  it("flags :: (unspecified)", () => {
    expect(isPrivateAddress("::")).toMatch(/unspecified/i);
  });

  it("flags 240.1.2.3 (future-use)", () => {
    expect(isPrivateAddress("240.1.2.3")).toMatch(/future-use/i);
  });

  it("flags 255.255.255.255 (caught by future-use 240/4 superset)", () => {
    expect(isPrivateAddress("255.255.255.255")).toMatch(/future-use/i);
  });

  it("flags 224.0.0.1 (multicast)", () => {
    expect(isPrivateAddress("224.0.0.1")).toMatch(/multicast/i);
  });

  it("flags 198.18.0.1 (benchmark)", () => {
    expect(isPrivateAddress("198.18.0.1")).toMatch(/benchmark/i);
  });

  it("flags 198.51.100.1 (TEST-NET-2)", () => {
    expect(isPrivateAddress("198.51.100.1")).toMatch(/TEST-NET-2/);
  });

  it("flags ff02::1 (IPv6 multicast)", () => {
    expect(isPrivateAddress("ff02::1")).toMatch(/multicast/i);
  });
});

// ---------------------------------------------------------------------------
// assertHostnameIsPublic — DNS-aware allowlist (includes rebinding shape)
// ---------------------------------------------------------------------------

describe("assertHostnameIsPublic", () => {
  it("rejects the literal 'localhost' hostname before touching DNS", async () => {
    // No DNS stub installed: if the implementation tried to resolve, the
    // missing Deno global would throw a different error. The hostname rule
    // has to fire on the string match alone.
    const reason = await assertHostnameIsPublic("localhost");
    expect(reason).toMatch(/localhost/i);
  });

  it("blocks a hostname whose A record sits in RFC 1918 (10.0.0.5)", async () => {
    stubResolveDns(["10.0.0.5"]);
    const reason = await assertHostnameIsPublic("rebind.example");
    expect(reason).toMatch(/blocked range/i);
    expect(reason).toMatch(/10\.0\.0\.5/);
  });

  it("blocks the DNS-rebinding mixed-record shape (one public, one private)", async () => {
    // Classic rebinding: an attacker advertises BOTH a public A and a
    // private A. The "any private record blocks" policy must catch it on
    // the private record, even though a public record is present.
    stubResolveDns(["8.8.8.8", "192.168.1.10"]);
    const reason = await assertHostnameIsPublic("mixed.example");
    expect(reason).toMatch(/192\.168\.1\.10/);
    expect(reason).toMatch(/blocked range/i);
  });

  it("accepts a hostname that resolves only to a single public IPv4", async () => {
    stubResolveDns(["8.8.8.8"]);
    const reason = await assertHostnameIsPublic("public.example");
    expect(reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateOutboundUrl — scheme + hostname allowlist
// ---------------------------------------------------------------------------

describe("validateOutboundUrl", () => {
  it("rejects file:// URLs before any DNS lookup", async () => {
    // The protocol check fires before resolveDns, so no DNS stub is needed.
    const result = await validateOutboundUrl("file:///etc/passwd");
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/protocol/i);
    expect(result as string).toMatch(/file:/i);
  });

  it("rejects a literal [::1] URL on the IPv6 loopback fast path", async () => {
    const result = await validateOutboundUrl("http://[::1]/whatever");
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/blocked range/i);
  });

  it("rejects a literal 169.254.169.254 URL", async () => {
    const result = await validateOutboundUrl("http://169.254.169.254/latest/meta-data");
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/link-local/i);
  });
});

// ---------------------------------------------------------------------------
// safeFetch — end-to-end policy enforcement
// ---------------------------------------------------------------------------

describe("safeFetch", () => {
  it("throws SafeFetchError for the literal AWS metadata URL", async () => {
    await expect(
      safeFetch("http://169.254.169.254/latest/meta-data/iam"),
    ).rejects.toBeInstanceOf(SafeFetchError);
  });

  it("throws SafeFetchError for the literal [::1] URL", async () => {
    await expect(safeFetch("http://[::1]/")).rejects.toBeInstanceOf(SafeFetchError);
  });

  it("throws SafeFetchError for literal CGNAT 100.64.0.1", async () => {
    await expect(safeFetch("http://100.64.0.1/")).rejects.toBeInstanceOf(SafeFetchError);
  });

  it("throws SafeFetchError for literal IPv6 ULA [fc00::1]", async () => {
    await expect(safeFetch("http://[fc00::1]/")).rejects.toBeInstanceOf(SafeFetchError);
  });

  it("throws SafeFetchError for literal IPv6 link-local [fe80::1]", async () => {
    await expect(safeFetch("http://[fe80::1]/")).rejects.toBeInstanceOf(SafeFetchError);
  });

  it("throws SafeFetchError for literal IPv6 documentation [2001:db8::1]", async () => {
    await expect(
      safeFetch("http://[2001:db8::1]/"),
    ).rejects.toBeInstanceOf(SafeFetchError);
  });

  it("throws SafeFetchError for file:// URLs", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toBeInstanceOf(SafeFetchError);
  });

  it("throws SafeFetchError when the hostname is 'localhost'", async () => {
    // No DNS stub: the localhost short-circuit must trip purely on the
    // hostname string before any resolver call.
    await expect(safeFetch("http://localhost/admin")).rejects.toBeInstanceOf(
      SafeFetchError,
    );
  });

  it("throws SafeFetchError when Deno.resolveDns returns a private A record", async () => {
    stubResolveDns(["10.0.0.5"]);
    await expect(safeFetch("http://rebind.example/")).rejects.toBeInstanceOf(
      SafeFetchError,
    );
  });

  it("throws SafeFetchError on DNS-rebinding mixed (public + private) records", async () => {
    stubResolveDns(["8.8.8.8", "172.16.0.4"]);
    await expect(safeFetch("http://mixed.example/")).rejects.toBeInstanceOf(
      SafeFetchError,
    );
  });

  it("re-validates the Location header and blocks a 302 → 169.254.169.254 hop", async () => {
    // First hop: public DNS resolution lets the initial fetch happen.
    stubResolveDns(["8.8.8.8"]);
    queueFetchResponses([
      // Hop 1: 302 pointing the manual-redirect loop at the metadata IP.
      new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/latest/meta-data/iam" },
      }),
      // Hop 2 would only fire if validation passed (it must not).
      new Response("nope", { status: 200 }),
    ]);

    await expect(safeFetch("http://public.example/start")).rejects.toBeInstanceOf(
      SafeFetchError,
    );
  });

  it("returns successfully when DNS resolves to a single public IPv4 (happy path)", async () => {
    stubResolveDns(["8.8.8.8"]);
    queueFetchResponses([
      new Response("<html><head><title>ok</title></head></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    ]);

    const result = await safeFetch("http://public.example/");
    expect(result.status).toBe(200);
    expect(result.body).toContain("<title>ok</title>");
  });

  // Round-4 regression: pre-fix, isPrivateAddress returned the truthy string
  // "unparseable address" for any non-IP input, so assertHostnameIsPublic's
  // literal-IP fast path mis-classified "example.com" as a "literal IP in
  // blocked range" and safeFetch rejected every hostname before DNS ran. The
  // fix returns null for non-literal input and skips the fast path entirely
  // unless the hostname actually parses as a v4 / v6 literal.
  it("does NOT throw on a regular hostname URL when DNS resolves to a public IP (regression)", async () => {
    stubResolveDns(["93.184.215.14"]);
    queueFetchResponses([
      new Response(
        '<html><head><meta property="og:image" content="https://cdn.example.com/cover.jpg" /></head></html>',
        { status: 200, headers: { "Content-Type": "text/html" } },
      ),
    ]);

    const result = await safeFetch(
      new URL("https://example.com/feed.xml").toString(),
    );
    expect(result.status).toBe(200);
    expect(result.body).toContain("og:image");
  });

  // Regression (production defect, PR #43): earlier revisions rewrote the
  // HTTP dial to the validated literal IP and set a "host" header to
  // preserve virtual hosting. Deno's fetch treats `Host` as a forbidden
  // header and silently drops it, so the origin received `Host: <ip>` and
  // any Cloudflare-fronted / vhosted target answered 403 — 14 of 118
  // http: feeds started failing. The fix: still DNS-validate (via
  // resolveAndPin) so a blocked resolution is rejected, but dial the
  // HOSTNAME URL exactly as the HTTPS path does, and do not set a host
  // header at all.
  it("dials the hostname URL for plain HTTP (no IP-literal rewrite, no host header)", async () => {
    const PUBLIC_IP = "93.184.216.34";
    stubResolveDns([PUBLIC_IP]);
    const fetchStub = queueFetchResponses([
      new Response("<html><head></head></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    ]);

    const result = await safeFetch("http://example.com/path");

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [dialUrl, init] = fetchStub.mock.calls[0];
    // The socket is opened against the hostname URL, not the resolved
    // literal — mirroring the HTTPS path exactly.
    expect(dialUrl).toBe("http://example.com/path");
    expect(dialUrl).not.toContain(PUBLIC_IP);
    // No host header is set (Deno's fetch would silently drop it anyway,
    // which was the root cause of the production 403s).
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.has("host")).toBe(false);
    // finalUrl must reflect the hostname URL, not an IP literal.
    expect(result.finalUrl).toBe("http://example.com/path");
  });

  // The DNS-validation step for plain HTTP must still reject a hostname
  // whose resolution is blocked, even though the dial itself is no longer
  // pinned to the literal. This proves resolveAndPin's allow-check still
  // runs on the http: path.
  it("still rejects an HTTP hostname whose resolution is blocked, even without pinning the dial", async () => {
    stubResolveDns(["10.0.0.5"]);
    await expect(safeFetch("http://rebind.example/path")).rejects.toBeInstanceOf(
      SafeFetchError,
    );
  });

  // Documented trade-off: HTTPS is NOT pinned. The hostname stays in the URL
  // so the platform TLS client uses it for the SNI handshake and certificate
  // verification; pinning to a literal would break cert validation. We accept
  // the residual same-resolver rebinding risk in exchange for correct TLS.
  it("does NOT pin HTTPS — the hostname is retained in the dial for SNI/TLS", async () => {
    stubResolveDns(["93.184.216.34"]);
    const fetchStub = queueFetchResponses([
      new Response("<html><head></head></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    ]);

    await safeFetch("https://example.com/path");

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [dialUrl] = fetchStub.mock.calls[0];
    expect(dialUrl).toContain("example.com");
    expect(dialUrl).not.toContain("93.184.216.34");
    expect(dialUrl).toBe("https://example.com/path");
  });
});

// ---------------------------------------------------------------------------
// safeResponse — the shared primitive fetchFeed (RSS ingest, SEC-01) also
// builds on. Proves the redirect/DNS/pin guard behaves the same as it did
// inside safeFetch pre-refactor, and that the body is left unread for the
// caller to consume under its own rules (no 50 KB cap, no UTF-8 decode).
// ---------------------------------------------------------------------------

describe("safeResponse", () => {
  it("returns an unread 200 Response with no cap and no decode applied", async () => {
    stubResolveDns(["93.184.216.34"]);
    // Larger than safeFetch's DEFAULT_MAX_BYTES (50 000) — proves
    // safeResponse itself enforces no cap; that ceiling only exists in
    // safeFetch's own bounded read layered on top.
    const bigBody = "a".repeat(60_000);
    queueFetchResponses([
      new Response(bigBody, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    ]);

    const { response, finalUrl } = await safeResponse("https://example.com/big");
    const buf = await response.arrayBuffer();
    expect(buf.byteLength).toBe(60_000);
    expect(response.status).toBe(200);
    expect(finalUrl).toBe("https://example.com/big");
  });

  it("returns a 304 untouched without following anything", async () => {
    stubResolveDns(["93.184.216.34"]);
    const fetchStub = queueFetchResponses([
      new Response(null, { status: 304 }),
    ]);

    const { response } = await safeResponse("https://example.com/feed.xml");
    expect(response.status).toBe(304);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("throws SafeFetchError for the literal 169.254.169.254 URL", async () => {
    await expect(
      safeResponse("http://169.254.169.254/latest/meta-data"),
    ).rejects.toBeInstanceOf(SafeFetchError);
  });

  it("rejects a 302 hop into 169.254.169.254", async () => {
    stubResolveDns(["8.8.8.8"]);
    queueFetchResponses([
      new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/latest/meta-data" },
      }),
      // Would only be reached if the Location re-validation failed to fire.
      new Response("nope", { status: 200 }),
    ]);

    await expect(
      safeResponse("http://public.example/start"),
    ).rejects.toBeInstanceOf(SafeFetchError);
  });

  it("throws when the redirect chain exceeds maxRedirects", async () => {
    stubResolveDns(["8.8.8.8"]);
    queueFetchResponses([
      new Response(null, {
        status: 302,
        headers: { Location: "http://public-2.example/next" },
      }),
      new Response(null, {
        status: 302,
        headers: { Location: "http://public-3.example/next" },
      }),
      // Never reached — the chain is rejected on the second hop.
      new Response("nope", { status: 200 }),
    ]);

    await expect(
      safeResponse("http://public.example/start", { maxRedirects: 1 }),
    ).rejects.toBeInstanceOf(SafeFetchError);
  });

  it("forwards caller headers onto the dialed request", async () => {
    stubResolveDns(["93.184.216.34"]);
    const fetchStub = queueFetchResponses([
      new Response("ok", { status: 200 }),
    ]);

    await safeResponse("https://example.com/feed.xml", {
      headers: { "If-None-Match": '"abc"' },
    });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [, init] = fetchStub.mock.calls[0];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("if-none-match")).toBe('"abc"');
  });
});

// ---------------------------------------------------------------------------
// h29 parity: the Node webhook guard (src/lib/alerts/webhook-url.ts) refuses
// NAT64 64:ff9b::/96, 6to4 2002::/16, site-local fec0::/10 and 192.88.99.0/24;
// the Edge guard must refuse the same whole ranges (no unwrapping of the
// embedded IPv4). tests/guards/ssrf-blocklist-parity.test.ts keeps the two
// lists in step; this table pins the Edge side directly.
// ---------------------------------------------------------------------------

describe("isPrivateAddress h29 parity", () => {
  it.each([
    // NAT64 64:ff9b::/96, embedded 127.0.0.1 / 169.254.169.254 / 8.8.8.8
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::808:808",
    // 6to4 2002::/16, the bare prefix and embedded loopback / metadata
    "2002::",
    "2002:7f00:1::",
    "2002:a9fe:a9fe::",
    // site-local fec0::/10, first and last /16 of the range
    "fec0::1",
    "feff::1",
    // 6to4 relay anycast 192.88.99.0/24, first / middle / last
    "192.88.99.0",
    "192.88.99.1",
    "192.88.99.255",
  ])("blocks %s", (ip) => {
    expect(isPrivateAddress(ip), ip).not.toBeNull();
  });

  it.each([
    "1.1.1.1",
    // just outside 192.88.99.0/24
    "192.88.98.255",
    "192.88.100.0",
    "2606:4700:4700::1111",
    "2a00:1450:4001::64",
    // NAT64's local-use prefix 64:ff9b:1::/48 is NOT the well-known /96
    "64:ff9b:1::1",
    // neighbours of fe80::/10 + fec0::/10 + ff00::/8
    "fe00::1",
    // Teredo 2001::/32 and the /16 after 6to4
    "2001::1",
    "2003::1",
  ])("does not block %s", (ip) => {
    expect(isPrivateAddress(ip), ip).toBeNull();
  });
});

describe("h29 ranges are refused through every entry point", () => {
  it.each([
    "http://[64:ff9b::7f00:1]/",
    "http://[64:ff9b::169.254.169.254]/latest/meta-data",
    "http://[2002:a9fe:a9fe::]/",
    "http://[fec0::1]/",
    "http://192.88.99.1/",
  ])("safeFetch(%s) throws SafeFetchError without dialling", async (url) => {
    const fetchStub = queueFetchResponses([new Response("never served", { status: 200 })]);
    await expect(safeFetch(url)).rejects.toBeInstanceOf(SafeFetchError);
    expect(fetchStub).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["NAT64", "64:ff9b::a9fe:a9fe"],
    ["6to4", "2002:7f00:1::"],
    ["site-local", "fec0::1"],
  ])("rejects a hostname whose AAAA record is %s (%s), even beside a public A", async (_label, aaaa) => {
    stubResolveDns(["93.184.216.34"], [aaaa]);
    const reason = await assertHostnameIsPublic("sneaky.example");
    expect(reason).toMatch(/blocked range/);
    expect(reason).toContain(aaaa);
  });

  it("rejects a redirect hop into a NAT64-wrapped metadata address", async () => {
    stubResolveDns(["93.184.216.34"]);
    const fetchStub = queueFetchResponses([
      new Response(null, {
        status: 302,
        headers: { Location: "http://[64:ff9b::a9fe:a9fe]/latest/meta-data" },
      }),
      new Response("never served", { status: 200 }),
    ]);
    await expect(safeFetch("https://public.example/start")).rejects.toBeInstanceOf(SafeFetchError);
    // Only the first hop was dialled.
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each([
    "64:FF9B::7F00:1",
    "0064:ff9b:0000:0000:0000:0000:7f00:0001",
    "2002:A9FE:A9FE::",
    "FEC0::1",
    "fec0::1%eth0",
  ])("is case, zero-padding and zone-id insensitive: %s", (ip) => {
    expect(isPrivateAddress(ip), ip).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fail-closed branches: DNS failure, empty answers, malformed hostnames, the
// resolveAndPin rebinding re-check, the http pin rejection, and the bounded
// body reader. Per-record-type call counters prove which lookups ran; fetch is
// always a stub, so nothing here touches the network.
// ---------------------------------------------------------------------------

interface DnsHandlers {
  /** Called with the 1-based count of lookups of that record type so far. */
  A: (callNo: number) => Promise<string[]>;
  AAAA: (callNo: number) => Promise<string[]>;
}

function stubDnsPerType(handlers: DnsHandlers): {
  calls: { A: number; AAAA: number };
  resolveDns: ReturnType<typeof vi.fn>;
} {
  const calls = { A: 0, AAAA: 0 };
  const resolveDns = vi.fn(async (_host: string, recordType: string) => {
    if (recordType !== "A" && recordType !== "AAAA") {
      throw new Error(`unexpected record type ${recordType}`);
    }
    calls[recordType] += 1;
    return handlers[recordType](calls[recordType]);
  });
  vi.stubGlobal("Deno", { resolveDns, serve: vi.fn() });
  return { calls, resolveDns };
}

const rejectLookup = (): Promise<string[]> => Promise.reject(new Error("NotFound"));
const answer = (...ips: string[]) => (): Promise<string[]> => Promise.resolve(ips);

/** A byte stream that hands out one chunk per pull and records pulls / cancel. */
function chunkedStream(chunks: string[]): {
  stream: ReadableStream<Uint8Array>;
  state: { pulls: number; cancelled: boolean };
} {
  const encoder = new TextEncoder();
  const state = { pulls: 0, cancelled: false };
  let next = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls += 1;
        const chunk = chunks[next];
        next += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    // highWaterMark 0: the stream never reads ahead, so pulls == chunks the
    // consumer actually asked for.
    { highWaterMark: 0 },
  );
  return { stream, state };
}

describe("assertHostnameIsPublic fail-closed branches", () => {
  it("fails closed with 'DNS resolution failed' when both resolvers reject", async () => {
    const dns = stubDnsPerType({ A: rejectLookup, AAAA: rejectLookup });
    expect(await assertHostnameIsPublic("down.example")).toBe("DNS resolution failed");
    expect(dns.calls).toEqual({ A: 1, AAAA: 1 });
  });

  it("fails closed when both resolvers answer with empty lists", async () => {
    const dns = stubDnsPerType({ A: answer(), AAAA: answer() });
    expect(await assertHostnameIsPublic("empty.example")).toBe(
      "hostname has no A or AAAA records",
    );
    expect(dns.calls).toEqual({ A: 1, AAAA: 1 });
  });

  it("rejects a hostname with an underscore before any DNS lookup", async () => {
    const dns = stubDnsPerType({ A: answer("8.8.8.8"), AAAA: answer("2606:4700::1111") });
    expect(await assertHostnameIsPublic("a_b.example")).toMatch(/invalid characters/);
    expect(dns.resolveDns).not.toHaveBeenCalled();
  });

  it("rejects a 254-character hostname before any DNS lookup", async () => {
    const dns = stubDnsPerType({ A: answer("8.8.8.8"), AAAA: answer("2606:4700::1111") });
    expect(await assertHostnameIsPublic("a".repeat(254))).toBe("invalid hostname length");
    expect(dns.resolveDns).not.toHaveBeenCalled();
  });
});

describe("resolveAndPin", () => {
  it("rejects a hostname whose second A lookup flips to a private address", async () => {
    const dns = stubDnsPerType({
      A: (n) => Promise.resolve(n === 1 ? ["93.184.216.34"] : ["10.0.0.5"]),
      AAAA: rejectLookup,
    });
    const pinned = await resolveAndPin("rebind.example");
    expect(typeof pinned).toBe("string");
    expect(pinned as string).toContain("rebinding attempt rejected");
    // One validation pass plus the pin pass: two A lookups.
    expect(dns.calls.A).toBe(2);
  });

  it("pins the first public AAAA record when only IPv6 resolves", async () => {
    stubDnsPerType({ A: rejectLookup, AAAA: answer("2606:4700::1111") });
    expect(await resolveAndPin("v6only.example")).toEqual({
      pinIp: "2606:4700::1111",
      ipFamily: "v6",
    });
  });

  it("pins a literal IPv4 without any DNS lookup", async () => {
    const dns = stubDnsPerType({ A: rejectLookup, AAAA: rejectLookup });
    expect(await resolveAndPin("93.184.216.34")).toEqual({
      pinIp: "93.184.216.34",
      ipFamily: "v4",
    });
    expect(dns.resolveDns).not.toHaveBeenCalled();
  });
});

describe("safeFetch fail-closed branches", () => {
  it("rejects an http hop whose pin lookup flips to the metadata address, without fetching", async () => {
    stubDnsPerType({
      A: (n) => Promise.resolve(n === 1 ? ["93.184.216.34"] : ["169.254.169.254"]),
      AAAA: rejectLookup,
    });
    const fetchStub = queueFetchResponses([new Response("never served", { status: 200 })]);

    const error = await safeFetch("http://flip.example/").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SafeFetchError);
    expect((error as SafeFetchError).message).toMatch(/pin rejected/);
    expect(fetchStub).toHaveBeenCalledTimes(0);
  });

  it("cuts the body at maxBytes, slicing inside the chunk that crosses the ceiling", async () => {
    stubDnsPerType({ A: answer("93.184.216.34"), AAAA: rejectLookup });
    const { stream, state } = chunkedStream(["aaaa", "bbbb", "cccc"]);
    queueFetchResponses([new Response(stream, { status: 200 })]);

    const result = await safeFetch("https://example.com/big", { maxBytes: 6 });
    expect(result.body).toBe("aaaabb");
    // Chunk three was never requested and the socket was released.
    expect(state.pulls).toBe(2);
    expect(state.cancelled).toBe(true);
  });

  it("stops reading as soon as shouldStopReading says so", async () => {
    stubDnsPerType({ A: answer("93.184.216.34"), AAAA: rejectLookup });
    const { stream, state } = chunkedStream(["aaaa", "bbbb", "cccc"]);
    queueFetchResponses([new Response(stream, { status: 200 })]);

    const result = await safeFetch("https://example.com/head", {
      shouldStopReading: (accumulated) => accumulated.includes("aaaa"),
    });
    expect(result.body).toBe("aaaa");
    expect(state.pulls).toBe(1);
    expect(state.cancelled).toBe(true);
  });

  it("returns an empty body for a bodyless 204", async () => {
    stubDnsPerType({ A: answer("93.184.216.34"), AAAA: rejectLookup });
    queueFetchResponses([new Response(null, { status: 204 })]);

    const result = await safeFetch("https://example.com/none");
    expect(result.status).toBe(204);
    expect(result.body).toBe("");
  });
});
