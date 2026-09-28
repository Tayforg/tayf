// Migration 075 ("Küme dışı adaylar" triage) — pure constants, types and
// helpers shared by src/lib/admin/jev-cluster.ts, the bulk-keep API route,
// and the admin section component. Nothing here touches Supabase or
// Next.js, so it needs no mocking: tests/migrations/075-jev-unlink-triage
// .test.ts parses the migration's raw SQL and checks its literals against
// the constants below, so THESE are the source of truth, not the SQL file.
//
// Read the header of supabase/migrations/075_jev_unlink_triage.sql first —
// it explains the band, the dry-run guards and the deploy/kill-switch
// story this module's constants encode.

/** Below this Jev probability, a candidate is eligible for the
 * 'likely_unlink' band and for the dry-run auto-unlink evaluation. */
export const JEV_UNLINK_LIKELY_PROB_MAX = 0.1;

/** Below this word-Jaccard similarity (article title vs. cluster title),
 * combined with JEV_UNLINK_LIKELY_PROB_MAX, a candidate is 'likely_unlink'. */
export const JEV_UNLINK_LIKELY_JACCARD_MAX = 0.2;

/** The dry-run guard: a cluster smaller than this is never "would unlink". */
export const JEV_UNLINK_DRYRUN_MIN_CLUSTER = 4;

/** The dry-run guard: a pair_positive prediction at or above this probability
 * with another cluster member blocks "would unlink" (Jev thinks the pair
 * is the same event). */
export const JEV_UNLINK_PAIR_POSITIVE_MIN = 0.5;

/** The five reasons the dry-run refresh function can record, in the exact
 * order the SQL CHECK constraint and the `array[...]` literal use. */
export const JEV_UNLINK_SKIP_REASONS = [
  "not_member",
  "small_cluster",
  "earliest_member",
  "pair_positive",
  "title_match",
] as const;

export type JevUnlinkSkipReason = (typeof JEV_UNLINK_SKIP_REASONS)[number];

/** Turkish labels for each skip reason, used by the dry-run block. */
export const JEV_UNLINK_SKIP_REASON_LABELS: Record<JevUnlinkSkipReason, string> = {
  not_member: "artık kümede değil",
  small_cluster: "küme 4 haberden küçük",
  earliest_member: "kümenin ilk haberi",
  pair_positive: "Jev başka bir üyeyle aynı olay dedi",
  title_match: "başlık küme başlığıyla aynı",
};

/** Max ids accepted by one bulk "Kalsın" request. */
export const JEV_UNLINK_BULK_MAX = 50;

/** Below this many decided (unlinked/kept) rows, a precision line reads
 * "henüz yok" instead of a percentage — too few samples to mean anything. */
export const JEV_UNLINK_PRECISION_MIN_N = 10;

/** Row cap for the dry-run table read (mirrors the SQL refresh's own cap). */
export const JEV_UNLINK_DRYRUN_READ_LIMIT = 500;

export type JevUnlinkBand = "likely_unlink" | "review";

export function isJevUnlinkBand(value: unknown): value is JevUnlinkBand {
  return value === "likely_unlink" || value === "review";
}

/**
 * Validates a bulk-keep id list: must be an array, deduped, 1-50 entries,
 * every entry a positive safe integer. Anything else returns null so the
 * caller can 400 uniformly.
 */
export function parseBulkKeepIds(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;

  const deduped = Array.from(new Set(v));
  if (deduped.length === 0 || deduped.length > JEV_UNLINK_BULK_MAX) return null;

  const ids: number[] = [];
  for (const entry of deduped) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) {
      return null;
    }
    ids.push(entry);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// summariseDryRun
// ---------------------------------------------------------------------------

/**
 * A to-one PostgREST embed can arrive as an object, a one-element array, or
 * null/undefined. Same normalisation discipline as jev-cluster.ts's `one()`.
 */
type Embed<T> = T | T[] | null | undefined;

function embedOne<T extends object>(embed: Embed<T>): T | null {
  const first = Array.isArray(embed) ? (embed[0] ?? null) : (embed ?? null);
  return first && typeof first === "object" ? first : null;
}

function asFiniteNumber(v: unknown): number | null {
  // A7 lesson (jev-cluster.ts): Number(null) is 0, not NaN, so null/undefined
  // must be rejected before the Number.isFinite guard or a genuinely missing
  // title_jaccard silently becomes 0 instead of null.
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

interface CandidateEmbed {
  status?: unknown;
  article?: Embed<{ title?: unknown }>;
  cluster?: Embed<{ title_tr?: unknown; title_tr_neutral?: unknown }>;
}

export interface RawDryRunRow {
  candidate_id?: unknown;
  jev_prob?: unknown;
  title_jaccard?: unknown;
  cluster_size?: unknown;
  would_unlink?: unknown;
  skip_reasons?: unknown;
  first_evaluated_at?: unknown;
  candidate?: Embed<CandidateEmbed>;
}

export interface JevUnlinkDryRunRecentRow {
  candidateId: number;
  articleTitle: string;
  clusterTitle: string;
  jevProb: number;
  titleJaccard: number | null;
  wouldUnlink: boolean;
  skipReasons: JevUnlinkSkipReason[];
}

interface PolicyBucket {
  decided: number;
  unlinked: number;
  kept: number;
  pending: number;
  precision: number | null;
}

export interface JevUnlinkDryRunSummary {
  evaluated: number;
  wouldUnlink: number;
  guarded: number;
  reasons: Record<JevUnlinkSkipReason, number>;
  policyA: PolicyBucket;
  policyB: PolicyBucket;
  recent: JevUnlinkDryRunRecentRow[];
  truncated: boolean;
}

function emptyReasonTally(): Record<JevUnlinkSkipReason, number> {
  return {
    not_member: 0,
    small_cluster: 0,
    earliest_member: 0,
    pair_positive: 0,
    title_match: 0,
  };
}

function emptyPolicyBucket(): PolicyBucket {
  return { decided: 0, unlinked: 0, kept: 0, pending: 0, precision: null };
}

interface NormalisedDryRunRow {
  candidateId: number;
  status: string | null;
  articleTitle: string;
  clusterTitle: string;
  jevProb: number;
  titleJaccard: number | null;
  wouldUnlink: boolean;
  skipReasons: JevUnlinkSkipReason[];
}

function preferredClusterTitle(cluster: { title_tr?: unknown; title_tr_neutral?: unknown } | null): string {
  if (!cluster) return "(başlıksız)";
  const neutral = asStringOrNull(cluster.title_tr_neutral);
  if (neutral) return neutral;
  return asStringOrNull(cluster.title_tr) ?? "(başlıksız)";
}

function normaliseRow(row: RawDryRunRow): NormalisedDryRunRow | null {
  const candidateId = asFiniteNumber(row.candidate_id);
  if (candidateId === null) return null;

  const candidate = embedOne(row.candidate);
  const article = candidate ? embedOne(candidate.article) : null;
  const cluster = candidate ? embedOne(candidate.cluster) : null;

  const rawReasons = Array.isArray(row.skip_reasons) ? row.skip_reasons : [];
  const skipReasons = rawReasons.filter((r): r is JevUnlinkSkipReason =>
    (JEV_UNLINK_SKIP_REASONS as readonly string[]).includes(r as string),
  );

  return {
    candidateId,
    status: candidate ? asStringOrNull(candidate.status) : null,
    articleTitle: article ? (asStringOrNull(article.title) ?? "") : "",
    clusterTitle: preferredClusterTitle(cluster),
    jevProb: asFiniteNumber(row.jev_prob) ?? 0,
    titleJaccard: asFiniteNumber(row.title_jaccard),
    wouldUnlink: row.would_unlink === true,
    skipReasons,
  };
}

function bucketFor(rows: NormalisedDryRunRow[]): PolicyBucket {
  const bucket = emptyPolicyBucket();
  for (const row of rows) {
    if (row.status === "unlinked") bucket.unlinked += 1;
    else if (row.status === "kept") bucket.kept += 1;
    else bucket.pending += 1;
  }
  bucket.decided = bucket.unlinked + bucket.kept;
  bucket.precision =
    bucket.decided < JEV_UNLINK_PRECISION_MIN_N ? null : bucket.unlinked / bucket.decided;
  return bucket;
}

/**
 * Turns the raw jev_unlink_dryrun (+ embedded candidate/article/cluster)
 * rows into the counts, reason tally and precision lines the dry-run block
 * shows. Never throws: tolerates object, array and null embed shapes, and
 * any malformed row is simply skipped rather than blowing up the page.
 */
export function summariseDryRun(rows: unknown): JevUnlinkDryRunSummary {
  const rawRows = Array.isArray(rows) ? (rows as RawDryRunRow[]) : [];
  const normalised = rawRows
    .map(normaliseRow)
    .filter((r): r is NormalisedDryRunRow => r !== null);

  const reasons = emptyReasonTally();
  let wouldUnlink = 0;
  for (const row of normalised) {
    if (row.wouldUnlink) {
      wouldUnlink += 1;
    } else {
      for (const reason of row.skipReasons) {
        reasons[reason] += 1;
      }
    }
  }

  const wouldUnlinkRows = normalised.filter((r) => r.wouldUnlink);
  const policyBRows = wouldUnlinkRows.filter(
    (r) => r.titleJaccard !== null && r.titleJaccard < JEV_UNLINK_LIKELY_JACCARD_MAX,
  );

  return {
    evaluated: normalised.length,
    wouldUnlink,
    guarded: normalised.length - wouldUnlink,
    reasons,
    policyA: bucketFor(wouldUnlinkRows),
    policyB: bucketFor(policyBRows),
    recent: normalised.slice(0, 10).map((row) => ({
      candidateId: row.candidateId,
      articleTitle: row.articleTitle,
      clusterTitle: row.clusterTitle,
      jevProb: row.jevProb,
      titleJaccard: row.titleJaccard,
      wouldUnlink: row.wouldUnlink,
      skipReasons: row.skipReasons,
    })),
    truncated: rawRows.length >= JEV_UNLINK_DRYRUN_READ_LIMIT,
  };
}
