import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SourceLogo,
  SourceLogoFallback,
  isBrokenImage,
  sourceInitials,
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

  it("square fallback renders no <img> and an empty aria-hidden element with the fallback class", () => {
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
    expect(html).toBe(`<span aria-hidden="true" class="${SQUARE_CLASS}"></span>`);
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

  it("square kind matches the no-logo square markup and carries no text", () => {
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
    expect(fromFallback).toBe(`<span aria-hidden="true" class="${SQUARE_CLASS}"></span>`);
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

  it("has no useEffect at all (react-hooks/set-state-in-effect is enforced)", () => {
    expect(src).not.toMatch(/useEffect/);
    expect(src).not.toMatch(/useLayoutEffect/);
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
