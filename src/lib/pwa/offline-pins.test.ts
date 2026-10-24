import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activeWorkerWithin,
  pinForOffline,
  readBookmarkIds,
  syncMessage,
  unpinForOffline,
} from "./offline-pins";
import { SW_READY_TIMEOUT_MS } from "./sw-contract";

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

type ReadyLike = PromiseLike<{ active: { postMessage(m: unknown): void } | null }>;

/** A page no worker controls yet (first visit); `ready` is what the browser would offer instead. */
const navUncontrolled = (ready: ReadyLike) => ({
  serviceWorker: { controller: null, ready },
});

const resolvedWith = (active: { postMessage(m: unknown): void } | null): ReadyLike =>
  Promise.resolve({ active });

const never = (): ReadyLike => new Promise<never>(() => {});

/** An uncontrolled navigator whose `ready` getter throws, like a blocked-storage SecurityError. */
const navReadyGetterThrows = () => ({
  serviceWorker: {
    controller: null,
    get ready(): never {
      throw new DOMException("denied", "SecurityError");
    },
  },
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
  vi.useRealTimers();
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

  describe("on an uncontrolled page (first visit)", () => {
    it("returns false right away, then posts the pin to registration.active", async () => {
      const active = controllerSpy();
      expect(pinForOffline(ID_A, navUncontrolled(resolvedWith(active)))).toBe(false);
      expect(active.postMessage).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(active.postMessage).toHaveBeenCalledTimes(1));
      expect(active.postMessage).toHaveBeenCalledWith({ type: "tayf:pin", id: ID_A });
    });

    it("posts nothing when the registration has no active worker yet (not to installing/waiting either)", async () => {
      const other = controllerSpy();
      const ready = Promise.resolve({ active: null, installing: other, waiting: other }) as ReadyLike;
      expect(pinForOffline(ID_A, navUncontrolled(ready))).toBe(false);
      await flush();
      expect(other.postMessage).not.toHaveBeenCalled();
    });

    it("posts nothing for an invalid id", async () => {
      const active = controllerSpy();
      const ready = vi.fn(() => resolvedWith(active));
      const nav = {
        serviceWorker: {
          controller: null,
          get ready() {
            return ready();
          },
        },
      };
      expect(pinForOffline("../x", nav)).toBe(false);
      await flush();
      expect(ready).not.toHaveBeenCalled();
      expect(active.postMessage).not.toHaveBeenCalled();
    });

    it("gives up after SW_READY_TIMEOUT_MS when ready never settles, leaving no timer behind", async () => {
      vi.useFakeTimers();
      const late = controllerSpy();
      let activate!: (r: { active: typeof late }) => void;
      const ready: ReadyLike = new Promise((resolve) => {
        activate = resolve;
      });
      expect(pinForOffline(ID_A, navUncontrolled(ready))).toBe(false);
      await vi.advanceTimersByTimeAsync(SW_READY_TIMEOUT_MS - 1);
      expect(vi.getTimerCount()).toBe(1); // still waiting: the timeout is armed
      await vi.advanceTimersByTimeAsync(1);
      expect(vi.getTimerCount()).toBe(0);
      activate({ active: late }); // the worker shows up after we gave up: the next document's sync pins it
      await vi.advanceTimersByTimeAsync(0);
      expect(late.postMessage).not.toHaveBeenCalled();
    });

    it("clears its timer as soon as ready settles", async () => {
      vi.useFakeTimers();
      const active = controllerSpy();
      pinForOffline(ID_A, navUncontrolled(resolvedWith(active)));
      await vi.advanceTimersByTimeAsync(0);
      expect(active.postMessage).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("returns false and never throws or leaks a rejection when ready rejects", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const ready = Promise.reject(new Error("no registration"));
        expect(pinForOffline(ID_A, navUncontrolled(ready))).toBe(false);
        await flush();
        await flush();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
      expect(unhandled).not.toHaveBeenCalled();
    });

    it("returns false and never throws or leaks a rejection when the ready getter throws", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        expect(() => pinForOffline(ID_A, navReadyGetterThrows())).not.toThrow();
        expect(pinForOffline(ID_A, navReadyGetterThrows())).toBe(false);
        await flush();
        await flush();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
      expect(unhandled).not.toHaveBeenCalled();
    });

    it("never throws when the active worker's postMessage throws", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      const active = {
        postMessage: vi.fn(() => {
          throw new Error("clone");
        }),
      };
      try {
        expect(pinForOffline(ID_A, navUncontrolled(resolvedWith(active)))).toBe(false);
        await vi.waitFor(() => expect(active.postMessage).toHaveBeenCalledTimes(1));
        await flush();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
      expect(unhandled).not.toHaveBeenCalled();
    });

    it("tolerates a ready that resolves to nothing", async () => {
      const ready = Promise.resolve(undefined) as unknown as ReadyLike;
      expect(pinForOffline(ID_A, navUncontrolled(ready))).toBe(false);
      await flush();
    });
  });

  it("never reads ready when a controller exists", () => {
    const c = controllerSpy();
    const readyGetter = vi.fn(() => never());
    const serviceWorker = { controller: c };
    Object.defineProperty(serviceWorker, "ready", { get: readyGetter });
    expect(pinForOffline(ID_A, { serviceWorker })).toBe(true);
    expect(readyGetter).not.toHaveBeenCalled();
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

  describe("on an uncontrolled page (first visit)", () => {
    it("posts the unpin to registration.active AND still deletes the saved copy directly", async () => {
      const active = controllerSpy();
      const f = fakeCaches(true);
      expect(unpinForOffline(ID_A, navUncontrolled(resolvedWith(active)), f.storage)).toBe(false);
      await vi.waitFor(() => expect(active.postMessage).toHaveBeenCalledTimes(1));
      expect(active.postMessage).toHaveBeenCalledWith({ type: "tayf:unpin", id: ID_A });
      await vi.waitFor(() => expect(f.del).toHaveBeenCalledTimes(1));
      expect(f.open).toHaveBeenCalledWith("tayf-saved-v1");
      expect(f.del).toHaveBeenCalledWith(`/cluster/${ID_A}`);
    });

    it("still deletes the saved copy when ready never settles", async () => {
      vi.useFakeTimers();
      const f = fakeCaches(true);
      expect(unpinForOffline(ID_A, navUncontrolled(never()), f.storage)).toBe(false);
      await vi.advanceTimersByTimeAsync(SW_READY_TIMEOUT_MS);
      expect(f.del).toHaveBeenCalledWith(`/cluster/${ID_A}`);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("still deletes the saved copy when the ready getter throws", async () => {
      const f = fakeCaches(true);
      expect(unpinForOffline(ID_A, navReadyGetterThrows(), f.storage)).toBe(false);
      await vi.waitFor(() => expect(f.del).toHaveBeenCalledWith(`/cluster/${ID_A}`));
    });

    it("posts nothing to the worker for an invalid id", async () => {
      const active = controllerSpy();
      const f = fakeCaches(true);
      expect(unpinForOffline("nope", navUncontrolled(resolvedWith(active)), f.storage)).toBe(false);
      await flush();
      expect(active.postMessage).not.toHaveBeenCalled();
      expect(f.del).not.toHaveBeenCalled();
    });
  });

  it("never reads ready when a controller exists", () => {
    const c = controllerSpy();
    const f = fakeCaches(true);
    const readyGetter = vi.fn(() => never());
    const serviceWorker = { controller: c };
    Object.defineProperty(serviceWorker, "ready", { get: readyGetter });
    expect(unpinForOffline(ID_A, { serviceWorker }, f.storage)).toBe(true);
    expect(readyGetter).not.toHaveBeenCalled();
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

describe("activeWorkerWithin", () => {
  it("resolves the active worker", async () => {
    const active = controllerSpy();
    await expect(activeWorkerWithin({ ready: resolvedWith(active) }, 1000)).resolves.toBe(active);
  });

  it("resolves null for no container, no ready, or no active worker", async () => {
    await expect(activeWorkerWithin(undefined, 1000)).resolves.toBeNull();
    await expect(activeWorkerWithin({}, 1000)).resolves.toBeNull();
    await expect(activeWorkerWithin({ ready: resolvedWith(null) }, 1000)).resolves.toBeNull();
  });

  it("resolves null after the timeout when ready never settles, and clears the timer", async () => {
    vi.useFakeTimers();
    const pending = activeWorkerWithin({ ready: never() }, 250);
    await vi.advanceTimersByTimeAsync(249);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves null (never rejects) when ready rejects or its getter throws", async () => {
    await expect(
      activeWorkerWithin({ ready: Promise.reject(new Error("nope")) }, 1000),
    ).resolves.toBeNull();
    await expect(activeWorkerWithin(navReadyGetterThrows().serviceWorker, 1000)).resolves.toBeNull();
  });
});
