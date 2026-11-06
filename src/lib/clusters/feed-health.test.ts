import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Harness mirrors src/lib/sources/active-count.test.ts's shared-fake wiring
// (createSupabaseFake + the "use cache" next/cache mocks) plus its call-
// tracking proxy: the shared fake's `BuilderState.limit` only records the
// row-cap argument, not the `{ referencedTable }` options object, so the
// yield-probe query-shape test below wraps `from()`'s return value to record
// every method call (name + raw args) and asserts on that instead.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string; hint?: string; code?: string } | null,
  lastState: null as unknown,
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
}));

const tracker = vi.hoisted(() => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  function wrapTracking<T extends object>(obj: T): T {
    return new Proxy(obj, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          const result = (value as (...a: unknown[]) => unknown).apply(
            target,
            args,
          );
          return result && typeof result === "object"
            ? wrapTracking(result as object)
            : result;
        };
      },
    });
  }
  return { calls, wrapTracking };
});

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
  createClient: (_url: string, _key: string, opts?: unknown) => {
    fixture.clientOpts.push(opts);
    return {
      ...supabaseFake.client,
      from: (table: string) =>
        tracker.wrapTracking(supabaseFake.client.from(table)),
    };
  },
}));

import { cacheLife } from "next/cache";
import { isVotingKind } from "@/lib/bias/config";
import {
  degradedSilentZone,
  getZoneFeedHealth,
  isZoneDegraded,
  shouldSuppressBlindspot,
  zoneVotingYieldDenominator,
  zoneYieldDenominator,
  FEED_HEALTH_MIN_SHARE,
  FEED_HEALTH_MAX_AGE_MS,
  FEED_YIELD_WINDOW_MS,
  FEED_HEALTH_MIN_YIELD_SHARE,
  type ZoneFeedHealth,
  type ZoneHealth,
} from "./feed-health";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };
const NOW_MS = new Date("2026-04-18T12:00:00Z").getTime();

function ago(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

let recentSeq = 0;

function row(opts: {
  bias: string;
  fetch_last_status?: number | null;
  fetch_last_at?: string | null;
  /** Existence-probe embed rows. Defaults to one row (delivering) so tests
   * that only care about the fetch-status axis don't have to think about
   * the yield axis they're not exercising. */
  recent?: Array<{ id: string }>;
  /** `sources.fetch_fail_streak`. The key is left off the row entirely when
   * the test does not pass it, which is the legacy / test-double shape. */
  fetch_fail_streak?: number | null;
  /** `sources.kind`. Like the streak, the key is left off the row entirely
   * when the test does not pass it (legacy / test-double shape), which must
   * read as a voting `outlet` (`isVotingKind`'s default). */
  kind?: unknown;
}) {
  recentSeq += 1;
  return {
    bias: opts.bias,
    fetch_last_status: opts.fetch_last_status ?? 200,
    fetch_last_at: opts.fetch_last_at === undefined ? ago(0) : opts.fetch_last_at,
    recent: opts.recent ?? [{ id: `recent-${recentSeq}` }],
    ...("fetch_fail_streak" in opts ? { fetch_fail_streak: opts.fetch_fail_streak } : {}),
    ...("kind" in opts ? { kind: opts.kind } : {}),
  };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.lastState = null;
  fixture.clientOpts = [];
  vi.mocked(cacheLife).mockClear();
  tracker.calls.length = 0;
  recentSeq = 0;
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

  it("selects the recent:articles(id) existence-probe embed alongside the status columns", async () => {
    await getZoneFeedHealth();
    const state = fixture.lastState as BuilderState;
    expect(String(state.selectArgs[0])).toContain("recent:articles(id)");
    expect(String(state.selectArgs[0])).toContain("fetch_last_status");
    expect(String(state.selectArgs[0])).toContain("fetch_last_at");
  });

  it("h49-ops-1: selects fetch_fail_streak so a refused 2xx body is not counted as a good fetch", async () => {
    await getZoneFeedHealth();
    const state = fixture.lastState as BuilderState;
    expect(String(state.selectArgs[0])).toContain("fetch_fail_streak");
  });

  it("h53-consistency-2: selects the kind column (one more column, no extra query) so voting sources can be told apart", async () => {
    await getZoneFeedHealth();
    const state = fixture.lastState as BuilderState;
    expect(String(state.selectArgs[0])).toMatch(/(^|[\s,])kind([\s,]|$)/);
    // Still exactly one sources query: the kind split rides on the same select.
    expect(tracker.calls.filter((c) => c.method === "select")).toHaveLength(1);
  });

  it("adds a 72h gte on recent.published_at and probes with limit(1, { referencedTable: 'recent' }) — same cheap-compute shape as active-count.ts", async () => {
    await getZoneFeedHealth();
    const state = fixture.lastState as BuilderState;

    const gte = state.gte.find((g) => g.col === "recent.published_at");
    expect(gte).toBeDefined();
    const gteMs = new Date(gte!.val as string).getTime();
    const expectedMs = NOW_MS - FEED_YIELD_WINDOW_MS;
    expect(Math.abs(gteMs - expectedMs)).toBeLessThan(1000);

    expect(tracker.calls).toContainEqual({
      method: "limit",
      args: [1, { referencedTable: "recent" }],
    });
  });

  it("SEC-01: also bounds the probe with an lte on recent.published_at at ~now, so a future-dated pubDate can't satisfy the gte forever", async () => {
    await getZoneFeedHealth();
    const state = fixture.lastState as BuilderState;

    const lte = state.lte.find((l) => l.col === "recent.published_at");
    expect(lte).toBeDefined();
    const lteMs = new Date(lte!.val as string).getTime();
    expect(Math.abs(lteMs - NOW_MS)).toBeLessThan(1000);
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

  it("yield window is 72 hours and the yield share constant is the evidence-backed 0.5", () => {
    expect(FEED_YIELD_WINDOW_MS).toBe(72 * 60 * 60 * 1000);
    expect(FEED_HEALTH_MIN_YIELD_SHARE).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Health computation (fetch-status axis, delivering held at "default: yes"
// via the row() helper so these cases keep testing exactly what they tested
// before the yield axis existed)
// ---------------------------------------------------------------------------

describe("getZoneFeedHealth health computation", () => {
  it("marks a zone healthy when every source is fresh, 200/304, and delivering", async () => {
    fixture.data = [
      row({ bias: "pro_government", fetch_last_status: 200, fetch_last_at: ago(5 * 60 * 1000) }),
      row({ bias: "gov_leaning", fetch_last_status: 304, fetch_last_at: ago(10 * 60 * 1000) }),
      row({ bias: "nationalist", fetch_last_status: 200, fetch_last_at: ago(0) }),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health).not.toBeNull();
    expect(health.iktidar).toEqual<ZoneHealth>({
      total: 3,
      fetchOk: 3,
      fetchOkShare: 1,
      delivering: 3,
      // No row carries a kind: the legacy shape votes (isVotingKind default).
      votingDelivering: 3,
      deliveringShare: 1,
      healthy: 3,
      healthyShare: 1,
      degraded: false,
    });
  });

  it("marks a zone degraded below the 0.7 fetchOk share", async () => {
    // 10 iktidar sources, 6 fetchOk -> 0.6 < 0.7 -> degraded via the
    // fetch-status axis (all still delivering, via the row() default).
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
    expect(health.iktidar.fetchOk).toBe(6);
    expect(health.iktidar.fetchOkShare).toBeCloseTo(0.6);
    expect(health.iktidar.delivering).toBe(10);
    expect(health.iktidar.deliveringShare).toBe(1);
    expect(health.iktidar.healthy).toBe(6);
    expect(health.iktidar.degraded).toBe(true);
  });

  it("marks a zone degraded when every source's last fetch failed (fetchOk === 0)", async () => {
    fixture.data = [
      row({ bias: "opposition", fetch_last_status: 500, fetch_last_at: ago(0) }),
      row({ bias: "opposition_leaning", fetch_last_status: null, fetch_last_at: null }),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health.muhalefet.total).toBe(2);
    expect(health.muhalefet.fetchOk).toBe(0);
    expect(health.muhalefet.fetchOkShare).toBe(0);
    expect(health.muhalefet.healthy).toBe(0);
    expect(health.muhalefet.healthyShare).toBe(0);
    expect(health.muhalefet.degraded).toBe(true);
  });

  it("is NOT degraded at exactly 0.7 fetchOk share with full delivering share (boundary)", async () => {
    // 10 muhalefet sources, 7 fetchOk -> exactly 0.7 -> not degraded; all
    // still delivering (row() default) so the yield axis doesn't interfere.
    fixture.data = [
      ...Array.from({ length: 7 }, () =>
        row({ bias: "opposition", fetch_last_status: 200, fetch_last_at: ago(0) }),
      ),
      ...Array.from({ length: 3 }, () =>
        row({ bias: "opposition", fetch_last_status: 500, fetch_last_at: ago(0) }),
      ),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health.muhalefet.fetchOkShare).toBe(0.7);
    expect(health.muhalefet.deliveringShare).toBe(1);
    expect(health.muhalefet.degraded).toBe(false);
  });

  it("counts a stale-but-200 source as fetch-not-ok", async () => {
    // 200 status, but the fetch happened 3 hours ago (> 2h window).
    fixture.data = [
      row({ bias: "center", fetch_last_status: 200, fetch_last_at: ago(3 * 60 * 60 * 1000) }),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health.bagimsiz.fetchOk).toBe(0);
    expect(health.bagimsiz.healthy).toBe(0);
    expect(health.bagimsiz.degraded).toBe(true);
  });

  describe("h49-ops-1: a 2xx/304 answer with a fail streak was refused, not fetched", () => {
    // A parsed 2xx/304 resets fetch_fail_streak to 0, so status 200 together
    // with a streak above 0 is an HTML page or a parse failure. 5 such feeds
    // (t24, turkiye-today, voa-turkce, yenisoz, rudaw-turkce) sit at 200 with
    // streaks of 34-60 and re-stamp fetch_last_at on every daily retry.
    it("a 200 fetched 10 minutes ago with fetch_fail_streak 5 is NOT fetch-ok", async () => {
      fixture.data = [
        row({
          bias: "center",
          fetch_last_status: 200,
          fetch_last_at: ago(10 * 60 * 1000),
          fetch_fail_streak: 5,
        }),
      ];
      const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
      expect(health.bagimsiz.total).toBe(1);
      expect(health.bagimsiz.fetchOk).toBe(0);
      expect(health.bagimsiz.fetchOkShare).toBe(0);
      expect(health.bagimsiz.healthy).toBe(0);
      expect(health.bagimsiz.degraded).toBe(true);
    });

    it("a 304 with a fail streak is NOT fetch-ok either", async () => {
      fixture.data = [
        row({
          bias: "center",
          fetch_last_status: 304,
          fetch_last_at: ago(10 * 60 * 1000),
          fetch_fail_streak: 1,
        }),
      ];
      const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
      expect(health.bagimsiz.fetchOk).toBe(0);
    });

    it.each([
      ["streak 0", 0],
      ["streak null", null],
      ["streak undefined", undefined],
    ])("the same row with %s IS fetch-ok", async (_name, streak) => {
      fixture.data = [
        row({
          bias: "center",
          fetch_last_status: 200,
          fetch_last_at: ago(10 * 60 * 1000),
          fetch_fail_streak: streak,
        }),
      ];
      const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
      expect(health.bagimsiz.fetchOk).toBe(1);
      expect(health.bagimsiz.healthy).toBe(1);
      expect(health.bagimsiz.degraded).toBe(false);
    });

    it("a row that omits the fetch_fail_streak key (legacy shape) IS fetch-ok", async () => {
      fixture.data = [
        row({ bias: "center", fetch_last_status: 200, fetch_last_at: ago(10 * 60 * 1000) }),
      ];
      expect("fetch_fail_streak" in (fixture.data[0] as object)).toBe(false);
      const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
      expect(health.bagimsiz.fetchOk).toBe(1);
    });

    it("only the refused feeds drop out of the zone share", async () => {
      // 10 bagimsiz sources: 7 healthy, 3 refused 200s (streak 34-60).
      fixture.data = [
        ...Array.from({ length: 7 }, () =>
          row({ bias: "center", fetch_last_status: 200, fetch_last_at: ago(0), fetch_fail_streak: 0 }),
        ),
        ...[34, 58, 60].map((streak) =>
          row({ bias: "center", fetch_last_status: 200, fetch_last_at: ago(0), fetch_fail_streak: streak }),
        ),
      ];
      const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
      expect(health.bagimsiz.total).toBe(10);
      expect(health.bagimsiz.fetchOk).toBe(7);
      expect(health.bagimsiz.fetchOkShare).toBe(0.7);
      expect(health.bagimsiz.degraded).toBe(false);
    });

    it("four refused 200s out of ten push the zone under the 0.7 gate", async () => {
      // 10 sources: 6 healthy, 4 refused 200s -> 0.6 < 0.7 -> degraded.
      fixture.data = [
        ...Array.from({ length: 6 }, () =>
          row({ bias: "pro_government", fetch_last_status: 200, fetch_last_at: ago(0), fetch_fail_streak: 0 }),
        ),
        ...Array.from({ length: 4 }, () =>
          row({ bias: "pro_government", fetch_last_status: 200, fetch_last_at: ago(0), fetch_fail_streak: 60 }),
        ),
      ];
      const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
      expect(health.iktidar.fetchOkShare).toBeCloseTo(0.6);
      expect(health.iktidar.degraded).toBe(true);
    });
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

  it("returns an all-zero, degraded zone when there are no sources at all", async () => {
    fixture.data = [];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
      expect(health[zone]).toEqual<ZoneHealth>({
        total: 0,
        fetchOk: 0,
        fetchOkShare: 0,
        delivering: 0,
        votingDelivering: 0,
        deliveringShare: 0,
        healthy: 0,
        healthyShare: 0,
        degraded: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Yield axis (the AND rule this pack adds)
// ---------------------------------------------------------------------------

describe("getZoneFeedHealth yield axis (status AND yield)", () => {
  it("a source that fetches 200 within 2h but delivered nothing in 72h is NOT healthy", async () => {
    fixture.data = [
      row({ bias: "pro_government", fetch_last_status: 200, fetch_last_at: ago(0), recent: [] }),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health.iktidar.fetchOk).toBe(1);
    expect(health.iktidar.delivering).toBe(0);
    expect(health.iktidar.healthy).toBe(0);
  });

  it("a source that delivered in 72h but last fetched 3h ago is NOT healthy", async () => {
    fixture.data = [
      row({
        bias: "pro_government",
        fetch_last_status: 200,
        fetch_last_at: ago(3 * 60 * 60 * 1000),
        recent: [{ id: "a1" }],
      }),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health.iktidar.fetchOk).toBe(0);
    expect(health.iktidar.delivering).toBe(1);
    expect(health.iktidar.healthy).toBe(0);
  });

  it("only both-true counts as healthy — fetchOk/delivering/healthy are independently asserted", async () => {
    fixture.data = [
      // both true
      row({ bias: "pro_government", fetch_last_status: 200, fetch_last_at: ago(0), recent: [{ id: "a1" }] }),
      // fetchOk only
      row({ bias: "pro_government", fetch_last_status: 200, fetch_last_at: ago(0), recent: [] }),
      // delivering only
      row({ bias: "pro_government", fetch_last_status: 500, fetch_last_at: ago(0), recent: [{ id: "a2" }] }),
      // neither
      row({ bias: "pro_government", fetch_last_status: 500, fetch_last_at: ago(0), recent: [] }),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health.iktidar.total).toBe(4);
    expect(health.iktidar.fetchOk).toBe(2);
    expect(health.iktidar.delivering).toBe(2);
    expect(health.iktidar.healthy).toBe(1);
  });

  it("deliveringShare below FEED_HEALTH_MIN_YIELD_SHARE marks the zone degraded even when fetchOkShare is 1.0", async () => {
    fixture.data = [
      row({ bias: "pro_government", fetch_last_status: 200, fetch_last_at: ago(0), recent: [{ id: "a1" }] }),
      row({ bias: "pro_government", fetch_last_status: 200, fetch_last_at: ago(0), recent: [] }),
      row({ bias: "pro_government", fetch_last_status: 200, fetch_last_at: ago(0), recent: [] }),
      row({ bias: "pro_government", fetch_last_status: 200, fetch_last_at: ago(0), recent: [] }),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health.iktidar.fetchOkShare).toBe(1);
    expect(health.iktidar.deliveringShare).toBe(0.25);
    expect(health.iktidar.degraded).toBe(true);
  });

  it("pins today's measured per-zone yield shares against FEED_HEALTH_MIN_YIELD_SHARE so a future drift is loud", async () => {
    // Measured via `sbq.py` against production `sources`/`articles`
    // (2026-09-18), grouped by bias and mapped to zone via BIAS_TO_ZONE:
    //   pro_government:     17 total, 15 fetchOk, 12 delivering
    //   gov_leaning:        19 total, 14 fetchOk, 12 delivering
    //   center (bagimsiz):  57 total, 49 fetchOk, 33 delivering
    //   opposition:          7 total,  6 fetchOk,  5 delivering
    //   opposition_leaning: 18 total, 15 fetchOk, 10 delivering
    // -> iktidar = 36 total / 29 fetchOk / 24 delivering (66.7% yield)
    // -> muhalefet = 25 total / 21 fetchOk / 15 delivering (60.0% yield)
    function rowsFor(
      bias: string,
      total: number,
      fetchOkCount: number,
      deliveringCount: number,
    ) {
      return Array.from({ length: total }, (_, i) =>
        row({
          bias,
          fetch_last_status: i < fetchOkCount ? 200 : 500,
          fetch_last_at: ago(0),
          recent: i < deliveringCount ? [{ id: `${bias}-${i}` }] : [],
        }),
      );
    }
    fixture.data = [
      ...rowsFor("pro_government", 17, 15, 12),
      ...rowsFor("gov_leaning", 19, 14, 12),
      ...rowsFor("center", 57, 49, 33),
      ...rowsFor("opposition", 7, 6, 5),
      ...rowsFor("opposition_leaning", 18, 15, 10),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;

    expect(health.iktidar.total).toBe(36);
    expect(health.iktidar.fetchOk).toBe(29);
    expect(health.iktidar.delivering).toBe(24);
    expect(health.iktidar.deliveringShare).toBeCloseTo(24 / 36);
    expect(health.iktidar.degraded).toBe(false);

    expect(health.muhalefet.total).toBe(25);
    expect(health.muhalefet.fetchOk).toBe(21);
    expect(health.muhalefet.delivering).toBe(15);
    expect(health.muhalefet.deliveringShare).toBeCloseTo(15 / 25);
    expect(health.muhalefet.degraded).toBe(false);

    // Both pole zones must keep >=0.05 headroom above the chosen constant.
    // If this goes negative, FEED_HEALTH_MIN_YIELD_SHARE has drifted past
    // the evidence that justified it and /blindspots is at risk of
    // silently emptying — see the pack's threshold step.
    expect(
      health.iktidar.deliveringShare - FEED_HEALTH_MIN_YIELD_SHARE,
    ).toBeGreaterThanOrEqual(0.05);
    expect(
      health.muhalefet.deliveringShare - FEED_HEALTH_MIN_YIELD_SHARE,
    ).toBeGreaterThanOrEqual(0.05);
  });
});

// ---------------------------------------------------------------------------
// h53-consistency-2: the voting basis. `delivering` stays the all-kinds count
// (/hafta labels it "toplayıcı / niş dahil"); `votingDelivering` is the same
// count restricted to the kinds that vote in bias_distribution (outlet, wire)
// — the basis the Manşet Kartı numerator already uses.
// ---------------------------------------------------------------------------

describe("getZoneFeedHealth voting basis (h53-consistency-2)", () => {
  /** n delivering rows of one kind in one bias. */
  function kindRows(bias: string, kind: unknown, n: number) {
    return Array.from({ length: n }, () => row({ bias, kind }));
  }

  it("20 outlet + 1 wire + 5 niche + 2 aggregator delivering rows: delivering 28, votingDelivering 21", async () => {
    fixture.data = [
      ...kindRows("center", "outlet", 20),
      ...kindRows("center", "wire", 1),
      ...kindRows("center", "niche", 5),
      ...kindRows("center", "aggregator", 2),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health.bagimsiz.total).toBe(28);
    expect(health.bagimsiz.delivering).toBe(28);
    expect(health.bagimsiz.votingDelivering).toBe(21);
  });

  it("degraded, healthy and deliveringShare equal the kind-blind values for the same fixture", async () => {
    const fixtureRows = (withKind: boolean) =>
      [
        ["outlet", 20],
        ["wire", 1],
        ["niche", 5],
        ["aggregator", 2],
      ].flatMap(([kind, n]) =>
        Array.from({ length: n as number }, (_, i) =>
          row({
            bias: "center",
            // A mix of fetch outcomes and silent feeds so every axis moves.
            fetch_last_status: i % 4 === 0 ? 500 : 200,
            recent: i % 5 === 0 ? [] : undefined,
            ...(withKind ? { kind } : {}),
          }),
        ),
      );

    recentSeq = 0;
    fixture.data = fixtureRows(false);
    const blind = ((await getZoneFeedHealth()) as ZoneFeedHealth).bagimsiz;

    recentSeq = 0;
    fixture.data = fixtureRows(true);
    const withKinds = ((await getZoneFeedHealth()) as ZoneFeedHealth).bagimsiz;

    expect(withKinds.total).toBe(blind.total);
    expect(withKinds.fetchOk).toBe(blind.fetchOk);
    expect(withKinds.fetchOkShare).toBe(blind.fetchOkShare);
    expect(withKinds.delivering).toBe(blind.delivering);
    expect(withKinds.deliveringShare).toBe(blind.deliveringShare);
    expect(withKinds.healthy).toBe(blind.healthy);
    expect(withKinds.healthyShare).toBe(blind.healthyShare);
    expect(withKinds.degraded).toBe(blind.degraded);
    // ...while the kind split is real: strictly fewer voting than delivering.
    expect(withKinds.votingDelivering).toBeLessThan(withKinds.delivering);
    // And the kind-blind run (no kind key at all) votes everywhere.
    expect(blind.votingDelivering).toBe(blind.delivering);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an unknown string", "podcast"],
    ["an empty string", ""],
    ["a non-string", 7],
  ])("a row whose kind is %s follows isVotingKind (it votes)", async (_label, kind) => {
    fixture.data = [row({ bias: "center", kind })];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(isVotingKind(kind)).toBe(true);
    expect(health.bagimsiz.delivering).toBe(1);
    expect(health.bagimsiz.votingDelivering).toBe(1);
  });

  it("a non-delivering voting source adds to neither count", async () => {
    fixture.data = [
      row({ bias: "center", kind: "outlet", recent: [] }),
      row({ bias: "center", kind: "outlet" }),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health.bagimsiz.total).toBe(2);
    expect(health.bagimsiz.delivering).toBe(1);
    expect(health.bagimsiz.votingDelivering).toBe(1);
  });

  it("a delivering non-voting source counts in delivering only, in its own zone", async () => {
    fixture.data = [
      row({ bias: "pro_government", kind: "aggregator" }),
      row({ bias: "opposition", kind: "niche" }),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect(health.iktidar.delivering).toBe(1);
    expect(health.iktidar.votingDelivering).toBe(0);
    expect(health.muhalefet.delivering).toBe(1);
    expect(health.muhalefet.votingDelivering).toBe(0);
    expect(health.bagimsiz.votingDelivering).toBe(0);
  });

  it("votingDelivering never exceeds delivering, and is 0 on an empty read", async () => {
    fixture.data = [];
    const empty = (await getZoneFeedHealth()) as ZoneFeedHealth;
    for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
      expect(empty[zone].votingDelivering).toBe(0);
    }
    fixture.data = [
      ...kindRows("pro_government", "outlet", 3),
      ...kindRows("pro_government", "niche", 4),
      ...kindRows("opposition", "wire", 2),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
      expect(health[zone].votingDelivering).toBeLessThanOrEqual(health[zone].delivering);
    }
  });

  it("replays the 2026-11-06 17:25Z production counts: delivering 31/37/19, voting 28/24/18", async () => {
    // outlet + wire + aggregator + niche delivering rows per zone, from the
    // read-only SQL in the h53-consistency-2 evidence.
    fixture.data = [
      ...kindRows("pro_government", "outlet", 27),
      ...kindRows("pro_government", "wire", 1),
      ...kindRows("pro_government", "aggregator", 1),
      ...kindRows("pro_government", "niche", 2),
      ...kindRows("center", "outlet", 23),
      ...kindRows("center", "wire", 1),
      ...kindRows("center", "aggregator", 5),
      ...kindRows("center", "niche", 8),
      ...kindRows("opposition", "outlet", 17),
      ...kindRows("opposition", "wire", 1),
      ...kindRows("opposition", "niche", 1),
    ];
    const health = (await getZoneFeedHealth()) as ZoneFeedHealth;
    expect([health.iktidar.delivering, health.bagimsiz.delivering, health.muhalefet.delivering]).toEqual([31, 37, 19]);
    expect([
      health.iktidar.votingDelivering,
      health.bagimsiz.votingDelivering,
      health.muhalefet.votingDelivering,
    ]).toEqual([28, 24, 18]);
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
// Read profile + conditional cache lifetime (cold-read resilience)
// ---------------------------------------------------------------------------

/** A capped client is built with a custom `global.fetch`; a plain one is not. */
function isCappedClientOpts(opts: unknown): boolean {
  const g = (opts as { global?: { fetch?: unknown } } | undefined)?.global;
  return typeof g?.fetch === "function";
}

describe("getZoneFeedHealth read profile", () => {
  it("defaults to the capped reader client", async () => {
    await getZoneFeedHealth();
    expect(fixture.clientOpts).toHaveLength(1);
    expect(isCappedClientOpts(fixture.clientOpts[0])).toBe(true);
  });

  it("an empty options object is still the capped reader client", async () => {
    await getZoneFeedHealth({});
    expect(fixture.clientOpts).toHaveLength(1);
    expect(isCappedClientOpts(fixture.clientOpts[0])).toBe(true);
  });

  it("the explicit reader profile gets the capped client", async () => {
    await getZoneFeedHealth({ profile: "reader" });
    expect(fixture.clientOpts).toHaveLength(1);
    expect(isCappedClientOpts(fixture.clientOpts[0])).toBe(true);
  });

  it("the batch profile (crons) gets the plain, uncapped client", async () => {
    await getZoneFeedHealth({ profile: "batch" });
    expect(fixture.clientOpts).toHaveLength(1);
    expect(isCappedClientOpts(fixture.clientOpts[0])).toBe(false);
  });
});

describe("getZoneFeedHealth cache lifetime", () => {
  it("success calls cacheLife exactly once with the normal source-directory profile", async () => {
    fixture.data = [row({ bias: "pro_government" })];
    const health = await getZoneFeedHealth();
    expect(health).not.toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
  });

  it("a query error returns null and is cached only for the short minutes lifetime", async () => {
    fixture.error = { message: "connection reset" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(getZoneFeedHealth()).resolves.toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("a reader timeout (AbortError) returns null and is cached only for minutes", async () => {
    fixture.error = {
      message: "AbortError: Supabase request exceeded 4000 ms",
      hint: "Request was aborted (timeout or manual cancellation)",
      code: "",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(getZoneFeedHealth({ profile: "reader" })).resolves.toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("a thrown client-construction error also fails open to null with the minutes lifetime", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(getZoneFeedHealth()).resolves.toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });
});

// ---------------------------------------------------------------------------
// Shared health fixture for the pure-function tests below.
// ---------------------------------------------------------------------------

function mkHealth(overrides: Partial<Record<"iktidar" | "bagimsiz" | "muhalefet", boolean>>): ZoneFeedHealth {
  const healthyZone: ZoneHealth = {
    total: 5,
    fetchOk: 5,
    fetchOkShare: 1,
    delivering: 5,
    votingDelivering: 4,
    deliveringShare: 1,
    healthy: 5,
    healthyShare: 1,
    degraded: false,
  };
  const degradedZone: ZoneHealth = {
    total: 5,
    fetchOk: 1,
    fetchOkShare: 0.2,
    delivering: 1,
    votingDelivering: 0,
    deliveringShare: 0.2,
    healthy: 1,
    healthyShare: 0.2,
    degraded: true,
  };
  return {
    iktidar: overrides.iktidar ? degradedZone : healthyZone,
    bagimsiz: overrides.bagimsiz ? degradedZone : healthyZone,
    muhalefet: overrides.muhalefet ? degradedZone : healthyZone,
  };
}

// ---------------------------------------------------------------------------
// isZoneDegraded (pure) — SEC-02's two-axis-plus-floor rule, tested
// directly since a real query result can never produce the disjoint-sets
// numbers below (see the function's doc comment: the two threshold
// constants sum above 1, so a real fetchOk/delivering split can't clear
// both shares with zero overlap) — this is the only way to exercise the
// `healthy === 0` floor with the pack's own illustrative numbers.
// ---------------------------------------------------------------------------

describe("isZoneDegraded", () => {
  it("SEC-02: is degraded when healthy is 0, even with fetchOkShare 0.8 and deliveringShare 0.6 (both individually above threshold)", () => {
    expect(isZoneDegraded(0, 0.8, 0.6)).toBe(true);
  });

  it("is not degraded when healthy > 0 and both shares clear their thresholds", () => {
    expect(isZoneDegraded(4, 0.8, 0.6)).toBe(false);
  });

  it("is degraded when fetchOkShare alone is below threshold, regardless of healthy", () => {
    expect(isZoneDegraded(5, 0.69, 0.9)).toBe(true);
  });

  it("is degraded when deliveringShare alone is below threshold, regardless of healthy", () => {
    expect(isZoneDegraded(5, 0.9, 0.49)).toBe(true);
  });

  it("is not degraded exactly at both thresholds with healthy > 0 (boundary)", () => {
    expect(isZoneDegraded(1, FEED_HEALTH_MIN_SHARE, FEED_HEALTH_MIN_YIELD_SHARE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// zoneYieldDenominator (pure)
// ---------------------------------------------------------------------------

describe("zoneYieldDenominator", () => {
  it("returns null when health is null", () => {
    expect(zoneYieldDenominator(null, "iktidar")).toBeNull();
  });

  it("returns the zone's delivering count when health is present", () => {
    const health = mkHealth({});
    expect(zoneYieldDenominator(health, "iktidar")).toBe(health.iktidar.delivering);
    expect(zoneYieldDenominator(health, "muhalefet")).toBe(health.muhalefet.delivering);
  });

  it("reflects a degraded zone's (lower) delivering count too", () => {
    const health = mkHealth({ muhalefet: true });
    expect(zoneYieldDenominator(health, "muhalefet")).toBe(1);
  });

  it("h53-consistency-2: stays the ALL-kinds count (aggregator + niche included), the figure /hafta and /rapor label and divide as such", () => {
    const health = mkHealth({});
    // 5 delivering, of which only 4 vote: the all-kinds helper must not move.
    expect(zoneYieldDenominator(health, "bagimsiz")).toBe(5);
    expect(zoneYieldDenominator(health, "bagimsiz")).not.toBe(health.bagimsiz.votingDelivering);
  });
});

// ---------------------------------------------------------------------------
// zoneVotingYieldDenominator (pure) — the one helper that gives the Manşet
// Kartı (and any future "N / M kaynak" surface whose N counts voting
// sources) a denominator on the same basis as its numerator.
// ---------------------------------------------------------------------------

describe("zoneVotingYieldDenominator", () => {
  it("returns null when health is null (health unknown)", () => {
    expect(zoneVotingYieldDenominator(null, "iktidar")).toBeNull();
    expect(zoneVotingYieldDenominator(null, "bagimsiz")).toBeNull();
    expect(zoneVotingYieldDenominator(null, "muhalefet")).toBeNull();
  });

  it("returns the zone's votingDelivering, not delivering, when health is present", () => {
    const health = mkHealth({});
    expect(zoneVotingYieldDenominator(health, "iktidar")).toBe(4);
    expect(zoneVotingYieldDenominator(health, "iktidar")).toBe(health.iktidar.votingDelivering);
    expect(zoneVotingYieldDenominator(health, "iktidar")).not.toBe(health.iktidar.delivering);
  });

  it("returns a real 0 (not null) for a zone with no delivering voting source", () => {
    const health = mkHealth({ muhalefet: true });
    expect(zoneVotingYieldDenominator(health, "muhalefet")).toBe(0);
  });

  it("reads the evidence fixture: Bağımsız 24 voting of 37 delivering", () => {
    const health = mkHealth({});
    health.bagimsiz = { ...health.bagimsiz, delivering: 37, votingDelivering: 24 };
    expect(zoneVotingYieldDenominator(health, "bagimsiz")).toBe(24);
    expect(zoneYieldDenominator(health, "bagimsiz")).toBe(37);
  });
});

// ---------------------------------------------------------------------------
// shouldSuppressBlindspot (pure)
// ---------------------------------------------------------------------------

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
