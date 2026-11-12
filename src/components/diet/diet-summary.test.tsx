import type { DependencyList, EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DIET_STORAGE_KEY, summarizeDiet, type DietEntry, type DietZone } from "@/lib/diet/diet";

import { DietSummary } from "./diet-summary";

// h67-landmarks-2: the zone bar was role="img" named "Bu hafta: İktidar 3,
// Bağımsız 4, Muhalefet 5", and the same three counts are printed as a <p>
// directly below it ("İktidar 3 · Bağımsız 4 · Muhalefet 5", under the visible
// "Bu hafta (son 7 gün)" heading). A screen reader read the counts twice. The bar
// is now aria-hidden and the visible line is the one text alternative.

const hook = vi.hoisted(() => ({
  value: { hydrated: true, available: true, summary: undefined as unknown },
}));

vi.mock("./use-reading-diet", () => ({
  useReadingDiet: () => hook.value,
}));

// renderToStaticMarkup never runs effects (which is also why nothing below can
// touch storage during SSR). When a test asks, the effect body runs at once, the
// same stand-in page-last-visit.test.tsx uses; the deps are recorded so "once per
// mount" can be pinned.
const effects = vi.hoisted(() => ({
  run: false,
  deps: [] as Array<DependencyList | undefined>,
}));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return {
    ...actual,
    useEffect: (fn: EffectCallback, deps?: DependencyList): void => {
      if (effects.run) {
        effects.deps.push(deps);
        fn();
      } else {
        actual.useEffect(fn, deps);
      }
    },
  };
});

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

function clicks(zone: DietZone, n: number): DietEntry[] {
  return Array.from({ length: n }, (_, i) => ({ t: NOW - 1000 * 60 * (i + 5), z: zone }));
}

function render(entries: DietEntry[]): string {
  hook.value = { hydrated: true, available: true, summary: summarizeDiet(entries, NOW) };
  return renderToStaticMarkup(<DietSummary />);
}

// 3 + 4 + 5 = 12 clicks this week, over the 10-click floor, so the bar shows.
const ENTRIES = [...clicks("iktidar", 3), ...clicks("bagimsiz", 4), ...clicks("muhalefet", 5)];

describe("DietSummary zone bar (h67-landmarks-2)", () => {
  const out = render(ENTRIES);

  it("renders the bar and the visible counts line", () => {
    expect(out).toContain("Bu hafta (son 7 gün)");
    expect(out).toContain("İktidar 3 · Bağımsız 4 · Muhalefet 5");
    expect(out).toContain("bg-red-500");
    expect(out).toContain("bg-zinc-400");
    expect(out).toContain("bg-emerald-500");
  });

  it("hides the bar from assistive tech: no role=\"img\", no aria-label, aria-hidden=\"true\"", () => {
    expect(out).not.toContain('role="img"');
    expect(out).not.toContain("aria-label=");
    const bar = out.match(/<div[^>]*class="flex h-3 w-full[^"]*"[^>]*>/);
    expect(bar, "the zone bar").not.toBeNull();
    expect(bar?.[0]).toContain('aria-hidden="true"');
    expect(bar?.[0]).not.toContain("role=");
  });

  it("announces the counts once: the visible line, not a second aria-label copy", () => {
    expect(out.split("İktidar 3").length - 1).toBe(1);
    expect(out).not.toContain("İktidar 3, Bağımsız 4, Muhalefet 5");
  });

  it("shows no bar at all below the 10-click floor", () => {
    const few = render(clicks("iktidar", 2));
    expect(few).toContain("Az veri var (2 tıklama)");
    expect(few).not.toContain("rounded-full bg-muted");
  });
});

// h151-clientstate-2: /diyetim promises that entries older than 30 days are
// deleted on their own. The summary windows its display to 30 days, so the page
// looked right while the expired clicks (a dated record of which side the reader
// clicked) stayed in localStorage until the next counted click. Mounting the
// summary now prunes them; the rendered counts do not change.
describe("DietSummary load-time prune (h151-clientstate-2)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  afterEach(() => {
    effects.run = false;
    effects.deps.length = 0;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubStorage(entries: ReadonlyArray<{ t: number; z: string }> | string) {
    const initial = typeof entries === "string" ? entries : JSON.stringify({ v: 1, e: entries });
    const store = new Map<string, string>([[DIET_STORAGE_KEY, initial]]);
    const setItem = vi.fn((key: string, value: string) => void store.set(key, value));
    const removeItem = vi.fn((key: string) => void store.delete(key));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem,
        removeItem,
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    return { store, setItem, removeItem };
  }

  function mount(state: { hydrated: boolean; available: boolean } = { hydrated: true, available: true }) {
    hook.value = { ...state, summary: summarizeDiet([], NOW) };
    effects.run = true;
    return renderToStaticMarkup(<DietSummary />);
  }

  const FRESH = { t: NOW - DAY, z: "iktidar" };
  const FRESH_2 = { t: NOW - 3 * DAY, z: "muhalefet" };

  it("leaves only the fresh entries in storage after the mount effect", () => {
    const { store } = stubStorage([
      { t: NOW - 40 * DAY, z: "iktidar" },
      { t: NOW - 95 * DAY, z: "muhalefet" },
      { t: NOW - 31 * DAY, z: "bagimsiz" },
      FRESH_2,
      FRESH,
    ]);

    mount();

    expect(JSON.parse(store.get(DIET_STORAGE_KEY)!)).toEqual({ v: 1, e: [FRESH_2, FRESH] });
  });

  it("removes the key when every stored entry has expired", () => {
    const { store } = stubStorage([
      { t: NOW - 40 * DAY, z: "iktidar" },
      { t: NOW - 95 * DAY, z: "muhalefet" },
    ]);

    mount();

    expect(store.has(DIET_STORAGE_KEY)).toBe(false);
  });

  it("does not write when nothing has expired", () => {
    const { setItem, removeItem } = stubStorage([FRESH_2, FRESH]);

    mount();

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("does not throw or write on a junk stored value", () => {
    const { store, setItem, removeItem } = stubStorage("not json");

    expect(() => mount()).not.toThrow();

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(store.get(DIET_STORAGE_KEY)).toBe("not json");
  });

  it("prunes whichever branch the summary renders (skeleton, storage unavailable)", () => {
    for (const state of [
      { hydrated: false, available: true },
      { hydrated: true, available: false },
    ]) {
      const { store } = stubStorage([{ t: NOW - 40 * DAY, z: "iktidar" }, FRESH]);
      mount(state);
      expect(JSON.parse(store.get(DIET_STORAGE_KEY)!)).toEqual({ v: 1, e: [FRESH] });
      effects.deps.length = 0;
    }
  });

  it("registers the prune as a once-per-mount effect (empty dependency list)", () => {
    stubStorage([FRESH]);

    mount();

    expect(effects.deps).toEqual([[]]);
  });

  it("does not touch storage during a server render, where effects never run", () => {
    const { store, setItem, removeItem } = stubStorage([{ t: NOW - 40 * DAY, z: "iktidar" }, FRESH]);
    const before = store.get(DIET_STORAGE_KEY);

    hook.value = { hydrated: true, available: true, summary: summarizeDiet([], NOW) };
    effects.run = false;
    renderToStaticMarkup(<DietSummary />);

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(store.get(DIET_STORAGE_KEY)).toBe(before);
  });

  it("does not change what is rendered", () => {
    stubStorage([{ t: NOW - 40 * DAY, z: "iktidar" }, FRESH]);
    const entries = [...clicks("iktidar", 3), ...clicks("bagimsiz", 4), ...clicks("muhalefet", 5)];
    hook.value = { hydrated: true, available: true, summary: summarizeDiet(entries, NOW) };

    effects.run = false;
    const withoutEffect = renderToStaticMarkup(<DietSummary />);
    effects.run = true;
    const withEffect = renderToStaticMarkup(<DietSummary />);

    expect(withEffect).toBe(withoutEffect);
    expect(withEffect).toContain("İktidar 3 · Bağımsız 4 · Muhalefet 5");
  });
});
