import { connection, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { requireCronBearer } from "@/lib/api/bearer";
import { apiError, apiServerError, withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import {
  buildHeadlinePrompt,
  HEADLINE_MIN_ARTICLE_COUNT,
  HEADLINE_PROMPT_VERSION,
} from "@/lib/headline/prompt";
import { EXTRACTIVE_MODEL_ID, pickNeutralTitle } from "@/lib/clusters/neutral-title";
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
 * `title_tr_neutral` and stamps `title_neutral_model = "extractive-v1"`
 * but leaves `title_neutral_at` NULL — so nothing that counts "AI
 * neutralized" (rss.xml, /metodoloji, /api/metrics) counts these, and
 * enabling the LLM later re-titles the same clusters. The extractive title
 * is a floor, not a verdict.
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

// Same `MEMBER_TITLES_CAP` as the tmux worker. The rewriter slices to 8
// internally; we ask for a couple extra so the slice is meaningful even
// after dedupe / nulls.
const MEMBER_TITLES_CAP = 16;

// Re-exported from src/lib/headline/prompt.ts so /metodoloji can state the
// threshold without hardcoding a literal that could drift from this gate.
const MIN_ARTICLE_COUNT = HEADLINE_MIN_ARTICLE_COUNT;

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

export const GET = withApiErrors(async (request: Request) => {
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
    return apiError(429, "Too many requests", {
      details: { retryAfterMs: rl.retryAfterMs },
    });
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

  // 1. Pick the next batch of clusters needing a neutral title.
  // `.eq("is_archived", false)` mirrors the filter every reader-facing
  // surface already applies (src/lib/clusters/politics-query.ts) — without
  // it the drain could spend LLM budget rewriting a cluster no reader will
  // ever see. Ordered by updated_at DESC (recency-first) rather than
  // article_count DESC so today's stories get rewritten before an old,
  // large historical pile. `.gte("article_count", MIN_ARTICLE_COUNT)` is
  // unchanged so migration 019's partial index still applies.
  const { data: clustersData, error: pickError } = await supabase
    .from("clusters")
    .select("id, title_tr, title_tr_neutral, summary_tr, article_count")
    .is(mode === "llm" ? "title_neutral_at" : "title_tr_neutral", null)
    .eq("is_archived", false)
    .gte(
      "article_count",
      mode === "llm" ? MIN_ARTICLE_COUNT : EXTRACTIVE_MIN_ARTICLE_COUNT,
    )
    .order("updated_at", { ascending: false })
    .limit(mode === "llm" ? LLM_BATCH : EXTRACTIVE_BATCH);

  if (pickError) {
    return apiServerError(pickError);
  }

  const clusters = (clustersData ?? []) as ClusterCandidate[];

  if (clusters.length === 0) {
    if (mode === "llm") {
      // Gate counters are per CYCLE, not per candidate — a zero-candidate
      // cycle still records that the gate ran (both counts 0).
      await addHeadlineGateCounts(supabase, { day: utcDay(), eligible: 0, ineligible: 0 });
    }
    return NextResponse.json({
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
    // Fetch member titles for this cluster.
    const { data: memberRows, error: memberErr } = await supabase
      .from("cluster_articles")
      .select("articles ( title, published_at )")
      .eq("cluster_id", c.id)
      .limit(MEMBER_TITLES_CAP);

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

    const items: Array<{ title: string; published_at: string | null }> = [];
    for (const r of (memberRows ?? []) as unknown as ClusterArticleRow[]) {
      const a = Array.isArray(r.articles) ? r.articles[0] : r.articles;
      if (!a || !a.title) continue;
      items.push({ title: a.title, published_at: a.published_at });
    }
    // Newest-first so the LLM sees the freshest framings of the story.
    items.sort((a, b) => {
      const ta = a.published_at ? new Date(a.published_at).getTime() : 0;
      const tb = b.published_at ? new Date(b.published_at).getTime() : 0;
      return tb - ta;
    });
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
            neutral = pickNeutralTitle(items);
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

          const { error: writeErr } = await supabase
            .from("clusters")
            .update({
              // No title_neutral_at: an extractive pick is not an AI
              // neutralization and must not be counted as one.
              title_tr_neutral: neutral,
              title_neutral_model: EXTRACTIVE_MODEL_ID,
            })
            .eq("id", c.id);

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
      neutral = pickNeutralTitle(items);
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

    const { error: writeErr } = await supabase
      .from("clusters")
      .update({
        // No title_neutral_at: an extractive pick is not an AI
        // neutralization and must not be counted as one.
        title_tr_neutral: neutral,
        title_neutral_model: EXTRACTIVE_MODEL_ID,
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
    for (const id of rewroteIds) {
      revalidateTag(`cluster-detail:${id}`, "max");
    }
    if (rewroteIds.length > 0) {
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
    eligible: eligibleCount,
    ineligible: ineligibleCount,
    budgetedOut,
    ...(mode === "llm" ? { budget: { day, usd: spentUsd, cap: capUsd } } : {}),
    clusters: perCluster,
    timestamp: new Date().toISOString(),
  });
});
