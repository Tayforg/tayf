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
  // `latest` is the embed the directory read selects (newest article in the
  // 7-day window). Empty unless a test sets `supabaseFixture.latestBySlug`.
  const latestOf = (slug: string) => {
    const publishedAt = supabaseFixture.latestBySlug[slug];
    return publishedAt ? [{ published_at: publishedAt }] : [];
  };
  // `created_at` / `zone_rationale_at` feed the dataset's dateModified. A slug
  // missing from createdAtBySlug gets DEFAULT_CREATED_AT; an explicit null
  // models a NULL column. zone_rationale_at is NULL unless a test sets it.
  const createdAtOf = (slug: string) =>
    slug in supabaseFixture.createdAtBySlug
      ? (supabaseFixture.createdAtBySlug[slug] ?? null)
      : "2025-01-01T00:00:00Z";
  const rationaleAtOf = (slug: string) =>
    supabaseFixture.rationaleBySlug[slug] ?? null;
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
      latest: latestOf("s-outlet"),
      created_at: createdAtOf("s-outlet"),
      zone_rationale_at: rationaleAtOf("s-outlet"),
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
      latest: latestOf("s-aggregator"),
      created_at: createdAtOf("s-aggregator"),
      zone_rationale_at: rationaleAtOf("s-aggregator"),
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
      latest: latestOf("s-wire"),
      created_at: createdAtOf("s-wire"),
      zone_rationale_at: rationaleAtOf("s-wire"),
    },
  ];
  return createSupabaseFake({
    tables: {
      // Like PostgREST, return only the columns the query selects: a page that
      // forgets `created_at, zone_rationale_at` in its select string must not
      // be rescued by a fake that hands them over anyway.
      sources: (state) => {
        if (supabaseFixture.sourcesError) {
          return { data: null, error: { message: supabaseFixture.sourcesError } };
        }
        const selected = String(state.selectArgs[0] ?? "")
          .split(",")
          .map((column) => column.trim());
        return {
          data: sourceRows.map((row) => {
            const out: Record<string, unknown> = { ...row };
            for (const column of ["created_at", "zone_rationale_at"]) {
              if (!selected.includes(column)) delete out[column];
            }
            return out;
          }),
          error: null,
        };
      },
      // Append-only zone history (migration 055). Mirrors the query it is
      // given: ordered by changed_at when asked, cut to `.limit(n)`.
      source_zone_history: (state) => {
        supabaseFixture.historyQueries.push({
          select: String(state.selectArgs[0] ?? ""),
          order: state.order.map((o) => ({
            col: o.col,
            ascending:
              (o.opts as { ascending?: boolean } | undefined)?.ascending ?? true,
          })),
          limit: state.limit,
        });
        if (supabaseFixture.historyError) {
          return { data: null, error: { message: supabaseFixture.historyError } };
        }
        let rows = supabaseFixture.history.map((h) => ({ changed_at: h.changed_at }));
        const byChangedAt = state.order.find((o) => o.col === "changed_at");
        if (byChangedAt) {
          const ascending =
            (byChangedAt.opts as { ascending?: boolean } | undefined)?.ascending ?? true;
          rows = rows.sort(
            (a, b) =>
              (Date.parse(a.changed_at) - Date.parse(b.changed_at)) *
              (ascending ? 1 : -1),
          );
        }
        if (state.limit !== null) rows = rows.slice(0, state.limit);
        return { data: rows, error: null };
      },
    },
  }).client;
}

// ingest-hygiene (handed over from seo-error-states): flips the mocked
// client factory into a throwing one so SourcesPage's `!result.ok` branch
// (the "Kaynak listesi şu an yüklenemedi" fallback) can be exercised.
const supabaseFixture = vi.hoisted(() => ({
  fail: false,
  /** slug -> ISO published_at of the source's newest article in the window. */
  latestBySlug: {} as Record<string, string>,
  /** slug -> created_at; a slug that is absent gets a fixed old default, null models a NULL column. */
  createdAtBySlug: {} as Record<string, string | null>,
  /** slug -> zone_rationale_at; an absent slug is NULL. */
  rationaleBySlug: {} as Record<string, string | null>,
  /** Rows of source_zone_history (the reader asks for the newest one). */
  history: [] as Array<{ changed_at: string }>,
  /** When set, the source_zone_history read resolves { data: null, error: { message } }. */
  historyError: null as string | null,
  /** When set, the sources directory read resolves { data: null, error: { message } }. */
  sourcesError: null as string | null,
  /** What each source_zone_history query asked for (select, order, limit). */
  historyQueries: [] as Array<{
    select: string;
    order: Array<{ col: string; ascending: boolean }>;
    limit: number | null;
  }>,
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
import SourcesPage, {
  SourceDirectory,
  SourceDirectoryWithCounts,
  deriveDirectoryStats,
  registryModifiedAt,
} from "./page";
import { SOURCE_SKELETON_CARDS, SourceDirectorySkeleton } from "./source-directory-skeleton";
import { getSourceItemsPerDay } from "@/lib/sources/feed-status";
import { DenominatorNote } from "@/components/source/denominator-note";
import { ClickbaitKarneSection } from "@/components/source/clickbait-karne";
import { getClickbaitKarne, isClickbaitPublic } from "@/lib/sources/clickbait";
import { BIAS_LABELS } from "@/lib/bias/config";
import { FEED_YIELD_WINDOW_MS } from "@/lib/clusters/feed-health";
import { formatTurkishTimeAgo } from "@/lib/time";

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
  supabaseFixture.latestBySlug = {};
  // Old stamps on every row, one rationale: well before any date a test asserts.
  supabaseFixture.createdAtBySlug = {};
  supabaseFixture.rationaleBySlug = { "s-aggregator": "2025-06-15T00:00:00Z" };
  supabaseFixture.history = [];
  supabaseFixture.historyError = null;
  supabaseFixture.sourcesError = null;
  supabaseFixture.historyQueries.length = 0;
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

  it("groups a four-digit weekly count the Turkish way (1.689, not 1689)", async () => {
    // The map is per-day keyed by source id; the page multiplies by 7.
    const text = await renderedText({ "s-outlet": 1689 / 7 });

    expect(text).toContain("son 7 günde 1.689 haber");
    expect(text).not.toContain("son 7 günde 1689 haber");
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
  lastSeenLabel: null,
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

  // h16-mobile-2: the 24 px corner arrow is the WCAG 2.5.8 minimum, but on a
  // phone it is a thumb-sized miss next to the card link. Below sm it becomes
  // a 44 x 44 box in the card's corner (top-0 right-0); the card link gives up
  // 28 px of its right edge (card padding 16 + 28 = 44) so the two boxes touch
  // without overlapping, and the name's own pr-7 reservation is dropped so the
  // space is not reserved twice. sm and up renders exactly as before.
  it("(mobile 44 px) the external link is a 44 x 44 corner box below sm and keeps the 24 px box from sm up", () => {
    const tokens = tokensOf(externalTag);
    for (const token of [
      "max-sm:top-0",
      "max-sm:right-0",
      "max-sm:min-h-11",
      "max-sm:min-w-11",
    ]) {
      expect(tokens).toContain(token);
    }
    for (const token of ["absolute", "top-2", "right-2", "min-h-6", "min-w-6", "inline-flex", "items-center", "justify-center"]) {
      expect(tokens).toContain(token);
    }
  });

  it("(mobile 44 px) the card link ends where the 44 px arrow begins: max-sm:mr-7", () => {
    const tokens = tokensOf(cardTag);
    expect(tokens).toContain("block");
    expect(tokens).toContain("max-sm:mr-7");
  });

  it("(mobile 44 px) the name keeps pr-7 and releases it below sm with max-sm:pr-0", () => {
    const namePara = /<p class="([^"]*)">GZT<\/p>/.exec(markup);
    expect(namePara).not.toBeNull();
    const tokens = (namePara?.[1] ?? "").split(/\s+/);
    expect(tokens).toContain("pr-7");
    expect(tokens).toContain("max-sm:pr-0");
  });

  it("(mobile 44 px) every mobile addition is max-sm: scoped, so sm and up classes are untouched", () => {
    expect(tokensOf(cardTag).filter((t) => !t.startsWith("max-sm:"))).toEqual(["block"]);
    expect(tokensOf(externalTag).filter((t) => !t.startsWith("max-sm:"))).toEqual([
      "absolute",
      "top-2",
      "right-2",
      "inline-flex",
      "min-h-6",
      "min-w-6",
      "items-center",
      "justify-center",
      "rounded",
      "text-[11px]",
      "leading-none",
      "text-muted-foreground",
      "hover:bg-muted/60",
      "hover:text-foreground",
    ]);
  });
});

// ---------------------------------------------------------------------------
// sources-cold-hit: the first request to /sources after a deploy took 4.4-5.6 s
// in production (x-vercel-cache PRERENDER; warm requests 0.5 s). The page body
// began with `await connection()`, so `next build` postponed the whole body: the
// prerender held only the loading skeleton (0 /source/ links), no "use cache"
// entry was filled at build, and the first reader paid the function cold path
// plus the uncached directory read and the weekly-count aggregate (a cold
// buffer-cache read on the articles index, mean ~2 s in pg_stat_statements).
// The page is now prerenderable: every clock-dependent value is stamped inside
// the cached read, at fill time.
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-11-01T12:00:00.000Z");
const hoursAgoIso = (hours: number) => new Date(NOW_MS - hours * 3_600_000).toISOString();

type StatsRow = GroupedSources[keyof GroupedSources][number];

function statsRow(slug: string, kind: string, lastPublishedAt: string | null): StatsRow {
  return { ...GZT, id: slug, slug, kind, lastPublishedAt } as unknown as StatsRow;
}

describe("registryModifiedAt -- the registry's last change time", () => {
  it("returns the ISO form of the latest value", () => {
    expect(
      registryModifiedAt([
        "2026-09-01T00:00:00Z",
        "2026-10-20T08:00:00.000Z",
        "2026-10-05T00:00:00Z",
      ]),
    ).toBe("2026-10-20T08:00:00.000Z");
  });

  it("ignores null, undefined and unparseable values", () => {
    expect(
      registryModifiedAt([
        null,
        undefined,
        "not-a-date",
        "",
        "2026-10-05T00:00:00Z",
        "2026-13-45",
      ]),
    ).toBe("2026-10-05T00:00:00.000Z");
  });

  it("returns null for an empty input and for input with nothing usable", () => {
    expect(registryModifiedAt([])).toBeNull();
    expect(registryModifiedAt([null, undefined, "junk", ""])).toBeNull();
  });

  it("compares instants, not strings: offsets and Postgres microseconds normalise to UTC", () => {
    // 03:00+03:00 is 00:00Z -- earlier than 01:00Z although "03" > "01" as text.
    expect(registryModifiedAt(["2026-10-20T03:00:00+03:00", "2026-10-20T01:00:00Z"])).toBe(
      "2026-10-20T01:00:00.000Z",
    );
    expect(registryModifiedAt(["2026-10-20T08:00:00.123456+00:00"])).toBe(
      "2026-10-20T08:00:00.123Z",
    );
  });

  it("does not depend on the clock or on input order", () => {
    const values = ["2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", null];
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2026-11-01T00:00:00.000Z"));
      const first = registryModifiedAt(values);
      vi.setSystemTime(Date.parse("2030-01-01T00:00:00.000Z"));
      const second = registryModifiedAt([...values].reverse());
      expect(first).toBe("2026-10-02T00:00:00.000Z");
      expect(second).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("deriveDirectoryStats -- the yield denominator, from fill-time rows", () => {
  const grouped = (rows: Partial<Record<string, StatsRow[]>>) =>
    rows as unknown as Parameters<typeof deriveDirectoryStats>[0];

  it("counts only voting sources (outlet, wire) that delivered inside FEED_YIELD_WINDOW_MS", () => {
    const stats = deriveDirectoryStats(
      grouped({
        pro_government: [
          statsRow("outlet-fresh", "outlet", hoursAgoIso(1)),
          statsRow("outlet-stale", "outlet", hoursAgoIso(100)),
          statsRow("outlet-never", "outlet", null),
        ],
        center: [
          statsRow("agg-fresh", "aggregator", hoursAgoIso(1)),
          statsRow("niche-fresh", "niche", hoursAgoIso(1)),
        ],
        state_media: [statsRow("wire-fresh", "wire", hoursAgoIso(2))],
      }),
      NOW_MS,
    );

    // Voting: outlet x3 + wire x1 = 4. Delivering: outlet-fresh + wire-fresh.
    expect(stats).toEqual({ votingSources: 4, votingDelivering: 2 });
  });

  it("the window edge is inclusive, one millisecond past it is not", () => {
    const edge = new Date(NOW_MS - FEED_YIELD_WINDOW_MS).toISOString();
    const past = new Date(NOW_MS - FEED_YIELD_WINDOW_MS - 1).toISOString();
    const stats = deriveDirectoryStats(
      grouped({
        center: [statsRow("edge", "outlet", edge), statsRow("past", "outlet", past)],
      }),
      NOW_MS,
    );

    expect(stats.votingDelivering).toBe(1);
    expect(stats.votingSources).toBe(2);
  });

  it("a future-dated row is never delivering (SEC-01: a source-controlled pubDate)", () => {
    const stats = deriveDirectoryStats(
      grouped({
        center: [
          statsRow("future-1h", "outlet", new Date(NOW_MS + 3_600_000).toISOString()),
          statsRow("future-1ms", "wire", new Date(NOW_MS + 1).toISOString()),
          statsRow("now", "outlet", new Date(NOW_MS).toISOString()),
        ],
      }),
      NOW_MS,
    );

    expect(stats).toEqual({ votingSources: 3, votingDelivering: 1 });
  });

  it("an unparseable timestamp is not delivering, and missing buckets read as empty", () => {
    expect(
      deriveDirectoryStats(
        grouped({ center: [statsRow("junk", "outlet", "not-a-date")] }),
        NOW_MS,
      ),
    ).toEqual({ votingSources: 1, votingDelivering: 0 });
    expect(deriveDirectoryStats(grouped({}), NOW_MS)).toEqual({
      votingSources: 0,
      votingDelivering: 0,
    });
  });

  it("depends on the nowMs it is given, not on the wall clock", () => {
    const rows = grouped({ center: [statsRow("a", "outlet", hoursAgoIso(1))] });

    expect(deriveDirectoryStats(rows, NOW_MS).votingDelivering).toBe(1);
    expect(deriveDirectoryStats(rows, NOW_MS + FEED_YIELD_WINDOW_MS).votingDelivering).toBe(0);
  });
});

/** Source of `async function <name>(...) { ... }`, matched by brace depth. */
function functionSource(code: string, name: string): string {
  const start = code.search(new RegExp(`function\\s+${name}\\b`));
  if (start === -1) return "";
  const open = code.indexOf("{", code.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(start, i + 1);
  }
  return "";
}

describe("/sources page source -- the first hit after a deploy must be a prerender", () => {
  // WHY: `await connection()` at the top of the page postponed the entire body
  // at build time, so the deployed prerender was an empty skeleton and the first
  // reader after every deploy paid the uncached reads plus the function cold
  // path (4.4-5.6 s). A cached read stamps the clock at fill time instead, so
  // the build fills the cache and ships the finished page. A clock read in the
  // page body, or in any component below it, would fail the build once the read
  // succeeds (tests/guards/static-page-clock.test.ts describes the same trap).
  const code = stripComments(PAGE_SOURCE);
  const reader = functionSource(code, "readSourcesDirectory");
  const outsideReader = code.replace(reader, "");
  const CLOCK_READ = /\bDate\.now\s*\(|\bnew Date\s*\(\s*\)|\bformatTurkishTimeAgo\s*\(/;

  it("never awaits or calls connection(), and no longer imports it", () => {
    expect(code).not.toMatch(/\bconnection\s*\(/);
    expect(code).not.toMatch(/import\s*\{[^}]*\bconnection\b[^}]*\}\s*from/);
  });

  it("finds the cached reader (so the clock guard below is not vacuous)", () => {
    expect(reader).toContain("createServerClient()");
    expect(reader).toMatch(/\bDate\.now\s*\(\s*\)/);
  });

  it("reads the clock only inside the cached reader", () => {
    expect(outsideReader).not.toMatch(CLOCK_READ);
  });

  it("the reader hands formatTurkishTimeAgo its own fill-time `now`", () => {
    expect(reader).toMatch(/formatTurkishTimeAgo\([^)]*\bnow:/);
  });

  it("functionSource and the clock pattern tolerate nested braces and flag stray reads", () => {
    const sample = "function a() { const x = { y: `${1}` }; return Date.now(); }\nfunction b() { return 1; }";
    expect(functionSource(sample, "a")).toContain("Date.now()");
    expect(functionSource(sample, "a")).not.toContain("function b");
    expect(sample.replace(functionSource(sample, "a"), "")).not.toMatch(CLOCK_READ);
    expect("const t = new Date();").toMatch(CLOCK_READ);
    expect("formatTurkishTimeAgo(x)").toMatch(CLOCK_READ);
    expect("new Date(x).toISOString()").not.toMatch(CLOCK_READ);
    expect(functionSource(sample, "missing")).toBe("");
  });
});

describe("/sources page -- clock values are stamped when the directory is read", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The <script type="application/ld+json"> payload under the page fragment. */
  function jsonLdOf(tree: unknown): Record<string, unknown> {
    const children = (tree as { props: { children: unknown[] } }).props.children;
    const script = children.find(
      (c) => (c as { type?: unknown } | null)?.type === "script",
    ) as { props: { dangerouslySetInnerHTML: { __html: string } } };
    return JSON.parse(script.props.dangerouslySetInnerHTML.__html) as Record<string, unknown>;
  }

  function findByType(node: unknown, type: unknown): TreeElement | null {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = findByType(child, type);
        if (hit) return hit;
      }
      return null;
    }
    if (node && typeof node === "object") {
      const el = node as TreeElement;
      if (el.type === type) return el;
      if (el.props?.children !== undefined) return findByType(el.props.children, type);
    }
    return null;
  }

  // dateModified is the registry's last change time, derived from the database:
  // the latest of every active row's created_at, every active row's
  // zone_rationale_at and the newest source_zone_history.changed_at. It used to
  // be the instant the cache was filled, so three fetches 20 s apart reported
  // three different "now" stamps (hunt-17).
  it("(a) dateModified is the latest of the row stamps and the zone history, not the clock", async () => {
    vi.setSystemTime(Date.parse("2026-11-01T09:30:00.000Z"));
    supabaseFixture.createdAtBySlug = { "s-outlet": "2026-09-01T00:00:00Z" };
    supabaseFixture.rationaleBySlug = { "s-aggregator": "2026-10-05T00:00:00Z" };
    supabaseFixture.history = [
      { changed_at: "2026-08-01T00:00:00.000Z" },
      { changed_at: "2026-10-20T08:00:00.000Z" },
      { changed_at: "2026-10-10T00:00:00.000Z" },
    ];

    const dataset = jsonLdOf(await SourcesPage());

    expect(dataset.dateModified).toBe("2026-10-20T08:00:00.000Z");
  });

  it.each<{
    name: string;
    createdAt: Record<string, string | null>;
    rationale: Record<string, string | null>;
    history: Array<{ changed_at: string }>;
    expected: string;
  }>([
    {
      name: "a source's created_at",
      createdAt: { "s-wire": "2026-10-25T10:00:00Z" },
      rationale: { "s-aggregator": "2026-10-05T00:00:00Z" },
      history: [{ changed_at: "2026-10-20T08:00:00.000Z" }],
      expected: "2026-10-25T10:00:00.000Z",
    },
    {
      name: "a source's zone_rationale_at",
      createdAt: { "s-outlet": "2026-09-01T00:00:00Z" },
      rationale: { "s-wire": "2026-10-28T12:30:00Z" },
      history: [{ changed_at: "2026-10-20T08:00:00.000Z" }],
      expected: "2026-10-28T12:30:00.000Z",
    },
    {
      name: "the newest zone-history row",
      createdAt: { "s-outlet": "2026-09-01T00:00:00Z" },
      rationale: { "s-aggregator": "2026-10-05T00:00:00Z" },
      history: [{ changed_at: "2026-10-30T23:59:59.000Z" }],
      expected: "2026-10-30T23:59:59.000Z",
    },
  ])("(a) each of the three inputs can be the latest: $name", async (c) => {
    supabaseFixture.createdAtBySlug = c.createdAt;
    supabaseFixture.rationaleBySlug = c.rationale;
    supabaseFixture.history = c.history;

    const dataset = jsonLdOf(await SourcesPage());

    expect(dataset.dateModified).toBe(c.expected);
  });

  it("asks the database for the single newest zone-history row, not the whole table", async () => {
    supabaseFixture.history = [{ changed_at: "2026-10-20T08:00:00.000Z" }];

    await SourcesPage();

    expect(supabaseFixture.historyQueries).toEqual([
      {
        select: "changed_at",
        order: [{ col: "changed_at", ascending: false }],
        limit: 1,
      },
    ]);
  });

  it("(b) two renders under different system clocks report the same dateModified", async () => {
    supabaseFixture.history = [{ changed_at: "2026-10-20T08:00:00.000Z" }];

    vi.setSystemTime(Date.parse("2026-11-01T09:30:00.000Z"));
    const first = jsonLdOf(await SourcesPage());
    vi.setSystemTime(Date.parse("2026-11-01T09:30:20.000Z"));
    const second = jsonLdOf(await SourcesPage());

    expect(first.dateModified).toBe("2026-10-20T08:00:00.000Z");
    expect(second.dateModified).toBe(first.dateModified);
  });

  it("(c) an unreadable zone history leaves dateModified out but still renders the directory", async () => {
    supabaseFixture.historyError = "statement timeout";
    // A partial max (rows only) would understate the change time: it must not be used.
    supabaseFixture.createdAtBySlug = { "s-outlet": "2026-09-01T00:00:00Z" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const tree = await SourcesPage();
    const dataset = jsonLdOf(tree);
    const text = (await collectText(tree)).join(" ");
    const hrefs = await collectHrefs(tree);

    expect("dateModified" in dataset).toBe(false);
    expect(dataset["@type"]).toBe("Dataset");
    expect(text).toContain("Yanlılık dağılımına sayılan");
    expect(text).not.toContain("Kaynak listesi şu an yüklenemedi");
    expect(findElementProps(tree, "meta")).toBeNull();
    expect(hrefs.filter((h) => h.startsWith("/source/"))).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("[sources] zone history unreadable");
    expect(String(warn.mock.calls[0]?.[0])).toContain("statement timeout");
  });

  it("(d) an empty history and no row stamps leave dateModified out", async () => {
    supabaseFixture.createdAtBySlug = {
      "s-outlet": null,
      "s-aggregator": null,
      "s-wire": null,
    };
    supabaseFixture.rationaleBySlug = {};
    supabaseFixture.history = [];

    const tree = await SourcesPage();
    const dataset = jsonLdOf(tree);

    expect("dateModified" in dataset).toBe(false);
    expect(dataset["@type"]).toBe("Dataset");
    expect(findElementProps(tree, "meta")).toBeNull();
  });

  it("a history row alone is enough when every row stamp is NULL", async () => {
    supabaseFixture.createdAtBySlug = {
      "s-outlet": null,
      "s-aggregator": null,
      "s-wire": null,
    };
    supabaseFixture.rationaleBySlug = {};
    supabaseFixture.history = [{ changed_at: "2026-10-20T08:00:00.000Z" }];

    const dataset = jsonLdOf(await SourcesPage());

    expect(dataset.dateModified).toBe("2026-10-20T08:00:00.000Z");
  });

  it("a failing directory read is still the error state, whatever the history says", async () => {
    supabaseFixture.sourcesError = "canceling statement due to statement timeout";
    supabaseFixture.history = [{ changed_at: "2026-10-20T08:00:00.000Z" }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const tree = await SourcesPage();
    const text = (await collectText(tree)).join(" ");

    expect(text).toContain("Kaynak listesi şu an yüklenemedi");
    expect(findElementProps(tree, "meta")).toMatchObject({
      name: "robots",
      content: "noindex",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[sources] unavailable"));
  });

  it("the DenominatorNote pair comes from the fill-time clock: fresh voting sources deliver, aggregators and stale ones do not", async () => {
    supabaseFixture.latestBySlug = {
      "s-outlet": hoursAgoIso(1),
      "s-aggregator": hoursAgoIso(1),
      "s-wire": hoursAgoIso(100),
    };

    const note = findByType(await SourcesPage(), DenominatorNote);

    expect(note?.props).toMatchObject({ delivering: 1, total: 2 });
  });

  it("every row carries a lastSeenLabel computed at fill time, and a quiet source carries none", async () => {
    supabaseFixture.latestBySlug = {
      "s-outlet": hoursAgoIso(3),
      "s-wire": hoursAgoIso(100),
    };

    const tree = await SourcesPage();
    const child = findSuspenses(tree)[0]?.props?.children as TreeElement;
    const grouped = child.props?.grouped as Record<
      string,
      Array<{ slug: string; lastSeenLabel: string | null }>
    >;
    const label = (bias: string, slug: string) =>
      grouped[bias]?.find((r) => r.slug === slug)?.lastSeenLabel;

    expect(label("pro_government", "s-outlet")).toBe("3 saat önce");
    // Older than 48 h the helper switches to an absolute date; it is stamped too.
    expect(label("state_media", "s-wire")).toBe(
      formatTurkishTimeAgo(hoursAgoIso(100), { now: NOW_MS }),
    );
    expect(label("state_media", "s-wire")).not.toMatch(/önce$/);
    expect(label("center", "s-aggregator")).toBeNull();
  });

  it("the label does not drift while the cached directory is served: rendering ten hours later shows the fill-time text", async () => {
    supabaseFixture.latestBySlug = { "s-outlet": hoursAgoIso(3) };
    const tree = await SourcesPage();
    const child = findSuspenses(tree)[0]?.props?.children as TreeElement;
    const props = child.props as unknown as Parameters<typeof SourceDirectoryWithCounts>[0];

    vi.setSystemTime(NOW_MS + 10 * 3_600_000);
    const markup = renderToStaticMarkup(
      createElement(SourceDirectory, { grouped: props.grouped, countLabel: "0 haber" }),
    );

    const timeLine = /<p class="text-\[10px\] text-muted-foreground">([^<]*)<\/p>/.exec(markup);
    expect(timeLine?.[1]).toBe("3 saat önce");
  });
});

describe("SourceDirectory -- renders lastSeenLabel", () => {
  const render = (lastSeenLabel: string | null) =>
    renderToStaticMarkup(
      createElement(SourceDirectory, {
        grouped: {
          pro_government: [
            { ...GZT, lastPublishedAt: "2026-10-31T08:00:00.000Z", lastSeenLabel },
          ],
        } as unknown as GroupedSources,
        countLabel: "12 haber",
      }),
    );
  const TIME_LINE = /<p class="text-\[10px\] text-muted-foreground">([^<]*)<\/p>/;

  it("shows the given label under the card, verbatim, instead of deriving one from the clock", () => {
    const markup = render("3 saat önce");

    expect(TIME_LINE.exec(markup)?.[1]).toBe("3 saat önce");
    expect(markup.match(/önce/g)).toHaveLength(1);
  });

  it("renders no time line when the source has no label", () => {
    expect(TIME_LINE.test(render(null))).toBe(false);
  });
});
