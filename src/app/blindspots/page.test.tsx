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

const getNearBlindspots = vi.fn(
  async (): Promise<unknown[] | null> => [],
);
vi.mock("@/lib/clusters/near-blindspots-query", () => ({
  getNearBlindspotsSafe: () => getNearBlindspots(),
}));

import BlindspotsPage, { BlindspotsFeed, NearBlindspotsSection } from "./page";
import { createElement, Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DenominatorNote } from "@/components/source/denominator-note";
import { NearBlindspotList } from "@/components/blindspots/near-blindspot-section";
import { SilenceDigestBand } from "@/components/blindspots/silence-digest-band";
import type { SilenceDigest } from "@/lib/clusters/silence-digest";

const ORIGINAL_ENV = { ...process.env };

// Order independence (vitest --sequence.shuffle): mockClear() only drops call
// records, so an implementation swapped in by one test (PERF-01) or a
// mockResolvedValueOnce it never consumed leaked into whichever test ran next.
// All three fetcher mocks are therefore mockReset() and given their default
// implementation again before every test, and fake Date timers never outlive a
// test (the digest-band describe installs them in its own beforeEach).
beforeEach(() => {
  delete process.env.RESEND_API_KEY; // isMailConfigured() -> false, no NewsletterForm
  getBlindspots.mockReset();
  getBlindspots.mockImplementation(async () => ({ ok: true, bundles: [] }));
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
    ["ok with one bundle", { ok: true, bundles: [BUNDLE_FIXTURE] }],
    ["ok-empty", { ok: true, bundles: [] }],
    ["failed", { ok: false }],
  ] as const)(
    "BlindspotsFeed (%s) ends with a null-fallback Suspense around NearBlindspotsSection",
    async (_label, state) => {
      getBlindspots.mockResolvedValueOnce(
        state as { ok: true; bundles: unknown[] } | { ok: false },
      );

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
    getBlindspots.mockResolvedValueOnce({
      ok: true,
      bundles: [
        {
          cluster: { id: "b1", updated_at: "2026-10-22T11:00:00.000Z" },
          articles: [],
          sources: [{ id: "b1-s", name: "Kaynak", bias: "pro_government" }],
          dominantZone: "iktidar",
          dominantPct: 1,
          votingZoneCounts: { iktidar: 1, bagimsiz: 0, muhalefet: 0 },
          isWireRedistribution: false,
          effectiveArticleCount: 1,
        },
      ],
    });

    await BlindspotsFeed();
    await BlindspotsFeed(); // also on the empty path
    getBlindspots.mockResolvedValueOnce({ ok: false });
    await BlindspotsFeed(); // and the failed path

    expect(getNearBlindspots).not.toHaveBeenCalled();
  });

  it("the SilenceDigestBand digest counts only the main bundles, never the near items", async () => {
    getNearBlindspots.mockResolvedValue([NEAR_ITEM, { ...NEAR_ITEM, id: "near-2" }]);
    getBlindspots.mockResolvedValueOnce({
      ok: true,
      bundles: [
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
      ],
    });

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
      sources: [],
      dominantZone: "iktidar",
      // Deliberately the Math.round-prone share: the page must not read it.
      dominantPct: counts.iktidar / total,
      votingZoneCounts: counts,
      isWireRedistribution: false,
      effectiveArticleCount: total,
    };
  }

  /** Renders the BlindspotCard for one bundle: its chip, "tek tarafta" span and bar. */
  async function renderCard(bundle: ReturnType<typeof cardBundle>) {
    getBlindspots.mockResolvedValueOnce({ ok: true, bundles: [bundle] });
    const tree = await BlindspotsFeed();
    const cards = collectElements(tree).filter(
      (el) => typeof el.type === "function" && el.props?.bundle === bundle,
    );
    expect(cards).toHaveLength(1);
    const card = cards[0] as { type: React.FunctionComponent; props: object };
    const html = renderToStaticMarkup(createElement(card.type, card.props));
    // Visible text only: attributes (the bar's title="...") live in `html`.
    return { html, text: html.replace(/<[^>]*>/g, "") };
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
});
