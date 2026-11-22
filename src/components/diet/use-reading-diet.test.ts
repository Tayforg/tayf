import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The repo has no DOM renderer, so the two React hooks the hook uses are replaced by plain equivalents
// (useSyncExternalStore reads the store right now; useMemo keeps the last value while its deps are
// identical) and useReadingDiet is called as a function. That is enough to see what a re-render after
// some time would show, which is what the finding is about.
const memoState = vi.hoisted(() => ({
  last: null as { deps: readonly unknown[]; value: unknown } | null,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
    useMemo: <T>(factory: () => T, deps: readonly unknown[]): T => {
      const last = memoState.last;
      if (last !== null && last.deps.length === deps.length && last.deps.every((d, i) => Object.is(d, deps[i]))) {
        return last.value as T;
      }
      const value = factory();
      memoState.last = { deps, value };
      return value;
    },
  };
});

import { DIET_STORAGE_KEY } from "@/lib/diet/diet";
import { useReadingDiet } from "./use-reading-diet";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);

function stubStorage(entries: ReadonlyArray<{ t: number; z: string }>) {
  const store = new Map<string, string>([[DIET_STORAGE_KEY, JSON.stringify({ v: 1, e: entries })]]);
  vi.stubGlobal("window", {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
}

describe("useReadingDiet -- windows follow the clock, not the first read (h201-diet-1)", () => {
  beforeEach(() => {
    memoState.last = null;
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a re-render days later, with no click in between, no longer counts clicks that left the 7-day window", () => {
    // 12 clicks 6 days old, stored with an offset no other test file shares.
    stubStorage(
      Array.from({ length: 12 }, (_, i) => ({
        t: T0 - 6 * DAY + i * 1000 + 7,
        z: i % 2 === 0 ? "iktidar" : "muhalefet",
      })),
    );

    const first = useReadingDiet();
    expect(first.hydrated).toBe(true);
    expect(first.summary.total).toBe(12);
    expect(first.summary.total30d).toBe(12);

    vi.setSystemTime(T0 + 9 * DAY); // the clicks are 15 days old now
    const later = useReadingDiet();

    expect(later.summary.total).toBe(0);
    expect(later.summary.total30d).toBe(12);
    expect(later.summary.leastRead).toBeNull();
    expect(later.summary).not.toBe(first.summary);
  });

  it("and past 30 days they are gone from the month too", () => {
    stubStorage([
      { t: T0 - 5 * DAY + 11, z: "iktidar" },
      { t: T0 - 5 * DAY + 12, z: "bagimsiz" },
    ]);
    expect(useReadingDiet().summary.total30d).toBe(2);

    vi.setSystemTime(T0 + 26 * DAY); // 31 days old
    expect(useReadingDiet().summary.total30d).toBe(0);
  });

  it("two renders inside the refresh age share one summary object (no needless recompute)", () => {
    stubStorage([{ t: T0 - DAY + 21, z: "iktidar" }]);
    const first = useReadingDiet();
    vi.setSystemTime(T0 + 1000);
    const second = useReadingDiet();
    expect(second.summary).toBe(first.summary);
  });
});
