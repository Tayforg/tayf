import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  firstPartyLogoUrl,
  isOptimizableImageUrl,
  isPlaceholderImageUrl,
  normalizeImageUrl,
  OPTIMIZER_IMAGE_SIZES,
  optimizedThumbSrcSet,
  optimizedThumbUrl,
  THUMB_WIDTHS,
} from "./image-url";

// ---------------------------------------------------------------------------
// ingest-hygiene: render-side image helpers.
//
//  - normalizeImageUrl is the shared Deno/Next normaliser (re-exported, so
//    the card can heal existing rows that still carry `https://h//x.jpg` or
//    a protocol-relative `//cdn/x.jpg`).
//  - firstPartyLogoUrl routes Google S2 favicon URLs (the ~44 source logos on
//    the home page) through our own /_next/image so the browser never talks
//    to google.com and gets the already-sized, cached variant.
// ---------------------------------------------------------------------------

describe("normalizeImageUrl (re-export)", () => {
  it("is the shared implementation", () => {
    expect(normalizeImageUrl("https://i12.haber7.net//fotogaleri/x.jpg")).toBe(
      "https://i12.haber7.net/fotogaleri/x.jpg",
    );
    expect(normalizeImageUrl("//cdn.x/a.jpg")).toBe("https://cdn.x/a.jpg");
    expect(normalizeImageUrl("/rel.jpg")).toBeNull();
  });

  // posta-image-url: rows already stored as two glued ObjectIds
  // (`<id1>.jpg<id2>.jpg`, which 404s) heal at render time -- no backfill.
  it("heals a stored posta joined-ObjectId URL to its real (second) image", () => {
    expect(
      normalizeImageUrl(
        "https://image.posta.com.tr/i/posta/90/0x0/627e113be4bfdc26aca117f5.jpg6acfb319b65de53ef53b8d3c.jpg",
      ),
    ).toBe(
      "https://image.posta.com.tr/i/posta/90/0x0/6acfb319b65de53ef53b8d3c.jpg",
    );
  });

  it("leaves a clean posta URL untouched", () => {
    const clean =
      "https://image.posta.com.tr/i/posta/90/0x0/6acfb319b65de53ef53b8d3c.jpg";
    expect(normalizeImageUrl(clean)).toBe(clean);
  });
});

describe("isOptimizableImageUrl (re-export)", () => {
  it("is the shared implementation", () => {
    expect(isOptimizableImageUrl("https://h.test/a.jpg")).toBe(true);
    expect(isOptimizableImageUrl("https://i12.haber7.net/x/rlQtL_1579004365_7688.gif")).toBe(
      false,
    );
  });
});

describe("firstPartyLogoUrl", () => {
  const S2 = "https://www.google.com/s2/favicons?domain=ntv.com.tr&sz=64";

  it("routes a Google S2 favicon URL through /_next/image (default width 64)", () => {
    expect(firstPartyLogoUrl(S2)).toBe(
      `/_next/image?url=${encodeURIComponent(S2)}&w=64&q=75`,
    );
  });

  it("also routes the bare google.com host", () => {
    const u = "https://google.com/s2/favicons?domain=a.com";
    expect(firstPartyLogoUrl(u)).toBe(
      `/_next/image?url=${encodeURIComponent(u)}&w=64&q=75`,
    );
  });

  it("honours an allowed width (128)", () => {
    expect(firstPartyLogoUrl(S2, 128)).toBe(
      `/_next/image?url=${encodeURIComponent(S2)}&w=128&q=75`,
    );
  });

  it.each([32, 48, 64, 96, 128])("accepts configured imageSize %i", (w) => {
    expect(firstPartyLogoUrl(S2, w)).toContain(`&w=${w}&q=75`);
  });

  it("falls back to w=64 for a width that is not in next.config imageSizes", () => {
    expect(firstPartyLogoUrl(S2, 77)).toContain("&w=64&q=75");
  });

  it("leaves a look-alike host untouched", () => {
    const evil = "https://google.com.evil.tld/s2/favicons?domain=a.com";
    expect(firstPartyLogoUrl(evil)).toBe(evil);
    const evil2 = "https://notgoogle.com/s2/favicons";
    expect(firstPartyLogoUrl(evil2)).toBe(evil2);
  });

  it("leaves a google.com URL on a different path untouched", () => {
    const u = "https://www.google.com/s2/favicons/extra";
    expect(firstPartyLogoUrl(u)).toBe(u);
    const search = "https://www.google.com/search?q=x";
    expect(firstPartyLogoUrl(search)).toBe(search);
  });

  it("leaves a non-google logo untouched", () => {
    const u = "https://cdn.example.com/logos/ntv.png";
    expect(firstPartyLogoUrl(u)).toBe(u);
  });

  it("returns an unparseable string as is", () => {
    expect(firstPartyLogoUrl("not a url")).toBe("not a url");
    expect(firstPartyLogoUrl("/logos/local.png")).toBe("/logos/local.png");
  });

  it("returns null for null, undefined and empty input", () => {
    expect(firstPartyLogoUrl(null)).toBeNull();
    expect(firstPartyLogoUrl(undefined)).toBeNull();
    expect(firstPartyLogoUrl("")).toBeNull();
  });
});

describe("isPlaceholderImageUrl (re-export)", () => {
  it("is the shared implementation", () => {
    expect(
      isPlaceholderImageUrl(
        "https://image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg",
      ),
    ).toBe(true);
    expect(isPlaceholderImageUrl("https://h.test/a.jpg")).toBe(false);
    expect(isPlaceholderImageUrl(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// perf-2: /source/<slug> thumbnails go through /_next/image at the slot size
// (80 px slot, 1x/2x/3x = 128 / 160 / 256 in next.config imageSizes) instead of
// shipping the publisher's full-size original to the browser.
// ---------------------------------------------------------------------------

describe("optimizedThumbUrl", () => {
  const SRC = "https://cdn.x/a.jpg";
  const ENC = "https%3A%2F%2Fcdn.x%2Fa.jpg";

  it.each([128, 160, 256])("returns the next/image optimizer key for w=%i", (w) => {
    expect(optimizedThumbUrl(SRC, w)).toBe(`/_next/image?url=${ENC}&w=${w}&q=75`);
  });

  it("normalises first: a protocol-relative URL with a doubled slash is healed", () => {
    expect(optimizedThumbUrl("//cdn.x//a.jpg", 128)).toBe(
      `/_next/image?url=${ENC}&w=128&q=75`,
    );
  });

  it("encodes a query string into the url parameter", () => {
    expect(optimizedThumbUrl("https://cdn.x/a.jpg?w=1&h=2", 160)).toBe(
      "/_next/image?url=https%3A%2F%2Fcdn.x%2Fa.jpg%3Fw%3D1%26h%3D2&w=160&q=75",
    );
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["the empty string", ""],
    ["a relative path", "/rel.jpg"],
    ["a data: URI", "data:image/png;base64,AAAA"],
    ["a .gif", "https://cdn.x/a.gif"],
    ["a 'son dakika' placeholder", "https://cdn.x/img/son-dakika.jpg"],
    [
      "a publisher logo card",
      "https://image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg",
    ],
  ])("returns null for %s", (_label, input) => {
    expect(optimizedThumbUrl(input, 128)).toBeNull();
  });

  it.each([0, 80, 100, 127, 129, 512, -128, Number.NaN])(
    "returns null for width %s (not in images.imageSizes)",
    (w) => {
      expect(optimizedThumbUrl(SRC, w)).toBeNull();
    },
  );
});

describe("optimizedThumbSrcSet", () => {
  it("returns the 128 src and the 128w/160w/256w srcSet", () => {
    const enc = "https%3A%2F%2Fcdn.x%2Fa.jpg";
    expect(optimizedThumbSrcSet("https://cdn.x/a.jpg")).toEqual({
      src: `/_next/image?url=${enc}&w=128&q=75`,
      srcSet:
        `/_next/image?url=${enc}&w=128&q=75 128w, ` +
        `/_next/image?url=${enc}&w=160&q=75 160w, ` +
        `/_next/image?url=${enc}&w=256&q=75 256w`,
    });
  });

  it.each([
    ["null", null],
    ["a relative path", "/rel.jpg"],
    ["a .gif", "https://cdn.x/a.gif"],
    ["a placeholder", "https://cdn.x/son-dakika.jpg"],
  ])("returns null for %s", (_label, input) => {
    expect(optimizedThumbSrcSet(input)).toBeNull();
  });

  it("never contains a raw publisher URL", () => {
    const t = optimizedThumbSrcSet("https://cdn.x/a.jpg");
    expect(t?.srcSet).not.toContain("https://cdn.x");
    expect(t?.src.startsWith("/_next/image?url=")).toBe(true);
  });
});

describe("optimizer widths parity with next.config.ts", () => {
  const config = readFileSync(resolve(__dirname, "../../../next.config.ts"), "utf8");
  const list = (key: string): number[] => {
    const m = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(config);
    expect(m, `next.config.ts has no ${key}: [...]`).not.toBeNull();
    return (m?.[1] ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map(Number);
  };

  it("OPTIMIZER_IMAGE_SIZES equals images.imageSizes", () => {
    expect([...OPTIMIZER_IMAGE_SIZES]).toEqual(list("imageSizes"));
  });

  it("images.qualities contains the q=75 the helpers emit", () => {
    expect(list("qualities")).toContain(75);
  });

  it("every THUMB_WIDTHS entry is an allowed optimizer width", () => {
    for (const w of THUMB_WIDTHS) {
      expect(OPTIMIZER_IMAGE_SIZES as readonly number[]).toContain(w);
    }
  });
});
