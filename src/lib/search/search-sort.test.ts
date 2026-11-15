import { describe, expect, it } from "vitest";

import { SEARCH_SORT_NEW, parseSearchSort, searchHref } from "./search-sort";

// h191: the order of the archive search results. ?sirala=yeni is the newest-first order (migration 215); every other
// value, or none, is the ranked order the page always had.

describe("parseSearchSort", () => {
  it("only the exact value 'yeni' selects the newest-first order", () => {
    expect(SEARCH_SORT_NEW).toBe("yeni");
    expect(parseSearchSort("yeni")).toBe("yeni");
  });

  it("anything else is the ranked order: absent, empty, unknown, another case, padded, a repeated parameter (an array)", () => {
    const others: Array<string | string[] | undefined> = [
      undefined,
      "",
      "relevance",
      "alakali",
      "YENI",
      "Yeni",
      "yeni ",
      " yeni",
      "yeni\n",
      "yeni2",
      "ye",
      "1",
      "true",
      ["yeni"],
      ["yeni", "yeni"],
      ["x", "yeni"],
      [],
    ];
    for (const raw of others) expect(parseSearchSort(raw), JSON.stringify(raw)).toBeNull();
  });

  it("never returns the raw value: the result is the constant or null", () => {
    expect(parseSearchSort("yeni")).toBe(SEARCH_SORT_NEW);
    expect(parseSearchSort("<script>")).toBeNull();
  });
});

describe("searchHref", () => {
  const params = (href: string) => new URL(href, "https://tayf.test").searchParams;

  it("the ranked address is the plain search box one: /?q=, no sirala, no arsiv", () => {
    expect(searchHref("enflasyon")).toBe("/?q=enflasyon");
    expect(searchHref("enflasyon", { sort: null })).toBe("/?q=enflasyon");
    expect(searchHref("enflasyon", { sort: null, archivePage: 1 })).toBe("/?q=enflasyon");
  });

  it("the newest-first address adds sirala=yeni after q, and arsiv after both from page 2", () => {
    expect(searchHref("enflasyon", { sort: "yeni" })).toBe("/?q=enflasyon&sirala=yeni");
    expect(searchHref("enflasyon", { sort: "yeni", archivePage: 1 })).toBe("/?q=enflasyon&sirala=yeni");
    expect(searchHref("enflasyon", { sort: "yeni", archivePage: 3 })).toBe("/?q=enflasyon&sirala=yeni&arsiv=3");
    expect(searchHref("enflasyon", { archivePage: 2 })).toBe("/?q=enflasyon&arsiv=2");
  });

  it("the query is encoded by URLSearchParams and cannot add a parameter", () => {
    const href = searchHref("faiz kararı&sirala=yeni&arsiv=4", { sort: null });
    expect(params(href).get("q")).toBe("faiz kararı&sirala=yeni&arsiv=4");
    expect(params(href).has("sirala")).toBe(false);
    expect(params(href).has("arsiv")).toBe(false);
    expect([...params(href).keys()]).toEqual(["q"]);
  });

  it("an unknown sort value is the ranked address", () => {
    expect(searchHref("deprem", { sort: "relevance" as never })).toBe("/?q=deprem");
  });
});
