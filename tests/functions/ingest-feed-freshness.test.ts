import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSupabaseFake } from "../_helpers/supabase-fake";
import { miniParseRss } from "../_helpers/mini-rss-parse";

// ---------------------------------------------------------------------------
// feed-freshness (migration 119): ingest stores what each feed reports about
// itself -- the newest item date and the item count -- on `sources`
// (fetch_newest_item_at, fetch_items_count), so a FROZEN feed (HTTP 200, same
// newest item for days) can be told apart from a quiet outlet and from a
// blocked one.
//
// The catch these tests pin: a frozen feed with a byte-identical body is never
// parsed again (the body-hash short-circuit and the etag 304 both return
// notModified), so the very sources this targets would keep fetch_items_count
// NULL forever. A source whose fetch_items_count is NULL is therefore
// BOOTSTRAPPED once: no conditional request, no body-hash short-circuit, one
// parse; when its body is the one already stored, no row is inserted.
//
// Harness: copied from ingest-silent-feeds.test.ts (the REAL fetcher,
// normalizer and ingest handler; only the XML parser, the Supabase client and
// global fetch are faked, driven by the captured fixtures in tests/fixtures/
// feeds). The fetch stub here serves several fixtures at once and can answer a
// chosen status; the sources fake can answer 42703 to a select that names the
// new columns. Date.now is pinned so the fixture dates (2026-09) are never in
// the future.
// ---------------------------------------------------------------------------

vi.mock("https://esm.sh/fast-xml-parser@4.5.0", async () => {
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

// A test can make computeFeedFreshness return a chosen value, to prove that the
// ingest still refuses to send an out-of-range date when the helper does not.
const freshnessOverride = vi.hoisted(() => ({
  value: null as null | { newestItemAt: string | null; itemsCount: number },
}));
vi.mock("../../supabase/functions/_shared/rss/feed-freshness.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../supabase/functions/_shared/rss/feed-freshness")>();
  return {
    ...real,
    computeFeedFreshness: (...args: Parameters<typeof real.computeFeedFreshness>) =>
      freshnessOverride.value ?? real.computeFeedFreshness(...args),
  };
});
vi.mock("../../supabase/functions/_shared/supabase.ts", () => ({
  createServiceClient: () => holder.client,
}));

const KEY = "test-service-role-key";
const FIXED_NOW = Date.parse("2026-10-01T00:00:00.000Z");

// Hand-computed from the captured XML (raw item count, newest item date in UTC).
const IKLIM = { slug: "iklim-haber", items: 10, newest: "2026-09-28T11:04:44.000Z" }; // Mon, 28 Sep 2026 11:04:44 +0000
const THA = { slug: "turkiye-haber-ajansi", items: 20, newest: "2026-09-28T16:09:34.000Z" }; // Mon, 28 Sep 2026 19:09:34 +0300
const NEWSLAB = { slug: "newslab-turkey", items: 12, newest: "2026-09-27T00:01:41.000Z" }; // Sun, 27 Sep 2026 00:01:41 +0000

interface Fixture {
  slug: string;
  rssUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  etag: string | null;
  lastModified: string | null;
  capturedAt: string;
}

interface Loaded {
  fx: Fixture;
  bytes: Buffer;
  sha: string;
  expected: number;
}

const FIXTURE_DIR = resolve(__dirname, "..", "fixtures", "feeds");
function loadFixture(slug: string): Loaded {
  const fx = JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${slug}.json`), "utf8")) as Fixture;
  const bytes = readFileSync(resolve(FIXTURE_DIR, `${slug}.xml`));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const parsed = miniParseRss(bytes.toString("utf8")) as {
    rss: { channel: { item: Array<{ title?: string; link?: string }> } };
  };
  const good = parsed.rss.channel.item.filter((i) => i.title && i.link);
  return { fx, bytes, sha, expected: good.length };
}

type SourceRec = Record<string, unknown>;
type ArticleRec = Record<string, unknown> & { url: string; source_id: string; content_hash: string; title: string };

let sourcesTable: SourceRec[] = [];
const articlesStore = new Map<string, ArticleRec>();
let failUpserts = false;
let legacyOnly = false;
let rpcCalls: Array<{ name: string; rows: Array<Record<string, unknown>> }> = [];
let fetchLog: Array<{ url: string; inm: string | null; ims: string | null }> = [];
let selectLog: string[] = [];
let served = new Map<string, Loaded>();
let statusOverride = new Map<string, number>();
// Fetch-state RPC fault injection. A batch that holds a poisoned source id is
// refused whole with a data exception (SQLSTATE 22008), like Postgres refuses a
// year-0 timestamp in jsonb_to_recordset; `rpcMode` makes EVERY call fail in a
// way that is not about a row's data.
let rpcPoison = new Set<string>();
let rpcMode: "ok" | "timeout" | "throw" = "ok";

function makeArticlesBuilder() {
  const ins: Array<{ col: string; vals: unknown[] }> = [];
  const gtes: Array<{ col: string; val: unknown }> = [];
  const b: Record<string, unknown> = {};
  const readResult = () => {
    const keyIn = ins.find((c) => c.col === "source_article_key");
    if (keyIn) {
      const sidIn = ins.find((c) => c.col === "source_id");
      const since = gtes.find((g) => g.col === "created_at")?.val;
      const sinceMs = typeof since === "string" ? Date.parse(since) : Number.NEGATIVE_INFINITY;
      const rows = [...articlesStore.values()]
        .filter(
          (r) =>
            (sidIn?.vals ?? []).includes(r.source_id) &&
            typeof r.source_article_key === "string" &&
            keyIn.vals.includes(r.source_article_key) &&
            Date.parse(String(r.created_at)) >= sinceMs,
        )
        .map((r) => ({
          id: r.id,
          url: r.url,
          title: r.title,
          source_id: r.source_id,
          source_article_key: r.source_article_key,
          created_at: r.created_at,
        }));
      return { data: rows, error: null };
    }
    const url = ins.find((c) => c.col === "url");
    if (url) {
      const rows = (url.vals as string[])
        .map((u) => articlesStore.get(u))
        .filter((r): r is ArticleRec => r !== undefined)
        .map((r) => ({ id: r.id, url: r.url, title: r.title, source_id: r.source_id }));
      return { data: rows, error: null };
    }
    const sid = ins.find((c) => c.col === "source_id");
    const hash = ins.find((c) => c.col === "content_hash");
    if (sid && hash) {
      const rows = [...articlesStore.values()]
        .filter((r) => sid.vals.includes(r.source_id) && hash.vals.includes(r.content_hash))
        .map((r) => ({ source_id: r.source_id, content_hash: r.content_hash }));
      return { data: rows, error: null };
    }
    return { data: [], error: null };
  };
  Object.assign(b, {
    select: () => b,
    gte: (col: string, val: unknown) => {
      gtes.push({ col, val });
      return b;
    },
    in: (col: string, vals: unknown) => {
      ins.push({ col, vals: Array.isArray(vals) ? vals : [vals] });
      return b;
    },
    then: (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
      Promise.resolve(readResult()).then(f, r),
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
        then: (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(f, r),
      };
    },
  });
  return b;
}

function buildClient() {
  const { client } = createSupabaseFake({
    tables: {
      sources: (state) => {
        const select = String(state.selectArgs[0] ?? "");
        selectLog.push(select);
        if (legacyOnly && select.includes("fetch_items_count")) {
          // PostgREST answer for an unknown column (migration 119 not applied yet)
          return {
            data: null,
            error: { message: "column sources.fetch_items_count does not exist", code: "42703" } as { message: string },
          };
        }
        return { data: sourcesTable.map((r) => ({ ...r })), error: null };
      },
    },
    rpc: {
      ingest_set_source_fetch_state: (args) => {
        const rows = ((args as { p_rows?: Array<Record<string, unknown>> }).p_rows ?? []);
        rpcCalls.push({ name: "ingest_set_source_fetch_state", rows });
        if (rpcMode === "throw") throw new Error("fetch failed (network down)");
        if (rpcMode === "timeout") {
          return { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } as { message: string } };
        }
        if (rows.some((r) => rpcPoison.has(String(r.id)))) {
          return {
            data: null,
            error: { message: 'date/time field value out of range: "0000-01-01T00:00:00.000Z"', code: "22008" } as { message: string },
          };
        }
        for (const row of rows) {
          const target = sourcesTable.find((s) => s.id === row.id);
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
    fetchLog.push({ url, inm: headers.get("if-none-match"), ims: headers.get("if-modified-since") });
    for (const { fx, bytes } of served.values()) {
      const rss = new URL(fx.rssUrl).toString();
      const fin = new URL(fx.finalUrl).toString();
      if (url === rss && rss !== fin) {
        return new Response(null, { status: 301, headers: { location: fx.finalUrl } });
      }
      if (url !== fin) continue;
      const forced = statusOverride.get(fx.slug);
      if (forced !== undefined) {
        if (forced === 200) {
          return new Response("<html><body>blocked page</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("nope", { status: forced });
      }
      const inm = headers.get("if-none-match");
      const ims = headers.get("if-modified-since");
      if ((fx.etag && inm === fx.etag) || (fx.lastModified && ims === fx.lastModified)) {
        return new Response(null, { status: 304 });
      }
      const h: Record<string, string> = { "content-type": fx.contentType };
      if (fx.etag) h.etag = fx.etag;
      if (fx.lastModified) h["last-modified"] = fx.lastModified;
      return new Response(new Uint8Array(bytes), { status: 200, headers: h });
    }
    throw new Error(`unexpected fetch (unknown url): ${url}`);
  }) as typeof fetch;
}

(globalThis as unknown as { Deno?: unknown }).Deno = {
  env: { get: (k: string) => process.env[k] },
  serve: (h: (req: Request) => Promise<Response> | Response) => {
    (globalThis as unknown as { __feedFreshnessHandler?: unknown }).__feedFreshnessHandler = h;
    return { finished: Promise.resolve() };
  },
  resolveDns: async (_host: string, type: string) => {
    if (type === "A") return ["93.184.215.14"];
    throw new Error("NotFound");
  },
};

async function loadHandler(): Promise<void> {
  await import("../../supabase/functions/ingest/index.ts");
}

async function cycle(): Promise<Record<string, unknown>> {
  const handler = (globalThis as unknown as {
    __feedFreshnessHandler: (req: Request) => Promise<Response>;
  }).__feedFreshnessHandler;
  const res = await handler(
    new Request("http://localhost/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}` },
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

interface SeedOpts {
  etag?: string | null;
  bodyHash?: string | null;
  /** Default null: the column exists (119 applied) but the feed was never measured. */
  itemsCount?: number | null;
  newest?: string | null;
  status?: number | null;
  /** A pre-119 row: neither fetch_items_count nor fetch_newest_item_at is present. */
  legacy?: boolean;
}

/** Adds one source row (and serves its fixture). */
function seed(slug: string, opts: SeedOpts = {}): Loaded {
  const loaded = loadFixture(slug);
  served.set(slug, loaded);
  const rec: SourceRec = {
    id: `src-${slug}`,
    name: slug,
    slug,
    url: new URL(loaded.fx.finalUrl).origin,
    rss_url: loaded.fx.rssUrl,
    active: true,
    fetch_etag: opts.etag ?? null,
    fetch_last_modified: null,
    fetch_body_hash: opts.bodyHash ?? null,
    fetch_last_status: opts.status ?? null,
    fetch_last_at: null,
    fetch_fail_streak: 0,
    fetch_quarantined_until: null,
  };
  if (!opts.legacy) {
    rec.fetch_items_count = opts.itemsCount ?? null;
    rec.fetch_newest_item_at = opts.newest ?? null;
  }
  sourcesTable.push(rec);
  return loaded;
}

function row(slug: string): SourceRec {
  const r = sourcesTable.find((s) => s.slug === slug);
  if (!r) throw new Error("source row missing");
  return r;
}
function rpcRows(slug: string): Array<Record<string, unknown>> {
  return rpcCalls.flatMap((c) => c.rows).filter((r) => r.id === `src-${slug}`);
}
function lastRpcRow(slug: string): Record<string, unknown> {
  const rows = rpcRows(slug);
  const last = rows[rows.length - 1];
  if (!last) throw new Error(`no RPC row for ${slug}`);
  return last;
}
function fetchesOf(fx: Fixture): Array<{ url: string; inm: string | null; ims: string | null }> {
  const fin = new URL(fx.finalUrl).toString();
  return fetchLog.filter((f) => f.url === fin);
}

beforeEach(async () => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
  delete process.env.INGEST_MAX_PARSES_PER_CYCLE;
  articlesStore.clear();
  failUpserts = false;
  legacyOnly = false;
  rpcCalls = [];
  fetchLog = [];
  selectLog = [];
  served = new Map();
  statusOverride = new Map();
  rpcPoison = new Set();
  rpcMode = "ok";
  freshnessOverride.value = null;
  sourcesTable = [];
  holder.client = buildClient();
  vi.spyOn(Date, "now").mockImplementation(() => FIXED_NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  installFetchStub();
  vi.resetModules();
  await loadHandler();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.INGEST_MAX_PARSES_PER_CYCLE;
  vi.restoreAllMocks();
});

describe("ingest feed freshness (the RPC row carries what the feed reported)", () => {
  it("cycle 1 writes the item count and the newest item date; cycle 2 (a 304) sends neither key and the stored values survive", async () => {
    const { fx, expected } = seed(IKLIM.slug); // fetch_items_count null: first sight of the feed

    const a = await cycle();
    expect(a.inserted).toBe(expected);
    const first = lastRpcRow(IKLIM.slug);
    expect(first.fetch_items_count).toBe(IKLIM.items);
    expect(first.fetch_newest_item_at).toBe(IKLIM.newest);
    expect(first.fetch_etag).toBe(fx.etag);
    expect(row(IKLIM.slug).fetch_items_count).toBe(IKLIM.items);
    expect(row(IKLIM.slug).fetch_newest_item_at).toBe(IKLIM.newest);

    rpcCalls = [];
    const b = await cycle();
    expect(b.notModified).toBe(1);
    expect(b.inserted).toBe(0);
    const second = lastRpcRow(IKLIM.slug);
    expect(second.fetch_last_status).toBe(304);
    expect("fetch_items_count" in second).toBe(false);
    expect("fetch_newest_item_at" in second).toBe(false);
    expect(row(IKLIM.slug).fetch_items_count).toBe(IKLIM.items);
    expect(row(IKLIM.slug).fetch_newest_item_at).toBe(IKLIM.newest);
  });

  it("a zone-less / +0300 feed date is stored in UTC (turkiye-haber-ajansi: 19:09:34 +0300 -> 16:09:34Z)", async () => {
    seed(THA.slug);
    await cycle();
    const sent = lastRpcRow(THA.slug);
    expect(sent.fetch_items_count).toBe(THA.items);
    expect(sent.fetch_newest_item_at).toBe(THA.newest);
  });

  it("the freshness is the raw item date, not a clamped or fallback one: it equals the feed's own newest date", async () => {
    seed(NEWSLAB.slug);
    await cycle();
    expect(lastRpcRow(NEWSLAB.slug).fetch_newest_item_at).toBe(NEWSLAB.newest);
    expect(lastRpcRow(NEWSLAB.slug).fetch_items_count).toBe(NEWSLAB.items);
  });

  it("freshness describes the feed, not row durability: a withheld source (rows failed) still reports it, with its OLD validators", async () => {
    seed(IKLIM.slug);
    failUpserts = true;
    const a = await cycle();
    expect(a.validatorsWithheld).toBe(1);
    const sent = lastRpcRow(IKLIM.slug);
    expect(sent.fetch_items_count).toBe(IKLIM.items);
    expect(sent.fetch_newest_item_at).toBe(IKLIM.newest);
    expect(sent.fetch_etag).toBeNull(); // validators withheld: old (null) values
    expect(sent.fetch_body_hash).toBeNull();
    expect(row(IKLIM.slug).fetch_etag).toBeNull();
  });

  it("an HTTP error sends no freshness and keeps the stored pair", async () => {
    seed(IKLIM.slug, { itemsCount: 7, newest: "2026-09-20T10:00:00.000Z", status: 200 });
    statusOverride.set(IKLIM.slug, 403);
    const a = await cycle();
    expect(a.failed).toBe(1);
    const sent = lastRpcRow(IKLIM.slug);
    expect(sent.fetch_last_status).toBe(403);
    expect("fetch_items_count" in sent).toBe(false);
    expect("fetch_newest_item_at" in sent).toBe(false);
    expect(row(IKLIM.slug).fetch_items_count).toBe(7);
    expect(row(IKLIM.slug).fetch_newest_item_at).toBe("2026-09-20T10:00:00.000Z");
  });

  it("a 2xx that is not a feed (an HTML page) is a failure and sends no freshness", async () => {
    seed(IKLIM.slug, { itemsCount: 7, newest: "2026-09-20T10:00:00.000Z", status: 200 });
    statusOverride.set(IKLIM.slug, 200);
    const a = await cycle();
    expect(a.notAFeed).toBe(1);
    const sent = lastRpcRow(IKLIM.slug);
    expect("fetch_items_count" in sent).toBe(false);
    expect("fetch_newest_item_at" in sent).toBe(false);
    expect(row(IKLIM.slug).fetch_items_count).toBe(7);
  });
});

describe("ingest feed freshness bootstrap (a NULL fetch_items_count means parse the feed once)", () => {
  it("etag seeded, body_hash = the fixture, count NULL: no If-None-Match, freshness is written, no row is inserted", async () => {
    const { fx, sha } = seed(IKLIM.slug, { etag: loadFixture(IKLIM.slug).fx.etag, bodyHash: loadFixture(IKLIM.slug).sha, itemsCount: null });
    const before = articlesStore.size;

    const c = await cycle();
    const sent = fetchesOf(fx);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.inm).toBeNull(); // the seeded etag was NOT used
    expect(sent[0]?.ims).toBeNull();
    expect(c.notModified).toBe(0);
    expect(c.fetched).toBe(1);
    expect(c.freshnessBootstraps).toBe(1);
    expect(c.inserted).toBe(0);
    expect(articlesStore.size).toBe(before);

    const row1 = lastRpcRow(IKLIM.slug);
    expect(row1.fetch_items_count).toBe(IKLIM.items);
    expect(row1.fetch_newest_item_at).toBe(IKLIM.newest);
    // the body is unchanged: its validators are kept as they are
    expect(row1.fetch_body_hash).toBe(sha);
    expect(row1.fetch_etag).toBe(fx.etag);
    expect(row(IKLIM.slug).fetch_items_count).toBe(IKLIM.items);
  });

  it("a feed with no validators on the wire (body hash only) is bootstrapped too", async () => {
    const loaded = loadFixture(THA.slug);
    expect(loaded.fx.etag).toBeNull();
    seed(THA.slug, { bodyHash: loaded.sha, itemsCount: null });
    const c = await cycle();
    expect(c.notModified).toBe(0); // without the bootstrap the body-hash short-circuit would answer
    expect(c.freshnessBootstraps).toBe(1);
    expect(c.inserted).toBe(0);
    expect(articlesStore.size).toBe(0);
    const sent = lastRpcRow(THA.slug);
    expect(sent.fetch_items_count).toBe(THA.items);
    expect(sent.fetch_newest_item_at).toBe(THA.newest);
  });

  it("the bootstrap is once: the next cycle sends the conditional request and a 304 carries no freshness keys", async () => {
    const { fx } = seed(IKLIM.slug, { etag: loadFixture(IKLIM.slug).fx.etag, bodyHash: loadFixture(IKLIM.slug).sha, itemsCount: null });
    await cycle();
    rpcCalls = [];
    const b = await cycle();
    expect(b.notModified).toBe(1);
    expect(b.freshnessBootstraps).toBe(0);
    const sent = fetchesOf(fx);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.inm).toBe(fx.etag);
    const second = lastRpcRow(IKLIM.slug);
    expect("fetch_items_count" in second).toBe(false);
    expect("fetch_newest_item_at" in second).toBe(false);
  });

  it("count 7 seeded: a conditional request is sent and the RPC carries no freshness keys", async () => {
    const { fx, sha } = seed(IKLIM.slug, {
      etag: loadFixture(IKLIM.slug).fx.etag,
      bodyHash: loadFixture(IKLIM.slug).sha,
      itemsCount: 7,
      newest: "2026-09-20T10:00:00.000Z",
    });
    const c = await cycle();
    const sent = fetchesOf(fx);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.inm).toBe(fx.etag);
    expect(c.notModified).toBe(1);
    expect(c.freshnessBootstraps).toBe(0);
    const out = lastRpcRow(IKLIM.slug);
    expect("fetch_items_count" in out).toBe(false);
    expect("fetch_newest_item_at" in out).toBe(false);
    expect(out.fetch_body_hash).toBe(sha);
    expect(row(IKLIM.slug).fetch_items_count).toBe(7);
  });

  it("a body that CHANGED during the bootstrap inserts its rows normally and reports freshness (settled path)", async () => {
    const { expected } = seed(IKLIM.slug, { etag: "W/\"old\"", bodyHash: "0".repeat(64), itemsCount: null });
    const c = await cycle();
    expect(c.inserted).toBe(expected);
    expect(c.freshnessBootstraps).toBe(1);
    const sent = lastRpcRow(IKLIM.slug);
    expect(sent.fetch_items_count).toBe(IKLIM.items);
    expect(sent.fetch_newest_item_at).toBe(IKLIM.newest);
    expect(row(IKLIM.slug).fetch_body_hash).not.toBe("0".repeat(64));
  });

  it("an HTTP error during the bootstrap leaves the count NULL (it is retried next cycle)", async () => {
    seed(IKLIM.slug, { itemsCount: null });
    statusOverride.set(IKLIM.slug, 503);
    await cycle();
    const sent = lastRpcRow(IKLIM.slug);
    expect("fetch_items_count" in sent).toBe(false);
    expect(row(IKLIM.slug).fetch_items_count).toBeNull();
    // next cycle, the feed is back: bootstrapped then
    statusOverride.clear();
    rpcCalls = [];
    const b = await cycle();
    expect(b.freshnessBootstraps).toBe(1);
    expect(lastRpcRow(IKLIM.slug).fetch_items_count).toBe(IKLIM.items);
  });

  it("the parse budget still applies: a deferred bootstrap is retried first next cycle", async () => {
    process.env.INGEST_MAX_PARSES_PER_CYCLE = "1";
    seed(IKLIM.slug, { itemsCount: null });
    seed(NEWSLAB.slug, { itemsCount: null });

    const a = await cycle();
    expect(a.parseDeferred).toBe(1);
    expect(a.fetched).toBe(1);
    const measuredAfterA = sourcesTable.filter((s) => typeof s.fetch_items_count === "number");
    expect(measuredAfterA).toHaveLength(1);

    const b = await cycle();
    expect(b.parseDeferred).toBe(0);
    // the deferred source went first and was bootstrapped; the other one is already measured
    expect(sourcesTable.every((s) => typeof s.fetch_items_count === "number")).toBe(true);
    expect(row(IKLIM.slug).fetch_items_count).toBe(IKLIM.items);
    expect(row(NEWSLAB.slug).fetch_items_count).toBe(NEWSLAB.items);
    expect(row(IKLIM.slug).fetch_newest_item_at).toBe(IKLIM.newest);
    expect(row(NEWSLAB.slug).fetch_newest_item_at).toBe(NEWSLAB.newest);
  });
});

describe("ingest feed freshness when migration 119 is not applied yet (42703)", () => {
  it("retries once with the legacy select and the cycle still completes: rows inserted, no bootstrap", async () => {
    legacyOnly = true;
    const { fx, expected } = seed(IKLIM.slug, { legacy: true });
    const c = await cycle();

    expect(selectLog).toHaveLength(2);
    expect(selectLog[0]).toContain("fetch_items_count");
    expect(selectLog[0]).toContain("fetch_newest_item_at");
    expect(selectLog[1]).not.toContain("fetch_items_count");
    expect(selectLog[1]).not.toContain("fetch_newest_item_at");
    expect(selectLog[1]).toContain("fetch_quarantined_until"); // the current legacy select

    expect(c.sources).toBe(1);
    expect(c.inserted).toBe(expected);
    expect(c.freshnessBootstraps).toBe(0);
    expect(fetchesOf(fx)).toHaveLength(1);
  });

  it("an undefined fetch_items_count (legacy rows) is never a bootstrap: the seeded etag is used", async () => {
    legacyOnly = true;
    const { fx } = seed(IKLIM.slug, { etag: loadFixture(IKLIM.slug).fx.etag, bodyHash: loadFixture(IKLIM.slug).sha, legacy: true });
    const c = await cycle();
    expect(fetchesOf(fx)[0]?.inm).toBe(fx.etag);
    expect(c.notModified).toBe(1);
    expect(c.freshnessBootstraps).toBe(0);
  });

  it("another select error is still fatal to the cycle (only 42703 retries)", async () => {
    seed(IKLIM.slug, { itemsCount: null });
    holder.client = (() => {
      const { client } = createSupabaseFake({
        tables: { sources: () => ({ data: null, error: { message: "boom", code: "57014" } as { message: string } }) },
      });
      return client;
    })();
    vi.resetModules();
    await loadHandler();
    const handler = (globalThis as unknown as {
      __feedFreshnessHandler: (req: Request) => Promise<Response>;
    }).__feedFreshnessHandler;
    const res = await handler(
      new Request("http://localhost/ingest", { method: "POST", headers: { Authorization: `Bearer ${KEY}` } }),
    );
    expect(res.status).toBe(500);
  });

  it("the current select names both new columns", async () => {
    seed(IKLIM.slug, { itemsCount: null });
    await cycle();
    expect(selectLog).toHaveLength(1);
    expect(selectLog[0]).toContain("fetch_newest_item_at");
    expect(selectLog[0]).toContain("fetch_items_count");
  });
});

describe("ingest never sends an out-of-range item date (the last guard in buildFetchStateUpdate)", () => {
  it.each([
    "0000-01-01T00:00:00.000Z",
    "-000001-12-31T21:00:00.000Z",
    "-000100-01-01T00:00:00.000Z",
    "1989-12-31T23:59:59.999Z",
    "2101-01-01T00:00:00.000Z",
    "not a date",
  ])("a newest item of %s is sent as null, with the item count intact", async (bad) => {
    seed(IKLIM.slug);
    freshnessOverride.value = { newestItemAt: bad, itemsCount: 7 };
    await cycle();
    const sent = lastRpcRow(IKLIM.slug);
    expect(sent.fetch_newest_item_at).toBeNull();
    expect(sent.fetch_items_count).toBe(7);
  });

  it("a plausible newest item still goes through unchanged", async () => {
    seed(IKLIM.slug);
    freshnessOverride.value = { newestItemAt: "2026-09-28T11:04:44.000Z", itemsCount: 10 };
    await cycle();
    expect(lastRpcRow(IKLIM.slug).fetch_newest_item_at).toBe("2026-09-28T11:04:44.000Z");
  });

  it("the real helper never lets a year-0 item reach the RPC row either (no override)", async () => {
    seed(IKLIM.slug);
    await cycle();
    const sent = lastRpcRow(IKLIM.slug);
    expect(Date.parse(String(sent.fetch_newest_item_at))).toBeGreaterThanOrEqual(Date.UTC(1990, 0, 1));
  });
});

describe("ingest fetch-state write isolation (one bad row must not erase the others)", () => {
  const errorLog = () => vi.mocked(console.error).mock.calls.map((c) => c.map(String).join(" ")).join("\n");

  it("a batch refused with a data exception (22008) is retried in halves: only the poisoned source loses its write", async () => {
    seed(IKLIM.slug);
    seed(THA.slug);
    seed(NEWSLAB.slug);
    rpcPoison.add(`src-${THA.slug}`);

    const c = await cycle();

    expect(c.sources).toBe(3);
    // the two healthy sources got their fetch state AND freshness
    expect(row(IKLIM.slug).fetch_items_count).toBe(IKLIM.items);
    expect(row(IKLIM.slug).fetch_newest_item_at).toBe(IKLIM.newest);
    expect(row(IKLIM.slug).fetch_last_status).toBe(200);
    expect(row(NEWSLAB.slug).fetch_items_count).toBe(NEWSLAB.items);
    expect(row(NEWSLAB.slug).fetch_last_status).toBe(200);
    // the poisoned one wrote nothing, and the others were not rolled in with it
    expect(row(THA.slug).fetch_items_count).toBeNull();
    expect(row(THA.slug).fetch_last_status).toBeNull();
    // one full batch first, then smaller ones; bounded
    expect(rpcCalls[0]?.rows).toHaveLength(3);
    expect(rpcCalls.length).toBeGreaterThan(1);
    expect(rpcCalls.length).toBeLessThanOrEqual(7);
    expect(rpcCalls.slice(1).every((call) => call.rows.length < 3)).toBe(true);
    // the dropped row is named in the log (id only: never a url or a title)
    expect(errorLog()).toContain(`src-${THA.slug}`);
    expect(errorLog()).toContain("date/time field value out of range");
  });

  it("the healthy sources are written once (no source's state is sent twice after a half succeeded)", async () => {
    seed(IKLIM.slug);
    seed(THA.slug);
    seed(NEWSLAB.slug);
    rpcPoison.add(`src-${NEWSLAB.slug}`);
    await cycle();
    const successful = rpcCalls.filter((call) => !call.rows.some((r) => r.id === `src-${NEWSLAB.slug}`));
    const written = successful.flatMap((call) => call.rows.map((r) => r.id));
    expect(written.filter((id) => id === `src-${IKLIM.slug}`)).toHaveLength(1);
    expect(written.filter((id) => id === `src-${THA.slug}`)).toHaveLength(1);
  });

  it("a failure that is not about a row's data (statement timeout, 57014) is NOT split: one call, nothing retried", async () => {
    seed(IKLIM.slug);
    seed(THA.slug);
    seed(NEWSLAB.slug);
    rpcMode = "timeout";
    const c = await cycle();
    expect(c.sources).toBe(3);
    expect(rpcCalls).toHaveLength(1);
    expect(errorLog()).toContain("canceling statement due to statement timeout");
  });

  it("a thrown error (network down) is NOT split either: one call, and the cycle still completes", async () => {
    seed(IKLIM.slug);
    seed(THA.slug);
    rpcMode = "throw";
    const c = await cycle();
    expect(c.sources).toBe(2);
    expect(rpcCalls).toHaveLength(1);
    expect(errorLog()).toContain("network down");
  });

  it("a healthy cycle is still exactly one write", async () => {
    seed(IKLIM.slug);
    seed(THA.slug);
    seed(NEWSLAB.slug);
    await cycle();
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.rows).toHaveLength(3);
  });

  it("retries are capped: a batch of 40 poisoned rows stops at the call cap and says how many rows it left unwritten", async () => {
    for (let i = 0; i < 40; i++) {
      // no served fixture: the fetch stub throws, the fetcher reports a failure, and the failure state is a row
      sourcesTable.push({
        id: `src-bare-${i}`,
        name: `bare ${i}`,
        slug: `bare-${i}`,
        url: `https://bare-${i}.example.com`,
        rss_url: `https://bare-${i}.example.com/feed.xml`,
        active: true,
        fetch_etag: null,
        fetch_last_modified: null,
        fetch_body_hash: null,
        fetch_last_status: null,
        fetch_last_at: null,
        fetch_fail_streak: 0,
        fetch_quarantined_until: null,
        fetch_items_count: null,
        fetch_newest_item_at: null,
      });
      rpcPoison.add(`src-bare-${i}`);
    }
    const c = await cycle();
    expect(c.sources).toBe(40);
    expect(rpcCalls.length).toBeLessThanOrEqual(24);
    expect(rpcCalls.length).toBeGreaterThan(8);
    expect(errorLog()).toMatch(/call cap \(24\) reached, \d+ row\(s\) not written/);
  });
});

