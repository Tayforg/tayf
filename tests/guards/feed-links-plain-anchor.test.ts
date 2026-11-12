import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { anchorTags, hrefOf, linkTags } from "../_helpers/jsx-tags";

// ---------------------------------------------------------------------------
// Permanent CI guard (perf-6): RSS / feed links must be plain `<a href>`.
//
// `next/link` prefetches every link that scrolls into the viewport. For a
// feed URL such as `/rss/kor-noktalar.xml` that prefetch is an RSC request
// against a DB-backed route handler: a wasted query per page view that can
// never produce a navigable page. A plain anchor never prefetches, and the
// browser downloads or hands the feed to the reader exactly as it should.
//
//     <a href="/rss.xml" type="application/rss+xml">RSS</a>     // ok
//     <Link href="/rss.xml">RSS</Link>                          // offender
//
// Scope: every non-test .tsx under src/ (components and app routes alike),
// the same walk as input-purpose.test.ts, so a new feed link cannot regress.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC_DIR = join(ROOT, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

const FEED_HREF = /\.xml(?:[?#]|$)/;
const isFeedHref = (href: string | null): boolean =>
  href !== null && (FEED_HREF.test(href) || href.startsWith("/rss"));

const files = walk(SRC_DIR).sort();
const sources = files.map((file) => ({ file, src: readFileSync(file, "utf8") }));

const offenders = sources.flatMap(({ file, src }) =>
  linkTags(src)
    .filter(({ tag }) => isFeedHref(hrefOf(tag)))
    .map(({ line }) => `${relative(ROOT, file)}:${line}`),
);

const xmlAnchors = sources.flatMap(({ file, src }) =>
  anchorTags(src)
    .filter(({ tag }) => FEED_HREF.test(hrefOf(tag) ?? ""))
    .map(({ line }) => ({ file: relative(ROOT, file), line })),
);

describe("feed links are plain anchors (perf-6)", () => {
  it("never points a next/link <Link> at a feed", () => {
    expect(
      offenders,
      `RSS/feed links must be plain <a href>; next/link prefetch hits the DB-backed route handler as an RSC request (perf-6):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("is not vacuous: finds the site's plain-anchor feed links", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => /\.test\./.test(f))).toBe(false);
    expect(xmlAnchors.length).toBeGreaterThanOrEqual(3);

    const where = xmlAnchors.map(({ file }) => file);
    expect(where).toContain("src/components/layout/footer.tsx");
    expect(where).toContain("src/app/blindspots/page.tsx");
    expect(where).toContain("src/app/konu/[slug]/page.tsx");
  });

  describe("the guard itself works", () => {
    const offends = (src: string): boolean =>
      linkTags(src).some(({ tag }) => isFeedHref(hrefOf(tag)));

    it("fails a string href to a feed", () => {
      expect(offends('<Link href="/rss.xml">RSS</Link>')).toBe(true);
      expect(offends("<Link href='/other/feed.xml?x=1'>RSS</Link>")).toBe(true);
      expect(offends('<Link href="/rss/kor-noktalar.xml#top">RSS</Link>')).toBe(true);
    });

    it("fails a braced string href to a feed", () => {
      expect(offends('<Link href={"/rss.xml"}>RSS</Link>')).toBe(true);
      expect(offends("<Link href={'/rss.xml'}>RSS</Link>")).toBe(true);
    });

    it("fails a template-literal href to a feed", () => {
      expect(offends("<Link href={`/rss/${slug}.xml`}>RSS</Link>")).toBe(true);
    });

    it("fails a multi-line tag whose href follows other attributes", () => {
      const src = `
        <Link
          className="underline"
          href="/rss.xml"
        >
          RSS
        </Link>
      `;
      expect(offends(src)).toBe(true);
      expect(linkTags(src)[0]!.line).toBe(2);
    });

    it("fails any /rss path even without an .xml suffix", () => {
      expect(offends('<Link href="/rss">RSS</Link>')).toBe(true);
    });

    it("passes ordinary <Link> hrefs", () => {
      expect(offends('<Link href="/blindspots">Kör noktalar</Link>')).toBe(false);
      expect(offends("<Link href={`/konu/${slug}`}>Konu</Link>")).toBe(false);
      expect(offends('<Link href="/xmlguide">Kılavuz</Link>')).toBe(false);
    });

    it("passes a plain <a> to a feed (the required spelling)", () => {
      expect(offends('<a href="/rss.xml">RSS</a>')).toBe(false);
      expect(linkTags('<a href="/rss.xml">RSS</a>')).toEqual([]);
      expect(anchorTags('<a href="/rss.xml">RSS</a>')).toHaveLength(1);
    });

    it("does not end the tag early at an arrow function inside an attribute", () => {
      const src = `<Link onClick={(e) => track(e)} href="/rss.xml">RSS</Link>`;
      const [only] = linkTags(src);
      expect(only).toBeDefined();
      expect(only!.tag.endsWith('href="/rss.xml">')).toBe(true);
      expect(offends(src)).toBe(true);
    });

    it("does not end the tag early at a > inside a quoted attribute value", () => {
      const src = `<Link title="a > b" href="/rss.xml">RSS</Link>`;
      expect(offends(src)).toBe(true);
    });

    it("does not mistake a longer component name for <Link>", () => {
      expect(linkTags('<LinkButton href="/rss.xml" />')).toEqual([]);
    });
  });
});
