import { createServerClient } from "@/lib/supabase/server";
import {
  loadClusterRefs,
  pickDefaultTarget,
  toMergeClusterRef,
  type MergeClusterRef,
} from "@/lib/admin/merge-queue";
import { foldTr } from "@/lib/clusters/turkish-query";
import { MATCH_THRESHOLD, rescoreContentPairs } from "../../../scripts/lib/content-twin-rescore.mjs";

// Reader for the "Olası içerik ikizleri" list on /admin/birlestir (migration 139).
//
// A content twin is a pair of LIVE clusters that tell the same story but were
// never joined, because the consumer scores each incoming article against a
// bounded context and the second outlet's article did not reach the first
// cluster. Neither the nightly story threads (confidence >= 0.9) nor the twin
// list of migration 120 (same-source keyed rows) surface such pairs.
//
// Two stages:
//   1. admin_content_twin_pairs() (SQL, migration 139): live clusters opened at
//      most 6 hours apart whose seed titles share enough word stems. Cheap and
//      loose on purpose; CONTENT_TWIN below is its TypeScript twin and
//      tests/migrations/139-content-twin-candidates.test.ts pins both.
//   2. rescoreContentPairs() (scripts/lib/content-twin-rescore.mjs): the same
//      ensemble the clustering consumer uses; only a pair at or above
//      MATCH_THRESHOLD is listed.
//
// READ-ONLY, ON PURPOSE. No write call, no other rpc, never cluster_merge_atomic:
// a pair is merged only when an admin presses Birleştir, which POSTs the existing
// /api/admin/cluster-merge flow with origin "manual" (the merge API and the
// cluster_merge_log check do not accept a "content" origin; it is display only).
// tests/guards/admin-content-twins-readonly.test.ts pins all of it.
//
// Plain async, no cache, never throws: null means "could not read" (e.g. 139 not
// applied) and the page renders a sentence.

/**
 * The SQL pre-filter, as numbers. Every field is mirrored by a literal in
 * supabase/migrations/139_content_twin_candidates.sql; the migration test fails
 * when the two drift apart.
 */
export const CONTENT_TWIN = {
  /** |first_published delta| of the two clusters, in hours, inclusive. */
  windowHours: 6,
  /** Pairs need at least this many shared title stems ... */
  minSharedStems: 3,
  /** ... and shared / (|A| + |B| - shared) at or above this. */
  minJaccard: 0.5,
  /** A stem is the first 5 characters of a folded title word. */
  stemLen: 5,
  /** Words shorter than this (folded, before the cut) are not stems. */
  tokenMinLen: 4,
  defaultHours: 48,
  maxHours: 168,
  defaultLimit: 50,
  maxLimit: 100,
} as const;

/**
 * Title stems that say nothing about WHICH story it is (live-blog and service
 * words, role titles, month and filler verbs). Read-only top-40 stem frequency
 * of live clusters over 7 days (2026-11-01) picked the role and filler entries;
 * named entities (erdog, israi, trump, istan, ankar, ...) are deliberately
 * absent. Mirrored literally by the array in migration 139.
 */
export const CONTENT_TWIN_GENERIC_STEMS: readonly string[] = [
  "acikl",
  "dakik",
  "canli",
  "haber",
  "gunde",
  "video",
  "izle",
  "yeni",
  "bugun",
  "icin",
  "sonra",
  "olara",
  "kadar",
  "nasil",
  "nedir",
  "bakan",
  "cumhu",
  "baska",
  "oldu",
  "etti",
  "ekim",
  "mesaj",
  "gorus",
  "basla",
  "genel",
];

const GENERIC = new Set(CONTENT_TWIN_GENERIC_STEMS);

/**
 * The stems of a title, exactly as the SQL builds them: tayf_search_fold, split
 * on runs of [^a-z0-9], words of at least 4 characters, the first 5 characters
 * of each, distinct, generic stems removed. Anything that is not a string has
 * no stems.
 */
export function candidateStems(title: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (typeof title !== "string") return out;
  for (const w of foldTr(title).split(/[^a-z0-9]+/)) {
    if (w.length < CONTENT_TWIN.tokenMinLen) continue;
    const stem = w.slice(0, CONTENT_TWIN.stemLen);
    if (!GENERIC.has(stem)) out.add(stem);
  }
  return out;
}

export interface StemOverlap {
  shared: number;
  union: number;
  jaccard: number;
}

/** Shared stems, union size and Jaccard of two titles (0 when the union is empty). */
export function stemOverlap(titleA: string | null | undefined, titleB: string | null | undefined): StemOverlap {
  const a = candidateStems(titleA);
  const b = candidateStems(titleB);
  let shared = 0;
  for (const s of a) if (b.has(s)) shared++;
  const union = a.size + b.size - shared;
  return { shared, union, jaccard: union === 0 ? 0 : shared / union };
}

/**
 * The TypeScript mirror of the SQL pre-filter for one pair: the two clusters
 * opened at most `windowHours` apart (either order) and their titles share at
 * least `minSharedStems` stems at a Jaccard of at least `minJaccard`.
 */
export function isContentTwinCandidate(
  titleA: string | null | undefined,
  titleB: string | null | undefined,
  hoursApart: number,
): boolean {
  if (!Number.isFinite(hoursApart) || Math.abs(hoursApart) > CONTENT_TWIN.windowHours) return false;
  const o = stemOverlap(titleA, titleB);
  return o.shared >= CONTENT_TWIN.minSharedStems && o.jaccard >= CONTENT_TWIN.minJaccard;
}

export type ContentTwinLane =
  | "autoAccept"
  | "headline-jaccard"
  | "headline-containment"
  | "live-title"
  | "minhash"
  | "primary";

/** What decided the score, in words the admin reads. */
export const CONTENT_TWIN_LANE_LABEL: Record<ContentTwinLane, string> = {
  autoAccept: "aynı metin (parmak izi)",
  "headline-jaccard": "başlıklar neredeyse aynı",
  "headline-containment": "kısa başlık uzununun içinde",
  "live-title": "aynı canlı yayın başlığı",
  minhash: "metin örtüşmesi",
  primary: "metin ve özne benzerliği",
};

const TR_SCORE = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TR_HOURS = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

/**
 * "Puan 0,62 · başlıklar neredeyse aynı · 24 dk arayla · 5 ortak kelime kökü".
 * Under one hour the gap is whole minutes ("24 dk"); from one hour on it is
 * hours with a tr-TR decimal ("1,5 saat"). Non-finite inputs print as 0.
 */
export function formatContentTwinDetail(p: {
  score: number;
  lane: ContentTwinLane;
  hoursApart: number;
  sharedStems: number;
}): string {
  const score = Number.isFinite(p.score) ? p.score : 0;
  const hours = Number.isFinite(p.hoursApart) ? Math.max(0, p.hoursApart) : 0;
  const minutes = Math.round(hours * 60);
  const gap = minutes < 60 ? `${minutes} dk arayla` : `${TR_HOURS.format(minutes / 60)} saat arayla`;
  const shared = Number.isFinite(p.sharedStems) ? Math.max(0, Math.floor(p.sharedStems)) : 0;
  return [`Puan ${TR_SCORE.format(score)}`, CONTENT_TWIN_LANE_LABEL[p.lane], gap, `${shared} ortak kelime kökü`].join(
    " · ",
  );
}

/**
 * Rows without the pairs whose key is in any of the given collections: how the
 * page shows a pair once (queue first, then content twins, then keyed twins).
 * null stays null (an unreadable list stays unreadable); order is kept.
 */
export function excludeKeys<T extends { key: string }>(
  rows: readonly T[] | null,
  ...shown: Iterable<string>[]
): T[] | null {
  if (rows === null) return null;
  const hidden = new Set<string>();
  for (const keys of shown) for (const k of keys) hidden.add(k);
  return rows.filter((r) => !hidden.has(r.key));
}

export interface ContentTwinRow {
  /** `${min}:${max}` of the two cluster ids, the same shape as MergeQueueRow.key. */
  key: string;
  a: MergeClusterRef;
  b: MergeClusterRef;
  /** Display only. The merge API does not know this origin; the page sends "manual". */
  origin: "content";
  /** The ensemble score, at or above MATCH_THRESHOLD. */
  score: number;
  lane: ContentTwinLane;
  hoursApart: number;
  sharedStems: number;
  detail: string;
  defaultTargetId: string;
}

interface RpcPair {
  a: string;
  b: string;
  row: Record<string, unknown>;
  sharedStems: number;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

const SWAP_PAIRS: [string, string][] = [
  ["cluster_a", "cluster_b"],
  ["title_a", "title_b"],
  ["summary_a", "summary_b"],
  ["published_a", "published_b"],
  ["article_count_a", "article_count_b"],
];

/**
 * Valid, de-duplicated rows with the ids in (a < b) order; a row that arrives
 * with a > b is swapped field by field. Anything that is not an object with two
 * different ids is skipped.
 */
function parseRows(data: unknown): RpcPair[] {
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: RpcPair[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    let row = raw as Record<string, unknown>;
    const x = str(row.cluster_a);
    const y = str(row.cluster_b);
    if (!x || !y || x === y) continue;
    if (x > y) {
      row = { ...row };
      for (const [l, r] of SWAP_PAIRS) {
        row[l] = (raw as Record<string, unknown>)[r];
        row[r] = (raw as Record<string, unknown>)[l];
      }
    }
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = `${a}:${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const shared = Number(row.shared_stems);
    out.push({ a, b, row, sharedStems: Number.isFinite(shared) && shared > 0 ? Math.floor(shared) : 0 });
  }
  return out;
}

export async function getContentTwinPairs(): Promise<ContentTwinRow[] | null> {
  try {
    const supabase = createServerClient();
    const res = await supabase.rpc("admin_content_twin_pairs", {
      p_hours: CONTENT_TWIN.defaultHours,
      p_limit: CONTENT_TWIN.defaultLimit,
    });
    if (res.error) throw new Error(`content twins: ${res.error.message}`);

    const pairs = parseRows(res.data);
    if (pairs.length === 0) return [];

    // Stage 2: the clustering ensemble decides. Index-aligned with `pairs`.
    const scores = rescoreContentPairs(
      pairs.map((p) => ({
        cluster_a: p.a,
        cluster_b: p.b,
        title_a: str(p.row.title_a),
        title_b: str(p.row.title_b),
        summary_a: str(p.row.summary_a),
        summary_b: str(p.row.summary_b),
        published_a: str(p.row.published_a),
        published_b: str(p.row.published_b),
      })),
    );
    const matched = pairs
      .map((p, i) => ({ p, s: scores[i] }))
      .filter((m) => m.s !== undefined && m.s.isMatch && m.s.score >= MATCH_THRESHOLD);
    if (matched.length === 0) return [];

    const ids = [...new Set(matched.flatMap((m) => [m.p.a, m.p.b]))];

    const dis = await supabase.from("cluster_merge_dismissals").select("cluster_a, cluster_b").in("cluster_a", ids);
    if (dis.error) throw new Error(`content twin dismissals: ${dis.error.message}`);
    const dismissed = new Set(
      (Array.isArray(dis.data) ? (dis.data as Record<string, unknown>[]) : []).map(
        (d) => `${str(d.cluster_a)}:${str(d.cluster_b)}`,
      ),
    );

    const refs = await loadClusterRefs(supabase, ids);

    const out: ContentTwinRow[] = [];
    for (const { p, s } of matched) {
      if (!s) continue;
      const key = `${p.a}:${p.b}`;
      if (dismissed.has(key)) continue;
      const ca = refs.get(p.a);
      const cb = refs.get(p.b);
      if (!ca || !cb || ca.archived || cb.archived) continue;
      const a = toMergeClusterRef(ca);
      const b = toMergeClusterRef(cb);
      out.push({
        key,
        a,
        b,
        origin: "content",
        score: s.score,
        lane: s.lane,
        hoursApart: s.hoursApart,
        sharedStems: p.sharedStems,
        detail: formatContentTwinDetail({
          score: s.score,
          lane: s.lane,
          hoursApart: s.hoursApart,
          sharedStems: p.sharedStems,
        }),
        defaultTargetId: pickDefaultTarget(a, b),
      });
    }
    return out.sort((x, y) => y.score - x.score || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  } catch (err) {
    console.error(`[admin] content twins unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
