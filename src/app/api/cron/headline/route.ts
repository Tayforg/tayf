import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { connection, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { requireCronBearer } from "@/lib/api/bearer";
import { withCronOutcome } from "@/lib/ops/cron-route-outcome";
import { apiTooManyRequests, apiServerError, withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import {
  buildHeadlinePrompt,
  HEADLINE_MIN_ARTICLE_COUNT,
  HEADLINE_PROMPT_VERSION,
} from "@/lib/headline/prompt";
import {
  EXTRACTIVE_MODEL_ID,
  isAcceptableNeutral,
  pickNeutralTitle,
} from "@/lib/clusters/neutral-title";
import { captureServerException } from "@/lib/sentry/server";
import { fetchHeadlineEligibility } from "@/lib/headline/eligibility";
import {
  addHeadlineBudget,
  addHeadlineGateCounts,
  estimateCallUsd,
  headlineLlmDailyCapUsd,
  readHeadlineBudget,
  utcDay,
} from "@/lib/headline/budget";

// Boot-time guard. The route is FAIL-CLOSED on a missing `CRON_SECRET` (503
// on every invocation), but in production that failure is otherwise only
// visible per-request. Surface it once at module-load so a mis-configured
// deploy is obvious in the build/boot logs rather than silently 503-ing the
// scheduled cron every 5 minutes. Idempotent: runs once per module init.
if (process.env.NODE_ENV === "production" && !process.env.CRON_SECRET) {
  console.warn(
    "[headline-cron] CRON_SECRET is not set; route will fail-closed with 503 on every invocation",
  );
}

// Same boot-time visibility for a missing LLM key: without it the route runs
// in extractive mode (picks and cleans a member headline, see
// src/lib/clusters/neutral-title.ts) rather than calling an LLM. Correct
// fail-safe behaviour, but an operator staring at the boot log should be
// able to tell at a glance why titles are extractive. Idempotent.
if (process.env.NODE_ENV === "production" && !process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "[headline-cron] ANTHROPIC_API_KEY is not set; running in extractive mode",
  );
}

/**
 * Vercel cron — neutral-headline rewriter.
 *
 * Replaces the long-running tmux headline-worker process with a stateless
 * serverless invocation that runs every 5 minutes (see `vercel.ts`).
 *
 * BEHAVIOUR
 * ---------
 * Walks the partial index `idx_clusters_needs_rewrite`
 * (`title_neutral_at IS NULL AND article_count >= 3`) in a small batch,
 * fetches the member article titles for each candidate cluster, asks the
 * configured LLM API for a neutral Turkish summary headline, then writes the
 * result into `clusters.title_tr_neutral` and stamps
 * `title_neutral_at = now()`. The LLM cost stays under $1/month at the
 * default cadence — keep the batch small.
 *
 * EXTRACTIVE MODE
 * ---------------
 * With no ANTHROPIC_API_KEY the route does not go idle: it picks the most
 * central, least sensational member headline and strips the outlet's
 * framing from it (`src/lib/clusters/neutral-title.ts`). That costs
 * nothing, so it covers 2+ source clusters in a bigger batch. It fills
 * `title_tr_neutral`, stamps `title_neutral_model = EXTRACTIVE_MODEL_ID`
 * (`extractive-v3`) and `title_neutral_member_count` (the cluster's
 * article_count at pick time) but leaves `title_neutral_at` NULL — so nothing
 * that counts "AI neutralized" (rss.xml, /metodoloji, /api/metrics) counts
 * these, and enabling the LLM later re-titles the same clusters. The
 * extractive title is a floor, not a verdict. A first pick never comes back
 * empty because every member fails the acceptance gate: `{ floor: true }`
 * returns the cleaned best candidate instead of leaving the raw `title_tr`
 * on every surface (and the row in the IS NULL pick for good).
 *
 * LLM MODE REJECTIONS
 * -------------------
 * An LLM rewrite that fails isAcceptableNeutral (`generated`: no feed-cut
 * check) is not written. The call is already metered, so the cluster gets
 * `title_neutral_prompt_version = '<HEADLINE_PROMPT_VERSION>:rejected'` (plus
 * the floor pick when it had no title) and the LLM pick skips that mark: the
 * gate is deterministic, so without it the same cluster would be re-sent and
 * re-billed every tick. A prompt version bump retries those clusters.
 *
 * RE-PICK (extractive mode only)
 * ------------------------------
 * An extractive title is picked when a cluster first reaches 2 members, so it
 * goes stale as the cluster grows and whenever the picker's rules change
 * (EXTRACTIVE_MODEL_ID bump). After the IS NULL pass, with what is left of
 * the 50-write budget (at most REPICK_BATCH = 20) and only while the run is
 * under 40 s old, the route asks `neutral_title_repick_candidates` (migration
 * 141) for active clusters of the last 14 days whose pick came from another
 * model, was never stamped, or has been outgrown, and re-picks them from all
 * fetched members. The re-pick is conservative (hunt 16: #156 replaced about
 * half of the good stored titles with fragments): the stored title goes to
 * `pickNeutralTitle` as the incumbent and stays unless it fails the acceptance
 * gate or the best member title outscores it by REPICK_MARGIN (0.05, a stored
 * title under 45 characters) or REPICK_MARGIN_FULL_LENGTH (0.20, a longer one;
 * a replay over 150 good titles changes 12.7% of them, not 38%). It writes
 * `title_tr_neutral` only when the pick changed (a kept title writes the model
 * and the count alone), always stamps the model and the article_count, only
 * touches rows whose `title_neutral_at` IS NULL, and NEVER writes
 * `clusters.updated_at` (it orders the home feed: a healed title must not make
 * an old story look new).
 * There is no backfill UPDATE anywhere: existing rows heal through this
 * loop at ~20 per run, newest first. An rpc failure is logged and the run
 * still answers 200.
 *
 * AUTH
 * ----
 * Gated by `requireCronBearer` (`src/lib/api/bearer.ts`): constant-time
 * token comparison, case-insensitive scheme, FAIL-CLOSED 503 when
 * `CRON_SECRET` is unset (or empty) in the runtime environment. Vercel cron
 * pings this endpoint with `Authorization: Bearer <CRON_SECRET>`
 * automatically; any external caller must supply the same header.
 */

// Vercel Pro Hobby/Pro tier ceiling for cron routes. Per-cycle work is
// LLM-bound (one network round-trip per cluster, sequential) so 60s leaves
// headroom even on slow LLM responses while still keeping the cron quick
// enough to overlap cleanly with the */5 schedule.
export const maxDuration = 60;

// Token-bucket guard — the cron itself ticks every 5 minutes (well under
// the limit), so this exists mainly to protect against accidental curl
// floods if the endpoint is hit ad-hoc with a valid secret.
const headlineLimit = createRateLimiter("cron-headline", {
  capacity: 5,
  refillPerSecond: 1 / 60,
});

// LLM batch size. Matches `scripts/headline-worker.mjs` — small on purpose
// so a transient 5xx doesn't blow the whole cycle and so monthly spend
// stays bounded.
const LLM_BATCH = 5;

// Extractive mode has no per-cluster cost, so it covers every multi-source
// cluster and drains faster. Selection is on title_tr_neutral IS NULL, which
// migration 019's partial index does not cover; at ~100k clusters with the
// is_archived + article_count filters the scan is still milliseconds.
const EXTRACTIVE_MIN_ARTICLE_COUNT = 2;
const EXTRACTIVE_BATCH = 50;

// Members fetched per cluster. The LLM prompt slices to the newest 8
// itself (src/lib/headline/prompt.ts); the extractive picker scores every
// fetched title, so a big story is judged on all of its outlets, not on the
// arbitrary 16 the old unordered fetch returned.
const MEMBER_FETCH_CAP = 200;

// clusters.title_neutral_member_count is a smallint.
const MEMBER_COUNT_MAX = 32767;

// Extractive re-pick (migration 141): rows per run, and the age of the run
// after which the pass is skipped (maxDuration is 60 s).
const REPICK_BATCH = 20;
const REPICK_DEADLINE_MS = 40_000;

// Re-exported from src/lib/headline/prompt.ts so /metodoloji can state the
// threshold without hardcoding a literal that could drift from this gate.
const MIN_ARTICLE_COUNT = HEADLINE_MIN_ARTICLE_COUNT;

// Stamped into clusters.title_neutral_prompt_version when the acceptance gate
// rejects an LLM rewrite (a paid call already metered). The LLM pick excludes
// it, so a rejected cluster is not re-sent every tick; a new
// HEADLINE_PROMPT_VERSION changes the mark and retries those clusters. A
// rejected rewrite never gets title_neutral_at, so nothing counts it as an AI
// neutralization.
const LLM_REJECTED_MARK = `${HEADLINE_PROMPT_VERSION}:rejected`;

// Vendor URL + model id default to the current upstream provider, but operators
// can swap providers without a code change by setting LLM_API_URL / LLM_MODEL
// in the runtime environment. The hardcoded fallback keeps backward-compat
// with deployments that have not yet set these vars.
const LLM_API_URL =
  process.env.LLM_API_URL ?? "https://api.anthropic.com/v1/messages";
const LLM_MODEL =
  process.env.LLM_MODEL ?? "claude-haiku-4-5-20251001";

interface ClusterCandidate {
  id: string;
  title_tr: string | null;
  title_tr_neutral: string | null;
  summary_tr: string | null;
  article_count: number;
}

// PostgREST returns embedded selects as arrays when the FK is many-to-one;
// the legacy worker treated it as a single object. Accept both shapes here.
type ClusterArticleNested = { title: string | null; published_at: string | null };
interface ClusterArticleRow {
  articles: ClusterArticleNested | ClusterArticleNested[] | null;
}

/**
 * Ask the configured LLM for a neutral, factual aggregator headline for a
 * cluster. This route is the sole caller and source-of-truth for the
 * neutral-headline prompt since the worker-stream refactor retired the
 * tmux-based headline runner.
 */
async function rewriteClusterHeadline(input: {
  member_titles: string[];
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("LLM API key not set");
  }

  const prompt = buildHeadlinePrompt(input.member_titles);

  const res = await fetch(LLM_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    content?: Array<{ text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  // Do NOT throw on empty content: the vendor has already billed this 200.
  // Return the usage counts so the caller can meter the spend, then let its
  // existing `if (!result.text)` branch record status "errored".
  const text = data.content?.[0]?.text?.trim() ?? "";
  const cleaned = text.replace(/^["'“‘]|["'”’]$/g, "").trim();
  return {
    text: cleaned,
    // A 200 with no usage object must not meter as free; fall back to a
    // conservative non-zero estimate (prompt chars/4 in, max_tokens out).
    inputTokens: data.usage?.input_tokens ?? Math.ceil(prompt.length / 4),
    outputTokens: data.usage?.output_tokens ?? 100,
  };
}

interface MemberItem {
  title: string;
  published_at: string | null;
}

/**
 * The titles of a cluster's articles, newest first, capped at
 * MEMBER_FETCH_CAP. Both passes use it. Ties on `published_at` break on the
 * title, so equal timestamps order the same on every run and the picker's
 * stable tie-break is deterministic.
 */
async function fetchMemberItems(
  supabase: SupabaseClient,
  clusterId: string,
): Promise<{ items: MemberItem[]; error: PostgrestError | null }> {
  const { data: memberRows, error } = await supabase
    .from("cluster_articles")
    .select("articles ( title, published_at )")
    .eq("cluster_id", clusterId)
    .limit(MEMBER_FETCH_CAP);
  if (error) return { items: [], error };

  const items: MemberItem[] = [];
  for (const r of (memberRows ?? []) as unknown as ClusterArticleRow[]) {
    const a = Array.isArray(r.articles) ? r.articles[0] : r.articles;
    if (!a || !a.title) continue;
    items.push({ title: a.title, published_at: a.published_at });
  }
  // Newest-first so the LLM sees the freshest framings of the story.
  items.sort((a, b) => {
    const ta = a.published_at ? new Date(a.published_at).getTime() : 0;
    const tb = b.published_at ? new Date(b.published_at).getTime() : 0;
    if (tb !== ta) return tb - ta;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });
  return { items, error: null };
}

/** What a stamp writes: the cluster's article_count, not the number of titles the picker saw. */
function memberCountStamp(articleCount: number): number {
  return Math.min(articleCount, MEMBER_COUNT_MAX);
}

/**
 * Writes an extractive title/stamp to one cluster. Never carries `updated_at`
 * (it orders the home feed). With `onlyIfNoLlmTitle` the update also requires
 * `title_neutral_at IS NULL`, so a re-pick can never overwrite an LLM title.
 * PGRST204 means PostgREST does not know `title_neutral_member_count` (the
 * schema cache predates migration 141): the write is retried once without it,
 * so the IS NULL pick keeps working until 141 is applied.
 */
async function writeExtractive(
  supabase: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
  opts: { onlyIfNoLlmTitle?: boolean } = {},
): Promise<PostgrestError | null> {
  const attempt = async (body: Record<string, unknown>) => {
    const q = supabase.from("clusters").update(body).eq("id", id);
    const { error } = await (opts.onlyIfNoLlmTitle ? q.is("title_neutral_at", null) : q);
    return error;
  };
  let error = await attempt(patch);
  if (error?.code === "PGRST204" && "title_neutral_member_count" in patch) {
    const { title_neutral_member_count: _stamp, ...withoutStamp } = patch;
    error = await attempt(withoutStamp);
  }
  return error;
}

interface RepickRow {
  id: string;
  title_tr_neutral: string | null;
  article_count: number;
  title_neutral_member_count: number | null;
}

// withCronOutcome is the outermost wrapper: each authenticated run is recorded in
// public.ops_cron_route_runs (ops_health_report row 15, migration 136).
export const GET = withCronOutcome("headline", withApiErrors(async (request: Request) => {
  // Next.js 16 with cacheComponents prerenders GET handlers at build time.
  // `await connection()` returns a hanging promise during prerender so
  // `request.headers` below is never touched until an actual request hits.
  // See https://nextjs.org/docs/messages/next-prerender-sync-request.
  await connection();

  // FAIL-CLOSED bearer gate (shared helper): 503 when CRON_SECRET is
  // unset/empty rather than the legacy `if (process.env.CRON_SECRET && ...)`
  // pattern that silently waved everything through in dev / mis-deployed
  // environments; 401 on a missing or mismatched token. Audit T3 P0-9.
  const auth = requireCronBearer(request);
  if (!auth.ok) {
    return auth.response;
  }

  const rl = headlineLimit(clientKey(request));
  if (!rl.allowed) {
    return apiTooManyRequests(rl.retryAfterMs);
  }

  // HEADLINE_PAUSED kill switch — an explicit, reversible pause that does
  // not require touching ANTHROPIC_API_KEY (removing the key would work too,
  // but that also removes the capability entirely and is a bigger change to
  // undo). Any non-empty value other than the literal string "false" pauses;
  // unset or "false" is a no-op so existing deployments are unaffected.
  // Zero DB access either way — checked before the Supabase client is even
  // constructed.
  const paused = process.env.HEADLINE_PAUSED;
  if (paused && paused !== "false") {
    return NextResponse.json({
      skipped: true,
      reason: "paused",
      timestamp: new Date().toISOString(),
    });
  }

  // No API key → extractive mode. The cron keeps firing every 5 minutes,
  // so an operator that drops a key into Vercel env vars and redeploys
  // gets LLM titles on the very next tick — no manual kick needed.
  const mode: "llm" | "extractive" = process.env.ANTHROPIC_API_KEY
    ? "llm"
    : "extractive";

  const supabase = createServerClient();
  const startedAt = Date.now();

  // 1. Pick the next batch of clusters needing a neutral title.
  // `.eq("is_archived", false)` mirrors the filter every reader-facing
  // surface already applies (src/lib/clusters/politics-query.ts) — without
  // it the drain could spend LLM budget rewriting a cluster no reader will
  // ever see. Ordered by updated_at DESC (recency-first) rather than
  // article_count DESC so today's stories get rewritten before an old,
  // large historical pile. `.gte("article_count", MIN_ARTICLE_COUNT)` is
  // unchanged so migration 019's partial index still applies.
  //
  // LLM mode also skips a cluster whose rewrite the acceptance gate already
  // rejected under this prompt version (LLM_REJECTED_MARK, written below):
  // nothing else leaves `title_neutral_at IS NULL`, so without the mark the
  // same cluster would be re-sent, and re-billed, on every tick. The mark is
  // version-scoped, so a prompt bump gives those clusters a fresh try.
  let pickQuery = supabase
    .from("clusters")
    .select("id, title_tr, title_tr_neutral, summary_tr, article_count")
    .is(mode === "llm" ? "title_neutral_at" : "title_tr_neutral", null)
    .eq("is_archived", false)
    .gte(
      "article_count",
      mode === "llm" ? MIN_ARTICLE_COUNT : EXTRACTIVE_MIN_ARTICLE_COUNT,
    );
  if (mode === "llm") {
    pickQuery = pickQuery.or(
      `title_neutral_prompt_version.is.null,title_neutral_prompt_version.neq."${LLM_REJECTED_MARK}"`,
    );
  }
  const { data: clustersData, error: pickError } = await pickQuery
    .order("updated_at", { ascending: false })
    .limit(mode === "llm" ? LLM_BATCH : EXTRACTIVE_BATCH);

  if (pickError) {
    return apiServerError(pickError);
  }

  const clusters = (clustersData ?? []) as ClusterCandidate[];

  // The body of a run with nothing to do. Extractive mode only returns it
  // after the re-pick pass has also come up empty (below).
  const noCandidates = () =>
    NextResponse.json({
      success: true,
      mode,
      rewrote: 0,
      skipped: 0,
      errored: 0,
      eligible: 0,
      ineligible: 0,
      budgetedOut: 0,
      reason: "no candidates",
      timestamp: new Date().toISOString(),
    });

  if (clusters.length === 0 && mode === "llm") {
    // Gate counters are per CYCLE, not per candidate — a zero-candidate
    // cycle still records that the gate ran (both counts 0).
    await addHeadlineGateCounts(supabase, { day: utcDay(), eligible: 0, ineligible: 0 });
    return noCandidates();
  }

  let rewrote = 0;
  let skipped = 0;
  let errored = 0;
  let eligibleCount = 0;
  let ineligibleCount = 0;
  let budgetedOut = 0;
  const perCluster: Record<string, { status: string; error?: string }> = {};
  // Ids actually rewrote this cycle — drives the revalidateTag calls below.
  const rewroteIds: string[] = [];
  // Extractive writes issued by the IS NULL pass; the re-pick gets what is
  // left of EXTRACTIVE_BATCH, so one run never writes more than 50 rows.
  let writesThisRun = 0;
  let repicked = 0;
  let repickKept = 0;

  // B7 (migration 069): the LLM eligibility pre-gate + daily USD budget.
  // Computed once before the loop, only in LLM mode — extractive mode
  // never calls headline_llm_eligible / llm_budget_add / llm_budget_gate
  // (it is free, so there is nothing to gate or meter). `spentUsd` is
  // re-read from each successful llm_budget_add() return value inside the
  // loop, never accumulated locally, so the cap check always reflects the
  // database's authoritative total.
  const day = utcDay();
  const capUsd = headlineLlmDailyCapUsd();
  let spentUsd = 0;
  let eligibility = new Map<
    string,
    { eligible: boolean; politics_n: number; clickbait_share: number }
  >();
  if (mode === "llm") {
    spentUsd = (await readHeadlineBudget(supabase, day))?.usd ?? 0;
    eligibility = await fetchHeadlineEligibility(
      supabase,
      clusters.map((c) => c.id),
    );
  }

  // Sequential. The LLM API is fine with bursts but cost-conscious mode
  // wants serialised retries; one bad cluster shouldn't blow the whole
  // batch and we want predictable wall time inside the 60s ceiling.
  for (const c of clusters) {
    // Fetch member titles for this cluster (newest first, deterministic).
    const { items, error: memberErr } = await fetchMemberItems(supabase, c.id);

    if (memberErr) {
      // Keep raw Supabase error out of the response body — it can embed
      // table/column names. Log the detail for triage and hand a generic
      // tag back to the caller. Same pattern as `apiServerError`.
      console.error("[headline-cron] member-fetch", c.id, memberErr);
      captureServerException(memberErr, { clusterId: c.id, mode });
      perCluster[c.id] = { status: "errored", error: "member-fetch-failed" };
      errored++;
      continue;
    }

    const memberTitles = items.map((i) => i.title);

    if (memberTitles.length === 0) {
      perCluster[c.id] = { status: "skipped" };
      skipped++;
      continue;
    }

    if (mode === "llm") {
      // B7 gate: only an eligible row (from headline_llm_eligible) may
      // spend LLM budget. A cluster absent from the map (rpc failure, or
      // no scored members) is fail-safe ineligible — see
      // src/lib/headline/eligibility.ts's header doc.
      const isEligible = eligibility.get(c.id)?.eligible === true;

      if (!isEligible) {
        ineligibleCount++;

        if (c.title_tr_neutral === null) {
          // STARVATION GUARD: only write the free extractive fallback when
          // this cluster has never had ANY neutral title — otherwise a
          // cluster that already holds an extractive title would be
          // rewritten every single cycle (it always matches
          // `title_neutral_at IS NULL`), looping the same rows forever.
          let neutral: string | null;
          try {
            // First pick: the floor, never the raw title_tr.
            neutral = pickNeutralTitle(items, { floor: true });
          } catch (err) {
            console.error("[headline-cron] extractive pick failed", c.id, err);
            captureServerException(err, { clusterId: c.id, mode });
            perCluster[c.id] = { status: "errored", error: "empty rewrite" };
            errored++;
            continue;
          }
          if (!neutral) {
            perCluster[c.id] = { status: "errored", error: "empty rewrite" };
            errored++;
            continue;
          }

          const writeErr = await writeExtractive(supabase, c.id, {
            // No title_neutral_at: an extractive pick is not an AI
            // neutralization and must not be counted as one.
            title_tr_neutral: neutral,
            title_neutral_model: EXTRACTIVE_MODEL_ID,
            title_neutral_member_count: memberCountStamp(c.article_count),
          });

          if (writeErr) {
            console.error("[headline-cron] write", c.id, writeErr);
            captureServerException(writeErr, { clusterId: c.id, mode });
            perCluster[c.id] = { status: "errored", error: "write-failed" };
            errored++;
            continue;
          }

          perCluster[c.id] = { status: "extractive" };
          // Counts as a rewrite for cache-invalidation purposes, but NOT
          // in the `rewrote` counter — it isn't an AI neutralization.
          rewroteIds.push(c.id);
        } else {
          // Already has a title (extractive or otherwise): leave it
          // untouched, no write, no LLM call. Prevents the batch from
          // starving on the same rows every cycle (see pack.md's
          // "STARVATION BUG THE DESIGN AVOIDS").
          perCluster[c.id] = { status: "ineligible" };
        }
        continue;
      }

      eligibleCount++;

      if (spentUsd >= capUsd) {
        console.warn("[headline-cron] budgeted_out", c.id, spentUsd, capUsd);
        perCluster[c.id] = { status: "budgeted_out" };
        budgetedOut++;
        continue;
      }

      let result: { text: string; inputTokens: number; outputTokens: number };
      try {
        result = await rewriteClusterHeadline({ member_titles: memberTitles });
      } catch (err) {
        // Keep the raw `err` out of the response body — it can carry
        // vendor identifiers, prompt fragments, or upstream rate-limit
        // details that we do not want to leak to the caller. The full
        // message is captured explicitly via captureServerException below
        // and also logged to Edge/Vercel logs via console.error.
        console.error(
          "[headline-cron] LLM call failed for cluster",
          c.id,
          err,
        );
        captureServerException(err, { clusterId: c.id, mode });
        perCluster[c.id] = {
          status: "errored",
          error: "rewriteClusterHeadline failed",
        };
        errored++;
        continue;
      }

      // Record the real spend and use the database's returned cumulative
      // total for the NEXT iteration's cap check (migration 069, B7) —
      // never a locally-accumulated number. This MUST run immediately
      // after the vendor call resolves, before any later branch below can
      // `continue` — the money is spent when the vendor responds, not when
      // the clusters row is written (E1-BUDGET-LEAK).
      const usd = estimateCallUsd(result.inputTokens, result.outputTokens);
      const newTotal = await addHeadlineBudget(supabase, {
        day,
        calls: 1,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        usd,
      });
      spentUsd = newTotal ?? spentUsd + usd;

      if (!result.text) {
        perCluster[c.id] = { status: "errored", error: "empty rewrite" };
        errored++;
        continue;
      }

      // The same acceptance gate the extractive picker applies, minus the
      // feed-cut heuristic (`generated`: a model does not truncate): a
      // question, an English or shouted headline is never shown. The spend is
      // already metered above. A cluster with no neutral title yet gets the
      // free extractive pick instead; one that has a title keeps it. The
      // rejected text is never written, but the rejection is: the mark keeps
      // the cluster out of the next LLM pick (see the pick query), because the
      // gate is deterministic and would reject, and bill, the same cluster
      // again on every tick.
      if (!isAcceptableNeutral(result.text, memberTitles, { generated: true })) {
        let fallback: string | null = null;
        if (c.title_tr_neutral === null) {
          try {
            fallback = pickNeutralTitle(items, { floor: true });
          } catch (err) {
            console.error("[headline-cron] extractive pick failed", c.id, err);
            captureServerException(err, { clusterId: c.id, mode });
          }
        }

        // Never title_neutral_at: this is not an AI neutralization.
        const rejectErr = await writeExtractive(
          supabase,
          c.id,
          {
            title_neutral_prompt_version: LLM_REJECTED_MARK,
            ...(fallback === null
              ? {}
              : {
                  title_tr_neutral: fallback,
                  title_neutral_model: EXTRACTIVE_MODEL_ID,
                  title_neutral_member_count: memberCountStamp(c.article_count),
                }),
          },
          { onlyIfNoLlmTitle: true },
        );
        if (rejectErr) {
          console.error("[headline-cron] write", c.id, rejectErr);
          captureServerException(rejectErr, { clusterId: c.id, mode });
          perCluster[c.id] = { status: "errored", error: "write-failed" };
          errored++;
          continue;
        }
        if (fallback === null) {
          perCluster[c.id] = { status: "errored", error: "rejected rewrite" };
          errored++;
          continue;
        }
        perCluster[c.id] = { status: "extractive" };
        rewroteIds.push(c.id);
        continue;
      }

      const { error: writeErr } = await supabase
        .from("clusters")
        .update({
          title_tr_neutral: result.text,
          title_neutral_at: new Date().toISOString(),
          // Provenance (migration 046): the model id actually used for
          // this rewrite and the prompt-template version that produced
          // it, so a rewrite can never land without an audit trail.
          title_neutral_model: LLM_MODEL,
          title_neutral_prompt_version: HEADLINE_PROMPT_VERSION,
        })
        .eq("id", c.id);

      if (writeErr) {
        console.error("[headline-cron] write", c.id, writeErr);
        captureServerException(writeErr, { clusterId: c.id, mode });
        perCluster[c.id] = { status: "errored", error: "write-failed" };
        errored++;
        continue;
      }

      perCluster[c.id] = { status: "rewrote" };
      rewrote++;
      rewroteIds.push(c.id);
      continue;
    }

    // Extractive mode (no ANTHROPIC_API_KEY): unchanged from before B7 —
    // picks and cleans a member headline, zero cost, no eligibility gate.
    let neutral: string | null;
    try {
      // First pick (title_tr_neutral IS NULL): the floor. A cluster whose
      // every member fails the acceptance gate (SEO questions, a long
      // headline) would otherwise stay NULL: every surface shows the raw
      // title_tr with its lead-ins, and the row is fetched again each tick.
      neutral = pickNeutralTitle(items, { floor: true });
    } catch (err) {
      console.error("[headline-cron] extractive pick failed", c.id, err);
      captureServerException(err, { clusterId: c.id, mode });
      perCluster[c.id] = { status: "errored", error: "empty rewrite" };
      errored++;
      continue;
    }

    if (!neutral) {
      perCluster[c.id] = { status: "errored", error: "empty rewrite" };
      errored++;
      continue;
    }

    writesThisRun++;
    const writeErr = await writeExtractive(supabase, c.id, {
      // No title_neutral_at: an extractive pick is not an AI
      // neutralization and must not be counted as one.
      title_tr_neutral: neutral,
      title_neutral_model: EXTRACTIVE_MODEL_ID,
      title_neutral_member_count: memberCountStamp(c.article_count),
    });

    if (writeErr) {
      console.error("[headline-cron] write", c.id, writeErr);
      captureServerException(writeErr, { clusterId: c.id, mode });
      perCluster[c.id] = { status: "errored", error: "write-failed" };
      errored++;
      continue;
    }

    perCluster[c.id] = { status: "rewrote" };
    rewrote++;
    rewroteIds.push(c.id);
  }

  // 2. Extractive re-pick (migration 141). Only in extractive mode, only
  // after the IS NULL pass, only while the run is young, and only with what is
  // left of the per-run write budget. The function returns active clusters of
  // the last 14 days (no LLM title) whose pick came from another model, was
  // never stamped, or has been outgrown by the cluster. An rpc failure is
  // logged and the run stays 200: the IS NULL writes above are already done.
  let repickSeen = 0;
  const repickedIds: string[] = [];
  if (mode === "extractive" && Date.now() - startedAt < REPICK_DEADLINE_MS) {
    const budget = Math.min(REPICK_BATCH, EXTRACTIVE_BATCH - writesThisRun);
    if (budget > 0) {
      const { data: repickData, error: repickErr } = await supabase.rpc(
        "neutral_title_repick_candidates",
        { p_model: EXTRACTIVE_MODEL_ID, p_limit: budget },
      );

      if (repickErr) {
        console.error("[headline-cron] repick-candidates", repickErr);
        captureServerException(repickErr, { mode });
      } else {
        // The function already caps the batch; slicing keeps the write budget
        // a property of this route, not of the database function.
        const rows = ((repickData ?? []) as RepickRow[]).slice(0, budget);
        repickSeen = rows.length;

        for (const r of rows) {
          if (Date.now() - startedAt >= REPICK_DEADLINE_MS) break;

          const { items, error: memberErr } = await fetchMemberItems(supabase, r.id);
          if (memberErr) {
            // Transient: no stamp, so the row is offered again next run.
            console.error("[headline-cron] repick member-fetch", r.id, memberErr);
            captureServerException(memberErr, { clusterId: r.id, mode });
            perCluster[r.id] = { status: "errored", error: "member-fetch-failed" };
            errored++;
            continue;
          }

          // A pick that throws is treated like one that finds nothing: stamp
          // and keep the stored title. Not stamping would offer the same
          // newest rows every run and starve the rest of the set.
          let next: string | null = null;
          try {
            next = pickNeutralTitle(items, { incumbent: r.title_tr_neutral });
          } catch (err) {
            console.error("[headline-cron] repick pick failed", r.id, err);
            captureServerException(err, { clusterId: r.id, mode });
          }

          const changed = next !== null && next !== r.title_tr_neutral;
          const patch: Record<string, unknown> = {
            title_neutral_model: EXTRACTIVE_MODEL_ID,
            // The cluster's article_count, changed title or not: stamping the
            // number of titles used would re-pick a 40-member cluster forever.
            title_neutral_member_count: memberCountStamp(r.article_count),
          };
          if (changed) patch.title_tr_neutral = next;

          const writeErr = await writeExtractive(supabase, r.id, patch, {
            onlyIfNoLlmTitle: true,
          });
          if (writeErr) {
            console.error("[headline-cron] repick write", r.id, writeErr);
            captureServerException(writeErr, { clusterId: r.id, mode });
            perCluster[r.id] = { status: "errored", error: "write-failed" };
            errored++;
            continue;
          }

          if (changed) {
            perCluster[r.id] = { status: "repicked" };
            repicked++;
            repickedIds.push(r.id);
          } else {
            perCluster[r.id] = { status: "repick-kept" };
            repickKept++;
          }
        }
      }
    }
  }

  // Extractive mode: nothing from the IS NULL pick and nothing to re-pick.
  if (clusters.length === 0 && repickSeen === 0) {
    return noCandidates();
  }

  // B7: best-effort gate-outcome write, once per cycle, including cycles
  // that made zero LLM calls (every candidate ineligible, or budget
  // exhausted before the first eligible cluster). Never in extractive mode.
  if (mode === "llm") {
    try {
      await addHeadlineGateCounts(supabase, {
        day,
        eligible: eligibleCount,
        ineligible: ineligibleCount,
      });
    } catch (err) {
      console.error("[headline-cron] llm_budget_gate failed", err);
    }
  }

  // Push fresh titles out now instead of waiting on the cluster-feed
  // cacheLife window. Best-effort: a throw here must not undo the DB writes
  // above or turn a successful cron cycle into a 500.
  try {
    for (const id of [...rewroteIds, ...repickedIds]) {
      revalidateTag(`cluster-detail:${id}`, "max");
    }
    if (rewroteIds.length > 0 || repickedIds.length > 0) {
      revalidateTag("clusters-politics", "max");
    }
  } catch (err) {
    console.error("[headline-cron] revalidateTag failed", err);
  }

  return NextResponse.json({
    success: true,
    mode,
    rewrote,
    skipped,
    errored,
    repicked,
    repickKept,
    eligible: eligibleCount,
    ineligible: ineligibleCount,
    budgetedOut,
    ...(mode === "llm" ? { budget: { day, usd: spentUsd, cap: capUsd } } : {}),
    clusters: perCluster,
    timestamp: new Date().toISOString(),
  });
}));
