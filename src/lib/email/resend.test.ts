import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// resend.ts keeps a module-level `warnedMissingKey` flag ("warn once per
// process"). A static import would share it across tests, so "warns exactly
// once" passed or failed depending on whether an earlier test had already
// triggered the warning (vitest --sequence.shuffle). Every test gets a fresh
// module instance instead; the names below are re-bound in beforeEach.
let sendEmail: typeof import("./resend").sendEmail;
let sendBatch: typeof import("./resend").sendBatch;
let isMailConfigured: typeof import("./resend").isMailConfigured;
let setSleep: typeof import("./resend").__setResendSleepForTests;

const ORIGINAL_ENV = { ...process.env };
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  ({
    sendEmail,
    sendBatch,
    isMailConfigured,
    __setResendSleepForTests: setSleep,
  } = await import("./resend"));
});

afterEach(() => {
  for (const k of ["RESEND_API_KEY", "NEWSLETTER_FROM"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

const INPUT = { to: "reader@example.com", subject: "Merhaba", html: "<p>hi</p>" };

describe("isMailConfigured", () => {
  it("is false when RESEND_API_KEY is unset", () => {
    delete process.env.RESEND_API_KEY;
    expect(isMailConfigured()).toBe(false);
  });

  it("is false when RESEND_API_KEY is an empty string", () => {
    process.env.RESEND_API_KEY = "";
    expect(isMailConfigured()).toBe(false);
  });

  it("is true when RESEND_API_KEY is set", () => {
    process.env.RESEND_API_KEY = "re_test_key";
    expect(isMailConfigured()).toBe(true);
  });
});

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

  it("puts sanitized headers in the JSON body when provided", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "email_789" }), { status: 200 }),
    );

    await sendEmail({
      ...INPUT,
      headers: {
        "List-Unsubscribe": "<https://x/u?token=t\r\ninjected: evil>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(init?.body as string);
    expect(body.headers).toEqual({
      "List-Unsubscribe": "<https://x/u?token=t injected: evil>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("omits the headers key entirely when no headers are provided", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "email_790" }), { status: 200 }),
    );

    await sendEmail(INPUT);

    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(init?.body as string);
    expect("headers" in body).toBe(false);
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

    // minIntervalMs 0: this case is about the concurrency bound; pacing has its own describe below.
    const results = await sendBatch(list, 5, { minIntervalMs: 0 });

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

// ---------------------------------------------------------------------------
// h87-newsletter-2: Resend's documented default is 2 requests per second per
// team, and it answers an excess with 429 + Retry-After. A 429 used to be a
// failed send that waited a week; it is now retried a bounded number of times,
// and sendBatch spaces its starts so the retries are the exception.
// ---------------------------------------------------------------------------

function ok200(id = "email_ok"): Response {
  return new Response(JSON.stringify({ id }), { status: 200 });
}

function rateLimited(retryAfter?: string): Response {
  return new Response("rate_limit_exceeded", {
    status: 429,
    headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
  });
}

describe("sendEmail 429 handling (h87-newsletter-2)", () => {
  let sleeps: number[];

  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
    sleeps = [];
    setSleep(async (ms) => {
      sleeps.push(ms);
    });
  });

  it("retries a 429 once after the Retry-After seconds, and reports the send that then succeeds", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(rateLimited("2"))
      .mockResolvedValueOnce(ok200("email_retry"));

    const result = await sendEmail(INPUT);

    expect(result).toEqual({ ok: true, id: "email_retry" });
    expect(sleeps).toEqual([2000]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("resends the same message on the retry, List-Unsubscribe headers included", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(rateLimited("1"))
      .mockResolvedValueOnce(ok200());
    const input = {
      ...INPUT,
      headers: {
        "List-Unsubscribe": "<https://x/u?token=t>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    };

    await sendEmail(input);

    const [first, second] = fetchSpy.mock.calls.map(([, init]) => JSON.parse(init?.body as string));
    expect(second).toEqual(first);
    expect(second.headers).toEqual(input.headers);
    expect(second.to).toBe(INPUT.to);
  });

  it("sleeps 1000 ms when Retry-After is missing", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(ok200());

    expect((await sendEmail(INPUT)).ok).toBe(true);
    expect(sleeps).toEqual([1000]);
  });

  it.each(["soon", "", "   ", "-4", "NaN", "Wed, 21 Oct 2026 07:28:00 GMT", "1e3", "2 seconds"])(
    "sleeps 1000 ms when Retry-After is unparseable (%j)",
    async (header) => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(rateLimited(header))
        .mockResolvedValueOnce(ok200());

      expect((await sendEmail(INPUT)).ok).toBe(true);
      expect(sleeps).toEqual([1000]);
    },
  );

  it.each([
    ["0", 500],
    ["0.2", 500],
    ["0.5", 500],
    ["1.5", 1500],
    ["9", 9000],
    ["10", 10_000],
    ["11", 10_000],
    ["3600", 10_000],
  ])("clamps Retry-After %s s to %i ms (500-10000)", async (header, expectedMs) => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(rateLimited(header))
      .mockResolvedValueOnce(ok200());

    expect((await sendEmail(INPUT)).ok).toBe(true);
    expect(sleeps).toEqual([expectedMs]);
  });

  it("retries at most twice: three 429s in a row end as ok:false with 'Resend 429' in the error", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => rateLimited("1"));

    const result = await sendEmail(INPUT);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 1000]);
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error("expected ok:false");
    expect(result.error).toContain("Resend 429");
  });

  it("succeeds on the second retry (429, 429, 200) after two sleeps", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(rateLimited("1"))
      .mockResolvedValueOnce(rateLimited("3"))
      .mockResolvedValueOnce(ok200("third_time"));

    expect(await sendEmail(INPUT)).toEqual({ ok: true, id: "third_time" });
    expect(sleeps).toEqual([1000, 3000]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 403, 422, 500, 503])("never retries a %i", async (status) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("nope", { status, headers: { "Retry-After": "2" } }));

    const result = await sendEmail(INPUT);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error("expected ok:false");
    expect(result.error).toContain(String(status));
  });

  it("never retries a network failure, and still never throws", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    expect(await sendEmail(INPUT)).toEqual({ ok: false, error: "network down" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("reports ok:false, not a throw, when the retry itself fails on the network", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(rateLimited("1"))
      .mockRejectedValueOnce(new Error("reset by peer"));

    expect(await sendEmail(INPUT)).toEqual({ ok: false, error: "reset by peer" });
    expect(sleeps).toEqual([1000]);
  });

  it("does not sleep or call Resend at all without an API key", async () => {
    delete process.env.RESEND_API_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(await sendEmail(INPUT)).toEqual({ skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
  });
});

describe("sendBatch pacing (h87-newsletter-2)", () => {
  const MIN_GAP = 500;

  function items(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      to: `reader${i}@example.com`,
      subject: "s",
      html: "<p>h</p>",
    }));
  }

  /** Fake clock + a fetch that records when each request starts (ms since the run began). */
  function recordStarts(
    respond: (to: string, attempt: number) => Response | Promise<Response> = () => ok200(),
  ) {
    vi.useFakeTimers();
    const t0 = Date.now();
    const starts: Array<{ to: string; at: number }> = [];
    const attempts = new Map<string, number>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const to = (JSON.parse(init?.body as string) as { to: string }).to;
      starts.push({ to, at: Date.now() - t0 });
      const attempt = (attempts.get(to) ?? 0) + 1;
      attempts.set(to, attempt);
      return respond(to, attempt);
    });
    return { starts };
  }

  async function runBatch(...args: Parameters<typeof sendBatch>) {
    const pending = sendBatch(...args);
    await vi.runAllTimersAsync();
    return pending;
  }

  function gaps(starts: Array<{ at: number }>): number[] {
    const times = starts.map((s) => s.at).sort((a, b) => a - b);
    return times.slice(1).map((t, i) => t - times[i]!);
  }

  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
  });

  it("starts no two sends less than 500 ms apart with 5 workers over 5 items: 0, 500, 1000, 1500, 2000", async () => {
    const { starts } = recordStarts();

    const results = await runBatch(items(5), 5);

    expect(results.every((r) => r.ok === true)).toBe(true);
    expect(starts.map((s) => s.at)).toEqual([0, 500, 1000, 1500, 2000]);
  });

  it.each([1, 2, 5, 20])("keeps every gap at 500 ms or more whatever the concurrency (%i)", async (concurrency) => {
    const { starts } = recordStarts();

    await runBatch(items(8), concurrency);

    expect(starts).toHaveLength(8);
    expect(Math.min(...gaps(starts))).toBeGreaterThanOrEqual(MIN_GAP);
  });

  it("honours minIntervalMs: 1000 gives one send a second", async () => {
    const { starts } = recordStarts();

    await runBatch(items(4), 5, { minIntervalMs: 1000 });

    expect(starts.map((s) => s.at)).toEqual([0, 1000, 2000, 3000]);
  });

  it("minIntervalMs: 0 switches pacing off (every send starts at once, up to the concurrency)", async () => {
    const { starts } = recordStarts();

    await runBatch(items(4), 4, { minIntervalMs: 0 });

    expect(starts.map((s) => s.at)).toEqual([0, 0, 0, 0]);
  });

  it.each([-5, Number.NaN, Number.POSITIVE_INFINITY])(
    "treats a nonsense minIntervalMs (%s) as no pacing, never as an endless wait",
    async (minIntervalMs) => {
      const { starts } = recordStarts();

      const results = await runBatch(items(3), 3, { minIntervalMs });

      expect(results.every((r) => r.ok === true)).toBe(true);
      expect(starts.map((s) => s.at)).toEqual([0, 0, 0]);
    },
  );

  it("paces across consecutive sendBatch calls too (the digest sends in chunks)", async () => {
    const { starts } = recordStarts();

    await runBatch(items(2), 5);
    await runBatch(items(2), 5);

    expect(starts.map((s) => s.at)).toEqual([0, 500, 1000, 1500]);
  });

  it("paces the retry of a 429 like any other start", async () => {
    // 'reader0' is rate limited once, with a 1 s Retry-After; its retry must not
    // land within 500 ms of the sends other workers are starting meanwhile.
    const { starts } = recordStarts((to, attempt) =>
      to === "reader0@example.com" && attempt === 1 ? rateLimited("1") : ok200(to),
    );

    const results = await runBatch(items(4), 4);

    expect(results.every((r) => r.ok === true)).toBe(true);
    expect(starts).toHaveLength(5);
    expect(Math.min(...gaps(starts))).toBeGreaterThanOrEqual(MIN_GAP);
  });

  it("keeps results in input order, and one failure never aborts the rest", async () => {
    recordStarts((to) =>
      to === "reader2@example.com" ? new Response("bad", { status: 422 }) : ok200(to),
    );

    const results = await runBatch(items(5), 3);

    expect(results).toHaveLength(5);
    expect(results.map((r) => ("ok" in r && r.ok ? r.id : null))).toEqual([
      "reader0@example.com",
      "reader1@example.com",
      null,
      "reader3@example.com",
      "reader4@example.com",
    ]);
    const failed = results[2]!;
    if (!("ok" in failed) || failed.ok !== false) throw new Error("expected ok:false at index 2");
    expect(failed.error).toContain("422");
  });

  it("a send that stays rate limited (three 429s) is that item's ok:false and the others still go out", async () => {
    recordStarts((to) => (to === "reader1@example.com" ? rateLimited("1") : ok200(to)));

    const results = await runBatch(items(3), 3);

    expect(results.map((r) => ("ok" in r ? r.ok : null))).toEqual([true, false, true]);
    const failed = results[1]!;
    if (!("ok" in failed) || failed.ok !== false) throw new Error("expected ok:false at index 1");
    expect(failed.error).toContain("Resend 429");
  });

  it("an empty list resolves at once and sleeps for nothing", async () => {
    const sleeps: number[] = [];
    setSleep(async (ms) => {
      sleeps.push(ms);
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(await sendBatch([], 5)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
  });

  it("does not pace (or sleep) when RESEND_API_KEY is unset: every item is skipped at once", async () => {
    delete process.env.RESEND_API_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sleeps: number[] = [];
    setSleep(async (ms) => {
      sleeps.push(ms);
    });

    expect(await sendBatch(items(3), 5)).toEqual([{ skipped: true }, { skipped: true }, { skipped: true }]);
    expect(sleeps).toEqual([]);
  });

  // SEC-digest-double-send-1: a chunk's length has no bound of its own (pacing + 429
  // sleeps + a hung fetch), so the digest route cannot rely on checking its clock
  // between chunks. sendBatch gets a hard deadline: past it nothing new starts, an
  // item it never attempted is `{ deferred: true }` (nothing was sent), and every
  // finished item is reported at once through onResult so the caller can stamp it.
  describe("deadline, per-item results and the fetch timeout (SEC-digest-double-send-1)", () => {
    it("(a) starts no send at or after deadlineAt: 25 items, 5 workers, 2 s left -> starts at 0/500/1000/1500, the other 21 are deferred", async () => {
      const { starts } = recordStarts();

      const results = await runBatch(items(25), 5, { deadlineAt: Date.now() + 2_000 });

      expect(starts.map((s) => s.at)).toEqual([0, 500, 1000, 1500]);
      expect(results).toHaveLength(25);
      expect(results.slice(0, 4).every((r) => "ok" in r && r.ok === true)).toBe(true);
      expect(results.slice(4)).toEqual(Array.from({ length: 21 }, () => ({ deferred: true })));
    });

    it("defers every item at once when the deadline has already passed: no fetch, no sleep", async () => {
      const { starts } = recordStarts();
      const sleeps: number[] = [];
      setSleep(async (ms) => {
        sleeps.push(ms);
      });

      const results = await runBatch(items(6), 5, { deadlineAt: Date.now() - 1 });

      expect(starts).toEqual([]);
      expect(sleeps).toEqual([]);
      expect(results).toEqual(Array.from({ length: 6 }, () => ({ deferred: true })));
    });

    it("a deferred item reserves no slot, so the next batch is not pushed back by it", async () => {
      const { starts } = recordStarts();

      await runBatch(items(25), 5, { deadlineAt: Date.now() + 2_000 });
      expect(starts.map((s) => s.at)).toEqual([0, 500, 1000, 1500]);

      // The four sends left nextStartAt at 2000; the 21 deferred items did not move it
      // (each one reserving 500 ms would have pushed this send to 12500).
      await runBatch(items(1), 1);
      expect(starts.at(-1)!.at).toBe(2_000);
    });

    it("does not touch the deadline logic when no deadlineAt is given (every item is sent)", async () => {
      const { starts } = recordStarts();

      const results = await runBatch(items(25), 5);

      expect(starts).toHaveLength(25);
      expect(results.every((r) => "ok" in r && r.ok === true)).toBe(true);
    });

    it("(b) a 429 whose Retry-After would end past the deadline is not slept on: one fetch, no 10 s sleep, ok:false", async () => {
      const { starts } = recordStarts(() => rateLimited("10"));
      const sleeps: number[] = [];
      setSleep(async (ms) => {
        sleeps.push(ms);
      });

      const results = await runBatch(items(1), 1, { deadlineAt: Date.now() + 3_000 });

      expect(starts).toHaveLength(1);
      expect(sleeps).toEqual([]);
      const only = results[0]!;
      if (!("ok" in only) || only.ok !== false) throw new Error("expected ok:false");
      expect(only.error).toContain("Resend 429");
    });

    it("a 429 whose Retry-After still fits before the deadline is retried as before", async () => {
      const { starts } = recordStarts((_to, attempt) => (attempt === 1 ? rateLimited("1") : ok200("after_retry")));

      const results = await runBatch(items(1), 1, { deadlineAt: Date.now() + 3_000 });

      expect(starts.map((s) => s.at)).toEqual([0, 1000]);
      expect(results).toEqual([{ ok: true, id: "after_retry" }]);
    });

    it("a 429 retry that finds no start slot left before the deadline returns the last Resend 429, not deferred (the first send was attempted)", async () => {
      // reader0 is rate limited and would retry at 500; but the slots at 500 (reader1) and
      // 1000 (the deadline) are taken or out of budget by then.
      const { starts } = recordStarts((to, attempt) =>
        to === "reader0@example.com" && attempt === 1 ? rateLimited("0.5") : ok200(to),
      );

      const results = await runBatch(items(3), 3, { deadlineAt: Date.now() + 1_000 });

      expect(starts.map((s) => s.at)).toEqual([0, 500]);
      const first = results[0]!;
      if (!("ok" in first) || first.ok !== false) throw new Error("expected ok:false at index 0");
      expect(first.error).toContain("Resend 429");
      expect(results[1]).toEqual({ ok: true, id: "reader1@example.com" });
      expect(results[2]).toEqual({ deferred: true });
    });

    it("(c) reports each finished item through onResult at once, before the batch resolves and while another fetch is still pending", async () => {
      vi.useFakeTimers();
      let releaseSecond!: (r: Response) => void;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const to = (JSON.parse(init?.body as string) as { to: string }).to;
        if (to === "reader1@example.com") return new Promise<Response>((resolve) => (releaseSecond = resolve));
        return ok200(to);
      });
      const onResult = vi.fn();

      let settled = false;
      const pending = sendBatch(items(2), 2, { minIntervalMs: 0, onResult }).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(onResult).toHaveBeenCalledTimes(1);
      expect(onResult).toHaveBeenCalledWith(0, { ok: true, id: "reader0@example.com" });
      expect(settled).toBe(false);

      releaseSecond(ok200("reader1@example.com"));
      const results = await pending;

      expect(onResult).toHaveBeenCalledTimes(2);
      expect(onResult).toHaveBeenLastCalledWith(1, { ok: true, id: "reader1@example.com" });
      expect(results).toEqual([
        { ok: true, id: "reader0@example.com" },
        { ok: true, id: "reader1@example.com" },
      ]);
    });

    it("an onResult that throws or rejects never aborts the batch", async () => {
      recordStarts();
      const onResult = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("sync boom");
        })
        .mockImplementationOnce(async () => {
          throw new Error("async boom");
        });

      const results = await runBatch(items(3), 2, { onResult });

      expect(onResult).toHaveBeenCalledTimes(3);
      expect(results.every((r) => "ok" in r && r.ok === true)).toBe(true);
    });

    it("an awaited onResult holds its worker, so the caller's stamp finishes before that worker takes the next item", async () => {
      recordStarts();
      const order: string[] = [];
      const onResult = vi.fn(async (i: number) => {
        order.push(`result${i}:start`);
        await new Promise((r) => setTimeout(r, 100));
        order.push(`result${i}:end`);
      });

      await runBatch(items(2), 1, { minIntervalMs: 0, onResult });

      expect(order).toEqual(["result0:start", "result0:end", "result1:start", "result1:end"]);
    });

    it("(d) aborts a fetch that never answers after 8 s and reports ok:false", async () => {
      vi.useFakeTimers();
      const t0 = Date.now();
      // AbortSignal.timeout runs on Node's own timer, which fake timers do not move; the
      // stand-in aborts on the (fake) clock after the same number of ms, so the 8 s is exact.
      const timeoutMs: number[] = [];
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
        timeoutMs.push(ms);
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
        return controller.signal;
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      );

      let settled = false;
      const pending = sendBatch(items(1), 1).then((r) => {
        settled = true;
        return r;
      });
      await vi.runAllTimersAsync();

      expect(settled).toBe(true);
      expect(timeoutMs).toEqual([8_000]);
      expect(Date.now() - t0).toBe(8_000);
      const only = (await pending)[0]!;
      if (!("ok" in only) || only.ok !== false) throw new Error("expected ok:false");
      expect(only.error).toContain("timed out");
    });

    it("sendEmail too passes the 8 s timeout signal to fetch", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok200());

      await sendEmail(INPUT);

      const [, init] = fetchSpy.mock.calls[0]!;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
  });
});
