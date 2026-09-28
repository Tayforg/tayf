import type { TelegramConfig } from "@/lib/social/config";

// Telegram sendMessage — a single, bounded (6s) call per post. The bot
// token lives only in the URL path; on error, every occurrence of it is
// stripped from the returned error string before it can reach a log line
// or an API response.

const TIMEOUT_MS = 6000;
const ERROR_MAX_LEN = 300;

export interface TelegramSendInput {
  text: string;
  url: string;
}

export type TelegramSendResult =
  | { ok: true; externalId: string }
  | { ok: false; error: string };

function sanitizeError(raw: string, token: string): string {
  const redacted = token ? raw.split(token).join("[token]") : raw;
  return redacted.slice(0, ERROR_MAX_LEN);
}

export async function postToTelegram(
  cfg: TelegramConfig,
  input: TelegramSendInput,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramSendResult> {
  const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: input.text,
        link_preview_options: {
          url: input.url,
          prefer_large_media: true,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: sanitizeError(`HTTP ${res.status}`, cfg.token) };
    }

    const parsed = body as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: string;
    };

    if (!res.ok || parsed.ok !== true) {
      const message = parsed.description ?? `HTTP ${res.status}`;
      return { ok: false, error: sanitizeError(message, cfg.token) };
    }

    const messageId = parsed.result?.message_id;
    if (messageId === undefined) {
      return { ok: false, error: sanitizeError("missing message_id", cfg.token) };
    }

    return { ok: true, externalId: String(messageId) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: sanitizeError(message, cfg.token) };
  }
}
