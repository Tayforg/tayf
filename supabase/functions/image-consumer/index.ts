// supabase/functions/image-consumer/index.ts
//
// Image-backfill consumer Edge Function. Drains messages from the
// `image_backfill` pgmq queue, fetches og:image / twitter:image for the
// referenced article URL through the SSRF-guarded fetcher, and updates
// `articles.image_url` on success.
//
// Triggered by a pg_cron schedule ("*/5 * * * *" per ADR-001). Each
// invocation drains a bounded batch, then returns. Module-scoped state
// (Supabase client, source-slug map) is reused across warm invocations.
//
// Lifecycle per message:
//   1. pgmq.read('image_backfill', vt=30, qty=BATCH_SIZE).
//   2. For each message:
//      a. If read_ct > MAX_READS → pgmq.archive (permanent failure path —
//         the payload survives in pgmq.a_image_backfill for audit).
//      b. Load the article row; skip if missing or already imaged.
//      c. Pick the extractor (fetchHeroImage for the three audit-flagged
//         slugs, fetchOgImage otherwise).
//      d. On success: update articles.image_url + reset attempts, archive.
//      e. On not-found / errored: bump image_backfill_attempts +
//         attempted_at, archive. We do NOT requeue — the AFTER UPDATE
//         trigger and the safety-net resweep handle re-discovery.
//   3. Stops when the wall budget is exhausted or the queue is empty.

import { createServiceClient, type SupabaseClient } from "../_shared/supabase.ts";
import {
  archive as pgmqArchive,
  queueDepth as pgmqQueueDepth,
  readBatch as pgmqRead,
  type PgmqMessage,
} from "../_shared/pgmq.ts";
import {
  fetchHeroImage,
  fetchOgImage,
  isValidImageUrl,
} from "../_shared/og-image.ts";
import { requireServiceRoleBearer } from "../_shared/auth.ts";
import { captureException, initSentry, withSentry } from "../_shared/sentry.ts";

await initSentry("image-consumer");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const QUEUE_NAME = "image_backfill";
// Per-message visibility timeout. Fetch + update + archive comfortably
// finishes inside 30s for healthy hosts; messages from a killed invocation
// become re-readable after 30s and the next pg_cron tick picks them up.
const VISIBILITY_TIMEOUT_S = 30;
// Batch size per pgmq.read call. 20 keeps each invocation cheap while
// keeping pace with the pg_cron interval (every 5 min).
const BATCH_SIZE = 20;
// Per-message permanent-failure cap. Poison contract (shared with
// cluster-consumer): once read_ct EXCEEDS this — i.e. on the 4th read —
// the message is pgmq.archive'd so it stops bouncing while the payload
// survives in pgmq.a_image_backfill for audit.
const MAX_READS = 3;
// Per-row attempt cap. Mirrors scripts/image-worker.mjs / migration 022 so
// the queue path and the legacy worker agree on parking behaviour.
const IMG_BACKFILL_MAX_ATTEMPTS = 5;
const IMG_BACKFILL_PARK_MS = 7 * 24 * 3600 * 1000;
// Edge Functions hard limit is 400s, but we cap ourselves well under to
// leave headroom for the pg_cron wrapper + cold-start jitter.
const WALL_BUDGET_MS = 30_000;
// Minimum budget that must remain before leasing another batch. pgmq bumps
// read_ct on every read — including messages this invocation never gets to
// process — so reading with the budget nearly spent walks healthy messages
// toward the poison threshold (audit S11).
const READ_BUDGET_FLOOR_MS = 5_000;
// Per-fetch HTTP timeout — matches scripts/image-worker.mjs's tuned-down 5s.
const REQUEST_TIMEOUT_MS = 5000;
// Slugs that get the extended-window hero-image extractor (audit IMG1).
const HERO_IMAGE_SLUGS = new Set([
  "haberler-com",
  "trt-haber",
  "anadolu-ajansi",
]);

// ---------------------------------------------------------------------------
// Module-scoped state (survives across warm invocations on the same instance)
// ---------------------------------------------------------------------------

let supabase: SupabaseClient | null = null;
let supabaseInitError: string | null = null;
try {
  supabase = createServiceClient();
} catch (err) {
  supabaseInitError = err instanceof Error ? err.message : String(err);
  console.error(`[image-consumer] FATAL: ${supabaseInitError}`);
}

// Source id → slug map. Loaded lazily on the first invocation; cached
// across warm invocations because sources change rarely.
let sourceSlugMap: Map<string, string> | null = null;
let sourceSlugMapLoadedAt = 0;
const SOURCE_MAP_TTL_MS = 30 * 60 * 1000;

async function getSourceSlugMap(client: SupabaseClient): Promise<Map<string, string>> {
  const now = Date.now();
  if (sourceSlugMap && now - sourceSlugMapLoadedAt < SOURCE_MAP_TTL_MS) {
    return sourceSlugMap;
  }
  const { data, error } = await client.from("sources").select("id, slug");
  if (error) {
    console.error(`[image-consumer] source slug map load failed: ${error.message}`);
    return sourceSlugMap ?? new Map();
  }
  const next = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; slug: string }>) {
    if (row?.id && row?.slug) next.set(row.id, row.slug);
  }
  sourceSlugMap = next;
  sourceSlugMapLoadedAt = now;
  return next;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImageJob {
  article_id?: string;
}

interface ArticleRow {
  id: string;
  url: string | null;
  source_id: string | null;
  image_url: string | null;
  image_backfill_attempts: number | null;
}

type Outcome =
  | "found"
  | "not-found"
  | "errored"
  | "skipped-no-url"
  | "skipped-already-imaged"
  | "skipped-missing"
  | "permanent-failure";

// ---------------------------------------------------------------------------
// Per-message worker
// ---------------------------------------------------------------------------

async function processMessage(
  client: SupabaseClient,
  msg: PgmqMessage<ImageJob>,
): Promise<Outcome> {
  const articleId = msg.message?.article_id;

  // Malformed enqueue payload → permanent. Archive so we don't keep
  // reading while the payload stays inspectable in pgmq.a_image_backfill.
  if (!articleId || typeof articleId !== "string") {
    console.warn(`[image-consumer] msg ${msg.msg_id} missing article_id — archiving`);
    await safeArchive(client, msg.msg_id);
    return "permanent-failure";
  }

  // read_ct > MAX_READS → permanent (shared poison contract with
  // cluster-consumer). Archive — never delete — so the message body
  // survives in pgmq.a_image_backfill as the audit trail (audit S12).
  if (msg.read_ct > MAX_READS) {
    console.warn(
      `[image-consumer] msg ${msg.msg_id} (article=${articleId}) exceeded ${MAX_READS} reads — archiving`,
    );
    await safeArchive(client, msg.msg_id);
    return "permanent-failure";
  }

  // Load the article. Service role bypasses RLS.
  const { data: article, error: loadErr } = await client
    .from("articles")
    .select("id, url, source_id, image_url, image_backfill_attempts")
    .eq("id", articleId)
    .maybeSingle<ArticleRow>();

  if (loadErr) {
    // URL is unknown here — the row never loaded.
    console.error(
      "[image-consumer] msg-error",
      JSON.stringify({
        msg_id: msg.msg_id,
        read_ct: msg.read_ct,
        article_id: articleId,
        url: null,
        error: loadErr.message,
      }),
    );
    // Transient — leave the message visible for the next read.
    return "errored";
  }

  if (!article) {
    console.warn(
      `[image-consumer] article ${articleId} not found — archiving msg ${msg.msg_id}`,
    );
    await safeArchive(client, msg.msg_id);
    return "skipped-missing";
  }

  if (article.image_url) {
    // Already backfilled (race / re-enqueue); archive and move on.
    await safeArchive(client, msg.msg_id);
    return "skipped-already-imaged";
  }

  if (!article.url) {
    await safeArchive(client, msg.msg_id);
    return "skipped-no-url";
  }

  // Pick the extractor. HERO_IMAGE_SLUGS get the extended 200KB window;
  // everything else gets the stock 50KB head-only path.
  const sources = await getSourceSlugMap(client);
  const slug = article.source_id ? sources.get(article.source_id) ?? null : null;
  const useHero = slug !== null && HERO_IMAGE_SLUGS.has(slug);

  let ogImage: string | null = null;
  try {
    ogImage = useHero
      ? await fetchHeroImage(article.url, slug, { timeoutMs: REQUEST_TIMEOUT_MS })
      : await fetchOgImage(article.url, { timeoutMs: REQUEST_TIMEOUT_MS });
  } catch (err) {
    // fetchOgImage / fetchHeroImage are contracted not to throw; this is
    // defensive. Any throw collapses to errored.
    const m = err instanceof Error ? err.message : String(err);
    console.error(
      "[image-consumer] msg-error",
      JSON.stringify({
        msg_id: msg.msg_id,
        read_ct: msg.read_ct,
        article_id: article.id,
        url: article.url,
        error: m,
      }),
    );
    await bumpAttempt(client, article);
    await safeArchive(client, msg.msg_id);
    return "errored";
  }

  if (!ogImage || !isValidImageUrl(ogImage)) {
    await bumpAttempt(client, article);
    await safeArchive(client, msg.msg_id);
    return "not-found";
  }

  // Successful fetch. Single update sets image_url, resets attempts, and
  // bumps attempted_at. Conditional on image_url still being NULL so two
  // concurrent drains can't both write — the loser matches zero rows and
  // records the race as a skip, not an error (audit P3-10).
  const { data: updatedRows, error: updateErr } = await client
    .from("articles")
    .update({
      image_url: ogImage,
      image_backfill_attempted_at: new Date().toISOString(),
      image_backfill_attempts: 0,
    })
    .eq("id", article.id)
    .is("image_url", null)
    .select("id");

  if (updateErr) {
    console.error(
      "[image-consumer] msg-error",
      JSON.stringify({
        msg_id: msg.msg_id,
        read_ct: msg.read_ct,
        article_id: article.id,
        url: article.url,
        error: updateErr.message,
      }),
    );
    // Leave the message visible so the next read retries.
    return "errored";
  }

  const matched = Array.isArray(updatedRows)
    ? updatedRows.length
    : updatedRows
    ? 1
    : 0;
  if (matched === 0) {
    // A concurrent drain wrote image_url between our load and this update.
    console.log(
      `[image-consumer] article ${article.id} already imaged by a concurrent drain — skipping msg ${msg.msg_id}`,
    );
    await safeArchive(client, msg.msg_id);
    return "skipped-already-imaged";
  }

  await safeArchive(client, msg.msg_id);
  return "found";
}

/**
 * Bump image_backfill_attempts and image_backfill_attempted_at after a
 * failed fetch. Once attempts >= IMG_BACKFILL_MAX_ATTEMPTS, park the row
 * IMG_BACKFILL_PARK_MS into the future so it leaves the active pool.
 */
async function bumpAttempt(
  client: SupabaseClient,
  article: ArticleRow,
): Promise<void> {
  const prev = Number.isFinite(article.image_backfill_attempts as number)
    ? (article.image_backfill_attempts as number)
    : 0;
  const next = prev + 1;
  const shouldPark = next >= IMG_BACKFILL_MAX_ATTEMPTS;
  const attemptedAtIso = shouldPark
    ? new Date(Date.now() + IMG_BACKFILL_PARK_MS).toISOString()
    : new Date().toISOString();
  const { error } = await client
    .from("articles")
    .update({
      image_backfill_attempted_at: attemptedAtIso,
      image_backfill_attempts: next,
    })
    .eq("id", article.id);
  if (error) {
    console.error(`[image-consumer] bumpAttempt failed for ${article.id}: ${error.message}`);
  }
}

/**
 * Wrap pgmq.archive so a transient RPC failure doesn't abort the whole
 * drain. The pgmq helper throws on error; we log and move on. Archive is
 * the only removal path — poison messages are archived too (audit S12) so
 * the payload survives in pgmq.a_image_backfill.
 */
async function safeArchive(
  client: SupabaseClient,
  msgId: number,
): Promise<void> {
  try {
    await pgmqArchive(client, QUEUE_NAME, msgId);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[image-consumer] pgmq archive(${msgId}) failed: ${m}`);
  }
}

// ---------------------------------------------------------------------------
// Drain loop
// ---------------------------------------------------------------------------

interface DrainSummary {
  drained: number;
  found: number;
  notFound: number;
  errored: number;
  skipped: number;
  permanentFailures: number;
  elapsedMs: number;
}

async function drain(client: SupabaseClient): Promise<DrainSummary> {
  const startedAt = Date.now();
  let drained = 0;
  let found = 0;
  let notFound = 0;
  let errored = 0;
  let skipped = 0;
  let permanentFailures = 0;

  // Best-effort depth sample for the drain summary log (audit O13).
  const before = await pgmqQueueDepth(client, QUEUE_NAME);

  // Lease a new batch only while enough budget remains to actually process
  // it — pgmq bumps read_ct on every read, so a read that only ever
  // budget-outs walks a never-attempted message toward the poison
  // threshold (audit S11).
  while (Date.now() - startedAt < WALL_BUDGET_MS - READ_BUDGET_FLOOR_MS) {
    let batch: PgmqMessage<ImageJob>[] = [];
    try {
      batch = await pgmqRead<ImageJob>(client, QUEUE_NAME, VISIBILITY_TIMEOUT_S, BATCH_SIZE);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[image-consumer] pgmq.read failed: ${m}`);
      break;
    }
    if (batch.length === 0) break;

    // Serial within an invocation: predictable resource footprint, plays
    // nicely with the legacy worker which runs IMG_CONCURRENCY=5 in parallel.
    for (const msg of batch) {
      // Deadline hit mid-batch: leave the remaining messages untouched —
      // the visibility timeout returns them to the queue — so they never
      // count toward the read_ct-based poison check.
      if (Date.now() - startedAt >= WALL_BUDGET_MS) break;
      let outcome: Outcome;
      try {
        outcome = await processMessage(client, msg);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(
          "[image-consumer] msg-error",
          JSON.stringify({
            msg_id: msg.msg_id,
            read_ct: msg.read_ct,
            article_id: msg.message?.article_id ?? null,
            url:
              (err as { article_url?: string } | null | undefined)
                ?.article_url ?? null,
            error: m,
          }),
        );
        outcome = "errored";
      }
      drained += 1;
      switch (outcome) {
        case "found":
          found += 1;
          break;
        case "not-found":
          notFound += 1;
          break;
        case "errored":
          errored += 1;
          break;
        case "permanent-failure":
          permanentFailures += 1;
          break;
        case "skipped-no-url":
        case "skipped-already-imaged":
        case "skipped-missing":
          skipped += 1;
          break;
      }
    }
  }

  const summary: DrainSummary = {
    drained,
    found,
    notFound,
    errored,
    skipped,
    permanentFailures,
    elapsedMs: Date.now() - startedAt,
  };
  const after = await pgmqQueueDepth(client, QUEUE_NAME);
  // One JSON-shaped summary line per drain (audit O13) — depth + oldest-age
  // samples are best-effort and surface as null when the metrics probe fails.
  console.log(
    "[image-consumer] drain",
    JSON.stringify({
      depth_before: before.depth,
      depth_after: after.depth,
      oldest_age_before_s: before.oldest_msg_age_sec,
      oldest_age_after_s: after.oldest_msg_age_sec,
      ...summary,
    }),
  );
  return summary;
}

// ---------------------------------------------------------------------------
// Deno.serve entrypoint
// ---------------------------------------------------------------------------

Deno.serve(withSentry("image-consumer", async (req: Request) => {
  // Bearer gate before any branch — the GET probe also returns infra detail
  // ("configured") we do not want to leak anonymously.
  const denied = requireServiceRoleBearer(req);
  if (denied) return denied;

  // GET → cheap health probe (no DB hits). The raw init error is logged
  // once at module init (see the `supabaseInitError` assignment above) and
  // is never echoed in the response body — only the non-sensitive
  // ok/configured booleans are (CodeQL js/stack-trace-exposure).
  if (req.method === "GET") {
    return new Response(
      JSON.stringify({
        ok: supabase !== null,
        queue: QUEUE_NAME,
        configured: supabase !== null,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  if (!supabase) {
    // Same rationale as the GET probe: the detailed init error was already
    // logged server-side at module init; only a generic message goes out.
    return new Response(
      JSON.stringify({ error: "supabase client unavailable" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  try {
    // drain() emits its own JSON-shaped summary log line (audit O13).
    const summary = await drain(supabase);
    return new Response(JSON.stringify(summary), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const request_id = crypto.randomUUID();
    // Round-6 P1: forward to Sentry explicitly. The withSentry wrapper
    // only sees thrown errors; this catch builds a 500 response so the
    // throw never reaches the wrapper.
    captureException("image-consumer", err);
    // Log the full error (stack + message) to Edge Function logs as well.
    console.error(`[image-consumer] ${request_id}`, err);
    return new Response(
      JSON.stringify({ ok: false, error: "internal-error", request_id }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}));
