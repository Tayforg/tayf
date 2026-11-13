import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FETCH_STATE_WRITE_MAX_CALLS,
  isRowScopedPgError,
} from "../../supabase/functions/ingest/fetch-state";
import { createSupabaseFake } from "../_helpers/supabase-fake";
import { miniParseRss } from "../_helpers/mini-rss-parse";

// The two sections below share one file: the pure helpers behind the batched
// fetch-state write (migration 119), and the state row ingest sends for each
// source, which since migration 212 may carry `fetch_window_overflow_at`.
// The second section runs the REAL ingest handler, so its mocks are hoisted to
// the top of the file; the pure tests do not touch them.
vi.mock("https://esm.sh/fast-xml-parser@4.5.7?deps=strnum@1.1.2", async () => {
  const { miniParseRss: parse } = await import("../_helpers/mini-rss-parse");
  return {
    XMLParser: class {
      parse(x: string) {
        return parse(x);
      }
    },
  };
});

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../../supabase/functions/_shared/supabase.ts", () => ({
  createServiceClient: () => holder.client,
}));

// ---------------------------------------------------------------------------
// Helpers behind persistSourceFetchState's bisecting retry (migration 119).
// One batched `ingest_set_source_fetch_state` write covers every source the
// cycle attempted, so one row Postgres refuses (a year-0 item date, say) fails
// the whole batch. A batch refused for a reason that belongs to a ROW's data is
// worth splitting; one refused for any other reason (a timeout, a dropped
// connection, a missing function, a permission error) would fail every half
// just the same, so splitting it only multiplies the load on a sick database.
// ---------------------------------------------------------------------------

describe("isRowScopedPgError", () => {
  it("is true for SQLSTATE class 22 (data exception): the datetime and numeric errors a bad row raises", () => {
    for (const code of ["22008", "22007", "22009", "22003", "22P02", "22001", "22000"]) {
      expect(isRowScopedPgError(code), code).toBe(true);
    }
  });

  it("is true for SQLSTATE class 23 (integrity constraint violation)", () => {
    for (const code of ["23502", "23503", "23505", "23514"]) {
      expect(isRowScopedPgError(code), code).toBe(true);
    }
  });

  it("is false for everything that would fail every half the same way", () => {
    for (const code of [
      "57014", // statement timeout
      "57P01", // admin shutdown
      "08006", // connection failure
      "53300", // too many connections
      "40001", // serialization failure
      "40P01", // deadlock
      "42883", // function does not exist
      "42703", // undefined column
      "42501", // permission denied
      "PGRST202", // PostgREST: function not found in schema cache
      "PGRST301", // PostgREST: JWT error
    ]) {
      expect(isRowScopedPgError(code), code).toBe(false);
    }
  });

  it("is false for a missing, empty, or malformed code", () => {
    for (const code of [undefined, null, "", "2", "22", "x22008", " 22008", 22008 as unknown as string]) {
      expect(isRowScopedPgError(code), String(code)).toBe(false);
    }
  });
});

describe("FETCH_STATE_WRITE_MAX_CALLS", () => {
  it("is 24: enough to isolate a couple of bad rows out of a flush (1 + 2*ceil(log2 n) calls for one), small enough to stay cheap", () => {
    expect(FETCH_STATE_WRITE_MAX_CALLS).toBe(24);
    // one bad row out of a 118-source roster costs 1 + 2*7 = 15 calls
    expect(1 + 2 * Math.ceil(Math.log2(118))).toBeLessThanOrEqual(FETCH_STATE_WRITE_MAX_CALLS);
  });
});

// ---------------------------------------------------------------------------
// fetch_window_overflow_at (migration 212, h174-latency-1).
//
// haberport's feed holds its 50 newest items and is replaced once an hour. When
// more than 50 items appear between two polls, the rest are never offered, and
// nothing recorded it. Ingest already looks up which of a poll's urls are stored
// (`lookupStoredByUrl`): a poll of a full-sized window (10 items or more) whose
// urls are ALL absent from `articles` means the window moved past the previous
// poll. That poll's state row then carries `fetch_window_overflow_at`.
//
// Same omit discipline as fetch_items_count (migration 119): the key is PRESENT
// only on an overflow poll. A normal poll, a bootstrap, a 304 and a failure OMIT
// it (never null), so the writer's coalesce keeps the last time one was seen.
//
// Harness: the REAL fetcher, normalizer and ingest handler; only the XML parser,
// the Supabase client and global fetch are faked (the shape of
// ingest-feed-freshness.test.ts), serving synthetic feeds of a chosen size.
// ---------------------------------------------------------------------------

const KEY = "test-service-role-key";
const FIXED_NOW = Date.parse("2026-10-01T00:00:00.000Z");

// Fifty distinct place names: the headlines of a synthetic feed must differ
// enough that nothing treats two of them as twins.
const PLACES = [
  "Adana", "Adıyaman", "Afyon", "Ağrı", "Aksaray", "Amasya", "Ankara", "Antalya", "Ardahan", "Artvin",
  "Aydın", "Balıkesir", "Bartın", "Batman", "Bayburt", "Bilecik", "Bingöl", "Bitlis", "Bolu", "Burdur",
  "Bursa", "Çanakkale", "Çankırı", "Çorum", "Denizli", "Diyarbakır", "Düzce", "Edirne", "Elazığ", "Erzincan",
  "Erzurum", "Eskişehir", "Gaziantep", "Giresun", "Gümüşhane", "Hakkâri", "Hatay", "Iğdır", "Isparta", "İstanbul",
  "İzmir", "Kars", "Kastamonu", "Kayseri", "Kırıkkale", "Kırklareli", "Kırşehir", "Kilis", "Kocaeli", "Konya",
];
const TEMPLATES = [
  (p: string) => `${p} belediyesi yeni yol çalışmasını duyurdu`,
  (p: string) => `${p} için kuvvetli yağış uyarısı yapıldı`,
  (p: string) => `${p} üniversitesinde bilim şenliği başladı`,
  (p: string) => `${p} sahilinde balıkçılar sezonu açtı`,
  (p: string) => `${p} deplasmanında takım üç puanı aldı`,
];

interface SyntheticFeed {
  slug: string;
  url: string;
  links: string[];
  bytes: Buffer;
  etag: string;
}

/** `segment` is the url path section of every item ("haber" by default; "ilan" makes each one a BİK notice url). */
function syntheticFeed(slug: string, n: number, segment = "haber"): SyntheticFeed {
  const origin = `https://${slug}.example`;
  const links: string[] = [];
  let items = "";
  for (let i = 0; i < n; i++) {
    const link = `${origin}/${segment}/${100_000 + i}`;
    links.push(link);
    const title = (TEMPLATES[i % TEMPLATES.length] as (p: string) => string)(PLACES[i % PLACES.length] as string);
    const minute = String(59 - (i % 60)).padStart(2, "0");
    items += `<item><title>${title}</title><link>${link}</link><pubDate>Wed, 30 Sep 2026 12:${minute}:00 +0000</pubDate></item>`;
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${slug}</title><link>${origin}/</link>${items}</channel></rss>`;
  return { slug, url: `${origin}/rss`, links, bytes: Buffer.from(xml, "utf8"), etag: `"etag-${slug}"` };
}

type SourceRec = Record<string, unknown>;
type ArticleRec = Record<string, unknown> & { url: string; source_id: string; title: string };

let sourcesTable: SourceRec[] = [];
const articlesStore = new Map<string, ArticleRec>();
let served = new Map<string, SyntheticFeed>();
let statusOverride = new Map<string, number>();
let rpcCalls: Array<Array<Record<string, unknown>>> = [];
let failUpserts = false;
let lookupFails = false;
let logLines: string[] = [];

function makeArticlesBuilder() {
  const ins: Array<{ col: string; vals: unknown[] }> = [];
  const b: Record<string, unknown> = {};
  const readResult = () => {
    const url = ins.find((c) => c.col === "url");
    if (url) {
      if (lookupFails) return { data: null, error: { message: "simulated lookup failure" } };
      const rows = (url.vals as string[])
        .map((u) => articlesStore.get(u))
        .filter((r): r is ArticleRec => r !== undefined)
        .map((r) => ({ id: r.id, url: r.url, title: r.title, source_id: r.source_id }));
      return { data: rows, error: null };
    }
    return { data: [], error: null };
  };
  Object.assign(b, {
    select: () => b,
    gte: () => b,
    in: (col: string, vals: unknown) => {
      ins.push({ col, vals: Array.isArray(vals) ? vals : [vals] });
      return b;
    },
    then: (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(readResult()).then(f, r),
    upsert: (rows: unknown) => {
      const arr = (Array.isArray(rows) ? rows : [rows]) as ArticleRec[];
      const run = () => {
        if (failUpserts) return { data: null, error: { message: "simulated upsert failure" } };
        const inserted: Array<{ id: string }> = [];
        for (const r of arr) {
          if (articlesStore.has(r.url)) continue; // ignoreDuplicates on url
          const id = `art-${articlesStore.size + 1}`;
          articlesStore.set(r.url, { ...r, id, created_at: new Date().toISOString() });
          inserted.push({ id });
        }
        return { data: inserted, error: null };
      };
      return {
        select: () => Promise.resolve(run()),
        then: (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(run()).then(f, r),
      };
    },
  });
  return b;
}

function buildClient() {
  const { client } = createSupabaseFake({
    tables: {
      sources: () => ({ data: sourcesTable.map((r) => ({ ...r })), error: null }),
    },
    rpc: {
      ingest_set_source_fetch_state: (args) => {
        const rows = (args as { p_rows?: Array<Record<string, unknown>> }).p_rows ?? [];
        rpcCalls.push(rows);
        for (const row of rows) {
          const target = sourcesTable.find((x) => x.id === row.id);
          if (!target) continue;
          const { id: _id, ...rest } = row;
          // the SQL keeps a stored column when the key is absent; so does assign
          Object.assign(target, rest);
        }
        return { data: null, error: null };
      },
      apply_article_title_edits: () => ({ data: 0, error: null }),
    },
  });
  const baseFrom = client.from;
  return {
    ...client,
    from: (table: string) => (table === "articles" ? makeArticlesBuilder() : baseFrom(table)),
  };
}

const originalFetch = globalThis.fetch;
function installFetchStub() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString()).toString();
    const headers = new Headers(init?.headers);
    for (const feed of served.values()) {
      if (url !== new URL(feed.url).toString()) continue;
      const forced = statusOverride.get(feed.slug);
      if (forced !== undefined) return new Response("nope", { status: forced });
      if (headers.get("if-none-match") === feed.etag) return new Response(null, { status: 304 });
      return new Response(new Uint8Array(feed.bytes), {
        status: 200,
        headers: { "content-type": "application/rss+xml", etag: feed.etag },
      });
    }
    throw new Error(`unexpected fetch (unknown url): ${url}`);
  }) as typeof fetch;
}

(globalThis as unknown as { Deno?: unknown }).Deno = {
  env: { get: (k: string) => process.env[k] },
  serve: (h: (req: Request) => Promise<Response> | Response) => {
    (globalThis as unknown as { __windowOverflowHandler?: unknown }).__windowOverflowHandler = h;
    return { finished: Promise.resolve() };
  },
  resolveDns: async (_host: string, type: string) => {
    if (type === "A") return ["93.184.215.14"];
    throw new Error("NotFound");
  },
};

async function loadHandler(): Promise<void> {
  vi.resetModules();
  await import("../../supabase/functions/ingest/index.ts");
}

async function cycle(): Promise<Record<string, unknown>> {
  const handler = (globalThis as unknown as {
    __windowOverflowHandler: (req: Request) => Promise<Response>;
  }).__windowOverflowHandler;
  const res = await handler(
    new Request("http://localhost/ingest", { method: "POST", headers: { Authorization: `Bearer ${KEY}` } }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** Adds one source row and serves a synthetic feed of `n` items for it. */
function seedFeed(
  slug: string,
  n: number,
  opts: { itemsCount?: number | null; overflowAt?: string | null; segment?: string } = {},
): SyntheticFeed {
  const feed = syntheticFeed(slug, n, opts.segment);
  served.set(slug, feed);
  sourcesTable.push({
    id: `src-${slug}`,
    name: slug,
    slug,
    url: new URL(feed.url).origin,
    rss_url: feed.url,
    active: true,
    fetch_etag: null,
    fetch_last_modified: null,
    fetch_body_hash: null,
    fetch_last_status: null,
    fetch_last_at: null,
    fetch_fail_streak: 0,
    fetch_quarantined_until: null,
    // measured before unless a test says otherwise: not a bootstrap poll
    fetch_items_count: opts.itemsCount === undefined ? n : opts.itemsCount,
    fetch_newest_item_at: null,
    ...(opts.overflowAt === undefined ? {} : { fetch_window_overflow_at: opts.overflowAt }),
  });
  return feed;
}

function row(slug: string): SourceRec {
  const r = sourcesTable.find((x) => x.slug === slug);
  if (!r) throw new Error("source row missing");
  return r;
}

function lastRpcRow(slug: string): Record<string, unknown> {
  const rows = rpcCalls.flat().filter((r) => r.id === `src-${slug}`);
  const last = rows[rows.length - 1];
  if (!last) throw new Error(`no RPC row for ${slug}`);
  return last;
}

/** The next cycle starts on a cold isolate (empty conditional cache) with no validators stored: a full parse. */
async function coldIsolateWithoutValidators(slug: string): Promise<void> {
  await loadHandler();
  const r = row(slug);
  r.fetch_etag = null;
  r.fetch_last_modified = null;
  r.fetch_body_hash = null;
  rpcCalls = [];
}

beforeEach(async () => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
  delete process.env.INGEST_MAX_PARSES_PER_CYCLE;
  articlesStore.clear();
  served = new Map();
  statusOverride = new Map();
  rpcCalls = [];
  failUpserts = false;
  lookupFails = false;
  logLines = [];
  sourcesTable = [];
  holder.client = buildClient();
  vi.spyOn(Date, "now").mockImplementation(() => FIXED_NOW);
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  installFetchStub();
  await loadHandler();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("ingest state row: fetch_window_overflow_at (migration 212)", () => {
  it("sanity: the synthetic harness parses and inserts a feed (a bootstrap of 20 items)", async () => {
    seedFeed("sanity", 20, { itemsCount: null });
    const c = await cycle();
    expect(c.fetched).toBe(1);
    expect(c.inserted).toBeGreaterThan(0);
    expect(articlesStore.size).toBeGreaterThan(0);
    expect(miniParseRss(syntheticFeed("x", 3).bytes.toString("utf8"))).toBeTruthy();
  });

  it("an overflow poll (a full window, none of it stored) carries fetch_window_overflow_at, as a timestamp ingest just took", async () => {
    seedFeed("haberport", 50);
    const before = new Date().getTime();

    const c = await cycle();

    const after = new Date().getTime();
    const sent = lastRpcRow("haberport");
    expect(typeof sent.fetch_window_overflow_at).toBe("string");
    const at = Date.parse(sent.fetch_window_overflow_at as string);
    expect(Number.isNaN(at)).toBe(false);
    expect(new Date(at).toISOString()).toBe(sent.fetch_window_overflow_at);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    expect(c.windowOverflows).toBe(1);
    // the fake writer applied it, as the SQL coalesce does for a present key
    expect(row("haberport").fetch_window_overflow_at).toBe(sent.fetch_window_overflow_at);
    // the rest of the state row is the ordinary one
    expect(sent.fetch_items_count).toBe(50);
    expect(sent.fetch_last_status).toBe(200);
  });

  it("logs the slug and the count, never a url or a headline", async () => {
    const feed = seedFeed("haberport", 50);
    await cycle();
    const lines = logLines.filter((l) => l.includes("feed window overflow"));
    expect(lines).toEqual(["[ingest] haberport: feed window overflow (50 items, none stored before)"]);
    const everything = logLines.join("\n");
    expect(everything).not.toContain(feed.links[0] as string);
    for (const place of ["Adana", "Bursa", "Konya"]) expect(everything).not.toContain(place);
  });

  it("a normal poll OMITS the key (not null) and the stored time survives", async () => {
    const earlier = "2026-11-12T09:03:00.000Z";
    seedFeed("haberport", 50, { itemsCount: null });
    await cycle(); // a bootstrap: inserts all 50, flags nothing
    row("haberport").fetch_window_overflow_at = earlier;
    await coldIsolateWithoutValidators("haberport");

    const c = await cycle(); // a full parse again, every url stored now

    expect(c.fetched).toBe(1);
    expect(c.itemsKnownSkipped).toBeGreaterThan(0);
    expect(c.windowOverflows).toBe(0);
    const sent = lastRpcRow("haberport");
    expect("fetch_window_overflow_at" in sent).toBe(false);
    expect(row("haberport").fetch_window_overflow_at).toBe(earlier);
  });

  it("one stored item of another source, under another headline, is enough overlap: no flag", async () => {
    const feed = seedFeed("haberport", 50);
    articlesStore.set(feed.links[7] as string, {
      url: feed.links[7] as string,
      source_id: "src-baska-kaynak",
      title: "Bambaşka bir başlık",
      id: "art-0",
    });

    const c = await cycle();

    expect(c.windowOverflows).toBe(0);
    expect("fetch_window_overflow_at" in lastRpcRow("haberport")).toBe(false);
  });

  it("a window under 10 items proves nothing (9 items, none stored: omitted); 10 is the smallest that flags", async () => {
    seedFeed("dokuz", 9);
    seedFeed("on", 10);

    const c = await cycle();

    expect("fetch_window_overflow_at" in lastRpcRow("dokuz")).toBe(false);
    expect(typeof lastRpcRow("on").fetch_window_overflow_at).toBe("string");
    expect(c.windowOverflows).toBe(1);
  });

  it("a bootstrap poll (fetch_items_count still NULL) of a full window with nothing stored is not an overflow", async () => {
    seedFeed("haberport", 50, { itemsCount: null });

    const c = await cycle();

    expect(c.freshnessBootstraps).toBe(1);
    expect(c.windowOverflows).toBe(0);
    expect("fetch_window_overflow_at" in lastRpcRow("haberport")).toBe(false);
  });

  it("a failed stored-url lookup proves nothing: no flag", async () => {
    seedFeed("haberport", 50);
    lookupFails = true;

    const c = await cycle();

    expect(c.knownUrlLookupErrors).toBe(1);
    expect(c.windowOverflows).toBe(0);
    expect("fetch_window_overflow_at" in lastRpcRow("haberport")).toBe(false);
  });

  it("a 304 sends no key and the stored time survives", async () => {
    seedFeed("haberport", 50);
    await cycle(); // an overflow poll: the key is set and the validators are committed
    const stamped = row("haberport").fetch_window_overflow_at;
    expect(typeof stamped).toBe("string");

    rpcCalls = [];
    const c = await cycle(); // same isolate: If-None-Match -> 304

    expect(c.notModified).toBe(1);
    const sent = lastRpcRow("haberport");
    expect(sent.fetch_last_status).toBe(304);
    expect("fetch_window_overflow_at" in sent).toBe(false);
    expect(row("haberport").fetch_window_overflow_at).toBe(stamped);
  });

  it("an HTTP failure sends no key and the stored time survives", async () => {
    const earlier = "2026-11-12T09:03:00.000Z";
    seedFeed("haberport", 50, { overflowAt: earlier });
    statusOverride.set("haberport", 503);

    const c = await cycle();

    expect(c.failed).toBe(1);
    const sent = lastRpcRow("haberport");
    expect(sent.fetch_last_status).toBe(503);
    expect("fetch_window_overflow_at" in sent).toBe(false);
    expect(row("haberport").fetch_window_overflow_at).toBe(earlier);
    expect(c.windowOverflows).toBe(0);
  });

  it("the overflow is a fact about the feed, not about row durability: a poll whose rows failed (validators withheld) still carries it", async () => {
    seedFeed("haberport", 50);
    failUpserts = true;

    const c = await cycle();

    expect(c.validatorsWithheld).toBe(1);
    const sent = lastRpcRow("haberport");
    expect(sent.fetch_etag).toBeNull(); // validators withheld: the old (null) values
    expect(typeof sent.fetch_window_overflow_at).toBe("string");
    expect(c.windowOverflows).toBe(1);
  });

  it("a feed whose whole window is legal-notice urls (nothing inserted, the pushed === 0 branch) still stamps the overflow and saves the fresh validators at once", async () => {
    // 12 absent urls under /ilan/ (a BİK notice section): prepared >= 10 and none stored before, so the window
    // overflowed; completeItem then drops every one as a notice, so no row is pushed and ingest takes the
    // "nothing to lose" branch, which must forward the time like the settled and the withheld paths do.
    const feed = seedFeed("ilanci", 12, { segment: "ilan" }); // fetch_items_count non-null: not a bootstrap

    const c = await cycle();

    const sent = lastRpcRow("ilanci");
    // (1) the stamp is a timestamp ingest just took, and it round-trips through Date
    expect(typeof sent.fetch_window_overflow_at).toBe("string");
    expect(new Date(sent.fetch_window_overflow_at as string).toISOString()).toBe(sent.fetch_window_overflow_at);
    // (2) no row of the feed was inserted: every url was dropped as a notice
    for (const link of feed.links) expect(articlesStore.has(link)).toBe(false);
    expect(articlesStore.size).toBe(0);
    // (3) the cycle counter
    expect(c.windowOverflows).toBe(1);
    // (4) the fresh validators went out in this very write: the pushed === 0 branch, not the withheld
    // (etag null) or the deferred path
    expect(sent.fetch_etag).toBe(feed.etag);
    expect(sent.fetch_etag).toBe('"etag-ilanci"');
    expect(row("ilanci").fetch_window_overflow_at).toBe(sent.fetch_window_overflow_at);
  });

  it("only the overflowing source's row carries the key when several sources are polled in one cycle", async () => {
    seedFeed("tasan", 50);
    seedFeed("sakin", 5);
    const feed = seedFeed("ortusen", 30);
    articlesStore.set(feed.links[0] as string, {
      url: feed.links[0] as string,
      source_id: "src-ortusen",
      title: "baska",
      id: "art-0",
    });

    const c = await cycle();

    expect(typeof lastRpcRow("tasan").fetch_window_overflow_at).toBe("string");
    expect("fetch_window_overflow_at" in lastRpcRow("sakin")).toBe(false);
    expect("fetch_window_overflow_at" in lastRpcRow("ortusen")).toBe(false);
    expect(c.windowOverflows).toBe(1);
  });
});
