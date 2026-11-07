import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { externalQueryChange, searchNavTarget } from "./search-nav";

describe("searchNavTarget", () => {
  it("returns null when mounting with ?q=abc and value already 'abc'", () => {
    expect(searchNavTarget({ value: "abc", pathname: "/", search: "q=abc" })).toBeNull();
  });

  it("returns null for an empty value with no q param", () => {
    expect(searchNavTarget({ value: "", pathname: "/", search: "" })).toBeNull();
  });

  it("builds a query for a new value on /", () => {
    expect(searchNavTarget({ value: "abc", pathname: "/", search: "" })).toBe("/?q=abc");
  });

  it("clearing the value returns the bare pathname", () => {
    expect(searchNavTarget({ value: "", pathname: "/", search: "q=abc" })).toBe("/");
  });

  it("drops page when the query changes", () => {
    expect(searchNavTarget({ value: "ab", pathname: "/", search: "q=a&page=3" })).toBe("/?q=ab");
  });

  it("returns null for a whitespace-only change", () => {
    expect(searchNavTarget({ value: "  abc  ", pathname: "/", search: "q=abc" })).toBeNull();
  });

  it("encodes Turkish characters", () => {
    const target = searchNavTarget({ value: "çağrı", pathname: "/", search: "" });
    expect(target).not.toBeNull();
    const url = new URL(target!, "http://x");
    expect(url.searchParams.get("q")).toBe("çağrı");
  });
});

// h60-forms-1: the home SearchBar seeded its input from ?q once, so any in-app
// navigation back to "/" (header logo, "Haberler", "Aramayı temizle", g h) kept
// the old text and the debounced effect wrote ?q=<old> straight back. The URL
// is now the source of truth whenever it changes from outside the component:
// externalQueryChange decides whether a new ?q is such a change.
describe("externalQueryChange", () => {
  it("returns '' when the URL lost its query (logo, 'Aramayı temizle', g h)", () => {
    expect(externalQueryChange({ urlQ: "", lastWritten: "tutuklama" })).toBe("");
  });

  it("returns null when the URL still shows what the bar last wrote", () => {
    expect(externalQueryChange({ urlQ: "tutuklama", lastWritten: "tutuklama" })).toBeNull();
  });

  it("returns null when only surrounding whitespace differs", () => {
    expect(externalQueryChange({ urlQ: "erdoğan", lastWritten: "erdoğan " })).toBeNull();
    expect(externalQueryChange({ urlQ: " erdoğan ", lastWritten: "erdoğan" })).toBeNull();
  });

  it("returns the URL query on Back/forward to a different query", () => {
    expect(externalQueryChange({ urlQ: "a", lastWritten: "ab" })).toBe("a");
  });

  it("returns the URL query when a link lands on a search from an empty bar", () => {
    expect(externalQueryChange({ urlQ: "seçim", lastWritten: "" })).toBe("seçim");
  });

  it("returns null when both sides are empty or whitespace-only", () => {
    expect(externalQueryChange({ urlQ: "", lastWritten: "" })).toBeNull();
    expect(externalQueryChange({ urlQ: "   ", lastWritten: "" })).toBeNull();
    expect(externalQueryChange({ urlQ: "", lastWritten: "  " })).toBeNull();
  });

  it("hands back the URL value untouched, not trimmed", () => {
    expect(externalQueryChange({ urlQ: " abc", lastWritten: "" })).toBe(" abc");
  });

  it("is case sensitive (the search itself is case-insensitive, the bar is not)", () => {
    expect(externalQueryChange({ urlQ: "Seçim", lastWritten: "seçim" })).toBe("Seçim");
  });

  it("agrees with searchNavTarget: a URL it would write is never an external change", () => {
    for (const value of ["abc", "  abc  ", "çağrı", "a b"]) {
      const target = searchNavTarget({ value, pathname: "/", search: "" });
      expect(target).not.toBeNull();
      const urlQ = new URL(target!, "http://x").searchParams.get("q") ?? "";
      expect(externalQueryChange({ urlQ, lastWritten: value.trim() })).toBeNull();
    }
  });
});

describe("search-bar.tsx source", () => {
  it("uses searchNavTarget and router.replace, and never router.push", () => {
    const src = readFileSync(join(__dirname, "search-bar.tsx"), "utf8");
    expect(src).toContain("searchNavTarget(");
    expect(src).toContain("router.replace(");
    expect(src).not.toContain("router.push(");
  });
});
