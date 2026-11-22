import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// h201: the bookmark store with a stubbed window and an in-memory localStorage.
//   1. A refused write (quota) used to be undone by the very next read: readSet reset
//      memoryOnly and re-parsed the stale stored value, so the star flipped on and straight
//      back off while the side effects (a saved_clusters RPC, a service-worker pin) still
//      went out. The documented memory-only fallback now holds for the session.
//   2. /saved removed through toggle, which ADDS an absent id. remove(id) only removes.

const spies = vi.hoisted(() => ({
  captureSnapshot: vi.fn(async (_id: string): Promise<void> => {}),
  removeSnapshot: vi.fn((_id: string): void => {}),
  pinForOffline: vi.fn((_id: string): boolean => true),
  unpinForOffline: vi.fn((_id: string): boolean => true),
}));

vi.mock("@/components/bookmark/bookmark-snapshots", () => ({
  captureSnapshot: spies.captureSnapshot,
  removeSnapshot: spies.removeSnapshot,
}));
vi.mock("@/lib/pwa/offline-pins", () => ({
  pinForOffline: spies.pinForOffline,
  unpinForOffline: spies.unpinForOffline,
}));

const KEY = "tayf:bookmarks";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const X = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

interface Browser {
  storage: Map<string, string>;
  setItem: ReturnType<typeof vi.fn>;
  getItem: ReturnType<typeof vi.fn>;
  /** tayf:bookmarks-change events dispatched on this tab's window. */
  changes: () => number;
  refuseWrites: (on: boolean) => void;
  blockReads: (on: boolean) => void;
  /** Another tab writes the list; `notify` also delivers the `storage` event to this tab. */
  otherTabWrites: (ids: string[], notify?: boolean) => void;
  stored: () => string[] | null;
}

function installBrowser(seed?: string[]): Browser {
  const storage = new Map<string, string>();
  if (seed) storage.set(KEY, JSON.stringify(seed));
  const win = new EventTarget();
  let changes = 0;
  win.addEventListener("tayf:bookmarks-change", () => {
    changes += 1;
  });
  let refuse = false;
  let blocked = false;
  const getItem = vi.fn((k: string) => {
    if (blocked) throw new Error("SecurityError");
    return storage.has(k) ? (storage.get(k) as string) : null;
  });
  const setItem = vi.fn((k: string, v: string) => {
    if (refuse) throw new DOMException("quota", "QuotaExceededError");
    storage.set(k, v);
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", { getItem, setItem, removeItem: (k: string) => storage.delete(k) });
  return {
    storage,
    setItem,
    getItem,
    changes: () => changes,
    refuseWrites: (on) => {
      refuse = on;
    },
    blockReads: (on) => {
      blocked = on;
    },
    otherTabWrites: (ids, notify = true) => {
      storage.set(KEY, JSON.stringify(ids));
      if (notify) win.dispatchEvent(Object.assign(new Event("storage"), { key: KEY }));
    },
    stored: () => {
      const raw = storage.get(KEY);
      return raw === undefined ? null : (JSON.parse(raw) as string[]);
    },
  };
}

async function loadModule() {
  vi.resetModules();
  return import("@/components/bookmark/use-bookmarks");
}

async function loadStore() {
  return (await loadModule()).bookmarksStore;
}

function ids(store: { read: () => ReadonlySet<string> }): string[] {
  return Array.from(store.read());
}

beforeEach(() => {
  for (const spy of Object.values(spies)) spy.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bookmarksStore.toggle with working storage", () => {
  it("adds, stores, notifies once and fires the add side effects once", async () => {
    const browser = installBrowser();
    const store = await loadStore();
    const change = store.toggle(A.toUpperCase());
    expect(change).toEqual({ key: A, added: true, stored: true });
    expect(browser.stored()).toEqual([A]);
    expect(browser.changes()).toBe(1);
    expect(ids(store)).toEqual([A]);
    expect(spies.captureSnapshot).toHaveBeenCalledTimes(1);
    expect(spies.captureSnapshot).toHaveBeenCalledWith(A);
    expect(spies.pinForOffline).toHaveBeenCalledTimes(1);
    expect(spies.pinForOffline).toHaveBeenCalledWith(A);
    expect(spies.removeSnapshot).not.toHaveBeenCalled();
    expect(spies.unpinForOffline).not.toHaveBeenCalled();
  });

  it("removes a saved id and fires the remove side effects once", async () => {
    const browser = installBrowser([A, B]);
    const store = await loadStore();
    const change = store.toggle(A);
    expect(change).toEqual({ key: A, added: false, stored: true });
    expect(browser.stored()).toEqual([B]);
    expect(spies.removeSnapshot).toHaveBeenCalledTimes(1);
    expect(spies.removeSnapshot).toHaveBeenCalledWith(A);
    expect(spies.unpinForOffline).toHaveBeenCalledTimes(1);
    expect(spies.unpinForOffline).toHaveBeenCalledWith(A);
    expect(spies.captureSnapshot).not.toHaveBeenCalled();
    expect(spies.pinForOffline).not.toHaveBeenCalled();
  });

  it("does nothing for an empty or non-string id", async () => {
    const browser = installBrowser([A]);
    const store = await loadStore();
    expect(store.toggle("")).toBeNull();
    expect(store.toggle("   ")).toBeNull();
    expect(store.toggle(undefined as unknown as string)).toBeNull();
    expect(browser.setItem).not.toHaveBeenCalled();
    expect(browser.changes()).toBe(0);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  it("reads storage fresh instead of closing over an older snapshot", async () => {
    const browser = installBrowser([A]);
    const store = await loadStore();
    expect(ids(store)).toEqual([A]);
    // Another tab saved B and this tab has not seen the storage event yet.
    browser.otherTabWrites([A, B], false);
    const change = store.toggle(B);
    expect(change?.added).toBe(false);
    expect(browser.stored()).toEqual([A]);
  });
});

describe("bookmarksStore storage events", () => {
  it("re-reads when another tab writes the key, and ignores other keys", async () => {
    const browser = installBrowser([A]);
    const store = await loadStore();
    const onChange = vi.fn();
    const unsubscribe = store.subscribe(onChange);
    expect(ids(store)).toEqual([A]);

    browser.otherTabWrites([A, B]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(ids(store)).toEqual([A, B]);

    (window as unknown as EventTarget).dispatchEvent(Object.assign(new Event("storage"), { key: "tayf:follows" }));
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
    browser.otherTabWrites([C]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("notifies this tab through tayf:bookmarks-change after its own write", async () => {
    installBrowser();
    const store = await loadStore();
    const onChange = vi.fn();
    store.subscribe(onChange);
    store.toggle(A);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("returns the same set object while nothing changed (useSyncExternalStore needs it)", async () => {
    installBrowser([A, B]);
    const store = await loadStore();
    expect(store.read()).toBe(store.read());
    store.toggle(C);
    const afterWrite = store.read();
    expect(store.read()).toBe(afterWrite);
  });

  it("serves the empty set to the server render", async () => {
    installBrowser([A]);
    const store = await loadStore();
    expect(store.getServerSnapshot().size).toBe(0);
  });
});

describe("bookmarksStore.toggle when setItem is refused but getItem works (quota)", () => {
  it("keeps the saved id for the session instead of snapping back", async () => {
    const browser = installBrowser();
    browser.refuseWrites(true);
    const store = await loadStore();
    const change = store.toggle(A);
    expect(change).toEqual({ key: A, added: true, stored: false });
    // useSyncExternalStore reads again straight after the change event, and on every render.
    expect(ids(store)).toEqual([A]);
    expect(ids(store)).toEqual([A]);
    expect(browser.stored()).toBeNull();
    expect(browser.changes()).toBe(1);
  });

  it("does not make the saved_clusters request or ask the service worker to download the page", async () => {
    const browser = installBrowser();
    browser.refuseWrites(true);
    const store = await loadStore();
    store.toggle(A);
    expect(spies.captureSnapshot).not.toHaveBeenCalled();
    expect(spies.pinForOffline).not.toHaveBeenCalled();
  });

  it("stays in memory-only mode for later toggles", async () => {
    const browser = installBrowser();
    browser.refuseWrites(true);
    const store = await loadStore();
    store.toggle(A);
    store.toggle(B);
    expect(ids(store)).toEqual([A, B]);
    const removal = store.toggle(A);
    expect(removal).toEqual({ key: A, added: false, stored: false });
    expect(ids(store)).toEqual([B]);
    expect(spies.captureSnapshot).not.toHaveBeenCalled();
    expect(spies.pinForOffline).not.toHaveBeenCalled();
    // A removal that took effect still cleans up after itself (and frees space).
    expect(spies.removeSnapshot).toHaveBeenCalledWith(A);
    expect(spies.unpinForOffline).toHaveBeenCalledWith(A);
  });

  it("keeps the ids that were already stored next to the refused one", async () => {
    const browser = installBrowser([X]);
    browser.refuseWrites(true);
    const store = await loadStore();
    store.toggle(A);
    expect(ids(store)).toEqual([X, A]);
    expect(ids(store)).toEqual([X, A]);
    expect(browser.stored()).toEqual([X]);
  });

  it("lets an external change win: another tab's write replaces the memory list", async () => {
    const browser = installBrowser([X]);
    browser.refuseWrites(true);
    const store = await loadStore();
    store.toggle(A);
    expect(ids(store)).toEqual([X, A]);

    browser.otherTabWrites([X, C]);
    expect(ids(store)).toEqual([X, C]);

    // Mirroring storage again: a later refused write is held in memory on top of it.
    store.toggle(B);
    expect(ids(store)).toEqual([X, C, B]);
    expect(browser.stored()).toEqual([X, C]);
  });

  it("flushes the whole in-memory list once writes work again", async () => {
    const browser = installBrowser();
    browser.refuseWrites(true);
    const store = await loadStore();
    store.toggle(A);
    browser.refuseWrites(false);
    const change = store.toggle(B);
    expect(change).toEqual({ key: B, added: true, stored: true });
    expect(browser.stored()).toEqual([A, B]);
    expect(ids(store)).toEqual([A, B]);
    // Only the add that was actually stored fires the side effects.
    expect(spies.captureSnapshot).toHaveBeenCalledTimes(1);
    expect(spies.captureSnapshot).toHaveBeenCalledWith(B);
    expect(spies.pinForOffline).toHaveBeenCalledTimes(1);
    expect(spies.pinForOffline).toHaveBeenCalledWith(B);
  });

  it("remove(id) of an id that only lives in memory removes it and never re-adds it", async () => {
    const browser = installBrowser();
    browser.refuseWrites(true);
    const store = await loadStore();
    store.toggle(A);
    const removal = store.remove(A);
    expect(removal).toEqual({ key: A, added: false, stored: false });
    expect(ids(store)).toEqual([]);
    expect(store.remove(A)).toBeNull();
    expect(ids(store)).toEqual([]);
  });

  it("importBookmarkIds keeps reporting stored:false while the list is memory-only", async () => {
    const browser = installBrowser();
    browser.refuseWrites(true);
    const { bookmarksStore: store, importBookmarkIds } = await loadModule();
    store.toggle(A);
    const again = importBookmarkIds([A], 100);
    expect(again.added).toBe(0);
    expect(again.existing).toBe(1);
    expect(again.stored).toBe(false);
    const more = importBookmarkIds([B], 100);
    expect(more.added).toBe(1);
    expect(more.stored).toBe(false);
    expect(ids(store)).toEqual([A, B]);
  });
});

describe("bookmarksStore.toggle when getItem throws (blocked storage)", () => {
  it("keeps the change in memory and fires no storage-dependent side effect", async () => {
    const browser = installBrowser();
    browser.blockReads(true);
    browser.refuseWrites(true);
    const store = await loadStore();
    const change = store.toggle(A);
    expect(change).toEqual({ key: A, added: true, stored: false });
    expect(ids(store)).toEqual([A]);
    expect(spies.captureSnapshot).not.toHaveBeenCalled();
    expect(spies.pinForOffline).not.toHaveBeenCalled();
  });
});

describe("bookmarksStore.remove", () => {
  it("removes exactly the id it is given and fires the remove side effects once", async () => {
    const browser = installBrowser([A, B, C]);
    const store = await loadStore();
    const change = store.remove(B.toUpperCase());
    expect(change).toEqual({ key: B, added: false, stored: true });
    expect(browser.stored()).toEqual([A, C]);
    expect(browser.changes()).toBe(1);
    expect(spies.removeSnapshot).toHaveBeenCalledTimes(1);
    expect(spies.removeSnapshot).toHaveBeenCalledWith(B);
    expect(spies.unpinForOffline).toHaveBeenCalledTimes(1);
    expect(spies.unpinForOffline).toHaveBeenCalledWith(B);
    expect(spies.captureSnapshot).not.toHaveBeenCalled();
    expect(spies.pinForOffline).not.toHaveBeenCalled();
  });

  it("is idempotent: a second remove of the same id writes nothing, notifies nothing, fires nothing", async () => {
    const browser = installBrowser([A, B]);
    const store = await loadStore();
    expect(store.remove(A)).not.toBeNull();
    browser.setItem.mockClear();
    spies.removeSnapshot.mockClear();
    spies.unpinForOffline.mockClear();
    const changesBefore = browser.changes();

    expect(store.remove(A)).toBeNull();
    expect(browser.setItem).not.toHaveBeenCalled();
    expect(browser.changes()).toBe(changesBefore);
    expect(spies.removeSnapshot).not.toHaveBeenCalled();
    expect(spies.unpinForOffline).not.toHaveBeenCalled();
    // The next story is untouched by the repeated tap.
    expect(browser.stored()).toEqual([B]);
  });

  it("never adds: removing an id that is not saved leaves the list and storage alone", async () => {
    const browser = installBrowser();
    const store = await loadStore();
    expect(store.remove(A)).toBeNull();
    expect(browser.setItem).not.toHaveBeenCalled();
    expect(browser.stored()).toBeNull();
    expect(ids(store)).toEqual([]);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  it("does not re-add a story another tab already removed (stale rows, no storage event yet)", async () => {
    const browser = installBrowser([A, B]);
    const store = await loadStore();
    expect(ids(store)).toEqual([A, B]);
    // Tab 2 removed A; this tab's /saved list still shows A while its lookup is running.
    browser.otherTabWrites([B], false);
    expect(store.remove(A)).toBeNull();
    expect(browser.setItem).not.toHaveBeenCalled();
    expect(browser.stored()).toEqual([B]);
    expect(ids(store)).toEqual([B]);
    expect(spies.captureSnapshot).not.toHaveBeenCalled();
    expect(spies.pinForOffline).not.toHaveBeenCalled();
  });

  it("two removals of different ids remove both, each by its own id", async () => {
    const browser = installBrowser([A, B, C]);
    const store = await loadStore();
    store.remove(A);
    store.remove(C);
    expect(browser.stored()).toEqual([B]);
  });

  it("ignores an empty or non-string id", async () => {
    const browser = installBrowser([A]);
    const store = await loadStore();
    expect(store.remove("")).toBeNull();
    expect(store.remove("  ")).toBeNull();
    expect(store.remove(null as unknown as string)).toBeNull();
    expect(browser.setItem).not.toHaveBeenCalled();
    expect(browser.stored()).toEqual([A]);
  });
});

describe("useBookmarks", () => {
  function probe(mod: Awaited<ReturnType<typeof loadModule>>) {
    let captured: ReturnType<typeof mod.useBookmarks> | null = null;
    function Probe() {
      captured = mod.useBookmarks();
      return null;
    }
    renderToStaticMarkup(<Probe />);
    if (captured === null) throw new Error("hook did not run");
    return captured as ReturnType<typeof mod.useBookmarks>;
  }

  it("exposes remove next to toggle, and both go through the store", async () => {
    const browser = installBrowser([A, B]);
    const mod = await loadModule();
    const hook = probe(mod);
    expect(typeof hook.toggle).toBe("function");
    expect(typeof hook.remove).toBe("function");

    hook.remove(A);
    expect(browser.stored()).toEqual([B]);
    // The render-time snapshot still lists A (the hook was rendered on the server);
    // a second remove is still a no-op and cannot add it back.
    hook.remove(A);
    expect(browser.stored()).toEqual([B]);

    hook.toggle(C);
    expect(browser.stored()).toEqual([B, C]);
  });

  it("keeps a stable toggle and remove (they no longer close over the render-time ids)", async () => {
    installBrowser();
    const mod = await loadModule();
    const first = probe(mod);
    const second = probe(mod);
    // Separate renders of the same module state: the callbacks delegate to the store, so
    // behaviour never depends on which render they came from.
    first.toggle(A);
    expect(Array.from(mod.bookmarksStore.read())).toEqual([A]);
    second.remove(A);
    expect(Array.from(mod.bookmarksStore.read())).toEqual([]);
  });
});
