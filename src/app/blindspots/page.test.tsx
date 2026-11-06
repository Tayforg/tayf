import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// A-M4: no test file existed for /blindspots before. Keeps `getBlindspotsSafe`
// resolving zero bundles (the page's own empty-state branch) so this test
// doesn't need to mock ClusterCard's full dependency chain — the point here
// is the DenominatorNote wiring (now its own Suspense slot, hunt-27
// resilience-1), not the bundle-rendering path (already covered by
// blindspots-query.test.ts).
//
// h53-consistency-1: the fetch result is now { bundles, more, claimCount,
// sideCounts, digest }. `okResult` builds one the way the fetcher does (real
// buildSilenceDigest over every claim), so the page is tested against the
// shape it really receives.
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

type FeedResult =
  | {
      ok: true;
      bundles: unknown[];
      more: unknown[];
      claimCount: number;
      sideCounts: Record<MediaDnaZone, number>;
      digest: SilenceDigest;
    }
  | { ok: false };
const getBlindspots = vi.fn(async (): Promise<FeedResult> => ({ ok: false }));
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

const getNearBlindspots = vi.fn(
  async (): Promise<unknown[] | null> => [],
);
vi.mock("@/lib/clusters/near-blindspots-query", () => ({
  getNearBlindspotsSafe: () => getNearBlindspots(),
}));

import BlindspotsPage, { BlindspotsFeed, NearBlindspotsSection, metadata } from "./page";
import { createElement, Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DenominatorNote } from "@/components/source/denominator-note";
import { PageHero } from "@/components/ui/page-hero";
import { NearBlindspotList } from "@/components/blindspots/near-blindspot-section";
import { SilenceDigestBand } from "@/components/blindspots/silence-digest-band";
import { buildSilenceDigest, type SilenceDigest } from "@/lib/clusters/silence-digest";
import type { MediaDnaZone } from "@/types";

const ORIGINAL_ENV = { ...process.env };

/**
 * A successful fetch result shaped like the fetcher's: `claims` is every
 * passing claim (cards first, then compact rows), the digest is counted over
 * all of them, the side counts add up to claimCount.
 */
function okResult(
  bundles: unknown[],
  more: unknown[] = [],
  overrides: Partial<Extract<FeedResult, { ok: true }>> = {},
): Extract<FeedResult, { ok: true }> {
  const cards = bundles as Array<{ dominantZone: MediaDnaZone }>;
  const rows = more as Array<{ dominantZone: MediaDnaZone }>;
  const sideCounts: Record<MediaDnaZone, number> = { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
  for (const c of [...cards, ...rows]) sideCounts[c.dominantZone] += 1;
  return {
    ok: true,
    bundles,
    more,
    claimCount: bundles.length + more.length,
    sideCounts,
    digest: buildSilenceDigest(
      bundles as Parameters<typeof buildSilenceDigest>[0],
    ),
    ...overrides,
  };
}

// Order independence (vitest --sequence.shuffle): mockClear() only drops call
// records, so an implementation swapped in by one test (PERF-01) or a
// mockResolvedValueOnce it never consumed leaked into whichever test ran next.
// All three fetcher mocks are therefore mockReset() and given their default
// implementation again before every test, and fake Date timers never outlive a
// test (the digest-band describe installs them in its own beforeEach).
beforeEach(() => {
  delete process.env.RESEND_API_KEY; // isMailConfigured() -> false, no NewsletterForm
  getBlindspots.mockReset();
  getBlindspots.mockImplementation(async () => okResult([]));
  getFeedStatusSummary.mockReset();
  getFeedStatusSummary.mockImplementation(async () => ({ delivering: 59, total: 96 }));
  getNearBlindspots.mockReset();
  getNearBlindspots.mockImplementation(async () => []);
});

afterEach(() => {
  vi.useRealTimers();
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

type SlotElement = { type?: unknown; props?: Record<string, unknown> };

/**
 * The `<Suspense>` element whose only child is the named async component.
 * `BlindspotsDenominator` is module-private (a page file only exports the
 * route API plus the two feed components the tests already use), so it is
 * located by function name.
 */
function findSuspenseAround(
  tree: unknown,
  componentName: string,
): SlotElement | undefined {
  return collectElements(tree).find((el) => {
    if (el.type !== Suspense) return false;
    const child = el.props?.children as SlotElement | undefined;
    return (
      typeof child?.type === "function" &&
      (child.type as { name?: string }).name === componentName
    );
  });
}

/** Awaits the named async slot the way React would, with the props it was given. */
async function renderSlot(tree: unknown, componentName: string): Promise<unknown> {
  const child = findSuspenseAround(tree, componentName)?.props?.children as
    | SlotElement
    | undefined;
  if (!child || typeof child.type !== "function") {
    throw new Error(`no <Suspense> around ${componentName}`);
  }
  return (child.type as (props: unknown) => Promise<unknown>)(child.props);
}

describe("/blindspots page", () => {
  it("A-M4: links to /kaynaklar/durum via the DenominatorNote, with the voting-kind pair from getFeedStatusSummary", async () => {
    const tree = await renderSlot(await BlindspotsFeed(), "BlindspotsDenominator");
    const hrefs = collectHrefs(tree);
    const text = collectText(tree).join(" ");

    expect(hrefs).toContain("/kaynaklar/durum");
    expect(text).toContain("59");
    expect(text).toContain("96");
  });

  it("hunt-27: the DenominatorNote is the FIRST child of the feed, in its own Suspense whose fallback is the numberless DenominatorNote (h55-browser-1)", async () => {
    const tree = (await BlindspotsFeed()) as Elementish;

    const boundary = findSuspenseAround(tree, "BlindspotsDenominator");
    expect(boundary).toBeDefined();
    // h55-browser-1: the fallback is no longer null. It is the fail-open
    // DenominatorNote, so the line box exists from the feed's first paint.
    const fallback = boundary?.props?.fallback as Elementish | null | undefined;
    expect(fallback).not.toBeNull();
    expect(fallback?.type).toBe(DenominatorNote);
    expect(fallback?.props).toEqual({ delivering: null, total: null });
    const children = tree.props?.children as unknown[];
    expect(children[0]).toBe(boundary);
  });

  describe("h55-browser-1: the slot reserves its line before the summary resolves", () => {
    const NUMBERLESS =
      "Paylar, yanlılık dağılımına sayılan ve son 72 saatte en az bir haber veren kaynaklar üzerinden hesaplanır.";

    async function fallbackOf(): Promise<Elementish> {
      const tree = await BlindspotsFeed();
      const fallback = findSuspenseAround(tree, "BlindspotsDenominator")?.props
        ?.fallback as Elementish | null | undefined;
      if (!fallback) throw new Error("the denominator Suspense has no fallback");
      return fallback;
    }

    it("the fallback's text is the text of DenominatorNote({ delivering: null, total: null }) -- the numberless wording", async () => {
      const fallbackText = collectText(await fallbackOf()).join(" ");
      const expected = collectText(
        DenominatorNote({ delivering: null, total: null }),
      ).join(" ");

      expect(fallbackText).toBe(expected);
      expect(fallbackText).toContain(NUMBERLESS);
      // No figure is shown before the summary is known (no fabricated N/M).
      expect(fallbackText).not.toContain("59");
      expect(fallbackText).not.toContain("96");
    });

    it("the fallback keeps the link to /kaynaklar/durum", async () => {
      expect(collectHrefs(await fallbackOf())).toContain("/kaynaklar/durum");
    });

    it("the fallback never calls the feed-status read (it is static, so it paints with the feed)", async () => {
      await fallbackOf();

      expect(getFeedStatusSummary).not.toHaveBeenCalled();
    });

    it("fallback and resolved note share one root <p> with one class: the late summary swaps words in place, it adds no line", async () => {
      const feed = await BlindspotsFeed();
      const resolved = (await renderSlot(feed, "BlindspotsDenominator")) as Elementish;
      const resolvedRoot = DenominatorNote(
        resolved.props as unknown as Parameters<typeof DenominatorNote>[0],
      ) as unknown as Elementish;
      const fallbackRoot = DenominatorNote(
        (await fallbackOf()).props as unknown as Parameters<typeof DenominatorNote>[0],
      ) as unknown as Elementish;

      expect(fallbackRoot.type).toBe("p");
      expect(resolvedRoot.type).toBe("p");
      expect(fallbackRoot.props?.className).toBe(resolvedRoot.props?.className);
      // The resolved note differs only by its figures.
      expect(collectText(resolved).join(" ")).toContain("59");
      expect(collectText(resolved).join(" ")).toContain("96");
    });
  });

  it("hunt-27: BlindspotsFeed neither calls nor awaits getFeedStatusSummary (an optional widget cannot hold the feed)", async () => {
    // A summary read that never settles must not delay the feed.
    getFeedStatusSummary.mockImplementation(() => new Promise(() => {}));

    const tree = await BlindspotsFeed();

    expect(getBlindspots).toHaveBeenCalledTimes(1);
    expect(getFeedStatusSummary).not.toHaveBeenCalled();
    expect(collectText(tree).join(" ")).toContain("belirgin bir kör nokta yok");
  });

  it("hunt-27: the denominator slot reads getFeedStatusSummary exactly once", async () => {
    const feed = await BlindspotsFeed();
    await renderSlot(feed, "BlindspotsDenominator");

    expect(getFeedStatusSummary).toHaveBeenCalledTimes(1);
  });

  it("degrades DenominatorNote to wording-without-numbers when the summary is unknown", async () => {
    getFeedStatusSummary.mockResolvedValueOnce(null);

    const tree = await renderSlot(await BlindspotsFeed(), "BlindspotsDenominator");
    const text = collectText(tree).join(" ");

    expect(text).toContain("yanlılık dağılımına sayılan");
  });
});

describe("/blindspots page source — the feed-status read stays out of BlindspotsFeed (hunt-27)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "page.tsx"), "utf8");

  /** Blanks // and block comments (offsets kept) so prose cannot trip a match. */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
        p1 + " ".repeat(m.length - p1.length),
      );
  }

  /** Text from the function's declaration up to its closing brace at column 0. */
  function functionSource(code: string, declaration: string): string {
    const start = code.indexOf(declaration);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = code.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    return code.slice(start, end + 2);
  }

  const code = stripComments(source);

  it("BlindspotsFeed awaits getBlindspotsSafe() only: no Promise.all, no getFeedStatusSummary", () => {
    const feed = functionSource(code, "export async function BlindspotsFeed");
    expect(feed).toContain("await getBlindspotsSafe()");
    expect(feed).not.toContain("getFeedStatusSummary");
    expect(feed).not.toContain("Promise.all");
  });

  it("BlindspotsDenominator is a module-private async component that awaits getFeedStatusSummary()", () => {
    expect(code).not.toMatch(/export\s+(?:async\s+)?function\s+BlindspotsDenominator\b/);
    const slot = functionSource(code, "async function BlindspotsDenominator");
    expect(slot).toContain("await getFeedStatusSummary()");
    expect(slot).toContain("<DenominatorNote");
  });

  it("the slot is rendered inside <Suspense fallback={<DenominatorNote delivering={null} total={null} />}> (h55-browser-1)", () => {
    expect(code).toMatch(
      /<Suspense\s+fallback=\{\s*<DenominatorNote\s+delivering=\{null\}\s+total=\{null\}\s*\/>\s*\}\s*>\s*<BlindspotsDenominator\s*\/>\s*<\/Suspense>/,
    );
    // The old null-fallback shape around the slot is gone.
    expect(code).not.toMatch(
      /<Suspense\s+fallback=\{null\}\s*>\s*<BlindspotsDenominator\b/,
    );
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

describe("/blindspots page — sentence-case title (h24-pages-3)", () => {
  it("the <title>, og:title and twitter:title all read 'Kör noktalar'", () => {
    expect(metadata.title).toBe("Kör noktalar");
    expect(metadata.openGraph?.title).toBe("Kör noktalar — Tayf");
    expect(metadata.twitter?.title).toBe("Kör noktalar — Tayf");
  });

  it("the H1 (PageHero title) agrees with the <title>", () => {
    const heroes = collectElements(BlindspotsPage()).filter((el) => el.type === PageHero);
    expect(heroes).toHaveLength(1);
    expect(heroes[0]?.props?.title).toBe("Kör noktalar");
  });
});

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
    getBlindspots.mockResolvedValueOnce(okResult([]));

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

  it("renders one band, with the digest the fetcher built, when the feed has a bundle updated 1 h ago", async () => {
    getBlindspots.mockResolvedValueOnce(okResult([mkBundle("c1", NOW - 3_600_000)]));

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
    getBlindspots.mockResolvedValueOnce(okResult([mkBundle("old", NOW - 5 * DAY)]));

    const tree = await BlindspotsFeed();

    const found = bands(tree);
    expect(found).toHaveLength(1);
    const digest = found[0]?.props?.digest as SilenceDigest;
    expect(digest.windowTotal).toBe(1);
    expect(digest.rows.map((r) => r.silentCount)).toEqual([0, 1, 1]);
  });

  it("counts every distinct bundle, fresh or stale", async () => {
    getBlindspots.mockResolvedValueOnce(
      okResult([
        mkBundle("fresh", NOW - 3_600_000),
        mkBundle("stale", NOW - 25 * 3_600_000),
        mkBundle("ancient", NOW - 40 * DAY),
      ]),
    );

    const tree = await BlindspotsFeed();

    const digest = bands(tree)[0]?.props?.digest as SilenceDigest;
    expect(digest.windowTotal).toBe(3);
  });

  // h53-consistency-1: the box counted the 30 cards (25 : 2 against a week of
  // 41 : 9). The page now hands the band the digest the fetcher counted over
  // ALL claims; it must not recount from the cards it happens to show.
  it("h53-consistency-1: hands the band the fetcher's whole-window digest, not a recount of the cards", async () => {
    const wholeWindow: SilenceDigest = {
      windowTotal: 46,
      rows: [
        { zone: "iktidar", silentCount: 9, byDominant: [{ zone: "muhalefet", count: 9 }] },
        { zone: "bagimsiz", silentCount: 0, byDominant: [] },
        { zone: "muhalefet", silentCount: 37, byDominant: [{ zone: "iktidar", count: 37 }] },
      ],
      scope: { windowDays: 7, shown: 1 },
    };
    getBlindspots.mockResolvedValueOnce(
      okResult([mkBundle("only-card", NOW - 3_600_000)], [], { digest: wholeWindow }),
    );

    const tree = await BlindspotsFeed();

    const found = bands(tree);
    expect(found).toHaveLength(1);
    expect(found[0]?.props?.digest).toBe(wholeWindow);
  });

  it("does not render the band when the feed failed ({ ok: false })", async () => {
    getBlindspots.mockResolvedValueOnce({ ok: false });

    const tree = await BlindspotsFeed();

    expect(bands(tree)).toHaveLength(0);
  });

  it("does not render the band on the ok-but-empty path", async () => {
    getBlindspots.mockResolvedValueOnce(okResult([]));

    const tree = await BlindspotsFeed();

    expect(bands(tree)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// "Kör noktaya yakın": a Suspense boundary NESTED as the last child of the
// feed (perf-4), so it can only reveal after the feed has laid out. It must
// not couple to the feed: the feed never awaits it, the silence digest never
// sees its items, and a failure only hides the section.
// ---------------------------------------------------------------------------
describe("/blindspots page — Kör noktaya yakın section", () => {
  const NEAR_ITEM = {
    id: "near-1",
    title: "Yakın haber",
    dominantZone: "iktidar",
    dominantShare: 0.7,
    votingTotal: 10,
    balance: null,
    updatedAt: "2026-10-21T10:00:00.000Z",
  };

  it("NearBlindspotsSection hands the fetched items to NearBlindspotList", async () => {
    getNearBlindspots.mockResolvedValueOnce([NEAR_ITEM]);

    const tree = (await NearBlindspotsSection()) as Elementish;

    expect(tree.type).toBe(NearBlindspotList);
    expect(tree.props?.items).toEqual([NEAR_ITEM]);
  });

  it("NearBlindspotsSection passes null through (the list hides itself)", async () => {
    getNearBlindspots.mockResolvedValueOnce(null);

    const tree = (await NearBlindspotsSection()) as Elementish;

    expect(tree.type).toBe(NearBlindspotList);
    expect(tree.props?.items).toBeNull();
  });

  it("the page has exactly one Suspense boundary, around BlindspotsFeed (perf-4: no sibling band boundary)", () => {
    const tree = BlindspotsPage();
    const all = collectElements(tree);
    const suspenses = all.filter((el) => el.type === Suspense);

    expect(suspenses).toHaveLength(1);
    const only = suspenses[0];
    expect((only?.props?.children as Elementish | undefined)?.type).toBe(
      BlindspotsFeed,
    );
    // The feed keeps its skeleton fallback.
    expect(only?.props?.fallback).not.toBeNull();
    // The band is no longer a sibling of the page: it lives inside the feed.
    expect(all.some((el) => el.type === NearBlindspotsSection)).toBe(false);
  });

  const BUNDLE_FIXTURE = {
    cluster: { id: "b1", updated_at: "2026-10-22T11:00:00.000Z" },
    articles: [],
    sources: [{ id: "b1-s", name: "Kaynak", bias: "pro_government" }],
    dominantZone: "iktidar",
    dominantPct: 1,
    votingZoneCounts: { iktidar: 1, bagimsiz: 0, muhalefet: 0 },
    isWireRedistribution: false,
    effectiveArticleCount: 1,
  };

  // perf-4: React reveals a nested boundary only after its parent has
  // revealed, so mounting the band as the LAST child of the feed (in every
  // state) means it streams in below already-laid-out content: no shift.
  it.each([
    ["ok with one bundle", okResult([BUNDLE_FIXTURE])],
    ["ok-empty", okResult([])],
    ["failed", { ok: false } as FeedResult],
  ] as const)(
    "BlindspotsFeed (%s) ends with a null-fallback Suspense around NearBlindspotsSection",
    async (_label, state) => {
      getBlindspots.mockResolvedValueOnce(state);

      const tree = (await BlindspotsFeed()) as Elementish;

      const near = collectElements(tree).filter(
        (el) =>
          el.type === Suspense &&
          (el.props?.children as Elementish | undefined)?.type ===
            NearBlindspotsSection,
      );
      expect(near).toHaveLength(1);
      expect(near[0]?.props?.fallback).toBeNull();

      const children = tree.props?.children as unknown[];
      expect(Array.isArray(children)).toBe(true);
      expect(children[children.length - 1]).toBe(near[0]);
    },
  );

  // perf-6: next/link would viewport-prefetch the DB-backed route handler as
  // an RSC request. A plain anchor never prefetches.
  it("the RSS link is a plain <a>, not a next/link", () => {
    const rss = collectElements(BlindspotsPage()).filter(
      (el) => el.props?.href === "/rss/kor-noktalar.xml",
    );

    expect(rss).toHaveLength(1);
    expect(rss[0]?.type).toBe("a");
    expect(rss[0]?.props?.type).toBe("application/rss+xml");
  });

  it("BlindspotsFeed never reads the near-blindspot fetcher", async () => {
    getBlindspots.mockResolvedValueOnce(okResult([BUNDLE_FIXTURE]));

    await BlindspotsFeed();
    await BlindspotsFeed(); // also on the empty path
    getBlindspots.mockResolvedValueOnce({ ok: false });
    await BlindspotsFeed(); // and the failed path

    expect(getNearBlindspots).not.toHaveBeenCalled();
  });

  it("the SilenceDigestBand digest counts only the main bundles, never the near items", async () => {
    getNearBlindspots.mockResolvedValue([NEAR_ITEM, { ...NEAR_ITEM, id: "near-2" }]);
    getBlindspots.mockResolvedValueOnce(
      okResult([
        {
          cluster: { id: "only", updated_at: "2026-10-22T11:00:00.000Z" },
          articles: [],
          sources: [{ id: "only-s", name: "Kaynak", bias: "pro_government" }],
          dominantZone: "iktidar",
          dominantPct: 1,
          votingZoneCounts: { iktidar: 1, bagimsiz: 0, muhalefet: 0 },
          isWireRedistribution: false,
          effectiveArticleCount: 1,
        },
      ]),
    );

    const tree = await BlindspotsFeed();

    const band = collectElements(tree).find((el) => el.type === SilenceDigestBand);
    expect((band?.props?.digest as SilenceDigest).windowTotal).toBe(1);
    expect(getNearBlindspots).not.toHaveBeenCalled();
  });

  it("a failed near-blindspot fetch leaves the main feed untouched", async () => {
    getNearBlindspots.mockResolvedValue(null);

    const feed = await BlindspotsFeed();
    const near = (await NearBlindspotsSection()) as Elementish;

    expect(collectText(feed).join(" ")).toContain("belirgin bir kör nokta yok");
    expect(near.props?.items).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Zone percent consistency (hunt-14 polish-1): the chip above a card and the
// card's own BiasSpectrum bar must print the SAME number. Math.round(11/13)
// gave "%85 İktidar" over a bar reading "İktidar: 11 kaynak (%84)"; the chip
// now takes zonePercents (largest remainder) from the voting tally, and the
// "Sadece X yazdı" claim is decided on the counts, not on a rounded 100.
// ---------------------------------------------------------------------------
describe("/blindspots page — chip agrees with the bar (zone percent consistency)", () => {
  function distOf(partial: Record<string, number>) {
    return {
      pro_government: 0,
      gov_leaning: 0,
      state_media: 0,
      center: 0,
      opposition_leaning: 0,
      opposition: 0,
      nationalist: 0,
      islamist_conservative: 0,
      pro_kurdish: 0,
      international: 0,
      ...partial,
    };
  }

  function cardBundle(
    counts: { iktidar: number; bagimsiz: number; muhalefet: number },
    distribution: Record<string, number>,
    sources: unknown[] = [],
    dominantZone: "iktidar" | "bagimsiz" | "muhalefet" = "iktidar",
  ) {
    const total = counts.iktidar + counts.bagimsiz + counts.muhalefet;
    return {
      cluster: {
        id: "zp1",
        title_tr: "Yüzde tutarlılığı",
        summary_tr: "",
        bias_distribution: distOf(distribution),
        is_blindspot: true,
        blindspot_side: "pro_government",
        article_count: total,
        first_published: "2026-10-22T09:00:00.000Z",
        updated_at: "2026-10-22T11:00:00.000Z",
      },
      articles: [],
      sources,
      dominantZone,
      // Deliberately the Math.round-prone share: the page must not read it.
      dominantPct: counts.iktidar / total,
      votingZoneCounts: counts,
      isWireRedistribution: false,
      effectiveArticleCount: total,
    };
  }

  /** Renders the BlindspotCard for one bundle: its chip, "tek tarafta" span and bar. */
  /** Text outside tags, by a single character scan (no regex tag stripping). */
  function visibleText(markup: string): string {
    let out = "";
    let inTag = false;
    for (const ch of markup) {
      if (ch === "<") inTag = true;
      else if (ch === ">") inTag = false;
      else if (!inTag) out += ch;
    }
    return out;
  }

  async function renderCard(bundle: ReturnType<typeof cardBundle>) {
    getBlindspots.mockResolvedValueOnce(okResult([bundle]));
    const tree = await BlindspotsFeed();
    const cards = collectElements(tree).filter(
      (el) => typeof el.type === "function" && el.props?.bundle === bundle,
    );
    expect(cards).toHaveLength(1);
    const card = cards[0] as { type: React.FunctionComponent; props: object };
    const html = renderToStaticMarkup(createElement(card.type, card.props));
    // Visible text only: attributes (the bar's title="...") live in `html`.
    return { html, text: visibleText(html) };
  }

  it("prints %84 on the chip for 11/1/1, matching the bar title, never %85", async () => {
    const { html, text } = await renderCard(
      cardBundle(
        { iktidar: 11, bagimsiz: 1, muhalefet: 1 },
        { pro_government: 11, center: 1, opposition: 1 },
      ),
    );

    expect(text).toContain("%84 İktidar");
    expect(html).toContain("İktidar: 11 kaynak (%84)");
    expect(html).not.toContain("%85");
    expect(text).not.toContain("Sadece");
    expect(text).not.toContain("tek tarafta");
  });

  it("says 'Sadece İktidar yazdı' and '%100 tek tarafta' when the other two zones have no sources", async () => {
    const { text } = await renderCard(
      cardBundle(
        { iktidar: 5, bagimsiz: 0, muhalefet: 0 },
        { pro_government: 5 },
      ),
    );

    expect(text).toContain("Sadece İktidar yazdı");
    expect(text).toContain("%100 tek tarafta");
  });

  it("does not claim 'only one side' at 250/1/0 although the share rounds to 100", async () => {
    const { text } = await renderCard(
      cardBundle(
        { iktidar: 250, bagimsiz: 1, muhalefet: 0 },
        { pro_government: 250, center: 1 },
      ),
    );

    expect(text).toContain("%100 İktidar");
    expect(text).not.toContain("Sadece");
    expect(text).not.toContain("tek tarafta");
  });

  // h43-blindspots-1: the flag rule is vote-only by design, so "Sadece İktidar
  // yazdı" prints over a story a non-voting (toplayıcı / niş) source from
  // another zone also wrote (cluster 5692a4a1: İşçi Haber, a niche Muhalefet
  // source). Only the wording changes: the chip says what the SPECTRUM shows
  // and the side note names the uncounted outsiders. The flag, the counts and
  // the percent are untouched.
  describe("qualified claim when a non-voting source from another zone also wrote it (h43-blindspots-1)", () => {
    const src = (id: string, bias: string, kind?: string | null) => ({
      id,
      name: id,
      bias,
      logo_url: null,
      ...(kind === undefined ? {} : { kind }),
    });

    // Shaped like cluster 5692a4a1-3c17-429e-87d1-8a5af5741ec6: ten voting
    // İktidar sources (nine outlets and the wire anadolu-ajansi) ...
    const voting10 = [
      src("aksam", "gov_leaning", "outlet"),
      src("cnn-turk", "gov_leaning", "outlet"),
      src("haber7", "gov_leaning", "outlet"),
      src("hurriyet", "gov_leaning", "outlet"),
      src("milat", "gov_leaning", "outlet"),
      src("milliyet", "gov_leaning", "outlet"),
      src("dirilis-postasi", "pro_government", "outlet"),
      src("trt-haber", "pro_government", "outlet"),
      src("yeni-safak", "pro_government", "outlet"),
      src("anadolu-ajansi", "pro_government", "wire"),
    ];
    const IKTIDAR_10 = { iktidar: 10, bagimsiz: 0, muhalefet: 0 };
    const IKTIDAR_10_DIST = { pro_government: 4, gov_leaning: 6 };
    // ... plus the three that do not vote.
    const hablerCom = src("haberler-com", "gov_leaning", "aggregator");
    const ajansHaber = src("ajans-haber", "center", "aggregator");
    const isciHaber = src("isci-haber", "opposition", "niche");

    it("reads 'Spektrumda sadece İktidar' and '%100 tek tarafta · +2 toplayıcı/niş kaynak (sayılmaz)' for the 5692a4a1 shape", async () => {
      const { text } = await renderCard(
        cardBundle(IKTIDAR_10, IKTIDAR_10_DIST, [...voting10, hablerCom, ajansHaber, isciHaber]),
      );

      expect(text).toContain("Spektrumda sadece İktidar");
      expect(text).toContain("%100 tek tarafta · +2 toplayıcı/niş kaynak (sayılmaz)");
      // The bare claim is gone: the story was not written by İktidar alone.
      expect(text).not.toContain("Sadece İktidar yazdı");
      expect(text).not.toContain("yazdı");
    });

    it("names one outsider as '+1 toplayıcı/niş kaynak (sayılmaz)'", async () => {
      const { text } = await renderCard(
        cardBundle(IKTIDAR_10, IKTIDAR_10_DIST, [...voting10, isciHaber]),
      );

      expect(text).toContain("Spektrumda sadece İktidar");
      expect(text).toContain("%100 tek tarafta · +1 toplayıcı/niş kaynak (sayılmaz)");
    });

    it("qualifies a Muhalefet-dominant card by the non-voting sources outside Muhalefet", async () => {
      const { text } = await renderCard(
        cardBundle(
          { iktidar: 0, bagimsiz: 0, muhalefet: 3 },
          { opposition: 2, opposition_leaning: 1 },
          [
            src("sozcu", "opposition_leaning", "outlet"),
            src("halk-tv", "opposition", "outlet"),
            src("birgun", "opposition", "outlet"),
            // d5a6d9ab-like: an İktidar aggregator and a Bağımsız aggregator.
            src("haberler-com", "gov_leaning", "aggregator"),
            src("son-dakika", "center", "aggregator"),
            // Inside the zone: never counted.
            src("niche-muhalefet", "opposition_leaning", "niche"),
          ],
          "muhalefet",
        ),
      );

      expect(text).toContain("Spektrumda sadece Muhalefet");
      expect(text).toContain("%100 tek tarafta · +2 toplayıcı/niş kaynak (sayılmaz)");
      expect(text).not.toContain("Sadece Muhalefet yazdı");
    });

    it("keeps the byte-identical 'Sadece İktidar yazdı' / '%100 tek tarafta' when there is no non-voting source at all", async () => {
      const { html, text } = await renderCard(
        cardBundle({ iktidar: 5, bagimsiz: 0, muhalefet: 0 }, { pro_government: 5 }),
      );

      expect(text).toContain("Sadece İktidar yazdı");
      expect(text).toContain("%100 tek tarafta");
      expect(text).not.toContain("Spektrumda");
      expect(text).not.toContain("toplayıcı");
      // Exact markup, not just text: the chip's text node and the whole side
      // note element are what they were before the qualifier existed.
      expect(html).toContain("Sadece İktidar yazdı</span>");
      expect(html).toContain(
        '<span class="text-[11px] text-muted-foreground"><span class="font-mono">%100</span> tek tarafta</span>',
      );
    });

    it("keeps the unqualified claim when the only non-voting sources sit inside the dominant zone", async () => {
      const { html, text } = await renderCard(
        cardBundle(IKTIDAR_10, IKTIDAR_10_DIST, [...voting10, hablerCom]),
      );

      expect(text).toContain("Sadece İktidar yazdı");
      expect(text).toContain("%100 tek tarafta");
      expect(text).not.toContain("Spektrumda");
      expect(text).not.toContain("toplayıcı");
      expect(html).toContain(
        '<span class="text-[11px] text-muted-foreground"><span class="font-mono">%100</span> tek tarafta</span>',
      );
    });

    it("treats a source with a null or missing kind as voting, so it never qualifies the claim", async () => {
      const { text } = await renderCard(
        cardBundle(IKTIDAR_10, IKTIDAR_10_DIST, [
          ...voting10,
          src("legacy-null", "opposition", null),
          src("legacy-missing", "center"),
        ]),
      );

      expect(text).toContain("Sadece İktidar yazdı");
      expect(text).not.toContain("Spektrumda");
      expect(text).not.toContain("toplayıcı");
    });

    it("leaves a card that does not claim 'only one side' alone, outsiders or not", async () => {
      const { text } = await renderCard(
        cardBundle(
          { iktidar: 11, bagimsiz: 1, muhalefet: 1 },
          { pro_government: 11, center: 1, opposition: 1 },
          [src("a", "pro_government", "outlet"), isciHaber, ajansHaber],
        ),
      );

      // Same chip as without sources: the largest-remainder %84, no qualifier.
      expect(text).toContain("%84 İktidar");
      expect(text).not.toContain("Spektrumda");
      expect(text).not.toContain("Sadece");
      expect(text).not.toContain("toplayıcı");
      expect(text).not.toContain("tek tarafta");
    });

    it("does not change the flag rule: 250/1/0 with an outsider is still not 'only one side'", async () => {
      const { text } = await renderCard(
        cardBundle(
          { iktidar: 250, bagimsiz: 1, muhalefet: 0 },
          { pro_government: 250, center: 1 },
          [isciHaber],
        ),
      );

      expect(text).toContain("%100 İktidar");
      expect(text).not.toContain("Spektrumda");
      expect(text).not.toContain("Sadece");
      expect(text).not.toContain("toplayıcı");
    });
  });
});

// ---------------------------------------------------------------------------
// h53-consistency-5: the subtitle, the meta description (and its og/twitter
// copies) said the other sides "ignored" the story and asked why they are
// "silent". The site's own rule (compose.ts, docs/owned-channels.md,
// /metodoloji, /kalite) is that absence can be a clustering split, so the copy
// describes coverage and never motive. tests/guards/blindspot-copy.test.ts
// keeps the motive words out of src; these pin the exact replacement text.
// ---------------------------------------------------------------------------
describe("/blindspots page — copy describes coverage, never motive (h53-consistency-5)", () => {
  const DESCRIPTION =
    "Bir tarafın haberi verdiği, diğer taraflardan az ya da hiç haber çıkmayan hikâyeler. Türk medyasındaki kör noktaları tek ekranda görün.";
  const SUBTITLE =
    "Bir tarafın haberi verdiği, diğer taraflardan az ya da hiç haber çıkmayan hikâyeler. Bu bir yok sayma iddiası değil: yalnızca spektruma sayılan kaynaklar sayılır.";

  it("the meta description is the coverage sentence", () => {
    expect(metadata.description).toBe(DESCRIPTION);
  });

  it("the og:description and twitter:description carry the same sentence", () => {
    expect(metadata.openGraph?.description).toBe(DESCRIPTION);
    expect(metadata.twitter?.description).toBe(DESCRIPTION);
  });

  it("the visible subtitle states the coverage and disclaims a claim of intent", () => {
    const heroes = collectElements(BlindspotsPage()).filter((el) => el.type === PageHero);
    expect(heroes).toHaveLength(1);
    expect(heroes[0]?.props?.subtitle).toBe(SUBTITLE);
  });

  it("no motive wording survives in the metadata or on the page shell", () => {
    const shell = JSON.stringify(metadata) + collectText(BlindspotsPage()).join(" ");
    const hero = collectElements(BlindspotsPage()).find((el) => el.type === PageHero);
    const everything = `${shell} ${String(hero?.props?.subtitle)}`;
    expect(everything).not.toMatch(/görmezden|susuyor|sustu|gizledi/i);
  });
});

// ---------------------------------------------------------------------------
// h53-consistency-1: every public claim of the trailing 7 days is reachable.
// 30 side-balanced cards, then the other claims as compact rows, and one count
// line over the whole window.
// ---------------------------------------------------------------------------
describe("/blindspots page — the whole window is listed (h53-consistency-1)", () => {
  const COUNTS = (iktidar: number, bagimsiz: number, muhalefet: number) => ({
    iktidar,
    bagimsiz,
    muhalefet,
  });

  function cardFixture(id: string, zone: MediaDnaZone = "iktidar") {
    return {
      cluster: {
        id,
        title_tr: `Kart ${id}`,
        summary_tr: "",
        bias_distribution: {},
        is_blindspot: true,
        blindspot_side: "pro_government",
        article_count: 5,
        first_published: "2026-11-01T09:00:00.000Z",
        updated_at: "2026-11-05T11:00:00.000Z",
      },
      articles: [],
      sources: [],
      dominantZone: zone,
      dominantPct: 1,
      votingZoneCounts: COUNTS(zone === "iktidar" ? 5 : 0, 0, zone === "muhalefet" ? 5 : 0),
      isWireRedistribution: false,
      effectiveArticleCount: 5,
    };
  }

  function moreFixture(
    id: string,
    zone: MediaDnaZone,
    counts: { iktidar: number; bagimsiz: number; muhalefet: number },
    sourceCount: number,
  ) {
    return {
      id,
      title: `Kompakt ${id}`,
      dominantZone: zone,
      dominantPct: counts[zone] / (counts.iktidar + counts.bagimsiz + counts.muhalefet),
      sourceCount,
      firstPublished: "2026-11-04T10:00:00.000Z",
      votingZoneCounts: counts,
    };
  }

  const MORE = [
    moreFixture("m-ik", "iktidar", COUNTS(11, 1, 1), 13),
    moreFixture("m-mu", "muhalefet", COUNTS(0, 1, 4), 5),
    // 8 voters among 10 members: the label names both numbers.
    moreFixture("m-agg", "iktidar", COUNTS(8, 0, 0), 10),
  ];

  function countLines(tree: unknown): string[] {
    return collectText(tree).filter((t) => t.startsWith("Son 7 günde "));
  }

  it("renders the count line over the whole window: 'Son 7 günde N kör nokta · İktidar tarafında a · Muhalefet tarafında b'", async () => {
    getBlindspots.mockResolvedValueOnce(
      okResult([cardFixture("c1"), cardFixture("c2", "muhalefet")], MORE, {
        claimCount: 46,
        sideCounts: COUNTS(37, 0, 9),
      }),
    );

    const tree = await BlindspotsFeed();

    expect(countLines(tree)).toEqual([
      "Son 7 günde 46 kör nokta · İktidar tarafında 37 · Muhalefet tarafında 9",
    ]);
  });

  it("adds Bağımsız to the count line only when it is above zero", async () => {
    getBlindspots.mockResolvedValueOnce(
      okResult([cardFixture("c1")], [], {
        claimCount: 12,
        sideCounts: COUNTS(7, 2, 3),
      }),
    );

    const tree = await BlindspotsFeed();

    expect(countLines(tree)).toEqual([
      "Son 7 günde 12 kör nokta · İktidar tarafında 7 · Muhalefet tarafında 3 · Bağımsız tarafında 2",
    ]);
  });

  it("renders no count line on the empty and failed paths", async () => {
    getBlindspots.mockResolvedValueOnce(okResult([]));
    expect(countLines(await BlindspotsFeed())).toEqual([]);

    getBlindspots.mockResolvedValueOnce({ ok: false });
    expect(countLines(await BlindspotsFeed())).toEqual([]);
  });

  function moreLists(tree: unknown): Elementish[] {
    return collectElements(tree).filter(
      (el) =>
        typeof el.type === "function" &&
        (el.type as { name?: string }).name === "MoreBlindspotList",
    );
  }

  function renderMore(tree: unknown): string {
    const lists = moreLists(tree);
    expect(lists).toHaveLength(1);
    const list = lists[0] as { type: React.FunctionComponent; props: object };
    return renderToStaticMarkup(createElement(list.type, list.props));
  }

  it("renders a 'Diğer kör noktalar' list holding every `more` row: title link, '%P Taraf', 'N kaynak', no images", async () => {
    getBlindspots.mockResolvedValueOnce(okResult([cardFixture("c1")], MORE));

    const html = renderMore(await BlindspotsFeed());

    expect(html).toContain("Diğer kör noktalar");
    for (const row of MORE) {
      expect(html).toContain(`href="/cluster/${row.id}"`);
      expect(html).toContain(row.title);
    }
    expect(html.match(/<li[ >]/g)).toHaveLength(MORE.length);
    // %P comes from the voting tally, largest remainder: 11/1/1 is 84, never 85.
    expect(html).toContain("%84 İktidar");
    expect(html).not.toContain("%85");
    expect(html).toContain("%80 Muhalefet");
    expect(html).toContain("%100 İktidar");
    // N kaynak: bare when every member votes, both numbers when it differs.
    expect(html).toContain("13 kaynak");
    expect(html).toContain("5 kaynak");
    expect(html).toContain("10 kaynak · 8 sayıldı");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<picture");
  });

  it("keeps the compact rows in the order the fetcher gave", async () => {
    getBlindspots.mockResolvedValueOnce(okResult([cardFixture("c1")], MORE));

    const html = renderMore(await BlindspotsFeed());

    const at = (id: string) => html.indexOf(`/cluster/${id}"`);
    expect(at("m-ik")).toBeGreaterThan(-1);
    expect(at("m-ik")).toBeLessThan(at("m-mu"));
    expect(at("m-mu")).toBeLessThan(at("m-agg"));
  });

  it("does not prefetch a hundred DB-backed cluster pages from the compact list", async () => {
    getBlindspots.mockResolvedValueOnce(okResult([cardFixture("c1")], MORE));

    const tree = await BlindspotsFeed();
    const list = moreLists(tree)[0] as { type: (p: unknown) => unknown; props: unknown };
    const links = collectElements(list.type(list.props)).filter(
      (el) => typeof el.props?.href === "string" && String(el.props.href).startsWith("/cluster/"),
    );

    expect(links).toHaveLength(MORE.length);
    for (const link of links) expect(link.props?.prefetch).toBe(false);
  });

  it("renders no compact list when every claim has a card", async () => {
    getBlindspots.mockResolvedValueOnce(okResult([cardFixture("c1")], []));

    const tree = await BlindspotsFeed();

    expect(moreLists(tree)).toHaveLength(0);
    expect(collectText(tree).join(" ")).not.toContain("Diğer kör noktalar");
  });

  it("no claim of the fixture is missing from the page: every card id and every compact id is rendered", async () => {
    const cards = Array.from({ length: 30 }, (_, i) => cardFixture(`card-${i}`));
    const rows = Array.from({ length: 16 }, (_, i) =>
      moreFixture(`row-${i}`, "iktidar", COUNTS(7, 0, 0), 7),
    );
    getBlindspots.mockResolvedValueOnce(okResult(cards, rows));

    const tree = await BlindspotsFeed();

    const cardIds = collectElements(tree)
      .filter((el) => typeof el.props?.bundle === "object")
      .map((el) => (el.props?.bundle as { cluster: { id: string } }).cluster.id);
    const compactHtml = renderMore(tree);
    const rowIds = rows.filter((r) => compactHtml.includes(`/cluster/${r.id}"`)).map((r) => r.id);

    expect([...cardIds, ...rowIds].sort()).toEqual(
      [...cards.map((c) => c.cluster.id), ...rows.map((r) => r.id)].sort(),
    );
  });

  it("puts the count line and the band above the cards, and the compact list after them", async () => {
    getBlindspots.mockResolvedValueOnce(okResult([cardFixture("c1")], MORE));

    const tree = (await BlindspotsFeed()) as Elementish;
    const children = (tree.props?.children as unknown[]).flat(2) as Elementish[];
    const nameOf = (el: Elementish | undefined) =>
      typeof el?.type === "function" ? (el.type as { name?: string }).name : el?.type;

    const flat = collectElements(tree);
    const idxOf = (pred: (el: Elementish) => boolean) => flat.findIndex(pred);
    const countAt = idxOf(
      (el) => typeof el.props?.children === "string" && el.props.children.startsWith("Son 7 günde "),
    );
    const bandAt = idxOf((el) => el.type === SilenceDigestBand);
    const cardAt = idxOf((el) => nameOf(el) === "BlindspotCard");
    const moreAt = idxOf((el) => nameOf(el) === "MoreBlindspotList");
    expect(children.length).toBeGreaterThan(0);
    expect(countAt).toBeGreaterThanOrEqual(0);
    expect(countAt).toBeLessThan(bandAt);
    expect(bandAt).toBeLessThan(cardAt);
    expect(cardAt).toBeLessThan(moreAt);
  });
});
