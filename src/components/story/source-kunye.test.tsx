import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SourceChips } from "@/components/source/source-chips";
import { SOURCE_METADATA } from "@/lib/sources/factuality";

import { SourceBadge } from "./source-badge";
import { SourceProfileLink } from "./source-profile-link";
import { KUNYE_COLLAPSE_MIN, KUNYE_VISIBLE, SourceKunye } from "./source-kunye";

// h49-browser-1: the cluster page's "Kaynak künyesi" list used to render every
// rated outlet, so a 21-source story pushed "Aynı Haber, Farklı Dünyalar"
// about four phone screens down. SourceKunye shows the first KUNYE_VISIBLE
// rows and keeps the rest behind a native <details>. It is a synchronous,
// hookless server component, so it renders directly with react-dom/server
// (same approach as story-timeline.test and source-profile-link.test).

type KunyeSource = Parameters<typeof SourceKunye>[0]["sources"][number];

const SLUGS = Object.keys(SOURCE_METADATA);

/** `n` sources with real, SOURCE_METADATA-tagged slugs so SourceChips renders. */
function makeSources(n: number): KunyeSource[] {
  expect(SLUGS.length).toBeGreaterThanOrEqual(n);
  return SLUGS.slice(0, n).map((slug) => ({
    id: `id-${slug}`,
    slug,
    name: `Kaynak ${slug}`,
    trustee_since: null,
  }));
}

function render(sources: KunyeSource[]): string {
  return renderToStaticMarkup(<SourceKunye sources={sources} />);
}

const DETAILS_RE = /<details[\s>][\s\S]*?<\/details>/g;

/** The single <details> block, or null when there is none. */
function detailsOf(html: string): string | null {
  return html.match(DETAILS_RE)?.[0] ?? null;
}

/** The markup with every <details> block cut out. */
function outsideDetails(html: string): string {
  return html.replace(DETAILS_RE, "");
}

function rowsOf(fragment: string): string[] {
  return fragment.match(/<li[\s>][\s\S]*?<\/li>/g) ?? [];
}

/** Source slugs of the profile anchors in `fragment`, in document order. */
function slugsOf(fragment: string): string[] {
  return [...fragment.matchAll(/href="\/source\/([^"]+)"/g)].map((m) => m[1]!);
}

function summaryOf(html: string): { className: string; text: string } {
  const m = /<summary(?: class="([^"]*)")?>([\s\S]*?)<\/summary>/.exec(html);
  expect(m).not.toBeNull();
  return { className: m?.[1] ?? "", text: m?.[2] ?? "" };
}

/** Inner HTML of the `<li>` the page used to render for `source`. */
function expectedRowInner(source: KunyeSource): string {
  return renderToStaticMarkup(
    <>
      <SourceProfileLink slug={source.slug} name={source.name} />
      <SourceChips slug={source.slug} />
      <SourceBadge trusteeSince={source.trustee_since} />
    </>,
  );
}

function liInner(li: string): string {
  return /^<li[^>]*>([\s\S]*)<\/li>$/.exec(li)?.[1] ?? "";
}

const UL_CLASS = "flex flex-wrap gap-x-3 gap-y-1.5 min-w-0";

describe("SourceKunye - thresholds", () => {
  it("pins the visible-row cap and the collapse threshold", () => {
    expect(KUNYE_VISIBLE).toBe(6);
    expect(KUNYE_COLLAPSE_MIN).toBe(8);
  });

  it("renders nothing for an empty list", () => {
    expect(render([])).toBe("");
  });

  it("renders 5 sources as 5 rows with no disclosure", () => {
    const html = render(makeSources(5));
    expect(rowsOf(html)).toHaveLength(5);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
  });

  it("renders 7 sources as 7 rows with no disclosure (it would hide only 1 row)", () => {
    const html = render(makeSources(7));
    expect(rowsOf(html)).toHaveLength(7);
    expect(html).not.toContain("<details");
  });

  it("collapses exactly at the threshold: 8 sources show 6 and hide 2 behind 'Tüm künye (8 kaynak)'", () => {
    const sources = makeSources(8);
    const html = render(sources);
    const details = detailsOf(html);
    expect(details).not.toBeNull();
    expect(rowsOf(outsideDetails(html))).toHaveLength(6);
    expect(rowsOf(details!)).toHaveLength(2);
    expect(summaryOf(html).text).toBe("Tüm künye (8 kaynak)");
    expect(slugsOf(html)).toEqual(sources.map((s) => s.slug));
  });

  it("keeps the 'Kaynak künyesi' heading in both modes", () => {
    for (const n of [3, 21]) {
      const html = render(makeSources(n));
      expect(html).toContain("Kaynak künyesi");
    }
  });

  // h67-landmarks-1: the label was a <div>, so heading navigation skipped the
  // strip. It is an <h2> (a sibling of "Aynı Haber, Farklı Dünyalar") with the
  // classes the <div> had.
  it("renders 'Kaynak künyesi' as the one <h2>, in both modes (h67-landmarks-1)", () => {
    for (const n of [3, 21]) {
      const html = render(makeSources(n));
      const headings = html.match(/<h[1-6][\s>][\s\S]*?<\/h[1-6]>/g) ?? [];
      expect(headings).toHaveLength(1);
      expect(headings[0]).toMatch(/^<h2[\s>]/);
      expect(headings[0]).toContain("Kaynak künyesi");
      expect(html).not.toMatch(/<div[^>]*>\s*Kaynak künyesi\s*<\/div>/);
    }
  });

  it("keeps the heading's classes: no visual change from the old <div> (h67-landmarks-1)", () => {
    const html = render(makeSources(3));
    expect(html).toContain(
      '<h2 class="font-serif text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Kaynak künyesi</h2>',
    );
  });
});

describe("SourceKunye - 21 sources", () => {
  const sources = makeSources(21);
  const html = render(sources);
  const details = detailsOf(html);

  it("shows the first 6 rows outside any <details>, in input order", () => {
    const visible = outsideDetails(html);
    expect(rowsOf(visible)).toHaveLength(KUNYE_VISIBLE);
    expect(slugsOf(visible)).toEqual(sources.slice(0, 6).map((s) => s.slug));
  });

  it("puts the other 15 rows in exactly one <details>, in input order", () => {
    expect(html.match(/<details[\s>]/g)).toHaveLength(1);
    expect(details).not.toBeNull();
    expect(rowsOf(details!)).toHaveLength(15);
    expect(slugsOf(details!)).toEqual(sources.slice(6).map((s) => s.slug));
  });

  it("labels the disclosure exactly 'Tüm künye (21 kaynak)'", () => {
    expect(summaryOf(html).text).toBe("Tüm künye (21 kaynak)");
    expect(html.match(/<summary[\s>]/g)).toHaveLength(1);
  });

  it("starts closed (no open attribute) so the hidden rows are not in the first paint", () => {
    expect(/<details[^>]*\sopen[\s=>]/.test(html)).toBe(false);
  });

  it("keeps the summary a 44 px native tap target", () => {
    const tokens = summaryOf(html).className.split(/\s+/);
    for (const token of [
      "inline-flex",
      "min-h-[44px]",
      "touch-manipulation",
      "list-none",
      "items-center",
    ]) {
      expect(tokens).toContain(token);
    }
  });

  it("renders one profile anchor per source, 21 in all, and no target", () => {
    expect(html.match(/<a [^>]*href="\/source\//g)).toHaveLength(21);
    expect(html).not.toContain("target=");
  });

  it("keeps the same <ul> class string for the visible and the hidden list", () => {
    const uls = [...html.matchAll(/<ul class="([^"]*)"/g)].map((m) => m[1]);
    expect(uls).toEqual([UL_CLASS, UL_CLASS]);
    expect(detailsOf(html)).toContain(`<ul class="${UL_CLASS}">`);
  });
});

describe("SourceKunye - row markup is unchanged", () => {
  it("renders SourceProfileLink + SourceChips + SourceBadge inside every row, hidden ones included", () => {
    const sources = makeSources(21);
    // A kayyum badge on a row that sits behind the disclosure.
    sources[10] = { ...sources[10]!, trustee_since: "2016-03-04T00:00:00Z" };
    const html = render(sources);

    const rows = rowsOf(html);
    expect(rows).toHaveLength(21);
    rows.forEach((row, i) => {
      expect(liInner(row)).toBe(expectedRowInner(sources[i]!));
    });
    expect(liInner(rows[10]!)).toContain("Kayyum · ");
    expect(detailsOf(html)).toContain("Kayyum · ");
    // At least one real chip rendered, so the equality above is not vacuous.
    expect(liInner(rows[0]!).length).toBeGreaterThan(
      renderToStaticMarkup(
        <SourceProfileLink slug={sources[0]!.slug} name={sources[0]!.name} />,
      ).length,
    );
  });

  it("keeps the flex-wrap / min-w-0 / max-w-full row classes on visible and hidden rows", () => {
    const html = render(makeSources(21));
    for (const row of rowsOf(html)) {
      const tokens = /^<li class="([^"]*)"/.exec(row)?.[1]?.split(/\s+/) ?? [];
      for (const token of ["flex", "flex-wrap", "items-center", "gap-1.5", "min-w-0", "max-w-full"]) {
        expect(tokens).toContain(token);
      }
    }
  });

  it("renders a short list exactly as the old inline block did (4 sources)", () => {
    const sources = makeSources(4);
    const html = render(sources);
    const rows = rowsOf(html);
    expect(rows).toHaveLength(4);
    rows.forEach((row, i) => {
      expect(row).toBe(
        `<li class="flex flex-wrap items-center gap-1.5 min-w-0 max-w-full animate-fade-up stagger-${i}">${expectedRowInner(sources[i]!)}</li>`,
      );
    });
    expect(html).toContain(`<ul class="${UL_CLASS}">`);
    expect(html).toContain(">Kaynak künyesi</h2>");
  });
});

describe("SourceKunye - stagger animation", () => {
  it("animates the visible rows only; the hidden rows get no animation", () => {
    const html = render(makeSources(21));
    const visibleRows = rowsOf(outsideDetails(html));
    const hiddenRows = rowsOf(detailsOf(html)!);
    expect(visibleRows).toHaveLength(6);
    for (const row of visibleRows) {
      expect(row).toContain("animate-fade-up");
      expect(row).toMatch(/stagger-\d/);
    }
    for (const row of hiddenRows) {
      expect(row).not.toContain("animate-fade-up");
      expect(row).not.toContain("stagger-");
    }
  });

  it("only uses stagger-N names that globals.css defines (N >= 1; row 0 has no delay)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "../../app/globals.css"), "utf8");
    const html = render(makeSources(7));
    const used = [...html.matchAll(/stagger-(\d+)/g)].map((m) => Number(m[1]));
    expect(used).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const n of used.filter((n) => n >= 1)) {
      expect(css).toContain(`.stagger-${n} {`);
    }
  });
});

describe("SourceKunye - server component", () => {
  it("ships no client JS: no 'use client', no hooks", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "source-kunye.tsx"), "utf8");
    expect(source).not.toMatch(/["']use client["']/);
    expect(source).not.toMatch(/\buse(State|Effect|Ref|Memo|Callback)\b/);
  });
});
