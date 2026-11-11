import { describe, it, expect, vi, beforeEach } from "vitest";

// The route must use the THROWING reader: the never-throw `getClusterDetail`
// maps a sustained outage to null, which the badge would then serve as a
// cacheable 404. Only `getClusterDetailOrThrow` is mocked, so an import of the
// never-throw variant fails loudly here.
// A throwing vi.fn is reported by vitest as a test failure even when the SUT
// catches it, so the throw lives in a plain wrapper around the spy.
const { getClusterDetailMock, control } = vi.hoisted(() => ({
  getClusterDetailMock: vi.fn(),
  control: { throwNext: false },
}));
vi.mock("@/lib/clusters/cluster-detail-query", () => ({
  getClusterDetailOrThrow: async (id: string) => {
    if (control.throwNext) throw new Error("db");
    return getClusterDetailMock(id);
  },
}));

import { GET } from "@/app/rozet/[file]/route";

const ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";
const call = (file: string) => GET(new Request(`http://x/rozet/${file}`), { params: Promise.resolve({ file }) });

beforeEach(() => {
  getClusterDetailMock.mockReset();
  control.throwNext = false;
});

describe("GET /rozet/[file]", () => {
  it.each(["abc.svg", `${ID}.png`, `${ID}`, "../x.svg", `${"z".repeat(36)}.svg`])("404s for %s without touching the DB", async (file) => {
    const res = await call(file);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300");
    expect(getClusterDetailMock).not.toHaveBeenCalled();
  });

  it("404s for an unknown uuid", async () => {
    getClusterDetailMock.mockResolvedValue(null);
    const res = await call(`${ID}.svg`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300");
  });

  it("503s no-store with Retry-After 60 when the reader throws (outage is not 'not found')", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    control.throwNext = true;
    try {
      const res = await call(`${ID}.svg`);
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("retry-after")).toBe("60");
      expect(await res.text()).toBe("Service unavailable");
      expect(errSpy).toHaveBeenCalledWith(`[rozet] ${ID} failed: db`);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("never caches the failure: the 503 carries no public/s-maxage directive", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    control.throwNext = true;
    try {
      const res = await call(`${ID}.svg`);
      expect(res.headers.get("cache-control")).not.toMatch(/public|s-maxage/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("200s with the exact headers and an SVG body", async () => {
    getClusterDetailMock.mockResolvedValue({
      cluster: { bias_distribution: { pro_government: 2, state_media: 0, center: 1, opposition: 1 } },
      members: [],
      wire: { effectiveArticleCount: 4 },
    });
    const res = await call(`${ID}.svg`);
    expect(getClusterDetailMock).toHaveBeenCalledWith(ID);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=600, stale-while-revalidate=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const body = await res.text();
    expect(body).toContain("Tayf");
    expect(body).toContain("4 kaynak");
  });
});

// h118-shares-1: an all-English cluster (92742df8: daily-sabah, hurriyet-daily-news,
// trt-world) must not print the zone-absence claim its own page does not make.
// The route decides isolation with the page's own predicate, over the members.
describe("GET /rozet/[file] for an all-English cluster (h118-shares-1)", () => {
  const member = (slug: string) => ({ source: { slug, name: slug } });
  const detail = (slugs: string[], zones: Record<string, number>, count: number) => ({
    cluster: { bias_distribution: zones },
    members: slugs.map(member),
    wire: { effectiveArticleCount: count },
  });
  const bodyOf = async () => (await call(`${ID}.svg`)).text();

  it("92742df8: the badge names the qualifier and the count, not 'İktidar %100, Bağımsız %0'", async () => {
    getClusterDetailMock.mockResolvedValue(
      detail(["daily-sabah", "hurriyet-daily-news", "trt-world"], { pro_government: 2, gov_leaning: 1 }, 3),
    );
    const body = await bodyOf();
    expect(body).toContain(
      "<title>Tayf yelpazesi: yalnızca İngilizce kaynaklar, Türkçe haberlerle karşılaştırılmadı · 3 kaynak</title>",
    );
    expect(body).toContain(">3 kaynak · yalnızca İngilizce</text>");
    expect(body).not.toContain("Bağımsız %0");
  });

  it("2dab7e87: a-news + trt-world", async () => {
    getClusterDetailMock.mockResolvedValue(detail(["a-news", "trt-world"], { pro_government: 2 }, 2));
    expect(await bodyOf()).toContain("· 2 kaynak</title>");
    expect(await bodyOf()).toContain("yalnızca İngilizce kaynaklar, Türkçe haberlerle karşılaştırılmadı");
  });

  it("controls: a Turkish cluster and a mixed English + Turkish cluster keep the percent label", async () => {
    getClusterDetailMock.mockResolvedValue(
      detail(["sabah", "yeni-safak", "a-haber"], { pro_government: 3 }, 3),
    );
    const turkish = await bodyOf();
    expect(turkish).toContain("<title>Tayf yelpazesi: İktidar %100, Bağımsız %0, Muhalefet %0 · 3 kaynak</title>");
    expect(turkish).toContain(">3 kaynak · %100/%0/%0</text>");

    getClusterDetailMock.mockResolvedValue(detail(["a-haber", "daily-sabah"], { pro_government: 2 }, 2));
    const mixed = await bodyOf();
    expect(mixed).toContain("<title>Tayf yelpazesi: İktidar %100, Bağımsız %0, Muhalefet %0 · 2 kaynak</title>");
    expect(mixed).not.toContain("İngilizce");
  });

  it("a cluster with no members is not isolated", async () => {
    getClusterDetailMock.mockResolvedValue(detail([], { pro_government: 2 }, 2));
    expect(await bodyOf()).toContain("İktidar %100");
  });
});

