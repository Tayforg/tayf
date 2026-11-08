import { describe, expect, it, vi } from "vitest";

import {
  findStoredCopy,
  markStoredCopyOpen,
  readOfflineItems,
  sortOfflineItems,
  toOfflineItem,
  type OfflineItem,
} from "./offline-items";
import { CACHE_NAMES } from "./sw-contract";
import { SW_CONFIG } from "./sw-policy";

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

// h69-pwa-1: the cluster error boundary asks whether this device holds a copy of the story.
describe("findStoredCopy", () => {
  const NOW = Date.parse("2026-11-08T12:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const KEY = `${ORIGIN}/cluster/${ID_A}`;

  type Stores = { saved?: Record<string, string | null>; pages?: Record<string, string | null> };

  /** `Record<url, cachedAt | null>` per cache; an absent record means the cache does not exist. */
  function fake(stores: Stores) {
    const calls: string[] = [];
    const byName = new Map<string, Record<string, string | null>>();
    if (stores.saved) byName.set("tayf-saved-v1", stores.saved);
    if (stores.pages) byName.set(SW_CONFIG.caches.pages, stores.pages);
    const storage = {
      has: vi.fn(async (name: string) => {
        calls.push(`has:${name}`);
        return byName.has(name);
      }),
      open: vi.fn(async (name: string) => {
        calls.push(`open:${name}`);
        const entries = byName.get(name) ?? {};
        return {
          keys: async () => [] as Request[],
          match: async (request: Request | string) => {
            const url = typeof request === "string" ? request : request.url;
            calls.push(`match:${name}:${url}`);
            if (!(url in entries)) return undefined;
            const at = entries[url];
            return { headers: headers(at === null || at === undefined ? {} : { at }) };
          },
        };
      }),
    };
    return { storage, calls };
  }

  it("asks the saved and the pages cache whether they exist before opening either, so it never creates one", async () => {
    const f = fake({});
    await expect(findStoredCopy(f.storage, ORIGIN, ID_A, NOW)).resolves.toBeNull();
    expect(f.calls).toEqual([`has:tayf-saved-v1`, `has:${SW_CONFIG.caches.pages}`]);
    expect(f.storage.open).not.toHaveBeenCalled();

    const g = fake({ pages: { [KEY]: iso(DAY) } });
    await findStoredCopy(g.storage, ORIGIN, ID_A, NOW);
    const firstOpen = g.calls.findIndex((c) => c.startsWith("open:"));
    expect(g.calls.slice(0, firstOpen)).toEqual([`has:tayf-saved-v1`, `has:${SW_CONFIG.caches.pages}`]);
    expect(g.calls).not.toContain("open:tayf-saved-v1"); // that one does not exist
  });

  it("finds a saved copy under origin + /cluster/<lower-cased id> and links to it with ?kopya=1", async () => {
    const at = iso(3 * DAY);
    const f = fake({ saved: { [KEY]: at } });
    await expect(findStoredCopy(f.storage, ORIGIN, ID_A.toUpperCase(), NOW)).resolves.toEqual({
      href: `/cluster/${ID_A}?kopya=1`,
      cachedAt: at,
    });
    expect(f.calls).toContain(`match:tayf-saved-v1:${KEY}`);
  });

  it("finds a pages copy that is inside the 14-day window", async () => {
    const at = iso(13 * DAY);
    const f = fake({ pages: { [KEY]: at } });
    await expect(findStoredCopy(f.storage, ORIGIN, ID_A, NOW)).resolves.toEqual({
      href: `/cluster/${ID_A}?kopya=1`,
      cachedAt: at,
    });
  });

  it("prefers the saved copy and does not even read pages then", async () => {
    const f = fake({ saved: { [KEY]: iso(DAY) }, pages: { [KEY]: iso(0) } });
    const out = await findStoredCopy(f.storage, ORIGIN, ID_A, NOW);
    expect(out?.cachedAt).toBe(iso(DAY));
    expect(f.calls.some((c) => c.startsWith(`match:${SW_CONFIG.caches.pages}`))).toBe(false);
  });

  it("a saved copy never expires, however old", async () => {
    const f = fake({ saved: { [KEY]: iso(400 * DAY) } });
    await expect(findStoredCopy(f.storage, ORIGIN, ID_A, NOW)).resolves.not.toBeNull();
  });

  it("an expired pages copy is not offered (the worker would not serve it either)", async () => {
    const f = fake({ pages: { [KEY]: iso(SW_CONFIG.pagesMaxAgeMs + 1) } });
    await expect(findStoredCopy(f.storage, ORIGIN, ID_A, NOW)).resolves.toBeNull();
  });

  it("a pages copy exactly at the limit is still fresh, one millisecond over is not", async () => {
    const edge = fake({ pages: { [KEY]: iso(SW_CONFIG.pagesMaxAgeMs) } });
    await expect(findStoredCopy(edge.storage, ORIGIN, ID_A, NOW)).resolves.not.toBeNull();
    const over = fake({ pages: { [KEY]: iso(SW_CONFIG.pagesMaxAgeMs + 1) } });
    await expect(findStoredCopy(over.storage, ORIGIN, ID_A, NOW)).resolves.toBeNull();
  });

  it("a pages copy without a usable stamp counts as expired; a saved one without a stamp is offered with cachedAt null", async () => {
    const pages = fake({ pages: { [KEY]: null } });
    await expect(findStoredCopy(pages.storage, ORIGIN, ID_A, NOW)).resolves.toBeNull();
    const badPages = fake({ pages: { [KEY]: "yesterday-ish" } });
    await expect(findStoredCopy(badPages.storage, ORIGIN, ID_A, NOW)).resolves.toBeNull();

    const saved = fake({ saved: { [KEY]: null } });
    await expect(findStoredCopy(saved.storage, ORIGIN, ID_A, NOW)).resolves.toEqual({
      href: `/cluster/${ID_A}?kopya=1`,
      cachedAt: null,
    });
    const badSaved = fake({ saved: { [KEY]: "yesterday-ish" } });
    await expect(findStoredCopy(badSaved.storage, ORIGIN, ID_A, NOW)).resolves.toEqual({
      href: `/cluster/${ID_A}?kopya=1`,
      cachedAt: null,
    });
  });

  it("a saved copy still wins when the pages copy of the same story is expired", async () => {
    const f = fake({ saved: { [KEY]: iso(DAY) }, pages: { [KEY]: iso(30 * DAY) } });
    const out = await findStoredCopy(f.storage, ORIGIN, ID_A, NOW);
    expect(out?.cachedAt).toBe(iso(DAY));
  });

  it("is null for another story's copy", async () => {
    const f = fake({ saved: { [`${ORIGIN}/cluster/${ID_B}`]: iso(0) } });
    await expect(findStoredCopy(f.storage, ORIGIN, ID_A, NOW)).resolves.toBeNull();
  });

  it("is null for an invalid id and touches no cache API", async () => {
    for (const id of ["", "not-a-uuid", "../admin", `${ID_A}/x`, `${ID_A}?x=1`, undefined as unknown as string, null as unknown as string]) {
      const f = fake({ saved: { [KEY]: iso(0) } });
      await expect(findStoredCopy(f.storage, ORIGIN, id, NOW), String(id)).resolves.toBeNull();
      expect(f.calls, String(id)).toEqual([]);
    }
  });

  it("is null when there is no CacheStorage", async () => {
    await expect(findStoredCopy(undefined, ORIGIN, ID_A, NOW)).resolves.toBeNull();
  });

  it("is null, not a rejection, when the cache API throws", async () => {
    const hasBoom = { has: async () => Promise.reject(new Error("x")), open: vi.fn() };
    await expect(findStoredCopy(hasBoom, ORIGIN, ID_A, NOW)).resolves.toBeNull();
    const openBoom = { has: async () => true, open: async () => Promise.reject(new Error("x")) };
    await expect(findStoredCopy(openBoom, ORIGIN, ID_A, NOW)).resolves.toBeNull();
    const matchBoom = {
      has: async () => true,
      open: async () => ({
        keys: async () => [] as Request[],
        match: async () => {
          throw new Error("x");
        },
      }),
    };
    await expect(findStoredCopy(matchBoom, ORIGIN, ID_A, NOW)).resolves.toBeNull();
  });

  it("builds the key from the origin it is given", async () => {
    const f = fake({ saved: { [`https://www.tayfhaber.com/cluster/${ID_A}`]: iso(0) } });
    await expect(findStoredCopy(f.storage, ORIGIN, ID_A, NOW)).resolves.toBeNull();
    await expect(findStoredCopy(f.storage, "https://www.tayfhaber.com", ID_A, NOW)).resolves.not.toBeNull();
  });

  it("reads the cache names the worker writes (guards a rename)", () => {
    expect(SW_CONFIG.caches.saved).toBe("tayf-saved-v1");
    expect(SW_CONFIG.caches.pages).toMatch(/^tayf-pages-/);
  });
});

// security-1 / sw-kopya-reload-trap: the "Kayıtlı kopyayı aç" click leaves a one-shot mark in Cache Storage; the
// worker answers the next ?kopya=1 navigation from storage only when it finds (and takes) that mark. Only code
// running on this origin can write it.
describe("markStoredCopyOpen", () => {
  const NOW = Date.parse("2026-11-08T12:00:00.000Z");
  const KEY = `${ORIGIN}/cluster/${ID_A}`;

  function recorder() {
    const puts: Array<{ cache: string; key: string; status: number; stamp: string | null; body: string | null }> = [];
    const storage = {
      has: vi.fn(async () => true),
      open: vi.fn(async (name: string) => ({
        keys: async () => [] as Request[],
        match: async () => undefined,
        put: async (request: Request | string, response: Response) => {
          puts.push({
            cache: name,
            key: typeof request === "string" ? request : request.url,
            status: response.status,
            stamp: response.headers.get("x-tayf-cached-at"),
            body: await response.text(),
          });
        },
      })),
    };
    return { storage, puts };
  }

  it("writes the normalized lower-case cluster url into the open-copy cache, with a cached-at stamp and an empty body", async () => {
    const r = recorder();
    await markStoredCopyOpen(r.storage, ORIGIN, ID_A.toUpperCase(), NOW);
    expect(r.puts).toEqual([
      { cache: CACHE_NAMES.openCopy, key: KEY, status: 200, stamp: new Date(NOW).toISOString(), body: "" },
    ]);
    expect(CACHE_NAMES.openCopy).toMatch(/^tayf-open-copy-/);
  });

  it("builds the key from the origin it is given", async () => {
    const r = recorder();
    await markStoredCopyOpen(r.storage, "https://www.tayfhaber.com", ID_B, NOW);
    expect(r.puts.map((p) => p.key)).toEqual([`https://www.tayfhaber.com/cluster/${ID_B}`]);
  });

  it("does nothing, and resolves, when there is no CacheStorage", async () => {
    await expect(markStoredCopyOpen(undefined, ORIGIN, ID_A, NOW)).resolves.toBeUndefined();
  });

  it("does nothing for an invalid id and touches no cache API", async () => {
    for (const id of ["", "not-a-uuid", "../admin", `${ID_A}/x`, `${ID_A}?x=1`, undefined as unknown as string, null as unknown as string]) {
      const r = recorder();
      await expect(markStoredCopyOpen(r.storage, ORIGIN, id, NOW), String(id)).resolves.toBeUndefined();
      expect(r.storage.open, String(id)).not.toHaveBeenCalled();
      expect(r.puts, String(id)).toEqual([]);
    }
  });

  it("never rejects: a throwing open() or put() is swallowed", async () => {
    const openBoom = { has: async () => true, open: vi.fn(async () => Promise.reject(new Error("SecurityError"))) };
    await expect(markStoredCopyOpen(openBoom, ORIGIN, ID_A, NOW)).resolves.toBeUndefined();
    expect(openBoom.open).toHaveBeenCalledTimes(1);

    const putBoom = {
      has: async () => true,
      open: async () => ({
        keys: async () => [] as Request[],
        match: async () => undefined,
        put: async () => {
          throw new Error("QuotaExceededError");
        },
      }),
    };
    await expect(markStoredCopyOpen(putBoom, ORIGIN, ID_A, NOW)).resolves.toBeUndefined();
  });

  it("a synchronous throw from open() is swallowed too", async () => {
    const syncBoom = {
      has: async () => true,
      open: () => {
        throw new Error("sync");
      },
    };
    await expect(markStoredCopyOpen(syncBoom, ORIGIN, ID_A, NOW)).resolves.toBeUndefined();
  });
});
