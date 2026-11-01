import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Suspense, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createSupabaseFake } from "../../../tests/_helpers/supabase-fake";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
//
// next/cache: `getSources` is wrapped in `"use cache"` with cacheLife/
// cacheTag side-effects. In Vitest (no Next.js SWC transform) the directive
// is a no-op string literal; we only need the two helpers to exist.
//
// next/server: `SourcesPage` awaits `connection()` before rendering (an
// opt-in-to-dynamic-rendering signal) — mocked to resolve immediately.
//
// @/lib/supabase/server: the whole point. Replaced with the shared
// chainable Supabase fake pre-loaded with 3 active source rows spanning
// outlet/aggregator/wire kinds. `makeFakeClient` is a hoisted `function`
// declaration (not `const`) so it's safe to reference from inside the
// `vi.mock` factory below regardless of Vitest's mock-hoisting order —
// same pattern as cluster-detail-query.test.ts's `makeFakeClient`.

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));
vi.mock("next/server", () => ({
  connection: vi.fn(async () => undefined),
}));

// clickbait-karne (migration 078) — mocked independently of the real rpc
// path so this file stays focused on the source-kind UI it already covers.
// `clickbaitFixture.public` toggles the gate the same way
// isClickbaitPublic() would.
const clickbaitFixture = vi.hoisted(() => ({
  public: false,
  karne: null as unknown,
}));

vi.mock("@/lib/sources/clickbait", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sources/clickbait")>();
  return {
    ...actual,
    isClickbaitPublic: vi.fn(() => clickbaitFixture.public),
    getClickbaitKarne: vi.fn(async () => clickbaitFixture.karne),
  };
});

// sources-weight: the weekly-count aggregate is the one dependency the tests
// below need to steer (a `null` failure, a resolved map). The mock delegates to
// the real implementation by default, so every other test still reads the fake
// Supabase client; only `mockResolvedValueOnce` overrides a single call.
vi.mock("@/lib/sources/feed-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sources/feed-status")>();
  return {
    ...actual,
    getSourceItemsPerDay: vi.fn(actual.getSourceItemsPerDay),
  };
});

function makeFakeClient() {
  const sourceRows = [
    {
      id: "s-outlet",
      name: "Outlet Gazete",
      slug: "s-outlet",
      url: "https://example.com/outlet",
      rss_url: "https://example.com/outlet/rss",
      bias: "pro_government",
      logo_url: null,
      active: true,
      kind: "outlet",
      stats: [{ count: 2 }],
      latest: [],
    },
    {
      id: "s-aggregator",
      name: "Toplayıcı Site",
      slug: "s-aggregator",
      url: "https://example.com/aggregator",
      rss_url: "https://example.com/aggregator/rss",
      bias: "center",
      logo_url: null,
      active: true,
      kind: "aggregator",
      stats: [{ count: 2 }],
      latest: [],
    },
    {
      id: "s-wire",
      name: "Wire Ajans",
      slug: "s-wire",
      url: "https://example.com/wire",
      rss_url: "https://example.com/wire/rss",
      bias: "state_media",
      logo_url: null,
      active: true,
      kind: "wire",
      stats: [{ count: 2 }],
      latest: [],
    },
  ];
  return createSupabaseFake({ tables: { sources: sourceRows } }).client;
}

// ingest-hygiene (handed over from seo-error-states): flips the mocked
// client factory into a throwing one so SourcesPage's `!result.ok` branch
// (the "Kaynak listesi şu an yüklenemedi" fallback) can be exercised.
const supabaseFixture = vi.hoisted(() => ({
  fail: false,
  // Order of the reads the page starts: "directory" is pushed by the
  // directory read's createServerClient() call, "counts" by a stubbed
  // getSourceItemsPerDay (see the overlap test below).
  calls: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => {
    supabaseFixture.calls.push("directory");
    if (supabaseFixture.fail) throw new Error("supabase unavailable");
    return makeFakeClient();
  },
}));

// Import AFTER mocks are declared.
import SourcesPage, { SourceDirectory, SourceDirectoryWithCounts } from "./page";
import { SOURCE_SKELETON_CARDS, SourceDirectorySkeleton } from "./source-directory-skeleton";
import { getSourceItemsPerDay } from "@/lib/sources/feed-status";
import { DenominatorNote } from "@/components/source/denominator-note";
import { ClickbaitKarneSection } from "@/components/source/clickbait-karne";
import { getClickbaitKarne, isClickbaitPublic } from "@/lib/sources/clickbait";
import { BIAS_LABELS } from "@/lib/bias/config";

/**
 * Collects every string/number leaf under a React element tree. Expands
 * `<ClickbaitKarneSection>` the same way collectHrefs below expands
 * `<DenominatorNote>` — a one-level-deep function component whose own text
 * lives in its rendered output, not its props. Also expands
 * `<SourceDirectoryWithCounts>` and the `<SourceDirectory>` element it
 * returns (reader-queries G2: the kind-badge grid streams behind its own
 * <Suspense> boundary, two component layers deep, so neither is reachable
 * via `.props.children`) — the outer one is async, so this walker is too.
 */
async function collectText(node: unknown, out: string[] = []): Promise<string[]> {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) await collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: { children?: ReactNode; [k: string]: unknown } };
    if (el.type === ClickbaitKarneSection && el.props) {
      const props = el.props as unknown as Parameters<typeof ClickbaitKarneSection>[0];
      await collectText(ClickbaitKarneSection(props), out);
      return out;
    }
    if (el.type === SourceDirectoryWithCounts && el.props) {
      const props = el.props as unknown as Parameters<typeof SourceDirectoryWithCounts>[0];
      await collectText(await SourceDirectoryWithCounts(props), out);
      return out;
    }
    if (el.type === SourceDirectory && el.props) {
      const props = el.props as unknown as Parameters<typeof SourceDirectory>[0];
      await collectText(SourceDirectory(props), out);
      return out;
    }
    if (el.props?.children !== undefined) await collectText(el.props.children, out);
  }
  return out;
}

/**
 * Collects every `href` prop found anywhere in a React element tree.
 * Expands `<DenominatorNote>` (a one-level-deep function component whose
 * own href lives in its rendered output, not its props) so its
 * /kaynaklar/durum link is reachable without a full renderer.
 */
async function collectHrefs(node: unknown, out: string[] = []): Promise<string[]> {
  if (Array.isArray(node)) {
    for (const child of node) await collectHrefs(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as {
      type?: unknown;
      props?: { href?: unknown; children?: ReactNode; [k: string]: unknown };
    };
    if (el.type === DenominatorNote && el.props) {
      const props = el.props as unknown as Parameters<typeof DenominatorNote>[0];
      await collectHrefs(DenominatorNote(props), out);
      return out;
    }
    if (el.type === SourceDirectoryWithCounts && el.props) {
      const props = el.props as unknown as Parameters<typeof SourceDirectoryWithCounts>[0];
      await collectHrefs(await SourceDirectoryWithCounts(props), out);
      return out;
    }
    if (el.type === SourceDirectory && el.props) {
      const props = el.props as unknown as Parameters<typeof SourceDirectory>[0];
      await collectHrefs(SourceDirectory(props), out);
      return out;
    }
    if (typeof el.props?.href === "string") out.push(el.props.href);
    if (el.props?.children !== undefined) await collectHrefs(el.props.children, out);
  }
  return out;
}

// Order independence (vitest --sequence.shuffle): every test starts from the
// same fixture state no matter which test ran before it. The noindex test
// flips `supabaseFixture.fail`, the karne test flips the clickbait fixture and
// both clickbait mocks record calls, so all four are reset here, once, for the
// whole file instead of inside the one describe that happened to need it.
beforeEach(() => {
  supabaseFixture.fail = false;
  supabaseFixture.calls.length = 0;
  clickbaitFixture.public = false;
  clickbaitFixture.karne = null;
  vi.mocked(isClickbaitPublic).mockClear();
  vi.mocked(getClickbaitKarne).mockClear();
});

afterEach(() => {
  // console spies created with vi.spyOn must not outlive their test.
  vi.restoreAllMocks();
});

describe("/sources page — source-kind UI", () => {
  it("shows the classified-count line and kind badges", async () => {
    const tree = await SourcesPage();
    const text = (await collectText(tree)).join("");
    const hrefs = await collectHrefs(tree);

    expect(text).toContain("Yanlılık dağılımına sayılan: ");
    expect(text).toContain("2/3");
    expect(text).toContain("aktif kaynak");
    expect(text).toContain("Toplayıcı");
    expect(text).toContain("Ajans");
    expect(hrefs).toContain("/metodoloji#kaynaklar");
  });

  it("A-M4 / PERF-01: links to /kaynaklar/durum via the DenominatorNote, derived from the already-fetched rows with no second query", async () => {
    const tree = await SourcesPage();
    const hrefs = await collectHrefs(tree);
    const text = (await collectText(tree)).join("");

    expect(hrefs).toContain("/kaynaklar/durum");
    // Fixture: 2 voting sources (outlet + wire), neither with a
    // `latest` row, so the derived voting-delivering pair is 0/2.
    expect(text).toContain("0");
    expect(text).toContain("2");
  });
});

describe("/sources page — clickbait-karne gate", () => {
  it("with the gate closed, getClickbaitKarne is never called and there is no 'tık tuzağı' text", async () => {
    clickbaitFixture.public = false;

    const tree = await SourcesPage();
    const text = (await collectText(tree)).join(" ");

    expect(getClickbaitKarne).not.toHaveBeenCalled();
    expect(text).not.toMatch(/tık tuzağı/i);
  });

  it("with the gate open and karne present, the section renders", async () => {
    clickbaitFixture.public = true;
    clickbaitFixture.karne = {
      outlets: [
        {
          slug: "s-outlet",
          name: "Outlet Gazete",
          bias: "pro_government",
          zone: "iktidar",
          n: 300,
          nFlagged: 30,
          share: 0.1,
          meanProb: 0.4,
          tier: "low",
        },
      ],
      firstDay: "2026-09-24",
      lastDay: "2026-09-28",
      outletCount: 1,
      questionSets: ["2026-09-24.1"],
      minN: 300,
    };

    const tree = await SourcesPage();
    const text = (await collectText(tree)).join(" ");

    expect(getClickbaitKarne).toHaveBeenCalled();
    expect(text).toMatch(/tık tuzağı karnesi/i);
  });
});

/**
 * Depth-first search of a React element tree for an element of the given
 * intrinsic type (e.g. "meta"), returning its props. Only walks `children`.
 */
function findElementProps(
  node: unknown,
  type: string,
): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElementProps(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: { children?: ReactNode } };
    if (el.type === type && el.props) return el.props as Record<string, unknown>;
    if (el.props?.children !== undefined) {
      return findElementProps(el.props.children, type);
    }
  }
  return null;
}

describe("/sources page — noindex on the error state (seo-error-states)", () => {
  it("emits <meta name=robots content=noindex> as the FIRST child of the container when the directory fails to load", async () => {
    supabaseFixture.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const tree = (await SourcesPage()) as {
        props: { children: unknown[] };
      };
      const first = tree.props.children[0] as {
        type?: unknown;
        props?: Record<string, unknown>;
      };
      expect(first.type).toBe("meta");
      expect(first.props).toMatchObject({ name: "robots", content: "noindex" });

      const text = (await collectText(tree)).join(" ");
      expect(text).toContain("Kaynak listesi şu an yüklenemedi");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not emit a noindex meta on the ok path", async () => {
    supabaseFixture.fail = false;
    const tree = await SourcesPage();
    expect(findElementProps(tree, "meta")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sources-weight: the Suspense fallback used to be a full <SourceDirectory>
// (PENDING_COUNT_LABEL), so the 118-card directory shipped twice in the HTML
// (1.29 MB, 236 /source/ links on 2026-11-01). The fallback is now a light,
// link-free skeleton; the resolved UI, the sort, the count labels and the em
// dash failure path are unchanged.
// ---------------------------------------------------------------------------

type TreeElement = {
  type?: unknown;
  props?: { children?: ReactNode; fallback?: unknown; [k: string]: unknown };
};

/** Every <Suspense> reachable through `props.children` and arrays. */
function findSuspenses(node: unknown, out: TreeElement[] = []): TreeElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findSuspenses(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as TreeElement;
    if (el.type === Suspense) out.push(el);
    if (el.props?.children !== undefined) findSuspenses(el.props.children, out);
  }
  return out;
}

/** Drops block and line comments so prose cannot satisfy (or trip) a guard. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_SOURCE = readFileSync(resolve(here, "page.tsx"), "utf8");
const DIRECTORY_GRID_CLASSES =
  "grid grid-cols-1 min-[480px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3";

describe("/sources page — Suspense fallback is a light skeleton", () => {
  it("has exactly one Suspense; its fallback is the skeleton and its child still streams the counted directory", async () => {
    const tree = await SourcesPage();
    const suspenses = findSuspenses(tree);

    expect(suspenses).toHaveLength(1);
    const suspense = suspenses[0]!;

    const fallback = suspense.props?.fallback as TreeElement | undefined;
    expect(fallback?.type).toBe(SourceDirectorySkeleton);

    const child = suspense.props?.children as TreeElement | undefined;
    expect(child?.type).toBe(SourceDirectoryWithCounts);
    const grouped = child?.props?.grouped as Record<string, Array<{ slug: string }>>;
    expect(grouped.pro_government?.map((s) => s.slug)).toEqual(["s-outlet"]);
  });

  it("the page tree still reaches every source profile link through the resolved directory", async () => {
    const hrefs = await collectHrefs(await SourcesPage());

    expect(hrefs).toContain("/source/s-outlet");
    expect(hrefs).toContain("/source/s-aggregator");
    expect(hrefs).toContain("/source/s-wire");
    // One profile link per source: the fallback adds none.
    expect(hrefs.filter((h) => h.startsWith("/source/"))).toHaveLength(3);
  });
});

describe("SourceDirectorySkeleton", () => {
  const markup = renderToStaticMarkup(createElement(SourceDirectorySkeleton));

  it("carries no links, images or count copy (nothing a crawler or the HTML weight can count twice)", () => {
    expect(markup).not.toContain("href=");
    expect(markup).not.toContain("<a");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("son 7 günde");
  });

  it("renders SOURCE_SKELETON_CARDS (8) placeholder cards", () => {
    expect(SOURCE_SKELETON_CARDS).toBe(8);
    expect(markup.split("data-skeleton-card").length - 1).toBe(8);
  });

  it("announces loading once through a polite sr-only status, outside the aria-hidden placeholder", () => {
    const status = /<p(?=[^>]*role="status")(?=[^>]*class="[^"]*\bsr-only\b)[^>]*>Kaynak listesi yükleniyor…<\/p>/.exec(
      markup,
    );
    expect(status).not.toBeNull();

    const hidden = /<section(?=[^>]*aria-hidden="true")[^>]*>/.exec(markup);
    expect(hidden).not.toBeNull();
    expect(status!.index).toBeLessThan(hidden!.index);
    // Every card sits inside the hidden placeholder, none before it.
    expect(markup.indexOf("data-skeleton-card")).toBeGreaterThan(hidden!.index);
    expect(markup.match(/aria-hidden="true"/g)).toHaveLength(1);
  });

  it("reuses the directory grid classes and reserves height so the footer does not jump", () => {
    expect(markup).toContain(DIRECTORY_GRID_CLASSES);
    expect(markup).toContain("min-h-[60vh]");
  });

  it("only pulses when the reader allows motion", () => {
    expect(markup).toContain("motion-safe:animate-pulse");
    expect(markup).not.toMatch(/(?<!motion-safe:)animate-pulse/);
  });

  it("stays light: well under 4 kB of markup", () => {
    expect(markup.length).toBeLessThan(4000);
  });
});

describe("/sources page source — the directory is not rendered twice", () => {
  const code = stripComments(PAGE_SOURCE);
  // `\b` after the name: <SourceDirectorySkeleton> and <SourceDirectoryWithCounts>
  // are different components and must not trip the guard.
  const FULL_DIRECTORY_FALLBACK = /fallback\s*=\s*\{\s*<\s*SourceDirectory\b/;

  it("never uses a full <SourceDirectory> as the Suspense fallback", () => {
    expect(code).not.toMatch(FULL_DIRECTORY_FALLBACK);
  });

  it("the fallback pattern tolerates JSX line breaks but does not flag the skeleton", () => {
    expect("fallback={\n  <SourceDirectory\n    grouped={x}").toMatch(FULL_DIRECTORY_FALLBACK);
    expect("fallback={<SourceDirectory grouped={x} />}").toMatch(FULL_DIRECTORY_FALLBACK);
    expect("fallback={<SourceDirectorySkeleton />}").not.toMatch(FULL_DIRECTORY_FALLBACK);
    expect("fallback={<SourceDirectoryWithCounts />}").not.toMatch(FULL_DIRECTORY_FALLBACK);
  });

  it("has dropped PENDING_COUNT_LABEL", () => {
    expect(code).not.toContain("PENDING_COUNT_LABEL");
  });

  it("still streams <SourceDirectoryWithCounts> behind the one Suspense, handing it the counts promise", () => {
    expect(code).toContain(
      "<SourceDirectoryWithCounts grouped={grouped} perDay={perDayPromise} />",
    );
  });

  it("starts the weekly-count read before awaiting the directory read, and only there", () => {
    const start = code.indexOf("const perDayPromise = getSourceItemsPerDay()");
    const directory = code.indexOf("await getSourcesSafe()");
    expect(start).toBeGreaterThan(-1);
    expect(directory).toBeGreaterThan(-1);
    expect(start).toBeLessThan(directory);
    // The streamed child awaits the promise it is given; a second call there
    // would put the counts read back behind the directory read.
    expect(code.match(/getSourceItemsPerDay\(\)/g)).toHaveLength(1);
  });

  it("stripComments removes prose so a comment cannot satisfy or trip the guards", () => {
    const stripped = stripComments(
      'const a = "https://x.y"; // fallback={<SourceDirectory\n/* PENDING_COUNT_LABEL */ const b = 1;',
    );
    expect(stripped).toContain('"https://x.y"');
    expect(stripped).not.toContain("fallback=");
    expect(stripped).not.toContain("PENDING_COUNT_LABEL");
  });
});

describe("SourceDirectoryWithCounts — count labels (unchanged contract)", () => {
  // The page starts the counts read itself (before the directory read), so the
  // stub must be queued BEFORE SourcesPage() runs, not before the child renders.
  async function renderedText(
    perDay: Record<string, number> | null,
  ): Promise<string> {
    vi.mocked(getSourceItemsPerDay).mockResolvedValueOnce(perDay);
    const tree = await SourcesPage();
    const child = findSuspenses(tree)[0]?.props?.children as TreeElement;
    const props = child.props as unknown as Parameters<typeof SourceDirectoryWithCounts>[0];
    return (await collectText(await SourceDirectoryWithCounts(props))).join(" ");
  }

  it("a failed aggregate (null) renders the em dash for every source, never a fabricated 0", async () => {
    const text = await renderedText(null);

    expect(text).toContain("son 7 günde — haber");
    expect(text).not.toMatch(/son 7 günde \d+ haber/);
    expect(text).not.toContain("…");
  });

  it("a resolved map renders weekly numbers; a source missing from the map reads as 0", async () => {
    const text = await renderedText({ "s-outlet": 1 });

    expect(text).toContain("son 7 günde 7 haber");
    expect(text).toContain("son 7 günde 0 haber");
    expect(text).not.toContain("son 7 günde — haber");
  });
});

describe("/sources page — the weekly counts overlap the directory read (cold path)", () => {
  it("starts the counts read before the directory read, so a cache miss costs max(), not the sum", async () => {
    vi.mocked(getSourceItemsPerDay).mockImplementationOnce(async () => {
      supabaseFixture.calls.push("counts");
      return null;
    });

    await SourcesPage();

    expect(supabaseFixture.calls[0]).toBe("counts");
    expect(supabaseFixture.calls).toContain("directory");
  });

  it("reads the counts exactly once: the streamed child awaits the page's promise instead of asking again", async () => {
    vi.mocked(getSourceItemsPerDay).mockClear();
    vi.mocked(getSourceItemsPerDay).mockResolvedValueOnce({ "s-outlet": 2 });

    const tree = await SourcesPage();
    const child = findSuspenses(tree)[0]?.props?.children as TreeElement;
    const props = child.props as unknown as Parameters<typeof SourceDirectoryWithCounts>[0];
    const text = (await collectText(await SourceDirectoryWithCounts(props))).join(" ");

    expect(getSourceItemsPerDay).toHaveBeenCalledTimes(1);
    expect(text).toContain("son 7 günde 14 haber");
  });

  it("the child shows the directory as soon as the page's promise settles, even when the read is slow", async () => {
    let release!: (v: Record<string, number>) => void;
    vi.mocked(getSourceItemsPerDay).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const tree = await SourcesPage(); // the page itself never waits for the counts
    const child = findSuspenses(tree)[0]?.props?.children as TreeElement;
    const props = child.props as unknown as Parameters<typeof SourceDirectoryWithCounts>[0];
    const rendering = SourceDirectoryWithCounts(props);
    release({ "s-wire": 3 });

    const text = (await collectText(await rendering)).join(" ");
    expect(text).toContain("son 7 günde 21 haber");
  });

  it("an unused counts promise (error state) is harmless: it resolves null and nothing is thrown", async () => {
    supabaseFixture.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(SourcesPage()).resolves.toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Card a11y (WCAG 2.5.3 label in name, 2.5.8 target size). The card link used to
// carry aria-label="<name> profili", which replaced the whole visible text (bias
// label, count, time) in the accessible name. It now has no aria-label, so its
// name is its visible text. The external "↗" link is a 24 x 24 target.
// ---------------------------------------------------------------------------

type GroupedSources = Parameters<typeof SourceDirectory>[0]["grouped"];

const GZT = {
  id: "gzt",
  name: "GZT",
  slug: "gzt",
  url: "https://example.com/gzt",
  rss_url: "https://example.com/gzt/rss",
  bias: "pro_government",
  logo_url: "https://example.com/gzt.png",
  active: true,
  kind: "outlet",
  image_allowed: true,
  excerpt_allowed: true,
  trustee_since: null,
  trustee_note: null,
  lastPublishedAt: null,
};

describe("SourceDirectory card -- accessible name and target size", () => {
  const markup = renderToStaticMarkup(
    createElement(SourceDirectory, {
      grouped: { pro_government: [GZT] } as unknown as GroupedSources,
      countLabel: "12 haber",
    }),
  );

  const cardOpen = /<a\b[^>]*\bhref="\/source\/gzt"[^>]*>/.exec(markup);
  const cardStart = cardOpen?.index ?? -1;
  const cardEnd = markup.indexOf("</a>", cardStart);
  const cardTag = cardOpen?.[0] ?? "";
  const cardInner = markup.slice(cardStart + cardTag.length, cardEnd);

  const externalOpen = /<a\b[^>]*\bhref="https:\/\/example\.com\/gzt"[^>]*>/.exec(markup);
  const externalTag = externalOpen?.[0] ?? "";
  const externalInner = externalOpen
    ? markup.slice(
        externalOpen.index + externalTag.length,
        markup.indexOf("</a>", externalOpen.index),
      )
    : "";

  const tokensOf = (tag: string) =>
    (/\bclass="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean);

  it("finds the card link and the external link", () => {
    expect(cardOpen).not.toBeNull();
    expect(cardEnd).toBeGreaterThan(cardStart);
    expect(externalOpen).not.toBeNull();
  });

  it("(2.5.3) the card link has no aria-label, so its name is its visible text", () => {
    expect(cardTag).not.toContain("aria-label");
    expect(markup).not.toContain("profili");
  });

  it("(2.5.3) the card link's text holds the name, the bias label and the count", () => {
    const text = cardInner.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("GZT");
    expect(text).toContain(BIAS_LABELS.pro_government);
    expect(text).toContain("12 haber");
  });

  it("the logo inside the card link is decorative: every alt is empty", () => {
    const alts = [...cardInner.matchAll(/\balt=("[^"]*")/g)].map((m) => m[1]);
    expect(alts.length).toBeGreaterThan(0);
    for (const alt of alts) expect(alt).toBe('""');
  });

  it("(2.5.8) the external link is a 24 x 24 target in the corner, named for what it opens", () => {
    expect(externalTag).toContain('aria-label="GZT sitesini yeni sekmede aç"');
    expect(externalTag).toContain('target="_blank"');
    expect(externalTag).toContain('rel="noopener noreferrer"');
    const tokens = tokensOf(externalTag);
    for (const token of ["inline-flex", "min-h-6", "min-w-6", "top-2", "right-2"]) {
      expect(tokens).toContain(token);
    }
    expect(externalInner).toBe('<span aria-hidden="true">↗</span>');
  });

  it("(e) the name leaves room for the 24 px corner link: pr-7, not pr-5", () => {
    const namePara = /<p class="([^"]*)">GZT<\/p>/.exec(markup);
    expect(namePara).not.toBeNull();
    const tokens = (namePara?.[1] ?? "").split(/\s+/);
    expect(tokens).toContain("pr-7");
    expect(tokens).not.toContain("pr-5");
  });
});
