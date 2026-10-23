import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import type { BiasCategory, BiasDistribution } from "@/types";

// A throwing vi.fn is reported by vitest as a test failure even when the SUT
// catches it, so the throw lives in a plain wrapper around the spy.
const { getClusterDetailMock, control } = vi.hoisted(() => ({
  getClusterDetailMock: vi.fn(),
  control: { throwNext: false },
}));
vi.mock("@/lib/clusters/cluster-detail-query", () => ({
  getClusterDetailOrThrow: async (id: string) => {
    if (control.throwNext) throw new Error("secret-db-detail");
    return getClusterDetailMock(id);
  },
}));

import { GET } from "@/app/embed/cluster/[id]/route";

const ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";
const MERGED_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORIGINAL_ENV = { ...process.env };

const call = (id: string) =>
  GET(new Request(`http://x/embed/cluster/${id}`), { params: Promise.resolve({ id }) });

function dist(partial: Partial<BiasDistribution> = {}): BiasDistribution {
  return { ...emptyBiasDistribution(), ...partial };
}

function detail(over: {
  title?: string;
  distribution?: BiasDistribution;
  isBlindspot?: boolean;
  blindspotSide?: BiasCategory | null;
  mergedInto?: string | null;
  sourceCount?: number;
} = {}) {
  return {
    cluster: {
      id: ID,
      title_tr: over.title ?? "Merkez Bankası faizi sabit tuttu",
      bias_distribution: over.distribution ?? dist({ pro_government: 2, center: 1, opposition: 1 }),
      is_blindspot: over.isBlindspot ?? false,
      blindspot_side: over.blindspotSide ?? null,
      merged_into: over.mergedInto ?? null,
    },
    wire: { effectiveArticleCount: over.sourceCount ?? 4 },
  };
}

beforeEach(() => {
  getClusterDetailMock.mockReset();
  control.throwNext = false;
  process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
});

afterEach(() => {
  if ("NEXT_PUBLIC_SITE_URL" in ORIGINAL_ENV) process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL_ENV.NEXT_PUBLIC_SITE_URL;
  else delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe("GET /embed/cluster/[id] — rejects without reading", () => {
  it.each(["abc", "not-a-uuid", `${ID}x`, `${ID}.svg`, "../x", `${"z".repeat(36)}`, "%00", ""])(
    "404s for %j without touching the reader",
    async (id) => {
      const res = await call(id);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("public, s-maxage=300");
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const body = await res.text();
      expect(body).toContain("Haber bulunamadı");
      expect(body).toContain('<meta name="robots" content="noindex,nofollow">');
      expect(body).not.toMatch(/<script/i);
      expect(getClusterDetailMock).not.toHaveBeenCalled();
    },
  );
});

describe("GET /embed/cluster/[id] — reader outcomes", () => {
  it("404s for an unknown cluster (cached briefly)", async () => {
    getClusterDetailMock.mockResolvedValue(null);
    const res = await call(ID);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300");
    expect(await res.text()).toContain("Haber bulunamadı");
  });

  it("503s no-store with Retry-After when the read throws", async () => {
    control.throwNext = true;
    const res = await call(ID);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("Şu anda yüklenemiyor");
    expect(body).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("does not leak the error message into the 503 body", async () => {
    control.throwNext = true;
    const body = await (await call(ID)).text();
    expect(body).not.toContain("secret-db-detail");
  });

  it("308-redirects a merged cluster to its survivor's embed", async () => {
    getClusterDetailMock.mockResolvedValue(detail({ mergedInto: MERGED_ID }));
    const res = await call(ID);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`/embed/cluster/${MERGED_ID}`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("normalises an upper-case id before reading (bounded cache key space)", async () => {
    getClusterDetailMock.mockResolvedValue(null);
    await call(ID.toUpperCase());
    expect(getClusterDetailMock).toHaveBeenCalledTimes(1);
    expect(getClusterDetailMock).toHaveBeenCalledWith(ID);
  });
});

describe("GET /embed/cluster/[id] — 200", () => {
  it("answers with the exact headers and never sets a cookie", async () => {
    getClusterDetailMock.mockResolvedValue(detail());
    const res = await call(ID);
    expect(getClusterDetailMock).toHaveBeenCalledWith(ID);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=600");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("renders a script-less document with the percent legend and source count", async () => {
    getClusterDetailMock.mockResolvedValue(detail({ sourceCount: 12 }));
    const body = await (await call(ID)).text();
    expect(body.startsWith("<!doctype html>")).toBe(true);
    expect(body).not.toContain("<script");
    expect(body).toContain("Merkez Bankası faizi sabit tuttu");
    expect(body).toContain("İktidar %50 · Bağımsız %25 · Muhalefet %25 · 12 kaynak");
    expect(body).toContain('role="img" aria-label="İktidar %50, Bağımsız %25, Muhalefet %25"');
  });

  it("escapes a hostile cluster title", async () => {
    getClusterDetailMock.mockResolvedValue(detail({ title: '"><script>alert(1)</script>' }));
    const body = await (await call(ID)).text();
    expect(body).not.toContain("<script");
    expect(body).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("swaps a KVKK-rejected title for the generic heading", async () => {
    getClusterDetailMock.mockResolvedValue(detail({ title: "Ali Yılmaz adlı şüpheli tutuklandı" }));
    const body = await (await call(ID)).text();
    expect(body).toContain("Bu haberin medya yelpazesi");
    expect(body).not.toContain("Ali Yılmaz");
  });

  it("shows the blindspot ribbon only when the cluster is flagged", async () => {
    getClusterDetailMock.mockResolvedValue(detail({ isBlindspot: false }));
    expect(await (await call(ID)).text()).not.toContain("Kör nokta");

    getClusterDetailMock.mockResolvedValue(
      detail({ isBlindspot: true, blindspotSide: "pro_government", distribution: dist({ pro_government: 6 }) }),
    );
    expect(await (await call(ID)).text()).toContain("Kör nokta: sadece iktidar yazdı");
  });

  it("links out to the cluster in a new tab with rel=noopener", async () => {
    getClusterDetailMock.mockResolvedValue(detail());
    const body = await (await call(ID)).text();
    const a = body.match(/<a [^>]*>/)![0];
    expect(a).toContain('target="_blank"');
    expect(a).toContain('rel="noopener"');
    expect(a).toContain(`href="https://tayf.test/cluster/${ID}?utm_source=embed&amp;utm_medium=iframe&amp;utm_campaign=cluster"`);
  });

  it("never fetches anything itself", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    getClusterDetailMock.mockResolvedValue(detail());
    await call(ID);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
