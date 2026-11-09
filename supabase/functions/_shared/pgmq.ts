// supabase/functions/_shared/pgmq.ts
//
// Thin RPC wrapper over the `pgmq` extension functions. The service-role
// client routes through PostgREST, which only sees the `public` schema —
// `pgmq` is deliberately NOT exposed (Round-6 audit). So we call public
// SECURITY DEFINER shims (`public.pgmq_*`, migration 029) that proxy to the
// real `pgmq.*` functions; EXECUTE on the shims is granted to service_role
// only. Arg names below match the shim parameter names.
//
// Migration 188 adds the long-poll twin of the read shim (`pgmq_read_msgs_poll`,
// over `pgmq.read_with_poll`); `readBatchPoll` below calls it.
//
// pgmq's row shape (from `pgmq.read`):
//   msg_id      bigint
//   read_ct     integer    -- how many times read (visibility-timeout retries)
//   enqueued_at timestamptz
//   vt          timestamptz
//   message     jsonb

import type { SupabaseClient } from "./supabase.ts";

export interface PgmqMessage<T = unknown> {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: T;
}

/**
 * Reads up to `qty` messages from `queue`, leasing them for `vt` seconds.
 * Returns [] if the queue is empty.
 */
export async function readBatch<T = unknown>(
  client: SupabaseClient,
  queue: string,
  vt = 60,
  qty = 50,
): Promise<PgmqMessage<T>[]> {
  const { data, error } = await client.rpc("pgmq_read_msgs", {
    queue_name: queue,
    vt,
    qty,
  });
  if (error) {
    throw new Error(`pgmq.read(${queue}): ${error.message}`);
  }
  return (data ?? []) as PgmqMessage<T>[];
}

/**
 * Like `readBatch`, but waits for a message instead of answering [] at once:
 * the database re-reads every `pollIntervalMs` until a message shows up or
 * `maxPollSeconds` have passed (migration 188, `pgmq.read_with_poll`). Returns
 * as soon as at least one message was leased, [] when the wait ran out empty.
 *
 * The database function clamps the wait to 1..6 s and the step to 50..1000 ms
 * on its own: PostgREST's authenticator role cancels any statement after 8 s
 * (57014), so a longer poll could never succeed. Nothing is clamped here.
 *
 * Errors have `readBatch`'s message shape. The PostgREST / Postgres error code
 * is kept on the thrown error as `code`, so a caller can tell "the RPC does not
 * exist yet" (`isPollRpcMissing`: migration 188 not applied) from a real failure.
 */
export async function readBatchPoll<T = unknown>(
  client: SupabaseClient,
  queue: string,
  vt: number,
  qty: number,
  maxPollSeconds: number,
  pollIntervalMs: number,
): Promise<PgmqMessage<T>[]> {
  const { data, error } = await client.rpc("pgmq_read_msgs_poll", {
    queue_name: queue,
    vt,
    qty,
    max_poll_seconds: maxPollSeconds,
    poll_interval_ms: pollIntervalMs,
  });
  if (error) {
    const failure = new Error(`pgmq.read(${queue}): ${error.message}`);
    const code: unknown = (error as { code?: unknown }).code;
    if (typeof code === "string") (failure as Error & { code?: string }).code = code;
    throw failure;
  }
  return (data ?? []) as PgmqMessage<T>[];
}

/**
 * True when `err` says the long-poll RPC does not exist: PostgREST's
 * PGRST202 (not in its schema cache) or Postgres' 42883 (undefined_function,
 * e.g. dropped while PostgREST still had it cached). Only that: a timeout,
 * a permission error or an unknown failure is a real failure.
 */
export function isPollRpcMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === "PGRST202" || code === "42883";
}

/**
 * Archives a single message — moves it to the archive table and removes it
 * from the live queue. Used on successful processing.
 */
export async function archive(
  client: SupabaseClient,
  queue: string,
  msgId: number,
): Promise<void> {
  const { error } = await client.rpc("pgmq_archive_msg", {
    queue_name: queue,
    msg_id: msgId,
  });
  if (error) {
    throw new Error(`pgmq.archive(${queue}, ${msgId}): ${error.message}`);
  }
}

/**
 * Permanently deletes a message from the queue WITHOUT archiving.
 * Operational escape hatch only — the consumers archive poison messages
 * (audit S12) so the payload survives in `pgmq.a_<queue>` as the audit
 * trail; nothing in the drain paths deletes anymore.
 */
export async function deleteMessage(
  client: SupabaseClient,
  queue: string,
  msgId: number,
): Promise<void> {
  const { error } = await client.rpc("pgmq_delete_msg", {
    queue_name: queue,
    msg_id: msgId,
  });
  if (error) {
    throw new Error(`pgmq.delete(${queue}, ${msgId}): ${error.message}`);
  }
}

export interface QueueDepth {
  depth: number | null;
  oldest_msg_age_sec: number | null;
}

/**
 * Best-effort queue depth probe via `pgmq.metrics` (granted to
 * service_role in migration 024). Surfaces both `queue_length` (as `depth`)
 * and `oldest_msg_age_sec` so the drain summary can report queue backlog age
 * alongside size. Each field falls back to null independently on any failure —
 * depth sampling is observability garnish and must never fail a drain.
 */
export async function queueDepth(
  client: SupabaseClient,
  queue: string,
): Promise<QueueDepth> {
  const { data, error } = await client.rpc("pgmq_metrics_one", {
    queue_name: queue,
  });
  if (error) return { depth: null, oldest_msg_age_sec: null };
  const row = (Array.isArray(data) ? data[0] : data) as
    | { queue_length?: number; oldest_msg_age_sec?: number }
    | null;
  const len = row?.queue_length;
  const oldest = row?.oldest_msg_age_sec;
  return {
    depth: typeof len === "number" ? len : null,
    oldest_msg_age_sec: typeof oldest === "number" ? oldest : null,
  };
}

/**
 * Enqueue a JSON-serialisable payload. Returns the new msg_id.
 */
export async function send(
  client: SupabaseClient,
  queue: string,
  payload: unknown,
): Promise<number> {
  const { data, error } = await client.rpc("pgmq_send_msg", {
    queue_name: queue,
    message: payload,
  });
  if (error) {
    throw new Error(`pgmq.send(${queue}): ${error.message}`);
  }
  // pgmq.send returns a single bigint (the msg_id). PostgREST hands it back as
  // a JSON number; a one-element array and a numeric string are tolerated too.
  // Anything else (null, undefined, [], "abc", ...) is NOT a message id: fail
  // loudly rather than return 0 or NaN for a send that may not have happened.
  const id: unknown = Array.isArray(data) ? data[0] : data;
  let msgId = Number.NaN;
  if (typeof id === "number") msgId = id;
  else if (typeof id === "string" && id.trim() !== "") msgId = Number(id);
  if (!Number.isFinite(msgId)) {
    throw new Error(`pgmq.send(${queue}): no msg_id returned`);
  }
  return msgId;
}
