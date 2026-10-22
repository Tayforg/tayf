import { describe, it, expect, vi } from "vitest";

import {
  COMPARE_UUID_RE,
  compareHref,
  parseCompareParams,
  parseSide,
} from "./compare-params";

const A = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb";
const B = "cccccccc-2222-4222-8222-dddddddddddd";

describe("COMPARE_UUID_RE", () => {
  it("matches a lowercase UUID and rejects uppercase (case is folded by parseSide)", () => {
    expect(COMPARE_UUID_RE.test(A)).toBe(true);
    expect(COMPARE_UUID_RE.test(A.toUpperCase())).toBe(false);
  });

  it("rejects wrong shapes", () => {
    expect(COMPARE_UUID_RE.test("not-a-uuid")).toBe(false);
    expect(COMPARE_UUID_RE.test(`${A}x`)).toBe(false);
    expect(COMPARE_UUID_RE.test(`x${A}`)).toBe(false);
  });
});

describe("parseSide", () => {
  it.each([undefined, "", "  ", "\t\n"])("treats %j as missing", (raw) => {
    expect(parseSide(raw)).toEqual({ kind: "missing" });
  });

  it("treats an empty array as missing", () => {
    expect(parseSide([])).toEqual({ kind: "missing" });
  });

  it("takes the first element of an array", () => {
    expect(parseSide([A, B])).toEqual({ kind: "id", id: A });
  });

  it("treats a blank first array element as missing even when later ones are valid", () => {
    expect(parseSide(["", B])).toEqual({ kind: "missing" });
  });

  it("lowercases an uppercase UUID", () => {
    expect(parseSide(A.toUpperCase())).toEqual({ kind: "id", id: A });
  });

  it("trims surrounding whitespace", () => {
    expect(parseSide(`  ${A}  `)).toEqual({ kind: "id", id: A });
  });

  it.each(["<script>", "not-a-uuid", "../../etc/passwd", "1; drop table x", "😀"])(
    "marks %j invalid",
    (raw) => {
      expect(parseSide(raw)).toEqual({ kind: "invalid" });
    },
  );

  it("marks a 65-char string invalid without running the regex", () => {
    const spy = vi.spyOn(COMPARE_UUID_RE, "test");
    try {
      expect(parseSide("a".repeat(65))).toEqual({ kind: "invalid" });
      expect(spy).not.toHaveBeenCalled();
      expect(parseSide("a".repeat(64))).toEqual({ kind: "invalid" });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("never echoes raw input in any output", () => {
    for (const raw of ["<script>alert(1)</script>", "not-a-uuid", "x".repeat(200)]) {
      expect(JSON.stringify(parseSide(raw))).not.toContain(raw);
    }
  });
});

describe("parseCompareParams", () => {
  it("parses two distinct ids", () => {
    expect(parseCompareParams({ a: A, b: B })).toEqual({
      a: { kind: "id", id: A },
      b: { kind: "id", id: B },
    });
  });

  it("reports b as duplicate when both ids are equal", () => {
    expect(parseCompareParams({ a: A, b: A })).toEqual({
      a: { kind: "id", id: A },
      b: { kind: "duplicate" },
    });
  });

  it("detects a duplicate across case differences", () => {
    expect(parseCompareParams({ a: A, b: A.toUpperCase() }).b).toEqual({
      kind: "duplicate",
    });
  });

  it("does not flag a duplicate for two missing or two invalid sides", () => {
    expect(parseCompareParams({})).toEqual({
      a: { kind: "missing" },
      b: { kind: "missing" },
    });
    expect(parseCompareParams({ a: "zzz", b: "zzz" })).toEqual({
      a: { kind: "invalid" },
      b: { kind: "invalid" },
    });
  });

  it("parses each side independently", () => {
    expect(parseCompareParams({ a: "bad", b: B })).toEqual({
      a: { kind: "invalid" },
      b: { kind: "id", id: B },
    });
  });

  it("never echoes raw input", () => {
    const out = JSON.stringify(
      parseCompareParams({ a: "<img src=x onerror=alert(1)>", b: ["javascript:alert(1)"] }),
    );
    expect(out).not.toContain("img");
    expect(out).not.toContain("javascript");
  });
});

describe("compareHref", () => {
  it("builds a two-id href", () => {
    expect(compareHref(A, B)).toBe(`/karsilastir?a=${A}&b=${B}`);
  });

  it("builds a one-id href", () => {
    expect(compareHref(A)).toBe(`/karsilastir?a=${A}`);
    expect(compareHref(null, B)).toBe(`/karsilastir?b=${B}`);
  });

  it("returns the bare path when neither id is valid", () => {
    expect(compareHref()).toBe("/karsilastir");
    expect(compareHref(null, null)).toBe("/karsilastir");
    expect(compareHref("", undefined)).toBe("/karsilastir");
  });

  it("drops invalid ids", () => {
    expect(compareHref("<script>", B)).toBe(`/karsilastir?b=${B}`);
    expect(compareHref(A, "not-a-uuid")).toBe(`/karsilastir?a=${A}`);
    expect(compareHref("x".repeat(65), "y")).toBe("/karsilastir");
  });

  it("normalizes case and never emits raw input", () => {
    expect(compareHref(A.toUpperCase(), B)).toBe(`/karsilastir?a=${A}&b=${B}`);
    expect(compareHref('"><script>', B)).not.toContain("script");
  });
});
