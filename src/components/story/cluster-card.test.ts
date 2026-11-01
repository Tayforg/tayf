import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MOBILE_BANNER_SIZES, mobileBannerImageProps } from "./cluster-card";

// Source guard (repo convention: no render tests of server components --
// ClusterCard is an async-data Server Component). Pins the image-priority
// wiring the browser-6 / perf-3 fixes depend on, so a refactor cannot quietly
// bring back a second eager/preloaded hero or a preload on every top card.
// The pure `mobileBannerImageProps` helper is exercised directly.

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "cluster-card.tsx"), "utf8");
const nextConfigSource = readFileSync(
  join(here, "..", "..", "..", "next.config.ts"),
  "utf8",
);

// Blanks line and block comments (offsets kept) so prose can't satisfy or trip a pattern.
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

const src = blankComments(raw);

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("mobileBannerImageProps (perf-3)", () => {
  const SIZES = "(max-width: 640px) calc(100vw - 2rem), 0px";

  it("exports the banner sizes: the viewport minus the 1rem page gutters on mobile, nothing on desktop", () => {
    expect(MOBILE_BANNER_SIZES).toBe(SIZES);
  });

  it("preloads at high priority for the first card only (index 0)", () => {
    expect(mobileBannerImageProps(0)).toEqual({
      priority: true,
      fetchPriority: "high",
      sizes: SIZES,
      quality: 50,
    });
  });

  it.each([1, 2, 3, 10])("does not preload or raise priority for card %i", (index) => {
    expect(mobileBannerImageProps(index)).toEqual({
      priority: false,
      fetchPriority: undefined,
      sizes: SIZES,
      quality: 50,
    });
  });

  it("does not preload when the index is omitted", () => {
    expect(mobileBannerImageProps()).toEqual({
      priority: false,
      fetchPriority: undefined,
      sizes: SIZES,
      quality: 50,
    });
    expect(mobileBannerImageProps(undefined)).toEqual(mobileBannerImageProps());
  });

  it("only ever hints fetchPriority together with priority", () => {
    for (const index of [undefined, 0, 1, 2, 3, 10]) {
      const p = mobileBannerImageProps(index);
      expect(p.fetchPriority === "high").toBe(p.priority);
    }
  });

  it("asks for a quality that next.config.ts images.qualities allows", () => {
    expect(nextConfigSource).toMatch(/qualities:\s*\[[^\]]*\b50\b/);
    expect(mobileBannerImageProps(0).quality).toBe(50);
  });
});

describe("cluster-card.tsx image priority wiring (browser-6 / perf-3)", () => {
  const heroStart = src.indexOf("sm:hidden");
  const thumbStart = src.indexOf("hidden sm:block");

  it("derives the banner props once from mobileBannerImageProps(index)", () => {
    expect(count(src, "mobileBannerImageProps(index)")).toBe(1);
    expect(src).toContain("const banner = mobileBannerImageProps(index)");
  });

  it.each([
    "priority={banner.priority}",
    "fetchPriority={banner.fetchPriority}",
    "quality={banner.quality}",
    "sizes={banner.sizes}",
  ])("passes %s exactly once, inside the sm:hidden mobile banner", (prop) => {
    expect(count(src, prop)).toBe(1);

    // ...and that one sits inside the sm:hidden banner, not the desktop slot.
    const at = src.indexOf(prop);
    expect(heroStart).toBeGreaterThan(-1);
    expect(thumbStart).toBeGreaterThan(heroStart);
    expect(at).toBeGreaterThan(heroStart);
    expect(at).toBeLessThan(thumbStart);
  });

  it("keeps the desktop thumbnail lazy: priority={false} once, after the banner", () => {
    expect(count(src, "priority={false}")).toBe(1);
    expect(src.indexOf("priority={false}")).toBeGreaterThan(thumbStart);
  });

  it("gives the lazy desktop thumbnail no fetchPriority hint (the banner carries the only one)", () => {
    expect(count(src, "fetchPriority=")).toBe(1);
  });

  it("no longer ranks the top three cards: no PRIORITY_CARD_COUNT, no per-card flag, no default index", () => {
    // Raw source: stale prose naming the old identifiers must go too.
    expect(raw).not.toContain("isPriority");
    expect(raw).not.toContain("PRIORITY_CARD_COUNT");
    // `index` is optional with NO default: an omitted index is never card 0.
    expect(src).not.toMatch(/\bindex\s*=(?!=)/);
  });

  it("has no inline banner sizes literal left (it lives in MOBILE_BANNER_SIZES)", () => {
    expect(src).not.toContain('sizes="(max-width');
    expect(count(src, "MOBILE_BANNER_SIZES")).toBeGreaterThanOrEqual(1);
  });

  it('keeps the fixed sizes="160px" slot the next-images config test pins', () => {
    expect(src).toContain('sizes="160px"');
  });
});

describe("cluster-card.tsx undersized-thumbnail guard (minIntrinsicWidth)", () => {
  it("opts the full-width mobile hero in exactly once, never the 160px desktop thumb", () => {
    expect(count(src, "minIntrinsicWidth={320}")).toBe(1);
    expect(src).not.toMatch(/minIntrinsicWidth=\{(?!320\})/);

    // The prop must sit in the sm:hidden hero, i.e. before the desktop
    // thumbnail's fixed 160px slot.
    const heroStart = src.indexOf("sm:hidden");
    const prop = src.indexOf("minIntrinsicWidth={320}");
    expect(heroStart).toBeGreaterThan(-1);
    expect(prop).toBeGreaterThan(heroStart);
    expect(prop).toBeLessThan(src.indexOf('sizes="160px"'));
    expect(prop).toBeLessThan(src.indexOf("hidden sm:block"));
  });
});

describe("cluster-card.tsx text contrast (a11y-2)", () => {
  it("has no opacity-modified brand text token", () => {
    expect(src).not.toContain("text-brand/");
  });

  it("styles the '+N başka kaynak' line with the full brand token", () => {
    expect(src).toMatch(/className="text-\[11px\] text-brand"/);
  });
});

describe("cluster-card.tsx balance chip (Denge puanı)", () => {
  it("renders <BalanceChip> inside ClusterMetaBadges, not in ClusterCard", () => {
    const badgesStart = src.indexOf("function ClusterMetaBadges");
    const cardStart = src.indexOf("export function ClusterCard");
    const chip = src.indexOf("<BalanceChip");
    expect(badgesStart).toBeGreaterThan(-1);
    expect(cardStart).toBeGreaterThan(badgesStart);
    expect(chip).toBeGreaterThan(badgesStart);
    expect(chip).toBeLessThan(cardStart);
    expect(count(src, "<BalanceChip")).toBe(1);
  });

  it("uses the compact variant and only for a non-null score", () => {
    expect(src).toContain('<BalanceChip balance={balance} variant="compact" />');
    expect(src).toMatch(/\{balance && \(\s*<BalanceChip/);
  });

  it("sits right after the Clock pill", () => {
    const clock = src.indexOf("<Clock");
    const chip = src.indexOf("<BalanceChip");
    const wire = src.indexOf("{isWireRedistribution && (");
    expect(clock).toBeGreaterThan(-1);
    expect(chip).toBeGreaterThan(clock);
    expect(chip).toBeLessThan(wire);
  });

  it("derives the score from the same distribution the BiasSpectrum bar uses", () => {
    expect(src).toContain("balanceFromDistribution(cluster.bias_distribution)");
    expect(src).toContain("balance={balanceFromDistribution(cluster.bias_distribution)}");
    expect(src).toContain(
      "<BiasSpectrum distribution={cluster.bias_distribution} compact />",
    );
  });
});

describe("cluster-card.tsx aging treatment (contrast sweep)", () => {
  it("never dims the whole card with an opacity utility (text keeps full contrast)", () => {
    // Raw source: stale prose mentioning the old class must go too.
    expect(raw).not.toContain("opacity-80");
  });

  it("desaturates only the images of an aging card", () => {
    expect(src).toContain('isAging ? " [&_img]:grayscale" : ""');
    expect(src).toContain("[&_img]:grayscale");
  });
});

describe("cluster-card.tsx bookmark accessible name (WCAG 2.5.3)", () => {
  it("passes the h2 story title to the overlay bookmark button, so each card's control has its own name", () => {
    expect(count(src, "<BookmarkButton")).toBe(1);
    expect(src).toMatch(/<BookmarkButton[^>]*\bstoryTitle=\{cluster\.title_tr\}/);
    expect(src).toMatch(/<BookmarkButton[^>]*\bvariant="overlay"/);
  });
});

// ---------------------------------------------------------------------------
// h10-a11y-1: Chrome never builds a link's accessible name from an <article>
// descendant (name-from-content skips the article role), so the card link,
// which used to wrap an <article>, was a nameless link on /, /blindspots and
// /konu/*. The article is now the OUTER wrapper (link + bookmark), the link
// names itself from the h2 through aria-labelledby, the thumbnails are
// decorative (the headline is adjacent) and the member rows read as
// "Kaynak: Başlık". Visual output is unchanged: no class string moved.
// ---------------------------------------------------------------------------

/**
 * Opening tag of the first `needle` occurrence: the scan walks to the first
 * `>` outside braces and string/template literals, so `className={`...`}` or
 * an arrow function in a prop cannot end the tag early.
 */
function openingTagAt(source: string, needle: string, from = 0): string {
  const start = source.indexOf(needle, from);
  if (start === -1) return "";
  let depth = 0;
  let quote: string | null = null;
  let i = start + needle.length;
  for (; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || (c === "`" && depth > 0)) quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) break;
  }
  return source.slice(start, i + 1);
}

/** Every opening tag that starts with `needle`, in source order. */
function openingTagsOf(source: string, needle: string): string[] {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return tags;
    tags.push(openingTagAt(source, needle, at));
    from = at + needle.length;
  }
}

describe("card link accessible name (h10-a11y-1)", () => {
  const linkOpen = src.indexOf("<Link");
  const linkClose = src.indexOf("</Link>");
  const articleOpen = src.indexOf("<article");
  const articleClose = src.indexOf("</article>");

  it("makes the OUTER wrapper the only <article>: returned JSX starts with <article className=\"relative\">", () => {
    expect(src).toMatch(/return \(\s*<article className="relative">/);
    expect(count(src, "<article")).toBe(1);
    expect(count(src, "</article>")).toBe(1);
    expect(count(src, "<Link")).toBe(1);
    expect(count(src, "</Link>")).toBe(1);
  });

  it("closes the <article> after the </Link>, so it wraps the link plus the bookmark", () => {
    const bookmark = src.indexOf("<BookmarkButton");
    expect(articleOpen).toBeGreaterThan(-1);
    expect(bookmark).toBeGreaterThan(articleOpen);
    expect(linkOpen).toBeGreaterThan(bookmark);
    expect(linkClose).toBeGreaterThan(linkOpen);
    expect(articleClose).toBeGreaterThan(linkClose);
  });

  it("puts no <article> between <Link and </Link> (Chrome excludes it from the link's name)", () => {
    const linkBody = src.slice(linkOpen, linkClose);
    expect(linkBody).not.toContain("<article");
    expect(linkBody).not.toContain("</article>");
    expect(linkBody).not.toContain("<section");
  });

  it("names the link from the visible h2 via aria-labelledby", () => {
    expect(src).toContain("const headingId = `kart-baslik-${cluster.id}`");

    const linkTags = openingTagsOf(src, "<Link");
    expect(linkTags).toHaveLength(1);
    expect(linkTags[0]).toContain("aria-labelledby={headingId}");

    const h2Tags = openingTagsOf(src, "<h2");
    expect(h2Tags).toHaveLength(1);
    expect(h2Tags[0]).toContain("id={headingId}");

    // The id sits on the card's own headline, inside the link it names.
    const h2At = src.indexOf("<h2");
    expect(h2At).toBeGreaterThan(linkOpen);
    expect(h2At).toBeLessThan(linkClose);
  });

  it("gives both thumbnails alt=\"\" (the headline is adjacent) and drops heroAlt", () => {
    const imageTags = openingTagsOf(src, "<ClusterCardImage");
    expect(imageTags).toHaveLength(2);
    for (const tag of imageTags) {
      expect(tag).toContain('alt=""');
      expect(tag).not.toMatch(/\balt=\{/);
    }
    expect(raw).not.toContain("heroAlt");
  });

  it("separates the source name from the title with a screen-reader-only \": \" in the member row", () => {
    expect(src).toMatch(
      /\{a\.source_name\}\s*<\/span>\s*<span className="sr-only">: <\/span>\s*<span[^>]*>\s*\{a\.title\}/,
    );
    expect(count(src, '<span className="sr-only">: </span>')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// h11-mobile-1: the overlay bookmark used to sit at `right-3 top-3` (12 px) on
// every width, but from `sm` the card content is `p-5` (20 px) and the 160x112
// side thumbnail starts at that padded corner. The 36 px button therefore stuck
// out 8 px to the right of and above the thumbnail on every card at >= 640 px.
// At `sm:right-7 sm:top-7` (20 px padding + 8 px) it sits inside the thumbnail;
// below `sm` the 12 px offset keeps it over the 16:9 banner, which is unchanged.
// ---------------------------------------------------------------------------

describe("cluster-card.tsx bookmark position (h11-mobile-1)", () => {
  const bookmarkTags = openingTagsOf(src, "<BookmarkButton");
  const bookmarkTag = bookmarkTags[0] ?? "";

  it("offsets the overlay by 12 px on mobile and 28 px (20 px padding + 8 px) from sm", () => {
    expect(bookmarkTags).toHaveLength(1);
    expect(bookmarkTag).toContain(
      'className="absolute right-3 top-3 z-10 sm:right-7 sm:top-7"',
    );
  });

  it("keeps the sm offset in step with the card padding (sm:p-5 = 20 px, so sm:right-7 = 28 px)", () => {
    expect(src).toContain('className="p-6 sm:p-5 space-y-4"');
    // Tailwind spacing: p-5 = 1.25rem = 20 px, right-7/top-7 = 1.75rem = 28 px,
    // right-3/top-3 = 0.75rem = 12 px. A 36 px button 8 px inside the corner of
    // a 160x112 thumbnail ends at 28 + 36 = 64 px from the corner, well inside.
    const padding = 5 * 4;
    const offset = 7 * 4;
    const button = 36;
    expect(offset - padding).toBe(8);
    expect(offset + button).toBeLessThanOrEqual(padding + 160);
    expect(offset + button).toBeLessThanOrEqual(padding + 112);
  });

  it('stays a sibling BEFORE the <Link>, inside <article className="relative">', () => {
    const articleOpen = src.indexOf('<article className="relative">');
    const bookmark = src.indexOf("<BookmarkButton");
    const linkOpen = src.indexOf("<Link");
    const articleClose = src.indexOf("</article>");
    expect(articleOpen).toBeGreaterThan(-1);
    expect(bookmark).toBeGreaterThan(articleOpen);
    expect(linkOpen).toBeGreaterThan(bookmark);
    expect(articleClose).toBeGreaterThan(src.indexOf("</Link>"));
    // The button's own tag closes before the link opens: it never wraps or nests in it.
    expect(bookmark + bookmarkTag.length).toBeLessThanOrEqual(linkOpen);
  });

  it("no longer uses the bare right-3 top-3 offset on every width", () => {
    expect(src).not.toContain('className="absolute right-3 top-3 z-10"');
  });
});
