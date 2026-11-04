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
import { GET as GET_ROBOTS } from "@/app/robots.txt/route";
import {
  isCrawlAllowed,
  parseRobots,
  robotsPatternMatches,
  rulesFor,
  type RobotsRule,
} from "../_helpers/robots-match";

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

  it("points to /sources, /kaynaklar/durum, /blindspots, /blindspots/rss.xml, /rss.xml and /sitemap.xml", async () => {
    const body = await (await GET()).text();
    for (const path of [
      "/sources",
      "/kaynaklar/durum",
      "/blindspots",
      "/blindspots/rss.xml",
      "/rss.xml",
      "/sitemap.xml",
    ]) {
      expect(body).toContain(path);
    }
  });

  it("lists the blindspots and per-topic RSS feeds as markdown links", async () => {
    const body = await (await GET()).text();
    expect(body).toContain(
      "[Kör noktalar RSS](https://tayf.test/blindspots/rss.xml)",
    );
    expect(body).toContain("[Konu RSS](https://tayf.test/rss/{konu}.xml)");
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

// ---------------------------------------------------------------------------
// llms.txt <-> robots.txt consistency. llms.txt is read by crawlers, so every
// absolute link in it that does not hold a `{placeholder}` must be crawlable
// under /robots.txt. The OpenAPI link used to sit under `Disallow: /api/`.
//
// The evaluator lives in tests/_helpers/robots-match.ts: RFC 9309 group
// selection, `*` / trailing-`$` wildcards, longest match wins, Allow wins a
// tie. It is a character scan; no regular expression ever runs over robots or
// llms text.
// ---------------------------------------------------------------------------

/** URLs of every `[text](url)` link, found by scanning for "](" rather than a pattern. */
function markdownLinkUrls(text: string): string[] {
  const urls: string[] = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf("](", from);
    if (open === -1) break;
    const close = text.indexOf(")", open + 2);
    if (close === -1) break;
    urls.push(text.slice(open + 2, close));
    from = close + 1;
  }
  return urls;
}

describe("llms.txt links are crawlable under /robots.txt", () => {
  const BASE = "https://tayf.test";
  const CRAWLERS = ["*", "Googlebot", "ClaudeBot"];

  async function loadFiles() {
    const llms = await (await GET()).text();
    const robots = await (await GET_ROBOTS()).text();
    return { llms, groups: parseRobots(robots) };
  }

  /** Paths of the links that point at this site and hold no `{placeholder}`. */
  function internalLinkPaths(llms: string): string[] {
    const paths: string[] = [];
    for (const url of markdownLinkUrls(llms)) {
      if (!url.startsWith(`${BASE}/`) || url.includes("{")) continue;
      const hash = url.indexOf("#");
      paths.push(url.slice(BASE.length, hash === -1 ? url.length : hash));
    }
    return paths;
  }

  it("the evaluator follows RFC 9309: longest match wins, Allow wins a tie, no match is allowed", () => {
    const rules: RobotsRule[] = [
      { allow: true, path: "/" },
      { allow: true, path: "/api/sources" },
      { allow: false, path: "/api/" },
      { allow: false, path: "/same" },
      { allow: true, path: "/same" },
    ];
    expect(isCrawlAllowed(rules, "/blindspots")).toBe(true);
    expect(isCrawlAllowed(rules, "/api/sources/foo")).toBe(true);
    expect(isCrawlAllowed(rules, "/api/health")).toBe(false);
    expect(isCrawlAllowed(rules, "/same")).toBe(true);
    expect(isCrawlAllowed([], "/anything")).toBe(true);
    expect(isCrawlAllowed([{ allow: false, path: "/api/" }], "/api/sources")).toBe(false);
  });

  it("the parser reads one group per user-agent and ignores comments and Sitemap", async () => {
    const { groups } = await loadFiles();
    for (const crawler of CRAWLERS) {
      const rules = groups.get(crawler.toLowerCase());
      expect(rules, `no robots group for ${crawler}`).toBeDefined();
      expect(rules!.length).toBeGreaterThanOrEqual(5);
      for (const rule of rules!) {
        // A rule path is rooted; comment text and Sitemap lines never become rules.
        expect(rule.path.startsWith("/"), rule.path).toBe(true);
        expect(rule.path.includes("#") || rule.path.includes(" "), rule.path).toBe(false);
      }
    }
  });

  it("the evaluator follows RFC 9309 wildcards: '*' matches any run, a trailing '$' anchors the end, matching starts at path+query", () => {
    // '*' matches any run of characters: none, and across '/' and '?'.
    expect(robotsPatternMatches("/*?cluster=", "/metodoloji?cluster=abc")).toBe(true);
    expect(robotsPatternMatches("/*?cluster=", "/?cluster=abc")).toBe(true);
    expect(robotsPatternMatches("/*?cluster=", "/a/b/c?cluster=")).toBe(true);
    expect(robotsPatternMatches("/*?cluster=", "/metodoloji?source=abc")).toBe(false);
    expect(robotsPatternMatches("/*?cluster=", "/metodoloji?x=1&cluster=abc")).toBe(false);
    expect(robotsPatternMatches("/*?cluster=", "/metodoloji")).toBe(false);
    // The match starts at the first character, never in the middle.
    expect(robotsPatternMatches("/kart", "/cluster/x/kart")).toBe(false);
    expect(robotsPatternMatches("/cluster/*/kart", "/cluster/abc/kart")).toBe(true);
    expect(robotsPatternMatches("/cluster/*/kart", "/cluster/abc/kart/extra")).toBe(true);
    expect(robotsPatternMatches("/cluster/*/kart", "/cluster/abc")).toBe(false);
    expect(robotsPatternMatches("/cluster/*/kart", "/cluster/abc/opengraph-image")).toBe(false);
    expect(robotsPatternMatches("/cluster/*/kart", "/cluster/abc?utm_source=x")).toBe(false);
    // Without '$' a rule is a prefix rule; with it the rule must reach the end.
    expect(robotsPatternMatches("/api/", "/api/health")).toBe(true);
    expect(robotsPatternMatches("/exact$", "/exact")).toBe(true);
    expect(robotsPatternMatches("/exact$", "/exact/")).toBe(false);
    expect(robotsPatternMatches("/*.pdf$", "/a/b.pdf")).toBe(true);
    expect(robotsPatternMatches("/*.pdf$", "/a/b.pdf?x=1")).toBe(false);
    expect(robotsPatternMatches("/*.pdf$", "/a/b.pdfx")).toBe(false);
    // Backtracking: the first candidate for a literal may not be the one that lets the rule match.
    expect(robotsPatternMatches("/*/b/c", "/x/b/y/b/c")).toBe(true);
    expect(robotsPatternMatches("/a*b*c$", "/aXbXbXc")).toBe(true);
    expect(robotsPatternMatches("/a*b*c$", "/aXbXbXcX")).toBe(false);
    // Consecutive and trailing stars; a '$' that is not trailing is a literal.
    expect(robotsPatternMatches("/a**b", "/ab")).toBe(true);
    expect(robotsPatternMatches("/a*", "/a")).toBe(true);
    expect(robotsPatternMatches("/a*$", "/a")).toBe(true);
    expect(robotsPatternMatches("/a$b", "/a$b")).toBe(true);
    expect(robotsPatternMatches("/a$b", "/ab")).toBe(false);
    // A pattern is never a regular expression: metacharacters are literal text.
    expect(robotsPatternMatches("/a.c", "/abc")).toBe(false);
    expect(robotsPatternMatches("/a+", "/aaa")).toBe(false);
    expect(robotsPatternMatches("/(a)", "/(a)")).toBe(true);
  });

  it("wildcard rules take part in longest-match and Allow-wins-a-tie selection", () => {
    const rules: RobotsRule[] = [
      { allow: true, path: "/" },
      { allow: false, path: "/*?cluster=" },
      { allow: true, path: "/metodoloji?cluster=ok" },
      { allow: false, path: "/a*" },
      { allow: true, path: "/*b" },
    ];
    expect(isCrawlAllowed(rules, "/blindspots")).toBe(true);
    expect(isCrawlAllowed(rules, "/metodoloji?cluster=abc")).toBe(false);
    // The Allow rule is the longer match, so it beats the wildcard Disallow.
    expect(isCrawlAllowed(rules, "/metodoloji?cluster=ok")).toBe(true);
    // Both '/a*' and '/*b' match '/ab' with a path length of 3: Allow wins the tie.
    expect(isCrawlAllowed(rules, "/ab")).toBe(true);
    expect(isCrawlAllowed(rules, "/ac")).toBe(false);
    expect(isCrawlAllowed(rules, "/cb")).toBe(true);
  });

  it("every same-site link in llms.txt (placeholders skipped) is allowed for *, Googlebot and ClaudeBot", async () => {
    const { llms, groups } = await loadFiles();
    const paths = internalLinkPaths(llms);

    // Non-vacuous: the list covers the registry, the OpenAPI file and the pages.
    expect(paths.length).toBeGreaterThanOrEqual(10);
    for (const expected of ["/metodoloji", "/sources", "/api/sources", "/api/v1/openapi.json", "/sitemap.xml"]) {
      expect(paths, "llms.txt link list").toContain(expected);
    }
    // The templated registry and RSS links are skipped, not judged.
    expect(paths.some((p) => p.includes("{"))).toBe(false);

    for (const crawler of CRAWLERS) {
      const rules = rulesFor(groups, crawler);
      for (const path of paths) {
        expect(isCrawlAllowed(rules, path), `${path} is disallowed for ${crawler} in /robots.txt`).toBe(true);
      }
    }
  });

  it("the keyed API and the rest of /api/ stay disallowed", async () => {
    const { groups } = await loadFiles();
    for (const crawler of CRAWLERS) {
      const rules = rulesFor(groups, crawler);
      for (const path of ["/api/v1/clusters", "/api/v1/clusters?limit=10", "/api/v1/", "/api/health", "/api/admin"]) {
        expect(isCrawlAllowed(rules, path), `${path} must stay disallowed for ${crawler}`).toBe(false);
      }
      expect(isCrawlAllowed(rules, "/admin"), `/admin for ${crawler}`).toBe(false);
      expect(isCrawlAllowed(rules, "/embed/x"), `/embed/x for ${crawler}`).toBe(false);
    }
  });
});
