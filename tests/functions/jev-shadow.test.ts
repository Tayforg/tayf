import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  JEV_AUDIT_CANDIDATE_LIMIT,
  JEV_AUDIT_CLUSTER_LIMIT,
  JEV_AUDIT_PAIR_COUNT,
  JEV_AUDIT_PAIRS_PER_CLUSTER,
  JEV_BLINDSPOT_CANDIDATES_PER_CALL,
  JEV_BLINDSPOT_FORWARD_HOURS,
  JEV_CLUSTER_MEMBER_MAX,
  JEV_CONCURRENCY,
  JEV_DESC_CLAMP,
  JEV_MODEL,
  JEV_NEUTRAL_MODEL_ID,
  JEV_PAIRS_PER_CALL,
  JEV_PREVIEW_CLAMP,
  JEV_QUESTION_REGISTRY,
  JEV_QUESTION_SET_VERSION,
  JEV_TASKS,
  JEV_TICKER_LIMIT,
  JEV_TITLE_CLAMP,
  JevDeadlineError,
  JevRateLimitError,
  JevResponseError,
  biasKeysForZones,
  blindspotSilentZones,
  booleanAgrees,
  budgetExceeded,
  buildArticleCall,
  buildBlindspotRecallCall,
  buildBlindspotRecallRows,
  buildBlindspotDayRow,
  buildClusterCall,
  buildKapCall,
  buildPairCall,
  buildTickerCall,
  buildTitleCall,
  canonicalJson,
  choiceAgrees,
  clamp,
  isRateLimitStatus,
  offendingQuestionIds,
  pairKey,
  parseJevResponse,
  pickNeutralArticleId,
  politicsBaseline,
  predictionRow,
  questionRegistryHash,
  rankBlindspotCandidates,
  retryDelayMs,
  runJevShadow,
  sampleClusterPairs,
  samplePairs,
  sharedTokenCount,
  stateHash,
  statePreview,
  tokensToUsd,
  topicBaseline,
  unlinkCandidatesFromRows,
  type JevArticleRow,
  type JevBlindspotCandidate,
  type JevBlindspotCandidateQuery,
  type JevBlindspotClusterRow,
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
  type JevTickerRow,
  type JevTitleRow,
  type JevUnlinkCandidateRow,
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
  return {
    id: "c1",
    title: "Olay",
    updated_at: "2026-09-19T09:00:00.000Z",
    title_tr_neutral: null,
    title_neutral_model: null,
    ...overrides,
  };
}

function tickerRow(overrides: Partial<JevTickerRow> = {}): JevTickerRow {
  return {
    article_id: "art-1",
    ticker: "THYAO",
    title: "Başlık",
    description: "Açıklama",
    company: "Türk Hava Yolları",
    matched_on: "code",
    ...overrides,
  };
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

function blindspotClusterRow(overrides: Partial<JevBlindspotClusterRow> = {}): JevBlindspotClusterRow {
  return {
    id: "bc1",
    title: "Kör nokta olayı",
    blindspot_side: "pro_government",
    first_published: "2026-09-19T08:00:00.000Z",
    updated_at: "2026-09-19T09:00:00.000Z",
    ...overrides,
  };
}

function blindspotCandidateRow(overrides: Partial<JevBlindspotCandidate> = {}): JevBlindspotCandidate {
  return {
    article_id: "bca-1",
    title: "Aday başlık",
    published_at: "2026-09-19T08:30:00.000Z",
    source_slug: "kaynak",
    ...overrides,
  };
}

function clusterMemberPredictionRow(overrides: Partial<JevPredictionRow> = {}): JevPredictionRow {
  return {
    task: "cluster_member",
    subject_type: "cluster",
    subject_id: "c1:a1",
    article_id: "a1",
    cluster_id: "c1",
    state_hash: "h",
    jev_answer: {},
    jev_prob: 0.1,
    jev_choice: null,
    baseline_answer: "true",
    agree: true,
    latency_ms: 1,
    input_tokens: 1,
    model: JEV_MODEL,
    run_id: 1,
    ...overrides,
  };
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
  fetchAuditPairsCalls: Array<{ sinceIso: string; clusterLimit: number }>;
  fetchPendingTickerMatchesCalls: Array<{ sinceIso: string; limit: number }>;
  insertUnlinkCandidatesCalls: JevUnlinkCandidateRow[][];
  fetchBlindspotClustersCalls: Array<{ sinceIso: string; limit: number }>;
  fetchBlindspotCandidatesCalls: JevBlindspotCandidateQuery[];
  markBlindspotCheckedCalls: Array<{ clusterId: string; suspect: boolean }>;
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
    fetchAuditPairsCalls: [],
    fetchPendingTickerMatchesCalls: [],
    insertUnlinkCandidatesCalls: [],
    fetchBlindspotClustersCalls: [],
    fetchBlindspotCandidatesCalls: [],
    markBlindspotCheckedCalls: [],
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
    fetchAuditPairs: async (sinceIso, clusterLimit) => {
      rec.order.push("fetchAuditPairs");
      rec.fetchAuditPairsCalls.push({ sinceIso, clusterLimit });
      return [];
    },
    fetchPendingTickerMatches: async (sinceIso, limit) => {
      rec.order.push("fetchPendingTickerMatches");
      rec.fetchPendingTickerMatchesCalls.push({ sinceIso, limit });
      return [];
    },
    insertUnlinkCandidates: async (rows) => {
      rec.order.push("insertUnlinkCandidates");
      rec.insertUnlinkCandidatesCalls.push([...rows]);
      return rows.length;
    },
    fetchBlindspotClusters: async (sinceIso, limit) => {
      rec.order.push("fetchBlindspotClusters");
      rec.fetchBlindspotClustersCalls.push({ sinceIso, limit });
      return [];
    },
    fetchBlindspotCandidates: async (query) => {
      rec.order.push("fetchBlindspotCandidates");
      rec.fetchBlindspotCandidatesCalls.push({ ...query, biasKeys: [...query.biasKeys] });
      return [];
    },
    markBlindspotChecked: async (clusterId, suspect) => {
      rec.order.push("markBlindspotChecked");
      rec.markBlindspotCheckedCalls.push({ clusterId, suspect });
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

  it("(h) finishRun always runs (try/finally), even when a stage's fetch throws -- the stage is isolated (JEV-B1), the run closes as partial, note stays short", async () => {
    const longMessage = "boom ".repeat(200);
    expect(longMessage.length).toBeGreaterThan(500);
    const rec = makePorts({
      fetchPendingArticles: async () => {
        throw new Error(longMessage);
      },
    });

    const result = await runJevShadow(rec.ports);

    expect(result.status).toBe("partial");
    expect(result.stages.articles.errors).toBe(1);
    expect(rec.finishRunCalls).toHaveLength(1);
    const patch = rec.finishRunCalls[0]?.patch;
    expect(patch?.status).toBe("partial");
    expect(patch?.note).toBe("stage failed: articles");
    expect(patch?.note?.length).toBeLessThanOrEqual(500);
    // The other stages still ran.
    expect(rec.order.filter((name) => name.startsWith("fetch"))).toContain("fetchPendingTitleVersions");
  });

  it("(h3) an error thrown OUTSIDE a stage (monthTokens/startRun happen before; here finishRun itself) still surfaces -- the isolation is per stage, not a blanket swallow", async () => {
    const rec = makePorts({
      finishRun: async () => {
        throw new Error("finishRun failed");
      },
    });
    await expect(runJevShadow(rec.ports)).rejects.toThrow("finishRun failed");
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

  it("(i2) a stage whose fetch throws is isolated (JEV-B1): later stages still run, the run closes as partial naming the stage", async () => {
    const onErrorCalls: Array<{ stage: string; err: unknown }> = [];
    const rec = makePorts({
      fetchPairCandidates: async () => {
        throw new Error("jev-shadow: fetchPairCandidates failed: canceling statement due to statement timeout");
      },
      onError: (stage, err) => {
        onErrorCalls.push({ stage, err });
      },
    });

    const result = await runJevShadow(rec.ports);

    const fetchOrder = rec.order.filter((name) => name.startsWith("fetch"));
    expect(fetchOrder).toContain("fetchPendingKap");
    expect(fetchOrder).toContain("fetchPendingTitleVersions");
    expect(result.status).toBe("partial");
    expect(result.stages.pairs.errors).toBe(1);
    expect(result.errors).toBe(1);
    expect(onErrorCalls.map((c) => c.stage)).toEqual(["pairs"]);
    const patch = rec.finishRunCalls[0]?.patch;
    expect(patch?.status).toBe("partial");
    expect(patch?.note).toContain("pairs");
  });

  it("(i) runs stages in order: articles -> clusters -> blindspot_recall -> pairs -> kap -> title_versions -> tickers (064)", async () => {
    const rec = makePorts();

    await runJevShadow(rec.ports);

    const fetchOrder = rec.order.filter((name) => name.startsWith("fetch"));
    expect(fetchOrder).toEqual([
      "fetchPendingArticles",
      "fetchRecentClusters",
      "fetchBlindspotClusters",
      "fetchPairCandidates",
      "fetchPendingKap",
      "fetchPendingTitleVersions",
      "fetchPendingTickerMatches",
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
      // The clusters stage now also anti-joins "neutral_pick" in the same
      // batched fashion (063). cluster1's title_neutral_model is null (not
      // "extractive-v1"), so it never enters the neutral_pick anti-join's
      // subjectIds -- pin that explicitly rather than letting the second
      // branch go unasserted (JEV-N3).
      fetchSeenSubjects: async (task, subjectIds) => {
        if (task === "cluster_member") {
          expect(subjectIds).toEqual(["c1:m1", "c1:m2"]);
          return new Set(["c1:m1", "c1:m2"]);
        }
        expect(task).toBe("neutral_pick");
        expect(subjectIds).toEqual([]);
        return new Set();
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
// 15. JEV_QUESTION_REGISTRY -- migration 063. The single source of every
// instructions/criteria string; byte-identical for the 12 pre-063 tasks.
//
// DEVIATION FROM W1.md, per pack.md's orchestrator override #1 (overrides
// win over the brief): questionRegistryHash() is ASYNC, computed as
// `sha256Hex(canonicalJson(JEV_QUESTION_REGISTRY))` using the existing
// async sha256Hex from ./archive.ts -- NOT a hand-rolled synchronous
// sha256Sync. There is therefore no sha256Sync export and no NIST-vector
// test for it; the brief's verbatim "sha256Sync matches the NIST vector for
// 'abc'" test is replaced below with a stability/shape check on the async
// questionRegistryHash() the override mandates instead.
// ---------------------------------------------------------------------------

describe("JEV_QUESTION_REGISTRY", () => {
  it("has an entry for every JevTask", () => {
    for (const task of JEV_TASKS) {
      expect(JEV_QUESTION_REGISTRY[task], `missing registry entry for "${task}"`).toBeDefined();
      expect(typeof JEV_QUESTION_REGISTRY[task]?.instructions).toBe("string");
    }
  });

  it("keeps every pre-063 question string byte-identical", () => {
    const article = buildArticleCall(articleRow());
    expect(article.questions.politics).toEqual({
      type: "boolean",
      instructions:
        "Is this Turkish news item about domestic politics, government, parties, elections, parliament, courts/justice with political actors, or foreign policy? Judge the news item in `title` and `description`, not the outlet. Not politics: sports, markets/economy with no political actor, celebrity, weather, crime with no political actor.",
      criteria: {
        true: "Political actors, institutions or processes are the subject of the item",
        false: "No political actor, institution or process is the subject",
      },
    });
    expect(article.questions.topic).toEqual({
      type: "choice",
      instructions: "Which single topic best matches this Turkish news item?",
      criteria: {
        politics: "Government, parliament, parties, elections, courts, law-making, foreign policy",
        economy:
          "Markets, companies, finance, trade, inflation, the budget as an economic (not political-process) matter",
        other: "Anything else: sports, culture, weather, crime, celebrity, technology, health",
      },
    });
    expect(article.questions.opinion).toEqual({
      type: "boolean",
      instructions:
        "Is this an opinion piece, column or analysis expressing the writer's own judgement, rather than a straight news report of events?",
      criteria: { true: "Column/opinion/analysis voice", false: "Straight news report" },
    });
    expect(article.questions.clickbait).toEqual({
      type: "boolean",
      instructions:
        "Does this headline deliberately withhold the key fact to force a click (curiosity gap, unnamed subject, 'işte o isim', 'ne oldu şaşıracaksınız'), rather than stating what happened?",
      criteria: { true: "The headline hides the payload", false: "The headline states what happened" },
    });
    expect(article.questions.framing).toEqual({
      type: "choice",
      instructions:
        "Whose side does the WORDING of this Turkish headline favour? Judge word choice and framing, not which actors appear.",
      criteria: {
        pro_government: "Wording favours government/state actors, or casts their critics unfavourably",
        pro_opposition: "Wording favours opposition actors, or casts the government unfavourably",
        neutral: "Reports the event without favouring either side",
      },
    });
    expect(article.questions.sensational).toEqual({
      type: "score",
      instructions: "How sensational is the wording of this headline?",
      criteria: [
        "Plain, factual wording",
        "Slightly heightened wording",
        "Clearly dramatic wording (şok, skandal, kan donduran)",
        "Extreme tabloid wording",
      ],
    });

    const { request: clusterReq } = buildClusterCall(clusterRow(), [
      memberRow({ article_id: "m1", published_at: "2026-09-19T08:00:00.000Z" }),
      memberRow({ article_id: "m2", published_at: "2026-09-19T08:10:00.000Z" }),
    ]);
    expect(clusterReq.questions.m1).toEqual({
      type: "boolean",
      instructions:
        "Does headline `m1` report the SAME news event as the event named in `event`? Same event means the same incident, announcement or decision — not merely the same topic, the same people, or a follow-up story on a different day.",
      criteria: { true: "Same concrete event", false: "Different event, even if related" },
    });

    const { request: pairReq } = buildPairCall([
      { a: pairCandidateRow({ id: "a1" }), b: pairCandidateRow({ id: "b1", cluster_id: "other" }) },
    ]);
    expect(pairReq.questions.p1).toEqual({
      type: "boolean",
      instructions:
        "Do the two headlines in `pairs.p1` report the SAME news event (same incident, announcement or decision), or merely the same topic / different events?",
      criteria: { true: "Same concrete event", false: "Different events" },
    });

    const kapReq = buildKapCall(kapRow());
    expect(kapReq.questions.kap_class).toEqual({
      type: "choice",
      instructions: "Which KAP disclosure class does this Turkish filing belong to?",
      criteria: {
        ODA: "Özel Durum Açıklaması — a material-event disclosure: contract, investment, litigation, management change, capital action",
        DKB: "Düzenli Kamuyu Bilgilendirme — routine periodic information: buy-back reports, investor presentations, general assembly notices",
        DG: "Diğer — other filings that fit none of the other classes",
        FR: "Finansal Rapor — a financial statement or interim/annual financial report",
      },
    });
    expect(kapReq.questions.kap_materiality).toEqual({
      type: "score",
      instructions: "How likely is this filing to move the company's share price?",
      criteria: [
        "Administrative or routine; no price impact expected",
        "Minor; marginal impact at most",
        "Notable; a plausible single-digit move",
        "Highly material; a large move is likely",
      ],
    });

    const titleReq = buildTitleCall(titleVersionRow());
    expect(titleReq.questions.title_meaning).toEqual({
      type: "boolean",
      instructions:
        "Did the edit from `before` to `after` change the FACTUAL meaning of the headline — a different claim, number, actor, or an added/removed allegation — as opposed to a purely cosmetic edit such as a typo fix, punctuation, shortening or style change?",
      criteria: { true: "The factual claim changed", false: "Cosmetic edit only; the claim is the same" },
    });
    expect(titleReq.questions.title_edit_kind).toEqual({
      type: "choice",
      instructions: "What kind of edit turned `before` into `after`?",
      criteria: {
        correction: "Fixes a factual error in the earlier headline",
        softening: "Makes the claim weaker, vaguer, or less damaging to someone",
        hardening: "Makes the claim stronger, sharper, or more damaging to someone",
        cosmetic: "Typo, punctuation, length or style only — the claim is unchanged",
      },
    });
  });

  it("questionRegistryHash matches sha256Hex(canonicalJson(registry))", async () => {
    const hash = await questionRegistryHash();
    expect(hash).toBe(await sha256Hex(canonicalJson(JEV_QUESTION_REGISTRY)));
  });

  it("questionRegistryHash is a stable sha256 hex digest across calls (override #1: async, no hand-rolled SHA-256)", async () => {
    const h1 = await questionRegistryHash();
    const h2 = await questionRegistryHash();
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pair_positive is a byte-identical copy of pair_negative", () => {
    const pairs = [{ a: pairCandidateRow({ id: "a1" }), b: pairCandidateRow({ id: "b1", cluster_id: "other" }) }];
    const neg = buildPairCall(pairs, "pair_negative").request.questions.p1;
    const pos = buildPairCall(pairs, "pair_positive").request.questions.p1;
    expect(pos).toEqual(neg);
  });
});

// ---------------------------------------------------------------------------
// 16. buildClusterCall with neutral_pick (063)
// ---------------------------------------------------------------------------

describe("buildClusterCall with neutral_pick", () => {
  const threeMembers = [
    memberRow({ article_id: "m-a", published_at: "2026-09-19T08:00:00.000Z", title: "Olay oldu" }),
    memberRow({ article_id: "m-b", published_at: "2026-09-19T08:10:00.000Z", title: "Olay yine oldu" }),
    memberRow({ article_id: "m-c", published_at: "2026-09-19T08:20:00.000Z", title: "Olay üçüncü kez oldu" }),
  ];

  it("adds s<k>/f<k> only when neutralPick is set", () => {
    const withoutNeutral = buildClusterCall(clusterRow(), threeMembers);
    expect(
      Object.keys(withoutNeutral.request.questions).some((k) => k.startsWith("f") || k.startsWith("s")),
    ).toBe(false);
    expect(withoutNeutral.neutralKeys).toEqual({});

    const withNeutral = buildClusterCall(clusterRow(), threeMembers, { neutralPick: true });
    expect(withNeutral.request.questions.f1?.type).toBe("boolean");
    expect(withNeutral.request.questions.s1?.type).toBe("score");
    expect(withNeutral.request.questions.f3?.type).toBe("boolean");
    expect(withNeutral.request.questions.s3?.type).toBe("score");
  });

  it("keeps every member in state.headlines while asking m<k> only for unseen members", () => {
    const skip = new Set(["m-a"]);
    const { request, keys } = buildClusterCall(clusterRow(), threeMembers, { skipMemberIds: skip });
    const state = request.state as { headlines: Record<string, string> };
    expect(Object.keys(state.headlines)).toHaveLength(3);
    expect(keys).not.toHaveProperty("m1");
    expect(keys.m2).toBe("m-b");
    expect(keys.m3).toBe("m-c");
  });

  it("returns neutralKeys covering every member in the call", () => {
    const skip = new Set(["m-a"]);
    const { neutralKeys } = buildClusterCall(clusterRow(), threeMembers, { neutralPick: true, skipMemberIds: skip });
    expect(neutralKeys).toEqual({ m1: "m-a", m2: "m-b", m3: "m-c" });
  });

  it("skips only when both keys and neutralKeys are empty", () => {
    const allSkipped = new Set(threeMembers.map((m) => m.article_id));
    const { keys, neutralKeys } = buildClusterCall(clusterRow(), threeMembers, { skipMemberIds: allSkipped });
    expect(keys).toEqual({});
    expect(neutralKeys).toEqual({});

    const { keys: keys2, neutralKeys: neutralKeys2 } = buildClusterCall(clusterRow(), threeMembers, {
      neutralPick: true,
      skipMemberIds: allSkipped,
    });
    expect(keys2).toEqual({});
    expect(Object.keys(neutralKeys2)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 17. pickNeutralArticleId (063)
// ---------------------------------------------------------------------------

describe("pickNeutralArticleId", () => {
  const neutralKeys = { m1: "art-1", m2: "art-2", m3: "art-3" };
  const order = [
    { key: "m1", published_at: "2026-09-19T08:00:00.000Z" },
    { key: "m2", published_at: "2026-09-19T08:10:00.000Z" },
    { key: "m3", published_at: "2026-09-19T08:20:00.000Z" },
  ];

  it("picks the lowest-score plain headline", () => {
    const answers: Record<string, JevAnswer> = {
      f1: { type: "boolean", probability: 0.9 },
      s1: { type: "score", score: 1 },
      f2: { type: "boolean", probability: 0.95 },
      s2: { type: "score", score: 0.2 },
      f3: { type: "boolean", probability: 0.1 },
      s3: { type: "score", score: 0.05 },
    };
    const { articleId } = pickNeutralArticleId(neutralKeys, order, answers);
    // m3 has the lowest score overall but f3 < threshold (not plain); among
    // the plain headlines (m1, m2) m2 has the lower score.
    expect(articleId).toBe("art-2");
  });

  it("falls back to the lowest score when no headline is plain", () => {
    const answers: Record<string, JevAnswer> = {
      f1: { type: "boolean", probability: 0.1 },
      s1: { type: "score", score: 1 },
      f2: { type: "boolean", probability: 0.2 },
      s2: { type: "score", score: 0.4 },
      f3: { type: "boolean", probability: 0.3 },
      s3: { type: "score", score: 2 },
    };
    const { articleId } = pickNeutralArticleId(neutralKeys, order, answers);
    expect(articleId).toBe("art-2");
  });

  it("breaks a tie by earliest published_at", () => {
    const answers: Record<string, JevAnswer> = {
      f1: { type: "boolean", probability: 0.9 },
      s1: { type: "score", score: 0.5 },
      f2: { type: "boolean", probability: 0.9 },
      s2: { type: "score", score: 0.5 },
      f3: { type: "boolean", probability: 0.1 },
      s3: { type: "score", score: 9 },
    };
    const { articleId } = pickNeutralArticleId(neutralKeys, order, answers);
    expect(articleId).toBe("art-1");
  });

  it("returns null when no score answer came back", () => {
    const { articleId, picks } = pickNeutralArticleId(neutralKeys, order, {});
    expect(articleId).toBeNull();
    expect(picks.m1).toEqual({ s: null, f: null });
  });
});

// ---------------------------------------------------------------------------
// 18. neutral_pick rows -- full runJevShadow integration (063)
// ---------------------------------------------------------------------------

describe("neutral_pick rows", () => {
  function neutralClusterRow(overrides: Partial<JevClusterRow> = {}): JevClusterRow {
    return clusterRow({ title_neutral_model: JEV_NEUTRAL_MODEL_ID, title_tr_neutral: "Olay oldu", ...overrides });
  }

  const twoMembers = [
    memberRow({ article_id: "m-a", published_at: "2026-09-19T08:00:00.000Z", title: "Olay oldu" }),
    memberRow({ article_id: "m-b", published_at: "2026-09-19T08:10:00.000Z", title: "Farklı başlık" }),
  ];

  function neutralEvaluate(): JevPorts["evaluate"] {
    return async (req) => {
      const answers: Record<string, JevAnswer> = {};
      for (const [key, q] of Object.entries(req.questions)) {
        if (key.startsWith("f")) answers[key] = { type: "boolean", probability: 0.9 };
        else if (key.startsWith("s")) answers[key] = { type: "score", score: key === "s1" ? 0.1 : 2 };
        else answers[key] = defaultAnswerFor(q);
      }
      return { response: { answers, usage: { inputTokens: 40, outputTokens: 4 } }, latencyMs: 2 };
    };
  }

  it("baseline is the member whose trimmed title equals title_tr_neutral", async () => {
    const rec = makePorts({
      fetchRecentClusters: async () => [neutralClusterRow()],
      fetchClusterMembers: async () => twoMembers,
      evaluate: neutralEvaluate(),
    });
    await runJevShadow(rec.ports);
    const row = rec.insertPredictionsCalls.flat().find((r) => r.task === "neutral_pick");
    expect(row).toBeDefined();
    expect(row?.baseline_answer).toBe("m-a");
  });

  it("baseline is 'unknown' and agree null when no member title matches", async () => {
    const rec = makePorts({
      fetchRecentClusters: async () => [neutralClusterRow({ title_tr_neutral: "Hiç eşleşmeyen başlık" })],
      fetchClusterMembers: async () => twoMembers,
      evaluate: neutralEvaluate(),
    });
    await runJevShadow(rec.ports);
    const row = rec.insertPredictionsCalls.flat().find((r) => r.task === "neutral_pick");
    expect(row?.baseline_answer).toBe("unknown");
    expect(row?.agree).toBeNull();
  });

  it("baseline is 'unknown' (not a false agree) when the matching title belongs to a member outside the first JEV_CLUSTER_MEMBER_MAX by published_at (regression, 063)", async () => {
    // JEV_CLUSTER_MEMBER_MAX + 2 members, published_at ascending m0..mN. The
    // title matching title_tr_neutral belongs to the member at index
    // JEV_CLUSTER_MEMBER_MAX -- one past the cap orderMembers() applies --
    // so Jev was never shown that headline. The baseline must resolve
    // against the SAME capped/ordered list the call itself used, not the
    // raw uncapped member list, or this silently becomes a hard `false`
    // disagreement instead of an excluded 'unknown'.
    const manyMembers = Array.from({ length: JEV_CLUSTER_MEMBER_MAX + 2 }, (_, i) =>
      memberRow({
        article_id: `m${i}`,
        published_at: `2026-09-19T08:${String(i).padStart(2, "0")}:00.000Z`,
        title: i === JEV_CLUSTER_MEMBER_MAX ? "Olay oldu" : `Diğer başlık ${i}`,
      }),
    );
    const rec = makePorts({
      fetchRecentClusters: async () => [neutralClusterRow()],
      fetchClusterMembers: async () => manyMembers,
      evaluate: neutralEvaluate(),
    });
    await runJevShadow(rec.ports);
    const row = rec.insertPredictionsCalls.flat().find((r) => r.task === "neutral_pick");
    expect(row?.baseline_answer).toBe("unknown");
    expect(row?.agree).toBeNull();
  });

  it("stores the per-member picks in jev_answer.answer.picks", async () => {
    const rec = makePorts({
      fetchRecentClusters: async () => [neutralClusterRow()],
      fetchClusterMembers: async () => twoMembers,
      evaluate: neutralEvaluate(),
    });
    await runJevShadow(rec.ports);
    const row = rec.insertPredictionsCalls.flat().find((r) => r.task === "neutral_pick");
    const answer = row?.jev_answer.answer as {
      type: string;
      choice: string;
      picks: Record<string, { s: number | null; f: number | null }>;
    };
    expect(answer.type).toBe("choice");
    expect(answer.picks.m1).toEqual({ s: 0.1, f: 0.9 });
    expect(answer.picks.m2).toEqual({ s: 2, f: 0.9 });
  });

  it("writes one row per cluster with subject_id = cluster_id", async () => {
    const rec = makePorts({
      fetchRecentClusters: async () => [neutralClusterRow({ id: "cluster-xyz" })],
      fetchClusterMembers: async () => twoMembers.map((m) => ({ ...m, cluster_id: "cluster-xyz" })),
      evaluate: neutralEvaluate(),
    });
    await runJevShadow(rec.ports);
    const rows = rec.insertPredictionsCalls.flat().filter((r) => r.task === "neutral_pick");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject_id).toBe("cluster-xyz");
    expect(rows[0]?.subject_type).toBe("cluster");
  });
});

// ---------------------------------------------------------------------------
// 19. ticker_relevance stage (063)
// ---------------------------------------------------------------------------

describe("buildTickerCall", () => {
  it("builds state {title, description, ticker, company, matched_on} and one boolean question keyed ticker_relevance", () => {
    const req = buildTickerCall(tickerRow());
    expect(req.state).toEqual({
      title: "Başlık",
      description: "Açıklama",
      ticker: "THYAO",
      company: "Türk Hava Yolları",
      matched_on: "code",
    });
    expect(req.questions.ticker_relevance?.type).toBe("boolean");
  });
});

describe("ticker_relevance stage", () => {
  it("runs after kap in shadow mode, fetching JEV_TICKER_LIMIT rows", async () => {
    const rec = makePorts();
    await runJevShadow(rec.ports);
    const fetchOrder = rec.order.filter((name) => name.startsWith("fetch"));
    const kapIdx = fetchOrder.indexOf("fetchPendingKap");
    const tickerIdx = fetchOrder.indexOf("fetchPendingTickerMatches");
    expect(kapIdx).toBeGreaterThanOrEqual(0);
    expect(tickerIdx).toBeGreaterThan(kapIdx);
    expect(rec.fetchPendingTickerMatchesCalls[0]?.limit).toBe(JEV_TICKER_LIMIT);
  });

  it("builds subject_id as `${article_id}:${ticker}` and sets article_id", async () => {
    const rec = makePorts({
      fetchPendingTickerMatches: async () => [tickerRow({ article_id: "art-9", ticker: "GARAN" })],
      evaluate: async (_req) => ({
        response: {
          answers: { ticker_relevance: { type: "boolean", probability: 0.8 } },
          usage: { inputTokens: 10, outputTokens: 1 },
        },
        latencyMs: 1,
      }),
    });
    await runJevShadow(rec.ports);
    const row = rec.insertPredictionsCalls.flat().find((r) => r.task === "ticker_relevance");
    expect(row?.subject_id).toBe("art-9:GARAN");
    expect(row?.article_id).toBe("art-9");
    expect(row?.subject_type).toBe("article");
  });

  it("baseline is 'true' and agree follows the 0.5 threshold", async () => {
    const rec = makePorts({
      fetchPendingTickerMatches: async () => [
        tickerRow({ article_id: "a1", ticker: "T1" }),
        tickerRow({ article_id: "a2", ticker: "T2" }),
      ],
      evaluate: async (req) => {
        const state = req.state as { ticker: string };
        const probability = state.ticker === "T1" ? 0.7 : 0.3;
        return {
          response: {
            answers: { ticker_relevance: { type: "boolean", probability } },
            usage: { inputTokens: 10, outputTokens: 1 },
          },
          latencyMs: 1,
        };
      },
    });
    await runJevShadow(rec.ports);
    const rows = rec.insertPredictionsCalls.flat().filter((r) => r.task === "ticker_relevance");
    const r1 = rows.find((r) => r.subject_id === "a1:T1");
    const r2 = rows.find((r) => r.subject_id === "a2:T2");
    expect(r1).toMatchObject({ baseline_answer: "true", agree: true });
    expect(r2).toMatchObject({ baseline_answer: "true", agree: false });
  });

  it("clamps description and sends ticker/company/matched_on in state", async () => {
    let capturedState: unknown;
    const longDesc = "x".repeat(1000);
    const rec = makePorts({
      fetchPendingTickerMatches: async () => [
        tickerRow({ description: longDesc, company: "ACME", matched_on: "alias:acme" }),
      ],
      evaluate: async (req) => {
        capturedState = req.state;
        return {
          response: {
            answers: { ticker_relevance: { type: "boolean", probability: 0.5 } },
            usage: { inputTokens: 10, outputTokens: 1 },
          },
          latencyMs: 1,
        };
      },
    });
    await runJevShadow(rec.ports);
    const state = capturedState as { description: string; ticker: string; company: string | null; matched_on: string };
    expect(state.description.length).toBeLessThanOrEqual(JEV_DESC_CLAMP);
    expect(state.ticker).toBe("THYAO");
    expect(state.company).toBe("ACME");
    expect(state.matched_on).toBe("alias:acme");
  });
});

// ---------------------------------------------------------------------------
// 20. sampleClusterPairs (063) -- audit mode's recall-side sampler
// ---------------------------------------------------------------------------

describe("sampleClusterPairs", () => {
  function auditCandidate(overrides: Partial<JevPairCandidate> = {}): JevPairCandidate {
    return { id: "x1", cluster_id: "c1", title: "Başlık", published_at: "2026-09-19T08:00:00.000Z", ...overrides };
  }

  it("never pairs two articles from different clusters", () => {
    const rows = [
      auditCandidate({ id: "1", cluster_id: "c1" }),
      auditCandidate({ id: "2", cluster_id: "c1" }),
      auditCandidate({ id: "3", cluster_id: "c1" }),
      auditCandidate({ id: "4", cluster_id: "c2" }),
      auditCandidate({ id: "5", cluster_id: "c2" }),
    ];
    const pairs = sampleClusterPairs(rows, 3, 20, mulberry32(11));
    expect(pairs.length).toBeGreaterThan(0);
    for (const p of pairs) expect(p.a.cluster_id).toBe(p.b.cluster_id);
  });

  it("draws at most JEV_AUDIT_PAIRS_PER_CLUSTER pairs per cluster", () => {
    const rows = Array.from({ length: 10 }, (_, i) => auditCandidate({ id: `m${i}`, cluster_id: "c1" }));
    const pairs = sampleClusterPairs(rows, JEV_AUDIT_PAIRS_PER_CLUSTER, 500, mulberry32(2));
    expect(pairs.length).toBeLessThanOrEqual(JEV_AUDIT_PAIRS_PER_CLUSTER);
  });

  it("stops at the requested count", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => auditCandidate({ id: `a${i}`, cluster_id: "c1" })),
      ...Array.from({ length: 5 }, (_, i) => auditCandidate({ id: `b${i}`, cluster_id: "c2" })),
    ];
    const pairs = sampleClusterPairs(rows, 10, 2, mulberry32(4));
    expect(pairs.length).toBeLessThanOrEqual(2);
  });

  it("returns [] when every cluster has fewer than two members", () => {
    const rows = [auditCandidate({ id: "1", cluster_id: "c1" }), auditCandidate({ id: "2", cluster_id: "c2" })];
    expect(sampleClusterPairs(rows, 3, 10, mulberry32(1))).toEqual([]);
  });

  it("is deterministic under a seeded PRNG", () => {
    const rows = Array.from({ length: 8 }, (_, i) => auditCandidate({ id: `r${i}`, cluster_id: `c${i % 3}` }));
    const p1 = sampleClusterPairs(rows, 3, 20, mulberry32(77));
    const p2 = sampleClusterPairs(rows, 3, 20, mulberry32(77));
    expect(p1.map((p) => pairKey(p.a.id, p.b.id))).toEqual(p2.map((p) => pairKey(p.a.id, p.b.id)));
  });

  it("never emits a self-pair when a cluster has duplicate-id members (M6)", () => {
    const rows = [auditCandidate({ id: "A", cluster_id: "c1" }), auditCandidate({ id: "A", cluster_id: "c1" })];
    expect(sampleClusterPairs(rows, 3, 10, () => 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 21. audit mode (063) -- runJevShadow(ports, { mode: "audit" })
// ---------------------------------------------------------------------------

describe("audit mode", () => {
  it("runs only audit_pairs then pairs, using the audit-sized limits", async () => {
    const rec = makePorts();
    await runJevShadow(rec.ports, { mode: "audit" });
    const fetchOrder = rec.order.filter((name) => name.startsWith("fetch"));
    expect(fetchOrder).toEqual(["fetchAuditPairs", "fetchPairCandidates"]);
    expect(rec.fetchAuditPairsCalls[0]?.clusterLimit).toBe(JEV_AUDIT_CLUSTER_LIMIT);
    expect(rec.fetchPairCandidatesCalls[0]?.limit).toBe(JEV_AUDIT_CANDIDATE_LIMIT);
  });

  it("never fetches articles, kap, title versions or tickers", async () => {
    const rec = makePorts();
    await runJevShadow(rec.ports, { mode: "audit" });
    expect(rec.fetchPendingArticlesCalls).toHaveLength(0);
    expect(rec.fetchRecentClustersCalls).toHaveLength(0);
    expect(rec.fetchClusterMembersCalls).toHaveLength(0);
    expect(rec.fetchPendingKapCalls).toHaveLength(0);
    expect(rec.fetchPendingTitleVersionsCalls).toHaveLength(0);
    expect(rec.fetchPendingTickerMatchesCalls).toHaveLength(0);
  });

  it("writes pair_positive rows with baseline 'true' and subject_id pairKey(a,b)", async () => {
    const rec = makePorts({
      fetchAuditPairs: async () => [
        { id: "a1", cluster_id: "cA", title: "X", published_at: "2026-09-19T08:00:00.000Z" },
        { id: "a2", cluster_id: "cA", title: "Y", published_at: "2026-09-19T08:10:00.000Z" },
      ],
    });
    await runJevShadow(rec.ports, { mode: "audit" });
    const rows = rec.insertPredictionsCalls.flat().filter((r) => r.task === "pair_positive");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      baseline_answer: "true",
      subject_type: "pair",
      subject_id: pairKey("a1", "a2"),
    });
  });

  it("writes pair_negative rows with baseline 'false' in the same run", async () => {
    const rec = makePorts({
      fetchAuditPairs: async () => [
        { id: "a1", cluster_id: "cA", title: "X", published_at: "2026-09-19T08:00:00.000Z" },
        { id: "a2", cluster_id: "cA", title: "Y", published_at: "2026-09-19T08:10:00.000Z" },
      ],
      fetchPairCandidates: async () => [
        pairCandidateRow({ id: "n1", cluster_id: "cB", published_at: "2026-09-19T08:00:00.000Z" }),
        pairCandidateRow({ id: "n2", cluster_id: "cC", published_at: "2026-09-19T08:00:00.000Z" }),
      ],
    });
    const result = await runJevShadow(rec.ports, { mode: "audit" });
    const posRows = rec.insertPredictionsCalls.flat().filter((r) => r.task === "pair_positive");
    const negRows = rec.insertPredictionsCalls.flat().filter((r) => r.task === "pair_negative");
    expect(posRows.length).toBeGreaterThan(0);
    expect(negRows.length).toBeGreaterThan(0);
    expect(negRows[0]).toMatchObject({ baseline_answer: "false" });
    expect(result.stages.audit_pairs.rows).toBeGreaterThan(0);
    expect(result.stages.pairs.rows).toBeGreaterThan(0);
  });

  it("packs JEV_PAIRS_PER_CALL pairs per gateway call", async () => {
    const clusterMembers = Array.from({ length: 25 }, (_, i) => [
      { id: `p${i}-a`, cluster_id: `g${i}`, title: "T", published_at: "2026-09-19T08:00:00.000Z" },
      { id: `p${i}-b`, cluster_id: `g${i}`, title: "T", published_at: "2026-09-19T08:05:00.000Z" },
    ]).flat();
    const rec = makePorts({ fetchAuditPairs: async () => clusterMembers });
    await runJevShadow(rec.ports, { mode: "audit" });
    for (const req of rec.evaluateCalls) {
      const state = req.state as { pairs?: Record<string, unknown> };
      if (state.pairs) {
        expect(Object.keys(state.pairs).length).toBeLessThanOrEqual(JEV_PAIRS_PER_CALL);
      }
    }
  });

  it("never samples more than JEV_AUDIT_PAIR_COUNT pairs in one audit run", async () => {
    const manyClusters = Array.from({ length: JEV_AUDIT_PAIR_COUNT + 50 }, (_, i) => [
      { id: `q${i}-a`, cluster_id: `h${i}`, title: "T", published_at: "2026-09-19T08:00:00.000Z" },
      { id: `q${i}-b`, cluster_id: `h${i}`, title: "T", published_at: "2026-09-19T08:05:00.000Z" },
    ]).flat();
    const rec = makePorts({ fetchAuditPairs: async () => manyClusters });
    await runJevShadow(rec.ports, { mode: "audit" });
    const posRows = rec.insertPredictionsCalls.flat().filter((r) => r.task === "pair_positive");
    expect(posRows.length).toBeLessThanOrEqual(JEV_AUDIT_PAIR_COUNT);
  });

  it("still honours the budget cap and closes the run row", async () => {
    const clusterMembers = [
      { id: "p0-a", cluster_id: "g0", title: "T", published_at: "2026-09-19T08:00:00.000Z" },
      { id: "p0-b", cluster_id: "g0", title: "T", published_at: "2026-09-19T08:05:00.000Z" },
      { id: "p1-a", cluster_id: "g1", title: "T", published_at: "2026-09-19T08:00:00.000Z" },
      { id: "p1-b", cluster_id: "g1", title: "T", published_at: "2026-09-19T08:05:00.000Z" },
    ];
    const rec = makePorts({
      fetchAuditPairs: async () => clusterMembers,
      evaluate: async (req) => ({
        response: { answers: validResponseFor(req).answers, usage: { inputTokens: 60, outputTokens: 5 } },
        latencyMs: 1,
      }),
    });
    const result = await runJevShadow(rec.ports, { mode: "audit", cap: 50 });
    expect(result.status).toBe("budget_exceeded");
    expect(rec.finishRunCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Migration 064 -- "Jev canlı küme": outlier-ejection queue (P5) and the
// blindspot recall check (P4). Both are additive shadow-side mechanisms;
// P4/P5 write nothing a reader ever sees. P3 (live marginal verification)
// lives entirely in W2's supabase/functions/_shared/cluster/jev-verify.ts
// and supabase/functions/cluster-consumer/index.ts -- out of scope here.
// ---------------------------------------------------------------------------

describe("JEV_QUESTION_REGISTRY (064)", () => {
  it("keeps every pre-064 question string byte-identical", () => {
    expect(JEV_TASKS).toEqual([
      "politics",
      "topic",
      "opinion",
      "clickbait",
      "framing",
      "sensational",
      "cluster_member",
      "pair_negative",
      "pair_positive",
      "ticker_relevance",
      "neutral_pick",
      "kap_class",
      "kap_materiality",
      "title_meaning",
      "title_edit_kind",
      "pair_marginal",
      "blindspot_recall",
    ]);

    expect(JEV_QUESTION_REGISTRY.pair_marginal).toEqual({
      instructions:
        "Do the two headlines in `pairs.{key}` report the SAME news event (same incident, announcement or decision), or merely the same topic / different events?",
      criteria: { true: "Same concrete event", false: "Different events" },
    });
    expect(JEV_QUESTION_REGISTRY.pair_marginal).toEqual(JEV_QUESTION_REGISTRY.pair_negative);

    expect(JEV_QUESTION_REGISTRY.blindspot_recall).toEqual({
      instructions:
        "Does headline `{key}` report the SAME news event as the event named in `event`? Same event means the same incident, announcement or decision — not merely the same topic, the same people, or a follow-up story on a different day.",
      criteria: { true: "Same concrete event", false: "Different event, even if related" },
    });
    expect(JEV_QUESTION_REGISTRY.blindspot_recall).toEqual(JEV_QUESTION_REGISTRY.cluster_member);
  });
});

describe("blindspotSilentZones / biasKeysForZones", () => {
  it("blindspotSilentZones returns the two zones that are NOT the dominant side's zone", () => {
    expect(blindspotSilentZones("pro_government")).toEqual(["bagimsiz", "muhalefet"]);
    expect(blindspotSilentZones("gov_leaning")).toEqual(["bagimsiz", "muhalefet"]);
    expect(blindspotSilentZones("opposition")).toEqual(["iktidar", "bagimsiz"]);
    expect(blindspotSilentZones("center")).toEqual(["iktidar", "muhalefet"]);
    expect(blindspotSilentZones("pro_kurdish")).toEqual(["iktidar", "muhalefet"]);
  });

  it("[A6 / SEC-064-04] fails closed (returns []) for null or any side outside BIAS_KEYS, instead of every zone", () => {
    expect(blindspotSilentZones(null)).toEqual([]);
    expect(blindspotSilentZones("")).toEqual([]);
    expect(blindspotSilentZones("not_a_bias_key")).toEqual([]);
    expect(blindspotSilentZones("pg_catalog")).toEqual([]);
  });

  it("biasKeysForZones returns BIAS_KEYS-ordered keys for the given zones", () => {
    expect(biasKeysForZones(["bagimsiz"])).toEqual(["center", "pro_kurdish", "international"]);
    expect(biasKeysForZones(["iktidar", "muhalefet"])).toEqual([
      "pro_government",
      "gov_leaning",
      "state_media",
      "opposition_leaning",
      "opposition",
      "nationalist",
      "islamist_conservative",
    ]);
  });
});

describe("sharedTokenCount", () => {
  it("counts shared 4+ char Turkish-folded/stemmed tokens between two titles", () => {
    expect(sharedTokenCount("ankara meclis kanun teklifi", "ankara meclis kanun teklifi onaylandi")).toBe(4);
    expect(sharedTokenCount("ankara meclis kanun teklifi", "ankara meclis toplantisi yapildi")).toBe(2);
    expect(sharedTokenCount("ankara meclis kanun teklifi", "istanbul spor kulubu maci")).toBe(0);
  });
});

describe("blindspot_recall: rankBlindspotCandidates", () => {
  it("keeps only >=2 shared 4+ char Turkish-folded tokens, top 15, published_at desc tiebreak", () => {
    const eventTitle = "ankara meclis kanun teklifi";
    const high = blindspotCandidateRow({
      article_id: "high",
      title: "ankara meclis kanun teklifi onaylandi",
      published_at: "2026-09-19T08:00:00.000Z",
    });
    const midLate = blindspotCandidateRow({
      article_id: "mid-late",
      title: "ankara meclis komisyonu toplandi",
      published_at: "2026-09-19T09:00:00.000Z",
    });
    const midEarly = blindspotCandidateRow({
      article_id: "mid-early",
      title: "ankara meclis toplantisi yapildi",
      published_at: "2026-09-19T07:00:00.000Z",
    });
    const low = blindspotCandidateRow({
      article_id: "low",
      title: "ankara valiligi aciklama yapti",
      published_at: "2026-09-19T10:00:00.000Z",
    });
    const zero = blindspotCandidateRow({
      article_id: "zero",
      title: "istanbul spor kulubu maci",
      published_at: "2026-09-19T11:00:00.000Z",
    });

    const ranked = rankBlindspotCandidates(eventTitle, [low, zero, midEarly, high, midLate]);
    // low (shared=1) and zero (shared=0) are dropped -- only >=2-shared survive.
    // high (shared=4) beats the two shared=2 candidates; midLate beats
    // midEarly on the published_at-desc tiebreak.
    expect(ranked.map((c) => c.article_id)).toEqual(["high", "mid-late", "mid-early"]);

    const many = Array.from({ length: 20 }, (_, i) =>
      blindspotCandidateRow({
        article_id: `many-${String(i).padStart(2, "0")}`,
        title: eventTitle,
        published_at: `2026-09-19T08:${String(i).padStart(2, "0")}:00.000Z`,
      }),
    );
    const rankedMany = rankBlindspotCandidates(eventTitle, many);
    expect(rankedMany).toHaveLength(JEV_BLINDSPOT_CANDIDATES_PER_CALL);
    expect(rankedMany[0]?.article_id).toBe("many-19");
    expect(rankedMany[14]?.article_id).toBe("many-05");
    for (let i = 1; i < rankedMany.length; i++) {
      expect(rankedMany[i]!.published_at <= rankedMany[i - 1]!.published_at).toBe(true);
    }
  });
});

describe("blindspot_recall: buildBlindspotRecallCall", () => {
  it("keys c1..cN and copies the cluster_member wording byte-for-byte", () => {
    const cluster = blindspotClusterRow({ title: "Ana olay" });
    const candidates = [
      blindspotCandidateRow({ article_id: "art-1", title: "Aday 1" }),
      blindspotCandidateRow({ article_id: "art-2", title: "Aday 2" }),
    ];
    const { request, keys } = buildBlindspotRecallCall(cluster, candidates);

    expect(keys).toEqual({ c1: "art-1", c2: "art-2" });
    expect(request.state).toEqual({
      event: "Ana olay",
      headlines: { c1: "Aday 1", c2: "Aday 2" },
    });
    expect(request.questions.c1).toEqual({
      type: "boolean",
      instructions:
        "Does headline `c1` report the SAME news event as the event named in `event`? Same event means the same incident, announcement or decision — not merely the same topic, the same people, or a follow-up story on a different day.",
      criteria: { true: "Same concrete event", false: "Different event, even if related" },
    });
    expect(request.questions.c2?.instructions).toContain("headline `c2`");
  });

  it("returns the empty request/keys shape when there are no candidates", () => {
    const { request, keys } = buildBlindspotRecallCall(blindspotClusterRow(), []);
    expect(request).toEqual({ state: {}, questions: {} });
    expect(keys).toEqual({});
  });
});

describe("blindspot_recall: buildBlindspotRecallRows", () => {
  it("rows use baseline 'false' so agree is true exactly when p < 0.5", () => {
    const cluster = blindspotClusterRow({ id: "clx" });
    const keys = { c1: "art-low", c2: "art-high" };
    const response: JevResponse = {
      answers: {
        c1: { type: "boolean", probability: 0.2 },
        c2: { type: "boolean", probability: 0.8 },
      },
      usage: { inputTokens: 10, outputTokens: 1 },
    };

    const rows = buildBlindspotRecallRows(1, cluster, keys, response, "call-1", "hash-1", "preview-1", 5);

    expect(rows).toHaveLength(2);
    const low = rows.find((r) => r.subject_id === "clx:art-low");
    const high = rows.find((r) => r.subject_id === "clx:art-high");
    expect(low).toMatchObject({
      task: "blindspot_recall",
      subject_type: "cluster",
      article_id: "art-low",
      cluster_id: "clx",
      baseline_answer: "false",
      agree: true,
      jev_prob: 0.2,
    });
    expect(high).toMatchObject({
      task: "blindspot_recall",
      subject_type: "cluster",
      article_id: "art-high",
      cluster_id: "clx",
      baseline_answer: "false",
      agree: false,
      jev_prob: 0.8,
    });
  });
});

describe("blindspot_recall: buildBlindspotDayRow", () => {
  it("builds a marker row with no real Jev answer", () => {
    const row = buildBlindspotDayRow({
      runId: 7,
      clusterId: "clx",
      day: "2026-09-19",
      candidates: 3,
      stateHash: "hash-1",
      preview: "preview-1",
    });
    expect(row).toMatchObject({
      task: "blindspot_recall",
      subject_type: "cluster",
      subject_id: "clx:2026-09-19",
      article_id: null,
      cluster_id: "clx",
      jev_prob: null,
      jev_choice: null,
      baseline_answer: "false",
      agree: null,
      latency_ms: 0,
      input_tokens: 0,
      run_id: 7,
    });
    expect(row.jev_answer).toEqual({ candidates: 3, question_set: JEV_QUESTION_SET_VERSION, day: "2026-09-19" });
  });
});

describe("blindspot_recall stage", () => {
  it("blindspot_recall: writes the <cluster>:<day> marker row even when a cluster has zero candidates", async () => {
    const cluster = blindspotClusterRow({
      id: "bc-zero",
      blindspot_side: "pro_government",
      first_published: "2026-09-19T08:00:00.000Z",
    });
    const rec = makePorts({
      fetchBlindspotClusters: async () => [cluster],
      fetchBlindspotCandidates: async () => [],
    });

    await runJevShadow(rec.ports, { nowIso: "2026-09-19T10:00:00.000Z" });

    const allRows = rec.insertPredictionsCalls.flat();
    const dayRow = allRows.find((r) => r.task === "blindspot_recall" && r.subject_id === "bc-zero:2026-09-19");
    expect(dayRow).toBeDefined();
    expect(dayRow).toMatchObject({
      subject_type: "cluster",
      article_id: null,
      cluster_id: "bc-zero",
      jev_prob: null,
      jev_choice: null,
      baseline_answer: "false",
      agree: null,
      latency_ms: 0,
      input_tokens: 0,
    });
    expect(dayRow?.jev_answer).toMatchObject({ candidates: 0, day: "2026-09-19" });
    expect(rec.markBlindspotCheckedCalls).toEqual([{ clusterId: "bc-zero", suspect: false }]);
    expect(rec.evaluateCalls).toHaveLength(0);
  });

  it("blindspot_recall: marks the cluster suspect only when some candidate reaches 0.7", async () => {
    const highCluster = blindspotClusterRow({
      id: "bc-high",
      title: "ankara meclis kanun teklifi",
      blindspot_side: "pro_government",
      first_published: "2026-09-19T08:00:00.000Z",
    });
    const lowCluster = blindspotClusterRow({
      id: "bc-low",
      title: "ankara meclis butce teklifi",
      blindspot_side: "pro_government",
      first_published: "2026-09-19T08:00:00.000Z",
    });
    const candidate = blindspotCandidateRow({
      article_id: "cand-1",
      title: "ankara meclis kanun butce teklifi onaylandi",
    });

    const rec = makePorts({
      fetchBlindspotClusters: async () => [highCluster, lowCluster],
      fetchBlindspotCandidates: async () => [candidate],
      evaluate: async (req) => {
        const state = req.state as { event?: string };
        const probability = state.event === highCluster.title ? 0.75 : 0.5;
        const key = Object.keys(req.questions)[0]!;
        return {
          response: { answers: { [key]: { type: "boolean", probability } }, usage: { inputTokens: 5, outputTokens: 1 } },
          latencyMs: 1,
        };
      },
    });

    await runJevShadow(rec.ports, { nowIso: "2026-09-19T10:00:00.000Z" });

    expect(rec.markBlindspotCheckedCalls).toContainEqual({ clusterId: "bc-high", suspect: true });
    expect(rec.markBlindspotCheckedCalls).toContainEqual({ clusterId: "bc-low", suspect: false });
  });

  it("blindspot_recall: skips clusters whose <cluster>:<day> marker already exists (anti-join)", async () => {
    const cluster = blindspotClusterRow({ id: "bc-seen" });
    const rec = makePorts({
      fetchBlindspotClusters: async () => [cluster],
      fetchSeenSubjects: async (task, subjectIds) => {
        expect(task).toBe("blindspot_recall");
        expect(subjectIds).toEqual(["bc-seen:2026-09-19"]);
        return new Set(["bc-seen:2026-09-19"]);
      },
    });

    const result = await runJevShadow(rec.ports, { nowIso: "2026-09-19T10:00:00.000Z" });

    expect(rec.fetchBlindspotCandidatesCalls).toHaveLength(0);
    expect(rec.evaluateCalls).toHaveLength(0);
    expect(result.stages.blindspot_recall.skipped).toBe(1);
  });

  it("blindspot_recall: a gateway failure writes no marker row, so the next run retries the cluster", async () => {
    const cluster = blindspotClusterRow({
      id: "bc-fail",
      title: "ankara meclis kanun teklifi",
      blindspot_side: "pro_government",
      first_published: "2026-09-19T08:00:00.000Z",
    });
    const candidate = blindspotCandidateRow({
      article_id: "cand-1",
      title: "ankara meclis kanun teklifi onaylandi",
    });
    const rec = makePorts({
      fetchBlindspotClusters: async () => [cluster],
      fetchBlindspotCandidates: async () => [candidate],
      evaluate: async () => {
        throw new Error("gateway-error");
      },
    });

    const result = await runJevShadow(rec.ports, { nowIso: "2026-09-19T10:00:00.000Z" });

    const allRows = rec.insertPredictionsCalls.flat();
    expect(allRows.filter((r) => r.task === "blindspot_recall")).toHaveLength(0);
    expect(rec.markBlindspotCheckedCalls).toHaveLength(0);
    expect(result.stages.blindspot_recall.errors).toBe(1);
  });

  it("blindspot_recall: bounds the candidate fetch window to first_published + JEV_BLINDSPOT_FORWARD_HOURS, not nowMs (A-ADV-01)", async () => {
    const cluster = blindspotClusterRow({
      id: "bc-window",
      first_published: "2026-09-19T08:00:00.000Z",
    });
    // No fetchBlindspotCandidates override here on purpose: overriding it
    // would replace makePorts' own recording wrapper (which pushes into
    // rec.fetchBlindspotCandidatesCalls) and this test's only interest is
    // the query bounds that wrapper records; the base mock already returns
    // an empty candidate list.
    const rec = makePorts({
      fetchBlindspotClusters: async () => [cluster],
    });

    // nowMs is far past the event -- under the old code this leaked
    // straight into toIso, so the candidate window trailed `now`
    // unboundedly instead of staying anchored to the event.
    await runJevShadow(rec.ports, { nowIso: "2026-09-21T13:15:32.000Z" });

    expect(rec.fetchBlindspotCandidatesCalls).toHaveLength(1);
    const expectedToIso = new Date(
      Date.parse(cluster.first_published) + JEV_BLINDSPOT_FORWARD_HOURS * 3600e3,
    ).toISOString();
    expect(rec.fetchBlindspotCandidatesCalls[0]!.toIso).toBe(expectedToIso);
    expect(rec.fetchBlindspotCandidatesCalls[0]!.toIso).not.toBe(new Date("2026-09-21T13:15:32.000Z").toISOString());
  });

  it("blindspot_recall: a candidate published near first_published (the old end of the window) survives ranking into the Jev call (A-ADV-01)", async () => {
    const cluster = blindspotClusterRow({
      id: "bc-survive",
      title: "ankara meclis kanun teklifi onaylandi",
      blindspot_side: "pro_government",
      first_published: "2026-09-19T08:00:00.000Z",
    });
    // Candidates spanning the full [fromIso, toIso] window: the oldest one
    // (right at first_published) is the one a naive "keep only the newest
    // N" truncation would have dropped first. All share >=2 tokens with the
    // cluster title so every one clears rankBlindspotCandidates' relevance
    // filter, and there are fewer than JEV_BLINDSPOT_CANDIDATES_PER_CALL of
    // them so none are cut by the per-call cap either -- the only thing
    // under test is whether the stage forwards the old candidate at all.
    const oldCandidate = blindspotCandidateRow({
      article_id: "old-near-event",
      title: "ankara meclis kanun teklifi",
      published_at: "2026-09-19T08:05:00.000Z",
    });
    const newCandidate = blindspotCandidateRow({
      article_id: "new-recent",
      title: "ankara meclis kanun teklifi yorumlandi",
      published_at: "2026-09-19T19:00:00.000Z",
    });
    const rec = makePorts({
      fetchBlindspotClusters: async () => [cluster],
      fetchBlindspotCandidates: async () => [newCandidate, oldCandidate],
    });

    await runJevShadow(rec.ports, { nowIso: "2026-09-21T13:15:32.000Z" });

    const allRows = rec.insertPredictionsCalls.flat();
    const oldRow = allRows.find(
      (r) => r.task === "blindspot_recall" && r.subject_id === "bc-survive:old-near-event",
    );
    expect(oldRow).toBeDefined();
  });

  it("blindspot_recall: audit mode never touches the four new ports", async () => {
    const rec = makePorts();

    await runJevShadow(rec.ports, { mode: "audit" });

    expect(rec.fetchBlindspotClustersCalls).toHaveLength(0);
    expect(rec.fetchBlindspotCandidatesCalls).toHaveLength(0);
    expect(rec.markBlindspotCheckedCalls).toHaveLength(0);
    expect(rec.insertUnlinkCandidatesCalls).toHaveLength(0);
  });
});

describe("unlinkCandidatesFromRows", () => {
  it("emits one candidate per cluster_member row under 0.35 and nothing at 0.35", () => {
    const rows: JevPredictionRow[] = [
      clusterMemberPredictionRow({ jev_prob: 0.1, cluster_id: "c1", article_id: "a1", subject_id: "c1:a1" }),
      clusterMemberPredictionRow({ jev_prob: 0.35, cluster_id: "c1", article_id: "a2", subject_id: "c1:a2" }),
      clusterMemberPredictionRow({ jev_prob: 0.34999, cluster_id: "c1", article_id: "a3", subject_id: "c1:a3" }),
      clusterMemberPredictionRow({
        task: "pair_negative",
        jev_prob: 0.1,
        cluster_id: null,
        article_id: null,
        subject_id: "a4:a5",
      }),
      clusterMemberPredictionRow({ jev_prob: null, cluster_id: "c1", article_id: "a6", subject_id: "c1:a6" }),
    ];

    expect(unlinkCandidatesFromRows(rows)).toEqual([
      { cluster_id: "c1", article_id: "a1", jev_prob: 0.1, source_task: "cluster_member" },
      { cluster_id: "c1", article_id: "a3", jev_prob: 0.34999, source_task: "cluster_member" },
    ]);
  });
});

describe("clusters stage: outlier-ejection queue emission (064)", () => {
  it("insertUnlinkCandidates failure is swallowed: the clusters stage still inserts its prediction rows", async () => {
    const cluster = clusterRow({ id: "c1", title: "Olay" });
    const members = [
      memberRow({ cluster_id: "c1", article_id: "m1", published_at: "2026-09-19T08:00:00.000Z" }),
      memberRow({ cluster_id: "c1", article_id: "m2", published_at: "2026-09-19T08:10:00.000Z" }),
    ];
    const rec = makePorts({
      fetchRecentClusters: async () => [cluster],
      fetchClusterMembers: async () => members,
      evaluate: async () => ({
        response: {
          answers: { m1: { type: "boolean", probability: 0.1 }, m2: { type: "boolean", probability: 0.9 } },
          usage: { inputTokens: 10, outputTokens: 1 },
        },
        latencyMs: 1,
      }),
      insertUnlinkCandidates: async () => {
        throw new Error("db down");
      },
    });

    const result = await runJevShadow(rec.ports);

    const allRows = rec.insertPredictionsCalls.flat();
    const clusterRows = allRows.filter((r) => r.task === "cluster_member");
    expect(clusterRows).toHaveLength(2);
    expect(result.errors).toBeGreaterThan(0);
  });

  it("queues exactly the sub-0.35 cluster_member rows via insertUnlinkCandidates, and nothing when every row clears the bar", async () => {
    const cluster = clusterRow({ id: "c1", title: "Olay" });
    const members = [
      memberRow({ cluster_id: "c1", article_id: "m1", published_at: "2026-09-19T08:00:00.000Z" }),
      memberRow({ cluster_id: "c1", article_id: "m2", published_at: "2026-09-19T08:10:00.000Z" }),
    ];
    const rec = makePorts({
      fetchRecentClusters: async () => [cluster],
      fetchClusterMembers: async () => members,
      evaluate: async () => ({
        response: {
          answers: { m1: { type: "boolean", probability: 0.1 }, m2: { type: "boolean", probability: 0.95 } },
          usage: { inputTokens: 10, outputTokens: 1 },
        },
        latencyMs: 1,
      }),
    });

    await runJevShadow(rec.ports);

    expect(rec.insertUnlinkCandidatesCalls).toEqual([
      [{ cluster_id: "c1", article_id: "m1", jev_prob: 0.1, source_task: "cluster_member" }],
    ]);
  });

  it("never calls insertUnlinkCandidates when no cluster_member row falls below the threshold", async () => {
    const cluster = clusterRow({ id: "c1", title: "Olay" });
    const members = [
      memberRow({ cluster_id: "c1", article_id: "m1", published_at: "2026-09-19T08:00:00.000Z" }),
      memberRow({ cluster_id: "c1", article_id: "m2", published_at: "2026-09-19T08:10:00.000Z" }),
    ];
    const rec = makePorts({
      fetchRecentClusters: async () => [cluster],
      fetchClusterMembers: async () => members,
      evaluate: async () => ({
        response: {
          answers: { m1: { type: "boolean", probability: 0.9 }, m2: { type: "boolean", probability: 0.95 } },
          usage: { inputTokens: 10, outputTokens: 1 },
        },
        latencyMs: 1,
      }),
    });

    await runJevShadow(rec.ports);

    expect(rec.insertUnlinkCandidatesCalls).toHaveLength(0);
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

    // Articles-side query (indexed published_at) with the cluster join as an
    // inner embed -- the cluster_articles-side mirror image timed out at 8s
    // on the first production run (JEV-B2).
    expect(fnBody).toMatch(/\.from\(\s*"articles"\s*\)/);
    expect(fnBody).toMatch(/cluster_articles!inner/);
    expect(fnBody).toMatch(/\.gte\(\s*"published_at"\s*,\s*sinceIso\s*\)/);
    expect(fnBody).not.toMatch(/\.from\(\s*"cluster_articles"\s*\)/);
    // The dead in-memory skip this test guards against.
    expect(fnBody).not.toMatch(/a\.published_at\s*<\s*sinceIso/);
  });
});

describe("jev-shadow/index.ts markBlindspotChecked patch shape (DB-06 / SEC-064-03)", () => {
  it("writes blindspot_recall_suspect unconditionally, including false on a negative re-check", () => {
    const indexTs = readFileSync(
      resolve(__dirname, "..", "..", "supabase", "functions", "jev-shadow", "index.ts"),
      "utf8",
    );
    const fnMatch = indexTs.match(/async markBlindspotChecked[\s\S]*?\n    \},\n/);
    expect(fnMatch, "could not find markBlindspotChecked in jev-shadow/index.ts").not.toBeNull();
    const fnBody = fnMatch![0];

    // The fix: one unconditional patch object, suspect written every time.
    expect(fnBody).toMatch(/blindspot_recall_suspect:\s*suspect\s*,/);
    expect(fnBody).toMatch(/blindspot_recall_checked_at:\s*new Date\(\)\.toISOString\(\)/);
    // Guard against reintroducing the DB-06 latch: no ternary that only
    // sets blindspot_recall_suspect on the truthy branch.
    expect(fnBody).not.toMatch(/suspect\s*\?\s*\{\s*blindspot_recall_suspect:\s*true/);
  });
});

// A-ADV-03 static guard: fetchBlindspotCandidates' silent-zone source lookup
// must be restricted to VOTING_SOURCE_KINDS (outlet, wire) -- is_blindspot
// and the 064 RPC's own recompute only ever count voting-kind sources, so an
// unfiltered `.in("bias", ...)` lets a non-voting source (aggregator/niche)
// raise a blindspot_recall_suspect flag for a verdict it never contributed
// to. The filter must come from _shared/cluster/source-kind.ts, not a
// hand-copied literal list (a fourth copy of the kind list this repo has
// already had to keep in sync three times over).
describe("jev-shadow/index.ts fetchBlindspotCandidates sources query shape (A-ADV-03)", () => {
  it("restricts the silent-zone sources lookup to VOTING_SOURCE_KINDS", () => {
    const indexTs = readFileSync(
      resolve(__dirname, "..", "..", "supabase", "functions", "jev-shadow", "index.ts"),
      "utf8",
    );

    expect(indexTs).toMatch(
      /import \{ VOTING_SOURCE_KINDS \} from "\.\.\/_shared\/cluster\/source-kind\.ts";/,
    );

    const fnMatch = indexTs.match(/async fetchBlindspotCandidates[\s\S]*?\n    \},\n/);
    expect(fnMatch, "could not find fetchBlindspotCandidates in jev-shadow/index.ts").not.toBeNull();
    const fnBody = fnMatch![0];

    expect(fnBody).toMatch(/\.from\(\s*"sources"\s*\)/);
    expect(fnBody).toMatch(/\.in\(\s*"bias"\s*,\s*query\.biasKeys as string\[\]\s*\)/);
    expect(fnBody).toMatch(
      /\.in\(\s*"kind"\s*,\s*VOTING_SOURCE_KINDS as unknown as string\[\]\s*\)/,
    );
  });
});
