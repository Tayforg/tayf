import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// h172-mobilelayout-1: the global header row must fit with no horizontal page
// scroll at any CSS viewport >= 276 px, and at 360 px with the root font at
// 130% / 150%.
//
// Before: the row needed 16 + 62 + 212 + 16 = 306 CSS px. Under that (a 280 px
// foldable cover screen, a 360 px phone at 130% page or text zoom, an iPhone at
// 125% Safari zoom) every route scrolled sideways and the "Tayf" wordmark sat
// flush against the first nav link. The nav is four 44 px icon links, and
// three aria-hidden dividers whose `mx-0.5` margins plus the two flex gaps
// around each one added 12 px between links. The floors were also in rem
// (`min-w-11`), so a bigger root font grew them past 44 px.
//
// The fix, below 24rem only (384 px at the default font size): the dividers
// collapse (`max-[24rem]:hidden`), the nav gap drops to 2 px
// (`max-[24rem]:gap-0.5`) and the nav may shrink (`min-w-0`), the 44 px floors
// are px values instead of rem, and the logo link cannot be squeezed
// (`shrink-0`). The compaction is NOT `max-sm:` (below 640 px): that moved the
// nav from 212 to 182 px and every link box at 390 px at 100% zoom, a visible
// change on the most common phone width. From 384 px up at 100% the layout is
// the original one; the 276 px row fits a 280 px cover screen, a 360 px phone at
// 130% page zoom and a 360 px phone with the root font at 130% or 150% (a media
// query ignores a JS-set root font size, so the compaction stays on there). 150%
// page zoom on a 360 px phone (240 CSS px) and a 390 to 428 px phone with the
// root font at 150% still scroll sideways, as they did before. sm+ is untouched,
// and so is the h-14 / 59 px row, so the anchor-offset and layout-main guards
// still hold.
//
// Source-text guard in the house style (tests/styles/anchor-offset.test.ts):
// literal includes and character scans only, no regular expression runs over
// the source and nothing is stripped or rewritten.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..", "..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

const NAV_LINKS = read("src/components/layout/nav-links.tsx");
const HEADER = read("src/components/layout/header.tsx");

/** Class tokens of `cls`, split on any whitespace character. */
function tokens(cls: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of cls) {
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") {
      if (cur !== "") out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}

/** Every plain `className="..."` attribute value in `src`, in source order. */
function classNameLiterals(src: string): string[] {
  const marker = 'className="';
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(marker, from);
    if (at === -1) return out;
    const start = at + marker.length;
    const end = src.indexOf('"', start);
    if (end === -1) throw new Error("unterminated className literal");
    out.push(src.slice(start, end));
    from = end + 1;
  }
}

/** The text of the opening tag that starts at the first `<name` in `src` (up to its first `>`). */
function openingTag(src: string, name: string): string {
  const at = src.indexOf(`<${name}`);
  if (at === -1) throw new Error(`no <${name}> in source`);
  const end = src.indexOf(">", at);
  if (end === -1) throw new Error(`unterminated <${name}> tag`);
  return src.slice(at, end + 1);
}

/** The class tokens of the first `className="..."` literal inside `tag`. */
function tagClassTokens(tag: string): string[] {
  const literals = classNameLiterals(tag);
  if (literals.length === 0) throw new Error("tag has no className literal");
  return tokens(literals[0]!);
}

/** The literal assigned to `const <name> =` (string on the same or the next line). */
function stringConstant(src: string, name: string): string {
  const head = `const ${name} =`;
  const at = src.indexOf(head);
  if (at === -1) throw new Error(`no const ${name}`);
  let i = at + head.length;
  while (src[i] === " " || src[i] === "\n") i++;
  if (src[i] !== '"') throw new Error(`const ${name} is not a plain string literal`);
  const end = src.indexOf('"', i + 1);
  if (end === -1) throw new Error(`const ${name} literal is unterminated`);
  return src.slice(i + 1, end);
}

/** The shared (pre-`${`) part of the admin link's template-literal className. */
function adminLinkSharedClasses(src: string): string {
  const adminAt = src.indexOf('href="/admin"');
  if (adminAt === -1) throw new Error("no /admin link");
  const marker = "className={`";
  const classAt = src.indexOf(marker, adminAt);
  if (classAt === -1) throw new Error("admin link has no template className");
  const start = classAt + marker.length;
  const end = src.indexOf("${", start);
  if (end === -1) throw new Error("admin link template has no state branch");
  return src.slice(start, end);
}

/** className of every divider (a literal carrying the `mx-0.5` margin token). */
function dividerClassNames(src: string): string[] {
  return classNameLiterals(src).filter((cls) => tokens(cls).includes("mx-0.5"));
}

/** The compaction variant: below 24rem (384 px at the default font size), not below `sm`. */
const COMPACT_HIDE = "max-[24rem]:hidden";
const COMPACT_GAP = "max-[24rem]:gap-0.5";

/** Dividers that would still draw their margins below 24rem (no `max-[24rem]:hidden` token). */
function dividersMissingHide(src: string): string[] {
  return dividerClassNames(src).filter((cls) => !tokens(cls).includes(COMPACT_HIDE));
}

describe("nav-links.tsx: the dividers collapse on narrow phones (below 24rem)", () => {
  it("finds the three dividers between the links plus the one before the admin link", () => {
    expect(dividerClassNames(NAV_LINKS)).toHaveLength(4);
  });

  it("every mx-0.5 divider carries max-[24rem]:hidden and no max-sm:hidden", () => {
    expect(dividersMissingHide(NAV_LINKS)).toEqual([]);
    for (const cls of dividerClassNames(NAV_LINKS)) {
      expect(tokens(cls)).toContain("max-[24rem]:hidden");
      expect(tokens(cls)).not.toContain("max-sm:hidden");
    }
  });

  it("keeps the dividers' own look and hides them below 24rem only (no bare hidden, no sm: leak)", () => {
    for (const cls of dividerClassNames(NAV_LINKS)) {
      expect(tokens(cls)).toEqual(["h-3", "mx-0.5", "shrink-0", "bg-border", "max-[24rem]:hidden"]);
    }
  });

  it("no divider carries any max-sm: token: 390 px at 100% zoom keeps the original spacing", () => {
    for (const cls of dividerClassNames(NAV_LINKS)) {
      expect(tokens(cls).filter((t) => t.startsWith("max-sm:"))).toEqual([]);
    }
  });
});

describe("nav-links.tsx: the nav tightens its gap below 24rem and may shrink", () => {
  const nav = tagClassTokens(openingTag(NAV_LINKS, "nav"));

  it("has max-[24rem]:gap-0.5 and min-w-0, and no max-sm:gap-0.5", () => {
    expect(nav).toContain(COMPACT_GAP);
    expect(nav).toContain("min-w-0");
    expect(nav).not.toContain("max-sm:gap-0.5");
  });

  it("carries no max-sm: compaction token at all (the 390 px layout is the original one)", () => {
    expect(nav.filter((t) => t.startsWith("max-sm:"))).toEqual([]);
  });

  it("keeps its sm+ layout: flex, centred, gap-1, 13 px text", () => {
    for (const token of ["flex", "items-center", "gap-1", "text-[13px]"]) {
      expect(nav).toContain(token);
    }
  });

  it("stays a labelled landmark", () => {
    expect(openingTag(NAV_LINKS, "nav")).toContain('aria-label="Ana menü"');
  });
});

describe("nav-links.tsx: the 44 px phone floor is in px, so it does not grow with the root font", () => {
  const FLOORS = ["max-sm:min-h-[44px]", "max-sm:min-w-[44px]"];
  const RETIRED = ["max-sm:min-h-11", "max-sm:min-w-11", "min-h-11", "min-w-11"];

  const linkClassSets: [string, string[]][] = [
    ["baseLink (home, blindspots, ekonomi, saved)", tokens(stringConstant(NAV_LINKS, "baseLink"))],
    ["admin link", tokens(adminLinkSharedClasses(NAV_LINKS))],
  ];

  it.each(linkClassSets)("%s carries both px floors and max-sm:justify-center", (_label, cls) => {
    for (const token of [...FLOORS, "max-sm:justify-center"]) expect(cls).toContain(token);
  });

  it.each(linkClassSets)("%s carries no rem-based 11 floor", (_label, cls) => {
    for (const token of RETIRED) expect(cls).not.toContain(token);
  });

  it.each(linkClassSets)("%s keeps the floors below sm only (no unprefixed px floor)", (_label, cls) => {
    expect(cls).not.toContain("min-h-[44px]");
    expect(cls).not.toContain("min-w-[44px]");
  });

  it("no max-sm:min-w-11 / max-sm:min-h-11 remains anywhere in the file", () => {
    expect(NAV_LINKS.includes("max-sm:min-w-11")).toBe(false);
    expect(NAV_LINKS.includes("max-sm:min-h-11")).toBe(false);
  });

  it("keeps the sm+ link box: rounded, 2 px border slot, horizontal padding, focus ring", () => {
    const base = tokens(stringConstant(NAV_LINKS, "baseLink"));
    for (const token of ["rounded-md", "border-b-2", "px-2.5", "py-1.5", "gap-1.5", "focus-visible:ring-2"]) {
      expect(base).toContain(token);
    }
    const admin = tokens(adminLinkSharedClasses(NAV_LINKS));
    for (const token of ["rounded-md", "border-b-2", "px-2", "py-1.5", "focus-visible:ring-2"]) {
      expect(admin).toContain(token);
    }
  });
});

describe("header.tsx: the logo link cannot be squeezed, and the row height does not move", () => {
  const logoTag = openingTag(HEADER, "Link");
  const logo = tagClassTokens(logoTag);

  it("the logo link is the home link and carries shrink-0", () => {
    expect(logoTag).toContain('href="/"');
    expect(logo).toContain("shrink-0");
  });

  it("keeps the rest of the logo link's classes", () => {
    for (const token of ["group", "flex", "items-center", "gap-3", "rounded-md", "focus-visible:ring-2"]) {
      expect(logo).toContain(token);
    }
  });

  it("leaves the stepped container and the h-14 row alone", () => {
    expect(HEADER).toContain(
      'className="container mx-auto flex h-14 items-center justify-between px-4 sm:px-6"',
    );
    expect(HEADER).toContain("h-[59px]");
  });
});

describe("helpers (mutation checks on synthetic sources)", () => {
  it("tokens splits on spaces, tabs and newlines and drops empties", () => {
    expect(tokens("  a\tb\n  c \r\nd ")).toEqual(["a", "b", "c", "d"]);
    expect(tokens("")).toEqual([]);
  });

  it("classNameLiterals returns plain attribute values and skips expression classNames", () => {
    const src = '<a className="x y" /><b className={`z ${w}`} /><i className="q" />';
    expect(classNameLiterals(src)).toEqual(["x y", "q"]);
    expect(() => classNameLiterals('<a className="open')).toThrow();
  });

  it("dividersMissingHide reports a divider that does not collapse and accepts one that does", () => {
    const bad = '<span aria-hidden="true" className="h-3 mx-0.5 shrink-0 bg-border" />';
    const good = '<span aria-hidden="true" className="h-3 mx-0.5 shrink-0 bg-border max-[24rem]:hidden" />';
    expect(dividersMissingHide(bad)).toEqual(["h-3 mx-0.5 shrink-0 bg-border"]);
    expect(dividersMissingHide(good)).toEqual([]);
    expect(dividersMissingHide(`${good}${bad}${good}`)).toHaveLength(1);
  });

  it("dividersMissingHide treats the old max-sm:hidden as missing (it moved the 390 px layout)", () => {
    const old = '<span className="h-3 mx-0.5 shrink-0 bg-border max-sm:hidden" />';
    expect(dividersMissingHide(old)).toHaveLength(1);
  });

  it("dividersMissingHide matches whole tokens, not substrings", () => {
    const lookalike = '<span className="h-3 mx-0.5 shrink-0 xmax-[24rem]:hidden max-[24rem]:hidden-x" />';
    expect(dividersMissingHide(lookalike)).toHaveLength(1);
    expect(dividerClassNames('<span className="mx-0.55 a" /><span className="no-mx-0.5 a" />')).toEqual([]);
  });

  it("openingTag and tagClassTokens read the first tag of that name, and throw when it is absent", () => {
    const src = '<div><nav aria-label="x" className="flex gap-1"><a /></nav><nav className="other"></nav></div>';
    expect(tagClassTokens(openingTag(src, "nav"))).toEqual(["flex", "gap-1"]);
    expect(() => openingTag(src, "section")).toThrow();
    expect(() => tagClassTokens("<nav>")).toThrow();
  });

  it("stringConstant reads the constant's own literal across a line break, not a lookalike", () => {
    const src = 'const baseLinkX = "no";\nconst baseLink =\n  "a b c";\nconst other = "d";';
    expect(stringConstant(src, "baseLink")).toBe("a b c");
    expect(stringConstant(src, "other")).toBe("d");
    expect(() => stringConstant(src, "missing")).toThrow();
    expect(() => stringConstant("const baseLink = build();", "baseLink")).toThrow();
  });

  it("adminLinkSharedClasses reads the template up to the first state branch", () => {
    const src = 'x <Link href="/admin" className={`one two ${isAdmin ? active : "idle"}`}>';
    expect(tokens(adminLinkSharedClasses(src))).toEqual(["one", "two"]);
    expect(() => adminLinkSharedClasses("<Link href=\"/x\" />")).toThrow();
  });
});
