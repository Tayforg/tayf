import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { NextRequest } from "next/server";

import { middleware, config } from "@/middleware";
import { siteUrl } from "@/lib/site-url";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";

// ---------------------------------------------------------------------------
// /gundem entity hubs (roadmap G2). Two halves:
//
//  1. Edge gate + source-text guards, in the style of middleware-routing.test.ts
//     and konu-routes.test.ts: the matcher, the Set membership gate that gives
//     an unknown key a real 404, the "rising-entities.ts has no imports" rule
//     that keeps the Edge bundle clean, the static-params wiring, the sitemap.
//
//  2. The page body's three states (unavailable / empty / ok), rendered as a
//     plain async function with the data module mocked (the same harness as
//     src/app/konu/[slug]/page.test.tsx). The Supabase round-trips themselves
//     are covered by src/lib/entities/entity-hub-query.test.ts.
// ---------------------------------------------------------------------------

const ORIGIN = "https://www.tayfhaber.com";

function req(path: string): NextRequest {
  return new NextRequest(new URL(path, ORIGIN));
}

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/** Blanks // and block comments (keeps offsets); same helper as the other guards. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

// ---------------------------------------------------------------------------
// Part 1: middleware gate
// ---------------------------------------------------------------------------

describe("middleware: /gundem/:key gate", () => {
  it("matcher has the single literal segment /gundem/:key and never /gundem/:path*", () => {
    expect(config.matcher).toContain("/gundem/:key");
    expect(config.matcher).not.toContain("/gundem/:path*");
    // The index /gundem is a static page and must stay out of the matcher.
    expect(config.matcher).not.toContain("/gundem");
  });

  it("passes every curated RISING_ENTITIES key through", async () => {
    expect(RISING_ENTITIES.length).toBeGreaterThanOrEqual(60);
    for (const e of RISING_ENTITIES) {
      const res = await middleware(req(`/gundem/${e.key}`));
      expect(res.headers.get("x-middleware-next"), `key ${e.key}`).toBe("1");
      expect(res.headers.get("x-middleware-rewrite"), `key ${e.key}`).toBeNull();
    }
  });

  it("rewrites unknown keys to the not-found sink, not a bare 404", async () => {
    for (const path of [
      "/gundem/bilinmeyen",
      "/gundem/ERDOGAN", // keys are case-sensitive lowercase slugs
      "/gundem/Erdoğan",
      "/gundem/erdogan%20",
      "/gundem/__proto__",
      "/gundem/constructor",
      "/gundem/erdogan/extra",
    ]) {
      const res = await middleware(req(path));
      const rewrite = res.headers.get("x-middleware-rewrite");
      expect(rewrite, `path ${path}`).not.toBeNull();
      expect(rewrite).toContain("/__tayf-not-found");
      expect(res.status).not.toBe(404);
      expect(res.headers.get("x-middleware-next")).toBeNull();
    }
  });

  it("never falls into the admin branch (no 307 to /admin/login)", async () => {
    const res = await middleware(req("/gundem/erdogan"));
    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it("source: documents gate 6 and builds the key Set from RISING_ENTITIES", () => {
    const src = read("src/middleware.ts");
    expect(src).toMatch(/\n\/\/\s+6\.\s+\/gundem\/:key/);
    expect(src).toContain(
      'import { RISING_ENTITIES } from "@/lib/trends/rising-entities";',
    );
    expect(src).toContain(
      "const GUNDEM_KEYS = new Set(RISING_ENTITIES.map((e) => e.key));",
    );
    const code = blankComments(src);
    // The /gundem branch must precede the admin fallthrough.
    const gundemIdx = code.indexOf('pathname.startsWith("/gundem/")');
    const adminIdx = code.indexOf('pathname === "/admin/login"');
    expect(gundemIdx).toBeGreaterThan(-1);
    expect(adminIdx).toBeGreaterThan(gundemIdx);
  });
});

// ---------------------------------------------------------------------------
// Part 1b: static guards
// ---------------------------------------------------------------------------

describe("rising-entities.ts stays Edge-safe", () => {
  it("has no import, export-from or require statements (the middleware bundles it)", () => {
    const code = blankComments(read("src/lib/trends/rising-entities.ts"));
    expect(code).not.toMatch(/^\s*import\b/m);
    expect(code).not.toMatch(/\bexport\s+(\*|\{[^}]*\})\s*from\b/);
    expect(code).not.toMatch(/\bfrom\s+["'][^"']+["']/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });
});

describe("/gundem/[key] page source", () => {
  const src = read("src/app/gundem/[key]/page.tsx");
  const code = blankComments(src);

  it("declares generateStaticParams over RISING_ENTITIES", () => {
    expect(code).toMatch(/export\s+async\s+function\s+generateStaticParams\s*\(\s*\)/);
    expect(code).toContain("RISING_ENTITIES.map");
    expect(code).toMatch(/RISING_ENTITIES\.map\(\s*\(\s*e\s*\)\s*=>\s*\(\s*\{\s*key:\s*e\.key\s*\}\s*\)\s*\)/);
  });

  it("404s unknown keys via notFound() and never reads the clock (fully static page)", () => {
    expect(code).toContain("!isEntityKey(key)");
    expect(code).toContain("notFound()");
    expect(code).not.toMatch(/\bDate\.now\s*\(/);
    expect(code).not.toMatch(/\bcurrentTimeMs\s*\(/);
    // "now" comes from the cached read, and every card gets it
    expect(code).toContain("result?.asOfMs");
    expect(code).toContain("nowMs={nowMs}");
  });

  it("generateMetadata shares getEntityHub with the body and only adds robots when needed", () => {
    expect(code).toMatch(/export\s+async\s+function\s+generateMetadata/);
    expect(code).toContain("entityHubRobots(await getEntityHub(key))");
    expect(code).toContain("...(robots ? { robots } : {})");
    expect(code).toContain("staticPageMetadata(");
    expect(code).toContain("path: `/gundem/${key}`");
  });

  it("emits JSON-LD only for an indexable hub, built from the shared builders and no clock", () => {
    expect(code).toContain('type="application/ld+json"');
    expect(code).toContain("serializeJsonLd(");
    expect(code).toContain("buildClusterCollectionPage(");
    expect(code).toContain("buildBreadcrumbs(");
    // the same predicate generateMetadata uses for robots decides indexability
    expect(code).toContain("result !== null && entityHubRobots(result) === undefined");
  });

  it("links to the plain-anchor archive search and the index", () => {
    expect(code).toContain("`/?q=${encodeURIComponent(");
    expect(code).toMatch(/<a\s+href=\{`\/\?q=\$\{encodeURIComponent\(/);
    expect(code).toContain("Tüm arşivde ara");
    expect(code).toContain('href="/gundem"');
    expect(code).toContain("Tüm gündem başlıkları");
  });
});

describe("/gundem index page source", () => {
  const src = read("src/app/gundem/page.tsx");
  const code = blankComments(src);

  it("reads no database (no query module, no Supabase, no cache directive)", () => {
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/-query["']/);
    expect(code).not.toContain("next/cache");
    expect(code).not.toContain('"use cache"');
  });

  it("emits CollectionPage + BreadcrumbList JSON-LD from the static vocabulary", () => {
    expect(code).toContain('type="application/ld+json"');
    expect(code).toContain("buildClusterCollectionPage(");
    expect(code).toContain("buildBreadcrumbs(");
    expect(code).toContain("serializeJsonLd(");
  });

  it("uses staticPageMetadata with the /gundem path", () => {
    expect(code).toContain("staticPageMetadata(");
    expect(code).toContain('path: "/gundem"');
    expect(code).toContain("title: \"Gündem\"");
  });

  it("renders one prefetch-off chip per entity with a >= 24 px target", () => {
    expect(code).toContain("RISING_ENTITIES.map");
    expect(code).toContain("prefetch={false}");
    expect(code).toContain("href={`/gundem/${");
    expect(code).toContain("min-h-8");
    expect(code).toContain("focus-visible:ring-2");
  });
});

describe("sitemap", () => {
  const sitemaps = blankComments(read("src/lib/seo/sitemaps.ts"));
  const hubSitemap = blankComments(read("src/lib/seo/hub-sitemap.ts"));

  it("lists /gundem and points at /sitemaps/hubs.xml, with no hub or entity code of its own", () => {
    expect(sitemaps).toContain('{ path: "/gundem", changefreq: "daily", priority: 0.5 }');
    expect(sitemaps).toContain("/sitemaps/hubs.xml");
    // The 62 hubs are listed by hub-sitemap.ts, never hard-wired here.
    expect(sitemaps).not.toContain("/gundem/");
    expect(sitemaps).not.toMatch(/RISING_ENTITIES|getEntityHub|entityHubRobots|entity-hub/);
  });

  it("hub-sitemap.ts reads each hub and filters by the page's own robots predicate, uncached", () => {
    expect(hubSitemap).toContain("getEntityHub(");
    expect(hubSitemap).toContain("entityHubRobots(");
    // getEntityHub is a resolveCachedOrRetry getter: it must never run inside a
    // "use cache" body (tests/guards/cache-retry-prerender.test.ts).
    expect(hubSitemap).not.toContain("use cache");
  });

  it("no other seo module (non-test) touches getEntityHub", () => {
    const dir = resolve(ROOT, "src/lib/seo");
    const others = readdirSync(dir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "hub-sitemap.ts",
    );
    expect(others.length).toBeGreaterThan(0);
    for (const f of others) {
      const code = blankComments(read(`src/lib/seo/${f}`));
      expect(code, f).not.toMatch(/\bgetEntityHub\b/);
      expect(code, f).not.toContain("entity-hub-query");
    }
  });
});

describe("trends links", () => {
  it("rising.ts points an entity at its hub, not at the home search", () => {
    const code = blankComments(read("src/lib/trends/rising.ts"));
    expect(code).toContain("href: `/gundem/${entity.key}`");
    expect(code).not.toContain("/?q=");
  });
});

// ---------------------------------------------------------------------------
// Part 2: page body states
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  result: null as unknown,
  calls: [] as string[],
}));

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

vi.mock("@/lib/entities/entity-hub-query", () => ({
  getEntityHub: (key: string) => {
    mocks.calls.push(key);
    return Promise.resolve(mocks.result);
  },
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import EntityHubPage, {
  generateMetadata,
  generateStaticParams,
} from "@/app/gundem/[key]/page";
import GundemIndexPage, { metadata as indexMetadata } from "@/app/gundem/page";

type El = { type?: unknown; props?: Record<string, unknown> };

function walk(node: unknown, visit: (el: El) => void) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node && typeof node === "object") {
    const el = node as El;
    visit(el);
    if (el.props?.children !== undefined) walk(el.props.children, visit);
  }
}

function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { children?: ReactNode } };
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

/** Visible text of the tree plus the string props PageHero renders (kicker, title, subtitle). */
function pageText(tree: unknown): string {
  const parts = collectText(tree);
  walk(tree, (el) => {
    if (typeof el.type === "function" && (el.type as { name?: string }).name === "PageHero") {
      for (const k of ["kicker", "title", "subtitle"]) {
        const v = el.props?.[k];
        if (typeof v === "string") parts.push(v);
      }
    }
  });
  return parts.join(" ");
}

function elements(tree: unknown, pred: (el: El) => boolean): El[] {
  const out: El[] = [];
  walk(tree, (el) => {
    if (pred(el)) out.push(el);
  });
  return out;
}

const robotsMetas = (tree: unknown) =>
  elements(tree, (el) => el.type === "meta" && el.props?.name === "robots");

function bundle(id: string, dist: unknown = { center: 1 }) {
  return {
    cluster: {
      id,
      title_tr: `Başlık ${id}`,
      first_published: "2026-10-30T08:00:00.000Z",
      updated_at: "2026-10-30T10:00:00.000Z",
      bias_distribution: dist,
    },
    articles: [],
    sources: [],
    isWireRedistribution: false,
    effectiveArticleCount: 2,
  };
}

const renderHub = (key = "erdogan") =>
  EntityHubPage({ params: Promise.resolve({ key }) });

beforeEach(() => {
  mocks.result = null;
  mocks.calls = [];
});

describe("generateStaticParams", () => {
  it("returns one { key } per curated entity", async () => {
    const params = await generateStaticParams();
    expect(params).toEqual(RISING_ENTITIES.map((e) => ({ key: e.key })));
    expect(new Set(params.map((p) => p.key)).size).toBe(RISING_ENTITIES.length);
  });
});

describe("generateMetadata", () => {
  const meta = (key: string) => generateMetadata({ params: Promise.resolve({ key }) });

  it("returns {} for an unknown key without reading data", async () => {
    await expect(meta("bilinmeyen")).resolves.toEqual({});
    expect(mocks.calls).toEqual([]);
  });

  it("builds the title, description and canonical from the entity label", async () => {
    mocks.result = { bundles: [bundle("a"), bundle("b"), bundle("c")], total: 3, asOfMs: 0 };
    const m = await meta("erdogan");
    expect(m.title).toBe("Erdoğan haberleri");
    expect(m.description).toBe(
      "Erdoğan hakkında son 14 günün haber kümeleri ve kaynak dağılımı.",
    );
    expect(m.alternates?.canonical).toBe("/gundem/erdogan");
    expect(mocks.calls).toEqual(["erdogan"]);
  });

  it("leaves a healthy hub (>= 3 clusters) indexable: no robots key at all", async () => {
    mocks.result = { bundles: [bundle("a"), bundle("b"), bundle("c")], total: 9, asOfMs: 0 };
    const m = await meta("chp");
    expect("robots" in m).toBe(false);
  });

  it("noindexes a thin hub (< 3 clusters)", async () => {
    mocks.result = { bundles: [bundle("a")], total: 1, asOfMs: 0 };
    const m = await meta("ysk");
    expect(m.robots).toEqual({ index: false, follow: true });
  });

  it("noindexes an unavailable hub", async () => {
    mocks.result = null;
    const m = await meta("ysk");
    expect(m.robots).toEqual({ index: false, follow: true });
    expect(m.alternates?.canonical).toBe("/gundem/ysk");
  });
});

describe("/gundem/[key] body", () => {
  it("404s an unknown key", async () => {
    await expect(renderHub("bilinmeyen")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.calls).toEqual([]);
  });

  it("unavailable (null): honest copy plus a body noindex meta, hero still shown", async () => {
    mocks.result = null;
    const tree = await renderHub("erdogan");
    const text = pageText(tree);
    expect(text).toContain(
      "Bu sayfa şu anda yüklenemiyor. Birkaç dakika içinde tekrar deneyin.",
    );
    const metas = robotsMetas(tree);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.props?.content ?? (metas[0] as El).props?.content).toBe("noindex");
    expect(text).not.toContain("Listelenen haberlerin kaynak dağılımı");
  });

  it("empty: says there are no clusters and emits no robots meta", async () => {
    mocks.result = { bundles: [], total: 0, asOfMs: 0 };
    const tree = await renderHub("ysk");
    const text = pageText(tree);
    expect(text).toContain("Son 14 günde bu konuda küme yok.");
    expect(robotsMetas(tree)).toHaveLength(0);
    expect(text).not.toContain("Listelenen haberlerin kaynak dağılımı");
  });

  it("ok: heading, summed spectrum, one card per bundle in order, truncation note, no robots meta", async () => {
    mocks.result = {
      bundles: [
        bundle("c1", { pro_government: 2, center: 1 }),
        bundle("c2", { pro_government: 1, opposition: 3 }),
        bundle("c3", { center: 4 }),
      ],
      total: 422,
      asOfMs: 0,
    };
    const tree = await renderHub("erdogan");
    const text = pageText(tree);

    expect(text).toContain("Erdoğan");
    expect(text).toContain("Erdoğan ile ilgili son 14 günün haber kümeleri.");
    expect(text).toContain("Son 14 günde 422 küme · en yeni 3 tanesi listeleniyor");
    expect(text).toContain(
      "Eşleşme, küme başlığı ve özetinde tam metin aramasıyla yapılır; eş adlı kişi ve kurumlar karışabilir.",
    );
    expect(text).toContain("Listelenen haberlerin kaynak dağılımı");
    expect(robotsMetas(tree)).toHaveLength(0);

    const h2 = elements(tree, (el) => el.type === "h2");
    expect(h2).toHaveLength(1);

    const spectrum = elements(
      tree,
      (el) => typeof el.type === "function" && (el.type as { name?: string }).name === "BiasSpectrum",
    );
    expect(spectrum).toHaveLength(1);
    const dist = spectrum[0]!.props!.distribution as Record<string, number>;
    expect(dist.pro_government).toBe(3);
    expect(dist.center).toBe(5);
    expect(dist.opposition).toBe(3);
    expect(spectrum[0]!.props!.compact).toBeFalsy();

    const cards = elements(
      tree,
      (el) => typeof el.type === "function" && (el.type as { name?: string }).name === "ClusterCard",
    );
    expect(cards.map((c) => (c.props!.cluster as { id: string }).id)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    expect(cards.map((c) => c.props!.index)).toEqual([0, 1, 2]);
    expect(cards.every((c) => typeof c.props!.isAging === "boolean")).toBe(true);
  });

  it("ok: does not claim a truncation when everything is listed", async () => {
    mocks.result = { bundles: [bundle("c1"), bundle("c2"), bundle("c3")], total: 3, asOfMs: 0 };
    const text = pageText(await renderHub("chp"));
    expect(text).toContain("Son 14 günde 3 küme");
    expect(text).not.toContain("tanesi listeleniyor");
  });

  it("offers a follow button for the label as a query, in every state", async () => {
    for (const result of [null, { bundles: [], total: 0, asOfMs: 0 }, { bundles: [bundle("a")], total: 1, asOfMs: 0 }]) {
      mocks.result = result;
      const tree = await renderHub("ozgur-ozel");
      const follow = elements(
        tree,
        (el) => typeof el.type === "function" && (el.type as { name?: string }).name === "FollowButton",
      );
      expect(follow).toHaveLength(1);
      expect(follow[0]!.props).toMatchObject({ kind: "q", value: "Özgür Özel" });
    }
  });

  it("footer: plain-anchor archive search with the encoded label, and the index link", async () => {
    mocks.result = { bundles: [bundle("a")], total: 1, asOfMs: 0 };
    const tree = await renderHub("erdogan");

    const anchors = elements(tree, (el) => el.type === "a");
    const search = anchors.find((a) => collectText(a).join("") === "Tüm arşivde ara");
    expect(search?.props?.href).toBe(`/?q=${encodeURIComponent("Erdoğan")}`);
    expect(search?.props?.href).toBe("/?q=Erdo%C4%9Fan");

    const links = elements(tree, (el) => el.props?.href === "/gundem");
    expect(links).toHaveLength(1);
    expect(collectText(links[0]).join("")).toBe("Tüm gündem başlıkları");
  });
});

describe("/gundem/[key] structured data", () => {
  const ldScripts = (tree: unknown) =>
    elements(tree, (el) => el.type === "script" && el.props?.type === "application/ld+json");
  const ldJson = (el: El): unknown =>
    JSON.parse(
      (el.props!.dangerouslySetInnerHTML as { __html: string }).__html,
    );

  it("an indexable hub (3 bundles) renders exactly one JSON-LD script: CollectionPage + BreadcrumbList", async () => {
    mocks.result = { bundles: [bundle("c1"), bundle("c2"), bundle("c3")], total: 9, asOfMs: 0 };
    const tree = await renderHub("erdogan");

    const scripts = ldScripts(tree);
    expect(scripts).toHaveLength(1);
    const base = siteUrl();
    expect(ldJson(scripts[0]!)).toEqual([
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: "Erdoğan haberleri",
        url: `${base}/gundem/erdogan`,
        isPartOf: { "@type": "WebSite", name: "Tayf", url: base },
        mainEntity: {
          "@type": "ItemList",
          numberOfItems: 3,
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Başlık c1", url: `${base}/cluster/c1` },
            { "@type": "ListItem", position: 2, name: "Başlık c2", url: `${base}/cluster/c2` },
            { "@type": "ListItem", position: 3, name: "Başlık c3", url: `${base}/cluster/c3` },
          ],
        },
      },
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Anasayfa", item: `${base}/` },
          { "@type": "ListItem", position: 2, name: "Gündem", item: `${base}/gundem` },
          { "@type": "ListItem", position: 3, name: "Erdoğan", item: `${base}/gundem/erdogan` },
        ],
      },
    ]);
  });

  it("the script is the first child of the page container, ahead of the hero", async () => {
    mocks.result = { bundles: [bundle("c1"), bundle("c2"), bundle("c3")], total: 3, asOfMs: 0 };
    const tree = (await renderHub("chp")) as { props: { children: unknown[] } };

    const first = tree.props.children[0] as El;
    expect(first.type).toBe("script");
    expect(first.props?.type).toBe("application/ld+json");
  });

  it("the boundary is the indexability rule: 3 bundles emit, 2 do not", async () => {
    mocks.result = { bundles: [bundle("a"), bundle("b")], total: 2, asOfMs: 0 };
    expect(ldScripts(await renderHub("ysk"))).toHaveLength(0);

    mocks.result = { bundles: [bundle("a"), bundle("b"), bundle("c")], total: 3, asOfMs: 0 };
    expect(ldScripts(await renderHub("ysk"))).toHaveLength(1);
  });

  it("thin (1 bundle), empty and unavailable (null) hubs render no JSON-LD", async () => {
    for (const result of [
      { bundles: [bundle("a")], total: 1, asOfMs: 0 },
      { bundles: [], total: 0, asOfMs: 0 },
      null,
    ]) {
      mocks.result = result;
      expect(ldScripts(await renderHub("ysk"))).toHaveLength(0);
    }
  });

  it("a hostile cluster title cannot close the script element", async () => {
    const evil = bundle("c1");
    evil.cluster.title_tr = "x </script><img src=x onerror=alert(1)>";
    mocks.result = { bundles: [evil, bundle("c2"), bundle("c3")], total: 3, asOfMs: 0 };

    const scripts = ldScripts(await renderHub("erdogan"));
    const html = (scripts[0]!.props!.dangerouslySetInnerHTML as { __html: string }).__html;

    expect(html).not.toContain("<");
    expect(JSON.stringify(ldJson(scripts[0]!))).toContain("</script>");
  });
});

describe("/gundem index body", () => {
  it("has the static metadata", () => {
    expect(indexMetadata.title).toBe("Gündem");
    expect(indexMetadata.description).toBe(
      "Kişi, parti, kurum ve ülkelere göre son 14 günün haber kümeleri.",
    );
    expect(indexMetadata.alternates?.canonical).toBe("/gundem");
  });

  it("renders the hero and one prefetch-off chip per entity, in vocabulary order", () => {
    const tree = GundemIndexPage();
    const text = pageText(tree);
    expect(text).toContain("Gündemdeki adlar");
    expect(text).toContain("Kişi, parti, kurum ve ülkelere göre son 14 günün haberleri.");

    const lists = elements(tree, (el) => el.type === "ul");
    expect(lists).toHaveLength(1);

    const chips = elements(
      tree,
      (el) => typeof el.props?.href === "string" && String(el.props.href).startsWith("/gundem/"),
    );
    expect(chips.map((c) => c.props!.href)).toEqual(
      RISING_ENTITIES.map((e) => `/gundem/${e.key}`),
    );
    expect(chips.every((c) => c.props!.prefetch === false)).toBe(true);
    expect(chips.map((c) => collectText(c).join(""))).toEqual(
      RISING_ENTITIES.map((e) => e.label),
    );
    for (const c of chips) {
      expect(String(c.props!.className)).toContain("min-h-8");
    }
  });

  it("renders one JSON-LD script: CollectionPage of all hubs in vocabulary order + BreadcrumbList", () => {
    const scripts = elements(
      GundemIndexPage(),
      (el) => el.type === "script" && el.props?.type === "application/ld+json",
    );
    expect(scripts).toHaveLength(1);

    const base = siteUrl();
    const data = JSON.parse(
      (scripts[0]!.props!.dangerouslySetInnerHTML as { __html: string }).__html,
    ) as unknown[];
    expect(data).toEqual([
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: "Gündemdeki adlar",
        url: `${base}/gundem`,
        isPartOf: { "@type": "WebSite", name: "Tayf", url: base },
        mainEntity: {
          "@type": "ItemList",
          numberOfItems: RISING_ENTITIES.length,
          itemListElement: RISING_ENTITIES.map((e, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: e.label,
            url: `${base}/gundem/${e.key}`,
          })),
        },
      },
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Anasayfa", item: `${base}/` },
          { "@type": "ListItem", position: 2, name: "Gündem", item: `${base}/gundem` },
        ],
      },
    ]);
    expect(RISING_ENTITIES.length).toBe(62);
  });
});
