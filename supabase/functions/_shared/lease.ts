// supabase/functions/_shared/lease.ts
//
// The TTL lease the cluster consumer takes before it reads `cluster_work`
// (h106-attachdesign-1, migration 190). Two consumers can be alive at once in
// different isolates: the one pg_cron starts every minute and the one ingest
// kicks (`_shared/kick.ts`) right after its enqueue. `drainInFlight` in
// cluster-consumer only serialises ONE isolate, and two readers on the queue
// would score the same story's messages in parallel and open twins. PostgREST
// cannot hold a session advisory lock, so the lease is a row with an expiry,
// taken and given back through two SECURITY DEFINER RPCs (service_role only):
//
//   public.consumer_lease_acquire(p_name, p_holder, p_ttl_seconds) -> boolean
//   public.consumer_lease_release(p_name, p_holder)                -> boolean
//
// `acquire` is also the renewal (the same holder acquiring again) and the
// takeover (an expired row of any holder). The argument names below are the
// parameter names of migration 190; tests/functions/_shared/lease.test.ts pins
// them against the SQL file.
//
// Same shape as `_shared/pgmq.ts`: an RPC error becomes a thrown Error whose
// message names the call, with the PostgREST / Postgres error code kept as
// `code`, so a caller can tell "migration 190 is not applied"
// (`isLeaseRpcMissing`) from a real failure.

import type { SupabaseClient } from "./supabase.ts";

/** Keeps the code of an RPC error on the Error we throw, when it has one. */
function rpcFailure(label: string, error: { message: string; code?: unknown }): Error {
  const failure = new Error(`${label}: ${error.message}`);
  if (typeof error.code === "string") (failure as Error & { code?: string }).code = error.code;
  return failure;
}

/**
 * Takes the lease `name` for `holder` for `ttlSeconds` (the database clamps it
 * to 5..120), or renews it when `holder` already holds it, or takes it over
 * when the previous holder's lease has expired. True when the caller holds the
 * lease afterwards, false when somebody else holds an unexpired one.
 *
 * Throws on an RPC error, and on an answer that is not a boolean (an unknown
 * shape is neither "free" nor "busy": the caller decides what an error means).
 * A rejected call (network failure) propagates as it is.
 */
export async function acquireLease(
  client: SupabaseClient,
  name: string,
  holder: string,
  ttlSeconds: number,
): Promise<boolean> {
  const { data, error } = await client.rpc("consumer_lease_acquire", {
    p_name: name,
    p_holder: holder,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) throw rpcFailure(`lease.acquire(${name})`, error);
  if (data === true) return true;
  if (data === false) return false;
  throw new Error(`lease.acquire(${name}): unexpected result`);
}

/**
 * Gives the lease back: deletes the row only when `holder` still holds it.
 * True when a row was deleted, false when there was nothing of ours to delete
 * (the lease expired and somebody took it over, or it was released already) --
 * that is not an error, and an empty answer counts as false. Throws on an RPC
 * error; the caller treats a failed release as best effort (the TTL frees the
 * lease anyway).
 */
export async function releaseLease(
  client: SupabaseClient,
  name: string,
  holder: string,
): Promise<boolean> {
  const { data, error } = await client.rpc("consumer_lease_release", {
    p_name: name,
    p_holder: holder,
  });
  if (error) throw rpcFailure(`lease.release(${name})`, error);
  return data === true;
}

/**
 * True when `err` says the lease RPC does not exist: PostgREST's PGRST202 (not
 * in its schema cache) or Postgres' 42883 (undefined_function, e.g. dropped
 * while PostgREST still had it cached). Only that: a timeout, a permission
 * error or an unknown failure is a real failure.
 */
export function isLeaseRpcMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === "PGRST202" || code === "42883";
}

// ---------------------------------------------------------------------------
// The kick's wait
// ---------------------------------------------------------------------------

export interface LeaseWaitOptions {
  /** One acquire attempt; may throw (an RPC error ends the wait with outcome "error"). */
  acquire: () => Promise<boolean>;
  /** The queue depth, or null when unknown. A thrown error counts as unknown. 0 is the only value that ends the wait early. */
  depth: () => Promise<number | null>;
  /** The longest the wait may last, in ms. 0 means one try and no wait. */
  waitMs: number;
  /** The pause between two tries, in ms (floored to 1; a value that is not a number is 400). */
  stepMs: number;
  /** The clock. Injected in tests; `Date.now` by default. */
  now?: () => number;
  /** The sleep. Injected in tests; a `setTimeout` promise by default. */
  sleep?: (ms: number) => Promise<void>;
}

export type LeaseWaitResult =
  | { outcome: "acquired"; tries: number; waitedMs: number }
  | { outcome: "busy"; tries: number; waitedMs: number }
  | { outcome: "empty"; tries: number; waitedMs: number }
  | { outcome: "error"; error: unknown; tries: number; waitedMs: number };

const DEFAULT_STEP_MS = 400;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for the lease the way a kicked consumer does: try, and on a refusal
 * look at the queue (an empty queue means the other consumer drained
 * everything: leave), sleep one step, try again, until `waitMs` have passed.
 *
 *   acquired  the lease is ours;
 *   busy      still held when `waitMs` ran out (the last try is made at
 *             exactly `waitMs`, and no sleep ever passes it);
 *   empty     a refusal, and then the queue was empty;
 *   error     an acquire threw: no second try (a kick fails closed), the
 *             error is handed back so the caller can classify it.
 *
 * The time waited is the larger of the clock and the time slept, so a frozen
 * or non-numeric clock still ends the wait after `waitMs` of sleeping.
 */
export async function waitForLease(options: LeaseWaitOptions): Promise<LeaseWaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const waitMs = Number.isFinite(options.waitMs) && options.waitMs > 0 ? options.waitMs : 0;
  const stepMs = Number.isFinite(options.stepMs) && options.stepMs >= 1 ? Math.floor(options.stepMs) : DEFAULT_STEP_MS;
  const startedAt = now();
  let slept = 0;
  let tries = 0;

  const waited = (): number => {
    const wall = now() - startedAt;
    return Number.isFinite(wall) ? Math.max(wall, slept) : slept;
  };

  while (true) {
    tries += 1;
    let got: boolean;
    try {
      got = await options.acquire();
    } catch (error) {
      return { outcome: "error", error, tries, waitedMs: waited() };
    }
    if (got) return { outcome: "acquired", tries, waitedMs: waited() };

    const elapsed = waited();
    if (elapsed >= waitMs) return { outcome: "busy", tries, waitedMs: elapsed };

    let depth: number | null = null;
    try {
      depth = await options.depth();
    } catch {
      depth = null;
    }
    if (depth === 0) return { outcome: "empty", tries, waitedMs: waited() };

    const pause = Math.min(stepMs, waitMs - elapsed);
    await sleep(pause);
    slept += pause;
  }
}
