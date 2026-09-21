// supabase/functions/_shared/cluster/jev-verify.ts
//
// Pure decision logic for the Jev LIVE marginal-verification path (P3,
// migration 064). Imports ONLY from ../jev.ts -- no fetch, no Deno global,
// no supabase-js, zero `console.*`. The HTTP call itself lives in the
// sibling module ../jev-client.ts; cluster-consumer/index.ts is the only
// caller that wires the two together with real I/O.
//
// WHY exactly two bands (see JEV_LIVE_POLICY / classifyBand):
//   - band "low"  = [FALLBACK_FLOOR, MATCH_THRESHOLD)   -- today this
//     score NEVER joins an existing cluster (it is below MATCH_THRESHOLD),
//     so the article always falls through to createCluster. Jev gets one
//     shot to say "no, this really is the same event" (p >= 0.7) and
//     upgrade a would-be new cluster into a join.
//   - band "high" = [MATCH_THRESHOLD, MATCH_THRESHOLD + highBand) -- today
//     this score ALWAYS joins the primary candidate. Jev gets one shot to
//     say "no, these are different events" (p < 0.3) and downgrade a
//     would-be join into a reject, so the ensemble's own fallback chain
//     (the next candidate, or createCluster) decides instead.
//   - every other score ("none") is left alone: Jev is never consulted
//     outside these two narrow bands, and the wide dead zone between 0.7
//     and 0.3 on each band (i.e. any probability that doesn't clear the
//     override bar) resolves to "unchanged" -- the ensemble's original
//     decision stands.
//
// Every failure path -- flag off, no API key, budget exhausted, a
// gateway timeout/error, a malformed response, or a failed prediction
// insert -- is the CALLER's responsibility (cluster-consumer/index.ts) to
// catch and turn into "unchanged". This module never throws for a bad
// score/probability combination; classifyBand/decideMarginal are total
// functions over their inputs. Every threshold this module or its caller
// consults lives in JEV_LIVE_POLICY below -- never inlined at a call site.
import {
  JEV_MODEL,
  JEV_QUESTION_REGISTRY,
  JEV_QUESTION_SET_VERSION,
  clamp,
  type JevRequest,
} from "../jev.ts";

export const JEV_LIVE_POLICY = {
  envFlag: "JEV_LIVE_PAIRS",
  enabledValue: "1",
  timeoutMs: 1500,
  maxCallsPerDrain: 40,
  joinMinProbability: 0.7,
  rejectMaxProbability: 0.3,
  highBandWidth: 0.04,
  maxRetries: 0,
} as const;

export type MarginalBand = "low" | "high" | "none";
export type MarginalDecision = "join" | "reject" | "unchanged";

/**
 * "low"  when floor <= score < threshold
 * "high" when threshold <= score < threshold + highBand
 * "none" otherwise (including score < floor and score >= threshold + highBand)
 */
export function classifyBand(i: {
  score: number;
  floor: number;
  threshold: number;
  highBand: number;
}): MarginalBand {
  if (i.score >= i.floor && i.score < i.threshold) return "low";
  if (i.score >= i.threshold && i.score < i.threshold + i.highBand) return "high";
  return "none";
}

/**
 * band "low"  && probability >= JEV_LIVE_POLICY.joinMinProbability   => "join"
 * band "high" && probability <  JEV_LIVE_POLICY.rejectMaxProbability => "reject"
 * otherwise => "unchanged"
 */
export function decideMarginal(i: {
  score: number;
  floor: number;
  threshold: number;
  highBand: number;
  probability: number;
}): MarginalDecision {
  const band = classifyBand(i);
  if (band === "low" && i.probability >= JEV_LIVE_POLICY.joinMinProbability) return "join";
  if (band === "high" && i.probability < JEV_LIVE_POLICY.rejectMaxProbability) return "reject";
  return "unchanged";
}

/** flag === "1" && a non-empty api key. */
export function liveEnabled(flag: string | undefined, apiKey: string | undefined): boolean {
  return flag === "1" && !!apiKey;
}

/** calls < (max ?? JEV_LIVE_POLICY.maxCallsPerDrain) */
export function budgetAllows(calls: number, max?: number): boolean {
  return calls < (max ?? JEV_LIVE_POLICY.maxCallsPerDrain);
}

/**
 * SEC-064-02: strips characters an attacker-controlled RSS headline could
 * use to structurally manipulate or obscure this module's prompt --
 * headlineA/B/C are fully third-party text (article.title straight off a
 * feed, only HTML-tag-stripped upstream) and now drive a production
 * clustering decision. C0 controls (incl. DEL) and C1 controls, zero-width
 * space/joiners (U+200B-U+200F), explicit bidi overrides (U+202A-U+202E),
 * and bidi isolates (U+2066-U+2069) all fold to a single space; runs of
 * whitespace then collapse to one and the result is trimmed. Pure -- no
 * I/O, no console.
 *
 * This is a defence against STRUCTURAL manipulation (embedded newlines,
 * invisible/obscured text, RTL reordering) only -- it does NOT defeat
 * plain-language prompt injection (a headline that just asks, in Turkish or
 * English, to be joined/split). Every live decision remains auditable via
 * the pair_marginal rows this module's caller writes regardless.
 */
export function sanitizeHeadline(text: string | null | undefined): string {
  if (!text) return "";
  // Explicit \uXXXX escapes only -- never paste literal control/zero-width/
  // bidi characters into source. Ranges: C0 controls, DEL + C1 controls,
  // zero-width space/joiners + LRM/RLM, explicit bidi embeds/overrides,
  // bidi isolates.
  return text
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * state = { pairs: { p1: { a: clamp(headlineA,300), b: clamp(headlineB,300) } } }
 *         plus headline_c: clamp(headlineC,300) ONLY when headlineC is a
 *         non-empty string.
 * Every headline value is run through sanitizeHeadline() before clamp()
 * (SEC-064-02) -- the instructions string and the emptiness gate on
 * headlineC are untouched, only the state VALUES change.
 * questions.p1 reuses the byte-identical pair_negative/pair_marginal
 * wording, substituting {key} -> "p1" so the copied "pairs.{key}" phrasing
 * is literally true of this state shape (planner decision D2).
 */
export function buildMarginalRequest(i: {
  headlineA: string;
  headlineB: string;
  headlineC: string | null;
}): JevRequest {
  const state: Record<string, unknown> = {
    pairs: {
      p1: {
        a: clamp(sanitizeHeadline(i.headlineA), 300),
        b: clamp(sanitizeHeadline(i.headlineB), 300),
      },
    },
  };
  if (typeof i.headlineC === "string" && i.headlineC.length > 0) {
    state.headline_c = clamp(sanitizeHeadline(i.headlineC), 300);
  }
  return {
    state,
    questions: {
      p1: {
        type: "boolean",
        instructions: JEV_QUESTION_REGISTRY.pair_marginal.instructions.replace("{key}", "p1"),
        criteria: { true: "Same concrete event", false: "Different events" },
      },
    },
  };
}

export interface JevLiveRow {
  task: "pair_marginal";
  subject_type: "pair";
  subject_id: string;
  article_id: null;
  cluster_id: null;
  state_hash: string;
  jev_answer: Record<string, unknown>;
  jev_prob: number | null;
  jev_choice: null;
  baseline_answer: "true" | "false";
  agree: boolean;
  latency_ms: number;
  input_tokens: number;
  model: string;
  run_id: null;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * subject_id = `${articleId}:${clusterId}`
 * baseline_answer = band === "high" ? "true" : "false"   (what the ensemble alone would have done)
 * agree = (probability >= 0.5) === (baseline_answer === "true")
 * jev_prob = Math.round(probability * 1000) / 1000
 * jev_answer = { answer: { type:"boolean", probability }, question_set: JEV_QUESTION_SET_VERSION,
 *                live: true, band, ensemble_score: <rounded to 3dp>, decision, state_preview: preview }
 */
export function buildMarginalRow(a: {
  articleId: string;
  clusterId: string;
  band: "low" | "high";
  ensembleScore: number;
  probability: number;
  decision: "joined" | "rejected" | "unchanged";
  stateHash: string;
  preview: string;
  latencyMs: number;
  inputTokens: number;
}): JevLiveRow {
  const baselineAnswer: "true" | "false" = a.band === "high" ? "true" : "false";
  const agree = (a.probability >= 0.5) === (baselineAnswer === "true");
  return {
    task: "pair_marginal",
    subject_type: "pair",
    subject_id: `${a.articleId}:${a.clusterId}`,
    article_id: null,
    cluster_id: null,
    state_hash: a.stateHash,
    jev_answer: {
      answer: { type: "boolean", probability: a.probability },
      question_set: JEV_QUESTION_SET_VERSION,
      live: true,
      band: a.band,
      ensemble_score: round3(a.ensembleScore),
      decision: a.decision,
      state_preview: a.preview,
    },
    jev_prob: round3(a.probability),
    jev_choice: null,
    baseline_answer: baselineAnswer,
    agree,
    latency_ms: a.latencyMs,
    input_tokens: a.inputTokens,
    model: JEV_MODEL,
    run_id: null,
  };
}

export interface JevLiveState {
  enabled: boolean;
  calls: number;
  joined_by_jev: number;
  rejected_by_jev: number;
  errors: number;
  timeouts: number;
  budget_skipped: number;
}

/** All counters 0. */
export function newJevLiveState(enabled: boolean): JevLiveState {
  return {
    enabled,
    calls: 0,
    joined_by_jev: 0,
    rejected_by_jev: 0,
    errors: 0,
    timeouts: 0,
    budget_skipped: 0,
  };
}
