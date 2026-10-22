import { describe, expect, it } from "vitest";

import {
  firstPartyLogoUrl,
  isOptimizableImageUrl,
  normalizeImageUrl,
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
