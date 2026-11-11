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
import { toFeedStatusRows } from "./feed-status";
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

  // h122-sourcepages-3: a failed history read used to look exactly like an empty
  // history, so the card printed "Bu etiket hiç değişmedi." for a table that
  // could not be read. The read still never fails the profile and is still
  // logged, but the profile now says the history is unavailable.
  it("a zone-history error sets historyUnavailable, with zoneHistory [] and the failure still logged", async () => {
    fixture.history = [
      { data: null, error: { message: "history table unavailable" } },
    ];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.historyUnavailable).toBe(true);
    expect(profile?.zoneHistory).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      "[source-profile] zone history query failed",
      expect.objectContaining({ message: "history table unavailable" }),
    );
  });

  it("a successful history read is not unavailable, with rows or without (an empty table is an honest empty history)", async () => {
    const withRows = await getSourceProfile("ornek-gazete");
    expect(withRows?.historyUnavailable).toBe(false);
    expect(withRows?.zoneHistory).toHaveLength(1);

    fixture.history = [{ data: [], error: null }];
    fixture.served = { sources: 0, count: 0, articles: 0, history: 0, clusterArticles: 0 };
    const empty = await getSourceProfile("ornek-gazete");
    expect(empty?.historyUnavailable).toBe(false);
    expect(empty?.zoneHistory).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("a null history payload without an error reads as an empty, available history", async () => {
    fixture.history = [{ data: null, error: null }];
    const profile = await getSourceProfile("ornek-gazete");
    expect(profile?.historyUnavailable).toBe(false);
    expect(profile?.zoneHistory).toEqual([]);
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

// h74-sourcepages-3: a third source state next to inactive and feedDown. The feed
// answers (2xx or 304, no failure streak, not quarantined) but is frozen: it
// holds no items or its newest item is older than 72 h. The verdict is
// `classifySilence` of silence-reason.ts (the rule /kaynaklar/durum labels
// 'akış donmuş' with), decided with the same `nowMs` as the quarantine verdict.
describe("getSourceProfile frozen feed (h74-sourcepages-3)", () => {
  const NOW = Date.parse("2026-11-07T16:28:00.000Z");
  const HOUR = 60 * 60 * 1000;
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A source row carrying the four feed columns; `over` overrides any of them. */
  const withFeed = (over: Record<string, unknown>) => {
    fixture.sources = [
      {
        data: [
          {
            ...SOURCE_ROW,
            fetch_quarantined_until: null,
            fetch_last_status: 200,
            fetch_fail_streak: 0,
            fetch_newest_item_at: iso(10 * HOUR),
            fetch_items_count: 20,
            ...over,
          },
        ],
        error: null,
      },
    ];
    fixture.served = { sources: 0, count: 0, articles: 0, history: 0, clusterArticles: 0 };
  };

  it("selects the four feed columns feed-status.ts reads", async () => {
    await getSourceProfile("ornek-gazete");

    const cols = (fixture.sourceSelects[0] ?? "").split(",").map((c) => c.trim());
    for (const c of [
      "fetch_last_status",
      "fetch_fail_streak",
      "fetch_newest_item_at",
      "fetch_items_count",
    ]) {
      expect(cols).toContain(c);
    }
    // The quarantine column stays selected.
    expect(cols).toContain("fetch_quarantined_until");
  });

  it("answering feed (200, streak 0, not quarantined) whose newest item is 5 days old is frozen, newest passed through", async () => {
    const newest = iso(5 * 24 * HOUR);
    withFeed({ fetch_newest_item_at: newest });

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.feedFrozen).toBe(true);
    expect(profile?.newestFeedItemAt).toBe(newest);
    expect(profile?.quarantined).toBe(false);
  });

  it("a 304 with an empty feed (fetch_items_count 0) is frozen, with no newest date", async () => {
    withFeed({ fetch_last_status: 304, fetch_items_count: 0, fetch_newest_item_at: null });

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.feedFrozen).toBe(true);
    expect(profile?.newestFeedItemAt).toBeNull();
  });

  it("a newest item 10 h old is not frozen", async () => {
    withFeed({ fetch_newest_item_at: iso(10 * HOUR) });

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.feedFrozen).toBe(false);
    expect(profile?.newestFeedItemAt).toBe(iso(10 * HOUR));
  });

  it("the 72 h edge is strict: exactly 72 h old is not frozen, one millisecond older is", async () => {
    withFeed({ fetch_newest_item_at: iso(72 * HOUR) });
    expect((await getSourceProfile("ornek-gazete"))?.feedFrozen).toBe(false);

    withFeed({ fetch_newest_item_at: iso(72 * HOUR + 1) });
    expect((await getSourceProfile("ornek-gazete"))?.feedFrozen).toBe(true);
  });

  // The status page only labels a source silent when its newest STORED article
  // (published_at <= now) is missing or older than FEED_YIELD_WINDOW_MS, and only a
  // silent source is classified at all. The profile applies the same gate, so a
  // feed that looks frozen on its own columns but still delivers stored articles
  // is not 'akış donmuş' here either.
  const storedArticle = (msAgo: number) => ({
    id: "a-stored",
    title: "Haber",
    description: null,
    url: "https://ornek.example/stored",
    image_url: null,
    published_at: iso(msAgo),
  });

  it("an empty feed (0 items, no newest date) is not frozen while a stored article is 2 h old", async () => {
    withFeed({ fetch_items_count: 0, fetch_newest_item_at: null });
    fixture.articles = [{ data: [storedArticle(2 * HOUR)], error: null }];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.feedFrozen).toBe(false);
  });

  it("a newest feed item 5 days old: frozen only once the newest stored article is past 72 h", async () => {
    withFeed({ fetch_newest_item_at: iso(5 * 24 * HOUR) });

    fixture.articles = [{ data: [storedArticle(71 * HOUR)], error: null }];
    expect((await getSourceProfile("ornek-gazete"))?.feedFrozen).toBe(false);

    fixture.articles = [{ data: [storedArticle(73 * HOUR)], error: null }];
    expect((await getSourceProfile("ornek-gazete"))?.feedFrozen).toBe(true);
  });

  it("the stored-article edge is strict: exactly 72 h old still delivers, one millisecond older is silent", async () => {
    withFeed({ fetch_newest_item_at: iso(5 * 24 * HOUR) });

    fixture.articles = [{ data: [storedArticle(72 * HOUR)], error: null }];
    expect((await getSourceProfile("ornek-gazete"))?.feedFrozen).toBe(false);

    fixture.articles = [{ data: [storedArticle(72 * HOUR + 1)], error: null }];
    expect((await getSourceProfile("ornek-gazete"))?.feedFrozen).toBe(true);
  });

  it("a future-dated stored article does not count as delivering (mirrors the status page's .lte now)", async () => {
    withFeed({ fetch_newest_item_at: iso(5 * 24 * HOUR) });
    fixture.articles = [{ data: [storedArticle(-HOUR)], error: null }];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.feedFrozen).toBe(true);
  });

  it("skips a future-dated row and reads the newest past one: a 2 h old article behind it still delivers", async () => {
    withFeed({ fetch_newest_item_at: iso(5 * 24 * HOUR) });
    fixture.articles = [
      { data: [storedArticle(-HOUR), storedArticle(2 * HOUR)], error: null },
    ];

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.feedFrozen).toBe(false);
  });

  it("a quarantined source is not frozen (feedDown wins), however old its newest item", async () => {
    withFeed({
      fetch_quarantined_until: new Date(NOW + HOUR).toISOString(),
      fetch_newest_item_at: iso(5 * 24 * HOUR),
    });

    const profile = await getSourceProfile("ornek-gazete");

    expect(profile?.quarantined).toBe(true);
    expect(profile?.feedFrozen).toBe(false);
  });

  it("an unreachable feed is not frozen: a failure streak, a 403, status 0 and a never-fetched source are 'erişim yok'", async () => {
    for (const over of [
      { fetch_fail_streak: 3 },
      { fetch_last_status: 403 },
      { fetch_last_status: 0 },
      { fetch_last_status: null },
    ]) {
      withFeed({ ...over, fetch_newest_item_at: iso(5 * 24 * HOUR) });
      expect((await getSourceProfile("ornek-gazete"))?.feedFrozen).toBe(false);
    }
  });

  it("a row without the feed columns (undefined) or never measured (null count and date) is not frozen", async () => {
    // Pre-119 shape: the columns are absent. The status is unknown, so never frozen.
    fixture.sources = [{ data: [{ ...SOURCE_ROW }], error: null }];
    const bare = await getSourceProfile("ornek-gazete");
    expect(bare?.feedFrozen).toBe(false);
    expect(bare?.newestFeedItemAt).toBeNull();

    // Reachable but never measured: 'sessiz', not frozen.
    withFeed({ fetch_newest_item_at: null, fetch_items_count: null });
    const unmeasured = await getSourceProfile("ornek-gazete");
    expect(unmeasured?.feedFrozen).toBe(false);
    expect(unmeasured?.newestFeedItemAt).toBeNull();
  });

  it("agrees with /kaynaklar/durum: the same row is 'akis_donmus' there exactly when feedFrozen here", async () => {
    const rows: Record<string, unknown>[] = [
      { fetch_newest_item_at: iso(5 * 24 * HOUR) },
      { fetch_newest_item_at: iso(10 * HOUR) },
      { fetch_last_status: 304, fetch_items_count: 0, fetch_newest_item_at: null },
      { fetch_newest_item_at: iso(72 * HOUR) },
      { fetch_newest_item_at: iso(72 * HOUR + 1) },
      { fetch_fail_streak: 2, fetch_newest_item_at: iso(5 * 24 * HOUR) },
      { fetch_last_status: 503, fetch_newest_item_at: iso(5 * 24 * HOUR) },
      { fetch_quarantined_until: new Date(NOW + HOUR).toISOString(), fetch_items_count: 0 },
      { fetch_items_count: null, fetch_newest_item_at: null },
    ];
    // Both stored-article situations: none at all (the source reads as silent on
    // the status page, which is when it shows a reason), and one delivered 2 h ago
    // (not silent there: no reason, so never 'akış donmuş').
    const situations: { name: string; latest: { published_at: string }[] }[] = [
      { name: "no stored article", latest: [] },
      { name: "stored article 2 h old", latest: [{ published_at: iso(2 * HOUR) }] },
    ];
    for (const over of rows) {
      for (const situation of situations) {
        withFeed(over);
        fixture.articles = [
          {
            data: situation.latest.map((l) => ({
              id: "a-parity",
              title: "Haber",
              description: null,
              url: "https://ornek.example/parity",
              image_url: null,
              published_at: l.published_at,
            })),
            error: null,
          },
        ];
        const profile = await getSourceProfile("ornek-gazete");
        const durum = toFeedStatusRows(
          [
            {
              slug: "ornek-gazete",
              name: "Örnek Gazete",
              bias: "center",
              kind: "outlet",
              fetch_last_status: 200,
              fetch_last_at: null,
              fetch_fail_streak: 0,
              fetch_quarantined_until: null,
              fetch_newest_item_at: iso(10 * HOUR),
              fetch_items_count: 20,
              ...over,
              latest: situation.latest,
            },
          ],
          NOW,
        )[0];
        expect(
          profile?.feedFrozen,
          `${situation.name}: ${JSON.stringify(over)}`,
        ).toBe(durum?.silenceReason === "akis_donmus");
      }
    }
  });

  it("reuses the shared frozen-feed rule instead of keeping its own threshold", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const code = readFileSync(resolve(here, "source-profile-query.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

    expect(code).toMatch(/\bclassifySilence\(/);
    expect(code).toMatch(/["']akis_donmus["']/);
    // No private 72 h arithmetic: the threshold lives in silence-reason.ts.
    expect(code).not.toMatch(/\b72\b/);
    expect(code).not.toMatch(/\bFROZEN_FEED_MS\b/);
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
