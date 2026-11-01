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
// Dynamic pages whose path segment is validated by the page itself (a parsed
// ISO week key, a ticker shape) use sharePageMetadata() from the same file:
// the same output as staticPageMetadata() but a path alphabet that allows
// upper-case, so /ekonomi/LYDHO gets its own og:url instead of the homepage's.
// They are pinned in SHARE_PAGES, and a completeness walk fails any other page
// that writes a canonical without one of the helpers (or its own openGraph).
//
// Token pages (capability URLs such as rapor/[token]) are exempt from both
// helpers on purpose: their path carries a credential, which must never reach
// og:url or the canonical. They hand-write `robots: { index: false }` and
// `alternates: { canonical: null }` and nothing else, and are pinned in
// TOKEN_PAGES. The null canonical is deliberate (h11-finance-4): src/app/layout.tsx
// sets a site-wide canonical '/', which every page inherits unless it sets its
// own `alternates`, so a bare noindex page used to advertise the homepage as
// its canonical. `canonical: null` is not "a canonical": the checks below
// ignore it where they look for noindex-plus-canonical.
//
// Error shells (the not-found and "could not load" metadata of a dynamic page
// that streams a 200 shell) are built by errorShellMetadata() for the same
// reason; they are pinned in ERROR_SHELL_PAGES.
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
  "gundem",
].map((route) => `${route}/page.tsx`);

// Static pages that stay out of the index but get their own og/twitter
// identity. Value = the `follow` flag the page must pass (robots output is
// pinned: /karsilastir is noindex,follow; the per-user pages are noindex,nofollow).
const NOINDEX_PAGES: Record<string, boolean> = {
  "diyetim/page.tsx": false,
  "karsilastir/page.tsx": true,
  "offline/page.tsx": false,
  "saved/page.tsx": false,
  "takip/page.tsx": false,
};

// Dynamic-segment pages: generateMetadata validates the segment first, then
// hands the path to sharePageMetadata(). The page must not hand-write the
// openGraph / twitter blocks (or alternates) the helper owns. Value = the path
// template the page must pass, derived from the file location.
const SHARE_PAGES: Record<string, string> = {
  "hafta/[hafta]/page.tsx": "/hafta/${hafta}",
  "ekonomi/[ticker]/page.tsx": "/ekonomi/${ticker}",
};

// Capability-URL pages: the path carries a credential, so neither helper may
// be used (it would put the token into og:url and the canonical).
const TOKEN_PAGES = ["rapor/[token]/page.tsx"];

// Dynamic pages whose generateMetadata can answer "not found" / "unknown" for a
// segment: those shells must come from errorShellMetadata() (noindex + a null
// canonical), not a hand-written { title, robots } that inherits the homepage
// canonical from the root layout.
const ERROR_SHELL_PAGES = ["ekonomi/[ticker]/page.tsx"];

/** A canonical that is a real URL or path; `canonical: null` (the opt-out) is not one. */
const REAL_CANONICAL = /\bcanonical:(?!\s*null\b)/;

const EXPECTED_NOINDEX = [
  "diyetim/page.tsx",
  "karsilastir/page.tsx",
  "offline/page.tsx",
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
  it("lists the 15 known pages", () => {
    expect(PAGES).toHaveLength(15);
    expect(new Set(PAGES).size).toBe(15);
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

  describe.each(Object.entries(SHARE_PAGES))("%s (share page)", (rel, pathTemplate) => {
    const source = readFileSync(join(APP, rel), "utf8");
    const code = codeLines(source);

    it("builds its metadata with sharePageMetadata()", () => {
      expect(code.join("\n")).toMatch(/\bsharePageMetadata\(/);
      expect(source).toMatch(/from "@\/lib\/seo\/page-metadata"/);
    });

    it("hand-writes no alternates / openGraph / twitter block", () => {
      const offenders = code.filter((line) => /\b(alternates|openGraph|twitter):/.test(line));
      expect(offenders).toEqual([]);
    });

    it("passes the route template derived from the file location as the path", () => {
      expect(code.join("\n")).toContain(`path: \`${pathTemplate}\``);
    });

    it("exports generateMetadata (the segment is dynamic, so there is no static metadata)", () => {
      expect(
        code.some((line) => /export\s+(async\s+)?function\s+generateMetadata\b/.test(line)),
      ).toBe(true);
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

    it("opts out of the layout's site-wide canonical '/' with alternates: { canonical: null }", () => {
      expect(block).toMatch(/canonical:\s*null/);
      expect(block).toMatch(/alternates:\s*\{\s*canonical:\s*null\s*\}/);
    });

    it("calls none of staticPageMetadata, noindexPageMetadata and sharePageMetadata", () => {
      expect(code.join("\n")).not.toMatch(
        /\b(staticPageMetadata|noindexPageMetadata|sharePageMetadata)\b/,
      );
    });
  });

  describe.each(ERROR_SHELL_PAGES)("%s (error shells)", (rel) => {
    const source = readFileSync(join(APP, rel), "utf8");
    const code = codeLines(source).join("\n");

    it("builds its not-found / unknown shells with errorShellMetadata()", () => {
      expect(code).toMatch(/\berrorShellMetadata\(/);
      expect(source).toMatch(/from "@\/lib\/seo\/page-metadata"/);
    });

    it("no longer hand-writes a { title, robots: { index: false, follow: false } } shell", () => {
      expect(code).not.toMatch(/robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
    });

    it("hand-writes no alternates block (the helper owns it)", () => {
      expect(code).not.toMatch(/\balternates:/);
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
            REAL_CANONICAL.test(code) &&
            !(/\bopenGraph:/.test(code) && /\btwitter:/.test(code)),
        )
        .map(({ rel }) => rel);
      expect(offenders).toEqual([]);
    });

    it("the noindex-plus-canonical check ignores `canonical: null` and still catches a real one (scanner sanity check)", () => {
      expect(REAL_CANONICAL.test("alternates: { canonical: null }")).toBe(false);
      expect(REAL_CANONICAL.test("alternates:{canonical:null}")).toBe(false);
      expect(REAL_CANONICAL.test("alternates: { canonical: `/rapor/${token}` }")).toBe(true);
      expect(REAL_CANONICAL.test('alternates: { canonical: "/x" }')).toBe(true);
      expect(REAL_CANONICAL.test("canonical: nullable")).toBe(true);
    });

    it("finds exactly the 6 known noindex pages (scanner sanity check)", () => {
      const noindex = pages
        .filter(({ code }) => usesNoindex(code) || handWritesNoindex(code))
        .map(({ rel }) => rel)
        .sort();
      expect(EXPECTED_NOINDEX).toHaveLength(6);
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

  // Every page.tsx under src/app (admin excluded), not only those exporting a
  // static `metadata` const: a generateMetadata page that hand-writes a
  // canonical without openGraph / twitter unfurls as the homepage.
  describe("canonical completeness walk (generateMetadata pages included)", () => {
    const allPages = walkPages(APP)
      .map((file) => ({
        rel: appRel(file),
        code: codeLines(readFileSync(file, "utf8")).join("\n"),
      }))
      .filter(({ rel }) => !rel.startsWith("admin/"));

    const writesCanonical = (code: string) => /\bcanonical:\s*[`"']/.test(code);
    const usesHelper = (code: string) =>
      /\b(staticPageMetadata|noindexPageMetadata|sharePageMetadata)\(/.test(code);
    const handWritesOpenGraph = (code: string) => /\bopenGraph:/.test(code);

    it("every page that writes a canonical also builds its own og/twitter identity", () => {
      const offenders = allPages
        .filter(
          ({ code }) => writesCanonical(code) && !usesHelper(code) && !handWritesOpenGraph(code),
        )
        .map(({ rel }) => rel);
      expect(
        offenders,
        `a page-level canonical without staticPageMetadata / noindexPageMetadata / sharePageMetadata (or its own openGraph) unfurls as the homepage: ${offenders.join(", ")}`,
      ).toEqual([]);
    });

    it("every page using sharePageMetadata is a key of SHARE_PAGES", () => {
      const unlisted = allPages
        .filter(({ code }) => /\bsharePageMetadata\(/.test(code))
        .map(({ rel }) => rel)
        .filter((rel) => !(rel in SHARE_PAGES));
      expect(unlisted, `new share page: add it to SHARE_PAGES (${unlisted.join(", ")})`).toEqual([]);
    });

    it("finds every SHARE_PAGES entry (the walk and the list agree)", () => {
      const found = new Set(allPages.map(({ rel }) => rel));
      expect(Object.keys(SHARE_PAGES).filter((rel) => !found.has(rel))).toEqual([]);
    });

    it("scanner sanity check: the walk sees the helper pages and the known canonical writers", () => {
      expect(allPages.filter(({ code }) => writesCanonical(code)).length).toBeGreaterThan(0);
      expect(allPages.filter(({ code }) => usesHelper(code)).length).toBeGreaterThanOrEqual(20);
    });
  });
});
