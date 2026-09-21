// supabase/functions/_shared/archive.ts
//
// Tayf Arşiv (M-10): the pure, runtime-agnostic half of the nightly export.
// Everything here runs unchanged under Deno (archive-export/index.ts) and
// under vitest on Node 24 (tests/functions/archive-export.test.ts) -- no
// Deno.* API, no supabase-js import. The Edge Function wires a Supabase
// service-role client into the `ArchivePorts` interface at the bottom, so
// the export algorithm (paging, hashing, manifest, idempotency) is testable
// with plain in-memory fakes.
//
// What gets exported, per UTC day: clusters whose first_published falls in
// [day 00:00Z, day+1 00:00Z), and their member articles -- headlines and
// URLs only (see migration 060 for the retention/legal note).

import { BIAS_TO_ZONE, type BiasKey, type MediaDnaZone } from "./cluster/blindspot.ts";

export const ARCHIVE_BUCKET = "tayf-archive";
export const ARCHIVE_SCHEMA = "tayf-archive/1";
/** PostgREST rows per page -- the same bound ingest uses for its drains. */
export const ARCHIVE_PAGE_SIZE = 1000;
/** Cluster ids per `in (...)` article query; keeps the URL well under 8 KB. */
export const ARCHIVE_ID_CHUNK = 100;
/** Same wall-clock budget as ingest's CYCLE_DEADLINE_MS. */
export const ARCHIVE_DEADLINE_MS = 50_000;

// P12 (migration 065): each exported article is enriched with a `labels`
// object read from jev_shadow_predictions -- one model's shadow answers
// under a pinned question set, declared as such in the manifest. Zero
// gateway calls: this only reads rows jev-shadow already wrote.
export const ARCHIVE_LABEL_TASKS = ["politics", "topic", "clickbait", "framing", "sensational"] as const;
export const ARCHIVE_LABEL_SOURCE = "typesafe-ai/jev via jev-shadow";

export interface ArchiveCluster {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  title_neutral_model: string | null;
  article_count: number;
  is_blindspot: boolean;
  blindspot_side: string | null;
  is_archived: boolean;
  bias_distribution: Record<string, number> | null;
  first_published: string;
}

/**
 * One article's shadow-model labels. All six fields are null when jev-shadow
 * has not produced a prediction for the article yet -- a miss is never an
 * error and never drops the article from the export.
 */
export interface ArchiveLabels {
  question_set: string | null;
  politics_p: number | null; // task 'politics'  -> jev_prob
  topic: string | null; // task 'topic'     -> jev_choice
  clickbait_p: number | null; // task 'clickbait' -> jev_prob
  framing: string | null; // task 'framing'   -> jev_choice
  sensational: number | null; // task 'sensational' -> jev_prob (RAW 0..3, NOT normalised)
}

/** A fresh, all-null ArchiveLabels object. Never share/freeze one instance --
 * every article gets its own so a future mutation bug can't silently alias
 * across the export. */
export function emptyLabels(): ArchiveLabels {
  return {
    question_set: null,
    politics_p: null,
    topic: null,
    clickbait_p: null,
    framing: null,
    sensational: null,
  };
}

export interface ArchiveArticle {
  article_id: string;
  cluster_id: string;
  source: string | null;
  zone: MediaDnaZone | null;
  title: string;
  url: string;
  published_at: string;
  labels: ArchiveLabels;
}

export interface ArchiveFile {
  name: string;
  sha256: string;
  rows: number;
  bytes: number;
}

export interface ArchiveManifestLabels {
  source: typeof ARCHIVE_LABEL_SOURCE;
  question_set: string | null; // most common non-null question_set; ties broken lexicographically ascending
  coverage: number; // (# articles with labels.politics_p !== null) / articles.length, 3dp, 0 when empty
  declared: true;
}

export interface ArchiveManifest {
  schema: typeof ARCHIVE_SCHEMA;
  day: string;
  generated_at: string;
  files: ArchiveFile[];
  rows: number;
  bytes: number;
  labels: ArchiveManifestLabels;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` for the UTC day before `now`. */
export function previousUtcDay(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return d.toISOString().slice(0, 10);
}

/** True for a well-formed `YYYY-MM-DD` that round-trips through Date.UTC. */
export function isValidDay(day: unknown): day is string {
  if (typeof day !== "string" || !DAY_RE.test(day)) return false;
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.toISOString().slice(0, 10) === day;
}

/** Half-open UTC bounds `[start, end)` as ISO strings. */
export function dayBounds(day: string): { start: string; end: string } {
  const [y, m, d] = day.split("-").map(Number);
  const start = new Date(Date.UTC(y!, m! - 1, d!));
  const end = new Date(Date.UTC(y!, m! - 1, d! + 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/** `YYYY/MM/DD` -- the object prefix inside the bucket. */
export function objectPrefix(day: string): string {
  return day.replaceAll("-", "/");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * One JSON object per line, keys sorted recursively so the same rows always
 * hash the same. Empty input encodes to the empty string (no stray newline).
 */
export function toJsonl(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  return rows.map((r) => JSON.stringify(sortKeys(r))).join("\n") + "\n";
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function buildManifest(
  day: string,
  generatedAt: string,
  files: ArchiveFile[],
  labels: ArchiveManifestLabels,
): ArchiveManifest {
  // Key order here IS manifest.json's key order (JSON.stringify(manifest,
  // null, 2) is not key-sorted): schema, day, generated_at, files, rows,
  // bytes, labels. Do not reorder without checking (h) in the test suite.
  return {
    schema: ARCHIVE_SCHEMA,
    day,
    generated_at: generatedAt,
    files,
    rows: files.reduce((n, f) => n + f.rows, 0),
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    labels,
  };
}

/**
 * Coverage/question_set summary for the manifest's `labels` block. Coverage
 * is measured by `politics_p` (every article gets a politics prediction in
 * the normal run) not by "has any label at all", so a partially-labelled day
 * reports a meaningful fraction rather than always 1.0.
 */
export function summariseLabels(articles: readonly ArchiveArticle[]): ArchiveManifestLabels {
  if (articles.length === 0) {
    return { source: ARCHIVE_LABEL_SOURCE, question_set: null, coverage: 0, declared: true };
  }
  let withPolitics = 0;
  const counts = new Map<string, number>();
  for (const a of articles) {
    if (a.labels.politics_p !== null) withPolitics++;
    if (a.labels.question_set !== null) {
      counts.set(a.labels.question_set, (counts.get(a.labels.question_set) ?? 0) + 1);
    }
  }
  // Determinism is the point: two runs over the same day must produce the
  // same manifest hash, so ties break on the question_set string itself,
  // not on Map/array iteration order.
  const ranked = [...counts.entries()].sort(([qsA, nA], [qsB, nB]) => nB - nA || (qsA < qsB ? -1 : qsA > qsB ? 1 : 0));
  return {
    source: ARCHIVE_LABEL_SOURCE,
    question_set: ranked.length > 0 ? ranked[0]![0] : null,
    coverage: Number((withPolitics / articles.length).toFixed(3)),
    declared: true,
  };
}

/** Bias key -> Medya DNA zone; null for an unknown/absent bias. */
export function zoneOfBias(bias: string | null | undefined): MediaDnaZone | null {
  if (!bias) return null;
  return (BIAS_TO_ZONE as Record<string, MediaDnaZone>)[bias as BiasKey] ?? null;
}

/** Raw article row as selected from PostgREST (source embedded). */
export interface RawArticleRow {
  id: string;
  cluster_id: string;
  title: string;
  url: string;
  published_at: string;
  source: { slug: string; bias: string | null } | { slug: string; bias: string | null }[] | null;
}

export function mapArticle(row: RawArticleRow, labels: ArchiveLabels = emptyLabels()): ArchiveArticle {
  const src = Array.isArray(row.source) ? (row.source[0] ?? null) : row.source;
  return {
    article_id: row.id,
    cluster_id: row.cluster_id,
    source: src?.slug ?? null,
    zone: zoneOfBias(src?.bias ?? null),
    title: row.title,
    url: row.url,
    published_at: row.published_at,
    labels,
  };
}

/** Raw row from `jev_shadow_predictions`, one per (article, task). */
export interface RawLabelRow {
  task: string;
  article_id: string | null;
  jev_prob: number | string | null;
  jev_choice: string | null;
  question_set: string | null; // projected from jev_answer->>question_set
}

function coerceLabelNumber(v: number | string | null): number | null {
  if (v === null) return null;
  // PostgREST sends numeric columns as strings.
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Folds raw jev_shadow_predictions rows (task-per-row) into one ArchiveLabels
 * object per article. A row with a null/empty article_id or a task outside
 * ARCHIVE_LABEL_TASKS is skipped entirely. question_set is taken from the
 * first non-null value seen for that article and never overwritten after.
 */
export function labelsFromRows(rows: readonly RawLabelRow[]): Map<string, ArchiveLabels> {
  const out = new Map<string, ArchiveLabels>();
  const tasks: readonly string[] = ARCHIVE_LABEL_TASKS;
  for (const row of rows) {
    if (!row.article_id) continue;
    if (!tasks.includes(row.task)) continue;

    let labels = out.get(row.article_id);
    if (!labels) {
      labels = emptyLabels();
      out.set(row.article_id, labels);
    }
    if (labels.question_set === null && row.question_set !== null) {
      labels.question_set = row.question_set;
    }
    switch (row.task) {
      case "politics":
        labels.politics_p = coerceLabelNumber(row.jev_prob);
        break;
      case "clickbait":
        labels.clickbait_p = coerceLabelNumber(row.jev_prob);
        break;
      case "sensational":
        labels.sensational = coerceLabelNumber(row.jev_prob);
        break;
      case "topic":
        labels.topic = row.jev_choice;
        break;
      case "framing":
        labels.framing = row.jev_choice;
        break;
    }
  }
  return out;
}

/** The I/O the export needs; archive-export/index.ts binds it to Supabase. */
export interface ArchivePorts {
  hasExport(day: string): Promise<boolean>;
  /** Clusters first_published in [start, end), page `page` (0-based) of ARCHIVE_PAGE_SIZE. */
  fetchClusters(start: string, end: string, page: number): Promise<ArchiveCluster[]>;
  /**
   * Member articles of `clusterIds`, page `page` (0-based) of
   * ARCHIVE_PAGE_SIZE. `rows` is what survived mapping (a member row whose
   * article embed is missing is dropped); `fetched` is how many rows the
   * query actually returned. Paging MUST stop on `fetched`, never on
   * `rows.length` — otherwise one dropped row on a full page silently ends
   * the chunk and the manifest certifies a truncated archive.
   */
  fetchArticles(
    clusterIds: readonly string[],
    page: number,
  ): Promise<{ rows: RawArticleRow[]; fetched: number }>;
  /**
   * Shadow-model labels for up to ARCHIVE_ID_CHUNK article ids in ONE query
   * -- never one per article, same anti-timeout discipline as fetchArticles.
   * An id absent from the returned Map is not an error: the caller falls
   * back to emptyLabels() and still exports the article.
   */
  fetchLabels(articleIds: readonly string[]): Promise<Map<string, ArchiveLabels>>;
  upload(path: string, body: string, contentType: string): Promise<void>;
  recordExport(row: { day: string; object_path: string; sha256: string; rows: number; bytes: number }): Promise<void>;
  now(): number;
}

export type ArchiveResult =
  | { ok: true; skipped: true; day: string }
  | {
    ok: true;
    skipped: false;
    day: string;
    object_path: string;
    clusters: number;
    articles: number;
    rows: number;
    bytes: number;
    sha256: string;
    duration_ms: number;
  };

export class ArchiveDeadlineError extends Error {
  constructor(stage: string) {
    super(`archive-export deadline exceeded during ${stage}`);
    this.name = "ArchiveDeadlineError";
  }
}

async function pageAll<T>(
  fetchPage: (page: number) => Promise<T[]>,
  checkDeadline: (stage: string) => void,
  stage: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; ; page++) {
    checkDeadline(stage);
    const rows = await fetchPage(page);
    out.push(...rows);
    if (rows.length < ARCHIVE_PAGE_SIZE) return out;
  }
}

/**
 * Exports one UTC day. Idempotent per day: returns `skipped` when a ledger
 * row already exists. Throws (no ledger row written) only on an upload
 * failure or when the overall deadline is blown -- a day that fails that
 * way is NOT automatically retried; it stays failed until an operator
 * deletes its `archive_exports` row and re-POSTs the day. A deadline hit
 * during the optional labels phase does not throw: it degrades to
 * all-null labels for the remaining articles and the day still exports.
 */
export async function runArchiveExport(
  ports: ArchivePorts,
  day: string,
  opts: { deadlineMs?: number; generatedAt?: string } = {},
): Promise<ArchiveResult> {
  const t0 = ports.now();
  const deadlineMs = opts.deadlineMs ?? ARCHIVE_DEADLINE_MS;
  const labelsCutoff = t0 + deadlineMs * 0.7;
  const checkDeadline = (stage: string) => {
    if (ports.now() - t0 > deadlineMs) throw new ArchiveDeadlineError(stage);
  };

  if (await ports.hasExport(day)) return { ok: true, skipped: true, day };

  const { start, end } = dayBounds(day);
  const clusters = await pageAll((p) => ports.fetchClusters(start, end, p), checkDeadline, "clusters");

  const rawRows: RawArticleRow[] = [];
  const ids = clusters.map((c) => c.id);
  for (let i = 0; i < ids.length; i += ARCHIVE_ID_CHUNK) {
    const chunk = ids.slice(i, i + ARCHIVE_ID_CHUNK);
    // Paged here rather than through pageAll: the stop signal is the number
    // of rows the query returned (`fetched`), not the number that survived
    // mapping — see ArchivePorts.fetchArticles.
    for (let page = 0; ; page++) {
      checkDeadline("articles");
      const { rows, fetched } = await ports.fetchArticles(chunk, page);
      rawRows.push(...rows);
      if (fetched < ARCHIVE_PAGE_SIZE) break;
    }
  }

  // Deduped, insertion-ordered article ids: the same article can be a
  // member of two clusters published the same day, so it must be requested
  // from fetchLabels once even though it is mapped into `articles` twice.
  const seenIds = new Set<string>();
  const dedupedIds: string[] = [];
  for (const row of rawRows) {
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    dedupedIds.push(row.id);
  }

  const labelMap = new Map<string, ArchiveLabels>();
  for (let i = 0; i < dedupedIds.length; i += ARCHIVE_ID_CHUNK) {
    const chunk = dedupedIds.slice(i, i + ARCHIVE_ID_CHUNK);
    // Labels are an optional enrichment with its own sub-budget so it can
    // never cost the day: once labelsCutoff passes, stop labelling and let
    // every remaining article fall back to emptyLabels() below -- the day
    // still exports, with manifest.labels.coverage as the machine-readable
    // signal that this happened.
    if (ports.now() > labelsCutoff) break;
    // A PostgREST error on this chunk (including a deadline-port error)
    // must not abort the whole day's export either -- same degrade path.
    try {
      const chunkLabels = await ports.fetchLabels(chunk);
      for (const [id, labels] of chunkLabels) labelMap.set(id, labels);
    } catch (err) {
      console.error("[archive-export] labels chunk failed", err);
      break;
    }
  }

  const articles: ArchiveArticle[] = rawRows.map((row) =>
    mapArticle(row, { ...(labelMap.get(row.id) ?? emptyLabels()) }),
  );

  const prefix = objectPrefix(day);
  const clustersText = toJsonl(clusters as unknown as Record<string, unknown>[]);
  const articlesText = toJsonl(articles as unknown as Record<string, unknown>[]);
  const files: ArchiveFile[] = [
    { name: "clusters.jsonl", sha256: await sha256Hex(clustersText), rows: clusters.length, bytes: byteLength(clustersText) },
    { name: "articles.jsonl", sha256: await sha256Hex(articlesText), rows: articles.length, bytes: byteLength(articlesText) },
  ];
  const generatedAt = opts.generatedAt ?? new Date(ports.now()).toISOString();
  const manifestLabels = summariseLabels(articles);
  const manifest = buildManifest(day, generatedAt, files, manifestLabels);
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  const manifestSha = await sha256Hex(manifestText);

  checkDeadline("upload");
  await ports.upload(`${prefix}/clusters.jsonl`, clustersText, "application/x-ndjson");
  await ports.upload(`${prefix}/articles.jsonl`, articlesText, "application/x-ndjson");
  await ports.upload(`${prefix}/manifest.json`, manifestText, "application/json");

  await ports.recordExport({ day, object_path: prefix, sha256: manifestSha, rows: manifest.rows, bytes: manifest.bytes });

  return {
    ok: true,
    skipped: false,
    day,
    object_path: prefix,
    clusters: clusters.length,
    articles: articles.length,
    rows: manifest.rows,
    bytes: manifest.bytes,
    sha256: manifestSha,
    duration_ms: ports.now() - t0,
  };
}
