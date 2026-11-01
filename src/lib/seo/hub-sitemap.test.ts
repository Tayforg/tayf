import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// src/lib/seo/hub-sitemap.ts -- /sitemaps/hubs.xml, the sitemap of the
// /gundem/<key> hubs that the page itself leaves indexable (>= 3 bundles).
// getEntityHub is mocked: its Supabase round-trips and cache window are covered
// by src/lib/entities/entity-hub-query.test.ts; this file pins what the
// sitemap does with the 62 results.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  getEntityHub: vi.fn(),
}));

vi.mock("@/lib/entities/entity-hub-query", () => ({
  getEntityHub: mocks.getEntityHub,
}));

import { ENTITY_HUB_MIN_INDEXABLE } from "@/lib/entities/entity-hub";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";
import { HUB_SITEMAP_CONCURRENCY, getHubsSitemapXml } from "./hub-sitemap";
import { renderUrlset } from "./sitemaps";

const BASE = "https://tayf.test";

type Bundle = { cluster: { id: string; first_published?: unknown } };
interface HubResult {
  bundles: Bundle[];
  total: number;
  asOfMs: number;
}

/** A hub read with `count` bundles; `published[i]` is bundle i's first_published. */
function hub(count: number, published: readonly unknown[] = []): HubResult {
  return {
    bundles: Array.from({ length: count }, (_, i) => ({
      cluster: { id: `c${i}`, first_published: published[i] },
    })),
    total: count,
    asOfMs: 0,
  };
}

/** Routes getEntityHub by key; every key not listed resolves to an empty hub. */
function serve(byKey: Record<string, HubResult | null>): void {
  mocks.getEntityHub.mockImplementation((key: string) =>
    Promise.resolve(key in byKey ? byKey[key] : hub(0)),
  );
}

const key = (i: number): string => RISING_ENTITIES[i]!.key;
const locs = (xml: string): string[] =>
  [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]!);
const lastmods = (xml: string): string[] =>
  [...xml.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)].map((m) => m[1]!);
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  mocks.getEntityHub.mockReset();
});

describe("getHubsSitemapXml: which hubs are listed", () => {
  it("lists only hubs with >= ENTITY_HUB_MIN_INDEXABLE bundles, in RISING_ENTITIES order", async () => {
    expect(ENTITY_HUB_MIN_INDEXABLE).toBe(3);
    serve({
      [key(0)]: hub(3),
      [key(1)]: hub(2), // thin
      [key(2)]: hub(20),
      [key(3)]: hub(0), // empty
      [key(4)]: hub(ENTITY_HUB_MIN_INDEXABLE), // boundary
      [key(RISING_ENTITIES.length - 1)]: hub(4),
    });

    const xml = await getHubsSitemapXml(BASE);

    expect(locs(xml)).toEqual([
      `${BASE}/gundem/${key(0)}`,
      `${BASE}/gundem/${key(2)}`,
      `${BASE}/gundem/${key(4)}`,
      `${BASE}/gundem/${key(RISING_ENTITIES.length - 1)}`,
    ]);
  });

  it("keeps RISING_ENTITIES order even when each wave of reads settles in reverse", async () => {
    let wave: Array<() => void> = [];
    mocks.getEntityHub.mockImplementation(
      () =>
        new Promise<HubResult>((resolve) => {
          wave.push(() => resolve(hub(3)));
        }),
    );

    const pending = getHubsSitemapXml(BASE);
    for (let guard = 0; guard < RISING_ENTITIES.length + 2; guard += 1) {
      await tick();
      const settling = wave.reverse();
      wave = [];
      for (const settle of settling) settle();
    }
    const xml = await pending;

    expect(locs(xml)).toEqual(RISING_ENTITIES.map((e) => `${BASE}/gundem/${e.key}`));
  });

  it("emits <loc> and <lastmod> only (no changefreq or priority) through renderUrlset", async () => {
    serve({ [key(0)]: hub(3, ["2026-10-30T10:00:00.000Z"]) });

    const xml = await getHubsSitemapXml(BASE);

    expect(xml).toBe(
      renderUrlset([
        { loc: `${BASE}/gundem/${key(0)}`, lastmod: "2026-10-30T10:00:00.000Z" },
      ]),
    );
    expect(xml).not.toContain("<changefreq>");
    expect(xml).not.toContain("<priority>");
  });

  it("reads each curated key exactly once", async () => {
    serve({});
    await getHubsSitemapXml(BASE);

    expect(mocks.getEntityHub.mock.calls.map((c) => c[0])).toEqual(
      RISING_ENTITIES.map((e) => e.key),
    );
  });
});

describe("getHubsSitemapXml: lastmod", () => {
  it("is the newest bundle first_published", async () => {
    serve({
      [key(0)]: hub(3, [
        "2026-10-01T08:00:00.000Z",
        "2026-10-29T08:00:00.000Z", // newest, in the middle
        "2026-10-15T08:00:00.000Z",
      ]),
    });

    const xml = await getHubsSitemapXml(BASE);

    expect(lastmods(xml)).toEqual(["2026-10-29T08:00:00.000Z"]);
  });

  it("compares by Date.parse, not as strings", async () => {
    // As text "…:00Z" sorts after "…:00.500Z" ('Z' > '.'), but .500 is later.
    serve({
      [key(0)]: hub(3, [
        "2026-10-30T22:00:00Z",
        "2026-10-30T22:00:00.500Z",
        "2026-10-30T21:59:59Z",
      ]),
    });

    const xml = await getHubsSitemapXml(BASE);

    expect(lastmods(xml)).toEqual(["2026-10-30T22:00:00.500Z"]);
  });

  it("skips unparseable timestamps and still picks the newest parseable one", async () => {
    serve({
      [key(0)]: hub(4, [
        "not-a-date",
        undefined,
        "2026-10-02T00:00:00.000Z",
        null,
      ]),
    });

    const xml = await getHubsSitemapXml(BASE);

    expect(lastmods(xml)).toEqual(["2026-10-02T00:00:00.000Z"]);
  });

  it("is omitted when no bundle timestamp parses, but the hub is still listed", async () => {
    serve({ [key(0)]: hub(3, ["", "garbage", undefined]) });

    const xml = await getHubsSitemapXml(BASE);

    expect(locs(xml)).toEqual([`${BASE}/gundem/${key(0)}`]);
    expect(xml).not.toContain("<lastmod>");
  });

  it("is per hub", async () => {
    serve({
      [key(0)]: hub(3, ["2026-10-01T00:00:00.000Z"]),
      [key(1)]: hub(3, ["2026-10-20T00:00:00.000Z"]),
    });

    const xml = await getHubsSitemapXml(BASE);

    expect(lastmods(xml)).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-10-20T00:00:00.000Z",
    ]);
  });
});

describe("getHubsSitemapXml: failed reads", () => {
  it("rejects when one hub read failed (null) -- never a partial urlset", async () => {
    serve({ [key(0)]: hub(5), [key(3)]: null, [key(4)]: hub(5) });

    await expect(getHubsSitemapXml(BASE)).rejects.toThrow(
      "hubs sitemap: hub read failed",
    );
  });

  it("reports how many reads of the failing batch failed", async () => {
    serve({ [key(0)]: null, [key(1)]: null, [key(2)]: null });

    await expect(getHubsSitemapXml(BASE)).rejects.toThrow(
      `hubs sitemap: hub read failed (3 of ${HUB_SITEMAP_CONCURRENCY} in the batch at 0)`,
    );
  });

  it("rejects when every read failed -- never an empty urlset", async () => {
    mocks.getEntityHub.mockResolvedValue(null);

    await expect(getHubsSitemapXml(BASE)).rejects.toThrow(
      "hubs sitemap: hub read failed",
    );
  });

  it("a failed read of a thin-looking key still rejects (null is not 'empty')", async () => {
    serve({ [key(0)]: null });

    await expect(getHubsSitemapXml(BASE)).rejects.toBeInstanceOf(Error);
  });

  it("propagates a rejected read instead of swallowing it", async () => {
    mocks.getEntityHub.mockRejectedValue(new Error("boom"));

    await expect(getHubsSitemapXml(BASE)).rejects.toThrow("boom");
  });

  // getEntityHub resolves null only after a live retry against the reader, so a
  // request that keeps reading past the first failure multiplies the load on a
  // struggling database (up to 62 retry chains per GET; the 503 is no-store and
  // a changing query string defeats the CDN). The first batch with a failure
  // must therefore be the last batch started.
  describe("fails fast: no further batch starts once a read failed", () => {
    it("a failure in the first batch stops after exactly one batch", async () => {
      serve({ [key(0)]: null });

      await expect(getHubsSitemapXml(BASE)).rejects.toThrow("hubs sitemap: hub read failed");

      expect(mocks.getEntityHub).toHaveBeenCalledTimes(HUB_SITEMAP_CONCURRENCY);
      expect(mocks.getEntityHub.mock.calls.map((c) => c[0])).toEqual(
        RISING_ENTITIES.slice(0, HUB_SITEMAP_CONCURRENCY).map((e) => e.key),
      );
    });

    it("every read failing (an outage) costs one batch, not all keys", async () => {
      mocks.getEntityHub.mockResolvedValue(null);

      await expect(getHubsSitemapXml(BASE)).rejects.toBeInstanceOf(Error);

      expect(mocks.getEntityHub).toHaveBeenCalledTimes(HUB_SITEMAP_CONCURRENCY);
      expect(HUB_SITEMAP_CONCURRENCY).toBeLessThan(RISING_ENTITIES.length);
    });

    it("a rejected read in the first batch also stops after one batch", async () => {
      mocks.getEntityHub.mockRejectedValue(new Error("boom"));

      await expect(getHubsSitemapXml(BASE)).rejects.toThrow("boom");
      await tick();

      expect(mocks.getEntityHub).toHaveBeenCalledTimes(HUB_SITEMAP_CONCURRENCY);
    });

    it("a failure in the second batch stops after two batches", async () => {
      serve({ [key(HUB_SITEMAP_CONCURRENCY + 1)]: null });

      await expect(getHubsSitemapXml(BASE)).rejects.toThrow(
        `(1 of ${HUB_SITEMAP_CONCURRENCY} in the batch at ${HUB_SITEMAP_CONCURRENCY})`,
      );

      expect(mocks.getEntityHub).toHaveBeenCalledTimes(2 * HUB_SITEMAP_CONCURRENCY);
    });

    it("a failure in the very last key still rejects after reading every key once", async () => {
      serve({ [key(RISING_ENTITIES.length - 1)]: null });

      await expect(getHubsSitemapXml(BASE)).rejects.toThrow("hubs sitemap: hub read failed");

      expect(mocks.getEntityHub).toHaveBeenCalledTimes(RISING_ENTITIES.length);
    });

    it("never starts the next batch while the failing batch is still settling", async () => {
      const release: Array<() => void> = [];
      mocks.getEntityHub.mockImplementation(
        (k: string) =>
          new Promise<HubResult | null>((resolve) => {
            release.push(() => resolve(k === key(2) ? null : hub(3)));
          }),
      );

      const done = getHubsSitemapXml(BASE);
      const settled = expect(done).rejects.toThrow("hubs sitemap: hub read failed");
      await tick();
      expect(mocks.getEntityHub).toHaveBeenCalledTimes(HUB_SITEMAP_CONCURRENCY);

      for (const r of release.splice(0)) r();
      await settled;
      await tick();

      expect(mocks.getEntityHub).toHaveBeenCalledTimes(HUB_SITEMAP_CONCURRENCY);
    });
  });
});

describe("getHubsSitemapXml: all reads OK, nothing indexable", () => {
  it("returns a valid empty urlset", async () => {
    serve({ [key(0)]: hub(2), [key(1)]: hub(0) });

    const xml = await getHubsSitemapXml(BASE);

    expect(xml).toBe(renderUrlset([]));
    expect(xml).toContain("<urlset");
    expect(xml).not.toContain("<url>");
  });
});

describe("getHubsSitemapXml: concurrency", () => {
  it("exports a concurrency of 8", () => {
    expect(HUB_SITEMAP_CONCURRENCY).toBe(8);
  });

  it("reads every hub with at most HUB_SITEMAP_CONCURRENCY in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const pending: Array<() => void> = [];
    mocks.getEntityHub.mockImplementation(() => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<HubResult>((resolve) => {
        pending.push(() => {
          inFlight -= 1;
          resolve(hub(3));
        });
      });
    });

    const done = getHubsSitemapXml(BASE);

    await tick();
    // Parallel, not serial: the first wave is exactly one full chunk.
    expect(calls).toBe(HUB_SITEMAP_CONCURRENCY);
    expect(inFlight).toBe(HUB_SITEMAP_CONCURRENCY);

    let waves = 1;
    while (calls < RISING_ENTITIES.length || pending.length > 0) {
      const wave = pending.splice(0, pending.length);
      for (const release of wave) release();
      await tick();
      waves += 1;
      expect(waves).toBeLessThan(RISING_ENTITIES.length + 2);
    }
    const xml = await done;

    expect(calls).toBe(RISING_ENTITIES.length);
    expect(maxInFlight).toBeLessThanOrEqual(HUB_SITEMAP_CONCURRENCY);
    expect(locs(xml)).toHaveLength(RISING_ENTITIES.length);
  });
});

describe("getHubsSitemapXml: escaping", () => {
  it("escapes loc through renderUrlset", async () => {
    serve({ [key(0)]: hub(3) });

    const xml = await getHubsSitemapXml("https://tayf.test/?a=1&b=<2>");

    expect(xml).toContain(`https://tayf.test/?a=1&amp;b=&lt;2&gt;/gundem/${key(0)}`);
    expect(xml).not.toContain("&b=");
    expect(xml).not.toContain("<2>");
  });

  it("matches renderUrlset byte for byte", async () => {
    serve({ [key(5)]: hub(3, ["2026-10-30T10:00:00Z"]) });

    expect(await getHubsSitemapXml(BASE)).toBe(
      renderUrlset([
        { loc: `${BASE}/gundem/${key(5)}`, lastmod: "2026-10-30T10:00:00Z" },
      ]),
    );
  });
});
