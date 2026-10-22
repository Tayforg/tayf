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

import TopicHubPage from "./page";

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
