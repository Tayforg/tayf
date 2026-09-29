import https from "node:https";
import type { LookupFunction } from "node:net";

import { pinnedLookup, validateWebhookUrlSyntax } from "@/lib/alerts/webhook-url";

/**
 * Outbound delivery for signed webhooks (Node only). One POST, no redirect
 * following, response body capped at 4 KB and thrown away, hard timeout.
 * The connect goes through `pinnedLookup`, so a hostname that re-resolves to
 * a private address between registration and delivery is refused at connect.
 */

export const MAX_ATTEMPTS = 5;
export const DISABLE_AFTER_FAILS = 20;
export const WEBHOOK_TIMEOUT_MS = 5000;
export const RESPONSE_CAP_BYTES = 4096;

const BACKOFF_MINUTES = [1, 5, 15, 60] as const;

export type WebhookErrorKind = "timeout" | "network" | "blocked";
export type PostResult = { status: number } | { error: WebhookErrorKind };
export type Verdict = "ok" | "retry" | "fail";

export function classify(result: number | PostResult): Verdict {
  if (typeof result === "object") {
    if ("error" in result) return result.error === "blocked" ? "fail" : "retry";
    return classify(result.status);
  }
  const status = result;
  if (status >= 200 && status < 300) return "ok";
  if (status >= 500 || status === 408 || status === 429) return "retry";
  return "fail";
}

/**
 * Epoch ms of the next attempt, given how many attempts have been made so
 * far (the claim already counted the one that just ran). Null once
 * MAX_ATTEMPTS is reached: the delivery is then terminally 'failed'.
 */
export function nextAttemptAt(attempts: number, nowMs: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  const idx = Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1;
  return nowMs + BACKOFF_MINUTES[idx]! * 60_000;
}

export interface TransportInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export type WebhookTransport = (url: URL, init: TransportInit) => Promise<{ status: number }>;

/** Default transport: node:https with the SSRF-pinned lookup. Never follows redirects. */
export const httpsTransport: WebhookTransport = (url, init) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: init.method,
        headers: { ...init.headers, "Content-Length": String(Buffer.byteLength(init.body)) },
        lookup: pinnedLookup as unknown as LookupFunction,
        signal: init.signal,
      },
      (res) => {
        let seen = 0;
        res.on("data", (chunk: Buffer) => {
          seen += chunk.length;
          if (seen >= RESPONSE_CAP_BYTES) res.destroy();
        });
        res.on("error", () => {
          /* body discarded; status already known */
        });
        const done = () => resolve({ status: res.statusCode ?? 0 });
        res.on("end", done);
        res.on("close", done);
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });

export async function postWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
  opts: { timeoutMs?: number; transport?: WebhookTransport } = {},
): Promise<PostResult> {
  const check = validateWebhookUrlSyntax(url);
  if (!check.ok) return { error: "blocked" };

  const transport = opts.transport ?? httpsTransport;
  const timeoutMs = opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
  });

  try {
    const res = await Promise.race([
      transport(check.url, { method: "POST", headers, body, signal: controller.signal }),
      timeout,
    ]);
    return { status: res.status };
  } catch (err) {
    if (timedOut) return { error: "timeout" };
    const code = (err as { code?: string } | null)?.code;
    if (code === "ETAYFBLOCKED") return { error: "blocked" };
    if (code === "ETIMEDOUT" || code === "ABORT_ERR") return { error: "timeout" };
    return { error: "network" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
