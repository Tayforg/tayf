import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// M-05: replaces the old MetadataRoute.Robots (src/app/robots.ts, deleted)
// with a raw route handler at src/app/robots.txt/route.ts so the file can
// carry an RSL-style `License:` line and comments, neither of which
// Next's typed robots metadata export can emit. This is the only coverage
// for /robots.txt — no prior test file existed.
// ---------------------------------------------------------------------------

import { GET } from "@/app/robots.txt/route";
import { isCrawlAllowed, parseRobots, rulesFor } from "../_helpers/robots-match";

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

// The whole Disallow vocabulary, sorted: /admin, /api/ and /embed/ plus the
// three crawl-hygiene rules (h31-bots-1).
const SIX_DISALLOWS = [
  "Disallow: /*?cluster=",
  "Disallow: /*?source=",
  "Disallow: /admin",
  "Disallow: /api/",
  "Disallow: /cluster/*/kart",
  "Disallow: /embed/",
];

/** Lines of every User-agent group, keyed by the group's first User-agent token. */
function groupsByAgent(body: string): Map<string, string[]> {
  const lines = body.split("\n");
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("User-agent: ")) {
      current = [];
      out.set(line.slice("User-agent: ".length), current);
    }
    if (current !== null && line === "") current = null;
    if (current !== null) current.push(line);
  }
  return out;
}

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

  it("carries no License: directive (Lighthouse flags it as an unknown robots.txt rule)", async () => {
    const body = await (await GET()).text();
    expect(body).not.toMatch(/^License:/m);
  });

  it("carries a comment pointing at /llms.txt instead", async () => {
    const body = await (await GET()).text();
    expect(body).toMatch(/^# .*License.*\/llms\.txt$/m);
    expect(body).toContain("https://tayf.test/llms.txt");
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

  it("keeps the script-less /embed/ widget out of every crawler group (it is a frame target, not a page)", async () => {
    const body = await (await GET()).text();
    const lines = body.split("\n");
    const userAgents = lines.filter((l) => l.startsWith("User-agent:")).map((l) => l.slice("User-agent: ".length));
    expect(userAgents).toEqual(expect.arrayContaining(["*", "Googlebot", "Bingbot", ...AI_BOTS]));
    for (const ua of userAgents) {
      const startIdx = lines.findIndex((l) => l === `User-agent: ${ua}`);
      let endIdx = lines.findIndex((l, i) => i > startIdx && l.startsWith("User-agent:"));
      if (endIdx === -1) endIdx = lines.length;
      const group = lines.slice(startIdx, endIdx).join("\n");
      expect(group, `group for ${ua}`).toContain("Disallow: /embed/");
    }
    expect(body.match(/^Disallow: \/embed\/$/gm)).toHaveLength(userAgents.length);
  });

  it("does not disallow /embed (no trailing slash): only the widget namespace is hidden", async () => {
    const body = await (await GET()).text();
    expect(body).not.toMatch(/^Disallow: \/embed$/m);
    const disallows = new Set(body.match(/^Disallow: .*$/gm));
    expect([...disallows].sort()).toEqual(SIX_DISALLOWS);
  });

  it("carves out Allow: /api/v1/openapi.json in every User-agent group (llms.txt links to it; the contract file is keyless and public)", async () => {
    const body = await (await GET()).text();
    const lines = body.split("\n");
    const userAgents = lines.filter((l) => l.startsWith("User-agent:"));
    expect(userAgents.length).toBe(2 + AI_BOTS.length + 1);
    let seen = 0;
    for (const ua of userAgents) {
      const startIdx = lines.indexOf(ua);
      let endIdx = lines.findIndex((l, i) => i > startIdx && l.startsWith("User-agent:"));
      if (endIdx === -1) endIdx = lines.length;
      const group = lines.slice(startIdx, endIdx);
      expect(group, `group for ${ua}`).toContain("Allow: /api/v1/openapi.json");
      seen += 1;
    }
    expect(seen).toBe(userAgents.length);
    expect(lines.filter((l) => l === "Allow: /api/v1/openapi.json")).toHaveLength(userAgents.length);
  });

  it("opens only the three Allow paths and keeps the Disallow set exactly the six lines (the carve-out is a longer match, not a removal)", async () => {
    const body = await (await GET()).text();
    const lines = body.split("\n");
    const allows = new Set(lines.filter((l) => l.startsWith("Allow:")));
    expect([...allows]).toEqual([
      "Allow: /",
      "Allow: /api/sources",
      "Allow: /api/v1/openapi.json",
    ]);
    const disallows = new Set(lines.filter((l) => l.startsWith("Disallow:")));
    expect([...disallows].sort()).toEqual(SIX_DISALLOWS);
  });

  it("builds the Sitemap line from NEXT_PUBLIC_SITE_URL", async () => {
    const body = await (await GET()).text();
    expect(body).toContain("Sitemap: https://tayf.test/sitemap.xml");
  });

  it("falls back to http://localhost:3000 when NEXT_PUBLIC_SITE_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const body = await (await GET()).text();
    expect(body).toContain("Sitemap: http://localhost:3000/sitemap.xml");
    expect(body).toContain("http://localhost:3000/llms.txt");
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

// ---------------------------------------------------------------------------
// h31-bots-1: ~31.7k per-entity /metodoloji?cluster=<uuid> / ?source=<slug>
// URLs (one static page, the form reads the params client-side) and the
// Satori /cluster/<id>/kart PNG renders are kept out of every crawler group.
// The allow-with-terms stance is unchanged: no bare `Disallow: /`.
// ---------------------------------------------------------------------------
describe("GET /robots.txt — crawl-index hygiene (h31-bots-1)", () => {
  const CLUSTER_ID = "6e19dd5a-0000-0000-0000-000000000000";
  const HYGIENE_RULES = [
    "Disallow: /*?cluster=",
    "Disallow: /*?source=",
    "Disallow: /cluster/*/kart",
  ];

  it("has the expected groups: *, Googlebot, Bingbot and every AI bot", async () => {
    const groups = groupsByAgent(await (await GET()).text());
    expect([...groups.keys()].sort()).toEqual(["*", "Bingbot", "Googlebot", ...AI_BOTS].sort());
  });

  it("every User-agent group carries each of the three hygiene rules exactly once", async () => {
    const groups = groupsByAgent(await (await GET()).text());
    expect(groups.size).toBe(3 + AI_BOTS.length);
    for (const [ua, lines] of groups) {
      for (const rule of HYGIENE_RULES) {
        expect(lines.filter((l) => l === rule), `${rule} in group for ${ua}`).toHaveLength(1);
      }
    }
  });

  it("the hygiene rules follow Disallow: /embed/ inside each group (one block, no stray group)", async () => {
    const groups = groupsByAgent(await (await GET()).text());
    for (const [ua, lines] of groups) {
      const embed = lines.indexOf("Disallow: /embed/");
      expect(embed, `embed rule in ${ua}`).toBeGreaterThan(0);
      expect(lines.slice(embed + 1), `rules after /embed/ in ${ua}`).toEqual(HYGIENE_RULES);
    }
  });

  it("stays allow-with-terms: no bare Disallow: / anywhere", async () => {
    const body = await (await GET()).text();
    expect(body).not.toMatch(/^Disallow: \/\s*$/m);
  });

  describe.each(["*", "Googlebot", "Bingbot", ...AI_BOTS])("evaluated for %s", (ua) => {
    async function rules() {
      return rulesFor(parseRobots(await (await GET()).text()), ua);
    }

    it.each([
      "/",
      `/cluster/${CLUSTER_ID}`,
      `/cluster/${CLUSTER_ID}?utm_source=x`,
      `/cluster/${CLUSTER_ID}/opengraph-image`,
      `/cluster/${CLUSTER_ID}/twitter-image`,
      "/metodoloji",
      "/source/sozcu",
      "/sources",
      "/llms.txt",
      "/sitemap.xml",
      "/api/sources",
      "/api/sources/sozcu",
      "/api/v1/openapi.json",
    ])("allows %s", async (path) => {
      expect(isCrawlAllowed(await rules(), path)).toBe(true);
    });

    it.each([
      `/metodoloji?cluster=${CLUSTER_ID}`,
      "/metodoloji?source=star",
      "/metodoloji?source=a%20b%26c",
      "/?cluster=x",
      "/?source=x",
      `/cluster/${CLUSTER_ID}/kart`,
      `/cluster/${CLUSTER_ID.toUpperCase()}/kart`,
      "/admin",
      "/api/v1/clusters",
      "/embed/x",
    ])("disallows %s", async (path) => {
      expect(isCrawlAllowed(await rules(), path)).toBe(false);
    });
  });
});
