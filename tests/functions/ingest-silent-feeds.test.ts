import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSupabaseFake } from "../_helpers/supabase-fake";
import { miniParseRss } from "../_helpers/mini-rss-parse";

// ---------------------------------------------------------------------------
// silent-feeds: RED repro of "slow feeds lose items because ingest saves the
// feed's validators (ETag / Last-Modified / body hash) before its rows land".
//
// Everything below the network is real: the REAL fetcher (conditional GET,
// body-hash short-circuit, SSRF-guarded redirect loop), the REAL normalizer,
// the REAL ingest handler. Only three seams are faked:
//   * the XML parser (esm.sh import, see tests/_helpers/mini-rss-parse.ts),
//   * the Supabase client (a small stateful simulation of `sources` and
//     `articles`, so cycle N+1 sees what cycle N durably wrote),
//   * global `fetch`, driven by the captured fixtures in tests/fixtures/feeds
//     (the five sources the 2026-09-28 audit found silent). No network.
//
// "Starve" mode advances the mocked clock by 55 s while the fetch is in
// flight: the fetch pool overran and the upsert window is gone, exactly the
// production regime (99.9 % of cycles at the 50 s deadline).
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
vi.mock("../../supabase/functions/_shared/supabase.ts", () => ({
  createServiceClient: () => holder.client,
}));

const KEY = "test-service-role-key";
const SLUGS = [
  "iklim-haber",
  "investing-com-tr",
  "newslab-turkey",
  "platform-24",
  "turkiye-haber-ajansi",
] as const;

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

const FIXTURE_DIR = resolve(__dirname, "..", "fixtures", "feeds");
function loadFixture(slug: string): { fx: Fixture; bytes: Buffer; sha: string; links: string[]; expected: number } {
  const fx = JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${slug}.json`), "utf8")) as Fixture;
  const bytes = readFileSync(resolve(FIXTURE_DIR, `${slug}.xml`));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const parsed = miniParseRss(bytes.toString("utf8")) as {
    rss: { channel: { item: Array<{ title?: string; link?: string }> } };
  };
  const good = parsed.rss.channel.item.filter((i) => i.title && i.link);
  return { fx, bytes, sha, links: good.map((i) => i.link as string), expected: good.length };
}

type SourceRec = Record<string, unknown>;
type ArticleRec = Record<string, unknown> & { url: string; source_id: string; content_hash: string; title: string };

let sourcesTable: SourceRec[] = [];
const articlesStore = new Map<string, ArticleRec>();
let failUpserts = false;
let starve = false;
let clockOffset = 0;
let rpcCalls: Array<{ name: string; rows: Array<Record<string, unknown>> }> = [];
let fetchLog: Array<{ url: string; inm: string | null; ims: string | null }> = [];
let currentFx: { fx: Fixture; bytes: Buffer } | null = null;

function makeArticlesBuilder() {
  const ins: Array<{ col: string; vals: unknown[] }> = [];
  const b: Record<string, unknown> = {};
  const readResult = () => {
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
          articlesStore.set(r.url, { ...r, id });
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
      sources: () => ({ data: sourcesTable.map((r) => ({ ...r })), error: null }),
    },
    rpc: {
      ingest_set_source_fetch_state: (args) => {
        const rows = ((args as { p_rows?: Array<Record<string, unknown>> }).p_rows ?? []);
        rpcCalls.push({ name: "ingest_set_source_fetch_state", rows });
        for (const row of rows) {
          const target = sourcesTable.find((s) => s.id === row.id);
          if (!target) continue;
          const { id: _id, ...rest } = row;
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
    if (!currentFx) throw new Error(`unexpected fetch (no fixture): ${url}`);
    const { fx, bytes } = currentFx;
    const rss = new URL(fx.rssUrl).toString();
    const fin = new URL(fx.finalUrl).toString();
    if (starve) clockOffset += 55_000;
    if (url === rss && rss !== fin) {
      return new Response(null, { status: 301, headers: { location: fx.finalUrl } });
    }
    if (url !== fin) throw new Error(`unexpected fetch (unknown url): ${url}`);
    const inm = headers.get("if-none-match");
    const ims = headers.get("if-modified-since");
    if ((fx.etag && inm === fx.etag) || (fx.lastModified && ims === fx.lastModified)) {
      return new Response(null, { status: 304 });
    }
    const h: Record<string, string> = { "content-type": fx.contentType };
    if (fx.etag) h.etag = fx.etag;
    if (fx.lastModified) h["last-modified"] = fx.lastModified;
    return new Response(new Uint8Array(bytes), { status: 200, headers: h });
  }) as typeof fetch;
}

(globalThis as unknown as { Deno?: unknown }).Deno = {
  env: { get: (k: string) => process.env[k] },
  serve: (h: (req: Request) => Promise<Response> | Response) => {
    (globalThis as unknown as { __silentFeedsHandler?: unknown }).__silentFeedsHandler = h;
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

async function cycle(mode: "normal" | "starve" = "normal"): Promise<Record<string, unknown>> {
  starve = mode === "starve";
  const handler = (globalThis as unknown as {
    __silentFeedsHandler: (req: Request) => Promise<Response>;
  }).__silentFeedsHandler;
  const res = await handler(
    new Request("http://localhost/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}` },
    }),
  );
  starve = false;
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function seed(slug: string) {
  const loaded = loadFixture(slug);
  currentFx = loaded;
  sourcesTable = [
    {
      id: `src-${slug}`,
      name: slug,
      slug,
      url: new URL(loaded.fx.finalUrl).origin,
      rss_url: loaded.fx.rssUrl,
      active: true,
      fetch_etag: null,
      fetch_last_modified: null,
      fetch_body_hash: null,
      fetch_last_status: null,
      fetch_last_at: null,
      fetch_fail_streak: 0,
      fetch_quarantined_until: null,
    },
  ];
  return loaded;
}

function row(slug: string): SourceRec {
  const r = sourcesTable.find((s) => s.slug === slug);
  if (!r) throw new Error("source row missing");
  return r;
}
function storedFor(slug: string): ArticleRec[] {
  return [...articlesStore.values()].filter((a) => a.source_id === `src-${slug}`);
}

beforeEach(async () => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
  articlesStore.clear();
  failUpserts = false;
  starve = false;
  clockOffset = 0;
  rpcCalls = [];
  fetchLog = [];
  currentFx = null;
  holder.client = buildClient();
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  installFetchStub();
  vi.resetModules();
  await loadHandler();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("ingest silent-feeds (validators follow row durability)", () => {
  it.each(SLUGS)(
    "%s: a starved cycle must not persist the feed's validators; the next warm cycle inserts every item",
    async (slug) => {
      const { fx, sha, links, expected } = seed(slug);
      expect(expected).toBeGreaterThanOrEqual(10);

      // Cycle A: fetch overran, upsert window gone -> no row lands.
      await cycle("starve");
      expect(storedFor(slug)).toHaveLength(0);
      expect(row(slug).fetch_etag).toBeNull();
      expect(row(slug).fetch_last_modified).toBeNull();
      expect(row(slug).fetch_body_hash).toBeNull();
      expect(row(slug).fetch_last_status).toBe(200);

      // Cycle B: healthy cycle, same (warm) instance. The feed must be re-offered.
      await cycle();
      const stored = storedFor(slug);
      expect(stored).toHaveLength(expected);
      const urls = new Set(stored.map((a) => a.url));
      for (const link of links) expect(urls.has(link), link).toBe(true);
      expect(row(slug).fetch_body_hash).toBe(sha);
      expect(row(slug).fetch_etag).toBe(fx.etag);

      // Cycle C: settled now -> validators are honoured, nothing new inserted.
      const fetchesBefore = fetchLog.length;
      const c = await cycle();
      expect(storedFor(slug)).toHaveLength(expected);
      expect(c.inserted).toBe(0);
      const last = fetchLog.slice(fetchesBefore).at(-1);
      if (fx.etag) {
        expect(last?.inm).toBe(fx.etag);
        expect(c.notModified).toBe(1);
      } else {
        // No validators on the wire (THA): the body-hash short-circuit fires.
        expect(c.notModified).toBe(1);
        expect(c.itemsNormalized).toBe(0);
      }
    },
  );

  it.each(SLUGS)(
    "%s: cold start after a starved cycle still re-offers the feed",
    async (slug) => {
      const { fx, sha, expected } = seed(slug);
      await cycle("starve");
      // What the DB holds is what a cold instance hydrates from.
      expect(row(slug).fetch_etag).toBeNull();
      expect(row(slug).fetch_body_hash).toBeNull();

      vi.resetModules();
      await loadHandler();
      await cycle();
      expect(storedFor(slug)).toHaveLength(expected);
      expect(row(slug).fetch_body_hash).toBe(sha);
      expect(row(slug).fetch_etag).toBe(fx.etag);
    },
  );

  it.each(SLUGS)("%s: row errors withhold validators too", async (slug) => {
    const { expected } = seed(slug);
    failUpserts = true;
    const a = await cycle();
    expect(a.rowErrors).toBe(expected);
    expect(a.validatorsWithheld).toBe(1);
    expect(row(slug).fetch_etag).toBeNull();
    expect(row(slug).fetch_last_modified).toBeNull();
    expect(row(slug).fetch_body_hash).toBeNull();
    // The feed is healthy: the streak reset is still persisted.
    expect(row(slug).fetch_last_status).toBe(200);
    expect(row(slug).fetch_fail_streak).toBe(0);

    failUpserts = false;
    const b = await cycle();
    expect(b.inserted).toBe(expected);
    expect(b.validatorsWithheld).toBe(0);
    expect(storedFor(slug)).toHaveLength(expected);
  });

  it.each(SLUGS)("%s: rows already stored count as settled", async (slug) => {
    const { fx, sha, expected } = seed(slug);
    await cycle();
    expect(storedFor(slug)).toHaveLength(expected);

    // Simulate migration 094 (validators nulled) followed by a cold start.
    row(slug).fetch_etag = null;
    row(slug).fetch_last_modified = null;
    row(slug).fetch_body_hash = null;
    vi.resetModules();
    await loadHandler();

    const again = await cycle();
    expect(again.inserted).toBe(0);
    expect(again.dedupedInBatch).toBe(expected);
    expect(again.validatorsWithheld).toBe(0);
    expect(storedFor(slug)).toHaveLength(expected);
    expect(row(slug).fetch_body_hash).toBe(sha);
    expect(row(slug).fetch_etag).toBe(fx.etag);
  });

  it.each(["platform-24", "turkiye-haber-ajansi"] as const)(
    "%s: the http:// rss_url reaches the feed through the redirect hop (redirect is not the drop)",
    async (slug) => {
      const { fx, expected } = seed(slug);
      expect(fx.rssUrl.startsWith("http://")).toBe(true);
      await cycle();
      const seen = fetchLog.map((f) => f.url);
      expect(seen).toContain(new URL(fx.rssUrl).toString());
      expect(seen).toContain(new URL(fx.finalUrl).toString());
      expect(storedFor(slug)).toHaveLength(expected);
    },
  );
});
