import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// A-M4: no test file existed for /kaynaklar/durum before. Covers the
// rows / null / empty-array branches of the default export, plus the
// KaynakDurumBody / ItemsPerDayCell named exports (page.tsx exports them
// specifically so this file doesn't need a full React renderer capable of
// resolving async Server Components).
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
  createServerClient: () => ({
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

import KaynakDurumPage, {
  KaynakDurumBody,
  ItemsPerDayCell,
} from "./page";
import {
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

const NOW = Date.parse("2026-09-18T12:00:00.000Z");

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

describe("KaynakDurumPage (default export)", () => {
  it("renders the honest 'durum bilinmiyor' state when the query errors (never fabricates a table)", async () => {
    fixture.data = [];
    fixture.error = { message: "canceling statement due to statement timeout" };

    const tree = await KaynakDurumPage();
    const text = collectText(tree).join(" ");

    expect(text).toContain("Kaynak durumu şu anda bilinmiyor");
  });

  it("renders the table shell for a successful, non-empty response", async () => {
    fixture.data = [rawRow()];
    fixture.error = null;

    const tree = await KaynakDurumPage();
    const text = collectText(tree).join(" ");

    expect(text).toContain("Örnek Kaynak");
    expect(text).not.toContain("Kaynak durumu şu anda bilinmiyor");
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
      const th = elements(body(fixtures())).find((e) => e.type === "th" && textOf(e) === "Kaynak");
      expect(th, "Kaynak <th>").toBeDefined();
      const cls = classOf(th);
      expect(cls).toContain("sticky left-0");
      expect(tokens(cls)).toContain("z-10");
      expect(tokens(cls)).toContain("bg-card");
    });

    it("every row's name cell is sticky on an opaque card background", () => {
      const tree = body(fixtures());
      for (const slug of ["donmus", "engelli", "sakin", "aktif"]) {
        const firstCell = elements(rowOf(tree, slug)).find((e) => e.type === "td");
        expect(firstCell, `${slug} first <td>`).toBeDefined();
        const cls = classOf(firstCell);
        expect(cls, slug).toContain("sticky left-0");
        expect(tokens(cls), slug).toContain("z-10");
        expect(tokens(cls), slug).toContain("bg-card");
        expect(textOf(firstCell)).toContain("Haber");
      }
    });

    it("only the first column is sticky", () => {
      const tree = body(fixtures());
      const cells = elements(rowOf(tree, "aktif")).filter((e) => e.type === "td");
      expect(cells.length).toBeGreaterThan(1);
      for (const cell of cells.slice(1)) expect(classOf(cell)).not.toContain("sticky");
      const heads = elements(tree).filter((e) => e.type === "th");
      for (const th of heads.filter((h) => textOf(h) !== "Kaynak")) {
        expect(classOf(th)).not.toContain("sticky");
      }
    });

    it("the sticky cells sit inside the scroll region and the card behind them is opaque", () => {
      const tree = body(fixtures());
      const region = elements(tree).find((e) => e.props?.role === "region");
      expect(region, "scroll region").toBeDefined();
      expect(classOf(region)).toContain("overflow-x-auto");
      expect(elements(region).some((e) => e.type === "th" && textOf(e) === "Kaynak")).toBe(true);

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

  it("renders the pointer in the page tree for both the data and the unavailable state", async () => {
    fixture.data = [rawRow()];
    fixture.error = null;
    const ok = collectText(await KaynakDurumPage()).join(" ");
    expect(ok).toContain("Haber akışının genel durumu için");

    fixture.data = [];
    fixture.error = { message: "canceling statement due to statement timeout" };
    const down = collectText(await KaynakDurumPage()).join(" ");
    expect(down).toContain("Haber akışının genel durumu için");
  });
});
