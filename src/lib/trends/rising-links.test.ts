import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EntityHub } from "@/lib/entities/entity-hub-query";
import { MAX_ITEMS, type RisingItem, type RisingResult } from "@/lib/trends/rising";

// ---------------------------------------------------------------------------
// linkRisingHubs (h170-roadmap-3): moved out of src/app/trends/page.tsx
// unchanged, so /trends and the home "Yükselen konular" rail settle their links
// the same way. A rising row links to its /gundem hub only when that hub is
// indexable; a thin, empty or unreadable hub links to the home search instead
// (withHubLinks, rising.ts). The hubs are read here, after the rising list is
// known, never inside a "use cache" function.
// ---------------------------------------------------------------------------

let mockHubs: Record<string, unknown> = {};
const reads: string[] = [];

vi.mock("@/lib/entities/entity-hub-query", () => ({
  getEntityHub: vi.fn(async (key: string) => {
    reads.push(key);
    return mockHubs[key] ?? null;
  }),
}));

import { getEntityHub } from "@/lib/entities/entity-hub-query";
import { linkRisingHubs } from "./rising-links";

/** A hub read holding `n` bundles (only the length is read). */
function hubWith(n: number): EntityHub {
  return { bundles: Array.from({ length: n }, () => ({})), total: n, asOfMs: 0 } as unknown as EntityHub;
}

function row(key: string, label: string, over: Partial<RisingItem> = {}): RisingItem {
  return {
    key,
    label,
    href: `/gundem/${key}`,
    count: 30,
    baseline: 5,
    ratio: 6,
    ratioLabel: "6,0",
    ratioIsLowerBound: false,
    isNew: false,
    ...over,
  };
}

function ok(items: RisingItem[], day = "2026-11-05"): RisingResult {
  return { status: "ok", day, items };
}

function hrefs(result: RisingResult | null): string[] {
  if (result === null || result.status !== "ok") throw new Error("expected an ok result");
  return result.items.map((i) => i.href);
}

beforeEach(() => {
  mockHubs = {};
  reads.length = 0;
  vi.mocked(getEntityHub).mockClear();
});

describe("linkRisingHubs", () => {
  it.each([
    ["a failed read (null)", null as RisingResult | null],
    ["insufficient history", { status: "insufficient" } as RisingResult],
    ["nothing rising", ok([])],
  ])("returns %s as it is and reads no hub", async (_name, rising) => {
    expect(await linkRisingHubs(rising)).toBe(rising);
    expect(getEntityHub).not.toHaveBeenCalled();
  });

  it("keeps the /gundem link of an indexable hub; a thin, empty or failed hub goes to the home search", async () => {
    mockHubs = { msb: hubWith(9), tcmb: hubWith(1), hamas: hubWith(0) };
    const out = await linkRisingHubs(
      ok([row("msb", "MSB"), row("tcmb", "Merkez Bankası"), row("hamas", "Hamas"), row("meclis", "Meclis")]),
    );
    expect(hrefs(out)).toEqual([
      "/gundem/msb",
      "/?q=Merkez%20Bankas%C4%B1",
      "/?q=Hamas",
      "/?q=Meclis",
    ]);
  });

  it("changes only href: day, order and every other field pass through, and the input is not mutated", async () => {
    const items = [row("tcmb", "Merkez Bankası", { isNew: true, ratioIsLowerBound: true, count: 38 })];
    const input = ok(items, "2026-11-07");
    mockHubs = { tcmb: hubWith(1) };

    const out = await linkRisingHubs(input);

    expect(out).toEqual(ok([{ ...items[0]!, href: "/?q=Merkez%20Bankas%C4%B1" }], "2026-11-07"));
    expect(items[0]!.href).toBe("/gundem/tcmb");
  });

  it("reads one hub per row, and only after being handed the list", async () => {
    await linkRisingHubs(ok([row("msb", "MSB"), row("tcmb", "Merkez Bankası")]));
    expect([...reads].sort()).toEqual(["msb", "tcmb"]);
  });

  it("reads at most MAX_ITEMS hubs and returns at most MAX_ITEMS rows", async () => {
    expect(MAX_ITEMS).toBe(8);
    const out = await linkRisingHubs(
      ok(Array.from({ length: 12 }, (_, i) => row(`k${i}`, `Konu ${i}`))),
    );
    expect(getEntityHub).toHaveBeenCalledTimes(MAX_ITEMS);
    expect(vi.mocked(getEntityHub).mock.calls.map((c) => c[0])).toEqual(
      Array.from({ length: MAX_ITEMS }, (_, i) => `k${i}`),
    );
    expect(hrefs(out)).toHaveLength(MAX_ITEMS);
  });

  it("a rejected hub read rejects the call (the caller owns the catch)", async () => {
    vi.mocked(getEntityHub).mockRejectedValueOnce(new Error("db down"));
    await expect(linkRisingHubs(ok([row("msb", "MSB")]))).rejects.toThrow("db down");
  });
});

describe("rising-links.ts: source guard", () => {
  // getEntityHub is a resolveCachedOrRetry getter: its live retry awaits connection(), which throws
  // inside a cache body and fails `next build` (tests/guards/cache-retry-prerender.test.ts). A cache
  // directive at the start of a line would put every hub read of this file inside one.
  it("carries no cache directive of its own", () => {
    const src = readFileSync(resolve(__dirname, "rising-links.ts"), "utf8");
    expect(/^[ \t]*["']use cache/m.test(src)).toBe(false);
  });
});
