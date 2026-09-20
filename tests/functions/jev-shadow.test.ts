import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  JEV_CLUSTER_MEMBER_MAX,
  JEV_CONCURRENCY,
  JEV_DESC_CLAMP,
  JEV_MODEL,
  JEV_PAIRS_PER_CALL,
  JEV_PREVIEW_CLAMP,
  JEV_TITLE_CLAMP,
  JevDeadlineError,
  JevRateLimitError,
  JevResponseError,
  booleanAgrees,
  budgetExceeded,
  buildArticleCall,
  buildClusterCall,
  buildKapCall,
  buildPairCall,
  buildTitleCall,
  canonicalJson,
  choiceAgrees,
  clamp,
  isRateLimitStatus,
  offendingQuestionIds,
  pairKey,
  parseJevResponse,
  politicsBaseline,
  predictionRow,
  retryDelayMs,
  runJevShadow,
  samplePairs,
  stateHash,
  statePreview,
  tokensToUsd,
  topicBaseline,
  type JevArticleRow,
  type JevClusterRow,
  type JevKapRow,
  type JevMemberRow,
  type JevPairCandidate,
  type JevPorts,
  type JevPredictionRow,
  type JevQuestion,
  type JevRequest,
  type JevResponse,
  type JevAnswer,
  type JevTitleRow,
} from "../../supabase/functions/_shared/jev.ts";
import { sha256Hex } from "../../supabase/functions/_shared/archive.ts";

// Pure-helper + algorithm contract for the jev-shadow Edge Function
// (TypeSafe Jev shadow mode, migration 061). The Supabase/gateway wiring in
// jev-shadow/index.ts is thin (W2); everything that can silently rot lives
// here -- canonical hashing, the gateway response contract, the retry/error
// classification, the baseline/agree rules per task, and runJevShadow's
// budget/deadline/rate-limit/finally-close invariants. Modelled line for
// line on tests/functions/archive-export.test.ts (in-memory ports
// recorder, sectioned describes).

// --- verified live gateway bodies (plan-result.json response_example /
//     error_shapes, captured 2026-09-20) -----------------------------------

const VERIFIED_200_BODY = {
  answers: {
    politics: { type: "boolean", probability: 0.98 },
    topic: { type: "choice", choice: "politics", probabilities: { politics: 1, other: 0, economy: 0 } },
  },
  rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
  usage: { inputTokens: 433, outputTokens: 62 },
  warnings: [],
  providerMetadata: {
    typesafe: { confidence: { topic: 1 } },
    gateway: {
      routing: {
        originalModelId: "typesafe-ai/jev",
        resolvedProvider: "typesafe-ai",
        finalProvider: "typesafe-ai",
        modelAttemptCount: 1,
      },
      cost: "0",
      marketCost: "0.000018186",
      surchargeCost: "0",
      gatewayCost: "0",
      generationId: "gen_01M2ZJ65M4A5JSEBFW8MA50YNC",
    },
  },
};

const VERIFIED_400_BODY = {
  error: {
    message: "Invalid discriminator value. Expected 'choice' | 'score' | 'boolean'",
    param: [
      {
        code: "invalid_union",
        path: ["questions", "badType", "type"],
        discriminator: "type",
        options: ["choice", "score", "boolean"],
        message: "Invalid discriminator value. Expected 'choice' | 'score' | 'boolean'",
      },
      {
        code: "custom",
        path: ["questions", "emptyChoice", "criteria"],
        message: "Choice questions require at least one criterion",
      },
    ],
    type: "invalid_request_error",
  },
};

// --- seeded PRNG for deterministic samplePairs/runJevShadow tests ---------

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

// --- fixtures ---------------------------------------------------------------

function articleRow(overrides: Partial<JevArticleRow> = {}): JevArticleRow {
  return {
    id: "a1",
    title: "Başlık",
    description: "Açıklama",
    category: "politika",
    published_at: "2026-09-19T10:00:00.000Z",
    source_slug: "ornek",
    ...overrides,
  };
}

function clusterRow(overrides: Partial<JevClusterRow> = {}): JevClusterRow {
  return { id: "c1", title: "Olay", updated_at: "2026-09-19T09:00:00.000Z", ...overrides };
}

function memberRow(overrides: Partial<JevMemberRow> = {}): JevMemberRow {
  return {
    cluster_id: "c1",
    article_id: "m1",
    title: "Üye başlığı",
    published_at: "2026-09-19T08:00:00.000Z",
    ...overrides,
  };
}

function pairCandidateRow(overrides: Partial<JevPairCandidate> = {}): JevPairCandidate {
  return {
    id: "p1",
    cluster_id: "c1",
    title: "Başlık",
    published_at: "2026-09-19T08:00:00.000Z",
    ...overrides,
  };
}

function kapRow(overrides: Partial<JevKapRow> = {}): JevKapRow {
  return {
    disclosure_index: "KAP-1",
    kap_title: "Bildirim",
    subject: null,
    summary: "Özet",
    disclosure_class: "ODA",
    stock_codes: [],
    ...overrides,
  };
}

function titleVersionRow(overrides: Partial<JevTitleRow> = {}): JevTitleRow {
  return { id: "v1", article_id: "a1", old_title: "Eski", new_title: "Yeni", ...overrides };
}

function defaultAnswerFor(question: JevQuestion): JevAnswer {
  if (question.type === "boolean") return { type: "boolean", probability: 0.9 };
  if (question.type === "choice") {
    const firstKey = Object.keys(question.criteria)[0] ?? "unknown";
    return { type: "choice", choice: firstKey };
  }
  return { type: "score", score: 1 };
}

function validResponseFor(req: JevRequest): JevResponse {
  const answers: Record<string, JevAnswer> = {};
  for (const [key, q] of Object.entries(req.questions)) {
    answers[key] = defaultAnswerFor(q);
  }
  return { answers, usage: { inputTokens: 100, outputTokens: 10 }, warnings: [] };
}

// --- in-memory JevPorts recorder --------------------------------------------

interface Recorder {
  ports: JevPorts;
  order: string[];
  evaluateCalls: JevRequest[];
  monthTokensCalls: number[];
  startRunCalls: number;
  finishRunCalls: Array<{ id: number; patch: Parameters<JevPorts["finishRun"]>[1] }>;
  insertPredictionsCalls: JevPredictionRow[][];
  recordTokensCalls: Array<{ runId: number; calls: number; inputTokens: number }>;
  fetchSeenSubjectsCalls: Array<{ task: string; subjectIds: string[] }>;
  fetchPendingArticlesCalls: Array<{ sinceIso: string; limit: number }>;
  fetchRecentClustersCalls: Array<{ sinceIso: string; limit: number }>;
  fetchClusterMembersCalls: Array<{ clusterIds: string[] }>;
  fetchPairCandidatesCalls: Array<{ sinceIso: string; limit: number }>;
  fetchPendingKapCalls: Array<{ sinceIso: string; limit: number }>;
  fetchPendingTitleVersionsCalls: Array<{ sinceIso: string; limit: number }>;
}

function makePorts(overrides: Partial<JevPorts> = {}): Recorder {
  const rec: Recorder = {
    ports: {} as JevPorts,
    order: [],
    evaluateCalls: [],
    monthTokensCalls: [],
    startRunCalls: 0,
    finishRunCalls: [],
    insertPredictionsCalls: [],
    recordTokensCalls: [],
    fetchSeenSubjectsCalls: [],
    fetchPendingArticlesCalls: [],
    fetchRecentClustersCalls: [],
    fetchClusterMembersCalls: [],
    fetchPairCandidatesCalls: [],
    fetchPendingKapCalls: [],
    fetchPendingTitleVersionsCalls: [],
  };

  const tick = 0;
  const base: JevPorts = {
    now: () => tick,
    random: mulberry32(42),
    evaluate: async (req) => {
      rec.order.push("evaluate");
      rec.evaluateCalls.push(req);
      return { response: validResponseFor(req), latencyMs: 5 };
    },
    monthTokens: async (cap) => {
      rec.order.push("monthTokens");
      rec.monthTokensCalls.push(cap);
      return { input_tokens: 0, cap, exceeded: false };
    },
    startRun: async () => {
      rec.order.push("startRun");
      rec.startRunCalls += 1;
      return 1;
    },
    finishRun: async (id, patch) => {
      rec.order.push("finishRun");
      rec.finishRunCalls.push({ id, patch });
    },
    insertPredictions: async (rows) => {
      rec.order.push("insertPredictions");
      rec.insertPredictionsCalls.push([...rows]);
      return rows.length;
    },
    fetchSeenSubjects: async (task, subjectIds) => {
      rec.order.push("fetchSeenSubjects");
      rec.fetchSeenSubjectsCalls.push({ task, subjectIds: [...subjectIds] });
      return new Set<string>();
    },
    recordTokens: async (runId, calls, inputTokens) => {
      rec.order.push("recordTokens");
      rec.recordTokensCalls.push({ runId, calls, inputTokens });
    },
    fetchPendingArticles: async (sinceIso, limit) => {
      rec.order.push("fetchPendingArticles");
      rec.fetchPendingArticlesCalls.push({ sinceIso, limit });
      return [];
    },
    fetchRecentClusters: async (sinceIso, limit) => {
      rec.order.push("fetchRecentClusters");
      rec.fetchRecentClustersCalls.push({ sinceIso, limit });
      return [];
    },
    fetchClusterMembers: async (clusterIds) => {
      rec.order.push("fetchClusterMembers");
      rec.fetchClusterMembersCalls.push({ clusterIds: [...clusterIds] });
      return [];
    },
    fetchPairCandidates: async (sinceIso, limit) => {
      rec.order.push("fetchPairCandidates");
      rec.fetchPairCandidatesCalls.push({ sinceIso, limit });
      return [];
    },
    fetchPendingKap: async (sinceIso, limit) => {
      rec.order.push("fetchPendingKap");
      rec.fetchPendingKapCalls.push({ sinceIso, limit });
      return [];
    },
    fetchPendingTitleVersions: async (sinceIso, limit) => {
      rec.order.push("fetchPendingTitleVersions");
      rec.fetchPendingTitleVersionsCalls.push({ sinceIso, limit });
      return [];
    },
  };

  rec.ports = { ...base, ...overrides };
  return rec;
}

// --- 1. canonicalJson --------------------------------------------------------

describe("canonicalJson", () => {
  it("recursively sorts object keys", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });

  it("preserves array order while sorting keys of array elements", () => {
    expect(
      canonicalJson([
        { b: 1, a: 2 },
        { d: 1, c: 2 },
      ]),
    ).toBe('[{"a":2,"b":1},{"c":2,"d":1}]');
  });

  it("handles primitives and null", () => {
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(5)).toBe("5");
  });
});

// --- 2. stateHash -------------------------------------------------------------

describe("stateHash", () => {
  it("is deterministic for the same state", async () => {
    const state = { title: "a", n: 1 };
    await expect(stateHash(state)).resolves.toBe(await stateHash(state));
  });

  it("hashes identically regardless of key order", async () => {
    const h1 = await stateHash({ a: 1, b: 2 });
    const h2 = await stateHash({ b: 2, a: 1 });
    expect(h1).toBe(h2);
  });

  it("hashes differently when a member changes", async () => {
    const h1 = await stateHash({ a: 1 });
    const h2 = await stateHash({ a: 2 });
    expect(h1).not.toBe(h2);
  });

  it("matches sha256Hex(canonicalJson(state))", async () => {
    const state = { z: 1, a: [1, 2, 3] };
    expect(await stateHash(state)).toBe(await sha256Hex(canonicalJson(state)));
  });
});

// --- 3. clamp / statePreview --------------------------------------------------

describe("clamp", () => {
  it("returns the text unchanged when under the limit", () => {
    expect(clamp("hello", 10)).toBe("hello");
  });

  it("truncates text longer than max", () => {
    expect(clamp("abcdefgh", 4)).toBe("abcd");
  });

  it("returns '' for null/undefined", () => {
    expect(clamp(null, 10)).toBe("");
    expect(clamp(undefined, 10)).toBe("");
  });

  it("returns '' for the empty string", () => {
    expect(clamp("", 10)).toBe("");
  });
});

describe("statePreview", () => {
  it("clamps to JEV_PREVIEW_CLAMP", () => {
    const long = "x".repeat(500);
    expect(statePreview(long).length).toBeLessThanOrEqual(JEV_PREVIEW_CLAMP);
  });

  it("collapses newlines to spaces", () => {
    const preview = statePreview("line one\nline two\r\nline three");
    expect(preview).not.toMatch(/[\r\n]/);
  });

  it("renders a plain-object state as a readable one-liner", () => {
    const preview = statePreview({ title: "Başlık", description: "Açıklama" });
    expect(preview).toContain("Başlık");
    expect(preview).not.toMatch(/[\r\n]/);
  });
});

// --- 4. parseJevResponse -------------------------------------------------------

describe("parseJevResponse", () => {
  it("accepts the verified 200 response body (politics=boolean, topic=choice)", () => {
    const parsed = parseJevResponse(VERIFIED_200_BODY);
    expect(parsed.answers.politics).toEqual({ type: "boolean", probability: 0.98 });
    expect(parsed.answers.topic).toMatchObject({ type: "choice", choice: "politics" });
    expect(parsed.usage).toEqual({ inputTokens: 433, outputTokens: 62 });
  });

  it("never throws on extra unknown top-level fields (rounding, warnings, providerMetadata)", () => {
    expect(() => parseJevResponse(VERIFIED_200_BODY)).not.toThrow();
  });

  it("rejects a body with a missing or non-object `answers`", () => {
    expect(() => parseJevResponse({ usage: { inputTokens: 1, outputTokens: 1 } })).toThrow(JevResponseError);
    expect(() =>
      parseJevResponse({ answers: "nope", usage: { inputTokens: 1, outputTokens: 1 } }),
    ).toThrow(JevResponseError);
  });

  it("rejects a body with a missing usage.inputTokens", () => {
    expect(() =>
      parseJevResponse({
        answers: { a: { type: "boolean", probability: 0.5 } },
        usage: { outputTokens: 5 },
      }),
    ).toThrow(JevResponseError);
  });

  it("rejects an answer whose type is not boolean|choice|score", () => {
    expect(() =>
      parseJevResponse({
        answers: { a: { type: "weird", probability: 0.5 } },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).toThrow(JevResponseError);
  });

  it("rejects a boolean answer with a missing, non-numeric, NaN, or out-of-[0,1] probability", () => {
    for (const probability of [undefined, "0.5", NaN, -0.1, 1.1]) {
      expect(() =>
        parseJevResponse({
          answers: { a: { type: "boolean", probability } },
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      ).toThrow(JevResponseError);
    }
    expect(() =>
      parseJevResponse({
        answers: { a: { type: "boolean", probability: 0 } },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).not.toThrow();
  });

  it("rejects a score answer with a missing, non-numeric, NaN, or out-of-[0,10) score", () => {
    for (const score of [undefined, "1", NaN, -1, 10, 10.5]) {
      expect(() =>
        parseJevResponse({
          answers: { a: { type: "score", score } },
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      ).toThrow(JevResponseError);
    }
    expect(() =>
      parseJevResponse({
        answers: { a: { type: "score", score: 0 } },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).not.toThrow();
  });

  it("rejects a choice answer with a missing, non-string, or empty-string choice", () => {
    for (const choice of [undefined, 5, ""]) {
      expect(() =>
        parseJevResponse({
          answers: { a: { type: "choice", choice } },
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      ).toThrow(JevResponseError);
    }
    expect(() =>
      parseJevResponse({
        answers: { a: { type: "choice", choice: "ok" } },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).not.toThrow();
  });
});

// --- 5. offendingQuestionIds ----------------------------------------------------

describe("offendingQuestionIds", () => {
  it("reads error.param[].path against the verified 400 body", () => {
    expect(offendingQuestionIds(VERIFIED_400_BODY)).toEqual(["badType", "emptyChoice"]);
  });

  it("returns [] when there is no error field, or the body is not an object", () => {
    expect(offendingQuestionIds({})).toEqual([]);
    expect(offendingQuestionIds(null)).toEqual([]);
    expect(offendingQuestionIds("nope")).toEqual([]);
    expect(offendingQuestionIds(undefined)).toEqual([]);
  });

  it("returns [] when error.param is missing or not an array", () => {
    expect(offendingQuestionIds({ error: { message: "x" } })).toEqual([]);
    expect(offendingQuestionIds({ error: { message: "x", param: "nope" } })).toEqual([]);
  });

  it("skips param entries whose path does not start with 'questions'", () => {
    expect(
      offendingQuestionIds({ error: { param: [{ path: ["state"] }, { path: ["questions", "ok"] }] } }),
    ).toEqual(["ok"]);
  });
});

// --- 6. isRateLimitStatus / retryDelayMs -----------------------------------------

describe("isRateLimitStatus / retryDelayMs", () => {
  it("is true only for 429", () => {
    expect(isRateLimitStatus(429)).toBe(true);
    expect(isRateLimitStatus(400)).toBe(false);
    expect(isRateLimitStatus(401)).toBe(false);
    expect(isRateLimitStatus(500)).toBe(false);
    expect(isRateLimitStatus(200)).toBe(false);
  });

  it("doubles from 500ms and caps at 8000ms", () => {
    expect(retryDelayMs(0)).toBe(500);
    expect(retryDelayMs(1)).toBe(1000);
    expect(retryDelayMs(2)).toBe(2000);
    expect(retryDelayMs(3)).toBe(4000);
    expect(retryDelayMs(4)).toBe(8000);
    expect(retryDelayMs(5)).toBe(8000);
    expect(retryDelayMs(10)).toBe(8000);
  });
});

// --- 7. tokensToUsd / budgetExceeded -----------------------------------------------

describe("tokensToUsd / budgetExceeded", () => {
  it("converts tokens to USD at JEV_USD_PER_TOKEN (42 / 1e9)", () => {
    expect(tokensToUsd(1_000_000_000)).toBeCloseTo(42, 10);
    expect(tokensToUsd(0)).toBe(0);
  });

  it("is exceeded when monthTokens + runTokens >= cap (boundary is inclusive)", () => {
    expect(budgetExceeded(0, 0, 100)).toBe(false);
    expect(budgetExceeded(40, 50, 100)).toBe(false);
    expect(budgetExceeded(50, 50, 100)).toBe(true);
    expect(budgetExceeded(60, 50, 100)).toBe(true);
  });
});

// --- 8. politicsBaseline / topicBaseline ---------------------------------------------

describe("politicsBaseline / topicBaseline", () => {
  it("politicsBaseline is true for politika/son_dakika, false otherwise including null", () => {
    expect(politicsBaseline("politika")).toBe(true);
    expect(politicsBaseline("son_dakika")).toBe(true);
    expect(politicsBaseline("ekonomi")).toBe(false);
    expect(politicsBaseline("spor")).toBe(false);
    expect(politicsBaseline(null)).toBe(false);
  });

  it("topicBaseline maps the 3-way taxonomy and returns null for the ambiguous/unmapped cases", () => {
    expect(topicBaseline("politika")).toBe("politics");
    expect(topicBaseline("ekonomi")).toBe("economy");
    expect(topicBaseline("spor")).toBe("other");
    expect(topicBaseline("teknoloji")).toBe("other");
    expect(topicBaseline("yasam")).toBe("other");
    expect(topicBaseline("genel")).toBe("other");
    expect(topicBaseline("son_dakika")).toBeNull();
    expect(topicBaseline("dunya")).toBeNull();
    expect(topicBaseline(null)).toBeNull();
    expect(topicBaseline("something_else")).toBeNull();
  });
});

// --- 9. booleanAgrees / choiceAgrees -----------------------------------------------

describe("booleanAgrees / choiceAgrees", () => {
  it("booleanAgrees compares (prob >= threshold) to the baseline", () => {
    expect(booleanAgrees(0.5, true)).toBe(true);
    expect(booleanAgrees(0.49, true)).toBe(false);
    expect(booleanAgrees(0.4, false)).toBe(true);
    expect(booleanAgrees(0.6, false)).toBe(false);
  });

  it("choiceAgrees returns null for a null baseline, otherwise an exact-match boolean", () => {
    expect(choiceAgrees("a", null)).toBeNull();
    expect(choiceAgrees("a", "a")).toBe(true);
    expect(choiceAgrees("a", "b")).toBe(false);
  });
});

// --- 10. pairKey / samplePairs -------------------------------------------------------

describe("pairKey", () => {
  it("sorts the two ids so an unordered pair always produces the same key", () => {
    expect(pairKey("b", "a")).toBe("a:b");
    expect(pairKey("a", "b")).toBe("a:b");
  });
});

describe("samplePairs", () => {
  it("returns [] when fewer than 2 rows are given", () => {
    expect(samplePairs([], 10, Math.random)).toEqual([]);
    expect(samplePairs([pairCandidateRow()], 10, Math.random)).toEqual([]);
  });

  it("never pairs two candidates from the same cluster", () => {
    const rows = [
      pairCandidateRow({ id: "1", cluster_id: "c1" }),
      pairCandidateRow({ id: "2", cluster_id: "c1" }),
      pairCandidateRow({ id: "3", cluster_id: "c2" }),
      pairCandidateRow({ id: "4", cluster_id: "c3" }),
    ];
    const pairs = samplePairs(rows, 20, mulberry32(7));
    expect(pairs.length).toBeGreaterThan(0);
    for (const p of pairs) expect(p.a.cluster_id).not.toBe(p.b.cluster_id);
  });

  it("never produces a duplicate pairKey", () => {
    const rows = Array.from({ length: 10 }, (_, i) => pairCandidateRow({ id: `r${i}`, cluster_id: `c${i % 5}` }));
    const pairs = samplePairs(rows, 20, mulberry32(3));
    const keys = pairs.map((p) => pairKey(p.a.id, p.b.id));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is deterministic under a seeded random function", () => {
    const rows = Array.from({ length: 8 }, (_, i) => pairCandidateRow({ id: `r${i}`, cluster_id: `c${i % 4}` }));
    const pairs1 = samplePairs(rows, 20, mulberry32(99));
    const pairs2 = samplePairs(rows, 20, mulberry32(99));
    expect(pairs1.map((p) => pairKey(p.a.id, p.b.id))).toEqual(pairs2.map((p) => pairKey(p.a.id, p.b.id)));
  });

  it("only pairs candidates published on the same UTC day", () => {
    const rows = [
      pairCandidateRow({ id: "1", cluster_id: "c1", published_at: "2026-09-19T08:00:00.000Z" }),
      pairCandidateRow({ id: "2", cluster_id: "c2", published_at: "2026-09-19T09:00:00.000Z" }),
      pairCandidateRow({ id: "3", cluster_id: "c3", published_at: "2026-09-20T08:00:00.000Z" }),
    ];
    const pairs = samplePairs(rows, 20, mulberry32(5));
    for (const p of pairs) {
      expect(p.a.published_at.slice(0, 10)).toBe(p.b.published_at.slice(0, 10));
    }
  });

  it("never spins forever -- bounded to count*10 attempts even when few pairs are possible", () => {
    const rows = [pairCandidateRow({ id: "1", cluster_id: "c1" }), pairCandidateRow({ id: "2", cluster_id: "c2" })];
    const pairs = samplePairs(rows, 20, mulberry32(1));
    expect(pairs.length).toBeLessThanOrEqual(1);
  });
});

// --- 11. predictionRow -----------------------------------------------------------------

describe("predictionRow", () => {
  const baseResponse: JevResponse = { answers: {}, usage: { inputTokens: 100, outputTokens: 20 } };

  it("rounds a boolean probability into jev_prob and leaves jev_choice null", () => {
    const row = predictionRow({
      task: "politics",
      subjectType: "article",
      subjectId: "a1",
      stateHash: "h",
      preview: "p",
      questionId: "politics",
      callId: "c1",
      answer: { type: "boolean", probability: 0.98765 },
      response: baseResponse,
      baseline: "true",
      agree: true,
      latencyMs: 10,
      runId: 1,
    });
    expect(row.jev_prob).toBe(0.988);
    expect(row.jev_choice).toBeNull();
  });

  it("rounds a score into jev_prob and leaves jev_choice null", () => {
    const row = predictionRow({
      task: "sensational",
      subjectType: "article",
      subjectId: "a1",
      stateHash: "h",
      preview: "p",
      questionId: "sensational",
      callId: "c1",
      answer: { type: "score", score: 2.34567 },
      response: baseResponse,
      baseline: "none",
      agree: null,
      latencyMs: 10,
      runId: 1,
    });
    expect(row.jev_prob).toBe(2.346);
    expect(row.jev_choice).toBeNull();
  });

  it("carries the choice into jev_choice and leaves jev_prob null", () => {
    const row = predictionRow({
      task: "topic",
      subjectType: "article",
      subjectId: "a1",
      stateHash: "h",
      preview: "p",
      questionId: "topic",
      callId: "c1",
      answer: { type: "choice", choice: "economy" },
      response: baseResponse,
      baseline: "economy",
      agree: true,
      latencyMs: 10,
      runId: 1,
    });
    expect(row.jev_prob).toBeNull();
    expect(row.jev_choice).toBe("economy");
  });

  it("defaults market_cost/confidence to null and warnings to [] when providerMetadata is absent", () => {
    const row = predictionRow({
      task: "politics",
      subjectType: "article",
      subjectId: "a1",
      stateHash: "h",
      preview: "p",
      questionId: "politics",
      callId: "c1",
      answer: { type: "boolean", probability: 0.5 },
      response: baseResponse,
      baseline: "true",
      agree: true,
      latencyMs: 10,
      runId: 1,
    });
    expect(row.jev_answer).toMatchObject({
      question_id: "politics",
      call_id: "c1",
      state_preview: "p",
      output_tokens: 20,
      market_cost: null,
      confidence: null,
      warnings: [],
    });
  });

  it("reads market_cost and per-question confidence from providerMetadata when present", () => {
    const response: JevResponse = {
      answers: {},
      usage: { inputTokens: 100, outputTokens: 20 },
      warnings: ["w1"],
      providerMetadata: {
        gateway: { marketCost: "0.000018186" },
        typesafe: { confidence: { politics: 0.87 } },
      },
    };
    const row = predictionRow({
      task: "politics",
      subjectType: "article",
      subjectId: "a1",
      stateHash: "h",
      preview: "p",
      questionId: "politics",
      callId: "c1",
      answer: { type: "boolean", probability: 0.5 },
      response,
      baseline: "true",
      agree: true,
      latencyMs: 10,
      runId: 1,
    });
    expect(row.jev_answer).toMatchObject({ market_cost: "0.000018186", confidence: 0.87, warnings: ["w1"] });
  });

  it("carries model, input_tokens, run_id, latency_ms, and null article/cluster ids by default", () => {
    const row = predictionRow({
      task: "politics",
      subjectType: "article",
      subjectId: "a1",
      stateHash: "h",
      preview: "p",
      questionId: "politics",
      callId: "c1",
      answer: { type: "boolean", probability: 0.5 },
      response: baseResponse,
      baseline: "true",
      agree: true,
      latencyMs: 42,
      runId: 7,
    });
    expect(row.model).toBe(JEV_MODEL);
    expect(row.input_tokens).toBe(100);
    expect(row.run_id).toBe(7);
    expect(row.latency_ms).toBe(42);
    expect(row.article_id).toBeNull();
    expect(row.cluster_id).toBeNull();
  });
});

// --- 12. question builders -----------------------------------------------------------

describe("buildArticleCall", () => {
  it("builds state {title, description} only (no outlet slug, no timestamp) and all six article questions", () => {
    const a = articleRow();
    const req = buildArticleCall(a);
    expect(req.state).toEqual({
      title: clamp(a.title, JEV_TITLE_CLAMP),
      description: clamp(a.description, JEV_DESC_CLAMP),
    });
    expect(JSON.stringify(req.state)).not.toContain(a.source_slug ?? " ");
    expect(Object.keys(req.questions).sort()).toEqual(
      ["clickbait", "framing", "opinion", "politics", "sensational", "topic"].sort(),
    );
    expect(req.questions.sensational?.type).toBe("score");
    expect(req.questions.topic?.type).toBe("choice");
    expect(req.questions.politics?.type).toBe("boolean");
  });

  it("maps a null description to an empty string and never adds a source key", () => {
    const req = buildArticleCall(articleRow({ description: null, source_slug: null }));
    const state = req.state as { description: string; source?: unknown };
    expect(state.description).toBe("");
    expect("source" in state).toBe(false);
  });
});

describe("buildClusterCall", () => {
  it("returns keys={} (skip) when fewer than 2 members are given", () => {
    const { keys } = buildClusterCall(clusterRow(), [memberRow()]);
    expect(keys).toEqual({});
  });

  it("orders members by published_at ascending and caps at JEV_CLUSTER_MEMBER_MAX, keeping the earliest (seed) members", () => {
    const members = Array.from({ length: 14 }, (_, i) =>
      memberRow({ article_id: `m${i}`, published_at: `2026-09-19T08:${String(i).padStart(2, "0")}:00.000Z` }),
    );
    const { request, keys } = buildClusterCall(clusterRow(), members);

    expect(Object.keys(keys)).toHaveLength(JEV_CLUSTER_MEMBER_MAX);
    expect(keys.m1).toBe("m0");
    expect(keys[`m${JEV_CLUSTER_MEMBER_MAX}`]).toBe(`m${JEV_CLUSTER_MEMBER_MAX - 1}`);
    const state = request.state as { headlines: Record<string, string> };
    expect(Object.keys(state.headlines)).toHaveLength(JEV_CLUSTER_MEMBER_MAX);
  });
});

describe("buildPairCall", () => {
  it("keys pairs p1..pN and caps at JEV_PAIRS_PER_CALL", () => {
    const pairs = Array.from({ length: 12 }, (_, i) => ({
      a: pairCandidateRow({ id: `a${i}` }),
      b: pairCandidateRow({ id: `b${i}`, cluster_id: "other" }),
    }));
    const { request, keys } = buildPairCall(pairs);
    expect(Object.keys(keys)).toHaveLength(JEV_PAIRS_PER_CALL);
    const state = request.state as { pairs: Record<string, { a: string; b: string }> };
    expect(Object.keys(state.pairs)).toHaveLength(JEV_PAIRS_PER_CALL);
    expect(Object.keys(request.questions)).toHaveLength(JEV_PAIRS_PER_CALL);
  });
});

describe("buildKapCall / buildTitleCall", () => {
  it("buildKapCall asks kap_class (choice) and kap_materiality (score)", () => {
    const req = buildKapCall(kapRow());
    expect(req.questions.kap_class?.type).toBe("choice");
    expect(req.questions.kap_materiality?.type).toBe("score");
  });

  it("buildTitleCall asks title_meaning (boolean) and title_edit_kind (choice)", () => {
    const req = buildTitleCall(titleVersionRow());
    expect(req.questions.title_meaning?.type).toBe("boolean");
    expect(req.questions.title_edit_kind?.type).toBe("choice");
    expect(req.state).toEqual({ before: "Eski", after: "Yeni" });
  });
});

// --- 13. error classes ---------------------------------------------------------------

describe("JevDeadlineError / JevRateLimitError / JevResponseError", () => {
  it("JevDeadlineError names the stage in its message", () => {
    const err = new JevDeadlineError("clusters");
    expect(err.name).toBe("JevDeadlineError");
    expect(err.message).toContain("clusters");
  });

  it("JevRateLimitError and JevResponseError carry their own message and name", () => {
    const rl = new JevRateLimitError("429 rate limited");
    expect(rl.name).toBe("JevRateLimitError");
    expect(rl.message).toBe("429 rate limited");

    const re = new JevResponseError("bad shape");
    expect(re.name).toBe("JevResponseError");
    expect(re.message).toBe("bad shape");
  });
});

// --- 14. runJevShadow -----------------------------------------------------------------

describe("runJevShadow", () => {
  it("(a) monthTokens(cap) runs before startRun; when exceeded it opens+closes a run with status budget_exceeded and makes zero evaluate calls", async () => {
    const rec = makePorts({
      monthTokens: async (cap) => {
        rec.order.push("monthTokens");
        rec.monthTokensCalls.push(cap);
        return { input_tokens: cap, cap, exceeded: true };
      },
    });

    const result = await runJevShadow(rec.ports, { cap: 1000 });

    expect(result.status).toBe("budget_exceeded");
    expect(result.calls).toBe(0);
    expect(rec.evaluateCalls).toHaveLength(0);
    expect(rec.finishRunCalls).toHaveLength(1);
    expect(rec.finishRunCalls[0]?.patch).toMatchObject({
      calls: 0,
      status: "budget_exceeded",
      note: "monthly cap reached",
    });
    expect(rec.order.indexOf("monthTokens")).toBeLessThan(rec.order.indexOf("startRun"));
    expect(rec.fetchPendingArticlesCalls).toHaveLength(0);
  });

  it("(b) stops with status partial and never throws when the deadline is already spent before the first stage begins", async () => {
    const ticks = [0, 999_999];
    let i = 0;
    const rec = makePorts({ now: () => ticks[Math.min(i++, ticks.length - 1)] ?? 0 });

    const result = await runJevShadow(rec.ports, { deadlineMs: 50_000 });

    expect(result.status).toBe("partial");
    expect(rec.fetchPendingArticlesCalls).toHaveLength(0);
    expect(rec.finishRunCalls).toHaveLength(1);
  });

  it("(c) never runs more than JEV_CONCURRENCY evaluate() calls concurrently", async () => {
    // A real (short) timer, not a manually-drained resolver queue: a
    // resolver-controlled fake that the test must release by hand risks
    // orphaning pending resolvers once another await in the chain (e.g.
    // stateHash's crypto.subtle.digest) lags behind pure microtask pumping,
    // which deadlocks the test. A tiny real setTimeout gives every in-flight
    // call the same wall-clock window to overlap, so maxInFlight is still a
    // reliable saturation signal, with no hand-rolled draining to get wrong.
    const articles = Array.from({ length: 20 }, (_, idx) => articleRow({ id: `a${idx}` }));
    let inFlight = 0;
    let maxInFlight = 0;

    const rec = makePorts({
      fetchPendingArticles: async () => articles,
      evaluate: async (req) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { response: validResponseFor(req), latencyMs: 1 };
      },
    });

    const result = await runJevShadow(rec.ports);

    expect(result.calls).toBe(20);
    expect(inFlight).toBe(0);
    expect(maxInFlight).toBeLessThanOrEqual(JEV_CONCURRENCY);
    expect(maxInFlight).toBe(JEV_CONCURRENCY);
  });

  it("(d) a single evaluate() failure is a per-subject skip -- increments errors and keeps processing the rest", async () => {
    const articles = [
      articleRow({ id: "a1" }),
      articleRow({ id: "a2", title: "trigger-error" }),
      articleRow({ id: "a3" }),
    ];
    const rec = makePorts({
      fetchPendingArticles: async () => articles,
      evaluate: async (req) => {
        rec.evaluateCalls.push(req);
        const state = req.state as { title: string };
        if (state.title === "trigger-error") throw new Error("network blip");
        return { response: validResponseFor(req), latencyMs: 1 };
      },
    });

    const result = await runJevShadow(rec.ports);

    expect(result.status).toBe("ok");
    expect(result.errors).toBe(1);
    expect(result.calls).toBe(2);
    expect(rec.evaluateCalls).toHaveLength(3);
  });

  it("(e) a JevRateLimitError aborts the run with status rate_limited and skips later stages", async () => {
    const articles = [articleRow({ id: "a1", title: "rate-limit-me" }), articleRow({ id: "a2" })];
    const rec = makePorts({
      fetchPendingArticles: async () => articles,
      evaluate: async (req) => {
        const state = req.state as { title: string };
        if (state.title === "rate-limit-me") throw new JevRateLimitError("429 from gateway");
        return { response: validResponseFor(req), latencyMs: 1 };
      },
    });

    const result = await runJevShadow(rec.ports);

    expect(result.status).toBe("rate_limited");
    expect(rec.fetchRecentClustersCalls).toHaveLength(0);
  });

  it("(f) re-checks budgetExceeded after every successful call and can stop mid-flight", async () => {
    const articles = Array.from({ length: 20 }, (_, idx) => articleRow({ id: `a${idx}` }));
    const rec = makePorts({
      fetchPendingArticles: async () => articles,
      evaluate: async (req) => ({
        response: { answers: validResponseFor(req).answers, usage: { inputTokens: 60, outputTokens: 5 } },
        latencyMs: 1,
      }),
    });

    const result = await runJevShadow(rec.ports, { cap: 100 });

    expect(result.status).toBe("budget_exceeded");
    expect(result.calls).toBeGreaterThanOrEqual(2);
    expect(result.calls).toBeLessThan(20);
  });

  it("(g) inserts prediction rows via insertPredictions in chunks that never exceed 200", async () => {
    const articles = Array.from({ length: 40 }, (_, idx) => articleRow({ id: `a${idx}` }));
    const rec = makePorts({ fetchPendingArticles: async () => articles });

    const result = await runJevShadow(rec.ports);

    expect(result.status).toBe("ok");
    expect(result.calls).toBe(40);
    const totalRows = rec.insertPredictionsCalls.reduce((n, rows) => n + rows.length, 0);
    expect(totalRows).toBe(result.rows);
    expect(totalRows).toBe(240);
    expect(rec.insertPredictionsCalls.length).toBeGreaterThanOrEqual(2);
    for (const rows of rec.insertPredictionsCalls) {
      expect(rows.length).toBeLessThanOrEqual(200);
    }
  });

  it("(h) finishRun always runs (try/finally), even when a stage's fetch throws -- status error, note clamped to 500 chars", async () => {
    const longMessage = "boom ".repeat(200);
    expect(longMessage.length).toBeGreaterThan(500);
    const rec = makePorts({
      fetchPendingArticles: async () => {
        throw new Error(longMessage);
      },
    });

    const result = await runJevShadow(rec.ports);

    expect(result.status).toBe("error");
    expect(rec.finishRunCalls).toHaveLength(1);
    const patch = rec.finishRunCalls[0]?.patch;
    expect(patch?.status).toBe("error");
    expect(patch?.note).not.toBeNull();
    expect(patch?.note?.length).toBeLessThanOrEqual(500);
  });

  it("(g2) checkpoints spend via recordTokens after every successful evaluate(), not only at finishRun (JEV-A12)", async () => {
    const articles = [articleRow({ id: "a1" }), articleRow({ id: "a2" })];
    const rec = makePorts({ fetchPendingArticles: async () => articles });

    const result = await runJevShadow(rec.ports);

    // At least one checkpoint landed before the run closed -- simulating a
    // kill right after the last evaluate() but before `finally` runs would
    // still leave this call's spend on the run row, unlike relying on
    // finishRun alone.
    expect(rec.recordTokensCalls.length).toBeGreaterThanOrEqual(2);
    const last = rec.recordTokensCalls.at(-1);
    expect(last?.runId).toBe(1);
    expect(last?.calls).toBe(result.calls);
    expect(last?.inputTokens).toBe(result.input_tokens);
    // Every recordTokens call happened before finishRun closed the run.
    expect(rec.order.indexOf("recordTokens")).toBeLessThan(rec.order.lastIndexOf("finishRun"));
  });

  it("(h2) finishRun still runs, with status='error', when the finally block's flushRemaining/insertPredictions rejects (JEV-A7)", async () => {
    const articles = [articleRow({ id: "a1" })];
    const rec = makePorts({
      fetchPendingArticles: async () => articles,
      insertPredictions: async () => {
        throw new Error("insert failed: connection reset");
      },
    });

    const result = await runJevShadow(rec.ports);

    expect(result.status).toBe("error");
    expect(rec.finishRunCalls).toHaveLength(1);
    const patch = rec.finishRunCalls[0]?.patch;
    expect(patch?.status).toBe("error");
    expect(patch?.note).toContain("insert failed");
  });

  it("(i) runs stages in order: articles -> clusters -> pairs -> kap -> title_versions", async () => {
    const rec = makePorts();

    await runJevShadow(rec.ports);

    const fetchOrder = rec.order.filter((name) => name.startsWith("fetch"));
    expect(fetchOrder).toEqual([
      "fetchPendingArticles",
      "fetchRecentClusters",
      "fetchPairCandidates",
      "fetchPendingKap",
      "fetchPendingTitleVersions",
    ]);
  });

  it("(j1) article stage: baselines, agreement, and the politics-row null-category skip", async () => {
    const articles = [articleRow({ id: "a-politics", category: "politika" }), articleRow({ id: "a-null-cat", category: null })];
    const rec = makePorts({
      fetchPendingArticles: async () => articles,
      evaluate: async (_req) => ({
        response: {
          answers: {
            politics: { type: "boolean", probability: 0.9 },
            topic: { type: "choice", choice: "other" },
            opinion: { type: "boolean", probability: 0.2 },
            clickbait: { type: "boolean", probability: 0.8 },
            framing: { type: "choice", choice: "neutral" },
            sensational: { type: "score", score: 2.5 },
          },
          usage: { inputTokens: 50, outputTokens: 5 },
        },
        latencyMs: 3,
      }),
    });

    await runJevShadow(rec.ports);
    const allRows = rec.insertPredictionsCalls.flat();

    const politicsRows = allRows.filter((r) => r.task === "politics");
    expect(politicsRows).toHaveLength(1);
    expect(politicsRows[0]).toMatchObject({ subject_id: "a-politics", baseline_answer: "true", agree: true });

    const topicPolitics = allRows.find((r) => r.task === "topic" && r.subject_id === "a-politics");
    expect(topicPolitics).toMatchObject({ baseline_answer: "politics", agree: false });

    const topicNull = allRows.find((r) => r.task === "topic" && r.subject_id === "a-null-cat");
    expect(topicNull).toMatchObject({ baseline_answer: "unknown", agree: null });

    for (const task of ["opinion", "clickbait", "framing", "sensational"] as const) {
      for (const subjectId of ["a-politics", "a-null-cat"]) {
        const row = allRows.find((r) => r.task === task && r.subject_id === subjectId);
        expect(row).toMatchObject({ baseline_answer: "none", agree: null });
      }
    }

    expect(allRows.filter((r) => r.subject_id === "a-null-cat")).toHaveLength(5);
    expect(allRows.filter((r) => r.subject_id === "a-politics")).toHaveLength(6);
  });

  it("(j2) cluster stage: cluster_member baseline is always true, subject_id is clusterId:articleId, and <2 members is a skip", async () => {
    const cluster1 = clusterRow({ id: "c1", title: "Olay" });
    const cluster2 = clusterRow({ id: "c2", title: "Tek üyeli" });
    const members = [
      memberRow({ cluster_id: "c1", article_id: "m1", published_at: "2026-09-19T08:00:00.000Z" }),
      memberRow({ cluster_id: "c1", article_id: "m2", published_at: "2026-09-19T08:10:00.000Z" }),
      memberRow({ cluster_id: "c2", article_id: "solo", published_at: "2026-09-19T08:00:00.000Z" }),
    ];
    const rec = makePorts({
      fetchRecentClusters: async () => [cluster1, cluster2],
      fetchClusterMembers: async () => members,
      evaluate: async (_req) => ({
        response: {
          answers: { m1: { type: "boolean", probability: 0.95 }, m2: { type: "boolean", probability: 0.3 } },
          usage: { inputTokens: 40, outputTokens: 4 },
        },
        latencyMs: 2,
      }),
    });

    const result = await runJevShadow(rec.ports);
    const allRows = rec.insertPredictionsCalls.flat();
    const clusterRows = allRows.filter((r) => r.task === "cluster_member");

    expect(clusterRows).toHaveLength(2);
    const m1Row = clusterRows.find((r) => r.subject_id === "c1:m1");
    const m2Row = clusterRows.find((r) => r.subject_id === "c1:m2");
    expect(m1Row).toMatchObject({ baseline_answer: "true", agree: true, article_id: "m1", cluster_id: "c1" });
    expect(m2Row).toMatchObject({ baseline_answer: "true", agree: false, article_id: "m2", cluster_id: "c1" });
    expect(result.stages.clusters.skipped).toBe(1);
  });

  it("(j2b) cluster stage: a fully-seen cluster (every member already predicted) produces zero evaluate() calls and is skipped (JEV-A10)", async () => {
    const cluster1 = clusterRow({ id: "c1", title: "Olay" });
    const members = [
      memberRow({ cluster_id: "c1", article_id: "m1", published_at: "2026-09-19T08:00:00.000Z" }),
      memberRow({ cluster_id: "c1", article_id: "m2", published_at: "2026-09-19T08:10:00.000Z" }),
    ];
    const rec = makePorts({
      fetchRecentClusters: async () => [cluster1],
      fetchClusterMembers: async () => members,
      fetchSeenSubjects: async (task, subjectIds) => {
        expect(task).toBe("cluster_member");
        expect(subjectIds).toEqual(["c1:m1", "c1:m2"]);
        return new Set(["c1:m1", "c1:m2"]);
      },
    });

    const result = await runJevShadow(rec.ports);

    expect(rec.evaluateCalls).toHaveLength(0);
    expect(result.stages.clusters.calls).toBe(0);
    expect(result.stages.clusters.skipped).toBe(1);
  });

  it("(j3) pair stage: pair_negative baseline is always false, agree, and subject_id is the sorted pair key", async () => {
    const candidates = [
      pairCandidateRow({ id: "p-aaa", cluster_id: "cX", published_at: "2026-09-19T08:00:00.000Z" }),
      pairCandidateRow({ id: "p-bbb", cluster_id: "cY", published_at: "2026-09-19T09:00:00.000Z" }),
    ];
    const rec = makePorts({
      fetchPairCandidates: async () => candidates,
      evaluate: async (_req) => ({
        response: { answers: { p1: { type: "boolean", probability: 0.2 } }, usage: { inputTokens: 30, outputTokens: 3 } },
        latencyMs: 2,
      }),
    });

    await runJevShadow(rec.ports);
    const allRows = rec.insertPredictionsCalls.flat();
    const pairRows = allRows.filter((r) => r.task === "pair_negative");

    expect(pairRows).toHaveLength(1);
    expect(pairRows[0]).toMatchObject({
      subject_id: "p-aaa:p-bbb",
      subject_type: "pair",
      baseline_answer: "false",
      agree: true,
      article_id: null,
      cluster_id: null,
    });
  });

  it("(j4) kap stage: kap_class agrees on exact string match, kap_materiality is collection-only", async () => {
    const row = kapRow({ disclosure_index: "KAP-1", disclosure_class: "ODA" });
    const rec = makePorts({
      fetchPendingKap: async () => [row],
      evaluate: async (_req) => ({
        response: {
          answers: { kap_class: { type: "choice", choice: "ODA" }, kap_materiality: { type: "score", score: 1.5 } },
          usage: { inputTokens: 20, outputTokens: 2 },
        },
        latencyMs: 2,
      }),
    });

    await runJevShadow(rec.ports);
    const allRows = rec.insertPredictionsCalls.flat();

    const classRow = allRows.find((r) => r.task === "kap_class");
    expect(classRow).toMatchObject({ subject_id: "KAP-1", baseline_answer: "ODA", agree: true, jev_choice: "ODA", jev_prob: null });

    const matRow = allRows.find((r) => r.task === "kap_materiality");
    expect(matRow).toMatchObject({ subject_id: "KAP-1", baseline_answer: "none", agree: null, jev_prob: 1.5, jev_choice: null });
  });

  it("(j5) title stage: title_meaning baseline is always true, title_edit_kind is collection-only", async () => {
    const versionRow = titleVersionRow({ id: "v1", article_id: "art-1" });
    const rec = makePorts({
      fetchPendingTitleVersions: async () => [versionRow],
      evaluate: async (_req) => ({
        response: {
          answers: {
            title_meaning: { type: "boolean", probability: 0.6 },
            title_edit_kind: { type: "choice", choice: "softening" },
          },
          usage: { inputTokens: 15, outputTokens: 2 },
        },
        latencyMs: 1,
      }),
    });

    await runJevShadow(rec.ports);
    const allRows = rec.insertPredictionsCalls.flat();

    const meaningRow = allRows.find((r) => r.task === "title_meaning");
    expect(meaningRow).toMatchObject({ subject_id: "v1", article_id: "art-1", baseline_answer: "true", agree: true });

    const kindRow = allRows.find((r) => r.task === "title_edit_kind");
    expect(kindRow).toMatchObject({ subject_id: "v1", baseline_answer: "none", agree: null, jev_choice: "softening" });
  });

  it("(j3b) pair stage: fewer than 2 samplable candidates marks stages.pairs.skipped instead of vanishing silently (JEV-A3)", async () => {
    const single = [pairCandidateRow({ id: "p-only", cluster_id: "cX", published_at: "2026-09-19T08:00:00.000Z" })];
    const rec = makePorts({ fetchPairCandidates: async () => single });

    const result = await runJevShadow(rec.ports);

    expect(result.stages.pairs.skipped).toBe(1);
    expect(result.stages.pairs.calls).toBe(0);
    // No pair-stage row should have been written.
    expect(rec.insertPredictionsCalls.flat().some((r) => r.task === "pair_negative")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JEV-A3 static guard: fetchPairCandidates in jev-shadow/index.ts must
// filter the 24h window server-side through the embedded article (a
// `!inner` embed + `.gte("article.published_at", ...)`), not by fetching an
// unfiltered oldest-cluster_id-first slice of `cluster_articles` and
// dropping stale rows in memory after the fact -- the bug this guards
// against (JEV-01/JEV-02/DB-4) silently starved `pair_negative` once the
// table grew past a few hundred rows.
// ---------------------------------------------------------------------------

describe("jev-shadow/index.ts fetchPairCandidates query shape (JEV-A3)", () => {
  it("filters via a server-side .gte on the embedded article, not an in-memory published_at skip", () => {
    const indexTs = readFileSync(
      resolve(__dirname, "..", "..", "supabase", "functions", "jev-shadow", "index.ts"),
      "utf8",
    );
    const fnMatch = indexTs.match(/async fetchPairCandidates[\s\S]*?\n    \},\n/);
    expect(fnMatch, "could not find fetchPairCandidates in jev-shadow/index.ts").not.toBeNull();
    const fnBody = fnMatch![0];

    expect(fnBody).toMatch(/articles!inner/);
    expect(fnBody).toMatch(/\.gte\(\s*"article\.published_at"\s*,\s*sinceIso\s*\)/);
    // The dead in-memory skip this test guards against.
    expect(fnBody).not.toMatch(/a\.published_at\s*<\s*sinceIso/);
  });
});
