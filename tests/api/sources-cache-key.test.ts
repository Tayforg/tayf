import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// ---------------------------------------------------------------------------
// /api/sources and /api/sources/[slug] read through the cached, 4 s-capped
// readers in src/lib/sources/registry-query.ts. The cache key MUST be built
// from values the server controls: a bare `getRegistryRows()` for the list and
// the source ROW ID (taken from the registry rows, never from the URL) for the
// detail. If a cache-buster in the query string, or an arbitrary well-formed
// slug, could reach the key, an anonymous caller could mint unbounded cache
// entries and force a Supabase read per request.
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const registry = vi.hoisted(() => ({
  getRegistryRows: vi.fn(),
  getRegistryDetail: vi.fn(),
}));

vi.mock("@/lib/sources/registry-query", () => registry);

const ROWS = [
  {
    id: "src-1",
    slug: "haberturk",
    name: "Habertürk",
    url: "https://www.haberturk.com",
    bias: "gov_leaning",
    kind: "outlet",
    active: true,
    zone_rationale: null,
    zone_rationale_at: null,
    trustee_since: null,
    trustee_note: null,
  },
  {
    id: "src-2",
    slug: "tele1",
    name: "Tele1",
    url: "https://www.tele1.com.tr",
    bias: "opposition_leaning",
    kind: "outlet",
    active: true,
    zone_rationale: null,
    zone_rationale_at: null,
    trustee_since: null,
    trustee_note: null,
  },
];

const DETAIL = {
  zone_history: [
    {
      old_bias: "center",
      new_bias: "gov_leaning",
      reason: "r",
      rater: "editör",
      changed_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  reader_agreement: { n: 30, share: 0.633 },
};

beforeEach(() => {
  registry.getRegistryRows.mockReset();
  registry.getRegistryDetail.mockReset();
  registry.getRegistryRows.mockResolvedValue(ROWS);
  registry.getRegistryDetail.mockResolvedValue(DETAIL);
});

let ipCounter = 0;
/** A fresh client IP per call so no test inherits another's rate-limit bucket. */
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function listRequest(query = "", ip = freshIp()): Request {
  return new Request(`http://example.com/api/sources${query}`, {
    headers: { "x-forwarded-for": ip },
  });
}

function detailRequest(slug: string, query = "", ip = freshIp()): Request {
  return new Request(`http://example.com/api/sources/${slug}${query}`, {
    headers: { "x-forwarded-for": ip },
  });
}

const paramsFor = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe("GET /api/sources cache key", () => {
  it("calls getRegistryRows() with no arguments whatever the query string says", async () => {
    const { GET } = await import("@/app/api/sources/route");

    for (const query of ["?cb=1", "?cb=2", "?cb=1&cb=2&x=%00", ""]) {
      const res = await GET(listRequest(query));
      expect(res.status).toBe(200);
    }

    expect(registry.getRegistryRows).toHaveBeenCalledTimes(4);
    for (const call of registry.getRegistryRows.mock.calls) {
      expect(call).toEqual([]);
    }
  });

  it("serves the same body for different cache-busters", async () => {
    const { GET } = await import("@/app/api/sources/route");
    const a = await (await GET(listRequest("?cb=1"))).json();
    const b = await (await GET(listRequest("?cb=2"))).json();
    expect(a.sources).toEqual(b.sources);
    expect(a.count).toBe(ROWS.length);
    // The id is the cache key's business, never part of the public record.
    expect(JSON.stringify(a.sources)).not.toContain("src-1");
  });
});

describe("GET /api/sources/[slug] cache key", () => {
  it("looks the slug up in the registry rows, then keys the detail by the row id", async () => {
    const { GET } = await import("@/app/api/sources/[slug]/route");

    for (const query of ["?cb=1", "?cb=2"]) {
      const res = await GET(
        detailRequest("haberturk", query),
        paramsFor("haberturk"),
      );
      expect(res.status).toBe(200);
    }

    expect(registry.getRegistryRows).toHaveBeenCalledTimes(2);
    for (const call of registry.getRegistryRows.mock.calls) {
      expect(call).toEqual([]);
    }
    expect(registry.getRegistryDetail).toHaveBeenCalledTimes(2);
    expect(registry.getRegistryDetail.mock.calls).toEqual([
      ["src-1"],
      ["src-1"],
    ]);
  });

  it("never passes the URL slug to getRegistryDetail", async () => {
    const { GET } = await import("@/app/api/sources/[slug]/route");
    await GET(detailRequest("tele1"), paramsFor("tele1"));
    expect(registry.getRegistryDetail).toHaveBeenCalledWith("src-2");
    expect(registry.getRegistryDetail).not.toHaveBeenCalledWith("tele1");
  });

  it("builds the envelope in the route: source, zone_history, reader_agreement, request-time generated_at", async () => {
    const { GET } = await import("@/app/api/sources/[slug]/route");
    const before = Date.now();
    const res = await GET(detailRequest("haberturk"), paramsFor("haberturk"));
    const body = await res.json();

    expect(body.source.slug).toBe("haberturk");
    expect("id" in body.source).toBe(false);
    expect(body.zone_history).toEqual(DETAIL.zone_history);
    expect(body.reader_agreement).toEqual(DETAIL.reader_agreement);
    expect(typeof body.licence).toBe("string");
    const generated = Date.parse(body.generated_at);
    expect(generated).toBeGreaterThanOrEqual(before - 1000);
    expect(generated).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("answers an unknown slug with 404 + short public cache and never reads the detail", async () => {
    const { GET } = await import("@/app/api/sources/[slug]/route");
    const res = await GET(
      detailRequest("does-not-exist", "?cb=7"),
      paramsFor("does-not-exist"),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300");
    expect(await res.json()).toEqual({ error: "Source not found" });
    expect(registry.getRegistryDetail).not.toHaveBeenCalled();
  });

  it("answers a malformed slug with 400 and reads nothing", async () => {
    const { GET } = await import("@/app/api/sources/[slug]/route");
    const res = await GET(
      detailRequest("Not A Slug!"),
      paramsFor("Not A Slug!"),
    );
    expect(res.status).toBe(400);
    expect(registry.getRegistryRows).not.toHaveBeenCalled();
    expect(registry.getRegistryDetail).not.toHaveBeenCalled();
  });

  it("turns a reader failure into the generic 500 (no internals in the body)", async () => {
    registry.getRegistryRows.mockRejectedValue(new Error("relation sources boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/sources/[slug]/route");
    const res = await GET(detailRequest("haberturk"), paramsFor("haberturk"));
    errSpy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("boom");
  });
});

describe("rate limiting", () => {
  it("list: 429 carries Retry-After (whole seconds, >= 1) and no-store", async () => {
    const { GET } = await import("@/app/api/sources/route");
    const ip = freshIp();
    for (let i = 0; i < 60; i++) {
      expect((await GET(listRequest("", ip))).status).toBe(200);
    }
    const res = await GET(listRequest("", ip));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.error).toBe("Too many requests");
    expect(body.details.retryAfterMs).toBeGreaterThan(0);
  });

  it("detail: 429 carries Retry-After and no-store, before any slug or registry work", async () => {
    const { GET } = await import("@/app/api/sources/[slug]/route");
    const ip = freshIp();
    for (let i = 0; i < 60; i++) {
      expect(
        (await GET(detailRequest("haberturk", "", ip), paramsFor("haberturk")))
          .status,
      ).toBe(200);
    }
    registry.getRegistryRows.mockClear();
    registry.getRegistryDetail.mockClear();

    const res = await GET(
      detailRequest("haberturk", "", ip),
      paramsFor("haberturk"),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(registry.getRegistryRows).not.toHaveBeenCalled();
    expect(registry.getRegistryDetail).not.toHaveBeenCalled();
  });
});

describe("the routes never read the query string", () => {
  it.each([
    "src/app/api/sources/route.ts",
    "src/app/api/sources/[slug]/route.ts",
  ])("%s does not touch searchParams or the request URL", (rel) => {
    const src = readFileSync(resolve(ROOT, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
    expect(src).not.toMatch(/searchParams/);
    expect(src).not.toMatch(/new URL\(/);
    expect(src).not.toMatch(/request\.url|req\.url/);
  });
});
