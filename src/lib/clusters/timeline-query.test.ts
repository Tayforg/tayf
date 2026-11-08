import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// getRecentClusters was extracted out of src/app/timeline/page.tsx into this
// module. Harness mirrors search-query.test.ts. The fake `clusters` resolver
// tells the two reads apart by the select string: `"id"` is the head/exact
// count read, anything else is the row read. The fake `cluster_articles`
// resolver is the member read of h76-timeline-2 (display titles for clusters
// whose neutral title is not stored yet); it records every read it receives.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  /** The head/exact count the count read reports (null = no Content-Range total). */
  count: null as number | null,
  countError: null as { message: string } | null,
  countThrows: false,
  /** Builder state of the last ROW read. */
  lastState: null as unknown,
  /** Builder state of the last COUNT read. */
  countState: null as unknown,
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
  /** Rows the member read (cluster_articles) returns. */
  members: [] as unknown[],
  membersError: null as { message: string } | null,
  membersThrows: false,
  /** Builder state of EVERY member read, in order (empty = none was issued). */
  memberStates: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        if (state.selectArgs[0] === "id") {
          fixture.countState = state;
          if (fixture.countThrows) throw new Error("count boom");
          if (fixture.countError) {
            return { data: null, error: fixture.countError, count: null };
          }
          return { data: null, error: null, count: fixture.count };
        }
        fixture.lastState = state;
        return { data: fixture.data, error: fixture.error };
      },
      cluster_articles: (state) => {
        fixture.memberStates.push(state);
        if (fixture.membersThrows) throw new Error("members boom");
        if (fixture.membersError) {
          return { data: null, error: fixture.membersError };
        }
        return { data: fixture.members, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, opts?: unknown) => {
    fixture.clientOpts.push(opts);
    return supabaseFake.client;
  },
}));

/** A capped client is built with a custom `global.fetch`; a plain one is not. */
function isCappedClientOpts(opts: unknown): boolean {
  const g = (opts as { global?: { fetch?: unknown } } | undefined)?.global;
  return typeof g?.fetch === "function";
}

import { cacheLife, cacheTag } from "next/cache";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getRecentClusters, TIMELINE_LIMIT } from "./timeline-query";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

function mkRow(id: string, firstPublished = "2026-09-18T10:00:00.000Z") {
  return {
    id,
    title_tr: `Küme ${id}`,
    title_tr_neutral: null,
    article_count: 3,
    first_published: firstPublished,
  };
}

/**
 * What a row becomes once the display title is attached: no stored neutral
 * title and no members, so the title is `title_tr`.
 */
function withTitles(rows: unknown[]) {
  return (rows as Array<{ title_tr: string }>).map((r) => ({
    ...r,
    title: r.title_tr,
  }));
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.count = null;
  fixture.countError = null;
  fixture.countThrows = false;
  fixture.lastState = null;
  fixture.countState = null;
  fixture.clientOpts = [];
  fixture.members = [];
  fixture.membersError = null;
  fixture.membersThrows = false;
  fixture.memberStates = [];
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("TIMELINE_LIMIT", () => {
  it("is 200 (covers ~20 h of a ~234-clusters-per-24-h day; the copy names the real total for the rest)", () => {
    expect(TIMELINE_LIMIT).toBe(200);
  });
});

describe("getRecentClusters row read shape", () => {
  it("keeps only real clusters (article_count >= 2, not archived) in the 24h window, newest first, capped at TIMELINE_LIMIT", async () => {
    await getRecentClusters();

    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("clusters");
    expect(state.eq).toEqual([{ col: "is_archived", val: false }]);
    expect(state.gte).toContainEqual({ col: "article_count", val: 2 });
    expect(state.gt[0]?.col).toBe("first_published");
    expect(state.order).toEqual([
      { col: "first_published", opts: { ascending: false } },
    ]);
    expect(state.limit).toBe(TIMELINE_LIMIT);
    expect(state.limit).toBe(200);
  });
});

describe("getRecentClusters count read shape", () => {
  it("is a head/exact count with the same filters and the SAME first_published bound as the row read", async () => {
    await getRecentClusters();

    const rowState = fixture.lastState as BuilderState;
    const countState = fixture.countState as BuilderState;
    expect(countState).not.toBeNull();
    expect(countState.table).toBe("clusters");
    expect(countState.selectArgs[0]).toBe("id");
    expect(countState.selectArgs[1]).toEqual({ count: "exact", head: true });
    expect(countState.eq).toEqual(rowState.eq);
    expect(countState.eq).toEqual([{ col: "is_archived", val: false }]);
    expect(countState.gte).toContainEqual({ col: "article_count", val: 2 });
    expect(countState.gt[0]?.col).toBe("first_published");
    // One clock read: both reads must count the exact same window.
    expect(countState.gt[0]?.val).toBe(rowState.gt[0]?.val);
  });
});

const TIMEOUT_MESSAGE = "AbortError: Supabase request exceeded 4000 ms";

describe("getRecentClusters read profile", () => {
  it("builds only capped reader clients", async () => {
    await getRecentClusters();
    expect(fixture.clientOpts.length).toBeGreaterThanOrEqual(1);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });

  it("shares ONE reader client between the row read and the count read", async () => {
    fixture.count = 5;
    await getRecentClusters();
    expect(fixture.lastState).not.toBeNull();
    expect(fixture.countState).not.toBeNull();
    expect(fixture.clientOpts).toHaveLength(1);
  });
});

describe("getRecentClusters result + cache lifetime", () => {
  it("returns { rows, total } on success and caches them for cluster-feed, once", async () => {
    fixture.data = [mkRow("c1")];
    fixture.count = 234;

    const result = await getRecentClusters();

    expect(result).toEqual({ rows: withTitles(fixture.data), total: 234 });
    // h76-timeline-2: the dedicated "timeline" tag lets the headline cron bust
    // this entry without busting "clusters" (which also tags every per-cluster
    // story-timeline seenAt entry).
    expect(cacheTag).toHaveBeenCalledWith("clusters", "timeline");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("returns empty rows (not null) when the window legitimately matched nothing", async () => {
    fixture.data = [];
    fixture.count = 0;

    await expect(getRecentClusters()).resolves.toEqual({ rows: [], total: 0 });
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("a count error leaves total null but keeps the rows, still cluster-feed, exactly one cacheLife", async () => {
    fixture.data = [mkRow("c1"), mkRow("c2")];
    fixture.countError = { message: "count timed out" };

    const result = await getRecentClusters();

    expect(result).toEqual({ rows: withTitles(fixture.data), total: null });
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("a count read that throws leaves total null and never fails the attempt", async () => {
    fixture.data = [mkRow("c1")];
    fixture.countThrows = true;

    const result = await getRecentClusters();

    expect(result).toEqual({ rows: withTitles(fixture.data), total: null });
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("a null count (no Content-Range total) leaves total null rather than inventing a number", async () => {
    fixture.data = [mkRow("c1")];
    fixture.count = null;

    await expect(getRecentClusters()).resolves.toEqual({
      rows: withTitles(fixture.data),
      total: null,
    });
  });

  it("clamps a count smaller than the rows read up to rows.length (the two reads are not one snapshot)", async () => {
    fixture.data = [mkRow("c1"), mkRow("c2"), mkRow("c3")];
    fixture.count = 2;

    const result = await getRecentClusters();

    expect(result?.rows).toHaveLength(3);
    expect(result?.total).toBe(3);
  });

  it("returns null on a row-read Supabase error and never throws into the prerender", async () => {
    fixture.error = { message: "relation missing" };
    fixture.count = 10;

    await expect(getRecentClusters()).resolves.toBeNull();
  });

  it("a row-read timeout resolves null and is cached for minutes only (exactly one cacheLife)", async () => {
    fixture.error = { message: TIMEOUT_MESSAGE };

    await expect(getRecentClusters()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
  });

  it("a row-read error wins over a failing count read: still null, still minutes", async () => {
    fixture.error = { message: TIMEOUT_MESSAGE };
    fixture.countError = { message: TIMEOUT_MESSAGE };

    await expect(getRecentClusters()).resolves.toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("tags the entry before the fetch (cacheTag precedes cacheLife)", async () => {
    await getRecentClusters();
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });

  it("does not retry live: a failed attempt builds exactly one client (static route, the clock read stays inside the cache scope)", async () => {
    fixture.error = { message: TIMEOUT_MESSAGE };

    await getRecentClusters();

    // One fetch = one createReaderClient() = one createClient(), shared by
    // the row read and the count read.
    expect(fixture.clientOpts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// h76-timeline-2: /timeline printed the raw outlet headline ("KABİNE'NİN
// GÜNDEMİ YOĞUN") for a cluster whose neutral title the headline cron had not
// written yet, and kept printing it after the cron wrote the neutral one. The
// h42-latency-1 display title (clusterDisplayTitle) had only reached the home
// feed and the detail page. `row.title` is now that display title, computed
// inside the `use cache` scope from ONE member read that covers only the rows
// with no stored neutral title.
// ---------------------------------------------------------------------------

const KABINE_ID = "37ba6f63-08d2-431f-aee6-51e80e3dd6fa";
const TAJANI_ID = "757608d3-9d06-41bf-8651-64ebc282fa16";
const KABINE_RAW = "KABİNE'NİN GÜNDEMİ YOĞUN";
const TAJANI_RAW =
  "İtalya Dışişleri Bakanı Tajani: Bilgisayar korsanlarının Rusya yanlısı olduğu açık";
// What the headline cron stored for them (production, 2026-11-08).
const KABINE_NEUTRAL =
  "Kabine’nin gündemi yoğun. Emekli zammı ve fon soruşturması masada";
const TAJANI_NEUTRAL =
  "İtalya Dışişleri Bakanı Tajani, siber saldırıları G7 gündemine taşıyacak";

function mkClusterRow(
  id: string,
  titleTr: string,
  neutral: string | null,
  firstPublished = "2026-11-08T18:30:00.000Z",
) {
  return {
    id,
    title_tr: titleTr,
    title_tr_neutral: neutral,
    article_count: 2,
    first_published: firstPublished,
  };
}

function member(clusterId: string, title: string | null, publishedAt: string) {
  return {
    cluster_id: clusterId,
    articles: { title, published_at: publishedAt },
  };
}

// The real members of the two clusters. Deliberately oldest-first: the reader
// has to order them as the cron does (newest first).
const KABINE_MEMBERS = [
  member(KABINE_ID, KABINE_RAW, "2026-11-08T17:46:15Z"),
  member(
    KABINE_ID,
    "Kabine’nin gündemi yoğun! Emekli zammı ve fon soruşturması masada",
    "2026-11-08T18:28:00Z",
  ),
];
const TAJANI_MEMBERS = [
  member(TAJANI_ID, TAJANI_RAW, "2026-11-08T18:14:00Z"),
  member(
    TAJANI_ID,
    "İtalya Dışişleri Bakanı Tajani, siber saldırıları G7 gündemine taşıyacak",
    "2026-11-08T18:14:45Z",
  ),
];

function titlesOf(result: Awaited<ReturnType<typeof getRecentClusters>>) {
  return (result?.rows ?? []).map((r) => r.title);
}

describe("getRecentClusters display title: stored neutral titles", () => {
  it("every row has a stored neutral title: title is that title verbatim and NO member read is issued", async () => {
    fixture.data = [
      mkClusterRow("c1", "HAM BAŞLIK 1!", "Nötr başlık bir"),
      mkClusterRow("c2", "HAM BAŞLIK 2!", "Nötr başlık iki"),
    ];
    fixture.count = 2;

    const result = await getRecentClusters();

    expect(titlesOf(result)).toEqual(["Nötr başlık bir", "Nötr başlık iki"]);
    expect(fixture.memberStates).toHaveLength(0);
    expect(fixture.clientOpts).toHaveLength(1);
  });

  it("an empty window issues no member read either", async () => {
    fixture.data = [];
    fixture.count = 0;

    await getRecentClusters();

    expect(fixture.memberStates).toHaveLength(0);
  });

  it("keeps every original column on the row and adds title next to them", async () => {
    fixture.data = [mkClusterRow("c1", "Ham", "Nötr")];

    const result = await getRecentClusters();

    expect(result?.rows[0]).toEqual({
      id: "c1",
      title_tr: "Ham",
      title_tr_neutral: "Nötr",
      article_count: 2,
      first_published: "2026-11-08T18:30:00.000Z",
      title: "Nötr",
    });
  });
});

describe("getRecentClusters display title: no stored neutral title", () => {
  it("37ba6f63: its 2 real members give the title the cron stored, not the raw ALL-CAPS one", async () => {
    fixture.data = [mkClusterRow(KABINE_ID, KABINE_RAW, null)];
    fixture.members = KABINE_MEMBERS;

    const result = await getRecentClusters();

    expect(titlesOf(result)).toEqual([KABINE_NEUTRAL]);
    expect(result?.rows[0]?.title).not.toBe(KABINE_RAW);
    // The stored column itself is untouched: nothing is written back.
    expect(result?.rows[0]?.title_tr_neutral).toBeNull();
    expect(fixture.memberStates).toHaveLength(1);
  });

  it("757608d3: its 2 real members give the title the cron stored", async () => {
    fixture.data = [mkClusterRow(TAJANI_ID, TAJANI_RAW, null)];
    fixture.members = TAJANI_MEMBERS;

    const result = await getRecentClusters();

    expect(titlesOf(result)).toEqual([TAJANI_NEUTRAL]);
  });

  it("both clusters come back in ONE read; members of each are grouped by cluster_id", async () => {
    fixture.data = [
      mkClusterRow(TAJANI_ID, TAJANI_RAW, null, "2026-11-08T18:34:00.000Z"),
      mkClusterRow(KABINE_ID, KABINE_RAW, null, "2026-11-08T17:46:15.000Z"),
    ];
    // Interleaved on purpose.
    fixture.members = [
      TAJANI_MEMBERS[0],
      KABINE_MEMBERS[0],
      TAJANI_MEMBERS[1],
      KABINE_MEMBERS[1],
    ];

    const result = await getRecentClusters();

    expect(titlesOf(result)).toEqual([TAJANI_NEUTRAL, KABINE_NEUTRAL]);
    expect(fixture.memberStates).toHaveLength(1);
  });

  it("a whitespace-only neutral title counts as missing and goes through the member read", async () => {
    fixture.data = [mkClusterRow(KABINE_ID, KABINE_RAW, "  ")];
    fixture.members = KABINE_MEMBERS;

    const result = await getRecentClusters();

    expect(titlesOf(result)).toEqual([KABINE_NEUTRAL]);
    expect(fixture.memberStates).toHaveLength(1);
  });

  it("an empty-string neutral title counts as missing too", async () => {
    fixture.data = [mkClusterRow(KABINE_ID, KABINE_RAW, "")];
    fixture.members = KABINE_MEMBERS;

    expect(titlesOf(await getRecentClusters())).toEqual([KABINE_NEUTRAL]);
  });

  it("a mixed page: stored rows keep their title, only the missing ones are computed", async () => {
    fixture.data = [
      mkClusterRow("c-stored", "HAM", "Saklı nötr başlık"),
      mkClusterRow(KABINE_ID, KABINE_RAW, null),
    ];
    fixture.members = KABINE_MEMBERS;

    const result = await getRecentClusters();

    expect(titlesOf(result)).toEqual(["Saklı nötr başlık", KABINE_NEUTRAL]);
  });

  it("fewer than 2 usable members: the cron would not title it, so the row keeps title_tr", async () => {
    fixture.data = [mkClusterRow(KABINE_ID, KABINE_RAW, null)];
    fixture.members = [KABINE_MEMBERS[0], member(KABINE_ID, null, "2026-11-08T18:00:00Z")];

    expect(titlesOf(await getRecentClusters())).toEqual([KABINE_RAW]);
  });

  it("a cluster the member read returned nothing for keeps title_tr", async () => {
    fixture.data = [mkClusterRow(KABINE_ID, KABINE_RAW, null)];
    fixture.members = [];

    expect(titlesOf(await getRecentClusters())).toEqual([KABINE_RAW]);
  });

  it("tolerates a null article embed and an array-shaped embed", async () => {
    fixture.data = [mkClusterRow(KABINE_ID, KABINE_RAW, null)];
    fixture.members = [
      { cluster_id: KABINE_ID, articles: null },
      { cluster_id: KABINE_ID, articles: [KABINE_MEMBERS[0]?.articles] },
      { cluster_id: KABINE_ID, articles: KABINE_MEMBERS[1]?.articles },
    ];

    expect(titlesOf(await getRecentClusters())).toEqual([KABINE_NEUTRAL]);
  });

  it("ignores member rows of a cluster it did not ask about", async () => {
    fixture.data = [mkClusterRow("c1", "Ham c1", null)];
    fixture.members = [...KABINE_MEMBERS];

    expect(titlesOf(await getRecentClusters())).toEqual(["Ham c1"]);
  });
});

describe("getRecentClusters member read shape", () => {
  function lastMemberState(): BuilderState {
    return fixture.memberStates[0] as BuilderState;
  }

  it("filters .in('cluster_id', ids) on exactly the null or blank-neutral ids, in row order", async () => {
    fixture.data = [
      mkClusterRow("c1", "a", null),
      mkClusterRow("c2", "b", "Saklı"),
      mkClusterRow("c3", "c", "   "),
      mkClusterRow("c4", "d", null),
    ];

    await getRecentClusters();

    expect(fixture.memberStates).toHaveLength(1);
    const state = lastMemberState();
    expect(state.table).toBe("cluster_articles");
    expect(state.in).toEqual([{ col: "cluster_id", vals: ["c1", "c3", "c4"] }]);
  });

  it("embeds the member article's title and published_at next to cluster_id", async () => {
    fixture.data = [mkClusterRow("c1", "a", null)];

    await getRecentClusters();

    const select = String(lastMemberState().selectArgs[0]);
    expect(select).toMatch(/\bcluster_id\b/);
    expect(select).toMatch(/articles\s*\(\s*title\s*,\s*published_at\s*\)/);
  });

  it("has a row cap: 50 per asked cluster", async () => {
    fixture.data = [mkClusterRow("c1", "a", null), mkClusterRow("c2", "b", null)];

    await getRecentClusters();

    expect(lastMemberState().limit).toBe(100);
  });

  it("caps the member read at 1000 rows however many clusters are missing a title", async () => {
    fixture.data = Array.from({ length: 30 }, (_, i) => mkClusterRow(`c${i}`, `t${i}`, null));

    await getRecentClusters();

    expect(lastMemberState().limit).toBe(1000);
    expect((lastMemberState().in[0]?.vals ?? []).length).toBe(30);
  });

  it("reuses the page's capped reader client (no second client for the member read)", async () => {
    fixture.data = [mkClusterRow("c1", "a", null)];
    fixture.count = 1;

    await getRecentClusters();

    expect(fixture.memberStates).toHaveLength(1);
    expect(fixture.clientOpts).toHaveLength(1);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });
});

describe("getRecentClusters member read failure", () => {
  it("an error from the member read keeps every row, falls back to title_tr and logs; never null", async () => {
    fixture.data = [
      mkClusterRow("c1", "Ham bir", null),
      mkClusterRow("c2", "Ham iki", "Saklı nötr"),
      mkClusterRow("c3", "Ham üç", null),
    ];
    fixture.count = 3;
    fixture.membersError = { message: "members timed out" };

    const result = await getRecentClusters();

    expect(result).not.toBeNull();
    expect(result?.rows).toHaveLength(3);
    expect(result?.total).toBe(3);
    expect(titlesOf(result)).toEqual(["Ham bir", "Saklı nötr", "Ham üç"]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("members timed out"),
    );
    // The rows are still the page: cached for the normal window, once.
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("a member read that throws is contained the same way", async () => {
    fixture.data = [mkClusterRow("c1", "Ham bir", null), mkClusterRow("c2", "Ham iki", null)];
    fixture.membersThrows = true;

    const result = await getRecentClusters();

    expect(result).not.toBeNull();
    expect(titlesOf(result)).toEqual(["Ham bir", "Ham iki"]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("members boom"));
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
    expect(cacheLife).not.toHaveBeenCalledWith("minutes");
  });

  it("a row-read error still wins: null, and no member read is attempted", async () => {
    fixture.error = { message: "relation missing" };
    fixture.data = [mkClusterRow("c1", "a", null)];

    await expect(getRecentClusters()).resolves.toBeNull();
    expect(fixture.memberStates).toHaveLength(0);
  });
});

describe("/timeline page renders the display title (source guard)", () => {
  const page = readFileSync(resolve(__dirname, "../../app/timeline/page.tsx"), "utf8");

  it("no longer coalesces title_tr_neutral and title_tr on its own", () => {
    expect(page).not.toContain("title_tr_neutral ?? row.title_tr");
    expect(page).not.toMatch(/row\.title_tr\b/);
  });

  it("renders row.title as the headline link text", () => {
    expect(page).toMatch(/\{row\.title\}/);
  });
});
