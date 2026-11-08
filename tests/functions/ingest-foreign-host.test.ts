import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseFake } from "../_helpers/supabase-fake";
import { miniParseRss } from "../_helpers/mini-rss-parse";

// ---------------------------------------------------------------------------
// h63-clusterintegrity-2: an item whose link host belongs to ANOTHER active
// source is left to that source. From 2026-11-06 haberler.com's feed carried the
// sondakika.com stream; the ingest upsert gives a URL (onConflict "url",
// ignoreDuplicates) to whichever source polls first, so 2,014 rows labelled
// "Haberler.com" linked to sondakika.com and Son Dakika fell from ~95 items a day
// to none, with every fetch answering 200.
//
// The guard runs in the per-feed loop, after the cheap normalisation and before
// the stored-url lookup, the twin bookkeeping and `allRows.push`, so a skipped
// item registers nothing and is never written. The owner map is built from EVERY
// active source (a quarantined source still owns its host) and holds only hosts
// claimed by exactly one source.
//
// Harness: the REAL fetcher, normalizer and ingest handler; only the XML parser,
// the Supabase client and global fetch are faked (see ingest-silent-feeds.test.ts).
// The feeds are inline XML, so no fixture file is needed.
// ---------------------------------------------------------------------------

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

const KEY = "test-service-role-key";

type SourceRec = Record<string, unknown>;
type ArticleRec = Record<string, unknown> & { url: string; source_id: string; content_hash: string; title: string };

let sourcesTable: SourceRec[] = [];
const articlesStore = new Map<string, ArticleRec>();
let feeds = new Map<string, string>();
let logLines: string[] = [];

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
    return { data: [], error: null };
  };
  Object.assign(b, {
    select: () => b,
    gte: () => b,
    in: (col: string, vals: unknown) => {
      ins.push({ col, vals: Array.isArray(vals) ? vals : [vals] });
      return b;
    },
    then: (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
      Promise.resolve(readResult()).then(f, r),
    upsert: (rows: unknown) => {
      const arr = (Array.isArray(rows) ? rows : [rows]) as ArticleRec[];
      const run = () => {
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
      sources: () => ({ data: sourcesTable.map((r) => ({ ...r })), error: null }),
    },
    rpc: {
      ingest_set_source_fetch_state: (args) => {
        const rows = (args as { p_rows?: Array<Record<string, unknown>> }).p_rows ?? [];
        for (const row of rows) {
          const target = sourcesTable.find((s) => s.id === row.id);
          if (!target) continue;
          const { id: _id, ...rest } = row;
          Object.assign(target, rest);
        }
        return { data: null, error: null };
      },
      apply_article_title_edits: () => ({ data: 0, error: null }),
      existing_source_content_hash_pairs: (args) => {
        const { p_source_ids = [], p_hashes = [] } = args as {
          p_source_ids?: string[];
          p_hashes?: string[];
        };
        const asked = new Set(p_source_ids.map((sid, i) => `${sid}\x1f${p_hashes[i]}`));
        const rows = [...articlesStore.values()]
          .filter((r) => asked.has(`${r.source_id}\x1f${r.content_hash}`))
          .map((r) => ({ source_id: r.source_id, content_hash: r.content_hash }));
        return { data: rows, error: null };
      },
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
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString()).toString();
    const body = feeds.get(url);
    if (body === undefined) throw new Error(`unexpected fetch: ${url}`);
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/rss+xml; charset=UTF-8" },
    });
  }) as typeof fetch;
}

(globalThis as unknown as { Deno?: unknown }).Deno = {
  env: { get: (k: string) => process.env[k] },
  serve: (h: (req: Request) => Promise<Response> | Response) => {
    (globalThis as unknown as { __foreignHostHandler?: unknown }).__foreignHostHandler = h;
    return { finished: Promise.resolve() };
  },
  resolveDns: async (_host: string, type: string) => {
    if (type === "A") return ["93.184.215.14"];
    throw new Error("NotFound");
  },
};

async function cycle(): Promise<Record<string, unknown>> {
  const handler = (globalThis as unknown as {
    __foreignHostHandler: (req: Request) => Promise<Response>;
  }).__foreignHostHandler;
  const res = await handler(
    new Request("http://localhost/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}` },
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function rss(items: Array<{ title: string; link: string }>): string {
  const pub = new Date(Date.now() - 60_000).toUTCString();
  const body = items
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>${i.link}</link><description>${i.title} ayrintilari</description><pubDate>${pub}</pubDate></item>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>t</title>${body}</channel></rss>`;
}

function source(slug: string, siteUrl: string, rssUrl: string, extra: SourceRec = {}): SourceRec {
  return {
    id: `src-${slug}`,
    name: slug,
    slug,
    url: siteUrl,
    rss_url: rssUrl,
    active: true,
    fetch_etag: null,
    fetch_last_modified: null,
    fetch_body_hash: null,
    fetch_last_status: null,
    fetch_last_at: null,
    fetch_fail_streak: 0,
    fetch_quarantined_until: null,
    ...extra,
  };
}

function storedFor(slug: string): string[] {
  return [...articlesStore.values()].filter((a) => a.source_id === `src-${slug}`).map((a) => a.url);
}

const HABERLER_RSS = "https://rss.haberler.com/RssNew.aspx";
const SONDAKIKA_RSS = "https://rss.sondakika.com/rss_standart.asp";

const HB_OWN_1 = "https://www.haberler.com/ekonomi/dolar-gunu-yukselisle-kapatti-18000001/";
const HB_OWN_2 = "https://www.haberler.com/spor/milli-takim-kadrosu-aciklandi-18000002/";
const SD_1 = "https://www.sondakika.com/guncel/israil-cumhurbaskani-herzog-hukumeti-kurma-20406057/";
const SD_2 = "https://www.sondakika.com/ekonomi/merkez-bankasi-faiz-kararini-acikladi-20406058/";
const SD_OWN = "https://www.sondakika.com/spor/derbi-oncesi-son-durum-20406059/";

function seedHaberlerAndSondakika(sondakikaExtra: SourceRec = {}) {
  sourcesTable = [
    source("haberler-com", "https://www.haberler.com", HABERLER_RSS),
    source("son-dakika", "https://www.sondakika.com", SONDAKIKA_RSS, sondakikaExtra),
  ];
  feeds = new Map([
    [
      new URL(HABERLER_RSS).toString(),
      rss([
        { title: "Dolar günü yükselişle kapattı", link: HB_OWN_1 },
        { title: "Israil Cumhurbaskani Herzog hukumeti kurma gorevini verdi", link: SD_1 },
        { title: "Milli takim kadrosu aciklandi", link: HB_OWN_2 },
        { title: "Merkez Bankasi faiz kararini acikladi", link: SD_2 },
      ]),
    ],
    [
      new URL(SONDAKIKA_RSS).toString(),
      rss([
        { title: "Israil Cumhurbaskani Herzog hukumeti kurma gorevini verdi", link: SD_1 },
        { title: "Merkez Bankasi faiz kararini acikladi", link: SD_2 },
        { title: "Derbi oncesi son durum", link: SD_OWN },
      ]),
    ],
  ]);
}

beforeEach(async () => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
  articlesStore.clear();
  sourcesTable = [];
  feeds = new Map();
  logLines = [];
  holder.client = buildClient();
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  installFetchStub();
  vi.resetModules();
  await import("../../supabase/functions/ingest/index.ts");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("ingest leaves an item to the source that owns its link host", () => {
  it("haberler-com keeps only its own host; son-dakika owns the sondakika.com links", async () => {
    seedHaberlerAndSondakika();
    const stats = await cycle();

    expect(storedFor("haberler-com").sort()).toEqual([HB_OWN_1, HB_OWN_2].sort());
    expect(storedFor("son-dakika").sort()).toEqual([SD_1, SD_2, SD_OWN].sort());
    expect(stats.inserted).toBe(5);
    expect(stats.foreignHostSkipped).toBe(2);
  });

  it("logs the slug, the owner and a count, never a url or a headline", async () => {
    seedHaberlerAndSondakika();
    await cycle();

    const lines = logLines.filter((l) => l.includes("left to"));
    expect(lines).toEqual([
      "[ingest] haberler-com: 2 item(s) left to son-dakika (link host belongs to that source)",
    ]);
    for (const l of lines) {
      expect(l).not.toMatch(/https?:\/\//);
      expect(l).not.toContain("Herzog");
    }
  });

  it("a second cycle over the same feeds writes nothing new and still skips", async () => {
    seedHaberlerAndSondakika();
    await cycle();
    const again = await cycle();

    expect(again.inserted).toBe(0);
    expect(storedFor("haberler-com")).toHaveLength(2);
    expect(storedFor("son-dakika")).toHaveLength(3);
    for (const url of storedFor("haberler-com")) expect(url).not.toContain("sondakika.com");
  });

  it("a quarantined owner still owns its host", async () => {
    seedHaberlerAndSondakika({ fetch_quarantined_until: new Date(Date.now() + 3_600_000).toISOString() });
    const stats = await cycle();

    expect(storedFor("haberler-com").sort()).toEqual([HB_OWN_1, HB_OWN_2].sort());
    expect(storedFor("son-dakika")).toEqual([]);
    expect(stats.foreignHostSkipped).toBe(2);
  });

  it("a host two active sources claim is ambiguous: nothing is skipped on it", async () => {
    const shared = "https://www.shared-outlet.example/haber/ortak-konu-baslik-777/";
    sourcesTable = [
      source("haberler-com", "https://www.haberler.com", HABERLER_RSS),
      source("outlet-tr", "https://www.shared-outlet.example/tr", "https://rss.outlet-tr.example/a.xml", {
        fetch_quarantined_until: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      source("outlet-en", "https://shared-outlet.example/en", "https://rss.outlet-en.example/a.xml", {
        fetch_quarantined_until: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ];
    feeds = new Map([
      [
        new URL(HABERLER_RSS).toString(),
        rss([
          { title: "Dolar günü yükselişle kapattı", link: HB_OWN_1 },
          { title: "Ortak konu baslik", link: shared },
        ]),
      ],
    ]);
    const stats = await cycle();

    expect(storedFor("haberler-com").sort()).toEqual([HB_OWN_1, shared].sort());
    expect(stats.foreignHostSkipped).toBe(0);
    expect(logLines.filter((l) => l.includes("left to"))).toEqual([]);
  });

  it("a subdomain of an owned host is not that host: m.sondakika.com is kept", async () => {
    const mobile = "https://m.sondakika.com/guncel/mobil-surum-haber-20406060/";
    seedHaberlerAndSondakika();
    feeds.set(
      new URL(HABERLER_RSS).toString(),
      rss([
        { title: "Dolar günü yükselişle kapattı", link: HB_OWN_1 },
        { title: "Mobil surum haberi", link: mobile },
      ]),
    );
    const stats = await cycle();

    expect(storedFor("haberler-com").sort()).toEqual([HB_OWN_1, mobile].sort());
    expect(stats.foreignHostSkipped).toBe(0);
  });

  it("a feed with no foreign host logs nothing and counts zero", async () => {
    seedHaberlerAndSondakika();
    feeds.set(
      new URL(HABERLER_RSS).toString(),
      rss([
        { title: "Dolar günü yükselişle kapattı", link: HB_OWN_1 },
        { title: "Milli takim kadrosu aciklandi", link: HB_OWN_2 },
      ]),
    );
    const stats = await cycle();

    expect(stats.foreignHostSkipped).toBe(0);
    expect(logLines.filter((l) => l.includes("left to"))).toEqual([]);
    expect(storedFor("haberler-com")).toHaveLength(2);
  });

  it("a feed that holds only foreign items inserts none of them and still settles its validators", async () => {
    seedHaberlerAndSondakika();
    feeds.set(
      new URL(HABERLER_RSS).toString(),
      rss([
        { title: "Israil Cumhurbaskani Herzog hukumeti kurma gorevini verdi", link: SD_1 },
        { title: "Merkez Bankasi faiz kararini acikladi", link: SD_2 },
      ]),
    );
    const stats = await cycle();

    expect(storedFor("haberler-com")).toEqual([]);
    expect(stats.foreignHostSkipped).toBe(2);
    expect(stats.failed).toBe(0);
    const hb = sourcesTable.find((s) => s.slug === "haberler-com");
    expect(hb?.fetch_last_status).toBe(200);
    expect(hb?.fetch_body_hash).not.toBeNull();
  });
});

describe("miniParseRss sanity for the inline feeds", () => {
  it("parses the items the tests rely on", () => {
    const parsed = miniParseRss(rss([{ title: "a", link: "https://x.example/1" }])) as {
      rss: { channel: { item: Array<{ link?: string }> } };
    };
    expect(parsed.rss.channel.item[0]?.link).toBe("https://x.example/1");
  });
});
