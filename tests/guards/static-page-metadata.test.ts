import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative, sep } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard: every public, indexable static page must build its
// metadata with staticPageMetadata() (src/lib/seo/page-metadata.ts).
//
// A page-level `openGraph` / `twitter` object REPLACES the parent's resolved
// one, root file-convention images included, and `openGraph` left unset
// inherits the homepage's url '/' and title. Hand-written alternates /
// openGraph / twitter blocks drift from that contract, so the helper is the
// only sanctioned way to write them. A page that should not be indexed opts
// out with `robots: { index: false }` instead.
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
  return source.split("\n").filter((line) => !/^\s*(\/\/|\*)/.test(line));
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

  describe("completeness walk", () => {
    const pages = walkPages(APP)
      .map((file) => ({ rel: appRel(file), source: readFileSync(file, "utf8") }))
      .filter(({ rel }) => !rel.startsWith("admin/"))
      .filter(({ source }) => /export const metadata\b/.test(source));

    it("every indexable page with static metadata is on the list", () => {
      const unlisted = pages
        .filter(({ source }) => !/index:\s*false/.test(source))
        .map(({ rel }) => rel)
        .filter((rel) => !PAGES.includes(rel));
      expect(
        unlisted,
        `new indexable static page: use staticPageMetadata or add robots noindex (${unlisted.join(", ")})`,
      ).toEqual([]);
    });

    it("finds exactly the 5 known noindex pages (scanner sanity check)", () => {
      const noindex = pages
        .filter(({ source }) => /index:\s*false/.test(source))
        .map(({ rel }) => rel)
        .sort();
      expect(noindex).toEqual([...EXPECTED_NOINDEX].sort());
    });

    it("finds every listed page (the walk and the list agree)", () => {
      const found = new Set(pages.map(({ rel }) => rel));
      expect(PAGES.filter((rel) => !found.has(rel))).toEqual([]);
    });
  });
});
