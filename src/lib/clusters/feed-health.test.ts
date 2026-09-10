import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Harness mirrors src/lib/sources/active-count.test.ts's shared-fake wiring
// (createSupabaseFake + the "use cache" next/cache mocks).
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  lastState: null as unknown,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      sources: (state: unknown) => {
        fixture.lastState = state;
        return { data: fixture.data, error: fixture.error };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import {
  degradedSilentZone,
  getZoneFeedHealth,
  shouldSuppressBlindspot,
  FEED_HEALTH_MIN_SHARE,
  FEED_HEALTH_MAX_AGE_MS,
  type ZoneFeedHealth,
  type ZoneHealth,
} from "./feed-health";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };
const NOW_MS = new Date("2026-04-18T12:00:00Z").getTime();

function ago(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function row(opts: {
  bias: string;
  fetch_last_status?: number | null;
  fetch_last_at?: string | null;
}) {
  return {
    bias: opts.bias,
    fetch_last_status: opts.fetch_last_status ?? 200,
    fetch_last_at: opts.fetch_last_at === undefined ? ago(0) : opts.fetch_last_at,
  };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.lastState = null;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_MS));
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

// ---------------------------------------------------------------------------
// Query shape
// ---------------------------------------------------------------------------

describe("getZoneFeedHealth query shape", () => {
  it("filters on active sources with a non-null rss_url", async () => {
    await getZoneFeedHealth();
    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("sources");
    expect(state.eq).toContainEqual({ col: "active", val: true });
    expect(state.not).toContainEqual({ col: "rss_url", op: "is", val: null });
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("min share is 0.7 and max age is 2 hours", () => {
    expect(FEED_HEALTH_MIN_SHARE).toBe(0.7);
    expect(FEED_HEALTH_MAX_AGE_MS).toBe(2 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Health computation
// ---------------------------------------------------------------------------

describe("getZoneFeedHealth health computation", () => {
  it("marks a zone healthy when every source is fresh and 200/304", async () => {
    fixture.data = [
      row({ bias: "pro_government", fetch_last_status: 200, fetch_last_at: ago(5 * 60 * 1000) }),
      row({ bias: "gov_leaning", fetch_last_status: 304, fetch_last_at: ago(10 * 60 * 1000) }),
      row({ bias: "nationalist", fetch_last_status: 200, fetch_last_at: ago(0) }),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health).not.toBeNull();
    const iktidar = health.iktidar;
    expect(iktidar).toEqual<ZoneHealth>({
      total: 3,
      healthy: 3,
      healthyShare: 1,
      degraded: false,
    });
  });

  it("marks a zone degraded below the 0.7 healthy share", async () => {
    // 10 iktidar sources, 6 healthy -> 0.6 < 0.7 -> degraded.
    fixture.data = [
      ...Array.from({ length: 6 }, () =>
        row({ bias: "pro_government", fetch_last_status: 200, fetch_last_at: ago(0) }),
      ),
      ...Array.from({ length: 4 }, () =>
        row({ bias: "pro_government", fetch_last_status: 500, fetch_last_at: ago(0) }),
      ),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health.iktidar.total).toBe(10);
    expect(health.iktidar.healthy).toBe(6);
    expect(health.iktidar.healthyShare).toBeCloseTo(0.6);
    expect(health.iktidar.degraded).toBe(true);
  });

  it("marks a zone degraded when every source is down (healthy === 0)", async () => {
    fixture.data = [
      row({ bias: "opposition", fetch_last_status: 500, fetch_last_at: ago(0) }),
      row({ bias: "opposition_leaning", fetch_last_status: null, fetch_last_at: null }),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health.muhalefet).toEqual<ZoneHealth>({
      total: 2,
      healthy: 0,
      healthyShare: 0,
      degraded: true,
    });
  });

  it("is NOT degraded at exactly 0.7 healthy share (boundary)", async () => {
    // 10 muhalefet sources, 7 healthy -> exactly 0.7 -> not degraded.
    fixture.data = [
      ...Array.from({ length: 7 }, () =>
        row({ bias: "opposition", fetch_last_status: 200, fetch_last_at: ago(0) }),
      ),
      ...Array.from({ length: 3 }, () =>
        row({ bias: "opposition", fetch_last_status: 500, fetch_last_at: ago(0) }),
      ),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health.muhalefet.healthyShare).toBe(0.7);
    expect(health.muhalefet.degraded).toBe(false);
  });

  it("counts a stale-but-200 source as unhealthy", async () => {
    // 200 status, but the fetch happened 3 hours ago (> 2h window).
    fixture.data = [
      row({ bias: "center", fetch_last_status: 200, fetch_last_at: ago(3 * 60 * 60 * 1000) }),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health.bagimsiz.healthy).toBe(0);
    expect(health.bagimsiz.degraded).toBe(true);
  });

  it("uses zoneOf from @/lib/bias/config to bucket every bias category", async () => {
    fixture.data = [
      row({ bias: "center", fetch_last_status: 200, fetch_last_at: ago(0) }),
      row({ bias: "international", fetch_last_status: 200, fetch_last_at: ago(0) }),
      row({ bias: "pro_kurdish", fetch_last_status: 200, fetch_last_at: ago(0) }),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health.bagimsiz.total).toBe(3);
    expect(health.iktidar.total).toBe(0);
    expect(health.muhalefet.total).toBe(0);
  });

  it("returns an all-zero, non-degraded-by-healthyShare-but-degraded-by-zero zone when there are no sources at all", async () => {
    fixture.data = [];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
      expect(health[zone]).toEqual<ZoneHealth>({
        total: 0,
        healthy: 0,
        healthyShare: 0,
        degraded: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-open error handling
// ---------------------------------------------------------------------------

describe("getZoneFeedHealth error handling (fail open)", () => {
  it("returns null and logs a single warning when the query errors", async () => {
    fixture.error = { message: "connection reset" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const health = await getZoneFeedHealth();
    expect(health).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/^\[feed-health\] health unknown:/);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// shouldSuppressBlindspot (pure)
// ---------------------------------------------------------------------------

function mkHealth(overrides: Partial<Record<"iktidar" | "bagimsiz" | "muhalefet", boolean>>): ZoneFeedHealth {
  const healthyZone: ZoneHealth = { total: 5, healthy: 5, healthyShare: 1, degraded: false };
  const degradedZone: ZoneHealth = { total: 5, healthy: 1, healthyShare: 0.2, degraded: true };
  return {
    iktidar: overrides.iktidar ? degradedZone : healthyZone,
    bagimsiz: overrides.bagimsiz ? degradedZone : healthyZone,
    muhalefet: overrides.muhalefet ? degradedZone : healthyZone,
  };
}

describe("shouldSuppressBlindspot", () => {
  it("is false when health is null (fail open)", () => {
    expect(shouldSuppressBlindspot("iktidar", null)).toBe(false);
  });

  it("is false when health is undefined (fail open)", () => {
    expect(shouldSuppressBlindspot("iktidar", undefined)).toBe(false);
  });

  it("is true when the opposite pole zone is degraded", () => {
    // Dominant = iktidar (it covered the story); muhalefet (the silent
    // pole) is degraded -> its silence can't be trusted.
    expect(shouldSuppressBlindspot("iktidar", mkHealth({ muhalefet: true }))).toBe(true);
  });

  it("is true the other direction: dominant = muhalefet, iktidar degraded", () => {
    expect(shouldSuppressBlindspot("muhalefet", mkHealth({ iktidar: true }))).toBe(true);
  });

  it("is false when every pole zone is healthy (regression / unaffected cluster)", () => {
    expect(shouldSuppressBlindspot("iktidar", mkHealth({}))).toBe(false);
  });

  it("a degraded bagimsiz zone ALONE does not suppress — it is never a pole", () => {
    expect(shouldSuppressBlindspot("iktidar", mkHealth({ bagimsiz: true }))).toBe(false);
    expect(shouldSuppressBlindspot("muhalefet", mkHealth({ bagimsiz: true }))).toBe(false);
  });

  it("does not check the dominant zone's own health", () => {
    // Dominant = iktidar and iktidar itself is degraded, but the OTHER
    // pole (muhalefet) is healthy -> must not suppress on the dominant
    // zone's own health.
    expect(shouldSuppressBlindspot("iktidar", mkHealth({ iktidar: true }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// degradedSilentZone (pure) — the single lookup every suppression log call
// site shares (blindspots-query.ts, cluster-detail-query.ts,
// politics-query.ts) so they can't independently drift on which zone a
// suppression log names.
// ---------------------------------------------------------------------------

describe("degradedSilentZone", () => {
  it("names the degraded opposite pole when dominant = iktidar", () => {
    expect(degradedSilentZone("iktidar", mkHealth({ muhalefet: true }))).toBe(
      "muhalefet",
    );
  });

  it("names muhalefet when the dominant zone is bagimsiz and muhalefet is degraded", () => {
    // A bagimsiz-dominant blindspot is a real case (e.g. a story covered
    // >=80% by center/international/pro_kurdish outlets) — the silent
    // pole is still whichever of iktidar/muhalefet is degraded, never
    // "iktidar" by hardcoded default.
    expect(degradedSilentZone("bagimsiz", mkHealth({ muhalefet: true }))).toBe(
      "muhalefet",
    );
  });

  it("names iktidar when the dominant zone is bagimsiz and iktidar is degraded", () => {
    expect(degradedSilentZone("bagimsiz", mkHealth({ iktidar: true }))).toBe(
      "iktidar",
    );
  });

  it("returns null when no pole zone is degraded", () => {
    expect(degradedSilentZone("iktidar", mkHealth({}))).toBeNull();
  });
});
