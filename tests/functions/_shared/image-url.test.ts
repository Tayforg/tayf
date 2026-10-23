import { describe, expect, it } from "vitest";

import {
  isOptimizableImageUrl,
  isPlaceholderImageUrl,
  normalizeImageUrl,
  PLACEHOLDER_IMAGE_ASSETS,
  repairJoinedImageSegment,
} from "../../../supabase/functions/_shared/image-url.ts";

// ---------------------------------------------------------------------------
// ingest-hygiene: one shared normaliser for image URLs. haber7 (and a few
// other CDNs) ship URLs like `https://i12.haber7.net//fotogaleri/x.jpg` whose
// doubled leading slash 404s behind the Next optimizer; protocol-relative
// `//cdn/...` values are unusable as-is. The same function runs at ingest
// (Deno) and at render (Next), so existing rows heal without a backfill.
// ---------------------------------------------------------------------------

describe("normalizeImageUrl", () => {
  it("collapses a doubled leading path slash", () => {
    expect(normalizeImageUrl("https://i12.haber7.net//fotogaleri/x.jpg")).toBe(
      "https://i12.haber7.net/fotogaleri/x.jpg",
    );
  });

  it("collapses a longer leading run of slashes", () => {
    expect(normalizeImageUrl("https://h.test///a")).toBe("https://h.test/a");
  });

  it("keeps a mid-path '//' byte-for-byte", () => {
    const u = "https://i20.haber7.net/resize/1280x720//haber/x.jpg";
    expect(normalizeImageUrl(u)).toBe(u);
  });

  it("preserves the query string and hash while collapsing the leading run", () => {
    expect(normalizeImageUrl("https://h//a.jpg?x=1#y")).toBe(
      "https://h/a.jpg?x=1#y",
    );
  });

  it("preserves '//' inside the query string", () => {
    expect(normalizeImageUrl("https://h//a.jpg?u=https://o//z.jpg")).toBe(
      "https://h/a.jpg?u=https://o//z.jpg",
    );
  });

  it("works for http: URLs", () => {
    expect(normalizeImageUrl("http://h.test//a.jpg")).toBe("http://h.test/a.jpg");
  });

  it("upgrades a protocol-relative URL to https", () => {
    expect(normalizeImageUrl("//cdn.x/a.jpg")).toBe("https://cdn.x/a.jpg");
  });

  it("collapses the leading run of a protocol-relative URL too", () => {
    expect(normalizeImageUrl("//cdn.x//a.jpg")).toBe("https://cdn.x/a.jpg");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeImageUrl("  https://h.test/a.jpg \n")).toBe(
      "https://h.test/a.jpg",
    );
  });

  it("returns an already-clean URL identical (no re-serialisation)", () => {
    // `new URL(...).toString()` would add a trailing slash / lowercase the
    // host / encode characters; the helper must hand back the input as-is.
    const u = "https://CDN.Test/a b/İ.jpg?Q=1";
    expect(normalizeImageUrl(u)).toBe(u);
    const bare = "https://cdn.test";
    expect(normalizeImageUrl(bare)).toBe(bare);
  });

  it.each([
    ["data: URI", "data:image/png;base64,AAAA"],
    ["ftp: URL", "ftp://h.test/a.jpg"],
    ["root-relative path", "/rel.jpg"],
    ["plain word", "nope"],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["javascript: URL", "javascript:alert(1)"],
  ])("returns null for %s", (_label, input) => {
    expect(normalizeImageUrl(input)).toBeNull();
  });

  it("returns null for null and undefined", () => {
    expect(normalizeImageUrl(null)).toBeNull();
    expect(normalizeImageUrl(undefined)).toBeNull();
  });

  it("returns null for a bare '//' (no host)", () => {
    expect(normalizeImageUrl("//")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gif-filter (http-1): haber7 and elips-haber ship a 22.3 MB animated
// placeholder GIF that /_next/image passes through UNMODIFIED (the optimizer
// never re-encodes animated GIFs), so the filter has to live at the query
// boundary, ingest, and the card -- never at the CDN.
// ---------------------------------------------------------------------------

describe("isOptimizableImageUrl", () => {
  it.each([
    ["a .gif", "https://i12.haber7.net/x/rlQtL_1579004365_7688.gif"],
    ["an upper-case .GIF", "https://i12.haber7.net/x/rlQtL_1579004365_7688.GIF"],
    ["a .gif with a query string", "https://h/a.gif?x=1"],
    ["a .gif with a fragment", "https://h/a.gif#a"],
    ["a protocol-relative .gif", "//cdn.x/a.gif"],
    ["a .gif padded with whitespace", "  https://h/a.gif \n"],
  ])("is false for %s", (_label, input) => {
    expect(isOptimizableImageUrl(input)).toBe(false);
  });

  it("is false for null, undefined and the empty string", () => {
    expect(isOptimizableImageUrl(null)).toBe(false);
    expect(isOptimizableImageUrl(undefined)).toBe(false);
    expect(isOptimizableImageUrl("")).toBe(false);
  });

  it("is false for a whitespace-only string and for non-string input", () => {
    expect(isOptimizableImageUrl("   ")).toBe(false);
    expect(isOptimizableImageUrl(42 as unknown as string)).toBe(false);
    expect(isOptimizableImageUrl({} as unknown as string)).toBe(false);
  });

  it.each([
    ["a .jpg", "https://h/a.jpg"],
    ["a .webp", "https://h/a.webp"],
    ["a .png with a query", "https://h/a.png?w=100"],
    ["an extensionless URL whose query merely mentions gif", "https://h/img?format=gif"],
    ["a .gifv path (not a .gif)", "https://h/a.gifv"],
    ["a path that contains 'gif' mid-name", "https://h/gift/a.jpg"],
  ])("is true for %s", (_label, input) => {
    expect(isOptimizableImageUrl(input)).toBe(true);
  });

  it("does not re-normalise: a doubled leading slash does not change the verdict", () => {
    expect(isOptimizableImageUrl("https://h//a.jpg")).toBe(true);
    expect(isOptimizableImageUrl("https://h//a.gif")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// posta-image-url (2026-10-22): 1,202 of 1,204 posta rows in the trailing
// 7 days (the other 2 carry no image_url match at all) store an image URL
// that 404s:
//
//   https://image.posta.com.tr/i/posta/90/0x0/627e113be4bfdc26aca117f5.jpg6acfb319b65de53ef53b8d3c.jpg
//
// That is TWO Mongo ObjectIds glued together as `<id1>.<ext1><id2>.<ext2>`
// in the LAST path segment.
//
// Step 0 investigation findings (read-only, 2026-10-22):
//
//   * DB: sources.slug='posta', rss_url https://www.posta.com.tr/rss/anasayfa.xml.
//     The first id is a CONSTANT: `627e113be4bfdc26aca117f5` leads 1,202 of the
//     1,204 rows (as an ObjectId it decodes to 2022-05-13 -- a default /
//     placeholder asset). The second id varies per article and decodes to the
//     publication time (e.g. 6acfb319... = 2026-10-14).
//   * Feed (one GET, 50 items, 49 with the joined shape, all `.jpg.jpg`):
//     there is NO <enclosure>, <media:*> or <image> element. The picture is
//     the first `<img src="...">` inside the CDATA <description>, and the
//     joined string is LITERALLY in the publisher's XML. So it is not our XML
//     parser concatenating two nodes: the defect is upstream, and every
//     extractor already funnels through normalizeImageUrl (decision A).
//   * HEAD (6 URLs, two live feed items):
//       joined                      -> 404, content-length 0
//       .../0x0/<id1>.jpg           -> 200 image/jpeg, 1,650 bytes (the same
//                                       placeholder for every article)
//       .../0x0/<id2>.jpg           -> 200 image/jpeg, 63,109 and 75,160 bytes
//     so the SECOND id is the real article image and is what the repair keeps.
// ---------------------------------------------------------------------------

describe("repairJoinedImageSegment / normalizeImageUrl: posta joined ObjectId segment", () => {
  const BASE = "https://image.posta.com.tr/i/posta/90/0x0/";
  const H1 = "627e113be4bfdc26aca117f5"; // constant placeholder id
  const H2 = "6acfb319b65de53ef53b8d3c"; // per-article id
  const JOINED = `${BASE}${H1}.jpg${H2}.jpg`;
  const HEALED = `${BASE}${H2}.jpg`;

  it("heals the real posta sample to its second (real) image", () => {
    expect(normalizeImageUrl(JOINED)).toBe(HEALED);
    expect(normalizeImageUrl(JOINED)).toBe(
      "https://image.posta.com.tr/i/posta/90/0x0/6acfb319b65de53ef53b8d3c.jpg",
    );
  });

  it.each([
    // Live feed items, HEAD-verified 2026-10-22: joined 404, healed 200 image/jpeg.
    ["6ad93ca7b65de53ef53ba8ca"],
    ["6ad936d2b65de53ef53ba8c1"],
  ])("heals the live feed pair ending in %s", (id) => {
    expect(normalizeImageUrl(`${BASE}${H1}.jpg${id}.jpg`)).toBe(`${BASE}${id}.jpg`);
  });

  it("heals through the pure helper too", () => {
    expect(repairJoinedImageSegment(JOINED)).toBe(HEALED);
  });

  it("matches upper-case hex and an upper-case extension and keeps the second half byte for byte", () => {
    const u = `${BASE}${H1.toUpperCase()}.JPG${H2.toUpperCase()}.JPG`;
    expect(normalizeImageUrl(u)).toBe(`${BASE}${H2.toUpperCase()}.JPG`);
  });

  it.each([
    ["png then webp", "png", "webp"],
    ["webp then png", "webp", "png"],
    ["jpeg then jpg", "jpeg", "jpg"],
    ["jpg then jpeg", "jpg", "jpeg"],
    ["png then png", "png", "png"],
  ])("handles mixed extensions (%s) and keeps the second extension", (_l, e1, e2) => {
    expect(normalizeImageUrl(`${BASE}${H1}.${e1}${H2}.${e2}`)).toBe(
      `${BASE}${H2}.${e2}`,
    );
  });

  it("preserves the query string and hash byte for byte", () => {
    expect(normalizeImageUrl(`${JOINED}?v=1#x`)).toBe(`${HEALED}?v=1#x`);
    expect(normalizeImageUrl(`${JOINED}?v=1`)).toBe(`${HEALED}?v=1`);
    expect(normalizeImageUrl(`${JOINED}#frag`)).toBe(`${HEALED}#frag`);
  });

  it("only rewrites the PATH: a joined-looking value inside the query or hash is left alone", () => {
    const inQuery = `https://h.test/a.jpg?u=/${H1}.jpg${H2}.jpg`;
    expect(normalizeImageUrl(inQuery)).toBe(inQuery);
    const inHash = `https://h.test/a.jpg#/${H1}.jpg${H2}.jpg`;
    expect(normalizeImageUrl(inHash)).toBe(inHash);
  });

  it("never rewrites the authority (host) of a URL", () => {
    const hostLike = `https://${H1}.jpg${H2}.jpg`;
    expect(normalizeImageUrl(hostLike)).toBe(hostLike);
  });

  it("heals a doubled leading slash AND a joined segment in one call", () => {
    expect(normalizeImageUrl(`https://image.posta.com.tr//i/posta/90/0x0/${H1}.jpg${H2}.jpg`)).toBe(
      HEALED,
    );
    expect(normalizeImageUrl(`https://h.test//${H1}.jpg${H2}.jpg?v=1`)).toBe(
      `https://h.test/${H2}.jpg?v=1`,
    );
  });

  it("heals a protocol-relative joined URL (https upgrade + repair)", () => {
    expect(normalizeImageUrl(`//image.posta.com.tr/i/posta/90/0x0/${H1}.jpg${H2}.jpg`)).toBe(
      HEALED,
    );
  });

  it("trims surrounding whitespace before repairing", () => {
    expect(normalizeImageUrl(`  ${JOINED} \n`)).toBe(HEALED);
  });

  it("keeps a mid-path '//' while healing the last segment", () => {
    expect(normalizeImageUrl(`https://h.test/a//${H1}.jpg${H2}.jpg`)).toBe(
      `https://h.test/a//${H2}.jpg`,
    );
  });

  it("is idempotent: f(f(x)) === f(x)", () => {
    const inputs = [
      JOINED,
      `${JOINED}?v=1#x`,
      `https://image.posta.com.tr//i/posta/90/0x0/${H1}.jpg${H2}.jpg`,
      `//image.posta.com.tr/i/posta/90/0x0/${H1}.png${H2}.webp`,
      `${BASE}${H1.toUpperCase()}.JPG${H2.toUpperCase()}.JPG`,
      HEALED,
      "https://cdn.test/a.jpg",
    ];
    for (const x of inputs) {
      const once = normalizeImageUrl(x);
      expect(normalizeImageUrl(once)).toBe(once);
    }
  });

  it("a healed value is no longer a joined shape", () => {
    expect(repairJoinedImageSegment(HEALED)).toBe(HEALED);
  });

  describe("negatives: returned identical (===)", () => {
    it.each([
      ["a single <24hex>.jpg", `${BASE}${H1}.jpg`],
      ["a single <24hex>.webp with a query", `${BASE}${H2}.webp?w=1`],
      ["a first half of 23 hex", `${BASE}${H1.slice(1)}.jpg${H2}.jpg`],
      ["a second half of 23 hex", `${BASE}${H1}.jpg${H2.slice(1)}.jpg`],
      ["a first half of 25 hex", `${BASE}${H1}a.jpg${H2}.jpg`],
      ["a second half of 25 hex", `${BASE}${H1}.jpg${H2}a.jpg`],
      ["a non-hex first name", `${BASE}${"g".repeat(24)}.jpg${H2}.jpg`],
      ["a non-hex second name", `${BASE}${H1}.jpg${"z".repeat(24)}.jpg`],
      ["a plain photo.jpg2.jpg", "https://cdn.test/photo.jpg2.jpg"],
      ["a prefixed first name (x<24hex>)", `${BASE}x${H1}.jpg${H2}.jpg`],
      ["a joined pattern that is NOT the last segment", `${BASE}${H1}.jpg${H2}.jpg/extra.jpg`],
      ["a .gif second extension", `${BASE}${H1}.jpg${H2}.gif`],
      ["a .gif first extension", `${BASE}${H1}.gif${H2}.jpg`],
      ["an unknown second extension", `${BASE}${H1}.jpg${H2}.bmp`],
      ["a trailing character after the second extension", `${BASE}${H1}.jpg${H2}.jpgx`],
      ["a separator between the halves", `${BASE}${H1}.jpg-${H2}.jpg`],
    ])("%s", (_label, input) => {
      expect(normalizeImageUrl(input)).toBe(input);
      expect(repairJoinedImageSegment(input)).toBe(input);
    });
  });

  it("still returns null for unusable input (repair never resurrects it)", () => {
    expect(normalizeImageUrl(`/${H1}.jpg${H2}.jpg`)).toBeNull();
    expect(normalizeImageUrl(`ftp://h.test/${H1}.jpg${H2}.jpg`)).toBeNull();
    expect(normalizeImageUrl(null)).toBeNull();
  });

  it("does not change the animated-GIF verdict for a healed URL", () => {
    expect(isOptimizableImageUrl(JOINED)).toBe(true);
    expect(isOptimizableImageUrl(HEALED)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// db-4 / perf-2: publisher logo cards and 'son dakika' placeholders are
// reused across dozens of unrelated stories (read-only prod sample, trailing
// 48 h: one image_url spread over 10-174 distinct titles at ten sources).
// They must never become a hero, a card thumb or a /source thumb. Render-only
// for now: nothing is rewritten in the database.
// ---------------------------------------------------------------------------

describe("isPlaceholderImageUrl (db-4)", () => {
  // The ten verified rows from the 2026-10-23 sample. The `via` column says
  // whether the denylist catches it by exact asset or by basename pattern.
  const VERIFIED: ReadonlyArray<readonly [string, string, string]> = [
    [
      "cnn-turk",
      "https://image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg",
      "asset",
    ],
    [
      "yeni-safak",
      "https://img.piri.net/resim/imagecrop/2026/04/01/09/50/tr_son_dakika_530x530.jpg",
      "pattern",
    ],
    [
      "aksam",
      "https://img3.aksam.com.tr/imgsdisk2026/01/01/210220191220255418101_2.jpg",
      "asset",
    ],
    ["diken", "https://www.diken.com.tr/wp-content/uploads/2021/10/gunun_11.jpg", "asset"],
    [
      "star",
      "https://imgs.star.com.tr/imgsdisk/2026/10/02/1138373167528_2-15012019114103500.jpg",
      "asset",
    ],
    [
      "isci-haber",
      "https://www.iscihaber.net/cropImages/1280x720/uploads/haberler/default_news_photo.jpg",
      "pattern",
    ],
    [
      "gzt",
      "https://img.piri.net/resim/imagecrop/2018/04/20/06/49/resized_9641d-8b15395cgztsondakika.jpg",
      "asset",
    ],
    [
      "haber-global",
      "https://i.haberglobal.com/storage/files/images/2021/09/23/haberglobal-sondakika-1jxM.png",
      "asset",
    ],
    [
      "a-haber",
      "https://iaahbr.tmgrup.com.tr/c18248/1200/675/0/0/1200/675?u=https://iahbr.tmgrup.com.tr/Defaults/Upload/ahbr-default-1754911102530.png",
      "asset",
    ],
    ["haberler-com", "https://foto.haberler.com/haber/2026/07/03/son-dakika_o.jpg", "pattern"],
  ];

  it("covers all ten verified sources", () => {
    expect(new Set(VERIFIED.map(([slug]) => slug)).size).toBe(10);
  });

  it.each(VERIFIED.map(([slug, url, via]) => [slug, via, url] as const))(
    "is true for the %s placeholder (%s)",
    (_slug, _via, url) => {
      expect(isPlaceholderImageUrl(url)).toBe(true);
    },
  );

  it("the asset set is a ReadonlySet keyed by lower-case host + path", () => {
    expect(PLACEHOLDER_IMAGE_ASSETS.has("image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg")).toBe(true);
    for (const key of PLACEHOLDER_IMAGE_ASSETS) {
      expect(key).not.toMatch(/^[a-z]+:/);
      expect(key).not.toMatch(/[?#]/);
      expect(key.split("/")[0]).toBe(key.split("/")[0]?.toLowerCase());
    }
  });

  describe("exact asset: spelling variants", () => {
    const CNN = "image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg";
    it.each([
      ["a cache-busting query", `https://${CNN}?v=2`],
      ["a fragment", `https://${CNN}#x`],
      ["a protocol-relative form", `//${CNN}`],
      ["a doubled leading slash", "https://image.cnnturk.com//i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg"],
      ["an upper-case host", "https://IMAGE.CnnTurk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg"],
      ["http instead of https", `http://${CNN}`],
      ["surrounding whitespace", `  https://${CNN} `],
    ])("is true with %s", (_label, url) => {
      expect(isPlaceholderImageUrl(url)).toBe(true);
    });
  });

  describe("resizer wrapper: the wrapped origin in `u` is checked too", () => {
    it("is true for another crop of the same a-haber default image", () => {
      expect(
        isPlaceholderImageUrl(
          "https://iaahbr.tmgrup.com.tr/ffffff/0/0/0/0/2048/1365?u=https://iahbr.tmgrup.com.tr/Defaults/Upload/ahbr-default-1754911102530.png",
        ),
      ).toBe(true);
    });

    it("is false for a real a-haber photo behind the same resizer", () => {
      expect(
        isPlaceholderImageUrl(
          "https://iaahbr.tmgrup.com.tr/c18248/1200/675/0/0/1200/675?u=https://iahbr.tmgrup.com.tr/albums/2026/10/22/a-real-photo.jpg",
        ),
      ).toBe(false);
    });

    it("is false when `u` is not an http(s) URL", () => {
      expect(isPlaceholderImageUrl("https://cdn.x/a.jpg?u=javascript:alert(1)")).toBe(false);
      expect(isPlaceholderImageUrl("https://cdn.x/a.jpg?u=")).toBe(false);
    });

    it("applies the basename pattern to the wrapped URL", () => {
      expect(isPlaceholderImageUrl("https://r.x/c1/1/1?u=https://o.x/img/son-dakika.jpg")).toBe(true);
    });
  });

  describe("basename pattern", () => {
    it.each([
      "https://cdn.x/img/son-dakika.jpg",
      "https://cdn.x/img/son_dakika.png",
      "https://cdn.x/img/sondakika.webp",
      "https://cdn.x/img/SON-DAKIKA.JPG",
      "https://cdn.x/img/son-dakika-haberleri.jpg",
      "https://cdn.x/img/son_dakika_default.jpg",
      "https://cdn.x/img/son-dakika-logo.png",
      "https://cdn.x/img/son-dakika-1.jpg",
      "https://cdn.x/img/son-dakika-1200x675.jpg",
      "https://cdn.x/img/tr-son-dakika.jpg",
      "https://cdn.x/img/tr_son_dakika_530x530.jpg",
      "https://cdn.x/img/son%2Ddakika.jpg",
      "https://cdn.x/img/default_news_photo.jpg",
      "https://cdn.x/img/default-news-photo-2.png",
      "https://cdn.x/img/Default_News_Photo.JPG?w=100",
    ])("is true for %s", (url) => {
      expect(isPlaceholderImageUrl(url)).toBe(true);
    });
  });

  describe("false cases", () => {
    it("is false for the same CDN host with another hex file", () => {
      expect(
        isPlaceholderImageUrl(
          "https://image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9e.jpg",
        ),
      ).toBe(false);
    });

    it("is false when only the host differs from a known asset", () => {
      expect(
        isPlaceholderImageUrl(
          "https://image.cnnturk.net/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg",
        ),
      ).toBe(false);
    });

    it.each([
      ["son-dakika in the middle of an article basename", "https://cdn.x/2026/10/erdogan-son-dakika-aciklama-18123456.jpg"],
      ["a slug that starts with son-dakika", "https://cdn.x/2026/10/son-dakika-erdogan-aciklama-18123456.jpg"],
      ["a slug that starts with son-dakika, no extension noise", "https://cdn.x/son-dakika-deprem-oldu.jpg"],
      ["default-news-photo as a prefix of a slug", "https://cdn.x/default-news-photo-of-the-minister.jpg"],
      ["a basename that merely ends with sondakika", "https://cdn.x/yeni-sondakika-gelisme.jpg"],
    ])("is false for %s", (_label, url) => {
      expect(isPlaceholderImageUrl(url)).toBe(false);
    });

    it("is false for a /son-dakika/ directory holding a normal file", () => {
      expect(isPlaceholderImageUrl("https://cdn.x/son-dakika/2026/10/22/foto-123.jpg")).toBe(false);
      expect(isPlaceholderImageUrl("https://cdn.x/son-dakika/default-news-photo/abc.jpg")).toBe(false);
    });

    it("is false for a trailing-slash path (no basename)", () => {
      expect(isPlaceholderImageUrl("https://cdn.x/son-dakika/")).toBe(false);
      expect(isPlaceholderImageUrl("https://cdn.x/")).toBe(false);
    });

    it("is false for a placeholder-named query value (path is what counts)", () => {
      expect(isPlaceholderImageUrl("https://cdn.x/a.jpg?name=son-dakika.jpg")).toBe(false);
    });

    it.each([
      ["null", null],
      ["undefined", undefined],
      ["the empty string", ""],
      ["whitespace", "   "],
      ["a non-URL string", "not a url"],
      ["a relative path", "/son-dakika.jpg"],
      ["a data: URI", "data:image/png;base64,AAAA"],
      ["an ftp: URL", "ftp://h.test/son-dakika.jpg"],
      ["a number", 42 as unknown as string],
      ["an object", {} as unknown as string],
    ])("is false for %s", (_label, input) => {
      expect(isPlaceholderImageUrl(input)).toBe(false);
    });

    it("does not throw on malformed percent-encoding and returns false", () => {
      for (const bad of [
        "https://cdn.x/%E0%A4%A.jpg",
        "https://cdn.x/%ZZ.jpg",
        "https://cdn.x/son-dakika%.jpg",
        "https://cdn.x/a.jpg?u=%E0%A4%A",
        "https://cdn.x/a.jpg?u=https://o.x/%E0%A4%A.jpg",
      ]) {
        expect(() => isPlaceholderImageUrl(bad)).not.toThrow();
        expect(isPlaceholderImageUrl(bad)).toBe(false);
      }
    });
  });

  it("is not a gif check: the gif verdict is independent", () => {
    expect(isOptimizableImageUrl("https://cdn.x/img/son-dakika.jpg")).toBe(true);
    expect(isPlaceholderImageUrl("https://cdn.x/img/photo.gif")).toBe(false);
  });

  it("stays linear on adversarial basenames (no catastrophic backtracking)", () => {
    const started = Date.now();
    for (const name of [
      `son-dakika${"-1".repeat(5000)}!`,
      `son-dakika${"1".repeat(20000)}!`,
      `son-dakika-${"1".repeat(20000)}x`,
      `tr${"_".repeat(20000)}`,
      `default-news-photo${"-1".repeat(5000)}!`,
    ]) {
      expect(isPlaceholderImageUrl(`https://cdn.x/${name}.jpg`)).toBe(false);
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
