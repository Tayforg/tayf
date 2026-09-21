// supabase/functions/jev-shadow/index.ts
//
// TypeSafe Jev production shadow suite (migration 061). Poked by pg_cron
// `jev-shadow` every 10 minutes (`*/10 * * * *`, bearer-gated like
// archive-export) to ask Jev 12 typed questions per run across five subject
// types (article, cluster, pair, KAP, title version) and record one row per
// (task, subject) in `jev_shadow_predictions` alongside the current
// system's answer. This is a pure shadow observer: nothing it writes
// reaches a reader.
//
// The algorithm -- state building, question builders, baselines, agree
// rules, the budget/deadline/retry-aware orchestrator -- lives entirely in
// `_shared/jev.ts`. This file is a THIN binding: it wires JevPorts to the
// service-role Supabase client, does the one raw gateway fetch (no
// `npm:ai` -- the `@vercel/oidc` `--allow-sys` cold-start trap), and
// renders the HTTP envelope.
//
// This function reads the gateway API key from a Deno env var and NEVER
// stores it, logs it, or echoes it -- nor does it ever forward the
// gateway's raw error body (which, on a 401, embeds an API-key-creation
// URL) into a log line or into the HTTP response this function returns.
// See `evaluateOnce` / `evaluateWithRetries` below.

import { requireServiceRoleBearer } from "../_shared/auth.ts";
import { captureException, initSentry, withSentry } from "../_shared/sentry.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import {
  type JevArticleRow,
  type JevBlindspotCandidate,
  type JevBlindspotCandidateQuery,
  type JevBlindspotClusterRow,
  type JevClusterRow,
  JEV_DEADLINE_MS,
  JEV_ENDPOINT,
  JEV_MAX_RETRIES,
  JEV_MODEL,
  JEV_MONTHLY_TOKEN_CAP_DEFAULT,
  JEV_POLITICS_CATEGORIES,
  JEV_PROTOCOL_VERSION,
  JEV_SPEC_VERSION,
  type JevGoldLabelRow,
  type JevKapRow,
  JevDeadlineError,
  type JevMemberRow,
  type JevPairCandidate,
  type JevPorts,
  JevRateLimitError,
  type JevRegressionAnswerRow,
  type JevRegressionItem,
  type JevRequest,
  type JevResponse,
  type JevRunMode,
  type JevRunStatus,
  type JevTickerRow,
  type JevTitleRow,
  type JevUnlinkCandidateRow,
  agreedGoldLabels,
  isRateLimitStatus,
  offendingQuestionIds,
  parseJevResponse,
  retryDelayMs,
  runJevShadow,
} from "../_shared/jev.ts";
import { VOTING_SOURCE_KINDS } from "../_shared/cluster/source-kind.ts";

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** Hard cap on fetchPendingArticles' forward paging (JEV-A4) -- bounds a
 * pathological 24h backlog to a fixed number of round trips per run. */
const JEV_ARTICLE_FETCH_MAX_PAGES = 10;

/** PostgREST page size for fetchPreviousRegressionAnswers (066). */
const JEV_REGRESSION_ANSWER_PAGE = 1000;
/** Hard cap on fetchPreviousRegressionAnswers' paging (066): 400 articles x
 * 7 tasks + 100 pairs is 2900 rows, well over PostgREST's default 1000-row
 * ceiling -- an unpaged read would silently truncate the baseline and
 * manufacture flips over a fraction of the set rather than erroring. */
const JEV_REGRESSION_ANSWER_MAX_PAGES = 10;

/** Same 100-id cap as _shared/archive.ts's ARCHIVE_ID_CHUNK,
 * cluster-consumer/index.ts's inChunked default, and ingest/index.ts's
 * TITLE_LOOKUP_BATCH -- keeps a PostgREST `.in(...)` GET URL well under
 * typical gateway URL-length limits (JEV-A5). */
const JEV_ID_CHUNK = 100;

/** Explicit cap on the bist_companies select in fetchPendingTickerMatches
 * (~1047 rows in production, comfortably under this). Without it, an
 * unbounded select silently truncates under a PostgREST db-max-rows
 * setting and every ticker past the cut becomes company `undefined` at
 * once (M5); fetchPendingTickerMatches throws instead if the row count
 * ever comes back exactly at this limit. */
const JEV_BIST_COMPANIES_LIMIT = 5000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounds a log line's length -- same discipline as jev.ts's clampErrorMessage. */
function clampErrorForLog(message: string): string {
  return message.length > 500 ? message.slice(0, 500) : message;
}

// ---------------------------------------------------------------------------
// Raw-row shapes returned by PostgREST embeds -- flattened the same way
// archive-export/index.ts flattens its `article:articles(...)` embed
// (Supabase returns an object for a to-one embed, but the generated types
// widen it to object-or-array; both are handled defensively).
// ---------------------------------------------------------------------------

interface RawArticleFetchRow {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  published_at: string;
  source: { slug: string | null } | { slug: string | null }[] | null;
}

interface RawClusterFetchRow {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  title_neutral_model: string | null;
  updated_at: string;
}

interface RawMemberFetchRow {
  cluster_id: string;
  article_id: string;
  article: { title: string; published_at: string } | { title: string; published_at: string }[] | null;
}

interface RawPairFetchRow {
  id: string;
  title: string;
  published_at: string;
  cluster_articles: { cluster_id: string } | { cluster_id: string }[] | null;
}

interface RawAuditClusterRow {
  id: string;
}

interface RawTickerFetchRow {
  article_id: string;
  ticker: string;
  matched_on: string;
  article: { title: string; description: string | null } | { title: string; description: string | null }[] | null;
}

interface RawBistCompanyRow {
  tickers: string[];
  title: string;
}

interface RawTitleVersionFetchRow {
  id: number | string;
  article_id: string | null;
  old_title: string;
  new_title: string;
}

interface RawBlindspotClusterFetchRow {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  blindspot_side: string | null;
  first_published: string;
  updated_at: string;
}

interface RawBlindspotMemberIdRow {
  article_id: string;
}

interface RawBlindspotSourceIdRow {
  id: string;
}

interface RawBlindspotCandidateFetchRow {
  id: string;
  title: string;
  published_at: string;
  source: { slug: string | null } | { slug: string | null }[] | null;
}

interface ShadowPredictionKey {
  subject_id: string;
}

function flattenEmbed<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

// ---------------------------------------------------------------------------
// Ports -- binds createServiceClient() to JevPorts (the ArchivePorts seam).
// `apiKey` is threaded in from the caller (read exactly once, at the top of
// the request handler) rather than re-read here, so the env var lookup
// stays singular for the whole file.
// ---------------------------------------------------------------------------

function makePorts(apiKey: string): JevPorts {
  const supabase = createServiceClient();

  async function anti_join(task: string, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const seen = new Set<string>();
    for (let i = 0; i < ids.length; i += JEV_ID_CHUNK) {
      const chunk = ids.slice(i, i + JEV_ID_CHUNK) as string[];
      const { data, error } = await supabase
        .from("jev_shadow_predictions")
        .select("subject_id")
        .eq("task", task)
        .in("subject_id", chunk);
      if (error) throw new Error(`jev-shadow: ${task} anti-join failed: ${error.message}`);
      for (const r of (data ?? []) as unknown as ShadowPredictionKey[]) seen.add(r.subject_id);
    }
    return seen;
  }

  return {
    now: () => Date.now(),
    random: () => Math.random(),

    async evaluate(request: JevRequest) {
      return evaluateWithRetries(apiKey, request);
    },

    async fetchSeenSubjects(task, subjectIds) {
      return anti_join(task, subjectIds);
    },

    onError(stage, err) {
      // SECURITY, non-negotiable: never log err.message from anything that
      // could carry the gateway's raw response text (a 401 embeds an
      // API-key-creation URL, a 400 echoes request paths). Every error this
      // file's evaluateWithRetries throws is already a sanitized, static
      // string (JevRateLimitError never reaches here -- callOnce handles it
      // separately), so err.name + err.message is safe -- but log only
      // those two fields, never a raw response body, even if that
      // invariant changes later.
      const name = err instanceof Error ? err.name : typeof err;
      const message = err instanceof Error ? clampErrorForLog(err.message) : "";
      console.error(`[jev-shadow] ${stage} call failed`, { name, message });
      captureException("jev-shadow", err);
    },

    async recordTokens(id, calls, inputTokens) {
      // service_role already has update on jev_shadow_runs (061:219) -- no
      // grant change needed. Deliberately not startedAt/finished_at: this
      // is a mid-run checkpoint, not a close.
      const { error } = await supabase
        .from("jev_shadow_runs")
        .update({ calls, input_tokens: inputTokens })
        .eq("id", id);
      if (error) throw new Error(`jev-shadow: recordTokens failed: ${error.message}`);
    },

    async monthTokens(cap) {
      const { data, error } = await supabase.rpc("jev_shadow_month_usage", { p_cap: cap });
      if (error) throw new Error(`jev-shadow: jev_shadow_month_usage failed: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as
        | { input_tokens: number; cap: number; exceeded: boolean }
        | undefined;
      if (!row) throw new Error("jev-shadow: jev_shadow_month_usage returned no row");
      return { input_tokens: row.input_tokens, cap: row.cap, exceeded: row.exceeded };
    },

    async startRun() {
      const { data, error } = await supabase.from("jev_shadow_runs").insert({}).select("id").single();
      if (error) throw new Error(`jev-shadow: startRun failed: ${error.message}`);
      return (data as { id: number }).id;
    },

    async finishRun(id: number, patch: { finished_at: string; calls: number; input_tokens: number; errors: number; status: JevRunStatus; note: string | null }) {
      const { error } = await supabase.from("jev_shadow_runs").update(patch).eq("id", id);
      if (error) throw new Error(`jev-shadow: finishRun failed: ${error.message}`);
    },

    async insertPredictions(rows) {
      if (rows.length === 0) return 0;
      // A redelivered cron poke must never 23505 the batch -- ignore rows
      // that already exist under (task, subject_id) and count only the
      // rows PostgREST actually inserted.
      const { data, error } = await supabase
        .from("jev_shadow_predictions")
        .upsert(rows, { onConflict: "task,subject_id", ignoreDuplicates: true })
        .select("task");
      if (error) throw new Error(`jev-shadow: insertPredictions failed: ${error.message}`);
      return (data ?? []).length;
    },

    async fetchPendingArticles(sinceIso, limit): Promise<JevArticleRow[]> {
      // Oldest-first is deliberate (drains the first-run 24h backlog --
      // pack.md). At steady state (144 sources, thousands of articles/day)
      // a single fixed-size oldest page is already fully seen, so page
      // forward through the window -- subtracting the anti-join per page --
      // until `limit` unseen rows are found or the window is exhausted,
      // hard-capped at JEV_ARTICLE_FETCH_MAX_PAGES so a pathological
      // backlog can't turn one run into an unbounded scan.
      const pageSize = limit * 2;
      const out: JevArticleRow[] = [];
      for (let page = 0; page < JEV_ARTICLE_FETCH_MAX_PAGES && out.length < limit; page++) {
        const from = page * pageSize;
        const { data, error } = await supabase
          .from("articles")
          .select("id, title, description, category, published_at, source:sources(slug)")
          .gte("published_at", sinceIso)
          .order("published_at", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw new Error(`jev-shadow: fetchPendingArticles failed: ${error.message}`);
        const rows = (data ?? []) as unknown as RawArticleFetchRow[];
        if (rows.length === 0) break;
        const seen = await anti_join(
          "politics",
          rows.map((r) => r.id),
        );
        for (const r of rows) {
          if (seen.has(r.id)) continue;
          const source = flattenEmbed(r.source);
          out.push({
            id: r.id,
            title: r.title,
            description: r.description,
            category: r.category,
            published_at: r.published_at,
            source_slug: source?.slug ?? null,
          });
          if (out.length >= limit) break;
        }
        if (rows.length < pageSize) break; // exhausted the 24h window
      }
      return out;
    },

    async fetchRecentClusters(sinceIso, limit): Promise<JevClusterRow[]> {
      const { data, error } = await supabase
        .from("clusters")
        .select("id, title_tr, title_tr_neutral, title_neutral_model, updated_at")
        .gte("updated_at", sinceIso)
        .gte("article_count", 2)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`jev-shadow: fetchRecentClusters failed: ${error.message}`);
      return ((data ?? []) as unknown as RawClusterFetchRow[]).map((c) => ({
        id: c.id,
        title: c.title_tr_neutral ?? c.title_tr,
        updated_at: c.updated_at,
        title_tr_neutral: c.title_tr_neutral,
        title_neutral_model: c.title_neutral_model,
      }));
    },

    async fetchClusterMembers(clusterIds): Promise<JevMemberRow[]> {
      if (clusterIds.length === 0) return [];
      const { data, error } = await supabase
        .from("cluster_articles")
        .select("cluster_id, article_id, article:articles(title, published_at)")
        .in("cluster_id", clusterIds as string[])
        .order("cluster_id", { ascending: true })
        .order("article_id", { ascending: true });
      if (error) throw new Error(`jev-shadow: fetchClusterMembers failed: ${error.message}`);
      const rows: JevMemberRow[] = [];
      for (const m of (data ?? []) as unknown as RawMemberFetchRow[]) {
        const a = flattenEmbed(m.article);
        if (!a) continue;
        rows.push({ cluster_id: m.cluster_id, article_id: m.article_id, title: a.title, published_at: a.published_at });
      }
      return rows;
    },

    async fetchPairCandidates(sinceIso, limit): Promise<JevPairCandidate[]> {
      // Query from the ARTICLES side: `articles.published_at` is indexed
      // (idx_articles_published_at) and the 24h window is a few thousand
      // rows, so the planner walks that index and joins cluster_articles
      // through idx_cluster_articles_article_id. The `!inner` embed drops
      // unclustered articles server-side. The first production run proved
      // the mirror-image query (from cluster_articles, `articles!inner`,
      // ordered by the embedded column) joins all ~250k cluster_articles
      // rows before sorting and trips the authenticator role's 8s
      // statement_timeout.
      const { data, error } = await supabase
        .from("articles")
        .select("id, title, published_at, cluster_articles!inner(cluster_id)")
        .gte("published_at", sinceIso)
        .order("published_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`jev-shadow: fetchPairCandidates failed: ${error.message}`);
      const out: JevPairCandidate[] = [];
      for (const a of (data ?? []) as unknown as RawPairFetchRow[]) {
        const ca = flattenEmbed(a.cluster_articles);
        if (!ca) continue;
        out.push({ id: a.id, cluster_id: ca.cluster_id, title: a.title, published_at: a.published_at });
      }
      return out;
    },

    async fetchAuditPairs(sinceIso, clusterLimit): Promise<JevPairCandidate[]> {
      // Same shape as fetchPairCandidates, but pair construction for audit
      // mode is pure and lives in sampleClusterPairs (_shared/jev.ts) -- this
      // port only fetches cluster MEMBERS updated since sinceIso.
      const { data: clusterRows, error: clusterError } = await supabase
        .from("clusters")
        .select("id")
        .gte("updated_at", sinceIso)
        .gte("article_count", 2)
        .order("updated_at", { ascending: false })
        .limit(clusterLimit);
      if (clusterError) throw new Error(`jev-shadow: fetchAuditPairs failed: ${clusterError.message}`);
      const clusterIds = ((clusterRows ?? []) as unknown as RawAuditClusterRow[]).map((c) => c.id);
      if (clusterIds.length === 0) return [];

      // clusterLimit (200) is above every existing fetchClusterMembers call
      // site's <= 40 ids, so this port chunks its `.in("cluster_id", ...)`
      // by the shared JEV_ID_CHUNK (100) the same way anti_join does --
      // never queries from the articles side ordered by an embedded column
      // (the fetchPairCandidates comment above explains why that direction
      // trips the authenticator role's 8s statement_timeout).
      const out: JevPairCandidate[] = [];
      for (let i = 0; i < clusterIds.length; i += JEV_ID_CHUNK) {
        const chunk = clusterIds.slice(i, i + JEV_ID_CHUNK);
        const { data, error } = await supabase
          .from("cluster_articles")
          .select("cluster_id, article_id, article:articles(title, published_at)")
          .in("cluster_id", chunk)
          .order("cluster_id", { ascending: true })
          .order("article_id", { ascending: true });
        if (error) throw new Error(`jev-shadow: fetchAuditPairs failed: ${error.message}`);
        for (const m of (data ?? []) as unknown as RawMemberFetchRow[]) {
          const a = flattenEmbed(m.article);
          if (!a) continue;
          out.push({ id: m.article_id, cluster_id: m.cluster_id, title: a.title, published_at: a.published_at });
        }
      }
      return out;
    },

    async fetchPendingTickerMatches(sinceIso, limit): Promise<JevTickerRow[]> {
      // Query from the SMALL indexed side -- article_tickers carries its own
      // published_at and takes ~70 rows/day. The mirror-image
      // `.from("articles")` with an `article_tickers!inner` embed ordered by
      // the embedded column is the exact shape that tripped the
      // authenticator role's 8s statement_timeout in fetchPairCandidates
      // above and in src/lib/finance/queries.ts (DB-02). JEV-A17 in
      // tests/migrations/jev-shadow-parity.test.ts pins this direction
      // statically.
      const { data, error } = await supabase
        .from("article_tickers")
        .select("article_id, ticker, matched_on, article:articles(title, description)")
        .gte("published_at", sinceIso)
        .order("published_at", { ascending: false })
        .range(0, limit * 2 - 1);
      if (error) throw new Error(`jev-shadow: fetchPendingTickerMatches failed: ${error.message}`);
      const rows = (data ?? []) as unknown as RawTickerFetchRow[];
      if (rows.length === 0) return [];

      // Anti-join BEFORE anything else -- skipping this makes every run
      // re-pay the gateway for rows the upsert then silently discards (the
      // JEV-A10 lesson).
      const seen = await anti_join(
        "ticker_relevance",
        rows.map((r) => `${r.article_id}:${r.ticker}`),
      );
      const unseen = rows.filter((r) => !seen.has(`${r.article_id}:${r.ticker}`));
      if (unseen.length === 0) return [];

      // Exactly ONE bist_companies query per run, never one per ticker --
      // built into an in-memory Map by iterating each row's tickers array.
      // Bounded to JEV_BIST_COMPANIES_LIMIT: without an explicit limit, a
      // PostgREST db-max-rows setting could silently truncate this select
      // and every ticker past the cut becomes company `undefined` at once
      // (M5) -- fail loudly instead of degrading silently.
      const { data: companyRows, error: companyError } = await supabase
        .from("bist_companies")
        .select("tickers, title")
        .limit(JEV_BIST_COMPANIES_LIMIT);
      if (companyError) throw new Error(`jev-shadow: fetchPendingTickerMatches failed: ${companyError.message}`);
      const companyRowsTyped = (companyRows ?? []) as unknown as RawBistCompanyRow[];
      if (companyRowsTyped.length === JEV_BIST_COMPANIES_LIMIT) {
        throw new Error(
          `jev-shadow: fetchPendingTickerMatches: bist_companies returned JEV_BIST_COMPANIES_LIMIT (${JEV_BIST_COMPANIES_LIMIT}) rows -- likely truncated by a PostgREST db-max-rows setting`,
        );
      }
      const companyByTicker = new Map<string, string>();
      for (const c of companyRowsTyped) {
        for (const t of c.tickers ?? []) companyByTicker.set(t, c.title);
      }

      const out: JevTickerRow[] = [];
      for (const r of unseen) {
        // Skip unmapped tickers rather than writing a null company (M5):
        // the registry question asks about "the company named in
        // `company`", and jev_shadow_predictions' unique (task, subject_id)
        // with ignoreDuplicates means a poisoned null-company row could
        // never be re-asked once bist_companies gains the alias -- the
        // anti-join makes skipping self-healing on a later run instead.
        const company = companyByTicker.get(r.ticker);
        if (company === undefined) continue;
        const a = flattenEmbed(r.article);
        if (!a) continue;
        out.push({
          article_id: r.article_id,
          ticker: r.ticker,
          title: a.title,
          description: a.description,
          company,
          matched_on: r.matched_on,
        });
        if (out.length >= limit) break;
      }
      return out;
    },

    async fetchPendingKap(sinceIso, limit): Promise<JevKapRow[]> {
      const { data, error } = await supabase
        .from("kap_disclosures")
        .select("disclosure_index, kap_title, subject, summary, disclosure_class, stock_codes")
        .gte("published_at", sinceIso)
        .not("disclosure_class", "is", null)
        .order("published_at", { ascending: false })
        .range(0, limit * 2 - 1);
      if (error) throw new Error(`jev-shadow: fetchPendingKap failed: ${error.message}`);
      // disclosure_index is `bigint primary key` (049_finance_substrate.sql),
      // so PostgREST returns it as a JSON number -- normalise to text at the
      // port boundary (same discipline as the title port's String(r.id)
      // below) since jev_shadow_predictions.subject_id and the anti-join
      // Set are both text.
      const rows = ((data ?? []) as unknown as Array<Omit<JevKapRow, "disclosure_index"> & { disclosure_index: number | string }>).map(
        (r) => ({ ...r, disclosure_index: String(r.disclosure_index) }),
      );
      if (rows.length === 0) return [];
      const seen = await anti_join(
        "kap_class",
        rows.map((r) => r.disclosure_index),
      );
      const out: JevKapRow[] = [];
      for (const r of rows) {
        if (seen.has(r.disclosure_index)) continue;
        out.push(r);
        if (out.length >= limit) break;
      }
      return out;
    },

    async fetchPendingTitleVersions(sinceIso, limit): Promise<JevTitleRow[]> {
      const { data, error } = await supabase
        .from("article_title_versions")
        .select("id, article_id, old_title, new_title")
        .gte("seen_at", sinceIso)
        .order("seen_at", { ascending: false })
        .range(0, limit * 2 - 1);
      if (error) throw new Error(`jev-shadow: fetchPendingTitleVersions failed: ${error.message}`);
      const rows = (data ?? []) as unknown as RawTitleVersionFetchRow[];
      if (rows.length === 0) return [];
      const seen = await anti_join(
        "title_meaning",
        rows.map((r) => String(r.id)),
      );
      const out: JevTitleRow[] = [];
      for (const r of rows) {
        const subjectId = String(r.id);
        if (seen.has(subjectId)) continue;
        out.push({ id: subjectId, article_id: r.article_id, old_title: r.old_title, new_title: r.new_title });
        if (out.length >= limit) break;
      }
      return out;
    },

    async insertUnlinkCandidates(rows: readonly JevUnlinkCandidateRow[]): Promise<number> {
      if (rows.length === 0) return 0;
      // A re-ask of an already-queued (cluster, article) pair must never
      // 23505 the batch, and must never resurrect a row a human already
      // decided (status moves to 'unlinked'/'kept' and stays there) --
      // ignoreDuplicates against the unique (cluster_id, article_id) key.
      const { data, error } = await supabase
        .from("jev_unlink_candidates")
        .upsert(rows, { onConflict: "cluster_id,article_id", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(`jev-shadow: insertUnlinkCandidates failed: ${error.message}`);
      return (data ?? []).length;
    },

    async fetchBlindspotClusters(sinceIso, limit): Promise<JevBlindspotClusterRow[]> {
      const { data, error } = await supabase
        .from("clusters")
        .select("id, title_tr, title_tr_neutral, blindspot_side, first_published, updated_at")
        .eq("is_blindspot", true)
        .gte("updated_at", sinceIso)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`jev-shadow: fetchBlindspotClusters failed: ${error.message}`);
      return ((data ?? []) as unknown as RawBlindspotClusterFetchRow[]).map((c) => ({
        id: c.id,
        title: c.title_tr_neutral ?? c.title_tr,
        blindspot_side: c.blindspot_side,
        first_published: c.first_published,
        updated_at: c.updated_at,
      }));
    },

    async fetchBlindspotCandidates(query: JevBlindspotCandidateQuery): Promise<JevBlindspotCandidate[]> {
      // (a) existing members -- never re-suggest an article already in the cluster.
      const { data: memberRows, error: memberError } = await supabase
        .from("cluster_articles")
        .select("article_id")
        .eq("cluster_id", query.clusterId);
      if (memberError) throw new Error(`jev-shadow: fetchBlindspotCandidates failed: ${memberError.message}`);
      const memberIds = new Set(
        ((memberRows ?? []) as unknown as RawBlindspotMemberIdRow[]).map((m) => m.article_id),
      );

      // (b) source ids for the silent zone's bias categories. Only VOTING
      // kinds count -- mirrors is_blindspot's own voting-kind restriction
      // (_shared/cluster/source-kind.ts, and the 064 RPC's own
      // `s.kind in ('outlet', 'wire')` recompute) so a non-voting source
      // (aggregator/niche) can never raise a blindspot_recall_suspect flag
      // for a verdict it never contributed to.
      const { data: sourceRows, error: sourceError } = await supabase
        .from("sources")
        .select("id")
        .in("bias", query.biasKeys as string[])
        .in("kind", VOTING_SOURCE_KINDS as unknown as string[]);
      if (sourceError) throw new Error(`jev-shadow: fetchBlindspotCandidates failed: ${sourceError.message}`);
      const sourceIds = ((sourceRows ?? []) as unknown as RawBlindspotSourceIdRow[]).map((s) => s.id);
      if (sourceIds.length === 0) return [];

      // (c) query FROM THE ARTICLES SIDE ONLY (indexed published_at),
      // chunked by JEV_ID_CHUNK -- never from cluster_articles with an
      // articles!inner embed ordered by the embedded column, the shape
      // that has already tripped the authenticator role's 8s
      // statement_timeout twice in this repo (fetchPairCandidates above).
      const out: JevBlindspotCandidate[] = [];
      for (let i = 0; i < sourceIds.length; i += JEV_ID_CHUNK) {
        const chunk = sourceIds.slice(i, i + JEV_ID_CHUNK);
        const { data, error } = await supabase
          .from("articles")
          .select("id, title, published_at, source:sources(slug)")
          .in("source_id", chunk)
          .in("category", JEV_POLITICS_CATEGORIES as unknown as string[])
          .gte("published_at", query.fromIso)
          .lte("published_at", query.toIso)
          .order("published_at", { ascending: false })
          .limit(query.limit);
        if (error) throw new Error(`jev-shadow: fetchBlindspotCandidates failed: ${error.message}`);
        for (const a of (data ?? []) as unknown as RawBlindspotCandidateFetchRow[]) {
          if (memberIds.has(a.id)) continue;
          const source = flattenEmbed(a.source);
          out.push({ article_id: a.id, title: a.title, published_at: a.published_at, source_slug: source?.slug ?? null });
        }
      }
      out.sort((a, b) => b.published_at.localeCompare(a.published_at));
      return out.slice(0, query.limit);
    },

    async markBlindspotChecked(clusterId: string, suspect: boolean): Promise<void> {
      // DB-06 / SEC-064-03 fix: write the flag unconditionally. suspect is
      // the CURRENT verdict, not a latch -- a negative re-check must clear
      // a stale `true` (and stop pushing checked_at forward to keep a
      // one-time suspicion inside getJevBlindspotSuspects' 7-day window),
      // matching the 064 column comment ("Written on every check, suspect
      // or not").
      const patch = { blindspot_recall_suspect: suspect, blindspot_recall_checked_at: new Date().toISOString() };
      const { error } = await supabase.from("clusters").update(patch).eq("id", clusterId);
      if (error) throw new Error(`jev-shadow: markBlindspotChecked failed: ${error.message}`);
    },

    // --- Migration 066: frozen regression set --------------------------------

    async fetchRegressionItems(kind, limit): Promise<JevRegressionItem[]> {
      const { data, error } = await supabase
        .from("jev_regression_items")
        .select("id, kind, subject_id, state, in_gold")
        .eq("kind", kind)
        .order("id", { ascending: true })
        .limit(limit);
      if (error) throw new Error(`jev-shadow: fetchRegressionItems failed: ${error.message}`);
      return (data ?? []) as unknown as JevRegressionItem[];
    },

    async insertRegressionAnswers(rows): Promise<number> {
      if (rows.length === 0) return 0;
      // The primary key IS the idempotency key -- upsert on conflict
      // (run_id, item_id, task) DO UPDATE, so a retried write corrects
      // instead of 23505-ing.
      const { data, error } = await supabase
        .from("jev_regression_answers")
        .upsert(rows, { onConflict: "run_id,item_id,task" })
        .select("task");
      if (error) throw new Error(`jev-shadow: insertRegressionAnswers failed: ${error.message}`);
      return (data ?? []).length;
    },

    async startRegressionRun(questionSet): Promise<number> {
      const { data, error } = await supabase
        .from("jev_regression_runs")
        .insert({ question_set: questionSet })
        .select("id")
        .single();
      if (error) throw new Error(`jev-shadow: startRegressionRun failed: ${error.message}`);
      return (data as { id: number }).id;
    },

    async finishRegressionRun(id, patch): Promise<void> {
      const { error } = await supabase.from("jev_regression_runs").update(patch).eq("id", id);
      if (error) throw new Error(`jev-shadow: finishRegressionRun failed: ${error.message}`);
    },

    async fetchPreviousRegressionAnswers(currentRunId): Promise<JevRegressionAnswerRow[]> {
      // The baseline is the most recent status='ok' run BELOW this run's id
      // -- a deadline-truncated 'partial' run answered only a prefix of the
      // set, so promoting it would make the next run's flip counts depend
      // on where the deadline landed.
      const { data: baseline, error: baselineError } = await supabase
        .from("jev_regression_runs")
        .select("id")
        .eq("status", "ok")
        .lt("id", currentRunId)
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (baselineError) {
        throw new Error(`jev-shadow: fetchPreviousRegressionAnswers failed: ${baselineError.message}`);
      }
      if (!baseline) return [];
      const baselineRunId = (baseline as { id: number }).id;

      // 400 articles x 7 tasks + 100 pairs is 2900 rows, well over
      // PostgREST's default 1000-row ceiling -- page with .range(), capped
      // at JEV_REGRESSION_ANSWER_MAX_PAGES, or an unpaged read would
      // silently truncate the baseline and manufacture flips.
      const out: JevRegressionAnswerRow[] = [];
      for (let page = 0; page < JEV_REGRESSION_ANSWER_MAX_PAGES; page++) {
        const from = page * JEV_REGRESSION_ANSWER_PAGE;
        const to = from + JEV_REGRESSION_ANSWER_PAGE - 1;
        const { data, error } = await supabase
          .from("jev_regression_answers")
          .select("run_id, item_id, task, jev_prob, jev_choice")
          .eq("run_id", baselineRunId)
          .order("item_id", { ascending: true })
          .order("task", { ascending: true })
          .range(from, to);
        if (error) throw new Error(`jev-shadow: fetchPreviousRegressionAnswers failed: ${error.message}`);
        const rows = (data ?? []) as unknown as JevRegressionAnswerRow[];
        out.push(...rows);
        if (rows.length < JEV_REGRESSION_ANSWER_PAGE) break;
      }
      return out;
    },

    async fetchGoldLabels(articleIds): Promise<JevGoldLabelRow[]> {
      if (articleIds.length === 0) return [];
      const rows: Array<{ article_id: string; labeler: number; is_politics: boolean; topic: string }> = [];
      for (let i = 0; i < articleIds.length; i += JEV_ID_CHUNK) {
        const chunk = articleIds.slice(i, i + JEV_ID_CHUNK) as string[];
        const { data, error } = await supabase
          .from("jev_gold_labels")
          .select("article_id, labeler, is_politics, topic")
          .in("article_id", chunk);
        if (error) throw new Error(`jev-shadow: fetchGoldLabels failed: ${error.message}`);
        rows.push(...((data ?? []) as unknown as Array<{ article_id: string; labeler: number; is_politics: boolean; topic: string }>));
      }
      // Already agreement-filtered -- agreedGoldLabels keeps only rows where
      // labeler 1 and labeler 2 both exist and agree on both fields.
      return agreedGoldLabels(rows);
    },
  };
}

// ---------------------------------------------------------------------------
// Gateway call -- RAW FETCH, no npm:ai (the @vercel/oidc `--allow-sys`
// cold-start trap). Exactly the six verified-contract headers plus a
// tayf User-Agent, AbortSignal.timeout(20_000) (the kap-ingest /
// headline-route plain-fetch-with-timeout precedent -- deliberately not
// wrapped in safeFetch: the host is fixed and operator-configured, not
// user input).
//
// SECURITY, non-negotiable: never log the Authorization header or `key`.
// The gateway's error body (a 401 embeds an API-key-creation URL; a 400
// echoes request paths) is read ONLY to classify the failure
// (rate-limit pattern match, offendingQuestionIds) -- its text is never
// passed to console.*, never returned in the Response this function
// produces, and never stored. Only status codes and latency are logged.
// ---------------------------------------------------------------------------

async function fetchOnce(
  key: string,
  request: JevRequest,
): Promise<{ status: number; latencyMs: number; json: unknown; text: string }> {
  const started = Date.now();
  const res = await fetch(JEV_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
      "ai-gateway-protocol-version": JEV_PROTOCOL_VERSION,
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": JEV_SPEC_VERSION,
      "ai-model-id": JEV_MODEL,
      "User-Agent": "tayf-jev-shadow/1",
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(20_000),
  });
  const latencyMs = Date.now() - started;
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, latencyMs, json, text };
}

function looksRateLimited(status: number, text: string): boolean {
  return isRateLimitStatus(status) || /rate.?limit|too many/i.test(text);
}

async function evaluateWithRetries(
  key: string,
  initialRequest: JevRequest,
): Promise<{ response: JevResponse; latencyMs: number }> {
  let request = initialRequest;
  let droppedQuestionsOnce = false;
  let attempt = 0;

  for (;;) {
    let result: { status: number; latencyMs: number; json: unknown; text: string };
    try {
      result = await fetchOnce(key, request);
    } catch (err) {
      // Network failure or AbortSignal timeout -- the generic retry ladder.
      if (attempt >= JEV_MAX_RETRIES) {
        console.error("[jev-shadow] gateway fetch failed after max retries", { attempt });
        throw new Error("gateway-error");
      }
      console.error("[jev-shadow] gateway fetch error, retrying", { attempt, kind: err instanceof Error ? err.name : "unknown" });
      await sleep(retryDelayMs(attempt));
      attempt++;
      continue;
    }

    if (result.status === 200) {
      return { response: parseJevResponse(result.json), latencyMs: result.latencyMs };
    }

    if (looksRateLimited(result.status, result.text)) {
      console.error("[jev-shadow] gateway rate limited", { status: result.status });
      throw new JevRateLimitError(`gateway rate limited (status ${result.status})`);
    }

    if (result.status === 400) {
      console.error("[jev-shadow] gateway 400", { status: result.status });
      if (!droppedQuestionsOnce) {
        const offending = offendingQuestionIds(result.json);
        const sentIds = Object.keys(request.questions);
        const namesExactlySent = offending.length > 0 && offending.every((id) => sentIds.includes(id));
        if (namesExactlySent) {
          const trimmedQuestions = Object.fromEntries(
            Object.entries(request.questions).filter(([id]) => !offending.includes(id)),
          );
          if (Object.keys(trimmedQuestions).length > 0) {
            request = { ...request, questions: trimmedQuestions };
            droppedQuestionsOnce = true;
            continue;
          }
        }
      }
      throw new Error("gateway-error");
    }

    if (result.status >= 500) {
      if (attempt >= JEV_MAX_RETRIES) {
        console.error("[jev-shadow] gateway 5xx after max retries", { status: result.status, attempt });
        throw new Error("gateway-error");
      }
      console.error("[jev-shadow] gateway 5xx, retrying", { status: result.status, attempt });
      await sleep(retryDelayMs(attempt));
      attempt++;
      continue;
    }

    console.error("[jev-shadow] gateway unexpected status", { status: result.status });
    throw new Error("gateway-error");
  }
}

// ---------------------------------------------------------------------------
// HTTP envelope
// ---------------------------------------------------------------------------

await initSentry("jev-shadow");

Deno.serve(withSentry("jev-shadow", async (req: Request) => {
  const denied = requireServiceRoleBearer(req);
  if (denied) return denied;

  if (req.method === "GET") {
    return jsonResponse({ ok: true, ready: true });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // No overrides are supported beyond `mode` (no `{"limit_articles": n}`
  // style knobs) -- the only accepted bodies are empty, or a JSON object
  // whose fields are ignored except `mode`. Anything that isn't valid JSON,
  // or isn't an object, is a 400.
  let text: string;
  try {
    text = await req.text();
  } catch {
    return jsonResponse({ ok: false, error: "bad-json" }, 400);
  }
  let parsed: unknown;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      return jsonResponse({ ok: false, error: "bad-json" }, 400);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return jsonResponse({ ok: false, error: "bad-json" }, 400);
    }
  }

  // Kill switch -- checked BEFORE any database read, run row, or gateway
  // call. Placed after the bearer check above (so an unauthenticated poke
  // still 401s) but before AI_GATEWAY_API_KEY and makePorts() (so it costs
  // zero Supabase client construction and zero DB round trips).
  const disabled = Deno.env.get("JEV_DISABLED") ?? "";
  if (disabled === "1" || disabled.toLowerCase() === "true") {
    console.log("[jev-shadow] skipped: JEV_DISABLED");
    return jsonResponse({ ok: true, skipped: true, reason: "disabled" });
  }

  // The accepted body fields: `{"mode":"audit"}` selects the nightly
  // accuracy audit; `{"mode":"regression"}` (066) selects the frozen
  // regression-set replay; a missing mode, `{}`, `{"mode":"shadow"}`, or any
  // other string all select the normal shadow run. `{"limit_articles":
  // n}`-style knobs are still refused, simply by being ignored.
  const rawMode = (parsed as { mode?: unknown } | undefined)?.mode;
  const mode: JevRunMode = rawMode === "regression" ? "regression" : rawMode === "audit" ? "audit" : "shadow";

  // Fail-safe: no key configured -> no run row, no gateway call (the
  // RESEND_API_KEY precedent in src/lib/email/resend.ts). This is the
  // ONLY place this file reads the gateway key from the environment.
  const apiKey = Deno.env.get("AI_GATEWAY_API_KEY") ?? "";
  if (!apiKey) {
    console.log("[jev-shadow] skipped: no gateway key configured");
    return jsonResponse({ ok: true, skipped: true, reason: "no-api-key" });
  }

  try {
    // `|| JEV_MONTHLY_TOKEN_CAP_DEFAULT` would treat 0 as falsy -- an
    // operator setting JEV_MONTHLY_TOKEN_CAP=0 as an emergency "spend
    // nothing" lever (pack.md's documented cost lever) would silently get
    // the default instead. Parse explicitly so 0 is honoured and junk
    // still falls back.
    const rawCap = Deno.env.get("JEV_MONTHLY_TOKEN_CAP");
    const parsedCap = rawCap === undefined || rawCap.trim() === "" ? NaN : Number(rawCap);
    const cap = Number.isFinite(parsedCap) && parsedCap >= 0 ? parsedCap : JEV_MONTHLY_TOKEN_CAP_DEFAULT;
    const result = await runJevShadow(makePorts(apiKey), { deadlineMs: JEV_DEADLINE_MS, cap, mode });
    console.log("[jev-shadow]", JSON.stringify(result));
    return jsonResponse(result);
  } catch (err) {
    const request_id = crypto.randomUUID();
    captureException("jev-shadow", err);
    console.error(`[jev-shadow] ${request_id}`, err);
    const status = err instanceof JevDeadlineError ? 504 : 500;
    return jsonResponse({ ok: false, error: err instanceof JevDeadlineError ? "deadline" : "internal-error", request_id }, status);
  }
}));
