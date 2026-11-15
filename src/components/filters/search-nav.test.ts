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

// h192-yeni-4: a new query starts at its first archive page. searchNavTarget
// copied the current search string and deleted only `page`, so editing the query
// on /?q=deprem&sirala=yeni&arsiv=3 landed on /?q=...&arsiv=3, an empty page
// although page 1 of the new query has results; clearing the box left the stale
// ?sirala=yeni&arsiv=3 behind (both are ignored without q).
describe("searchNavTarget archive page and order (h192-yeni-4)", () => {
  it("drops arsiv but keeps the chosen order when the query changes", () => {
    const target = searchNavTarget({
      value: "faiz kararı",
      pathname: "/",
      search: "q=deprem&sirala=yeni&arsiv=3",
    });
    expect(target).not.toBeNull();
    const url = new URL(target!, "http://x");
    expect(url.pathname).toBe("/");
    expect(url.search).toContain("q=faiz+karar%C4%B1");
    expect(url.searchParams.get("q")).toBe("faiz kararı");
    expect(url.searchParams.get("sirala")).toBe("yeni");
    expect(url.searchParams.has("arsiv")).toBe(false);
    expect(url.searchParams.has("page")).toBe(false);
  });

  it("clearing the query drops arsiv and sirala too: the bare pathname", () => {
    expect(
      searchNavTarget({ value: "", pathname: "/", search: "q=deprem&sirala=yeni&arsiv=3" }),
    ).toBe("/");
  });

  it("clearing with a whitespace-only value also returns the bare pathname", () => {
    expect(
      searchNavTarget({ value: "   ", pathname: "/", search: "q=deprem&sirala=yeni&arsiv=3" }),
    ).toBe("/");
  });

  it("drops page and arsiv together, leaving only the new q", () => {
    expect(
      searchNavTarget({ value: "ab", pathname: "/", search: "q=a&arsiv=2&page=3" }),
    ).toBe("/?q=ab");
  });

  it("returns null for the same query with different whitespace, even on an archive page", () => {
    expect(
      searchNavTarget({ value: "  deprem ", pathname: "/", search: "q=deprem&arsiv=3" }),
    ).toBeNull();
    expect(
      searchNavTarget({ value: "deprem", pathname: "/", search: "q=deprem&sirala=yeni&arsiv=3" }),
    ).toBeNull();
  });

  it("keeps unrelated params when the query changes", () => {
    const target = searchNavTarget({
      value: "faiz",
      pathname: "/",
      search: "q=deprem&foo=1&arsiv=3",
    });
    expect(target).not.toBeNull();
    const url = new URL(target!, "http://x");
    expect(url.searchParams.get("foo")).toBe("1");
    expect(url.searchParams.get("q")).toBe("faiz");
    expect(url.searchParams.has("arsiv")).toBe(false);
  });

  it("keeps unrelated params when the query is cleared, but drops arsiv and sirala", () => {
    expect(
      searchNavTarget({ value: "", pathname: "/", search: "q=deprem&foo=1&sirala=yeni&arsiv=3" }),
    ).toBe("/?foo=1");
  });

  it("starts a first query from an empty search without inventing params", () => {
    expect(searchNavTarget({ value: "abc", pathname: "/", search: "sirala=yeni" })).toBe(
      "/?sirala=yeni&q=abc",
    );
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
