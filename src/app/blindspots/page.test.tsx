import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// A-M4: no test file existed for /blindspots before. Keeps `getBlindspotsSafe`
// resolving zero bundles (the page's own empty-state branch) so this test
// doesn't need to mock ClusterCard's full dependency chain — the point here
// is PERF-01 (parallel fetch) and the DenominatorNote wiring, not the
// bundle-rendering path (already covered by blindspots-query.test.ts).
//
// reader-queries D2: the page's data-dependent body now lives in the inner
// async `BlindspotsFeed` component, streamed behind a <Suspense> boundary —
// `BlindspotsPage()` itself returns synchronously and never touches the
// data layer. Every assertion below therefore renders `BlindspotsFeed()`
// directly (it's the exported implementation detail these tests exist to
// cover) rather than `BlindspotsPage()`.
// ---------------------------------------------------------------------------

vi.mock("next/server", () => ({
  connection: vi.fn(async () => undefined),
}));

const getBlindspots = vi.fn(
  async (): Promise<{ ok: true; bundles: unknown[] } | { ok: false }> => ({
    ok: true,
    bundles: [],
  }),
);
vi.mock("@/lib/clusters/blindspots-query", () => ({
  getBlindspotsSafe: () => getBlindspots(),
}));

const getFeedStatusSummary = vi.fn(
  async (): Promise<{ delivering: number; total: number } | null> => ({
    delivering: 59,
    total: 96,
  }),
);
vi.mock("@/lib/sources/feed-status", () => ({
  getFeedStatusSummary: () => getFeedStatusSummary(),
}));

import { BlindspotsFeed } from "./page";
import { DenominatorNote } from "@/components/source/denominator-note";
import { SilenceDigestBand } from "@/components/blindspots/silence-digest-band";
import type { SilenceDigest } from "@/lib/clusters/silence-digest";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.RESEND_API_KEY; // isMailConfigured() -> false, no NewsletterForm
  getBlindspots.mockReset();
  getBlindspots.mockImplementation(async () => ({ ok: true, bundles: [] }));
  getFeedStatusSummary.mockClear();
});

afterEach(() => {
  for (const k of ["RESEND_API_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

/**
 * Collects every string/number leaf under a React element tree. Expands
 * `<DenominatorNote>` so its own rendered text is reachable without a full
 * renderer.
 */
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
    const el = node as { type?: unknown; props?: { children?: ReactNode } };
    if (el.type === DenominatorNote && el.props) {
      const props = el.props as unknown as Parameters<typeof DenominatorNote>[0];
      collectText(DenominatorNote(props), out);
      return out;
    }
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

/**
 * Collects every `href` prop found anywhere in a React element tree.
 * Expands `<DenominatorNote>` so its /kaynaklar/durum link is reachable
 * without a full renderer.
 */
function collectHrefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as {
      type?: unknown;
      props?: { href?: unknown; children?: ReactNode };
    };
    if (el.type === DenominatorNote && el.props) {
      const props = el.props as unknown as Parameters<typeof DenominatorNote>[0];
      collectHrefs(DenominatorNote(props), out);
      return out;
    }
    if (typeof el.props?.href === "string") out.push(el.props.href);
    if (el.props?.children !== undefined) collectHrefs(el.props.children, out);
  }
  return out;
}

describe("/blindspots page", () => {
  it("A-M4: links to /kaynaklar/durum via the DenominatorNote, with the voting-kind pair from getFeedStatusSummary", async () => {
    const tree = await BlindspotsFeed();
    const hrefs = collectHrefs(tree);
    const text = collectText(tree).join(" ");

    expect(hrefs).toContain("/kaynaklar/durum");
    expect(text).toContain("59");
    expect(text).toContain("96");
  });

  it("PERF-01: fetches getBlindspots and getFeedStatusSummary in parallel (both start before either resolves)", async () => {
    const order: string[] = [];
    getBlindspots.mockImplementation(async () => {
      order.push("blindspots:start");
      await new Promise((r) => setTimeout(r, 0));
      order.push("blindspots:end");
      return { ok: true, bundles: [] };
    });
    getFeedStatusSummary.mockImplementation(async () => {
      order.push("summary:start");
      await new Promise((r) => setTimeout(r, 0));
      order.push("summary:end");
      return { delivering: 1, total: 2 };
    });

    await BlindspotsFeed();

    // Both "start" markers must precede both "end" markers — impossible
    // under two serial `await`s, which would fully finish one call before
    // the other's body even begins.
    expect(order.indexOf("blindspots:start")).toBeLessThan(order.indexOf("summary:end"));
    expect(order.indexOf("summary:start")).toBeLessThan(order.indexOf("blindspots:end"));
  });

  it("degrades DenominatorNote to wording-without-numbers when the summary is unknown", async () => {
    getFeedStatusSummary.mockResolvedValueOnce(null);

    const tree = await BlindspotsFeed();
    const text = collectText(tree).join(" ");

    expect(text).toContain("yanlılık dağılımına sayılan");
  });
});

type Elementish = { type?: unknown; props?: Record<string, unknown> };

/** Collects every element in the tree (props.children walked recursively). */
function collectElements(node: unknown, out: Elementish[] = []): Elementish[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as Elementish;
    if (el.type !== undefined) out.push(el);
    if (el.props?.children !== undefined) {
      collectElements(el.props.children, out);
    }
  }
  return out;
}

function noindexMetas(tree: unknown): Elementish[] {
  return collectElements(tree).filter(
    (el) =>
      el.type === "meta" &&
      el.props?.name === "robots" &&
      el.props?.content === "noindex",
  );
}

describe("/blindspots page — noindex on the failed feed state only (seo-error-states)", () => {
  it("emits <meta name=robots content=noindex> when getBlindspotsSafe reports { ok: false }", async () => {
    getBlindspots.mockResolvedValueOnce({ ok: false });

    const tree = await BlindspotsFeed();

    expect(noindexMetas(tree)).toHaveLength(1);
  });

  it("makes the noindex meta the first child of the failure container", async () => {
    getBlindspots.mockResolvedValueOnce({ ok: false });

    const tree = await BlindspotsFeed();

    const failure = collectElements(tree).find(
      (el) =>
        el.type === "div" &&
        Array.isArray(el.props?.children) &&
        (el.props.children as Elementish[])[0]?.type === "meta",
    );
    expect(failure).toBeDefined();
    expect(noindexMetas(failure)).toHaveLength(1);
  });

  it("does not emit noindex on the ok-but-empty path", async () => {
    getBlindspots.mockResolvedValueOnce({ ok: true, bundles: [] });

    const tree = await BlindspotsFeed();

    expect(noindexMetas(tree)).toHaveLength(0);
    expect(collectText(tree).join(" ")).toContain("belirgin bir kör nokta yok");
  });
});

describe("/blindspots page — silence digest band", () => {
  const NOW = Date.parse("2026-10-22T12:00:00Z");
  const DAY = 24 * 3_600_000;

  beforeEach(() => {
    // Only Date is faked: the page reads Date.now() once (card aging), and
    // the mocked fetchers resolve via microtasks, so no timers need faking.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mkBundle(id: string, updatedAtMs: number) {
    return {
      cluster: { id, updated_at: new Date(updatedAtMs).toISOString() },
      articles: [],
      sources: [{ id: `${id}-s`, name: "Kaynak", bias: "pro_government" }],
      dominantZone: "iktidar",
      dominantPct: 1,
      votingZoneCounts: { iktidar: 1, bagimsiz: 0, muhalefet: 0 },
      isWireRedistribution: false,
      effectiveArticleCount: 1,
    };
  }

  function bands(tree: unknown): Elementish[] {
    return collectElements(tree).filter((el) => el.type === SilenceDigestBand);
  }

  it("renders one band, derived from the loaded bundles, when the feed has a bundle updated 1 h ago", async () => {
    getBlindspots.mockResolvedValueOnce({
      ok: true,
      bundles: [mkBundle("c1", NOW - 3_600_000)],
    });

    const tree = await BlindspotsFeed();

    const found = bands(tree);
    expect(found).toHaveLength(1);
    const digest = found[0]?.props?.digest as SilenceDigest;
    expect(digest.windowTotal).toBe(1);
    expect(digest.rows.map((r) => r.zone)).toEqual([
      "iktidar",
      "bagimsiz",
      "muhalefet",
    ]);
  });

  it("renders the band whenever the feed is ok and has bundles: a story updated 5 days ago still counts", async () => {
    getBlindspots.mockResolvedValueOnce({
      ok: true,
      bundles: [mkBundle("old", NOW - 5 * DAY)],
    });

    const tree = await BlindspotsFeed();

    const found = bands(tree);
    expect(found).toHaveLength(1);
    const digest = found[0]?.props?.digest as SilenceDigest;
    expect(digest.windowTotal).toBe(1);
    expect(digest.rows.map((r) => r.silentCount)).toEqual([0, 1, 1]);
  });

  it("counts every distinct bundle on the page, fresh or stale", async () => {
    getBlindspots.mockResolvedValueOnce({
      ok: true,
      bundles: [
        mkBundle("fresh", NOW - 3_600_000),
        mkBundle("stale", NOW - 25 * 3_600_000),
        mkBundle("ancient", NOW - 40 * DAY),
      ],
    });

    const tree = await BlindspotsFeed();

    const digest = bands(tree)[0]?.props?.digest as SilenceDigest;
    expect(digest.windowTotal).toBe(3);
  });

  it("does not render the band when the feed failed ({ ok: false })", async () => {
    getBlindspots.mockResolvedValueOnce({ ok: false });

    const tree = await BlindspotsFeed();

    expect(bands(tree)).toHaveLength(0);
  });

  it("does not render the band on the ok-but-empty path", async () => {
    getBlindspots.mockResolvedValueOnce({ ok: true, bundles: [] });

    const tree = await BlindspotsFeed();

    expect(bands(tree)).toHaveLength(0);
  });
});
