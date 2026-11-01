import { describe, it, expect, vi } from "vitest";

// The page module pulls the Supabase server client, feed-health and the
// weekly query layer at import time; generateMetadata needs none of them, so
// stub the heavy edges (same approach as tests/api/ekonomi-ticker.test.ts).
vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: vi.fn(async () => undefined) };
});
vi.mock("@/lib/supabase/server", () => ({
  READER_TIMEOUT_MS: 4000,
  createReaderClient: vi.fn(),
  createServerClient: vi.fn(),
  createFinanceServerClient: vi.fn(),
}));
vi.mock("@/lib/clusters/feed-health", () => ({ getZoneFeedHealth: vi.fn() }));

import { generateMetadata } from "@/app/hafta/[hafta]/page";

type Image = { url: string };
type Shape = {
  title: string;
  description: string;
  alternates: { canonical?: string };
  openGraph: { url: string; title: string; description: string; images: Image[] };
  twitter: { card: string; title: string; description: string; images: Image[] };
  robots?: unknown;
};

async function meta(hafta: string): Promise<Shape> {
  return (await generateMetadata({ params: Promise.resolve({ hafta }) })) as unknown as Shape;
}

describe("/hafta/[hafta] generateMetadata — share identity", () => {
  it("unfurls as the week itself, not as the homepage", async () => {
    const m = await meta("2026-W43");
    expect(m.openGraph.url).toBe("/hafta/2026-W43");
    expect(m.alternates.canonical).toBe("/hafta/2026-W43");
  });

  it("gives og:title and twitter:title the week label and the site suffix", async () => {
    const m = await meta("2026-W43");
    const title = "Haftanın yelpazesi — 2026, 43. hafta · 19–25 Ekim — Tayf";
    expect(m.openGraph.title).toBe(title);
    expect(m.twitter.title).toBe(title);
    expect(m.openGraph.title).toContain("43. hafta");
  });

  it("keeps the plain page title (the layout template adds the suffix to <title>)", async () => {
    const m = await meta("2026-W43");
    expect(m.title).toBe("Haftanın yelpazesi — 2026, 43. hafta · 19–25 Ekim");
  });

  it("uses the large summary card and the root share images", async () => {
    const m = await meta("2026-W43");
    expect(m.twitter.card).toBe("summary_large_image");
    expect(m.openGraph.images[0]?.url).toBe("/opengraph-image");
    expect(m.twitter.images[0]?.url).toBe("/twitter-image");
  });

  it("does not set robots (the week archive stays indexable)", async () => {
    const m = await meta("2026-W43");
    expect("robots" in m).toBe(false);
  });

  it("writes the description without the doubled 'hafta ... haftasında'", async () => {
    const m = await meta("2026-W43");
    expect(m.description).not.toMatch(/hafta[\s\S]*haftasında/);
    expect(m.description).toBe(
      "2026, 43. hafta · 19–25 Ekim: hangi taraf neyi öne çıkardı? Bölge payları, en geniş yelpazeli haberler ve kör noktalar.",
    );
    expect(m.openGraph.description).toBe(m.description);
    expect(m.twitter.description).toBe(m.description);
  });

  it("returns an empty object for a key that does not parse", async () => {
    expect(await meta("garbage")).toEqual({});
    expect(await meta("2026-W99")).toEqual({});
  });
});
