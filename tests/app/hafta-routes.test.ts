import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { middleware, config } from "@/middleware";

// ---------------------------------------------------------------------------
// /hafta/:hafta edge gate (gate 7). The page's own notFound() runs after PPR
// has flushed a 200 shell, so a garbage key, a pre-archive week or a future
// week only gets a real 404 status from the middleware. The gate is pure
// (shape + range from one clock read) and does no I/O.
// ---------------------------------------------------------------------------

const ORIGIN = "https://www.tayfhaber.com";
// Sunday 2026-11-01 12:00 UTC: ISO week 2026-W44.
const NOW = Date.UTC(2026, 10, 1, 12);

function req(path: string): NextRequest {
  return new NextRequest(new URL(path, ORIGIN));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("middleware — /hafta/:hafta gate", () => {
  it.each([
    "/hafta/garbage",
    "/hafta/2026-W4",
    "/hafta/2026-w44",
    "/hafta/2026-W37", // before WEEK_ARCHIVE_FIRST (2026-W38)
    "/hafta/2026-W45", // next week
    "/hafta/2099-W01",
    "/hafta/2026-W00",
    "/hafta/2026-W54",
    "/hafta/2025-W53", // 2025 has only 52 ISO weeks
    "/hafta/2026-W44/extra",
  ])("%s rewrites to the not-found sink (real 404, site chrome)", async (path) => {
    const res = await middleware(req(path));
    expect(res.headers.get("x-middleware-rewrite")).toBe(`${ORIGIN}/__tayf-not-found`);
    expect(res.headers.get("x-middleware-next")).toBeNull();
  });

  it.each(["/hafta/2026-W38", "/hafta/2026-W43", "/hafta/2026-W44"])(
    "%s passes through",
    async (path) => {
      const res = await middleware(req(path));
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    },
  );

  it("the current week follows the clock, so next week opens once Istanbul rolls over", async () => {
    expect((await middleware(req("/hafta/2026-W45"))).headers.get("x-middleware-rewrite")).toContain(
      "/__tayf-not-found",
    );
    // Sunday 22:00Z is Monday 01:00 in Istanbul: W45 becomes the current week.
    vi.setSystemTime(Date.UTC(2026, 10, 1, 22));
    expect((await middleware(req("/hafta/2026-W45"))).headers.get("x-middleware-next")).toBe("1");
  });

  it("does no network I/O", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await middleware(req("/hafta/2026-W43"));
      await middleware(req("/hafta/garbage"));
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("middleware config — /hafta matcher", () => {
  it("matches the single literal segment /hafta/:hafta", () => {
    expect(config.matcher).toContain("/hafta/:hafta");
  });

  it("leaves the rolling /hafta page unmatched and never uses a wildcard", () => {
    expect(config.matcher).not.toContain("/hafta");
    expect(config.matcher).not.toContain("/hafta/:path*");
  });
});

// ---------------------------------------------------------------------------
// The archive page used to hardcode `truncated={false}`, so a week that hit the
// read ceiling still printed a total as if it were the whole week. The flag now
// comes from the paged read itself. Source-level: no render tests of server
// components (AGENTS.md).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "../..");
const ARCHIVE_PAGE = readFileSync(resolve(ROOT, "src/app/hafta/[hafta]/page.tsx"), "utf8");
const LIVE_PAGE = readFileSync(resolve(ROOT, "src/app/hafta/page.tsx"), "utf8");

describe("/hafta/[hafta] page: truncation comes from the read", () => {
  it("never hardcodes truncated={false}", () => {
    expect(ARCHIVE_PAGE).not.toMatch(/truncated=\{\s*false\s*\}/);
  });

  it("passes the archive read's truncated flag to <ZoneShares>", () => {
    expect(ARCHIVE_PAGE).toMatch(/getWeekArchiveClusters\(/);
    expect(ARCHIVE_PAGE).toContain("truncated={read?.truncated === true}");
  });
});

describe("/hafta page: truncation comes from the read, not a row count", () => {
  it("passes the weekly read's truncated flag and does not compare lengths against the limit", () => {
    expect(LIVE_PAGE).toContain("read?.truncated === true");
    expect(LIVE_PAGE).not.toMatch(/length\s*>=\s*WEEKLY_CLUSTER_LIMIT/);
    expect(LIVE_PAGE).not.toContain("WEEKLY_CLUSTER_LIMIT");
  });
});
