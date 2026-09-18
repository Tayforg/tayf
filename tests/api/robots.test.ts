import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// M-05: replaces the old MetadataRoute.Robots (src/app/robots.ts, deleted)
// with a raw route handler at src/app/robots.txt/route.ts so the file can
// carry an RSL-style `License:` line and comments, neither of which
// Next's typed robots metadata export can emit. This is the only coverage
// for /robots.txt — no prior test file existed.
// ---------------------------------------------------------------------------

import { GET } from "@/app/robots.txt/route";

const ORIGINAL_ENV = { ...process.env };

const AI_BOTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "CCBot",
  "Bytespider",
  "Applebot-Extended",
  "Amazonbot",
  "meta-externalagent",
  "cohere-ai",
  "Diffbot",
  "Timpibot",
];

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SITE_URL"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("GET /robots.txt", () => {
  it("returns 200 text/plain with a cache header", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, s-maxage=86400",
    );
  });

  it("names every declared AI bot by user-agent", async () => {
    const body = await (await GET()).text();
    for (const bot of AI_BOTS) {
      expect(body).toContain(`User-agent: ${bot}`);
    }
  });

  it("carries a License: line pointing at /llms.txt", async () => {
    const body = await (await GET()).text();
    expect(body).toMatch(/^License: https:\/\/tayf\.test\/llms\.txt$/m);
  });

  it("preserves today's User-agent: * behaviour exactly", async () => {
    const body = await (await GET()).text();
    const starGroupMatch = body.match(
      /User-agent: \*\n([\s\S]*?)(?=\nUser-agent:|\n*$)/,
    );
    expect(starGroupMatch).not.toBeNull();
    const starGroup = starGroupMatch ? starGroupMatch[1] : "";
    expect(starGroup).toContain("Allow: /");
    expect(starGroup).toContain("Disallow: /admin");
    expect(starGroup).toContain("Disallow: /api/");
  });

  it("still disallows /admin and /api/ globally", async () => {
    const body = await (await GET()).text();
    expect(body).toContain("Disallow: /admin");
    expect(body).toContain("Disallow: /api/");
  });

  it("carves out Allow: /api/sources for the AI-bot groups", async () => {
    const body = await (await GET()).text();
    expect(body).toContain("Allow: /api/sources");
  });

  it("carves out Allow: /api/sources for User-agent: *, Googlebot and Bingbot too", async () => {
    const body = await (await GET()).text();
    const lines = body.split("\n");
    for (const ua of ["*", "Googlebot", "Bingbot"]) {
      const startIdx = lines.findIndex((l) => l === `User-agent: ${ua}`);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      let endIdx = lines.findIndex(
        (l, i) => i > startIdx && l.startsWith("User-agent:"),
      );
      if (endIdx === -1) endIdx = lines.length;
      const group = lines.slice(startIdx, endIdx).join("\n");
      expect(group).toContain("Allow: /api/sources");
      expect(group).toContain("Disallow: /api/");
    }
  });

  it("builds the Sitemap line from NEXT_PUBLIC_SITE_URL", async () => {
    const body = await (await GET()).text();
    expect(body).toContain("Sitemap: https://tayf.test/sitemap.xml");
  });

  it("falls back to http://localhost:3000 when NEXT_PUBLIC_SITE_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const body = await (await GET()).text();
    expect(body).toContain("Sitemap: http://localhost:3000/sitemap.xml");
    expect(body).toContain("License: http://localhost:3000/llms.txt");
  });

  it("never emits a bare `Disallow: /` line for any AI bot (no blocking)", async () => {
    const body = await (await GET()).text();
    expect(body).not.toMatch(/^Disallow: \/$/m);
  });

  it("never disallows any declared AI bot outright", async () => {
    const body = await (await GET()).text();
    const lines = body.split("\n");
    for (const bot of AI_BOTS) {
      const startIdx = lines.findIndex((l) => l === `User-agent: ${bot}`);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      let endIdx = lines.findIndex(
        (l, i) => i > startIdx && l.startsWith("User-agent:"),
      );
      if (endIdx === -1) endIdx = lines.length;
      const group = lines.slice(startIdx, endIdx).join("\n");
      expect(group).toContain("Allow: /");
      expect(group).not.toMatch(/^Disallow: \/$/m);
    }
  });
});
