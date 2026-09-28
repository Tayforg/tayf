import { describe, it, expect } from "vitest";

import {
  STREAK_STORAGE_KEY,
  applyDailyResult,
  buildShareText,
  parseDailyStore,
  type DailyStore,
} from "./daily-share";

describe("STREAK_STORAGE_KEY", () => {
  it("is the fixed, versioned key", () => {
    expect(STREAK_STORAGE_KEY).toBe("tayf-gunun-tayfi-v1");
  });
});

describe("buildShareText", () => {
  const base = {
    number: 3,
    dateKey: "2026-09-30",
    score: 4,
    marks: [true, true, false, true, false],
    origin: "https://tayf.news",
  };

  it("returns exactly three lines in the specified shape", () => {
    const text = buildShareText(base);
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Günün Tayf'ı #3 · 4/5");
    expect(lines[1]).toBe("✅✅❌✅❌");
    expect(lines[2]).toBe("https://tayf.news/oyun?mod=gunluk&gun=2026-09-30");
  });

  it("contains no zone colour emoji or zone labels — no spoilers", () => {
    const text = buildShareText(base);
    expect(text).not.toContain("🟥");
    expect(text).not.toContain("⬜");
    expect(text).not.toContain("🟩");
    expect(text).not.toContain("İktidar");
    expect(text).not.toContain("Bağımsız");
    expect(text).not.toContain("Muhalefet");
  });
});

describe("parseDailyStore", () => {
  it("returns an empty store for null/undefined", () => {
    expect(parseDailyStore(null)).toEqual({
      v: 1,
      lastPlayed: null,
      streak: 0,
      best: 0,
      results: {},
    });
    expect(parseDailyStore(undefined)).toEqual({
      v: 1,
      lastPlayed: null,
      streak: 0,
      best: 0,
      results: {},
    });
  });

  it("returns an empty store for corrupt JSON", () => {
    expect(parseDailyStore("{not json")).toEqual({
      v: 1,
      lastPlayed: null,
      streak: 0,
      best: 0,
      results: {},
    });
  });

  it("returns an empty store for a valid JSON shape with the wrong version", () => {
    expect(parseDailyStore(JSON.stringify({ v: 2, streak: 5 }))).toEqual({
      v: 1,
      lastPlayed: null,
      streak: 0,
      best: 0,
      results: {},
    });
  });

  it("round-trips a well-formed store", () => {
    const store: DailyStore = {
      v: 1,
      lastPlayed: "2026-09-29",
      streak: 3,
      best: 5,
      results: { "2026-09-29": { score: 4, marks: [true, false, true, true, false] } },
    };
    expect(parseDailyStore(JSON.stringify(store))).toEqual(store);
  });

  it("drops malformed result entries but keeps well-formed ones", () => {
    const raw = JSON.stringify({
      v: 1,
      lastPlayed: "2026-09-29",
      streak: 1,
      best: 1,
      results: {
        "2026-09-29": { score: 3, marks: [true, false, true, false, false] },
        "2026-09-28": { score: "oops" },
      },
    });
    const parsed = parseDailyStore(raw);
    expect(Object.keys(parsed.results)).toEqual(["2026-09-29"]);
  });
});

describe("applyDailyResult — streak rules", () => {
  const marks5 = [true, true, true, true, true];

  it("increments the streak on consecutive days", () => {
    let store = parseDailyStore(null);
    store = applyDailyResult(store, {
      dateKey: "2026-09-28",
      todayKey: "2026-09-28",
      score: 5,
      marks: marks5,
    });
    expect(store.streak).toBe(1);

    store = applyDailyResult(store, {
      dateKey: "2026-09-29",
      todayKey: "2026-09-29",
      score: 5,
      marks: marks5,
    });
    expect(store.streak).toBe(2);

    store = applyDailyResult(store, {
      dateKey: "2026-09-30",
      todayKey: "2026-09-30",
      score: 5,
      marks: marks5,
    });
    expect(store.streak).toBe(3);
  });

  it("a same-day replay leaves the streak unchanged", () => {
    let store = parseDailyStore(null);
    store = applyDailyResult(store, {
      dateKey: "2026-09-28",
      todayKey: "2026-09-28",
      score: 5,
      marks: marks5,
    });
    expect(store.streak).toBe(1);

    store = applyDailyResult(store, {
      dateKey: "2026-09-28",
      todayKey: "2026-09-28",
      score: 5,
      marks: marks5,
    });
    expect(store.streak).toBe(1);
  });

  it("a gap resets the streak to 1", () => {
    let store = parseDailyStore(null);
    store = applyDailyResult(store, {
      dateKey: "2026-09-20",
      todayKey: "2026-09-20",
      score: 5,
      marks: marks5,
    });
    expect(store.streak).toBe(1);

    // A 3-day gap before the next play.
    store = applyDailyResult(store, {
      dateKey: "2026-09-24",
      todayKey: "2026-09-24",
      score: 5,
      marks: marks5,
    });
    expect(store.streak).toBe(1);
  });

  it("a past-day puzzle (dateKey !== todayKey) leaves streak/lastPlayed unchanged", () => {
    let store = parseDailyStore(null);
    store = applyDailyResult(store, {
      dateKey: "2026-09-28",
      todayKey: "2026-09-28",
      score: 5,
      marks: marks5,
    });
    const before = { ...store };

    store = applyDailyResult(store, {
      dateKey: "2026-09-20", // a replayed past puzzle
      todayKey: "2026-09-28",
      score: 2,
      marks: [true, false, false, true, false],
    });

    expect(store.streak).toBe(before.streak);
    expect(store.lastPlayed).toBe(before.lastPlayed);
    expect(store.results["2026-09-20"]).toEqual({ score: 2, marks: [true, false, false, true, false] });
  });

  it("best tracks the maximum streak ever reached", () => {
    let store = parseDailyStore(null);
    store = applyDailyResult(store, {
      dateKey: "2026-09-01",
      todayKey: "2026-09-01",
      score: 5,
      marks: marks5,
    });
    store = applyDailyResult(store, {
      dateKey: "2026-09-02",
      todayKey: "2026-09-02",
      score: 5,
      marks: marks5,
    });
    expect(store.best).toBe(2);

    // Gap resets streak to 1, but best stays at 2.
    store = applyDailyResult(store, {
      dateKey: "2026-09-10",
      todayKey: "2026-09-10",
      score: 5,
      marks: marks5,
    });
    expect(store.streak).toBe(1);
    expect(store.best).toBe(2);
  });

  it("results trim to the 14 newest keys", () => {
    let store = parseDailyStore(null);
    for (let i = 1; i <= 16; i++) {
      const dateKey = `2026-09-${String(i).padStart(2, "0")}`;
      store = applyDailyResult(store, { dateKey, todayKey: dateKey, score: 3, marks: marks5 });
    }
    expect(Object.keys(store.results)).toHaveLength(14);
    expect(store.results["2026-09-01"]).toBeUndefined();
    expect(store.results["2026-09-02"]).toBeUndefined();
    expect(store.results["2026-09-16"]).toBeDefined();
  });
});
