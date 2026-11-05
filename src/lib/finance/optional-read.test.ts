import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { optionalRead } from "./optional-read";

// h41-resilience-3: /ekonomi and /ekonomi/[ticker] used to fall to the error
// page when ANY read failed, decorative ones (circuit breakers, quote stats,
// reference prices, intraday bars) included. optionalRead is the one place that
// turns a decorative read's failure into a fallback value plus a `failed` flag.

describe("optionalRead", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a fulfilled read passes its value through with failed false and logs nothing", async () => {
    const rows = [{ id: 1 }];
    await expect(optionalRead("circuit-breakers", Promise.resolve(rows), [])).resolves.toEqual({
      value: rows,
      failed: false,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("a rejected read resolves to the fallback with failed true and warns exactly once", async () => {
    const fallback: Record<string, number> = {};
    const result = await optionalRead("quote-stats", Promise.reject(new Error("statement timeout")), fallback);

    expect(result).toEqual({ value: {}, failed: true });
    expect(result.value).toBe(fallback);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[ekonomi] optional read failed: quote-stats");
  });

  it("the warning carries the read's name only: no error text, no data", async () => {
    await optionalRead(
      "reference-prices",
      Promise.reject(new Error("db password=hunter2 ticker=THYAO")),
      {} as Record<string, number>,
    );

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("reference-prices");
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("THYAO");
    expect(warn.mock.calls[0]).toHaveLength(1);
  });

  it.each([
    ["a string", "boom"],
    ["undefined", undefined],
    ["null", null],
    ["a plain object", { code: "57014" }],
  ])("never rejects, whatever the rejection reason (%s)", async (_label, reason) => {
    const result = await optionalRead("intraday", Promise.reject(reason), { day: null, bars: [] });
    expect(result).toEqual({ value: { day: null, bars: [] }, failed: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an empty array", []],
    ["zero", 0],
    ["an empty string", ""],
    ["null", null],
  ])("a legitimately empty value (%s) is a success, not a failure", async (_label, value) => {
    const result = await optionalRead("x", Promise.resolve(value), "fallback" as unknown);
    expect(result).toEqual({ value, failed: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not report a failure for a read that is still pending, and settles when it does", async () => {
    let resolve!: (v: string) => void;
    const pending = new Promise<string>((r) => {
      resolve = r;
    });
    const result = optionalRead("slow", pending, "fallback");
    resolve("late");
    await expect(result).resolves.toEqual({ value: "late", failed: false });
  });

  it("keeps concurrent reads independent: one failing leaves the other's value alone", async () => {
    const [a, b] = await Promise.all([
      optionalRead("a", Promise.reject(new Error("x")), [] as number[]),
      optionalRead("b", Promise.resolve([1, 2]), [] as number[]),
    ]);
    expect(a).toEqual({ value: [], failed: true });
    expect(b).toEqual({ value: [1, 2], failed: false });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a Next control-flow signal (notFound/redirect) is not swallowed and is not logged as a failed read", async () => {
    // The same digest next/navigation's notFound() throws.
    const signal = Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    await expect(optionalRead("x", Promise.reject(signal), [])).rejects.toBe(signal);
    expect(warn).not.toHaveBeenCalled();
  });
});
