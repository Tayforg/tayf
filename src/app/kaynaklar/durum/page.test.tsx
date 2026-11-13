import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Suspense, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// A-M4: no test file existed for /kaynaklar/durum before. Covers the
// rows / null / empty-array branches of the async child (DurumBody), plus the
// KaynakDurumBody / ItemsPerDayCell named exports (page.tsx exports them
// specifically so this file doesn't need a full React renderer capable of
// resolving async Server Components).
//
// h177-perfsweep-1: the default export is a plain (sync) function that returns
// the static shell (hero, the /durum pointer) with the one dynamic child behind
// <Suspense fallback={<DurumBodySkeleton />}>. The shell and the async child
// (DurumBody: connection(), the reads, the unavailable state, the table) are
// rendered separately below; tests/guards/static-hero-shell.test.ts pins the
// split in the source.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));
vi.mock("next/server", () => ({
  connection: vi.fn(async () => undefined),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSlowReaderClient: () => ({
    from: (_table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gte: () => builder,
        lte: () => builder,
        order: () => builder,
        limit: () => builder,
        then: (
          onFul?: (v: { data: unknown; error: unknown }) => unknown,
          onRej?: (e: unknown) => unknown,
        ) =>
          Promise.resolve({ data: fixture.data, error: fixture.error }).then(
            onFul,
            onRej,
          ),
      };
      return builder;
    },
  }),
}));

import { connection } from "next/server";

import KaynakDurumPage, {
  DurumBody,
  DurumBodySkeleton,
  KaynakDurumBody,
  ItemsPerDayCell,
  metadata,
} from "./page";
import { PageHero } from "@/components/ui/page-hero";
import { SOURCE_KIND_META } from "@/lib/sources/kind";
import { SILENCE_REASON_LABEL } from "@/lib/sources/silence-reason";
import { ZONE_META } from "@/lib/bias/config";
import {
  summariseFeedStatus,
  toFeedStatusRows,
  type SourceFeedStatusRawRow,
} from "@/lib/sources/feed-status";

/**
 * Collects every string/number leaf under a React element tree. Expands
 * `<KaynakDurumBody>` (a one-level-deep, synchronous function component)
 * so its table content is reachable without a full React renderer.
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
    if (el.type === KaynakDurumBody && el.props) {
      const props = el.props as unknown as Parameters<typeof KaynakDurumBody>[0];
      collectText(KaynakDurumBody(props), out);
      return out;
    }
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

/** Every element under `node`, depth first, expanding no components (the shell/skeleton tests below). */
type TreeEl = { type?: unknown; props?: Record<string, unknown> };
function walkTree(node: unknown, out: TreeEl[] = []): TreeEl[] {
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as TreeEl;
    out.push(el);
    if (el.props?.children !== undefined) walkTree(el.props.children, out);
  }
  return out;
}

const NOW = Date.parse("2026-09-18T12:00:00.000Z");

// h126-a11y-2: the cell that names a row is a <th scope="row">, so a row's cells
// are td AND th, and the column headers are the th with scope="col".
type CellEl = { type?: unknown; props?: Record<string, unknown> };
const isCell = (e: CellEl): boolean => e.type === "td" || e.type === "th";
const isColHead = (e: CellEl): boolean => e.type === "th" && e.props?.scope === "col";

function rawRow(overrides: Partial<SourceFeedStatusRawRow> = {}): SourceFeedStatusRawRow {
  return {
    slug: "ornek-kaynak",
    name: "Örnek Kaynak",
    bias: "center",
    kind: "outlet",
    fetch_last_status: 200,
    fetch_last_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    latest: [{ published_at: new Date(NOW - 60 * 60 * 1000).toISOString() }],
    ...overrides,
  };
}

describe("DurumBody (async child of the page)", () => {
  beforeEach(() => {
    vi.mocked(connection).mockClear();
  });

  it("renders the honest 'durum bilinmiyor' state when the query errors (never fabricates a table)", async () => {
    fixture.data = [];
    fixture.error = { message: "canceling statement due to statement timeout" };

    const tree = await DurumBody();
    const text = collectText(tree).join(" ");

    expect(text).toContain("Kaynak durumu şu anda bilinmiyor");
    expect(text).toContain("veri geçici olarak ulaşılamıyor");
    expect(text).not.toContain("Şu anda listelenecek aktif kaynak yok");
  });

  it("renders the table shell for a successful, non-empty response", async () => {
    fixture.data = [rawRow()];
    fixture.error = null;

    const tree = await DurumBody();
    const text = collectText(tree).join(" ");

    expect(text).toContain("Örnek Kaynak");
    expect(text).not.toContain("Kaynak durumu şu anda bilinmiyor");
  });

  it("renders the empty-list state (not the unavailable one) when the read worked and no source is active", async () => {
    fixture.data = [];
    fixture.error = null;

    const text = collectText(await DurumBody()).join(" ");

    expect(text).toContain("Şu anda listelenecek aktif kaynak yok");
    expect(text).not.toContain("Kaynak durumu şu anda bilinmiyor");
  });

  it("hands KaynakDurumBody the shaped rows and the still-pending items-per-day promise, as before", async () => {
    fixture.data = [rawRow()];
    fixture.error = null;

    const tree = (await DurumBody()) as { type?: unknown; props?: Record<string, unknown> };

    expect(tree.type).toBe(KaynakDurumBody);
    const rows = tree.props?.rows as Array<{ slug: string; name: string }>;
    expect(rows.map((r) => r.slug)).toEqual(["ornek-kaynak"]);
    // Not awaited by the page (PERF-01): a thenable that the nested Suspense cells consume.
    expect(typeof (tree.props?.itemsPerDayPromise as { then?: unknown }).then).toBe("function");
  });

  it("calls connection() so the reads run at request time, and never from the shell", async () => {
    fixture.data = [rawRow()];
    fixture.error = null;

    KaynakDurumPage();
    expect(connection).not.toHaveBeenCalled();

    await DurumBody();
    expect(connection).toHaveBeenCalledTimes(1);
  });

  it("does not swallow a failed read: a rejected rows read rejects the child (error.tsx renders as before)", async () => {
    // getSourceFeedStatuses itself never throws (null = unknown); a throw from deeper (here the
    // client factory) must still surface, not be caught by the page.
    fixture.data = [rawRow()];
    fixture.error = null;
    const feedStatus = await import("@/lib/sources/feed-status");
    const spy = vi
      .spyOn(feedStatus, "getSourceFeedStatuses")
      .mockRejectedValueOnce(new Error("boom"));
    try {
      await expect(DurumBody()).rejects.toThrow("boom");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("KaynakDurumPage (static shell, h177-perfsweep-1)", () => {
  it("is a plain function: calling it returns the element tree synchronously, not a promise", () => {
    const tree = KaynakDurumPage();
    expect(tree).not.toBeInstanceOf(Promise);
    expect(typeof (tree as unknown as { then?: unknown }).then).toBe("undefined");
  });

  it("holds the hero text and the /durum pointer without any data read", () => {
    fixture.data = [];
    fixture.error = { message: "must not be read by the shell" };

    const tree = KaynakDurumPage();
    const text = collectText(tree).join(" ");

    // PageHero takes its copy as props, so read them off the element.
    const hero = walkTree(tree).find((e) => e.type === PageHero);
    expect(hero, "PageHero").toBeDefined();
    expect(hero?.props?.kicker).toBe("Kapsam düzeltmesi");
    expect(hero?.props?.title).toBe("Kaynak durumu");
    expect(String(hero?.props?.subtitle)).toContain(
      "yalnızca son 72 saatte en az bir haber veren kaynaklar üzerinden hesaplanır",
    );
    expect(text).toContain("Haber akışının genel durumu için");
    expect(text).toContain("sayfasına bakın.");
    // Neither table copy nor the unavailable state: those arrive with the child.
    expect(text).not.toContain("Kaynak durumu şu anda bilinmiyor");
    expect(text).not.toContain("Aktif kaynakların besleme durumu");
  });

  it("puts the one dynamic child behind a Suspense whose fallback is the skeleton", () => {
    const tree = KaynakDurumPage() as { props?: { children?: unknown } };
    const children = (Array.isArray(tree.props?.children) ? tree.props?.children : []) as Array<{
      type?: unknown;
      props?: { fallback?: { type?: unknown }; children?: { type?: unknown } };
    }>;
    const suspenses = children.filter((c) => c.type === Suspense);

    expect(suspenses).toHaveLength(1);
    expect(suspenses[0]?.props?.fallback?.type).toBe(DurumBodySkeleton);
    expect(suspenses[0]?.props?.children?.type).toBe(DurumBody);
    // the hero and the pointer come before it, in the shell
    const heroAt = children.findIndex((c) => c.type === PageHero);
    expect(heroAt).toBe(0);
    expect(children.indexOf(suspenses[0] as (typeof children)[number])).toBeGreaterThan(heroAt);
  });
});

describe("DurumBodySkeleton (same-footprint fallback)", () => {
  /** Plain-text content of rendered markup: a linear tag scan, no regex over HTML. */
  function textOfMarkup(markup: string): string {
    let inTag = false;
    let out = "";
    for (const ch of markup) {
      if (ch === "<") inTag = true;
      else if (ch === ">") inTag = false;
      else if (!inTag) out += ch;
    }
    return out;
  }

  type El = TreeEl;
  const walk = walkTree;
  const classOf = (el: El): string => String(el.props?.className ?? "");

  it("renders no text at all (no copy is duplicated while the body streams) and is hidden from assistive tech", () => {
    const markup = renderToStaticMarkup(<DurumBodySkeleton />);
    expect(textOfMarkup(markup).trim()).toBe("");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("<h1");
    expect(markup).not.toContain("<h2");
    expect(markup).not.toContain("<table");
  });

  it("reserves the zone cards, the totals line and the table card with the seven header cells", () => {
    const els = walk(DurumBodySkeleton());
    // three zone cards in the same grid as the loaded ones
    const grid = els.find((e) => classOf(e) === "grid grid-cols-1 sm:grid-cols-3 gap-3");
    expect(grid, "zone grid").toBeDefined();
    expect(walk(grid?.props?.children).filter((e) => classOf(e).includes("rounded-xl"))).toHaveLength(3);
    // the table card has the loaded card's chrome, a header row of 7 cells and a floor height
    const card = els.find((e) => classOf(e).startsWith("rounded-xl ring-1 ring-border/60 bg-card p-4 sm:p-6"));
    expect(card, "table card").toBeDefined();
    expect(classOf(card as El)).toContain("min-h-[");
    const headerRow = walk(card?.props?.children).find((e) => classOf(e).includes("border-b border-border/60"));
    expect(headerRow, "header row").toBeDefined();
    expect(walk(headerRow?.props?.children).filter((e) => e.type === "div")).toHaveLength(7);
  });

  it("clips the header row, so seven placeholder cells cannot widen the page on a phone (576 px at 360 px, measured)", () => {
    const headerRow = walk(DurumBodySkeleton()).find((e) => classOf(e).includes("border-b border-border/60"));
    expect(headerRow, "header row").toBeDefined();
    expect(classOf(headerRow as El).split(" ")).toContain("overflow-hidden");
  });
});

describe("KaynakDurumPage metadata (h24-pages-3)", () => {
  it("the <title>, og:title and twitter:title read 'Kaynak durumu' (sentence case)", () => {
    expect(metadata.title).toBe("Kaynak durumu");
    expect(metadata.openGraph?.title).toBe("Kaynak durumu — Tayf");
    expect(metadata.twitter?.title).toBe("Kaynak durumu — Tayf");
  });

  it("the H1 (PageHero title) agrees with the <title>", () => {
    // The hero is in the static shell now: no data and no await needed to reach it.
    const tree = KaynakDurumPage();

    function heroTitles(node: unknown, out: unknown[] = []): unknown[] {
      if (Array.isArray(node)) {
        for (const child of node) heroTitles(child, out);
        return out;
      }
      if (node && typeof node === "object") {
        const el = node as { type?: unknown; props?: Record<string, unknown> };
        if (el.type === PageHero) out.push(el.props?.title);
        if (el.props?.children !== undefined) heroTitles(el.props.children, out);
      }
      return out;
    }

    expect(heroTitles(tree)).toEqual(["Kaynak durumu"]);
  });
});

describe("KaynakDurumBody", () => {
  function shapedRows(raw: SourceFeedStatusRawRow[]) {
    return toFeedStatusRows(raw, NOW);
  }

  it("A-07: uses suffix-free grammatical Turkish for every number, not the hardcoded 'i possessive", async () => {
    const rows = shapedRows([
      rawRow({ slug: "a", bias: "pro_government" }),
      rawRow({ slug: "b", bias: "center" }),
    ]);
    const tree = KaynakDurumBody({
      rows,
      itemsPerDayPromise: Promise.resolve({}),
    });
    const text = collectText(tree).join(" ");

    expect(text).toContain("tanesi");
    expect(text).not.toMatch(/\d+'[iıuü]\b/);
  });

  it("A-H1: surfaces a `kind` column so a reader can see which rows count toward the shares", async () => {
    const rows = shapedRows([rawRow({ kind: "aggregator" })]);
    const tree = KaynakDurumBody({
      rows,
      itemsPerDayPromise: Promise.resolve({}),
    });
    const text = collectText(tree).join(" ");

    expect(text).toContain("Toplayıcı");
  });

  it("A-M3: the scroll container is a focusable, labelled region", () => {
    const rows = shapedRows([rawRow()]);
    const tree = KaynakDurumBody({
      rows,
      itemsPerDayPromise: Promise.resolve({}),
    });

    function findRegion(node: unknown): { props: Record<string, unknown> } | null {
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = findRegion(child);
          if (found) return found;
        }
        return null;
      }
      if (node && typeof node === "object") {
        const el = node as { props?: Record<string, unknown> };
        if (el.props?.role === "region") return el as { props: Record<string, unknown> };
        if (el.props?.children !== undefined) return findRegion(el.props.children);
      }
      return null;
    }

    const region = findRegion(tree);
    expect(region).not.toBeNull();
    expect(region!.props.tabIndex).toBe(0);
    expect(region!.props["aria-labelledby"]).toBe("durum-tablo");
  });

  it("the focusable scroll region shows a keyboard focus ring", () => {
    const rows = shapedRows([rawRow()]);
    const tree = KaynakDurumBody({
      rows,
      itemsPerDayPromise: Promise.resolve({}),
    });

    function regionClass(node: unknown): string | null {
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = regionClass(child);
          if (found !== null) return found;
        }
        return null;
      }
      if (node && typeof node === "object") {
        const el = node as { props?: Record<string, unknown> };
        if (el.props?.role === "region") return String(el.props.className ?? "");
        if (el.props?.children !== undefined) return regionClass(el.props.children);
      }
      return null;
    }

    const className = regionClass(tree);
    expect(className).not.toBeNull();
    const classes = (className ?? "").split(" ");
    expect(classes).toContain("focus-visible:outline-none");
    expect(classes).toContain("focus-visible:ring-2");
    expect(classes).toContain("focus-visible:ring-ring");
  });

  it("A-M1: renders an explicit empty state instead of a headers-only table when rows is []", () => {
    const tree = KaynakDurumBody({
      rows: [],
      itemsPerDayPromise: Promise.resolve({}),
    });
    const text = collectText(tree).join(" ");

    expect(text).toContain("Şu anda listelenecek aktif kaynak yok");
    expect(text).not.toContain("Son HTTP durumu");
  });
});

describe("KaynakDurumBody quarantine [migration 074]", () => {
  function shapedRows(raw: SourceFeedStatusRawRow[]) {
    return toFeedStatusRows(raw, NOW);
  }

  it("renders the 'karantinada' badge and its title for a quarantined row", () => {
    const rows = shapedRows([
      rawRow({
        fetch_fail_streak: 21,
        fetch_quarantined_until: new Date(NOW + 6 * 60 * 60 * 1000).toISOString(),
      }),
    ]);
    const tree = KaynakDurumBody({
      rows,
      itemsPerDayPromise: Promise.resolve({}),
    });
    const text = collectText(tree).join(" ");
    expect(text).toContain("karantinada");
  });

  it("adds the karantinada summary sentence when >=1 row is quarantined", () => {
    const rows = shapedRows([
      rawRow({
        fetch_fail_streak: 20,
        fetch_quarantined_until: new Date(NOW + 60 * 60 * 1000).toISOString(),
      }),
    ]);
    const tree = KaynakDurumBody({
      rows,
      itemsPerDayPromise: Promise.resolve({}),
    });
    const text = collectText(tree).join(" ");
    expect(text).toContain("besleme karantinada");
    expect(text).toContain("1 saat, 6 saat, sonra günde bir yeniden denenir");
  });

  it("does not render the badge or the summary sentence when nothing is quarantined", () => {
    const rows = shapedRows([rawRow()]);
    const tree = KaynakDurumBody({
      rows,
      itemsPerDayPromise: Promise.resolve({}),
    });
    const text = collectText(tree).join(" ");
    expect(text).not.toContain("karantinada");
  });
});

describe("KaynakDurumBody silence reasons [migration 119]", () => {
  const HOUR = 60 * 60 * 1000;
  const stale = [{ published_at: new Date(NOW - 96 * HOUR).toISOString() }];
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  function shapedRows(raw: SourceFeedStatusRawRow[]) {
    return toFeedStatusRows(raw, NOW);
  }

  function body(raw: SourceFeedStatusRawRow[]) {
    return KaynakDurumBody({
      rows: shapedRows(raw),
      itemsPerDayPromise: Promise.resolve({}),
    });
  }

  type El = { type?: unknown; key?: unknown; props?: Record<string, unknown> };

  /** Every element under the tree (depth first), expanding no components. */
  function elements(node: unknown, out: El[] = []): El[] {
    if (Array.isArray(node)) {
      for (const child of node) elements(child, out);
      return out;
    }
    if (node && typeof node === "object") {
      const el = node as El;
      out.push(el);
      const children = el.props?.children;
      if (children !== undefined) elements(children, out);
    }
    return out;
  }

  const textOf = (node: unknown) => collectText(node).join("");

  function rowOf(tree: unknown, slug: string): El {
    const tr = elements(tree).find((e) => e.type === "tr" && e.key === slug);
    if (!tr) throw new Error(`no <tr> for ${slug}`);
    return tr;
  }

  function badgeOf(tree: unknown, slug: string, label: string): El {
    // the wrapper span has the same text; the badge is the innermost match
    const badge = elements(rowOf(tree, slug))
      .filter((e) => e.type === "span" && textOf(e) === label)
      .pop();
    if (!badge) throw new Error(`no "${label}" badge in ${slug}`);
    return badge;
  }

  const fixtures = (): SourceFeedStatusRawRow[] => [
    rawRow({
      slug: "donmus",
      name: "Donmuş Haber",
      latest: stale,
      fetch_items_count: 5,
      fetch_newest_item_at: iso(80 * HOUR),
    }),
    rawRow({ slug: "engelli", name: "Engelli Haber", latest: stale, fetch_last_status: 403 }),
    rawRow({
      slug: "sakin",
      name: "Sakin Haber",
      latest: stale,
      fetch_items_count: 5,
      fetch_newest_item_at: iso(HOUR),
    }),
    rawRow({ slug: "aktif", name: "Aktif Haber" }),
  ];

  it("each silent row shows the label of its reason", () => {
    const tree = body(fixtures());
    expect(textOf(rowOf(tree, "donmus"))).toContain("akış donmuş");
    expect(textOf(rowOf(tree, "engelli"))).toContain("erişim yok");
    expect(textOf(rowOf(tree, "sakin"))).toContain("sessiz");
    // and only its own
    expect(textOf(rowOf(tree, "donmus"))).not.toMatch(/erişim yok|sessiz/);
    expect(textOf(rowOf(tree, "engelli"))).not.toMatch(/akış donmuş|sessiz/);
    expect(textOf(rowOf(tree, "sakin"))).not.toMatch(/akış donmuş|erişim yok/);
  });

  it("a row whose fetch_last_status is 0 shows a dash in the HTTP cell and the erişim yok label", () => {
    // 0 means "no HTTP answer" (DNS failure, timeout), not an HTTP status: a
    // bare "0" in the "Son HTTP durumu" column read as a status code.
    const tree = body([
      rawRow({
        slug: "cevapsiz",
        name: "Cevapsız Haber",
        latest: stale,
        fetch_last_status: 0,
      }),
    ]);
    const cells = elements(rowOf(tree, "cevapsiz")).filter(isCell);
    const cellTexts = cells.map((cell) => textOf(cell));

    // columns: Kaynak, Sessiz, Tür, Bölge, Son haber, Son HTTP durumu, 7 gün
    expect(cellTexts[1]).toContain(SILENCE_REASON_LABEL.erisim_yok);
    expect(cellTexts[1]).toContain("erişim yok");
    expect(cellTexts[5]).toBe("—");
    expect(cellTexts[5]).not.toContain("0");
  });

  it("a row with a real error status still shows its digits in the HTTP cell", () => {
    const tree = body([
      rawRow({ slug: "engelli", name: "Engelli Haber", latest: stale, fetch_last_status: 403 }),
    ]);
    const cells = elements(rowOf(tree, "engelli")).filter(isCell);
    expect(textOf(cells[5])).toBe("403");
  });

  describe("a success code with a fail streak (h49-ops-1)", () => {
    // t24, turkiye-today, voa-turkce, yenisoz and rudaw-turkce answer 200 with
    // an HTML page: ingest stores the 200, counts a failure and quarantines. A
    // bare "200" under "Son HTTP durumu" next to "erişim yok · karantinada" was
    // contradictory on the public page.
    const quarantinedUntil = new Date(NOW + 20 * HOUR).toISOString();

    it("a quarantined 200 with streak 60 reads '200 · geçersiz akış' in the HTTP cell", () => {
      const tree = body([
        rawRow({
          slug: "t24",
          name: "T24",
          latest: stale,
          fetch_last_status: 200,
          fetch_fail_streak: 60,
          fetch_quarantined_until: quarantinedUntil,
        }),
      ]);
      const cells = elements(rowOf(tree, "t24")).filter(isCell);
      const cellTexts = cells.map((cell) => textOf(cell));

      // columns: Kaynak, Sessiz, Tür, Bölge, Son haber, Son HTTP durumu, 7 gün
      expect(cellTexts[5]).toBe("200 · geçersiz akış");
      expect(cellTexts[1]).toContain("erişim yok");
      expect(cellTexts[1]).toContain("karantinada");
    });

    it("the HTTP cell may wrap below sm so the 19-character label does not widen the phone table", () => {
      // The label cannot wrap under a bare whitespace-nowrap, so its ~160 px
      // min-content would undo the phone narrowing of the headers. Below sm it
      // wraps at its spaces; from sm up it stays on one line.
      const tree = body([
        rawRow({
          slug: "t24",
          name: "T24",
          latest: stale,
          fetch_last_status: 200,
          fetch_fail_streak: 60,
          fetch_quarantined_until: quarantinedUntil,
        }),
      ]);
      const cells = elements(rowOf(tree, "t24")).filter(isCell);
      const cls = String(cells[5]?.props?.className).split(/\s+/);

      expect(cls).toContain("sm:whitespace-nowrap");
      expect(cls).not.toContain("whitespace-nowrap");
      expect(textOf(cells[5])).toBe("200 · geçersiz akış");
    });

    it("an unquarantined 200 with a streak of 2 reads '200 · geçersiz akış' too", () => {
      const tree = body([
        rawRow({ slug: "yeni-bozuk", name: "Yeni Bozuk", latest: stale, fetch_fail_streak: 2 }),
      ]);
      const cells = elements(rowOf(tree, "yeni-bozuk")).filter(isCell);
      expect(textOf(cells[5])).toBe("200 · geçersiz akış");
    });

    it("a 304 with a fail streak reads '304 · geçersiz akış'", () => {
      const tree = body([
        rawRow({
          slug: "bozuk-304",
          name: "Bozuk 304",
          latest: stale,
          fetch_last_status: 304,
          fetch_fail_streak: 1,
        }),
      ]);
      const cells = elements(rowOf(tree, "bozuk-304")).filter(isCell);
      expect(textOf(cells[5])).toBe("304 · geçersiz akış");
    });

    it("a healthy 200 (streak 0) still reads '200'", () => {
      const tree = body([rawRow({ slug: "saglam", name: "Sağlam Haber", fetch_fail_streak: 0 })]);
      const cells = elements(rowOf(tree, "saglam")).filter(isCell);
      expect(textOf(cells[5])).toBe("200");
    });

    it("a legacy row without the streak column still reads '200'", () => {
      const tree = body([rawRow({ slug: "eski", name: "Eski Haber" })]);
      const cells = elements(rowOf(tree, "eski")).filter(isCell);
      expect(textOf(cells[5])).toBe("200");
    });

    it("a quarantined 403 keeps its bare digits (the streak only relabels success codes)", () => {
      const tree = body([
        rawRow({
          slug: "halk-tv",
          name: "Halk TV",
          latest: stale,
          fetch_last_status: 403,
          fetch_fail_streak: 60,
          fetch_quarantined_until: quarantinedUntil,
        }),
      ]);
      const cells = elements(rowOf(tree, "halk-tv")).filter(isCell);
      expect(textOf(cells[5])).toBe("403");
    });

    it("a quarantined row with no HTTP answer (0) keeps its dash", () => {
      const tree = body([
        rawRow({
          slug: "cevapsiz-karantina",
          name: "Cevapsız Karantina",
          latest: stale,
          fetch_last_status: 0,
          fetch_fail_streak: 60,
          fetch_quarantined_until: quarantinedUntil,
        }),
      ]);
      const cells = elements(rowOf(tree, "cevapsiz-karantina")).filter(isCell);
      expect(textOf(cells[5])).toBe("—");
    });
  });

  it("a row that has never been fetched shows a dash in the HTTP cell", () => {
    const tree = body([
      rawRow({ slug: "yeni", name: "Yeni Haber", fetch_last_status: null }),
    ]);
    const cells = elements(rowOf(tree, "yeni")).filter(isCell);
    expect(textOf(cells[5])).toBe("—");
  });

  it("a row that is not silent shows a dash and no label", () => {
    const tree = body(fixtures());
    const text = textOf(rowOf(tree, "aktif"));
    expect(text).toContain("—");
    expect(text).not.toMatch(/akış donmuş|erişim yok|sessiz/);
  });

  it("the badge classes come from the AA-contrast map: sky, rose and amber, 800 in light and 300/300/400 in dark", () => {
    const tree = body(fixtures());
    const frozen = String(badgeOf(tree, "donmus", "akış donmuş").props?.className);
    const blocked = String(badgeOf(tree, "engelli", "erişim yok").props?.className);
    const quiet = String(badgeOf(tree, "sakin", "sessiz").props?.className);
    expect(frozen).toContain("bg-sky-500/15 border-sky-500/30 text-sky-800 dark:text-sky-300");
    expect(blocked).toContain("bg-rose-500/15 border-rose-500/30 text-rose-800 dark:text-rose-300");
    expect(quiet).toContain("bg-amber-500/15 border-amber-500/30 text-amber-800 dark:text-amber-400");
    // the old amber-700 / dark:amber-500 badge (below AA at 11 px) must not come back
    for (const cls of [frozen, blocked, quiet]) {
      expect(cls).not.toContain("text-amber-700");
      expect(cls).not.toContain("dark:text-amber-500");
      expect(cls).toContain("text-[11px]");
      expect(cls).toContain("border");
    }
  });

  it("keeps the karantinada badge next to the reason", () => {
    const tree = body([
      rawRow({
        slug: "karantina",
        name: "Karantina Haber",
        latest: stale,
        fetch_fail_streak: 21,
        fetch_quarantined_until: new Date(NOW + 6 * HOUR).toISOString(),
      }),
    ]);
    const text = textOf(rowOf(tree, "karantina"));
    expect(text).toContain("erişim yok");
    expect(text).toContain("karantinada");
  });

  it("a silent row of a legacy select (no freshness columns, reachable) reads sessiz", () => {
    const tree = body([rawRow({ slug: "eski", name: "Eski", latest: stale })]);
    expect(textOf(rowOf(tree, "eski"))).toContain("sessiz");
  });

  const LEGEND =
    "Sessiz kaynakların yanındaki etiket nedenini söyler: akış donmuş — besleme yanıt veriyor ama içindeki en yeni haber 72 saatten eski, yani besleme güncellenmiyor; erişim yok — besleme son denemede alınamadı ya da karantinada; sessiz — besleme güncel, ama son 72 saatte Tayf'a yeni haber eklenmedi.";

  it("shows the legend, word for word, when something is silent", () => {
    const tree = body(fixtures());
    const legend = elements(tree).find(
      (e) => e.type === "p" && textOf(e).startsWith("Sessiz kaynakların yanındaki etiket"),
    );
    expect(legend, "legend paragraph").toBeDefined();
    expect(textOf(legend)).toBe(LEGEND);
  });

  it("puts the three label words in <strong>, in order", () => {
    const tree = body(fixtures());
    const legend = elements(tree).find(
      (e) => e.type === "p" && textOf(e).startsWith("Sessiz kaynakların yanındaki etiket"),
    ) as El;
    const strong = elements(legend)
      .filter((e) => e.type === "strong")
      .map((e) => textOf(e));
    expect(strong).toEqual(["akış donmuş", "erişim yok", "sessiz"]);
  });

  it("places the legend under the totals paragraph and before the table", () => {
    const text = collectText(body(fixtures())).join(" ");
    const totals = text.indexOf("bu pencerede sessiz");
    const legend = text.indexOf("Sessiz kaynakların yanındaki etiket");
    const table = text.indexOf("Aktif kaynakların besleme durumu");
    expect(totals).toBeGreaterThan(-1);
    expect(legend).toBeGreaterThan(totals);
    expect(table).toBeGreaterThan(legend);
  });

  it("does not show the legend when no source is silent", () => {
    const tree = body([rawRow({ slug: "a" }), rawRow({ slug: "b" })]);
    expect(collectText(tree).join(" ")).not.toContain("Sessiz kaynakların yanındaki etiket");
    expect(elements(tree).filter((e) => e.type === "strong")).toHaveLength(0);
  });

  it("does not show the legend for an empty list", () => {
    const tree = KaynakDurumBody({ rows: [], itemsPerDayPromise: Promise.resolve({}) });
    expect(collectText(tree).join(" ")).not.toContain("Sessiz kaynakların yanındaki etiket");
  });

  it("never shows raw timestamps, the feed item count or error text", () => {
    const tree = body(fixtures());
    const text = collectText(tree).join(" ");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(text).not.toContain("fetch_");
    expect(text).not.toMatch(/\bundefined\b|\bnull\b|NaN/);
  });

  it("pins the literal class map and the legend in the page source", () => {
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(src).toContain("bg-sky-500/15 border-sky-500/30 text-sky-800 dark:text-sky-300");
    expect(src).toContain("bg-rose-500/15 border-rose-500/30 text-rose-800 dark:text-rose-300");
    expect(src).toContain("bg-amber-500/15 border-amber-500/30 text-amber-800 dark:text-amber-400");
    expect(src).toContain("SILENCE_REASON_LABEL[row.silenceReason ?? \"sessiz\"]");
    expect(src).not.toContain("text-amber-700");
  });

  describe("phone layout and contrast of the table (WCAG 1.4.3 / 1.4.10)", () => {
    const classOf = (el: El | undefined): string => String(el?.props?.className);
    const tokens = (cls: string) => cls.split(/\s+/);

    const quarantined = () =>
      body([
        rawRow({
          slug: "karantina",
          name: "Karantina Haber",
          latest: stale,
          fetch_fail_streak: 21,
          fetch_quarantined_until: new Date(NOW + 6 * HOUR).toISOString(),
        }),
      ]);

    it("the karantinada pill uses the AA-safe rose shade (800 light / 300 dark), never 700 / 500", () => {
      const pill = badgeOf(quarantined(), "karantina", "karantinada");
      const cls = classOf(pill);
      expect(cls).toContain("text-rose-800 dark:text-rose-300");
      expect(cls).not.toContain("text-rose-700");
      expect(cls).not.toContain("dark:text-rose-500");
      expect(cls).toContain("bg-rose-500/15");
    });

    it("the karantinada pill never wraps and keeps its title", () => {
      const pill = badgeOf(quarantined(), "karantina", "karantinada");
      expect(tokens(classOf(pill))).toContain("whitespace-nowrap");
      expect(String(pill.props?.title)).toContain("Art arda 21 başarısız çekim");
      expect(textOf(pill)).toBe("karantinada");
    });

    it("every silence pill keeps its label on one line", () => {
      const tree = body(fixtures());
      for (const [slug, label] of [
        ["donmus", "akış donmuş"],
        ["engelli", "erişim yok"],
        ["sakin", "sessiz"],
      ] as const) {
        expect(tokens(classOf(badgeOf(tree, slug, label))), `${slug} pill`).toContain(
          "whitespace-nowrap",
        );
      }
    });

    it("the pill wrapper may wrap onto a second line instead of overflowing the cell", () => {
      const tree = quarantined();
      const wrapper = elements(rowOf(tree, "karantina")).find(
        (e) => e.type === "span" && classOf(e).includes("gap-1.5"),
      );
      expect(wrapper, "pill wrapper span").toBeDefined();
      expect(classOf(wrapper)).toContain("flex flex-wrap items-center gap-1.5");
      expect(classOf(wrapper)).not.toContain("inline-flex");
    });

    it("the Kaynak column header is sticky on an opaque card background", () => {
      const th = elements(body(fixtures())).find((e) => isColHead(e) && textOf(e) === "Kaynak");
      expect(th, "Kaynak <th>").toBeDefined();
      const cls = classOf(th);
      expect(cls).toContain("sticky left-0");
      expect(tokens(cls)).toContain("z-10");
      expect(tokens(cls)).toContain("bg-card");
    });

    it("every row's name cell is sticky on an opaque card background", () => {
      const tree = body(fixtures());
      for (const slug of ["donmus", "engelli", "sakin", "aktif"]) {
        const firstCell = elements(rowOf(tree, slug)).find(isCell);
        expect(firstCell, `${slug} first cell`).toBeDefined();
        const cls = classOf(firstCell);
        expect(cls, slug).toContain("sticky left-0");
        expect(tokens(cls), slug).toContain("z-10");
        expect(tokens(cls), slug).toContain("bg-card");
        expect(textOf(firstCell)).toContain("Haber");
      }
    });

    it("only the first column is sticky", () => {
      const tree = body(fixtures());
      const cells = elements(rowOf(tree, "aktif")).filter(isCell);
      expect(cells.length).toBeGreaterThan(1);
      for (const cell of cells.slice(1)) expect(classOf(cell)).not.toContain("sticky");
      const heads = elements(tree).filter(isColHead);
      for (const th of heads.filter((h) => textOf(h) !== "Kaynak")) {
        expect(classOf(th)).not.toContain("sticky");
      }
    });

    it("the sticky cells sit inside the scroll region and the card behind them is opaque", () => {
      const tree = body(fixtures());
      const region = elements(tree).find((e) => e.props?.role === "region");
      expect(region, "scroll region").toBeDefined();
      expect(classOf(region)).toContain("overflow-x-auto");
      expect(elements(region).some((e) => isColHead(e) && textOf(e) === "Kaynak")).toBe(true);

      const card = elements(tree).find((e) => e.type === "div" && classOf(e).includes("ring-1"));
      expect(card, "table card wrapper").toBeDefined();
      expect(tokens(classOf(card))).toContain("bg-card");
      expect(classOf(card)).not.toContain("bg-card/60");
    });

    it("pins the sticky and opaque classes in the page source (literal class strings)", () => {
      const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
      expect(src).not.toContain("bg-card/60");
      expect(src).not.toContain("text-rose-700");
      expect(src).not.toContain("dark:text-rose-500");
      expect(src).toContain("sticky left-0 z-10 bg-card");
    });
  });

  // h14-polish-5: on a 375 px phone the table is ~721 px wide inside a ~311 px
  // scroller. "Sessiz" used to be the 7th of 7 columns (x = 670-753), so the
  // label the page copy points at was off-screen with no hint that the table
  // scrolls. It now sits right after the sticky Kaynak column, and a cue tells
  // phone readers the other columns are one swipe away.
  describe("Sessiz column order and scroll cue (h14-polish-5)", () => {
    const classOf = (el: El | undefined): string => String(el?.props?.className);
    const tokens = (cls: string) => cls.split(/\s+/);
    const CUE_ID = "durum-kaydir";

    const cellsOf = (tree: unknown, slug: string) =>
      elements(rowOf(tree, slug)).filter(isCell);

    const quarantinedSilent = () =>
      cellsOf(
        body([
          rawRow({
            slug: "karantina",
            name: "Karantina Haber",
            latest: stale,
            fetch_fail_streak: 21,
            fetch_quarantined_until: new Date(NOW + 6 * HOUR).toISOString(),
          }),
        ]),
        "karantina",
      );

    /** The children array that directly contains `target`, if any. */
    function siblingsOf(node: unknown, target: unknown): unknown[] | null {
      if (Array.isArray(node)) {
        if (node.includes(target)) return node;
        for (const child of node) {
          const found = siblingsOf(child, target);
          if (found) return found;
        }
        return null;
      }
      if (node && typeof node === "object") {
        const children = (node as El).props?.children;
        return children === undefined ? null : siblingsOf(children, target);
      }
      return null;
    }

    it("orders the columns Kaynak, Sessiz, Tür, Bölge, Son haber, Son HTTP durumu, 7 günlük gün başına haber", () => {
      const heads = elements(body(fixtures()))
        .filter(isColHead)
        .map((th) => textOf(th));
      expect(heads).toEqual([
        "Kaynak",
        "Sessiz",
        "Tür",
        "Bölge",
        "Son haber",
        "Son HTTP durumu",
        "7 günlük gün başına haber",
      ]);
    });

    it("every row has seven cells and keeps the name first", () => {
      const tree = body(fixtures());
      for (const slug of ["donmus", "engelli", "sakin", "aktif"]) {
        const cells = cellsOf(tree, slug);
        expect(cells, slug).toHaveLength(7);
        expect(textOf(cells[0]), slug).toContain("Haber");
      }
    });

    it("td[1] holds the silence badge, or a dash for a delivering source", () => {
      const tree = body(fixtures());
      expect(textOf(cellsOf(tree, "donmus")[1])).toBe("akış donmuş");
      expect(textOf(cellsOf(tree, "engelli")[1])).toBe("erişim yok");
      expect(textOf(cellsOf(tree, "sakin")[1])).toBe("sessiz");
      expect(textOf(cellsOf(tree, "aktif")[1])).toBe("—");
    });

    it("td[1] also carries the karantinada badge next to the reason", () => {
      const cell = quarantinedSilent()[1];
      expect(textOf(cell)).toBe("erişim yokkarantinada");
    });

    it("the other cells moved one place right: kind, zone, last item, HTTP status, items per day", () => {
      const cells = cellsOf(body(fixtures()), "aktif");
      expect(textOf(cells[2])).toBe(SOURCE_KIND_META.outlet.label);
      expect(textOf(cells[3])).toBe(ZONE_META.bagimsiz.label);
      // "Son haber": a relative time or date (depends on the clock), never the dash
      expect(textOf(cells[4])).not.toBe("");
      expect(textOf(cells[4])).not.toBe("—");
      expect(textOf(cells[5])).toBe("200");
      // the streamed 7-day rate stays behind its own Suspense in the last cell
      expect(elements(cells[6]).some((e) => e.type === Suspense)).toBe(true);
    });

    it("Sessiz th and td carry pr-4; the new last column drops it", () => {
      const tree = body(fixtures());
      const heads = elements(tree).filter(isColHead);
      expect(tokens(classOf(heads[1]))).toContain("pr-4");
      expect(tokens(classOf(heads[6]))).not.toContain("pr-4");
      for (const slug of ["donmus", "aktif"]) {
        const cells = cellsOf(tree, slug);
        expect(tokens(classOf(cells[1])), `${slug} Sessiz td`).toContain("pr-4");
        expect(tokens(classOf(cells[6])), `${slug} last td`).not.toContain("pr-4");
      }
    });

    it("Kaynak stays the only sticky column", () => {
      const tree = body(fixtures());
      const heads = elements(tree).filter(isColHead);
      expect(heads.filter((h) => classOf(h).includes("sticky"))).toHaveLength(1);
      expect(textOf(heads[0])).toBe("Kaynak");
      const cells = cellsOf(tree, "donmus");
      expect(cells.filter((c) => classOf(c).includes("sticky"))).toHaveLength(1);
      expect(classOf(cells[0])).toContain("sticky left-0 z-10 bg-card");
    });

    it("shows a swipe cue for phones right above the scroll region", () => {
      const tree = body(fixtures());
      const all = elements(tree);
      const cue = all.find((e) => e.props?.id === CUE_ID);
      expect(cue, "scroll cue").toBeDefined();
      expect(cue!.type).toBe("p");
      expect(classOf(cue)).toBe("text-[11px] text-muted-foreground md:hidden");
      expect(textOf(cue)).toBe("Diğer sütunlar için tabloyu yana kaydırın.");

      // The cue is outside the scroller, immediately before it (siblings).
      const region = all.find((e) => e.props?.role === "region")!;
      expect(elements(region).includes(cue!)).toBe(false);
      const siblings = siblingsOf(tree, cue)!;
      expect(siblings).not.toBeNull();
      expect(siblings[siblings.indexOf(cue) + 1]).toBe(region);
    });

    it("describes the region by the cue and keeps its role, name and focusability", () => {
      const region = elements(body(fixtures())).find((e) => e.props?.role === "region")!;
      expect(region.props?.["aria-describedby"]).toBe(CUE_ID);
      expect(region.props?.["aria-labelledby"]).toBe("durum-tablo");
      expect(region.props?.tabIndex).toBe(0);
      expect(classOf(region)).toContain("overflow-x-auto");
    });

    it("the describedby target exists exactly once", () => {
      const tree = body(fixtures());
      expect(elements(tree).filter((e) => e.props?.id === CUE_ID)).toHaveLength(1);
    });

    it("renders no cue (and no dangling describedby) for an empty list", () => {
      const tree = KaynakDurumBody({ rows: [], itemsPerDayPromise: Promise.resolve({}) });
      expect(elements(tree).filter((e) => e.props?.id === CUE_ID)).toHaveLength(0);
      expect(elements(tree).filter((e) => e.props?.["aria-describedby"] !== undefined)).toHaveLength(0);
    });

    it("pins the cue, its md:hidden class and the describedby in the page source", () => {
      const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
      expect(src).toContain('id="durum-kaydir"');
      expect(src).toContain('className="text-[11px] text-muted-foreground md:hidden"');
      expect(src).toContain('aria-describedby="durum-kaydir"');
      expect(src).toContain("Diğer sütunlar için tabloyu yana kaydırın.");
    });
  });

  // W4-kaynaklar-durum-mobile: at 390 px "Son HTTP durumu" and "7 günlük gün
  // başına haber" wrapped onto 3-5 lines each (tall header row, ragged table).
  // Every th is now whitespace-nowrap; the two long ones render a short label
  // on phones ("HTTP", "Haber/gün") from a data attribute via ::before, while
  // the full label stays in the DOM (visually hidden below sm, visible from sm
  // up) so the accessible name and the column-order test keep the full text.
  describe("phone header labels (W4-kaynaklar-durum-mobile)", () => {
    const classOf = (el: El | undefined): string => String(el?.props?.className);
    const tokens = (cls: string) => cls.split(/\s+/);

    const LONG_HEADERS = [
      { full: "Son HTTP durumu", short: "HTTP" },
      { full: "7 günlük gün başına haber", short: "Haber/gün" },
    ] as const;

    const heads = () => elements(body(fixtures())).filter(isColHead);
    const headOf = (full: string): El => {
      const th = heads().find((h) => textOf(h) === full);
      if (!th) throw new Error(`no <th> for ${full}`);
      return th;
    };
    /** The <span> elements below a header (the th itself is not one). */
    const spansOf = (th: El) => elements(th).filter((e) => e.type === "span");

    it("renders seven column headers", () => {
      expect(heads()).toHaveLength(7);
    });

    it("every th is whitespace-nowrap so no header wraps onto a second line", () => {
      for (const th of heads()) {
        expect(tokens(classOf(th)), textOf(th)).toContain("whitespace-nowrap");
      }
    });

    it("keeps the pr-4 rule (all but the last th) and Kaynak's sticky opaque classes", () => {
      const all = heads();
      for (const th of all.slice(0, 6)) expect(tokens(classOf(th)), textOf(th)).toContain("pr-4");
      expect(tokens(classOf(all[6]))).not.toContain("pr-4");
      expect(classOf(all[0])).toContain("sticky left-0 z-10 bg-card");
    });

    for (const { full, short } of LONG_HEADERS) {
      describe(`"${full}" header`, () => {
        it("holds the full label, exactly, in a span that is visually hidden only below sm", () => {
          const fullSpans = spansOf(headOf(full)).filter((s) =>
            tokens(classOf(s)).includes("max-sm:sr-only"),
          );
          expect(fullSpans).toHaveLength(1);
          expect(textOf(fullSpans[0])).toBe(full);
          // not aria-hidden: the screen-reader name is the full label at every width
          expect(fullSpans[0]!.props?.["aria-hidden"]).toBeUndefined();
        });

        it(`holds an empty aria-hidden span that shows "${short}" from data-short below sm`, () => {
          const shortSpans = spansOf(headOf(full)).filter(
            (s) => s.props?.["data-short"] !== undefined,
          );
          expect(shortSpans).toHaveLength(1);
          const span = shortSpans[0]!;
          expect(span.props?.["aria-hidden"]).toBe("true");
          expect(span.props?.["data-short"]).toBe(short);
          // no text node: the short label is painted by ::before, so textOf(th)
          // (and the accessible name) stays the full label
          expect(span.props?.children).toBeUndefined();
          expect(textOf(span)).toBe("");
          const cls = tokens(classOf(span));
          expect(cls).toContain("sm:hidden");
          expect(cls).toContain("before:content-[attr(data-short)]");
        });

        it("has exactly the two spans, full label first", () => {
          const spans = spansOf(headOf(full));
          expect(spans).toHaveLength(2);
          expect(tokens(classOf(spans[0]))).toContain("max-sm:sr-only");
          expect(spans[1]!.props?.["data-short"]).toBe(short);
        });

        it("keeps the text of the th equal to the full label", () => {
          expect(textOf(headOf(full))).toBe(full);
        });
      });
    }

    it("the five short columns have no short-label span", () => {
      const longLabels: readonly string[] = LONG_HEADERS.map((h) => h.full);
      for (const th of heads().filter((h) => !longLabels.includes(textOf(h)))) {
        expect(
          elements(th).filter((e) => e.props?.["data-short"] !== undefined),
          textOf(th),
        ).toHaveLength(0);
      }
    });

    it("pins the short-label and sr-only literals in the page source (Tailwind 4 reads the source)", () => {
      const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
      expect(src).toContain("before:content-[attr(data-short)]");
      expect(src).toContain("max-sm:sr-only");
      expect(src).toContain('data-short="HTTP"');
      expect(src).toContain('data-short="Haber/gün"');
    });

    // Measured at 390 px: without a positioned ancestor the absolutely
    // positioned sr-only span of the LAST column (static position x ~ 600) has
    // the viewport as containing block, so the scroller neither clips it nor
    // counts it, and documentElement.scrollWidth grew to 600 (the page scrolled
    // sideways). A positioned region keeps that overflow inside the scroller.
    it("the scroll region is a positioned box, so the sr-only header spans cannot widen the page", () => {
      const region = elements(body(fixtures())).find((e) => e.props?.role === "region");
      expect(tokens(classOf(region))).toContain("relative");
      expect(tokens(classOf(region))).toContain("overflow-x-auto");
    });

    it("keeps the scroll region labelled, described, focusable and ringed (#171)", () => {
      const region = elements(body(fixtures())).find((e) => e.props?.role === "region");
      expect(region, "scroll region").toBeDefined();
      expect(region!.props?.role).toBe("region");
      expect(region!.props?.tabIndex).toBe(0);
      expect(region!.props?.["aria-labelledby"]).toBe("durum-tablo");
      expect(region!.props?.["aria-describedby"]).toBe("durum-kaydir");
      const cls = tokens(classOf(region));
      expect(cls).toContain("overflow-x-auto");
      expect(cls).toContain("focus-visible:outline-none");
      expect(cls).toContain("focus-visible:ring-2");
      expect(cls).toContain("focus-visible:ring-ring");
    });
  });

  // h126-a11y-2 (WCAG 1.3.1, technique H63): the cell that names a row was a
  // <td>, so moving down a column a screen reader announced "Son haber, 16
  // Haziran 2026" with no source name. It is now <th scope="row">; the 118-row
  // table keeps its look (th defaults to bold and centred, so text-left and the
  // old font-medium are explicit) and its sticky first column.
  describe("row headers (h126-a11y-2)", () => {
    const classOf = (el: El | undefined): string => String(el?.props?.className);
    const tokens = (cls: string) => cls.split(/\s+/);

    const rowHeads = (tree: unknown) =>
      elements(tree).filter((e) => e.type === "th" && e.props?.scope === "row");
    const dataRows = (tree: unknown) =>
      elements(tree).filter((e) => e.type === "tr" && e.key !== null && e.key !== undefined);

    it("renders one th scope=row per data row, and the first one names the first source", () => {
      const tree = body(fixtures());
      const heads = rowHeads(tree);

      expect(dataRows(tree)).toHaveLength(4);
      expect(heads).toHaveLength(4);
      // silent rows first (alphabetical), then the delivering one
      expect(heads.map((h) => textOf(h))).toEqual([
        "Donmuş Haber",
        "Engelli Haber",
        "Sakin Haber",
        "Aktif Haber",
      ]);
    });

    it("in every row the name is the th and the other six cells stay td", () => {
      const tree = body(fixtures());
      for (const [slug, name] of [
        ["donmus", "Donmuş Haber"],
        ["engelli", "Engelli Haber"],
        ["sakin", "Sakin Haber"],
        ["aktif", "Aktif Haber"],
      ] as const) {
        const cells = elements(rowOf(tree, slug)).filter(isCell);
        expect(cells[0]!.type, slug).toBe("th");
        expect(cells[0]!.props?.scope, slug).toBe("row");
        expect(textOf(cells[0]), slug).toBe(name);
        expect(cells.slice(1).map((c) => c.type), slug).toEqual(Array(6).fill("td"));
      }
    });

    it("the name inside the row header is still the link to the source page", () => {
      const tree = body(fixtures());
      const th = rowHeads(rowOf(tree, "donmus"))[0];
      expect(th, "row header").toBeDefined();
      expect(elements(th).some((e) => e.props?.href === "/source/donmus")).toBe(true);
    });

    it("keeps the sticky opaque classes and sets text-left plus font-medium (th is bold and centred by default)", () => {
      const tree = body(fixtures());
      expect(rowHeads(tree)).toHaveLength(4);
      for (const th of rowHeads(tree)) {
        const cls = tokens(classOf(th));
        for (const token of ["sticky", "left-0", "z-10", "bg-card", "text-left", "font-medium"]) {
          expect(cls, `${textOf(th)} ${token}`).toContain(token);
        }
        expect(cls).not.toContain("font-bold");
        expect(cls).not.toContain("font-semibold");
      }
    });

    it("gives the table an sr-only caption 'Kaynak durumu' as its first child", () => {
      const tree = body(fixtures());
      const table = elements(tree).find((e) => e.type === "table");
      expect(table, "table").toBeDefined();
      const children = table!.props?.children as El[];
      expect(children[0]!.type).toBe("caption");
      expect(tokens(classOf(children[0]))).toContain("sr-only");
      expect(textOf(children[0])).toBe("Kaynak durumu");
      expect(elements(tree).filter((e) => e.type === "caption")).toHaveLength(1);
    });

    it("renders no row header (and no caption) for an empty list", () => {
      const tree = KaynakDurumBody({ rows: [], itemsPerDayPromise: Promise.resolve({}) });
      expect(rowHeads(tree)).toHaveLength(0);
      expect(elements(tree).filter((e) => e.type === "caption")).toHaveLength(0);
    });
  });
});

describe("ItemsPerDayCell", () => {
  it("A-07: formats the 7-day rate with tr-TR NumberFormat (comma decimal), streamed in behind the row", async () => {
    const el = await ItemsPerDayCell({
      slug: "ornek-kaynak",
      itemsPerDayPromise: Promise.resolve({ "ornek-kaynak": 1.4 }),
    });
    const text = collectText(el).join("");
    expect(text).toBe("1,4");
  });

  it("renders a neutral dash, not a fabricated 0, when the underlying fetch failed", async () => {
    const el = await ItemsPerDayCell({
      slug: "ornek-kaynak",
      itemsPerDayPromise: Promise.resolve(null),
    });
    const text = collectText(el).join("");
    expect(text).toBe("—");
  });
});

describe("KaynakDurumPage cross-link to /durum", () => {
  // Source-text assertion: the page is an async Server Component, so the
  // link is pinned in the file rather than by resolving the whole tree.
  const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

  it("points readers at the overall Sistem durumu page", () => {
    expect(src).toContain('href="/durum"');
    expect(src).toContain("Haber akışının genel durumu için");
    expect(src).toContain("Sistem durumu");
  });

  it("places the pointer in the static shell, right after the PageHero and before the table branch", () => {
    const hero = src.indexOf("<PageHero");
    const pointer = src.indexOf('href="/durum"');
    const branch = src.indexOf("rows === null");
    expect(hero).toBeGreaterThan(-1);
    expect(pointer).toBeGreaterThan(hero);
    expect(pointer).toBeLessThan(branch);
  });

  it("renders the pointer in the shell whatever the data does (it is static copy, not part of the child)", async () => {
    fixture.data = [rawRow()];
    fixture.error = null;
    const ok = collectText(KaynakDurumPage()).join(" ");
    expect(ok).toContain("Haber akışının genel durumu için");
    expect(collectText(await DurumBody()).join(" ")).not.toContain("Haber akışının genel durumu için");

    fixture.data = [];
    fixture.error = { message: "canceling statement due to statement timeout" };
    const down = collectText(KaynakDurumPage()).join(" ");
    expect(down).toContain("Haber akışının genel durumu için");
    expect(collectText(await DurumBody()).join(" ")).not.toContain("Haber akışının genel durumu için");
  });
});

// h71-transparency-2: every "N/M kaynak" footnote (DenominatorNote on /sources
// and /blindspots) links here as its evidence, but the page printed only the
// all-kinds tally (e.g. 88/118) and threw `.voting` away. The page now prints
// the voting pair in DenominatorNote's own wording, per zone as well, and
// labels the all-kinds numbers as including aggregators and niche sources.
describe("KaynakDurumBody voting denominator (h71-transparency-2)", () => {
  const HOUR = 60 * 60 * 1000;
  const stale = [{ published_at: new Date(NOW - 96 * HOUR).toISOString() }];

  type El = { type?: unknown; key?: unknown; props?: Record<string, unknown> };

  /** Every element under the tree (depth first), expanding no components. */
  function elements(node: unknown, out: El[] = []): El[] {
    if (Array.isArray(node)) {
      for (const child of node) elements(child, out);
      return out;
    }
    if (node && typeof node === "object") {
      const el = node as El;
      out.push(el);
      const children = el.props?.children;
      if (children !== undefined) elements(children, out);
    }
    return out;
  }

  const textOf = (node: unknown) => collectText(node).join("");
  const classOf = (el: El | undefined): string => String(el?.props?.className);

  function body(raw: SourceFeedStatusRawRow[]) {
    return KaynakDurumBody({
      rows: toFeedStatusRows(raw, NOW),
      itemsPerDayPromise: Promise.resolve({}),
    });
  }

  /**
   * 3 outlets (2 delivering), 1 wire (delivering), 2 aggregators (1
   * delivering), 1 niche (silent), spread over the three zones so that the
   * per-zone voting pair differs from the per-zone all-kinds pair:
   *   voting    iktidar 2/2   bagimsiz 0/1   muhalefet 1/1   total 3/4
   *   all kinds iktidar 2/3   bagimsiz 1/2   muhalefet 1/2   total 4/7
   */
  const votingFixture = (): SourceFeedStatusRawRow[] => [
    rawRow({ slug: "ik-bir", name: "İktidar Bir", kind: "outlet", bias: "pro_government" }),
    rawRow({ slug: "ik-iki", name: "İktidar İki", kind: "outlet", bias: "pro_government" }),
    rawRow({
      slug: "bg-sessiz",
      name: "Bağımsız Sessiz",
      kind: "outlet",
      bias: "center",
      latest: stale,
    }),
    rawRow({ slug: "mu-ajans", name: "Muhalefet Ajans", kind: "wire", bias: "opposition" }),
    rawRow({ slug: "bg-toplayici", name: "Bağımsız Toplayıcı", kind: "aggregator", bias: "center" }),
    rawRow({
      slug: "ik-toplayici",
      name: "İktidar Toplayıcı",
      kind: "aggregator",
      bias: "pro_government",
      latest: stale,
    }),
    rawRow({
      slug: "mu-nis",
      name: "Muhalefet Niş",
      kind: "niche",
      bias: "opposition",
      latest: [],
    }),
  ];

  /** Only aggregator and niche sources: nothing votes. */
  const nonVotingOnly = (): SourceFeedStatusRawRow[] => [
    rawRow({ slug: "toplayici", name: "Toplayıcı Bir", kind: "aggregator", bias: "center" }),
    rawRow({ slug: "nis", name: "Niş Bir", kind: "niche", bias: "opposition", latest: stale }),
  ];

  const VOTING_PREFIX = "Paylar, yanlılık dağılımına sayılan";
  const CLAUSE = "(haber siteleri ve ajanslar; toplayıcı ve niş kaynaklar paya sayılmaz).";

  function votingParagraph(tree: unknown): El | undefined {
    return elements(tree).find((e) => e.type === "p" && textOf(e).startsWith(VOTING_PREFIX));
  }

  function totalsParagraph(tree: unknown): El | undefined {
    return elements(tree).find((e) => e.type === "p" && textOf(e).includes("aktif kaynaktan"));
  }

  function zoneCard(tree: unknown, zone: keyof typeof ZONE_META): El {
    const card = elements(tree).find((e) => e.type === "div" && e.key === zone);
    if (!card) throw new Error(`no zone card for ${zone}`);
    return card;
  }

  describe("the voting pair in DenominatorNote's wording", () => {
    it("prints 'yanlılık dağılımına sayılan' and the voting pair '3/4 kaynak üzerinden hesaplanır'", () => {
      const text = textOf(body(votingFixture()));
      expect(text).toContain("yanlılık dağılımına sayılan");
      expect(text).toContain("3/4 kaynak üzerinden hesaplanır");
    });

    it("the paragraph reads in full, with the kinds clause, and is a muted text-xs paragraph", () => {
      const p = votingParagraph(body(votingFixture()));
      expect(p, "voting paragraph").toBeDefined();
      expect(textOf(p)).toBe(
        `${VOTING_PREFIX} ve son 72 saatte en az bir haber veren 3/4 kaynak üzerinden hesaplanır ${CLAUSE}`,
      );
      expect(classOf(p)).toBe("text-xs text-muted-foreground");
    });

    it("prints exactly the pair summariseFeedStatus().voting computes, so the page and DenominatorNote cannot drift", () => {
      const rows = toFeedStatusRows(votingFixture(), NOW);
      const { voting } = summariseFeedStatus(rows);
      const text = textOf(body(votingFixture()));
      expect(`${voting.delivering}/${voting.total}`).toBe("3/4");
      expect(text).toContain(`${voting.delivering}/${voting.total} kaynak üzerinden hesaplanır`);
      // and it is not the all-kinds pair, which stays on its own line
      const { all } = summariseFeedStatus(rows);
      expect(`${all.delivering}/${all.total}`).not.toBe(`${voting.delivering}/${voting.total}`);
      expect(votingParagraph(body(votingFixture()))).toBeDefined();
      expect(textOf(votingParagraph(body(votingFixture())))).not.toContain(
        `${all.delivering}/${all.total}`,
      );
    });

    it("both numbers are font-mono spans", () => {
      const p = votingParagraph(body(votingFixture()))!;
      const monos = elements(p)
        .filter((e) => e.type === "span" && classOf(e) === "font-mono")
        .map((e) => textOf(e));
      expect(monos).toEqual(["3", "4"]);
    });

    it("renders exactly one voting paragraph, directly above the all-kinds totals paragraph and below the zone cards", () => {
      const tree = body(votingFixture()) as El;
      const children = (tree.props?.children as unknown[]).filter(Boolean);
      const voting = children.find(
        (c) => (c as El).type === "p" && textOf(c).startsWith(VOTING_PREFIX),
      );
      const totals = children.find(
        (c) => (c as El).type === "p" && textOf(c).includes("aktif kaynaktan"),
      );
      const grid = children.find(
        (c) => (c as El).type === "div" && classOf(c as El).includes("grid"),
      );
      expect(voting, "voting paragraph").toBeDefined();
      expect(totals, "totals paragraph").toBeDefined();
      expect(grid, "zone grid").toBeDefined();
      expect(children.indexOf(totals)).toBe(children.indexOf(voting) + 1);
      expect(children.indexOf(voting)).toBeGreaterThan(children.indexOf(grid));
      expect(elements(tree).filter((e) => e.type === "p" && textOf(e).startsWith(VOTING_PREFIX)))
        .toHaveLength(1);
    });

    it("a zero voting total gives the wording without numbers, never '0/0'", () => {
      const tree = body(nonVotingOnly());
      const p = votingParagraph(tree);
      expect(p, "voting paragraph").toBeDefined();
      expect(textOf(p)).toBe(
        `${VOTING_PREFIX} ve son 72 saatte en az bir haber veren kaynaklar üzerinden hesaplanır ${CLAUSE}`,
      );
      expect(elements(p).filter((e) => e.type === "span")).toHaveLength(0);
      expect(textOf(tree)).not.toContain("0/0");
      expect(textOf(tree)).not.toMatch(/\d+\/\d+ kaynak üzerinden/);
    });

    it("an empty list gives the wording without numbers too", () => {
      const tree = KaynakDurumBody({ rows: [], itemsPerDayPromise: Promise.resolve({}) });
      const p = votingParagraph(tree);
      expect(p, "voting paragraph").toBeDefined();
      expect(textOf(p)).toContain("haber veren kaynaklar üzerinden hesaplanır");
      expect(textOf(tree)).not.toContain("0/0");
    });
  });

  describe("per-zone voting pair on the zone cards", () => {
    it("each card gets a second line 'Paya sayılan: d/t' with its own voting pair", () => {
      const tree = body(votingFixture());
      const expected = { iktidar: "2/2", bagimsiz: "0/1", muhalefet: "1/1" } as const;
      for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
        expect(textOf(zoneCard(tree, zone)), zone).toContain(`Paya sayılan: ${expected[zone]}`);
      }
    });

    it("the pair per zone is the one summariseFeedStatus().voting.byZone computes", () => {
      const rows = toFeedStatusRows(votingFixture(), NOW);
      const { voting } = summariseFeedStatus(rows);
      const tree = body(votingFixture());
      for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
        const z = voting.byZone[zone];
        expect(textOf(zoneCard(tree, zone)), zone).toContain(
          `Paya sayılan: ${z.delivering}/${z.total}`,
        );
      }
    });

    it("keeps the all-kinds line, suffixed '(toplayıcı ve niş dahil)'", () => {
      const tree = body(votingFixture());
      const expected = { iktidar: [3, 2], bagimsiz: [2, 1], muhalefet: [2, 1] } as const;
      for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
        const [total, delivering] = expected[zone];
        const text = textOf(zoneCard(tree, zone));
        expect(text, zone).toContain(
          `${total} kaynaktan ${delivering} tanesi son 72 saatte yayın yaptı (toplayıcı ve niş dahil)`,
        );
        expect(text, zone).toContain(ZONE_META[zone].label);
      }
    });

    it("the voting line comes after the all-kinds line in each card, with font-mono numbers", () => {
      const card = zoneCard(body(votingFixture()), "iktidar");
      const text = textOf(card);
      expect(text.indexOf("Paya sayılan")).toBeGreaterThan(text.indexOf("yayın yaptı"));
      const voting = elements(card).find(
        (e) => e.type === "p" && textOf(e).startsWith("Paya sayılan"),
      );
      expect(voting, "voting line").toBeDefined();
      const monos = elements(voting)
        .filter((e) => e.type === "span" && classOf(e).split(/\s+/).includes("font-mono"))
        .map((e) => textOf(e));
      expect(monos).toEqual(["2", "2"]);
    });

    it("a zone with no voting source says so instead of printing '0/0'", () => {
      const tree = body(nonVotingOnly());
      for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
        const text = textOf(zoneCard(tree, zone));
        expect(text, zone).toContain("Paya sayılan kaynak yok");
        expect(text, zone).not.toContain("0/0");
      }
    });
  });

  describe("regression: the all-kinds sentence, quarantine and ordering", () => {
    it("the totals sentence says it includes aggregators and niche sources and keeps the rest unchanged", () => {
      const p = totalsParagraph(body(votingFixture()));
      expect(p, "totals paragraph").toBeDefined();
      expect(textOf(p)).toBe(
        "Toplayıcı ve niş kaynaklar dahil toplam 7 aktif kaynaktan 4 tanesi son 72 saatte en az bir haber verdi; 3 kaynak bu pencerede sessiz.",
      );
      expect(classOf(p)).toBe("text-xs text-muted-foreground");
    });

    it("the totals sentence still carries the quarantine sentence when a feed is quarantined", () => {
      const raw = votingFixture();
      raw.push(
        rawRow({
          slug: "karantina",
          name: "Karantina Haber",
          latest: stale,
          fetch_fail_streak: 21,
          fetch_quarantined_until: new Date(NOW + 6 * HOUR).toISOString(),
        }),
      );
      const text = textOf(totalsParagraph(body(raw)));
      expect(text).toContain("1 besleme karantinada");
      expect(text).toContain("1 saat, 6 saat, sonra günde bir yeniden denenir");
      // the quarantined row is an outlet: it also counts in the voting pair (3/5)
      expect(textOf(body(raw))).toContain("3/5 kaynak üzerinden hesaplanır");
    });

    it("rows stay silent-first, then alphabetical (Turkish collation)", () => {
      const tree = body(votingFixture());
      const slugs = elements(tree)
        .filter((e) => e.type === "tr" && e.key !== null && e.key !== undefined)
        .map((e) => String(e.key));
      // silent: bg-sessiz (Bağımsız Sessiz), ik-toplayici (İktidar Toplayıcı), mu-nis
      // (Muhalefet Niş); delivering: ik-bir, ik-iki, bg-toplayici, mu-ajans
      expect(slugs).toEqual([
        "bg-sessiz",
        "ik-toplayici",
        "mu-nis",
        "bg-toplayici",
        "ik-bir",
        "ik-iki",
        "mu-ajans",
      ]);
    });

    it("the legend for silent sources still follows the totals paragraph", () => {
      const text = collectText(body(votingFixture())).join(" ");
      expect(text.indexOf("Sessiz kaynakların yanındaki etiket")).toBeGreaterThan(
        text.indexOf("bu pencerede sessiz"),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// migration 212 (h174-latency-1): a feed that holds only its newest N items
// (haberport: 50, replaced hourly) lost items whenever more than N appeared
// between two polls. Ingest stamps sources.fetch_window_overflow_at; the page
// tags a source whose window overflowed in the last 7 days, whether or not it
// is silent (haberport delivers every hour, which is exactly why nothing else
// on this page shows the loss), and says what the tag means.
// ---------------------------------------------------------------------------
describe("KaynakDurumBody feed window overflow [migration 212]", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const TAG = "akış penceresi taşıyor";
  const LEGEND =
    "akış penceresi taşıyor etiketi: besleme her seferinde yalnızca son haberleri veriyor ve son 7 günde bu sınır aşıldı; arada yayımlanan bazı haberler Tayf'a ulaşmadı, bu kaynağın sayıları en az değerdir.";

  type El = { type?: unknown; key?: unknown; props?: Record<string, unknown> };

  function elements(node: unknown, out: El[] = []): El[] {
    if (Array.isArray(node)) {
      for (const child of node) elements(child, out);
      return out;
    }
    if (node && typeof node === "object") {
      const el = node as El;
      out.push(el);
      const children = el.props?.children;
      if (children !== undefined) elements(children, out);
    }
    return out;
  }

  const textOf = (node: unknown) => collectText(node).join("");

  function body(raw: SourceFeedStatusRawRow[]) {
    return KaynakDurumBody({
      rows: toFeedStatusRows(raw, NOW),
      itemsPerDayPromise: Promise.resolve({}),
    });
  }

  function rowOf(tree: unknown, slug: string): El {
    const tr = elements(tree).find((e) => e.type === "tr" && e.key === slug);
    if (!tr) throw new Error(`no <tr> for ${slug}`);
    return tr;
  }

  const legendOf = (tree: unknown) =>
    elements(tree).find((e) => e.type === "p" && textOf(e).startsWith("akış penceresi taşıyor etiketi"));

  const fixtures = (): SourceFeedStatusRawRow[] => [
    rawRow({
      slug: "haberport",
      name: "Haberport",
      fetch_window_overflow_at: new Date(NOW - 2 * HOUR).toISOString(),
    }),
    rawRow({ slug: "sakin-akis", name: "Sakin Akış", fetch_window_overflow_at: null }),
    rawRow({
      slug: "eski-tasma",
      name: "Eski Taşma",
      fetch_window_overflow_at: new Date(NOW - 8 * DAY).toISOString(),
    }),
  ];

  it("a flagged source shows the tag and an unflagged one does not", () => {
    const tree = body(fixtures());
    expect(textOf(rowOf(tree, "haberport"))).toContain(TAG);
    expect(textOf(rowOf(tree, "sakin-akis"))).not.toContain(TAG);
  });

  it("a stamp older than 7 days no longer tags the source", () => {
    expect(textOf(rowOf(body(fixtures()), "eski-tasma"))).not.toContain(TAG);
  });

  it("the tag is in the Sessiz cell (td[1]) next to the dash of a delivering source, and nowhere else in the row", () => {
    const tree = body(fixtures());
    const cells = elements(rowOf(tree, "haberport")).filter((e) => e.type === "td" || e.type === "th");
    expect(cells).toHaveLength(7);
    expect(textOf(cells[1])).toContain(TAG);
    expect(textOf(cells[1])).toContain("—");
    for (const i of [0, 2, 3, 4, 5, 6]) expect(textOf(cells[i]), `cell ${i}`).not.toContain(TAG);
  });

  it("an unflagged delivering source keeps its plain dash (td[1] is exactly '—')", () => {
    const cells = elements(rowOf(body(fixtures()), "sakin-akis")).filter((e) => e.type === "td" || e.type === "th");
    expect(textOf(cells[1])).toBe("—");
  });

  it("a silent and flagged source shows its silence reason and the tag together, and the karantinada badge keeps its place", () => {
    const stale = [{ published_at: new Date(NOW - 96 * HOUR).toISOString() }];
    const tree = body([
      rawRow({
        slug: "hem-sessiz",
        name: "Hem Sessiz",
        latest: stale,
        fetch_fail_streak: 21,
        fetch_quarantined_until: new Date(NOW + 6 * HOUR).toISOString(),
        fetch_window_overflow_at: new Date(NOW - 3 * DAY).toISOString(),
      }),
    ]);
    const cells = elements(rowOf(tree, "hem-sessiz")).filter((e) => e.type === "td" || e.type === "th");
    const text = textOf(cells[1]);
    expect(text).toContain("erişim yok");
    expect(text).toContain("karantinada");
    expect(text).toContain(TAG);
    expect(text.indexOf("karantinada")).toBeLessThan(text.indexOf(TAG));
  });

  it("prints the legend, word for word, only when at least one source is tagged", () => {
    const flagged = legendOf(body(fixtures()));
    expect(flagged, "legend paragraph").toBeDefined();
    expect(textOf(flagged)).toBe(LEGEND);
    // none tagged: no legend
    expect(legendOf(body([rawRow({ slug: "a" }), rawRow({ slug: "b", fetch_window_overflow_at: new Date(NOW - 9 * DAY).toISOString() })]))).toBeUndefined();
    // an empty list: no legend
    expect(legendOf(KaynakDurumBody({ rows: [], itemsPerDayPromise: Promise.resolve({}) }))).toBeUndefined();
  });

  it("places the legend after the totals paragraph and before the table", () => {
    const text = collectText(body(fixtures())).join(" ");
    const totals = text.indexOf("bu pencerede sessiz");
    const legend = text.indexOf("etiketi: besleme her seferinde");
    const table = text.indexOf("Aktif kaynakların besleme durumu");
    expect(totals).toBeGreaterThan(-1);
    expect(legend).toBeGreaterThan(totals);
    expect(table).toBeGreaterThan(legend);
  });

  it("the tag is a literal-class pill like the karantinada one: AA shades (800 light, 300 dark), 11 px, one line, with a title", () => {
    const tree = body(fixtures());
    const tag = elements(rowOf(tree, "haberport"))
      .filter((e) => e.type === "span" && textOf(e) === TAG)
      .pop() as El;
    expect(tag).toBeDefined();
    const cls = String(tag.props?.className);
    expect(cls).toContain("text-[11px]");
    expect(cls).toContain("whitespace-nowrap");
    expect(cls).toContain("rounded-full");
    expect(cls).toContain("border");
    expect(cls).toContain("-800");
    expect(cls).toContain("dark:text-");
    expect(cls).toContain("-300");
    // the shades the page already ruled out below AA at 11 px
    expect(cls).not.toContain("text-amber-700");
    expect(cls).not.toMatch(/\btext-[a-z]+-(?:500|600|700)\b/);
    expect(String(tag.props?.title)).toContain("bazı haberler Tayf'a ulaşmadı");
  });

  it("pins the label and the literal classes in the page source", () => {
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(src).toContain(TAG);
    expect(src).toContain("row.windowOverflowRecent");
  });

  it("never shows a raw timestamp for the overflow, the column name or a count", () => {
    const text = collectText(body(fixtures())).join(" ");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(text).not.toContain("fetch_window_overflow_at");
    expect(text).not.toMatch(/\bundefined\b|\bnull\b|NaN/);
  });
});
