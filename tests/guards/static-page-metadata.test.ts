import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative, sep } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard: every public, indexable static page must build its
// metadata with staticPageMetadata() (src/lib/seo/page-metadata.ts), and every
// static page that stays out of the index must build it with
// noindexPageMetadata() from the same file.
//
// A page-level `openGraph` / `twitter` object REPLACES the parent's resolved
// one, root file-convention images included, and `openGraph` left unset
// inherits the homepage's url '/' and title -- so a shared /karsilastir link
// used to unfurl as the homepage card. Hand-written alternates / openGraph /
// twitter / robots blocks drift from that contract, so the two helpers are the
// only sanctioned way to write them. noindexPageMetadata() is staticPageMetadata()
// plus `robots: { index: false, follow }`, which keeps the og:url equal to the
// canonical.
//
// Token pages (capability URLs such as rapor/[token]) are exempt from both
// helpers on purpose: their path carries a credential, which must never reach
// og:url or the canonical. They hand-write `robots: { index: false }` and
// nothing else, and are pinned in TOKEN_PAGES.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, "../../src/app");

const PAGES = [
  "durum",
  "blindspots",
  "metodoloji",
  "hafta",
  "duzeltmeler",
  "kaynaklar/durum",
  "trends",
  "sources",
  "konu",
  "timeline",
  "kalite",
  "ekonomi",
  "oyun",
  "gelistirici",
].map((route) => `${route}/page.tsx`);

// Static pages that stay out of the index but get their own og/twitter
// identity. Value = the `follow` flag the page must pass (robots output is
// pinned: /karsilastir is noindex,follow; the per-user pages are noindex,nofollow).
const NOINDEX_PAGES: Record<string, boolean> = {
  "diyetim/page.tsx": false,
  "karsilastir/page.tsx": true,
  "saved/page.tsx": false,
  "takip/page.tsx": false,
};

// Capability-URL pages: the path carries a credential, so neither helper may
// be used (it would put the token into og:url and the canonical).
const TOKEN_PAGES = ["rapor/[token]/page.tsx"];

const EXPECTED_NOINDEX = [
  "diyetim/page.tsx",
  "karsilastir/page.tsx",
  "rapor/[token]/page.tsx",
  "saved/page.tsx",
  "takip/page.tsx",
];

function walkPages(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkPages(p));
    else if (name === "page.tsx") out.push(p);
  }
  return out;
}

/** Repo-relative-to-app path with forward slashes, e.g. "kaynaklar/durum/page.tsx". */
function appRel(file: string): string {
  return relative(APP, file).split(sep).join("/");
}

function codeLines(source: string): string[] {
  return source.split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line));
}

describe("static public pages use staticPageMetadata", () => {
  it("lists the 14 known pages", () => {
    expect(PAGES).toHaveLength(14);
    expect(new Set(PAGES).size).toBe(14);
  });

  describe.each(PAGES)("%s", (rel) => {
    const source = readFileSync(join(APP, rel), "utf8");
    const code = codeLines(source);

    it("exports metadata built by staticPageMetadata()", () => {
      expect(source).toMatch(/export const metadata: Metadata = staticPageMetadata\(/);
      expect(source).toMatch(/from "@\/lib\/seo\/page-metadata"/);
    });

    it("hand-writes no alternates / openGraph / twitter block", () => {
      const offenders = code.filter((line) => /\b(alternates|openGraph|twitter):/.test(line));
      expect(offenders).toEqual([]);
    });

    it("uses a path literal equal to the route derived from the file location", () => {
      const route = "/" + rel.replace(/\/page\.tsx$/, "");
      const m = /\bpath:\s*"([^"]*)"/.exec(code.join("\n"));
      expect(m?.[1]).toBe(route);
    });

    it("exports no generateMetadata", () => {
      const offenders = code.filter((line) =>
        /export\s+(async\s+)?(function|const)\s+generateMetadata\b/.test(line),
      );
      expect(offenders).toEqual([]);
    });
  });

  describe.each(Object.entries(NOINDEX_PAGES))("%s (noindex)", (rel, follow) => {
    const source = readFileSync(join(APP, rel), "utf8");
    const code = codeLines(source);

    it("exports metadata built by noindexPageMetadata()", () => {
      expect(source).toMatch(/export const metadata: Metadata = noindexPageMetadata\(/);
      expect(source).toMatch(/from "@\/lib\/seo\/page-metadata"/);
    });

    it("hand-writes no alternates / openGraph / twitter / robots block", () => {
      const offenders = code.filter((line) =>
        /\b(alternates|openGraph|twitter|robots):/.test(line),
      );
      expect(offenders).toEqual([]);
    });

    it("uses a path literal equal to the route derived from the file location", () => {
      const route = "/" + rel.replace(/\/page\.tsx$/, "");
      const m = /\bpath:\s*"([^"]*)"/.exec(code.join("\n"));
      expect(m?.[1]).toBe(route);
    });

    it(`passes follow: ${follow} (robots output must not change)`, () => {
      const m = /\bfollow:\s*(true|false)\b/.exec(code.join("\n"));
      expect(m?.[1]).toBe(String(follow));
    });

    it("exports no generateMetadata", () => {
      const offenders = code.filter((line) =>
        /export\s+(async\s+)?(function|const)\s+generateMetadata\b/.test(line),
      );
      expect(offenders).toEqual([]);
    });
  });

  // A token must never reach og:url or the canonical: the capability URL is the
  // credential, so these pages hand-write a bare noindex block and stay off
  // both helpers.
  describe.each(TOKEN_PAGES)("%s (capability URL)", (rel) => {
    const code = codeLines(readFileSync(join(APP, rel), "utf8"));
    const block = /export const metadata\b[\s\S]*?\n\};/.exec(code.join("\n"))?.[0] ?? "";

    it("exports a metadata object (extraction sanity check)", () => {
      expect(block).not.toBe("");
    });

    it("is noindex", () => {
      expect(block).toMatch(/index:\s*false/);
    });

    it("sets no url (og:url) and no literal canonical", () => {
      expect(block).not.toMatch(/\burl:/);
      expect(block).not.toMatch(/canonical:\s*["'`]/);
    });

    it("calls neither staticPageMetadata nor noindexPageMetadata", () => {
      expect(code.join("\n")).not.toMatch(/\b(staticPageMetadata|noindexPageMetadata)\b/);
    });
  });

  describe("completeness walk", () => {
    const pages = walkPages(APP)
      .map((file) => {
        const source = readFileSync(file, "utf8");
        return { rel: appRel(file), source, code: codeLines(source).join("\n") };
      })
      .filter(({ rel }) => !rel.startsWith("admin/"))
      .filter(({ source }) => /export const metadata\b/.test(source));

    const usesStatic = (code: string) => /\bstaticPageMetadata\(/.test(code);
    const usesNoindex = (code: string) => /\bnoindexPageMetadata\(/.test(code);
    const handWritesNoindex = (code: string) => /index:\s*false/.test(code);

    it("every page using staticPageMetadata is on the PAGES list", () => {
      const unlisted = pages
        .filter(({ code }) => usesStatic(code))
        .map(({ rel }) => rel)
        .filter((rel) => !PAGES.includes(rel));
      expect(
        unlisted,
        `new indexable static page: add it to PAGES (${unlisted.join(", ")})`,
      ).toEqual([]);
    });

    it("every page using noindexPageMetadata is a key of NOINDEX_PAGES", () => {
      const unlisted = pages
        .filter(({ code }) => usesNoindex(code))
        .map(({ rel }) => rel)
        .filter((rel) => !(rel in NOINDEX_PAGES));
      expect(
        unlisted,
        `new noindex static page: add it to NOINDEX_PAGES (${unlisted.join(", ")})`,
      ).toEqual([]);
    });

    it("every other page with static metadata is a hand-written token page", () => {
      const offenders = pages
        .filter(({ code }) => !usesStatic(code) && !usesNoindex(code))
        .filter(({ rel, code }) => !(handWritesNoindex(code) && TOKEN_PAGES.includes(rel)))
        .map(({ rel }) => rel);
      expect(
        offenders,
        `noindex static page must use noindexPageMetadata, else it inherits the homepage og:url (${offenders.join(", ")}); an indexable page uses staticPageMetadata and joins PAGES`,
      ).toEqual([]);
    });

    it("no page hand-writes noindex plus a canonical without its own openGraph and twitter", () => {
      const offenders = pages
        .filter(
          ({ code }) =>
            handWritesNoindex(code) &&
            /\bcanonical:/.test(code) &&
            !(/\bopenGraph:/.test(code) && /\btwitter:/.test(code)),
        )
        .map(({ rel }) => rel);
      expect(offenders).toEqual([]);
    });

    it("finds exactly the 5 known noindex pages (scanner sanity check)", () => {
      const noindex = pages
        .filter(({ code }) => usesNoindex(code) || handWritesNoindex(code))
        .map(({ rel }) => rel)
        .sort();
      expect(EXPECTED_NOINDEX).toHaveLength(5);
      expect(noindex).toEqual([...EXPECTED_NOINDEX].sort());
    });

    it("keeps EXPECTED_NOINDEX equal to NOINDEX_PAGES plus TOKEN_PAGES", () => {
      expect([...Object.keys(NOINDEX_PAGES), ...TOKEN_PAGES].sort()).toEqual(
        [...EXPECTED_NOINDEX].sort(),
      );
    });

    it("finds every listed page (the walk and the list agree)", () => {
      const found = new Set(pages.map(({ rel }) => rel));
      const listed = [...PAGES, ...Object.keys(NOINDEX_PAGES), ...TOKEN_PAGES];
      expect(listed.filter((rel) => !found.has(rel))).toEqual([]);
    });
  });
});
