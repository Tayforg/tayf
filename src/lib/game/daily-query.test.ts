import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts).
// Each `.from(table)` call gets its own fresh builder/state, so per-table
// fixture functions below push every call's accumulated state onto an
// array the tests can introspect (predicate shape, `.in()` order, etc).
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  predictionRows: [] as Array<{ article_id: string | null }>,
  predictionError: null as { message: string; hint?: string; code?: string } | null,
  articleRows: [] as unknown[],
  articlesError: null as { message: string } | null,
  /** article_title_versions rows; the fake serves them by `.in("article_id")` and `.range()` like PostgREST. */
  versionRows: [] as Array<{ article_id: string; old_title?: string; seen_at?: string }>,
  /** Fails every article_title_versions read, or only those whose `.in("article_id")` list holds `whenIdIn`. */
  versionError: null as { message: string; whenIdIn?: string } | null,
  /** cluster_articles rows, served by `.range()` so paging is exercised for real. */
  siblingRows: [] as unknown[],
  siblingError: null as { message: string } | null,
  predictionCalls: [] as unknown[],
  articleCalls: [] as unknown[],
  versionCalls: [] as unknown[],
  siblingCalls: [] as unknown[],
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      jev_shadow_predictions: (state) => {
        fixture.predictionCalls.push(state);
        if (fixture.predictionError) return { data: null, error: fixture.predictionError };
        return { data: fixture.predictionRows, error: null };
      },
      articles: (state) => {
        fixture.articleCalls.push(state);
        if (fixture.articlesError) return { data: null, error: fixture.articlesError };
        return { data: fixture.articleRows, error: null };
      },
      article_title_versions: (state) => {
        fixture.versionCalls.push(state);
        const ids = state.in.find((f) => f.col === "article_id")?.vals;
        const failing = fixture.versionError;
        if (failing && (!failing.whenIdIn || ids?.includes(failing.whenIdIn))) {
          return { data: null, error: { message: failing.message } };
        }
        const matching = ids
          ? fixture.versionRows.filter((r) => ids.includes(r.article_id))
          : fixture.versionRows;
        const from = state.range?.from ?? 0;
        const to = state.range?.to ?? matching.length - 1;
        return { data: matching.slice(from, to + 1), error: null };
      },
      cluster_articles: (state) => {
        fixture.siblingCalls.push(state);
        if (fixture.siblingError) return { data: null, error: fixture.siblingError };
        const from = state.range?.from ?? 0;
        const to = state.range?.to ?? fixture.siblingRows.length - 1;
        return { data: fixture.siblingRows.slice(from, to + 1), error: null };
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

import { cacheLife } from "next/cache";

const { fetchDailyPuzzleCached, getDailyPuzzle, resolveTitleAsOf } = await import("./daily-query");
const {
  DAILY_POLITICS_GATE_FROM,
  DAILY_TITLE_ASOF_FROM,
  DAILY_TWIN_GATE_FROM,
  DAILY_TWIN_KEY_V2_FROM,
  addDays,
  dailyHash,
  puzzleWindow,
} = await import("./daily-set");
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const DATE_KEY = "2026-10-05";
const WINDOW = puzzleWindow(DATE_KEY);

const ZONE_BIAS = {
  iktidar: "pro_government",
  bagimsiz: "center",
  muhalefet: "opposition",
} as const;

function articleRow(i: number, zone: keyof typeof ZONE_BIAS, overrides: Record<string, unknown> = {}) {
  return {
    id: `article-${i}`,
    title: `Siyasi gündemde bugün ${i}. önemli bir gelişme yaşandı bu haberde`,
    url: `https://ornek.com/haber/${i}`,
    published_at: WINDOW.startIso,
    created_at: WINDOW.startIso,
    source_id: `source-${i}`,
    sources: {
      id: `source-${i}`,
      name: `Kaynak ${i}`,
      slug: `kaynak-${i}`,
      bias: ZONE_BIAS[zone],
      kind: "outlet",
      active: true,
    },
    cluster_articles: [{ cluster_id: `cluster-${i}` }],
    category: "politika",
    politics_admitted_at: null,
    ...overrides,
  };
}

// 6 candidates spread across the 3 zones — one extra beyond the minimum 5
// so a single edited-title exclusion still leaves a full playable set.
function sixPredictionRows() {
  return Array.from({ length: 6 }, (_, i) => ({ article_id: `article-${i}` }));
}

function sixEligibleRows() {
  const zones: Array<keyof typeof ZONE_BIAS> = [
    "iktidar",
    "bagimsiz",
    "muhalefet",
    "iktidar",
    "bagimsiz",
    "muhalefet",
  ];
  return zones.map((zone, i) => articleRow(i, zone));
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.predictionRows = [];
  fixture.predictionError = null;
  fixture.articleRows = [];
  fixture.articlesError = null;
  fixture.versionRows = [];
  fixture.versionError = null;
  fixture.siblingRows = [];
  fixture.siblingError = null;
  fixture.predictionCalls = [];
  fixture.articleCalls = [];
  fixture.versionCalls = [];
  fixture.siblingCalls = [];
  fixture.clientOpts = [];
  vi.mocked(cacheLife).mockClear();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe("daily puzzle — predictions paging", () => {
  it("records the exact predicate/paging shape and stops on a short page", async () => {
    fixture.predictionRows = [{ article_id: "article-0" }, { article_id: "article-1" }];
    fixture.articleRows = sixEligibleRows();

    await getDailyPuzzle(DATE_KEY);

    expect(fixture.predictionCalls).toHaveLength(1);
    const state = fixture.predictionCalls[0] as BuilderState;
    expect(state.eq).toContainEqual({ col: "task", val: "politics" });
    expect(state.gte).toContainEqual({ col: "jev_prob", val: 0.7 });
    expect(state.gte).toContainEqual({ col: "created_at", val: WINDOW.startIso });
    expect(state.lt).toContainEqual({ col: "created_at", val: WINDOW.endIso });
    expect(state.not).toContainEqual({ col: "article_id", op: "is", val: null });
    expect(state.range).toEqual({ from: 0, to: 999 });
    expect(state.order).toContainEqual({ col: "created_at", opts: { ascending: true } });
    expect(state.order).toContainEqual({ col: "id", opts: { ascending: true } });
  });
});

describe("daily puzzle — article fetch order", () => {
  it("requests articles with .in in dailyHash order", async () => {
    fixture.predictionRows = [
      { article_id: "article-0" },
      { article_id: "article-1" },
      { article_id: "article-2" },
      { article_id: "article-3" },
      { article_id: "article-4" },
      { article_id: "article-5" },
    ];
    fixture.articleRows = sixEligibleRows();

    await getDailyPuzzle(DATE_KEY);

    expect(fixture.articleCalls.length).toBeGreaterThan(0);
    const state = fixture.articleCalls[0] as BuilderState;
    const requestedIds = state.in[0]?.vals as string[];

    const expectedIds = [
      "article-0",
      "article-1",
      "article-2",
      "article-3",
      "article-4",
      "article-5",
    ].sort((a, b) => dailyHash(DATE_KEY, a) - dailyHash(DATE_KEY, b));

    expect(requestedIds).toEqual(expectedIds);
  });
});

describe("daily puzzle — edited-title exclusion", () => {
  it("excludes an article with a row in article_title_versions", async () => {
    fixture.predictionRows = [
      { article_id: "article-0" },
      { article_id: "article-1" },
      { article_id: "article-2" },
      { article_id: "article-3" },
      { article_id: "article-4" },
      { article_id: "article-5" },
    ];
    fixture.articleRows = sixEligibleRows();
    fixture.versionRows = [{ article_id: "article-0" }];

    const attempt = await fetchDailyPuzzleCached(DATE_KEY);

    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.data.headlines).toHaveLength(5);
    expect(attempt.data.headlines.some((h) => h.articleId === "article-0")).toBe(false);
  });
});

describe("daily puzzle — politics gate", () => {
  const ZONES: Array<keyof typeof ZONE_BIAS> = [
    "iktidar",
    "bagimsiz",
    "muhalefet",
    "iktidar",
    "bagimsiz",
    "muhalefet",
    "iktidar",
  ];
  const IDS = ZONES.map((_, i) => `article-${i}`);

  /** 7 rows inside `key`'s window; the dailyHash-first one is re-categorised. */
  function rowsWithHashFirstAs(key: string, category: string) {
    const window = puzzleWindow(key);
    const hashFirst = [...IDS].sort((a, b) => dailyHash(key, a) - dailyHash(key, b))[0]!;
    const rows = ZONES.map((zone, i) =>
      articleRow(i, zone, {
        published_at: window.startIso,
        created_at: window.startIso,
        ...(IDS[i] === hashFirst ? { category } : {}),
      }),
    );
    return { rows, hashFirst };
  }

  it("selects category and politics_admitted_at from articles", async () => {
    fixture.predictionRows = sixPredictionRows();
    fixture.articleRows = sixEligibleRows();

    await getDailyPuzzle(DATE_KEY);

    const state = fixture.articleCalls[0] as BuilderState;
    const selected = String(state.selectArgs[0]);
    expect(selected).toContain("category");
    expect(selected).toContain("politics_admitted_at");
  });

  it("from the gate date, an ekonomi article is left out (proves toCandidate copies both fields)", async () => {
    const key = DAILY_POLITICS_GATE_FROM;
    const { rows, hashFirst } = rowsWithHashFirstAs(key, "ekonomi");
    fixture.predictionRows = IDS.map((article_id) => ({ article_id }));
    fixture.articleRows = rows;

    const attempt = await fetchDailyPuzzleCached(key);

    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.data.headlines).toHaveLength(5);
    expect(attempt.data.headlines.some((h) => h.articleId === hashFirst)).toBe(false);
  });

  it("from the gate date, an ekonomi article stamped politics_admitted_at stays eligible", async () => {
    const key = DAILY_POLITICS_GATE_FROM;
    const { rows, hashFirst } = rowsWithHashFirstAs(key, "ekonomi");
    const stamped = rows.map((r) =>
      r.id === hashFirst ? { ...r, politics_admitted_at: "2026-11-05T08:00:00Z" } : r,
    );
    fixture.predictionRows = IDS.map((article_id) => ({ article_id }));
    fixture.articleRows = stamped;

    const attempt = await fetchDailyPuzzleCached(key);

    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.data.headlines.some((h) => h.articleId === hashFirst)).toBe(true);
  });

  it("before the gate date the same ekonomi article is still picked (past puzzles stay byte-identical)", async () => {
    expect(DATE_KEY < DAILY_POLITICS_GATE_FROM).toBe(true);
    const { rows, hashFirst } = rowsWithHashFirstAs(DATE_KEY, "ekonomi");
    fixture.predictionRows = IDS.map((article_id) => ({ article_id }));
    fixture.articleRows = rows;

    const attempt = await fetchDailyPuzzleCached(DATE_KEY);

    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.data.headlines.some((h) => h.articleId === hashFirst)).toBe(true);
  });
});

describe("daily puzzle — cross-zone twin gate", () => {
  const GATE_KEY = DAILY_TWIN_GATE_FROM;
  const ZONES: Array<keyof typeof ZONE_BIAS> = [
    "iktidar",
    "bagimsiz",
    "muhalefet",
    "iktidar",
    "bagimsiz",
    "muhalefet",
    "iktidar",
  ];
  const IDS = ZONES.map((_, i) => `article-${i}`);
  const TWIN_TEXT = "Cumhurbaşkanı Erdoğan, ABD Başkanı Trump ile telefonda görüştü";

  /** A cluster_articles row, the shape of the embedded select. */
  function member(
    clusterId: string,
    title: string,
    bias: string,
    kind: string | null,
    publishedAt: string,
  ) {
    return {
      cluster_id: clusterId,
      articles: { title, published_at: publishedAt, sources: { bias, kind } },
    };
  }

  /** A bias of a zone other than `zone`'s. */
  const otherZoneBias = (zone: keyof typeof ZONE_BIAS) =>
    zone === "iktidar" ? "opposition_leaning" : "pro_government";

  /**
   * 7 politika articles inside `key`'s window; the dailyHash-first one carries
   * `TWIN_TEXT` (it is the first of its zone in hash order, so a pick that may
   * use it always does).
   */
  function setup(key: string, candidateTitle: string = TWIN_TEXT) {
    const window = puzzleWindow(key);
    const hashFirst = [...IDS].sort((a, b) => dailyHash(key, a) - dailyHash(key, b))[0]!;
    const index = IDS.indexOf(hashFirst);
    const zone = ZONES[index]!;
    const rows = ZONES.map((z, i) =>
      articleRow(i, z, {
        published_at: window.startIso,
        created_at: window.startIso,
        ...(i === index ? { title: candidateTitle } : {}),
      }),
    );
    fixture.predictionRows = IDS.map((article_id) => ({ article_id }));
    fixture.articleRows = rows;
    const clusterId = `cluster-${index}`;
    const during = new Date(Date.parse(window.endIso) - 3_600_000).toISOString();
    return { window, hashFirst, index, zone, clusterId, during, row: rows[index]! };
  }

  /** The İlke TV / Aydınlık / AA shape: the same text from another zone's outlet and wire. */
  function twinSiblings(s: ReturnType<typeof setup>, publishedAt = s.during) {
    const bias = otherZoneBias(s.zone);
    return [
      member(s.clusterId, TWIN_TEXT, ZONE_BIAS[s.zone], "outlet", s.during), // the candidate itself
      member(s.clusterId, TWIN_TEXT.toLocaleUpperCase("tr-TR"), bias, "outlet", publishedAt),
      member(s.clusterId, `${TWIN_TEXT}.`, "pro_government", "wire", publishedAt),
    ];
  }

  async function build(key: string) {
    const attempt = await fetchDailyPuzzleCached(key);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) throw new Error("unreachable");
    return attempt.data.headlines.map((h) => h.articleId);
  }

  it("the gate date is a key no player has seen, and every test below runs on or after it", () => {
    expect(GATE_KEY >= "2026-11-10").toBe(true);
  });

  it("leaves a candidate out when another zone's outlet and a wire ran the same text before the window closed", async () => {
    const s = setup(GATE_KEY);
    fixture.siblingRows = twinSiblings(s);

    const picked = await build(GATE_KEY);

    expect(picked).toHaveLength(5);
    expect(picked).not.toContain(s.hashFirst);
  });

  it("keeps the same candidate when the twin was published after window.endIso (a later copy must not change a closed day)", async () => {
    const s = setup(GATE_KEY);
    const after = new Date(Date.parse(s.window.endIso) + 60_000).toISOString();
    fixture.siblingRows = twinSiblings(s, after);

    expect(await build(GATE_KEY)).toContain(s.hashFirst);
  });

  it("treats a twin published exactly at window.endIso as outside the window (the end is exclusive)", async () => {
    const s = setup(GATE_KEY);
    fixture.siblingRows = twinSiblings(s, s.window.endIso);

    expect(await build(GATE_KEY)).toContain(s.hashFirst);
  });

  it("keeps the candidate when only members of ITS OWN zone ran the same text", async () => {
    const s = setup(GATE_KEY);
    fixture.siblingRows = [
      member(s.clusterId, TWIN_TEXT, ZONE_BIAS[s.zone], "outlet", s.during),
      member(s.clusterId, TWIN_TEXT, ZONE_BIAS[s.zone], "outlet", s.during),
    ];

    expect(await build(GATE_KEY)).toContain(s.hashFirst);
  });

  it("keeps the candidate when only an aggregator or niche source of another zone ran the same text", async () => {
    const s = setup(GATE_KEY);
    const bias = otherZoneBias(s.zone);
    fixture.siblingRows = [
      member(s.clusterId, TWIN_TEXT, bias, "aggregator", s.during),
      member(s.clusterId, TWIN_TEXT, bias, "niche", s.during),
    ];

    expect(await build(GATE_KEY)).toContain(s.hashFirst);
  });

  it("treats a sibling with a null kind as an outlet (the legacy default)", async () => {
    const s = setup(GATE_KEY);
    fixture.siblingRows = [member(s.clusterId, TWIN_TEXT, otherZoneBias(s.zone), null, s.during)];

    expect(await build(GATE_KEY)).not.toContain(s.hashFirst);
  });

  it("ignores a sibling without an article or without a source", async () => {
    const s = setup(GATE_KEY);
    fixture.siblingRows = [
      { cluster_id: s.clusterId, articles: null },
      {
        cluster_id: s.clusterId,
        articles: { title: TWIN_TEXT, published_at: s.during, sources: null },
      },
    ];

    expect(await build(GATE_KEY)).toContain(s.hashFirst);
  });

  it("does not treat the same text in a DIFFERENT cluster as a twin", async () => {
    const s = setup(GATE_KEY);
    fixture.siblingRows = twinSiblings(s).map((row) => ({ ...row, cluster_id: "cluster-elsewhere" }));

    expect(await build(GATE_KEY)).toContain(s.hashFirst);
  });

  it("counts the candidate itself as evidence, even when its own published_at is after the window (a future pubDate)", async () => {
    const s = setup(GATE_KEY);
    const future = new Date(Date.parse(s.window.endIso) + 3_600_000).toISOString();
    fixture.articleRows = fixture.articleRows.map((r) =>
      (r as { id: string }).id === s.hashFirst ? { ...(r as object), published_at: future } : r,
    );
    // Only the other zone's copy is in the sibling read: the candidate's own row is
    // outside the window, so without the self member the key would carry one zone.
    fixture.siblingRows = [
      member(s.clusterId, TWIN_TEXT, otherZoneBias(s.zone), "outlet", s.during),
      member(s.clusterId, TWIN_TEXT, ZONE_BIAS[s.zone], "outlet", future),
    ];

    expect(await build(GATE_KEY)).not.toContain(s.hashFirst);
  });

  it("reads an article chunk's siblings with ONE paged cluster_articles read: distinct non-null cluster ids, a stable order, the capped range", async () => {
    const s = setup(GATE_KEY);
    // A candidate with no cluster contributes no id.
    fixture.articleRows = fixture.articleRows.map((r) =>
      (r as { id: string }).id === "article-6" ? { ...(r as object), cluster_articles: [] } : r,
    );
    fixture.siblingRows = twinSiblings(s);

    await build(GATE_KEY);

    expect(fixture.siblingCalls).toHaveLength(1);
    const state = fixture.siblingCalls[0] as BuilderState;
    const ids = state.in[0]?.vals as string[];
    expect(state.in[0]?.col).toBe("cluster_id");
    expect([...ids].sort()).toEqual(
      ["article-0", "article-1", "article-2", "article-3", "article-4", "article-5"]
        .map((id) => `cluster-${id.split("-")[1]}`)
        .sort(),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(state.range).toEqual({ from: 0, to: 999 });
    expect(state.order).toContainEqual({ col: "cluster_id", opts: { ascending: true } });
    expect(state.order).toContainEqual({ col: "article_id", opts: { ascending: true } });
    const selected = String(state.selectArgs[0]);
    expect(selected).toContain("cluster_id");
    expect(selected).toContain("title");
    expect(selected).toContain("published_at");
    expect(selected).toContain("bias");
    expect(selected).toContain("kind");
  });

  it("pages past PostgREST's 1,000-row cap: a twin on the second page still counts", async () => {
    const s = setup(GATE_KEY);
    const filler = Array.from({ length: 1000 }, (_, i) =>
      member("cluster-filler", `Başka bir kümenin ${i}. haberi burada`, "center", "outlet", s.during),
    );
    fixture.siblingRows = [...filler, ...twinSiblings(s)];

    const picked = await build(GATE_KEY);

    expect(fixture.siblingCalls.length).toBeGreaterThanOrEqual(2);
    const second = fixture.siblingCalls[1] as BuilderState;
    expect(second.range).toEqual({ from: 1000, to: 1999 });
    expect(picked).not.toContain(s.hashFirst);
  });

  it("makes no cluster read at all when no candidate has a cluster", async () => {
    setup(GATE_KEY);
    fixture.articleRows = fixture.articleRows.map((r) => ({ ...(r as object), cluster_articles: [] }));

    expect(await build(GATE_KEY)).toHaveLength(5);
    expect(fixture.siblingCalls).toHaveLength(0);
  });

  it("a sibling read error is a failed attempt ({ ok: false }), never a puzzle built without the twin check", async () => {
    setup(GATE_KEY);
    fixture.siblingError = { message: "canceling statement due to statement timeout" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const attempt = await fetchDailyPuzzleCached(GATE_KEY);

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toContain("canceling statement due to statement timeout");
    await expect(getDailyPuzzle(GATE_KEY)).resolves.toBeNull();
    // A failure is memoised for minutes only.
    expect(cacheLife).toHaveBeenLastCalledWith("minutes");
    errSpy.mockRestore();
  });

  it("two builds from the same data give the identical puzzle (the twin flag is deterministic)", async () => {
    const s = setup(GATE_KEY);
    fixture.siblingRows = twinSiblings(s);

    const first = await build(GATE_KEY);
    const second = await build(GATE_KEY);

    expect(second).toEqual(first);
  });

  it("the day BEFORE the gate: the twin candidate is still picked and no cluster_articles request is made (replays stay byte-identical)", async () => {
    const preKey = addDays(GATE_KEY, -1);
    expect(preKey < GATE_KEY).toBe(true);
    const s = setup(preKey);
    fixture.siblingRows = twinSiblings(s);

    const picked = await build(preKey);

    expect(picked).toContain(s.hashFirst);
    expect(fixture.siblingCalls).toHaveLength(0);
  });

  it("a pre-gate puzzle does not fail when the cluster_articles read would (it is never made)", async () => {
    const preKey = addDays(GATE_KEY, -1);
    setup(preKey);
    fixture.siblingError = { message: "boom" };

    expect(await build(preKey)).toHaveLength(5);
  });

  // The breaking-news lead-in (title-twin.ts, key version 2): "Son dakika... X" in
  // one zone and a plain "X" in another are twins from DAILY_TWIN_KEY_V2_FROM on.
  // Keys in [DAILY_TWIN_GATE_FROM, DAILY_TWIN_KEY_V2_FROM) were already served
  // under the version 1 key and must recompute byte-identically.
  describe("lead-in twin key by puzzle key (version 1 below DAILY_TWIN_KEY_V2_FROM, version 2 from it)", () => {
    const LEAD_IN_KEY = DAILY_TWIN_KEY_V2_FROM;
    const SERVED_KEY = addDays(DAILY_TWIN_KEY_V2_FROM, -1);
    const LEAD_IN_TITLE = `Son dakika... ${TWIN_TEXT}`;

    /** A plain copy of TWIN_TEXT from an outlet of another zone, inside the window. */
    function plainCopy(s: ReturnType<typeof setup>) {
      return [
        member(s.clusterId, LEAD_IN_TITLE, ZONE_BIAS[s.zone], "outlet", s.during), // the candidate itself
        member(s.clusterId, TWIN_TEXT, otherZoneBias(s.zone), "outlet", s.during),
      ];
    }

    it("the version 2 key is a key no player has seen, between the twin gate and the lead-in key", () => {
      expect(SERVED_KEY >= GATE_KEY).toBe(true);
      expect(LEAD_IN_KEY > SERVED_KEY).toBe(true);
    });

    it("does NOT flag a 'Son dakika...' candidate against a plain copy for a key in [DAILY_TWIN_GATE_FROM, DAILY_TWIN_KEY_V2_FROM)", async () => {
      for (const key of [GATE_KEY, SERVED_KEY]) {
        const s = setup(key, LEAD_IN_TITLE);
        fixture.siblingRows = plainCopy(s);

        expect(await build(key), key).toContain(s.hashFirst);
      }
    });

    it("flags the same candidate for a key >= DAILY_TWIN_KEY_V2_FROM", async () => {
      for (const key of [LEAD_IN_KEY, addDays(LEAD_IN_KEY, 1), addDays(LEAD_IN_KEY, 30)]) {
        const s = setup(key, LEAD_IN_TITLE);
        fixture.siblingRows = plainCopy(s);

        const picked = await build(key);

        expect(picked, key).toHaveLength(5);
        expect(picked, key).not.toContain(s.hashFirst);
      }
    });

    it("flags a plain candidate whose twin is the 'SON DAKİKA…' copy of another zone, from DAILY_TWIN_KEY_V2_FROM on only", async () => {
      const lead = "SON DAKİKA… " + TWIN_TEXT;
      for (const [key, flagged] of [
        [SERVED_KEY, false],
        [LEAD_IN_KEY, true],
      ] as const) {
        const s = setup(key);
        fixture.siblingRows = [
          member(s.clusterId, TWIN_TEXT, ZONE_BIAS[s.zone], "outlet", s.during),
          member(s.clusterId, lead, otherZoneBias(s.zone), "outlet", s.during),
        ];

        const picked = await build(key);

        expect(picked.includes(s.hashFirst), key).toBe(!flagged);
      }
    });

    it("keeps flagging what version 1 already flagged on both sides of the switch (a ':' lead-in, an identical text)", async () => {
      for (const key of [GATE_KEY, SERVED_KEY, LEAD_IN_KEY]) {
        const s = setup(key, `SON DAKİKA: ${TWIN_TEXT}`);
        fixture.siblingRows = [
          member(s.clusterId, TWIN_TEXT, otherZoneBias(s.zone), "outlet", s.during),
        ];

        expect(await build(key), key).not.toContain(s.hashFirst);
      }
    });

    it("keeps a 'Son dakika...' candidate whose only copy is from its own zone, on both sides of the switch", async () => {
      for (const key of [SERVED_KEY, LEAD_IN_KEY]) {
        const s = setup(key, LEAD_IN_TITLE);
        fixture.siblingRows = [
          member(s.clusterId, LEAD_IN_TITLE, ZONE_BIAS[s.zone], "outlet", s.during),
          member(s.clusterId, TWIN_TEXT, ZONE_BIAS[s.zone], "outlet", s.during),
        ];

        expect(await build(key), key).toContain(s.hashFirst);
      }
    });

    it("keeps the cluster_articles read count unchanged by the version (ONE paged read per chunk on both sides)", async () => {
      for (const key of [SERVED_KEY, LEAD_IN_KEY]) {
        const s = setup(key, LEAD_IN_TITLE);
        fixture.siblingRows = plainCopy(s);
        fixture.siblingCalls = [];

        await build(key);

        expect(fixture.siblingCalls, key).toHaveLength(1);
      }
    });
  });
});

describe("resolveTitleAsOf", () => {
  const END = puzzleWindow("2026-11-11").endIso;
  const endMs = Date.parse(END);
  const HOUR = 3_600_000;
  const at = (offsetMs: number) => new Date(endMs + offsetMs).toISOString();
  // A real post-close edit of key 2026-11-11's window (article 467aa9a3, prod, read-only).
  const OLD = "Osman Kavala 3 bin 297 gündür hapiste";
  const NEW = "Osman Kavala 3 bin 298 gündür hapiste";

  it("the fixture window closes at Istanbul midnight of 2026-11-11", () => {
    expect(END).toBe("2026-11-10T21:00:00.000Z");
  });

  it("no versions: kept, with the current title", () => {
    expect(resolveTitleAsOf(NEW, [], END)).toEqual({ excluded: false, title: NEW });
  });

  it("a version one millisecond before the close excludes the article", () => {
    expect(resolveTitleAsOf(NEW, [{ old_title: OLD, seen_at: at(-1) }], END).excluded).toBe(true);
  });

  it("versions only after the close: kept, and the title is the earliest one's old_title (the title at the close)", () => {
    const versions = [
      { old_title: OLD, seen_at: at(HOUR) },
      { old_title: NEW, seen_at: at(5 * HOUR) },
    ];
    expect(resolveTitleAsOf(NEW, versions, END)).toEqual({ excluded: false, title: OLD });
  });

  it("ignores the current title when every version is after the close (it may be a write-back of the edit)", () => {
    const versions = [{ old_title: OLD, seen_at: at(HOUR) }];
    expect(resolveTitleAsOf("Başka bir başlık tamamen farklı", versions, END).title).toBe(OLD);
  });

  it("does not depend on the order the rows come back in", () => {
    const versions = [
      { old_title: OLD, seen_at: at(HOUR) },
      { old_title: NEW, seen_at: at(5 * HOUR) },
      { old_title: "Üçüncü sürüm başlığı", seen_at: at(9 * HOUR) },
    ];
    const expected = resolveTitleAsOf(NEW, versions, END);
    expect(expected.title).toBe(OLD);
    expect(resolveTitleAsOf(NEW, [...versions].reverse(), END)).toEqual(expected);
    expect(resolveTitleAsOf(NEW, [versions[1]!, versions[2]!, versions[0]!], END)).toEqual(expected);
  });

  it("a version exactly at the close is after it (the end is exclusive)", () => {
    expect(resolveTitleAsOf(NEW, [{ old_title: OLD, seen_at: END }], END)).toEqual({
      excluded: false,
      title: OLD,
    });
  });

  it("reads PostgREST microsecond timestamps on both sides of the close", () => {
    expect(
      resolveTitleAsOf(NEW, [{ old_title: OLD, seen_at: "2026-11-10T20:59:59.999999+00:00" }], END).excluded,
    ).toBe(true);
    expect(
      resolveTitleAsOf(NEW, [{ old_title: OLD, seen_at: "2026-11-10T21:00:00.000500+00:00" }], END),
    ).toEqual({ excluded: false, title: OLD });
  });

  it("mixed before and after the close: excluded, and the title is still the one at the close", () => {
    const versions = [
      { old_title: "İlk sürüm başlığı", seen_at: at(-2 * HOUR) },
      { old_title: OLD, seen_at: at(HOUR) },
    ];
    expect(resolveTitleAsOf(NEW, versions, END)).toEqual({ excluded: true, title: OLD });
  });

  it("only versions before the close: excluded, with the current title (the last write-back already happened)", () => {
    const versions = [{ old_title: OLD, seen_at: at(-HOUR) }];
    expect(resolveTitleAsOf(NEW, versions, END)).toEqual({ excluded: true, title: NEW });
  });

  it("a seen_at that cannot be read counts as before the close (the article stays out, as it does today)", () => {
    expect(resolveTitleAsOf(NEW, [{ old_title: OLD, seen_at: "" }], END).excluded).toBe(true);
    expect(resolveTitleAsOf(NEW, [{ old_title: OLD, seen_at: "not a date" }], END).excluded).toBe(true);
  });

  it("two versions seen at the same instant resolve the same way whatever the row order", () => {
    const a = { old_title: "A başlığı", seen_at: at(HOUR) };
    const b = { old_title: "B başlığı", seen_at: at(HOUR) };
    expect(resolveTitleAsOf(NEW, [a, b], END)).toEqual(resolveTitleAsOf(NEW, [b, a], END));
  });
});

// The version ledger (migrations 056/074) is never published: from the as-of key on, a
// version only decides the exclusion and the internal twin comparison, and the served
// headline is always articles.title as it stands. These tests pin all three.
describe("daily puzzle — title versions read as of the window close (served text is articles.title)", () => {
  const ASOF_KEY = DAILY_TITLE_ASOF_FROM;
  const PRE_KEY = addDays(ASOF_KEY, -1);
  const HOUR = 3_600_000;
  const ZONES: Array<keyof typeof ZONE_BIAS> = [
    "iktidar",
    "bagimsiz",
    "muhalefet",
    "iktidar",
    "bagimsiz",
    "muhalefet",
    "iktidar",
  ];
  const IDS = ZONES.map((_, i) => `article-${i}`);
  const TWIN_TEXT = "Cumhurbaşkanı Erdoğan, ABD Başkanı Trump ile telefonda görüştü";

  // Real post-close edits of key 2026-11-11's window (prod, read-only): the first two
  // were written back to articles.title, the third was not (the title stayed). An
  // edit whose headline pii-filter.ts rejects ("tutuklama") would never be a
  // candidate, so none of those is used.
  const REAL_EDITS = [
    {
      name: "Kavala (diken, written back)",
      before: "Osman Kavala 3 bin 297 gündür hapiste",
      after: "Osman Kavala 3 bin 298 gündür hapiste",
      writtenBack: true,
    },
    {
      name: "Hegseth (takvim, written back)",
      before:
        "ABD’de İran savaşı depremi: Savunma Bakanı Pete Hegseth hakkında azil süreci başlatıldı açıklama geldi: \"Yaptıklarımın arkasındayım\"",
      after:
        "ABD’de İran savaşı depremi: Savunma Bakanı Pete Hegseth \"Yaptıklarımın arkasındayım\" dedi azil süreci engellendi",
      writtenBack: true,
    },
    {
      name: "e-seçim (fayn, not written back)",
      before: "Radar altında kalan tehlike: e-seçim",
      after: "Seçimlerde bilgisayarlara güvenebilir miyiz?",
      writtenBack: false,
    },
  ] as const;
  type RealEdit = (typeof REAL_EDITS)[number];
  // The edit most tests below use.
  const KAVALA = REAL_EDITS[0];

  /**
   * 7 politika articles inside `key`'s window. The dailyHash-first one carries
   * `title` (the headline as the outlet first ran it); it is the first of its zone
   * in hash order, so a pick that may use it always does.
   */
  function setup(key: string, title: string = KAVALA.before) {
    const window = puzzleWindow(key);
    const hashFirst = [...IDS].sort((a, b) => dailyHash(key, a) - dailyHash(key, b))[0]!;
    const index = IDS.indexOf(hashFirst);
    fixture.predictionRows = IDS.map((article_id) => ({ article_id }));
    fixture.articleRows = ZONES.map((zone, i) =>
      articleRow(i, zone, {
        published_at: window.startIso,
        created_at: window.startIso,
        ...(i === index ? { title } : {}),
      }),
    );
    const endMs = Date.parse(window.endIso);
    const afterClose = (hours: number) => new Date(endMs + hours * HOUR).toISOString();
    const beforeClose = (hours: number) => new Date(endMs - hours * HOUR).toISOString();
    return {
      window,
      hashFirst,
      index,
      zone: ZONES[index]!,
      clusterId: `cluster-${index}`,
      afterClose,
      beforeClose,
    };
  }
  type Setup = ReturnType<typeof setup>;

  /** The outlet edits the headline: a version row appears, and articles.title is written back (or not). */
  function recordEdit(
    s: Setup,
    edit: Pick<RealEdit, "before" | "after" | "writtenBack">,
    seenAt: string,
  ): void {
    if (edit.writtenBack) {
      fixture.articleRows = fixture.articleRows.map((r) =>
        (r as { id: string }).id === s.hashFirst ? { ...(r as object), title: edit.after } : r,
      );
    }
    fixture.versionRows = [
      ...fixture.versionRows,
      { article_id: s.hashFirst, old_title: edit.before, seen_at: seenAt },
    ];
  }

  async function buildPuzzle(key: string) {
    const attempt = await fetchDailyPuzzleCached(key);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) throw new Error("unreachable");
    return attempt.data;
  }
  const idsOf = (puzzle: { headlines: Array<{ articleId: string }> }) =>
    puzzle.headlines.map((h) => h.articleId);
  const titleOf = (puzzle: { headlines: Array<{ articleId: string; title: string }> }, id: string) =>
    puzzle.headlines.find((h) => h.articleId === id)?.title;
  /** No served headline equals the `old_title` of any fixture version: ledger text is never rendered. */
  const expectNoLedgerTextServed = (puzzle: { headlines: Array<{ title: string }> }) => {
    const served = puzzle.headlines.map((h) => h.title);
    const ledger = fixture.versionRows.map((v) => v.old_title).filter((t): t is string => t !== undefined);
    expect(ledger.length).toBeGreaterThan(0);
    for (const oldTitle of ledger) expect(served).not.toContain(oldTitle);
  };

  /** A cluster_articles row as the sibling read returns it, with the member's article id. */
  function evidenceMember(
    clusterId: string,
    articleId: string,
    title: string,
    bias: string,
    publishedAt: string,
    kind: string | null = "outlet",
  ) {
    return {
      cluster_id: clusterId,
      article_id: articleId,
      articles: { title, published_at: publishedAt, sources: { bias, kind } },
    };
  }
  const otherZoneBias = (zone: keyof typeof ZONE_BIAS) =>
    zone === "iktidar" ? "opposition_leaning" : "pro_government";

  it("the as-of key and the key before it both run under the twin gate, so only the version reads differ between them", () => {
    expect(PRE_KEY < ASOF_KEY).toBe(true);
    expect(PRE_KEY >= DAILY_TWIN_GATE_FROM).toBe(true);
  });

  describe("candidates", () => {
    it.each(REAL_EDITS)(
      "keeps $name in the picked set when the edit is recorded after the close, and serves articles.title (never the ledger text)",
      async (edit) => {
        const s = setup(ASOF_KEY, edit.before);
        const first = await buildPuzzle(ASOF_KEY);
        expect(titleOf(first, s.hashFirst)).toBe(edit.before);

        recordEdit(s, edit, s.afterClose(1));
        const second = await buildPuzzle(ASOF_KEY);

        // The same articles in the same order: a post-close edit neither drops the
        // candidate nor reshuffles the hash order.
        expect(idsOf(second)).toEqual(idsOf(first));
        expect(idsOf(second)).toContain(s.hashFirst);
        // The served text is articles.title as it stands now: the written-back edit, or
        // the unchanged title when the outlet's edit was never written back.
        expect(titleOf(second, s.hashFirst)).toBe(edit.writtenBack ? edit.after : edit.before);
        // (The not-written-back case has old_title === articles.title, the same string.)
        if (edit.writtenBack) expectNoLedgerTextServed(second);
      },
    );

    it("a rebuild after several post-close edits keeps the picked set and serves the current articles.title, never a ledger title", async () => {
      const s = setup(ASOF_KEY, "Kavala davasında yeni gelişme: duruşma ertelendi mi");
      const first = await buildPuzzle(ASOF_KEY);
      const CURRENT = "Kavala davasında duruşma ertelendi: son durum";

      // A -> B -> C, both edits after the close; C is what articles.title holds now.
      fixture.articleRows = fixture.articleRows.map((r) =>
        (r as { id: string }).id === s.hashFirst ? { ...(r as object), title: CURRENT } : r,
      );
      fixture.versionRows = [
        {
          article_id: s.hashFirst,
          old_title: "Kavala davasında yeni gelişme: duruşma ertelendi mi",
          seen_at: s.afterClose(1),
        },
        {
          article_id: s.hashFirst,
          old_title: "Kavala davasında duruşma ertelendi: ilk haber",
          seen_at: s.afterClose(5),
        },
      ].reverse();
      const second = await buildPuzzle(ASOF_KEY);

      expect(idsOf(second)).toEqual(idsOf(first));
      expect(idsOf(second)).toContain(s.hashFirst);
      expect(titleOf(second, s.hashFirst)).toBe(CURRENT);
      expectNoLedgerTextServed(second);
    });

    it("still leaves out an article edited BEFORE the close", async () => {
      const s = setup(ASOF_KEY);
      recordEdit(s, KAVALA, new Date(Date.parse(s.window.endIso) - 1).toISOString());

      const puzzle = await buildPuzzle(ASOF_KEY);

      expect(idsOf(puzzle)).toHaveLength(5);
      expect(idsOf(puzzle)).not.toContain(s.hashFirst);
    });

    it("leaves out an article with versions on both sides of the close", async () => {
      const s = setup(ASOF_KEY);
      recordEdit(s, KAVALA, s.beforeClose(2));
      recordEdit(s, KAVALA, s.afterClose(2));

      expect(idsOf(await buildPuzzle(ASOF_KEY))).not.toContain(s.hashFirst);
    });

    it("treats a version recorded exactly at the close as after it (the end is exclusive)", async () => {
      const s = setup(ASOF_KEY);
      recordEdit(s, KAVALA, s.window.endIso);

      const puzzle = await buildPuzzle(ASOF_KEY);

      expect(idsOf(puzzle)).toContain(s.hashFirst);
      expect(titleOf(puzzle, s.hashFirst)).toBe(KAVALA.after);
      expectNoLedgerTextServed(puzzle);
    });

    it("runs every title check on articles.title, not on the ledger: a headline too short at the close but fine now stays a candidate", async () => {
      const s = setup(ASOF_KEY, "Kısa başlık");
      recordEdit(
        s,
        { before: "Kısa başlık", after: KAVALA.after, writtenBack: true },
        s.afterClose(1),
      );

      const puzzle = await buildPuzzle(ASOF_KEY);

      expect(idsOf(puzzle)).toContain(s.hashFirst);
      expect(titleOf(puzzle, s.hashFirst)).toBe(KAVALA.after);
      expectNoLedgerTextServed(puzzle);
    });

    // The caveat daily-set.ts documents: a post-close write-back is still read live, so
    // it can change title ELIGIBILITY (the served text is articles.title, and the title
    // checks run on what is served). It cannot drop a candidate that stays eligible.
    it("known caveat: a headline fine at the close but too short now is not a candidate (the title checks run on articles.title)", async () => {
      const s = setup(ASOF_KEY, KAVALA.before);
      const first = await buildPuzzle(ASOF_KEY);
      expect(idsOf(first)).toContain(s.hashFirst);

      recordEdit(s, { before: KAVALA.before, after: "Kısa başlık", writtenBack: true }, s.afterClose(1));
      const second = await buildPuzzle(ASOF_KEY);

      expect(idsOf(second)).toHaveLength(5);
      expect(idsOf(second)).not.toContain(s.hashFirst);
      expectNoLedgerTextServed(second);
    });

    it("asks article_title_versions for article_id, old_title and seen_at, in a stable order", async () => {
      setup(ASOF_KEY);

      await buildPuzzle(ASOF_KEY);

      const state = fixture.versionCalls[0] as BuilderState;
      const selected = String(state.selectArgs[0]);
      expect(selected).toContain("article_id");
      expect(selected).toContain("old_title");
      expect(selected).toContain("seen_at");
      expect(state.in[0]?.col).toBe("article_id");
      expect(state.order).toContainEqual({ col: "article_id", opts: { ascending: true } });
      expect(state.order).toContainEqual({ col: "id", opts: { ascending: true } });
      expect(state.range).toEqual({ from: 0, to: 999 });
    });

    it("pages the version read past PostgREST's 1,000-row cap: a version before the close on the second page still excludes", async () => {
      const s = setup(ASOF_KEY);
      const other = IDS.find((id) => id !== s.hashFirst)!;
      const filler = Array.from({ length: 1000 }, (_, i) => ({
        article_id: other,
        old_title: `Başka bir sürüm ${i} için uzun bir başlık metni`,
        seen_at: s.afterClose(1 + i / 1000),
      }));
      fixture.versionRows = filler;
      recordEdit(s, KAVALA, s.beforeClose(3));
      const puzzle = await buildPuzzle(ASOF_KEY);

      expect(fixture.versionCalls.length).toBeGreaterThanOrEqual(2);
      expect((fixture.versionCalls[1] as BuilderState).range).toEqual({ from: 1000, to: 1999 });
      expect(idsOf(puzzle)).toHaveLength(5);
      expect(idsOf(puzzle)).not.toContain(s.hashFirst);
    });

    it("a version read that hits the page cap is a failed attempt, never a puzzle built on part of the versions", async () => {
      const s = setup(ASOF_KEY);
      const other = IDS.find((id) => id !== s.hashFirst)!;
      fixture.versionRows = Array.from({ length: 3000 }, (_, i) => ({
        article_id: other,
        old_title: `Başka bir sürüm ${i} için uzun bir başlık metni`,
        seen_at: s.afterClose(1 + i / 1000),
      }));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const attempt = await fetchDailyPuzzleCached(ASOF_KEY);

      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.error).toContain("article_title_versions");
      expect(cacheLife).toHaveBeenLastCalledWith("minutes");
      errSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("a version read error is a failed attempt ({ ok: false })", async () => {
      setup(ASOF_KEY);
      fixture.versionError = { message: "canceling statement due to statement timeout" };
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const attempt = await fetchDailyPuzzleCached(ASOF_KEY);

      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.error).toContain("canceling statement due to statement timeout");
      errSpy.mockRestore();
    });
  });

  describe("keys before DAILY_TITLE_ASOF_FROM (today's behaviour, byte-identical)", () => {
    it("the same edit still drops the article, and the puzzle moves when it is recorded", async () => {
      const s = setup(PRE_KEY);
      const first = await buildPuzzle(PRE_KEY);
      expect(idsOf(first)).toContain(s.hashFirst);

      recordEdit(s, KAVALA, s.afterClose(1));
      const second = await buildPuzzle(PRE_KEY);

      expect(idsOf(second)).toHaveLength(5);
      expect(idsOf(second)).not.toContain(s.hashFirst);
    });

    it("any version means excluded and the title is articles.title: old_title and seen_at are never read", async () => {
      const s = setup(PRE_KEY);
      fixture.versionRows = [{ article_id: s.hashFirst }];
      const legacy = await buildPuzzle(PRE_KEY);

      fixture.versionRows = [
        { article_id: s.hashFirst, old_title: "Eski başlık", seen_at: s.afterClose(7) },
        { article_id: s.hashFirst, old_title: "Daha eski başlık", seen_at: s.afterClose(9) },
      ];
      const full = await buildPuzzle(PRE_KEY);

      expect(full).toEqual(legacy);
      expect(idsOf(full)).not.toContain(s.hashFirst);
    });

    it("keeps the title as it stands (articles.title) for an article without versions", async () => {
      const s = setup(PRE_KEY, TWIN_TEXT);

      expect(titleOf(await buildPuzzle(PRE_KEY), s.hashFirst)).toBe(TWIN_TEXT);
    });

    it("makes no member-version request: one version read per article chunk, as before", async () => {
      const s = setup(PRE_KEY, TWIN_TEXT);
      fixture.siblingRows = [
        evidenceMember(s.clusterId, s.hashFirst, TWIN_TEXT, ZONE_BIAS[s.zone], s.beforeClose(1)),
        evidenceMember(s.clusterId, "member-1", TWIN_TEXT, otherZoneBias(s.zone), s.beforeClose(1)),
      ];

      await buildPuzzle(PRE_KEY);

      expect(fixture.siblingCalls).toHaveLength(1);
      expect(fixture.versionCalls).toHaveLength(1);
      expect((fixture.versionCalls[0] as BuilderState).in[0]?.vals).not.toContain("member-1");
    });
  });

  describe("twin evidence reads member headlines as of the close", () => {
    /**
     * The candidate (`candidateTitle`, its own zone) and one outlet of another zone with the
     * member's current title.
     */
    function twinCluster(s: Setup, memberTitle: string, candidateTitle: string = TWIN_TEXT) {
      fixture.siblingRows = [
        evidenceMember(s.clusterId, s.hashFirst, candidateTitle, ZONE_BIAS[s.zone], s.beforeClose(1)),
        evidenceMember(s.clusterId, "member-1", memberTitle, otherZoneBias(s.zone), s.beforeClose(1)),
      ];
    }
    const OTHER_TEXT = "Erdoğan ve Trump arasındaki görüşme sona erdi";

    it("a member that ran the text at the close still makes a twin after it edited the text away (the flag does not flip)", async () => {
      const s = setup(ASOF_KEY, TWIN_TEXT);
      twinCluster(s, TWIN_TEXT);
      const first = await buildPuzzle(ASOF_KEY);
      expect(idsOf(first)).toHaveLength(5);
      expect(idsOf(first)).not.toContain(s.hashFirst);

      twinCluster(s, OTHER_TEXT);
      fixture.versionRows = [{ article_id: "member-1", old_title: TWIN_TEXT, seen_at: s.afterClose(2) }];
      const second = await buildPuzzle(ASOF_KEY);

      expect(second).toEqual(first);
    });

    it("a member that edited TO the text after the close does not make a twin (the flag does not flip)", async () => {
      const s = setup(ASOF_KEY, TWIN_TEXT);
      twinCluster(s, OTHER_TEXT);
      const first = await buildPuzzle(ASOF_KEY);
      expect(idsOf(first)).toContain(s.hashFirst);

      twinCluster(s, TWIN_TEXT);
      fixture.versionRows = [{ article_id: "member-1", old_title: OTHER_TEXT, seen_at: s.afterClose(2) }];
      const second = await buildPuzzle(ASOF_KEY);

      expect(second).toEqual(first);
      expect(idsOf(second)).toContain(s.hashFirst);
    });

    it("a candidate that edited its text away after the close is still compared with the text it ran at the close (the flag does not flip)", async () => {
      const s = setup(ASOF_KEY, TWIN_TEXT);
      twinCluster(s, TWIN_TEXT);
      const first = await buildPuzzle(ASOF_KEY);
      expect(idsOf(first)).toHaveLength(5);
      expect(idsOf(first)).not.toContain(s.hashFirst);

      // The outlet edits the candidate's own headline after the close and it is written back.
      recordEdit(s, { before: TWIN_TEXT, after: OTHER_TEXT, writtenBack: true }, s.afterClose(2));
      twinCluster(s, TWIN_TEXT, OTHER_TEXT);
      const second = await buildPuzzle(ASOF_KEY);

      expect(idsOf(second)).toEqual(idsOf(first));
      expect(idsOf(second)).not.toContain(s.hashFirst);
    });

    it("a candidate that edited TO a copied text after the close is compared with the text it ran at the close: it stays, and the served title is articles.title", async () => {
      const s = setup(ASOF_KEY, OTHER_TEXT);
      twinCluster(s, TWIN_TEXT, OTHER_TEXT);
      const first = await buildPuzzle(ASOF_KEY);
      expect(idsOf(first)).toContain(s.hashFirst);
      expect(titleOf(first, s.hashFirst)).toBe(OTHER_TEXT);

      // After the close the candidate's headline becomes the other zone's text (written back).
      recordEdit(s, { before: OTHER_TEXT, after: TWIN_TEXT, writtenBack: true }, s.afterClose(2));
      twinCluster(s, TWIN_TEXT, TWIN_TEXT);
      const second = await buildPuzzle(ASOF_KEY);

      // The flag compares the as-of text (OTHER_TEXT), so the set does not move ...
      expect(idsOf(second)).toEqual(idsOf(first));
      expect(idsOf(second)).toContain(s.hashFirst);
      // ... and what is served is articles.title as it stands, never the ledger text.
      expect(titleOf(second, s.hashFirst)).toBe(TWIN_TEXT);
      expectNoLedgerTextServed(second);
    });

    it("before the as-of key the same member edit still flips the flag (today's behaviour)", async () => {
      const s = setup(PRE_KEY, TWIN_TEXT);
      twinCluster(s, OTHER_TEXT);
      const first = await buildPuzzle(PRE_KEY);
      expect(idsOf(first)).toContain(s.hashFirst);

      twinCluster(s, TWIN_TEXT);
      fixture.versionRows = [{ article_id: "member-1", old_title: OTHER_TEXT, seen_at: s.afterClose(2) }];
      const second = await buildPuzzle(PRE_KEY);

      expect(idsOf(second)).not.toContain(s.hashFirst);
    });

    it("a member edited BEFORE the close still counts, with its current title", async () => {
      const s = setup(ASOF_KEY, TWIN_TEXT);
      twinCluster(s, TWIN_TEXT);
      fixture.versionRows = [{ article_id: "member-1", old_title: OTHER_TEXT, seen_at: s.beforeClose(3) }];

      expect(idsOf(await buildPuzzle(ASOF_KEY))).not.toContain(s.hashFirst);
    });

    it("a member edited on both sides of the close counts with the title at the close", async () => {
      const s = setup(ASOF_KEY, TWIN_TEXT);
      // OTHER_TEXT -> TWIN_TEXT before the close, TWIN_TEXT -> a third text after it.
      twinCluster(s, "Üçüncü bir başlık: görüşmenin ayrıntıları açıklandı");
      fixture.versionRows = [
        { article_id: "member-1", old_title: OTHER_TEXT, seen_at: s.beforeClose(3) },
        { article_id: "member-1", old_title: TWIN_TEXT, seen_at: s.afterClose(3) },
      ];

      expect(idsOf(await buildPuzzle(ASOF_KEY))).not.toContain(s.hashFirst);
    });

    it("reads the versions of the evidence members only: outlets and wires published before the close", async () => {
      const s = setup(ASOF_KEY, TWIN_TEXT);
      const bias = otherZoneBias(s.zone);
      fixture.siblingRows = [
        evidenceMember(s.clusterId, s.hashFirst, TWIN_TEXT, ZONE_BIAS[s.zone], s.beforeClose(1)),
        evidenceMember(s.clusterId, "member-outlet", OTHER_TEXT, bias, s.beforeClose(1)),
        evidenceMember(s.clusterId, "member-wire", OTHER_TEXT, bias, s.beforeClose(1), "wire"),
        evidenceMember(s.clusterId, "member-null-kind", OTHER_TEXT, bias, s.beforeClose(1), null),
        evidenceMember(s.clusterId, "member-aggregator", OTHER_TEXT, bias, s.beforeClose(1), "aggregator"),
        evidenceMember(s.clusterId, "member-late", OTHER_TEXT, bias, s.afterClose(1)),
      ];

      await buildPuzzle(ASOF_KEY);

      expect(fixture.versionCalls).toHaveLength(2);
      const memberRead = fixture.versionCalls[1] as BuilderState;
      expect(memberRead.in[0]?.col).toBe("article_id");
      expect([...(memberRead.in[0]?.vals as string[])].sort()).toEqual(
        [s.hashFirst, "member-null-kind", "member-outlet", "member-wire"].sort(),
      );
      expect(String(memberRead.selectArgs[0])).toContain("old_title");
      expect(String(memberRead.selectArgs[0])).toContain("seen_at");
    });

    it("makes no member-version request when no cluster member is evidence", async () => {
      setup(ASOF_KEY);
      fixture.siblingRows = [];

      await buildPuzzle(ASOF_KEY);

      expect(fixture.siblingCalls).toHaveLength(1);
      expect(fixture.versionCalls).toHaveLength(1);
    });

    it("splits the member ids into bounded batches, one read each, and still sees every member", async () => {
      const s = setup(ASOF_KEY, TWIN_TEXT);
      const fillers = Array.from({ length: 250 }, (_, i) =>
        evidenceMember(
          s.clusterId,
          `filler-${i}`,
          `Başka bir kümenin ${i}. haberi burada geçti`,
          "center",
          s.beforeClose(1),
        ),
      );
      fixture.siblingRows = [
        evidenceMember(s.clusterId, s.hashFirst, TWIN_TEXT, ZONE_BIAS[s.zone], s.beforeClose(1)),
        ...fillers,
        // The twin is the LAST member, so it sits in the last batch.
        evidenceMember(s.clusterId, "member-1", OTHER_TEXT, otherZoneBias(s.zone), s.beforeClose(1)),
      ];
      fixture.versionRows = [{ article_id: "member-1", old_title: TWIN_TEXT, seen_at: s.afterClose(2) }];

      const puzzle = await buildPuzzle(ASOF_KEY);

      const memberReads = fixture.versionCalls.slice(1) as BuilderState[];
      expect(memberReads.length).toBeGreaterThanOrEqual(3);
      const covered = new Set<string>();
      for (const call of memberReads) {
        const ids = call.in[0]?.vals as string[];
        expect(ids.length).toBeLessThanOrEqual(100);
        for (const id of ids) covered.add(id);
      }
      expect(covered.size).toBe(252);
      // member-1 ran TWIN_TEXT at the close: the candidate is a twin.
      expect(idsOf(puzzle)).not.toContain(s.hashFirst);
    });

    it("a member-version read error is a failed attempt, never a puzzle built without the as-of titles", async () => {
      const s = setup(ASOF_KEY, TWIN_TEXT);
      twinCluster(s, OTHER_TEXT);
      fixture.versionError = { message: "canceling statement due to statement timeout", whenIdIn: "member-1" };
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const attempt = await fetchDailyPuzzleCached(ASOF_KEY);

      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.error).toContain("canceling statement due to statement timeout");
      expect(cacheLife).toHaveBeenLastCalledWith("minutes");
      errSpy.mockRestore();
    });
  });
});

describe("daily puzzle — error handling", () => {
  it("a Supabase error comes back as { ok: false } (it never rejects), and getDailyPuzzle fails open to null", async () => {
    fixture.predictionError = { message: "connection reset" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const attempt = await fetchDailyPuzzleCached(DATE_KEY);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toContain("connection reset");

    await expect(getDailyPuzzle(DATE_KEY)).resolves.toBeNull();
    errSpy.mockRestore();
  });

  it("a reader-cap timeout (AbortError) is a failed attempt, not a rejection", async () => {
    fixture.predictionError = {
      message: "AbortError: Supabase request exceeded 4000 ms",
      hint: "Request was aborted (timeout or manual cancellation)",
      code: "",
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const attempt = await fetchDailyPuzzleCached(DATE_KEY);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toContain("AbortError");

    await expect(getDailyPuzzle(DATE_KEY)).resolves.toBeNull();
    errSpy.mockRestore();
  });

  it("a missing-env failure is contained too: { ok: false }, never a throw across the cache boundary", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(fetchDailyPuzzleCached(DATE_KEY)).resolves.toMatchObject({ ok: false });
    await expect(getDailyPuzzle(DATE_KEY)).resolves.toBeNull();
    errSpy.mockRestore();
  });

  it("logs the failure with the [gunun-tayfi] prefix and the date key", async () => {
    fixture.predictionError = { message: "connection reset" };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await getDailyPuzzle(DATE_KEY);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining(`[gunun-tayfi] puzzle unavailable for ${DATE_KEY}`));
    spy.mockRestore();
  });
});

describe("daily puzzle — incomplete set", () => {
  it("is a failed attempt ({ ok: false }) when fewer than 5 eligible candidates exist", async () => {
    fixture.predictionRows = [
      { article_id: "article-0" },
      { article_id: "article-1" },
      { article_id: "article-2" },
    ];
    fixture.articleRows = [
      articleRow(0, "iktidar"),
      articleRow(1, "bagimsiz"),
      articleRow(2, "muhalefet"),
    ];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const attempt = await fetchDailyPuzzleCached(DATE_KEY);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toContain("incomplete daily set");

    await expect(getDailyPuzzle(DATE_KEY)).resolves.toBeNull();
    errSpy.mockRestore();
  });
});

describe("daily puzzle — cache lifetime", () => {
  it("success calls cacheLife exactly once with days", async () => {
    fixture.predictionRows = sixPredictionRows();
    fixture.articleRows = sixEligibleRows();

    const attempt = await fetchDailyPuzzleCached(DATE_KEY);

    expect(attempt.ok).toBe(true);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("days");
  });

  it("an error calls cacheLife exactly once with minutes (a blip must not park a failure for days)", async () => {
    fixture.predictionError = { message: "connection reset" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await fetchDailyPuzzleCached(DATE_KEY);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    errSpy.mockRestore();
  });

  it("an incomplete set calls cacheLife exactly once with minutes", async () => {
    fixture.predictionRows = [{ article_id: "article-0" }];
    fixture.articleRows = [articleRow(0, "iktidar")];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await fetchDailyPuzzleCached(DATE_KEY);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    errSpy.mockRestore();
  });

  it("getDailyPuzzle makes exactly one cached call and does NOT retry live (a build is too heavy to repeat per request)", async () => {
    fixture.predictionError = { message: "connection reset" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(getDailyPuzzle(DATE_KEY)).resolves.toBeNull();

    expect(fixture.predictionCalls).toHaveLength(1);
    expect(fixture.clientOpts).toHaveLength(1);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("getDailyPuzzle returns the puzzle on success", async () => {
    fixture.predictionRows = sixPredictionRows();
    fixture.articleRows = sixEligibleRows();

    const puzzle = await getDailyPuzzle(DATE_KEY);

    expect(puzzle?.dateKey).toBe(DATE_KEY);
    expect(puzzle?.headlines).toHaveLength(5);
  });
});

describe("daily puzzle — reader cap", () => {
  /** A capped client is built with a custom `global.fetch`; a plain one is not. */
  function isCappedClientOpts(opts: unknown): boolean {
    const g = (opts as { global?: { fetch?: unknown } } | undefined)?.global;
    return typeof g?.fetch === "function";
  }

  it("a build creates exactly ONE capped client", async () => {
    fixture.predictionRows = sixPredictionRows();
    fixture.articleRows = sixEligibleRows();

    await getDailyPuzzle(DATE_KEY);

    expect(fixture.clientOpts).toHaveLength(1);
    expect(isCappedClientOpts(fixture.clientOpts[0])).toBe(true);
  });

  it("still exactly one client when the build needs several article chunks and several prediction pages", async () => {
    // 1000-row first page forces a second prediction page; 154 ghost ids
    // (no article row) + the 6 real ones spread across >= 2 chunks of 80.
    const real = ["article-0", "article-1", "article-2", "article-3", "article-4", "article-5"];
    const ghosts = Array.from({ length: 994 }, (_, i) => `ghost-${i}`);
    fixture.predictionRows = [...real, ...ghosts].map((article_id) => ({ article_id }));
    fixture.articleRows = sixEligibleRows();

    const attempt = await fetchDailyPuzzleCached(DATE_KEY);

    expect(fixture.predictionCalls.length).toBeGreaterThanOrEqual(2);
    expect(fixture.articleCalls.length).toBeGreaterThanOrEqual(2);
    expect(attempt.ok).toBe(true);
    expect(fixture.clientOpts).toHaveLength(1);
    expect(isCappedClientOpts(fixture.clientOpts[0])).toBe(true);
  });
});
