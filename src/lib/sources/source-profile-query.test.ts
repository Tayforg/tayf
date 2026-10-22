import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// /source/[slug] data layer. The contract this suite pins:
//   - a read timeout is NEVER a 404: `null` means "no such source" and only
//     that; a sustained failure (cached attempt AND live retry) THROWS so the
//     root error boundary renders ("Tekrar dene", noindex);
//   - the "use cache" body never throws (attemptCached) and picks its cache
//     lifetime from the outcome ("minutes" for a failure);
//   - every Supabase request runs under the 4 s reader cap.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const order = vi.hoisted(() => ({ events: [] as string[] }));

// next/navigation.notFound() normally throws a special Next digest error to
// unwind the render; the fake throws a recognisable signal. The rest of the
// module stays real (unstable_rethrow must keep its real no-op behaviour for
// plain errors).
const nav = vi.hoisted(() => {
  class NotFoundSignal extends Error {
    constructor() {
      super("NEXT_NOT_FOUND");
    }
  }
  return { NotFoundSignal };
});

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    notFound: () => {
      throw new nav.NotFoundSignal();
    },
  };
});

vi.mock("next/server", () => ({
  connection: vi.fn(async () => {
    order.events.push("connection");
  }),
}));

type PgError = { message: string; hint?: string; code?: string };
type Envelope = { data: unknown; error: PgError | null; count?: number | null };

const fixture = vi.hoisted(() => ({
  /** One envelope per query of that kind, consumed in order; the last repeats. */
  sources: [] as Envelope[],
  count: [] as Envelope[],
  articles: [] as Envelope[],
  history: [] as Envelope[],
  served: { sources: 0, count: 0, articles: 0, history: 0 },
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
}));

function take(kind: "sources" | "count" | "articles" | "history"): Envelope {
  const queue = fixture[kind];
  const i = Math.min(fixture.served[kind], queue.length - 1);
  fixture.served[kind] += 1;
  return queue[i] ?? { data: [], error: null };
}

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      sources: () => take("sources") as never,
      articles: (state: unknown) => {
        const args = (state as { selectArgs: unknown[] }).selectArgs;
        const isCount = (args[1] as { head?: boolean } | undefined)?.head === true;
        return take(isCount ? "count" : "articles") as never;
      },
      source_zone_history: () => take("history") as never,
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, opts?: unknown) => {
    order.events.push("client");
    fixture.clientOpts.push(opts);
    return supabaseFake.client;
  },
}));

import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";
import { getSourceProfile } from "./source-profile-query";

const ORIGINAL_ENV = { ...process.env };

/** A capped client is built with a custom `global.fetch`; a plain one is not. */
function isCappedClientOpts(opts: unknown): boolean {
  const g = (opts as { global?: { fetch?: unknown } } | undefined)?.global;
  return typeof g?.fetch === "function";
}

const TIMEOUT: Envelope = {
  data: null,
  error: {
    message: "AbortError: Supabase request exceeded 4000 ms",
    hint: "Request was aborted (timeout or manual cancellation)",
    code: "",
  },
};

const SOURCE_ROW = {
  id: "src-1",
  name: "Örnek Gazete",
  slug: "ornek-gazete",
  url: "https://ornek.example/",
  rss_url: "https://ornek.example/rss",
  bias: "center",
  logo_url: null,
  active: true,
  image_allowed: true,
  excerpt_allowed: true,
  zone_rationale: "gerekçe",
  zone_rationale_at: "2026-01-01T00:00:00.000Z",
  trustee_since: null,
  trustee_note: null,
};

const ARTICLE_ROWS = [
  {
    id: "a1",
    title: "Haber 1",
    description: "açıklama",
    url: "https://ornek.example/1",
    image_url: null,
    published_at: "2026-01-02T00:00:00.000Z",
  },
];

const HISTORY_ROWS = [
  {
    old_bias: "center",
    new_bias: "gov_leaning",
    reason: "sahiplik değişti",
    rater: "ekip",
    changed_at: "2026-01-03T00:00:00.000Z",
  },
];

function seedHappyPath() {
  fixture.sources = [{ data: [SOURCE_ROW], error: null }];
  fixture.count = [{ data: null, error: null, count: 12 }];
  fixture.articles = [{ data: ARTICLE_ROWS, error: null }];
  fixture.history = [{ data: HISTORY_ROWS, error: null }];
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  seedHappyPath();
  fixture.served = { sources: 0, count: 0, articles: 0, history: 0 };
  fixture.clientOpts = [];
  order.events = [];
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  vi.mocked(connection).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("getSourceProfile found / missing", () => {
  it("returns the profile and caches it for the normal source-directory lifetime, exactly once", async () => {
    const profile = await getSourceProfile("ornek-gazete");

    expect(profile).not.toBeNull();
    expect(profile?.source.name).toBe("Örnek Gazete");
    expect(profile?.articleCount7d).toBe(12);
    expect(profile?.articles).toEqual(ARTICLE_ROWS);
    expect(profile?.zoneHistory).toEqual([
      {
        oldBias: "center",
        newBias: "gov_leaning",
        reason: "sahiplik değişti",
        rater: "ekip",
        changedAt: "2026-01-03T00:00:00.000Z",
      },
    ]);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
    expect(cacheTag).toHaveBeenCalledWith("sources", "articles");
    expect(connection).not.toHaveBeenCalled();
  });

  it("a missing row returns null (the only case that may 404) and is cached as source-directory, with no retry", async () => {
    fixture.sources = [{ data: [], error: null }];

    await expect(getSourceProfile("yok-boyle-kaynak")).resolves.toBeNull();

    expect(fixture.served.sources).toBe(1);
    expect(fixture.served.count).toBe(0);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
    expect(connection).not.toHaveBeenCalled();
  });

  it("a zone-history error is non-fatal: the profile still renders with zoneHistory []", async () => {
    fixture.history = [
      { data: null, error: { message: "history table unavailable" } },
    ];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile).not.toBeNull();
    expect(profile?.zoneHistory).toEqual([]);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
    expect(console.error).toHaveBeenCalled();
  });
});

describe("getSourceProfile reader cap", () => {
  it("builds only capped reader clients", async () => {
    await getSourceProfile("ornek-gazete");
    expect(fixture.clientOpts.length).toBeGreaterThanOrEqual(1);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });

  it("the live retry after a failed cache attempt is capped too", async () => {
    fixture.sources = [TIMEOUT, { data: [SOURCE_ROW], error: null }];

    await getSourceProfile("ornek-gazete");

    expect(fixture.clientOpts).toHaveLength(2);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });
});

describe("getSourceProfile timeout is not a 404", () => {
  it("a sources-query timeout caches for minutes, calls connection() before the live retry, and when the retry also times out the call REJECTS (never null)", async () => {
    fixture.sources = [TIMEOUT];

    await expect(getSourceProfile("ornek-gazete")).rejects.toThrow(
      /source query failed: AbortError/,
    );

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(connection).toHaveBeenCalledTimes(1);
    expect(fixture.served.sources).toBe(2);
    // client(cached attempt) -> connection() -> client(live retry): the
    // retry reads the clock, which must be behind connection().
    expect(order.events).toEqual(["client", "connection", "client"]);
  });

  it("a successful live retry returns the profile (the blip heals inside the request)", async () => {
    fixture.sources = [TIMEOUT, { data: [SOURCE_ROW], error: null }];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.source.slug).toBe("ornek-gazete");
    expect(profile?.articleCount7d).toBe(12);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(connection).toHaveBeenCalledTimes(1);
  });

  it("a live retry that finds no row returns null (the source really is missing)", async () => {
    fixture.sources = [TIMEOUT, { data: [], error: null }];
    await expect(getSourceProfile("ornek-gazete")).resolves.toBeNull();
  });

  it("a count-query error rejects after the retry", async () => {
    fixture.count = [{ data: null, error: { message: "boom" } }];
    await expect(getSourceProfile("ornek-gazete")).rejects.toThrow(
      /count query failed: boom/,
    );
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("an articles-query error rejects after the retry", async () => {
    fixture.articles = [{ data: null, error: { message: "boom" } }];
    await expect(getSourceProfile("ornek-gazete")).rejects.toThrow(
      /articles query failed: boom/,
    );
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("a client-construction failure also rejects (it is not a 404 either)", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(getSourceProfile("ornek-gazete")).rejects.toThrow(/Missing/);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });
});

describe("getSourceProfile slug validation", () => {
  it.each(["", "Bad_Slug", "UPPER", "a b", "../etc/passwd", "a".repeat(65), "-lead"])(
    "an invalid slug (%j) returns null without building a client",
    async (slug) => {
      await expect(getSourceProfile(slug)).resolves.toBeNull();
      expect(fixture.clientOpts).toHaveLength(0);
      expect(cacheLife).not.toHaveBeenCalled();
      expect(connection).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// Page wiring: the page must keep the "null = 404, throw = error boundary"
// distinction that getSourceProfile establishes.
// ---------------------------------------------------------------------------

describe("/source/[slug] page: a timeout is not a 404", () => {
  it("generateMetadata on a sustained failure is noindex and does not claim the source is missing", async () => {
    fixture.sources = [TIMEOUT];
    const { generateMetadata } = await import("@/app/source/[slug]/page");

    const meta = await generateMetadata({ params: Promise.resolve({ slug: "ornek-gazete" }) });

    expect(meta.title).toBe("Kaynak şu anda yüklenemiyor");
    expect(meta.title).not.toBe("Kaynak bulunamadı");
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.alternates).toEqual({ canonical: null });
  });

  it("generateMetadata for a really missing source keeps the 'Kaynak bulunamadı' soft-404 metadata", async () => {
    fixture.sources = [{ data: [], error: null }];
    const { generateMetadata } = await import("@/app/source/[slug]/page");

    const meta = await generateMetadata({ params: Promise.resolve({ slug: "yok" }) });

    expect(meta.title).toBe("Kaynak bulunamadı");
    expect(meta.robots).toEqual({ index: false, follow: true });
  });

  it("generateMetadata for a found source carries the source name", async () => {
    const { generateMetadata } = await import("@/app/source/[slug]/page");

    const meta = await generateMetadata({ params: Promise.resolve({ slug: "ornek-gazete" }) });

    expect(meta.title).toBe("Örnek Gazete");
    expect(meta.alternates?.canonical).toBe("/source/ornek-gazete");
  });

  it("the page body REJECTS with a plain Error on a sustained failure (error boundary), never notFound()", async () => {
    fixture.sources = [TIMEOUT];
    const { default: SourceProfilePage } = await import("@/app/source/[slug]/page");

    const result = SourceProfilePage({ params: Promise.resolve({ slug: "ornek-gazete" }) });

    await expect(result).rejects.toThrow(/source query failed/);
    await expect(result).rejects.not.toBeInstanceOf(nav.NotFoundSignal);
  });

  it("the page body calls notFound() for a source that really does not exist", async () => {
    fixture.sources = [{ data: [], error: null }];
    const { default: SourceProfilePage } = await import("@/app/source/[slug]/page");

    await expect(
      SourceProfilePage({ params: Promise.resolve({ slug: "yok" }) }),
    ).rejects.toBeInstanceOf(nav.NotFoundSignal);
  });

  it("the page body calls notFound() for an invalid slug without any database read", async () => {
    const { default: SourceProfilePage } = await import("@/app/source/[slug]/page");

    await expect(
      SourceProfilePage({ params: Promise.resolve({ slug: "Bad_Slug" }) }),
    ).rejects.toBeInstanceOf(nav.NotFoundSignal);
    expect(fixture.clientOpts).toHaveLength(0);
  });

  it("the page body renders a found source", async () => {
    const { default: SourceProfilePage } = await import("@/app/source/[slug]/page");

    const element = await SourceProfilePage({ params: Promise.resolve({ slug: "ornek-gazete" }) });

    expect(element).toBeTruthy();
    expect(connection).not.toHaveBeenCalled();
  });
});
