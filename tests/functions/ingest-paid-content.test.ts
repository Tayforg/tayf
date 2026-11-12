import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseFake } from "../_helpers/supabase-fake";

// ---------------------------------------------------------------------------
// h148-sources-1: ingest drops an item whose url path opens with a paid-content
// section (/advertorial/ or /tanitim-bulteni/, first or second segment) and
// counts it in `paidContentDropped`, one log line per source with the slug and a
// count only. Paid advertorials and press releases were stored as news: Posta,
// CNN Turk, Dunya, Turkiye Gazetesi and Halk TV carry them in their feeds.
//
// Harness: same as ingest-ad-link.test.ts (real fetcher, normalizer and ingest
// handler; the XML parser, the Supabase client and global fetch faked).
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
    (globalThis as unknown as { __paidContentHandler?: unknown }).__paidContentHandler = h;
    return { finished: Promise.resolve() };
  },
  resolveDns: async (_host: string, type: string) => {
    if (type === "A") return ["93.184.215.14"];
    throw new Error("NotFound");
  },
};

async function cycle(): Promise<Record<string, unknown>> {
  const handler = (globalThis as unknown as {
    __paidContentHandler: (req: Request) => Promise<Response>;
  }).__paidContentHandler;
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

const POSTA_RSS = "https://www.posta.com.tr/rss";
const HALK_RSS = "https://halktv.com.tr/rss";
const POSTA_ADV =
  "https://www.posta.com.tr/advertorial/ziraat-bankasi-10-trilyon-tl-aktif-buyuklugu-asan-ilk-banka-oldu-3063347";
const POSTA_1 = "https://www.posta.com.tr/gundem/bir-haber-3063348";
const POSTA_2 = "https://www.posta.com.tr/ekonomi/baska-bir-haber-3063349";
const HALK_PR =
  "https://halktv.com.tr/tanitim-bulteni/otel-fiyatlarini-karsilastirmanin-pratik-bir-yolu-1061590h";
const HALK_1 = "https://halktv.com.tr/gundem/bir-haber-1061591h";

function seed() {
  sourcesTable = [
    source("posta", "https://www.posta.com.tr", POSTA_RSS),
    source("halk-tv", "https://halktv.com.tr", HALK_RSS),
  ];
  feeds = new Map([
    [
      new URL(POSTA_RSS).toString(),
      rss([
        { title: "Bir haber basligi", link: POSTA_1 },
        { title: "Ziraat Bankasi 10 trilyon TL aktif buyuklugunu asan ilk banka oldu", link: POSTA_ADV },
        { title: "Baska bir haber basligi", link: POSTA_2 },
      ]),
    ],
    [new URL(HALK_RSS).toString(), rss([{ title: "Halk TV haberi", link: HALK_1 }])],
  ]);
}

describe("ingest drops paid content urls", () => {
  it("stores the real stories, not the advertorial, and reports paidContentDropped 1", async () => {
    seed();
    const stats = await cycle();

    expect(storedFor("posta").sort()).toEqual([POSTA_1, POSTA_2].sort());
    expect([...articlesStore.keys()].some((u) => u.includes("/advertorial/"))).toBe(false);
    expect(stats.paidContentDropped).toBe(1);
    expect(stats.adLinksDropped).toBe(0);
    expect(stats.contentlessTitlesDropped).toBe(0);
    expect(stats.inserted).toBe(3);
  });

  it("logs the slug and a count, never a url or a headline", async () => {
    seed();
    await cycle();

    const lines = logLines.filter((l) => l.includes("paid content"));
    expect(lines).toEqual(["[ingest] posta: 1 item(s) dropped: paid content url"]);
    for (const l of lines) {
      expect(l).not.toMatch(/https?:\/\//);
      expect(l).not.toContain("advertorial");
      expect(l).not.toContain("Ziraat");
    }
  });

  it("totals the drops of several sources and logs one line per source", async () => {
    seed();
    feeds.set(
      new URL(HALK_RSS).toString(),
      rss([
        { title: "Halk TV haberi", link: HALK_1 },
        { title: "Otel fiyatlarini karsilastirmanin pratik bir yolu", link: HALK_PR },
        {
          title: "Viennalife prim iadeli hayat sigortasi",
          link: "https://halktv.com.tr/tanitim-bulteni/viennalife-prim-iadeli-hayat-sigortasi-1061600h",
        },
      ]),
    );
    const stats = await cycle();

    expect(stats.paidContentDropped).toBe(3);
    expect(storedFor("halk-tv")).toEqual([HALK_1]);
    expect(logLines.filter((l) => l.includes("paid content")).sort()).toEqual([
      "[ingest] halk-tv: 2 item(s) dropped: paid content url",
      "[ingest] posta: 1 item(s) dropped: paid content url",
    ]);
  });

  it("a second cycle over an unchanged body is not re-parsed: nothing new is stored or counted", async () => {
    seed();
    await cycle();
    const again = await cycle();

    expect(again.notModified).toBe(2);
    expect(again.inserted).toBe(0);
    expect(again.paidContentDropped).toBe(0);
    expect(storedFor("posta")).toHaveLength(2);
  });

  it("a re-poll with a changed body drops the still-present advertorial again and stores only the new story", async () => {
    seed();
    await cycle();
    const POSTA_3 = "https://www.posta.com.tr/gundem/yeni-gelisme-3063350";
    feeds.set(
      new URL(POSTA_RSS).toString(),
      rss([
        { title: "Yeni gelisme", link: POSTA_3 },
        { title: "Ziraat Bankasi 10 trilyon TL aktif buyuklugunu asan ilk banka oldu", link: POSTA_ADV },
        { title: "Bir haber basligi", link: POSTA_1 },
      ]),
    );
    const again = await cycle();

    expect(again.inserted).toBe(1);
    expect(again.paidContentDropped).toBe(1);
    expect(storedFor("posta").sort()).toEqual([POSTA_1, POSTA_2, POSTA_3].sort());
  });

  it("a feed with no paid url logs nothing and counts zero", async () => {
    seed();
    feeds.set(new URL(POSTA_RSS).toString(), rss([{ title: "Bir haber basligi", link: POSTA_1 }]));
    const stats = await cycle();

    expect(stats.paidContentDropped).toBe(0);
    expect(logLines.filter((l) => l.includes("paid content"))).toEqual([]);
    expect(storedFor("posta")).toEqual([POSTA_1]);
  });

  it("a headline-less item with an advertorial link is counted as contentless, not as paid content", async () => {
    seed();
    feeds.set(
      new URL(POSTA_RSS).toString(),
      rss([
        { title: "&amp;nbsp", link: POSTA_ADV },
        { title: "Bir haber basligi", link: POSTA_1 },
      ]),
    );
    const stats = await cycle();

    expect(stats.contentlessTitlesDropped).toBe(1);
    expect(stats.paidContentDropped).toBe(0);
    expect(storedFor("posta")).toEqual([POSTA_1]);
  });

  it("a segment-prefix lookalike is stored, not dropped as paid content", async () => {
    const lookalike = "https://www.posta.com.tr/gundem/advertorial-ajansi-kuruldu-3063351";
    seed();
    feeds.set(
      new URL(POSTA_RSS).toString(),
      rss([{ title: "Advertorial ajansi kuruldu", link: lookalike }]),
    );
    const stats = await cycle();

    expect(stats.paidContentDropped).toBe(0);
    expect(storedFor("posta")).toEqual([lookalike]);
  });
});
