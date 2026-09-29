import { connection, NextResponse } from "next/server";

import { toV1AlertRecord, type AlertItem } from "@/lib/alerts/alert-feed";
import { getAlertItems } from "@/lib/alerts/alert-query";
import {
  DISABLE_AFTER_FAILS,
  classify,
  nextAttemptAt,
  postWebhook,
  type PostResult,
} from "@/lib/alerts/webhook-deliver";
import { buildWebhookHeaders, WEBHOOK_EVENT } from "@/lib/alerts/webhook-sign";
import { requireCronBearer } from "@/lib/api/bearer";
import { apiServerError, withApiErrors } from "@/lib/api/errors";
import { getZoneFeedHealth } from "@/lib/clusters/feed-health";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { REGISTRY_ATTRIBUTION, REGISTRY_LICENCE } from "@/lib/sources/registry";
import { createServerClient } from "@/lib/supabase/server";

// Vercel cron - signed alert webhooks (see vercel.ts, every 10 minutes).
//
// Flow: load enabled webhooks on live keys -> (no webhooks: stop, no other
// query) -> feed health (unknown: stop, push FAILS CLOSED, unlike the pull
// feed) -> alert items -> fresh blindspot re-read -> enqueue per webhook ->
// claim -> deliver -> record outcomes. Enqueue is idempotent through the
// unique (key_id, alert_id) constraint plus ignoreDuplicates; the payload is
// stored once, so a retry resends identical bytes.
//
// Logging: counts only. Never a URL path, a secret, a payload or a header.

export const maxDuration = 60;

const cronAlertsWebhooksLimit = createRateLimiter("cron-alerts-webhooks", {
  capacity: 6,
  refillPerSecond: 1 / 600,
});

const MAX_WEBHOOKS = 20;
const CLAIM_LIMIT = 20;
const CONCURRENCY = 4;
const ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;
const ALERT_LIMIT = 100;

const FRESH_SELECT =
  "id, is_blindspot, blindspot_recall_veto, blindspot_recall_suspect, blindspot_recall_checked_at, is_archived";

interface WebhookRow {
  key_id: number | string;
  created_at: string;
  fail_streak: number | null;
}

interface FreshRow {
  id: string;
  is_blindspot: boolean | null;
  blindspot_recall_veto: boolean | null;
  blindspot_recall_suspect: boolean | null;
  blindspot_recall_checked_at: string | null;
  is_archived: boolean | null;
}

interface ClaimRow {
  id: number | string;
  key_id: number | string;
  alert_id: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret: string;
}

interface Outcome {
  row: ClaimRow;
  result: PostResult;
}

/** A blindspot is pushed only when the fresh row still says so, checked and clean. */
function blindspotStillHolds(f: FreshRow | undefined): boolean {
  return (
    !!f &&
    f.is_blindspot === true &&
    f.blindspot_recall_veto === false &&
    f.blindspot_recall_suspect === false &&
    f.blindspot_recall_checked_at !== null &&
    f.is_archived === false
  );
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function errorLabel(result: PostResult): string {
  return "status" in result ? `http_${result.status}` : result.error;
}

export const GET = withApiErrors(async (request: Request) => {
  await connection();

  const auth = requireCronBearer(request);
  if (!auth.ok) return auth.response;

  const rl = cronAlertsWebhooksLimit(clientKey(request));
  if (!rl.allowed) {
    return NextResponse.json(
      { skipped: "rate limited", retryAfterMs: rl.retryAfterMs },
      { status: 429 },
    );
  }

  if (process.env.ALERT_WEBHOOKS_DISABLED === "1") {
    return NextResponse.json({ skipped: "disabled" });
  }

  const supabase = createServerClient();

  // Webhook rows are read WITHOUT url or secret here; the claim RPC hands
  // those out per delivery, so they never sit in this function's scope longer.
  const { data: hookData, error: hookError } = await supabase
    .from("api_key_webhooks")
    .select("key_id, created_at, fail_streak, api_keys!inner(revoked_at)")
    .eq("enabled", true)
    .is("api_keys.revoked_at", null)
    .order("key_id", { ascending: true })
    .limit(MAX_WEBHOOKS + 1);
  if (hookError) return apiServerError(hookError);

  const allHooks = (hookData ?? []) as unknown as WebhookRow[];
  if (allHooks.length === 0) {
    return NextResponse.json({ skipped: "no webhooks" });
  }
  if (allHooks.length > MAX_WEBHOOKS) {
    console.warn(`[alerts-webhooks] more than ${MAX_WEBHOOKS} enabled webhooks; serving the first ${MAX_WEBHOOKS}`);
  }
  const hooks = allHooks.slice(0, MAX_WEBHOOKS);

  const health = await getZoneFeedHealth();
  if (health === null) {
    console.log("[alerts-webhooks] feed health unknown; skipping this tick");
    return NextResponse.json({ skipped: "feed health unknown" });
  }

  const nowMs = Date.now();
  let items: AlertItem[];
  try {
    items = await getAlertItems({
      sinceIso: new Date(nowMs - ALERT_WINDOW_MS).toISOString(),
      limit: ALERT_LIMIT,
      health,
    });
  } catch (err) {
    return apiServerError(err);
  }

  // Fresh re-read: never trust the 5 minute cached bundle alone for a claim
  // pushed to a third party. A failed read drops the blindspots (fail closed).
  const blindspotIds = items.filter((i) => i.type === "blindspot").map((i) => i.clusterId);
  const fresh = new Map<string, FreshRow>();
  if (blindspotIds.length > 0) {
    const { data: freshRows, error: freshError } = await supabase
      .from("clusters")
      .select(FRESH_SELECT)
      .in("id", blindspotIds)
      .returns<FreshRow[]>();
    if (freshError) {
      console.warn("[alerts-webhooks] fresh blindspot re-read failed; skipping blindspots this tick");
    } else {
      for (const r of freshRows ?? []) fresh.set(r.id, r);
    }
  }
  const pushable = items.filter((i) => i.type !== "blindspot" || blindspotStillHolds(fresh.get(i.clusterId)));

  // Enqueue.
  let enqueued = 0;
  for (const hook of hooks) {
    const createdMs = Date.parse(hook.created_at);
    const rows = pushable
      .filter((i) => Date.parse(i.updatedAt) >= createdMs)
      .map((i) => {
        const alert = toV1AlertRecord(i);
        return {
          key_id: Number(hook.key_id),
          alert_id: alert.id,
          payload: {
            event: WEBHOOK_EVENT,
            alert,
            licence: REGISTRY_LICENCE,
            attribution: REGISTRY_ATTRIBUTION,
          },
        };
      });
    if (rows.length === 0) continue;
    const { data: inserted, error: upsertError } = await supabase
      .from("api_key_webhook_deliveries")
      .upsert(rows, { onConflict: "key_id,alert_id", ignoreDuplicates: true })
      .select("id");
    if (upsertError) {
      console.warn("[alerts-webhooks] enqueue failed for one webhook");
      continue;
    }
    enqueued += Array.isArray(inserted) ? inserted.length : 0;
  }

  // Claim + deliver.
  const { data: claimData, error: claimError } = await supabase.rpc("api_webhook_claim", {
    p_limit: CLAIM_LIMIT,
  });
  if (claimError) return apiServerError(claimError);
  const claimed = (Array.isArray(claimData) ? claimData : []) as ClaimRow[];

  const outcomes: Outcome[] = await mapConcurrent(claimed, CONCURRENCY, async (row) => {
    const body = JSON.stringify(row.payload);
    // Fresh timestamp and signature on every attempt; identical bytes.
    const headers = buildWebhookHeaders({
      secret: row.secret,
      deliveryId: row.id,
      timestampSec: Math.floor(Date.now() / 1000),
      body,
    });
    const result = await postWebhook(row.url, body, headers, { timeoutMs: 5000 });
    return { row, result };
  });

  // Record outcomes sequentially: the per-key fail streak is a running value.
  const streaks = new Map<number, number>();
  for (const h of hooks) streaks.set(Number(h.key_id), h.fail_streak ?? 0);
  const unknownKeys = [...new Set(claimed.map((r) => Number(r.key_id)))].filter((k) => !streaks.has(k));
  if (unknownKeys.length > 0) {
    const { data: extra } = await supabase
      .from("api_key_webhooks")
      .select("key_id, fail_streak")
      .in("key_id", unknownKeys);
    for (const r of (extra ?? []) as Array<{ key_id: number | string; fail_streak: number | null }>) {
      streaks.set(Number(r.key_id), r.fail_streak ?? 0);
    }
  }

  interface KeyPatch {
    fail_streak: number;
    last_status: number | null;
    last_success_at?: string;
    last_failure_at?: string;
    updated_at: string;
    enabled?: false;
    disabled_reason?: string;
  }
  const keyPatches = new Map<number, KeyPatch>();
  const nowIso = new Date().toISOString();
  let delivered = 0;
  let retried = 0;
  let failed = 0;

  for (const { row, result } of outcomes) {
    const keyId = Number(row.key_id);
    const verdict = classify(result);
    const status = "status" in result ? result.status : null;
    const label = errorLabel(result).slice(0, 300);
    const patchState: KeyPatch = keyPatches.get(keyId) ?? {
      fail_streak: streaks.get(keyId) ?? 0,
      last_status: null,
      updated_at: nowIso,
    };

    let deliveryPatch: Record<string, unknown>;
    if (verdict === "ok") {
      delivered++;
      deliveryPatch = { status: "delivered", delivered_at: nowIso, last_status: status, last_error: null };
      patchState.fail_streak = 0;
      patchState.last_success_at = nowIso;
    } else {
      const next = verdict === "retry" ? nextAttemptAt(Number(row.attempts), Date.now()) : null;
      if (next === null) {
        failed++;
        deliveryPatch = { status: "failed", last_status: status, last_error: label };
      } else {
        retried++;
        deliveryPatch = {
          status: "pending",
          next_attempt_at: new Date(next).toISOString(),
          last_status: status,
          last_error: label,
        };
      }
      patchState.fail_streak += 1;
      patchState.last_failure_at = nowIso;
      if (patchState.fail_streak >= DISABLE_AFTER_FAILS) {
        patchState.enabled = false;
        patchState.disabled_reason = "too_many_failures";
      }
    }
    patchState.last_status = status;
    streaks.set(keyId, patchState.fail_streak);
    keyPatches.set(keyId, patchState);

    const { error: updateError } = await supabase
      .from("api_key_webhook_deliveries")
      .update(deliveryPatch)
      .eq("id", Number(row.id))
      .eq("status", "sending");
    if (updateError) console.warn("[alerts-webhooks] could not record a delivery outcome");
  }

  for (const [keyId, patch] of keyPatches) {
    const { error: hookUpdateError } = await supabase
      .from("api_key_webhooks")
      .update(patch)
      .eq("key_id", keyId);
    if (hookUpdateError) console.warn("[alerts-webhooks] could not record webhook health");
  }

  console.log(
    `[alerts-webhooks] enqueued=${enqueued} claimed=${claimed.length} delivered=${delivered} retried=${retried} failed=${failed}`,
  );
  return NextResponse.json({ ok: true, enqueued, delivered, retried, failed });
});
