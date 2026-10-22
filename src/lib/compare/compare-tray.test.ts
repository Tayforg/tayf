import { describe, it, expect } from "vitest";

import {
  COMPARE_HINT_ONE,
  COMPARE_HINT_TWO,
  COMPARE_TRAY_EVENT,
  COMPARE_TRAY_KEY,
  COMPARE_TRAY_MAX,
  addToTray,
  compareHint,
  parseTray,
  removeFromTray,
  trayHref,
} from "./compare-tray";

const A = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb";
const B = "cccccccc-2222-4222-8222-dddddddddddd";
const C = "eeeeeeee-3333-4333-8333-ffffffffffff";

describe("constants", () => {
  it("exposes the storage key, event name and size cap", () => {
    expect(COMPARE_TRAY_KEY).toBe("tayf:compare");
    expect(COMPARE_TRAY_EVENT).toBe("tayf:compare-change");
    expect(COMPARE_TRAY_MAX).toBe(2);
  });
});

describe("parseTray", () => {
  it("returns [] for null, empty, bad JSON and non-arrays", () => {
    expect(parseTray(null)).toEqual([]);
    expect(parseTray(undefined)).toEqual([]);
    expect(parseTray("")).toEqual([]);
    expect(parseTray("{not json")).toEqual([]);
    expect(parseTray('{"a":1}')).toEqual([]);
    expect(parseTray('"' + A + '"')).toEqual([]);
    expect(parseTray("42")).toEqual([]);
    expect(parseTray("null")).toEqual([]);
  });

  it("keeps valid ids in order", () => {
    expect(parseTray(JSON.stringify([A, B]))).toEqual([A, B]);
  });

  it("drops non-strings and invalid ids", () => {
    expect(parseTray(JSON.stringify([A, 5, null, "<script>", {}, B]))).toEqual([A, B]);
  });

  it("lowercases uppercase ids", () => {
    expect(parseTray(JSON.stringify([A.toUpperCase()]))).toEqual([A]);
  });

  it("dedupes, keeping the first occurrence", () => {
    expect(parseTray(JSON.stringify([A, B, A]))).toEqual([A, B]);
    expect(parseTray(JSON.stringify([A, A]))).toEqual([A]);
  });

  it("keeps the LAST two entries", () => {
    expect(parseTray(JSON.stringify([A, B, C]))).toEqual([B, C]);
  });
});

describe("addToTray", () => {
  it("appends to an empty tray", () => {
    expect(addToTray([], A)).toEqual([A]);
  });

  it("is a no-op when the id is already present", () => {
    const tray = [A, B];
    expect(addToTray(tray, A)).toEqual([A, B]);
    expect(addToTray([A], A)).toEqual([A]);
  });

  it("appends a second id", () => {
    expect(addToTray([A], B)).toEqual([A, B]);
  });

  it("evicts the oldest (FIFO) when a third id is added", () => {
    expect(addToTray([A, B], C)).toEqual([B, C]);
  });

  it("normalizes case so an uppercase route param still lands in the tray", () => {
    expect(addToTray([], A.toUpperCase())).toEqual([A]);
    expect(addToTray([A], A.toUpperCase())).toEqual([A]);
  });

  it("is a no-op for an invalid id", () => {
    expect(addToTray([A], "<script>")).toEqual([A]);
    expect(addToTray([], "not-a-uuid")).toEqual([]);
    expect(addToTray([A, B], "")).toEqual([A, B]);
  });

  it("does not mutate its input", () => {
    const tray = Object.freeze([A, B]) as readonly string[];
    expect(addToTray(tray, C)).toEqual([B, C]);
    expect(tray).toEqual([A, B]);
  });
});

describe("removeFromTray", () => {
  it("removes a present id", () => {
    expect(removeFromTray([A, B], A)).toEqual([B]);
    expect(removeFromTray([A, B], A.toUpperCase())).toEqual([B]);
  });

  it("is a no-op for an absent id", () => {
    expect(removeFromTray([A], B)).toEqual([A]);
    expect(removeFromTray([], A)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const tray = Object.freeze([A, B]) as readonly string[];
    removeFromTray(tray, A);
    expect(tray).toEqual([A, B]);
  });
});

describe("trayHref", () => {
  it("returns null unless the tray holds exactly two ids", () => {
    expect(trayHref([])).toBeNull();
    expect(trayHref([A])).toBeNull();
  });

  it("returns the compare href for two ids", () => {
    expect(trayHref([A, B])).toBe(`/karsilastir?a=${A}&b=${B}`);
  });
});

describe("compareHint", () => {
  const NOTICE = "Seçim temizlendi";

  it("pins the two in-tray copies", () => {
    expect(COMPARE_HINT_ONE).toBe(
      "Karşılaştırmaya eklendi · ikinci haberi açıp “Karşılaştır”a dokunun",
    );
    expect(COMPARE_HINT_TWO).toBe("İki haber seçildi · karşılaştırmaya hazır");
  });

  it("empty tray, no notice: an empty, screen-reader-only region", () => {
    expect(compareHint({ tray: [], id: A, notice: "" })).toEqual({
      text: "",
      srOnly: true,
    });
    // `notice` is optional.
    expect(compareHint({ tray: [], id: A })).toEqual({ text: "", srOnly: true });
  });

  it("empty tray with a notice: announces it, screen-reader-only", () => {
    expect(compareHint({ tray: [], id: A, notice: NOTICE })).toEqual({
      text: NOTICE,
      srOnly: true,
    });
  });

  it("one OTHER story in the tray: tells the reader this would be the second pick", () => {
    expect(compareHint({ tray: [B], id: A, notice: "" })).toEqual({
      text: "1 haber seçili · bunu ikinci olarak ekleyin",
      srOnly: false,
    });
  });

  it("two OTHER stories in the tray: warns that adding evicts the first pick", () => {
    expect(compareHint({ tray: [B, C], id: A, notice: "" })).toEqual({
      text: "2 haber seçili · eklerseniz ilk seçim çıkar",
      srOnly: false,
    });
  });

  it("only this story in the tray: the visible 'second story' hint", () => {
    expect(compareHint({ tray: [A], id: A, notice: "" })).toEqual({
      text: COMPARE_HINT_ONE,
      srOnly: false,
    });
  });

  it("two stories incl. this one: readiness, screen-reader-only (the link says it on screen)", () => {
    expect(compareHint({ tray: [B, A], id: A, notice: "" })).toEqual({
      text: COMPARE_HINT_TWO,
      srOnly: true,
    });
    expect(compareHint({ tray: [A, B], id: A, notice: "" })).toEqual({
      text: COMPARE_HINT_TWO,
      srOnly: true,
    });
  });

  it("in-tray states ignore a leftover notice", () => {
    expect(compareHint({ tray: [A], id: A, notice: NOTICE }).text).toBe(COMPARE_HINT_ONE);
    expect(compareHint({ tray: [B, A], id: A, notice: NOTICE }).text).toBe(COMPARE_HINT_TWO);
    expect(compareHint({ tray: [B], id: A, notice: NOTICE }).text).toBe(
      "1 haber seçili · bunu ikinci olarak ekleyin",
    );
    expect(compareHint({ tray: [B, C], id: A, notice: NOTICE }).text).toBe(
      "2 haber seçili · eklerseniz ilk seçim çıkar",
    );
  });
});
