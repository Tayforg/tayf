import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DIET_CLOCK_TICK_MS,
  DIET_SNAPSHOT_MAX_AGE_MS,
  readDietSnapshot,
  getServerDietSnapshot,
  subscribeDiet,
  recordReadingClick,
  clearDiet,
  pruneStoredDiet,
} from "./diet-store";
import {
  DIET_STORAGE_KEY,
  DIET_MAX_ENTRIES,
  pruneDiet,
  parseDiet,
  summarizeDiet,
  type DietEntry,
} from "./diet";

// Minimal fake Storage + window, following the shape vi.stubGlobal needs.
// `throwOnGetter` simulates the `window.localStorage` PROPERTY ACCESS
// itself throwing (SecurityError in some blocked-cookie private modes),
// which is distinct from `getItem`/`setItem` throwing on an otherwise
// accessible Storage object.
function makeFakeStorage(opts: {
  throwOnGet?: boolean;
  throwOnSet?: boolean;
  throwOnRemove?: boolean;
  initial?: Record<string, string>;
} = {}) {
  const store = new Map(Object.entries(opts.initial ?? {}));
  // Spies, so a test can assert that a write did NOT happen.
  const setItem = vi.fn((key: string, value: string) => {
    if (opts.throwOnSet) throw new Error("QuotaExceededError");
    store.set(key, value);
  });
  const removeItem = vi.fn((key: string) => {
    if (opts.throwOnRemove) throw new Error("removeItem blocked");
    store.delete(key);
  });
  return {
    getItem: (key: string) => {
      if (opts.throwOnGet) throw new Error("getItem blocked");
      return store.has(key) ? store.get(key)! : null;
    },
    setItem,
    removeItem,
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

// h151-clientstate-2: the /diyetim privacy sentence says entries older than 30
// days "kendiliğinden silinir". They used to leave storage only on the reader's
// next counted click; pruneStoredDiet drops them when the page is opened.
describe("pruneStoredDiet", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
  const CHANGE = "tayf:diyet-change";

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function raw(entries: ReadonlyArray<{ t: number; z: string }>): string {
    return JSON.stringify({ v: 1, e: entries });
  }

  function setup(
    entries: ReadonlyArray<{ t: number; z: string }> | string | null,
    extra: { throwOnGet?: boolean; throwOnSet?: boolean; throwOnRemove?: boolean } = {},
  ) {
    const initial: Record<string, string> = { "other:key": "keep-me" };
    if (typeof entries === "string") initial[DIET_STORAGE_KEY] = entries;
    else if (entries !== null) initial[DIET_STORAGE_KEY] = raw(entries);
    const storage = makeFakeStorage({ initial, ...extra });
    const { fakeWindow } = stubWindow({ storage });
    const onChange = vi.fn();
    fakeWindow.addEventListener(CHANGE, onChange);
    return { storage, onChange };
  }

  function storedEntries(storage: ReturnType<typeof makeFakeStorage>): unknown {
    return JSON.parse(storage._store.get(DIET_STORAGE_KEY)!);
  }

  it("drops entries older than 30 days, rewrites the v1 shape, notifies once and returns the dropped count", () => {
    const recent = [
      { t: NOW - DAY, z: "muhalefet" },
      { t: NOW - 2 * 60 * 60 * 1000, z: "iktidar" },
    ];
    const { storage, onChange } = setup([
      { t: NOW - 40 * DAY, z: "iktidar" },
      { t: NOW - 41 * DAY, z: "iktidar" },
      { t: NOW - 95 * DAY, z: "muhalefet" },
      { t: NOW - 40 * DAY - 5, z: "bagimsiz" },
      ...recent,
    ]);

    expect(pruneStoredDiet(NOW)).toBe(4);

    expect(storedEntries(storage)).toEqual({ v: 1, e: recent });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(storage._store.get("other:key")).toBe("keep-me");
  });

  it("removes the key when every entry has expired and returns their count", () => {
    const { storage, onChange } = setup([
      { t: NOW - 31 * DAY, z: "iktidar" },
      { t: NOW - 60 * DAY, z: "bagimsiz" },
      { t: NOW - 90 * DAY, z: "muhalefet" },
    ]);

    expect(pruneStoredDiet(NOW)).toBe(3);

    expect(storage._store.has(DIET_STORAGE_KEY)).toBe(false);
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(storage._store.get("other:key")).toBe("keep-me");
  });

  it("writes nothing and fires no event when nothing has expired", () => {
    const original = raw([
      { t: NOW - 29 * DAY, z: "iktidar" },
      { t: NOW - DAY, z: "muhalefet" },
      { t: NOW - 1000, z: "bagimsiz" },
    ]);
    const { storage, onChange } = setup(original);

    expect(pruneStoredDiet(NOW)).toBe(0);

    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(storage._store.get(DIET_STORAGE_KEY)).toBe(original);
  });

  it("writes nothing for an absent key or an empty entry list", () => {
    const absent = setup(null);
    expect(pruneStoredDiet(NOW)).toBe(0);
    expect(absent.storage.setItem).not.toHaveBeenCalled();
    expect(absent.storage.removeItem).not.toHaveBeenCalled();
    expect(absent.onChange).not.toHaveBeenCalled();

    const empty = setup([]);
    expect(pruneStoredDiet(NOW)).toBe(0);
    expect(empty.storage.setItem).not.toHaveBeenCalled();
    expect(empty.storage.removeItem).not.toHaveBeenCalled();
    expect(empty.onChange).not.toHaveBeenCalled();
  });

  it.each(["not json", "{", "null", "42", '"text"', '{"v":2,"e":[]}', '{"v":1}', '{"v":1,"e":"x"}'])(
    "leaves malformed storage %j untouched: returns 0, no write, no event, no throw",
    (junk) => {
      const { storage, onChange } = setup(junk);

      expect(() => pruneStoredDiet(NOW)).not.toThrow();
      expect(pruneStoredDiet(NOW)).toBe(0);

      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      expect(storage._store.get(DIET_STORAGE_KEY)).toBe(junk);
    },
  );

  it("ignores malformed items when nothing valid has expired, and drops them in the rewrite when something has", () => {
    const fresh = { t: NOW - DAY, z: "muhalefet" };
    const untouched = setup([{ t: "x", z: "iktidar" }, { t: NOW, z: "nope" }, fresh]);
    expect(pruneStoredDiet(NOW)).toBe(0);
    expect(untouched.storage.setItem).not.toHaveBeenCalled();

    const rewritten = setup([
      { t: "x", z: "iktidar" },
      { t: NOW - 40 * DAY, z: "iktidar" },
      fresh,
    ]);
    expect(pruneStoredDiet(NOW)).toBe(1);
    expect(storedEntries(rewritten.storage)).toEqual({ v: 1, e: [fresh] });
  });

  it("returns 0 and does not throw when the localStorage getter itself throws", () => {
    stubWindow({ throwOnLocalStorageGetter: true });
    expect(() => pruneStoredDiet(NOW)).not.toThrow();
    expect(pruneStoredDiet(NOW)).toBe(0);
  });

  it("returns 0, writes nothing and fires no event when getItem throws", () => {
    const { storage, onChange } = setup([{ t: NOW - 40 * DAY, z: "iktidar" }], { throwOnGet: true });
    expect(() => pruneStoredDiet(NOW)).not.toThrow();
    expect(pruneStoredDiet(NOW)).toBe(0);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("returns 0 and fires no event when setItem throws (quota), leaving the stored value as it was", () => {
    const original = raw([
      { t: NOW - 40 * DAY, z: "iktidar" },
      { t: NOW - DAY, z: "muhalefet" },
    ]);
    const { storage, onChange } = setup(original, { throwOnSet: true });
    expect(() => pruneStoredDiet(NOW)).not.toThrow();
    expect(pruneStoredDiet(NOW)).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(storage._store.get(DIET_STORAGE_KEY)).toBe(original);
  });

  it("returns 0 and fires no event when removeItem throws", () => {
    const { storage, onChange } = setup([{ t: NOW - 40 * DAY, z: "iktidar" }], {
      throwOnRemove: true,
    });
    expect(() => pruneStoredDiet(NOW)).not.toThrow();
    expect(pruneStoredDiet(NOW)).toBe(0);
    expect(storage.removeItem).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is a no-op on the server (no window)", () => {
    vi.unstubAllGlobals();
    expect(() => pruneStoredDiet(NOW)).not.toThrow();
    expect(pruneStoredDiet(NOW)).toBe(0);
  });

  it("drops an entry more than 60 s in the future (clock-skew rule) and keeps one within 60 s", () => {
    const { storage } = setup([
      { t: NOW - DAY, z: "iktidar" },
      { t: NOW + 30_000, z: "bagimsiz" },
      { t: NOW + 2 * 60_000, z: "muhalefet" },
    ]);

    expect(pruneStoredDiet(NOW)).toBe(1);

    expect(storedEntries(storage)).toEqual({
      v: 1,
      e: [
        { t: NOW - DAY, z: "iktidar" },
        { t: NOW + 30_000, z: "bagimsiz" },
      ],
    });
  });

  it("keeps only the newest 500 entries when the store holds more", () => {
    const entries = Array.from({ length: DIET_MAX_ENTRIES + 10 }, (_, i) => ({
      t: NOW - (DIET_MAX_ENTRIES + 10 - i) * 1000,
      z: "iktidar",
    }));
    const { storage } = setup(entries);

    expect(pruneStoredDiet(NOW)).toBe(10);

    const written = storedEntries(storage) as { v: number; e: DietEntry[] };
    expect(written.e).toHaveLength(DIET_MAX_ENTRIES);
    expect(written.e[0]).toEqual(entries[10]);
    expect(written.e.at(-1)).toEqual(entries.at(-1));
  });

  it("uses the same 30-day boundary as the click-time prune (exactly 30 days is kept, 1 ms older is dropped)", () => {
    const edge = [
      { t: NOW - 30 * DAY - 1, z: "iktidar" },
      { t: NOW - 30 * DAY, z: "muhalefet" },
      { t: NOW - DAY, z: "bagimsiz" },
    ];

    // Load-time prune.
    const load = setup(edge);
    expect(pruneStoredDiet(NOW)).toBe(1);
    const afterLoad = (storedEntries(load.storage) as { e: DietEntry[] }).e;

    // Click-time prune of an identical store at the same instant.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const click = setup(edge);
    recordReadingClick("outbound", { zone: "iktidar" });
    const afterClick = (storedEntries(click.storage) as { e: DietEntry[] }).e.filter(
      (e) => e.t !== NOW,
    );

    expect(afterLoad).toEqual(afterClick);
    expect(afterLoad.map((e) => e.t)).toEqual([NOW - 30 * DAY, NOW - DAY]);
    // And it is the shared function's verdict, not a re-implementation of it.
    expect(afterLoad).toEqual(pruneDiet(parseDiet(raw(edge)), NOW));
  });

  it("defaults the clock to Date.now()", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { storage } = setup([
      { t: NOW - 40 * DAY, z: "iktidar" },
      { t: NOW - DAY, z: "muhalefet" },
    ]);

    expect(pruneStoredDiet()).toBe(1);
    expect(storedEntries(storage)).toEqual({ v: 1, e: [{ t: NOW - DAY, z: "muhalefet" }] });
  });

  it("is idempotent: a second call finds nothing to do and does not write again", () => {
    const { storage, onChange } = setup([
      { t: NOW - 40 * DAY, z: "iktidar" },
      { t: NOW - DAY, z: "muhalefet" },
    ]);

    expect(pruneStoredDiet(NOW)).toBe(1);
    expect(pruneStoredDiet(NOW)).toBe(0);

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("refreshes the cached snapshot: subscribers see the pruned entries after the change event", () => {
    const fresh = { t: NOW - DAY, z: "muhalefet" };
    const { storage } = setup([
      { t: NOW - 40 * DAY, z: "iktidar" },
      { t: NOW - 95 * DAY, z: "iktidar" },
      fresh,
    ]);
    const before = readDietSnapshot();
    expect(before.entries).toHaveLength(3);

    const onChange = vi.fn();
    const unsubscribe = subscribeDiet(onChange);
    pruneStoredDiet(NOW);
    unsubscribe();

    expect(onChange).toHaveBeenCalledTimes(1);
    const after = readDietSnapshot();
    expect(after).not.toBe(before);
    expect(after.entries).toEqual([fresh]);
    expect(storage._store.has(DIET_STORAGE_KEY)).toBe(true);
  });
});

// h201-diet-1: the 7- and 30-day windows were anchored to `readAt`, which was only re-stamped when the raw
// localStorage string changed. A tab (or a preserved /diyetim route) that outlived a click kept counting clicks
// that had long left the window. The anchor is now refreshed once it is older than DIET_SNAPSHOT_MAX_AGE_MS, and
// subscribers are nudged on focus / visibility / pageshow / a coarse tick so a long-lived tab re-reads it.
describe("snapshot clock (h201-diet-1)", () => {
  const MINUTE = 60 * 1000;
  const DAY = 24 * 60 * MINUTE;
  const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);

  function raw(entries: ReadonlyArray<{ t: number; z: string }>): string {
    return JSON.stringify({ v: 1, e: entries });
  }

  // The store keeps its cache in module state, so every test stores a raw string no earlier test used (a unique
  // millisecond offset), which makes its first read a real read instead of a cache hit on a previous test's snapshot.
  let nonce = 0;

  // The repro of the finding: 12 clicks stored 6 days before T0.
  function sixDayClicks(): Array<{ t: number; z: string }> {
    nonce += 1;
    return Array.from({ length: 12 }, (_, i) => ({
      t: T0 - 6 * DAY + i * 1000 + nonce,
      z: i % 3 === 0 ? "iktidar" : i % 3 === 1 ? "muhalefet" : "bagimsiz",
    }));
  }

  function setup(entries: ReadonlyArray<{ t: number; z: string }> = sixDayClicks()) {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const storage = makeFakeStorage({ initial: { [DIET_STORAGE_KEY]: raw(entries) } });
    const win = stubWindow({ storage });
    return { storage, ...win };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a long-lived tab: the same raw string, read days later, no longer counts clicks that left the window", () => {
    setup();
    const first = readDietSnapshot();
    expect(first.readAt).toBe(T0);
    expect(summarizeDiet(first.entries, first.readAt).total).toBe(12);

    vi.setSystemTime(T0 + 9 * DAY); // the clicks are now 15 days old; no click was stored in between
    const later = readDietSnapshot();

    expect(later.readAt).toBe(T0 + 9 * DAY);
    const summary = summarizeDiet(later.entries, later.readAt);
    expect(summary.total).toBe(0); // week
    expect(summary.total30d).toBe(12); // month: still inside 30 days
    expect(summary.leastRead).toBeNull();
  });

  it("clicks older than 30 days leave the 30-day window too, without any storage change", () => {
    setup();
    expect(summarizeDiet(readDietSnapshot().entries, T0).total30d).toBe(12);

    vi.setSystemTime(T0 + 25 * DAY); // 31 days old
    const later = readDietSnapshot();
    expect(summarizeDiet(later.entries, later.readAt).total30d).toBe(0);
  });

  it("the refreshed snapshot is a new object (so subscribers re-render) that keeps the very same entries array", () => {
    setup();
    const first = readDietSnapshot();
    vi.setSystemTime(T0 + DIET_SNAPSHOT_MAX_AGE_MS);
    const later = readDietSnapshot();

    expect(later).not.toBe(first);
    expect(later.entries).toBe(first.entries);
    expect(later.available).toBe(first.available);
  });

  it("inside the max age two reads return the identical object (useSyncExternalStore must not loop)", () => {
    setup();
    const first = readDietSnapshot();
    vi.setSystemTime(T0 + DIET_SNAPSHOT_MAX_AGE_MS - 1);
    expect(readDietSnapshot()).toBe(first);
    expect(readDietSnapshot()).toBe(first);
  });

  it("after a refresh the new anchor is stable again until it ages out in turn", () => {
    setup();
    readDietSnapshot();
    vi.setSystemTime(T0 + 2 * DIET_SNAPSHOT_MAX_AGE_MS);
    const second = readDietSnapshot();
    expect(readDietSnapshot()).toBe(second);
    vi.setSystemTime(T0 + 2 * DIET_SNAPSHOT_MAX_AGE_MS + DIET_SNAPSHOT_MAX_AGE_MS - 1);
    expect(readDietSnapshot()).toBe(second);
    vi.setSystemTime(T0 + 3 * DIET_SNAPSHOT_MAX_AGE_MS);
    expect(readDietSnapshot()).not.toBe(second);
  });

  it("a clock that jumped backwards re-stamps instead of anchoring the windows in the future", () => {
    setup();
    const first = readDietSnapshot();
    vi.setSystemTime(T0 - 2 * DAY);
    const later = readDietSnapshot();
    expect(later).not.toBe(first);
    expect(later.readAt).toBe(T0 - 2 * DAY);
  });

  it("a changed raw string still re-parses and re-stamps at once", () => {
    const { storage } = setup();
    const first = readDietSnapshot();
    vi.setSystemTime(T0 + 1000);
    storage._store.set(DIET_STORAGE_KEY, raw([{ t: T0, z: "iktidar" }]));
    const next = readDietSnapshot();
    expect(next).not.toBe(first);
    expect(next.entries).toHaveLength(1);
    expect(next.readAt).toBe(T0 + 1000);
  });

  it("an unavailable store stays unavailable and empty across a refresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    stubWindow({ throwOnLocalStorageGetter: true });
    const first = readDietSnapshot();
    expect(first.available).toBe(false);
    vi.setSystemTime(T0 + DAY);
    const later = readDietSnapshot();
    expect(later.available).toBe(false);
    expect(later.entries).toEqual([]);
  });

  describe("subscribeDiet nudges the subscriber when the tab comes back", () => {
    function stubDocument(visibilityState: "visible" | "hidden") {
      const listeners = new Map<string, Set<(e: unknown) => void>>();
      const fakeDocument = {
        visibilityState,
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
      };
      vi.stubGlobal("document", fakeDocument);
      return { fakeDocument, listeners };
    }

    it.each(["pageshow", "focus"])("%s on the window calls onChange", (type) => {
      const { fakeWindow } = setup();
      stubDocument("visible");
      const onChange = vi.fn();
      const unsubscribe = subscribeDiet(onChange);
      fakeWindow.dispatchEvent(new Event(type));
      expect(onChange).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it("visibilitychange to visible calls onChange, to hidden does not", () => {
      setup();
      const { fakeDocument } = stubDocument("hidden");
      const onChange = vi.fn();
      const unsubscribe = subscribeDiet(onChange);

      fakeDocument.dispatchEvent(new Event("visibilitychange"));
      expect(onChange).not.toHaveBeenCalled();

      fakeDocument.visibilityState = "visible";
      fakeDocument.dispatchEvent(new Event("visibilitychange"));
      expect(onChange).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it("a coarse tick calls onChange while the tab is visible and stays quiet while it is hidden", () => {
      setup();
      const { fakeDocument } = stubDocument("visible");
      const onChange = vi.fn();
      const unsubscribe = subscribeDiet(onChange);
      vi.advanceTimersByTime(0); // the one check made right after subscribing
      onChange.mockClear();

      vi.advanceTimersByTime(DIET_CLOCK_TICK_MS);
      expect(onChange).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(DIET_CLOCK_TICK_MS);
      expect(onChange).toHaveBeenCalledTimes(2);

      fakeDocument.visibilityState = "hidden";
      vi.advanceTimersByTime(3 * DIET_CLOCK_TICK_MS);
      expect(onChange).toHaveBeenCalledTimes(2);
      unsubscribe();
    });

    it("checks once right after subscribing (a hidden <Activity> that is revealed re-subscribes)", () => {
      setup();
      stubDocument("visible");
      const onChange = vi.fn();
      const unsubscribe = subscribeDiet(onChange);
      expect(onChange).not.toHaveBeenCalled(); // never synchronously inside subscribe
      vi.advanceTimersByTime(0);
      expect(onChange).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it("unsubscribing removes every listener and stops the tick and the first check", () => {
      const { listeners } = setup();
      const doc = stubDocument("visible");
      const onChange = vi.fn();
      const unsubscribe = subscribeDiet(onChange);
      unsubscribe();

      for (const type of ["storage", "tayf:diyet-change", "pageshow", "focus"]) {
        expect(listeners.get(type)?.size ?? 0).toBe(0);
      }
      expect(doc.listeners.get("visibilitychange")?.size ?? 0).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(10 * DIET_CLOCK_TICK_MS);
      expect(onChange).not.toHaveBeenCalled();
    });

    it("works with no document at all (the listeners on window and the tick still run)", () => {
      const { fakeWindow } = setup();
      const onChange = vi.fn();
      const unsubscribe = subscribeDiet(onChange);
      fakeWindow.dispatchEvent(new Event("focus"));
      expect(onChange).toHaveBeenCalledTimes(1);
      unsubscribe();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("end to end: a tick after days makes the subscriber read a snapshot whose windows have moved", () => {
      setup();
      stubDocument("visible");
      const seen: number[] = [];
      const onChange = () => {
        const snap = readDietSnapshot();
        seen.push(summarizeDiet(snap.entries, snap.readAt).total);
      };
      const first = readDietSnapshot();
      expect(summarizeDiet(first.entries, first.readAt).total).toBe(12);
      const unsubscribe = subscribeDiet(onChange);

      vi.advanceTimersByTime(9 * DAY);
      unsubscribe();

      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toBe(12); // right after subscribing nothing had aged yet
      expect(seen.at(-1)).toBe(0);
    });
  });
});
