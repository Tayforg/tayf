import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Pack JEV, W3. Mirrors src/lib/admin/archive-status.test.ts: the shared
// chainable Supabase fake (tests/_helpers/supabase-fake.ts) plus its `rpc`
// fixture map, since getJevShadowStatus is built on four RPCs
// (jev_shadow_agreement x2, jev_shadow_month_usage, jev_shadow_queue) and
// one `jev_shadow_runs` table read. No next/cache mock here —
// getJevShadowStatus is a plain async fetcher on purpose (the /admin page
// is cookie-gated and dynamic, so it must never be "use cache").

const fixture = vi.hoisted(() => ({
  agreement24h: [] as unknown[],
  agreement7d: [] as unknown[],
  monthUsage: [
    { runs: 12, calls: 340, input_tokens: 1_500_000, cap: 300_000_000, exceeded: false },
  ] as unknown[],
  queue: [] as unknown[],
  lastRun: [] as unknown[],
  agreementError: null as { message: string } | null,
  monthError: null as { message: string } | null,
  queueError: null as { message: string } | null,
  runsError: null as { message: string } | null,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      jev_shadow_runs: () => {
        if (fixture.runsError) return { data: null, error: fixture.runsError };
        return { data: fixture.lastRun, error: null };
      },
    },
    rpc: {
      jev_shadow_agreement: (args) => {
        if (fixture.agreementError) return { data: null, error: fixture.agreementError };
        const hours = (args as { p_hours: number } | undefined)?.p_hours;
        return { data: hours === 24 ? fixture.agreement24h : fixture.agreement7d, error: null };
      },
      jev_shadow_month_usage: () => {
        if (fixture.monthError) return { data: null, error: fixture.monthError };
        return { data: fixture.monthUsage, error: null };
      },
      jev_shadow_queue: () => {
        if (fixture.queueError) return { data: null, error: fixture.queueError };
        return { data: fixture.queue, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { getJevShadowStatus, JEV_QUEUE_LIMIT } from "./jev-shadow-status";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.agreement24h = [];
  fixture.agreement7d = [];
  fixture.monthUsage = [
    { runs: 12, calls: 340, input_tokens: 1_500_000, cap: 300_000_000, exceeded: false },
  ];
  fixture.queue = [];
  fixture.lastRun = [];
  fixture.agreementError = null;
  fixture.monthError = null;
  fixture.queueError = null;
  fixture.runsError = null;
  supabaseFake.calls.rpc.length = 0;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("getJevShadowStatus", () => {
  it("happy path: computes agreement rate and usd/pct math from the raw RPC rows", async () => {
    fixture.agreement24h = [
      { task: "politics", total: 80, agreed: 60, undecided: 5 },
    ];
    fixture.agreement7d = [
      { task: "politics", total: 500, agreed: 400, undecided: 20 },
    ];
    fixture.monthUsage = [
      { runs: 4, calls: 200, input_tokens: 1_000_000, cap: 300_000_000, exceeded: false },
    ];

    const result = await getJevShadowStatus();

    expect(result).not.toBeNull();
    expect(result!.agreement24h).toEqual([
      { task: "politics", total: 80, agreed: 60, undecided: 5, rate: 60 / 80 },
    ]);
    expect(result!.agreement7d).toEqual([
      { task: "politics", total: 500, agreed: 400, undecided: 20, rate: 400 / 500 },
    ]);
    expect(result!.month.runs).toBe(4);
    expect(result!.month.calls).toBe(200);
    expect(result!.month.inputTokens).toBe(1_000_000);
    expect(result!.month.cap).toBe(300_000_000);
    // usd = inputTokens * 42 / 1e9
    expect(result!.month.usd).toBeCloseTo((1_000_000 * 42) / 1_000_000_000, 10);
    // pct = round(inputTokens / cap * 100)
    expect(result!.month.pct).toBe(Math.round((1_000_000 / 300_000_000) * 100));
    expect(result!.month.exceeded).toBe(false);
  });

  it("total = 0 -> rate is null, not NaN", async () => {
    fixture.agreement24h = [{ task: "topic", total: 0, agreed: 0, undecided: 12 }];

    const result = await getJevShadowStatus();

    expect(result!.agreement24h).toEqual([
      { task: "topic", total: 0, agreed: 0, undecided: 12, rate: null },
    ]);
  });

  it("missing month row -> zeros, not null", async () => {
    fixture.monthUsage = [];

    const result = await getJevShadowStatus();

    expect(result).not.toBeNull();
    expect(result!.month).toEqual({
      runs: 0,
      calls: 0,
      inputTokens: 0,
      usd: 0,
      cap: 0,
      pct: 0,
      exceeded: false,
    });
  });

  it("an RPC error -> null, and logs exactly one PII-free [admin] line", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.monthError = { message: "relation \"jev_shadow_runs\" does not exist" };

    const result = await getJevShadowStatus();

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[admin] jev shadow status unavailable: "),
    );

    errorSpy.mockRestore();
  });

  it("missing env vars -> null, never throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getJevShadowStatus()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("pins the query shape: jev_shadow_agreement called with p_hours 24 and 168, jev_shadow_queue with p_limit 30", async () => {
    await getJevShadowStatus();

    const rpcCalls = supabaseFake.calls.rpc;

    expect(
      rpcCalls.some(
        (c) => c.name === "jev_shadow_agreement" && (c.args as { p_hours: number }).p_hours === 24,
      ),
    ).toBe(true);
    expect(
      rpcCalls.some(
        (c) => c.name === "jev_shadow_agreement" && (c.args as { p_hours: number }).p_hours === 168,
      ),
    ).toBe(true);
    expect(
      rpcCalls.some(
        (c) =>
          c.name === "jev_shadow_queue" &&
          (c.args as { p_limit: number }).p_limit === JEV_QUEUE_LIMIT,
      ),
    ).toBe(true);
    expect(rpcCalls.some((c) => c.name === "jev_shadow_month_usage")).toBe(true);
    expect(JEV_QUEUE_LIMIT).toBe(30);
  });
});
