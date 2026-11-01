import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";

// Importing the root card module pulls next/og (Satori + resvg); the test only
// needs its `alt` / `size` / `contentType` exports, so stub the renderer.
vi.mock("next/og", () => ({ ImageResponse: class {} }));

import { alt, contentType, size } from "@/app/opengraph-image";

import {
  SITE_TITLE_SUFFIX,
  noindexPageMetadata,
  sharePageMetadata,
  staticPageMetadata,
} from "./page-metadata";

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

describe("noindexPageMetadata", () => {
  const page = { title: "Karşılaştır", description: "D", path: "/karsilastir" };

  function buildNoindex(
    overrides: Partial<Parameters<typeof noindexPageMetadata>[0]> = {},
  ): Shape {
    return noindexPageMetadata({
      ...page,
      follow: true,
      ...overrides,
    }) as unknown as Shape;
  }

  it("sets robots to noindex,nofollow when follow is false", () => {
    expect(buildNoindex({ follow: false }).robots).toEqual({ index: false, follow: false });
  });

  it("sets robots to noindex,follow when follow is true", () => {
    expect(buildNoindex({ follow: true }).robots).toEqual({ index: false, follow: true });
  });

  it("keeps og:url identical to the canonical and to the path (no inherited homepage '/')", () => {
    const m = buildNoindex();
    expect(m.openGraph.url).toBe("/karsilastir");
    expect(m.alternates.canonical).toBe("/karsilastir");
    expect(m.openGraph.url).toBe(m.alternates.canonical);
  });

  it("gives openGraph and twitter their own title with the site suffix", () => {
    const m = buildNoindex();
    expect(m.openGraph.title).toBe("Karşılaştır — Tayf");
    expect(m.twitter.title).toBe("Karşılaştır — Tayf");
  });

  it("points og:image / twitter:image at the root card routes", () => {
    const m = buildNoindex();
    expect(m.openGraph.images).toHaveLength(1);
    expect(m.twitter.images).toHaveLength(1);
    expect(m.openGraph.images[0]?.url).toBe("/opengraph-image");
    expect(m.twitter.images[0]?.url).toBe("/twitter-image");
  });

  it.each([true, false])(
    "equals staticPageMetadata apart from robots (follow=%s)",
    (follow) => {
      const { robots, ...rest } = noindexPageMetadata({ ...page, follow });
      expect(robots).toEqual({ index: false, follow });
      expect(rest).toEqual(staticPageMetadata(page));
    },
  );

  it("does not leak the follow flag into the output", () => {
    expect("follow" in buildNoindex()).toBe(false);
  });

  it("leaves staticPageMetadata without robots (the helper is the only noindex path)", () => {
    expect("robots" in (staticPageMetadata(page) as object)).toBe(false);
  });

  it.each(["/karsilastir?a=1", "karsilastir", "/karsilastir/", "/Karsilastir", ""])(
    "throws for the invalid path %j",
    (path) => {
      expect(() => buildNoindex({ path })).toThrow(/invalid path/);
    },
  );
});

describe("sharePageMetadata", () => {
  const week = {
    title: "Haftanın yelpazesi — 2026, 43. hafta · 19–25 Ekim",
    description: "D",
    path: "/hafta/2026-W43",
  };

  function buildShare(
    overrides: Partial<Parameters<typeof sharePageMetadata>[0]> = {},
  ): Shape {
    return sharePageMetadata({ ...week, ...overrides }) as unknown as Shape;
  }

  it("accepts a dynamic week path and gives it its own og:url, canonical and titles", () => {
    const m = buildShare();
    expect(m.title).toBe(week.title);
    expect(m.description).toBe("D");
    expect(m.alternates).toEqual({ canonical: "/hafta/2026-W43" });
    expect(m.openGraph.url).toBe("/hafta/2026-W43");
    expect(m.openGraph.title).toBe(`${week.title}${SITE_TITLE_SUFFIX}`);
    expect(m.twitter.title).toBe(`${week.title}${SITE_TITLE_SUFFIX}`);
    expect(m.twitter.card).toBe("summary_large_image");
  });

  it("accepts an upper-case ticker path (the one thing staticPageMetadata rejects)", () => {
    const m = buildShare({ path: "/ekonomi/LYDHO" });
    expect(m.openGraph.url).toBe("/ekonomi/LYDHO");
    expect(m.alternates.canonical).toBe("/ekonomi/LYDHO");
  });

  it("keeps og:url identical to the canonical", () => {
    const m = buildShare({ path: "/ekonomi/LYDHO" });
    expect(m.openGraph.url).toBe(m.alternates.canonical);
  });

  it("points og:image / twitter:image at the root card routes with the pinned descriptors", () => {
    const m = buildShare();
    expect(m.openGraph.images).toHaveLength(1);
    expect(m.twitter.images).toHaveLength(1);
    expect(m.openGraph.images[0]?.url).toBe("/opengraph-image");
    expect(m.twitter.images[0]?.url).toBe("/twitter-image");
    for (const img of [m.openGraph.images[0], m.twitter.images[0]]) {
      expect(img?.width).toBe(size.width);
      expect(img?.height).toBe(size.height);
      expect(img?.alt).toBe(alt);
      expect(img?.type).toBe(contentType);
    }
  });

  it("sets no robots and no metadataBase (the root layout's still apply)", () => {
    const m = buildShare();
    expect("robots" in m).toBe(false);
    expect("metadataBase" in m).toBe(false);
  });

  it("builds the same shape staticPageMetadata builds for the same path", () => {
    const input = { title: "Sistem durumu", description: "D", path: "/durum" };
    expect(sharePageMetadata(input)).toEqual(staticPageMetadata(input));
  });

  it.each(["/x?y", "/x#y", "/x/", "x", "", "https://x.com/x", "/x y", "/x//y/ ", "/x\n"])(
    "throws for the invalid path %j",
    (path) => {
      expect(() => buildShare({ path })).toThrow(/sharePageMetadata: invalid path/);
    },
  );

  it("accepts the root path '/'", () => {
    expect(buildShare({ path: "/" }).openGraph.url).toBe("/");
  });

  it("does not loosen staticPageMetadata: it still throws on an upper-case path", () => {
    expect(() => build({ path: "/Upper" })).toThrow(/staticPageMetadata: invalid path/);
  });
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
