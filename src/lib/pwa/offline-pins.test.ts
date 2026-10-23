import { afterEach, describe, expect, it, vi } from "vitest";

import { pinForOffline, readBookmarkIds, syncMessage, unpinForOffline } from "./offline-pins";

const ID_A = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";
const ID_B = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

function storageOf(value: string | null) {
  return { getItem: vi.fn((key: string) => (key === "tayf:bookmarks" ? value : null)) };
}

function controllerSpy() {
  return { postMessage: vi.fn() };
}

const navWith = (controller: { postMessage(m: unknown): void } | null) => ({
  serviceWorker: { controller },
});

function fakeCaches(hasSaved: boolean) {
  const del = vi.fn(async (_req: string) => true);
  const open = vi.fn(async (_name: string) => ({ delete: del }));
  const has = vi.fn(async (_name: string) => hasSaved);
  return { storage: { has, open }, has, open, del };
}

/** Lets a fire-and-forget promise chain settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readBookmarkIds", () => {
  it("returns the stored ids", () => {
    const storage = storageOf(JSON.stringify([ID_A, ID_B]));
    expect(readBookmarkIds(storage)).toEqual([ID_A, ID_B]);
    expect(storage.getItem).toHaveBeenCalledWith("tayf:bookmarks");
  });

  it("returns [] when the key is absent (no bookmarks: a sync may prune)", () => {
    expect(readBookmarkIds(storageOf(null))).toEqual([]);
  });

  it("returns null on bad JSON (null = do not sync)", () => {
    expect(readBookmarkIds(storageOf("{not json"))).toBeNull();
  });

  it("returns null when the value is not an array", () => {
    expect(readBookmarkIds(storageOf(JSON.stringify({ a: 1 })))).toBeNull();
    expect(readBookmarkIds(storageOf("42"))).toBeNull();
    expect(readBookmarkIds(storageOf("null"))).toBeNull();
    expect(readBookmarkIds(storageOf('"str"'))).toBeNull();
  });

  it("filters out invalid ids and non-strings", () => {
    const raw = JSON.stringify([ID_A, "nope", 7, null, "../etc/passwd", "", { id: ID_B }, ID_B]);
    expect(readBookmarkIds(storageOf(raw))).toEqual([ID_A, ID_B]);
  });

  it("keeps only the last 500 ids", () => {
    const ids = Array.from({ length: 600 }, (_, i) => uuid(i));
    const out = readBookmarkIds(storageOf(JSON.stringify(ids)));
    expect(out).toHaveLength(500);
    expect(out).toEqual(ids.slice(100));
  });

  it("returns null when storage throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readBookmarkIds(storage)).toBeNull();
  });

  it("returns null when storage is explicitly null", () => {
    expect(readBookmarkIds(null)).toBeNull();
  });

  it("falls back to globalThis.localStorage when no storage is passed", () => {
    vi.stubGlobal("localStorage", storageOf(JSON.stringify([ID_A])));
    expect(readBookmarkIds()).toEqual([ID_A]);
  });

  it("returns null when there is no localStorage at all", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readBookmarkIds()).toBeNull();
  });

  it("returns null when reading localStorage itself throws", () => {
    vi.stubGlobal("localStorage", {
      get getItem(): never {
        throw new Error("SecurityError");
      },
    });
    expect(readBookmarkIds()).toBeNull();
  });
});

describe("syncMessage", () => {
  it("builds the sync message", () => {
    expect(syncMessage([ID_A, ID_B])).toEqual({ type: "tayf:sync", ids: [ID_A, ID_B] });
  });

  it("allows an empty id list (prune everything)", () => {
    expect(syncMessage([])).toEqual({ type: "tayf:sync", ids: [] });
  });
});

describe("pinForOffline", () => {
  it("posts the exact pin message to the controller and returns true", () => {
    const c = controllerSpy();
    expect(pinForOffline(ID_A, navWith(c))).toBe(true);
    expect(c.postMessage).toHaveBeenCalledTimes(1);
    expect(c.postMessage).toHaveBeenCalledWith({ type: "tayf:pin", id: ID_A });
  });

  it("is a no-op returning false when nothing controls the page", () => {
    expect(pinForOffline(ID_A, navWith(null))).toBe(false);
  });

  it("returns false when the browser has no serviceWorker", () => {
    expect(pinForOffline(ID_A, {})).toBe(false);
  });

  it("posts nothing for an invalid id", () => {
    const c = controllerSpy();
    for (const bad of ["", "nope", "../x", `${ID_A}/../../x`, `${ID_A}?a=1`]) {
      expect(pinForOffline(bad, navWith(c))).toBe(false);
    }
    expect(c.postMessage).not.toHaveBeenCalled();
  });

  it("returns false (never throws) when reading navigator throws", () => {
    const nav = {
      get serviceWorker(): never {
        throw new DOMException("denied", "SecurityError");
      },
    };
    expect(pinForOffline(ID_A, nav)).toBe(false);
  });

  it("returns false (never throws) when postMessage throws", () => {
    const c = {
      postMessage: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    expect(pinForOffline(ID_A, navWith(c))).toBe(false);
  });

  it("returns false when the global navigator has no controller (node)", () => {
    expect(pinForOffline(ID_A)).toBe(false);
  });
});

describe("unpinForOffline", () => {
  it("posts the exact unpin message when a controller exists", () => {
    const c = controllerSpy();
    const f = fakeCaches(true);
    expect(unpinForOffline(ID_A, navWith(c), f.storage)).toBe(true);
    expect(c.postMessage).toHaveBeenCalledTimes(1);
    expect(c.postMessage).toHaveBeenCalledWith({ type: "tayf:unpin", id: ID_A });
    expect(f.has).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it("without a controller deletes /cluster/<lowercased id> from tayf-saved-v1", async () => {
    const f = fakeCaches(true);
    expect(unpinForOffline(ID_A.toUpperCase(), navWith(null), f.storage)).toBe(false);
    await vi.waitFor(() => expect(f.del).toHaveBeenCalledTimes(1));
    expect(f.has).toHaveBeenCalledWith("tayf-saved-v1");
    expect(f.open).toHaveBeenCalledWith("tayf-saved-v1");
    expect(f.del).toHaveBeenCalledWith(`/cluster/${ID_A}`);
  });

  it("without a controller never opens the cache when it does not exist", async () => {
    const f = fakeCaches(false);
    unpinForOffline(ID_A, navWith(null), f.storage);
    await vi.waitFor(() => expect(f.has).toHaveBeenCalledTimes(1));
    await flush();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.del).not.toHaveBeenCalled();
  });

  it("uses the cache fallback when the browser has no serviceWorker", async () => {
    const f = fakeCaches(true);
    unpinForOffline(ID_B, {}, f.storage);
    await vi.waitFor(() => expect(f.del).toHaveBeenCalledWith(`/cluster/${ID_B}`));
  });

  it("does nothing for an invalid id", async () => {
    const c = controllerSpy();
    const f = fakeCaches(true);
    expect(unpinForOffline("nope", navWith(c), f.storage)).toBe(false);
    expect(unpinForOffline("../x", navWith(null), f.storage)).toBe(false);
    await flush();
    expect(c.postMessage).not.toHaveBeenCalled();
    expect(f.has).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.del).not.toHaveBeenCalled();
  });

  it("never throws or leaks a rejection when the cache API fails", async () => {
    const has = vi.fn(async () => {
      throw new Error("cache down");
    });
    expect(() => unpinForOffline(ID_A, navWith(null), { has, open: vi.fn() })).not.toThrow();
    await vi.waitFor(() => expect(has).toHaveBeenCalledTimes(1));
    await flush();
  });

  it("never throws when delete rejects", async () => {
    const del = vi.fn(async () => {
      throw new Error("quota");
    });
    const storage = { has: async () => true, open: async () => ({ delete: del }) };
    expect(() => unpinForOffline(ID_A, navWith(null), storage)).not.toThrow();
    await vi.waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await flush();
  });

  it("returns false and does nothing without a controller or a CacheStorage", () => {
    expect(unpinForOffline(ID_A, navWith(null), undefined)).toBe(false);
  });

  it("falls back to the cache when reading navigator throws", async () => {
    const f = fakeCaches(true);
    const nav = {
      get serviceWorker(): never {
        throw new DOMException("denied", "SecurityError");
      },
    };
    expect(unpinForOffline(ID_A, nav, f.storage)).toBe(false);
    await vi.waitFor(() => expect(f.del).toHaveBeenCalledWith(`/cluster/${ID_A}`));
  });
});
