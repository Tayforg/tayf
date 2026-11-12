import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hrefOf, linkTags } from "../_helpers/jsx-tags";

// ---------------------------------------------------------------------------
// Permanent CI guard (h166-perf-2): the /source/[slug] profile must not
// prefetch /sources or /metodoloji.
//
// `next/link` prefetches every in-viewport link. On a source profile that made
// two outliers out of 12 RSC prefetches: /sources (the "Tüm kaynaklar" back
// link, 362 KB decoded) and /metodoloji (the explainer links, 61 KB decoded).
// Together about 30 KB of transfer on every one of the 144 profile pages, most
// of which are single-page visits from search that never click either link.
// The dispute links to /metodoloji?source=... already opted out; the rest had
// not. The links stay `next/link` (a plain <a> would make the click re-download
// the inline stylesheet); only the viewport prefetch goes.
//
//     <Link href="/metodoloji#kaynaklar" prefetch={false}>   // ok
//     <Link href="/metodoloji#kaynaklar">                    // offender
//     <Link href="/sources" prefetch={false}>                // ok
//
// Scope: the profile page and the four components it renders those links from.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

const PROFILE_FILES = [
  "src/app/source/[slug]/page.tsx",
  "src/components/source/label-card.tsx",
  "src/components/source/source-karne.tsx",
  "src/components/source/source-reliability.tsx",
  "src/components/source/clickbait-karne.tsx",
];

/** `/sources` exactly, or any path under /metodoloji (anchor and query included). */
const isStaticTargetHref = (href: string | null): boolean =>
  href !== null && (href === "/sources" || href.startsWith("/metodoloji"));

/** `prefetch={false}`, with optional spaces inside the braces. Linear. */
const PREFETCH_OFF = /\bprefetch=\{\s*false\s*\}/;

/** Every `<Link>` in `src` that points at /sources or /metodoloji. */
function staticTargetLinks(src: string): { line: number; prefetchOff: boolean }[] {
  return linkTags(src)
    .filter(({ tag }) => isStaticTargetHref(hrefOf(tag)))
    .map(({ tag, line }) => ({ line, prefetchOff: PREFETCH_OFF.test(tag) }));
}

const hits = PROFILE_FILES.flatMap((file) =>
  staticTargetLinks(readFileSync(resolve(ROOT, file), "utf8")).map(({ line, prefetchOff }) => ({
    file,
    where: `${file}:${line}`,
    prefetchOff,
  })),
);

describe("source profile does not prefetch /sources or /metodoloji (h166-perf-2)", () => {
  it("every <Link> to /sources or /metodoloji carries prefetch={false}", () => {
    const offenders = hits.filter((h) => !h.prefetchOff).map((h) => h.where);
    expect(
      offenders,
      `A source profile must not viewport-prefetch /sources (362 KB decoded) or /metodoloji (61 KB decoded): most visitors never click them (h166-perf-2). Add prefetch={false}; keep next/link:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("is not vacuous: finds the profile's /sources and /metodoloji links", () => {
    // Nine today: page 1, label-card 3, source-karne 2, source-reliability 2,
    // clickbait-karne 1.
    expect(hits.length).toBeGreaterThanOrEqual(9);
    for (const file of PROFILE_FILES) {
      expect(
        hits.some((h) => h.file === file),
        `${file} has no <Link> to /sources or /metodoloji any more: update the guard's file list`,
      ).toBe(true);
    }
  });

  describe("the guard itself works", () => {
    const flagged = (src: string): number =>
      staticTargetLinks(src).filter((l) => !l.prefetchOff).length;

    it("flags /sources and /metodoloji links without prefetch", () => {
      expect(flagged('<Link href="/sources">Tüm kaynaklar</Link>')).toBe(1);
      expect(flagged('<Link href="/metodoloji#kaynaklar">Bölgeler</Link>')).toBe(1);
      expect(flagged("<Link href={'/metodoloji'}>Yöntem</Link>")).toBe(1);
    });

    it("flags a template-literal /metodoloji href without prefetch", () => {
      expect(
        flagged("<Link href={`/metodoloji?source=${encodeURIComponent(slug)}#duzeltme`}>x</Link>"),
      ).toBe(1);
    });

    it("passes the same links with prefetch={false}", () => {
      expect(flagged('<Link href="/sources" prefetch={false}>Tüm kaynaklar</Link>')).toBe(0);
      expect(
        flagged('<Link href="/metodoloji#guvenilirlik" prefetch={false}>Nasıl?</Link>'),
      ).toBe(0);
      expect(
        flagged(
          "<Link href={`/metodoloji?source=${slug}#duzeltme`} prefetch={ false }>x</Link>",
        ),
      ).toBe(0);
    });

    it("flags a prefetch that is not literally false", () => {
      expect(flagged('<Link href="/sources" prefetch={true}>x</Link>')).toBe(1);
      expect(flagged('<Link href="/sources" prefetch={flag}>x</Link>')).toBe(1);
      expect(flagged('<Link href="/sources" prefetch>x</Link>')).toBe(1);
    });

    it("reads prefetch from its own tag only, not from a neighbouring one", () => {
      const src = [
        '<Link href="/sources">A</Link>',
        '<Link href="/kaynaklar/durum" prefetch={false}>B</Link>',
      ].join("\n");
      expect(staticTargetLinks(src)).toEqual([{ line: 1, prefetchOff: false }]);
    });

    it("handles a multi-line tag whose prefetch follows other attributes", () => {
      const src = `
        <Link
          className="underline"
          href="/metodoloji#duzeltme"
          onClick={(e) => track(e)}
          prefetch={false}
        >
          Düzeltme
        </Link>
      `;
      expect(staticTargetLinks(src)).toEqual([{ line: 2, prefetchOff: true }]);
    });

    it("ignores other targets, including paths that merely share a prefix with /sources", () => {
      expect(flagged('<Link href="/kaynaklar/durum">Durum</Link>')).toBe(0);
      expect(flagged('<Link href="/source/sozcu">Profil</Link>')).toBe(0);
      expect(flagged('<Link href="/sources/extra">x</Link>')).toBe(0);
      expect(flagged('<Link href="/sourcesx">x</Link>')).toBe(0);
      expect(flagged('<a href="/sources">plain anchor</a>')).toBe(0);
    });
  });
});
