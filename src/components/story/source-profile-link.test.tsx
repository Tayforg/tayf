import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SOURCE_NAME_TEXT_CLASS,
  SOURCE_PROFILE_LINK_CLASS,
  SourceProfileLink,
  sourceProfileHref,
} from "./source-profile-link";

// SourceProfileLink is a synchronous, hookless server component, so it
// renders directly with react-dom/server (same approach as balance-chip.test).

function render(slug: string | null | undefined, name: string): string {
  return renderToStaticMarkup(<SourceProfileLink slug={slug} name={name} />);
}

function classTokensOf(markup: string): string[] {
  const m = /class="([^"]*)"/.exec(markup);
  return m ? m[1]!.split(/\s+/).filter(Boolean) : [];
}

describe("sourceProfileHref", () => {
  it("builds /source/<slug> for valid slugs", () => {
    expect(sourceProfileHref("sabah")).toBe("/source/sabah");
    expect(sourceProfileHref("trt-haber")).toBe("/source/trt-haber");
  });

  it.each([
    ["empty string", ""],
    ["blank string", " "],
    ["uppercase", "Sabah"],
    ["inner space", "sa bah"],
    ["path traversal", "../admin"],
    ["slash", "sabah/x"],
    ["leading dash", "-x"],
    ["65 chars", "a".repeat(65)],
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
  ])("returns null for %s", (_label, value) => {
    expect(sourceProfileHref(value)).toBeNull();
  });

  it("accepts the 64-char boundary", () => {
    expect(sourceProfileHref("a".repeat(64))).toBe(`/source/${"a".repeat(64)}`);
  });
});

describe("SourceProfileLink — valid slug", () => {
  const html = render("sabah", "Sabah");

  it("renders exactly one anchor to the source profile with the name as text", () => {
    expect(html.match(/<a[\s>]/g)).toHaveLength(1);
    expect(html).toContain('href="/source/sabah"');
    expect(html).toMatch(/<a [^>]*>Sabah<\/a>/);
  });

  it("opens in the same tab and adds no extra accessible-name attributes", () => {
    expect(html).not.toContain("target=");
    expect(html).not.toContain("rel=");
    expect(html).not.toContain("aria-label");
    expect(html).not.toContain("title=");
  });

  it("carries the focus ring and the 44px mobile target classes", () => {
    const tokens = classTokensOf(html);
    for (const token of [
      "inline-flex",
      "items-center",
      "max-sm:min-h-11",
      "focus-visible:outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-ring",
    ]) {
      expect(tokens).toContain(token);
    }
  });

  it("uses the exported link class verbatim", () => {
    expect(html).toContain(`class="${SOURCE_PROFILE_LINK_CLASS}"`);
  });

  it("keeps the existing künye text look", () => {
    const tokens = classTokensOf(html);
    for (const token of [
      "font-mono",
      "text-[10px]",
      "uppercase",
      "tracking-wider",
      "text-foreground/80",
      "underline",
      "decoration-dotted",
      "underline-offset-2",
      "hover:text-foreground",
    ]) {
      expect(tokens).toContain(token);
    }
  });
});

describe("SourceProfileLink — invalid or missing slug", () => {
  it.each([
    ["uppercase", "Sabah"],
    ["traversal", "../admin"],
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
  ])("renders a plain span for %s slug", (_label, slug) => {
    const html = render(slug, "Sabah");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("href");
    expect(html).toBe(`<span class="${SOURCE_NAME_TEXT_CLASS}">Sabah</span>`);
  });
});

describe("SourceProfileLink — name handling", () => {
  it("escapes a hostile name in the link", () => {
    const html = render("sabah", "<img src=x>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x&gt;");
  });

  it("escapes a hostile name in the plain-text fallback", () => {
    const html = render(null, "<img src=x>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x&gt;");
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
  ])("renders nothing for a %s name", (_label, name) => {
    expect(render("sabah", name)).toBe("");
    expect(render(null, name)).toBe("");
  });
});
