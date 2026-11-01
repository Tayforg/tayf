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
import { isAllowedRemoteImageUrl } from "./remote-image-hosts";

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

  // hurriyet: rows already stored as `file://image.hurimg.com/...` heal at
  // render time through this re-export -- no backfill.
  it("heals a stored hurriyet file:// URL to https, and keeps rejecting a local path", () => {
    expect(
      normalizeImageUrl(
        "file://image.hurimg.com/i/hurriyet/75/620x350/6ad8d7b322393fcfc7d3c38b.jpg",
      ),
    ).toBe("https://image.hurimg.com/i/hurriyet/75/620x350/6ad8d7b322393fcfc7d3c38b.jpg");
    expect(normalizeImageUrl("file:///etc/x.jpg")).toBeNull();
    expect(normalizeImageUrl("file://localhost/x.jpg")).toBeNull();
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

  it("only ever routes a URL the image allowlist accepts (api-1: the S2 path is listed explicitly)", () => {
    for (const u of [S2, "https://google.com/s2/favicons?domain=a.com"]) {
      const routed = firstPartyLogoUrl(u);
      expect(routed?.startsWith("/_next/image?url=")).toBe(true);
      expect(isAllowedRemoteImageUrl(u)).toBe(true);
    }
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

  // The file:// healing must not change any existing verdict.
  it("is unchanged for non-file input and for a file:// URL that cannot be healed", () => {
    expect(isPlaceholderImageUrl("file:///etc/x.jpg")).toBe(false);
    expect(isPlaceholderImageUrl("file://localhost/son-dakika.jpg")).toBe(false);
    expect(isPlaceholderImageUrl("https://img.piri.net/img/son-dakika.jpg")).toBe(true);
    expect(isPlaceholderImageUrl("ftp://img.piri.net/img/son-dakika.jpg")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// perf-2: /source/<slug> thumbnails go through /_next/image at the slot size
// (80 px slot, 1x/2x/3x = 128 / 160 / 256 in next.config imageSizes) instead of
// shipping the publisher's full-size original to the browser.
// ---------------------------------------------------------------------------

describe("optimizedThumbUrl", () => {
  // A host on the generated /_next/image allowlist (api-1).
  const SRC = "https://img.piri.net/a.jpg";
  const ENC = "https%3A%2F%2Fimg.piri.net%2Fa.jpg";

  it.each([128, 160, 256])("returns the next/image optimizer key for w=%i", (w) => {
    expect(optimizedThumbUrl(SRC, w)).toBe(`/_next/image?url=${ENC}&w=${w}&q=75`);
  });

  it("normalises first: a protocol-relative URL with a doubled slash is healed", () => {
    expect(optimizedThumbUrl("//img.piri.net//a.jpg", 128)).toBe(
      `/_next/image?url=${ENC}&w=128&q=75`,
    );
  });

  // hurriyet: a stored `file://image.hurimg.com/...` heals to https and then
  // goes through the same allowlist as any other URL.
  it("renders a healed file:// URL on an allowlisted host (image.hurimg.com)", () => {
    const healed = "https://image.hurimg.com/i/hurriyet/75/620x350/6ad8d7b322393fcfc7d3c38b.jpg";
    expect(
      optimizedThumbUrl(
        "file://image.hurimg.com/i/hurriyet/75/620x350/6ad8d7b322393fcfc7d3c38b.jpg",
        128,
      ),
    ).toBe(`/_next/image?url=${encodeURIComponent(healed)}&w=128&q=75`);
  });

  it("still gates a file:// URL on the allowlist: healing is not a licence to render any host", () => {
    expect(normalizeImageUrl("file://evil.example/a.jpg")).toBe("https://evil.example/a.jpg");
    expect(optimizedThumbUrl("file://evil.example/a.jpg", 128)).toBeNull();
    expect(optimizedThumbUrl("file:///etc/x.jpg", 128)).toBeNull();
    expect(optimizedThumbUrl("file://localhost/x.jpg", 128)).toBeNull();
  });

  it("encodes a query string into the url parameter", () => {
    expect(optimizedThumbUrl("https://img.piri.net/a.jpg?w=1&h=2", 160)).toBe(
      "/_next/image?url=https%3A%2F%2Fimg.piri.net%2Fa.jpg%3Fw%3D1%26h%3D2&w=160&q=75",
    );
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["the empty string", ""],
    ["a relative path", "/rel.jpg"],
    ["a data: URI", "data:image/png;base64,AAAA"],
    ["a .gif", "https://img.piri.net/a.gif"],
    ["a 'son dakika' placeholder", "https://img.piri.net/img/son-dakika.jpg"],
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

  // api-1: the optimizer answers 400 for a host that is not on the allowlist,
  // so a thumbnail from one must fall back to the neutral block, not a broken
  // /_next/image request.
  it.each([
    ["an unlisted https host", "https://cdn.x/a.jpg"],
    ["an attacker host", "https://evil.example/a.jpg"],
    ["a listed host plus a suffix", "https://img.piri.net.evil.tld/a.jpg"],
    ["a listed host on an explicit port", "https://img.piri.net:8443/a.jpg"],
    ["a protocol-relative URL on an unlisted host", "//cdn.x/a.jpg"],
    ["plain http on a listed host", "http://img.piri.net/a.jpg"],
    ["the gstatic favicon target", "https://www.gstatic.com/images/branding/product/1x/googleg_48dp.png"],
    ["a non-favicon google.com path", "https://www.google.com/images/x.png"],
  ])("returns null for %s", (_label, input) => {
    expect(optimizedThumbUrl(input, 128)).toBeNull();
  });
});

// hunt-15 / A-image-url-hygiene: the render path heals rows already stored with
// a bad URL, with no change here, because optimizedThumbUrl (and the card's
// candidate map, and the query layer's placeholder filter) all go through the
// shared normalizeImageUrl.
describe("render path heals stored hunt-15 image URLs (no backfill)", () => {
  const enc = (u: string) => encodeURIComponent(u);

  it("optimizedThumbUrl serves aksam's broken /imgsdisk2026/ spelling from the real path", () => {
    expect(optimizedThumbUrl("https://img3.aksam.com.tr/imgsdisk2026/11/01/x_2.jpg", 256)).toBe(
      `/_next/image?url=${enc("https://img3.aksam.com.tr/imgsdisk/2026/11/01/x_2.jpg")}&w=256&q=75`,
    );
  });

  it("optimizedThumbUrl serves an Oksijen 150x84 and a BBC ws/240 row at the large variant", () => {
    expect(optimizedThumbUrl("https://i.gazeteoksijen.com/2/150/84/storage/a.jpg", 160)).toBe(
      `/_next/image?url=${enc("https://i.gazeteoksijen.com/2/1280/720/storage/a.jpg")}&w=160&q=75`,
    );
    expect(optimizedThumbUrl("https://ichef.bbci.co.uk/ace/ws/240/cpsprodpb/a.jpg", 160)).toBe(
      `/_next/image?url=${enc("https://ichef.bbci.co.uk/ace/standard/976/cpsprodpb/a.jpg")}&w=160&q=75`,
    );
  });

  it("optimizedThumbUrl turns a stored YouTube embed into its allowlisted poster", () => {
    expect(optimizedThumbUrl("https://www.youtube.com/embed/2lKJof-8DeE", 128)).toBe(
      `/_next/image?url=${enc("https://img.youtube.com/vi/2lKJof-8DeE/hqdefault.jpg")}&w=128&q=75`,
    );
  });

  it("optimizedThumbUrl refuses a host root and a WordPress emoji (they are not images)", () => {
    expect(optimizedThumbUrl("https://cdn.istiklal.com.tr/", 128)).toBeNull();
    expect(optimizedThumbUrl("https://s.w.org/images/core/emoji/15.0.3/72x72/1f449.png", 128)).toBeNull();
  });

  it("optimizedThumbUrl refuses the new placeholder shapes", () => {
    for (const u of [
      "https://img3.aksam.com.tr/imgsdisk2026/01/01/210220191220255418101_2.jpg",
      "https://img3.aksam.com.tr/imgsdisk/2026/01/01/210220191220255418101_2.jpg",
      "https://sozcu01.sozcucdn.com/sozcu/production/uploads/images/2026/10/son-dakikajpg-fGomF2NHS0uGhDDwDPCbMQ.jpg",
      "https://img.yenicaggazetesi.com/rcman/Cw1280h720q95gc/storage/files/images/default.png",
    ]) {
      expect(optimizedThumbUrl(u, 128)).toBeNull();
    }
  });

  it("the re-exported isPlaceholderImageUrl sees both aksam spellings", () => {
    expect(isPlaceholderImageUrl("https://img3.aksam.com.tr/imgsdisk2026/01/01/210220191220255418101_2.jpg")).toBe(true);
    expect(isPlaceholderImageUrl("https://img3.aksam.com.tr/imgsdisk/2026/11/01/x_2.jpg")).toBe(false);
  });
});

describe("optimizedThumbSrcSet", () => {
  it("returns the 128 src and the 128w/160w/256w srcSet", () => {
    const enc = "https%3A%2F%2Fimg.piri.net%2Fa.jpg";
    expect(optimizedThumbSrcSet("https://img.piri.net/a.jpg")).toEqual({
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
    ["a .gif", "https://img.piri.net/a.gif"],
    ["a placeholder", "https://img.piri.net/son-dakika.jpg"],
    ["an unlisted host", "https://cdn.x/a.jpg"],
    ["plain http", "http://img.piri.net/a.jpg"],
  ])("returns null for %s", (_label, input) => {
    expect(optimizedThumbSrcSet(input)).toBeNull();
  });

  it("never contains a raw publisher URL", () => {
    const t = optimizedThumbSrcSet("https://img.piri.net/a.jpg");
    expect(t?.srcSet).not.toContain("https://img.piri.net");
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
