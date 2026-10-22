import { describe, expect, it } from "vitest";

import {
  isOptimizableImageUrl,
  normalizeImageUrl,
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
