/**
 * Thin Resend client. No SDK dependency — a single `fetch` call to Resend's
 * REST API, which is all `sendEmail` needs. Callers are route handlers
 * (`/api/newsletter`, the digest cron), so every path here returns a result
 * object instead of throwing: an email failure must never turn into a 500
 * for the reader who just submitted a form.
 */

const RESEND_API_URL = "https://api.resend.com/emails";

// h87-newsletter-2: Resend's documented default is 2 requests per second per
// team. An excess is a 429 with a Retry-After (seconds). A 429 is retried, at
// most MAX_429_RETRIES times, after the clamped Retry-After; sendBatch keeps its
// starts MIN_INTERVAL apart so that retrying is the exception, not the pace.
const MAX_429_RETRIES = 2;
const RETRY_AFTER_DEFAULT_MS = 1000;
const RETRY_AFTER_MIN_MS = 500;
const RETRY_AFTER_MAX_MS = 10_000;
const DEFAULT_MIN_INTERVAL_MS = 500;

// SEC-digest-double-send-1: a hung request must not hold a batch (and, behind it, the
// caller's stamps) for as long as the platform lets the function live. The limit covers
// the whole exchange, the body read included; an abort is an ordinary `{ ok: false }`.
const FETCH_TIMEOUT_MS = 8_000;

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));
let sleep = defaultSleep;

/** Test-only: replace (or, with no argument, restore) the sleep the retry and pacing waits use. */
export function __setResendSleepForTests(replacement?: (ms: number) => Promise<void>): void {
  sleep = replacement ?? defaultSleep;
}

/**
 * Retry-After as a wait in ms. Only the delta-seconds form ("2", "1.5") is read;
 * a missing header, an HTTP-date or any other text waits RETRY_AFTER_DEFAULT_MS.
 * A parsed value is clamped to RETRY_AFTER_MIN_MS-RETRY_AFTER_MAX_MS: a 0 must not
 * mean an instant hammer, and a huge value must not eat the cron's 60 s.
 */
function retryAfterMs(header: string | null): number {
  const text = header?.trim() ?? "";
  if (!/^\d+(\.\d+)?$/.test(text)) return RETRY_AFTER_DEFAULT_MS;
  const ms = Number(text) * 1000;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms));
}

// Warn about a missing key at most once per process so local dev / a
// not-yet-configured preview deploy doesn't spam stderr on every signup or
// every row of a digest batch.
let warnedMissingKey = false;

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /**
   * Extra mail headers (e.g. RFC 2369/8058 `List-Unsubscribe` /
   * `List-Unsubscribe-Post` on the digest — see
   * src/app/api/cron/digest/route.ts). Values are sanitized before they
   * reach the request body: a CR/LF in a header value could otherwise
   * smuggle an extra header into the request (header injection), so any
   * run of `\r`/`\n` is collapsed to a single space. Standard casing like
   * `List-Unsubscribe` is fine as written — mail headers are
   * case-insensitive.
   */
  headers?: Record<string, string>;
}

export type SendEmailResult =
  | { skipped: true }
  // sendBatch only: the item was never attempted because the batch deadline had
  // passed, so nothing was sent and the recipient is still owed the mail.
  | { deferred: true }
  | { ok: true; id?: string }
  | { ok: false; error: string };

/**
 * Send one transactional email via Resend.
 *
 * - No `RESEND_API_KEY` configured → soft no-op: `{ skipped: true }` plus a
 *   one-time console warning.
 * - Resend rate limits the request (429) → retried up to twice, after the
 *   clamped `Retry-After` (see `retryAfterMs`); still 429 → `{ ok: false, error }`.
 * - Resend rejects the request (any other non-2xx) → `{ ok: false, error }`,
 *   never retried.
 * - Network/parse failure → `{ ok: false, error }`. Never throws.
 * - No answer within FETCH_TIMEOUT_MS (8 s) → the request is aborted, `{ ok: false, error }`.
 *   Resend may still have accepted that message: the caller cannot tell.
 */
/**
 * Single source of truth for "can this deployment send mail?". Every
 * surface that offers or promises e-mail (footer form, POST /api/newsletter,
 * the digest cron) must gate on this so nothing is shown or accepted that
 * cannot actually be delivered.
 */
export function isMailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendEmail(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  return deliver(input);
}

/** What sendBatch hands `deliver`: its pacing and the point past which nothing may start. */
interface DeliverGate {
  /**
   * Reserve the next start slot and wait for it. False means the deadline leaves no
   * slot: nothing was reserved, nothing slept, and the request must not be made.
   */
  slot: () => Promise<boolean>;
  deadlineAt?: number;
}

/**
 * `sendEmail`'s body. `gate`, when given, is consulted in front of every request to
 * Resend, the first one and each 429 retry, and only once the API key is known to be
 * set (sendBatch passes its pacing and deadline here). An item that gets no slot for
 * its first request was never attempted: `{ deferred: true }`. One that got a 429 and
 * then no slot for the retry ends as that 429.
 */
async function deliver(
  input: SendEmailInput,
  gate?: DeliverGate,
): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn("[resend] RESEND_API_KEY is not set; emails are no-ops");
    }
    return { skipped: true };
  }

  const from = process.env.NEWSLETTER_FROM ?? "Tayf <bulten@tayfhaber.com>";

  const sanitizedHeaders = input.headers
    ? Object.fromEntries(
        Object.entries(input.headers).map(([key, value]) => [
          key,
          value.replace(/[\r\n]+/g, " "),
        ]),
      )
    : undefined;

  // Built once: a retry resends the identical message, headers included.
  const body = JSON.stringify({
    from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    ...(input.text ? { text: input.text } : {}),
    ...(sanitizedHeaders && Object.keys(sanitizedHeaders).length > 0
      ? { headers: sanitizedHeaders }
      : {}),
  });

  try {
    // The last 429 this item got, for the case where its retry finds no slot left.
    let lastError = "";
    for (let attempt = 0; ; attempt++) {
      if (gate && !(await gate.slot())) {
        return attempt === 0 ? { deferred: true } : { ok: false, error: lastError };
      }
      const res = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { id?: string } | null;
        return { ok: true, id: data?.id };
      }

      const errorBody = await res.text().catch(() => "");
      const error = `Resend ${res.status}: ${errorBody}`;
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const waitMs = retryAfterMs(res.headers.get("retry-after"));
        // A wait that ends at or past the deadline would only hand the retry to a
        // batch that has stopped starting sends: give the 429 back now instead.
        if (gate?.deadlineAt !== undefined && Date.now() + waitMs >= gate.deadlineAt) {
          return { ok: false, error };
        }
        await sleep(waitMs);
        lastError = error;
        continue;
      }
      return { ok: false, error };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// When the next request to Resend may start, shared by every sendBatch call in
// this process: the digest sends in chunks, and the spacing must hold across the
// chunk boundary too. A value in the past is no constraint.
let nextStartAt = 0;

/**
 * Reserve the next start slot and wait for it. The read and the write of
 * `nextStartAt` have no await between them, so concurrent workers each get their
 * own slot, `minIntervalMs` after the previous one. When `deadlineAt` is given and
 * the slot would start at or after it, nothing is reserved and nothing is slept:
 * the answer is false, "no slot", and a request that never started costs the
 * pacing of later batches nothing.
 */
async function awaitStartSlot(minIntervalMs: number, deadlineAt?: number): Promise<boolean> {
  const now = Date.now();
  const startAt = Math.max(now, nextStartAt);
  if (deadlineAt !== undefined && startAt >= deadlineAt) return false;
  const gap = Number.isFinite(minIntervalMs) && minIntervalMs > 0 ? minIntervalMs : 0;
  nextStartAt = startAt + gap;
  if (startAt > now) await sleep(startAt - now);
  return true;
}

export interface SendBatchOptions {
  /** Smallest gap, in ms, between two request starts (default 500; 0 or less switches pacing off). */
  minIntervalMs?: number;
  /**
   * Epoch ms. No request, start slot wait or 429 sleep begins at or after it; an item
   * never attempted is `{ deferred: true }`. Requests already in flight finish (each
   * is bounded by the fetch timeout), so the batch settles at most that long after it.
   */
  deadlineAt?: number;
  /**
   * Called as each item finishes (not for an item skipped at the deadline before it
   * started), while the other workers carry on. The worker waits for it, so a caller
   * that records the outcome (the digest stamps `last_sent_at`) has done so before that
   * worker takes another item. A throw or a rejection is swallowed: the batch goes on.
   */
  onResult?: (index: number, result: SendEmailResult) => void | Promise<void>;
}

/**
 * Send a list of emails with bounded concurrency (default 5), paced so that no
 * two requests to Resend start less than `minIntervalMs` apart (default 500 ms,
 * Resend's default 2 requests per second), whatever the concurrency. A 429 retry
 * counts as a start. Used by the digest cron to mail every due subscriber. Each
 * item resolves independently, in input order: a failed send never aborts the
 * rest of the batch. Without an API key nothing is paced: every item is skipped.
 * `deadlineAt` and `onResult` are described on SendBatchOptions.
 */
export async function sendBatch(
  list: SendEmailInput[],
  concurrency = 5,
  { minIntervalMs = DEFAULT_MIN_INTERVAL_MS, deadlineAt, onResult }: SendBatchOptions = {},
): Promise<SendEmailResult[]> {
  const results: SendEmailResult[] = new Array(list.length);
  let cursor = 0;
  const gate: DeliverGate = { slot: () => awaitStartSlot(minIntervalMs, deadlineAt), deadlineAt };

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        results[i] = { deferred: true };
        continue;
      }
      const result = await deliver(list[i]!, gate);
      results[i] = result;
      if (onResult) {
        try {
          await onResult(i, result);
        } catch {
          // The caller's bookkeeping failing must not abort the other sends.
        }
      }
    }
  }

  const workerCount = Math.max(0, Math.min(concurrency, list.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
