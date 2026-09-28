import { describe, it, expect, vi } from "vitest";
import { createSupabaseFake } from "../_helpers/supabase-fake";

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const foundClient = createSupabaseFake({
  tables: {
    sources: [
      {
        id: "s-cnn",
        name: "CNN Türk",
        slug: "cnn-turk",
        url: "https://cnnturk.com",
        rss_url: "https://cnnturk.com/rss",
        bias: "center",
        logo_url: "https://cnnturk.com/favicon.ico",
        active: true,
        image_allowed: true,
        excerpt_allowed: true,
        zone_rationale: null,
        zone_rationale_at: null,
        trustee_since: null,
        trustee_note: null,
      },
    ],
    articles: [],
    source_zone_history: [],
  },
}).client;

const notFoundClient = createSupabaseFake({
  tables: {
    sources: [],
  },
}).client;

describe("/source/[slug] generateMetadata (A4 + H)", () => {
  it("returns noindex + null canonical for a missing source", async () => {
    vi.resetModules();
    vi.doMock("@/lib/supabase/server", () => ({
      createServerClient: () => notFoundClient,
    }));
    const { generateMetadata } = await import("@/app/source/[slug]/page");

    const meta = await generateMetadata({ params: Promise.resolve({ slug: "yok" }) });

    expect(meta.title).toBe("Kaynak bulunamadı");
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.alternates).toEqual({ canonical: null });
  });

  it("carries no own openGraph/twitter images key and a summary_large_image card for a found source", async () => {
    vi.resetModules();
    vi.doMock("@/lib/supabase/server", () => ({
      createServerClient: () => foundClient,
    }));
    const { generateMetadata } = await import("@/app/source/[slug]/page");

    const meta = await generateMetadata({ params: Promise.resolve({ slug: "cnn-turk" }) });

    expect(meta.openGraph).not.toHaveProperty("images");
    expect(meta.twitter).not.toHaveProperty("images");
    expect((meta.twitter as { card?: string } | undefined)?.card).toBe(
      "summary_large_image",
    );
    expect(meta.alternates?.canonical).toBe("/source/cnn-turk");
  });
});

describe("/source/[slug] social image re-exports (H)", () => {
  it("opengraph-image.tsx re-exports the root card verbatim", async () => {
    const sourceOg = await import("@/app/source/[slug]/opengraph-image");
    const rootOg = await import("@/app/opengraph-image");
    expect(sourceOg.default).toBe(rootOg.default);
    expect(sourceOg.alt).toBe(rootOg.alt);
    expect(sourceOg.size).toEqual(rootOg.size);
    expect(sourceOg.contentType).toBe(rootOg.contentType);
  });

  it("twitter-image.tsx re-exports the root card verbatim", async () => {
    const sourceTwitter = await import("@/app/source/[slug]/twitter-image");
    const rootOg = await import("@/app/opengraph-image");
    expect(sourceTwitter.default).toBe(rootOg.default);
  });
});
