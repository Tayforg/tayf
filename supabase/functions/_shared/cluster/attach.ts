// supabase/functions/_shared/cluster/attach.ts
//
// The deterministic, attach-only admission of hunt-25 W3 (h25-clusters-3,
// migration 151). Pure: no I/O, no clock, no randomness, and no way to create a
// cluster.
//
// WHY. The politics gate is decided per article (category politika/son_dakika
// reaches cluster_work, everything else does not), so one story split: nine
// identical or near-identical FETO-operation headlines from hurriyet, cnn-turk,
// trt-haber, karar and others sat in genel next to the 13-member cluster 304a47ce.
// This module answers one question for such an article: "which EXISTING politics
// cluster does it belong to?" -- and refuses in every case of doubt.
//
// WHAT COUNTS AS EVIDENCE (three kinds, nothing else):
//   exact-title   the folded headline equals a member's (3 or more tokens);
//   fingerprint   the strict fingerprint equals a member's;
//   headline      the headline lane fires against a member (Jaccard or
//                 containment, >= HEADLINE_LANE_MIN_SHARED shared tokens, numerals
//                 consistent, size guard on containment), scored by
//                 headlineOnlyScore -- which is 0 for a pair whose two headlines name
//                 different actors (actorMismatchFires), so that pair is no evidence.
// All three need the member to be within HEADLINE_LANE_MAX_HOURS of the article.
// The live-title variant ("CANLI | ...") and the short-identical variant (fewer
// than HEADLINE_LANE_MIN_SHARED shared tokens) are NOT evidence here.
//
// WHAT IT REFUSES (reasons):
//   no-source     the article has no source, so the same-source rule cannot run;
//   stale         (opt-in via nowMs) the article is older than the lane window;
//   no-match      no member of any candidate is evidence;
//   below-share   every matching cluster holds < ATTACH_MIN_POLITICS_SHARE politics
//                 members (the reader would not show it as politics);
//   same-source   the best matching cluster already holds the article's source;
//   ambiguous     a second politics cluster matches within ATTACH_AMBIGUITY_MARGIN
//                 of the best one (twin clusters are not this path's to pick).
//
// Keep this module free of the scorer's other lanes: the test pins that it imports
// nothing but the headline lane, the lane constants and the folding helper.
//
// The Edge runtime and tsc both compile it; relative .ts imports, same discipline as
// ensemble.ts.

import { HEADLINE_LANE_MAX_HOURS, HEADLINE_LANE_MIN_SHARED } from "./constants.ts";
import { headlineLane, headlineOnlyScore } from "./ensemble.ts";
import { normalizeTurkish, type HeadlineTokens } from "./fingerprint.ts";

// A cluster is a politics cluster for the reader when at least this share of its
// members count as politics (src/lib/clusters/politics-query.ts, POLITICS_THRESHOLD;
// a test pins the equality).
export const ATTACH_MIN_POLITICS_SHARE = 0.6;

// Two matching politics clusters whose scores are this close are ambiguous.
export const ATTACH_AMBIGUITY_MARGIN = 0.05;

// A headline with fewer distinct tokens than this ("CANLI", "SON DAKIKA") is too
// generic to be an identity key (the same floor as the consumer's title probe).
export const ATTACH_MIN_TITLE_TOKENS = 3;

// At most this many attach messages are read per drain, and only after cluster_work
// ran dry (planAttachRead): the attach queue must never starve politika work.
// The measured peak is 467 candidates an hour (7.8 a minute) against 25 a drain.
export const ATTACH_MAX_PER_DRAIN = 25;

// The budget that must remain before the attach queue is read at all. Equal to the
// consumer's READ_BUDGET_FLOOR_MS (a test pins the equality): pgmq bumps read_ct
// on every read, so reading with the budget nearly spent walks healthy messages
// toward the poison threshold.
export const ATTACH_READ_FLOOR_MS = 5_000;

export type AttachLane = "exact-title" | "fingerprint" | "headline";

export type AttachReason =
  | "no-match"
  | "no-source"
  | "below-share"
  | "same-source"
  | "ambiguous"
  | "stale";

/** One article of a candidate cluster, or the incoming article itself. */
export interface AttachMember {
  id: string;
  sourceId: string | null;
  title: string;
  tokens: HeadlineTokens;
  publishedMs: number;
  fingerprint: string | null;
}

export type AttachArticle = AttachMember;

export interface AttachCandidate {
  clusterId: string;
  /** Share of the cluster's members that count as politics, 0..1. */
  politicsShare: number;
  /** Every source that already has a member in the cluster. */
  sourceIds: ReadonlySet<string> | readonly string[];
  articleCount: number;
  /** The members to compare with (the newest few plus seed and latest). */
  members: readonly AttachMember[];
}

export type AttachDecision =
  | { clusterId: string; score: number; lane: AttachLane }
  | { reason: AttachReason };

interface Evidence {
  score: number;
  lane: AttachLane;
}

interface Matched {
  candidate: AttachCandidate;
  evidence: Evidence;
}

const HOUR_MS = 3_600_000;

/** True when the article's own time is outside the lane window at `nowMs`
 * (or not a number). */
export function attachIsStale(publishedMs: number, nowMs: number): boolean {
  if (!Number.isFinite(publishedMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - publishedMs > HEADLINE_LANE_MAX_HOURS * HOUR_MS;
}

// The better of two pieces of evidence: higher score first, then the stronger kind.
const LANE_RANK: Record<AttachLane, number> = { "exact-title": 3, fingerprint: 2, headline: 1 };

function better(a: Evidence, b: Evidence | null): boolean {
  if (b === null) return true;
  if (a.score !== b.score) return a.score > b.score;
  return LANE_RANK[a.lane] > LANE_RANK[b.lane];
}

function memberEvidence(
  article: AttachArticle,
  articleKey: string,
  member: AttachMember,
  hours: number,
): Evidence | null {
  // exact-title: the folded headline is the same. Equal folded titles give equal
  // token sets, so a size mismatch rules a pair out without folding the member.
  if (
    articleKey !== "" &&
    member.tokens.tokens.size === article.tokens.tokens.size &&
    normalizeTurkish(member.title) === articleKey
  ) {
    return { score: 1, lane: "exact-title" };
  }
  // fingerprint: an empty or null hash is never a key.
  if (article.fingerprint && article.fingerprint === member.fingerprint) {
    return { score: 1, lane: "fingerprint" };
  }
  // headline lane, minus the variants that are too thin to attach on.
  const lane = headlineLane(article.tokens, member.tokens, hours);
  if (!lane.fired || lane.kind === "live-title" || lane.shared < HEADLINE_LANE_MIN_SHARED) return null;
  // With both titles headlineOnlyScore is 0 for a pair that names different actors
  // (h70-mergequality-3: "Erdogan, Karabag Zaferi'nin ..." against a comma-less
  // "AK Parti Sozcusu Celik Karabag Zaferi'nin ..."): no headline evidence then.
  const score = headlineOnlyScore(article.tokens, member.tokens, hours, {
    aTitle: article.title,
    bTitle: member.title,
  });
  return score > 0 ? { score, lane: "headline" } : null;
}

function candidateEvidence(
  article: AttachArticle,
  articleKey: string,
  candidate: AttachCandidate,
): Evidence | null {
  let best: Evidence | null = null;
  for (const member of candidate.members) {
    if (member.id === article.id) continue;
    if (!Number.isFinite(member.publishedMs)) continue;
    const hours = Math.abs(article.publishedMs - member.publishedMs) / HOUR_MS;
    if (hours > HEADLINE_LANE_MAX_HOURS) continue;
    const ev = memberEvidence(article, articleKey, member, hours);
    if (ev !== null && better(ev, best)) best = ev;
  }
  return best;
}

function holdsSource(candidate: AttachCandidate, sourceId: string): boolean {
  const ids = candidate.sourceIds;
  if (Array.isArray(ids) ? ids.includes(sourceId) : (ids as ReadonlySet<string>).has(sourceId)) return true;
  for (const member of candidate.members) {
    if (member.sourceId === sourceId) return true;
  }
  return false;
}

function shareOk(candidate: AttachCandidate): boolean {
  return Number.isFinite(candidate.politicsShare) && candidate.politicsShare >= ATTACH_MIN_POLITICS_SHARE;
}

/**
 * Decides which existing cluster, if any, the article may be attached to. See the
 * header for the evidence and the refusal reasons. Deterministic: the result does
 * not depend on the order of `candidates`. `nowMs` is optional; when given, an
 * article older than the lane window is refused as "stale" before any matching.
 */
export function attachDecision(
  article: AttachArticle,
  candidates: readonly AttachCandidate[],
  opts: { nowMs?: number } = {},
): AttachDecision {
  if (!article.sourceId) return { reason: "no-source" };
  if (!Number.isFinite(article.publishedMs)) return { reason: "no-match" };
  if (opts.nowMs !== undefined && attachIsStale(article.publishedMs, opts.nowMs)) {
    return { reason: "stale" };
  }

  const identifiable = article.tokens.tokens.size >= ATTACH_MIN_TITLE_TOKENS;
  const articleKey = identifiable ? normalizeTurkish(article.title) : "";

  const matched: Matched[] = [];
  for (const candidate of candidates) {
    const evidence = candidateEvidence(article, articleKey, candidate);
    if (evidence !== null) matched.push({ candidate, evidence });
  }
  if (matched.length === 0) return { reason: "no-match" };

  // Best first; ties go to the larger cluster, then to the smaller id, so the order
  // of the input never matters.
  matched.sort((a, b) =>
    b.evidence.score - a.evidence.score ||
    (Number(b.candidate.articleCount) || 0) - (Number(a.candidate.articleCount) || 0) ||
    (a.candidate.clusterId < b.candidate.clusterId ? -1 : a.candidate.clusterId > b.candidate.clusterId ? 1 : 0)
  );

  const politics = matched.filter((m) => shareOk(m.candidate));
  if (politics.length === 0) return { reason: "below-share" };

  const sourceFree = politics.filter((m) => !holdsSource(m.candidate, article.sourceId as string));
  if (sourceFree.length === 0) return { reason: "same-source" };

  // The answer is the best politics cluster. If a different politics cluster -- one
  // that holds the source or not -- is almost as good, the story has twin clusters
  // and this path does not pick between them.
  const top = sourceFree[0]!;
  const rival = politics.find((m) =>
    m.candidate.clusterId !== top.candidate.clusterId &&
    Math.abs(top.evidence.score - m.evidence.score) <= ATTACH_AMBIGUITY_MARGIN + 1e-9
  );
  if (rival) return { reason: "ambiguous" };
  // The best politics cluster overall holds the source and a weaker one does not:
  // the article duplicates a member of the stronger cluster, so it is not attached.
  if (politics[0]!.candidate.clusterId !== top.candidate.clusterId) {
    return { reason: "same-source" };
  }

  return { clusterId: top.candidate.clusterId, score: top.evidence.score, lane: top.evidence.lane };
}

/**
 * How many attach messages to read this drain: 0 unless the cluster_work read
 * came back short (nothing more visible) AND at least `floorMs` (default
 * ATTACH_READ_FLOOR_MS) of the budget remains; never more than
 * ATTACH_MAX_PER_DRAIN, never more than `cap`; always an integer. Total over
 * non-finite input (NaN, Infinity) -- those mean 0, except an infinite cap, which
 * is clamped to the maximum.
 */
export function planAttachRead(p: {
  clusterWorkEmpty: boolean;
  elapsedMs: number;
  budgetMs: number;
  cap: number;
  floorMs?: number;
}): number {
  if (p.clusterWorkEmpty !== true) return 0;
  if (!Number.isFinite(p.elapsedMs) || !Number.isFinite(p.budgetMs)) return 0;
  const floor = p.floorMs ?? ATTACH_READ_FLOOR_MS;
  if (!Number.isFinite(floor)) return 0;
  if (p.budgetMs - p.elapsedMs < floor) return 0;
  if (typeof p.cap !== "number" || Number.isNaN(p.cap)) return 0;
  const qty = Math.floor(Math.min(p.cap, ATTACH_MAX_PER_DRAIN));
  return qty >= 1 ? qty : 0;
}
