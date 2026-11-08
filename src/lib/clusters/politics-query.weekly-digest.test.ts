import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// h71-timebounds-1: the weekly digest ("Tayf Haftalık Bülteni", "Bu hafta ...")
// used to pick its top 5 from the home-feed pool of the 200 most recently
// UPDATED clusters (about the last 25 h), so none of Monday to Thursday's
// biggest stories could appear in a mail sent on Saturday. getWeeklyDigestClusters
// reads the week itself: first_published inside the trailing 7 days, biggest
// article_count first, the same window /hafta uses.
//
// The read is two steps (mig176-2): an ids-only select (filters, both orders,
// limit 40) and then the embedded select for exactly those ids, because one
// ORDER BY ... LIMIT over the embed made Postgres run the per-cluster aggregate
// for every window cluster (4.3 s partly cold on prod, against an 8 s timeout).
// Each step is tried at most twice (ts-2): a failed first attempt logs one
// warning and runs the identical query once more, live; two errors reject.
//
// The query builder is a hand-rolled chain like politics-query.test.ts. Most
// tests read the recorded chains; the table-driven tests give the fake a small
// in-memory `clusters` table (`serve`) and evaluate the recorded filters, order,
// limit and `.in()` against it, so they check what the two queries would return,
// not just their text. The `.in()` step returns rows in TABLE order, as
// PostgREST returns them in no order at all, so the JS sort is load-bearing.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
}

type Step = { method: string; args: unknown[] };
type CallEntry = { table: string; steps: Step[] };

let callLog: CallEntry[] = [];
let response: FakeResult = { data: [], error: null };
/** When set, the rows come from evaluating the recorded steps against a table. */
let respond: ((steps: Step[], callIndex: number) => FakeResult) | null = null;

function makeFakeClient() {
  return {
    from(table: string) {
      const steps: Step[] = [];
      const callIndex = callLog.length;
      callLog.push({ table, steps });
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq", "order", "gte", "lte", "limit", "in"]) {
        builder[name] = (...args: unknown[]) => {
          steps.push({ method: name, args });
          return builder;
        };
      }
      builder.returns = (...args: unknown[]) => {
        steps.push({ method: "returns", args });
        return {
          then: (fn: (v: FakeResult) => unknown) =>
            Promise.resolve(respond ? respond(steps, callIndex) : response).then(fn),
        };
      };
      return builder;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(() => makeFakeClient()),
  createReaderClient: vi.fn(() => makeFakeClient()),
}));

// The digest never reads feed health (it does not render the blindspot flag of
// its top clusters), so this mock exists only to prove the query does not
// depend on a second round-trip.
const feedHealth = vi.hoisted(() => ({
  getZoneFeedHealth: vi.fn(async () => null as unknown),
}));

vi.mock("./feed-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./feed-health")>();
  return { ...actual, getZoneFeedHealth: feedHealth.getZoneFeedHealth };
});

import {
  CLUSTER_EMBED_SELECT,
  getWeeklyDigestClusters,
  type EmbeddedClusterRow,
} from "./politics-query";
import { WEEK_MS } from "@/lib/weekly/weekly-query";
import { createReaderClient, createServerClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Saturday 09:00 TRT, the digest's real send time.
const SATURDAY_0900_TRT_MS = Date.parse("2026-11-07T06:00:00Z");
const NOW_MS = SATURDAY_0900_TRT_MS;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The system clock is pinned somewhere else on purpose: the window must come
// from the nowMs argument, never from Date.now().
const SYSTEM_CLOCK_MS = Date.parse("2030-01-01T00:00:00Z");

interface MkRowOpts {
  id: string;
  /** The stored clusters.article_count column. Defaults to the member count. */
  articleCount?: number;
  firstPublished: string;
  /** Member articles (each from its own source). Defaults to articleCount. */
  members?: number;
  /** How many of the members are politika; the rest are "ekonomi". Defaults to all. */
  politicsMembers?: number;
  sourceName?: (i: number) => string;
  isArchived?: boolean;
}

type TableRow = EmbeddedClusterRow & { is_archived: boolean };

function mkRow(opts: MkRowOpts): TableRow {
  const articleCount = opts.articleCount ?? opts.members ?? 2;
  const memberCount = opts.members ?? articleCount;
  const politicsMembers = opts.politicsMembers ?? memberCount;
  const published = new Date(opts.firstPublished).toISOString();
  return {
    id: opts.id,
    title_tr: `Cluster ${opts.id}`,
    title_tr_neutral: null,
    summary_tr: "summary",
    bias_distribution: {},
    is_blindspot: false,
    blindspot_side: null,
    article_count: articleCount,
    first_published: published,
    updated_at: published,
    is_archived: opts.isArchived ?? false,
    cluster_articles: Array.from({ length: memberCount }, (_, i) => ({
      articles: {
        id: `${opts.id}-a${i}`,
        title: `Article ${opts.id} ${i}`,
        url: `https://example.com/${opts.id}/${i}`,
        image_url: null,
        published_at: published,
        source_id: `${opts.id}-s${i}`,
        category: i < politicsMembers ? "politika" : "ekonomi",
        content_hash: `h-${opts.id}-${i}`,
        politics_admitted_at: null,
        sources: {
          id: `${opts.id}-s${i}`,
          name: opts.sourceName ? opts.sourceName(i) : `Gazete ${opts.id} ${i}`,
          bias: "center",
          logo_url: null,
          kind: "outlet",
        },
      },
    })),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Evaluates the recorded clusters query against an in-memory table, the way
 * PostgREST would: eq / gte / lte filters, the ordered columns, then limit.
 */
function evaluate(table: readonly TableRow[], steps: Step[]): FakeResult {
  const col = (r: TableRow, name: string) =>
    (r as unknown as Record<string, string | number | boolean>)[name]!;
  let rows = [...table];
  for (const s of steps) {
    const name = s.args[0] as string;
    const value = s.args[1] as string | number | boolean;
    if (s.method === "eq") rows = rows.filter((r) => col(r, name) === value);
    if (s.method === "gte") rows = rows.filter((r) => col(r, name) >= value);
    if (s.method === "lte") rows = rows.filter((r) => col(r, name) <= value);
  }
  const orders = steps
    .filter((s) => s.method === "order")
    .map((s) => ({
      name: s.args[0] as string,
      ascending: (s.args[1] as { ascending?: boolean } | undefined)?.ascending !== false,
    }));
  rows.sort((a, b) => {
    for (const o of orders) {
      const av = col(a, o.name);
      const bv = col(b, o.name);
      if (av === bv) continue;
      return (av < bv ? -1 : 1) * (o.ascending ? 1 : -1);
    }
    return 0;
  });
  const limit = steps.find((s) => s.method === "limit")?.args[0];
  if (typeof limit === "number") rows = rows.slice(0, limit);
  return { data: rows, error: null };
}

type ChainKind = "ids" | "embed";
/** Step 1 selects only `id`; step 2 selects the embed. */
const kindOf = (steps: Step[]): ChainKind =>
  steps.find((s) => s.method === "select")!.args[0] === "id" ? "ids" : "embed";

const BOOM = { data: null, error: { message: "boom" } } as const satisfies FakeResult;

/**
 * Serves the two-step read from an in-memory table. `fail(kind, attempt)` may
 * return an error result for one attempt of one step (attempt counts from 0);
 * returning undefined lets that attempt through.
 */
function serve(
  table: readonly TableRow[],
  fail?: (kind: ChainKind, attempt: number) => FakeResult | undefined,
): void {
  const attempts: Record<ChainKind, number> = { ids: 0, embed: 0 };
  respond = (steps) => {
    const kind = kindOf(steps);
    const injected = fail?.(kind, attempts[kind]++);
    if (injected) return injected;
    if (kind === "ids") {
      const picked = evaluate(table, steps).data as TableRow[];
      return { data: picked.map((row) => ({ id: row.id })), error: null };
    }
    const wanted = new Set(steps.find((s) => s.method === "in")!.args[1] as string[]);
    return { data: table.filter((row) => wanted.has(row.id)), error: null };
  };
}

const methodsOf = (entry: CallEntry) => entry.steps.map((s) => s.method);

const ids = (bundles: Array<{ cluster: { id: string } }>) =>
  bundles.map((b) => b.cluster.id);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  callLog = [];
  response = { data: [], error: null };
  respond = null;
  vi.mocked(createReaderClient).mockClear();
  vi.mocked(createServerClient).mockClear();
  feedHealth.getZoneFeedHealth.mockClear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(new Date(SYSTEM_CLOCK_MS));
});

afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
});

// ---------------------------------------------------------------------------
// Query shape
// ---------------------------------------------------------------------------

describe("getWeeklyDigestClusters query shape (two steps)", () => {
  const week = () => [
    mkRow({ id: "b-mid", articleCount: 20, firstPublished: iso(NOW_MS - 3 * DAY_MS) }),
    mkRow({ id: "a-big", articleCount: 30, firstPublished: iso(NOW_MS - 5 * DAY_MS) }),
    mkRow({ id: "c-small", articleCount: 3, firstPublished: iso(NOW_MS - HOUR_MS) }),
  ];

  it("step 1 selects only ids: the week's window, the member floor, both orders and the limit of 40", async () => {
    serve(week());
    await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });

    // "batch": the plain client (8 s statement_timeout), never the 4 s reader.
    expect(createServerClient).toHaveBeenCalledTimes(1);
    expect(createReaderClient).not.toHaveBeenCalled();
    // No feed-health read rides along.
    expect(feedHealth.getZoneFeedHealth).not.toHaveBeenCalled();

    const first = callLog[0]!;
    expect(first.table).toBe("clusters");
    const of = (method: string) => first.steps.filter((s) => s.method === method).map((s) => s.args);

    // Ids only: no embed, so Postgres does not run the per-cluster aggregate for the whole window.
    expect(of("select")).toEqual([["id"]]);
    // Archived clusters never reach a reader-facing surface.
    expect(of("eq")).toEqual([["is_archived", false]]);
    expect(of("gte")).toContainEqual(["article_count", 2]);
    // The window is [nowMs - 7d, nowMs], both from the argument.
    expect(of("gte")).toContainEqual(["first_published", iso(NOW_MS - WEEK_MS)]);
    expect(of("lte")).toEqual([["first_published", iso(NOW_MS)]]);
    // Biggest first, ties broken by id; never the home feed's updated_at order.
    expect(of("order")).toEqual([
      ["article_count", { ascending: false }],
      ["id", { ascending: true }],
    ]);
    expect(of("limit")).toEqual([[40]]);
    expect(of("in")).toEqual([]);
  });

  it("step 2 embeds exactly the step-1 ids, in step-1 order, with no other filter", async () => {
    serve(week());
    await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });

    expect(callLog).toHaveLength(2);
    const second = callLog[1]!;
    expect(second.table).toBe("clusters");
    // Same embedded shape the home feed reads.
    expect(second.steps.find((s) => s.method === "select")!.args).toEqual([CLUSTER_EMBED_SELECT]);
    // Step 1 ordered the ids article_count desc: a-big (30), b-mid (20), c-small (3).
    expect(second.steps.filter((s) => s.method === "in").map((s) => s.args)).toEqual([
      ["id", ["a-big", "b-mid", "c-small"]],
    ]);
    // Only select, in, returns: the 40 ids carry every filter, the embed adds none (and no order, limit or window).
    expect(methodsOf(second)).toEqual(["select", "in", "returns"]);
    expect(createServerClient).toHaveBeenCalledTimes(1);
  });

  it("step-2 rows that arrive shuffled come back ordered article_count desc, id asc after admission", async () => {
    // .in() returns rows in no order: the table order here is the opposite of the right one.
    serve([
      mkRow({ id: "z-small", articleCount: 3, firstPublished: iso(NOW_MS - DAY_MS) }),
      mkRow({ id: "m-tie-b", articleCount: 10, firstPublished: iso(NOW_MS - DAY_MS) }),
      mkRow({ id: "m-tie-a", articleCount: 10, firstPublished: iso(NOW_MS - 2 * DAY_MS) }),
      mkRow({ id: "a-big", articleCount: 30, firstPublished: iso(NOW_MS - 3 * DAY_MS) }),
    ]);
    const out = await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });
    expect(callLog[1]!.steps.find((s) => s.method === "in")!.args[1]).toEqual([
      "a-big",
      "m-tie-a",
      "m-tie-b",
      "z-small",
    ]);
    expect(ids(out)).toEqual(["a-big", "m-tie-a", "m-tie-b", "z-small"]);
  });

  it("an empty step 1 returns [] and never issues the second chain (no empty .in())", async () => {
    serve([]);
    await expect(getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" })).resolves.toEqual([]);
    expect(callLog).toHaveLength(1);
    expect(callLog.flatMap((c) => c.steps).some((s) => s.method === "in")).toBe(false);
  });

  it("derives the window from nowMs, not from the system clock", async () => {
    // The system clock is 2030; the window must still end at the argument.
    await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });
    const steps = callLog[0]!.steps;
    const lte = steps.find((s) => s.method === "lte")!;
    expect(lte.args).toEqual(["first_published", "2026-11-07T06:00:00.000Z"]);
    const from = steps.filter((s) => s.method === "gte").map((s) => s.args);
    expect(from).toContainEqual(["first_published", "2026-10-31T06:00:00.000Z"]);
  });

  it("returns an empty list for an empty week", async () => {
    response = { data: [], error: null };
    await expect(
      getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" }),
    ).resolves.toEqual([]);
  });

  it("treats a null step-1 payload as an empty week", async () => {
    response = { data: null, error: null };
    await expect(
      getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" }),
    ).resolves.toEqual([]);
    expect(callLog).toHaveLength(1);
  });

  it("treats a null step-2 payload as no clusters, not as an error", async () => {
    respond = (steps) =>
      kindOf(steps) === "ids" ? { data: [{ id: "a" }], error: null } : { data: null, error: null };
    await expect(
      getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" }),
    ).resolves.toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// One live retry per step, then throw
// ---------------------------------------------------------------------------

describe("getWeeklyDigestClusters retries each step once, live", () => {
  const rows = () => [
    mkRow({ id: "b-2", articleCount: 10, firstPublished: iso(NOW_MS - 2 * DAY_MS) }),
    mkRow({ id: "a-1", articleCount: 10, firstPublished: iso(NOW_MS - 3 * DAY_MS) }),
    mkRow({ id: "z-0", articleCount: 11, firstPublished: iso(NOW_MS - 4 * DAY_MS) }),
  ];

  it("step 1 fails once then succeeds: one warning, the identical ids query runs again, the result is ordered", async () => {
    serve(rows(), (kind, attempt) => (kind === "ids" && attempt === 0 ? BOOM : undefined));
    const out = await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });

    expect(ids(out)).toEqual(["z-0", "a-1", "b-2"]);
    // ids, ids (retry), embed: the embed's own first attempt succeeded, so it is not repeated
    expect(callLog.map((c) => kindOf(c.steps))).toEqual(["ids", "ids", "embed"]);
    expect(callLog[0]!.steps).toEqual(callLog[1]!.steps);
    expect(callLog[2]!.steps.find((s) => s.method === "select")!.args).toEqual([CLUSTER_EMBED_SELECT]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[clusters] weekly digest select failed, retrying live: boom");
  });

  it("step 2 fails once then succeeds: the identical embed query runs again with the same ids", async () => {
    serve(rows(), (kind, attempt) => (kind === "embed" && attempt === 0 ? BOOM : undefined));
    const out = await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });

    expect(ids(out)).toEqual(["z-0", "a-1", "b-2"]);
    // ids, embed, embed (retry)
    expect(callLog).toHaveLength(3);
    expect(callLog[1]!.steps).toEqual(callLog[2]!.steps);
    expect(callLog[1]!.steps.find((s) => s.method === "in")!.args).toEqual(["id", ["z-0", "a-1", "b-2"]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[clusters] weekly digest select failed, retrying live: boom");
  });

  it("one client serves the retry too: it is not a new profile or a cached read", async () => {
    serve(rows(), (kind, attempt) => (kind === "ids" && attempt === 0 ? BOOM : undefined));
    await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });
    expect(createServerClient).toHaveBeenCalledTimes(1);
    expect(createReaderClient).not.toHaveBeenCalled();
  });

  it("a clean run logs no warning", async () => {
    serve(rows());
    await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });
    expect(warn).not.toHaveBeenCalled();
    expect(callLog).toHaveLength(2);
  });

  it("step 1 errors on both attempts: rejects with the SECOND error after exactly two chains, no embed", async () => {
    serve(rows(), (kind, attempt) =>
      kind === "ids" ? { data: null, error: { message: attempt === 0 ? "first" : "second" } } : undefined,
    );
    await expect(getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" })).rejects.toThrow(
      "[clusters] weekly digest select error: second",
    );
    expect(callLog).toHaveLength(2);
    expect(callLog.every((c) => kindOf(c.steps) === "ids")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[clusters] weekly digest select failed, retrying live: first");
  });

  it("step 2 errors on both attempts: rejects with the SECOND error after exactly three chains", async () => {
    serve(rows(), (kind, attempt) =>
      kind === "embed" ? { data: null, error: { message: attempt === 0 ? "first" : "second" } } : undefined,
    );
    await expect(getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" })).rejects.toThrow(
      "[clusters] weekly digest select error: second",
    );
    expect(callLog).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a persistent Supabase error rejects instead of returning an empty digest", async () => {
    response = { data: null, error: { message: "statement timeout" } };
    await expect(getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" })).rejects.toThrow(/statement timeout/);
    expect(callLog).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Ordering: article_count, not recency
// ---------------------------------------------------------------------------

describe("getWeeklyDigestClusters ordering", () => {
  it("puts a 5-day-old 52-article cluster before a 1-hour-old 3-article one, whatever order the rows arrive in", async () => {
    const big = mkRow({
      id: "big-52",
      articleCount: 52,
      members: 52,
      firstPublished: iso(NOW_MS - 5 * DAY_MS),
    });
    const fresh = mkRow({
      id: "fresh-3",
      articleCount: 3,
      members: 3,
      firstPublished: iso(NOW_MS - HOUR_MS),
    });

    serve([fresh, big]);
    const a = await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });
    expect(ids(a)).toEqual(["big-52", "fresh-3"]);

    serve([big, fresh]);
    const b = await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });
    expect(ids(b)).toEqual(["big-52", "fresh-3"]);
  });

  it("breaks article_count ties by id ascending", async () => {
    serve([
        mkRow({ id: "c-3", articleCount: 10, firstPublished: iso(NOW_MS - DAY_MS) }),
        mkRow({ id: "a-1", articleCount: 10, firstPublished: iso(NOW_MS - 2 * DAY_MS) }),
        mkRow({ id: "b-2", articleCount: 10, firstPublished: iso(NOW_MS - 3 * DAY_MS) }),
        mkRow({ id: "z-0", articleCount: 11, firstPublished: iso(NOW_MS - 4 * DAY_MS) }),
      ]);
    const out = await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });
    expect(ids(out)).toEqual(["z-0", "a-1", "b-2", "c-3"]);
  });

  it("applies no home score, velocity or time decay: age never reorders the week", async () => {
    // A cluster whose members all landed 6 days ago, against one whose members
    // landed minutes ago; the home ranker would put the second first.
    const old = mkRow({
      id: "old",
      articleCount: 20,
      firstPublished: iso(NOW_MS - 6 * DAY_MS),
    });
    const brandNew = mkRow({
      id: "brand-new",
      articleCount: 19,
      firstPublished: iso(NOW_MS - 5 * 60 * 1000),
    });
    serve([brandNew, old]);
    const out = await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });
    expect(ids(out)).toEqual(["old", "brand-new"]);
  });

  it("returns ClusterBundle objects (the digest renders title, summary, articles and bias from them)", async () => {
    serve([mkRow({ id: "one", articleCount: 4, firstPublished: iso(NOW_MS - DAY_MS) })]);
    const [bundle] = await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });
    expect(bundle!.cluster.id).toBe("one");
    // The display headline (a member title until the neutral one is written).
    expect(bundle!.cluster.title_tr.trim().length).toBeGreaterThan(0);
    expect(bundle!.cluster.summary_tr).toBe("summary");
    expect(bundle!.articles).toHaveLength(4);
    expect(bundle!.sources).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Per-row admission: shared with the home feed
// ---------------------------------------------------------------------------

describe("getWeeklyDigestClusters admission (shared with the home feed)", () => {
  const publishedAt = () => iso(NOW_MS - 2 * DAY_MS);

  it("drops a cluster whose politics member share is below 0.6", async () => {
    serve([
        // 5 of 10 politics = 0.5: out, although it is the biggest cluster.
        mkRow({ id: "mixed-50", articleCount: 10, politicsMembers: 5, firstPublished: publishedAt() }),
        mkRow({ id: "politics", articleCount: 4, firstPublished: publishedAt() }),
      ]);
    const out = await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });
    expect(ids(out)).toEqual(["politics"]);
  });

  it("keeps a cluster at exactly 0.6 (the boundary is inclusive)", async () => {
    serve([mkRow({ id: "edge-60", articleCount: 10, politicsMembers: 6, firstPublished: publishedAt() })]);
    const out = await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });
    expect(ids(out)).toEqual(["edge-60"]);
  });

  it("drops a cluster with no joined members", async () => {
    const empty = { ...mkRow({ id: "empty", articleCount: 5, firstPublished: publishedAt() }), cluster_articles: [] };
    const nulled = { ...mkRow({ id: "nulled", articleCount: 5, firstPublished: publishedAt() }), cluster_articles: null };
    serve([empty, nulled, mkRow({ id: "ok", articleCount: 3, firstPublished: publishedAt() })]);
    const out = await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });
    expect(ids(out)).toEqual(["ok"]);
  });

  it("drops a cluster made only of English-language outlets, like the home feed does", async () => {
    const englishNames = ["Daily Sabah", "TRT World", "Hürriyet Daily News", "A News"];
    serve([
        mkRow({
          id: "english-only",
          articleCount: 4,
          firstPublished: publishedAt(),
          sourceName: (i) => englishNames[i]!,
        }),
        mkRow({ id: "turkish", articleCount: 3, firstPublished: publishedAt() }),
      ]);
    const out = await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });
    expect(ids(out)).toEqual(["turkish"]);
  });
});

// ---------------------------------------------------------------------------
// Replay: the Saturday mail
// ---------------------------------------------------------------------------

describe("getWeeklyDigestClusters replay (Saturday 09:00 TRT, 2026-11-07)", () => {
  // Monday to Thursday carry the week's biggest stories; Friday and Saturday
  // are smaller; the rest of the table is what the query must keep out.
  const MONDAY = "2026-11-02T10:00:00Z";
  const WEDNESDAY = "2026-11-04T08:00:00Z";
  const THURSDAY = "2026-11-05T09:00:00Z";
  const FRIDAY = "2026-11-06T11:00:00Z";
  const SATURDAY = "2026-11-07T02:00:00Z";

  const table = (): TableRow[] => [
    // Listed newest-first, the way the home pool (updated_at desc) would see them.
    mkRow({ id: "sat-35", articleCount: 35, firstPublished: SATURDAY }),
    mkRow({ id: "sat-fresh-3", articleCount: 3, firstPublished: "2026-11-07T05:00:00Z" }),
    mkRow({ id: "fri-41", articleCount: 41, firstPublished: FRIDAY }),
    mkRow({ id: "thu-44", articleCount: 44, firstPublished: THURSDAY }),
    mkRow({ id: "wed-48", articleCount: 48, firstPublished: WEDNESDAY }),
    mkRow({ id: "mon-52", articleCount: 52, firstPublished: MONDAY }),
    // Excluded by the window, the flags and the member floor:
    mkRow({ id: "stale-60", articleCount: 60, firstPublished: "2026-10-29T10:00:00Z" }),
    mkRow({ id: "future-70", articleCount: 70, firstPublished: "2026-11-09T10:00:00Z" }),
    mkRow({ id: "archived-80", articleCount: 80, firstPublished: THURSDAY, isArchived: true }),
    mkRow({ id: "single-1", articleCount: 1, members: 1, firstPublished: THURSDAY }),
  ];

  it("ranks Monday to Thursday's stories above Friday and Saturday's, with the exact top-5 order", async () => {
    serve(table());
    const out = await getWeeklyDigestClusters({
      nowMs: SATURDAY_0900_TRT_MS,
      profile: "batch",
    });
    expect(ids(out).slice(0, 5)).toEqual([
      "mon-52",
      "wed-48",
      "thu-44",
      "fri-41",
      "sat-35",
    ]);
    // The whole result: the sixth is the 1-hour-old 3-article cluster.
    expect(ids(out)).toEqual([
      "mon-52",
      "wed-48",
      "thu-44",
      "fri-41",
      "sat-35",
      "sat-fresh-3",
    ]);
  });

  it("keeps out clusters older than 7 days, future-dated, archived or single-article ones", async () => {
    serve(table());
    const out = await getWeeklyDigestClusters({
      nowMs: SATURDAY_0900_TRT_MS,
      profile: "batch",
    });
    for (const excluded of ["stale-60", "future-70", "archived-80", "single-1"]) {
      expect(ids(out)).not.toContain(excluded);
    }
  });

  it("is bounded: the 40 candidates are the 40 biggest of the week, not the 40 most recently updated", async () => {
    // Recency and size run in opposite directions: c-00 is the newest and the
    // smallest, c-59 the oldest and the biggest. A read that took the freshest
    // 40 (the home pool's order) would keep c-00..c-39.
    const many = Array.from({ length: 60 }, (_, i) =>
      mkRow({
        id: `c-${String(i).padStart(2, "0")}`,
        articleCount: 41 + i,
        members: 2,
        firstPublished: iso(NOW_MS - DAY_MS - i * 1000),
      }),
    );
    serve(many);
    const out = await getWeeklyDigestClusters({ nowMs: NOW_MS, profile: "batch" });
    expect(out).toHaveLength(40);
    expect(ids(out)[0]).toBe("c-59");
    expect(ids(out)[39]).toBe("c-20");
  });
});
