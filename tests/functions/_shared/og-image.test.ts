import { describe, expect, it } from "vitest";

import {
  extractHeroImageFromHtml,
  isValidImageUrl,
} from "../../../supabase/functions/_shared/og-image.ts";

// ---------------------------------------------------------------------------
// ingest-hygiene: og:image values pass through normalizeImageUrl so a
// publisher's doubled leading slash (`https://h//a/b.jpg`) is repaired before
// it reaches articles.image_url. isValidImageUrl keeps its existing rules.
// ---------------------------------------------------------------------------

describe("extractHeroImageFromHtml: image URL normalisation", () => {
  it("collapses a doubled leading slash in og:image", () => {
    const html =
      '<head><meta property="og:image" content="https://h//a/b.jpg"></head>';
    expect(extractHeroImageFromHtml(html)).toBe("https://h/a/b.jpg");
  });

  it("returns a clean og:image unchanged", () => {
    const html =
      '<meta property="og:image" content="https://cdn.test/photos/a.jpg">';
    expect(extractHeroImageFromHtml(html)).toBe("https://cdn.test/photos/a.jpg");
  });

  it("keeps a mid-path '//' untouched", () => {
    const html =
      '<meta property="og:image" content="https://i20.haber7.net/resize/1280x720//haber/x.jpg">';
    expect(extractHeroImageFromHtml(html)).toBe(
      "https://i20.haber7.net/resize/1280x720//haber/x.jpg",
    );
  });

  it("falls through to the next extractor when the first candidate cannot be normalised", () => {
    const html =
      '<meta property="og:image" content="/relative.jpg">' +
      '<meta name="twitter:image" content="https://cdn.test/tw/a.jpg">';
    expect(extractHeroImageFromHtml(html)).toBe("https://cdn.test/tw/a.jpg");
  });

  // posta-image-url: a joined `<id1>.jpg<id2>.jpg` value (the publisher glues
  // two ObjectIds together; the first is a constant placeholder) is healed to
  // the real second image on every og:image / twitter:image style path.
  it("heals a joined posta ObjectId og:image", () => {
    const html =
      '<head><meta property="og:image" content="https://image.posta.com.tr/i/posta/90/0x0/627e113be4bfdc26aca117f5.jpg6acfb319b65de53ef53b8d3c.jpg"></head>';
    expect(extractHeroImageFromHtml(html)).toBe(
      "https://image.posta.com.tr/i/posta/90/0x0/6acfb319b65de53ef53b8d3c.jpg",
    );
  });

  it("heals a joined posta ObjectId twitter:image and keeps its query string", () => {
    const html =
      '<meta name="twitter:image" content="https://image.posta.com.tr/i/posta/90/0x0/627e113be4bfdc26aca117f5.jpg6acfb319b65de53ef53b8d3c.jpg?v=1">';
    expect(extractHeroImageFromHtml(html)).toBe(
      "https://image.posta.com.tr/i/posta/90/0x0/6acfb319b65de53ef53b8d3c.jpg?v=1",
    );
  });

  it("returns null for empty html", () => {
    expect(extractHeroImageFromHtml("")).toBeNull();
  });

  // gif-filter (http-1): a 22 MB animated placeholder GIF must never be
  // backfilled into articles.image_url.
  it("skips a .gif og:image and returns the jpg twitter:image", () => {
    const html =
      '<meta property="og:image" content="https://i12.haber7.net/x/rlQtL_1579004365_7688.gif">' +
      '<meta name="twitter:image" content="https://cdn.test/tw/a.jpg">';
    expect(extractHeroImageFromHtml(html)).toBe("https://cdn.test/tw/a.jpg");
  });

  it("returns null when every candidate is a .gif", () => {
    const html =
      '<meta property="og:image" content="https://cdn.test/a.gif">' +
      '<meta name="twitter:image" content="https://cdn.test/b.GIF?x=1">';
    expect(extractHeroImageFromHtml(html)).toBeNull();
  });
});

// db-4 ingest half: the backfill must never store a publisher logo card or a
// 'son dakika' stand-in either, or the very job that is meant to find the real
// photo would write the placeholder straight back. Fixtures are the verified
// prod rows from tests/functions/_shared/image-url.test.ts.
describe("db-4 ingest half: placeholder og:image is rejected", () => {
  const CNN =
    "https://image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg";
  const HABERLER_COM = "https://foto.haberler.com/haber/2026/07/03/son-dakika_o.jpg";
  const A_HABER =
    "https://iaahbr.tmgrup.com.tr/c18248/1200/675/0/0/1200/675?u=https://iahbr.tmgrup.com.tr/Defaults/Upload/ahbr-default-1754911102530.png";

  it("isValidImageUrl is false for an exact-asset placeholder", () => {
    expect(isValidImageUrl(CNN)).toBe(false);
  });

  it("isValidImageUrl is false for a basename-pattern placeholder", () => {
    expect(isValidImageUrl(HABERLER_COM)).toBe(false);
    expect(
      isValidImageUrl("https://img.piri.net/resim/imagecrop/2026/04/01/09/50/tr_son_dakika_530x530.jpg"),
    ).toBe(false);
  });

  it("isValidImageUrl is false for a resizer URL wrapping a placeholder in u=", () => {
    expect(isValidImageUrl(A_HABER)).toBe(false);
  });

  it("isValidImageUrl still accepts a real photo", () => {
    expect(isValidImageUrl("https://image.cnnturk.com/i/cnnturk/75/1200x675/6710a1b2c3d4e5f607182930.jpg")).toBe(true);
  });

  it("falls through a placeholder og:image to a real twitter:image", () => {
    const html =
      `<meta property="og:image" content="${CNN}">` +
      '<meta name="twitter:image" content="https://cdn.test/tw/real.jpg">';
    expect(extractHeroImageFromHtml(html)).toBe("https://cdn.test/tw/real.jpg");
  });

  it("falls through a placeholder og:image and twitter:image to a real itemprop image", () => {
    const html =
      `<meta property="og:image" content="${CNN}">` +
      `<meta name="twitter:image" content="${HABERLER_COM}">` +
      '<meta itemprop="image" content="https://cdn.test/ip/real.jpg">';
    expect(extractHeroImageFromHtml(html)).toBe("https://cdn.test/ip/real.jpg");
  });

  it("returns null when every candidate is a placeholder", () => {
    const html =
      `<meta property="og:image" content="${CNN}">` +
      `<meta name="twitter:image" content="${HABERLER_COM}">` +
      `<meta itemprop="image" content="${A_HABER}">`;
    expect(extractHeroImageFromHtml(html)).toBeNull();
  });
});

describe("isValidImageUrl keeps its rules", () => {
  it("rejects favicons, data: URIs and non-http(s) values", () => {
    expect(isValidImageUrl("https://cdn.test/favicon.png")).toBe(false);
    expect(isValidImageUrl("data:image/png;base64,AAAAAAAA")).toBe(false);
    expect(isValidImageUrl("/relative/path.jpg")).toBe(false);
  });

  it("accepts a plain https image URL", () => {
    expect(isValidImageUrl("https://cdn.test/photos/a.jpg")).toBe(true);
  });

  it("rejects an animated .gif (gif-filter, http-1)", () => {
    expect(isValidImageUrl("https://h/a.gif")).toBe(false);
    expect(isValidImageUrl("https://cdn.test/photos/A.GIF?x=1")).toBe(false);
    expect(isValidImageUrl("https://i12.haber7.net/x/rlQtL_1579004365_7688.gif")).toBe(false);
  });

  it("still accepts a URL that only mentions gif in its query string or as .gifv", () => {
    expect(isValidImageUrl("https://cdn.test/img?format=gif")).toBe(true);
    expect(isValidImageUrl("https://cdn.test/a.gifv")).toBe(true);
  });
});
