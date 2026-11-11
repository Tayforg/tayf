import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseFake } from "../_helpers/supabase-fake";

// ---------------------------------------------------------------------------
// h130-feeds-2: ingest drops an item whose link is an ad click-tracker
// (a DoubleClick `gampad/clk` url was stored as a Habertuerk story on 2026-11-11)
// and counts it in `adLinksDropped`, one log line per source with the slug and a
// count only. LOG-ONLY second step: items whose link host is neither the source's
// own host (subdomains allowed) nor the host of a registered source are counted
// in `offHostItems` and logged, and are NOT dropped (Bloomberg HT staging host,
// youtu.be video links).
//
// Harness: same as ingest-foreign-host.test.ts (real fetcher, normalizer and
// ingest handler; the XML parser, the Supabase client and global fetch faked).
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
    (globalThis as unknown as { __adLinkHandler?: unknown }).__adLinkHandler = h;
    return { finished: Promise.resolve() };
  },
  resolveDns: async (_host: string, type: string) => {
    if (type === "A") return ["93.184.215.14"];
    throw new Error("NotFound");
  },
};

async function cycle(): Promise<Record<string, unknown>> {
  const handler = (globalThis as unknown as {
    __adLinkHandler: (req: Request) => Promise<Response>;
  }).__adLinkHandler;
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

const HT_RSS = "https://www.haberturk.com/rss";
const BB_RSS = "https://www.bloomberght.com/rss";
const AD_URL = "https://pubads.g.doubleclick.net/gampad/clk?id=7487496184&iu=/31903365";
const HT_1 = "https://www.haberturk.com/ekonomi/merkez-bankasi-faiz-kararini-acikladi-1234567";
const HT_2 = "https://www.haberturk.com/spor/milli-takim-kadrosu-aciklandi-1234568";
const BB_1 = "https://www.bloomberght.com/dolar-gunu-yukselisle-kapatti-3400001";
const BB_STAGE = "https://bbstagedesktop.ciner.com.tr/dolar-gunu-yukselisle-kapatti-3400002";

function seed() {
  sourcesTable = [
    source("haberturk", "https://www.haberturk.com", HT_RSS),
    source("bloomberg-ht", "https://www.bloomberght.com", BB_RSS),
  ];
  feeds = new Map([
    [
      new URL(HT_RSS).toString(),
      rss([
        { title: "Merkez Bankasi faiz kararini acikladi", link: HT_1 },
        { title: "Kentin Iyi Yasam Cizgisi KENT Etiler", link: AD_URL },
        { title: "Milli takim kadrosu aciklandi", link: HT_2 },
      ]),
    ],
    [
      new URL(BB_RSS).toString(),
      rss([{ title: "Dolar gunu yukselisle kapatti", link: BB_1 }]),
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

describe("ingest drops ad click links", () => {
  it("stores the real stories, not the DoubleClick link, and reports adLinksDropped 1", async () => {
    seed();
    const stats = await cycle();

    expect(storedFor("haberturk").sort()).toEqual([HT_1, HT_2].sort());
    expect([...articlesStore.keys()].some((u) => u.includes("doubleclick"))).toBe(false);
    expect(stats.adLinksDropped).toBe(1);
    expect(stats.inserted).toBe(3);
  });

  it("logs the slug and a count, never a url or a headline", async () => {
    seed();
    await cycle();

    const lines = logLines.filter((l) => l.includes("ad click link"));
    expect(lines).toEqual(["[ingest] haberturk: 1 item(s) dropped: ad click link"]);
    for (const l of lines) {
      expect(l).not.toMatch(/https?:\/\//);
      expect(l).not.toContain("doubleclick");
      expect(l).not.toContain("KENT");
    }
  });

  it("totals the drops of several sources and logs one line per source", async () => {
    seed();
    feeds.set(
      new URL(BB_RSS).toString(),
      rss([
        { title: "Dolar gunu yukselisle kapatti", link: BB_1 },
        { title: "Reklam bir", link: "https://ad.doubleclick.net/ddm/clk/1;2;3" },
        { title: "Reklam iki", link: "https://www.googleadservices.com/pagead/aclk?sa=L" },
      ]),
    );
    const stats = await cycle();

    expect(stats.adLinksDropped).toBe(3);
    expect(logLines.filter((l) => l.includes("ad click link")).sort()).toEqual([
      "[ingest] bloomberg-ht: 2 item(s) dropped: ad click link",
      "[ingest] haberturk: 1 item(s) dropped: ad click link",
    ]);
  });

  it("a second cycle over an unchanged body is not re-parsed: nothing new is stored or counted", async () => {
    seed();
    await cycle();
    const again = await cycle();

    expect(again.notModified).toBe(2);
    expect(again.inserted).toBe(0);
    expect(again.adLinksDropped).toBe(0);
    expect(storedFor("haberturk")).toHaveLength(2);
  });

  it("a re-poll with a changed body drops the still-present ad link again and stores only the new story", async () => {
    seed();
    await cycle();
    const HT_3 = "https://www.haberturk.com/gundem/yeni-gelisme-1234569";
    feeds.set(
      new URL(HT_RSS).toString(),
      rss([
        { title: "Yeni gelisme", link: HT_3 },
        { title: "Kentin Iyi Yasam Cizgisi KENT Etiler", link: AD_URL },
        { title: "Merkez Bankasi faiz kararini acikladi", link: HT_1 },
      ]),
    );
    const again = await cycle();

    expect(again.inserted).toBe(1);
    expect(again.adLinksDropped).toBe(1);
    expect(storedFor("haberturk").sort()).toEqual([HT_1, HT_2, HT_3].sort());
  });

  it("a feed with no ad link logs nothing and counts zero", async () => {
    seed();
    feeds.set(
      new URL(HT_RSS).toString(),
      rss([{ title: "Merkez Bankasi faiz kararini acikladi", link: HT_1 }]),
    );
    const stats = await cycle();

    expect(stats.adLinksDropped).toBe(0);
    expect(logLines.filter((l) => l.includes("ad click link"))).toEqual([]);
    expect(storedFor("haberturk")).toEqual([HT_1]);
  });

  it("a lookalike host is stored, not dropped as an ad link", async () => {
    const lookalike = "https://doubleclick.net.example.com/haber/benzer-alan-adi-99";
    seed();
    feeds.set(
      new URL(HT_RSS).toString(),
      rss([{ title: "Benzer alan adi", link: lookalike }]),
    );
    const stats = await cycle();

    expect(stats.adLinksDropped).toBe(0);
    expect(storedFor("haberturk")).toEqual([lookalike]);
  });
});

describe("ingest counts off-host items and keeps them (log only)", () => {
  const OFF_LINE =
    "item(s) off-host (link host is neither the source's own nor a registered source's); kept";

  it("keeps the Bloomberg HT staging-host item and counts it in offHostItems", async () => {
    seed();
    feeds.set(
      new URL(BB_RSS).toString(),
      rss([
        { title: "Dolar gunu yukselisle kapatti", link: BB_1 },
        { title: "Dolar gunu yukselisle kapatti staging", link: BB_STAGE },
      ]),
    );
    const stats = await cycle();

    expect(storedFor("bloomberg-ht").sort()).toEqual([BB_1, BB_STAGE].sort());
    expect(stats.offHostItems).toBe(1);
    expect(stats.adLinksDropped).toBe(1);
  });

  it("logs the slug and a count only", async () => {
    seed();
    feeds.set(
      new URL(BB_RSS).toString(),
      rss([
        { title: "Dolar gunu yukselisle kapatti", link: BB_1 },
        { title: "Dolar gunu yukselisle kapatti staging", link: BB_STAGE },
        { title: "Video haber", link: "https://youtu.be/abc123XYZ" },
      ]),
    );
    await cycle();

    const lines = logLines.filter((l) => l.includes("off-host"));
    expect(lines).toEqual([`[ingest] bloomberg-ht: 2 ${OFF_LINE}`]);
    for (const l of lines) {
      expect(l).not.toMatch(/https?:\/\//);
      expect(l).not.toContain("ciner");
      expect(l).not.toContain("youtu");
    }
  });

  it("the source's own host, its subdomains and www are not off-host", async () => {
    seed();
    feeds.set(
      new URL(BB_RSS).toString(),
      rss([
        { title: "Ana alan adi", link: BB_1 },
        { title: "Mobil surum", link: "https://m.bloomberght.com/mobil-surum-3400003" },
        { title: "Cipli alan adi", link: "https://bloomberght.com/cipsiz-3400004" },
      ]),
    );
    const stats = await cycle();

    expect(stats.offHostItems).toBe(0);
    expect(storedFor("bloomberg-ht")).toHaveLength(3);
    expect(logLines.filter((l) => l.includes("off-host"))).toEqual([]);
  });

  it("an item on another registered source's host is left to it, not counted as off-host", async () => {
    seed();
    feeds.set(
      new URL(BB_RSS).toString(),
      rss([
        { title: "Dolar gunu yukselisle kapatti", link: BB_1 },
        { title: "Merkez Bankasi faiz kararini acikladi", link: HT_1 },
      ]),
    );
    const stats = await cycle();

    expect(stats.foreignHostSkipped).toBe(1);
    expect(stats.offHostItems).toBe(0);
  });

  it("a host two active sources claim is registered: not off-host for a third source", async () => {
    const shared = "https://www.shared-outlet.example/haber/ortak-konu-baslik-777/";
    sourcesTable = [
      source("haberturk", "https://www.haberturk.com", HT_RSS),
      source("outlet-tr", "https://www.shared-outlet.example/tr", "https://rss.outlet-tr.example/a.xml", {
        fetch_quarantined_until: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      source("outlet-en", "https://shared-outlet.example/en", "https://rss.outlet-en.example/a.xml", {
        fetch_quarantined_until: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ];
    feeds = new Map([
      [
        new URL(HT_RSS).toString(),
        rss([
          { title: "Merkez Bankasi faiz kararini acikladi", link: HT_1 },
          { title: "Ortak konu baslik", link: shared },
        ]),
      ],
    ]);
    const stats = await cycle();

    expect(storedFor("haberturk").sort()).toEqual([HT_1, shared].sort());
    expect(stats.offHostItems).toBe(0);
  });

  it("nothing is counted when the source's own host is unknown", async () => {
    seed();
    sourcesTable = [source("haberturk", "not a url", HT_RSS)];
    feeds = new Map([
      [new URL(HT_RSS).toString(), rss([{ title: "Merkez Bankasi faiz", link: "https://elsewhere.example/a-1" }])],
    ]);
    const stats = await cycle();

    expect(stats.offHostItems).toBe(0);
    expect(logLines.filter((l) => l.includes("off-host"))).toEqual([]);
  });
});
