import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware, config } from "@/middleware";

const ORIGIN = "https://www.tayfhaber.com";

function req(path: string): NextRequest {
  return new NextRequest(new URL(path, ORIGIN));
}

describe("middleware — real 404 rewrite (A1)", () => {
  it("rewrites /konu/xyz, /ekonomi/bad_ticker! and /cluster/not-a-uuid to the not-found sink, not a bare 404", async () => {
    for (const path of ["/konu/xyz", "/ekonomi/bad_ticker!", "/cluster/not-a-uuid"]) {
      const res = await middleware(req(path));
      const rewrite = res.headers.get("x-middleware-rewrite");
      expect(rewrite, `path ${path}`).not.toBeNull();
      expect(rewrite).toContain("/__tayf-not-found");
      // Not a bare empty 404 response.
      expect(res.status).not.toBe(404);
    }
  });

  it("passes through valid /cluster/:uuid and /konu/:slug", async () => {
    const clusterRes = await middleware(
      req("/cluster/6ea8b39a-6ca7-4efe-ab30-71fdf1a2187b"),
    );
    expect(clusterRes.headers.get("x-middleware-next")).toBe("1");

    const konuRes = await middleware(req("/konu/dunya"));
    expect(konuRes.headers.get("x-middleware-next")).toBe("1");
  });

  it("still 308-redirects /konu/politika to /", async () => {
    const res = await middleware(req("/konu/politika"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/`);
  });

  it("matcher covers /cluster/:id but not a wildcard that would catch nested paths", () => {
    expect(config.matcher).toContain("/cluster/:id");
    expect(config.matcher).not.toContain("/cluster/:path*");
  });

  it("leaves /cluster/<id>/kart and /cluster/<id>/opengraph-image unmatched by the gate itself", async () => {
    // The middleware function itself must fall through to NextResponse.next()
    // for any pathname containing a nested segment, since the matcher
    // wouldn't even invoke it for those in production — but the function
    // body must not 404 them if somehow invoked.
    const res = await middleware(
      req("/cluster/6ea8b39a-6ca7-4efe-ab30-71fdf1a2187b/kart"),
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("still redirects unauthenticated /admin to /admin/login", async () => {
    const res = await middleware(req("/admin"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/admin/login`);
  });
});
