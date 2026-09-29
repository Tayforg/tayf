import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: null as unknown,
  error: null as { message: string } | null,
  calls: 0,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      source_karne_30d: () => {
        fixture.calls += 1;
        return { data: fixture.data, error: fixture.error };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import {
  KARNE_MIN_CLUSTERS,
  KARNE_MIN_MULTI_FOR_ZONES,
  KARNE_WINDOW_DAYS,
  buildKarneView,
  getSourceKarne,
  pct,
  toSourceKarne,
  type SourceKarne,
} from "./karne";

const ID = "9236e05a-56d9-47b0-a378-02ec8e880180";

function raw(over: Record<string, unknown> = {}) {
  return {
    source_id: ID,
    window_days: 30,
    window_start: "2026-08-30T00:00:00Z",
    window_end: "2026-09-29T00:00:00Z",
    n_clusters: 100,
    n_multi: 60,
    co_iktidar: 40,
    co_bagimsiz: 30,
    co_muhalefet: 20,
    n_blindspot: 5,
    n_blindspot_same_side: 2,
    computed_at: "2026-09-29T00:00:00Z",
    ...over,
  };
}

function karne(over: Partial<SourceKarne> = {}): SourceKarne {
  return { ...toSourceKarne(raw())!, ...over };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = null;
  fixture.error = null;
  fixture.calls = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("constants", () => {
  it("pins the thresholds", () => {
    expect(KARNE_WINDOW_DAYS).toBe(30);
    expect(KARNE_MIN_CLUSTERS).toBe(20);
    expect(KARNE_MIN_MULTI_FOR_ZONES).toBe(10);
  });
});

describe("toSourceKarne", () => {
  it("maps a valid row and derives nSolo", () => {
    const k = toSourceKarne(raw())!;
    expect(k).toMatchObject({
      windowDays: 30,
      nClusters: 100,
      nMulti: 60,
      nSolo: 40,
      co: { iktidar: 40, bagimsiz: 30, muhalefet: 20 },
      nBlindspot: 5,
      nBlindspotSameSide: 2,
      windowStart: "2026-08-30T00:00:00Z",
      windowEnd: "2026-09-29T00:00:00Z",
      computedAt: "2026-09-29T00:00:00Z",
    });
  });

  it.each([
    ["null", null],
    ["string", "x"],
    ["negative count", raw({ n_clusters: -1 })],
    ["NaN", raw({ n_multi: Number.NaN })],
    ["non-integer", raw({ n_multi: 1.5 })],
    ["string count", raw({ n_multi: "3" })],
    ["nMulti > nClusters", raw({ n_multi: 101 })],
    ["co > nMulti", raw({ co_iktidar: 61 })],
    ["same-side > blindspot", raw({ n_blindspot_same_side: 6 })],
    ["missing dates", raw({ window_start: null })],
  ])("rejects %s", (_n, input) => {
    expect(toSourceKarne(input)).toBeNull();
  });
});

describe("pct", () => {
  it("rounds and handles den = 0", () => {
    expect(pct(1, 3)).toBe(33);
    expect(pct(2, 3)).toBe(67);
    expect(pct(0, 0)).toBeNull();
    expect(pct(5, 0)).toBeNull();
  });
});

describe("buildKarneView", () => {
  it("is insufficient at 19 and ok at 20", () => {
    expect(buildKarneView(karne({ nClusters: 19, nMulti: 5, nSolo: 14 }))).toEqual({
      state: "insufficient",
      n: 19,
    });
    expect(
      buildKarneView(karne({ nClusters: 20, nMulti: 10, nSolo: 10 })).state,
    ).toBe("ok");
  });

  it("hides zones at nMulti = 9 and shows them at 10", () => {
    const co = { iktidar: 1, bagimsiz: 1, muhalefet: 1 };
    const low = buildKarneView(karne({ nClusters: 30, nMulti: 9, nSolo: 21, co }));
    const high = buildKarneView(karne({ nClusters: 30, nMulti: 10, nSolo: 20, co }));
    expect(low.state === "ok" && low.zones).toBeNull();
    expect(high.state === "ok" && high.zones).not.toBeNull();
  });

  it("rounds percentages (1/3 gives %33) and orders zones by spectrum", () => {
    const v = buildKarneView(
      karne({
        nClusters: 30,
        nMulti: 10,
        nSolo: 20,
        co: { iktidar: 3, bagimsiz: 5, muhalefet: 10 },
      }),
    );
    if (v.state !== "ok") throw new Error("expected ok");
    expect(v.multiText).toBe("%33 (10/30)");
    expect(v.soloText).toBe("%67 (20/30)");
    expect(v.zones!.map((z) => z.zone)).toEqual(["iktidar", "bagimsiz", "muhalefet"]);
    expect(v.zones!.map((z) => z.text)).toEqual(["%30 (3/10)", "%50 (5/10)", "%100 (10/10)"]);
  });

  it("appends the same-side clause only when nBlindspot > 0", () => {
    const some = buildKarneView(karne({ nBlindspot: 4, nBlindspotSameSide: 1 }));
    const none = buildKarneView(karne({ nBlindspot: 0, nBlindspotSameSide: 0 }));
    if (some.state !== "ok" || none.state !== "ok") throw new Error("expected ok");
    expect(some.blindspotText).toBe(
      "Kör nokta işaretli haberler: 4 · 1 tanesinde haberi ağırlıkla yazan bölgedeydi",
    );
    expect(none.blindspotText).toBe("Kör nokta işaretli haberler: 0");
  });
});

describe("getSourceKarne", () => {
  it("maps a hit", async () => {
    fixture.data = raw();
    const k = await getSourceKarne(ID);
    expect(k?.nClusters).toBe(100);
    expect(fixture.calls).toBeGreaterThan(0);
  });

  it("returns null for a missing row", async () => {
    fixture.data = null;
    expect(await getSourceKarne(ID)).toBeNull();
  });

  it("returns null for an inconsistent row", async () => {
    fixture.data = raw({ n_multi: 999 });
    expect(await getSourceKarne(ID)).toBeNull();
  });

  it("returns null and does not throw when both cache attempt and retry fail", async () => {
    fixture.error = { message: "boom" };
    await expect(getSourceKarne(ID)).resolves.toBeNull();
    expect(fixture.calls).toBe(2);
  });

  it("returns null for a non-uuid id without touching the DB", async () => {
    expect(await getSourceKarne("not-a-uuid")).toBeNull();
    expect(await getSourceKarne("")).toBeNull();
    expect(fixture.calls).toBe(0);
  });
});
