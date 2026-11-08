import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getImageProps } from "next/image";
import { describe, expect, it } from "vitest";

import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import type { BiasDistribution } from "@/types";

import {
  MOBILE_BANNER_SIZES,
  SOURCE_COUNT_QUALIFIED_TITLE,
  cardSourceCountLabel,
  cardSourceCountTitle,
  mobileBannerImageProps,
} from "./cluster-card";

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

/**
 * The desktop side thumbnail's `<ClusterCardImage ... />` opening tag: the
 * first one after the `hidden sm:block` wrapper, up to its closing `/>`.
 */
function thumbnailTag(): string {
  const from = src.indexOf("hidden sm:block");
  expect(from).toBeGreaterThan(-1);
  const start = src.indexOf("<ClusterCardImage", from);
  expect(start).toBeGreaterThan(from);
  const end = src.indexOf("/>", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end + 2);
}

describe("mobileBannerImageProps (perf-3)", () => {
  const SIZES = "(max-width: 640px) calc((100vw - 2rem) * 0.77), 0px";

  it("exports the banner sizes: 77% of the viewport minus the 1rem page gutters on mobile, nothing on desktop", () => {
    expect(MOBILE_BANNER_SIZES).toBe(SIZES);
  });

  // h18-perf-1 (c): the banner is a quality-50 photo under a scrim, so the
  // browser may upscale it a little. A 390 px phone has a 358 px slot; 77% of
  // it asks for 276 CSS px, which lands the DPR3 pick on the 828w candidate
  // (it was 1080w) and the DPR2 pick on 640w.
  it("a 390 px phone picks the 828w candidate at DPR3 and 640w at DPR2", () => {
    const factorText = /\) \* ([0-9.]+)\)/.exec(MOBILE_BANNER_SIZES)?.[1];
    expect(factorText).toBe("0.77");
    const slot = (390 - 32) * Number(factorText);

    expect(slot * 3).toBeLessThanOrEqual(828);
    expect(slot * 3).toBeGreaterThan(750);
    expect(slot * 2).toBeLessThanOrEqual(640);
    expect(slot * 2).toBeGreaterThan(384);
  });

  it("next.config.ts keeps the 640 and 828 device sizes that pick relies on", () => {
    const start = nextConfigSource.indexOf("deviceSizes:");
    expect(start).toBeGreaterThan(-1);
    const open = nextConfigSource.indexOf("[", start);
    const close = nextConfigSource.indexOf("]", open);
    const sizes = nextConfigSource
      .slice(open + 1, close)
      .split(",")
      .map((n) => Number(n.trim()));

    expect(sizes).toContain(640);
    expect(sizes).toContain(828);
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

  it("the desktop thumbnail renders at width={160} height={112} and passes no sizes prop", () => {
    const tag = thumbnailTag();
    expect(tag).toContain("width={160}");
    expect(tag).toContain("height={112}");
    // A `sizes` with no vw term makes next/image emit every configured width
    // (15 candidates); without it the srcset is a 1x/2x pair.
    expect(tag).not.toMatch(/\bsizes=/);
    expect(tag).not.toContain("160px");
  });

  it("only the mobile banner passes a sizes prop", () => {
    expect(count(src, "sizes=")).toBe(1);
  });
});

describe("desktop thumbnail srcset (h13-weight-2)", () => {
  const URL_ = "https://example.com/photo.jpg";

  it("a 160x112 image without sizes gets at most 2 srcset candidates (1x and 2x)", () => {
    const { props } = getImageProps({ src: URL_, width: 160, height: 112, alt: "" });
    const candidates = String(props.srcSet).split(",").map((c) => c.trim());
    expect(candidates.length).toBeLessThanOrEqual(2);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatch(/ 1x$/);
    expect(candidates[1]).toMatch(/ 2x$/);
    expect(props).not.toHaveProperty("sizes");
  });

  it("the old shape (width 320 + sizes=160px) emitted the full width ladder, so this test is not vacuous", () => {
    const { props } = getImageProps({
      src: URL_,
      width: 320,
      height: 224,
      sizes: "160px",
      alt: "",
    });
    expect(String(props.srcSet).split(",").length).toBeGreaterThan(8);
  });
});

describe("cluster-card.tsx undersized-thumbnail guard (minIntrinsicWidth)", () => {
  it("opts the full-width mobile hero in exactly once, never the 160px desktop thumb", () => {
    expect(count(src, "minIntrinsicWidth={320}")).toBe(1);
    expect(src).not.toMatch(/minIntrinsicWidth=\{(?!320\})/);

    // The prop must sit in the sm:hidden hero, i.e. before the desktop
    // thumbnail (anchored on its width={160}).
    const heroStart = src.indexOf("sm:hidden");
    const prop = src.indexOf("minIntrinsicWidth={320}");
    expect(heroStart).toBeGreaterThan(-1);
    expect(prop).toBeGreaterThan(heroStart);
    expect(prop).toBeLessThan(src.indexOf("width={160}"));
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

// h18-numbers-2: the wire badge printed "Tek kaynaktan dağıtıldı · N kopya"
// for clusters with several distinct dispatches (6 members, 3 texts). The text
// now comes from the shared helpers in wire.ts, fed the post-dedupe member
// count (articleCount) and the distinct-text count (effectiveArticleCount).
describe("cluster-card.tsx wire badge (h18-numbers-2)", () => {
  it("builds the label and the title from the wire helpers", () => {
    expect(src).toMatch(/from\s+"@\/lib\/clusters\/wire"/);
    expect(src).toContain(
      "wireBadgeLabel(articleCount, effectiveArticleCount ?? articleCount)",
    );
    expect(src).toContain("wireBadgeTitle(effectiveArticleCount ?? articleCount)");
  });

  it("keeps the badge behind {isWireRedistribution && (", () => {
    expect(count(src, "{isWireRedistribution && (")).toBe(1);
  });

  it("holds no hardcoded single-source literal (comments blanked)", () => {
    expect(src).not.toContain("Tek kaynaktan dağıtıldı");
    expect(src).not.toContain("tek kaynaktan");
    expect(src).not.toContain("aynı ajans metninin kopyası");
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

describe("cluster-card.tsx English headline language (h17-a11y-2, WCAG 3.1.2)", () => {
  // Interface body of `ClusterCardSource`, so the slug assertion cannot be
  // satisfied by a `slug` declared on some other interface in the file.
  function interfaceBody(name: string): string {
    const start = src.indexOf(`export interface ${name}`);
    expect(start).toBeGreaterThan(-1);
    const open = src.indexOf("{", start);
    const close = src.indexOf("\n}", open);
    expect(close).toBeGreaterThan(open);
    return src.slice(open, close);
  }

  it("imports sourceLang from @/lib/sources/source-language", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bsourceLang\b[^}]*\}\s*from\s*["']@\/lib\/sources\/source-language["']/,
    );
  });

  it("ClusterCardSource declares an optional, nullable slug (callers' projections may omit it)", () => {
    expect(interfaceBody("ClusterCardSource")).toMatch(
      /\bslug\?:\s*string\s*\|\s*null\s*;/,
    );
  });

  it("resolves title_lang from the slug with the source name as the fallback", () => {
    expect(count(src, "title_lang: sourceLang(")).toBe(1);
    expect(src).toMatch(
      /title_lang:\s*sourceLang\(\s*\{\s*slug:\s*src\?\.slug,\s*name:\s*source_name\s*\}\s*\)/,
    );
  });

  it("the article title span carries lang={a.title_lang}", () => {
    expect(count(src, "lang={a.title_lang}")).toBe(1);
    expect(src).toMatch(
      /<span\s+lang=\{a\.title_lang\}\s+className="text-muted-foreground text-xs"\s*>\s*\{a\.title\}\s*<\/span>/,
    );
  });

  it("imports headlineLang from @/lib/sources/source-language", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bheadlineLang\b[^}]*\}\s*from\s*["']@\/lib\/sources\/source-language["']/,
    );
  });

  it("derives headlineLangAttr from the cluster headline and the resolved articles' titles and langs", () => {
    expect(count(src, "const headlineLangAttr = headlineLang(")).toBe(1);
    expect(src).toMatch(
      /const headlineLangAttr = headlineLang\(\s*cluster\.title_tr,\s*resolved\.map\(\(a\) => \(\{ title: a\.title, lang: a\.title_lang \}\)\),?\s*\);/,
    );
    // Declared once `resolved` exists.
    expect(src.indexOf("const headlineLangAttr")).toBeGreaterThan(src.indexOf("const resolved = articles"));
  });

  it("the card's h2 carries lang={headlineLangAttr} next to id={headingId}", () => {
    const h2Tags = openingTagsOf(src, "<h2");
    expect(h2Tags).toHaveLength(1);
    expect(h2Tags[0]).toContain("lang={headlineLangAttr}");
    expect(h2Tags[0]).toContain("id={headingId}");
    expect(count(src, "lang={headlineLangAttr}")).toBe(1);
    // The h2 still renders the cluster headline.
    expect(src).toMatch(/<h2\b[^>]*>\s*\{cluster\.title_tr\}\s*<\/h2>/);
  });

  it("no other lang= appears in the file: the article title span and the h2 only (source name and chrome stay Turkish)", () => {
    expect(src.match(/\blang=/g)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// h66-statsparity-1: the card's pill printed the bare member count ("17
// kaynak") next to a bar drawn from the VOTING-only bias_distribution (14
// voters), while the OG card, embed, rozet, RSS, Telegram, share text and
// /takip already print "N kaynak (M sınıflandırılmış)". The pill now goes
// through the same sourceCountHead; the marker (and a title that explains it)
// shows only when fewer sources voted than the pill counts.
// ---------------------------------------------------------------------------

function dist(overrides: Partial<BiasDistribution> = {}): BiasDistribution {
  return { ...emptyBiasDistribution(), ...overrides };
}

describe("cardSourceCountLabel (h66-statsparity-1)", () => {
  it("17 members, 14 voters (10 iktidar / 1 bağımsız / 3 muhalefet): marks the voting count", () => {
    const distribution = dist({
      gov_leaning: 5,
      pro_government: 5,
      center: 1,
      opposition: 1,
      opposition_leaning: 2,
    });

    expect(cardSourceCountLabel(17, distribution)).toBe("17 kaynak (14 sınıflandırılmış)");
  });

  it("every member voted: the bare count, no marker", () => {
    expect(cardSourceCountLabel(3, dist({ pro_government: 1, center: 1, opposition: 1 }))).toBe(
      "3 kaynak",
    );
  });

  it("a wire card (2 distinct dispatches, 6 voters) keeps the bare count: voting >= total", () => {
    const distribution = dist({ pro_government: 3, center: 1, opposition: 2 });

    expect(cardSourceCountLabel(2, distribution)).toBe("2 kaynak");
  });

  it("nobody voted: says so with the helper's own rule", () => {
    expect(cardSourceCountLabel(3, dist())).toBe("3 kaynak (0 sınıflandırılmış)");
  });

  it("matches sourceCountHead over the same zone counts, so every surface words it alike", async () => {
    const { sourceCountHead } = await import("@/lib/feeds/zone-line");
    const { zoneCountsOf } = await import("@/lib/bias/zone-summary");
    const distribution = dist({ pro_government: 9, center: 1 });

    expect(cardSourceCountLabel(16, distribution)).toBe(
      sourceCountHead(16, zoneCountsOf(distribution)),
    );
  });
});

describe("cardSourceCountTitle (h66-statsparity-1)", () => {
  it("uses the /blindspots row wording", () => {
    expect(SOURCE_COUNT_QUALIFIED_TITLE).toBe("Toplayıcı ve niş kaynaklar spektruma sayılmaz.");
  });

  it("is set exactly when the marker shows", () => {
    const fourteen = dist({ gov_leaning: 5, pro_government: 5, center: 1, opposition: 1, opposition_leaning: 2 });
    const three = dist({ pro_government: 1, center: 1, opposition: 1 });

    expect(cardSourceCountTitle(17, fourteen)).toBe(SOURCE_COUNT_QUALIFIED_TITLE);
    expect(cardSourceCountTitle(3, dist())).toBe(SOURCE_COUNT_QUALIFIED_TITLE);
    expect(cardSourceCountTitle(3, three)).toBeUndefined();
    expect(cardSourceCountTitle(2, dist({ pro_government: 3, center: 1, opposition: 2 }))).toBeUndefined();
  });

  it("agrees with the label for every total around the voter count", () => {
    const distribution = dist({ pro_government: 4, center: 2, opposition: 2 });
    for (const total of [0, 1, 7, 8, 9, 20]) {
      const marked = cardSourceCountLabel(total, distribution).includes("sınıflandırılmış");
      expect(cardSourceCountTitle(total, distribution) !== undefined).toBe(marked);
    }
  });
});

describe("cluster-card.tsx source-count pill (h66-statsparity-1)", () => {
  const badgesStart = src.indexOf("function ClusterMetaBadges");
  const cardStart = src.indexOf("export function ClusterCard(");

  it("imports sourceCountHead and zoneCountsOf from the shared modules", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bsourceCountHead\b[^}]*\}\s*from\s*["']@\/lib\/feeds\/zone-line["']/,
    );
    expect(src).toMatch(
      /import\s*\{[^}]*\bzoneCountsOf\b[^}]*\}\s*from\s*["']@\/lib\/bias\/zone-summary["']/,
    );
  });

  it("builds the pill from cardSourceCountLabel(effectiveArticleCount ?? articleCount, distribution), once", () => {
    expect(count(src, "cardSourceCountLabel(effectiveArticleCount ?? articleCount, distribution)")).toBe(1);
    const at = src.indexOf("cardSourceCountLabel(effectiveArticleCount ?? articleCount, distribution)");
    expect(at).toBeGreaterThan(badgesStart);
    expect(at).toBeLessThan(cardStart);
  });

  it("holds no bare '{... ?? articleCount} kaynak' pill any more", () => {
    expect(src).not.toMatch(/\}\s*kaynak\s*</);
    expect(src).not.toMatch(/\{effectiveArticleCount \?\? articleCount\} kaynak/);
  });

  it("puts the explanatory title on the pill from cardSourceCountTitle, not an unconditional literal", () => {
    expect(count(src, "cardSourceCountTitle(effectiveArticleCount ?? articleCount, distribution)")).toBe(1);
    expect(src).toMatch(/<span\s+className="[^"]*"\s+title=\{countTitle\}\s*>\s*<Users/);
    // The wording lives in one constant, not repeated inline.
    expect(count(src, "Toplayıcı ve niş kaynaklar spektruma sayılmaz.")).toBe(1);
  });

  it("ClusterMetaBadges takes a distribution prop and ClusterCard hands it cluster.bias_distribution", () => {
    const props = src.slice(
      src.indexOf("interface ClusterMetaBadgesProps"),
      src.indexOf("function ClusterMetaBadges("),
    );
    expect(props).toMatch(/\bdistribution:\s*BiasDistribution\b/);
    expect(src).toMatch(/<ClusterMetaBadges[^>]*\bdistribution=\{cluster\.bias_distribution\}/s);
  });

  it("leaves the bar and the balance chip on the same distribution (percentages unchanged)", () => {
    expect(src).toContain(
      "<BiasSpectrum distribution={cluster.bias_distribution} compact />",
    );
    expect(src).toContain("balance={balanceFromDistribution(cluster.bias_distribution)}");
  });
});
