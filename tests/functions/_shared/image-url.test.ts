import { describe, expect, it } from "vitest";

import { normalizeImageUrl } from "../../../supabase/functions/_shared/image-url.ts";

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
