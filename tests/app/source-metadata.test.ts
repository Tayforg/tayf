import { describe, it, expect, vi } from "vitest";
import { createSupabaseFake } from "../_helpers/supabase-fake";

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

// A failed cached attempt falls through to `connection()` before the live
// retry; there is no request scope in vitest, so stub it.
vi.mock("next/server", () => ({
  connection: vi.fn(async () => {}),
}));

const CNN_SOURCE = {
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
};

// The fake answers the head/exact 7-day count with the fixture's length, so an
// empty `articles` table is a source that was silent for 7 days (count 0).
const foundClient = createSupabaseFake({
  tables: {
    sources: [CNN_SOURCE],
    articles: [],
    source_zone_history: [],
  },
}).client;

// One article => count 1 => not thin.
const activeClient = createSupabaseFake({
  tables: {
    sources: [CNN_SOURCE],
    articles: [
      {
        id: "a1",
        title: "Bir haber",
        description: null,
        url: "https://cnnturk.com/bir-haber",
        image_url: null,
        published_at: "2026-11-01T10:00:00.000Z",
      },
    ],
    source_zone_history: [],
  },
}).client;

const notFoundClient = createSupabaseFake({
  tables: {
    sources: [],
  },
}).client;

// The 4 s reader cap surfaces as a PostgREST-shaped error envelope, not a
// throw (supabase-js turns the AbortError into `{ data: null, error }`).
const timeoutClient = createSupabaseFake({
  tables: {
    sources: () => ({
      data: null,
      error: { message: "AbortError: Supabase request exceeded 4000 ms" },
    }),
  },
}).client;

describe("/source/[slug] generateMetadata (A4 + H)", () => {
  it("returns noindex + null canonical for a missing source", async () => {
    vi.resetModules();
    vi.doMock("@/lib/supabase/server", () => ({
      createServerClient: () => notFoundClient,
      createReaderClient: () => notFoundClient,
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
      createReaderClient: () => foundClient,
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

  it("an active source stays indexable with the 7-day count in its description", async () => {
    vi.resetModules();
    vi.doMock("@/lib/supabase/server", () => ({
      createServerClient: () => activeClient,
      createReaderClient: () => activeClient,
    }));
    const { generateMetadata } = await import("@/app/source/[slug]/page");

    const meta = await generateMetadata({ params: Promise.resolve({ slug: "cnn-turk" }) });

    expect(meta.robots).toBeUndefined();
    expect(meta.description).toContain("son 7 günde 1 haber");
    expect(meta.alternates?.canonical).toBe("/source/cnn-turk");
  });

  it("a source silent for 7 days is noindex,follow with a count-free description and its self canonical", async () => {
    vi.resetModules();
    vi.doMock("@/lib/supabase/server", () => ({
      createServerClient: () => foundClient,
      createReaderClient: () => foundClient,
    }));
    const { generateMetadata } = await import("@/app/source/[slug]/page");
    const { BIAS_LABELS } = await import("@/lib/bias/config");

    const meta = await generateMetadata({ params: Promise.resolve({ slug: "cnn-turk" }) });

    const expected = `CNN Türk (${BIAS_LABELS.center}) kaynağının Tayf profili: siyasi duruşu ve geçmiş haberleri.`;
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.alternates?.canonical).toBe("/source/cnn-turk");
    expect(meta.description).toBe(expected);
    expect(meta.description).not.toContain("0 haber");
    expect(meta.openGraph?.description).toBe(expected);
    expect(meta.twitter?.description).toBe(expected);
  });

  it("a read timeout is noindex + null canonical and never claims the source is missing", async () => {
    vi.resetModules();
    vi.doMock("@/lib/supabase/server", () => ({
      createServerClient: () => timeoutClient,
      createReaderClient: () => timeoutClient,
    }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { generateMetadata } = await import("@/app/source/[slug]/page");

      const meta = await generateMetadata({ params: Promise.resolve({ slug: "cnn-turk" }) });

      expect(meta.title).toBe("Kaynak şu anda yüklenemiyor");
      expect(meta.title).not.toBe("Kaynak bulunamadı");
      expect(meta.robots).toEqual({ index: false, follow: true });
      expect(meta.alternates).toEqual({ canonical: null });
      expect(meta).not.toHaveProperty("openGraph");
    } finally {
      errSpy.mockRestore();
    }
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
