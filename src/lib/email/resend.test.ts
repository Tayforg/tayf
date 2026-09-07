import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendEmail, sendBatch } from "./resend";

const ORIGINAL_ENV = { ...process.env };
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const k of ["RESEND_API_KEY", "NEWSLETTER_FROM"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  globalThis.fetch = originalFetch;
});

const INPUT = { to: "reader@example.com", subject: "Merhaba", html: "<p>hi</p>" };

describe("sendEmail", () => {
  it("is skipped without RESEND_API_KEY, and warns exactly once", async () => {
    delete process.env.RESEND_API_KEY;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const first = await sendEmail(INPUT);
    const second = await sendEmail(INPUT);

    expect(first).toEqual({ skipped: true });
    expect(second).toEqual({ skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    // Warns once per process, not once per call.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("posts to Resend with the API key and default from address", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    delete process.env.NEWSLETTER_FROM;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "email_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await sendEmail(INPUT);

    expect(result).toEqual({ ok: true, id: "email_123" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer re_test_key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({
      from: "Tayf <bulten@tayfhaber.com>",
      to: INPUT.to,
      subject: INPUT.subject,
      html: INPUT.html,
    });
    expect(body.text).toBeUndefined();
  });

  it("uses NEWSLETTER_FROM when set, and includes text when provided", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.NEWSLETTER_FROM = "Custom <custom@example.com>";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "email_456" }), { status: 200 }),
    );

    await sendEmail({ ...INPUT, text: "hi" });

    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(init?.body as string);
    expect(body.from).toBe("Custom <custom@example.com>");
    expect(body.text).toBe("hi");
  });

  it("returns ok:false without throwing on a non-2xx response", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad request", { status: 422 }),
    );

    const result = await sendEmail(INPUT);
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error("expected ok:false");
    expect(result.error).toContain("422");
  });

  it("returns ok:false without throwing when fetch itself rejects", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    const result = await sendEmail(INPUT);
    expect(result).toEqual({ ok: false, error: "network down" });
  });
});

describe("sendBatch", () => {
  it("sends every item and resolves in order with bounded concurrency", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    });

    const list = Array.from({ length: 12 }, (_, i) => ({
      to: `reader${i}@example.com`,
      subject: "s",
      html: "<p>h</p>",
    }));

    const results = await sendBatch(list, 5);

    expect(results).toHaveLength(12);
    expect(results.every((r) => r.ok === true)).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });

  it("never throws when RESEND_API_KEY is unset — every item is skipped", async () => {
    delete process.env.RESEND_API_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const results = await sendBatch([INPUT, INPUT], 5);
    expect(results).toEqual([{ skipped: true }, { skipped: true }]);
  });
});
