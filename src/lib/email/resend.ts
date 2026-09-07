/**
 * Thin Resend client. No SDK dependency — a single `fetch` call to Resend's
 * REST API, which is all `sendEmail` needs. Callers are route handlers
 * (`/api/newsletter`, the digest cron), so every path here returns a result
 * object instead of throwing: an email failure must never turn into a 500
 * for the reader who just submitted a form.
 */

const RESEND_API_URL = "https://api.resend.com/emails";

// Warn about a missing key at most once per process so local dev / a
// not-yet-configured preview deploy doesn't spam stderr on every signup or
// every row of a digest batch.
let warnedMissingKey = false;

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export type SendEmailResult =
  | { skipped: true }
  | { ok: true; id?: string }
  | { ok: false; error: string };

/**
 * Send one transactional email via Resend.
 *
 * - No `RESEND_API_KEY` configured → soft no-op: `{ skipped: true }` plus a
 *   one-time console warning.
 * - Resend rejects the request (non-2xx) → `{ ok: false, error }`.
 * - Network/parse failure → `{ ok: false, error }`. Never throws.
 */
export async function sendEmail(
  input: SendEmailInput,
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

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Resend ${res.status}: ${body}` };
    }

    const data = (await res.json().catch(() => null)) as { id?: string } | null;
    return { ok: true, id: data?.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Send a list of emails with bounded concurrency (default 5). Used by the
 * digest cron to mail every due subscriber without opening one connection
 * per row. Each item resolves independently — a failed send never aborts
 * the rest of the batch.
 */
export async function sendBatch(
  list: SendEmailInput[],
  concurrency = 5,
): Promise<SendEmailResult[]> {
  const results: SendEmailResult[] = new Array(list.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      results[i] = await sendEmail(list[i]!);
    }
  }

  const workerCount = Math.max(0, Math.min(concurrency, list.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
