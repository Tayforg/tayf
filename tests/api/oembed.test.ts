import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

// A throwing vi.fn is reported by vitest as a test failure even when the SUT
// catches it, so the throw lives in a plain wrapper around the spy.
const { getClusterDetailMock, eligibleMock, control } = vi.hoisted(() => ({
  getClusterDetailMock: vi.fn(),
  eligibleMock: vi.fn(),
  control: { throwNext: false },
}));
vi.mock("@/lib/clusters/cluster-detail-query", () => ({
  getClusterDetailOrThrow: async (id: string) => {
    if (control.throwNext) throw new Error("secret-db-detail");
    return getClusterDetailMock(id);
  },
}));
vi.mock("@/lib/game/pii-filter", () => ({
  isGameEligibleTitle: (title: string) => eligibleMock(title),
}));

import { GET, OPTIONS } from "@/app/api/oembed/route";
import { buildIframeSnippet } from "@/lib/embed/embed-snippet";

const ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";
const MERGED_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORIGIN = "https://tayfhaber.com";
const ORIGINAL_ENV = { ...process.env };

let fetchSpy: MockInstance;

function clusterUrl(id = ID, host = "tayfhaber.com", suffix = "") {
  return `https://${host}/cluster/${id}${suffix}`;
}

function call(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return GET(new Request(`https://tayfhaber.com/api/oembed?${qs}`));
}

function found(over: { title?: string; mergedInto?: string | null } = {}) {
  return {
    cluster: {
      id: ID,
      title_tr: over.title ?? "Merkez Bankası faizi sabit tuttu",
      merged_into: over.mergedInto ?? null,
    },
  };
}

function expectCors(res: Response) {
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
}

beforeEach(() => {
  getClusterDetailMock.mockReset();
  eligibleMock.mockReset();
  eligibleMock.mockReturnValue(true);
  control.throwNext = false;
  process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  // The route must never fetch the URL it is given (SSRF): hold every test to it.
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  if ("NEXT_PUBLIC_SITE_URL" in ORIGINAL_ENV) process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL_ENV.NEXT_PUBLIC_SITE_URL;
  else delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe("GET /api/oembed — accepted urls", () => {
  it.each([
    ["apex host", clusterUrl()],
    ["www host", clusterUrl(ID, "www.tayfhaber.com")],
    ["query string", clusterUrl(ID, "tayfhaber.com", "?utm_source=x&a=b")],
    ["hash", clusterUrl(ID, "tayfhaber.com", "#bolum")],
    ["trailing slash", clusterUrl(ID, "tayfhaber.com", "/")],
    ["upper-case id", clusterUrl(ID.toUpperCase())],
  ])("200s for %s with the sandboxed iframe on our own origin", async (_name, url) => {
    getClusterDetailMock.mockResolvedValue(found());
    const res = await call({ url });
    expect(res.status).toBe(200);
    expectCors(res);
    const body = await res.json();
    expect(getClusterDetailMock).toHaveBeenCalledWith(ID);
    expect(body.html).toContain(`src="${ORIGIN}/embed/cluster/${ID}"`);
    expect(body.html).toContain('sandbox="allow-popups allow-popups-to-escape-sandbox"');
    expect(body.html).toBe(buildIframeSnippet(ORIGIN, ID, 560, 200));
  });

  it("returns the full oEmbed 1.0 rich payload and the CDN headers", async () => {
    getClusterDetailMock.mockResolvedValue(found());
    const res = await call({ url: clusterUrl(), format: "json" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=3600, stale-while-revalidate=86400");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({
      version: "1.0",
      type: "rich",
      provider_name: "Tayf",
      provider_url: ORIGIN,
      title: "Merkez Bankası faizi sabit tuttu",
      html: buildIframeSnippet(ORIGIN, ID, 560, 200),
      width: 560,
      height: 200,
      cache_age: 3600,
    });
  });

  it("accepts the site's own https host in addition to the tayfhaber.com allowlist", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
    getClusterDetailMock.mockResolvedValue(found());
    const res = await call({ url: clusterUrl(ID, "tayf.test") });
    expect(res.status).toBe(200);
    expect((await res.json()).html).toContain(`src="https://tayf.test/embed/cluster/${ID}"`);
  });

  it("does not accept a non-https site host as an extra host", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
    const res = await call({ url: `http://localhost:3000/cluster/${ID}` });
    expect(res.status).toBe(404);
    expect(getClusterDetailMock).not.toHaveBeenCalled();
  });

  it("serves the frame from our origin even when the url was the www host", async () => {
    getClusterDetailMock.mockResolvedValue(found());
    const body = await (await call({ url: clusterUrl(ID, "www.tayfhaber.com") })).json();
    expect(body.html).not.toContain("www.tayfhaber.com");
  });
});

describe("GET /api/oembed — rejected urls never reach the reader", () => {
  const longUrl = `${clusterUrl()}?x=${"a".repeat(3000)}`;
  it.each([
    ["http scheme", `http://tayfhaber.com/cluster/${ID}`],
    ["foreign host", clusterUrl(ID, "evil.com")],
    ["allowlisted name under a foreign domain", clusterUrl(ID, "tayfhaber.com.evil.com")],
    ["userinfo trick", `https://www.tayfhaber.com@evil.com/cluster/${ID}`],
    ["non-default port", clusterUrl(ID, "tayfhaber.com:8443")],
    ["kart sub-path", clusterUrl(ID, "tayfhaber.com", "/kart")],
    ["non-uuid id", clusterUrl("not-a-uuid")],
    ["3000-char url", longUrl],
    ["not a url", "hello"],
    ["javascript scheme", "javascript:alert(1)"],
    ["internal address (SSRF probe)", `https://169.254.169.254/cluster/${ID}`],
    ["loopback (SSRF probe)", `https://127.0.0.1/cluster/${ID}`],
  ])("404s for %s", async (_name, url) => {
    const res = await call({ url });
    expect(res.status).toBe(404);
    expectCors(res);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300");
    expect(getClusterDetailMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/oembed — parameter rules", () => {
  it("400s when url is missing", async () => {
    const res = await call({});
    expect(res.status).toBe(400);
    expectCors(res);
    expect(getClusterDetailMock).not.toHaveBeenCalled();
  });

  it("400s when url is empty", async () => {
    const res = await call({ url: "" });
    expect(res.status).toBe(400);
    expectCors(res);
  });

  it("501s for format=xml, before looking at url at all", async () => {
    const res = await call({ url: clusterUrl(), format: "xml" });
    expect(res.status).toBe(501);
    expectCors(res);
    expect(getClusterDetailMock).not.toHaveBeenCalled();
    const res2 = await call({ format: "xml" });
    expect(res2.status).toBe(501);
  });

  it("501s for any other format", async () => {
    expect((await call({ url: clusterUrl(), format: "yaml" })).status).toBe(501);
  });

  it("serves format=json", async () => {
    getClusterDetailMock.mockResolvedValue(found());
    expect((await call({ url: clusterUrl(), format: "json" })).status).toBe(200);
  });

  describe("maxwidth", () => {
    it.each([
      ["300", 300],
      ["560", 560],
      ["99999", 560],
      ["abc", 560],
      ["50", 120],
      ["-1", 560],
    ])("maxwidth=%s -> width %i", async (maxwidth, expected) => {
      getClusterDetailMock.mockResolvedValue(found());
      const body = await (await call({ url: clusterUrl(), maxwidth })).json();
      expect(body.width).toBe(expected);
      expect(body.html).toContain(`width="${expected}"`);
    });
  });

  describe("maxheight", () => {
    it.each([
      ["180", 180],
      ["240", 240],
      ["99999", 240],
      ["abc", 200],
      ["50", 120],
      ["-1", 200],
    ])("maxheight=%s -> height %i", async (maxheight, expected) => {
      getClusterDetailMock.mockResolvedValue(found());
      const body = await (await call({ url: clusterUrl(), maxheight })).json();
      expect(body.height).toBe(expected);
      expect(body.html).toContain(`height="${expected}"`);
    });
  });
});

describe("GET /api/oembed — reader outcomes", () => {
  it("503s no-store when the read throws", async () => {
    control.throwNext = true;
    const res = await call({ url: clusterUrl() });
    expect(res.status).toBe(503);
    expectCors(res);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await res.json())).not.toContain("secret-db-detail");
  });

  it("404s (cached briefly) when the cluster does not exist", async () => {
    getClusterDetailMock.mockResolvedValue(null);
    const res = await call({ url: clusterUrl() });
    expect(res.status).toBe(404);
    expectCors(res);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300");
  });

  it("points a merged cluster's iframe at the survivor, with no second read", async () => {
    getClusterDetailMock.mockResolvedValue(found({ mergedInto: MERGED_ID }));
    const res = await call({ url: clusterUrl() });
    expect(res.status).toBe(200);
    expect(getClusterDetailMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.html).toContain(`src="${ORIGIN}/embed/cluster/${MERGED_ID}"`);
    expect(body.html).not.toContain(ID);
  });
});

describe("GET /api/oembed — title", () => {
  it("replaces a PII-rejected title with 'Tayf haberi'", async () => {
    eligibleMock.mockReturnValue(false);
    getClusterDetailMock.mockResolvedValue(found({ title: "Ali Yılmaz adlı şüpheli" }));
    const body = await (await call({ url: clusterUrl() })).json();
    expect(body.title).toBe("Tayf haberi");
    expect(JSON.stringify(body)).not.toContain("Ali Yılmaz");
  });

  it("asks the filter about the cluster title", async () => {
    getClusterDetailMock.mockResolvedValue(found({ title: "Başlık Z" }));
    await call({ url: clusterUrl() });
    expect(eligibleMock).toHaveBeenCalledWith("Başlık Z");
  });

  it("truncates a very long title by code point", async () => {
    getClusterDetailMock.mockResolvedValue(found({ title: "x".repeat(600) }));
    const body = await (await call({ url: clusterUrl() })).json();
    expect(Array.from(body.title as string)).toHaveLength(140);
  });
});

describe("GET /api/oembed — CORS on every status", () => {
  it("carries ACAO * and JSON content type on 200, 400, 404, 501 and 503", async () => {
    getClusterDetailMock.mockResolvedValue(found());
    const statuses = new Map<number, Response>();
    for (const res of [
      await call({ url: clusterUrl() }),
      await call({}),
      await call({ url: "https://evil.com/x" }),
      await call({ url: clusterUrl(), format: "xml" }),
    ]) {
      statuses.set(res.status, res);
    }
    control.throwNext = true;
    const unavailable = await call({ url: clusterUrl() });
    statuses.set(unavailable.status, unavailable);

    expect([...statuses.keys()].sort()).toEqual([200, 400, 404, 501, 503]);
    for (const res of statuses.values()) expectCors(res);
  });

  it("answers a preflight with 204 and the CORS headers", async () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});
