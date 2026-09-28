import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchNavTarget } from "./search-nav";

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

describe("search-bar.tsx source", () => {
  it("uses searchNavTarget and router.replace, and never router.push", () => {
    const src = readFileSync(join(__dirname, "search-bar.tsx"), "utf8");
    expect(src).toContain("searchNavTarget(");
    expect(src).toContain("router.replace(");
    expect(src).not.toContain("router.push(");
  });
});
