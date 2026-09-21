import { createServerClient } from "@/lib/supabase/server";

// Pack A ("Jev canlı küme", migration 064) — the /admin readers/writers for
// two of the three P3/P5 mechanisms: the outlier-ejection queue
// ("Küme dışı adaylar" / jev_unlink_candidates + the cluster_unlink_article
// RPC) and the blindspot-recall suspect list ("Şüpheli kör noktalar" /
// clusters.blindspot_recall_suspect + the 'blindspot_recall' shadow
// predictions). Mirrors src/lib/admin/jev-shadow-status.ts's rationale: the
// /admin page is cookie-gated and dynamic, so every export here is a plain
// async function, NEVER "use cache". None of these functions may ever
// throw — a throw here would 500 the whole cookie-gated /admin page, so a
// missing table, a bad RPC shape, or a Supabase hiccup all degrade to
// `null` (or a `{ ok: false, reason }` result for the two mutators)
// instead. `null` means "could not read"; the sections render a different
// sentence for that than for "read fine, nothing to show yet" (`[]`).
//
// Neither unlinkClusterArticle nor keepClusterArticle calls revalidateTag —
// that belongs to the route (src/app/api/admin/jev-unlink/route.ts), which
// is the only place that knows whether the decision was "unlink" (reader-
// facing surfaces changed) or "keep" (nothing did).

export const JEV_UNLINK_LIMIT = 30;
export const JEV_BLINDSPOT_SUSPECT_LIMIT = 20;
export const JEV_BLINDSPOT_SUSPECT_DAYS = 7;
// Duplicated from JEV_BLINDSPOT_CANDIDATES_PER_CALL in
// supabase/functions/_shared/jev.ts (same cross-runtime-duplication
// discipline as JEV_USD_PER_TOKEN in jev-shadow-status.ts) — the max
// blindspot_recall answer rows the shadow stage writes per cluster per
// call. Used below (DB-07) only to bound the suspects query, not to
// reproduce the ranking itself.
const JEV_BLINDSPOT_CANDIDATES_PER_CALL = 15;

export interface JevUnlinkCandidateView {
  id: number;
  clusterId: string;
  articleId: string;
  jevProb: number;
  createdAt: string;
  clusterTitle: string;
  articleTitle: string;
  sourceSlug: string | null;
}

export interface JevBlindspotSuspectView {
  clusterId: string;
  clusterTitle: string;
  checkedAt: string | null;
  topArticleTitle: string | null;
  topSourceSlug: string | null;
  topProb: number | null;
}

const JEV_UNLINK_SELECT =
  "id, cluster_id, article_id, jev_prob, created_at, " +
  "cluster:clusters ( title_tr, title_tr_neutral ), " +
  "article:articles ( title, source:sources ( slug ) )";

/**
 * A to-one PostgREST embed arrives as an object for a plain FK relation,
 * but the client (and its typegen) also hands back a one-element array
 * depending on how the FK is resolved, or `null`/`undefined` for a
 * deleted/absent row. Normalise all four shapes — same discipline as
 * src/lib/corrections/public-log.ts's `embedTitle`.
 */
type Embed<T> = T | T[] | null | undefined;

function one<T extends object>(embed: Embed<T>): T | null {
  const first = Array.isArray(embed) ? (embed[0] ?? null) : (embed ?? null);
  return first && typeof first === "object" ? first : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

interface TitleRow {
  title_tr?: unknown;
  title_tr_neutral?: unknown;
}

function preferredTitle(row: TitleRow | null): string {
  if (!row) return "(başlıksız)";
  const neutral = asString(row.title_tr_neutral, "");
  if (neutral) return neutral;
  return asString(row.title_tr, "") || "(başlıksız)";
}

interface SourceEmbed {
  slug?: unknown;
}

interface ArticleEmbed {
  title?: unknown;
  source?: Embed<SourceEmbed>;
}

function sourceSlugOf(article: ArticleEmbed | null): string | null {
  if (!article) return null;
  const source = one(article.source);
  const slug = source ? asString(source.slug, "") : "";
  return slug.length > 0 ? slug : null;
}

interface RawUnlinkRow {
  id?: unknown;
  cluster_id?: unknown;
  article_id?: unknown;
  jev_prob?: unknown;
  created_at?: unknown;
  cluster?: Embed<TitleRow>;
  article?: Embed<ArticleEmbed>;
}

function toUnlinkView(row: RawUnlinkRow): JevUnlinkCandidateView {
  const prob = Number(row.jev_prob);
  const article = one(row.article);
  return {
    id: Number(row.id),
    clusterId: asString(row.cluster_id),
    articleId: asString(row.article_id),
    jevProb: Number.isFinite(prob) ? prob : 0,
    createdAt: asString(row.created_at),
    clusterTitle: preferredTitle(one(row.cluster)),
    articleTitle: article ? asString(article.title) : "",
    sourceSlug: sourceSlugOf(article),
  };
}

/**
 * Pending outlier-ejection candidates, lowest (most suspicious) probability
 * first. Never throws — see the module docblock.
 */
export async function getJevUnlinkCandidates(): Promise<JevUnlinkCandidateView[] | null> {
  try {
    const supabase = createServerClient();

    const { data, error } = await supabase
      .from("jev_unlink_candidates")
      .select(JEV_UNLINK_SELECT)
      .eq("status", "pending")
      .order("jev_prob", { ascending: true })
      .limit(JEV_UNLINK_LIMIT);

    if (error) {
      console.error(`[admin] jev unlink candidates unavailable: ${error.message}`);
      return null;
    }

    const rows = Array.isArray(data) ? (data as RawUnlinkRow[]) : [];
    return rows.map(toUnlinkView);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] jev unlink candidates unavailable: ${message}`);
    return null;
  }
}

interface RawSuspectClusterRow {
  id?: unknown;
  title_tr?: unknown;
  title_tr_neutral?: unknown;
  blindspot_recall_checked_at?: unknown;
}

interface RawSuspectPredictionRow {
  cluster_id?: unknown;
  jev_prob?: unknown;
  article?: Embed<ArticleEmbed>;
}

/**
 * Clusters `blindspot_recall` flagged as a likely clustering miss in the
 * last JEV_BLINDSPOT_SUSPECT_DAYS days, each paired with the
 * highest-probability recall candidate found for it.
 *
 * Two queries, joined in application code rather than one PostgREST embed:
 * clusters and jev_shadow_predictions are both FK-linked, but "the
 * highest-probability prediction per cluster" is a top-1-per-group query
 * PostgREST cannot express directly. The second query is ordered
 * `jev_prob desc`, so the first row seen for a given cluster_id is that
 * cluster's top candidate — grouping below relies on that order, not on
 * re-sorting client-side.
 */
export async function getJevBlindspotSuspects(): Promise<JevBlindspotSuspectView[] | null> {
  try {
    const supabase = createServerClient();
    const sinceIso = new Date(
      Date.now() - JEV_BLINDSPOT_SUSPECT_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const clustersRes = await supabase
      .from("clusters")
      .select("id, title_tr, title_tr_neutral, blindspot_recall_checked_at")
      .eq("blindspot_recall_suspect", true)
      .gte("blindspot_recall_checked_at", sinceIso)
      .order("blindspot_recall_checked_at", { ascending: false })
      .limit(JEV_BLINDSPOT_SUSPECT_LIMIT);

    if (clustersRes.error) {
      console.error(`[admin] jev blindspot suspects unavailable: ${clustersRes.error.message}`);
      return null;
    }

    const clusterRows = Array.isArray(clustersRes.data)
      ? (clustersRes.data as RawSuspectClusterRow[])
      : [];
    if (clusterRows.length === 0) return [];

    const clusterIds = clusterRows
      .map((row) => asString(row.id))
      .filter((id) => id.length > 0);

    const predictionsRes = await supabase
      .from("jev_shadow_predictions")
      .select("cluster_id, jev_prob, article:articles ( title, source:sources ( slug ) )")
      .eq("task", "blindspot_recall")
      .in("cluster_id", clusterIds)
      .not("article_id", "is", null)
      // DB-07: bound this query with the same window the cluster query
      // above already computes, plus a row cap sized to the worst case
      // (JEV_BLINDSPOT_SUSPECT_LIMIT clusters x JEV_BLINDSPOT_CANDIDATES_PER_CALL
      // rows/cluster/call) -- without this the query pulls the entire
      // blindspot_recall history for every listed cluster, unbounded, on a
      // page whose whole design premise is that it cannot 500.
      .gte("created_at", sinceIso)
      .order("jev_prob", { ascending: false })
      .limit(JEV_BLINDSPOT_SUSPECT_LIMIT * JEV_BLINDSPOT_CANDIDATES_PER_CALL);

    if (predictionsRes.error) {
      console.error(`[admin] jev blindspot suspects unavailable: ${predictionsRes.error.message}`);
      return null;
    }

    const predictionRows = Array.isArray(predictionsRes.data)
      ? (predictionsRes.data as RawSuspectPredictionRow[])
      : [];

    const topByCluster = new Map<string, RawSuspectPredictionRow>();
    for (const row of predictionRows) {
      const cid = asString(row.cluster_id);
      if (cid && !topByCluster.has(cid)) {
        topByCluster.set(cid, row);
      }
    }

    return clusterRows.map((row) => {
      const id = asString(row.id);
      const top = topByCluster.get(id);
      const article = top ? one(top.article) : null;
      const prob = top ? Number(top.jev_prob) : NaN;
      return {
        clusterId: id,
        clusterTitle: preferredTitle(row),
        checkedAt:
          typeof row.blindspot_recall_checked_at === "string"
            ? row.blindspot_recall_checked_at
            : null,
        topArticleTitle: article ? asString(article.title, "") || null : null,
        topSourceSlug: sourceSlugOf(article),
        topProb: Number.isFinite(prob) ? prob : null,
      };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] jev blindspot suspects unavailable: ${message}`);
    return null;
  }
}

interface RawCandidateRow {
  id?: unknown;
  cluster_id?: unknown;
  article_id?: unknown;
}

/**
 * Resolves one "Ayır" decision: looks up the pending candidate row (never
 * trusting the caller's id/clusterId/articleId triple blindly — the row
 * must actually exist and still be pending), then calls the
 * SECURITY DEFINER RPC public.cluster_unlink_article, which does the
 * actual membership delete + aggregate recompute under the per-cluster
 * advisory lock. Never throws.
 */
export async function unlinkClusterArticle(
  id: number,
): Promise<
  | { ok: true; clusterId: string; articleCount: number }
  | { ok: false; reason: "not-found" | "error" }
> {
  try {
    const supabase = createServerClient();

    const { data: candidate, error: readError } = await supabase
      .from("jev_unlink_candidates")
      .select("id, cluster_id, article_id")
      .eq("id", id)
      .eq("status", "pending")
      .maybeSingle();

    if (readError) {
      console.error(`[admin] jev unlink candidate lookup failed: ${readError.message}`);
      return { ok: false, reason: "error" };
    }
    if (!candidate) {
      return { ok: false, reason: "not-found" };
    }

    const row = candidate as RawCandidateRow;
    const clusterId = asString(row.cluster_id);
    const articleId = asString(row.article_id);

    const { data: articleCount, error: rpcError } = await supabase.rpc(
      "cluster_unlink_article",
      { p_cluster_id: clusterId, p_article_id: articleId },
    );

    if (rpcError) {
      console.error(`[admin] cluster_unlink_article failed: ${rpcError.message}`);
      return { ok: false, reason: "error" };
    }

    // A7: a null/undefined articleCount with no rpcError would otherwise
    // serialise as `{ ok: true, article_count: null }` (JSON.stringify
    // turns NaN into null; and Number(null) is 0, not NaN, so `null`
    // specifically must be checked before the Number.isFinite guard),
    // contradicting shared_contract §I's `200 { "ok": true, "article_count": 4 }`.
    const count = Number(articleCount);
    if (articleCount === null || articleCount === undefined || !Number.isFinite(count)) {
      console.error("[admin] cluster_unlink_article returned a non-numeric article_count");
      return { ok: false, reason: "error" };
    }

    return { ok: true, clusterId, articleCount: count };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] jev unlink failed: ${message}`);
    return { ok: false, reason: "error" };
  }
}

/**
 * Resolves one "Kalsın" decision: marks the candidate row decided without
 * touching cluster membership. No RPC call, no revalidation — nothing
 * reader-facing changed. Never throws.
 */
export async function keepClusterArticle(
  id: number,
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "error" }> {
  try {
    const supabase = createServerClient();

    const { data, error } = await supabase
      .from("jev_unlink_candidates")
      .update({ status: "kept", decided_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    if (error) {
      console.error(`[admin] jev keep failed: ${error.message}`);
      return { ok: false, reason: "error" };
    }
    if (!data) {
      return { ok: false, reason: "not-found" };
    }

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] jev keep failed: ${message}`);
    return { ok: false, reason: "error" };
  }
}
