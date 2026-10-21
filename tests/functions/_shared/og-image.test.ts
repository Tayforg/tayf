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

  it("returns null for empty html", () => {
    expect(extractHeroImageFromHtml("")).toBeNull();
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
});
