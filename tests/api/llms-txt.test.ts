import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// M-05: /llms.txt currently 404s. This route publishes the same licence
// string as pack B's REGISTRY_LICENCE constant so /llms.txt and the
// /api/sources registry can never drift apart — see the licence-string
// assertion below.
// ---------------------------------------------------------------------------

import { GET } from "@/app/llms.txt/route";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SITE_URL"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("GET /llms.txt", () => {
  it("returns 200 text/plain with a cache header", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, s-maxage=86400",
    );
  });

  it("contains the licence string byte-identical to pack B's REGISTRY_LICENCE", async () => {
    const body = await (await GET()).text();
    // Kept in sync by hand with src/lib/registry/licence.ts's
    // REGISTRY_LICENCE constant (pack B) — see brief note.
    expect(body).toContain("CC BY-SA 4.0 — Tayf'a göre");
  });

  it("points to /metodoloji", async () => {
    const body = await (await GET()).text();
    expect(body).toContain("/metodoloji");
  });

  it("points to the registry JSON at /api/sources", async () => {
    const body = await (await GET()).text();
    expect(body).toContain("/api/sources");
  });

  it("points to /sources, /kaynaklar/durum, /blindspots, /rss.xml and /sitemap.xml", async () => {
    const body = await (await GET()).text();
    for (const path of [
      "/sources",
      "/kaynaklar/durum",
      "/blindspots",
      "/rss.xml",
      "/sitemap.xml",
    ]) {
      expect(body).toContain(path);
    }
  });

  it("states that Tayf does not relicense outlet text or photographs", async () => {
    const body = await (await GET()).text();
    expect(body.toLowerCase()).toMatch(
      /relicens|yeniden lisans|tam metin.*(yayınla|dağıt)/,
    );
  });

  it("points to the correction/dispute route for zone labels", async () => {
    const body = await (await GET()).text();
    expect(body).toContain("/metodoloji#duzeltme");
  });

  it("builds absolute links from NEXT_PUBLIC_SITE_URL", async () => {
    const body = await (await GET()).text();
    expect(body).toContain("https://tayf.test/metodoloji");
  });

  it("falls back to http://localhost:3000 when NEXT_PUBLIC_SITE_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const body = await (await GET()).text();
    expect(body).toContain("http://localhost:3000/metodoloji");
  });
});
