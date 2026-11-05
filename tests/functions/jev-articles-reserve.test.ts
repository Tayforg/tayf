import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  JEV_ARTICLES_POLITICS_RESERVE_DEFAULT,
  parseArticlesPoliticsReserve,
  runJevShadow,
  type JevAnswer,
  type JevArticleRow,
  type JevPorts,
  type JevPredictionRow,
  type JevRequest,
  type JevResponse,
  type JevStageLedger,
  type JevTickerRow,
} from "../../supabase/functions/_shared/jev.ts";

// h44-time-1: the Jev 'articles' daily allowance (11M) ran out around 13:40Z on
// non-politics articles that never cluster, so evening political clusters got
// no topic7. runJevShadow now holds a politics reserve INSIDE the same
// allowance: a non-politics-gate article (category other than politika /
// son_dakika) may only spend down to allowance - reserve; politics-gate
// articles keep the full allowance as their hard ceiling. Everything here runs
// through in-memory fake ports -- no Jev gateway, no database.

// --- fixtures ---------------------------------------------------------------

const ALLOWANCE = 11_000_000;
const RESERVE = 3_000_000;
/** The measured mean of an articles call (about 1,221 input tokens). */
const CALL_TOKENS = 1_221;

function article(i: number, category: string | null): JevArticleRow {
  return {
    id: `a${i}`,
    // The category rides in the title so a test can read the dispatch order
    // back from the evaluate() requests.
    title: `${category ?? "null"}-${i}`,
    description: "Açıklama",
    category,
    published_at: "2026-11-05T10:00:00.000Z",
    source_slug: "ornek",
  };
}

/** [politika, son_dakika, spor, yasam, politika, genel] -- the spec's mix. */
function mixedItems(): JevArticleRow[] {
  return [
    article(0, "politika"),
    article(1, "son_dakika"),
    article(2, "spor"),
    article(3, "yasam"),
    article(4, "politika"),
    article(5, "genel"),
  ];
}

function tickerRow(i: number): JevTickerRow {
  return {
    article_id: `art-${i}`,
    ticker: "THYAO",
    title: "Başlık",
    description: "Açıklama",
    company: "Türk Hava Yolları",
    matched_on: "code",
  };
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return function random(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Harness {
  ports: JevPorts;
  evaluateCalls: JevRequest[];
  finishRunCalls: Array<{ id: number; patch: Parameters<JevPorts["finishRun"]>[1] }>;
  inserted: JevPredictionRow[];
  errors: Array<{ stage: string; err: unknown }>;
  /** Peak sum of tokens already issued to evaluate() (started, in flight or done). */
  maxIssuedTokens: () => number;
  /** Titles of the evaluate() requests, in dispatch order. */
  order: () => string[];
}

function makePorts(
  opts: { tokensPerCall?: number; articles?: readonly JevArticleRow[]; tickers?: readonly JevTickerRow[] } = {},
  overrides: Partial<JevPorts> = {},
): Harness {
  const tokensPerCall = opts.tokensPerCall ?? CALL_TOKENS;
  let issued = 0;
  const h: Harness = {
    ports: {} as JevPorts,
    evaluateCalls: [],
    finishRunCalls: [],
    inserted: [],
    errors: [],
    maxIssuedTokens: () => issued,
    // Article calls only (the ticker stage also calls evaluate()).
    order: () =>
      h.evaluateCalls.filter((r) => "topic7" in r.questions).map((r) => String((r.state as { title?: unknown }).title)),
  };
  const base: JevPorts = {
    now: () => 0,
    random: mulberry32(42),
    sleep: async () => {},
    evaluate: async (req) => {
      h.evaluateCalls.push(req);
      issued += tokensPerCall;
      // Yield twice so the other workers really overlap with this call.
      await Promise.resolve();
      await Promise.resolve();
      const answers: Record<string, JevAnswer> = {};
      for (const [key, q] of Object.entries(req.questions)) {
        if (q.type === "boolean") answers[key] = { type: "boolean", probability: 0.9 };
        else if (q.type === "choice") answers[key] = { type: "choice", choice: Object.keys(q.criteria)[0] ?? "unknown" };
        else answers[key] = { type: "score", score: 1 };
      }
      const response: JevResponse = {
        answers,
        usage: { inputTokens: tokensPerCall, outputTokens: 10 },
        warnings: [],
      };
      return { response, latencyMs: 5 };
    },
    monthTokens: async (cap) => ({ input_tokens: 0, cap, exceeded: false }),
    startRun: async () => 1,
    finishRun: async (id, patch) => {
      h.finishRunCalls.push({ id, patch });
    },
    insertPredictions: async (rows) => {
      h.inserted.push(...rows);
      return rows.length;
    },
    recordTokens: async () => {},
    fetchSeenSubjects: async () => new Set<string>(),
    fetchPendingArticles: async (_since, limit) => (opts.articles ?? []).slice(0, limit),
    fetchRecentClusters: async () => [],
    fetchClusterMembers: async () => [],
    fetchPairCandidates: async () => [],
    fetchPendingKap: async () => [],
    fetchPendingTitleVersions: async () => [],
    fetchAuditPairs: async () => [],
    fetchPendingTickerMatches: async (_since, limit) => (opts.tickers ?? []).slice(0, limit),
    insertUnlinkCandidates: async (rows) => rows.length,
    fetchBlindspotClusters: async () => [],
    fetchBlindspotCandidates: async () => [],
    markBlindspotChecked: async () => {},
    fetchRegressionItems: async () => [],
    insertRegressionAnswers: async (rows) => rows.length,
    startRegressionRun: async () => 900,
    finishRegressionRun: async () => {},
    fetchPreviousRegressionAnswers: async () => [],
    fetchGoldLabels: async () => [],
    onError: (stage, err) => {
      h.errors.push({ stage, err });
    },
  };
  h.ports = { ...base, ...overrides };
  return h;
}

/** A stageBudgetsToday port with `articles` spent so far today. */
function articlesBudget(
  spentTokens: number,
  allowance: number | null = ALLOWANCE,
  calls: number = Math.round(spentTokens / CALL_TOKENS),
): Partial<JevPorts> {
  const spent: JevStageLedger = spentTokens > 0 ? { articles: { calls, tokens: spentTokens } } : {};
  return {
    stageBudgetsToday: async () => ({ spent, allowance: allowance === null ? {} : { articles: allowance } }),
  };
}

function lastNote(h: Harness): string | null {
  return h.finishRunCalls[h.finishRunCalls.length - 1]?.patch.note ?? null;
}

function lastLedger(h: Harness): JevStageLedger {
  return h.finishRunCalls[h.finishRunCalls.length - 1]?.patch.stage_tokens ?? {};
}

// --- 1. parseArticlesPoliticsReserve ---------------------------------------------

describe("parseArticlesPoliticsReserve", () => {
  it("defaults to 3,000,000 (about 2,400 politics-gate articles a day x ~1,221 tokens)", () => {
    expect(JEV_ARTICLES_POLITICS_RESERVE_DEFAULT).toBe(3_000_000);
  });

  it("falls back to the default when the variable is unset, null, empty or blank", () => {
    for (const raw of [undefined, null, "", "   ", "\n"]) {
      expect(parseArticlesPoliticsReserve(raw)).toBe(JEV_ARTICLES_POLITICS_RESERVE_DEFAULT);
    }
  });

  it("reads a non-negative integer, trimmed", () => {
    expect(parseArticlesPoliticsReserve("1500000")).toBe(1_500_000);
    expect(parseArticlesPoliticsReserve(" 2000000 ")).toBe(2_000_000);
    expect(parseArticlesPoliticsReserve("1")).toBe(1);
  });

  it("honours 0 as the off switch instead of mistaking it for unset", () => {
    expect(parseArticlesPoliticsReserve("0")).toBe(0);
    expect(parseArticlesPoliticsReserve("  0 ")).toBe(0);
    expect(parseArticlesPoliticsReserve("000")).toBe(0);
  });

  it("falls back to the default on anything that is not a plain non-negative integer", () => {
    const junk = [
      "-1",
      "-3000000",
      "1.5",
      "3e6",
      "0x10",
      "abc",
      "NaN",
      "Infinity",
      "-Infinity",
      "1_000",
      "1,000",
      "12abc",
      "+5",
      "99999999999999999999",
      "٣٠٠٠", // Arabic-Indic digits are not [0-9]
    ];
    for (const raw of junk) {
      expect(parseArticlesPoliticsReserve(raw), JSON.stringify(raw)).toBe(JEV_ARTICLES_POLITICS_RESERVE_DEFAULT);
    }
  });

  it("never throws, whatever the runtime hands it", () => {
    for (const raw of [{}, [], 5, true, Symbol.iterator, () => 1] as unknown[]) {
      expect(() => parseArticlesPoliticsReserve(raw as string)).not.toThrow();
      expect(parseArticlesPoliticsReserve(raw as string)).toBe(JEV_ARTICLES_POLITICS_RESERVE_DEFAULT);
    }
  });
});

// --- 2. the reserve through runJevShadow -------------------------------------------

describe("runJevShadow articles politics reserve", () => {
  it("(a) spent 8,000,000 of 11,000,000 with a 3,000,000 reserve: only the 3 politics-gate items get a call", async () => {
    const h = makePorts(
      { articles: mixedItems(), tickers: [tickerRow(1)] },
      articlesBudget(8_000_000),
    );

    const result = await runJevShadow(h.ports, { articlesPoliticsReserveTokens: RESERVE });

    // Politics-gate first (politika, son_dakika, politika), the rest never dispatched.
    expect(h.order()).toEqual(["politika-0", "son_dakika-1", "politika-4"]);
    expect(result.stages.articles.calls).toBe(3);
    // Booked as reserved, NOT as capped.
    expect(result.stages.articles.reserved).toBe(3);
    expect(result.stages.articles.capped).toBe(0);
    expect(result.status).toBe("ok");
    expect(lastNote(h)).toBe("daily cap: articles_reserved=3");
    expect(lastNote(h)).not.toContain("articles=");
    // The reserve is not a stop reason: the next stage still ran.
    expect(result.stages.tickers.calls).toBe(1);
    expect(lastLedger(h).articles).toEqual({ calls: 3, tokens: 3 * CALL_TOKENS });
    expect(h.finishRunCalls[0]?.patch.status).toBe("ok");
  });

  it("(a2) the predictions written belong to the politics-gate articles only", async () => {
    const h = makePorts({ articles: mixedItems() }, articlesBudget(8_000_000));

    await runJevShadow(h.ports, { articlesPoliticsReserveTokens: RESERVE });

    const scored = new Set(h.inserted.map((r) => r.article_id));
    expect(scored).toEqual(new Set(["a0", "a1", "a4"]));
  });

  it("(b) spent 10,999,000: the full allowance caps all 6, the note keeps the existing 'articles=6' format", async () => {
    const h = makePorts({ articles: mixedItems(), tickers: [tickerRow(1)] }, articlesBudget(10_999_000));

    const result = await runJevShadow(h.ports, { articlesPoliticsReserveTokens: RESERVE });

    expect(h.order()).toEqual([]);
    expect(result.stages.articles.calls).toBe(0);
    expect(result.stages.articles.capped).toBe(6);
    expect(result.stages.articles.reserved ?? 0).toBe(0);
    expect(result.status).toBe("ok");
    expect(lastNote(h)).toBe("daily cap: articles=6");
    expect(lastNote(h)).not.toContain("reserved");
    expect(result.stages.tickers.calls).toBe(1);
  });

  it("(c) plenty of room: nobody is reserved, all 6 are scored, politics-gate first, order kept inside each group", async () => {
    const h = makePorts({ articles: mixedItems() }, articlesBudget(1_000_000));

    const result = await runJevShadow(h.ports, { articlesPoliticsReserveTokens: RESERVE });

    expect(h.order()).toEqual(["politika-0", "son_dakika-1", "politika-4", "spor-2", "yasam-3", "genel-5"]);
    expect(result.stages.articles.calls).toBe(6);
    expect(result.stages.articles.capped).toBe(0);
    expect(result.stages.articles.reserved ?? 0).toBe(0);
    expect(lastNote(h)).toBeNull();
  });

  it("(d) the reserve is a floor for the others only: the politics partition keeps spending into it, up to the full allowance", async () => {
    // Day at 9,000,000 -- inside the reserved slice (8M..11M). 1,221-token calls.
    const politics = Array.from({ length: 4 }, (_, i) => article(i, "politika"));
    const others = Array.from({ length: 4 }, (_, i) => article(10 + i, "spor"));
    const h = makePorts({ articles: [...others, ...politics] }, articlesBudget(9_000_000));

    const result = await runJevShadow(h.ports, { articlesPoliticsReserveTokens: RESERVE });

    expect(result.stages.articles.calls).toBe(4);
    expect(h.order()).toEqual(["politika-0", "politika-1", "politika-2", "politika-3"]);
    expect(result.stages.articles.reserved).toBe(4);
    expect(9_000_000 + result.input_tokens).toBeLessThanOrEqual(ALLOWANCE);
  });

  it("(e) the total daily spend never passes the allowance, with 8 workers racing and politics-gate volume over the headroom", async () => {
    const allowance = 105_000;
    const daySpent = 100_000;
    const reserve = 3_000;
    // 120 politics-gate items alone are more than the 5,000 tokens of headroom.
    const items = Array.from({ length: 150 }, (_, i) => article(i, i % 5 === 0 ? "spor" : "politika"));
    const h = makePorts({ articles: items, tokensPerCall: 100 }, articlesBudget(daySpent, allowance, 1_000));

    const result = await runJevShadow(h.ports, { articlesPoliticsReserveTokens: reserve });

    expect(daySpent + h.maxIssuedTokens()).toBeLessThanOrEqual(allowance);
    expect(daySpent + result.input_tokens).toBeLessThanOrEqual(allowance);
    // The politics-gate items took the headroom (they run first); no spor item got a call.
    expect(h.order().every((t) => t.startsWith("politika-"))).toBe(true);
    expect(result.input_tokens).toBeGreaterThanOrEqual(3_000);
    // Every item is exactly one of: a call, a full-cap stop, a reserve stop.
    const stats = result.stages.articles;
    expect(stats.calls + stats.capped + (stats.reserved ?? 0)).toBe(150);
    // The allowance itself is spent, so the leftover items are booked as capped, the existing format.
    expect(stats.capped).toBeGreaterThan(0);
    expect(lastNote(h)).toMatch(/^daily cap: articles=\d+/);
    expect(result.status).toBe("ok");
  });

  it("(f) a reserve the politics volume does not fill leaves the others reserved out, never over the effective allowance", async () => {
    const allowance = 105_000;
    const daySpent = 100_000;
    // 20 politics-gate calls (2,000 tokens) -> 102,000; allowance - reserve = 102,000, so the others have no room.
    const items = [
      ...Array.from({ length: 20 }, (_, i) => article(i, "politika")),
      ...Array.from({ length: 20 }, (_, i) => article(100 + i, "spor")),
    ];
    const h = makePorts({ articles: items, tokensPerCall: 100 }, articlesBudget(daySpent, allowance, 1_000));

    const result = await runJevShadow(h.ports, { articlesPoliticsReserveTokens: 3_000 });

    expect(result.stages.articles.calls).toBe(20);
    expect(result.stages.articles.reserved).toBe(20);
    expect(daySpent + result.input_tokens).toBe(102_000);
    expect(lastNote(h)).toBe("daily cap: articles_reserved=20");
  });

  it("(g) a reserve larger than the allowance reserves out every non-politics item and leaves the politics gate alone", async () => {
    const h = makePorts({ articles: mixedItems() }, articlesBudget(0));

    const result = await runJevShadow(h.ports, { articlesPoliticsReserveTokens: ALLOWANCE * 10 });

    expect(h.order()).toEqual(["politika-0", "son_dakika-1", "politika-4"]);
    expect(result.stages.articles.reserved).toBe(3);
    expect(result.stages.articles.capped).toBe(0);
  });

  it("(h) only non-politics items, or a null category, are reserved; only politics items never are", async () => {
    const onlyOthers = makePorts(
      { articles: [article(0, "spor"), article(1, null), article(2, "dunya"), article(3, "ekonomi")] },
      articlesBudget(8_000_000),
    );
    const a = await runJevShadow(onlyOthers.ports, { articlesPoliticsReserveTokens: RESERVE });
    expect(a.stages.articles.calls).toBe(0);
    expect(a.stages.articles.reserved).toBe(4);
    expect(lastNote(onlyOthers)).toBe("daily cap: articles_reserved=4");

    const onlyPolitics = makePorts(
      { articles: [article(0, "politika"), article(1, "son_dakika")] },
      articlesBudget(8_000_000),
    );
    const b = await runJevShadow(onlyPolitics.ports, { articlesPoliticsReserveTokens: RESERVE });
    expect(b.stages.articles.calls).toBe(2);
    expect(b.stages.articles.reserved ?? 0).toBe(0);
    expect(lastNote(onlyPolitics)).toBeNull();

    const none = makePorts({ articles: [] }, articlesBudget(8_000_000));
    const c = await runJevShadow(none.ports, { articlesPoliticsReserveTokens: RESERVE });
    expect(c.stages.articles.calls).toBe(0);
    expect(lastNote(none)).toBeNull();
  });

  it("(i) a full-cap stop on the politics partition and a reserve stop on the rest are both named in the note", async () => {
    // No day history: the first call is estimated at the 2,000-token default. Allowance 3,000:
    // call 1 fits (2,000), a second worker sees one call in flight (4,000 > 3,000) and caps the
    // other 2 politics items. Once call 1 lands (100 tokens), the reserve (2,950) leaves an
    // effective allowance of 50, so the 2 non-politics items are reserved out.
    const items = [
      article(0, "politika"),
      article(1, "politika"),
      article(2, "politika"),
      article(3, "spor"),
      article(4, "genel"),
    ];
    const h = makePorts({ articles: items, tokensPerCall: 100 }, articlesBudget(0, 3_000));

    const result = await runJevShadow(h.ports, { articlesPoliticsReserveTokens: 2_950 });

    expect(result.stages.articles.calls).toBe(1);
    expect(result.stages.articles.capped).toBe(2);
    expect(result.stages.articles.reserved).toBe(2);
    expect(lastNote(h)).toBe("daily cap: articles=2,articles_reserved=2");
    expect(result.status).toBe("ok");
  });

  it("(j) without the stageBudgetsToday port, or with no articles allowance, the reserve changes nothing", async () => {
    const noPort = makePorts({ articles: mixedItems() });
    expect("stageBudgetsToday" in noPort.ports).toBe(false);
    const a = await runJevShadow(noPort.ports, { articlesPoliticsReserveTokens: RESERVE });
    expect(a.stages.articles.calls).toBe(6);
    expect(a.stages.articles.reserved ?? 0).toBe(0);
    expect(lastNote(noPort)).toBeNull();

    const noAllowance = makePorts({ articles: mixedItems() }, articlesBudget(50_000_000, null));
    const b = await runJevShadow(noAllowance.ports, { articlesPoliticsReserveTokens: RESERVE });
    expect(b.stages.articles.calls).toBe(6);
    expect(lastNote(noAllowance)).toBeNull();
  });

  it("(k) fail-open: a throwing stageBudgetsToday runs uncapped, reserve or not", async () => {
    const boom = new Error("statement timeout");
    const h = makePorts({ articles: mixedItems() }, {
      stageBudgetsToday: async () => {
        throw boom;
      },
    });

    const result = await runJevShadow(h.ports, { articlesPoliticsReserveTokens: RESERVE });

    expect(h.errors).toEqual([{ stage: "stage_budgets", err: boom }]);
    expect(result.stages.articles.calls).toBe(6);
    expect(result.status).toBe("ok");
    expect(lastNote(h)).toBeNull();
  });

  it("(l) bad runtime values for the option behave as no reserve and never throw", async () => {
    for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, null as unknown as number]) {
      const h = makePorts({ articles: mixedItems() }, articlesBudget(8_000_000));
      const result = await runJevShadow(h.ports, { articlesPoliticsReserveTokens: bad });
      expect(result.stages.articles.calls, String(bad)).toBe(6);
      expect(result.stages.articles.reserved ?? 0).toBe(0);
      expect(lastNote(h)).toBeNull();
    }
  });
});

// --- 3. reserve 0 is byte-identical to today ----------------------------------------

describe("runJevShadow articles reserve 0 is byte-identical to today", () => {
  async function snapshot(
    budget: Partial<JevPorts> | null,
    opts: Parameters<typeof runJevShadow>[1],
    items: readonly JevArticleRow[] = mixedItems(),
  ): Promise<{ result: string; evaluate: string; finish: string; inserted: string[]; order: string[] }> {
    const h = makePorts({ articles: items, tickers: [tickerRow(1)] }, budget ?? {});
    const result = await runJevShadow(h.ports, opts);
    // call_id is handed out after an async sha-256, so its numbering (and with it
    // the row order) depends on crypto timing, not on the code under test:
    // normalise the numbering and sort the rows.
    const inserted = h.inserted
      .map((row) => JSON.stringify(row).replace(/"call_id":"run1-\d+"/g, '"call_id":"run1-N"'))
      .sort();
    return {
      result: JSON.stringify(result),
      evaluate: JSON.stringify(h.evaluateCalls),
      finish: JSON.stringify(h.finishRunCalls),
      inserted,
      order: h.order(),
    };
  }

  const scenarios: Array<[string, Partial<JevPorts> | null]> = [
    ["no budget port", null],
    ["plenty of room", articlesBudget(1_000_000)],
    ["inside the would-be reserve slice", articlesBudget(9_000_000)],
    ["8,000,000 spent", articlesBudget(8_000_000)],
    ["at the ceiling", articlesBudget(10_999_000)],
    ["no articles allowance", articlesBudget(50_000_000, null)],
  ];

  for (const [name, budget] of scenarios) {
    it(`reserve 0, an omitted option and the pre-reserve call shape agree: ${name}`, async () => {
      const explicitZero = await snapshot(budget, { articlesPoliticsReserveTokens: 0 });
      const omitted = await snapshot(budget, {});
      const parsedFromEnvZero = await snapshot(budget, {
        articlesPoliticsReserveTokens: parseArticlesPoliticsReserve("0"),
      });

      expect(explicitZero).toEqual(omitted);
      expect(parsedFromEnvZero).toEqual(omitted);
      // The wire shape gains nothing: no 'reserved' key anywhere in the response.
      expect(omitted.result).not.toContain("reserved");
      expect(omitted.finish).not.toContain("reserved");
    });
  }

  it("keeps the ORIGINAL dispatch order (no politics-first reordering) when the reserve is 0", async () => {
    const s = await snapshot(articlesBudget(1_000_000), { articlesPoliticsReserveTokens: 0 });
    expect(s.order).toEqual(["politika-0", "son_dakika-1", "spor-2", "yasam-3", "politika-4", "genel-5"]);
  });

  it("keeps today's cap behaviour and note: one allowance for every item, 'daily cap: articles=N'", async () => {
    // 10,998,000 + 1 call of 1,221 fits (10,999,221); the 2nd (with the 1st in flight) does not.
    const h = makePorts({ articles: mixedItems() }, articlesBudget(10_998_000));
    const result = await runJevShadow(h.ports, { articlesPoliticsReserveTokens: 0 });

    expect(result.stages.articles.calls).toBeGreaterThanOrEqual(1);
    expect(result.stages.articles.calls + result.stages.articles.capped).toBe(6);
    expect(result.stages.articles.capped).toBeGreaterThan(0);
    expect("reserved" in result.stages.articles).toBe(false);
    expect(lastNote(h)).toBe(`daily cap: articles=${result.stages.articles.capped}`);
    expect(10_998_000 + result.input_tokens).toBeLessThanOrEqual(ALLOWANCE);
    // The capped items are the TAIL of the original order, spor/yasam included -- no category carve-out.
    expect(h.order()[0]).toBe("politika-0");
  });

  it("the stats object of every stage has exactly today's keys", async () => {
    const h = makePorts({ articles: mixedItems() }, articlesBudget(8_000_000));
    const result = await runJevShadow(h.ports, { articlesPoliticsReserveTokens: 0 });
    for (const stats of Object.values(result.stages)) {
      expect(Object.keys(stats).sort()).toEqual(["calls", "capped", "errors", "rows", "skipped", "tokens"]);
    }
  });
});

// --- 4. jev-shadow/index.ts wiring ----------------------------------------------------

describe("jev-shadow/index.ts wiring", () => {
  const source = readFileSync(new URL("../../supabase/functions/jev-shadow/index.ts", import.meta.url), "utf8");

  it("reads JEV_ARTICLES_POLITICS_RESERVE_TOKENS through parseArticlesPoliticsReserve and hands it to runJevShadow", () => {
    expect(source).toContain('Deno.env.get("JEV_ARTICLES_POLITICS_RESERVE_TOKENS")');
    expect(source).toMatch(
      /articlesPoliticsReserveTokens:\s*parseArticlesPoliticsReserve\(\s*Deno\.env\.get\("JEV_ARTICLES_POLITICS_RESERVE_TOKENS"\)\s*\)/,
    );
    expect(source).toMatch(/\bparseArticlesPoliticsReserve,/);
  });
});
