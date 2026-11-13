import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Link from "next/link";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntityHub } from "@/lib/entities/entity-hub-query";
import { risingHint, type RisingItem, type RisingResult } from "@/lib/trends/rising";

// ---------------------------------------------------------------------------
// h170-roadmap-3: the compact "Yükselen konular" rail on page 1 of the home feed.
// The read and the markup are two pieces: loadRisingRail does the reads (HomeFeed
// starts it next to the feed read, so the rail's data is not waiting for the feed to
// finish rendering) and RisingRail awaits that promise and paints. RisingRail is an
// async server component: it is called directly and the element tree it returns is
// read (props, text) or rendered to markup. The two readers loadRisingRail uses are
// mocked wholesale, as in src/app/trends/page.test.tsx: getRisingEntities is the SAME
// cached entry /trends reads, and getEntityHub is the per-key hub read.
// ---------------------------------------------------------------------------

let mockRising: RisingResult | null = null;
let mockHubs: Record<string, unknown> = {};

vi.mock("@/lib/trends/rising-query", () => ({
  getRisingEntities: vi.fn(async () => mockRising),
}));

vi.mock("@/lib/entities/entity-hub-query", () => ({
  getEntityHub: vi.fn(async (key: string) => mockHubs[key] ?? null),
}));

import { getEntityHub } from "@/lib/entities/entity-hub-query";
import { getRisingEntities } from "@/lib/trends/rising-query";
import { RisingRail, loadRisingRail } from "./rising-rail";

type Elementish = { type?: unknown; props?: Record<string, unknown> };

function collectElements(node: unknown, out: Elementish[] = []): Elementish[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as Elementish;
    if (el.type !== undefined) out.push(el);
    if (el.props?.children !== undefined) collectElements(el.props.children, out);
  }
  return out;
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object") return textOf((node as Elementish).props?.children);
  return "";
}

const tokens = (el: Elementish): string[] =>
  String(el.props?.className ?? "")
    .split(" ")
    .filter(Boolean);

/** A hub read holding `n` bundles (only the length is read). */
function hubWith(n: number): EntityHub {
  return { bundles: Array.from({ length: n }, () => ({})), total: n, asOfMs: 0 } as unknown as EntityHub;
}

function item(key: string, label: string, over: Partial<RisingItem> = {}): RisingItem {
  return {
    key,
    label,
    href: `/gundem/${key}`,
    count: 15,
    baseline: 3,
    ratio: 5,
    ratioLabel: "5,0",
    ratioIsLowerBound: false,
    isNew: false,
    ...over,
  };
}

function ok(items: RisingItem[], day = "2026-11-12"): RisingResult {
  return { status: "ok", day, items };
}

/** Eight distinct rising rows, every hub indexable unless a test says otherwise. */
function eight(): RisingItem[] {
  return Array.from({ length: 8 }, (_, i) => item(`k${i}`, `Konu ${i}`));
}

function allHubsIndexable(items: RisingItem[]): void {
  mockHubs = Object.fromEntries(items.map((i) => [i.key, hubWith(9)]));
}

/** The rail's element tree, or null when it renders nothing: the page's own pairing, the read handed to the component. */
async function rail() {
  return RisingRail({ data: loadRisingRail() });
}

function links(tree: unknown): Elementish[] {
  return collectElements(tree).filter((el) => el.type === Link);
}

beforeEach(() => {
  mockRising = null;
  mockHubs = {};
  vi.mocked(getRisingEntities).mockClear();
  vi.mocked(getEntityHub).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RisingRail: absent when there is nothing to show", () => {
  it("returns null for a failed read (null)", async () => {
    mockRising = null;
    expect(await rail()).toBeNull();
  });

  it("returns null for insufficient history (any status other than ok)", async () => {
    mockRising = { status: "insufficient" };
    expect(await rail()).toBeNull();
  });

  it("returns null for an ok result with no rows, and reads no hub", async () => {
    mockRising = ok([]);
    expect(await rail()).toBeNull();
    expect(getEntityHub).not.toHaveBeenCalled();
  });

  it("returns null when the rising read throws, so nothing reaches the error boundary", async () => {
    vi.mocked(getRisingEntities).mockRejectedValueOnce(new Error("cache read failed"));
    await expect(rail()).resolves.toBeNull();
  });

  it("returns null when a hub read throws", async () => {
    mockRising = ok([item("msb", "MSB")]);
    vi.mocked(getEntityHub).mockRejectedValueOnce(new Error("db down"));
    await expect(rail()).resolves.toBeNull();
  });

  it("logs a failed read once and does not log the happy path", async () => {
    mockRising = ok([item("msb", "MSB")]);
    allHubsIndexable(mockRising.status === "ok" ? mockRising.items : []);
    await rail();
    expect(console.warn).not.toHaveBeenCalled();

    vi.mocked(getRisingEntities).mockRejectedValueOnce(new Error("cache read failed"));
    await rail();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe("loadRisingRail", () => {
  it("resolves the linked rows: at most 6, each href settled against its hub, one read of the shared entry", async () => {
    mockRising = ok(eight());
    allHubsIndexable(eight());

    const items = await loadRisingRail();

    expect(items).not.toBeNull();
    expect(items!.map((i) => i.href)).toEqual(Array.from({ length: 6 }, (_, i) => `/gundem/k${i}`));
    expect(getRisingEntities).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getEntityHub).mock.calls.map((c) => c[0])).toEqual(
      Array.from({ length: 6 }, (_, i) => `k${i}`),
    );
  });

  it("resolves null, and reads no hub, for a failed read, thin history or no rows", async () => {
    mockRising = null;
    expect(await loadRisingRail()).toBeNull();
    mockRising = { status: "insufficient" };
    expect(await loadRisingRail()).toBeNull();
    mockRising = ok([]);
    expect(await loadRisingRail()).toBeNull();
    expect(getEntityHub).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("resolves null, never rejects, when getRisingEntities throws", async () => {
    vi.mocked(getRisingEntities).mockRejectedValueOnce(new Error("cache read failed"));
    await expect(loadRisingRail()).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("resolves null, never rejects, when a hub read throws", async () => {
    mockRising = ok([item("msb", "MSB"), item("chp", "CHP")]);
    vi.mocked(getEntityHub).mockRejectedValueOnce(new Error("db down"));
    await expect(loadRisingRail()).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("returns a promise that is already running: the read starts when it is called, not when the component awaits it", async () => {
    mockRising = ok([item("msb", "MSB")]);
    allHubsIndexable([item("msb", "MSB")]);

    const data = loadRisingRail();

    expect(getRisingEntities).toHaveBeenCalledTimes(1);
    await data;
  });
});

describe("RisingRail: takes its rows from the data prop", () => {
  it("renders nothing for null and for an empty list, without reading anything itself", async () => {
    expect(await RisingRail({ data: Promise.resolve(null) })).toBeNull();
    expect(await RisingRail({ data: Promise.resolve([]) })).toBeNull();
    expect(getRisingEntities).not.toHaveBeenCalled();
    expect(getEntityHub).not.toHaveBeenCalled();
  });

  it("renders the rows it is handed, in order, plus 'Tümü'", async () => {
    const rows = [item("msb", "MSB"), item("chp", "CHP")];
    const all = links(await RisingRail({ data: Promise.resolve(rows) }));
    expect(all.map((l) => l.props?.href)).toEqual(["/gundem/msb", "/gundem/chp", "/trends"]);
    expect(getRisingEntities).not.toHaveBeenCalled();
  });

  it("waits for the promise: a rail whose data is still pending has not rendered", async () => {
    let release: (v: RisingItem[] | null) => void = () => {};
    const data = new Promise<RisingItem[] | null>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const pending = RisingRail({ data }).then((tree) => {
      settled = true;
      return tree;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    release([item("msb", "MSB")]);
    expect(await pending).not.toBeNull();
  });
});

describe("RisingRail: the landmark", () => {
  it("renders one <aside aria-label='Yükselen konular'> with a small h2 in the section-label style", async () => {
    mockRising = ok([item("msb", "MSB")]);
    allHubsIndexable([item("msb", "MSB")]);

    const tree = await rail();

    const asides = collectElements(tree).filter((el) => el.type === "aside");
    expect(asides).toHaveLength(1);
    expect(asides[0]!.props?.["aria-label"]).toBe("Yükselen konular");
    const headings = collectElements(tree).filter((el) => el.type === "h2");
    expect(headings).toHaveLength(1);
    expect(textOf(headings[0])).toBe("Yükselen konular");
    for (const token of ["font-serif", "text-sm", "font-semibold", "uppercase", "tracking-wider", "text-muted-foreground"]) {
      expect(tokens(headings[0]!)).toContain(token);
    }
    // No other heading level: the page outline stays h1 > h2 (section) > h3 (story).
    expect(collectElements(tree).filter((el) => el.type === "h1" || el.type === "h3")).toHaveLength(0);
  });

  it("lists the chips in one <ul>, one <li> per link", async () => {
    mockRising = ok([item("msb", "MSB"), item("chp", "CHP")]);
    allHubsIndexable([item("msb", "MSB"), item("chp", "CHP")]);

    const html = renderToStaticMarkup((await rail()) as ReactNode);

    expect(html.split("<ul").length - 1).toBe(1);
    expect(html.split("<li").length - 1).toBe(3); // two chips + 'Tümü'
  });
});

describe("RisingRail: the chips", () => {
  it("each chip is a Link: the label, then the same hint /trends prints", async () => {
    const rows = [
      item("erdogan", "Erdoğan"),
      item("tcmb", "Merkez Bankası", { ratioIsLowerBound: true, ratioLabel: "6,5" }),
      item("hamas", "Hamas", { isNew: true }),
    ];
    mockRising = ok(rows);
    allHubsIndexable(rows);

    const chips = links(await rail()).slice(0, -1);

    expect(chips.map(textOf)).toEqual([
      "Erdoğan 7 günlük ortalamanın 5,0 katı",
      "Merkez Bankası 7 günlük ortalamanın en az 6,5 katı",
      "Hamas geçen hafta neredeyse hiç yoktu",
    ]);
    expect(chips.map(textOf)).toEqual(rows.map((r) => `${r.label} ${risingHint(r)}`));
  });

  it("the href is the /gundem hub when it is indexable and the /?q= search when it is thin, empty or unreadable", async () => {
    const rows = [
      item("msb", "MSB"),
      item("tcmb", "Merkez Bankası"),
      item("hamas", "Hamas"),
      item("meclis", "Meclis"),
    ];
    mockRising = ok(rows);
    mockHubs = { msb: hubWith(9), tcmb: hubWith(1), hamas: hubWith(0) }; // meclis: failed read

    const hrefs = links(await rail())
      .slice(0, -1)
      .map((l) => l.props?.href);

    expect(hrefs).toEqual(["/gundem/msb", "/?q=Merkez%20Bankas%C4%B1", "/?q=Hamas", "/?q=Meclis"]);
  });

  it("no link prefetches: chips and 'Tümü' all carry prefetch={false} (#291)", async () => {
    mockRising = ok(eight());
    allHubsIndexable(eight());

    const all = links(await rail());

    expect(all.length).toBeGreaterThan(1);
    for (const l of all) expect(l.props?.prefetch).toBe(false);
  });

  it("shows at most 6 chips, in the order the ranking gave them, and reads only those 6 hubs", async () => {
    mockRising = ok(eight());
    allHubsIndexable(eight());

    const chips = links(await rail()).slice(0, -1);

    expect(chips).toHaveLength(6);
    expect(chips.map((c) => c.props?.href)).toEqual(Array.from({ length: 6 }, (_, i) => `/gundem/k${i}`));
    expect(vi.mocked(getEntityHub).mock.calls.map((c) => c[0])).toEqual(
      Array.from({ length: 6 }, (_, i) => `k${i}`),
    );
  });

  it("shows every chip when there are fewer than 6", async () => {
    mockRising = ok(eight().slice(0, 2));
    allHubsIndexable(eight());

    expect(links(await rail())).toHaveLength(3); // two chips + 'Tümü'
  });

  it("a chip is 44 px high on a phone and 24 px from sm (WCAG 2.5.8), colour tokens only", async () => {
    mockRising = ok([item("msb", "MSB")]);
    allHubsIndexable([item("msb", "MSB")]);

    for (const l of links(await rail())) {
      expect(tokens(l)).toContain("min-h-6");
      expect(tokens(l)).toContain("max-sm:min-h-11");
      expect(tokens(l)).toContain("inline-flex");
    }
    const html = renderToStaticMarkup((await rail()) as ReactNode);
    // WCAG 1.4.3: no alpha text token, no element opacity (tests/guards/text-contrast-tokens.test.ts).
    expect(/\btext-(?:muted-foreground|brand)\/\d+/.test(html)).toBe(false);
    expect(/(?<![\w:/-])opacity-/.test(html)).toBe(false);
  });

  it("escapes a label (it is a React child, never HTML)", async () => {
    const rows = [item("x", "<b>x</b>")];
    mockRising = ok(rows);
    allHubsIndexable(rows);

    const html = renderToStaticMarkup((await rail()) as ReactNode);

    expect(html.includes("<b>x</b>")).toBe(false);
    expect(html.includes("&lt;b&gt;x&lt;/b&gt;")).toBe(true);
  });

  it("names no day and no count: a cached result is served past Istanbul midnight, so no 'Bugün' or 'Dün'", async () => {
    mockRising = ok([item("msb", "MSB", { count: 1234 })]);
    allHubsIndexable([item("msb", "MSB")]);

    const html = renderToStaticMarkup((await rail()) as ReactNode);

    expect(html.includes("Bugün")).toBe(false);
    expect(html.includes("Dün")).toBe(false);
    expect(html.includes("1.234")).toBe(false);
    expect(html.includes("1234")).toBe(false);
  });
});

describe("RisingRail: 'Tümü'", () => {
  it("ends the row with a link to /trends whose name starts with the visible text", async () => {
    mockRising = ok([item("msb", "MSB"), item("chp", "CHP")]);
    allHubsIndexable([item("msb", "MSB"), item("chp", "CHP")]);

    const all = links(await rail());
    const last = all[all.length - 1]!;

    expect(last.props?.href).toBe("/trends");
    expect(textOf(last).startsWith("Tümü")).toBe(true);
    // Discernible out of context (a link list says "Tümü yükselen konular"): the extra words are sr-only.
    expect(textOf(last)).toBe("Tümü yükselen konular");
    expect(collectElements(last).some((el) => el.type === "span" && tokens(el).includes("sr-only"))).toBe(true);
  });

  it("is the only link to /trends and comes after every chip", async () => {
    mockRising = ok(eight());
    allHubsIndexable(eight());

    const all = links(await rail());

    expect(all.filter((l) => l.props?.href === "/trends")).toHaveLength(1);
    expect(all[all.length - 1]!.props?.href).toBe("/trends");
  });
});

describe("RisingRail: shared data", () => {
  it("reads the rising list once per render: the same getRisingEntities entry /trends reads, no second computation", async () => {
    mockRising = ok([item("msb", "MSB")]);
    allHubsIndexable([item("msb", "MSB")]);

    await rail();

    expect(getRisingEntities).toHaveBeenCalledTimes(1);
  });
});

describe("RisingRail: HTML weight", () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;

  async function markup(n: number): Promise<string> {
    const rows = eight().slice(0, n);
    mockRising = ok(rows);
    allHubsIndexable(rows);
    return renderToStaticMarkup((await rail()) as ReactNode);
  }

  it("a typical day (1 or 2 rising topics) adds under 2 KB of HTML", async () => {
    expect(bytes(await markup(1))).toBeLessThan(2048);
    expect(bytes(await markup(2))).toBeLessThan(2048);
  });

  it("the 6-chip ceiling stays under 3.5 KB, and each further chip costs under 400 bytes", async () => {
    const one = bytes(await markup(1));
    const two = bytes(await markup(2));
    const six = bytes(await markup(6));
    expect(six).toBeLessThan(3584);
    expect(two - one).toBeLessThan(400);
    // The rail stops growing at 6: rows 7 and 8 add nothing.
    expect(await markup(8)).toBe(await markup(6));
    expect((await markup(8)).includes("Konu 6")).toBe(false);
  });
});
