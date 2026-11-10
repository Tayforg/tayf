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
  versionRows: [] as Array<{ article_id: string }>,
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
        return { data: fixture.versionRows, error: null };
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

const { fetchDailyPuzzleCached, getDailyPuzzle } = await import("./daily-query");
const {
  DAILY_POLITICS_GATE_FROM,
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
