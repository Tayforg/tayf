import { describe, expect, it } from "vitest";
import {
  JEV_CONCURRENCY,
  JEV_STAGE_CAP_DEFAULT_CALL_TOKENS,
  JEV_TITLE_FETCH_LIMIT,
  JEV_TITLE_LIMIT,
  JEV_TITLE_LOW_SIGNAL_JACCARD,
  perCallEstimate,
  runJevShadow,
  stageCapReached,
  sumStageLedgers,
  titleVersionHasSignal,
  utcDayStartIso,
  type JevAnswer,
  type JevArticleRow,
  type JevPairCandidate,
  type JevPorts,
  type JevPredictionRow,
  type JevQuestion,
  type JevRequest,
  type JevResponse,
  type JevStageLedger,
  type JevTickerRow,
  type JevTitleRow,
} from "../../supabase/functions/_shared/jev.ts";

// jev-budget: the per-stage daily allowances of public.jev_stage_budgets (088)
// used to raise an alert only. runJevShadow now treats them as a hard cap
// (stageBudgetsToday port + processStage gate) and the title stage drops
// low-signal edits (casing / spacing / one added word) before it pays for them.
// Everything here is pure or runs through in-memory fake ports -- no Jev
// gateway, no database.

// --- fixtures ---------------------------------------------------------------

const DAY_START = "2026-10-31T00:00:00.000Z";
const NOW_MS = Date.parse("2026-10-31T13:45:12.345Z");

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

function articleRow(i: number): JevArticleRow {
  return {
    id: `a${i}`,
    title: `Başlık ${i}`,
    description: "Açıklama",
    category: "politika",
    published_at: "2026-10-31T10:00:00.000Z",
    source_slug: "ornek",
  };
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

function titleRow(id: string, oldTitle: string, newTitle: string): JevTitleRow {
  return { id, article_id: `art-${id}`, old_title: oldTitle, new_title: newTitle };
}

/** A real edit: the two headlines share no words. */
function realEdit(id: string): JevTitleRow {
  return titleRow(id, `Merkez Bankası faizi sabit tuttu ${id}`, `Piyasalar sert düştü ${id}`);
}

/** Casing-only change: no signal. */
function lowSignalEdit(id: string): JevTitleRow {
  return titleRow(id, `Merkez Bankası faizi sabit tuttu ${id}`, `MERKEZ BANKASI FAİZİ SABİT TUTTU ${id}`);
}

function defaultAnswerFor(question: JevQuestion): JevAnswer {
  if (question.type === "boolean") return { type: "boolean", probability: 0.9 };
  if (question.type === "choice") {
    const firstKey = Object.keys(question.criteria)[0] ?? "unknown";
    return { type: "choice", choice: firstKey };
  }
  return { type: "score", score: 1 };
}

// --- minimal in-memory ports --------------------------------------------------

interface FakeOpts {
  tokensPerCall?: number;
  /** Real-time latency in ms for the n-th evaluate() call (0-based); default is two microtask yields. */
  delayMs?: (n: number) => number;
  articles?: readonly JevArticleRow[];
  titles?: readonly JevTitleRow[];
  tickers?: readonly JevTickerRow[];
  auditPairs?: readonly JevPairCandidate[];
  pairCandidates?: readonly JevPairCandidate[];
  now?: number;
}

interface Harness {
  ports: JevPorts;
  evaluateCalls: JevRequest[];
  finishRunCalls: Array<{ id: number; patch: Parameters<JevPorts["finishRun"]>[1] }>;
  titleFetches: Array<{ sinceIso: string; limit: number }>;
  inserted: JevPredictionRow[];
  errors: Array<{ stage: string; err: unknown }>;
  /** Peak number of evaluate() calls awaiting at once. */
  maxInFlight: () => number;
  /** Peak sum of tokens already issued to evaluate() (started, in flight or done). */
  maxIssuedTokens: () => number;
}

function makePorts(opts: FakeOpts = {}, overrides: Partial<JevPorts> = {}): Harness {
  const tokensPerCall = opts.tokensPerCall ?? 100;
  const h: Harness = {
    ports: {} as JevPorts,
    evaluateCalls: [],
    finishRunCalls: [],
    titleFetches: [],
    inserted: [],
    errors: [],
    maxInFlight: () => peakInFlight,
    maxIssuedTokens: () => issued,
  };
  let inFlight = 0;
  let peakInFlight = 0;
  let issued = 0;
  const now = opts.now ?? 0;

  const base: JevPorts = {
    now: () => now,
    random: mulberry32(42),
    sleep: async () => {},
    evaluate: async (req) => {
      const n = h.evaluateCalls.length;
      h.evaluateCalls.push(req);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      issued += tokensPerCall;
      if (opts.delayMs) {
        // Staggered latencies desynchronise the workers: a fast call finishes and
        // its worker dispatches the next item while slower calls are still in flight.
        await new Promise<void>((resolve) => setTimeout(resolve, opts.delayMs?.(n) ?? 0));
      } else {
        // Yield twice so the other workers really overlap with this call.
        await Promise.resolve();
        await Promise.resolve();
      }
      inFlight -= 1;
      const answers: Record<string, JevAnswer> = {};
      for (const [key, q] of Object.entries(req.questions)) answers[key] = defaultAnswerFor(q);
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
    fetchPairCandidates: async () => [...(opts.pairCandidates ?? [])],
    fetchPendingKap: async () => [],
    fetchPendingTitleVersions: async (sinceIso, limit) => {
      h.titleFetches.push({ sinceIso, limit });
      return (opts.titles ?? []).slice(0, limit);
    },
    fetchAuditPairs: async () => [...(opts.auditPairs ?? [])],
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

/** Overrides carrying a stageBudgetsToday that records the day-start it was asked for. */
function withBudgets(
  spent: JevStageLedger,
  allowance: Record<string, number>,
  reads: string[] = [],
): Partial<JevPorts> {
  return {
    stageBudgetsToday: async (dayStartIso: string) => {
      reads.push(dayStartIso);
      return { spent, allowance };
    },
  };
}

function lastLedger(h: Harness): JevStageLedger {
  const patch = h.finishRunCalls[h.finishRunCalls.length - 1]?.patch;
  return patch?.stage_tokens ?? {};
}

function lastNote(h: Harness): string | null {
  return h.finishRunCalls[h.finishRunCalls.length - 1]?.patch.note ?? null;
}

// --- 1. titleVersionHasSignal -------------------------------------------------

describe("titleVersionHasSignal", () => {
  it("pins the low-signal Jaccard threshold at 0.8", () => {
    expect(JEV_TITLE_LOW_SIGNAL_JACCARD).toBe(0.8);
  });

  it("is false when the two headlines are identical", () => {
    expect(titleVersionHasSignal({ old_title: "Faiz kararı açıklandı", new_title: "Faiz kararı açıklandı" })).toBe(false);
  });

  it("is false for a case-only change", () => {
    expect(
      titleVersionHasSignal({
        old_title: "Merkez Bankası faizi sabit tuttu",
        new_title: "MERKEZ BANKASI FAİZİ SABİT TUTTU",
      }),
    ).toBe(false);
  });

  it("is false for a whitespace-only change (runs of spaces, NBSP, tabs, edges)", () => {
    expect(
      titleVersionHasSignal({
        old_title: "  Merkez   Bankası faizi\tsabit tuttu ",
        new_title: "Merkez Bankası faizi sabit tuttu",
      }),
    ).toBe(false);
  });

  it("is false when one word is added to a 9-word title (Jaccard 0.9 >= 0.8)", () => {
    const nine = "hükümet yeni vergi paketini meclise sundu muhalefet tepki gösterdi";
    expect(nine.split(" ")).toHaveLength(9);
    expect(titleVersionHasSignal({ old_title: nine, new_title: `${nine} bugün` })).toBe(false);
  });

  it("treats exactly 0.8 as low signal and 0.75 as signal (boundary)", () => {
    // 4 shared of 5 distinct words = 0.8 -> no signal.
    expect(
      titleVersionHasSignal({ old_title: "faiz kararı bugün açıklandı", new_title: "faiz kararı bugün açıklandı saat" }),
    ).toBe(false);
    // 3 shared of 4 distinct words = 0.75 -> signal.
    expect(
      titleVersionHasSignal({ old_title: "faiz kararı bugün", new_title: "faiz kararı bugün açıklandı" }),
    ).toBe(true);
  });

  it("folds Turkish dotted/dotless I (İ/ı) when comparing", () => {
    expect(titleVersionHasSignal({ old_title: "İZMİR LİMANI", new_title: "izmir limanı" })).toBe(false);
    expect(titleVersionHasSignal({ old_title: "ISPARTA'DA IŞIK", new_title: "ısparta'da ışık" })).toBe(false);
  });

  it("compares NFC-normalised text (composed vs decomposed accent)", () => {
    expect(titleVersionHasSignal({ old_title: "Café", new_title: "Café" })).toBe(false);
  });

  it("is true for a real rewrite", () => {
    expect(
      titleVersionHasSignal({
        old_title: "Merkez Bankası faizi sabit tuttu",
        new_title: "Piyasalar sert düştü",
      }),
    ).toBe(true);
  });

  it("is false when both headlines are empty or blank", () => {
    expect(titleVersionHasSignal({ old_title: "", new_title: "" })).toBe(false);
    expect(titleVersionHasSignal({ old_title: "   ", new_title: "\n" })).toBe(false);
  });

  it("is true when exactly one headline is empty (a title was added or removed)", () => {
    expect(titleVersionHasSignal({ old_title: "", new_title: "Yeni başlık geldi" })).toBe(true);
  });
});

// --- 2. utcDayStartIso ----------------------------------------------------------

describe("utcDayStartIso", () => {
  it("floors to 00:00:00.000Z of the same UTC day", () => {
    expect(utcDayStartIso(NOW_MS)).toBe("2026-10-31T00:00:00.000Z");
    expect(utcDayStartIso(Date.parse("2026-10-31T23:59:59.999Z"))).toBe("2026-10-31T00:00:00.000Z");
  });

  it("is the identity on an exact midnight and rolls over at the boundary", () => {
    expect(utcDayStartIso(Date.parse("2026-11-01T00:00:00.000Z"))).toBe("2026-11-01T00:00:00.000Z");
    expect(utcDayStartIso(Date.parse("2026-10-31T23:59:59.999Z") + 1)).toBe("2026-11-01T00:00:00.000Z");
  });

  it("handles the epoch", () => {
    expect(utcDayStartIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("uses UTC, not the local time zone, near a local midnight", () => {
    // 22:30Z on the 30th is already the 31st in Istanbul (UTC+3); the budget day is UTC.
    expect(utcDayStartIso(Date.parse("2026-10-30T22:30:00.000Z"))).toBe("2026-10-30T00:00:00.000Z");
  });
});

// --- 3. sumStageLedgers ---------------------------------------------------------

describe("sumStageLedgers", () => {
  it("returns {} for no rows", () => {
    expect(sumStageLedgers([])).toEqual({});
  });

  it("sums calls and tokens per key across rows", () => {
    expect(
      sumStageLedgers([
        { articles: { calls: 2, tokens: 200 }, kap: { calls: 1, tokens: 900 } },
        { articles: { calls: 3, tokens: 330 } },
        { "audit:pairs": { calls: 1, tokens: 10 } },
      ]),
    ).toEqual({
      articles: { calls: 5, tokens: 530 },
      kap: { calls: 1, tokens: 900 },
      "audit:pairs": { calls: 1, tokens: 10 },
    });
  });

  it("ignores rows that are not objects (null, strings, numbers, arrays)", () => {
    expect(
      sumStageLedgers([null, undefined, "x", 7, [1, 2], true, { articles: { calls: 1, tokens: 5 } }]),
    ).toEqual({ articles: { calls: 1, tokens: 5 } });
  });

  it("ignores non-finite and negative values without poisoning the sum", () => {
    expect(
      sumStageLedgers([
        { articles: { calls: 1, tokens: 100 } },
        { articles: { calls: Number.NaN, tokens: 50 } },
        { articles: { calls: 1, tokens: Number.POSITIVE_INFINITY } },
        { articles: { calls: -4, tokens: -100 } },
        { articles: { calls: "3", tokens: "30" } },
        { articles: null },
        { articles: "oops" },
      ]),
    ).toEqual({ articles: { calls: 2, tokens: 150 } });
  });

  it("adds no entry for a key whose values are all invalid", () => {
    expect(sumStageLedgers([{ bad: { calls: Number.NaN, tokens: -1 } }, { worse: 5 }])).toEqual({});
  });

  it("is safe against a __proto__ key from a JSON row", () => {
    const row = JSON.parse('{"__proto__":{"calls":1,"tokens":5},"articles":{"calls":1,"tokens":7}}') as unknown;
    const out = sumStageLedgers([row]);
    expect(out.articles).toEqual({ calls: 1, tokens: 7 });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((({}) as { calls?: number }).calls).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const rows = [{ articles: { calls: 1, tokens: 5 } }];
    sumStageLedgers(rows);
    expect(rows).toEqual([{ articles: { calls: 1, tokens: 5 } }]);
  });

  it("tolerates a non-array argument", () => {
    expect(sumStageLedgers(null as unknown as unknown[])).toEqual({});
  });
});

// --- 4. perCallEstimate ---------------------------------------------------------

describe("perCallEstimate", () => {
  it("is 2,000 tokens by default", () => {
    expect(JEV_STAGE_CAP_DEFAULT_CALL_TOKENS).toBe(2_000);
  });

  it("prefers the ceiling of the run mean", () => {
    expect(perCallEstimate({ runCalls: 3, runTokens: 1_000, dayCalls: 10, dayTokens: 99_999 })).toBe(334);
    expect(perCallEstimate({ runCalls: 4, runTokens: 400, dayCalls: 1, dayTokens: 5_000 })).toBe(100);
  });

  it("falls back to the ceiling of the day mean when the run has no calls yet", () => {
    expect(perCallEstimate({ runCalls: 0, runTokens: 0, dayCalls: 3, dayTokens: 1_000 })).toBe(334);
  });

  it("falls back to the default with no history at all", () => {
    expect(perCallEstimate({ runCalls: 0, runTokens: 0, dayCalls: 0, dayTokens: 0 })).toBe(
      JEV_STAGE_CAP_DEFAULT_CALL_TOKENS,
    );
  });

  it("skips a mean of zero or a non-finite input and moves to the next source", () => {
    expect(perCallEstimate({ runCalls: 5, runTokens: 0, dayCalls: 2, dayTokens: 500 })).toBe(250);
    expect(perCallEstimate({ runCalls: Number.NaN, runTokens: 10, dayCalls: 2, dayTokens: 500 })).toBe(250);
    expect(perCallEstimate({ runCalls: 0, runTokens: 0, dayCalls: -1, dayTokens: -50 })).toBe(
      JEV_STAGE_CAP_DEFAULT_CALL_TOKENS,
    );
    expect(
      perCallEstimate({ runCalls: 0, runTokens: 0, dayCalls: Number.POSITIVE_INFINITY, dayTokens: 10 }),
    ).toBe(JEV_STAGE_CAP_DEFAULT_CALL_TOKENS);
  });
});

// --- 5. stageCapReached ---------------------------------------------------------

describe("stageCapReached", () => {
  const base = { spentDay: 0, spentRun: 0, inFlight: 0, perCallTokens: 100 };

  it("never caps without an allowance (null or undefined)", () => {
    expect(stageCapReached({ ...base, spentDay: 1e12, allowance: null })).toBe(false);
    expect(stageCapReached({ ...base, spentDay: 1e12, allowance: undefined })).toBe(false);
  });

  it("never caps on a non-finite allowance", () => {
    expect(stageCapReached({ ...base, spentDay: 1e12, allowance: Number.NaN })).toBe(false);
    expect(stageCapReached({ ...base, spentDay: 1e12, allowance: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it("allows a call that lands exactly on the allowance and refuses one token more", () => {
    // 900 + 0 + 100 * 1 = 1000 -> not over.
    expect(stageCapReached({ ...base, spentDay: 900, allowance: 1_000 })).toBe(false);
    expect(stageCapReached({ ...base, spentDay: 901, allowance: 1_000 })).toBe(true);
  });

  it("counts the run's own spend", () => {
    expect(stageCapReached({ ...base, spentDay: 500, spentRun: 400, allowance: 1_000 })).toBe(false);
    expect(stageCapReached({ ...base, spentDay: 500, spentRun: 401, allowance: 1_000 })).toBe(true);
  });

  it("reserves room for every call already in flight plus the one being dispatched", () => {
    // 100 * (7 + 1) = 800 <= 800, but 100 * (8 + 1) = 900 > 800.
    expect(stageCapReached({ ...base, inFlight: 7, allowance: 800 })).toBe(false);
    expect(stageCapReached({ ...base, inFlight: 8, allowance: 800 })).toBe(true);
  });

  it("caps at once when the day is already over the allowance", () => {
    expect(stageCapReached({ ...base, spentDay: 11_000_001, allowance: 11_000_000 })).toBe(true);
  });
});

// --- 6. runJevShadow with the daily cap ---------------------------------------------

describe("runJevShadow daily stage cap", () => {
  it("(a) caps title_versions at 199,000 of 200,000, still runs tickers, and closes ok with a note", async () => {
    const h = makePorts(
      {
        tokensPerCall: 600,
        titles: [realEdit("t1"), realEdit("t2"), realEdit("t3")],
        tickers: [tickerRow(1), tickerRow(2)],
      },
      withBudgets({ title_versions: { calls: 0, tokens: 199_000 } }, { title_versions: 200_000 }),
    );

    const result = await runJevShadow(h.ports);

    expect(result.stages.title_versions.calls).toBe(0);
    expect(result.stages.title_versions.capped).toBe(3);
    expect(result.status).toBe("ok");
    expect(lastNote(h)).toContain("daily cap: title_versions=");
    expect(lastNote(h)).toBe("daily cap: title_versions=3");
    // The next stage is not stopped: tickers still ran.
    expect(result.stages.tickers.calls).toBe(2);
    expect(result.stages.tickers.capped).toBe(0);
    expect(h.evaluateCalls).toHaveLength(2);
    const ledger = lastLedger(h);
    expect(ledger.title_versions).toBeUndefined();
    expect(ledger.tickers).toEqual({ calls: 2, tokens: 1_200 });
    expect(h.finishRunCalls[0]?.patch.status).toBe("ok");
  });

  it("(a2) reserves for the in-flight call: with a 603-token mean at 199,000 only one title call goes out", async () => {
    const titles = Array.from({ length: 5 }, (_, i) => realEdit(`t${i}`));
    const h = makePorts(
      { tokensPerCall: 600, titles },
      withBudgets({ title_versions: { calls: 330, tokens: 199_000 } }, { title_versions: 200_000 }),
    );

    const result = await runJevShadow(h.ports);

    expect(result.stages.title_versions.calls).toBe(1);
    expect(result.stages.title_versions.capped).toBe(4);
    expect(199_000 + result.input_tokens).toBeLessThanOrEqual(200_000);
    expect(result.status).toBe("ok");
    expect(lastNote(h)).toBe("daily cap: title_versions=4");
  });

  it("(b) never lets day spend plus the run's tokens pass the allowance, even with 8 calls in flight", async () => {
    const allowance = 105_000;
    const daySpent = 100_000;
    const articles = Array.from({ length: 150 }, (_, i) => articleRow(i));
    const h = makePorts(
      { tokensPerCall: 100, articles, delayMs: (n) => (n * 7) % 5 },
      withBudgets({ articles: { calls: 1_000, tokens: daySpent } }, { articles: allowance }),
    );

    const result = await runJevShadow(h.ports);

    expect(JEV_CONCURRENCY).toBe(8);
    expect(h.maxInFlight()).toBeGreaterThan(1);
    expect(h.maxInFlight()).toBeLessThanOrEqual(JEV_CONCURRENCY);
    // Tokens handed to the gateway (including calls still in flight) never crossed the line.
    expect(daySpent + h.maxIssuedTokens()).toBeLessThanOrEqual(allowance);
    expect(daySpent + result.input_tokens).toBeLessThanOrEqual(allowance);
    // It did spend most of the headroom, and every item is either a call or capped.
    expect(result.input_tokens).toBeGreaterThanOrEqual(3_000);
    expect(result.stages.articles.capped).toBeGreaterThan(0);
    expect(result.stages.articles.calls + result.stages.articles.capped).toBe(150);
    expect(result.status).toBe("ok");
    expect(lastNote(h)).toBe(`daily cap: articles=${result.stages.articles.capped}`);
  });

  it("(c) without the port the run behaves exactly as before (no cap, no note)", async () => {
    const articles = Array.from({ length: 12 }, (_, i) => articleRow(i));
    const h = makePorts({ articles, tickers: [tickerRow(1)] });
    expect("stageBudgetsToday" in h.ports).toBe(false);

    const result = await runJevShadow(h.ports);

    expect(result.stages.articles.calls).toBe(12);
    for (const stats of Object.values(result.stages)) expect(stats.capped).toBe(0);
    expect(result.status).toBe("ok");
    expect(lastNote(h)).toBeNull();
  });

  it("(c2) an allowance for another stage, or none at all, caps nothing", async () => {
    const articles = Array.from({ length: 12 }, (_, i) => articleRow(i));
    const other = makePorts({ articles }, withBudgets({ articles: { calls: 1, tokens: 1e9 } }, { kap: 1 }));
    const none = makePorts({ articles }, withBudgets({ articles: { calls: 1, tokens: 1e9 } }, {}));

    const a = await runJevShadow(other.ports);
    const b = await runJevShadow(none.ports);

    expect(a.stages.articles.calls).toBe(12);
    expect(b.stages.articles.calls).toBe(12);
    expect(lastNote(other)).toBeNull();
    expect(lastNote(none)).toBeNull();
  });

  it("(d) fail-open: a throwing stageBudgetsToday reports 'stage_budgets', runs uncapped and closes ok", async () => {
    const articles = Array.from({ length: 5 }, (_, i) => articleRow(i));
    const boom = new Error("jev-shadow: stageBudgetsToday runs failed: statement timeout");
    const h = makePorts({ articles }, {
      stageBudgetsToday: async () => {
        throw boom;
      },
    });

    const result = await runJevShadow(h.ports);

    expect(h.errors).toEqual([{ stage: "stage_budgets", err: boom }]);
    expect(result.stages.articles.calls).toBe(5);
    expect(result.stages.articles.capped).toBe(0);
    expect(result.status).toBe("ok");
    expect(lastNote(h)).toBeNull();
  });

  it("(d2) a throwing onError hook cannot destabilise the fail-open path", async () => {
    const articles = Array.from({ length: 3 }, (_, i) => articleRow(i));
    const h = makePorts({ articles }, {
      stageBudgetsToday: async () => {
        throw new Error("down");
      },
      onError: () => {
        throw new Error("logger down");
      },
    });

    const result = await runJevShadow(h.ports);

    expect(result.status).toBe("ok");
    expect(result.stages.articles.calls).toBe(3);
  });

  it("(d3) reads the budgets with the UTC day start of ports.now()", async () => {
    const reads: string[] = [];
    const h = makePorts({ now: NOW_MS }, withBudgets({}, {}, reads));

    await runJevShadow(h.ports);

    expect(reads).toEqual([DAY_START]);
  });

  it("(d4) does not read the budgets when the monthly cap already closed the run", async () => {
    const reads: string[] = [];
    const h = makePorts(
      { articles: [articleRow(1)] },
      {
        ...withBudgets({}, {}, reads),
        monthTokens: async (cap) => ({ input_tokens: cap, cap, exceeded: true }),
      },
    );

    const result = await runJevShadow(h.ports);

    expect(reads).toEqual([]);
    expect(result.status).toBe("budget_exceeded");
    expect(h.evaluateCalls).toHaveLength(0);
    expect(lastNote(h)).toBe("monthly cap reached");
  });

  it("(e) drops low-signal title edits before the cut: 3 calls, skipped 5, fetch limit JEV_TITLE_FETCH_LIMIT", async () => {
    const titles = [
      lowSignalEdit("l1"),
      realEdit("r1"),
      lowSignalEdit("l2"),
      realEdit("r2"),
      titleRow("l3", "Aynı başlık", "Aynı başlık"),
      realEdit("r3"),
      titleRow("l4", "faiz kararı bugün açıklandı", "faiz kararı bugün açıklandı saat"),
      titleRow("l5", "  Aynı   başlık ", "aynı başlık"),
    ];
    const h = makePorts({ titles });

    const result = await runJevShadow(h.ports);

    expect(JEV_TITLE_FETCH_LIMIT).toBe(JEV_TITLE_LIMIT * 4);
    expect(h.titleFetches).toHaveLength(1);
    expect(h.titleFetches[0]?.limit).toBe(JEV_TITLE_FETCH_LIMIT);
    expect(h.evaluateCalls).toHaveLength(3);
    expect(result.stages.title_versions.calls).toBe(3);
    expect(result.stages.title_versions.skipped).toBe(5);
    expect(result.stages.title_versions.capped).toBe(0);
    const answered = new Set(h.inserted.filter((r) => r.task === "title_meaning").map((r) => r.subject_id));
    expect(answered).toEqual(new Set(["r1", "r2", "r3"]));
  });

  it("(e2) low-signal rows do not starve real edits: the JEV_TITLE_LIMIT cut applies after the filter", async () => {
    const low = Array.from({ length: 40 }, (_, i) => lowSignalEdit(`low${i}`));
    const real = Array.from({ length: 35 }, (_, i) => realEdit(`real${i}`));
    const h = makePorts({ titles: [...low, ...real] });

    const result = await runJevShadow(h.ports);

    expect(result.stages.title_versions.calls).toBe(JEV_TITLE_LIMIT);
    expect(result.stages.title_versions.skipped).toBe(40);
    const answered = new Set(h.inserted.filter((r) => r.task === "title_meaning").map((r) => r.subject_id));
    expect(answered).toEqual(new Set(Array.from({ length: JEV_TITLE_LIMIT }, (_, i) => `real${i}`)));
  });

  it("(e3) only low-signal rows: no title call at all, all counted as skipped", async () => {
    const h = makePorts({ titles: [lowSignalEdit("l1"), lowSignalEdit("l2")] });

    const result = await runJevShadow(h.ports);

    expect(h.evaluateCalls).toHaveLength(0);
    expect(result.stages.title_versions.skipped).toBe(2);
    expect(result.stages.title_versions.calls).toBe(0);
    expect(result.status).toBe("ok");
  });

  it("(f) audit mode looks up the 'audit:pairs' key, not the bare 'pairs'", async () => {
    const auditPairs: JevPairCandidate[] = [
      { id: "a1", cluster_id: "cA", title: "X", published_at: "2026-10-31T08:00:00.000Z" },
      { id: "a2", cluster_id: "cA", title: "Y", published_at: "2026-10-31T08:10:00.000Z" },
    ];
    const pairCandidates: JevPairCandidate[] = [
      { id: "n1", cluster_id: "cB", title: "Başlık", published_at: "2026-10-31T08:00:00.000Z" },
      { id: "n2", cluster_id: "cC", title: "Başlık", published_at: "2026-10-31T08:00:00.000Z" },
    ];

    // Only 'audit:pairs' is tight: the audit_pairs stage ('audit:audit_pairs', no allowance) runs,
    // the pairs stage is capped (default 2,000-token reserve > 1,000 allowance).
    const keyed = makePorts({ auditPairs, pairCandidates }, withBudgets({}, { "audit:pairs": 1_000 }));
    const capped = await runJevShadow(keyed.ports, { mode: "audit" });
    expect(capped.stages.audit_pairs.calls).toBe(1);
    expect(capped.stages.audit_pairs.capped).toBe(0);
    expect(capped.stages.pairs.calls).toBe(0);
    expect(capped.stages.pairs.capped).toBe(1);
    expect(capped.status).toBe("ok");
    expect(lastNote(keyed)).toBe("daily cap: pairs=1");
    expect(lastLedger(keyed)["audit:audit_pairs"]).toBeDefined();
    expect(lastLedger(keyed)["audit:pairs"]).toBeUndefined();

    // The same tight allowances under the BARE stage names are shadow-mode keys: ignored in audit mode.
    const bare = makePorts(
      { auditPairs, pairCandidates },
      withBudgets({}, { pairs: 1, audit_pairs: 1 }),
    );
    const open = await runJevShadow(bare.ports, { mode: "audit" });
    expect(open.stages.audit_pairs.calls).toBe(1);
    expect(open.stages.pairs.calls).toBe(1);
    expect(open.stages.pairs.capped).toBe(0);
    expect(lastNote(bare)).toBeNull();
  });

  it("(f2) shadow mode reads the bare stage key ('pairs'), not 'audit:pairs'", async () => {
    const pairCandidates: JevPairCandidate[] = Array.from({ length: 6 }, (_, i) => ({
      id: `n${i}`,
      cluster_id: `c${i}`,
      title: "Başlık",
      published_at: "2026-10-31T08:00:00.000Z",
    }));
    const h = makePorts({ pairCandidates }, withBudgets({}, { "audit:pairs": 1, pairs: 1_000 }));

    const result = await runJevShadow(h.ports);

    expect(result.stages.pairs.calls).toBe(0);
    expect(result.stages.pairs.capped).toBeGreaterThan(0);
  });

  it("(g) a capped stage never sets a stop reason: the failed-stage note still wins and later stages still run", async () => {
    const h = makePorts(
      { titles: [realEdit("t1")], tickers: [tickerRow(1)] },
      {
        ...withBudgets({ title_versions: { calls: 0, tokens: 199_999 } }, { title_versions: 200_000 }),
        fetchPendingKap: async () => {
          throw new Error("kap fetch failed");
        },
      },
    );

    const result = await runJevShadow(h.ports);

    expect(result.status).toBe("partial");
    expect(lastNote(h)).toBe("stage failed: kap");
    expect(result.stages.title_versions.capped).toBe(1);
    expect(result.stages.tickers.calls).toBe(1);
  });

  it("(h) every stats entry carries a numeric capped counter, 0 unless the stage was capped", async () => {
    const h = makePorts({ articles: [articleRow(1)] });

    const result = await runJevShadow(h.ports);

    for (const stats of Object.values(result.stages)) expect(stats.capped).toBe(0);
    expect(Object.keys(result.stages)).toHaveLength(10);
  });
});
