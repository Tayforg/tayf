import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";

// Importing the root card module pulls next/og (Satori + resvg); the test only
// needs its `alt` / `size` / `contentType` exports, so stub the renderer.
vi.mock("next/og", () => ({ ImageResponse: class {} }));

import { alt, contentType, size } from "@/app/opengraph-image";

import { SITE_TITLE_SUFFIX, staticPageMetadata } from "./page-metadata";

type Image = { url: string; width: number; height: number; alt: string; type: string };
type Shape = {
  title: unknown;
  description: unknown;
  alternates: { canonical?: string; types?: Record<string, string> };
  openGraph: Record<string, unknown> & { images: Image[]; url: string };
  twitter: Record<string, unknown> & { images: Image[] };
  robots?: unknown;
  metadataBase?: unknown;
};

function build(
  overrides: Partial<Parameters<typeof staticPageMetadata>[0]> = {},
): Shape {
  return staticPageMetadata({
    title: "Sistem durumu",
    description: "D",
    path: "/durum",
    ...overrides,
  }) as unknown as Shape;
}

describe("staticPageMetadata", () => {
  it("keeps title and description plain so the layout template adds the suffix to <title>", () => {
    const m = build();
    expect(m.title).toBe("Sistem durumu");
    expect(m.description).toBe("D");
  });

  it("sets only the canonical alternate by default (no types key)", () => {
    const m = build();
    expect(m.alternates).toEqual({ canonical: "/durum" });
    expect("types" in m.alternates).toBe(false);
  });

  it("gives the page its own openGraph identity with the site suffix on the title", () => {
    const m = build();
    expect(m.openGraph).toMatchObject({
      type: "website",
      locale: "tr_TR",
      siteName: "Tayf",
      url: "/durum",
      title: "Sistem durumu — Tayf",
      description: "D",
    });
  });

  it("gives the page its own twitter card with the site suffix on the title", () => {
    const m = build();
    expect(m.twitter).toMatchObject({
      card: "summary_large_image",
      title: "Sistem durumu — Tayf",
      description: "D",
    });
  });

  it("keeps og:url identical to the canonical", () => {
    const m = build();
    expect(m.openGraph.url).toBe(m.alternates.canonical);
  });

  it("does not set robots or metadataBase (the root layout's still apply)", () => {
    const m = build();
    expect("robots" in m).toBe(false);
    expect("metadataBase" in m).toBe(false);
  });

  it("points og:image / twitter:image at the root card routes", () => {
    const m = build();
    expect(m.openGraph.images).toHaveLength(1);
    expect(m.twitter.images).toHaveLength(1);
    expect(m.openGraph.images[0]?.url).toBe("/opengraph-image");
    expect(m.twitter.images[0]?.url).toBe("/twitter-image");
  });

  it("pins the image descriptors to the root opengraph-image exports (no card drift)", () => {
    const m = build();
    for (const img of [m.openGraph.images[0], m.twitter.images[0]]) {
      expect(img?.width).toBe(size.width);
      expect(img?.height).toBe(size.height);
      expect(img?.alt).toBe(alt);
      expect(img?.type).toBe(contentType);
    }
  });

  it("passes alternateTypes through next to the canonical", () => {
    const m = build({
      path: "/blindspots",
      alternateTypes: { "application/rss+xml": "/rss/kor-noktalar.xml" },
    });
    expect(m.alternates).toEqual({
      canonical: "/blindspots",
      types: { "application/rss+xml": "/rss/kor-noktalar.xml" },
    });
  });

  it("keeps a curly apostrophe in the description byte-identical", () => {
    const description = "Tayf’ın haber toplama — yaklaşık dakikada bir.";
    const m = build({ description });
    expect(m.description).toBe(description);
    expect(m.openGraph.description).toBe(description);
    expect(m.twitter.description).toBe(description);
  });

  it("accepts nested paths and digits", () => {
    const m = build({ path: "/kaynaklar/durum" });
    expect(m.alternates.canonical).toBe("/kaynaklar/durum");
    expect(m.openGraph.url).toBe("/kaynaklar/durum");
  });

  it.each(["durum", "/durum/", "/durum?x=1", "https://x.com/durum", "/Durum", "", "/durum#x", "/dur um"])(
    "throws for the invalid path %j",
    (path) => {
      expect(() => build({ path })).toThrow(/staticPageMetadata: invalid path/);
    },
  );
});

describe("SITE_TITLE_SUFFIX", () => {
  it("is ' — Tayf'", () => {
    expect(SITE_TITLE_SUFFIX).toBe(" — Tayf");
  });

  it("equals the root layout's title.template (so og:title matches <title>)", () => {
    const layout = readFileSync(join(__dirname, "../../app/layout.tsx"), "utf8");
    expect(layout).toContain('template: "%s — Tayf"');
  });
});
