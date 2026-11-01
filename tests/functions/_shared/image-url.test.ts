import { describe, expect, it } from "vitest";

import {
  isIconLikeImageUrl,
  isOptimizableImageUrl,
  isPlaceholderImageUrl,
  normalizeImageUrl,
  PLACEHOLDER_IMAGE_ASSETS,
  repairJoinedImageSegment,
  upgradeImageVariant,
} from "../../../supabase/functions/_shared/image-url.ts";
import { isAllowedRemoteImageUrl } from "../../../src/lib/images/remote-image-hosts";

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
    // A query-only root (resizer shape) is not a host root, see "host root".
    const resizer = "https://CDN.Test?u=https://o.test/a.jpg";
    expect(normalizeImageUrl(resizer)).toBe(resizer);
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
// file:// image URLs (Hurriyet, 2026-10-24): the feed's <img src> sometimes
// reads `file://image.hurimg.com/i/hurriyet/75/620x350/<id>.jpg`, a path
// copied from a local editor. The publisher's CDN serves the same path over
// https. A `file:` URL is never loadable in a browser, so the only safe
// healing is: a dotted DNS host with nothing else in the authority becomes
// https, everything else (a local path, localhost, an IP, userinfo, a port)
// stays rejected. The rewrite is a string rewrite -- no URL re-serialisation.
// ---------------------------------------------------------------------------

describe("normalizeImageUrl: file:// scheme", () => {
  it("heals a file:// URL on a DNS host to https", () => {
    expect(
      normalizeImageUrl(
        "file://image.hurimg.com/i/hurriyet/75/620x350/6ad8d7b322393fcfc7d3c38b.jpg",
      ),
    ).toBe("https://image.hurimg.com/i/hurriyet/75/620x350/6ad8d7b322393fcfc7d3c38b.jpg");
  });

  it("matches the scheme case-insensitively", () => {
    expect(normalizeImageUrl("FILE://image.hurimg.com/a.jpg")).toBe(
      "https://image.hurimg.com/a.jpg",
    );
    expect(normalizeImageUrl("File://image.hurimg.com/a.jpg")).toBe(
      "https://image.hurimg.com/a.jpg",
    );
  });

  it("keeps the host's case (a string rewrite, not a URL re-serialisation)", () => {
    expect(normalizeImageUrl("file://Image.HURIMG.com/A.jpg")).toBe(
      "https://Image.HURIMG.com/A.jpg",
    );
  });

  it("trims surrounding whitespace before looking at the scheme", () => {
    expect(normalizeImageUrl("  file://image.hurimg.com/a.jpg \n")).toBe(
      "https://image.hurimg.com/a.jpg",
    );
  });

  it("collapses a doubled leading path slash after the rewrite", () => {
    expect(normalizeImageUrl("file://image.hurimg.com//a.jpg")).toBe(
      "https://image.hurimg.com/a.jpg",
    );
  });

  it("keeps the query string and hash byte for byte", () => {
    expect(normalizeImageUrl("file://image.hurimg.com/a.jpg?x=1&y=%20z#frag")).toBe(
      "https://image.hurimg.com/a.jpg?x=1&y=%20z#frag",
    );
    expect(normalizeImageUrl("file://image.hurimg.com?x=1")).toBe(
      "https://image.hurimg.com?x=1",
    );
    expect(normalizeImageUrl("file://image.hurimg.com#top")).toBe(
      "https://image.hurimg.com#top",
    );
  });

  it("heals a bare host to https, which is then rejected as a host root (no image path)", () => {
    expect(normalizeImageUrl("file://image.hurimg.com")).toBeNull();
    expect(normalizeImageUrl("file://image.hurimg.com/")).toBeNull();
  });

  it("still repairs a joined ObjectId segment after the rewrite", () => {
    expect(
      normalizeImageUrl(
        "file://image.posta.com.tr/i/posta/90/0x0/627e113be4bfdc26aca117f5.jpg6acfb319b65de53ef53b8d3c.jpg",
      ),
    ).toBe("https://image.posta.com.tr/i/posta/90/0x0/6acfb319b65de53ef53b8d3c.jpg");
  });

  it.each([
    ["an empty host (a local path)", "file:///etc/x.jpg"],
    ["localhost", "file://localhost/x.jpg"],
    ["LOCALHOST", "file://LOCALHOST/x.jpg"],
    ["an IPv4 address", "file://127.0.0.1/x.jpg"],
    ["another IPv4 address", "file://10.0.0.5/x.jpg"],
    ["an IPv4 address with an out-of-range octet", "file://256.256.256.256/x.jpg"],
    ["a hex IPv4 spelling", "file://0x7f.0.0.1/x.jpg"],
    ["a short IPv4 spelling", "file://127.1/x.jpg"],
    ["a bracketed IPv6 address", "file://[::1]/x.jpg"],
    ["a single-label host", "file://intranet/x.jpg"],
    ["nothing after the scheme", "file://"],
    ["whitespace after the scheme", "file://   "],
    ["a single slash after the scheme", "file:/image.hurimg.com/a.jpg"],
    ["userinfo in the authority", "file://u@image.hurimg.com/a.jpg"],
    ["a port in the authority", "file://image.hurimg.com:8080/a.jpg"],
    ["a backslash in the authority", "file://image.hurimg.com\\a.jpg"],
    ["a label starting with a hyphen", "file://-bad.example/a.jpg"],
    ["an empty label", "file://image..hurimg.com/a.jpg"],
    ["a trailing dot", "file://image.hurimg.com./a.jpg"],
    ["a Windows drive path", "file://C:/Users/x/a.jpg"],
    ["a space inside the host", "file://image hurimg.com/a.jpg"],
    ["a non-ASCII host", "file://görsel.example/a.jpg"],
  ])("returns null for %s", (_label, input) => {
    expect(normalizeImageUrl(input)).toBeNull();
  });

  it("leaves every non-file input exactly as before", () => {
    expect(normalizeImageUrl("https://image.hurimg.com/a.jpg")).toBe(
      "https://image.hurimg.com/a.jpg",
    );
    expect(normalizeImageUrl("//image.hurimg.com/a.jpg")).toBe("https://image.hurimg.com/a.jpg");
    expect(normalizeImageUrl("ftp://image.hurimg.com/a.jpg")).toBeNull();
    // `file` inside the path or query of an https URL is not a scheme.
    const u = "https://h.test/file://x.jpg?u=file://evil.example/a.jpg";
    expect(normalizeImageUrl(u)).toBe(u);
  });

  it("is idempotent: the healed URL normalises to itself", () => {
    const once = normalizeImageUrl("file://image.hurimg.com//a.jpg?x=1#y");
    expect(once).toBe("https://image.hurimg.com/a.jpg?x=1#y");
    expect(normalizeImageUrl(once)).toBe(once);
  });
});

describe("isPlaceholderImageUrl: file:// spelling", () => {
  it("judges a healed file:// URL like its https spelling", () => {
    expect(
      isPlaceholderImageUrl(
        "file://image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg",
      ),
    ).toBe(true);
    expect(isPlaceholderImageUrl("file://image.hurimg.com/a.jpg")).toBe(false);
    expect(isPlaceholderImageUrl("file:///etc/x.jpg")).toBe(false);
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
    // A bare host is a host root, which is never an image (null, not repaired).
    expect(normalizeImageUrl(hostLike)).toBeNull();
    expect(repairJoinedImageSegment(hostLike)).toBe(hostLike);
    const withPath = `${hostLike}/a.jpg`;
    expect(normalizeImageUrl(withPath)).toBe(withPath);
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

// ---------------------------------------------------------------------------
// hunt-15 / A-image-url-hygiene. Every defect below was verified on live data
// on 2026-11-01 and is healed here, in the one shared module, so ingest stores
// a good URL and the render path (cluster-card-image, optimizedThumbUrl, the
// query layer's isPlaceholderImageUrl) repairs rows already stored -- no UPDATE.
// ---------------------------------------------------------------------------

describe("normalizeImageUrl: aksam /imgsdisk2026/ -> /imgsdisk/2026/ (h15-images-1)", () => {
  // Aksam's RSS <enclosure> reads .../imgsdisk2026/11/01/<slug>_2.jpg (curl:
  // 404 text/html) while media:content reads .../imgsdisk/2026/11/01/<slug>_2.jpg
  // (200 image/jpeg). 96.6% of aksam rows (449 of 465 in 48 h) stored the 404.
  it("repairs the real broken enclosure spelling", () => {
    expect(normalizeImageUrl("https://img3.aksam.com.tr/imgsdisk2026/11/01/x_2.jpg")).toBe(
      "https://img3.aksam.com.tr/imgsdisk/2026/11/01/x_2.jpg",
    );
  });

  it.each(["img", "img1", "img2", "img3"])("repairs on host %s.aksam.com.tr", (sub) => {
    expect(normalizeImageUrl(`https://${sub}.aksam.com.tr/imgsdisk2026/11/01/x_2.jpg`)).toBe(
      `https://${sub}.aksam.com.tr/imgsdisk/2026/11/01/x_2.jpg`,
    );
  });

  it.each([2024, 2025, 2026, 2027, 2028, 2029])("repairs year %i", (year) => {
    expect(normalizeImageUrl(`https://img3.aksam.com.tr/imgsdisk${year}/05/09/a-b_2.jpg`)).toBe(
      `https://img3.aksam.com.tr/imgsdisk/${year}/05/09/a-b_2.jpg`,
    );
  });

  it("keeps the query and hash byte for byte", () => {
    expect(
      normalizeImageUrl("https://img3.aksam.com.tr/imgsdisk2026/11/01/x_2.jpg?v=1&Q=%20z#frag"),
    ).toBe("https://img3.aksam.com.tr/imgsdisk/2026/11/01/x_2.jpg?v=1&Q=%20z#frag");
  });

  it("matches the host case-insensitively and keeps its case", () => {
    expect(normalizeImageUrl("HTTPS://IMG3.Aksam.COM.TR/imgsdisk2026/11/01/x_2.jpg")).toBe(
      "HTTPS://IMG3.Aksam.COM.TR/imgsdisk/2026/11/01/x_2.jpg",
    );
  });

  it("heals a doubled leading slash and the spelling in one call", () => {
    expect(normalizeImageUrl("https://img3.aksam.com.tr//imgsdisk2026/11/01/x_2.jpg")).toBe(
      "https://img3.aksam.com.tr/imgsdisk/2026/11/01/x_2.jpg",
    );
  });

  it("returns an already-correct aksam URL === unchanged (idempotent)", () => {
    const good = "https://img3.aksam.com.tr/imgsdisk/2026/11/01/x_2.jpg";
    expect(normalizeImageUrl(good)).toBe(good);
    const once = normalizeImageUrl("https://img3.aksam.com.tr/imgsdisk2026/11/01/x_2.jpg");
    expect(normalizeImageUrl(once)).toBe(once);
  });

  it.each([
    ["a non-aksam host", "https://cdn.example.com/imgsdisk2026/x.jpg"],
    ["a look-alike host", "https://img3.aksam.com.tr.evil.test/imgsdisk2026/11/01/x_2.jpg"],
    ["imgsdisk2026 that is not the first path segment", "https://img3.aksam.com.tr/a/imgsdisk2026/11/01/x_2.jpg"],
    ["imgsdisk2026 only in the query", "https://img3.aksam.com.tr/x.jpg?p=/imgsdisk2026/11/01/x_2.jpg"],
    ["a non-20xx year", "https://img3.aksam.com.tr/imgsdisk1999/11/01/x_2.jpg"],
    ["a 3-digit year", "https://img3.aksam.com.tr/imgsdisk202/11/01/x_2.jpg"],
    ["imgsdisk2026 with no trailing slash", "https://img3.aksam.com.tr/imgsdisk2026"],
  ])("leaves %s untouched", (_label, input) => {
    expect(normalizeImageUrl(input)).toBe(input);
  });
});

describe("isPlaceholderImageUrl: the aksam stand-in in both spellings (h15-images-1)", () => {
  const BROKEN = "https://img3.aksam.com.tr/imgsdisk2026/01/01/210220191220255418101_2.jpg";
  const REAL = "https://img3.aksam.com.tr/imgsdisk/2026/01/01/210220191220255418101_2.jpg";

  it("is true for the broken spelling and for the real asset", () => {
    expect(isPlaceholderImageUrl(BROKEN)).toBe(true);
    expect(isPlaceholderImageUrl(REAL)).toBe(true);
  });

  it("is false for a normal aksam photo in either spelling", () => {
    expect(isPlaceholderImageUrl("https://img3.aksam.com.tr/imgsdisk/2026/11/01/halk-tercihini-yapti-bulg-592_2.jpg")).toBe(false);
    expect(isPlaceholderImageUrl("https://img3.aksam.com.tr/imgsdisk2026/11/01/halk-tercihini-yapti-bulg-592_2.jpg")).toBe(false);
  });
});

describe("PLACEHOLDER_IMAGE_ASSETS keys are in normalised form", () => {
  // The aksam key was spelled `imgsdisk2026/...`, a form normalisation never
  // produces once the repair exists, so it could never be matched. Every key
  // must survive normalisation unchanged.
  it("every key k satisfies normalizeImageUrl('https://' + k) === 'https://' + k", () => {
    expect(PLACEHOLDER_IMAGE_ASSETS.size).toBeGreaterThan(0);
    for (const k of PLACEHOLDER_IMAGE_ASSETS) {
      expect(normalizeImageUrl("https://" + k)).toBe("https://" + k);
    }
  });

  it("holds the aksam asset under its real spelling", () => {
    expect(
      PLACEHOLDER_IMAGE_ASSETS.has("img3.aksam.com.tr/imgsdisk/2026/01/01/210220191220255418101_2.jpg"),
    ).toBe(true);
  });
});

describe("isPlaceholderImageUrl: son-dakika cards with a glued extension and CMS defaults (h15-images-3)", () => {
  // Real rows from the 2026-11-01 sample (33 rows in 48 h across ten sources).
  it.each([
    ["sozcu son-dakikajpg", "https://sozcu01.sozcucdn.com/sozcu/production/uploads/images/2026/10/son-dakikajpg-fGomF2NHS0uGhDDwDPCbMQ.jpg"],
    ["sozcu son-dakikajpg with an underscore in the hash", "https://sozcu01.sozcucdn.com/sozcu/production/uploads/images/2026/10/son-dakikajpg-L_MyIqrTXE6MR_TakbyVqw.jpg"],
    ["sondakikajpg", "https://sozcu01.sozcucdn.com/sozcu/production/uploads/images/2026/10/sondakikajpg-fGomF2NHS0uGhDDwDPCbMQ.jpg"],
    ["logojpg", "https://sozcu01.sozcucdn.com/sozcu/production/uploads/images/2026/10/logojpg-fGomF2NHS0uGhDDwDPCbMQ.jpg"],
    ["sondakika880x487uzunjpg", "https://sozcu01.sozcucdn.com/sozcu/production/uploads/images/2026/10/sondakika880x487uzunjpg-BNRlohNsQE21_M5RLT2IhA.jpg"],
    ["a glued png with no hash tail", "https://cdn.x/uploads/son-dakikapng.png"],
    ["rcman images/default.png", "https://img.yenicaggazetesi.com/rcman/Cw1280h720q95gc/storage/files/images/default.png"],
    ["aydinlik rcman images/default.png", "https://img.aydinlik.com.tr/rcman/Cw1280h720q95gc/storage/files/images/default.png"],
    ["ekonomim default.png?v=3", "https://img.ekonomim.com/rcman/Cw1280h720q95gc/assets/web/images/default.png?v=3"],
    ["muhalif default cover", "https://www.muhalif.com.tr/cropImages/1280x720/uploads/haberler/2026/11/3712-muhalif-default-cover.jpg"],
    ["a bare x-muhalif-default-cover.jpg", "https://cdn.x/x-muhalif-default-cover.jpg"],
    ["a bare default-cover.jpg", "https://cdn.x/default-cover.jpg"],
    ["takvim direct", "https://itkv.tmgrup.com.tr/Defaults/Upload/tkv-default-1754911321840.png"],
    ["takvim wrapped in the iatkv resizer", "https://iatkv.tmgrup.com.tr/ca4868/1200/675/0/0/1200/675?u=https%3a%2f%2fitkv.tmgrup.com.tr%2fDefaults%2fUpload%2ftkv-default-1754911321840.png"],
    ["takvim wrapped with an unencoded u=", "https://iatkv.tmgrup.com.tr/ca4868/1200/675/0/0/1200/675?u=https://itkv.tmgrup.com.tr/Defaults/Upload/tkv-default-1754911321840.png"],
    ["cgtn-turk placeholder.png", "https://www.cgtnturk.com/vendor/te/assets/images/placeholder.png"],
    ["haberler-com son-dakika_amp", "https://foto.haberler.com/haber/2026/11/01/son-dakika_amp.jpg"],
  ])("is true for %s", (_label, url) => {
    expect(isPlaceholderImageUrl(url)).toBe(true);
  });

  it.each([
    ["the real haberler-com amp photo", "https://foto.haberler.com/haber/2026/11/01/deprem-sonrasi-aciklama-20384346_amp.jpg"],
    ["a real Sozcu photo", "https://sozcu01.sozcucdn.com/sozcu/production/uploads/images/2026/11/erdogan-konusma-fGomF2NHS0uGhDDwDPCbMQ.jpg"],
    ["a youtube thumbnail", "https://img.youtube.com/vi/2lKJof-8DeE/hqdefault.jpg"],
    ["a slug with default mid-name", "https://cdn.x/2026/11/mahkeme-default-karari-aciklandi-18123456.jpg"],
    ["a slug that starts with default", "https://cdn.x/default-karar-haberi.jpg"],
    ["a slug that ends with default and short digits", "https://cdn.x/foto-default-123.jpg"],
    ["a slug that starts with placeholder", "https://cdn.x/placeholder-haber.jpg"],
    ["a son-dakika slug with a hash-like tail", "https://cdn.x/son-dakika-erdogan-fGomF2NHS0uGhDDwDPCbMQ.jpg"],
    ["a son-dakika_amp suffix on a real slug", "https://cdn.x/yeni-son-dakika_amp.jpg"],
    ["a logo slug with words after it", "https://cdn.x/logojpg-degisti-haberi.jpg"],
    ["a /default/ directory holding a real photo", "https://cdn.x/default/2026/11/foto-123.jpg"],
    ["a /images/default/ directory", "https://cdn.x/images/default/foto-123.jpg"],
  ])("is false for %s", (_label, url) => {
    expect(isPlaceholderImageUrl(url)).toBe(false);
  });

  it("stays linear on adversarial basenames of the new rules", () => {
    const started = Date.now();
    for (const name of [
      // Over MAX_BASENAME_LENGTH: refused before any pattern runs.
      `son-dakikajpg-${"a".repeat(20000)}`,
      `sondakika${"9".repeat(20000)}x`,
      `logojpg-${"-".repeat(20000)}`,
      `x-default-${"1".repeat(20000)}x`,
      `${"-default-".repeat(2000)}1`,
      `default${"-cover".repeat(5000)}x`,
      // Within the 200-character budget: the patterns really run.
      `son-dakikajpg-${"a".repeat(150)}`,
      `sondakika${"9".repeat(150)}x`,
      `logojpg-${"-".repeat(150)}`,
      `x-default-${"1".repeat(150)}x`,
      `${"-default-".repeat(22)}1`,
      `default${"-cover".repeat(30)}x`,
      `${"son-dakika".repeat(19)}!`,
    ]) {
      expect(isPlaceholderImageUrl(`https://cdn.x/${name}.jpg`)).toBe(false);
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("normalizeImageUrl: values that are not an image (h15-images-3)", () => {
  it.each([
    ["istiklal host root with a slash", "https://cdn.istiklal.com.tr/"],
    ["istiklal host root without a slash", "https://cdn.istiklal.com.tr"],
    ["a host root with only a doubled slash", "https://cdn.istiklal.com.tr//"],
    ["a protocol-relative host root", "//cdn.istiklal.com.tr/"],
    ["a trailing-question-mark host root", "https://cdn.istiklal.com.tr/?"],
    ["a WordPress emoji PNG", "https://s.w.org/images/core/emoji/15.0.3/72x72/1f449.png"],
    ["a WordPress emoji svg on another version", "https://s.w.org/images/core/emoji/14.0.0/svg/1f525.svg"],
    ["a WordPress emoji with an upper-case host", "https://S.W.ORG/images/core/emoji/15.0.3/72x72/1f449.png"],
  ])("returns null for %s", (_label, input) => {
    expect(normalizeImageUrl(input)).toBeNull();
  });

  it("does not null a root path that carries a query (resizer shape)", () => {
    const u = "https://h/?u=https://o.test/a.jpg";
    expect(normalizeImageUrl(u)).toBe(u);
    const bareQuery = "https://cdn.test?u=https://o.test/a.jpg";
    expect(normalizeImageUrl(bareQuery)).toBe(bareQuery);
  });

  it("does not null a root path that carries only a hash", () => {
    expect(normalizeImageUrl("https://cdn.test/#a")).toBe("https://cdn.test/#a");
  });

  it("does not null other s.w.org paths or other hosts with an emoji-like path", () => {
    const other = "https://s.w.org/plugins/geodirectory/assets/a.png";
    expect(normalizeImageUrl(other)).toBe(other);
    const lookalike = "https://cdn.example.com/images/core/emoji/15.0.3/72x72/1f449.png";
    expect(normalizeImageUrl(lookalike)).toBe(lookalike);
  });

  it("a root-path URL is not a placeholder, it is simply unusable", () => {
    expect(isPlaceholderImageUrl("https://cdn.istiklal.com.tr/")).toBe(false);
  });
});

describe("normalizeImageUrl: YouTube embeds -> img.youtube.com thumbnail (h15-images-3)", () => {
  const ID = "2lKJof-8DeE";
  const THUMB = `https://img.youtube.com/vi/${ID}/hqdefault.jpg`;

  it.each([
    ["www.youtube.com/embed", `https://www.youtube.com/embed/${ID}`],
    ["youtube.com/embed with a query", `https://youtube.com/embed/${ID}?si=x`],
    ["www.youtube-nocookie.com/embed", `https://www.youtube-nocookie.com/embed/${ID}`],
    ["youtu.be", `https://youtu.be/${ID}`],
    ["a protocol-relative embed", `//www.youtube.com/embed/${ID}`],
    ["an embed with a trailing slash", `https://www.youtube.com/embed/${ID}/`],
    ["an http embed", `http://www.youtube.com/embed/${ID}`],
  ])("maps %s", (_label, input) => {
    expect(normalizeImageUrl(input)).toBe(THUMB);
  });

  it("accepts underscores and hyphens in the 11-char id", () => {
    expect(normalizeImageUrl("https://www.youtube.com/embed/DKe86Yi_5tU")).toBe(
      "https://img.youtube.com/vi/DKe86Yi_5tU/hqdefault.jpg",
    );
  });

  it("the mapped URL is on the /_next/image allowlist (the embed host is not)", () => {
    expect(isAllowedRemoteImageUrl(`https://www.youtube.com/embed/${ID}`)).toBe(false);
    const mapped = normalizeImageUrl(`https://www.youtube.com/embed/${ID}`) as string;
    expect(isAllowedRemoteImageUrl(mapped)).toBe(true);
  });

  it("is idempotent and leaves an img.youtube.com thumbnail untouched", () => {
    expect(normalizeImageUrl(THUMB)).toBe(THUMB);
    expect(normalizeImageUrl(normalizeImageUrl(`https://youtu.be/${ID}`))).toBe(THUMB);
  });

  it.each([
    ["a 10-char id", "https://www.youtube.com/embed/2lKJof-8De"],
    ["a 12-char id", "https://www.youtube.com/embed/2lKJof-8DeEx"],
    ["an id with a forbidden character", "https://www.youtube.com/embed/2lKJof.8DeE"],
    ["an empty id", "https://www.youtube.com/embed/"],
    ["a youtu.be id that is too short", "https://youtu.be/abc"],
    ["a non-embed youtube path", `https://www.youtube.com/watch/${ID}`],
    ["an embed on a look-alike host", `https://www.youtube.com.evil.test/embed/${ID}`],
    ["a nested embed path", `https://www.youtube.com/embed/${ID}/extra`],
  ])("leaves %s unchanged", (_label, input) => {
    expect(normalizeImageUrl(input)).toBe(input);
  });
});

describe("upgradeImageVariant (h15-images-4)", () => {
  it("upgrades an Oksijen 150x84 thumbnail to 1280x720", () => {
    expect(
      upgradeImageVariant(
        "https://i.gazeteoksijen.com/2/150/84/storage/files/images/2026/11/01/x-b1mn.jpg",
      ),
    ).toBe("https://i.gazeteoksijen.com/2/1280/720/storage/files/images/2026/11/01/x-b1mn.jpg");
  });

  it("upgrades a BBC ws/240 variant to standard/976", () => {
    expect(
      upgradeImageVariant("https://ichef.bbci.co.uk/ace/ws/240/cpsprodpb/abcd/live/x.jpg.webp"),
    ).toBe("https://ichef.bbci.co.uk/ace/standard/976/cpsprodpb/abcd/live/x.jpg.webp");
  });

  it("upgrades the rcman Cw150h84 preset on any host, every occurrence (the pre-existing behaviour, moved)", () => {
    expect(upgradeImageVariant("https://img.aydinlik.com.tr/rcman/Cw150h84q95gc/storage/x.jpg")).toBe(
      "https://img.aydinlik.com.tr/rcman/Cw1280h720q95gc/storage/x.jpg",
    );
    expect(upgradeImageVariant("https://any.test/rcman/Cw150h84q95gc/a/rcman/Cw150h84q95gc/b.jpg")).toBe(
      "https://any.test/rcman/Cw1280h720q95gc/a/rcman/Cw1280h720q95gc/b.jpg",
    );
  });

  it("keeps the query and hash of an upgraded URL", () => {
    expect(upgradeImageVariant("https://i.gazeteoksijen.com/2/150/84/storage/x.jpg?v=1#h")).toBe(
      "https://i.gazeteoksijen.com/2/1280/720/storage/x.jpg?v=1#h",
    );
  });

  it("matches the Oksijen and BBC host case-insensitively", () => {
    expect(upgradeImageVariant("https://I.GazeteOksijen.com/2/150/84/storage/x.jpg")).toBe(
      "https://I.GazeteOksijen.com/2/1280/720/storage/x.jpg",
    );
  });

  it.each([
    ["an already-large Oksijen variant", "https://i.gazeteoksijen.com/2/1280/720/storage/x.jpg"],
    ["an already-large BBC variant", "https://ichef.bbci.co.uk/ace/standard/976/cpsprodpb/x.jpg"],
    ["a BBC ws/480 variant (only 240 is verified)", "https://ichef.bbci.co.uk/ace/ws/480/cpsprodpb/x.jpg"],
    ["an already-large rcman preset", "https://img.aydinlik.com.tr/rcman/Cw1280h720q95gc/storage/x.jpg"],
    ["/2/150/84/ on another host", "https://cdn.example.com/2/150/84/storage/x.jpg"],
    ["/2/150/84/ on a look-alike host", "https://i.gazeteoksijen.com.evil.test/2/150/84/storage/x.jpg"],
    ["/2/150/84/ that is not the path prefix", "https://i.gazeteoksijen.com/a/2/150/84/storage/x.jpg"],
    ["/ace/ws/240/ on another host", "https://cdn.example.com/ace/ws/240/cpsprodpb/x.jpg"],
    ["a plain photo", "https://cdn.test/a.jpg"],
    ["the empty string", ""],
  ])("returns %s ===", (_label, input) => {
    expect(upgradeImageVariant(input)).toBe(input);
  });

  it("is idempotent", () => {
    for (const x of [
      "https://i.gazeteoksijen.com/2/150/84/storage/x.jpg",
      "https://ichef.bbci.co.uk/ace/ws/240/cpsprodpb/x.jpg",
      "https://img.test/rcman/Cw150h84q95gc/storage/x.jpg",
      "https://cdn.test/a.jpg",
    ]) {
      const once = upgradeImageVariant(x);
      expect(upgradeImageVariant(once)).toBe(once);
    }
  });

  it("is applied by normalizeImageUrl (render path heals stored rows)", () => {
    expect(normalizeImageUrl("https://i.gazeteoksijen.com/2/150/84/storage/x.jpg")).toBe(
      "https://i.gazeteoksijen.com/2/1280/720/storage/x.jpg",
    );
    expect(normalizeImageUrl("https://ichef.bbci.co.uk/ace/ws/240/cpsprodpb/x.jpg")).toBe(
      "https://ichef.bbci.co.uk/ace/standard/976/cpsprodpb/x.jpg",
    );
    expect(normalizeImageUrl("https://img.test//rcman/Cw150h84q95gc/storage/x.jpg")).toBe(
      "https://img.test/rcman/Cw1280h720q95gc/storage/x.jpg",
    );
    expect(normalizeImageUrl("//i.gazeteoksijen.com//2/150/84/storage/x.jpg")).toBe(
      "https://i.gazeteoksijen.com/2/1280/720/storage/x.jpg",
    );
  });

  it("normalizeImageUrl stays idempotent over every new repair", () => {
    for (const x of [
      "https://img3.aksam.com.tr/imgsdisk2026/11/01/x_2.jpg",
      "https://i.gazeteoksijen.com/2/150/84/storage/x.jpg",
      "https://ichef.bbci.co.uk/ace/ws/240/cpsprodpb/x.jpg",
      "https://www.youtube.com/embed/2lKJof-8DeE",
      "https://youtu.be/2lKJof-8DeE",
    ]) {
      const once = normalizeImageUrl(x);
      expect(normalizeImageUrl(once)).toBe(once);
    }
  });

  it("upgraded Oksijen and BBC hosts are on the /_next/image allowlist", () => {
    expect(isAllowedRemoteImageUrl("https://i.gazeteoksijen.com/2/1280/720/storage/x.jpg")).toBe(true);
    expect(isAllowedRemoteImageUrl("https://ichef.bbci.co.uk/ace/standard/976/cpsprodpb/x.jpg")).toBe(true);
    expect(isAllowedRemoteImageUrl("https://img3.aksam.com.tr/imgsdisk/2026/11/01/x_2.jpg")).toBe(true);
  });
});

describe("isIconLikeImageUrl (h15-images-3)", () => {
  it.each([
    ["logo.png", "https://www.mfa.gov.tr/images/logo.png"],
    ["favicon.ico", "https://cdn.test/favicon.ico"],
    ["apple-touch-icon.png", "https://cdn.test/apple-touch-icon.png"],
    ["site-logo-2x.png", "https://cdn.test/img/site-logo-2x.png"],
    ["icon_32.png", "https://cdn.test/img/icon_32.png"],
    ["an upper-case LOGO.PNG", "https://cdn.test/img/LOGO.PNG"],
    ["a logo with a query", "https://cdn.test/img/logo.png?v=3"],
    ["a percent-encoded site%2Dlogo", "https://cdn.test/img/site%2Dlogo.png"],
    ["a resizer wrapping a logo", "https://r.test/c1/1/1?u=https://o.test/images/logo.png"],
  ])("is true for %s", (_label, url) => {
    expect(isIconLikeImageUrl(url)).toBe(true);
  });

  it.each([
    ["erdogan-ekonomi.jpg", "https://cdn.test/2026/11/erdogan-ekonomi.jpg"],
    ["silicon-vadisi-haberi.jpg (icon inside a word)", "https://cdn.test/2026/11/silicon-vadisi-haberi.jpg"],
    ["teknoloji-zirvesi.jpg", "https://cdn.test/2026/11/teknoloji-zirvesi.jpg"],
    ["a directory called logo", "https://cdn.test/logo/2026/11/foto-123.jpg"],
    ["a directory called icons", "https://cdn.test/icons/foto-123.jpg"],
    ["a name that only mentions logo in the query", "https://cdn.test/foto.jpg?name=logo.png"],
    ["catalogo.jpg (logo inside a word)", "https://cdn.test/catalogo.jpg"],
    ["a plain photo", "https://cdn.test/photo.jpg"],
  ])("is false for %s", (_label, url) => {
    expect(isIconLikeImageUrl(url)).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["the empty string", ""],
    ["a number", 42 as unknown as string],
    ["a host root", "https://cdn.test/"],
  ])("is false for %s", (_label, input) => {
    expect(isIconLikeImageUrl(input)).toBe(false);
  });

  it("does not throw on malformed percent-encoding", () => {
    expect(() => isIconLikeImageUrl("https://cdn.test/%E0%A4%A-logo.png")).not.toThrow();
    expect(isIconLikeImageUrl("https://cdn.test/%ZZ.png")).toBe(false);
  });

  it("stays linear on a long basename", () => {
    const started = Date.now();
    expect(isIconLikeImageUrl(`https://cdn.test/${"logo-".repeat(20000)}x.png`)).toBe(false);
    expect(isIconLikeImageUrl(`https://cdn.test/${"-".repeat(20000)}.png`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
