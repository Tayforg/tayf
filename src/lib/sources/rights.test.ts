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
