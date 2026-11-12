import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hrefOf, linkTags } from "../_helpers/jsx-tags";

// ---------------------------------------------------------------------------
// Permanent CI guard (h166-perf-1): a compact list of /cluster rows must not
// viewport-prefetch.
//
// `next/link` prefetches every link that scrolls into the viewport. A /cluster
// page is request-time and DB-backed, so each row entering the viewport costs
// two RSC fetches (a route tree of about 0.8 KB and a segment of 1.4-2 KB).
// /timeline lists up to 180 rows: a full scroll was about 350 requests and
// 420 KB. The compact lists elsewhere already opt out for the same reason
// (MoreBlindspotList, related-stories); /timeline and the "Kör noktaya yakın"
// rows had not.
//
//     <Link href={`/cluster/${row.id}`} prefetch={false}>     // ok
//     <Link href={`/cluster/${row.id}`}>                      // offender
//
// Scope: the four files that render a compact row list of cluster links. The
// big ClusterCard grids are a separate decision and are not scanned here.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

const ROW_LIST_FILES = [
  "src/app/timeline/page.tsx",
  "src/components/blindspots/near-blindspot-section.tsx",
  "src/app/blindspots/page.tsx",
  "src/components/story/related-stories.tsx",
];

const isClusterHref = (href: string | null): boolean =>
  href !== null && href.startsWith("/cluster/");

/** `prefetch={false}`, with optional spaces inside the braces. Linear. */
const PREFETCH_OFF = /\bprefetch=\{\s*false\s*\}/;

interface Hit {
  where: string;
  prefetchOff: boolean;
}

/** Every `<Link>` in `src` whose href is a /cluster/ row path. */
function clusterLinks(src: string): { line: number; prefetchOff: boolean }[] {
  return linkTags(src)
    .filter(({ tag }) => isClusterHref(hrefOf(tag)))
    .map(({ tag, line }) => ({ line, prefetchOff: PREFETCH_OFF.test(tag) }));
}

const hits: Hit[] = ROW_LIST_FILES.flatMap((file) =>
  clusterLinks(readFileSync(resolve(ROOT, file), "utf8")).map(({ line, prefetchOff }) => ({
    where: `${relative(ROOT, resolve(ROOT, file))}:${line}`,
    prefetchOff,
  })),
);

describe("compact /cluster row links do not prefetch (h166-perf-1)", () => {
  it("every row <Link href=/cluster/...> carries prefetch={false}", () => {
    const offenders = hits.filter((h) => !h.prefetchOff).map((h) => h.where);
    expect(
      offenders,
      `A compact row list must not viewport-prefetch: every row entering the viewport fetches two RSC payloads of a request-time page (h166-perf-1). Add prefetch={false}:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("is not vacuous: finds the row links of every scanned file", () => {
    expect(hits.length).toBeGreaterThanOrEqual(4);
    for (const file of ROW_LIST_FILES) {
      expect(
        hits.some((h) => h.where.startsWith(`${file}:`)),
        `${file} has no <Link href="/cluster/..."> any more: update the guard's file list`,
      ).toBe(true);
    }
  });

  describe("the guard itself works", () => {
    const flagged = (src: string): number =>
      clusterLinks(src).filter((l) => !l.prefetchOff).length;

    it("flags a template-literal cluster link without prefetch", () => {
      expect(flagged("<Link href={`/cluster/${x}`}>Haber</Link>")).toBe(1);
    });

    it("flags a string cluster link without prefetch", () => {
      expect(flagged('<Link href="/cluster/abc">Haber</Link>')).toBe(1);
      expect(flagged("<Link href={'/cluster/abc'}>Haber</Link>")).toBe(1);
    });

    it("passes a cluster link with prefetch={false}", () => {
      expect(flagged("<Link href={`/cluster/${x}`} prefetch={false}>Haber</Link>")).toBe(0);
      expect(flagged("<Link href={`/cluster/${x}`} prefetch={ false }>Haber</Link>")).toBe(0);
    });

    it("flags a prefetch that is not literally false", () => {
      expect(flagged("<Link href={`/cluster/${x}`} prefetch={true}>Haber</Link>")).toBe(1);
      expect(flagged("<Link href={`/cluster/${x}`} prefetch={flag}>Haber</Link>")).toBe(1);
      expect(flagged("<Link href={`/cluster/${x}`} prefetch>Haber</Link>")).toBe(1);
    });

    it("reads prefetch from its own tag only, not from a neighbouring one", () => {
      const src = [
        "<Link href={`/cluster/${a}`}>A</Link>",
        '<Link href="/metodoloji" prefetch={false}>M</Link>',
      ].join("\n");
      expect(clusterLinks(src)).toEqual([{ line: 1, prefetchOff: false }]);
    });

    it("handles a multi-line tag whose prefetch follows other attributes", () => {
      const src = `
        <Link
          className="underline"
          href={\`/cluster/\${row.id}\`}
          onClick={(e) => track(e)}
          prefetch={false}
        >
          Haber
        </Link>
      `;
      expect(clusterLinks(src)).toEqual([{ line: 2, prefetchOff: true }]);
    });

    it("ignores links that do not point at a /cluster/ row", () => {
      expect(flagged('<Link href="/metodoloji#kor-noktaya-yakin">Nasıl?</Link>')).toBe(0);
      expect(flagged('<Link href="/clusters">Hepsi</Link>')).toBe(0);
      expect(flagged('<Link href="/cluster">Kök</Link>')).toBe(0);
    });
  });
});
