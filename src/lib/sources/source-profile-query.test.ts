import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

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
  /** cluster_articles membership reads (h61-journey-3); empty queue = no rows, no error. */
  clusterArticles: [] as Envelope[],
  served: { sources: 0, count: 0, articles: 0, history: 0, clusterArticles: 0 },
  /** The column list each `sources` query asked for. */
  sourceSelects: [] as string[],
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
  /** Builder state of each recent-articles query (not the head/count one). */
  articleStates: [] as BuilderState[],
  /** Builder state of each cluster_articles membership query. */
  clusterStates: [] as BuilderState[],
  /** Make the cluster_articles read THROW instead of returning an envelope. */
  clusterThrows: false,
}));

function take(
  kind: "sources" | "count" | "articles" | "history" | "clusterArticles",
): Envelope {
  const queue = fixture[kind];
  const i = Math.min(fixture.served[kind], queue.length - 1);
  fixture.served[kind] += 1;
  return queue[i] ?? { data: [], error: null };
}

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      sources: (state: unknown) => {
        const args = (state as { selectArgs: unknown[] }).selectArgs;
        fixture.sourceSelects.push(String(args[0]));
        return take("sources") as never;
      },
      articles: (state: unknown) => {
        const args = (state as { selectArgs: unknown[] }).selectArgs;
        const isCount = (args[1] as { head?: boolean } | undefined)?.head === true;
        if (!isCount) fixture.articleStates.push(state as BuilderState);
        return take(isCount ? "count" : "articles") as never;
      },
      source_zone_history: () => take("history") as never,
      cluster_articles: (state: unknown) => {
        fixture.clusterStates.push(state as BuilderState);
        if (fixture.clusterThrows) throw new Error("cluster_articles socket hang up");
        return take("clusterArticles") as never;
      },
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
import { SOURCE_RECENT_FETCH, getSourceProfile } from "./source-profile-query";

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
  fixture.clusterArticles = [];
  fixture.served = { sources: 0, count: 0, articles: 0, history: 0, clusterArticles: 0 };
  fixture.clientOpts = [];
  fixture.sourceSelects = [];
  fixture.articleStates = [];
  fixture.clusterStates = [];
  fixture.clusterThrows = false;
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

  // h37-content-2: the page tells an aggregator / niche source apart by
  // `source.kind`; a select that omits the column makes every source read as
  // an outlet (a voting kind), which silently hides the "does not vote" note.
  it("selects the kind column and hands it to the page", async () => {
    fixture.sources = [{ data: [{ ...SOURCE_ROW, kind: "aggregator" }], error: null }];

    const profile = await getSourceProfile("ornek-gazete");

    expect(fixture.sourceSelects).toHaveLength(1);
    expect(fixture.sourceSelects[0]?.split(",").map((c) => c.trim())).toContain("kind");
    expect(profile?.source.kind).toBe("aggregator");
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

// h47-sources-1: /source/[slug] now says when a source is no longer monitored
// (`active` = false) or its feed is in ingest quarantine. The read selects
// fetch_quarantined_until and turns it into `quarantined` with the clock value
// fetchSourceProfile already takes for its 7-day window (inside the cache scope):
// no second Date.now(), and the page body stays clock-free.
describe("getSourceProfile quarantine (h47-sources-1)", () => {
  const NOW = Date.parse("2026-11-06T02:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const withUntil = (until: string | null | undefined) => {
    fixture.sources = [
      { data: [{ ...SOURCE_ROW, fetch_quarantined_until: until }], error: null },
    ];
  };

  it("selects the fetch_quarantined_until column", async () => {
    await getSourceProfile("ornek-gazete");

    expect(fixture.sourceSelects).toHaveLength(1);
    expect(fixture.sourceSelects[0]?.split(",").map((c) => c.trim())).toContain(
      "fetch_quarantined_until",
    );
  });

  it("is quarantined while fetch_quarantined_until is in the future", async () => {
    withUntil(new Date(NOW + 60 * 60 * 1000).toISOString());
    expect((await getSourceProfile("ornek-gazete"))?.quarantined).toBe(true);
  });

  it("is not quarantined once it has passed, at the exact instant, when NULL, when absent or when unparseable", async () => {
    for (const until of [
      new Date(NOW - 60 * 1000).toISOString(),
      new Date(NOW).toISOString(),
      null,
      undefined,
      "not-a-date",
    ]) {
      withUntil(until);
      expect((await getSourceProfile("ornek-gazete"))?.quarantined).toBe(false);
      fixture.served = { sources: 0, count: 0, articles: 0, history: 0, clusterArticles: 0 };
    }
  });

  it("the live retry after a failed cached attempt decides the verdict from its own read", async () => {
    fixture.sources = [
      TIMEOUT,
      {
        data: [
          { ...SOURCE_ROW, fetch_quarantined_until: new Date(NOW + 1000).toISOString() },
        ],
        error: null,
      },
    ];

    expect((await getSourceProfile("ornek-gazete"))?.quarantined).toBe(true);
  });

  it("hands the page both facts it renders: `active` and the quarantine verdict, for an inactive source too", async () => {
    fixture.sources = [
      {
        data: [
          {
            ...SOURCE_ROW,
            active: false,
            fetch_quarantined_until: new Date(NOW + 1000).toISOString(),
          },
        ],
        error: null,
      },
    ];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.source.active).toBe(false);
    expect(profile?.quarantined).toBe(true);
  });

  it("reads the clock exactly once, the read the 7-day window already had (no second Date.now inside the cache scope)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const code = readFileSync(resolve(here, "source-profile-query.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

    expect(code.match(/\bDate\.now\s*\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/\bnew Date\s*\(\s*\)/);
    expect(code).toMatch(/\bisRowQuarantined\([^)]*,\s*nowMs\s*\)/);
  });
});

describe("getSourceProfile entity residue (read-time repair)", () => {
  const RESIDUE_ROWS = [
    {
      id: "r1",
      title: "Ali&#39;nin açıklaması",
      description: "x &quot;y&quot; &amp; z",
      url: "https://ornek.example/r1",
      image_url: "https://ornek.example/r1.jpg",
      published_at: "2026-01-04T00:00:00.000Z",
    },
    {
      id: "r2",
      title: "Meclis&amp;#8217;te gündem",
      description: null,
      url: "https://ornek.example/r2",
      image_url: null,
      published_at: "2026-01-03T00:00:00.000Z",
    },
    {
      id: "r3",
      title: "Temiz başlık",
      description: "AT&T ve Fenerbahçe",
      url: "https://ornek.example/r3",
      image_url: null,
      published_at: "2026-01-02T00:00:00.000Z",
    },
  ];

  it("decodes title and description, keeps a null description null and leaves every other field alone", async () => {
    fixture.articles = [{ data: RESIDUE_ROWS, error: null }];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.articles).toEqual([
      {
        id: "r1",
        title: "Ali'nin açıklaması",
        description: 'x "y" & z',
        url: "https://ornek.example/r1",
        image_url: "https://ornek.example/r1.jpg",
        published_at: "2026-01-04T00:00:00.000Z",
      },
      {
        id: "r2",
        title: "Meclis\u2019te gündem",
        description: null,
        url: "https://ornek.example/r2",
        image_url: null,
        published_at: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "r3",
        title: "Temiz başlık",
        description: "AT&T ve Fenerbahçe",
        url: "https://ornek.example/r3",
        image_url: null,
        published_at: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("an empty articles result still comes back as []", async () => {
    fixture.articles = [{ data: [], error: null }];
    expect((await getSourceProfile("ornek-gazete"))?.articles).toEqual([]);
  });

  it("never turns entity-encoded markup in a title or description into markup", async () => {
    fixture.articles = [
      {
        data: [
          {
            ...RESIDUE_ROWS[0],
            title: "&amp;lt;script&amp;gt;alert(1)",
            description: "&amp;#60;img src=x&amp;#62;",
          },
        ],
        error: null,
      },
    ];

    const [article] = (await getSourceProfile("ornek-gazete"))?.articles ?? [];

    expect(article?.title).not.toMatch(/[<>]/);
    expect(article?.description).not.toMatch(/[<>]/);
  });
});

describe("getSourceProfile outbound article url (h24-feeds-3)", () => {
  it("cleans each article url for the href (utm tags and a literal '&#038;' gone) and leaves every other field alone", async () => {
    fixture.articles = [
      {
        data: [
          {
            id: "d1",
            title: "Diken haberi",
            description: null,
            url: "https://www.diken.com.tr/avro-56-lira-sinirini-gecti/?utm_source=rss&#038;utm_medium=rss&#038;utm_campaign=avro-56-lira-sinirini-gecti",
            image_url: null,
            published_at: "2026-01-04T00:00:00.000Z",
          },
          {
            id: "e1",
            title: "Evrensel haberi",
            description: "özet",
            url: "https://www.evrensel.net/haber/6007631/akaryakita-zam?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication",
            image_url: "https://www.evrensel.net/img.jpg",
            published_at: "2026-01-03T00:00:00.000Z",
          },
          {
            id: "p1",
            title: "Temiz url",
            description: null,
            url: "https://ornek.example/p1?id=5#yorumlar",
            image_url: null,
            published_at: "2026-01-02T00:00:00.000Z",
          },
        ],
        error: null,
      },
    ];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.articles).toEqual([
      {
        id: "d1",
        title: "Diken haberi",
        description: null,
        url: "https://www.diken.com.tr/avro-56-lira-sinirini-gecti/",
        image_url: null,
        published_at: "2026-01-04T00:00:00.000Z",
      },
      {
        id: "e1",
        title: "Evrensel haberi",
        description: "özet",
        url: "https://www.evrensel.net/haber/6007631/akaryakita-zam",
        image_url: "https://www.evrensel.net/img.jpg",
        published_at: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "p1",
        title: "Temiz url",
        description: null,
        url: "https://ornek.example/p1?id=5#yorumlar",
        image_url: null,
        published_at: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });
});

// h61-journey-3: 'Son haberler' must never show an UNCLUSTERED article whose
// title or description matches the site's private-individual filter
// (pii-filter.ts). Clustered articles are political and already public on
// cluster pages, so they are always kept. To still fill 20 slots after the
// filter, the query reads a bounded larger window (SOURCE_RECENT_FETCH) and the
// pure selection (source-recent-filter.ts) slices the result back to 20.
describe("getSourceProfile recent-articles privacy filter (h61-journey-3)", () => {
  // Invented text: only the description trips the filter ("çocuk"); ZZMARKER
  // lets a test prove the dropped row's text was not logged.
  const DESC_ONLY_PII = {
    id: "desc-pii",
    title: "Bir ilçede eski eşine ateş açtı",
    description: "Olay bir köyde yaşandı. Zanlı, 2 çocuk annesi eski eşine ateş etti. ZZMARKER",
    url: "https://ornek.example/desc-pii",
    image_url: null,
    published_at: "2026-01-09T00:00:00.000Z",
  };
  const POLITICAL = {
    id: "pol",
    title: "Meclis'te bütçe görüşmeleri başladı",
    description: "Genel Kurul'da komisyon raporu okundu.",
    url: "https://ornek.example/pol",
    image_url: null,
    published_at: "2026-01-08T00:00:00.000Z",
  };
  const CLUSTERED_FLAGGED = {
    id: "cl",
    title: "Bakan: 17 yaşındaki gencin ölümü soruşturulacak",
    description: null,
    url: "https://ornek.example/cl",
    image_url: null,
    published_at: "2026-01-07T00:00:00.000Z",
  };

  /** n rows, newest first; row i carries a private-individual word when isFlagged(i). */
  function manyRows(n: number, isFlagged: (i: number) => boolean) {
    return Array.from({ length: n }, (_, i) => ({
      id: `m${i}`,
      title: isFlagged(i) ? `Olayda ${i} yaşındaki kişi yaralandı` : `Bütçe görüşmesi ${i}`,
      description: null,
      url: `https://ornek.example/m${i}`,
      image_url: null,
      published_at: new Date(Date.UTC(2026, 0, 31, 0, 0, 0) - i * 3_600_000).toISOString(),
    }));
  }

  it("fetches a bounded window of SOURCE_RECENT_FETCH (40) newest articles, newest first", async () => {
    await getSourceProfile("ornek-gazete");

    expect(SOURCE_RECENT_FETCH).toBe(40);
    expect(fixture.articleStates).toHaveLength(1);
    const state = fixture.articleStates[0]!;
    expect(state.limit).toBe(SOURCE_RECENT_FETCH);
    expect(state.eq).toContainEqual({ col: "source_id", val: "src-1" });
    expect(state.order).toEqual([{ col: "published_at", opts: { ascending: false } }]);
  });

  it("reads cluster_articles with select('article_id').in('article_id', ids) for the returned ids", async () => {
    fixture.articles = [{ data: [POLITICAL, DESC_ONLY_PII], error: null }];

    await getSourceProfile("ornek-gazete");

    expect(fixture.clusterStates).toHaveLength(1);
    const state = fixture.clusterStates[0]!;
    expect(state.selectArgs).toEqual(["article_id"]);
    expect(state.in).toEqual([{ col: "article_id", vals: ["pol", "desc-pii"] }]);
  });

  it("does not query cluster_articles when there are no articles", async () => {
    fixture.articles = [{ data: [], error: null }];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.articles).toEqual([]);
    expect(fixture.served.clusterArticles).toBe(0);
    expect(fixture.clusterStates).toHaveLength(0);
  });

  it("drops an unclustered flagged row (title or description), keeps a clean one", async () => {
    fixture.articles = [{ data: [DESC_ONLY_PII, POLITICAL], error: null }];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.articles.map((a) => a.id)).toEqual(["pol"]);
  });

  it("keeps a flagged row whose id is in cluster_articles, in newest-first order", async () => {
    fixture.articles = [{ data: [DESC_ONLY_PII, POLITICAL, CLUSTERED_FLAGGED], error: null }];
    fixture.clusterArticles = [{ data: [{ article_id: "cl" }], error: null }];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.articles.map((a) => a.id)).toEqual(["pol", "cl"]);
  });

  it("runs the filter on the repaired text and still cleans the outbound url", async () => {
    // The stored text spells the matching word as double-encoded entity
    // residue ("adl&amp;#305;" is "adlı" once repaired), so the raw string
    // matches no pattern. The filter must therefore run on the repaired text.
    fixture.articles = [
      {
        data: [
          {
            ...POLITICAL,
            id: "res",
            description: "Mehmet adl&amp;#305; vatandaş ifade verdi",
          },
          { ...POLITICAL, id: "ok", url: "https://ornek.example/ok?utm_source=rss" },
        ],
        error: null,
      },
    ];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.articles.map((a) => a.id)).toEqual(["ok"]);
    expect(profile?.articles[0]?.url).toBe("https://ornek.example/ok");
  });

  it("returns at most 20 items from a 40-row window, newest first", async () => {
    const rows = manyRows(40, () => false);
    fixture.articles = [{ data: rows, error: null }];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.articles).toHaveLength(20);
    expect(profile?.articles.map((a) => a.id)).toEqual(rows.slice(0, 20).map((r) => r.id));
  });

  it("refills from the wider window: 25 of 40 flagged leaves the 15 clean rows", async () => {
    // Flag the 25 newest rows, so the unfiltered top 20 would be all private.
    const rows = manyRows(40, (i) => i < 25);
    fixture.articles = [{ data: rows, error: null }];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.articles.map((a) => a.id)).toEqual(rows.slice(25).map((r) => r.id));
    expect(profile?.articles).toHaveLength(15);
  });

  it("leaves the 7-day count, the label card source and the zone history untouched", async () => {
    fixture.articles = [{ data: [DESC_ONLY_PII, POLITICAL], error: null }];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.articleCount7d).toBe(12);
    expect(profile?.source.name).toBe("Örnek Gazete");
    expect(profile?.zoneHistory).toHaveLength(1);
    expect(profile?.zoneHistory[0]?.newBias).toBe("gov_leaning");
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
  });

  it("a cluster_articles ERROR is logged and non-fatal: flagged rows are dropped (fail closed), the profile still resolves ok", async () => {
    fixture.articles = [{ data: [DESC_ONLY_PII, POLITICAL, CLUSTERED_FLAGGED], error: null }];
    fixture.clusterArticles = [{ data: null, error: { message: "cluster_articles unavailable" } }];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile).not.toBeNull();
    // Nothing can be proven clustered, so even the (really clustered) flagged
    // row goes: failing closed beats leaking one private-individual excerpt.
    expect(profile?.articles.map((a) => a.id)).toEqual(["pol"]);
    expect(console.error).toHaveBeenCalled();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
    expect(connection).not.toHaveBeenCalled();
  });

  it("a cluster_articles read that THROWS is treated the same way (logged, flagged rows dropped, no rejection)", async () => {
    fixture.articles = [{ data: [DESC_ONLY_PII, POLITICAL], error: null }];
    fixture.clusterThrows = true;

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.articles.map((a) => a.id)).toEqual(["pol"]);
    expect(console.error).toHaveBeenCalled();
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
    expect(connection).not.toHaveBeenCalled();
  });

  it("an error from the membership read does not log a dropped row's text (ids/messages only)", async () => {
    fixture.articles = [{ data: [DESC_ONLY_PII], error: null }];
    fixture.clusterArticles = [{ data: null, error: { message: "boom" } }];

    await getSourceProfile("ornek-gazete");

    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("ZZMARKER");
    expect(logged).not.toContain("Bir ilçede eski eşine ateş açtı");
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
