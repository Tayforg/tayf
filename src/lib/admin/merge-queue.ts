import { createServerClient } from "@/lib/supabase/server";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import type { BiasDistribution } from "@/types";

// Readers for /admin/birlestir (merge queue, migration 099). Plain async, no
// cache, never throws: null means "could not read" (e.g. 099 not applied) and
// the page renders a sentence. Two sources feed the queue: nightly story
// thread candidates (very high confidence, close in time) and Jev
// blindspot_recall matches (the silent side's article lives in another cluster).

export const MERGE_THREAD_MIN_CONFIDENCE = 0.9;
export const MERGE_THREAD_MAX_HOURS = 24;
export const MERGE_RECALL_MIN_PROB = 0.85;
export const MERGE_RECALL_WINDOW_DAYS = 7;
export const MERGE_QUEUE_CAP = 60;
export const MERGE_LOG_LIMIT = 20;

const THREAD_LIMIT = 50;
const RECALL_CLUSTER_LIMIT = 30;
const RECALL_PREDICTION_LIMIT = 300;
const HEADLINE_ROW_LIMIT = 2000;
const HEADLINES_PER_CLUSTER = 3;
const UNTITLED = "(başlıksız küme)";

export type MergeQueueOrigin = "thread" | "recall";

export interface MergeClusterRef {
  id: string;
  title: string;
  articleCount: number;
  firstPublished: string | null;
  biasDistribution: BiasDistribution;
  isBlindspot: boolean;
  headlines: { title: string; sourceName: string }[];
}

export interface MergeQueueRow {
  key: string;
  a: MergeClusterRef;
  b: MergeClusterRef;
  origin: MergeQueueOrigin;
  origins: MergeQueueOrigin[];
  score: number;
  detail: string;
  defaultTargetId: string;
}

export interface MergeLogRow {
  id: number;
  createdAt: string;
  actor: string;
  origin: "manual" | "thread" | "recall";
  source: { id: string; title: string };
  target: { id: string; title: string };
  sourceCountBefore: number;
  targetCountBefore: number;
  moved: number;
  duplicates: number;
  targetCountAfter: number;
  blindspotBefore: boolean;
  blindspotAfter: boolean;
}

interface Candidate {
  a: string;
  b: string;
  origin: MergeQueueOrigin;
  score: number;
  detail: string;
}

interface ClusterRow {
  id: string;
  title_tr: string | null;
  title_tr_neutral: string | null;
  article_count: number | null;
  first_published: string | null;
  bias_distribution: unknown;
  is_blindspot: boolean | null;
  is_archived: boolean | null;
  merged_into: string | null;
}

class ReadError extends Error {}

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new ReadError(`${what}: ${error.message}`);
}

function rows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function titleOf(c: { title_tr: unknown; title_tr_neutral: unknown } | undefined): string {
  if (!c) return UNTITLED;
  return str(c.title_tr_neutral) || str(c.title_tr) || UNTITLED;
}

function pairKey(x: string, y: string): { a: string; b: string; key: string } {
  const [a, b] = x < y ? [x, y] : [y, x];
  return { a, b, key: `${a}:${b}` };
}

function normalizeBias(raw: unknown): BiasDistribution {
  const out = emptyBiasDistribution();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;
  for (const k of Object.keys(out) as (keyof BiasDistribution)[]) {
    const n = src[k];
    if (typeof n === "number" && Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

export function pickDefaultTarget(
  a: { id: string; articleCount: number; firstPublished: string | null },
  b: { id: string; articleCount: number; firstPublished: string | null },
): string {
  if (a.articleCount !== b.articleCount) return a.articleCount > b.articleCount ? a.id : b.id;
  const ta = a.firstPublished ? Date.parse(a.firstPublished) : NaN;
  const tb = b.firstPublished ? Date.parse(b.firstPublished) : NaN;
  const va = Number.isNaN(ta) ? Infinity : ta;
  const vb = Number.isNaN(tb) ? Infinity : tb;
  if (va !== vb) return va < vb ? a.id : b.id;
  return a.id < b.id ? a.id : b.id;
}

type Supabase = ReturnType<typeof createServerClient>;

async function threadCandidates(supabase: Supabase): Promise<Candidate[]> {
  const res = await supabase
    .from("story_thread_candidates")
    .select("cluster_a, cluster_b, confidence, shared_terms, hours_apart")
    .eq("status", "pending")
    .gte("confidence", MERGE_THREAD_MIN_CONFIDENCE)
    .lte("hours_apart", MERGE_THREAD_MAX_HOURS)
    .order("confidence", { ascending: false })
    .limit(THREAD_LIMIT);
  fail("thread candidates", res.error);
  const out: Candidate[] = [];
  for (const r of rows<Record<string, unknown>>(res.data)) {
    const x = str(r.cluster_a);
    const y = str(r.cluster_b);
    if (!x || !y || x === y) continue;
    const terms = Array.isArray(r.shared_terms)
      ? r.shared_terms.filter((t): t is string => typeof t === "string")
      : [];
    const hours = Number(r.hours_apart);
    const parts: string[] = [];
    if (terms.length > 0) parts.push(`Ortak terimler: ${terms.join(", ")}`);
    if (Number.isFinite(hours)) parts.push(`${Math.round(hours)} saat arayla`);
    out.push({
      ...pairKey(x, y),
      origin: "thread",
      score: Number(r.confidence) || 0,
      detail: parts.join(" · "),
    });
  }
  return out;
}

async function recallCandidates(supabase: Supabase): Promise<Candidate[]> {
  const sinceIso = new Date(Date.now() - MERGE_RECALL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const susp = await supabase
    .from("clusters")
    .select("id")
    .or(
      `blindspot_recall_veto.eq.true,and(blindspot_recall_suspect.eq.true,blindspot_recall_checked_at.gte."${sinceIso}")`,
    )
    .order("blindspot_recall_checked_at", { ascending: false })
    .limit(RECALL_CLUSTER_LIMIT);
  fail("recall clusters", susp.error);
  const clusterIds = rows<{ id: unknown }>(susp.data).map((r) => str(r.id)).filter(Boolean);
  if (clusterIds.length === 0) return [];

  const preds = await supabase
    .from("jev_shadow_predictions")
    .select("cluster_id, article_id, jev_prob, article:articles(title, source:sources(slug))")
    .eq("task", "blindspot_recall")
    .not("article_id", "is", null)
    .gte("jev_prob", MERGE_RECALL_MIN_PROB)
    .gte("created_at", sinceIso)
    .in("cluster_id", clusterIds)
    .order("jev_prob", { ascending: false })
    .limit(RECALL_PREDICTION_LIMIT);
  fail("recall predictions", preds.error);
  const predRows = rows<Record<string, unknown>>(preds.data);
  const articleIds = [...new Set(predRows.map((p) => str(p.article_id)).filter(Boolean))];
  if (articleIds.length === 0) return [];

  const ca = await supabase.from("cluster_articles").select("cluster_id, article_id").in("article_id", articleIds);
  fail("recall article clusters", ca.error);
  const byArticle = new Map<string, Set<string>>();
  for (const r of rows<Record<string, unknown>>(ca.data)) {
    const aid = str(r.article_id);
    const cid = str(r.cluster_id);
    if (!aid || !cid) continue;
    const set = byArticle.get(aid) ?? new Set<string>();
    set.add(cid);
    byArticle.set(aid, set);
  }

  const seen = new Map<string, Candidate>();
  // Predictions arrive ordered jev_prob desc: the first row per pair wins.
  for (const p of predRows) {
    const x = str(p.cluster_id);
    const prob = Number(p.jev_prob);
    if (!x || !Number.isFinite(prob)) continue;
    const art = one(p.article as Record<string, unknown> | Record<string, unknown>[] | null);
    const src = art ? one(art.source as Record<string, unknown> | Record<string, unknown>[] | null) : null;
    for (const y of byArticle.get(str(p.article_id)) ?? []) {
      if (y === x) continue;
      const pk = pairKey(x, y);
      if (seen.has(pk.key)) continue;
      const tail = [str(src?.slug), str(art?.title)].filter(Boolean);
      seen.set(pk.key, {
        ...pk,
        origin: "recall",
        score: prob,
        detail: `Jev: %${Math.round(prob * 100)} aynı olay${tail.length === 2 ? ` · ${tail[0]}: ${tail[1]}` : ""}`,
      });
    }
  }
  return [...seen.values()];
}

export async function getMergeQueue(): Promise<MergeQueueRow[] | null> {
  try {
    const supabase = createServerClient();
    const [threads, recalls] = await Promise.all([threadCandidates(supabase), recallCandidates(supabase)]);

    const merged = new Map<
      string,
      { a: string; b: string; origins: MergeQueueOrigin[]; score: number; details: string[] }
    >();
    for (const c of [...threads, ...recalls]) {
      const key = `${c.a}:${c.b}`;
      const cur = merged.get(key);
      if (!cur) {
        merged.set(key, { a: c.a, b: c.b, origins: [c.origin], score: c.score, details: [c.detail] });
      } else if (!cur.origins.includes(c.origin)) {
        cur.origins.push(c.origin);
        cur.score = Math.max(cur.score, c.score);
        cur.details.push(c.detail);
      }
    }
    let pairs = [...merged.values()].sort(
      (p, q) => q.score - p.score || (p.origins[0] === "thread" ? -1 : 0) - (q.origins[0] === "thread" ? -1 : 0),
    );
    if (pairs.length === 0) return [];

    const idsOf = (ps: typeof pairs) => [...new Set(ps.flatMap((p) => [p.a, p.b]))];

    const dis = await supabase
      .from("cluster_merge_dismissals")
      .select("cluster_a, cluster_b")
      .in("cluster_a", idsOf(pairs));
    fail("merge dismissals", dis.error);
    const dismissed = new Set(
      rows<Record<string, unknown>>(dis.data).map((d) => `${str(d.cluster_a)}:${str(d.cluster_b)}`),
    );
    pairs = pairs.filter((p) => !dismissed.has(`${p.a}:${p.b}`)).slice(0, MERGE_QUEUE_CAP);
    if (pairs.length === 0) return [];

    const ids = idsOf(pairs);
    const [cl, hl] = await Promise.all([
      supabase
        .from("clusters")
        .select(
          "id, title_tr, title_tr_neutral, article_count, first_published, bias_distribution, is_blindspot, is_archived, merged_into",
        )
        .in("id", ids),
      supabase
        .from("cluster_articles")
        .select("cluster_id, article:articles(title, published_at, source:sources(name))")
        .in("cluster_id", ids)
        .limit(HEADLINE_ROW_LIMIT),
    ]);
    fail("merge clusters", cl.error);
    fail("merge headlines", hl.error);

    const clusters = new Map(rows<ClusterRow>(cl.data).map((c) => [c.id, c]));
    const heads = new Map<string, { title: string; sourceName: string; at: number }[]>();
    for (const r of rows<Record<string, unknown>>(hl.data)) {
      const cid = str(r.cluster_id);
      const art = one(r.article as Record<string, unknown> | Record<string, unknown>[] | null);
      const title = str(art?.title);
      if (!cid || !title) continue;
      const src = one(art?.source as Record<string, unknown> | Record<string, unknown>[] | null);
      const at = Date.parse(str(art?.published_at));
      const list = heads.get(cid) ?? [];
      list.push({ title, sourceName: str(src?.name), at: Number.isNaN(at) ? 0 : at });
      heads.set(cid, list);
    }

    const ref = (c: ClusterRow): MergeClusterRef => ({
      id: c.id,
      title: titleOf(c),
      articleCount: typeof c.article_count === "number" ? c.article_count : 0,
      firstPublished: c.first_published ?? null,
      biasDistribution: normalizeBias(c.bias_distribution),
      isBlindspot: c.is_blindspot === true,
      headlines: (heads.get(c.id) ?? [])
        .sort((x, y) => y.at - x.at)
        .slice(0, HEADLINES_PER_CLUSTER)
        .map(({ title, sourceName }) => ({ title, sourceName })),
    });

    const out: MergeQueueRow[] = [];
    for (const p of pairs) {
      const ca = clusters.get(p.a);
      const cb = clusters.get(p.b);
      if (!ca || !cb) continue;
      if (ca.is_archived || cb.is_archived || ca.merged_into || cb.merged_into) continue;
      const a = ref(ca);
      const b = ref(cb);
      out.push({
        key: `${p.a}:${p.b}`,
        a,
        b,
        origin: p.origins.includes("thread") ? "thread" : "recall",
        origins: p.origins,
        score: p.score,
        detail: p.details.filter(Boolean).join(" | "),
        defaultTargetId: pickDefaultTarget(a, b),
      });
    }
    return out;
  } catch (err) {
    console.error(`[admin] merge queue unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function getRecentMerges(): Promise<MergeLogRow[] | null> {
  try {
    const supabase = createServerClient();
    const log = await supabase
      .from("cluster_merge_log")
      .select(
        "id, source_id, target_id, actor, origin, source_count_before, target_count_before, moved, duplicates, target_count_after, target_blindspot_before, target_blindspot_after, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(MERGE_LOG_LIMIT);
    fail("merge log", log.error);
    const logRows = rows<Record<string, unknown>>(log.data);
    if (logRows.length === 0) return [];

    const ids = [...new Set(logRows.flatMap((r) => [str(r.source_id), str(r.target_id)]).filter(Boolean))];
    const cl = await supabase.from("clusters").select("id, title_tr, title_tr_neutral").in("id", ids);
    fail("merge log clusters", cl.error);
    const titles = new Map(
      rows<{ id: string; title_tr: unknown; title_tr_neutral: unknown }>(cl.data).map((c) => [c.id, titleOf(c)]),
    );
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

    return logRows.map((r) => {
      const sid = str(r.source_id);
      const tid = str(r.target_id);
      const origin = r.origin === "thread" || r.origin === "recall" ? r.origin : "manual";
      return {
        id: num(r.id),
        createdAt: str(r.created_at),
        actor: str(r.actor),
        origin,
        source: { id: sid, title: titles.get(sid) ?? UNTITLED },
        target: { id: tid, title: titles.get(tid) ?? UNTITLED },
        sourceCountBefore: num(r.source_count_before),
        targetCountBefore: num(r.target_count_before),
        moved: num(r.moved),
        duplicates: num(r.duplicates),
        targetCountAfter: num(r.target_count_after),
        blindspotBefore: r.target_blindspot_before === true,
        blindspotAfter: r.target_blindspot_after === true,
      };
    });
  } catch (err) {
    console.error(`[admin] merge log unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
