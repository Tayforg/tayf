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
  // h47-sources-1: fetch_quarantined_until is NULL unless a test sets it.
  const quarantinedUntilOf = (slug: string) =>
    supabaseFixture.quarantinedUntilBySlug[slug] ?? null;
  // h103-sourcescores-2: the four ingest columns classifySilence reads. A slug a
  // test does not touch is a healthy feed (200, no failures, nothing measured),
  // which classifies as 'sessiz', never 'akış donmuş'.
  const feedColumnsOf = (slug: string) => {
    const f = supabaseFixture.feedBySlug[slug] ?? {};
    return {
      fetch_last_status: "status" in f ? (f.status ?? null) : 200,
      fetch_fail_streak: "failStreak" in f ? (f.failStreak ?? null) : 0,
      fetch_newest_item_at: f.newest ?? null,
      fetch_items_count: "items" in f ? (f.items ?? null) : null,
    };
  };
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
      fetch_quarantined_until: quarantinedUntilOf("s-outlet"),
      ...feedColumnsOf("s-outlet"),
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
      fetch_quarantined_until: quarantinedUntilOf("s-aggregator"),
      ...feedColumnsOf("s-aggregator"),
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
      fetch_quarantined_until: quarantinedUntilOf("s-wire"),
      ...feedColumnsOf("s-wire"),
    },
    // h103-sourcescores-2: extra directory rows for the header-count tests; empty by default.
    ...supabaseFixture.extraRows.map((row) => ({
      stats: [{ count: 2 }],
      latest: latestOf(String(row.slug)),
      created_at: createdAtOf(String(row.slug)),
      zone_rationale_at: rationaleAtOf(String(row.slug)),
      fetch_quarantined_until: quarantinedUntilOf(String(row.slug)),
      ...feedColumnsOf(String(row.slug)),
      ...row,
    })),
  ];
  return createSupabaseFake({
    tables: {
      // Like PostgREST, return only the columns the query selects: a page that
      // forgets `created_at, zone_rationale_at, fetch_quarantined_until` (or one of the four fetch_*
      // columns the frozen-feed verdict reads) in its select string must not
      // be rescued by a fake that hands them over anyway.
      sources: (state) => {
        // h69-jsonld-1: the newest registry_changed_at stamp, a separate one-row read of the
        // same table. Mirrors the query it is given (ordered when asked, cut to `.limit(n)`)
        // and records every filter, so a test can show it is not narrowed to active rows.
        if (String(state.selectArgs[0] ?? "") === "registry_changed_at") {
          supabaseFixture.registryChangedQueries.push({
            select: String(state.selectArgs[0] ?? ""),
            order: state.order.map((o) => ({
              col: o.col,
              ascending:
                (o.opts as { ascending?: boolean } | undefined)?.ascending ?? true,
            })),
            limit: state.limit,
            filters: [
              ...state.eq.map((f) => `eq ${f.col}`),
              ...state.neq.map((f) => `neq ${f.col}`),
              ...state.in.map((f) => `in ${f.col}`),
              ...state.is.map((f) => `is ${f.col}`),
              ...state.not.map((f) => `not ${f.col}`),
              ...state.or.map((f) => `or ${f}`),
              ...state.gt.map((f) => `gt ${f.col}`),
              ...state.gte.map((f) => `gte ${f.col}`),
              ...state.lt.map((f) => `lt ${f.col}`),
              ...state.lte.map((f) => `lte ${f.col}`),
            ],
          });
          if (supabaseFixture.registryChangedError) {
            return {
              data: null,
              error: { message: supabaseFixture.registryChangedError },
            };
          }
          let rows = supabaseFixture.registryChangedAt.map((at) => ({
            registry_changed_at: at,
          }));
          const byStamp = state.order.find((o) => o.col === "registry_changed_at");
          if (byStamp) {
            const ascending =
              (byStamp.opts as { ascending?: boolean } | undefined)?.ascending ?? true;
            rows = rows.sort(
              (a, b) =>
                (Date.parse(a.registry_changed_at) - Date.parse(b.registry_changed_at)) *
                (ascending ? 1 : -1),
            );
          }
          if (state.limit !== null) rows = rows.slice(0, state.limit);
          return { data: rows, error: null };
        }
        if (supabaseFixture.sourcesError) {
          return { data: null, error: { message: supabaseFixture.sourcesError } };
        }
        const selected = String(state.selectArgs[0] ?? "")
          .split(",")
          .map((column) => column.trim());
        return {
          data: sourceRows.map((row) => {
            const out: Record<string, unknown> = { ...row };
            for (const column of [
              "created_at",
              "zone_rationale_at",
              "fetch_quarantined_until",
              "fetch_last_status",
              "fetch_fail_streak",
              "fetch_newest_item_at",
              "fetch_items_count",
            ]) {
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
  /** slug -> fetch_quarantined_until (ISO); an absent slug is NULL (never quarantined). */
  quarantinedUntilBySlug: {} as Record<string, string | null>,
  /**
   * slug -> the ingest columns classifySilence reads (h103-sourcescores-2). A key that is absent
   * keeps the healthy default (status 200, fail streak 0, no newest item, no item count); an
   * explicit null models a NULL column.
   */
  feedBySlug: {} as Record<
    string,
    {
      status?: number | null;
      failStreak?: number | null;
      newest?: string | null;
      items?: number | null;
    }
  >,
  /** Extra active source rows appended to the three fixed ones (empty by default). */
  extraRows: [] as Array<Record<string, unknown> & { slug: string }>,
  /** Rows of source_zone_history (the reader asks for the newest one). */
  history: [] as Array<{ changed_at: string }>,
  /** When set, the source_zone_history read resolves { data: null, error: { message } }. */
  historyError: null as string | null,
  /** When set, the sources directory read resolves { data: null, error: { message } }. */
  sourcesError: null as string | null,
  /** sources.registry_changed_at stamps (migration 175): every row of the table, active or not. */
  registryChangedAt: [] as string[],
  /** When set, the registry_changed_at read resolves { data: null, error: { message } }. */
  registryChangedError: null as string | null,
  /** What each registry_changed_at query asked for (select, order, limit, filters). */
  registryChangedQueries: [] as Array<{
    select: string;
    order: Array<{ col: string; ascending: boolean }>;
    limit: number | null;
    filters: string[];
  }>,
  /** What each source_zone_history query asked for (select, order, limit). */
  historyQueries: [] as Array<{
    select: string;
    order: Array<{ col: string; ascending: boolean }>;
    limit: number | null;
  }>,
  // Order of the reads the page starts: "directory" is pushed by the
  // directory read's createSlowReaderClient() call, "counts" by a stubbed
  // getSourceItemsPerDay (see the overlap test below).
  calls: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createSlowReaderClient: () => {
    supabaseFixture.calls.push("directory");
    if (supabaseFixture.fail) throw new Error("supabase unavailable");
    return makeFakeClient();
  },
}));

// Import AFTER mocks are declared.
import SourcesPage, {
  SourceDirectory,
  SourceDirectoryWithCounts,
  countFrozenSources,
  deriveDirectoryStats,
  registryModifiedAt,
} from "./page";
import { SOURCE_SKELETON_CARDS, SourceDirectorySkeleton } from "./source-directory-skeleton";
import { getSourceItemsPerDay } from "@/lib/sources/feed-status";
import { DenominatorNote } from "@/components/source/denominator-note";
import { ClickbaitKarneSection } from "@/components/source/clickbait-karne";
import { getClickbaitKarne, isClickbaitPublic } from "@/lib/sources/clickbait";
import { BIAS_LABELS } from "@/lib/bias/config";
import { SOURCE_KIND_META } from "@/lib/sources/kind";
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

/** First string value of `props[name]` found walking `props.children` only. */
function findPropString(node: unknown, name: string): string | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findPropString(child, name);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const props = (node as { props?: { children?: unknown; [k: string]: unknown } }).props;
    if (typeof props?.[name] === "string") return props[name] as string;
    return findPropString(props?.children, name);
  }
  return undefined;
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
  supabaseFixture.quarantinedUntilBySlug = {};
  supabaseFixture.feedBySlug = {};
  supabaseFixture.extraRows = [];
  supabaseFixture.history = [];
  supabaseFixture.historyError = null;
  supabaseFixture.sourcesError = null;
  supabaseFixture.registryChangedAt = [];
  supabaseFixture.registryChangedError = null;
  supabaseFixture.registryChangedQueries.length = 0;
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

  // h37-content-2: the aggregators and niche sources carry a bias label too,
  // but only the voting ones are placed on the spectrum - the header must not
  // claim "each one" is, right above the line that says they are not counted.
  it("the header scopes the political-stance claim to the sources that vote", async () => {
    // <PageHero subtitle> is a prop, not a child, so the text walker above
    // never reaches it: read the prop off the element instead.
    const subtitle = findPropString(await SourcesPage(), "subtitle");

    expect(subtitle).toContain(
      "Yanlılık dağılımına sayılan kaynakların her biri bir siyasi duruşa yerleştirilmiş.",
    );
    expect(subtitle).not.toContain("Her biri bir siyasi duruşa yerleştirilmiş");
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
  "grid grid-cols-1 min-[480px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3";

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
    expect(externalTag).toContain('aria-label="GZT sitesi (yeni sekmede açılır)"');
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
    expect(reader).toContain("createSlowReaderClient()");
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

  // h69-jsonld-1: created_at, zone_rationale_at and the zone history do not move when a source's
  // kind, kayyum (trustee) status, rights flags, name, URL or active flag change, so dateModified
  // sat at the day the registry was created. sources.registry_changed_at (migration 175) is
  // stamped by a trigger on exactly those edits; the page reads its newest value in the same
  // Promise.all as the directory and the zone history.
  it("(e) the newest sources.registry_changed_at is dateModified when every other input is older", async () => {
    vi.setSystemTime(Date.parse("2026-11-10T09:30:00.000Z"));
    supabaseFixture.createdAtBySlug = { "s-outlet": "2026-04-06T14:20:11.360Z" };
    supabaseFixture.rationaleBySlug = { "s-aggregator": "2026-10-05T00:00:00Z" };
    supabaseFixture.history = [{ changed_at: "2026-10-20T08:00:00.000Z" }];
    supabaseFixture.registryChangedAt = ["2026-11-09T00:00:00Z"];

    const dataset = jsonLdOf(await SourcesPage());

    expect(dataset.dateModified).toBe("2026-11-09T00:00:00.000Z");
  });

  it("(e) the page takes the newest of the stamps the database returns, not the first", async () => {
    supabaseFixture.registryChangedAt = [
      "2026-09-06T22:16:36Z",
      "2026-11-09T00:00:00Z",
      "2026-10-01T00:00:00Z",
    ];

    const dataset = jsonLdOf(await SourcesPage());

    expect(dataset.dateModified).toBe("2026-11-09T00:00:00.000Z");
  });

  it("(e) an older registry_changed_at never lowers dateModified: it is one more input to the maximum", async () => {
    supabaseFixture.history = [{ changed_at: "2026-10-20T08:00:00.000Z" }];
    supabaseFixture.registryChangedAt = ["2026-08-01T00:00:00Z"];

    const dataset = jsonLdOf(await SourcesPage());

    expect(dataset.dateModified).toBe("2026-10-20T08:00:00.000Z");
  });

  it("(e) a registry_changed_at alone is enough when every other stamp is NULL and the history is empty", async () => {
    supabaseFixture.createdAtBySlug = {
      "s-outlet": null,
      "s-aggregator": null,
      "s-wire": null,
    };
    supabaseFixture.rationaleBySlug = {};
    supabaseFixture.history = [];
    supabaseFixture.registryChangedAt = ["2026-11-09T00:00:00Z"];

    const dataset = jsonLdOf(await SourcesPage());

    expect(dataset.dateModified).toBe("2026-11-09T00:00:00.000Z");
  });

  it("(e) the stamp read is one row of the newest stamp and is NOT filtered, so deactivating a source counts", async () => {
    supabaseFixture.registryChangedAt = ["2026-11-09T00:00:00Z"];

    await SourcesPage();

    // No eq/neq/in/is/not/or/range filter at all: in particular none on `active`. The directory
    // read lists active sources only, a deactivated one would otherwise drop out of the maximum.
    expect(supabaseFixture.registryChangedQueries).toEqual([
      {
        select: "registry_changed_at",
        order: [{ col: "registry_changed_at", ascending: false }],
        limit: 1,
        filters: [],
      },
    ]);
  });

  it("(e) the stamp is read once per directory read, never per source", async () => {
    supabaseFixture.registryChangedAt = ["2026-11-09T00:00:00Z"];

    await SourcesPage();
    await SourcesPage();

    // The "use cache" directive is a no-op under Vitest, so each render is one directory read; three sources, one query.
    expect(supabaseFixture.registryChangedQueries).toHaveLength(2);
  });

  it("(e) two renders under different system clocks report the same registry-based dateModified", async () => {
    supabaseFixture.registryChangedAt = ["2026-11-09T00:00:00Z"];

    vi.setSystemTime(Date.parse("2026-11-10T09:30:00.000Z"));
    const first = jsonLdOf(await SourcesPage());
    vi.setSystemTime(Date.parse("2026-11-10T09:30:20.000Z"));
    const second = jsonLdOf(await SourcesPage());

    expect(first.dateModified).toBe("2026-11-09T00:00:00.000Z");
    expect(second.dateModified).toBe(first.dateModified);
  });

  it("(f) an unreadable registry_changed_at leaves dateModified out but still renders the directory", async () => {
    supabaseFixture.registryChangedError = 'column sources.registry_changed_at does not exist';
    // A partial max (the other inputs only) would understate the change time: it must not be used.
    supabaseFixture.createdAtBySlug = { "s-outlet": "2026-09-01T00:00:00Z" };
    supabaseFixture.history = [{ changed_at: "2026-10-20T08:00:00.000Z" }];
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
    expect(String(warn.mock.calls[0]?.[0])).toContain("[sources] registry change stamp unreadable");
    expect(String(warn.mock.calls[0]?.[0])).toContain("registry_changed_at does not exist");
  });

  it("(f) both side reads failing warns once for each and still omits dateModified", async () => {
    supabaseFixture.registryChangedError = "statement timeout";
    supabaseFixture.historyError = "statement timeout";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const tree = await SourcesPage();
    const dataset = jsonLdOf(tree);

    expect("dateModified" in dataset).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("[sources] zone history unreadable"))).toBe(true);
    expect(messages.some((m) => m.includes("[sources] registry change stamp unreadable"))).toBe(true);
  });

  it("(f) a failing directory read is still the error state, whatever the registry stamp says", async () => {
    supabaseFixture.sourcesError = "canceling statement due to statement timeout";
    supabaseFixture.registryChangedAt = ["2026-11-09T00:00:00Z"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const tree = await SourcesPage();
    const text = (await collectText(tree)).join(" ");

    expect(text).toContain("Kaynak listesi şu an yüklenemedi");
    expect(findElementProps(tree, "meta")).toMatchObject({ name: "robots", content: "noindex" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[sources] unavailable"));
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

// ---------------------------------------------------------------------------
// h47-sources-1: source status was invisible outside /kaynaklar/durum. Seven
// active sources that had never delivered an article (all in feed quarantine)
// rendered as ordinary cards with "son 7 günde 0 haber". The directory read now
// selects fetch_quarantined_until and stamps `quarantined` on each row at cache
// fill time, with the clock value the read already takes (`nowMs`): the page
// body stays clock-free. A card for a quarantined source carries an
// "Akış alınamıyor" marker linking to /kaynaklar/durum, and the header counts
// them. The 118/96-style numbers do not move.
// ---------------------------------------------------------------------------

/** Every intrinsic <p> reachable through props.children and arrays (components are not expanded). */
function intrinsicParagraphs(node: unknown, out: TreeElement[] = []): TreeElement[] {
  if (Array.isArray(node)) {
    for (const child of node) intrinsicParagraphs(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as TreeElement;
    if (el.type === "p") out.push(el);
    if (el.props?.children !== undefined) intrinsicParagraphs(el.props.children, out);
  }
  return out;
}

/** The intrinsic <p> elements whose own text contains `needle`. */
async function paragraphsContaining(tree: unknown, needle: string): Promise<TreeElement[]> {
  const hits: TreeElement[] = [];
  for (const p of intrinsicParagraphs(tree)) {
    if ((await collectText(p)).join("").includes(needle)) hits.push(p);
  }
  return hits;
}

describe("/sources page -- quarantined feeds are visible (h47-sources-1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const inOneHour = new Date(NOW_MS + 3_600_000).toISOString();
  const oneHourAgo = new Date(NOW_MS - 3_600_000).toISOString();

  type QuarantineRow = { slug: string; quarantined: boolean };

  async function groupedRows(): Promise<QuarantineRow[]> {
    const tree = await SourcesPage();
    const child = findSuspenses(tree)[0]?.props?.children as TreeElement;
    const grouped = child.props?.grouped as Record<string, QuarantineRow[]>;
    return Object.values(grouped).flat();
  }

  async function fullText(): Promise<string> {
    return (await collectText(await SourcesPage())).join("");
  }

  const MARKER = "Akış alınamıyor";
  const HEADER_SENTENCE = "kaynağın beslemesi şu anda alınamıyor.";
  const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  it("stamps quarantined on each row at fill time: a future until is true; past, exactly now and NULL are false", async () => {
    supabaseFixture.quarantinedUntilBySlug = {
      "s-outlet": inOneHour,
      "s-wire": new Date(NOW_MS).toISOString(),
      // s-aggregator: NULL
    };
    const rows = await groupedRows();
    const quarantinedOf = (slug: string) => rows.find((r) => r.slug === slug)?.quarantined;

    expect(quarantinedOf("s-outlet")).toBe(true);
    expect(quarantinedOf("s-wire")).toBe(false);
    expect(quarantinedOf("s-aggregator")).toBe(false);

    supabaseFixture.quarantinedUntilBySlug = { "s-outlet": oneHourAgo, "s-wire": "not-a-date" };
    const later = await groupedRows();
    expect(later.every((r) => r.quarantined === false)).toBe(true);
  });

  it("one millisecond before the quarantine ends the row is still quarantined", async () => {
    supabaseFixture.quarantinedUntilBySlug = { "s-outlet": new Date(NOW_MS + 1).toISOString() };
    const rows = await groupedRows();
    expect(rows.find((r) => r.slug === "s-outlet")?.quarantined).toBe(true);
  });

  it("renders the 'Akış alınamıyor' marker only on the quarantined card (a healthy directory renders none)", async () => {
    supabaseFixture.quarantinedUntilBySlug = { "s-outlet": inOneHour };
    expect(countOf(await fullText(), MARKER)).toBe(1);

    supabaseFixture.quarantinedUntilBySlug = {};
    expect(await fullText()).not.toContain(MARKER);
  });

  it("an aggregator or niche source is marked too: the marker does not depend on the kind", async () => {
    supabaseFixture.quarantinedUntilBySlug = { "s-aggregator": inOneHour };
    expect(countOf(await fullText(), MARKER)).toBe(1);
  });

  it("the header adds '{k} kaynağın beslemesi şu anda alınamıyor.' with a /kaynaklar/durum link when k > 0", async () => {
    supabaseFixture.quarantinedUntilBySlug = { "s-outlet": inOneHour, "s-wire": inOneHour };

    const tree = await SourcesPage();
    const text = (await collectText(tree)).join("");
    expect(text).toContain(`2 ${HEADER_SENTENCE}`);

    // The line itself carries the link: DenominatorNote and the cards link to
    // /kaynaklar/durum as well, so look at the paragraph, not the whole page.
    const headers = await paragraphsContaining(tree, HEADER_SENTENCE);
    expect(headers).toHaveLength(1);
    expect(await collectHrefs(headers[0])).toEqual(["/kaynaklar/durum"]);
  });

  it("k is the number of marked cards: one quarantined source reads '1 kaynağın ...'", async () => {
    supabaseFixture.quarantinedUntilBySlug = { "s-wire": inOneHour };
    const text = await fullText();
    expect(text).toContain(`1 ${HEADER_SENTENCE}`);
    expect(countOf(text, HEADER_SENTENCE)).toBe(1);
  });

  it("with k = 0 the header adds nothing", async () => {
    const tree = await SourcesPage();
    const text = (await collectText(tree)).join("");

    expect(text).not.toContain("beslemesi şu anda alınamıyor");
    expect(text).not.toContain(MARKER);
    expect(await paragraphsContaining(tree, "alınamıyor")).toEqual([]);
  });

  it("does not change the header numbers: the title count and the N/M pair ignore quarantine", async () => {
    const baselineTree = await SourcesPage();
    const baselineSubtitle = findPropString(baselineTree, "subtitle");
    const baselineNote = findDenominatorNote(baselineTree)?.props;

    supabaseFixture.quarantinedUntilBySlug = {
      "s-outlet": inOneHour,
      "s-aggregator": inOneHour,
      "s-wire": inOneHour,
    };
    const tree = await SourcesPage();
    const text = (await collectText(tree)).join("");

    expect(findPropString(tree, "subtitle")).toBe(baselineSubtitle);
    expect(baselineSubtitle).toContain("Tayf 3 Türk haber kaynağını izliyor.");
    expect(findDenominatorNote(tree)?.props).toEqual(baselineNote);
    expect(findDenominatorNote(tree)?.props).toMatchObject({ delivering: 0, total: 2 });
    expect(text).toContain("2/3");
  });

  function findDenominatorNote(node: unknown): TreeElement | null {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = findDenominatorNote(child);
        if (hit) return hit;
      }
      return null;
    }
    if (node && typeof node === "object") {
      const el = node as TreeElement;
      if (el.type === DenominatorNote) return el;
      if (el.props?.children !== undefined) return findDenominatorNote(el.props.children);
    }
    return null;
  }

  it("the marker is part of the cached rows: rendering ten hours later still shows the fill-time verdict", async () => {
    supabaseFixture.quarantinedUntilBySlug = { "s-outlet": inOneHour };
    const tree = await SourcesPage();
    const child = findSuspenses(tree)[0]?.props?.children as TreeElement;
    const props = child.props as unknown as Parameters<typeof SourceDirectoryWithCounts>[0];

    vi.setSystemTime(NOW_MS + 10 * 3_600_000);
    const markup = renderToStaticMarkup(
      createElement(SourceDirectory, { grouped: props.grouped, countLabel: "0 haber" }),
    );

    expect(countOf(markup, MARKER)).toBe(1);
  });
});

describe("SourceDirectory -- the 'Akış alınamıyor' card marker (h47-sources-1)", () => {
  const render = (quarantined: boolean | undefined) =>
    renderToStaticMarkup(
      createElement(SourceDirectory, {
        grouped: {
          pro_government: [{ ...GZT, quarantined }],
        } as unknown as GroupedSources,
        countLabel: "0 haber",
      }),
    );

  const MARKER_LINK = /<a\b[^>]*\bhref="\/kaynaklar\/durum"[^>]*>Akış alınamıyor<\/a>/;

  it("a quarantined card carries a link to /kaynaklar/durum named 'Akış alınamıyor'", () => {
    expect(MARKER_LINK.test(render(true))).toBe(true);
  });

  it("the marker sits beside the profile link, never inside it (anchors cannot nest)", () => {
    const markup = render(true);
    const profileOpen = markup.indexOf('href="/source/gzt"');
    const profileClose = markup.indexOf("</a>", profileOpen);
    const marker = MARKER_LINK.exec(markup);

    expect(profileOpen).toBeGreaterThan(-1);
    expect(marker).not.toBeNull();
    expect(marker!.index).toBeGreaterThan(profileClose);
    // Still exactly one card link: the profile link text is unchanged.
    expect(markup.match(/href="\/source\/gzt"/g)).toHaveLength(1);
  });

  it("the marker is a 24 px target (WCAG 2.5.8) with the AA-safe rose pill used on /kaynaklar/durum", () => {
    const tag = /<a\b[^>]*\bhref="\/kaynaklar\/durum"[^>]*>/.exec(render(true))?.[0] ?? "";
    const tokens = (/\bclass="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);

    for (const token of [
      "inline-flex",
      "items-center",
      "min-h-6",
      "text-rose-800",
      "dark:text-rose-300",
    ]) {
      expect(tokens).toContain(token);
    }
  });

  it("a healthy card (false, or a row that predates the field) renders no marker and no /kaynaklar/durum link", () => {
    for (const quarantined of [false, undefined]) {
      const markup = render(quarantined);
      expect(markup).not.toContain("Akış alınamıyor");
      expect(markup).not.toContain("/kaynaklar/durum");
    }
  });

  it("a non-voting card fades nothing: the kind pill is the cue and the text stays at the full token (WCAG 1.4.3)", () => {
    // The card wrapper used to carry `opacity-70` for non-voting kinds, which
    // faded the rose pill too (rose-800 on rose-500/15 measured 3.94:1 in light
    // mode, 6.23:1 at full opacity). h79-markup-1: the same element opacity on
    // the profile link and the external arrow took the 10 px muted text
    // (post count, kind pill, zone badge, age line) down to 3.09:1 light /
    // 3.15:1 dark against the 4.5:1 floor, so nothing on a card is faded now.
    const classOf = (tag: string) =>
      (/\bclass="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean);
    const renderCard = (kind: "aggregator" | "niche") =>
      renderToStaticMarkup(
        createElement(SourceDirectory, {
          grouped: {
            pro_government: [{ ...GZT, kind, quarantined: true }],
          } as unknown as GroupedSources,
          countLabel: "0 haber",
        }),
      );

    // (a) the card wrapper does not fade everything inside it.
    const markup = renderCard("aggregator");
    const wrapperTag =
      [...markup.matchAll(/<div\b[^>]*>/g)]
        .map((m) => m[0])
        .find((tag) => classOf(tag).includes("group") && classOf(tag).includes("relative")) ?? "";
    expect(wrapperTag).not.toBe("");
    expect(classOf(wrapperTag)).toContain("rounded-xl");
    expect(classOf(wrapperTag)).not.toContain("opacity-70");

    // (b) the profile link and the external arrow carry no opacity class, the
    // markup has no opacity-70 anywhere, and the kind pill (the only cue left
    // that the card does not vote) is still rendered inside the profile link.
    for (const kind of ["aggregator", "niche"] as const) {
      const cardMarkup = renderCard(kind);
      const profileTag = /<a\b[^>]*\bhref="\/source\/gzt"[^>]*>/.exec(cardMarkup)?.[0] ?? "";
      expect(profileTag, `${kind}: profile link rendered`).not.toBe("");
      expect(classOf(profileTag).filter((t) => t.includes("opacity-")), `${kind}: profile link`).toEqual([]);
      const externalTag =
        /<a\b[^>]*\bhref="https:\/\/example\.com\/gzt"[^>]*>/.exec(cardMarkup)?.[0] ?? "";
      expect(externalTag, `${kind}: external link rendered`).not.toBe("");
      expect(classOf(externalTag).filter((t) => t.includes("opacity-")), `${kind}: external link`).toEqual([]);
      expect(cardMarkup, `${kind}: no opacity-70`).not.toContain("opacity-70");

      const profileOpen = cardMarkup.indexOf('href="/source/gzt"');
      const profileInner = cardMarkup.slice(profileOpen, cardMarkup.indexOf("</a>", profileOpen));
      expect(profileInner, `${kind}: kind pill inside the profile link`).toContain(
        SOURCE_KIND_META[kind].label,
      );
    }

    // (c) the status marker and its paragraph carry no opacity class at all.
    const markerTag = /<a\b[^>]*\bhref="\/kaynaklar\/durum"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(markerTag).not.toBe("");
    expect(classOf(markerTag).filter((t) => t.includes("opacity-"))).toEqual([]);
    const markerPara = /<p\b[^>]*>(?=<a\b[^>]*\bhref="\/kaynaklar\/durum")/.exec(markup)?.[0] ?? "";
    expect(markerPara).not.toBe("");
    expect(classOf(markerPara).filter((t) => t.includes("opacity-"))).toEqual([]);
  });

  it("a voting card has no opacity-70 anywhere either (no card is faded, h79-markup-1)", () => {
    const markup = renderToStaticMarkup(
      createElement(SourceDirectory, {
        grouped: {
          pro_government: [{ ...GZT, quarantined: true }],
        } as unknown as GroupedSources,
        countLabel: "0 haber",
      }),
    );
    expect(markup).not.toContain("opacity-70");
  });
});

describe("/sources page source -- quarantine is computed inside the cached reader (h47-sources-1)", () => {
  const code = stripComments(PAGE_SOURCE);
  const reader = functionSource(code, "readSourcesDirectory");

  it("selects fetch_quarantined_until from sources", () => {
    expect(reader).toMatch(/"[^"]*\bfetch_quarantined_until\b[^"]*"/);
  });

  it("derives the verdict with isRowQuarantined(<column>, nowMs), the fill-time anchor the read already takes", () => {
    expect(reader).toMatch(/\bisRowQuarantined\([^)]*,\s*nowMs\s*\)/);
    expect(code).toMatch(
      /import\s*\{[^}]*\bisRowQuarantined\b[^}]*\}\s*from\s*"@\/lib\/sources\/feed-status"/,
    );
  });

  it("adds no clock read of its own: the reader keeps its two Date.now() calls (7-day window, nowMs)", () => {
    expect(reader.match(/\bDate\.now\s*\(/g)).toHaveLength(2);
  });

  it("keeps cacheLife as one literal per branch (no conditional argument)", () => {
    expect(code).toMatch(/if \(r\.ok\) cacheLife\("source-directory"\);\s*else cacheLife\("minutes"\);/);
  });
});

// ---------------------------------------------------------------------------
// h103-sourcescores-2: /kaynaklar/durum and the source profile call a feed that
// answers but delivers nothing new "akış donmuş", yet /sources gave Ayandon,
// Investing.com TR and Platform 24 no marker at all ("son 7 günde 0 haber"
// next to a bare card) and its header counted only the quarantined feeds. The
// directory read now also selects fetch_last_status, fetch_fail_streak,
// fetch_newest_item_at and fetch_items_count and stamps `feedFrozen` on each
// row at cache fill time with the same `nowMs` it already uses for
// `quarantined` (classifySilence, unchanged): the page body stays clock-free.
// A frozen card carries an amber "Akış donmuş" marker linking to
// /kaynaklar/durum (a quarantined card keeps only "Akış alınamıyor"), and the
// header gains "{m} kaynağın beslemesi donmuş: ..." in the same paragraph.
// ---------------------------------------------------------------------------

describe("/sources page -- frozen feeds are visible (h103-sourcescores-2)", () => {
  const FROZEN_NOW = Date.parse("2026-11-09T11:00:00.000Z");
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const FROZEN_NEWEST = "2026-10-02T14:41:30Z";
  const inOneHour = new Date(FROZEN_NOW + 3_600_000).toISOString();
  const MARKER = "Akış donmuş";
  const QUARANTINE_MARKER = "Akış alınamıyor";
  const FROZEN_SENTENCE = "kaynağın beslemesi donmuş: yanıt veriyor ama yeni haber gelmiyor.";
  const QUARANTINE_SENTENCE = "kaynağın beslemesi şu anda alınamıyor.";
  const MARKER_LINK = /<a\b[^>]*\bhref="\/kaynaklar\/durum"[^>]*>Akış donmuş<\/a>/;
  const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  type FrozenRow = { slug: string; feedFrozen: boolean; quarantined: boolean } & Record<
    string,
    unknown
  >;

  async function groupedProps() {
    const tree = await SourcesPage();
    const child = findSuspenses(tree)[0]?.props?.children as TreeElement;
    return (child.props as unknown as Parameters<typeof SourceDirectoryWithCounts>[0]).grouped;
  }
  async function groupedRows(): Promise<FrozenRow[]> {
    return Object.values(await groupedProps()).flat() as unknown as FrozenRow[];
  }
  const frozenOf = (rows: FrozenRow[], slug: string) => rows.find((r) => r.slug === slug)?.feedFrozen;
  async function fullText(): Promise<string> {
    return (await collectText(await SourcesPage())).join("");
  }
  async function cardsMarkup(): Promise<string> {
    return renderToStaticMarkup(
      createElement(SourceDirectory, { grouped: await groupedProps(), countLabel: "0 haber" }),
    );
  }

  it("(a) status 200, fail streak 0, newest item 2026-10-02, not quarantined: feedFrozen is true and the card says 'Akış donmuş' linking to /kaynaklar/durum", async () => {
    supabaseFixture.feedBySlug = {
      "s-outlet": { status: 200, failStreak: 0, newest: FROZEN_NEWEST, items: 12 },
    };
    const rows = await groupedRows();
    expect(frozenOf(rows, "s-outlet")).toBe(true);
    expect(frozenOf(rows, "s-aggregator")).toBe(false);
    expect(frozenOf(rows, "s-wire")).toBe(false);

    const markup = await cardsMarkup();
    expect(MARKER_LINK.test(markup)).toBe(true);
    expect(countOf(markup, MARKER)).toBe(1);
    expect(countOf(await fullText(), MARKER)).toBe(1);
  });

  it("(b) status 304 with an item count of 0 is frozen, whatever the newest item says (an empty feed)", async () => {
    supabaseFixture.feedBySlug = { "s-wire": { status: 304, failStreak: 0, newest: null, items: 0 } };
    const rows = await groupedRows();
    expect(frozenOf(rows, "s-wire")).toBe(true);
    expect(countOf(await cardsMarkup(), MARKER)).toBe(1);
  });

  it("(c) a feed item 10 h old is not frozen and the card renders no marker", async () => {
    supabaseFixture.feedBySlug = {
      "s-outlet": {
        status: 200,
        failStreak: 0,
        newest: new Date(FROZEN_NOW - 10 * 3_600_000).toISOString(),
        items: 40,
      },
    };
    const rows = await groupedRows();
    expect(rows.every((r) => r.feedFrozen === false)).toBe(true);
    const markup = await cardsMarkup();
    expect(markup).not.toContain(MARKER);
    expect(markup).not.toContain("/kaynaklar/durum");
    expect(await fullText()).not.toContain(MARKER);
  });

  it("the 72 h edge is strict, as in classifySilence: exactly 72 h old still delivers, one millisecond older is frozen", async () => {
    const at = (ageMs: number) => new Date(FROZEN_NOW - ageMs).toISOString();
    const seventyTwoHours = 72 * 3_600_000;
    supabaseFixture.feedBySlug = {
      "s-outlet": { status: 200, failStreak: 0, newest: at(seventyTwoHours), items: 3 },
      "s-wire": { status: 200, failStreak: 0, newest: at(seventyTwoHours + 1), items: 3 },
    };
    const rows = await groupedRows();
    expect(frozenOf(rows, "s-outlet")).toBe(false);
    expect(frozenOf(rows, "s-wire")).toBe(true);
  });

  it("(d) a quarantined row with a stale newest item is not frozen: feedFrozen false and only 'Akış alınamıyor' renders", async () => {
    supabaseFixture.quarantinedUntilBySlug = { "s-outlet": inOneHour };
    supabaseFixture.feedBySlug = {
      "s-outlet": { status: 200, failStreak: 0, newest: FROZEN_NEWEST, items: 12 },
    };
    const rows = await groupedRows();
    const row = rows.find((r) => r.slug === "s-outlet")!;
    expect(row.quarantined).toBe(true);
    expect(row.feedFrozen).toBe(false);

    const markup = await cardsMarkup();
    expect(countOf(markup, QUARANTINE_MARKER)).toBe(1);
    expect(markup).not.toContain(MARKER);
    const text = await fullText();
    expect(countOf(text, QUARANTINE_MARKER)).toBe(1);
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(FROZEN_SENTENCE);
  });

  it("(e) a failure streak of 2 with status 200 is not frozen (erişim yok), and neither is a 4xx/5xx or a never-fetched feed", async () => {
    supabaseFixture.feedBySlug = {
      "s-outlet": { status: 200, failStreak: 2, newest: FROZEN_NEWEST, items: 12 },
      "s-aggregator": { status: 403, failStreak: 0, newest: FROZEN_NEWEST, items: 12 },
      "s-wire": { status: null, failStreak: 0, newest: FROZEN_NEWEST, items: 12 },
    };
    const rows = await groupedRows();
    expect(rows.every((r) => r.feedFrozen === false)).toBe(true);
    expect(await cardsMarkup()).not.toContain(MARKER);
  });

  it("a NULL fail streak reads as 0 (the `?? 0` of the profile query), a NULL newest with a NULL count is never frozen", async () => {
    supabaseFixture.feedBySlug = {
      "s-outlet": { status: 200, failStreak: null, newest: FROZEN_NEWEST, items: 12 },
      "s-wire": { status: 200, failStreak: 0, newest: null, items: null },
    };
    const rows = await groupedRows();
    expect(frozenOf(rows, "s-outlet")).toBe(true);
    expect(frozenOf(rows, "s-wire")).toBe(false);
  });

  it("an aggregator's frozen feed is marked too: the marker does not depend on the kind", async () => {
    supabaseFixture.feedBySlug = {
      "s-aggregator": { status: 200, failStreak: 0, newest: FROZEN_NEWEST, items: 5 },
    };
    expect(frozenOf(await groupedRows(), "s-aggregator")).toBe(true);
    expect(countOf(await cardsMarkup(), MARKER)).toBe(1);
  });

  it("(f) with 2 quarantined and 3 frozen sources the header prints both sentences in ONE paragraph with one /kaynaklar/durum link", async () => {
    supabaseFixture.extraRows = [
      {
        id: "s-extra-a",
        name: "Ekstra A",
        slug: "s-extra-a",
        url: "https://example.com/a",
        rss_url: "https://example.com/a/rss",
        bias: "opposition",
        logo_url: null,
        active: true,
        kind: "outlet",
      },
      {
        id: "s-extra-b",
        name: "Ekstra B",
        slug: "s-extra-b",
        url: "https://example.com/b",
        rss_url: "https://example.com/b/rss",
        bias: "opposition",
        logo_url: null,
        active: true,
        kind: "niche",
      },
    ];
    supabaseFixture.quarantinedUntilBySlug = { "s-outlet": inOneHour, "s-extra-a": inOneHour };
    const frozen = { status: 200, failStreak: 0, newest: FROZEN_NEWEST, items: 7 };
    supabaseFixture.feedBySlug = {
      "s-aggregator": frozen,
      "s-wire": frozen,
      "s-extra-b": frozen,
      // a quarantined source's feed columns are stale too, and must not be counted twice
      "s-outlet": frozen,
      "s-extra-a": frozen,
    };

    const tree = await SourcesPage();
    const text = (await collectText(tree)).join("");
    expect(text).toContain(`2 ${QUARANTINE_SENTENCE}`);
    expect(text).toContain(`3 ${FROZEN_SENTENCE}`);
    expect(text.indexOf(`2 ${QUARANTINE_SENTENCE}`)).toBeLessThan(text.indexOf(`3 ${FROZEN_SENTENCE}`));

    const headers = await paragraphsContaining(tree, FROZEN_SENTENCE);
    expect(headers).toHaveLength(1);
    expect((await collectText(headers[0])).join("")).toContain(QUARANTINE_SENTENCE);
    expect(await collectHrefs(headers[0])).toEqual(["/kaynaklar/durum"]);
    expect(countOf(await cardsMarkup(), MARKER)).toBe(3);
    expect(countOf(await cardsMarkup(), QUARANTINE_MARKER)).toBe(2);
  });

  it("(f) with 0 frozen sources the header prints only the existing quarantine sentence, unchanged", async () => {
    supabaseFixture.quarantinedUntilBySlug = { "s-outlet": inOneHour, "s-wire": inOneHour };
    const tree = await SourcesPage();
    const text = (await collectText(tree)).join("");
    expect(text).toContain(`2 ${QUARANTINE_SENTENCE}`);
    expect(text).not.toContain("donmuş");
    const headers = await paragraphsContaining(tree, QUARANTINE_SENTENCE);
    expect(headers).toHaveLength(1);
    expect(await collectHrefs(headers[0])).toEqual(["/kaynaklar/durum"]);
  });

  it("(f) with frozen sources but nothing quarantined the header still appears: the frozen sentence and the Kaynak durumu link", async () => {
    supabaseFixture.feedBySlug = {
      "s-aggregator": { status: 200, failStreak: 0, newest: FROZEN_NEWEST, items: 7 },
    };
    const tree = await SourcesPage();
    const text = (await collectText(tree)).join("");
    expect(text).toContain(`1 ${FROZEN_SENTENCE}`);
    expect(text).not.toContain("şu anda alınamıyor");
    const headers = await paragraphsContaining(tree, FROZEN_SENTENCE);
    expect(headers).toHaveLength(1);
    expect(await collectHrefs(headers[0])).toEqual(["/kaynaklar/durum"]);
    expect((await collectText(headers[0])).join("")).toContain("Kaynak durumu");
  });

  it("with m = 0 and k = 0 the header adds nothing at all", async () => {
    const tree = await SourcesPage();
    const text = (await collectText(tree)).join("");
    expect(text).not.toContain("donmuş");
    expect(text).not.toContain("alınamıyor");
    expect(await paragraphsContaining(tree, "beslemesi")).toEqual([]);
  });

  it("(g) a SourceRow exposes no raw fetch_* key, only the two booleans", async () => {
    supabaseFixture.quarantinedUntilBySlug = { "s-outlet": inOneHour };
    supabaseFixture.feedBySlug = {
      "s-wire": { status: 200, failStreak: 0, newest: FROZEN_NEWEST, items: 12 },
    };
    const rows = await groupedRows();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Object.keys(row).filter((k) => k.startsWith("fetch_"))).toEqual([]);
      expect(typeof row.feedFrozen).toBe("boolean");
      expect(typeof row.quarantined).toBe("boolean");
    }
  });

  it("does not change the header numbers: the title count and the N/M pair ignore frozen feeds", async () => {
    const baseline = findPropString(await SourcesPage(), "subtitle");
    supabaseFixture.feedBySlug = {
      "s-outlet": { status: 200, failStreak: 0, newest: FROZEN_NEWEST, items: 12 },
      "s-wire": { status: 304, failStreak: 0, newest: null, items: 0 },
    };
    const tree = await SourcesPage();
    expect(findPropString(tree, "subtitle")).toBe(baseline);
    expect((await collectText(tree)).join("")).toContain("0/3");
  });

  it("the verdict is part of the cached rows: rendering ten hours later still shows the fill-time marker", async () => {
    supabaseFixture.feedBySlug = {
      "s-outlet": { status: 200, failStreak: 0, newest: FROZEN_NEWEST, items: 12 },
    };
    const grouped = await groupedProps();
    vi.setSystemTime(FROZEN_NOW + 10 * 3_600_000);
    const markup = renderToStaticMarkup(createElement(SourceDirectory, { grouped, countLabel: "0 haber" }));
    expect(countOf(markup, MARKER)).toBe(1);
  });

  it("a read that omitted any of the four fetch_* columns from its select would not mark anything (the fake returns only selected columns)", async () => {
    // The fake mirrors PostgREST: a column that is not in the select string is not on the row, so
    // a reader that forgot one of the four could never reach 'akis_donmus'. The positive cases
    // above would fail; this pins the select string itself.
    const reader = functionSource(stripComments(PAGE_SOURCE), "readSourcesDirectory");
    for (const column of [
      "fetch_last_status",
      "fetch_fail_streak",
      "fetch_newest_item_at",
      "fetch_items_count",
    ]) {
      expect(reader, column).toMatch(new RegExp(`"[^"]*\\b${column}\\b[^"]*"`));
    }
  });

  // correctness-1: only a SILENT source is classified, exactly as on
  // /kaynaklar/durum (toFeedStatusRows) and the profile (source-profile-query).
  // A source with a stored article inside FEED_YIELD_WINDOW_MS counts as
  // delivering in the DenominatorNote, so it is never also "akış donmuş".
  describe("a source with a recent stored article is delivering, never frozen (correctness-1)", () => {
    const HOUR = 3_600_000;
    const storedAgo = (ageMs: number) => new Date(FROZEN_NOW - ageMs).toISOString();

    it("(1) an empty poll (items 0, no newest item) with a stored article 1 h old is not frozen: no marker, no header sentence", async () => {
      supabaseFixture.feedBySlug = {
        "s-outlet": { status: 200, failStreak: 0, newest: null, items: 0 },
      };
      supabaseFixture.latestBySlug = { "s-outlet": storedAgo(HOUR) };
      const rows = await groupedRows();
      expect(frozenOf(rows, "s-outlet")).toBe(false);
      expect(await cardsMarkup()).not.toContain(MARKER);
      expect(await fullText()).not.toContain(FROZEN_SENTENCE);
    });

    it("(2) a stale fetch_newest_item_at with 12 items and a stored article 1 h old is not frozen", async () => {
      supabaseFixture.feedBySlug = {
        "s-outlet": { status: 200, failStreak: 0, newest: FROZEN_NEWEST, items: 12 },
      };
      supabaseFixture.latestBySlug = { "s-outlet": storedAgo(HOUR) };
      const rows = await groupedRows();
      expect(frozenOf(rows, "s-outlet")).toBe(false);
      expect(await cardsMarkup()).not.toContain(MARKER);
      expect(await fullText()).not.toContain(FROZEN_SENTENCE);
    });

    it("(3) the delivering edge is strict: a stored article exactly 72 h old is delivering, 72 h + 1 ms is frozen, none at all stays frozen", async () => {
      const stale = { status: 200, failStreak: 0, newest: FROZEN_NEWEST, items: 12 };
      supabaseFixture.feedBySlug = {
        "s-outlet": stale,
        "s-wire": stale,
        "s-aggregator": stale,
      };
      supabaseFixture.latestBySlug = {
        "s-outlet": storedAgo(72 * HOUR),
        "s-wire": storedAgo(72 * HOUR + 1),
        // s-aggregator: no stored article in the window
      };
      const rows = await groupedRows();
      expect(frozenOf(rows, "s-outlet")).toBe(false);
      expect(frozenOf(rows, "s-wire")).toBe(true);
      expect(frozenOf(rows, "s-aggregator")).toBe(true);
    });

    it("a future-dated stored article does not count as delivering (the same guard as deriveDirectoryStats), so the frozen verdict stands", async () => {
      supabaseFixture.feedBySlug = {
        "s-outlet": { status: 200, failStreak: 0, newest: FROZEN_NEWEST, items: 12 },
      };
      supabaseFixture.latestBySlug = { "s-outlet": new Date(FROZEN_NOW + HOUR).toISOString() };
      expect(frozenOf(await groupedRows(), "s-outlet")).toBe(true);
    });
  });
});

describe("countFrozenSources (h103-sourcescores-2)", () => {
  const row = (feedFrozen: boolean | undefined, quarantined = false) =>
    ({ ...GZT, feedFrozen, quarantined }) as unknown as GroupedSources["pro_government"][number];

  it("counts the rows stamped feedFrozen across every bias bucket, of every kind", () => {
    const grouped = {
      pro_government: [row(true), row(false), { ...row(true), kind: "aggregator" }],
      opposition: [{ ...row(true), kind: "niche" }, row(undefined)],
    } as unknown as GroupedSources;
    expect(countFrozenSources(grouped)).toBe(3);
  });

  it("is zero for an empty or partial grouping and for rows that predate the field", () => {
    expect(countFrozenSources({})).toBe(0);
    expect(countFrozenSources({ center: [] } as unknown as GroupedSources)).toBe(0);
    expect(countFrozenSources({ center: [row(undefined)] } as unknown as GroupedSources)).toBe(0);
  });
});

describe("SourceDirectory -- the 'Akış donmuş' card marker (h103-sourcescores-2)", () => {
  const render = (row: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(SourceDirectory, {
        grouped: { pro_government: [{ ...GZT, ...row }] } as unknown as GroupedSources,
        countLabel: "0 haber",
      }),
    );
  const MARKER_LINK = /<a\b[^>]*\bhref="\/kaynaklar\/durum"[^>]*>Akış donmuş<\/a>/;
  const classOf = (tag: string) =>
    (/\bclass="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean);

  it("a frozen card carries a link to /kaynaklar/durum named 'Akış donmuş' with the explanatory title", () => {
    const markup = render({ feedFrozen: true });
    expect(MARKER_LINK.test(markup)).toBe(true);
    const tag = /<a\b[^>]*\bhref="\/kaynaklar\/durum"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(tag).toContain('title="Besleme yanıt veriyor ama yeni haber gelmiyor"');
  });

  it("the marker sits beside the profile link, never inside it (anchors cannot nest)", () => {
    const markup = render({ feedFrozen: true });
    const profileOpen = markup.indexOf('href="/source/gzt"');
    const profileClose = markup.indexOf("</a>", profileOpen);
    const marker = MARKER_LINK.exec(markup);
    expect(profileOpen).toBeGreaterThan(-1);
    expect(marker).not.toBeNull();
    expect(marker!.index).toBeGreaterThan(profileClose);
    expect(markup.match(/href="\/source\/gzt"/g)).toHaveLength(1);
  });

  it("the marker is a 24 px target (WCAG 2.5.8) with the amber pill, one-line, and no rose styling", () => {
    const tag = /<a\b[^>]*\bhref="\/kaynaklar\/durum"[^>]*>/.exec(render({ feedFrozen: true }))?.[0] ?? "";
    const tokens = classOf(tag);
    for (const token of [
      "inline-flex",
      "items-center",
      "min-h-6",
      "whitespace-nowrap",
      "rounded-full",
      "border-amber-500/30",
      "bg-amber-500/15",
      "text-amber-900",
      "dark:text-amber-300",
    ]) {
      expect(tokens).toContain(token);
    }
    expect(tokens.filter((t) => t.includes("rose"))).toEqual([]);
    expect(tokens.filter((t) => t.includes("opacity-"))).toEqual([]);
  });

  it("a card that is both quarantined and frozen shows only 'Akış alınamıyor', never both markers", () => {
    const markup = render({ quarantined: true, feedFrozen: true });
    expect(markup).toContain("Akış alınamıyor");
    expect(markup).not.toContain("Akış donmuş");
    expect(markup.match(/href="\/kaynaklar\/durum"/g)).toHaveLength(1);
  });

  it("a healthy card (false, or a row that predates the field) renders no marker and no /kaynaklar/durum link", () => {
    for (const feedFrozen of [false, undefined]) {
      const markup = render({ feedFrozen, quarantined: false });
      expect(markup).not.toContain("Akış donmuş");
      expect(markup).not.toContain("/kaynaklar/durum");
    }
  });
});

describe("/sources page source -- the frozen verdict is computed inside the cached reader (h103-sourcescores-2)", () => {
  const code = stripComments(PAGE_SOURCE);
  const reader = functionSource(code, "readSourcesDirectory");

  it("derives feedFrozen with classifySilence from the shared module, fed the same fill-time nowMs and the row's quarantine verdict", () => {
    expect(code).toMatch(
      /import\s*\{[^}]*\bclassifySilence\b[^}]*\}\s*from\s*"@\/lib\/sources\/silence-reason"/,
    );
    expect(reader).toMatch(/\bclassifySilence\(/);
    expect(reader).toMatch(/\bnowMs,?\s*\)\s*===\s*"akis_donmus"/);
    expect(reader).toMatch(/!\s*quarantined\b/);
  });

  it("classifies only a silent source: the same delivering predicate as deriveDirectoryStats gates feedFrozen (correctness-1)", () => {
    expect(reader).toMatch(/!\s*delivering\b/);
    expect(reader).toMatch(/\bnowMs\s*-\s*lastMs\s*<=\s*FEED_YIELD_WINDOW_MS\b/);
    expect(reader).toMatch(/\blastMs\s*<=\s*nowMs\b/);
  });

  it("drops the four raw fetch_* columns from the row, like fetch_quarantined_until", () => {
    // The destructure that feeds `rest` renames every raw column (`column: local`), so none is
    // spread into SourceRow. Only that statement is searched: the row type also names the columns.
    const destructure = /const\s*\{([^}]*)\}\s*=\s*source\s*;/.exec(reader)?.[1] ?? "";
    expect(destructure).toMatch(/\.\.\.rest\b/);
    for (const column of [
      "fetch_quarantined_until",
      "fetch_last_status",
      "fetch_fail_streak",
      "fetch_newest_item_at",
      "fetch_items_count",
    ]) {
      expect(destructure, column).toMatch(new RegExp(`\\b${column}\\s*:\\s*\\w+`));
    }
  });

  it("adds no clock read of its own: the reader keeps its two Date.now() calls and the body none", () => {
    expect(reader.match(/\bDate\.now\s*\(/g)).toHaveLength(2);
    const body = code.replace(reader, "");
    expect(body.match(/\bDate\.now\s*\(|\bnew Date\(\s*\)/g)).toBeNull();
  });

  it("keeps cacheLife as one literal per branch (untouched)", () => {
    expect(code).toMatch(/if \(r\.ok\) cacheLife\("source-directory"\);\s*else cacheLife\("minutes"\);/);
  });
});
