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
}): Promise<string> {
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
    throw new Error(`LLM API ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    content?: Array<{ text?: string }>;
  };
  const text = data.content?.[0]?.text?.trim();
  if (!text) {
    throw new Error("Empty response from LLM");
  }

  // Strip stray wrapping quotes (curly + straight) the model sometimes adds.
  return text.replace(/^["'“‘]|["'”’]$/g, "").trim();
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
    .select("id, title_tr, summary_tr, article_count")
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
    return NextResponse.json({
      success: true,
      mode,
      rewrote: 0,
      skipped: 0,
      errored: 0,
      reason: "no candidates",
      timestamp: new Date().toISOString(),
    });
  }

  let rewrote = 0;
  let skipped = 0;
  let errored = 0;
  const perCluster: Record<string, { status: string; error?: string }> = {};
  // Ids actually rewrote this cycle — drives the revalidateTag calls below.
  const rewroteIds: string[] = [];

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

    let neutral: string | null;
    try {
      neutral =
        mode === "llm"
          ? await rewriteClusterHeadline({ member_titles: memberTitles })
          : pickNeutralTitle(items);
    } catch (err) {
      // Keep the raw `err` out of the response body — it can carry vendor
      // identifiers, prompt fragments, or upstream rate-limit details that
      // we do not want to leak to the caller. The full message still
      // reaches Sentry + Edge logs via console.error below.
      console.error(
        "[headline-cron] LLM call failed for cluster",
        c.id,
        err,
      );
      perCluster[c.id] = {
        status: "errored",
        error: "rewriteClusterHeadline failed",
      };
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
      .update(
        mode === "llm"
          ? {
              title_tr_neutral: neutral,
              title_neutral_at: new Date().toISOString(),
              // Provenance (migration 046): the model id actually used for
              // this rewrite and the prompt-template version that produced
              // it, so a rewrite can never land without an audit trail.
              title_neutral_model: LLM_MODEL,
              title_neutral_prompt_version: HEADLINE_PROMPT_VERSION,
            }
          : {
              // No title_neutral_at: an extractive pick is not an AI
              // neutralization and must not be counted as one.
              title_tr_neutral: neutral,
              title_neutral_model: EXTRACTIVE_MODEL_ID,
            },
      )
      .eq("id", c.id);

    if (writeErr) {
      console.error("[headline-cron] write", c.id, writeErr);
      perCluster[c.id] = { status: "errored", error: "write-failed" };
      errored++;
      continue;
    }

    perCluster[c.id] = { status: "rewrote" };
    rewrote++;
    rewroteIds.push(c.id);
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
    clusters: perCluster,
    timestamp: new Date().toISOString(),
  });
});
