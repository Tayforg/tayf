import { describe, it, expect, vi } from "vitest";

import {
  DISABLE_AFTER_FAILS,
  MAX_ATTEMPTS,
  classify,
  nextAttemptAt,
  postWebhook,
  type WebhookTransport,
} from "@/lib/alerts/webhook-deliver";

describe("classify", () => {
  it.each([
    [200, "ok"],
    [201, "ok"],
    [204, "ok"],
    [299, "ok"],
    [500, "retry"],
    [502, "retry"],
    [503, "retry"],
    [408, "retry"],
    [429, "retry"],
    [301, "fail"],
    [302, "fail"],
    [307, "fail"],
    [400, "fail"],
    [401, "fail"],
    [403, "fail"],
    [404, "fail"],
    [410, "fail"],
    [100, "fail"],
  ] as const)("status %s -> %s", (status, expected) => {
    expect(classify(status)).toBe(expected);
  });

  it("classifies transport errors", () => {
    expect(classify({ error: "timeout" })).toBe("retry");
    expect(classify({ error: "network" })).toBe("retry");
    expect(classify({ error: "blocked" })).toBe("fail");
  });
});

describe("nextAttemptAt", () => {
  const now = 1_000_000;
  it("backs off 1, 5, 15, 60 minutes and gives up at MAX_ATTEMPTS", () => {
    expect(nextAttemptAt(1, now)).toBe(now + 60_000);
    expect(nextAttemptAt(2, now)).toBe(now + 5 * 60_000);
    expect(nextAttemptAt(3, now)).toBe(now + 15 * 60_000);
    expect(nextAttemptAt(4, now)).toBe(now + 60 * 60_000);
    expect(nextAttemptAt(MAX_ATTEMPTS, now)).toBeNull();
    expect(nextAttemptAt(MAX_ATTEMPTS + 3, now)).toBeNull();
  });

  it("treats attempts below 1 as the first step", () => {
    expect(nextAttemptAt(0, now)).toBe(now + 60_000);
  });

  it("pins the constants", () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect(DISABLE_AFTER_FAILS).toBe(20);
  });
});

describe("postWebhook", () => {
  const url = "https://hooks.example.com/x";
  const headers = { "Content-Type": "application/json" };

  it("returns the status from the transport, called exactly once", async () => {
    const transport = vi.fn<WebhookTransport>(async () => ({ status: 204 }));
    const r = await postWebhook(url, "{}", headers, { transport });
    expect(r).toEqual({ status: 204 });
    expect(transport).toHaveBeenCalledTimes(1);
    const [u, init] = transport.mock.calls[0]!;
    expect(u.toString()).toBe(url);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
  });

  it("does not follow a 302: one call, classified fail", async () => {
    const transport = vi.fn<WebhookTransport>(async () => ({ status: 302 }));
    const r = await postWebhook(url, "{}", headers, { transport });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ status: 302 });
    expect(classify(r)).toBe("fail");
  });

  it("turns a hanging transport into a timeout (retry)", async () => {
    const transport: WebhookTransport = (_u, init) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener("abort", () => rej(new Error("aborted")));
      });
    const r = await postWebhook(url, "{}", headers, { transport, timeoutMs: 20 });
    expect(r).toEqual({ error: "timeout" });
    expect(classify(r)).toBe("retry");
  });

  it("maps a blocked-address error to blocked (fail) and others to network (retry)", async () => {
    const blocked = Object.assign(new Error("blocked"), { code: "ETAYFBLOCKED" });
    const r1 = await postWebhook(url, "{}", headers, {
      transport: async () => {
        throw blocked;
      },
    });
    expect(r1).toEqual({ error: "blocked" });
    const r2 = await postWebhook(url, "{}", headers, {
      transport: async () => {
        throw Object.assign(new Error("boom"), { code: "ECONNRESET" });
      },
    });
    expect(r2).toEqual({ error: "network" });
  });

  it("refuses a non-https url without calling the transport", async () => {
    const transport = vi.fn<WebhookTransport>(async () => ({ status: 200 }));
    const r = await postWebhook("http://hooks.example.com/x", "{}", headers, { transport });
    expect(r).toEqual({ error: "blocked" });
    expect(transport).not.toHaveBeenCalled();
  });
});
