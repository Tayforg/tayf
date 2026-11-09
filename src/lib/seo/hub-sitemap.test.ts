import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// src/lib/seo/hub-sitemap.ts -- /sitemaps/hubs.xml, the sitemap of the
// /gundem/<key> hubs that the page itself leaves indexable (>= 3 bundles).
//
// h94-slowroutes-1: the sitemap used to build all 62 full hubs (getEntityHub: the
// entity_cluster_ids_v3 RPC plus a CLUSTER_EMBED_SELECT of up to 20 clusters
// each) only to read entityHubRobots(bundles) and the newest first_published. It
// now reads getEntityHubSummary, whose indexableCount is the full read's
// bundles.length and whose newestFirstPublished is the newest bundle's
// first_published. getEntityHubSummary is mocked here: its Supabase round-trips,
// its cache window and its parity with the full read are covered by
// src/lib/entities/entity-hub-query.test.ts; this file pins what the sitemap does
// with the 62 summaries, and that it never reads a full hub (getEntityHub is
// mocked too, and must stay uncalled).
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  getEntityHub: vi.fn(),
  getEntityHubSummary: vi.fn(),
}));

vi.mock("@/lib/entities/entity-hub-query", () => ({
  getEntityHub: mocks.getEntityHub,
  getEntityHubSummary: mocks.getEntityHubSummary,
}));

import { ENTITY_HUB_MIN_INDEXABLE, entityHubRobots } from "@/lib/entities/entity-hub";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";
import {
  HUB_SITEMAP_CONCURRENCY,
  getHubsSitemapXml,
  readAllEntityHubSummaries,
} from "./hub-sitemap";
import { renderUrlset } from "./sitemaps";

const BASE = "https://tayf.test";

interface SummaryResult {
  total: number;
  indexableCount: number;
  newestFirstPublished: string | null;
  asOfMs: number;
}

/** A hub summary with `count` indexable clusters and the given newest first_published. */
function hub(count: number, newest: string | null = null): SummaryResult {
  return { total: count, indexableCount: count, newestFirstPublished: newest, asOfMs: 0 };
}

/** Routes getEntityHubSummary by key; every key not listed resolves to an empty hub. */
function serve(byKey: Record<string, SummaryResult | null>): void {
  mocks.getEntityHubSummary.mockImplementation((key: string) =>
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
  mocks.getEntityHubSummary.mockReset();
  mocks.getEntityHubSummary.mockReset();
});

describe("getHubsSitemapXml: which hubs are listed", () => {
  it("lists only hubs with >= ENTITY_HUB_MIN_INDEXABLE indexable clusters, in RISING_ENTITIES order", async () => {
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

  // entityHubRobots parity: /gundem/<key> is noindex exactly when
  // entityHubRobots(fullHub) says so, and the full read's bundles.length equals
  // the summary's indexableCount (entity-hub-query.test.ts pins that). So the
  // sitemap lists a hub iff the page's own predicate leaves it indexable.
  it.each([0, 1, 2, 3, 4, 5, 20])(
    "indexableCount %i: listed exactly when entityHubRobots leaves the full page indexable",
    async (count) => {
      serve({ [key(0)]: hub(count) });

      const xml = await getHubsSitemapXml(BASE);

      const pageIsIndexable =
        entityHubRobots({ bundles: Array.from({ length: count }) }) === undefined;
      expect(locs(xml).includes(`${BASE}/gundem/${key(0)}`)).toBe(pageIsIndexable);
      expect(pageIsIndexable).toBe(count >= ENTITY_HUB_MIN_INDEXABLE);
    },
  );

  it("a hub whose total is large but has too few indexable clusters stays out (the page's robots read bundles, not the total)", async () => {
    serve({
      [key(0)]: { total: 400, indexableCount: 2, newestFirstPublished: null, asOfMs: 0 },
      [key(1)]: { total: 3, indexableCount: 3, newestFirstPublished: null, asOfMs: 0 },
    });

    const xml = await getHubsSitemapXml(BASE);

    expect(locs(xml)).toEqual([`${BASE}/gundem/${key(1)}`]);
  });

  it("keeps RISING_ENTITIES order even when each wave of reads settles in reverse", async () => {
    let wave: Array<() => void> = [];
    mocks.getEntityHubSummary.mockImplementation(
      () =>
        new Promise<SummaryResult>((resolve) => {
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
    serve({ [key(0)]: hub(3, "2026-10-30T10:00:00.000Z") });

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

    expect(mocks.getEntityHubSummary.mock.calls.map((c) => c[0])).toEqual(
      RISING_ENTITIES.map((e) => e.key),
    );
  });
});

// The point of h94-slowroutes-1: the sitemap reads the light summary of every
// hub and never a full one, so no CLUSTER_EMBED_SELECT runs behind hubs.xml.
describe("getHubsSitemapXml: no full hub read", () => {
  it("never calls getEntityHub (the embed-backed full read), on success", async () => {
    serve({ [key(0)]: hub(5, "2026-10-30T10:00:00.000Z") });

    await getHubsSitemapXml(BASE);

    expect(mocks.getEntityHub).not.toHaveBeenCalled();
    expect(mocks.getEntityHubSummary).toHaveBeenCalledTimes(RISING_ENTITIES.length);
  });

  it("never calls getEntityHub on a failed read either", async () => {
    serve({ [key(2)]: null });

    await expect(getHubsSitemapXml(BASE)).rejects.toThrow("hubs sitemap: hub read failed");

    expect(mocks.getEntityHub).not.toHaveBeenCalled();
  });
});

// The urlset the sitemap published BEFORE h94-slowroutes-1, as a reference: list a
// hub when entityHubRobots(bundles) is undefined, lastmod = the newest bundle
// first_published (Date.parse, original string). The new path, fed the summary of
// the same bundles, must publish the same bytes.
describe("getHubsSitemapXml: the urlset and lastmod are identical to the full-read sitemap's", () => {
  type Bundle = { cluster: { first_published?: unknown } };

  function newest(bundles: readonly Bundle[]): string | null {
    let best: { ms: number; raw: string } | null = null;
    for (const b of bundles) {
      const raw = b.cluster.first_published;
      if (typeof raw !== "string") continue;
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) continue;
      if (best === null || ms > best.ms) best = { ms, raw };
    }
    return best === null ? null : best.raw;
  }

  /** The full-read sitemap's decision, per hub, over its bundles. */
  function legacyUrlset(base: string, bundlesByKey: Map<string, Bundle[]>): string {
    const entries: Array<{ loc: string; lastmod?: string }> = [];
    for (const e of RISING_ENTITIES) {
      const bundles = bundlesByKey.get(e.key) ?? [];
      if (entityHubRobots({ bundles }) !== undefined) continue;
      const lastmod = newest(bundles);
      entries.push({ loc: `${base}/gundem/${e.key}`, ...(lastmod !== null ? { lastmod } : {}) });
    }
    return renderUrlset(entries);
  }

  const PUBLISHED: readonly unknown[] = [
    "2026-11-08T21:00:00.000Z",
    "2026-11-09T01:30:00Z",
    "2026-11-09T01:30:00.500Z", // later than the line above, earlier as a string
    "not-a-date",
    undefined,
    null,
    "2026-11-01T00:00:00.000Z",
  ];

  // A mixed fixture: 0..6 bundles per hub, timestamps cycling through PUBLISHED
  // (parseable, sub-second, garbage, missing), including hubs with no parseable
  // timestamp at all.
  function fixtureBundles(): Map<string, Bundle[]> {
    const byKey = new Map<string, Bundle[]>();
    RISING_ENTITIES.forEach((e, i) => {
      const count = (i * 5) % 7;
      byKey.set(
        e.key,
        Array.from({ length: count }, (_, j) => ({
          cluster: {
            first_published: i % 9 === 0 ? PUBLISHED[3 + (j % 3)] : PUBLISHED[(i + j) % PUBLISHED.length],
          },
        })),
      );
    });
    return byKey;
  }

  it("matches byte for byte over all 62 hubs, indexable and thin, with and without a parseable lastmod", async () => {
    const byKey = fixtureBundles();
    mocks.getEntityHubSummary.mockImplementation((k: string) => {
      const bundles = byKey.get(k) ?? [];
      return Promise.resolve({
        total: bundles.length,
        indexableCount: bundles.length,
        newestFirstPublished: newest(bundles),
        asOfMs: 0,
      });
    });

    const xml = await getHubsSitemapXml(BASE);

    const expected = legacyUrlset(BASE, byKey);
    expect(xml).toBe(expected);
    // The fixture is not vacuous: some hubs listed, some left out, some without lastmod.
    expect(locs(xml).length).toBeGreaterThan(10);
    expect(locs(xml).length).toBeLessThan(RISING_ENTITIES.length);
    expect(lastmods(xml).length).toBeGreaterThan(5);
    expect(lastmods(xml).length).toBeLessThan(locs(xml).length);
    expect(lastmods(xml)).toContain("2026-11-09T01:30:00.500Z");
  });

  it("matches the full-read sitemap for a custom base URL too (escaping through renderUrlset)", async () => {
    const byKey = fixtureBundles();
    mocks.getEntityHubSummary.mockImplementation((k: string) => {
      const bundles = byKey.get(k) ?? [];
      return Promise.resolve({
        total: bundles.length,
        indexableCount: bundles.length,
        newestFirstPublished: newest(bundles),
        asOfMs: 0,
      });
    });
    const base = "https://tayf.test/?a=1&b=<2>";

    expect(await getHubsSitemapXml(base)).toBe(legacyUrlset(base, byKey));
  });
});

describe("getHubsSitemapXml: lastmod", () => {
  it("is the summary's newestFirstPublished, verbatim", async () => {
    serve({
      [key(0)]: hub(3, "2026-10-29T08:00:00.000Z"),
      [key(1)]: hub(3, "2026-10-30T22:00:00.500Z"),
      [key(2)]: hub(3, "2026-10-30T22:00:00Z"),
    });

    const xml = await getHubsSitemapXml(BASE);

    expect(lastmods(xml)).toEqual([
      "2026-10-29T08:00:00.000Z",
      "2026-10-30T22:00:00.500Z",
      "2026-10-30T22:00:00Z",
    ]);
  });

  it("is omitted when the summary has none (no timestamp parsed), but the hub is still listed", async () => {
    serve({ [key(0)]: hub(3, null) });

    const xml = await getHubsSitemapXml(BASE);

    expect(locs(xml)).toEqual([`${BASE}/gundem/${key(0)}`]);
    expect(xml).not.toContain("<lastmod>");
  });

  it("is per hub", async () => {
    serve({
      [key(0)]: hub(3, "2026-10-01T00:00:00.000Z"),
      [key(1)]: hub(3, "2026-10-20T00:00:00.000Z"),
    });

    const xml = await getHubsSitemapXml(BASE);

    expect(lastmods(xml)).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-10-20T00:00:00.000Z",
    ]);
  });

  it("is not printed for a hub that is left out, however new its newest cluster", async () => {
    serve({ [key(0)]: hub(2, "2026-11-09T00:00:00.000Z") });

    const xml = await getHubsSitemapXml(BASE);

    expect(locs(xml)).toEqual([]);
    expect(xml).not.toContain("<lastmod>");
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
    mocks.getEntityHubSummary.mockResolvedValue(null);

    await expect(getHubsSitemapXml(BASE)).rejects.toThrow(
      "hubs sitemap: hub read failed",
    );
  });

  it("a failed read of a thin-looking key still rejects (null is not 'empty')", async () => {
    serve({ [key(0)]: null });

    await expect(getHubsSitemapXml(BASE)).rejects.toBeInstanceOf(Error);
  });

  it("propagates a rejected read instead of swallowing it", async () => {
    mocks.getEntityHubSummary.mockRejectedValue(new Error("boom"));

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

      expect(mocks.getEntityHubSummary).toHaveBeenCalledTimes(HUB_SITEMAP_CONCURRENCY);
      expect(mocks.getEntityHubSummary.mock.calls.map((c) => c[0])).toEqual(
        RISING_ENTITIES.slice(0, HUB_SITEMAP_CONCURRENCY).map((e) => e.key),
      );
    });

    it("every read failing (an outage) costs one batch, not all keys", async () => {
      mocks.getEntityHubSummary.mockResolvedValue(null);

      await expect(getHubsSitemapXml(BASE)).rejects.toBeInstanceOf(Error);

      expect(mocks.getEntityHubSummary).toHaveBeenCalledTimes(HUB_SITEMAP_CONCURRENCY);
      expect(HUB_SITEMAP_CONCURRENCY).toBeLessThan(RISING_ENTITIES.length);
    });

    it("a rejected read in the first batch also stops after one batch", async () => {
      mocks.getEntityHubSummary.mockRejectedValue(new Error("boom"));

      await expect(getHubsSitemapXml(BASE)).rejects.toThrow("boom");
      await tick();

      expect(mocks.getEntityHubSummary).toHaveBeenCalledTimes(HUB_SITEMAP_CONCURRENCY);
    });

    it("a failure in the second batch stops after two batches", async () => {
      serve({ [key(HUB_SITEMAP_CONCURRENCY + 1)]: null });

      await expect(getHubsSitemapXml(BASE)).rejects.toThrow(
        `(1 of ${HUB_SITEMAP_CONCURRENCY} in the batch at ${HUB_SITEMAP_CONCURRENCY})`,
      );

      expect(mocks.getEntityHubSummary).toHaveBeenCalledTimes(2 * HUB_SITEMAP_CONCURRENCY);
    });

    it("a failure in the very last key still rejects after reading every key once", async () => {
      serve({ [key(RISING_ENTITIES.length - 1)]: null });

      await expect(getHubsSitemapXml(BASE)).rejects.toThrow("hubs sitemap: hub read failed");

      expect(mocks.getEntityHubSummary).toHaveBeenCalledTimes(RISING_ENTITIES.length);
    });

    it("never starts the next batch while the failing batch is still settling", async () => {
      const release: Array<() => void> = [];
      mocks.getEntityHubSummary.mockImplementation(
        (k: string) =>
          new Promise<SummaryResult | null>((resolve) => {
            release.push(() => resolve(k === key(2) ? null : hub(3)));
          }),
      );

      const done = getHubsSitemapXml(BASE);
      const settled = expect(done).rejects.toThrow("hubs sitemap: hub read failed");
      await tick();
      expect(mocks.getEntityHubSummary).toHaveBeenCalledTimes(HUB_SITEMAP_CONCURRENCY);

      for (const r of release.splice(0)) r();
      await settled;
      await tick();

      expect(mocks.getEntityHubSummary).toHaveBeenCalledTimes(HUB_SITEMAP_CONCURRENCY);
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
    mocks.getEntityHubSummary.mockImplementation(() => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<SummaryResult>((resolve) => {
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
    serve({ [key(5)]: hub(3, "2026-10-30T10:00:00Z") });

    expect(await getHubsSitemapXml(BASE)).toBe(
      renderUrlset([
        { loc: `${BASE}/gundem/${key(5)}`, lastmod: "2026-10-30T10:00:00Z" },
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// readAllEntityHubSummaries (h43-entities-3, now over the light summaries): the
// chunked read of every hub, shared by the sitemap builder above and the /gundem
// index. It returns what was read (a null stays a null) and leaves the policy to
// the caller: the sitemap throws, the index fails open to its static list.
// ---------------------------------------------------------------------------

describe("readAllEntityHubSummaries", () => {
  it("returns a Map of every curated key to its summary, in RISING_ENTITIES order", async () => {
    serve({ [key(0)]: hub(3), [key(1)]: hub(0), [key(5)]: hub(17, "2026-10-30T10:00:00Z") });

    const hubs = await readAllEntityHubSummaries();

    expect(hubs).toBeInstanceOf(Map);
    expect([...hubs.keys()]).toEqual(RISING_ENTITIES.map((e) => e.key));
    expect(hubs.get(key(0))).toEqual(hub(3));
    expect(hubs.get(key(1))).toEqual(hub(0));
    expect(hubs.get(key(5))?.total).toBe(17);
    expect(hubs.get(key(5))?.newestFirstPublished).toBe("2026-10-30T10:00:00Z");
  });

  it("reads each key exactly once, in chunks of HUB_SITEMAP_CONCURRENCY, and never a full hub", async () => {
    serve({});
    await readAllEntityHubSummaries();

    expect(mocks.getEntityHubSummary.mock.calls.map((c) => c[0])).toEqual(
      RISING_ENTITIES.map((e) => e.key),
    );
    expect(mocks.getEntityHub).not.toHaveBeenCalled();
  });

  it("keeps a failed read as null instead of throwing", async () => {
    serve({ [key(3)]: null });

    const hubs = await readAllEntityHubSummaries();

    expect(hubs.get(key(3))).toBeNull();
    expect(hubs.has(key(3))).toBe(true);
  });

  it("fails fast: the first batch holding a null is the last batch started", async () => {
    serve({ [key(HUB_SITEMAP_CONCURRENCY + 1)]: null });

    const hubs = await readAllEntityHubSummaries();

    expect(mocks.getEntityHubSummary).toHaveBeenCalledTimes(2 * HUB_SITEMAP_CONCURRENCY);
    // The keys of the two batches that were read are present; later ones are absent.
    expect(hubs.size).toBe(2 * HUB_SITEMAP_CONCURRENCY);
    expect(hubs.has(key(2 * HUB_SITEMAP_CONCURRENCY))).toBe(false);
    expect(hubs.get(key(HUB_SITEMAP_CONCURRENCY + 1))).toBeNull();
  });

  it("an outage (every read null) costs one batch, not all keys", async () => {
    mocks.getEntityHubSummary.mockResolvedValue(null);

    const hubs = await readAllEntityHubSummaries();

    expect(mocks.getEntityHubSummary).toHaveBeenCalledTimes(HUB_SITEMAP_CONCURRENCY);
    expect([...hubs.values()].every((h) => h === null)).toBe(true);
  });

  it("propagates a rejected read", async () => {
    mocks.getEntityHubSummary.mockRejectedValue(new Error("boom"));

    await expect(readAllEntityHubSummaries()).rejects.toThrow("boom");
  });
});
