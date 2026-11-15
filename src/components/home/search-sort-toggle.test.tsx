import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Link from "next/link";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SearchSortToggle } from "./search-sort-toggle";

// h191: "Sırala: En alakalı · En yeni", the two plain links above the results of a search. A hookless server
// component (no client JS): it reads its props and renders a nav. `active` is the order the results are SHOWN in
// ("yeni", or null for the ranked order); the links preserve the query and reset the archive page.

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(here, "search-sort-toggle.tsx"), "utf8");

type Elementish = { type?: unknown; props?: Record<string, unknown> };

function collect(node: unknown, out: Elementish[] = []): Elementish[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as Elementish;
    if (el.type !== undefined) out.push(el);
    if (el.props?.children !== undefined) collect(el.props.children, out);
  }
  return out;
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object") return textOf((node as Elementish).props?.children);
  return "";
}

/** The tree the component returns (it is a plain function: no hooks). */
function tree(q: string | undefined, active: "yeni" | null | undefined) {
  return SearchSortToggle({ q, active }) as unknown;
}

const links = (node: unknown) => collect(node).filter((el) => el.type === Link);
const params = (href: unknown) => new URL(String(href), "https://tayf.test").searchParams;

describe("SearchSortToggle", () => {
  it("is a nav labelled 'Sıralama' with the label 'Sırala:' and two links, 'En alakalı' then 'En yeni'", () => {
    const t = tree("faiz kararı", null);
    const nav = collect(t).find((el) => el.type === "nav");
    expect(nav?.props?.["aria-label"]).toBe("Sıralama");
    expect(textOf(t)).toContain("Sırala:");
    expect(links(t).map((l) => textOf(l))).toEqual(["En alakalı", "En yeni"]);
  });

  it("En alakalı goes to the plain search (no sirala), En yeni to the same search with sirala=yeni", () => {
    const [ranked, newest] = links(tree("deprem", null));
    expect(ranked?.props?.href).toBe("/?q=deprem");
    expect(newest?.props?.href).toBe("/?q=deprem&sirala=yeni");
    expect(params(ranked?.props?.href).has("sirala")).toBe(false);
    expect(params(newest?.props?.href).get("sirala")).toBe("yeni");
  });

  it("marks the active order with aria-current='page', and only that one", () => {
    const rankedActive = links(tree("deprem", null));
    expect(rankedActive.map((l) => l.props?.["aria-current"])).toEqual(["page", undefined]);
    const newestActive = links(tree("deprem", "yeni"));
    expect(newestActive.map((l) => l.props?.["aria-current"])).toEqual([undefined, "page"]);
    // an unknown or missing value is the ranked order
    expect(links(tree("deprem", undefined)).map((l) => l.props?.["aria-current"])).toEqual(["page", undefined]);
    expect(links(tree("deprem", "relevance" as never)).map((l) => l.props?.["aria-current"])).toEqual(["page", undefined]);
  });

  it("preserves the query, encoded, and resets the archive page: neither link carries arsiv or page", () => {
    for (const q of ["faiz kararı", "Erdoğan'ın", "a&b=c", '"><script>x</script>', "emekli maaşı  zammı", "100%"]) {
      for (const active of [null, "yeni"] as const) {
        for (const l of links(tree(q, active))) {
          const p = params(l.props?.href);
          expect(p.get("q"), q).toBe(q);
          expect(p.has("arsiv"), q).toBe(false);
          expect(p.has("page"), q).toBe(false);
          expect([...p.keys()].filter((k) => k !== "q" && k !== "sirala"), q).toEqual([]);
        }
      }
    }
  });

  it("renders nothing without a query: undefined, empty and whitespace-only", () => {
    expect(tree(undefined, null)).toBeNull();
    expect(tree("", null)).toBeNull();
    expect(tree("   ", "yeni")).toBeNull();
    expect(tree("\n\t", null)).toBeNull();
  });

  it("the links are plain: no prefetch (each target is a database search) and no handler, so no client JS is needed", () => {
    for (const l of links(tree("deprem", null))) {
      expect(l.props?.prefetch).toBe(false);
      expect(l.props?.onClick).toBeUndefined();
      expect(l.props?.onNavigate).toBeUndefined();
    }
    expect(SOURCE.startsWith('"use client"')).toBe(false);
    expect(SOURCE).not.toContain("use client");
    for (const hook of ["useState", "useEffect", "useRef", "useSearchParams", "usePathname"]) expect(SOURCE, hook).not.toContain(hook);
  });

  it("renders escaped markup with the two anchors and one aria-current", () => {
    const html = renderToStaticMarkup(createElement(SearchSortToggle, { q: '"><script>x</script>', active: "yeni" }));
    expect(html).not.toContain("<script>");
    expect(html).toContain('aria-label="Sıralama"');
    expect(html).toContain("Sırala:");
    expect(html.split("<a ").length - 1).toBe(2);
    expect(html.split('aria-current="page"').length - 1).toBe(1);
    expect(html).toContain("sirala=yeni");
    const [first, second] = html.split("<a ").slice(1) as [string, string];
    expect(first).not.toContain("aria-current");
    expect(second).toContain('aria-current="page"');
    expect(second).toContain("En yeni");
  });

  it("matches the chip style of the search area and works at 280 px: the same chip class, wrapping, shrinkable, 44 px targets on a phone, the site's focus ring", () => {
    const t = tree("deprem", null);
    for (const l of links(t)) {
      const cls = String(l.props?.className);
      for (const piece of [
        "inline-flex",
        "items-center",
        "min-h-6",
        "max-sm:min-h-11",
        "rounded-full",
        "border",
        "px-3",
        "text-xs",
        "focus-visible:outline-none",
        "focus-visible:ring-2",
        "focus-visible:ring-ring",
      ]) {
        expect(cls, piece).toContain(piece);
      }
      // the idle chip is font-medium like the search area's chips, the current one is a step heavier
      expect(cls.includes("font-medium") || cls.includes("font-semibold"), cls).toBe(true);
    }
    const idle = links(t).find((l) => l.props?.["aria-current"] === undefined);
    expect(String(idle?.props?.className)).toContain("font-medium");
    expect(String(idle?.props?.className)).toContain("border-border/60");
    const nav = collect(t).find((el) => el.type === "nav");
    const navClass = String(nav?.props?.className);
    expect(navClass).toContain("flex-wrap");
    expect(navClass).toContain("min-w-0");
    expect(navClass).toContain("max-w-full");
  });

  it("the active link looks different from the other (a filled pill), and both stay one literal class string each", () => {
    const [ranked, newest] = links(tree("deprem", "yeni"));
    expect(String(ranked?.props?.className)).not.toBe(String(newest?.props?.className));
    // Tailwind 4: literal class strings only, no computed class names
    expect(SOURCE).not.toContain("className={`");
    expect(SOURCE).not.toContain("${");
    expect(SOURCE).not.toContain("cn(");
  });

  it("the current chip is also a 2 px outline against the idle chip's 1 px, in both active states (a forced-colors mode drops the tint and the colour, not the width: h41-a11y-1)", () => {
    const tokens = (l: Elementish | undefined) => String(l?.props?.className).split(" ");
    for (const active of [null, "yeni"] as const) {
      const [ranked, newest] = links(tree("deprem", active));
      const current = active === "yeni" ? newest : ranked;
      const idle = active === "yeni" ? ranked : newest;
      expect(current?.props?.["aria-current"], String(active)).toBe("page");
      expect(tokens(current), String(active)).toContain("border-2");
      expect(tokens(current), String(active)).toContain("border-foreground");
      expect(tokens(idle), String(active)).not.toContain("border-2");
      expect(tokens(idle), String(active)).toContain("border");
      // the height budget is untouched: 24 px (min-h-6) with the 2 px border, 44 px on a phone
      expect(tokens(current), String(active)).toContain("min-h-6");
      expect(tokens(current), String(active)).toContain("max-sm:min-h-11");
    }
  });

  it("holds no machine-local text and no raw HTML insertion", () => {
    expect(SOURCE).not.toContain("dangerouslySetInnerHTML");
  });
});
