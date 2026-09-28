import { describe, it, expect, vi, afterEach } from "vitest";
import {
  readDietSnapshot,
  getServerDietSnapshot,
  subscribeDiet,
  recordReadingClick,
  clearDiet,
} from "./diet-store";
import { DIET_STORAGE_KEY } from "./diet";

// Minimal fake Storage + window, following the shape vi.stubGlobal needs.
// `throwOnGetter` simulates the `window.localStorage` PROPERTY ACCESS
// itself throwing (SecurityError in some blocked-cookie private modes),
// which is distinct from `getItem`/`setItem` throwing on an otherwise
// accessible Storage object.
function makeFakeStorage(opts: {
  throwOnGet?: boolean;
  throwOnSet?: boolean;
  initial?: Record<string, string>;
} = {}) {
  const store = new Map(Object.entries(opts.initial ?? {}));
  return {
    getItem: (key: string) => {
      if (opts.throwOnGet) throw new Error("getItem blocked");
      return store.has(key) ? store.get(key)! : null;
    },
    setItem: (key: string, value: string) => {
      if (opts.throwOnSet) throw new Error("QuotaExceededError");
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    _store: store,
  };
}

function stubWindow(opts: {
  storage?: ReturnType<typeof makeFakeStorage> | null;
  throwOnLocalStorageGetter?: boolean;
  listeners?: Map<string, Set<(e: unknown) => void>>;
}) {
  const listeners = opts.listeners ?? new Map<string, Set<(e: unknown) => void>>();
  const fakeWindow = {
    addEventListener: (type: string, cb: (e: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener: (type: string, cb: (e: unknown) => void) => {
      listeners.get(type)?.delete(cb);
    },
    dispatchEvent: (e: Event) => {
      for (const cb of listeners.get(e.type) ?? []) cb(e);
      return true;
    },
    get localStorage() {
      if (opts.throwOnLocalStorageGetter) {
        throw new Error("SecurityError: blocked");
      }
      return opts.storage;
    },
  };
  vi.stubGlobal("window", fakeWindow);
  return { fakeWindow, listeners };
}

describe("diet-store", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns available:false and does not throw when the localStorage getter itself throws", () => {
    stubWindow({ throwOnLocalStorageGetter: true });
    const snap = readDietSnapshot();
    expect(snap.available).toBe(false);
    expect(() => recordReadingClick("outbound", { zone: "iktidar" })).not.toThrow();
  });

  it("does not throw when setItem throws QuotaExceededError", () => {
    const storage = makeFakeStorage({ throwOnSet: true });
    stubWindow({ storage });
    expect(() => recordReadingClick("outbound", { zone: "iktidar" })).not.toThrow();
  });

  it("is a no-op on the server (no window)", () => {
    vi.unstubAllGlobals();
    expect(() => recordReadingClick("outbound", { zone: "iktidar" })).not.toThrow();
    expect(clearDiet()).toBe(false);
    expect(getServerDietSnapshot()).toEqual({ available: true, entries: [], readAt: 0 });
  });

  it("returns the identical snapshot object for two reads of the same raw string", () => {
    const storage = makeFakeStorage({
      initial: { [DIET_STORAGE_KEY]: JSON.stringify({ v: 1, e: [{ t: 1, z: "iktidar" }] }) },
    });
    stubWindow({ storage });
    const first = readDietSnapshot();
    const second = readDietSnapshot();
    expect(second).toBe(first);
  });

  it("recordReadingClick writes JSON whose entries have exactly the keys t and z", () => {
    const storage = makeFakeStorage();
    stubWindow({ storage });
    recordReadingClick("outbound", { zone: "iktidar" });
    const raw = storage._store.get(DIET_STORAGE_KEY);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.e).toHaveLength(1);
    expect(Object.keys(parsed.e[0]).sort()).toEqual(["t", "z"]);
  });

  it("ignores clicks with no zone / non-reading events", () => {
    const storage = makeFakeStorage();
    stubWindow({ storage });
    recordReadingClick("share", { clusterId: "c1" });
    recordReadingClick("outbound", { kind: "factcheck" });
    expect(storage._store.get(DIET_STORAGE_KEY)).toBeUndefined();
  });

  it("clearDiet removes the key, returns true, and fires tayf:diyet-change", () => {
    const storage = makeFakeStorage({
      initial: { [DIET_STORAGE_KEY]: JSON.stringify({ v: 1, e: [] }) },
    });
    const { fakeWindow } = stubWindow({ storage });
    const onChange = vi.fn();
    fakeWindow.addEventListener("tayf:diyet-change", onChange);
    expect(clearDiet()).toBe(true);
    expect(storage._store.has(DIET_STORAGE_KEY)).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("subscribeDiet reacts to a storage event for the diet key and ignores other keys", () => {
    const storage = makeFakeStorage();
    const { fakeWindow } = stubWindow({ storage });
    const onChange = vi.fn();
    const unsubscribe = subscribeDiet(onChange);

    fakeWindow.dispatchEvent(
      Object.assign(new Event("storage"), { key: "some:other:key" }) as StorageEvent,
    );
    expect(onChange).not.toHaveBeenCalled();

    fakeWindow.dispatchEvent(
      Object.assign(new Event("storage"), { key: DIET_STORAGE_KEY }) as StorageEvent,
    );
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
    fakeWindow.dispatchEvent(
      Object.assign(new Event("storage"), { key: DIET_STORAGE_KEY }) as StorageEvent,
    );
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
