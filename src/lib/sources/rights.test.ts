import { describe, it, expect } from "vitest";
import { articleImageEligible, articleExcerptEligible } from "./rights";

describe("articleImageEligible", () => {
  const withImage = { image_url: "https://example.com/a.jpg" };
  const noImage = { image_url: null };

  it("eligible when image_allowed is true", () => {
    expect(articleImageEligible(withImage, { image_allowed: true })).toBe(true);
  });

  it("not eligible when image_allowed is false", () => {
    expect(articleImageEligible(withImage, { image_allowed: false })).toBe(false);
  });

  it("eligible when image_allowed is undefined (not withdrawn)", () => {
    expect(articleImageEligible(withImage, { image_allowed: undefined })).toBe(true);
  });

  it("eligible when image_allowed is null (not withdrawn)", () => {
    expect(articleImageEligible(withImage, { image_allowed: null })).toBe(true);
  });

  it("not eligible when article.image_url is null, regardless of the flag", () => {
    expect(articleImageEligible(noImage, { image_allowed: true })).toBe(false);
  });

  // gif-filter (http-1): the 22 MB haber7 / elips-haber placeholder GIFs pass
  // through /_next/image unmodified, so an animated GIF is never a usable
  // cover image even when the source allows image reuse.
  it("not eligible when article.image_url is a .gif, even when image_allowed is true", () => {
    expect(
      articleImageEligible({ image_url: "https://h/a.gif" }, { image_allowed: true }),
    ).toBe(false);
    expect(
      articleImageEligible({ image_url: "https://h/a.GIF?x=1" }, { image_allowed: undefined }),
    ).toBe(false);
  });

  // db-4: a publisher logo card / 'son dakika' stand-in is never a usable
  // cover image either, so /source/[slug] shows its neutral block instead.
  it("not eligible when article.image_url is a known placeholder, even when image_allowed is true", () => {
    expect(
      articleImageEligible(
        { image_url: "https://image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg" },
        { image_allowed: true },
      ),
    ).toBe(false);
    expect(
      articleImageEligible(
        { image_url: "https://img.piri.net/resim/imagecrop/2026/04/01/09/50/tr_son_dakika_530x530.jpg" },
        { image_allowed: undefined },
      ),
    ).toBe(false);
  });

  it("still eligible for a normal photo on the same CDN as a placeholder", () => {
    expect(
      articleImageEligible(
        { image_url: "https://image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9e.jpg" },
        { image_allowed: true },
      ),
    ).toBe(true);
  });

  it("still eligible for a .jpg and for a URL that only mentions gif in its query", () => {
    expect(
      articleImageEligible({ image_url: "https://h/a.jpg" }, { image_allowed: true }),
    ).toBe(true);
    expect(
      articleImageEligible({ image_url: "https://h/img?format=gif" }, { image_allowed: true }),
    ).toBe(true);
  });
});

describe("articleExcerptEligible", () => {
  const withDescription = { description: "Test summary" };
  const noDescription = { description: null };

  it("eligible when excerpt_allowed is true", () => {
    expect(articleExcerptEligible(withDescription, { excerpt_allowed: true })).toBe(true);
  });

  it("not eligible when excerpt_allowed is false", () => {
    expect(articleExcerptEligible(withDescription, { excerpt_allowed: false })).toBe(false);
  });

  it("eligible when excerpt_allowed is undefined (not withdrawn)", () => {
    expect(articleExcerptEligible(withDescription, { excerpt_allowed: undefined })).toBe(true);
  });

  it("eligible when excerpt_allowed is null (not withdrawn)", () => {
    expect(articleExcerptEligible(withDescription, { excerpt_allowed: null })).toBe(true);
  });

  it("not eligible when article.description is null, regardless of the flag", () => {
    expect(articleExcerptEligible(noDescription, { excerpt_allowed: true })).toBe(false);
  });
});
