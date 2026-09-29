import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, type NextFetchEvent } from "next/server";

const lookup = vi.fn<(id: string) => string | null>();
const refreshIfStale = vi.fn<() => Promise<void>>();

vi.mock("@/lib/seo/merged-cluster-gate", () => ({
  createMergedClusterGate: () => ({
    lookup: (id: string) => lookup(id),
    refreshIfStale: () => refreshIfStale(),
  }),
}));

import { middleware } from "@/middleware";

const ORIGIN = "https://www.tayfhaber.com";
const SRC = "6ea8b39a-6ca7-4efe-ab30-71fdf1a2187b";
const DST = "0a1b2c3d-1111-4222-8333-444455556666";

function req(path: string): NextRequest {
  return new NextRequest(new URL(path, ORIGIN));
}

beforeEach(() => {
  lookup.mockReset();
  lookup.mockReturnValue(null);
  refreshIfStale.mockReset();
  refreshIfStale.mockResolvedValue(undefined);
});

describe("middleware — merged cluster 308", () => {
  it("redirects a known merged id to the survivor with 308, keeping the query", async () => {
    lookup.mockImplementation((id) => (id === SRC ? DST : null));
    const res = await middleware(req(`/cluster/${SRC}?utm_source=x`));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/cluster/${DST}?utm_source=x`);
  });

  it("passes an unknown id through", async () => {
    const res = await middleware(req(`/cluster/${SRC}`));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.status).not.toBe(308);
  });

  it("does not redirect when the target equals the requested id", async () => {
    lookup.mockReturnValue(SRC);
    const res = await middleware(req(`/cluster/${SRC}`));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("hands the refresh promise to event.waitUntil", async () => {
    const p = Promise.resolve();
    refreshIfStale.mockReturnValue(p);
    const waitUntil = vi.fn();
    await middleware(req(`/cluster/${SRC}`), { waitUntil } as unknown as NextFetchEvent);
    expect(waitUntil).toHaveBeenCalledWith(p);
  });

  it("works without an event and swallows a rejected refresh", async () => {
    refreshIfStale.mockReturnValue(Promise.reject(new Error("x")));
    const res = await middleware(req(`/cluster/${SRC}`));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(refreshIfStale).toHaveBeenCalledTimes(1);
  });

  it("does not consult the gate for a non-UUID segment", async () => {
    const res = await middleware(req("/cluster/not-a-uuid"));
    expect(res.headers.get("x-middleware-rewrite")).toContain("/__tayf-not-found");
    expect(lookup).not.toHaveBeenCalled();
  });
});
