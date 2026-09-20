// supabase/functions/_shared/jev.ts
//
// TypeSafe Jev SHADOW MODE (migration 061): the pure, runtime-agnostic half
// of the jev-shadow Edge Function, exactly the role _shared/archive.ts plays
// for archive-export. Everything here runs unchanged under the Deno runtime
// (jev-shadow/index.ts) and under vitest on Node 24
// (tests/functions/jev-shadow.test.ts) -- no Deno global APIs, no
// supabase-js import, no `fetch` call. jev-shadow/index.ts wires a raw-fetch gateway
// client and a Supabase service-role client into the `JevPorts` interface at
// the bottom, so the shadow algorithm (stage order, concurrency, budget
// guard, baseline/agree rules, row shape) is testable with plain in-memory
// fakes -- the ArchivePorts seam, verbatim discipline.
//
// What this asks, per run: 12 typed questions across five subject types
// (article, cluster, pair, KAP disclosure, title version), one gateway call
// per subject (except pairs, which pack up to 10 per call). Every prediction
// is stored alongside the CURRENT system's answer (the "baseline") so
// agreement can be measured without ever feeding a reader-facing byte.

import { sha256Hex } from "./archive.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const JEV_MODEL = "typesafe-ai/jev";
export const JEV_ENDPOINT = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";
export const JEV_PROTOCOL_VERSION = "0.0.1";
export const JEV_SPEC_VERSION = "4";
export const JEV_DEADLINE_MS = 50_000; // same budget as ARCHIVE_DEADLINE_MS
export const JEV_CONCURRENCY = 8;
export const JEV_ARTICLE_LIMIT = 150;
export const JEV_CLUSTER_LIMIT = 40;
export const JEV_CLUSTER_MEMBER_MAX = 12;
export const JEV_PAIR_COUNT = 20;
export const JEV_PAIRS_PER_CALL = 10;
export const JEV_KAP_LIMIT = 30;
export const JEV_TITLE_LIMIT = 30;
export const JEV_MONTHLY_TOKEN_CAP_DEFAULT = 300_000_000;
export const JEV_USD_PER_TOKEN = 42 / 1_000_000_000;
export const JEV_BOOLEAN_THRESHOLD = 0.5;
export const JEV_TITLE_CLAMP = 300; // chars of title sent
export const JEV_DESC_CLAMP = 600; // chars of description sent
export const JEV_PREVIEW_CLAMP = 240; // chars stored in state_preview
/** Stamped into every jev_answer as `question_set`. The 2026-09-20 limits
 * test showed instruction paraphrases flip ~30% of borderline titles, so a
 * prediction is only comparable to others made with the SAME question text.
 * Bump this whenever any instructions/criteria string in the builders below
 * changes, so analyses can group by question set. */
export const JEV_QUESTION_SET_VERSION = "2026-09-20.1";
// JEV-A11 stopgap: evaluateWithRetries (index.ts) is not deadline-aware --
// each attempt is a fresh AbortSignal.timeout(20_000) plus a retryDelayMs
// ladder, so 5 attempts at JEV_MAX_RETRIES=4 had a ~107s worst case for a
// single subject against JEV_DEADLINE_MS=50_000 and the cron's 60s
// timeout_milliseconds (061_jev_shadow.sql). Lowered to 2 (3 attempts,
// ~61.5s worst case) as the one-line stopgap the finding explicitly
// authorizes; a full fix would thread a deadlineAt through JevPorts.evaluate
// so a single call's AbortSignal.timeout is bounded by the run's remaining
// budget, not a fixed 20s.
export const JEV_MAX_RETRIES = 2;
/** MUST match POLITICS_CATEGORIES at cluster-consumer/index.ts:93. Parity-tested
 * in tests/migrations/jev-shadow-parity.test.ts. CONSTANT DRIFT: this is a
 * deliberate duplicate (importing the real one would drag that Edge
 * Function's own serve entrypoint into vitest) -- the parity test cannot
 * detect that cluster-consumer changed its own list independently. */
export const JEV_POLITICS_CATEGORIES = ["politika", "son_dakika"] as const;
export const JEV_TASKS = [
  "politics",
  "topic",
  "opinion",
  "clickbait",
  "framing",
  "sensational",
  "cluster_member",
  "pair_negative",
  "kap_class",
  "kap_materiality",
  "title_meaning",
  "title_edit_kind",
] as const;
export type JevTask = (typeof JEV_TASKS)[number];
export type JevSubjectType = "article" | "pair" | "cluster" | "kap" | "title_version";
export type JevRunStatus = "running" | "ok" | "partial" | "rate_limited" | "budget_exceeded" | "error";

/** Rows accumulate before insertPredictions is called; matches migration 061's design note. */
const PREDICTION_INSERT_CHUNK = 200;
/** Candidate pool fetchPairCandidates draws from before samplePairs narrows it
 * down to JEV_PAIR_COUNT -- generous so day-grouping/dedup has room to work. */
const PAIR_CANDIDATE_FETCH_LIMIT = 200;

// ---------------------------------------------------------------------------
// Wire types (mirror the verified gateway contract exactly)
// ---------------------------------------------------------------------------

export type JevQuestion =
  | { type: "boolean"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: Array<string | null> };

export interface JevRequest {
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, JevQuestion>;
}

export type JevAnswer =
  | { type: "boolean"; probability: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number> }
  | { type: "score"; score: number; probabilities?: Record<string, number> };

export interface JevResponse {
  answers: Record<string, JevAnswer>;
  usage: { inputTokens: number; outputTokens: number };
  warnings?: unknown[];
  rounding?: unknown;
  providerMetadata?: Record<string, unknown>;
}

export class JevRateLimitError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "JevRateLimitError";
  }
}

export class JevDeadlineError extends Error {
  constructor(stage: string) {
    super(`jev-shadow deadline exceeded during ${stage}`);
    this.name = "JevDeadlineError";
  }
}

export class JevResponseError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "JevResponseError";
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Recursively key-sorted JSON.stringify -- same discipline as archive.ts's sortKeys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** sha256Hex(canonicalJson(state)) -- lets a later run detect a changed subject without storing the prompt. */
export async function stateHash(state: unknown): Promise<string> {
  return sha256Hex(canonicalJson(state));
}

/** Truncates to `max` chars; null/undefined become "". */
export function clamp(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) : text;
}

/** Human-readable one-liner of `state`, newlines collapsed to " ", clamped to JEV_PREVIEW_CLAMP. */
export function statePreview(state: unknown): string {
  const text = typeof state === "string" ? state : JSON.stringify(state);
  const collapsed = (text ?? "").replace(/\r\n|\r|\n/g, " ").trim();
  return clamp(collapsed, JEV_PREVIEW_CLAMP);
}

/**
 * Validates the raw gateway body into a JevResponse. Throws JevResponseError
 * on a missing/non-object `answers`, a missing usage.inputTokens, an answer
 * whose `type` is not boolean|choice|score, OR an answer whose type-specific
 * field is missing/out of range: boolean requires a finite `probability` in
 * [0, 1], score requires a finite `score` in [0, 10), choice requires a
 * non-empty string `choice`. This is what keeps a contract surprise (a
 * missing field, a 0-100 percentage, an out-of-range level) a visible,
 * counted per-subject skip (callOnce downgrades JevResponseError) instead of
 * silent NaN/fabricated-disagreement rows or a Postgres 22003 that takes
 * down the whole insert chunk. Never throws on extra unknown fields
 * (rounding, warnings, providerMetadata and anything else).
 */
export function parseJevResponse(raw: unknown): JevResponse {
  if (!raw || typeof raw !== "object") {
    throw new JevResponseError("jev response is not an object");
  }
  const body = raw as Record<string, unknown>;

  const answers = body.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new JevResponseError("jev response is missing `answers`");
  }

  const usage = body.usage;
  if (
    !usage ||
    typeof usage !== "object" ||
    typeof (usage as Record<string, unknown>).inputTokens !== "number"
  ) {
    throw new JevResponseError("jev response is missing usage.inputTokens");
  }

  const answerEntries = answers as Record<string, unknown>;
  for (const key of Object.keys(answerEntries)) {
    const a = answerEntries[key];
    if (!a || typeof a !== "object" || Array.isArray(a)) {
      throw new JevResponseError(`jev response answer "${key}" is malformed`);
    }
    const entry = a as Record<string, unknown>;
    const type = entry.type;
    if (type !== "boolean" && type !== "choice" && type !== "score") {
      throw new JevResponseError(`jev response answer "${key}" has an unknown type`);
    }
    if (type === "boolean") {
      const probability = entry.probability;
      if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new JevResponseError(`jev response answer "${key}" has an invalid boolean probability`);
      }
    } else if (type === "score") {
      const score = entry.score;
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score >= 10) {
        throw new JevResponseError(`jev response answer "${key}" has an invalid score`);
      }
    } else {
      const choice = entry.choice;
      if (typeof choice !== "string" || choice.length === 0) {
        throw new JevResponseError(`jev response answer "${key}" has an invalid choice`);
      }
    }
  }

  return body as unknown as JevResponse;
}

/** 429 only -- the one unambiguous HTTP-level rate-limit signal. */
export function isRateLimitStatus(status: number): boolean {
  return status === 429;
}

/** 500 * 2**attempt, capped at 8000 -- port of jev.mjs's ev() retry ladder. */
export function retryDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8000);
}

/**
 * Reads error.param[].path where path[0] === "questions" -> path[1]. Returns
 * [] when the shape does not match the verified 400 envelope. Used to drop
 * exactly the offending question id(s) and retry the call once.
 */
export function offendingQuestionIds(errorBody: unknown): string[] {
  if (!errorBody || typeof errorBody !== "object") return [];
  const error = (errorBody as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return [];
  const param = (error as Record<string, unknown>).param;
  if (!Array.isArray(param)) return [];

  const out: string[] = [];
  for (const entry of param) {
    if (!entry || typeof entry !== "object") continue;
    const path = (entry as Record<string, unknown>).path;
    if (!Array.isArray(path)) continue;
    if (path[0] === "questions" && typeof path[1] === "string") {
      out.push(path[1]);
    }
  }
  return out;
}

export function tokensToUsd(tokens: number): number {
  return tokens * JEV_USD_PER_TOKEN;
}

/** True once the month-to-date plus this run's tokens would cross (or already crossed) the cap. */
export function budgetExceeded(monthTokens: number, runTokens: number, cap: number): boolean {
  return monthTokens + runTokens >= cap;
}

/** The ingest-time keyword classifier: politika/son_dakika -> true, everything else (incl. null) -> false. */
export function politicsBaseline(category: string | null): boolean {
  return category !== null && (JEV_POLITICS_CATEGORIES as readonly string[]).includes(category);
}

/**
 * politika -> politics; ekonomi -> economy; spor|teknoloji|yasam|genel ->
 * other; son_dakika|dunya|null|anything else -> null (ambiguous under this
 * 3-way taxonomy -- caller must map null to baseline_answer 'unknown').
 */
export function topicBaseline(category: string | null): "politics" | "economy" | "other" | null {
  if (category === "politika") return "politics";
  if (category === "ekonomi") return "economy";
  if (category === "spor" || category === "teknoloji" || category === "yasam" || category === "genel") {
    return "other";
  }
  return null;
}

export function booleanAgrees(prob: number, baseline: boolean): boolean {
  return (prob >= JEV_BOOLEAN_THRESHOLD) === baseline;
}

export function choiceAgrees(choice: string, baseline: string | null): boolean | null {
  if (baseline === null) return null;
  return choice === baseline;
}

/** Sorted, colon-joined key so an unordered pair can never be scored twice. */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}

export interface JevPairCandidate {
  id: string;
  cluster_id: string;
  title: string;
  published_at: string;
}

export interface JevPair {
  a: JevPairCandidate;
  b: JevPairCandidate;
}

/**
 * Groups candidates by UTC day (published_at.slice(0,10)), draws two from
 * DIFFERENT cluster_ids in the same day, dedupes on pairKey, bounded to
 * count*10 attempts so it can never spin. Returns [] when fewer than 2 rows
 * are given.
 */
export function samplePairs(
  rows: readonly JevPairCandidate[],
  count: number,
  random: () => number,
): JevPair[] {
  if (rows.length < 2) return [];

  const byDay = new Map<string, JevPairCandidate[]>();
  for (const row of rows) {
    const day = row.published_at.slice(0, 10);
    const list = byDay.get(day);
    if (list) list.push(row);
    else byDay.set(day, [row]);
  }

  const days = [...byDay.keys()].filter((d) => (byDay.get(d)?.length ?? 0) >= 2);
  if (days.length === 0) return [];

  const seen = new Set<string>();
  const out: JevPair[] = [];
  const maxAttempts = count * 10;

  for (let attempt = 0; attempt < maxAttempts && out.length < count; attempt++) {
    const day = days[Math.floor(random() * days.length)];
    if (day === undefined) continue;
    const pool = byDay.get(day);
    if (!pool || pool.length < 2) continue;

    const i = Math.floor(random() * pool.length);
    let j = Math.floor(random() * pool.length);
    if (j === i) j = (j + 1) % pool.length;

    const a = pool[i];
    const b = pool[j];
    if (!a || !b) continue;
    if (a.cluster_id === b.cluster_id) continue;

    const key = pairKey(a.id, b.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a, b });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Question builders -- instruction strings copied verbatim from the
// planner's shadow_tasks list (pack.md), English instructions over Turkish
// content, matching the verified gateway contract example.
// ---------------------------------------------------------------------------

export interface JevArticleRow {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  published_at: string;
  source_slug: string | null;
}

export interface JevClusterRow {
  id: string;
  title: string;
  updated_at: string;
}

export interface JevMemberRow {
  cluster_id: string;
  article_id: string;
  title: string;
  published_at: string;
}

export interface JevKapRow {
  disclosure_index: string;
  kap_title: string;
  subject: string | null;
  summary: string | null;
  disclosure_class: string | null;
  stock_codes: string[] | null;
}

export interface JevTitleRow {
  id: string;
  article_id: string | null;
  old_title: string;
  new_title: string;
}

/** state {title, description}; six questions keyed politics|topic|opinion|clickbait|framing|sensational.
 * Deliberately NO outlet slug and NO timestamp in the state: the 2026-09-20
 * limits test showed the framing answer tracks the named entity rather than
 * the wording, so handing the model the outlet name would let it key on the
 * source instead of the headline — exactly the confound this suite exists
 * to measure. source_slug stays on the row for analysis, not in the prompt. */
export function buildArticleCall(a: JevArticleRow): JevRequest {
  const state = {
    title: clamp(a.title, JEV_TITLE_CLAMP),
    description: clamp(a.description, JEV_DESC_CLAMP),
  };

  const questions: Record<string, JevQuestion> = {
    politics: {
      type: "boolean",
      instructions:
        "Is this Turkish news item about domestic politics, government, parties, elections, parliament, courts/justice with political actors, or foreign policy? Judge the news item in `title` and `description`, not the outlet. Not politics: sports, markets/economy with no political actor, celebrity, weather, crime with no political actor.",
      criteria: {
        true: "Political actors, institutions or processes are the subject of the item",
        false: "No political actor, institution or process is the subject",
      },
    },
    topic: {
      type: "choice",
      instructions: "Which single topic best matches this Turkish news item?",
      criteria: {
        politics: "Government, parliament, parties, elections, courts, law-making, foreign policy",
        economy: "Markets, companies, finance, trade, inflation, the budget as an economic (not political-process) matter",
        other: "Anything else: sports, culture, weather, crime, celebrity, technology, health",
      },
    },
    opinion: {
      type: "boolean",
      instructions:
        "Is this an opinion piece, column or analysis expressing the writer's own judgement, rather than a straight news report of events?",
      criteria: { true: "Column/opinion/analysis voice", false: "Straight news report" },
    },
    clickbait: {
      type: "boolean",
      instructions:
        "Does this headline deliberately withhold the key fact to force a click (curiosity gap, unnamed subject, 'işte o isim', 'ne oldu şaşıracaksınız'), rather than stating what happened?",
      criteria: { true: "The headline hides the payload", false: "The headline states what happened" },
    },
    framing: {
      type: "choice",
      instructions:
        "Whose side does the WORDING of this Turkish headline favour? Judge word choice and framing, not which actors appear.",
      criteria: {
        pro_government: "Wording favours government/state actors, or casts their critics unfavourably",
        pro_opposition: "Wording favours opposition actors, or casts the government unfavourably",
        neutral: "Reports the event without favouring either side",
      },
    },
    sensational: {
      type: "score",
      instructions: "How sensational is the wording of this headline?",
      criteria: [
        "Plain, factual wording",
        "Slightly heightened wording",
        "Clearly dramatic wording (şok, skandal, kan donduran)",
        "Extreme tabloid wording",
      ],
    },
  };

  return { state, questions };
}

/**
 * keys maps m1..m12 -> article_id; members capped at JEV_CLUSTER_MEMBER_MAX
 * ordered by published_at asc so the seed is always included; returns
 * keys = {} when members.length < 2 (caller skips).
 */
export function buildClusterCall(
  c: JevClusterRow,
  members: readonly JevMemberRow[],
): { request: JevRequest; keys: Record<string, string> } {
  const ordered = [...members].sort((x, y) => x.published_at.localeCompare(y.published_at)).slice(0, JEV_CLUSTER_MEMBER_MAX);

  if (ordered.length < 2) {
    return { request: { state: {}, questions: {} }, keys: {} };
  }

  const headlines: Record<string, string> = {};
  const keys: Record<string, string> = {};
  const questions: Record<string, JevQuestion> = {};

  ordered.forEach((m, i) => {
    const key = `m${i + 1}`;
    headlines[key] = clamp(m.title, JEV_TITLE_CLAMP);
    keys[key] = m.article_id;
    questions[key] = {
      type: "boolean",
      instructions:
        `Does headline \`${key}\` report the SAME news event as the event named in \`event\`? Same event means the same incident, announcement or decision — not merely the same topic, the same people, or a follow-up story on a different day.`,
      criteria: { true: "Same concrete event", false: "Different event, even if related" },
    };
  });

  const state = { event: clamp(c.title, JEV_TITLE_CLAMP), headlines };
  return { request: { state, questions }, keys };
}

/** <= JEV_PAIRS_PER_CALL pairs keyed p1..p10. */
export function buildPairCall(pairs: readonly JevPair[]): { request: JevRequest; keys: Record<string, JevPair> } {
  const limited = pairs.slice(0, JEV_PAIRS_PER_CALL);
  const pairsState: Record<string, { a: string; b: string }> = {};
  const keys: Record<string, JevPair> = {};
  const questions: Record<string, JevQuestion> = {};

  limited.forEach((pair, i) => {
    const key = `p${i + 1}`;
    pairsState[key] = { a: clamp(pair.a.title, JEV_TITLE_CLAMP), b: clamp(pair.b.title, JEV_TITLE_CLAMP) };
    keys[key] = pair;
    questions[key] = {
      type: "boolean",
      instructions:
        `Do the two headlines in \`pairs.${key}\` report the SAME news event (same incident, announcement or decision), or merely the same topic / different events?`,
      criteria: { true: "Same concrete event", false: "Different events" },
    };
  });

  return { request: { state: { pairs: pairsState }, questions }, keys };
}

/** questions kap_class (choice ODA|DKB|DG|FR) + kap_materiality (score, 4 levels). */
export function buildKapCall(d: JevKapRow): JevRequest {
  const state = {
    title: clamp(d.kap_title, JEV_TITLE_CLAMP),
    subject: d.subject ?? null,
    summary: clamp(d.summary, JEV_DESC_CLAMP),
    stock_codes: d.stock_codes ?? [],
  };

  const questions: Record<string, JevQuestion> = {
    kap_class: {
      type: "choice",
      instructions: "Which KAP disclosure class does this Turkish filing belong to?",
      criteria: {
        ODA: "Özel Durum Açıklaması — a material-event disclosure: contract, investment, litigation, management change, capital action",
        DKB: "Düzenli Kamuyu Bilgilendirme — routine periodic information: buy-back reports, investor presentations, general assembly notices",
        DG: "Diğer — other filings that fit none of the other classes",
        FR: "Finansal Rapor — a financial statement or interim/annual financial report",
      },
    },
    kap_materiality: {
      type: "score",
      instructions: "How likely is this filing to move the company's share price?",
      criteria: [
        "Administrative or routine; no price impact expected",
        "Minor; marginal impact at most",
        "Notable; a plausible single-digit move",
        "Highly material; a large move is likely",
      ],
    },
  };

  return { state, questions };
}

/** questions title_meaning (boolean) + title_edit_kind (choice). */
export function buildTitleCall(v: JevTitleRow): JevRequest {
  const state = { before: clamp(v.old_title, JEV_TITLE_CLAMP), after: clamp(v.new_title, JEV_TITLE_CLAMP) };

  const questions: Record<string, JevQuestion> = {
    title_meaning: {
      type: "boolean",
      instructions:
        "Did the edit from `before` to `after` change the FACTUAL meaning of the headline — a different claim, number, actor, or an added/removed allegation — as opposed to a purely cosmetic edit such as a typo fix, punctuation, shortening or style change?",
      criteria: { true: "The factual claim changed", false: "Cosmetic edit only; the claim is the same" },
    },
    title_edit_kind: {
      type: "choice",
      instructions: "What kind of edit turned `before` into `after`?",
      criteria: {
        correction: "Fixes a factual error in the earlier headline",
        softening: "Makes the claim weaker, vaguer, or less damaging to someone",
        hardening: "Makes the claim stronger, sharper, or more damaging to someone",
        cosmetic: "Typo, punctuation, length or style only — the claim is unchanged",
      },
    },
  };

  return { state, questions };
}

// ---------------------------------------------------------------------------
// Row builder -- the single place the insert payload shape is decided.
// ---------------------------------------------------------------------------

export interface JevPredictionRow {
  task: string;
  subject_type: JevSubjectType;
  subject_id: string;
  article_id: string | null;
  cluster_id: string | null;
  state_hash: string;
  jev_answer: Record<string, unknown>;
  jev_prob: number | null;
  jev_choice: string | null;
  baseline_answer: string;
  agree: boolean | null;
  latency_ms: number;
  input_tokens: number;
  model: string;
  run_id: number;
}

function readNested(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function predictionRow(args: {
  task: string;
  subjectType: JevSubjectType;
  subjectId: string;
  articleId?: string | null;
  clusterId?: string | null;
  stateHash: string;
  preview: string;
  questionId: string;
  callId: string;
  answer: JevAnswer;
  response: JevResponse;
  baseline: string;
  agree: boolean | null;
  latencyMs: number;
  runId: number;
}): JevPredictionRow {
  const jevProb =
    args.answer.type === "boolean"
      ? round3(args.answer.probability)
      : args.answer.type === "score"
        ? round3(args.answer.score)
        : null;
  const jevChoice = args.answer.type === "choice" ? args.answer.choice : null;

  const marketCost = readNested(args.response.providerMetadata, "gateway", "marketCost") ?? null;
  const confidence = readNested(args.response.providerMetadata, "typesafe", "confidence", args.questionId) ?? null;

  return {
    task: args.task,
    subject_type: args.subjectType,
    subject_id: args.subjectId,
    article_id: args.articleId ?? null,
    cluster_id: args.clusterId ?? null,
    state_hash: args.stateHash,
    jev_answer: {
      answer: args.answer,
      question_id: args.questionId,
      question_set: JEV_QUESTION_SET_VERSION,
      call_id: args.callId,
      state_preview: args.preview,
      output_tokens: args.response.usage.outputTokens,
      market_cost: marketCost,
      confidence,
      warnings: args.response.warnings ?? [],
    },
    jev_prob: jevProb,
    jev_choice: jevChoice,
    baseline_answer: args.baseline,
    agree: args.agree,
    latency_ms: args.latencyMs,
    input_tokens: args.response.usage.inputTokens,
    model: JEV_MODEL,
    run_id: args.runId,
  };
}

// ---------------------------------------------------------------------------
// Ports + algorithm -- the ArchivePorts seam, verbatim discipline.
// ---------------------------------------------------------------------------

export interface JevPorts {
  now(): number;
  random(): number;
  evaluate(req: JevRequest): Promise<{ response: JevResponse; latencyMs: number }>;
  monthTokens(cap: number): Promise<{ input_tokens: number; cap: number; exceeded: boolean }>;
  startRun(): Promise<number>;
  finishRun(
    id: number,
    patch: { finished_at: string; calls: number; input_tokens: number; errors: number; status: JevRunStatus; note: string | null },
  ): Promise<void>;
  insertPredictions(rows: readonly JevPredictionRow[]): Promise<number>;
  /** Checkpoints spend on the still-open run row (UPDATE, not the closing
   * finishRun). Called after every successful evaluate() (JEV-A12) so a
   * killed instance -- platform wall-clock kill, OOM, redeploy, or the
   * cron's 60s timeout -- still leaves its spend counted toward the monthly
   * cap, instead of the whole run's tokens vanishing because `finally`
   * never ran. */
  recordTokens(runId: number, calls: number, inputTokens: number): Promise<void>;
  /** Anti-join: which of these `${task}` subject_ids already have a row in
   * jev_shadow_predictions. Backed by index.ts's chunked anti_join()
   * helper (JEV-A5). Used by the cluster stage (JEV-A10) since
   * fetchClusterMembers has no per-task notion of "already asked". */
  fetchSeenSubjects(task: string, subjectIds: readonly string[]): Promise<Set<string>>;
  fetchPendingArticles(sinceIso: string, limit: number): Promise<JevArticleRow[]>;
  fetchRecentClusters(sinceIso: string, limit: number): Promise<JevClusterRow[]>;
  fetchClusterMembers(clusterIds: readonly string[]): Promise<JevMemberRow[]>;
  fetchPairCandidates(sinceIso: string, limit: number): Promise<JevPairCandidate[]>;
  fetchPendingKap(sinceIso: string, limit: number): Promise<JevKapRow[]>;
  fetchPendingTitleVersions(sinceIso: string, limit: number): Promise<JevTitleRow[]>;
  /**
   * Optional per-failure hook (JEV-A13): called for every callOnce failure
   * that is NOT a rate limit (a rate limit is already visible via the run's
   * status). Without this, callOnce's catch discarded `err` entirely and
   * the only surviving trace was an integer in jev_shadow_runs.errors --
   * not actionable on the first run, when pack.md's SCORE QUESTION TYPE
   * UNVERIFIED risk specifically calls for watching this.
   *
   * SECURITY, non-negotiable, runtime-agnostic (this file must stay free of
   * Deno./fetch(/npm: -- the "[W1] zero occurrences" acceptance bullet):
   * an implementation must log only the error's name/class, HTTP status and
   * attempt count -- NEVER the gateway's raw response text/JSON (a 401 body
   * embeds an API-key-creation URL, a 400 echoes request paths).
   */
  onError?(stage: string, err: unknown): void;
}

export interface JevShadowResult {
  ok: true;
  run_id: number;
  status: JevRunStatus;
  calls: number;
  errors: number;
  input_tokens: number;
  rows: number;
  usd: number;
  stages: Record<StageName, StageStats>;
  duration_ms: number;
}

type StageName = "articles" | "clusters" | "pairs" | "kap" | "title_versions";

interface StageStats {
  calls: number;
  rows: number;
  errors: number;
  skipped: number;
}

interface RunCtx {
  ports: JevPorts;
  runId: number;
  t0: number;
  deadlineMs: number;
  cap: number;
  monthTokens: number;
  calls: number;
  errors: number;
  runTokens: number;
  rows: JevPredictionRow[];
  rowsInserted: number;
  stopReason: JevRunStatus | null;
  callSeq: number;
  stages: Record<StageName, StageStats>;
  /** Stages whose own fetch/build threw (JEV-B1 stage isolation). The run
   * still closes -- as 'partial', naming them -- instead of one stage's
   * PostgREST error taking every later stage down with it. */
  failedStages: StageName[];
}

function emptyStageStats(): StageStats {
  return { calls: 0, rows: 0, errors: 0, skipped: 0 };
}

function makeCtx(ports: JevPorts, runId: number, t0: number, deadlineMs: number, cap: number): RunCtx {
  return {
    ports,
    runId,
    t0,
    deadlineMs,
    cap,
    monthTokens: 0,
    calls: 0,
    errors: 0,
    runTokens: 0,
    rows: [],
    rowsInserted: 0,
    stopReason: null,
    callSeq: 0,
    failedStages: [],
    stages: {
      articles: emptyStageStats(),
      clusters: emptyStageStats(),
      pairs: emptyStageStats(),
      kap: emptyStageStats(),
      title_versions: emptyStageStats(),
    },
  };
}

function isPastDeadline(ctx: RunCtx): boolean {
  return ctx.ports.now() - ctx.t0 > ctx.deadlineMs;
}

function nextCallId(ctx: RunCtx): string {
  ctx.callSeq += 1;
  return `run${ctx.runId}-${ctx.callSeq}`;
}

function clampErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 500 ? msg.slice(0, 500) : msg;
}

async function pushRows(ctx: RunCtx, rows: readonly JevPredictionRow[]): Promise<void> {
  ctx.rows.push(...rows);
  while (ctx.rows.length >= PREDICTION_INSERT_CHUNK) {
    const chunk = ctx.rows.splice(0, PREDICTION_INSERT_CHUNK);
    ctx.rowsInserted += await ctx.ports.insertPredictions(chunk);
  }
}

async function flushRemaining(ctx: RunCtx): Promise<void> {
  if (ctx.rows.length === 0) return;
  const chunk = ctx.rows.splice(0, ctx.rows.length);
  ctx.rowsInserted += await ctx.ports.insertPredictions(chunk);
}

/**
 * One gateway call. Increments ctx.calls/ctx.runTokens on success and
 * re-checks budgetExceeded immediately after. A JevRateLimitError sets
 * ctx.stopReason = 'rate_limited' (never thrown further); any other
 * rejection is a per-subject skip (ctx.errors++). Returns null on any
 * failure so the caller can bail out of building rows for this subject.
 */
async function callOnce(
  ctx: RunCtx,
  stage: StageName,
  request: JevRequest,
): Promise<{ response: JevResponse; latencyMs: number } | null> {
  try {
    const result = await ctx.ports.evaluate(request);
    ctx.calls += 1;
    ctx.runTokens += result.response.usage.inputTokens;
    if (!ctx.stopReason && budgetExceeded(ctx.monthTokens, ctx.runTokens, ctx.cap)) {
      ctx.stopReason = "budget_exceeded";
    }
    // Checkpoint immediately -- see JEV-A12. Awaited (deterministic
    // ordering) but best-effort: a failed checkpoint write must not turn a
    // successful gateway call into a per-subject error.
    try {
      await ctx.ports.recordTokens(ctx.runId, ctx.calls, ctx.runTokens);
    } catch {
      // swallow -- finishRun's close-of-run write is still authoritative.
    }
    return result;
  } catch (err) {
    if (err instanceof JevRateLimitError) {
      if (!ctx.stopReason) ctx.stopReason = "rate_limited";
      return null;
    }
    ctx.errors += 1;
    try {
      ctx.ports.onError?.(stage, err);
    } catch {
      // A logging hook must never destabilize the run.
    }
    return null;
  }
}

/**
 * Runs `worker` over `items` with at most JEV_CONCURRENCY in flight. Checks
 * the deadline (via JevDeadlineError, caught immediately -- never escapes
 * this function) and ctx.stopReason before dequeuing each item, so a
 * rate-limit/budget/deadline signal stops further dispatch without
 * cancelling in-flight calls.
 */
async function processStage<T>(
  ctx: RunCtx,
  stageName: StageName,
  items: readonly T[],
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let idx = 0;

  const runOne = async (): Promise<void> => {
    while (idx < items.length) {
      if (ctx.stopReason) return;
      try {
        if (isPastDeadline(ctx)) throw new JevDeadlineError(stageName);
      } catch (err) {
        if (err instanceof JevDeadlineError) {
          ctx.stopReason = "partial";
          return;
        }
        throw err;
      }
      const i = idx++;
      const item = items[i];
      if (item === undefined) continue;
      await worker(item);
    }
  };

  const n = Math.max(1, Math.min(JEV_CONCURRENCY, items.length));
  await Promise.all(Array.from({ length: n }, () => runOne()));
}

// --- per-stage row builders --------------------------------------------------

function buildArticleRows(
  runId: number,
  article: JevArticleRow,
  response: JevResponse,
  callId: string,
  hash: string,
  preview: string,
  latencyMs: number,
): JevPredictionRow[] {
  const rows: JevPredictionRow[] = [];
  const common = {
    articleId: article.id,
    clusterId: null,
    stateHash: hash,
    preview,
    callId,
    response,
    latencyMs,
    runId,
  };

  if (article.category !== null) {
    const answer = response.answers.politics;
    if (answer && answer.type === "boolean") {
      const baseline = politicsBaseline(article.category);
      rows.push(
        predictionRow({
          ...common,
          task: "politics",
          subjectType: "article",
          subjectId: article.id,
          questionId: "politics",
          answer,
          baseline: baseline ? "true" : "false",
          agree: booleanAgrees(answer.probability, baseline),
        }),
      );
    }
  }

  const topicAnswer = response.answers.topic;
  if (topicAnswer && topicAnswer.type === "choice") {
    const baseline = topicBaseline(article.category);
    rows.push(
      predictionRow({
        ...common,
        task: "topic",
        subjectType: "article",
        subjectId: article.id,
        questionId: "topic",
        answer: topicAnswer,
        baseline: baseline ?? "unknown",
        agree: choiceAgrees(topicAnswer.choice, baseline),
      }),
    );
  }

  for (const task of ["opinion", "clickbait", "framing", "sensational"] as const) {
    const answer = response.answers[task];
    if (!answer) continue;
    rows.push(
      predictionRow({
        ...common,
        task,
        subjectType: "article",
        subjectId: article.id,
        questionId: task,
        answer,
        baseline: "none",
        agree: null,
      }),
    );
  }

  return rows;
}

function buildClusterRows(
  runId: number,
  cluster: JevClusterRow,
  keys: Record<string, string>,
  response: JevResponse,
  callId: string,
  hash: string,
  preview: string,
  latencyMs: number,
): JevPredictionRow[] {
  const rows: JevPredictionRow[] = [];
  for (const [key, articleId] of Object.entries(keys)) {
    const answer = response.answers[key];
    if (!answer || answer.type !== "boolean") continue;
    rows.push(
      predictionRow({
        task: "cluster_member",
        subjectType: "cluster",
        subjectId: `${cluster.id}:${articleId}`,
        articleId,
        clusterId: cluster.id,
        stateHash: hash,
        preview,
        questionId: key,
        callId,
        answer,
        response,
        baseline: "true",
        agree: booleanAgrees(answer.probability, true),
        latencyMs,
        runId,
      }),
    );
  }
  return rows;
}

function buildPairRows(
  runId: number,
  keys: Record<string, JevPair>,
  response: JevResponse,
  callId: string,
  hash: string,
  preview: string,
  latencyMs: number,
): JevPredictionRow[] {
  const rows: JevPredictionRow[] = [];
  for (const [key, pair] of Object.entries(keys)) {
    const answer = response.answers[key];
    if (!answer || answer.type !== "boolean") continue;
    rows.push(
      predictionRow({
        task: "pair_negative",
        subjectType: "pair",
        subjectId: pairKey(pair.a.id, pair.b.id),
        articleId: null,
        clusterId: null,
        stateHash: hash,
        preview,
        questionId: key,
        callId,
        answer,
        response,
        baseline: "false",
        agree: booleanAgrees(answer.probability, false),
        latencyMs,
        runId,
      }),
    );
  }
  return rows;
}

function buildKapRows(
  runId: number,
  d: JevKapRow,
  response: JevResponse,
  callId: string,
  hash: string,
  preview: string,
  latencyMs: number,
): JevPredictionRow[] {
  const rows: JevPredictionRow[] = [];
  const common = {
    articleId: null,
    clusterId: null,
    stateHash: hash,
    preview,
    callId,
    response,
    latencyMs,
    runId,
    subjectType: "kap" as const,
    subjectId: d.disclosure_index,
  };

  const classAnswer = response.answers.kap_class;
  if (classAnswer && classAnswer.type === "choice" && d.disclosure_class !== null) {
    rows.push(
      predictionRow({
        ...common,
        task: "kap_class",
        questionId: "kap_class",
        answer: classAnswer,
        baseline: d.disclosure_class,
        agree: choiceAgrees(classAnswer.choice, d.disclosure_class),
      }),
    );
  }

  const matAnswer = response.answers.kap_materiality;
  if (matAnswer && matAnswer.type === "score") {
    rows.push(
      predictionRow({
        ...common,
        task: "kap_materiality",
        questionId: "kap_materiality",
        answer: matAnswer,
        baseline: "none",
        agree: null,
      }),
    );
  }

  return rows;
}

function buildTitleRows(
  runId: number,
  v: JevTitleRow,
  response: JevResponse,
  callId: string,
  hash: string,
  preview: string,
  latencyMs: number,
): JevPredictionRow[] {
  const rows: JevPredictionRow[] = [];
  const common = {
    articleId: v.article_id ?? null,
    clusterId: null,
    stateHash: hash,
    preview,
    callId,
    response,
    latencyMs,
    runId,
    subjectType: "title_version" as const,
    subjectId: v.id,
  };

  const meaningAnswer = response.answers.title_meaning;
  if (meaningAnswer && meaningAnswer.type === "boolean") {
    rows.push(
      predictionRow({
        ...common,
        task: "title_meaning",
        questionId: "title_meaning",
        answer: meaningAnswer,
        baseline: "true",
        agree: booleanAgrees(meaningAnswer.probability, true),
      }),
    );
  }

  const kindAnswer = response.answers.title_edit_kind;
  if (kindAnswer && kindAnswer.type === "choice") {
    rows.push(
      predictionRow({
        ...common,
        task: "title_edit_kind",
        questionId: "title_edit_kind",
        answer: kindAnswer,
        baseline: "none",
        agree: null,
      }),
    );
  }

  return rows;
}

// --- per-stage runners --------------------------------------------------------

async function runArticlesStage(ctx: RunCtx, sinceIso: string): Promise<void> {
  const items = await ctx.ports.fetchPendingArticles(sinceIso, JEV_ARTICLE_LIMIT);
  await processStage(ctx, "articles", items, async (article) => {
    const request = buildArticleCall(article);
    const result = await callOnce(ctx, "articles", request);
    if (!result) {
      ctx.stages.articles.errors += 1;
      return;
    }
    ctx.stages.articles.calls += 1;
    const hash = await stateHash(request.state);
    const preview = statePreview(request.state);
    const callId = nextCallId(ctx);
    const rows = buildArticleRows(ctx.runId, article, result.response, callId, hash, preview, result.latencyMs);
    ctx.stages.articles.rows += rows.length;
    await pushRows(ctx, rows);
  });
}

async function runClustersStage(ctx: RunCtx, sinceIso: string): Promise<void> {
  const clusters = await ctx.ports.fetchRecentClusters(sinceIso, JEV_CLUSTER_LIMIT);
  if (clusters.length === 0) return;

  const members = await ctx.ports.fetchClusterMembers(clusters.map((c) => c.id));
  const byCluster = new Map<string, JevMemberRow[]>();
  for (const m of members) {
    const list = byCluster.get(m.cluster_id);
    if (list) list.push(m);
    else byCluster.set(m.cluster_id, [m]);
  }

  // Unlike the article/kap/title stages, clusters.updated_at can keep a
  // cluster inside the (short, 1h) window across several consecutive runs,
  // so without an anti-join here the same cluster gets re-asked every run
  // it stays in-window -- the upsert then silently discards every re-ask
  // (JEV-A10). One batched anti-join over every candidate member's
  // subject_id, not one per cluster.
  const candidateSubjectIds = members.map((m) => `${m.cluster_id}:${m.article_id}`);
  const seen = await ctx.ports.fetchSeenSubjects("cluster_member", candidateSubjectIds);

  await processStage(ctx, "clusters", clusters, async (cluster) => {
    const unseenMembers = (byCluster.get(cluster.id) ?? []).filter(
      (m) => !seen.has(`${cluster.id}:${m.article_id}`),
    );
    const { request, keys } = buildClusterCall(cluster, unseenMembers);
    if (Object.keys(keys).length === 0) {
      ctx.stages.clusters.skipped += 1;
      return;
    }
    const result = await callOnce(ctx, "clusters", request);
    if (!result) {
      ctx.stages.clusters.errors += 1;
      return;
    }
    ctx.stages.clusters.calls += 1;
    const hash = await stateHash(request.state);
    const preview = statePreview(request.state);
    const callId = nextCallId(ctx);
    const rows = buildClusterRows(ctx.runId, cluster, keys, result.response, callId, hash, preview, result.latencyMs);
    ctx.stages.clusters.rows += rows.length;
    await pushRows(ctx, rows);
  });
}

async function runPairsStage(ctx: RunCtx, sinceIso: string): Promise<void> {
  const candidates = await ctx.ports.fetchPairCandidates(sinceIso, PAIR_CANDIDATE_FETCH_LIMIT);
  const pairs = samplePairs(candidates, JEV_PAIR_COUNT, ctx.ports.random);
  if (pairs.length === 0) {
    // Too few candidates (or too few distinct same-day cluster pairs) to
    // sample anything this run -- mark it explicitly rather than returning
    // silently, so a starved pairs stage (JEV-A3) is visible in the run
    // stats instead of looking identical to "nothing to do".
    ctx.stages.pairs.skipped += 1;
    return;
  }

  const chunks: JevPair[][] = [];
  for (let i = 0; i < pairs.length; i += JEV_PAIRS_PER_CALL) {
    chunks.push(pairs.slice(i, i + JEV_PAIRS_PER_CALL));
  }

  await processStage(ctx, "pairs", chunks, async (chunk) => {
    const { request, keys } = buildPairCall(chunk);
    const result = await callOnce(ctx, "pairs", request);
    if (!result) {
      ctx.stages.pairs.errors += 1;
      return;
    }
    ctx.stages.pairs.calls += 1;
    const hash = await stateHash(request.state);
    const preview = statePreview(request.state);
    const callId = nextCallId(ctx);
    const rows = buildPairRows(ctx.runId, keys, result.response, callId, hash, preview, result.latencyMs);
    ctx.stages.pairs.rows += rows.length;
    await pushRows(ctx, rows);
  });
}

async function runKapStage(ctx: RunCtx, sinceIso: string): Promise<void> {
  const items = await ctx.ports.fetchPendingKap(sinceIso, JEV_KAP_LIMIT);
  await processStage(ctx, "kap", items, async (d) => {
    const request = buildKapCall(d);
    const result = await callOnce(ctx, "kap", request);
    if (!result) {
      ctx.stages.kap.errors += 1;
      return;
    }
    ctx.stages.kap.calls += 1;
    const hash = await stateHash(request.state);
    const preview = statePreview(request.state);
    const callId = nextCallId(ctx);
    const rows = buildKapRows(ctx.runId, d, result.response, callId, hash, preview, result.latencyMs);
    ctx.stages.kap.rows += rows.length;
    await pushRows(ctx, rows);
  });
}

async function runTitleStage(ctx: RunCtx, sinceIso: string): Promise<void> {
  const items = await ctx.ports.fetchPendingTitleVersions(sinceIso, JEV_TITLE_LIMIT);
  await processStage(ctx, "title_versions", items, async (v) => {
    const request = buildTitleCall(v);
    const result = await callOnce(ctx, "title_versions", request);
    if (!result) {
      ctx.stages.title_versions.errors += 1;
      return;
    }
    ctx.stages.title_versions.calls += 1;
    const hash = await stateHash(request.state);
    const preview = statePreview(request.state);
    const callId = nextCallId(ctx);
    const rows = buildTitleRows(ctx.runId, v, result.response, callId, hash, preview, result.latencyMs);
    ctx.stages.title_versions.rows += rows.length;
    await pushRows(ctx, rows);
  });
}

const HOUR_MS = 60 * 60 * 1000;

async function runStages(ctx: RunCtx, nowIso: string | undefined): Promise<void> {
  const nowMs = nowIso !== undefined ? Date.parse(nowIso) : ctx.ports.now();
  const sinceIso = new Date(nowMs - 24 * HOUR_MS).toISOString();
  const clusterSinceIso = new Date(nowMs - HOUR_MS).toISOString();

  const stageDefs: Array<{ name: StageName; run: () => Promise<void> }> = [
    { name: "articles", run: () => runArticlesStage(ctx, sinceIso) },
    { name: "clusters", run: () => runClustersStage(ctx, clusterSinceIso) },
    { name: "pairs", run: () => runPairsStage(ctx, sinceIso) },
    { name: "kap", run: () => runKapStage(ctx, sinceIso) },
    { name: "title_versions", run: () => runTitleStage(ctx, sinceIso) },
  ];

  for (const { name, run } of stageDefs) {
    if (ctx.stopReason) break;
    if (isPastDeadline(ctx)) {
      ctx.stopReason = "partial";
      break;
    }
    try {
      await run();
    } catch (err) {
      if (err instanceof JevDeadlineError) {
        ctx.stopReason = "partial";
        break;
      }
      // Stage isolation (JEV-B1): a stage's own fetch/build failing -- the
      // first production run lost kap and title_versions to a PostgREST
      // statement timeout in the pairs fetch -- must not take the remaining
      // stages down with it. Count it, report it through onError (which
      // never receives a raw gateway body: fetch errors are Supabase
      // messages, gateway errors were already sanitised by the binding),
      // and carry on; runJevShadow closes the run as 'partial' naming the
      // stage. Rate limits never reach here (callOnce sets stopReason).
      ctx.errors += 1;
      ctx.stages[name].errors += 1;
      ctx.failedStages.push(name);
      ctx.ports.onError?.(name, err);
    }
  }
}

/**
 * Runs one jev-shadow invocation end to end. Contract:
 *  - monthTokens(cap) FIRST (before startRun). If exceeded: open a run row,
 *    close it immediately with status 'budget_exceeded', calls 0, note
 *    'monthly cap reached', make ZERO evaluate() calls.
 *  - Stages run articles -> clusters -> pairs -> kap -> title_versions, each
 *    with its own deadline check before it starts and between batches.
 *    Hitting the deadline stops cleanly with status 'partial' (never throws
 *    out of this function).
 *  - At most JEV_CONCURRENCY evaluate() calls in flight per stage.
 *  - A single call's failure is a per-subject skip (errors++, keep going).
 *    A JevRateLimitError aborts the remaining run with status 'rate_limited'.
 *  - budgetExceeded is re-checked after every successful call; true stops
 *    the run mid-flight with status 'budget_exceeded'.
 *  - Rows are inserted via insertPredictions in chunks of 200.
 *  - finishRun always runs (try/finally), including on a throw (status
 *    'error', note = err.message clamped to 500 chars).
 */
export async function runJevShadow(
  ports: JevPorts,
  opts: { deadlineMs?: number; cap?: number; nowIso?: string } = {},
): Promise<JevShadowResult> {
  const t0 = ports.now();
  const deadlineMs = opts.deadlineMs ?? JEV_DEADLINE_MS;
  const cap = opts.cap ?? JEV_MONTHLY_TOKEN_CAP_DEFAULT;

  const month = await ports.monthTokens(cap);
  const runId = await ports.startRun();
  const ctx = makeCtx(ports, runId, t0, deadlineMs, cap);
  ctx.monthTokens = month.input_tokens;

  let status: JevRunStatus = "ok";
  let note: string | null = null;

  try {
    if (month.exceeded) {
      status = "budget_exceeded";
      note = "monthly cap reached";
    } else {
      await runStages(ctx, opts.nowIso);
      if (ctx.stopReason) status = ctx.stopReason;
      if (ctx.failedStages.length > 0) {
        if (status === "ok") status = "partial";
        note = `stage failed: ${ctx.failedStages.join(",")}`;
      }
    }
  } catch (err) {
    status = "error";
    note = clampErrorMessage(err);
  } finally {
    // flushRemaining can itself throw (e.g. insertPredictions rejects on
    // the final chunk) -- never let that prevent finishRun from closing the
    // run row (docblock above: "finishRun always runs"). Downgrade to
    // status='error' with the flush failure's message unless the run was
    // already closing as an error for a more specific reason.
    try {
      await flushRemaining(ctx);
    } catch (flushErr) {
      if (status !== "error") {
        status = "error";
        note = clampErrorMessage(flushErr);
      }
    }
    await ports.finishRun(runId, {
      finished_at: new Date(ports.now()).toISOString(),
      calls: ctx.calls,
      input_tokens: ctx.runTokens,
      errors: ctx.errors,
      status,
      note,
    });
  }

  return {
    ok: true,
    run_id: runId,
    status,
    calls: ctx.calls,
    errors: ctx.errors,
    input_tokens: ctx.runTokens,
    rows: ctx.rowsInserted,
    usd: tokensToUsd(ctx.runTokens),
    stages: ctx.stages,
    duration_ms: ports.now() - t0,
  };
}
