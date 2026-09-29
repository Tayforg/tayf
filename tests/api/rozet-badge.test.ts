import { describe, it, expect, vi, beforeEach } from "vitest";

// A throwing vi.fn is reported by vitest as a test failure even when the SUT
// catches it, so the throw lives in a plain wrapper around the spy.
const { getClusterDetailMock, control } = vi.hoisted(() => ({
  getClusterDetailMock: vi.fn(),
  control: { throwNext: false },
}));
vi.mock("@/lib/clusters/cluster-detail-query", () => ({
  getClusterDetail: async (id: string) => {
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

  it("503s no-store when the query throws", async () => {
    control.throwNext = true;
    const res = await call(`${ID}.svg`);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("200s with the exact headers and an SVG body", async () => {
    getClusterDetailMock.mockResolvedValue({
      cluster: { bias_distribution: { pro_government: 2, state_media: 0, center: 1, opposition: 1 } },
      wire: { effectiveArticleCount: 4 },
    });
    const res = await call(`${ID}.svg`);
    expect(getClusterDetailMock).toHaveBeenCalledWith(ID);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=600, stale-while-revalidate=86400");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const body = await res.text();
    expect(body).toContain("Tayf");
    expect(body).toContain("4 kaynak");
  });
});
