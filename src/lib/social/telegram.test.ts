import { describe, it, expect, vi } from "vitest";
import { postToTelegram } from "./telegram";
import type { TelegramConfig } from "./config";

const cfg: TelegramConfig = { token: "SECRET-TOKEN-123", chatId: "-1001234" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("postToTelegram", () => {
  it("posts the exact URL and body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, result: { message_id: 42 } }),
    );

    await postToTelegram(cfg, { text: "merhaba", url: "https://tayfhaber.com/cluster/1" }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${cfg.token}/sendMessage`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      chat_id: cfg.chatId,
      text: "merhaba",
      link_preview_options: {
        url: "https://tayfhaber.com/cluster/1",
        prefer_large_media: true,
      },
    });
  });

  it("returns {ok:true, externalId} on success", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, result: { message_id: 42 } }),
    );
    const res = await postToTelegram(cfg, { text: "x", url: "https://x" }, fetchImpl);
    expect(res).toEqual({ ok: true, externalId: "42" });
  });

  it("returns {ok:false} on ok:false response, without leaking the token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, description: `chat not found for ${cfg.token}` }, 400),
    );
    const res = await postToTelegram(cfg, { text: "x", url: "https://x" }, fetchImpl);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain(cfg.token);
      expect(res.error).toContain("[token]");
      expect(res.error.length).toBeLessThanOrEqual(300);
    }
  });

  it("returns {ok:false} on a non-2xx HTTP response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    const res = await postToTelegram(cfg, { text: "x", url: "https://x" }, fetchImpl);
    expect(res.ok).toBe(false);
  });

  it("handles a timeout/network error without leaking the token", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`network failure hitting bot${cfg.token}`);
    });
    const res = await postToTelegram(cfg, { text: "x", url: "https://x" }, fetchImpl);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain(cfg.token);
    }
  });

  it("never returns or logs the request URL", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, description: "boom" }, 400),
    );
    const res = await postToTelegram(cfg, { text: "x", url: "https://x" }, fetchImpl);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain("api.telegram.org");
    }
  });
});
