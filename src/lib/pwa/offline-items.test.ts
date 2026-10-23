import { describe, expect, it, vi } from "vitest";

import { readOfflineItems, sortOfflineItems, toOfflineItem, type OfflineItem } from "./offline-items";

const ID_A = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";
const ID_B = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
const ID_C = "0c9d8e7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f";
const ORIGIN = "https://tayf.example";
const FALLBACK = "Kaydedilen hikâye";

function headers(h: { title?: string; at?: string } = {}) {
  const out = new Headers();
  if (h.title !== undefined) out.set("x-tayf-title", h.title);
  if (h.at !== undefined) out.set("x-tayf-cached-at", h.at);
  return out;
}

const item = (id: string, cachedAt: string | null): OfflineItem => ({
  id,
  href: `/cluster/${id}`,
  title: id,
  cachedAt,
});

describe("toOfflineItem", () => {
  it("round-trips a URI-encoded Turkish title and the cached-at stamp", () => {
    const title = "Erdoğan'ın açıklaması: İstanbul'da çok önemli bir gün";
    const at = "2026-10-01T10:00:00.000Z";
    expect(
      toOfflineItem(`${ORIGIN}/cluster/${ID_A}`, headers({ title: encodeURIComponent(title), at })),
    ).toEqual({ id: ID_A, href: `/cluster/${ID_A}`, title, cachedAt: at });
  });

  it("lowercases the id and ignores a query string", () => {
    const out = toOfflineItem(`${ORIGIN}/cluster/${ID_A.toUpperCase()}?utm=1`, headers());
    expect(out?.id).toBe(ID_A);
    expect(out?.href).toBe(`/cluster/${ID_A}`);
  });

  it("returns null for anything that is not /cluster/<uuid>", () => {
    for (const url of [
      `${ORIGIN}/offline`,
      `${ORIGIN}/`,
      `${ORIGIN}/cluster/not-a-uuid`,
      `${ORIGIN}/cluster/${ID_A}/extra`,
      `${ORIGIN}/cluster/${ID_A}/`,
      `${ORIGIN}/x/cluster/${ID_A}`,
      `${ORIGIN}/konu/${ID_A}`,
      "not a url at all",
      "",
    ]) {
      expect(toOfflineItem(url, headers({ title: "x" })), url).toBeNull();
    }
  });

  it("falls back for a missing, empty or whitespace title", () => {
    const url = `${ORIGIN}/cluster/${ID_A}`;
    expect(toOfflineItem(url, headers())?.title).toBe(FALLBACK);
    expect(toOfflineItem(url, headers({ title: "" }))?.title).toBe(FALLBACK);
    expect(toOfflineItem(url, headers({ title: encodeURIComponent("   ") }))?.title).toBe(FALLBACK);
  });

  it("falls back for a malformed percent-encoding instead of throwing", () => {
    const out = toOfflineItem(`${ORIGIN}/cluster/${ID_A}`, headers({ title: "%E0%A4%A" }));
    expect(out?.title).toBe(FALLBACK);
  });

  it("trims the title and caps it at 200 characters", () => {
    const url = `${ORIGIN}/cluster/${ID_A}`;
    expect(toOfflineItem(url, headers({ title: encodeURIComponent("  Başlık  ") }))?.title).toBe(
      "Başlık",
    );
    const long = toOfflineItem(url, headers({ title: encodeURIComponent("ş".repeat(300)) }));
    expect(long?.title).toHaveLength(200);
  });

  it("does not split a surrogate pair when capping", () => {
    const url = `${ORIGIN}/cluster/${ID_A}`;
    const out = toOfflineItem(url, headers({ title: encodeURIComponent("😀".repeat(250)) }));
    expect([...(out?.title ?? "")]).toHaveLength(200);
  });

  it("gives cachedAt null for a bad or absent date", () => {
    const url = `${ORIGIN}/cluster/${ID_A}`;
    expect(toOfflineItem(url, headers({ at: "yesterday-ish" }))?.cachedAt).toBeNull();
    expect(toOfflineItem(url, headers({ at: "" }))?.cachedAt).toBeNull();
    expect(toOfflineItem(url, headers())?.cachedAt).toBeNull();
  });
});

describe("sortOfflineItems", () => {
  it("orders newest first, nulls last, stable for ties", () => {
    const t1 = "2026-10-01T10:00:00.000Z";
    const t2 = "2026-10-02T10:00:00.000Z";
    const input = [
      item("n1", null),
      item("old", t1),
      item("tie1", t2),
      item("n2", null),
      item("tie2", t2),
    ];
    expect(sortOfflineItems(input).map((i) => i.id)).toEqual(["tie1", "tie2", "old", "n1", "n2"]);
  });

  it("does not mutate its input", () => {
    const input = [item("a", "2026-10-01T00:00:00Z"), item("b", "2026-10-03T00:00:00Z")];
    const snapshot = input.map((i) => i.id);
    sortOfflineItems(input);
    expect(input.map((i) => i.id)).toEqual(snapshot);
  });

  it("handles an empty list", () => {
    expect(sortOfflineItems([])).toEqual([]);
  });
});

type Entry = { path: string; title?: string; at?: string; missing?: boolean };

function fakeCacheStorage(entries: Entry[] | null) {
  const open = vi.fn(async (_name: string) => ({
    keys: async () => entries!.map((e) => new Request(`${ORIGIN}${e.path}`)),
    match: async (req: Request) => {
      const e = entries!.find((x) => `${ORIGIN}${x.path}` === req.url);
      if (!e || e.missing) return undefined;
      return { headers: headers({ title: e.title, at: e.at }) };
    },
  }));
  const has = vi.fn(async (_name: string) => entries !== null);
  return { storage: { has, open }, has, open };
}

describe("readOfflineItems", () => {
  it("returns null when there is no CacheStorage (unsupported)", async () => {
    await expect(readOfflineItems(undefined)).resolves.toBeNull();
  });

  it("returns [] without opening when the saved cache does not exist", async () => {
    const f = fakeCacheStorage(null);
    await expect(readOfflineItems(f.storage)).resolves.toEqual([]);
    expect(f.has).toHaveBeenCalledWith("tayf-saved-v1");
    expect(f.open).not.toHaveBeenCalled();
  });

  it("lists, decodes and sorts the saved entries, skipping foreign ones", async () => {
    const f = fakeCacheStorage([
      { path: `/cluster/${ID_A}`, title: encodeURIComponent("Eski"), at: "2026-10-01T10:00:00.000Z" },
      { path: `/cluster/${ID_B}`, title: encodeURIComponent("Yeni"), at: "2026-10-05T10:00:00.000Z" },
      { path: `/cluster/${ID_C}`, title: encodeURIComponent("Tarihsiz") },
      { path: "/offline", title: encodeURIComponent("Çevrimdışı") },
      { path: `/cluster/${ID_A.replace("3f2b", "3f2c")}`, missing: true },
    ]);
    const out = await readOfflineItems(f.storage);
    expect(f.open).toHaveBeenCalledWith("tayf-saved-v1");
    expect(out?.map((i) => [i.id, i.title, i.cachedAt])).toEqual([
      [ID_B, "Yeni", "2026-10-05T10:00:00.000Z"],
      [ID_A, "Eski", "2026-10-01T10:00:00.000Z"],
      [ID_C, "Tarihsiz", null],
    ]);
  });

  it("returns [] for an existing but empty cache", async () => {
    const f = fakeCacheStorage([]);
    await expect(readOfflineItems(f.storage)).resolves.toEqual([]);
  });

  it("returns [] when the cache API throws", async () => {
    const hasBoom = { has: async () => Promise.reject(new Error("x")), open: vi.fn() };
    await expect(readOfflineItems(hasBoom)).resolves.toEqual([]);
    const keysBoom = {
      has: async () => true,
      open: async () => ({
        keys: async () => {
          throw new Error("x");
        },
        match: async () => undefined,
      }),
    };
    await expect(readOfflineItems(keysBoom)).resolves.toEqual([]);
  });
});
