import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Pack "Sinyaller" (migration 065), W3. Modelled line for line on
// src/lib/admin/jev-gold.test.ts / jev-shadow-status.test.ts: the shared
// chainable Supabase fake (tests/_helpers/supabase-fake.ts) with
// function-shaped per-table fixtures so the test can introspect the
// recorded BuilderState (eq/gte/is/order/limit), plus the
// NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY beforeEach/afterEach
// dance. No next/cache mock here -- getJevSignalsStatus is a plain async
// fetcher on purpose (/admin is cookie-gated and dynamic, never "use cache").

const fixture = vi.hoisted(() => ({
  drift: [
    {
      source_id: "11111111-1111-1111-1111-111111111111",
      day: "2026-09-20",
      n: 42,
      politics_share: 0.6,
      drift_score: 3.25,
      baseline: { politics_share: 0.4 },
      source: { slug: "kaynak-a", name: "Kaynak A" },
    },
  ] as unknown[],
  alerts: [
    {
      id: 1,
      kind: "source_drift",
      day: "2026-09-20",
      subject: "11111111-1111-1111-1111-111111111111",
      payload: { source_slug: "kaynak-a" },
      created_at: "2026-09-20T04:05:00.000Z",
    },
  ] as unknown[],
  driftError: null as { message: string } | null,
  alertsError: null as { message: string } | null,
  driftState: null as unknown,
  alertsState: null as unknown,
  // undefined -> derive from fixture.alerts.length (the common case); set to
  // a number or null to exercise getJevSignalsStatus's alertsTotal fallback.
  alertsCount: undefined as number | null | undefined,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      source_drift_daily: (state) => {
        fixture.driftState = state;
        if (fixture.driftError) return { data: null, error: fixture.driftError };
        return { data: fixture.drift, error: null };
      },
      jev_alerts: (state) => {
        fixture.alertsState = state;
        if (fixture.alertsError) return { data: null, error: fixture.alertsError };
        return {
          data: fixture.alerts,
          error: null,
          count: fixture.alertsCount === undefined ? fixture.alerts.length : fixture.alertsCount,
        };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { getJevSignalsStatus, toSourceDriftRows, toAlertRows, JEV_ALERT_KINDS, JEV_ALERT_LIMIT } from "./jev-signals";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.drift = [
    {
      source_id: "11111111-1111-1111-1111-111111111111",
      day: "2026-09-20",
      n: 42,
      politics_share: 0.6,
      drift_score: 3.25,
      baseline: { politics_share: 0.4 },
      source: { slug: "kaynak-a", name: "Kaynak A" },
    },
  ];
  fixture.alerts = [
    {
      id: 1,
      kind: "source_drift",
      day: "2026-09-20",
      subject: "11111111-1111-1111-1111-111111111111",
      payload: { source_slug: "kaynak-a" },
      created_at: "2026-09-20T04:05:00.000Z",
    },
  ];
  fixture.driftError = null;
  fixture.alertsError = null;
  fixture.driftState = null;
  fixture.alertsState = null;
  fixture.alertsCount = undefined;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("toSourceDriftRows", () => {
  it("flattens a source embed returned as an object, as a one-element array, and as null", () => {
    const rows = toSourceDriftRows([
      { source_id: "a", day: "2026-09-20", n: 10, politics_share: 0.5, drift_score: 1, baseline: {}, source: { slug: "s-obj", name: "S Obj" } },
      { source_id: "b", day: "2026-09-20", n: 10, politics_share: 0.5, drift_score: 1, baseline: {}, source: [{ slug: "s-arr", name: "S Arr" }] },
      { source_id: "c", day: "2026-09-20", n: 10, politics_share: 0.5, drift_score: 1, baseline: {}, source: null },
    ]);

    expect(rows[0]!.source_slug).toBe("s-obj");
    expect(rows[0]!.source_name).toBe("S Obj");
    expect(rows[1]!.source_slug).toBe("s-arr");
    expect(rows[1]!.source_name).toBe("S Arr");
    expect(rows[2]!.source_slug).toBe("");
    expect(rows[2]!.source_name).toBe("");
  });

  it("reads baseline_politics_share out of the baseline jsonb", () => {
    const rows = toSourceDriftRows([
      { source_id: "a", day: "2026-09-20", n: 10, politics_share: 0.5, drift_score: 1, baseline: { politics_share: 0.42 }, source: null },
      { source_id: "b", day: "2026-09-20", n: 10, politics_share: 0.5, drift_score: 1, baseline: null, source: null },
      { source_id: "c", day: "2026-09-20", n: 10, politics_share: 0.5, drift_score: 1, baseline: {}, source: null },
    ]);

    expect(rows[0]!.baseline_politics_share).toBe(0.42);
    expect(rows[1]!.baseline_politics_share).toBeNull();
    expect(rows[2]!.baseline_politics_share).toBeNull();
  });

  it("coerces numerics sent as strings and keeps a missing measure null, never NaN", () => {
    const rows = toSourceDriftRows([
      {
        source_id: "a",
        day: "2026-09-20",
        n: 10,
        politics_share: "0.55",
        drift_score: "12.3",
        baseline: { politics_share: "0.31" },
        source: null,
      },
      {
        source_id: "b",
        day: "2026-09-20",
        n: 10,
        politics_share: undefined,
        drift_score: undefined,
        baseline: undefined,
        source: null,
      },
    ]);

    expect(rows[0]!.politics_share).toBe(0.55);
    expect(rows[0]!.drift_score).toBe(12.3);
    expect(rows[0]!.baseline_politics_share).toBe(0.31);
    expect(typeof rows[0]!.politics_share).toBe("number");

    expect(rows[1]!.politics_share).toBeNull();
    expect(rows[1]!.drift_score).toBeNull();
    expect(rows[1]!.baseline_politics_share).toBeNull();
    expect(Number.isNaN(rows[1]!.politics_share as unknown as number)).toBe(false);
    expect(Number.isNaN(rows[1]!.drift_score as unknown as number)).toBe(false);
  });

  it("defaults n to 0 rather than null so the render never divides by undefined", () => {
    const rows = toSourceDriftRows([
      { source_id: "a", day: "2026-09-20", n: null, politics_share: 0.5, drift_score: 1, baseline: {}, source: null },
      { source_id: "b", day: "2026-09-20", n: undefined, politics_share: 0.5, drift_score: 1, baseline: {}, source: null },
    ]);

    expect(rows[0]!.n).toBe(0);
    expect(rows[1]!.n).toBe(0);
    expect(typeof rows[0]!.n).toBe("number");
    expect(Number.isNaN(rows[0]!.n)).toBe(false);
  });
});

describe("toAlertRows", () => {
  it("coerces id to a number and keeps payload as an object", () => {
    const rows = toAlertRows([
      {
        id: "7",
        kind: "source_drift",
        day: "2026-09-20",
        subject: "s1",
        payload: { foo: "bar" },
        created_at: "2026-09-20T04:05:00.000Z",
      },
    ]);

    expect(rows[0]!.id).toBe(7);
    expect(typeof rows[0]!.id).toBe("number");
    expect(rows[0]!.payload).toEqual({ foo: "bar" });
  });

  it("survives a null payload by substituting an empty object", () => {
    const rows = toAlertRows([
      {
        id: 1,
        kind: "kap_class_canary",
        day: "2026-09-20",
        subject: "2026-09-20",
        payload: null,
        created_at: "2026-09-20T04:05:00.000Z",
      },
    ]);

    expect(rows[0]!.payload).toEqual({});
  });
});

describe("getJevSignalsStatus", () => {
  it("returns both lists from one round of queries", async () => {
    const result = await getJevSignalsStatus();

    expect(result).not.toBeNull();
    expect(result!.drift).toEqual(toSourceDriftRows(fixture.drift));
    expect(result!.alerts).toEqual(toAlertRows(fixture.alerts));
  });

  it("filters drift rows to flagged=true and the last 7 days", async () => {
    await getJevSignalsStatus();

    const state = fixture.driftState as BuilderState;
    expect(state).not.toBeNull();
    expect(state.eq).toContainEqual({ col: "flagged", val: true });
    expect(state.gte).toHaveLength(1);
    expect(state.gte[0]!.col).toBe("day");
    expect(String(state.gte[0]!.val)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("requests unacknowledged alerts newest first, limited to JEV_ALERT_LIMIT", async () => {
    await getJevSignalsStatus();

    const state = fixture.alertsState as BuilderState;
    expect(state).not.toBeNull();
    expect(state.is).toContainEqual({ col: "acknowledged_at", val: null });
    expect(state.order).toContainEqual({ col: "created_at", opts: { ascending: false } });
    expect(state.limit).toBe(JEV_ALERT_LIMIT);
    expect(JEV_ALERT_LIMIT).toBe(20);
  });

  it("a query error -> null and exactly one PII-free [admin] line", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.driftError = { message: "relation \"source_drift_daily\" does not exist" };

    const result = await getJevSignalsStatus();

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[admin]"));

    errorSpy.mockRestore();
  });

  it("missing env vars -> null, never throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getJevSignalsStatus()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("reports the exact unacknowledged count, not the capped page length, when a cohort flags at once", async () => {
    fixture.alerts = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      kind: "source_drift",
      day: "2026-09-20",
      subject: `source-${i}`,
      payload: {},
      created_at: "2026-09-20T04:05:00.000Z",
    }));
    fixture.alertsCount = 118;

    const result = await getJevSignalsStatus();

    expect(result).not.toBeNull();
    expect(result!.alerts.length).toBe(20);
    expect(result!.alertsTotal).toBe(118);
  });

  it("falls back alertsTotal to alerts.length when PostgREST returns no count", async () => {
    fixture.alertsCount = null;

    const result = await getJevSignalsStatus();

    expect(result).not.toBeNull();
    expect(result!.alertsTotal).toBe(result!.alerts.length);
  });
});

describe("vocabulary", () => {
  it("JEV_ALERT_KINDS matches migration 065's CHECK list", () => {
    expect(JEV_ALERT_KINDS).toEqual(["source_drift", "kap_class_canary"]);
  });
});
