import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { firstPartyLogoUrl } from "@/lib/images/image-url";

import {
  SourceLogo,
  SourceLogoFallback,
  isBrokenImage,
  sourceInitials,
  sourceMonogram,
} from "./source-logo";

// This suite runs in vitest's `node` environment (no jsdom, no RTL), so the
// onError / post-hydration paths cannot be exercised by dispatching events.
// House style (share-button.test.tsx, cluster-card-image.test.tsx): assert on
// `renderToStaticMarkup`, on pure helpers, and on source guards. The failed
// state is covered by rendering `SourceLogoFallback` — the exact view
// `SourceLogo` swaps to once `failed` flips.

const S2 = "https://www.google.com/s2/favicons?domain=gazete.net&sz=64";
const S2_PROXY_PREFIX =
  'src="/_next/image?url=https%3A%2F%2Fwww.google.com%2Fs2%2Ffavicons';

const IMG_CLASS = "h-8 w-8 rounded shrink-0 object-contain";
const SQUARE_CLASS = "h-8 w-8 rounded shrink-0 bg-muted/60";
const INITIALS_CLASS =
  "inline-flex h-3.5 w-3.5 items-center justify-center rounded bg-muted text-[8px] font-bold text-muted-foreground shrink-0";
// The centred monogram the 'square' fallback renders inside the caller's tile.
const MONOGRAM_CLASS =
  "flex h-full w-full items-center justify-center font-semibold leading-none text-muted-foreground";
const squareTile = (letter: string, outer = SQUARE_CLASS) =>
  `<span aria-hidden="true" class="${outer}"><span class="${MONOGRAM_CLASS}">${letter}</span></span>`;

describe("SourceLogo — URL routing", () => {
  it("routes a Google S2 favicon through /_next/image at the default width (64)", () => {
    const html = renderToStaticMarkup(
      <SourceLogo
        logoUrl={S2}
        name="Gazete"
        className={IMG_CLASS}
        fallback="square"
        fallbackClassName={SQUARE_CLASS}
      />,
    );
    expect(html).toContain(S2_PROXY_PREFIX);
    expect(html).toContain("&amp;w=64&amp;q=75");
  });

  it("forwards `width` to the optimizer (128 -> w=128)", () => {
    const html = renderToStaticMarkup(
      <SourceLogo
        logoUrl={S2}
        name="Gazete"
        width={128}
        className={IMG_CLASS}
        fallback="square"
        fallbackClassName={SQUARE_CLASS}
      />,
    );
    expect(html).toContain(S2_PROXY_PREFIX);
    expect(html).toContain("&amp;w=128&amp;q=75");
    expect(html).not.toContain("&amp;w=64");
  });

  it("passes a non-Google URL through unchanged", () => {
    const html = renderToStaticMarkup(
      <SourceLogo
        logoUrl="https://example.com/logo.png"
        name="Example"
        className={IMG_CLASS}
        fallback="square"
        fallbackClassName={SQUARE_CLASS}
      />,
    );
    expect(html).toContain('src="https://example.com/logo.png"');
    expect(html).not.toContain("/_next/image");
  });
});

// The request width follows the slot: `width ?? (size <= 16 ? 32 : 64)`. A
// 14 px favicon slot (cluster cards, framing rows) needs 32w for a 2x screen;
// fetching 64w for ~100 of them per page is wasted bytes (h13-weight-2).
describe("SourceLogo — request width derives from size", () => {
  const attr = (url: string | null) => (url ?? "").replace(/&/g, "&amp;");
  const render = (props: { size?: number; width?: number }) =>
    renderToStaticMarkup(
      <SourceLogo
        logoUrl={S2}
        name="Gazete"
        className={IMG_CLASS}
        fallback="initials"
        fallbackClassName={INITIALS_CLASS}
        {...props}
      />,
    );

  it("size 14 -> the 32 px optimizer width", () => {
    const html = render({ size: 14 });
    expect(html).toContain(`src="${attr(firstPartyLogoUrl(S2, 32))}"`);
    expect(html).toContain("&amp;w=32&amp;q=75");
  });

  it.each([
    [1, 32],
    [14, 32],
    [16, 32],
    [17, 64],
    [32, 64],
    [64, 64],
  ])("size %i -> w=%i", (size, w) => {
    expect(render({ size })).toContain(`src="${attr(firstPartyLogoUrl(S2, w))}"`);
  });

  it("no size and no width -> the 64 px optimizer width", () => {
    const html = render({});
    expect(html).toContain(`src="${attr(firstPartyLogoUrl(S2, 64))}"`);
    expect(html).toContain("&amp;w=64&amp;q=75");
  });

  it("an explicit width wins over the size-derived one", () => {
    expect(render({ size: 14, width: 128 })).toContain(
      `src="${attr(firstPartyLogoUrl(S2, 128))}"`,
    );
    expect(render({ size: 14, width: 64 })).toContain(
      `src="${attr(firstPartyLogoUrl(S2, 64))}"`,
    );
    expect(render({ width: 96 })).toContain(`src="${attr(firstPartyLogoUrl(S2, 96))}"`);
  });

  it("every derived width is one /_next/image accepts (a configured imageSizes entry)", () => {
    for (const size of [undefined, 14, 16, 24]) {
      expect(render({ size })).toMatch(/&amp;w=(?:32|64)&amp;q=75/);
    }
  });
});

describe("SourceLogo — img attributes", () => {
  it("renders a decorative, lazy image carrying the img className and no fallback class", () => {
    const html = renderToStaticMarkup(
      <SourceLogo
        logoUrl={S2}
        name="Gazete"
        className={IMG_CLASS}
        fallback="square"
        fallbackClassName={SQUARE_CLASS}
      />,
    );
    expect(html).toContain("<img");
    expect(html).toContain('alt=""');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain(`class="${IMG_CLASS}"`);
    expect(html).not.toContain("bg-muted/60");
    // No size prop -> no width/height attributes (CSS classes size the box).
    expect(html).not.toMatch(/\swidth="/);
    expect(html).not.toMatch(/\sheight="/);
  });

  it("emits width/height attributes when `size` is given", () => {
    const html = renderToStaticMarkup(
      <SourceLogo
        logoUrl={S2}
        name="Gazete"
        size={14}
        className="h-3.5 w-3.5 rounded shrink-0"
        fallback="initials"
        fallbackClassName={INITIALS_CLASS}
      />,
    );
    expect(html).toContain('width="14"');
    expect(html).toContain('height="14"');
  });

  it("forwards loading=\"eager\"", () => {
    const html = renderToStaticMarkup(
      <SourceLogo
        logoUrl={S2}
        name="Gazete"
        loading="eager"
        className={IMG_CLASS}
        fallback="square"
        fallbackClassName={SQUARE_CLASS}
      />,
    );
    expect(html).toContain('loading="eager"');
    expect(html).not.toContain('loading="lazy"');
  });
});

describe("SourceLogo — no logo", () => {
  it.each([null, undefined, ""])(
    "initials fallback for logoUrl=%j renders no <img> and an aria-hidden initials badge",
    (logoUrl) => {
      const html = renderToStaticMarkup(
        <SourceLogo
          logoUrl={logoUrl}
          name="NTV"
          className="h-3.5 w-3.5 rounded shrink-0"
          fallback="initials"
          fallbackClassName={INITIALS_CLASS}
        />,
      );
      expect(html).not.toContain("<img");
      expect(html).toBe(
        `<span aria-hidden="true" class="${INITIALS_CLASS}">NT</span>`,
      );
    },
  );

  it("square fallback renders no <img> and an aria-hidden tile carrying the outlet's initial", () => {
    const html = renderToStaticMarkup(
      <SourceLogo
        logoUrl={null}
        name="NTV"
        className={IMG_CLASS}
        fallback="square"
        fallbackClassName={SQUARE_CLASS}
      />,
    );
    expect(html).not.toContain("<img");
    expect(html).toBe(squareTile("N"));
  });

  it("uses the fallback class, never the img class, when there is no logo", () => {
    const html = renderToStaticMarkup(
      <SourceLogo
        logoUrl={null}
        name="NTV"
        className="IMG_ONLY_CLASS"
        fallback="square"
        fallbackClassName="FALLBACK_ONLY_CLASS"
      />,
    );
    expect(html).toContain("FALLBACK_ONLY_CLASS");
    expect(html).not.toContain("IMG_ONLY_CLASS");
  });
});

describe("SourceLogoFallback — the post-onError view", () => {
  it("initials kind matches the no-logo initials markup", () => {
    const fromFallback = renderToStaticMarkup(
      <SourceLogoFallback kind="initials" name="NTV" className={INITIALS_CLASS} />,
    );
    const fromLogo = renderToStaticMarkup(
      <SourceLogo
        logoUrl={null}
        name="NTV"
        className="x"
        fallback="initials"
        fallbackClassName={INITIALS_CLASS}
      />,
    );
    expect(fromFallback).toBe(fromLogo);
    expect(fromFallback).not.toContain("<img");
    expect(fromFallback).toContain(">NT<");
    expect(fromFallback).toContain('aria-hidden="true"');
    expect(fromFallback).toContain(INITIALS_CLASS);
  });

  it("square kind matches the no-logo square markup (logoUrl=null)", () => {
    const fromFallback = renderToStaticMarkup(
      <SourceLogoFallback kind="square" name="NTV" className={SQUARE_CLASS} />,
    );
    const fromLogo = renderToStaticMarkup(
      <SourceLogo
        logoUrl={null}
        name="NTV"
        className="x"
        fallback="square"
        fallbackClassName={SQUARE_CLASS}
      />,
    );
    expect(fromFallback).toBe(fromLogo);
    expect(fromFallback).toBe(squareTile("N"));
  });

  it("square kind for 'Gazete.net': the initial, aria-hidden, caller class outside, centring inside", () => {
    const html = renderToStaticMarkup(
      <SourceLogoFallback kind="square" name="Gazete.net" className={SQUARE_CLASS} />,
    );
    expect(html).toContain(">G<");
    expect(html).toContain('aria-hidden="true"');
    // Outer span: the caller's box classes, nothing else.
    expect(html).toMatch(new RegExp(`^<span aria-hidden="true" class="${SQUARE_CLASS}">`));
    // Inner span: fills the tile and centres the letter.
    const inner = html.match(/<span class="([^"]*)">G<\/span>/);
    expect(inner).not.toBeNull();
    for (const c of ["flex", "h-full", "w-full", "items-center", "justify-center", "font-semibold", "leading-none"]) {
      expect(inner![1]!.split(" "), c).toContain(c);
    }
    // Full token only (text-contrast guard bans text-muted-foreground/NN).
    expect(inner![1]!.split(" ")).toContain("text-muted-foreground");
    expect(html).not.toMatch(/text-muted-foreground\//);
    // The caller's font-size classes reach the letter by inheritance, not by a new prop.
    expect(html).not.toMatch(/\btext-(?:xs|sm|base|lg|xl|\dxl)\b/);
  });

  it("square kind forwards a caller font size on the outer span only (inherited by the letter)", () => {
    const cls = `${SQUARE_CLASS} text-2xl sm:text-3xl`;
    const html = renderToStaticMarkup(
      <SourceLogoFallback kind="square" name="KRT TV" className={cls} />,
    );
    expect(html).toBe(squareTile("K", cls));
  });

  it.each([
    "Gazete.net",
    "KRT TV",
    "  ntv",
    "istanbul",
    "ılık",
    "A",
    "1 Haber",
    "😀 Haber",
    "Çarşı",
    "\u00a0Habertürk",
  ])("regression: the square fallback for %j is never an empty tile", (name) => {
    const html = renderToStaticMarkup(
      <SourceLogoFallback kind="square" name={name} className={SQUARE_CLASS} />,
    );
    // Text nodes only: the runs between a tag's `>` and the next `<`.
    const text = (html.match(/>[^<]+</g) ?? []).map((run) => run.slice(1, -1)).join("");
    expect(text.length).toBeGreaterThan(0);
    expect(html).not.toMatch(/<span[^>]*><\/span>/);
    // Exactly one visible glyph (one code point; ß-style expansions are not in this list).
    expect(Array.from(text)).toHaveLength(1);
  });

  it("a name with no characters still renders the tile (empty letter), as it does today", () => {
    for (const name of ["", "   "]) {
      const html = renderToStaticMarkup(
        <SourceLogoFallback kind="square" name={name} className={SQUARE_CLASS} />,
      );
      expect(html).toBe(squareTile(""));
    }
  });

  it("initials kind output is unchanged (byte-identical to the pre-monogram markup)", () => {
    const html = renderToStaticMarkup(
      <SourceLogoFallback kind="initials" name="Sözcü" className={INITIALS_CLASS} />,
    );
    expect(html).toBe(`<span aria-hidden="true" class="${INITIALS_CLASS}">SÖ</span>`);
  });
});

describe("SourceLogo — a failed Google S2 logo still shows the S2 URL through the optimizer first", () => {
  it.each([
    "https://www.google.com/s2/favicons?domain=gazete.net&sz=64",
    "https://www.google.com/s2/favicons?domain=krttv.com.tr&sz=64",
  ])("%s is routed through /_next/image and the image is not replaced up front", (url) => {
    const html = renderToStaticMarkup(
      <SourceLogo
        logoUrl={url}
        name="Gazete.net"
        className={IMG_CLASS}
        fallback="square"
        fallbackClassName={SQUARE_CLASS}
      />,
    );
    expect(html).toContain(S2_PROXY_PREFIX);
    expect(html).toContain("<img");
    expect(html).not.toContain(">G<");
  });
});

describe("sourceMonogram", () => {
  it.each([
    ["Gazete.net", "G"],
    ["KRT TV", "K"],
    ["  ntv", "N"],
    ["istanbul", "İ"], // Turkish dotted capital I
    ["ılık", "I"], // dotless ı -> plain I
    ["Çarşı", "Ç"],
    ["", ""],
  ])("%j -> %j", (name, expected) => {
    expect(sourceMonogram(name)).toBe(expected);
  });

  it("is the first code point, never half of a surrogate pair", () => {
    const out = sourceMonogram("😀 Haber");
    expect(out).toBe("😀");
    expect(Array.from(out)).toHaveLength(1);
  });

  it("returns '' for whitespace-only input", () => {
    expect(sourceMonogram("   ")).toBe("");
    expect(sourceMonogram("\t\n")).toBe("");
  });

  it("is pure: same input, same output", () => {
    expect(sourceMonogram("Habertürk")).toBe(sourceMonogram("Habertürk"));
  });
});

describe("sourceInitials", () => {
  it("takes the first two characters, upper-cased (same as the old cluster-card inline)", () => {
    expect(sourceInitials("ntv")).toBe("NT");
    expect(sourceInitials("Sözcü")).toBe("SÖ");
    expect(sourceInitials("A")).toBe("A");
    expect(sourceInitials("")).toBe("");
  });

  it("does not apply locale-specific casing (matches String#toUpperCase)", () => {
    expect(sourceInitials("ıi")).toBe("ıi".slice(0, 2).toUpperCase());
  });
});

describe("isBrokenImage", () => {
  it("true: finished loading with zero natural width and a requested src", () => {
    expect(isBrokenImage({ complete: true, naturalWidth: 0, currentSrc: "x" })).toBe(true);
  });

  it("false: complete + zero width but never requested (lazy, currentSrc empty)", () => {
    expect(isBrokenImage({ complete: true, naturalWidth: 0, currentSrc: "" })).toBe(false);
  });

  it("false: still loading", () => {
    expect(isBrokenImage({ complete: false, naturalWidth: 0, currentSrc: "x" })).toBe(false);
  });

  it("false: loaded fine", () => {
    expect(isBrokenImage({ complete: true, naturalWidth: 64, currentSrc: "x" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source guards. The hydration-time check and the lint rule that forbids
// setState-in-effect cannot be observed from a node render, so pin the shape.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

describe("source-logo.tsx — source guard", () => {
  const src = read("src/components/source/source-logo.tsx");

  it("is a client component", () => {
    expect(src.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("wires an onError handler on the <img>", () => {
    expect(src).toContain("onError=");
  });

  it("checks for an already-failed (pre-hydration) image from a useCallback ref callback", () => {
    expect(src).toMatch(/useCallback\(/);
    expect(src).toMatch(/ref=\{/);
    // The ref callback body must call isBrokenImage.
    const refCallback = src.match(
      /useCallback\(\s*\(\s*img[^)]*\)\s*=>\s*\{[^]*?\},\s*\[\s*\]\s*\)/,
    );
    expect(refCallback).not.toBeNull();
    expect(refCallback![0]).toContain("isBrokenImage(");
  });

  it("`width` has no default of its own: the request width derives from `size`", () => {
    expect(src).not.toMatch(/\bwidth\s*=\s*64\b/);
    expect(src).toMatch(/width \?\? \(size !== undefined && size <= 16 \? 32 : 64\)/);
  });

  it("has no useEffect at all (react-hooks/set-state-in-effect is enforced)", () => {
    expect(src).not.toMatch(/useEffect/);
    expect(src).not.toMatch(/useLayoutEffect/);
  });

  it("the monogram is hydration-safe: no Date.now, Math.random or locale-less casing", () => {
    expect(src).not.toMatch(/Date\.now|Math\.random/);
    expect(src).toContain("toLocaleUpperCase(\"tr-TR\")");
  });

  it("uses only the full text-muted-foreground token (no /NN opacity form)", () => {
    expect(src).not.toMatch(/text-muted-foreground\/\d/);
  });
});

describe("the two 'square' call sites", () => {
  it.each(["src/app/sources/page.tsx", "src/app/source/[slug]/page.tsx"])(
    "%s passes fallback=\"square\"",
    (rel) => {
      expect(read(rel)).toContain('fallback="square"');
    },
  );

  it("the /source/[slug] hero tile sizes its letter via the fallback class (text-2xl sm:text-3xl)", () => {
    const src = read("src/app/source/[slug]/page.tsx");
    const m = src.match(/fallbackClassName="([^"]*)"/);
    expect(m).not.toBeNull();
    const tokens = m![1]!.split(/\s+/);
    expect(tokens).toContain("text-2xl");
    expect(tokens).toContain("sm:text-3xl");
    // The tile keeps the same box as the <img> so nothing shifts.
    expect(tokens).toEqual(expect.arrayContaining(["h-16", "w-16", "sm:h-20", "sm:w-20"]));
  });
});

describe("call sites render logos through SourceLogo", () => {
  const SITES = [
    "src/app/sources/page.tsx",
    "src/app/source/[slug]/page.tsx",
    "src/components/story/cluster-card.tsx",
    "src/components/story/framing-comparison.tsx",
  ];

  it.each(SITES)("%s uses <SourceLogo and no longer calls firstPartyLogoUrl", (rel) => {
    const src = read(rel);
    expect(src).toContain("<SourceLogo");
    expect(src).not.toContain("firstPartyLogoUrl(");
    // noUnusedLocals is on: the now-dead import must be removed too.
    expect(src).not.toContain("firstPartyLogoUrl");
  });

  it.each(SITES)("%s imports SourceLogo from the source-logo module", (rel) => {
    expect(read(rel)).toMatch(
      /import \{ SourceLogo \} from "@\/components\/source\/source-logo";/,
    );
  });

  it("cluster-card.tsx stays a Server Component (SourceLogo is the only client island)", () => {
    const src = read("src/components/story/cluster-card.tsx");
    expect(src.trimStart().startsWith('"use client"')).toBe(false);
  });

  it("no call site keeps a raw logo <img> eslint-disable (the only remaining <img> is the article image)", () => {
    for (const rel of [
      "src/app/sources/page.tsx",
      "src/components/story/cluster-card.tsx",
      "src/components/story/framing-comparison.tsx",
    ]) {
      expect(read(rel)).not.toMatch(/<img\b/);
    }
  });
});
