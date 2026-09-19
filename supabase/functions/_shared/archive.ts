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

export interface ArchiveArticle {
  article_id: string;
  cluster_id: string;
  source: string | null;
  zone: MediaDnaZone | null;
  title: string;
  url: string;
  published_at: string;
}

export interface ArchiveFile {
  name: string;
  sha256: string;
  rows: number;
  bytes: number;
}

export interface ArchiveManifest {
  schema: typeof ARCHIVE_SCHEMA;
  day: string;
  generated_at: string;
  files: ArchiveFile[];
  rows: number;
  bytes: number;
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

export function buildManifest(day: string, generatedAt: string, files: ArchiveFile[]): ArchiveManifest {
  return {
    schema: ARCHIVE_SCHEMA,
    day,
    generated_at: generatedAt,
    files,
    rows: files.reduce((n, f) => n + f.rows, 0),
    bytes: files.reduce((n, f) => n + f.bytes, 0),
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

export function mapArticle(row: RawArticleRow): ArchiveArticle {
  const src = Array.isArray(row.source) ? (row.source[0] ?? null) : row.source;
  return {
    article_id: row.id,
    cluster_id: row.cluster_id,
    source: src?.slug ?? null,
    zone: zoneOfBias(src?.bias ?? null),
    title: row.title,
    url: row.url,
    published_at: row.published_at,
  };
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
 * row already exists. Throws (no ledger row written) on an upload failure
 * or when the deadline is hit, so the next run redoes the whole day.
 */
export async function runArchiveExport(
  ports: ArchivePorts,
  day: string,
  opts: { deadlineMs?: number; generatedAt?: string } = {},
): Promise<ArchiveResult> {
  const t0 = ports.now();
  const deadlineMs = opts.deadlineMs ?? ARCHIVE_DEADLINE_MS;
  const checkDeadline = (stage: string) => {
    if (ports.now() - t0 > deadlineMs) throw new ArchiveDeadlineError(stage);
  };

  if (await ports.hasExport(day)) return { ok: true, skipped: true, day };

  const { start, end } = dayBounds(day);
  const clusters = await pageAll((p) => ports.fetchClusters(start, end, p), checkDeadline, "clusters");

  const articles: ArchiveArticle[] = [];
  const ids = clusters.map((c) => c.id);
  for (let i = 0; i < ids.length; i += ARCHIVE_ID_CHUNK) {
    const chunk = ids.slice(i, i + ARCHIVE_ID_CHUNK);
    // Paged here rather than through pageAll: the stop signal is the number
    // of rows the query returned (`fetched`), not the number that survived
    // mapping — see ArchivePorts.fetchArticles.
    for (let page = 0; ; page++) {
      checkDeadline("articles");
      const { rows, fetched } = await ports.fetchArticles(chunk, page);
      for (const row of rows) articles.push(mapArticle(row));
      if (fetched < ARCHIVE_PAGE_SIZE) break;
    }
  }

  const prefix = objectPrefix(day);
  const clustersText = toJsonl(clusters as unknown as Record<string, unknown>[]);
  const articlesText = toJsonl(articles as unknown as Record<string, unknown>[]);
  const files: ArchiveFile[] = [
    { name: "clusters.jsonl", sha256: await sha256Hex(clustersText), rows: clusters.length, bytes: byteLength(clustersText) },
    { name: "articles.jsonl", sha256: await sha256Hex(articlesText), rows: articles.length, bytes: byteLength(articlesText) },
  ];
  const generatedAt = opts.generatedAt ?? new Date(ports.now()).toISOString();
  const manifest = buildManifest(day, generatedAt, files);
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
