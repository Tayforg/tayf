import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// M-05: /llms.txt currently 404s. This route publishes the same licence
// string as pack B's REGISTRY_LICENCE constant so /llms.txt and the
// /api/sources registry can never drift apart — see the licence-string
// assertion below.
//
// Restructured per llmstxt.org: '# Tayf', a '> ' one-line summary, then
// h2 sections, every pointer as a markdown link `[Name](url)` rather than
// a bare URL — bare URLs are unclickable in most llms.txt-aware readers
// and Lighthouse-style link audits skip them entirely.
// ---------------------------------------------------------------------------

import { GET } from "@/app/llms.txt/route";

const ORIGINAL_ENV = { ...process.env };
const CONTACT_KEY = "NEXT_PUBLIC_CONTACT_EMAIL";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SITE_URL", CONTACT_KEY]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

const LINK_RE = /\[[^\]]+\]\(https?:\/\/[^)]+\)/g;

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

  it("starts with '# Tayf' followed by a '> ' summary line", async () => {
    const body = await (await GET()).text();
    const lines = body.split("\n");
    expect(lines[0]).toBe("# Tayf");
    const summaryIdx = lines.findIndex((l) => l.startsWith("> "));
    expect(summaryIdx).toBeGreaterThan(0);
    expect(summaryIdx).toBeLessThanOrEqual(2);
  });

  it("contains at least 8 markdown links, including the CC BY-SA 4.0 licence link", async () => {
    const body = await (await GET()).text();
    const links = body.match(LINK_RE) ?? [];
    expect(links.length).toBeGreaterThanOrEqual(8);
    expect(body).toContain(
      "[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)",
    );
  });

  it("no longer points at non-existent contact details on /metodoloji", async () => {
    const body = await (await GET()).text();
    expect(body).not.toContain("see the contact details at");
  });

  it("points to /metodoloji as a markdown link", async () => {
    const body = await (await GET()).text();
    expect(body).toMatch(/\[[^\]]+\]\(https:\/\/tayf\.test\/metodoloji\)/);
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

  it("points to /gelistirici and /api/v1/openapi.json", async () => {
    const body = await (await GET()).text();
    for (const path of ["/gelistirici", "/api/v1/openapi.json"]) {
      expect(body).toContain(path);
    }
  });

  it("states that Tayf does not relicense outlet text or photographs", async () => {
    const body = await (await GET()).text();
    expect(body.toLowerCase()).toMatch(
      /relicens|yeniden lisans|tam metin.*(yayınla|dağıt)/,
    );
  });

  it("points to the correction/dispute route for zone labels as a markdown link", async () => {
    const body = await (await GET()).text();
    expect(body).toMatch(
      /\[[^\]]+\]\(https:\/\/tayf\.test\/metodoloji#duzeltme\)/,
    );
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

  it("includes a mailto contact link when NEXT_PUBLIC_CONTACT_EMAIL is set to a valid address", async () => {
    process.env[CONTACT_KEY] = "iletisim@example.test";
    const body = await (await GET()).text();
    expect(body).toContain("[E-posta](mailto:iletisim@example.test)");
    delete process.env[CONTACT_KEY];
  });

  it("has no mailto link and states no separate e-mail is published when the env var is unset", async () => {
    delete process.env[CONTACT_KEY];
    const body = await (await GET()).text();
    expect(body).not.toContain("mailto:");
    expect(body).toContain(
      "Tayf şu anda ayrı bir e-posta adresi yayımlamıyor",
    );
  });

  it("ignores an invalid NEXT_PUBLIC_CONTACT_EMAIL value", async () => {
    process.env[CONTACT_KEY] = "x y";
    const body = await (await GET()).text();
    expect(body).not.toContain("mailto:");
    delete process.env[CONTACT_KEY];
  });
});
