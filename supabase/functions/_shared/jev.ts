// supabase/functions/_shared/jev.ts
//
// TypeSafe Jev SHADOW MODE (migration 061) + "Jev şimdi" (migration 063):
// the pure, runtime-agnostic half of the jev-shadow Edge Function, exactly
// the role _shared/archive.ts plays for archive-export. Everything here
// runs unchanged under the Deno runtime (jev-shadow/index.ts) and under
// vitest on Node 24 (tests/functions/jev-shadow.test.ts) -- no Deno global
// APIs, no supabase-js import, no `fetch` call. jev-shadow/index.ts wires a
// raw-fetch gateway client and a Supabase service-role client into the
// `JevPorts` interface at the bottom, so the shadow algorithm (stage order,
// concurrency, budget guard, baseline/agree rules, row shape) is testable
// with plain in-memory fakes -- the ArchivePorts seam, verbatim discipline.
//
// What this asks, per run: 16 typed questions across six subject types
// (article, cluster, pair, KAP disclosure, title version, ticker match),
// one gateway call per subject (except pairs, which pack up to 10 per
// call). Every prediction is stored alongside the CURRENT system's answer
// (the "baseline") so agreement can be measured without ever feeding a
// reader-facing byte.
//
// 063 adds an "audit" run mode (asks only the two pair questions, at
// volume, against a nightly cron so cluster precision/recall get a
// statistically useful sample the 10-minute shadow run should not pay for)
// and a neutral_pick stage that scores the extractive neutral-title picker
// against Jev's own choice among a cluster's member headlines.

import { sha256Hex } from "./archive.ts";
import { BIAS_TO_ZONE, BIAS_KEYS, ZONE_KEYS, type BiasKey, type MediaDnaZone } from "./cluster/blindspot.ts";
import { titleTokens } from "./cluster/fingerprint.ts";

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
/** Raised 3e8 -> 5e8 by migration 063 (~$21/month at the gateway market rate
 * observed 2026-09-20) to cover the nightly audit run and the new
 * ticker_relevance / neutral_pick shadow stages. Hand-duplicated against
 * 063_jev_now_package.sql's jev_shadow_month_usage default -- JEV-A16 in
 * tests/migrations/jev-shadow-parity.test.ts is the only thing keeping them
 * equal. NOTE for operators: an explicit JEV_MONTHLY_TOKEN_CAP Edge secret
 * overrides this default for the function but NOT for /admin's budget line,
 * which always reads the SQL default -- unset the secret after applying 063. */
export const JEV_MONTHLY_TOKEN_CAP_DEFAULT = 500_000_000;
export const JEV_USD_PER_TOKEN = 42 / 1_000_000_000;
export const JEV_BOOLEAN_THRESHOLD = 0.5;
export const JEV_TITLE_CLAMP = 300; // chars of title sent
export const JEV_DESC_CLAMP = 600; // chars of description sent
export const JEV_PREVIEW_CLAMP = 240; // chars stored in state_preview
/** ticker_relevance rows per shadow run. */
export const JEV_TICKER_LIMIT = 60;
/** Pairs sampled per audit task (pair_negative, pair_positive), per audit run. */
export const JEV_AUDIT_PAIR_COUNT = 500;
/** Cap on positive (same-cluster) pairs drawn from one cluster per audit run. */
export const JEV_AUDIT_PAIRS_PER_CLUSTER = 3;
/** Clusters fetchAuditPairs walks per audit run. */
export const JEV_AUDIT_CLUSTER_LIMIT = 200;
/** Negative-pair candidate pool size in audit mode. */
export const JEV_AUDIT_CANDIDATE_LIMIT = 600;
/** Must equal EXTRACTIVE_MODEL_ID in src/lib/clusters/neutral-title.ts. */
export const JEV_NEUTRAL_MODEL_ID = "extractive-v1";
/** Stamped into every jev_answer as `question_set`. The 2026-09-20 limits
 * test showed instruction paraphrases flip ~30% of borderline titles, so a
 * prediction is only comparable to others made with the SAME question text.
 * Bump this whenever any instructions/criteria string in JEV_QUESTION_REGISTRY
 * changes, so analyses can group by question set. Migration 063 bumps this
 * alongside the three new tasks (JEV-A20 pins this against
 * questionRegistryHash() so a future wording change can't bump one without
 * the other). Migration 067 bumps this again, to 2026-09-21.3, for the new
 * topic7 question. */
export const JEV_QUESTION_SET_VERSION = "2026-09-21.3";
/** Migration 064: a cluster_member prediction below this probability queues
 * the (cluster, article) pair into jev_unlink_candidates for a human to
 * review on /admin. */
export const JEV_UNLINK_PROB_MAX = 0.35;
/** Migration 064: recently-updated blindspot clusters examined per
 * jev-shadow run by the 'blindspot_recall' stage. */
export const JEV_BLINDSPOT_CLUSTER_LIMIT = 20;
/** Candidate headlines fetched from the silent zone before ranking. This is
 * a WINDOW cap, not a relevance cap -- rankBlindspotCandidates (shared-token
 * >= JEV_BLINDSPOT_MIN_SHARED_TOKENS, top JEV_BLINDSPOT_CANDIDATES_PER_CALL)
 * is the relevance filter, so this value must exceed the number of
 * silent-zone politics articles that can appear in the candidate window
 * (measured 663 across a +/-12h window on 2026-09-21). */
export const JEV_BLINDSPOT_CANDIDATE_FETCH = 600;
/** Top-ranked candidates actually sent to Jev per cluster, per run. */
export const JEV_BLINDSPOT_CANDIDATES_PER_CALL = 15;
/** rankBlindspotCandidates' default minimum shared-token count. */
export const JEV_BLINDSPOT_MIN_SHARED_TOKENS = 2;
/** titleTokens' minLen for the blindspot recall candidate ranking. */
export const JEV_BLINDSPOT_TOKEN_MIN_LEN = 4;
/** Candidate window: cluster.first_published minus this many hours. */
export const JEV_BLINDSPOT_LOOKBACK_HOURS = 12;
/** Candidate window upper bound: cluster.first_published plus this many
 * hours, capped at now. */
export const JEV_BLINDSPOT_FORWARD_HOURS = 12;
/** Driver query window: clusters.updated_at >= now - this many hours. */
export const JEV_BLINDSPOT_WINDOW_HOURS = 24;
/** Any blindspot_recall answer at or above this probability marks the
 * cluster blindspot_recall_suspect. */
export const JEV_BLINDSPOT_SUSPECT_PROB = 0.7;

// --- Migration 066: frozen regression set ---
/** Items fetched per kind, per regression run. */
export const JEV_REGRESSION_ITEM_LIMIT = 500;
/** Answer rows buffered before an insertRegressionAnswers write. */
export const JEV_REGRESSION_ANSWER_CHUNK = 200;
/** Hand-duplicated twin of 066's jev_regression_freeze(p_articles int default 400). */
export const JEV_REGRESSION_ARTICLE_DEFAULT = 400;
/** Hand-duplicated twin of 066's jev_regression_freeze(p_pairs int default 100). */
export const JEV_REGRESSION_PAIR_DEFAULT = 100;
/** Second gold threshold, mirroring jev_gold_scorecard()'s jev_politics_070. */
export const JEV_GOLD_STRICT_THRESHOLD = 0.7;
/** numeric(4,3) ceiling in 066's jev_regression_answers.jev_prob. */
export const JEV_PROB_MAX_NUMERIC = 9.999;
/** Tasks whose jev_prob is a 0-10 score, not a [0,1] probability. A 0.5
 * crossing is meaningless for these, so they contribute mean/max_abs_delta
 * but never a flip or a flip_rate denominator. */
export const JEV_SCORE_TASKS: ReadonlySet<string> = new Set(["sensational", "kap_materiality"]);

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
/** The feed's 7-label topic taxonomy. Byte-identical to migration 063's
 *  jev_gold_labels.topic CHECK list and to JEV_GOLD_TOPICS in
 *  src/lib/admin/jev-gold.ts. Also the vocabulary of clusters.topic7. */
export const JEV_TOPIC7_CHOICES = [
  "politika", "dunya", "ekonomi", "spor", "yasam", "teknoloji", "genel",
] as const;
export type JevTopic7Choice = (typeof JEV_TOPIC7_CHOICES)[number];
export const JEV_TASKS = [
  "politics",
  "topic",
  "topic7",
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
] as const;
export type JevTask = (typeof JEV_TASKS)[number];
export type JevSubjectType = "article" | "pair" | "cluster" | "kap" | "title_version";
export type JevRunStatus = "running" | "ok" | "partial" | "rate_limited" | "budget_exceeded" | "error";
/** shadow: the 10-minute cron, every subject type. audit: the nightly
 * cluster-precision/recall cron, pair questions only, at volume. regression
 * (066): the weekly frozen-regression-set replay, comparing this run's
 * answers against the previous 'ok' regression run (and against human gold
 * labels) so a wording or model change surfaces as a flip, separate from
 * every other pipeline change 061-065 already measure. */
export type JevRunMode = "shadow" | "audit" | "regression";

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

/**
 * articles.category verbatim when it is one of the seven feed topics; null
 * for son_dakika (the breaking-news bucket is a publishing state, not a
 * topic), for null, and for anything unmapped. Unlike the 3-way
 * topicBaseline() above, dunya IS a real label here -- it is not folded into
 * "unknown". Caller maps null -> baseline_answer 'unknown' and agree -> null,
 * exactly like topicBaseline()'s callers do.
 */
export function topic7Baseline(category: string | null): JevTopic7Choice | null {
  if (category !== null && (JEV_TOPIC7_CHOICES as readonly string[]).includes(category)) {
    return category as JevTopic7Choice;
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

/**
 * Groups candidates (cluster members) by cluster_id, drops clusters with
 * fewer than 2 members, and draws at most `maxPerCluster` distinct
 * SAME-cluster pairs per cluster (deduped on pairKey, bounded to
 * maxPerCluster*10 attempts per cluster so it can never spin), stopping
 * overall at `count`. Never pairs two different cluster_ids -- the mirror
 * image of samplePairs, which never pairs the SAME cluster_id. Used by
 * audit mode's recall check: pairs the clusterer DID put together.
 */
export function sampleClusterPairs(
  rows: readonly JevPairCandidate[],
  maxPerCluster: number,
  count: number,
  random: () => number,
): JevPair[] {
  const byCluster = new Map<string, JevPairCandidate[]>();
  for (const row of rows) {
    const list = byCluster.get(row.cluster_id);
    if (list) list.push(row);
    else byCluster.set(row.cluster_id, [row]);
  }

  const seen = new Set<string>();
  const out: JevPair[] = [];

  for (const members of byCluster.values()) {
    if (out.length >= count) break;
    if (members.length < 2) continue;

    const maxAttempts = maxPerCluster * 10;
    let drawn = 0;
    for (let attempt = 0; attempt < maxAttempts && drawn < maxPerCluster && out.length < count; attempt++) {
      const i = Math.floor(random() * members.length);
      let j = Math.floor(random() * members.length);
      if (j === i) j = (j + 1) % members.length;

      const a = members[i];
      const b = members[j];
      if (!a || !b) continue;
      if (a.id === b.id) continue;

      const key = pairKey(a.id, b.id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ a, b });
      drawn++;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Question builders -- instruction strings sourced from JEV_QUESTION_REGISTRY,
// the single source of truth for every instructions/criteria string. Per-key
// tasks (cluster_member, pair_negative, pair_positive, neutral_pick) store a
// template with the literal placeholder "{key}"; the builders below do a
// plain .replace("{key}", key). The 12 pre-063 emitted strings are
// byte-identical to PR #69's (tests/functions/jev-shadow.test.ts,
// "keeps every pre-063 question string byte-identical").
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
  title: string; // title_tr_neutral ?? title_tr (unchanged)
  updated_at: string;
  title_tr_neutral: string | null; // raw column, for the neutral_pick baseline
  title_neutral_model: string | null; // "extractive-v1" | "<llm prompt id>" | null
}

export interface JevMemberRow {
  cluster_id: string;
  article_id: string;
  title: string;
  published_at: string;
}

// --- Migration 064: outlier-ejection queue + blindspot recall check -------

export interface JevUnlinkCandidateRow {
  cluster_id: string;
  article_id: string;
  jev_prob: number;
  source_task: "cluster_member" | "audit";
}

export interface JevBlindspotClusterRow {
  id: string;
  title: string;
  blindspot_side: string | null;
  first_published: string;
  updated_at: string;
}

export interface JevBlindspotCandidateQuery {
  clusterId: string;
  biasKeys: readonly string[];
  fromIso: string;
  toIso: string;
  limit: number;
}

export interface JevBlindspotCandidate {
  article_id: string;
  title: string;
  published_at: string;
  source_slug: string | null;
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

export interface JevTickerRow {
  article_id: string;
  ticker: string;
  title: string;
  description: string | null;
  company: string | null; // bist_companies.title, or null when unmapped
  matched_on: string; // "alias:<alias>" | "code"
}

// --- Migration 066: frozen regression set ---

export type JevRegressionItemKind = "article" | "pair";
export type JevRegressionRunStatus = "running" | "ok" | "partial" | "error";

export interface JevRegressionItem {
  id: number;
  kind: JevRegressionItemKind;
  subject_id: string;
  /** Frozen snapshot. article: {title, description}. pair: {pairs:{p1:{a,b}}}. */
  state: Record<string, unknown>;
  in_gold: boolean;
}

export interface JevRegressionAnswerRow {
  run_id: number;
  item_id: number;
  task: string;
  jev_prob: number | null;
  jev_choice: string | null;
}

export interface JevGoldLabelRow {
  article_id: string;
  is_politics: boolean;
  /** Feed taxonomy: politika|dunya|ekonomi|spor|yasam|teknoloji|genel. */
  topic: string;
}

export interface JevRegressionTaskDelta {
  n: number;
  flips: number;
  mean_abs_delta: number | null;
  max_abs_delta: number | null;
}

export interface JevRegressionGold {
  politics: { n: number; correct_050: number; correct_070: number };
  topic: { n: number; correct: number };
}

export interface JevRegressionDeltas {
  first_run?: boolean;
  tasks?: Record<string, JevRegressionTaskDelta>;
  overall?: { items: number; tasks: number; flip_rate: number | null };
  gold?: JevRegressionGold;
}

/**
 * Single source of every instructions/criteria string this module sends.
 * Per-key entries (cluster_member, pair_negative, pair_positive,
 * neutral_pick) hold the literal "{key}" placeholder, substituted at build
 * time. neutral_pick nests its score sub-question under criteria.score.
 * pair_positive is a byte-identical copy of pair_negative -- only the
 * sampling and baseline differ downstream.
 */
export const JEV_QUESTION_REGISTRY: Record<JevTask, { instructions: string; criteria?: unknown }> = {
  politics: {
    instructions:
      "Is this Turkish news item about domestic politics, government, parties, elections, parliament, courts/justice with political actors, or foreign policy? Judge the news item in `title` and `description`, not the outlet. Not politics: sports, markets/economy with no political actor, celebrity, weather, crime with no political actor.",
    criteria: {
      true: "Political actors, institutions or processes are the subject of the item",
      false: "No political actor, institution or process is the subject",
    },
  },
  topic: {
    instructions: "Which single topic best matches this Turkish news item?",
    criteria: {
      politics: "Government, parliament, parties, elections, courts, law-making, foreign policy",
      economy: "Markets, companies, finance, trade, inflation, the budget as an economic (not political-process) matter",
      other: "Anything else: sports, culture, weather, crime, celebrity, technology, health",
    },
  },
  topic7: {
    instructions: "Which single topic category best matches this Turkish news headline?",
    criteria: {
      politika: "The headline is primarily about domestic politics, government, political parties, elections, parliament, or policy-making.",
      dunya: "The headline is primarily about international news, foreign countries, foreign policy, or world events outside Turkey.",
      ekonomi: "The headline is primarily about the economy, markets, companies, finance, trade, currency, or the cost of living.",
      spor: "The headline is primarily about sports, athletes, matches, or sports competitions.",
      yasam: "The headline is primarily about everyday life, lifestyle, celebrity/entertainment, culture, religion, health, or human-interest topics.",
      teknoloji: "The headline is primarily about technology, science, gadgets, software, AI, or the internet.",
      genel: "The headline does not clearly fit any of the other categories, such as general crime, weather, accidents, or miscellaneous news without a dominant political, economic, sports, lifestyle, or technology angle.",
    },
  },
  opinion: {
    instructions:
      "Is this an opinion piece, column or analysis expressing the writer's own judgement, rather than a straight news report of events?",
    criteria: { true: "Column/opinion/analysis voice", false: "Straight news report" },
  },
  clickbait: {
    instructions:
      "Does this headline deliberately withhold the key fact to force a click (curiosity gap, unnamed subject, 'işte o isim', 'ne oldu şaşıracaksınız'), rather than stating what happened?",
    criteria: { true: "The headline hides the payload", false: "The headline states what happened" },
  },
  framing: {
    instructions:
      "Whose side does the WORDING of this Turkish headline favour? Judge word choice and framing, not which actors appear.",
    criteria: {
      pro_government: "Wording favours government/state actors, or casts their critics unfavourably",
      pro_opposition: "Wording favours opposition actors, or casts the government unfavourably",
      neutral: "Reports the event without favouring either side",
    },
  },
  sensational: {
    instructions: "How sensational is the wording of this headline?",
    criteria: [
      "Plain, factual wording",
      "Slightly heightened wording",
      "Clearly dramatic wording (şok, skandal, kan donduran)",
      "Extreme tabloid wording",
    ],
  },
  cluster_member: {
    instructions:
      "Does headline `{key}` report the SAME news event as the event named in `event`? Same event means the same incident, announcement or decision — not merely the same topic, the same people, or a follow-up story on a different day.",
    criteria: { true: "Same concrete event", false: "Different event, even if related" },
  },
  pair_negative: {
    instructions:
      "Do the two headlines in `pairs.{key}` report the SAME news event (same incident, announcement or decision), or merely the same topic / different events?",
    criteria: { true: "Same concrete event", false: "Different events" },
  },
  pair_positive: {
    instructions:
      "Do the two headlines in `pairs.{key}` report the SAME news event (same incident, announcement or decision), or merely the same topic / different events?",
    criteria: { true: "Same concrete event", false: "Different events" },
  },
  ticker_relevance: {
    instructions:
      "Is this news item substantively about the company named in `company` (ticker `ticker`) — its business, shares, filings or people — rather than merely containing a word that happens to match its name or alias?",
    criteria: {
      true: "The item is about that company's business, shares, filings or people",
      false: "The name merely appears, or matches a different subject entirely",
    },
  },
  neutral_pick: {
    instructions: "Does headline `{key}` state the concrete event plainly, without opinion, teaser or rhetorical question?",
    criteria: {
      true: "Plain statement of the concrete event",
      false: "Opinion, teaser, rhetorical question or withheld payload",
      score: {
        instructions: "How sensational is the wording of headline `{key}`?",
        criteria: [
          "Plain, factual wording",
          "Slightly heightened wording",
          "Clearly dramatic wording (şok, skandal, kan donduran)",
          "Extreme tabloid wording",
        ],
      },
    },
  },
  kap_class: {
    instructions: "Which KAP disclosure class does this Turkish filing belong to?",
    criteria: {
      ODA: "Özel Durum Açıklaması — a material-event disclosure: contract, investment, litigation, management change, capital action",
      DKB: "Düzenli Kamuyu Bilgilendirme — routine periodic information: buy-back reports, investor presentations, general assembly notices",
      DG: "Diğer — other filings that fit none of the other classes",
      FR: "Finansal Rapor — a financial statement or interim/annual financial report",
    },
  },
  kap_materiality: {
    instructions: "How likely is this filing to move the company's share price?",
    criteria: [
      "Administrative or routine; no price impact expected",
      "Minor; marginal impact at most",
      "Notable; a plausible single-digit move",
      "Highly material; a large move is likely",
    ],
  },
  title_meaning: {
    instructions:
      "Did the edit from `before` to `after` change the FACTUAL meaning of the headline — a different claim, number, actor, or an added/removed allegation — as opposed to a purely cosmetic edit such as a typo fix, punctuation, shortening or style change?",
    criteria: { true: "The factual claim changed", false: "Cosmetic edit only; the claim is the same" },
  },
  title_edit_kind: {
    instructions: "What kind of edit turned `before` into `after`?",
    criteria: {
      correction: "Fixes a factual error in the earlier headline",
      softening: "Makes the claim weaker, vaguer, or less damaging to someone",
      hardening: "Makes the claim stronger, sharper, or more damaging to someone",
      cosmetic: "Typo, punctuation, length or style only — the claim is unchanged",
    },
  },
  pair_marginal: {
    instructions:
      "Do the two headlines in `pairs.{key}` report the SAME news event (same incident, announcement or decision), or merely the same topic / different events?",
    criteria: { true: "Same concrete event", false: "Different events" },
  },            // byte-identical to pair_negative
  blindspot_recall: {
    instructions:
      "Does headline `{key}` report the SAME news event as the event named in `event`? Same event means the same incident, announcement or decision — not merely the same topic, the same people, or a follow-up story on a different day.",
    criteria: { true: "Same concrete event", false: "Different event, even if related" },
  },            // byte-identical to cluster_member (em dash preserved via copy/paste)
};

/**
 * SYNCHRONOUS in the original plan, but sha256Hex (archive.ts) is async and
 * this module must never touch a runtime crypto global directly (Deno vs.
 * Node parity) -- so, per pack.md's orchestrator override #1 (overrides win
 * over the brief/contract), this is ASYNC and delegates to the existing
 * sha256Hex rather than hand-rolling SHA-256. The parity test
 * (tests/migrations/jev-shadow-parity.test.ts, JEV-A20) awaits it and pins
 * the literal hash next to JEV_QUESTION_SET_VERSION.
 */
export async function questionRegistryHash(): Promise<string> {
  return sha256Hex(canonicalJson(JEV_QUESTION_REGISTRY));
}

function boolQuestion(task: JevTask): JevQuestion {
  const entry = JEV_QUESTION_REGISTRY[task];
  const c = (entry.criteria ?? {}) as { true?: string; false?: string };
  return { type: "boolean", instructions: entry.instructions, criteria: { true: c.true, false: c.false } };
}

function choiceQuestion(task: JevTask): JevQuestion {
  const entry = JEV_QUESTION_REGISTRY[task];
  return { type: "choice", instructions: entry.instructions, criteria: entry.criteria as Record<string, string | null> };
}

function scoreQuestion(task: JevTask): JevQuestion {
  const entry = JEV_QUESTION_REGISTRY[task];
  return { type: "score", instructions: entry.instructions, criteria: entry.criteria as Array<string | null> };
}

function keyedBoolQuestion(
  task: "cluster_member" | "pair_negative" | "pair_positive" | "pair_marginal" | "blindspot_recall",
  key: string,
): JevQuestion {
  const entry = JEV_QUESTION_REGISTRY[task];
  const c = (entry.criteria ?? {}) as { true?: string; false?: string };
  return {
    type: "boolean",
    instructions: entry.instructions.replace("{key}", key),
    criteria: { true: c.true, false: c.false },
  };
}

function neutralPickBoolQuestion(key: string): JevQuestion {
  const entry = JEV_QUESTION_REGISTRY.neutral_pick;
  const c = entry.criteria as { true: string; false: string };
  return {
    type: "boolean",
    instructions: entry.instructions.replace("{key}", key),
    criteria: { true: c.true, false: c.false },
  };
}

function neutralPickScoreQuestion(key: string): JevQuestion {
  const entry = JEV_QUESTION_REGISTRY.neutral_pick;
  const c = entry.criteria as { score: { instructions: string; criteria: Array<string | null> } };
  return {
    type: "score",
    instructions: c.score.instructions.replace("{key}", key),
    criteria: c.score.criteria,
  };
}

/** state {title, description}; seven questions keyed politics|topic|topic7|opinion|clickbait|framing|sensational.
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
    politics: boolQuestion("politics"),
    topic: choiceQuestion("topic"),
    topic7: choiceQuestion("topic7"),
    opinion: boolQuestion("opinion"),
    clickbait: boolQuestion("clickbait"),
    framing: choiceQuestion("framing"),
    sensational: scoreQuestion("sensational"),
  };

  return { state, questions };
}

function orderMembers(members: readonly JevMemberRow[]): JevMemberRow[] {
  return [...members]
    .sort((x, y) => x.published_at.localeCompare(y.published_at))
    .slice(0, JEV_CLUSTER_MEMBER_MAX);
}

/**
 * state.headlines always covers EVERY member in the call (m1..mN,
 * published_at asc, capped at JEV_CLUSTER_MEMBER_MAX). `keys` = m<k>
 * questions actually asked (members not in opts.skipMemberIds). `neutralKeys`
 * = every m<k> -> article_id when opts.neutralPick, else {}. Caller skips
 * the cluster only when BOTH keys and neutralKeys come back empty.
 */
export function buildClusterCall(
  c: JevClusterRow,
  members: readonly JevMemberRow[],
  opts: { neutralPick?: boolean; skipMemberIds?: ReadonlySet<string> } = {},
): { request: JevRequest; keys: Record<string, string>; neutralKeys: Record<string, string> } {
  const ordered = orderMembers(members);

  if (ordered.length < 2) {
    return { request: { state: {}, questions: {} }, keys: {}, neutralKeys: {} };
  }

  const skip = opts.skipMemberIds ?? new Set<string>();
  const neutralPick = opts.neutralPick ?? false;

  const headlines: Record<string, string> = {};
  const keys: Record<string, string> = {};
  const neutralKeys: Record<string, string> = {};
  const questions: Record<string, JevQuestion> = {};

  ordered.forEach((m, i) => {
    const key = `m${i + 1}`;
    headlines[key] = clamp(m.title, JEV_TITLE_CLAMP);

    if (!skip.has(m.article_id)) {
      keys[key] = m.article_id;
      questions[key] = keyedBoolQuestion("cluster_member", key);
    }

    if (neutralPick) {
      neutralKeys[key] = m.article_id;
      questions[`f${i + 1}`] = neutralPickBoolQuestion(key);
      questions[`s${i + 1}`] = neutralPickScoreQuestion(key);
    }
  });

  if (Object.keys(keys).length === 0 && Object.keys(neutralKeys).length === 0) {
    return { request: { state: {}, questions: {} }, keys: {}, neutralKeys: {} };
  }

  const state = { event: clamp(c.title, JEV_TITLE_CLAMP), headlines };
  return { request: { state, questions }, keys, neutralKeys };
}

/** <= JEV_PAIRS_PER_CALL pairs keyed p1..p10. `task` selects which registry
 * entry supplies the question text -- pair_positive is byte-identical to
 * pair_negative, so the emitted request is the same either way. Defaults to
 * "pair_negative", which keeps every PR #69 call site compiling. */
export function buildPairCall(
  pairs: readonly JevPair[],
  task: "pair_negative" | "pair_positive" = "pair_negative",
): { request: JevRequest; keys: Record<string, JevPair> } {
  const limited = pairs.slice(0, JEV_PAIRS_PER_CALL);
  const pairsState: Record<string, { a: string; b: string }> = {};
  const keys: Record<string, JevPair> = {};
  const questions: Record<string, JevQuestion> = {};

  limited.forEach((pair, i) => {
    const key = `p${i + 1}`;
    pairsState[key] = { a: clamp(pair.a.title, JEV_TITLE_CLAMP), b: clamp(pair.b.title, JEV_TITLE_CLAMP) };
    keys[key] = pair;
    questions[key] = keyedBoolQuestion(task, key);
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
    kap_class: choiceQuestion("kap_class"),
    kap_materiality: scoreQuestion("kap_materiality"),
  };

  return { state, questions };
}

/** questions title_meaning (boolean) + title_edit_kind (choice). */
export function buildTitleCall(v: JevTitleRow): JevRequest {
  const state = { before: clamp(v.old_title, JEV_TITLE_CLAMP), after: clamp(v.new_title, JEV_TITLE_CLAMP) };

  const questions: Record<string, JevQuestion> = {
    title_meaning: boolQuestion("title_meaning"),
    title_edit_kind: choiceQuestion("title_edit_kind"),
  };

  return { state, questions };
}

/** state {title, description, ticker, company, matched_on}; one boolean question keyed ticker_relevance. */
export function buildTickerCall(t: JevTickerRow): JevRequest {
  const state = {
    title: clamp(t.title, JEV_TITLE_CLAMP),
    description: clamp(t.description, JEV_DESC_CLAMP),
    ticker: t.ticker,
    company: t.company,
    matched_on: t.matched_on,
  };

  const questions: Record<string, JevQuestion> = {
    ticker_relevance: boolQuestion("ticker_relevance"),
  };

  return { state, questions };
}

// ---------------------------------------------------------------------------
// Migration 064: blindspot recall check + outlier-ejection pure helpers.
// ---------------------------------------------------------------------------

/** UTC "YYYY-MM-DD" -- the per-day anti-join key for the blindspot_recall marker row. */
export function runDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Planner decision D1 (pack.md §L): blindspot_side is a bias CATEGORY inside
 * the DOMINANT zone (the side that DID write -- /blindspots renders "Sadece
 * X yazdı"), so the zones this function returns are the ones that did NOT
 * write -- the silent zones the recall check should examine.
 *
 * A6 / SEC-064-04 fix: `side` is an arbitrary DB `text` value, not a typed
 * BiasKey -- validate it against BIAS_KEYS instead of casting. `side ===
 * null` or any value outside BIAS_KEYS (should not happen for a real
 * blindspot cluster; defensive only) now fails CLOSED, returning `[]`
 * (no zones to check), instead of failing open and returning every zone
 * including the dominant one that demonstrably did publish -- the caller
 * (runBlindspotRecallStage) already skips when `zones.length === 0`.
 */
export function blindspotSilentZones(side: string | null): MediaDnaZone[] {
  if (side === null || !(BIAS_KEYS as readonly string[]).includes(side)) return [];
  const zone = BIAS_TO_ZONE[side as BiasKey];
  return ZONE_KEYS.filter((z) => z !== zone);
}

/** BIAS_KEYS whose zone is one of `zones`, in BIAS_KEYS order. */
export function biasKeysForZones(zones: readonly MediaDnaZone[]): BiasKey[] {
  return BIAS_KEYS.filter((k) => zones.includes(BIAS_TO_ZONE[k]));
}

/** |titleTokens(a) ∩ titleTokens(b)| -- shared 4+ char Turkish-folded/stemmed tokens. */
export function sharedTokenCount(a: string, b: string, minLen = JEV_BLINDSPOT_TOKEN_MIN_LEN): number {
  const ta = titleTokens(a, minLen);
  const tb = titleTokens(b, minLen);
  let count = 0;
  for (const t of ta) {
    if (tb.has(t)) count += 1;
  }
  return count;
}

/**
 * Keeps only candidates sharing >= opts.minShared (default
 * JEV_BLINDSPOT_MIN_SHARED_TOKENS) tokens of >= JEV_BLINDSPOT_TOKEN_MIN_LEN
 * chars with `eventTitle`, sorts shared desc / published_at desc / article_id
 * asc, and slices to opts.limit (default JEV_BLINDSPOT_CANDIDATES_PER_CALL).
 */
export function rankBlindspotCandidates(
  eventTitle: string,
  candidates: readonly JevBlindspotCandidate[],
  opts: { minShared?: number; limit?: number } = {},
): JevBlindspotCandidate[] {
  const minShared = opts.minShared ?? JEV_BLINDSPOT_MIN_SHARED_TOKENS;
  const limit = opts.limit ?? JEV_BLINDSPOT_CANDIDATES_PER_CALL;

  return candidates
    .map((c) => ({ c, shared: sharedTokenCount(eventTitle, c.title, JEV_BLINDSPOT_TOKEN_MIN_LEN) }))
    .filter((x) => x.shared >= minShared)
    .sort((x, y) => {
      if (y.shared !== x.shared) return y.shared - x.shared;
      if (x.c.published_at !== y.c.published_at) return y.c.published_at.localeCompare(x.c.published_at);
      return x.c.article_id.localeCompare(y.c.article_id);
    })
    .slice(0, limit)
    .map((x) => x.c);
}

/**
 * state = { event, headlines: { c1..cN } }; questions[`c${i+1}`] copies the
 * blindspot_recall registry entry (byte-identical to cluster_member).
 * candidates.length === 0 => the empty-request shape (caller skips the
 * gateway call and writes only the day marker row).
 */
export function buildBlindspotRecallCall(
  cluster: JevBlindspotClusterRow,
  candidates: readonly JevBlindspotCandidate[],
): { request: JevRequest; keys: Record<string, string> } {
  if (candidates.length === 0) {
    return { request: { state: {}, questions: {} }, keys: {} };
  }

  const headlines: Record<string, string> = {};
  const keys: Record<string, string> = {};
  const questions: Record<string, JevQuestion> = {};

  candidates.forEach((candidate, i) => {
    const key = `c${i + 1}`;
    headlines[key] = clamp(candidate.title, JEV_TITLE_CLAMP);
    keys[key] = candidate.article_id;
    questions[key] = keyedBoolQuestion("blindspot_recall", key);
  });

  const state = { event: clamp(cluster.title, JEV_TITLE_CLAMP), headlines };
  return { request: { state, questions }, keys };
}

/**
 * Among keys whose f<k> probability >= JEV_BOOLEAN_THRESHOLD, picks the
 * lowest s<k> score; a tie is broken by earliest published_at. When no key
 * qualifies (no f<k> reached the threshold), falls back to the lowest s<k>
 * overall (same tiebreak). When no s<k> answer came back at all, returns
 * articleId: null (caller must write no neutral_pick row).
 */
export function pickNeutralArticleId(
  neutralKeys: Record<string, string>,
  order: readonly { key: string; published_at: string }[],
  answers: Record<string, JevAnswer>,
): { articleId: string | null; picks: Record<string, { s: number | null; f: number | null }> } {
  const publishedAtByKey = new Map(order.map((o) => [o.key, o.published_at]));
  const picks: Record<string, { s: number | null; f: number | null }> = {};

  interface Entry {
    key: string;
    articleId: string;
    s: number;
    f: number | null;
    publishedAt: string;
  }
  const withScore: Entry[] = [];

  for (const key of Object.keys(neutralKeys)) {
    const suffix = key.slice(1);
    const fAnswer = answers[`f${suffix}`];
    const sAnswer = answers[`s${suffix}`];
    const f = fAnswer && fAnswer.type === "boolean" ? fAnswer.probability : null;
    const s = sAnswer && sAnswer.type === "score" ? sAnswer.score : null;
    picks[key] = { s, f };
    if (s !== null) {
      withScore.push({
        key,
        articleId: neutralKeys[key]!,
        s,
        f,
        publishedAt: publishedAtByKey.get(key) ?? "",
      });
    }
  }

  if (withScore.length === 0) {
    return { articleId: null, picks };
  }

  function lowest(candidates: Entry[]): Entry {
    return candidates.reduce((best, cur) => {
      if (cur.s < best.s) return cur;
      if (cur.s === best.s && cur.publishedAt < best.publishedAt) return cur;
      return best;
    });
  }

  const qualifying = withScore.filter((e) => e.f !== null && e.f >= JEV_BOOLEAN_THRESHOLD);
  const winner = lowest(qualifying.length > 0 ? qualifying : withScore);
  return { articleId: winner.articleId, picks };
}

// ---------------------------------------------------------------------------
// Migration 066: frozen regression set -- pure functions only (no ports, no
// Date.now(), no I/O). Unit-tested directly in tests/functions/jev-shadow.test.ts.
// ---------------------------------------------------------------------------

/**
 * Rebuilds the JevArticleRow buildArticleCall reads its request from, using
 * ONLY the frozen item's title+description -- category/published_at/
 * source_slug are deliberately absent (null/"") so nothing but the frozen
 * bytes can reach the gateway.
 */
export function regressionArticleRow(item: JevRegressionItem): JevArticleRow {
  const state = item.state as { title?: unknown; description?: unknown };
  return {
    id: item.subject_id,
    title: String(state.title ?? ""),
    description: typeof state.description === "string" ? state.description : null,
    category: null,
    published_at: "",
    source_slug: null,
  };
}

/**
 * Reads state.pairs.p1.{a,b}. A malformed frozen row (missing or non-string
 * title on either side) is a skip, never a throw -- one bad frozen row must
 * never abort the whole regression_pairs stage. ids come from
 * subject_id.split(":") (["", ""] fallback when the format is unexpected);
 * cluster_id "" and published_at "" on both sides (the pair sampler/grouping
 * functions are never used in regression mode).
 */
export function regressionPair(item: JevRegressionItem): JevPair | null {
  const pairsField = (item.state as { pairs?: unknown }).pairs;
  const p1 = pairsField && typeof pairsField === "object" ? (pairsField as Record<string, unknown>).p1 : undefined;
  if (!p1 || typeof p1 !== "object") return null;
  const a = (p1 as Record<string, unknown>).a;
  const b = (p1 as Record<string, unknown>).b;
  if (typeof a !== "string" || typeof b !== "string") return null;

  const parts = item.subject_id.split(":");
  const [idA, idB] = parts.length === 2 ? parts : ["", ""];

  return {
    a: { id: idA ?? "", cluster_id: "", title: a, published_at: "" },
    b: { id: idB ?? "", cluster_id: "", title: b, published_at: "" },
  };
}

/**
 * Builds JevRegressionAnswerRow[] from a JevResponse, one row per key in
 * keyToTask present in response.answers -- a missing answer is skipped
 * silently (the 400-retry path can drop a question). boolean/score answers
 * are clamped with Math.min(round3(x), JEV_PROB_MAX_NUMERIC): an un-clamped
 * round3(9.9996) rounds to 10 and 22003s the numeric(4,3) column, killing
 * the whole insert chunk.
 */
export function regressionAnswerRows(
  runId: number,
  itemId: number,
  response: JevResponse,
  keyToTask: Readonly<Record<string, string>>,
): JevRegressionAnswerRow[] {
  const rows: JevRegressionAnswerRow[] = [];
  for (const [key, task] of Object.entries(keyToTask)) {
    const answer = response.answers[key];
    if (!answer) continue;
    if (answer.type === "boolean") {
      rows.push({
        run_id: runId,
        item_id: itemId,
        task,
        jev_prob: Math.min(round3(answer.probability), JEV_PROB_MAX_NUMERIC),
        jev_choice: null,
      });
    } else if (answer.type === "score") {
      rows.push({
        run_id: runId,
        item_id: itemId,
        task,
        jev_prob: Math.min(round3(answer.score), JEV_PROB_MAX_NUMERIC),
        jev_choice: null,
      });
    } else {
      rows.push({ run_id: runId, item_id: itemId, task, jev_prob: null, jev_choice: answer.choice });
    }
  }
  return rows;
}

/**
 * prev empty -> { first_run: true } and nothing else. Otherwise compares
 * ONLY (item_id, task) keys present in BOTH sides; a pair where one side is
 * a probability/score and the other a choice is skipped entirely (never
 * counted as a flip, never counted toward n). flip = threshold-crossing for
 * a prob pair, choice inequality for a choice pair. mean_abs_delta /
 * max_abs_delta are computed only over pairs where BOTH sides carry a
 * non-null jev_prob (null when there are none), both rounded to 3 decimals.
 * Score-typed tasks (JEV_SCORE_TASKS: jev_prob on a 0-10 scale, not [0,1])
 * still report n/mean_abs_delta/max_abs_delta but are EXCLUDED from `flips`
 * and from `overall.flip_rate`'s numerator/denominator -- a 0.5 threshold
 * crossing is meaningless on a 0-10 scale. A score task's emitted `flips: 0`
 * therefore means NOT SCORED, not zero drift; read mean/max_abs_delta for
 * its actual drift signal.
 */
export function computeRegressionDeltas(
  prev: readonly JevRegressionAnswerRow[],
  cur: readonly JevRegressionAnswerRow[],
): JevRegressionDeltas {
  if (prev.length === 0) return { first_run: true };

  const prevByKey = new Map<string, JevRegressionAnswerRow>();
  for (const row of prev) prevByKey.set(`${row.item_id}:${row.task}`, row);

  interface TaskAcc {
    n: number;
    flips: number;
    sum: number;
    max: number;
    deltaCount: number;
  }
  const tasks = new Map<string, TaskAcc>();
  const itemIds = new Set<number>();
  let totalCompared = 0;
  let totalFlips = 0;

  for (const c of cur) {
    const p = prevByKey.get(`${c.item_id}:${c.task}`);
    if (!p) continue;

    const pIsProb = p.jev_prob !== null;
    const cIsProb = c.jev_prob !== null;
    const pIsChoice = p.jev_choice !== null;
    const cIsChoice = c.jev_choice !== null;
    if (pIsProb !== cIsProb) continue; // one side prob, other choice -- skip entirely
    if (!pIsProb && !pIsChoice) continue; // neither side has an answer
    if (!cIsProb && !cIsChoice) continue;

    // Score-typed tasks (0-10 scale) never cross the [0,1] boolean threshold
    // meaningfully -- skip the flip comparison entirely rather than run it
    // against a 0-10 value.
    const isScore = JEV_SCORE_TASKS.has(c.task);
    const flip = isScore
      ? false
      : pIsProb
        ? (p.jev_prob! >= JEV_BOOLEAN_THRESHOLD) !== (c.jev_prob! >= JEV_BOOLEAN_THRESHOLD)
        : p.jev_choice !== c.jev_choice;

    let acc = tasks.get(c.task);
    if (!acc) {
      acc = { n: 0, flips: 0, sum: 0, max: 0, deltaCount: 0 };
      tasks.set(c.task, acc);
    }
    acc.n += 1;
    if (flip) acc.flips += 1;
    if (p.jev_prob !== null && c.jev_prob !== null) {
      const d = Math.abs(p.jev_prob - c.jev_prob);
      acc.sum += d;
      acc.max = Math.max(acc.max, d);
      acc.deltaCount += 1;
    }

    itemIds.add(c.item_id);
    if (!isScore) {
      totalCompared += 1;
      if (flip) totalFlips += 1;
    }
  }

  const outTasks: Record<string, JevRegressionTaskDelta> = {};
  for (const [task, acc] of tasks) {
    outTasks[task] = {
      n: acc.n,
      flips: acc.flips,
      mean_abs_delta: acc.deltaCount > 0 ? round3(acc.sum / acc.deltaCount) : null,
      max_abs_delta: acc.deltaCount > 0 ? round3(acc.max) : null,
    };
  }

  return {
    tasks: outTasks,
    overall: {
      items: itemIds.size,
      tasks: Object.keys(outTasks).length,
      flip_rate: totalCompared > 0 ? round3(totalFlips / totalCompared) : null,
    },
  };
}

/**
 * 'politika' -> "politics" | 'ekonomi' -> "economy" | 'dunya' -> null
 * (ambiguous, NOT scored wrong) | everything else -> "other". MUST stay
 * identical to jev_gold_scorecard()'s topic3 CTE (063) and topicBaseline()'s
 * dunya handling -- DB-1 parity.
 */
export function goldTopicToJevChoice(topic: string): string | null {
  if (topic === "politika") return "politics";
  if (topic === "ekonomi") return "economy";
  if (topic === "dunya") return null;
  return "other";
}

/**
 * Keeps one row per article_id where labeler 1 and labeler 2 both exist AND
 * agree on is_politics AND on topic. Disagreement is excluded, never
 * adjudicated.
 */
export function agreedGoldLabels(
  rows: readonly { article_id: string; labeler: number; is_politics: boolean; topic: string }[],
): JevGoldLabelRow[] {
  type LabelRow = { article_id: string; labeler: number; is_politics: boolean; topic: string };
  const byArticle = new Map<string, LabelRow[]>();
  for (const r of rows) {
    const list = byArticle.get(r.article_id);
    if (list) list.push(r);
    else byArticle.set(r.article_id, [r]);
  }

  const out: JevGoldLabelRow[] = [];
  for (const [articleId, list] of byArticle) {
    const l1 = list.find((r) => r.labeler === 1);
    const l2 = list.find((r) => r.labeler === 2);
    if (!l1 || !l2) continue;
    if (l1.is_politics !== l2.is_politics) continue;
    if (l1.topic !== l2.topic) continue;
    out.push({ article_id: articleId, is_politics: l1.is_politics, topic: l1.topic });
  }
  return out;
}

/**
 * Only items with in_gold === true && kind === "article", matched to a
 * label by subject_id === article_id. politics: n counts items with a label
 * and a non-null task='politics' jev_prob; correct_050/correct_070 compare
 * against JEV_BOOLEAN_THRESHOLD / JEV_GOLD_STRICT_THRESHOLD. topic: excludes
 * labels whose goldTopicToJevChoice is null; n counts the rest with a
 * non-null task='topic' jev_choice; correct = jev_choice === mapped topic.
 */
export function computeRegressionGold(
  items: readonly JevRegressionItem[],
  cur: readonly JevRegressionAnswerRow[],
  labels: readonly JevGoldLabelRow[],
): JevRegressionGold {
  const labelByArticle = new Map(labels.map((l) => [l.article_id, l]));
  const politicsByItem = new Map<number, number>();
  const topicByItem = new Map<number, string>();
  for (const row of cur) {
    if (row.task === "politics" && row.jev_prob !== null) politicsByItem.set(row.item_id, row.jev_prob);
    if (row.task === "topic" && row.jev_choice !== null) topicByItem.set(row.item_id, row.jev_choice);
  }

  let politicsN = 0;
  let correct050 = 0;
  let correct070 = 0;
  let topicN = 0;
  let topicCorrect = 0;

  for (const item of items) {
    if (!item.in_gold || item.kind !== "article") continue;
    const label = labelByArticle.get(item.subject_id);
    if (!label) continue;

    const prob = politicsByItem.get(item.id);
    if (prob !== undefined) {
      politicsN += 1;
      if ((prob >= JEV_BOOLEAN_THRESHOLD) === label.is_politics) correct050 += 1;
      if ((prob >= JEV_GOLD_STRICT_THRESHOLD) === label.is_politics) correct070 += 1;
    }

    const mappedTopic = goldTopicToJevChoice(label.topic);
    if (mappedTopic === null) continue;
    const choice = topicByItem.get(item.id);
    if (choice !== undefined) {
      topicN += 1;
      if (choice === mappedTopic) topicCorrect += 1;
    }
  }

  return {
    politics: { n: politicsN, correct_050: correct050, correct_070: correct070 },
    topic: { n: topicN, correct: topicCorrect },
  };
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
  /** Shallow-merged into jev_answer.answer -- e.g. neutral_pick's { picks }. */
  answerExtra?: Record<string, unknown>;
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
      answer: args.answerExtra ? { ...args.answer, ...args.answerExtra } : args.answer,
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
   * fetchClusterMembers has no per-task notion of "already asked", and
   * (063) by the neutral_pick anti-join over extractive-v1 clusters. */
  fetchSeenSubjects(task: string, subjectIds: readonly string[]): Promise<Set<string>>;
  fetchPendingArticles(sinceIso: string, limit: number): Promise<JevArticleRow[]>;
  fetchRecentClusters(sinceIso: string, limit: number): Promise<JevClusterRow[]>;
  fetchClusterMembers(clusterIds: readonly string[]): Promise<JevMemberRow[]>;
  fetchPairCandidates(sinceIso: string, limit: number): Promise<JevPairCandidate[]>;
  fetchPendingKap(sinceIso: string, limit: number): Promise<JevKapRow[]>;
  fetchPendingTitleVersions(sinceIso: string, limit: number): Promise<JevTitleRow[]>;
  /** (063) Members of clusters updated since sinceIso with >= 2 members, as
   * JevPairCandidate { id: article_id, cluster_id, title, published_at }.
   * Pair construction is pure and lives in sampleClusterPairs -- the port
   * only fetches. */
  fetchAuditPairs(sinceIso: string, clusterLimit: number): Promise<JevPairCandidate[]>;
  /** (063) Pending article_tickers matches, ANTI-JOINED on task
   * "ticker_relevance" over `${article_id}:${ticker}` BEFORE returning, or
   * every run re-pays the gateway for rows the upsert then silently
   * discards (the JEV-A10 lesson). */
  fetchPendingTickerMatches(sinceIso: string, limit: number): Promise<JevTickerRow[]>;
  /** Migration 064: queues (cluster, article) pairs a cluster_member
   * prediction scored below JEV_UNLINK_PROB_MAX for human review on /admin.
   * Returns the number of rows actually inserted (upsert, ignoreDuplicates
   * -- a re-ask of an already-queued pair is a no-op). */
  insertUnlinkCandidates(rows: readonly JevUnlinkCandidateRow[]): Promise<number>;
  /** Migration 064: blindspot clusters updated since sinceIso, most recent first. */
  fetchBlindspotClusters(sinceIso: string, limit: number): Promise<JevBlindspotClusterRow[]>;
  /** Migration 064: candidate headlines from the given (silent-zone) source
   * set, published inside [fromIso, toIso], excluding existing members. */
  fetchBlindspotCandidates(query: JevBlindspotCandidateQuery): Promise<JevBlindspotCandidate[]>;
  /** Migration 064: stamps clusters.blindspot_recall_checked_at (and, when
   * suspect, blindspot_recall_suspect = true) after every check. */
  markBlindspotChecked(clusterId: string, suspect: boolean): Promise<void>;
  /**
   * Optional per-failure hook (JEV-A13): called for every callOnce failure
   * that is NOT a rate limit (a rate limit is already visible via the run's
   * status). Without this, callOnce's catch discarded `err` entirely and
   * the only surviving trace was an integer in jev_shadow_runs.errors --
   * not actionable on the first run, when pack.md's SCORE QUESTION TYPE
   * UNVERIFIED risk specifically calls for watching this.
   *
   * SECURITY, non-negotiable, runtime-agnostic (this file must stay free of
   * any Deno-global, raw-fetch or npm-specifier reference -- the "[W1] zero
   * occurrences" acceptance bullet): an implementation must log only the
   * error's name/class, HTTP status and attempt count -- NEVER the
   * gateway's raw response text/JSON (a 401 body embeds an
   * API-key-creation URL, a 400 echoes request paths).
   */
  onError?(stage: string, err: unknown): void;

  // --- Migration 066: frozen regression set ---

  /** Frozen regression items of one kind, ordered by id ASC -- a
   * deadline-truncated run must always cover the SAME prefix as the last
   * one, so flip counts stay comparable run over run. */
  fetchRegressionItems(kind: JevRegressionItemKind, limit: number): Promise<JevRegressionItem[]>;
  /** Upsert on conflict (run_id, item_id, task) DO UPDATE -- a retried write
   * corrects instead of 23505-ing. Returns rows written. */
  insertRegressionAnswers(rows: readonly JevRegressionAnswerRow[]): Promise<number>;
  startRegressionRun(questionSet: string): Promise<number>;
  finishRegressionRun(
    id: number,
    patch: {
      finished_at: string;
      items: number;
      calls: number;
      input_tokens: number;
      status: JevRegressionRunStatus;
      deltas: JevRegressionDeltas | null;
      note: string | null;
    },
  ): Promise<void>;
  /** Answers of the most recent jev_regression_runs row with status='ok'
   * AND id < currentRunId; [] when there is none. MUST page: 400 articles x
   * 6 tasks + 100 pairs is 2500 rows, over PostgREST's 1000-row default --
   * an unpaged read would silently truncate the baseline and manufacture
   * flips. */
  fetchPreviousRegressionAnswers(currentRunId: number): Promise<JevRegressionAnswerRow[]>;
  /** Already agreement-filtered via agreedGoldLabels(). Chunk .in() by
   * JEV_ID_CHUNK (100). */
  fetchGoldLabels(articleIds: readonly string[]): Promise<JevGoldLabelRow[]>;
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
  /** Present only when this run opened a regression run row (mode
   * 'regression' and the monthly cap was not already exceeded). shadow/audit
   * responses are byte-unchanged -- this field is purely additive. */
  regression?: { run_id: number; items: number; deltas: JevRegressionDeltas | null };
}

type StageName =
  | "articles"
  | "clusters"
  | "blindspot_recall"
  | "pairs"
  | "kap"
  | "title_versions"
  | "tickers"
  | "audit_pairs"
  | "regression_articles"
  | "regression_pairs";

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
  mode: JevRunMode;
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
  /** Migration 066: non-null only when mode === 'regression' and a
   * regression run row was actually opened (never when the monthly cap was
   * already exceeded). */
  regression: {
    runId: number;
    items: JevRegressionItem[];
    answers: JevRegressionAnswerRow[];
    pending: JevRegressionAnswerRow[];
    /** Count of insertRegressionAnswers chunk failures (pushRegressionRows
     * + flushRegressionRows). Never fed by ctx.errors alone: a write-failed
     * run must not close 'ok' and become the next run's baseline. */
    writeErrors: number;
  } | null;
}

function emptyStageStats(): StageStats {
  return { calls: 0, rows: 0, errors: 0, skipped: 0 };
}

function makeCtx(ports: JevPorts, runId: number, t0: number, deadlineMs: number, cap: number, mode: JevRunMode): RunCtx {
  return {
    ports,
    runId,
    t0,
    deadlineMs,
    cap,
    mode,
    monthTokens: 0,
    calls: 0,
    errors: 0,
    runTokens: 0,
    rows: [],
    rowsInserted: 0,
    stopReason: null,
    callSeq: 0,
    failedStages: [],
    regression: null,
    stages: {
      articles: emptyStageStats(),
      clusters: emptyStageStats(),
      blindspot_recall: emptyStageStats(),
      pairs: emptyStageStats(),
      kap: emptyStageStats(),
      title_versions: emptyStageStats(),
      tickers: emptyStageStats(),
      audit_pairs: emptyStageStats(),
      regression_articles: emptyStageStats(),
      regression_pairs: emptyStageStats(),
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
 * Mirrors pushRows, writing through ctx.ports.insertRegressionAnswers in
 * chunks of JEV_REGRESSION_ANSWER_CHUNK -- but, unlike pushRows, every write
 * is BEST-EFFORT: a failed answer write must never turn a paid gateway call
 * into a thrown run. `stage` is always known at the call site (both
 * regression stage runners call this from inside their own processStage
 * worker), so a failure bumps that stage's error counter too.
 */
async function pushRegressionRows(
  ctx: RunCtx,
  stage: "regression_articles" | "regression_pairs",
  rows: readonly JevRegressionAnswerRow[],
): Promise<void> {
  if (!ctx.regression) return;
  ctx.regression.pending.push(...rows);
  while (ctx.regression.pending.length >= JEV_REGRESSION_ANSWER_CHUNK) {
    const chunk = ctx.regression.pending.splice(0, JEV_REGRESSION_ANSWER_CHUNK);
    try {
      await ctx.ports.insertRegressionAnswers(chunk);
    } catch (err) {
      ctx.errors += 1;
      ctx.stages[stage].errors += 1;
      ctx.regression.writeErrors += 1;
      try {
        ctx.ports.onError?.(stage, err);
      } catch {
        // A logging hook must never destabilize the run.
      }
    }
  }
}

/**
 * Mirrors flushRemaining, called once in runJevShadow's finally block after
 * both regression stages have run (or been cut short by the deadline) -- no
 * single stage is "in scope" here, so a failure bumps only ctx.errors and
 * reports through onError under the literal stage name "regression".
 */
async function flushRegressionRows(ctx: RunCtx): Promise<void> {
  if (!ctx.regression || ctx.regression.pending.length === 0) return;
  const chunk = ctx.regression.pending.splice(0, ctx.regression.pending.length);
  try {
    await ctx.ports.insertRegressionAnswers(chunk);
  } catch (err) {
    ctx.errors += 1;
    if (ctx.regression) ctx.regression.writeErrors += 1;
    try {
      ctx.ports.onError?.("regression", err);
    } catch {
      // A logging hook must never destabilize the run.
    }
  }
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

  const topic7Answer = response.answers.topic7;
  if (topic7Answer && topic7Answer.type === "choice") {
    const baseline7 = topic7Baseline(article.category);
    rows.push(
      predictionRow({
        ...common,
        task: "topic7",
        subjectType: "article",
        subjectId: article.id,
        questionId: "topic7",
        answer: topic7Answer,
        baseline: baseline7 ?? "unknown",
        agree: choiceAgrees(topic7Answer.choice, baseline7),
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

/**
 * Migration 064: cluster_member predictions the ensemble should NOT trust --
 * jev_prob strictly below JEV_UNLINK_PROB_MAX (0.35). Feeds
 * jev_unlink_candidates so a human can review on /admin; nothing is unlinked
 * automatically.
 */
export function unlinkCandidatesFromRows(rows: readonly JevPredictionRow[]): JevUnlinkCandidateRow[] {
  const out: JevUnlinkCandidateRow[] = [];
  for (const row of rows) {
    if (row.task === "cluster_member" && row.jev_prob !== null && row.jev_prob < JEV_UNLINK_PROB_MAX) {
      out.push({
        cluster_id: row.cluster_id!,
        article_id: row.article_id!,
        jev_prob: row.jev_prob!,
        source_task: "cluster_member",
      });
    }
  }
  return out;
}

/** One row per candidate answer: subject_id `${clusterId}:${articleId}`,
 * baseline "false" (the system says the silent zone did NOT cover it), so
 * agree is true exactly when the answer also lands below the 0.5 threshold. */
export function buildBlindspotRecallRows(
  runId: number,
  cluster: JevBlindspotClusterRow,
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
        task: "blindspot_recall",
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
        baseline: "false",
        agree: booleanAgrees(answer.probability, false),
        latencyMs,
        runId,
      }),
    );
  }
  return rows;
}

/** The per-(cluster, day) marker row: makes the anti-join hold even when a
 * cluster had zero ranked candidates that day, so the stage never re-asks it
 * within the same UTC day. Carries no real Jev answer -- jev_prob/jev_choice
 * null, agree null, zero latency/tokens. */
export function buildBlindspotDayRow(args: {
  runId: number;
  clusterId: string;
  day: string;
  candidates: number;
  stateHash: string;
  preview: string;
}): JevPredictionRow {
  return {
    task: "blindspot_recall",
    subject_type: "cluster",
    subject_id: `${args.clusterId}:${args.day}`,
    article_id: null,
    cluster_id: args.clusterId,
    state_hash: args.stateHash,
    jev_answer: { candidates: args.candidates, question_set: JEV_QUESTION_SET_VERSION, day: args.day },
    jev_prob: null,
    jev_choice: null,
    baseline_answer: "false",
    agree: null,
    latency_ms: 0,
    input_tokens: 0,
    model: JEV_MODEL,
    run_id: args.runId,
  };
}

function computeNeutralBaseline(members: readonly JevMemberRow[], titleTrNeutral: string | null): string {
  const target = (titleTrNeutral ?? "").trim();
  const match = members.find((m) => m.title.trim() === target);
  return match ? match.article_id : "unknown";
}

function buildNeutralPickRow(
  runId: number,
  cluster: JevClusterRow,
  pickedArticleId: string | null,
  picks: Record<string, { s: number | null; f: number | null }>,
  members: readonly JevMemberRow[],
  response: JevResponse,
  callId: string,
  hash: string,
  preview: string,
  latencyMs: number,
): JevPredictionRow | null {
  if (pickedArticleId === null) return null;

  const baselineArticleId = computeNeutralBaseline(members, cluster.title_tr_neutral);
  const agree = baselineArticleId === "unknown" ? null : baselineArticleId === pickedArticleId;

  return predictionRow({
    task: "neutral_pick",
    subjectType: "cluster",
    subjectId: cluster.id,
    articleId: null,
    clusterId: cluster.id,
    stateHash: hash,
    preview,
    questionId: "neutral_pick",
    callId,
    answer: { type: "choice", choice: pickedArticleId },
    answerExtra: { picks },
    response,
    baseline: baselineArticleId,
    agree,
    latencyMs,
    runId,
  });
}

function buildPairRows(
  runId: number,
  keys: Record<string, JevPair>,
  response: JevResponse,
  callId: string,
  hash: string,
  preview: string,
  latencyMs: number,
  task: "pair_negative" | "pair_positive" = "pair_negative",
): JevPredictionRow[] {
  const baselineBool = task === "pair_positive";
  const baseline = baselineBool ? "true" : "false";
  const rows: JevPredictionRow[] = [];
  for (const [key, pair] of Object.entries(keys)) {
    const answer = response.answers[key];
    if (!answer || answer.type !== "boolean") continue;
    rows.push(
      predictionRow({
        task,
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
        baseline,
        agree: booleanAgrees(answer.probability, baselineBool),
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

function buildTickerRows(
  runId: number,
  t: JevTickerRow,
  response: JevResponse,
  callId: string,
  hash: string,
  preview: string,
  latencyMs: number,
): JevPredictionRow[] {
  const rows: JevPredictionRow[] = [];
  const answer = response.answers.ticker_relevance;
  if (answer && answer.type === "boolean") {
    rows.push(
      predictionRow({
        task: "ticker_relevance",
        subjectType: "article",
        subjectId: `${t.article_id}:${t.ticker}`,
        articleId: t.article_id,
        clusterId: null,
        stateHash: hash,
        preview,
        questionId: "ticker_relevance",
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

  // (063) neutral_pick anti-join: one pick per cluster, ever -- batched over
  // every extractive-v1 cluster in this window, alongside the cluster_member
  // anti-join above.
  const extractiveClusterIds = clusters
    .filter((c) => c.title_neutral_model === JEV_NEUTRAL_MODEL_ID)
    .map((c) => c.id);
  const seenNeutral = await ctx.ports.fetchSeenSubjects("neutral_pick", extractiveClusterIds);

  await processStage(ctx, "clusters", clusters, async (cluster) => {
    const allMembers = byCluster.get(cluster.id) ?? [];
    const skipMemberIds = new Set(
      allMembers.filter((m) => seen.has(`${cluster.id}:${m.article_id}`)).map((m) => m.article_id),
    );
    const neutralPick = cluster.title_neutral_model === JEV_NEUTRAL_MODEL_ID && !seenNeutral.has(cluster.id);

    const { request, keys, neutralKeys } = buildClusterCall(cluster, allMembers, { neutralPick, skipMemberIds });
    if (Object.keys(keys).length === 0 && Object.keys(neutralKeys).length === 0) {
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

    // Migration 064: queue any cluster_member prediction Jev scored below
    // JEV_UNLINK_PROB_MAX for human review on /admin. Best-effort, exactly
    // like recordTokens above -- a failed queue write must never turn a
    // successful gateway call into a lost prediction row.
    const unlinkRows = unlinkCandidatesFromRows(rows);
    if (unlinkRows.length > 0) {
      try {
        await ctx.ports.insertUnlinkCandidates(unlinkRows);
      } catch (err) {
        ctx.errors += 1;
        ctx.ports.onError?.("clusters", err);
      }
    }

    if (Object.keys(neutralKeys).length > 0) {
      const ordered = orderMembers(allMembers);
      const order = ordered.map((m, i) => ({ key: `m${i + 1}`, published_at: m.published_at }));
      const { articleId, picks } = pickNeutralArticleId(neutralKeys, order, result.response.answers);
      const neutralRow = buildNeutralPickRow(
        ctx.runId,
        cluster,
        articleId,
        picks,
        ordered,
        result.response,
        callId,
        hash,
        preview,
        result.latencyMs,
      );
      if (neutralRow) rows.push(neutralRow);
    }

    ctx.stages.clusters.rows += rows.length;
    await pushRows(ctx, rows);
  });
}

/**
 * Migration 064, shadow mode only (audit mode never touches the four new
 * ports). For up to JEV_BLINDSPOT_CLUSTER_LIMIT recently-updated blindspot
 * clusters per run, asks whether the SILENT media zone actually published
 * the same event. One `<clusterId>:<day>` marker row per cluster per UTC
 * day makes the anti-join hold even when a cluster had zero ranked
 * candidates that day; a gateway failure writes NO marker row, so the next
 * run retries the cluster.
 */
async function runBlindspotRecallStage(ctx: RunCtx, nowMs: number): Promise<void> {
  const sinceIso = new Date(nowMs - JEV_BLINDSPOT_WINDOW_HOURS * 3600e3).toISOString();
  const clusters = await ctx.ports.fetchBlindspotClusters(sinceIso, JEV_BLINDSPOT_CLUSTER_LIMIT * 4);
  if (clusters.length === 0) return;

  const day = runDayKey(nowMs);
  const candidateSubjectIds = clusters.map((c) => `${c.id}:${day}`);
  const seen = await ctx.ports.fetchSeenSubjects("blindspot_recall", candidateSubjectIds);
  const eligible = clusters.filter((c) => !seen.has(`${c.id}:${day}`));
  ctx.stages.blindspot_recall.skipped += clusters.length - eligible.length;
  const survivors = eligible.slice(0, JEV_BLINDSPOT_CLUSTER_LIMIT);

  await processStage(ctx, "blindspot_recall", survivors, async (cluster) => {
    const zones = blindspotSilentZones(cluster.blindspot_side);
    if (zones.length === 0) {
      ctx.stages.blindspot_recall.skipped += 1;
      return;
    }
    const biasKeys = biasKeysForZones(zones);
    const fromIso = new Date(Date.parse(cluster.first_published) - JEV_BLINDSPOT_LOOKBACK_HOURS * 3600e3).toISOString();
    const toIso = new Date(
      Math.min(nowMs, Date.parse(cluster.first_published) + JEV_BLINDSPOT_FORWARD_HOURS * 3600e3),
    ).toISOString();
    const fetched = await ctx.ports.fetchBlindspotCandidates({
      clusterId: cluster.id,
      biasKeys,
      fromIso,
      toIso,
      limit: JEV_BLINDSPOT_CANDIDATE_FETCH,
    });
    const ranked = rankBlindspotCandidates(cluster.title, fetched);

    if (ranked.length === 0) {
      const emptyState = { event: clamp(cluster.title, JEV_TITLE_CLAMP), headlines: {} };
      const hash = await stateHash(emptyState);
      const preview = statePreview(emptyState);
      const dayRow = buildBlindspotDayRow({
        runId: ctx.runId,
        clusterId: cluster.id,
        day,
        candidates: 0,
        stateHash: hash,
        preview,
      });
      ctx.stages.blindspot_recall.rows += 1;
      await pushRows(ctx, [dayRow]);
      try {
        await ctx.ports.markBlindspotChecked(cluster.id, false);
      } catch (err) {
        ctx.stages.blindspot_recall.errors += 1;
        ctx.ports.onError?.("blindspot_recall", err);
      }
      return;
    }

    const { request, keys } = buildBlindspotRecallCall(cluster, ranked);
    const result = await callOnce(ctx, "blindspot_recall", request);
    if (!result) {
      // No marker row written -- the next run retries this cluster.
      ctx.stages.blindspot_recall.errors += 1;
      return;
    }
    ctx.stages.blindspot_recall.calls += 1;
    const hash = await stateHash(request.state);
    const preview = statePreview(request.state);
    const callId = nextCallId(ctx);
    const answerRows = buildBlindspotRecallRows(ctx.runId, cluster, keys, result.response, callId, hash, preview, result.latencyMs);
    const dayRow = buildBlindspotDayRow({
      runId: ctx.runId,
      clusterId: cluster.id,
      day,
      candidates: ranked.length,
      stateHash: hash,
      preview,
    });
    const rows = [...answerRows, dayRow];
    const suspect = rows.some((r) => (r.jev_prob ?? 0) >= JEV_BLINDSPOT_SUSPECT_PROB);

    ctx.stages.blindspot_recall.rows += rows.length;
    await pushRows(ctx, rows);
    try {
      await ctx.ports.markBlindspotChecked(cluster.id, suspect);
    } catch (err) {
      ctx.stages.blindspot_recall.errors += 1;
      ctx.ports.onError?.("blindspot_recall", err);
    }
  });
}

async function runPairsStage(ctx: RunCtx, sinceIso: string, sampleCount: number, candidateLimit: number): Promise<void> {
  const candidates = await ctx.ports.fetchPairCandidates(sinceIso, candidateLimit);
  const pairs = samplePairs(candidates, sampleCount, ctx.ports.random);
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

/** (063) audit mode's recall stage: pairs the clusterer DID put together, asked as task "pair_positive". */
async function runAuditPairsStage(ctx: RunCtx, sinceIso: string): Promise<void> {
  const rows = await ctx.ports.fetchAuditPairs(sinceIso, JEV_AUDIT_CLUSTER_LIMIT);
  const pairs = sampleClusterPairs(rows, JEV_AUDIT_PAIRS_PER_CLUSTER, JEV_AUDIT_PAIR_COUNT, ctx.ports.random);
  if (pairs.length === 0) {
    ctx.stages.audit_pairs.skipped += 1;
    return;
  }

  const chunks: JevPair[][] = [];
  for (let i = 0; i < pairs.length; i += JEV_PAIRS_PER_CALL) {
    chunks.push(pairs.slice(i, i + JEV_PAIRS_PER_CALL));
  }

  await processStage(ctx, "audit_pairs", chunks, async (chunk) => {
    const { request, keys } = buildPairCall(chunk, "pair_positive");
    const result = await callOnce(ctx, "audit_pairs", request);
    if (!result) {
      ctx.stages.audit_pairs.errors += 1;
      return;
    }
    ctx.stages.audit_pairs.calls += 1;
    const hash = await stateHash(request.state);
    const preview = statePreview(request.state);
    const callId = nextCallId(ctx);
    const rows = buildPairRows(ctx.runId, keys, result.response, callId, hash, preview, result.latencyMs, "pair_positive");
    ctx.stages.audit_pairs.rows += rows.length;
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

async function runTickersStage(ctx: RunCtx, sinceIso: string): Promise<void> {
  const items = await ctx.ports.fetchPendingTickerMatches(sinceIso, JEV_TICKER_LIMIT);
  await processStage(ctx, "tickers", items, async (t) => {
    const request = buildTickerCall(t);
    const result = await callOnce(ctx, "tickers", request);
    if (!result) {
      ctx.stages.tickers.errors += 1;
      return;
    }
    ctx.stages.tickers.calls += 1;
    const hash = await stateHash(request.state);
    const preview = statePreview(request.state);
    const callId = nextCallId(ctx);
    const rows = buildTickerRows(ctx.runId, t, result.response, callId, hash, preview, result.latencyMs);
    ctx.stages.tickers.rows += rows.length;
    await pushRows(ctx, rows);
  });
}

// --- Migration 066: frozen regression set -- stage runners ------------------

/**
 * Replays every frozen article item's seven article-shaped questions through
 * the SAME callOnce/processStage machinery shadow/audit mode use. Never
 * calls insertPredictions -- every answer goes through pushRegressionRows
 * (insertRegressionAnswers).
 */
async function runRegressionArticlesStage(ctx: RunCtx): Promise<void> {
  const items = await ctx.ports.fetchRegressionItems("article", JEV_REGRESSION_ITEM_LIMIT);
  if (items.length === 0) {
    ctx.stages.regression_articles.skipped += 1;
    return;
  }
  if (ctx.regression) ctx.regression.items.push(...items);

  const keyToTask: Readonly<Record<string, string>> = {
    politics: "politics",
    topic: "topic",
    topic7: "topic7",
    opinion: "opinion",
    clickbait: "clickbait",
    framing: "framing",
    sensational: "sensational",
  };

  await processStage(ctx, "regression_articles", items, async (item) => {
    const request = buildArticleCall(regressionArticleRow(item));
    const result = await callOnce(ctx, "regression_articles", request);
    if (!result) {
      ctx.stages.regression_articles.errors += 1;
      return;
    }
    ctx.stages.regression_articles.calls += 1;
    const runId = ctx.regression?.runId ?? ctx.runId;
    const rows = regressionAnswerRows(runId, item.id, result.response, keyToTask);
    ctx.stages.regression_articles.rows += rows.length;
    if (ctx.regression) ctx.regression.answers.push(...rows);
    await pushRegressionRows(ctx, "regression_articles", rows);
  });
}

/**
 * Replays frozen pair items JEV_PAIRS_PER_CALL at a time, task
 * "pair_negative" (the wording actually sent -- pair_positive is a
 * byte-identical copy). A malformed frozen pair (regressionPair returns
 * null) is dropped and counted as a skip, never a throw.
 */
async function runRegressionPairsStage(ctx: RunCtx): Promise<void> {
  const items = await ctx.ports.fetchRegressionItems("pair", JEV_REGRESSION_ITEM_LIMIT);

  const survivors: Array<{ item: JevRegressionItem; pair: JevPair }> = [];
  for (const item of items) {
    const pair = regressionPair(item);
    if (!pair) {
      ctx.stages.regression_pairs.skipped += 1;
      continue;
    }
    survivors.push({ item, pair });
  }
  if (survivors.length === 0) return;
  if (ctx.regression) ctx.regression.items.push(...survivors.map((s) => s.item));

  const chunks: Array<Array<{ item: JevRegressionItem; pair: JevPair }>> = [];
  for (let i = 0; i < survivors.length; i += JEV_PAIRS_PER_CALL) {
    chunks.push(survivors.slice(i, i + JEV_PAIRS_PER_CALL));
  }

  await processStage(ctx, "regression_pairs", chunks, async (chunk) => {
    const { request } = buildPairCall(chunk.map((entry) => entry.pair));
    const result = await callOnce(ctx, "regression_pairs", request);
    if (!result) {
      ctx.stages.regression_pairs.errors += 1;
      return;
    }
    ctx.stages.regression_pairs.calls += 1;
    const runId = ctx.regression?.runId ?? ctx.runId;
    const rows: JevRegressionAnswerRow[] = [];
    chunk.forEach((entry, i) => {
      const key = `p${i + 1}`;
      rows.push(...regressionAnswerRows(runId, entry.item.id, result.response, { [key]: "pair_negative" }));
    });
    ctx.stages.regression_pairs.rows += rows.length;
    if (ctx.regression) ctx.regression.answers.push(...rows);
    await pushRegressionRows(ctx, "regression_pairs", rows);
  });
}

/** JevRunStatus -> JevRegressionRunStatus per contract B4. */
function regressionRunStatus(status: JevRunStatus): JevRegressionRunStatus {
  if (status === "ok") return "ok";
  if (status === "error") return "error";
  return "partial"; // partial | rate_limited | budget_exceeded | running
}

/** Prefixes a jev_shadow_runs note with 'regression' in regression mode
 * only -- applied once, at the finishRun call site, so it also prefixes
 * 'monthly cap reached' and a caught error message. */
function withModeNote(mode: JevRunMode, note: string | null): string | null {
  if (mode !== "regression") return note;
  return note ? `regression; ${note}` : "regression";
}

/**
 * Computes deltas (against the previous 'ok' regression run) and, when at
 * least one in_gold article item exists, the gold comparison -- even on a
 * first run, which compares against humans, not a previous run. The whole
 * computation lives in its own try/catch that degrades to deltas = null on
 * any failure (JEV-B5): it must never prevent finishRegressionRun from
 * closing the row.
 */
async function closeRegressionRun(
  ctx: RunCtx,
  status: JevRunStatus,
): Promise<{ run_id: number; items: number; deltas: JevRegressionDeltas | null } | null> {
  if (!ctx.regression) return null;
  const { runId, items, answers } = ctx.regression;

  let deltas: JevRegressionDeltas | null = null;
  try {
    const prev = await ctx.ports.fetchPreviousRegressionAnswers(runId);
    deltas = computeRegressionDeltas(prev, answers);

    const goldArticleIds = items.filter((i) => i.in_gold && i.kind === "article").map((i) => i.subject_id);
    if (goldArticleIds.length > 0) {
      const labels = await ctx.ports.fetchGoldLabels(goldArticleIds);
      const gold = computeRegressionGold(items, answers, labels);
      deltas = { ...deltas, gold };
    }
  } catch (err) {
    deltas = null;
    ctx.errors += 1;
    try {
      ctx.ports.onError?.("regression_deltas", err);
    } catch {
      // A logging hook must never destabilize the run.
    }
  }

  const closeStatus =
    ctx.regression.writeErrors > 0 && regressionRunStatus(status) === "ok"
      ? "partial"
      : regressionRunStatus(status);

  // Short, plain-text reason the run closed non-'ok' (deadline, rate limit,
  // budget, a failed stage, or a failed insertRegressionAnswers chunk), so
  // an operator reading jev_regression_runs.note doesn't have to cross-check
  // the sibling jev_shadow_runs row. Never an error message, URL or gateway
  // text -- just the state already tracked on ctx/ctx.regression.
  const regressionNote =
    ctx.failedStages.length > 0
      ? `stage failed: ${ctx.failedStages.join(",")}`
      : ctx.regression.writeErrors > 0
        ? "answer writes failed"
        : null;

  try {
    await ctx.ports.finishRegressionRun(runId, {
      finished_at: new Date(ctx.ports.now()).toISOString(),
      items: items.length,
      calls: ctx.stages.regression_articles.calls + ctx.stages.regression_pairs.calls,
      input_tokens: ctx.runTokens,
      status: closeStatus,
      deltas,
      note: regressionNote,
    });
  } catch (err) {
    ctx.errors += 1;
    try {
      ctx.ports.onError?.("regression_close", err);
    } catch {
      // A logging hook must never destabilize the run.
    }
  }

  return { run_id: runId, items: items.length, deltas };
}

const HOUR_MS = 60 * 60 * 1000;

async function runStages(ctx: RunCtx, nowIso: string | undefined): Promise<void> {
  const nowMs = nowIso !== undefined ? Date.parse(nowIso) : ctx.ports.now();
  const sinceIso = new Date(nowMs - 24 * HOUR_MS).toISOString();
  const clusterSinceIso = new Date(nowMs - HOUR_MS).toISOString();

  const stageDefs: Array<{ name: StageName; run: () => Promise<void> }> =
    ctx.mode === "audit"
      ? [
          { name: "audit_pairs", run: () => runAuditPairsStage(ctx, sinceIso) },
          { name: "pairs", run: () => runPairsStage(ctx, sinceIso, JEV_AUDIT_PAIR_COUNT, JEV_AUDIT_CANDIDATE_LIMIT) },
        ]
      : ctx.mode === "regression"
        ? [
            { name: "regression_articles", run: () => runRegressionArticlesStage(ctx) },
            { name: "regression_pairs", run: () => runRegressionPairsStage(ctx) },
          ]
        : [
            { name: "articles", run: () => runArticlesStage(ctx, sinceIso) },
            { name: "clusters", run: () => runClustersStage(ctx, clusterSinceIso) },
            { name: "blindspot_recall", run: () => runBlindspotRecallStage(ctx, nowMs) },
            { name: "pairs", run: () => runPairsStage(ctx, sinceIso, JEV_PAIR_COUNT, PAIR_CANDIDATE_FETCH_LIMIT) },
            { name: "kap", run: () => runKapStage(ctx, sinceIso) },
            { name: "title_versions", run: () => runTitleStage(ctx, sinceIso) },
            { name: "tickers", run: () => runTickersStage(ctx, sinceIso) },
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
 *  - Shadow mode stages run articles -> clusters -> pairs -> kap ->
 *    title_versions -> tickers; audit mode runs audit_pairs -> pairs only,
 *    never touching the other five ports; regression mode (066) runs
 *    regression_articles -> regression_pairs only, replaying the frozen set
 *    through the SAME question text as shadow mode and writing answers to
 *    jev_regression_answers (never jev_shadow_predictions). Each stage
 *    checks its own deadline before it starts and between batches. Hitting
 *    the deadline stops cleanly with status 'partial' (never throws out of
 *    this function).
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
  opts: { deadlineMs?: number; cap?: number; nowIso?: string; mode?: JevRunMode } = {},
): Promise<JevShadowResult> {
  const t0 = ports.now();
  const deadlineMs = opts.deadlineMs ?? JEV_DEADLINE_MS;
  const cap = opts.cap ?? JEV_MONTHLY_TOKEN_CAP_DEFAULT;
  const mode: JevRunMode = opts.mode ?? "shadow";

  const month = await ports.monthTokens(cap);
  const runId = await ports.startRun();
  const ctx = makeCtx(ports, runId, t0, deadlineMs, cap, mode);
  ctx.monthTokens = month.input_tokens;

  let status: JevRunStatus = "ok";
  let note: string | null = null;
  let regressionResult: { run_id: number; items: number; deltas: JevRegressionDeltas | null } | null = null;

  try {
    if (month.exceeded) {
      status = "budget_exceeded";
      note = "monthly cap reached";
    } else {
      // Migration 066: open the regression run row BEFORE runStages, only
      // in regression mode and only once the month cap is known clear --
      // month.exceeded above must open NO regression run row and make ZERO
      // evaluate() calls.
      if (mode === "regression") {
        const regressionRunId = await ports.startRegressionRun(JEV_QUESTION_SET_VERSION);
        ctx.regression = { runId: regressionRunId, items: [], answers: [], pending: [], writeErrors: 0 };
      }
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
    // Order is load-bearing (contract B2): flushRegressionRows ->
    // closeRegressionRun -> flushRemaining -> finishRun. flushRegressionRows
    // is best-effort internally and never throws. closeRegressionRun is
    // also guaranteed not to throw: both its deltas computation AND its
    // finishRegressionRun call are individually try/caught (counting
    // ctx.errors and reporting via onError) so a PostgREST failure on
    // either can never prevent flushRemaining/finishRun below from
    // running.
    await flushRegressionRows(ctx);
    if (ctx.regression) {
      regressionResult = await closeRegressionRun(ctx, status);
    }

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
      note: withModeNote(mode, note),
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
    ...(regressionResult ? { regression: regressionResult } : {}),
  };
}
