// supabase/functions/_shared/kick.ts
//
// The ingest -> cluster-consumer kick (h106-attachdesign-1).
//
// Attach waited p50 55 s because cluster-drain reads cluster_work at about :02 of
// every minute and ingest inserts at :04-:12 of its minute. With CLUSTER_KICK=on,
// a cycle that inserted articles POSTs {"trigger":"ingest"} to cluster-consumer
// as soon as its enqueue is done (the `AFTER INSERT` trigger of migration 025
// enqueues inside the insert transaction, so the messages are visible by then),
// and the consumer reads them seconds later instead of at the next cron minute.
// A TTL lease (migration 190, `_shared/lease.ts`) keeps that consumer and the
// cron one from reading the queue at the same time.
//
// THE RULE: the kick is NEVER awaited inside ingest's response path. This is the
// #252 failure mode (h102-pollregression-1): pg_net 0.20.0 starts its next batch
// only after the previous request has ended, so an ingest handler that waits for
// the consumer holds ingest-drain's request open and keeps every request queued
// behind it (cluster-drain) from starting. The kick therefore runs inside
// `EdgeRuntime.waitUntil` -- the runtime flushes the response first and keeps the
// isolate alive for the promise -- and where the runtime has none (tests, local
// serve) it is an un-awaited promise. `kickClusterConsumer` never rejects, so
// that promise cannot become an unhandled rejection, and `scheduleClusterKick`
// returns void and never throws: a rejected fetch, a timeout (45 s) or a non-2xx
// answer is captured and warned about and can never change the response.
//
// Only environment the functions already read is used: SUPABASE_URL and the
// service-role key (the same names, and the same local-development fallbacks, as
// `_shared/supabase.ts`). The key goes into one request header and nowhere else:
// it is never logged, never put in a message that is captured, and a message that
// happens to contain it is redacted first. The consumer's answer body is read for
// two numbers and never logged.

/** The Edge secret that switches the kick on (`supabase secrets set CLUSTER_KICK=on`); any other value is off. */
export const KICK_ENV = "CLUSTER_KICK";
/** The consumer's path under SUPABASE_URL. */
export const KICK_PATH = "/functions/v1/cluster-consumer";
/** How long the kick may take before its fetch is aborted (the consumer's own wait is at most 10 s plus a 30 s drain). */
export const KICK_TIMEOUT_MS = 45_000;

const KICK_BODY = '{"trigger":"ingest"}';

/**
 * True when a cycle should kick the consumer: the flag is exactly "on" and the
 * cycle inserted at least one article. Anything else (unset, "off", "ON", a
 * count that is zero, negative, not finite or not a number) is no kick.
 */
export function shouldKick(flag: unknown, inserted: unknown): boolean {
  return flag === "on" && typeof inserted === "number" && Number.isFinite(inserted) && inserted > 0;
}

export interface KickTarget {
  /** SUPABASE_URL without trailing slashes, http(s) only. */
  url: string;
  /** The service-role key: used as the bearer, never logged. */
  key: string;
}

function denoEnv(name: string): string | undefined {
  // Deno.env.get can throw under restricted permissions (and `Deno` is absent outside the runtime): guard.
  try {
    return Deno.env.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The URL and the service-role key from the environment, or null when either is
 * missing or the URL is not an http(s) address. Reads the names
 * `createServiceClient` reads, in the same order.
 */
export function clusterKickTarget(readEnv: (name: string) => string | undefined = denoEnv): KickTarget | null {
  const rawUrl = readEnv("SUPABASE_URL") || readEnv("SB_URL") || readEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = readEnv("SUPABASE_SERVICE_ROLE_KEY") || readEnv("SB_SERVICE_ROLE_KEY");
  if (!rawUrl || !key) return null;
  let url = rawUrl;
  while (url.endsWith("/")) url = url.slice(0, -1);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return { url, key };
}

export interface KickDeps {
  /** `fetch` by default. */
  fetchFn?: typeof fetch;
  /** Takes the kick's promise instead of `EdgeRuntime.waitUntil`. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** The clock for the elapsed time in the log line. `Date.now` by default. */
  now?: () => number;
  /** One info line. `console.log` by default. */
  log?: (line: string) => void;
  /** One warning line. `console.warn` by default. */
  warn?: (line: string) => void;
  /** Reports an error (ingest passes Sentry's captureException). Nothing by default. */
  capture?: (err: unknown) => void;
  /** An abort signal that fires after `ms`. `AbortSignal.timeout` by default. */
  timeoutSignal?: (ms: number) => AbortSignal;
  /** The environment reader of `scheduleClusterKick` when it builds the target itself. */
  env?: (name: string) => string | undefined;
}

export interface KickOutcome {
  /** True for a 2xx answer. */
  ok: boolean;
  /** The HTTP status, or null when no answer came (rejected fetch, timeout). */
  status: number | null;
  /** The `drained` count of a 2xx answer, or null. */
  drained: number | null;
  ms: number;
}

/** Replaces every occurrence of the secret in a message. */
function redact(text: string, secret: string): string {
  return secret.length > 0 ? text.split(secret).join("[redacted]") : text;
}

/** A short lowercase-and-hyphen word from the consumer's answer (its `reason`), or undefined. Anything else is dropped. */
function shortWord(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return undefined;
  for (const ch of value) {
    if (!((ch >= "a" && ch <= "z") || ch === "-")) return undefined;
  }
  return value;
}

/**
 * POSTs the kick and reports what came back. Never rejects and never throws:
 * every failure is warned about, passed to `capture` and returned as an outcome
 * with `ok: false`. The fetch starts before the first `await`, so a caller that
 * does not wait for the returned promise has still sent the request.
 */
export async function kickClusterConsumer(target: KickTarget, deps: KickDeps = {}): Promise<KickOutcome> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const capture = deps.capture ?? (() => {});
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  const report = (err: Error, line: string): void => {
    try {
      warn(line);
    } catch {
      // a logger that throws must not escape either
    }
    try {
      capture(err);
    } catch {
      // nor a reporter
    }
  };

  const startedAt = now();
  try {
    const res = await fetchFn(`${target.url}${KICK_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.key}`, "content-type": "application/json" },
      body: KICK_BODY,
      signal: timeoutSignal(KICK_TIMEOUT_MS),
    });
    const ms = now() - startedAt;

    if (res.status < 200 || res.status > 299) {
      // Release the connection; the body is never read into a log.
      try {
        await res.body?.cancel();
      } catch {
        // already closed
      }
      report(
        new Error(`cluster kick: the consumer answered HTTP ${res.status}`),
        `[ingest] cluster kick answered HTTP ${res.status} after ${ms} ms`,
      );
      return { ok: false, status: res.status, drained: null, ms };
    }

    let answer: unknown = null;
    try {
      answer = await res.json();
    } catch {
      answer = null;
    }
    const fields = (answer !== null && typeof answer === "object" ? answer : {}) as Record<string, unknown>;
    const drained = typeof fields.drained === "number" && Number.isFinite(fields.drained) ? fields.drained : null;
    const summary: Record<string, unknown> = { status: res.status, drained, ms };
    if (fields.busy === true) summary.busy = true;
    if (fields.empty === true) summary.empty = true;
    const reason = shortWord(fields.reason);
    if (reason !== undefined) summary.reason = reason;
    try {
      log(`[ingest] cluster kick ${JSON.stringify(summary)}`);
    } catch {
      // a logger that throws must not escape
    }
    return { ok: true, status: res.status, drained, ms };
  } catch (err) {
    const ms = now() - startedAt;
    const text = err instanceof Error ? err.message : String(err);
    const safe = redact(text, target.key);
    report(new Error(`cluster kick failed: ${safe}`), `[ingest] cluster kick failed after ${ms} ms: ${safe}`);
    return { ok: false, status: null, drained: null, ms };
  }
}

/**
 * Fires the kick and returns at once, void. The promise of the request goes to
 * `deps.waitUntil`, else to `EdgeRuntime.waitUntil` (called as a method) when the
 * runtime has one, else it is left un-awaited. `target` is the URL and key, or
 * undefined to read them from the environment; null (or an environment without
 * them) skips the kick with one warning. Never throws.
 */
export function scheduleClusterKick(target?: KickTarget | null, deps: KickDeps = {}): void {
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  let secret = "";
  try {
    const resolved = target === undefined ? clusterKickTarget(deps.env ?? denoEnv) : target;
    if (resolved === null) {
      warn("[ingest] cluster kick skipped: SUPABASE_URL or the service-role secret is not configured");
      return;
    }
    secret = resolved.key;
    const promise = kickClusterConsumer(resolved, deps);
    if (deps.waitUntil) {
      deps.waitUntil(promise);
      return;
    }
    const edge = (globalThis as { EdgeRuntime?: { waitUntil?: unknown } }).EdgeRuntime;
    if (edge !== undefined && edge !== null && typeof edge.waitUntil === "function") {
      (edge as { waitUntil: (p: Promise<unknown>) => void }).waitUntil(promise);
      return;
    }
    // No runtime hook (tests, local serve): the promise is simply not awaited. It never rejects.
    void promise;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    try {
      warn(`[ingest] cluster kick could not be scheduled: ${redact(text, secret)}`);
    } catch {
      // a logger that throws must not escape
    }
  }
}
