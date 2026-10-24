import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// /konu/[slug] failed state. Harness copied from src/app/hafta/page.test.tsx:
// mock the data module (the Supabase round-trips are covered by
// src/lib/clusters/topic-query.test.ts) and call the default export as a plain
// async function -- no React renderer needed for an async Server Component.
//
// What this pins: ONLY the failed read (getTopicClusters -> null) emits
// <meta name="robots" content="noindex">. The ok and empty states must not,
// or a healthy hub would drop out of the index. The failure is cached for
// "minutes" (topic-query.ts), so the prerendered noindex lives about a minute.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  result: null as unknown,
}));

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

// Everything except the fetcher stays real (slug validation, labels, page
// clamp, JSON-LD builder), so the page runs exactly as shipped.
vi.mock("@/lib/clusters/topic-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/topic-query")>();
  return {
    ...actual,
    getTopicClusters: () => Promise.resolve(mocks.result),
  };
});

import TopicHubPage, { generateMetadata } from "./page";

const UNAVAILABLE_COPY =
  "Konu listesi şu anda yüklenemiyor. Birkaç dakika içinde tekrar deneyin.";

/** Every element in the tree (own JSX only; custom components stay unexpanded). */
function walk(node: unknown, visit: (el: { type?: unknown; props?: Record<string, unknown> }) => void) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    visit(el);
    if (el.props?.children !== undefined) walk(el.props.children, visit);
  }
}

function robotsMetas(tree: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  walk(tree, (el) => {
    if (el.type === "meta" && el.props?.name === "robots") out.push(el.props);
  });
  return out;
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

async function render(page = 1) {
  return TopicHubPage({
    params: Promise.resolve({ slug: "dunya" }),
    searchParams: Promise.resolve(page === 1 ? {} : { sayfa: String(page) }),
  });
}

function bundle(id: string) {
  return {
    cluster: {
      id,
      title_tr: `Küme ${id}`,
      updated_at: "2026-09-18T11:00:00.000Z",
    },
    articles: [],
    sources: [],
    isWireRedistribution: false,
    effectiveArticleCount: 1,
  };
}

beforeEach(() => {
  mocks.result = null;
});

describe("/konu/[slug] failed state", () => {
  it("emits <meta name=robots content=noindex> and the unavailable copy when the read failed (null)", async () => {
    mocks.result = null;

    const tree = await render();
    const metas = robotsMetas(tree);

    expect(metas).toHaveLength(1);
    expect(metas[0]?.content).toBe("noindex");
    expect(collectText(tree).join("")).toContain(UNAVAILABLE_COPY);
  });

  it("does NOT emit a robots meta when the page has bundles", async () => {
    mocks.result = { bundles: [bundle("c1"), bundle("c2")], hasMore: false, page: 1 };

    const tree = await render();

    expect(robotsMetas(tree)).toEqual([]);
    expect(collectText(tree).join("")).not.toContain(UNAVAILABLE_COPY);
  });

  it("does NOT emit a robots meta for a legitimately empty page 1 (read fine, nothing matched)", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 1 };

    const tree = await render();

    expect(robotsMetas(tree)).toEqual([]);
    const text = collectText(tree).join("");
    expect(text).toContain("Bu konuda son 7 günde küme oluşmadı.");
    expect(text).not.toContain(UNAVAILABLE_COPY);
  });

  it("does NOT emit a robots meta for an empty page past the last one", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 3 };

    const tree = await render(3);

    expect(robotsMetas(tree)).toEqual([]);
    expect(collectText(tree).join("")).toContain("Bu sayfada küme yok.");
  });
});

// ---------------------------------------------------------------------------
// generateMetadata: the share/canonical identity of each hub page. The real
// topicMetadata runs (only the fetcher is mocked above), so this pins the
// wiring: slug + parsed ?sayfa= -> canonical and og:url agree, and the RSS
// alternate survives the merge.
// ---------------------------------------------------------------------------

function meta(slug: string, sayfa?: string | string[]) {
  return generateMetadata({
    params: Promise.resolve({ slug }),
    searchParams: Promise.resolve(sayfa === undefined ? {} : { sayfa }),
  });
}

describe("/konu/[slug] generateMetadata", () => {
  it("page 1: canonical and og:url are /konu/<slug>, and the RSS alternate is advertised", async () => {
    const m = await meta("spor");

    expect(m.alternates?.canonical).toBe("/konu/spor");
    expect(m.openGraph?.url).toBe("/konu/spor");
    expect(m.alternates?.types).toEqual({
      "application/rss+xml": "/rss/spor.xml",
    });
    expect(m.title).toBe("Spor haberleri");
    expect(m.openGraph?.title).toBe("Spor haberleri — Tayf");
    expect(m.robots).toBeUndefined();
  });

  it('?sayfa=2: canonical and og:url both carry "?sayfa=2"', async () => {
    const m = await meta("spor", "2");

    expect(m.alternates?.canonical).toBe("/konu/spor?sayfa=2");
    expect(m.openGraph?.url).toBe("/konu/spor?sayfa=2");
    expect(m.alternates?.types).toEqual({
      "application/rss+xml": "/rss/spor.xml",
    });
  });

  it('?sayfa=999 is clamped: both carry "?sayfa=20"', async () => {
    const m = await meta("spor", "999");

    expect(m.alternates?.canonical).toBe("/konu/spor?sayfa=20");
    expect(m.openGraph?.url).toBe("/konu/spor?sayfa=20");
  });

  it("a repeated ?sayfa= uses the first value, exactly like the page body", async () => {
    const m = await meta("ekonomi", ["3", "7"]);

    expect(m.alternates?.canonical).toBe("/konu/ekonomi?sayfa=3");
    expect(m.openGraph?.url).toBe("/konu/ekonomi?sayfa=3");
  });

  it.each(["abc", "0", "-4", "1"])(
    "?sayfa=%s falls back to page 1 (no query on the canonical or og:url)",
    async (raw) => {
      const m = await meta("dunya", raw);

      expect(m.alternates?.canonical).toBe("/konu/dunya");
      expect(m.openGraph?.url).toBe("/konu/dunya");
    },
  );

  it("politika (redirect slug) and unknown slugs get {}: the redirect/404 is the answer, not a meta tag", async () => {
    await expect(meta("politika")).resolves.toEqual({});
    await expect(meta("saglik")).resolves.toEqual({});
    await expect(meta("../admin")).resolves.toEqual({});
  });
});
