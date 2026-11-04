import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// h32-livebk-1: /cluster/<ID> in any non-lower-case spelling used to render a
// full page (own CDN entry, own OG render, raw id in client props and share
// URLs, a bookmark that /saved could not remove). Gate 3 now answers every such
// URL with exactly one 308 to the lower-case form (merged target included), for
// the page and for the three nested routes the cluster page owns.

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
const LOWER = "f85bc48e-692d-41be-8f6b-0d0ecd1d2281";
const UPPER = "F85BC48E-692D-41BE-8F6B-0D0ECD1D2281";
const MIXED = "f85bc48E-692d-41BE-8f6b-0D0ecd1d2281";
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

describe("middleware gate 3 — canonical lower-case cluster id (single segment)", () => {
  it("308s an upper-case id to the lower-case form, keeping the query", async () => {
    const res = await middleware(req(`/cluster/${UPPER}?utm_source=x`));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/cluster/${LOWER}?utm_source=x`);
  });

  it("308s a mixed-case id to the lower-case form", async () => {
    const res = await middleware(req(`/cluster/${MIXED}`));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/cluster/${LOWER}`);
  });

  it("passes a lower-case id through and looks it up by the lower-case id", async () => {
    const res = await middleware(req(`/cluster/${LOWER}`));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.status).not.toBe(308);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(LOWER);
  });

  it("looks an upper-case id up by its lower-case form", async () => {
    await middleware(req(`/cluster/${UPPER}`));
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(LOWER);
  });

  it("answers the upper-case form of a merged id with ONE 308 straight to the survivor", async () => {
    lookup.mockImplementation((id) => (id === SRC ? DST : null));
    const res = await middleware(req(`/cluster/${SRC.toUpperCase()}?a=1`));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/cluster/${DST}?a=1`);
  });

  it("still redirects a lower-case merged id with one 308", async () => {
    lookup.mockImplementation((id) => (id === SRC ? DST : null));
    const res = await middleware(req(`/cluster/${SRC}`));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/cluster/${DST}`);
  });

  it("redirects an upper-case id whose merge target is itself lower-case once, not twice", async () => {
    lookup.mockReturnValue(LOWER);
    const res = await middleware(req(`/cluster/${UPPER}`));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/cluster/${LOWER}`);
  });

  it("does not redirect a lower-case id whose merge target is itself", async () => {
    lookup.mockReturnValue(LOWER);
    const res = await middleware(req(`/cluster/${LOWER}`));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("answers a non-UUID segment with the not-found rewrite, whatever its case", async () => {
    for (const path of ["/cluster/NOT-A-UUID", "/cluster/not-a-uuid", `/cluster/${UPPER}x`]) {
      const res = await middleware(req(path));
      expect(res.headers.get("x-middleware-rewrite"), path).toContain("/__tayf-not-found");
      expect(res.status, path).not.toBe(308);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps a multi-parameter query string byte for byte", async () => {
    const res = await middleware(req(`/cluster/${UPPER}?a=1&b=%C3%A7&c=`));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/cluster/${LOWER}?a=1&b=%C3%A7&c=`);
  });
});

describe("middleware gate 3 — nested cluster routes", () => {
  it.each(["opengraph-image", "twitter-image", "kart"])(
    "308s /cluster/<UPPER>/%s to the lower-case path, keeping the query, without a merged lookup",
    async (sub) => {
      const res = await middleware(req(`/cluster/${UPPER}/${sub}?abc`));
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(`${ORIGIN}/cluster/${LOWER}/${sub}?abc`);
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("308s a mixed-case id on a nested route too", async () => {
    const res = await middleware(req(`/cluster/${MIXED}/kart`));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/cluster/${LOWER}/kart`);
  });

  it.each(["opengraph-image", "twitter-image", "kart"])(
    "passes /cluster/<lower>/%s through unchanged",
    async (sub) => {
      const res = await middleware(req(`/cluster/${LOWER}/${sub}`));
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(res.status).not.toBe(308);
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("passes an unknown sub of an upper-case id through, unchanged", async () => {
    const res = await middleware(req(`/cluster/${UPPER}/foo`));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.status).not.toBe(308);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not canonicalise a deeper path (the sub must be exactly one of the three)", async () => {
    const res = await middleware(req(`/cluster/${UPPER}/kart/extra`));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.status).not.toBe(308);
  });

  it("passes a non-UUID head with an upper-case letter through (only UUIDs are canonicalised)", async () => {
    const res = await middleware(req("/cluster/NOT-A-UUID/kart"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.status).not.toBe(308);
  });

  it("answers a malformed escape in the sub with gate 8's 400 (text/plain, no-store)", async () => {
    const res = await middleware(req(`/cluster/${UPPER}/%ff`));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers a malformed escape in the head with gate 8's 400 (text/plain, no-store)", async () => {
    const res = await middleware(req("/cluster/%ff/kart"));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers a malformed escape glued to a canonical sub with the 400, not a 308", async () => {
    const res = await middleware(req(`/cluster/${UPPER}/kart%ff`));
    expect(res.status).toBe(400);
  });
});
