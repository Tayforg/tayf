import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseFake } from "../_helpers/supabase-fake";
import { miniParseRss } from "../_helpers/mini-rss-parse";

// ---------------------------------------------------------------------------
// hunt-114: an Anadolu Ajansı live article retitled under a NEW url keeps the
// live stub's pubDate. Ingest stored the re-slugged item with that pubDate, so a
// cluster's first_published and its "Kim önce yazdı?" panel gave AA a 2.5-3 hour
// head start (9a24657e: "Muhalefet 2 sa 56 dk sonra katıldı"; AA ids 4117359,
// 4116605, 4118171).
//
// The fix: for a source in STABLE_ARTICLE_ID_SOURCES, a NEW row (its url is not
// stored) whose trailing numeric id matches a row stored for the same source under
// a DIFFERENT url, within 7 days, is stamped with the poll's clock instead of the
// feed's pubDate. One PostgREST select per batch of at most 50 ids, built from
// the captured digits only; fail-open; stored rows are never touched.
//
// Harness: the REAL fetcher, normalizer and ingest handler; only the XML parser,
// the Supabase client and global fetch are faked (see ingest-foreign-host.test.ts).
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
type ArticleRec = Record<string, unknown> & {
  id: string;
  url: string;
  source_id: string;
  content_hash: string;
  title: string;
  published_at: string;
  created_at: string;
  source_article_key: string | null;
};

interface ReslugRead {
  or: string;
  sourceId: unknown;
  gte: unknown;
  select: unknown;
}

let sourcesTable: SourceRec[] = [];
const articlesStore = new Map<string, ArticleRec>();
let feeds = new Map<string, string>();
let logLines: string[] = [];
let errorLines: string[] = [];
// Every articles select that carried an `.or(...)`: the re-slug lookups.
let reslugReads: ReslugRead[] = [];
// How the next re-slug selects answer: normally, with an error envelope, or by throwing.
let reslugMode: "ok" | "error" | "throw" = "ok";
// Fail the known-url select (`.in("url", ...)`) with an error envelope.
let knownUrlFails = false;

function likeIds(or: string): string[] {
  return or.split(",").map((f) => f.replace(/^url\.like\.\*\//, ""));
}

function makeArticlesBuilder() {
  const eqs: Array<{ col: string; val: unknown }> = [];
  const ins: Array<{ col: string; vals: unknown[] }> = [];
  const gtes: Array<{ col: string; val: unknown }> = [];
  const ors: string[] = [];
  let selected: unknown = null;
  const b: Record<string, unknown> = {};
  const readResult = () => {
    if (ors.length > 0) {
      reslugReads.push({
        or: ors.join("|"),
        sourceId: eqs.find((e) => e.col === "source_id")?.val,
        gte: gtes.find((g) => g.col === "created_at")?.val,
        select: selected,
      });
      if (reslugMode === "throw") throw new Error("socket closed");
      if (reslugMode === "error") {
        return {
          data: null,
          error: { message: "canceling statement due to statement timeout https://x.supabase.co/rest/v1/articles?or=secret" },
        };
      }
      const wantedIds = ors.flatMap(likeIds);
      const sid = eqs.find((e) => e.col === "source_id")?.val;
      const since = String(gtes.find((g) => g.col === "created_at")?.val ?? "");
      const rows = [...articlesStore.values()]
        .filter(
          (r) =>
            r.source_id === sid &&
            r.created_at >= since &&
            wantedIds.some((id) => r.url.endsWith(`/${id}`)),
        )
        .map((r) => ({ url: r.url }));
      return { data: rows, error: null };
    }
    const url = ins.find((c) => c.col === "url");
    if (url) {
      if (knownUrlFails) return { data: null, error: { message: "known-url lookup down" } };
      const rows = (url.vals as string[])
        .map((u) => articlesStore.get(u))
        .filter((r): r is ArticleRec => r !== undefined)
        .map((r) => ({ id: r.id, url: r.url, title: r.title, source_id: r.source_id }));
      return { data: rows, error: null };
    }
    const keys = ins.find((c) => c.col === "source_article_key");
    if (keys) {
      const sids = ins.find((c) => c.col === "source_id")?.vals ?? [];
      const since = String(gtes.find((g) => g.col === "created_at")?.val ?? "");
      const rows = [...articlesStore.values()]
        .filter(
          (r) =>
            sids.includes(r.source_id) &&
            r.source_article_key !== null &&
            keys.vals.includes(r.source_article_key) &&
            r.created_at >= since,
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
    return { data: [], error: null };
  };
  Object.assign(b, {
    select: (cols?: unknown) => {
      selected = cols ?? null;
      return b;
    },
    eq: (col: string, val: unknown) => {
      eqs.push({ col, val });
      return b;
    },
    gte: (col: string, val: unknown) => {
      gtes.push({ col, val });
      return b;
    },
    or: (filters: string) => {
      ors.push(filters);
      return b;
    },
    order: () => b,
    limit: () => b,
    in: (col: string, vals: unknown) => {
      ins.push({ col, vals: Array.isArray(vals) ? vals : [vals] });
      return b;
    },
    then: (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(readResult)
        .then(f, r),
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
    (globalThis as unknown as { __reslugHandler?: unknown }).__reslugHandler = h;
    return { finished: Promise.resolve() };
  },
  resolveDns: async (_host: string, type: string) => {
    if (type === "A") return ["93.184.215.14"];
    throw new Error("NotFound");
  },
};

async function cycle(): Promise<Record<string, unknown>> {
  const handler = (globalThis as unknown as {
    __reslugHandler: (req: Request) => Promise<Response>;
  }).__reslugHandler;
  const res = await handler(
    new Request("http://localhost/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}` },
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

interface FeedItem {
  title: string;
  link: string;
  pubDate: string;
}

function rss(items: FeedItem[]): string {
  const body = items
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>${i.link}</link><description>${i.title} ayrintilari</description><pubDate>${i.pubDate}</pubDate></item>`,
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

const AA_RSS = "https://www.aa.com.tr/tr/rss/default?cat=guncel";
const OTHER_RSS = "https://www.other-outlet.example/rss.xml";
const AA = "src-anadolu-ajansi";
const OTHER = "src-other-outlet";

const NOW = Date.parse("2026-11-09T18:09:00Z");
const NOW_ISO = "2026-11-09T18:09:00.000Z";
// The live stub's pubDate, 16:14 Istanbul = 13:14Z, carried by every re-slug.
const STUB_PUBDATE = "Mon, 09 Nov 2026 16:14:00 +0300";
const STUB_ISO = "2026-11-09T13:14:00.000Z";

const LIVE_URL = "https://www.aa.com.tr/tr/gundem/canli-cumhurbaskani-erdogan-konusuyor/4117359";
const RESLUG_URL =
  "https://www.aa.com.tr/tr/gundem/cumhurbaskani-erdogan-gabarda-iki-yeni-sahada-daha-petrol-kesfettik/4117359";
const RESLUG_TITLE = "Gabar'da iki yeni sahada daha petrol keşfettik";

function seedSources(): void {
  sourcesTable = [
    source("anadolu-ajansi", "https://www.aa.com.tr", AA_RSS),
    source("other-outlet", "https://www.other-outlet.example", OTHER_RSS),
  ];
}

// Letters only, so every generated headline is distinct after any digit stripping.
function LETTERS(n: number): string {
  return `${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + (Math.floor(n / 26) % 26))}${String.fromCharCode(97 + (Math.floor(n / 676) % 26))}x`;
}

function setAaFeed(items: FeedItem[]): void {
  feeds.set(new URL(AA_RSS).toString(), rss(items));
}

function setOtherFeed(items: FeedItem[]): void {
  feeds.set(new URL(OTHER_RSS).toString(), rss(items));
}

/** A row already in `articles`, as an earlier poll left it. */
function seedStored(
  url: string,
  title: string,
  opts: { sourceId?: string; createdAt?: string; publishedAt?: string; key?: string | null } = {},
): ArticleRec {
  const tail = opts.key !== undefined ? opts.key : (/\/(\d{6,9})$/.exec(url)?.[1] ?? null);
  const rec: ArticleRec = {
    id: `seed-${articlesStore.size + 1}`,
    url,
    title,
    source_id: opts.sourceId ?? AA,
    content_hash: `seedhash${articlesStore.size + 1}`.padEnd(40, "0"),
    published_at: opts.publishedAt ?? STUB_ISO,
    created_at: opts.createdAt ?? "2026-11-09T16:27:10.000Z",
    source_article_key: tail,
  };
  articlesStore.set(url, rec);
  return rec;
}

function stored(url: string): ArticleRec | undefined {
  return articlesStore.get(url);
}

beforeEach(async () => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
  articlesStore.clear();
  sourcesTable = [];
  feeds = new Map();
  logLines = [];
  errorLines = [];
  reslugReads = [];
  reslugMode = "ok";
  knownUrlFails = false;
  holder.client = buildClient();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLines.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  installFetchStub();
  vi.resetModules();
  await import("../../supabase/functions/ingest/index.ts");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("an AA item re-slugged under a new url is stamped with its first-seen time", () => {
  it("restamps the 4117359 re-slug: the stub's pubDate is replaced by the poll's clock", async () => {
    seedSources();
    const live = seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);

    const stats = await cycle();

    expect(stored(RESLUG_URL)?.published_at).toBe(NOW_ISO);
    expect(stats.reslugRestamped).toBe(1);
    expect(stats.reslugLookupErrors).toBe(0);
    expect(stats.inserted).toBe(1);
    // The existing row is not touched.
    expect(stored(LIVE_URL)).toBe(live);
    expect(live.published_at).toBe(STUB_ISO);
  });

  it("asks one select for the id: this source, the 7-day window, digits only", async () => {
    seedSources();
    seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);

    await cycle();

    expect(reslugReads).toEqual([
      {
        or: "url.like.*/4117359",
        sourceId: AA,
        gte: new Date(NOW - 7 * 86_400_000).toISOString(),
        select: "url",
      },
    ]);
    expect(reslugReads[0]?.gte).toBe("2026-11-02T18:09:00.000Z");
  });

  it("logs the slug and a count for the restamp, never a url or a headline", async () => {
    seedSources();
    seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);

    await cycle();

    const lines = logLines.filter((l) => l.includes("re-slugged"));
    expect(lines).toEqual([
      "[ingest] anadolu-ajansi: 1 re-slugged item(s) stamped with first-seen time",
    ]);
    for (const l of lines) {
      expect(l).not.toMatch(/https?:\/\//);
      expect(l).not.toContain("Gabar");
    }
  });

  it("puts both counters in the cycle JSON and in the [ingest] cycle summary line", async () => {
    seedSources();
    seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);

    const body = await cycle();

    expect(body).toMatchObject({ reslugRestamped: 1, reslugLookupErrors: 0 });
    const summary = logLines.filter((l) => l.startsWith("[ingest] cycle"));
    expect(summary.length).toBeGreaterThan(0);
    const json = JSON.parse((summary[summary.length - 1] as string).replace("[ingest] cycle", "")) as Record<
      string,
      unknown
    >;
    expect(json.reslugRestamped).toBe(1);
    expect(json.reslugLookupErrors).toBe(0);
  });

  it("restamps only the items whose id is stored under another url, in ONE select", async () => {
    seedSources();
    seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    seedStored(
      "https://www.aa.com.tr/tr/gundem/canli-cumhurbaskani-erdogan-konusuyor/4116605",
      "CANLI - Cumhurbaşkanı Erdoğan konuşuyor",
    );
    setAaFeed([
      { title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE },
      {
        title: "Bakan Bayraktar enerji yatırımlarını anlattı",
        link: "https://www.aa.com.tr/tr/ekonomi/bakan-bayraktar-enerji-yatirimlarini-anlatti/4118999",
        pubDate: STUB_PUBDATE,
      },
      {
        title: "Erdoğan insanımızın huzuruna çıkıyor",
        link: "https://www.aa.com.tr/tr/gundem/cumhurbaskani-erdogan-insanimizin-huzuruna-cikiyor/4116605",
        pubDate: STUB_PUBDATE,
      },
    ]);
    setOtherFeed([]);

    const stats = await cycle();

    expect(stored(RESLUG_URL)?.published_at).toBe(NOW_ISO);
    expect(
      stored("https://www.aa.com.tr/tr/gundem/cumhurbaskani-erdogan-insanimizin-huzuruna-cikiyor/4116605")
        ?.published_at,
    ).toBe(NOW_ISO);
    expect(
      stored("https://www.aa.com.tr/tr/ekonomi/bakan-bayraktar-enerji-yatirimlarini-anlatti/4118999")
        ?.published_at,
    ).toBe(STUB_ISO);
    expect(stats.reslugRestamped).toBe(2);
    expect(reslugReads).toHaveLength(1);
    expect(likeIds((reslugReads[0] as ReslugRead).or).sort()).toEqual(["4116605", "4117359", "4118999"]);
  });

  it("a later cycle takes the re-slug as a known url: only the genuinely new id is looked up", async () => {
    seedSources();
    seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    const feed: FeedItem[] = [{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }];
    setAaFeed(feed);
    setOtherFeed([]);
    await cycle();
    reslugReads = [];

    // The feed body changed (a new item), so it is parsed again.
    vi.setSystemTime(NOW + 600_000);
    setAaFeed([
      {
        title: "Bakan Bayraktar enerji yatırımlarını anlattı",
        link: "https://www.aa.com.tr/tr/ekonomi/bakan-bayraktar-enerji-yatirimlarini-anlatti/4118999",
        pubDate: "Mon, 09 Nov 2026 21:10:00 +0300",
      },
      ...feed,
    ]);
    const again = await cycle();

    expect(again.itemsKnownSkipped).toBe(1);
    expect(again.inserted).toBe(1);
    expect(again.reslugRestamped).toBe(0);
    expect(reslugReads.map((r) => r.or)).toEqual(["url.like.*/4118999"]);
    expect(stored(RESLUG_URL)?.published_at).toBe(NOW_ISO);
  });
});

describe("a re-slug is counted only when its row survives the twin drop (review of h115, CR-5)", () => {
  // A stored row whose headline shares words with the re-slug's: for AA the
  // source_article_key is the same trailing id, so dropExistingSourceArticleKeyRows
  // takes the restamped row as a twin of it and it never reaches the database.
  const TWIN_TITLE = "Gabar'da iki yeni sahada petrol keşfi";

  it("a restamped row dropped as a stored twin is not counted, not logged and not inserted", async () => {
    seedSources();
    seedStored(LIVE_URL, TWIN_TITLE);
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);

    const stats = await cycle();

    expect(stats.reslugRestamped).toBe(0);
    expect(stats.reslugLookupErrors).toBe(0);
    expect(stats.inserted).toBe(0);
    expect(stats.twinsDropped).toBe(1);
    expect(stored(RESLUG_URL)).toBeUndefined();
    expect(logLines.filter((l) => l.includes("re-slugged item(s) stamped"))).toEqual([]);
    // The lookup itself still ran: only the count waits for the survivor.
    expect(reslugReads).toHaveLength(1);
  });

  it("two re-slugs in one feed, one dropped as a twin: only the survivor is counted and logged", async () => {
    seedSources();
    seedStored(LIVE_URL, TWIN_TITLE);
    const otherLive = "https://www.aa.com.tr/tr/gundem/canli-cumhurbaskani-erdogan-konusuyor/4116605";
    seedStored(otherLive, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    const otherReslug = "https://www.aa.com.tr/tr/gundem/erdogan-insanimizin-huzuruna-cikiyor/4116605";
    setAaFeed([
      { title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE },
      { title: "Bakan Bayraktar enerji yatırımlarını anlattı", link: otherReslug, pubDate: STUB_PUBDATE },
    ]);
    setOtherFeed([]);

    const stats = await cycle();

    expect(stored(RESLUG_URL)).toBeUndefined();
    expect(stored(otherReslug)?.published_at).toBe(NOW_ISO);
    expect(stats.reslugRestamped).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.twinsDropped).toBe(1);
    expect(logLines.filter((l) => l.includes("re-slugged item(s) stamped"))).toEqual([
      "[ingest] anadolu-ajansi: 1 re-slugged item(s) stamped with first-seen time",
    ]);
  });
});

describe("everything else keeps its parsed pubDate", () => {
  it("a new AA id with no stored match keeps the feed's pubDate (one select was made)", async () => {
    seedSources();
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);

    const stats = await cycle();

    expect(stored(RESLUG_URL)?.published_at).toBe(STUB_ISO);
    expect(stats.reslugRestamped).toBe(0);
    expect(stats.reslugLookupErrors).toBe(0);
    expect(reslugReads).toHaveLength(1);
    expect(logLines.filter((l) => l.includes("re-slugged"))).toEqual([]);
  });

  it("the same url re-seen takes the known-url skip: no select, nothing rewritten", async () => {
    seedSources();
    const row = seedStored(RESLUG_URL, RESLUG_TITLE);
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);

    const stats = await cycle();

    expect(stats.itemsKnownSkipped).toBe(1);
    expect(stats.itemsNormalized).toBe(0);
    expect(stats.inserted).toBe(0);
    expect(stats.reslugRestamped).toBe(0);
    expect(reslugReads).toEqual([]);
    expect(row.published_at).toBe(STUB_ISO);
  });

  it("the same url with an edited headline is not an absent url: no select", async () => {
    seedSources();
    // A twin of that url already exists, so a restamp would be possible if the url were absent.
    seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    const row = seedStored(RESLUG_URL, "Gabar'da petrol keşfedildi");
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);

    const stats = await cycle();

    expect(stats.reslugRestamped).toBe(0);
    expect(reslugReads).toEqual([]);
    expect(row.published_at).toBe(STUB_ISO);
  });

  it("another source whose url ends in the same digits is untouched and costs no select", async () => {
    seedSources();
    seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    const otherUrl = "https://www.other-outlet.example/haber/gabarda-yeni-petrol-sahasi/4117359";
    setAaFeed([]);
    setOtherFeed([{ title: "Gabarda yeni petrol sahası bulundu", link: otherUrl, pubDate: STUB_PUBDATE }]);

    const stats = await cycle();

    expect(stored(otherUrl)?.source_id).toBe(OTHER);
    expect(stored(otherUrl)?.published_at).toBe(STUB_ISO);
    expect(stats.reslugRestamped).toBe(0);
    expect(reslugReads).toEqual([]);
  });

  it("a stored row of ANOTHER source with the same digits does not restamp an AA item", async () => {
    seedSources();
    seedStored("https://www.other-outlet.example/haber/gabarda-yeni-petrol-sahasi/4117359", "Gabarda yeni petrol sahası", {
      sourceId: OTHER,
    });
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);

    const stats = await cycle();

    expect(stored(RESLUG_URL)?.published_at).toBe(STUB_ISO);
    expect(stats.reslugRestamped).toBe(0);
    expect(reslugReads).toHaveLength(1);
    expect(reslugReads[0]?.sourceId).toBe(AA);
  });

  it("a stored match older than the 7-day window does not restamp", async () => {
    seedSources();
    seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor", { createdAt: "2026-11-01T16:27:10.000Z" });
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);

    const stats = await cycle();

    expect(stored(RESLUG_URL)?.published_at).toBe(STUB_ISO);
    expect(stats.reslugRestamped).toBe(0);
  });

  it("an AA url whose only digits are in the query string builds no filter and sends no select", async () => {
    seedSources();
    seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    const q = "https://www.aa.com.tr/tr/gundem/gabar-petrol-haberi?id=4117359";
    setAaFeed([{ title: RESLUG_TITLE, link: q, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);

    const stats = await cycle();

    expect(stored(q)?.published_at).toBe(STUB_ISO);
    expect(stats.reslugRestamped).toBe(0);
    expect(reslugReads).toEqual([]);
  });
});

describe("fail open", () => {
  it("an error envelope keeps the parsed pubDate, counts reslugLookupErrors and never blocks the insert", async () => {
    seedSources();
    seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);
    reslugMode = "error";

    const stats = await cycle();

    expect(stored(RESLUG_URL)?.published_at).toBe(STUB_ISO);
    expect(stats.reslugRestamped).toBe(0);
    expect(stats.reslugLookupErrors).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it("a rejected request is the same: parsed pubDate, one error, the row is stored", async () => {
    seedSources();
    seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);
    reslugMode = "throw";

    const stats = await cycle();

    expect(stored(RESLUG_URL)?.published_at).toBe(STUB_ISO);
    expect(stats.reslugLookupErrors).toBe(1);
    expect(stats.inserted).toBe(1);
  });

  it("the failure line carries the slug and a redacted message, never a url, an id or a headline", async () => {
    seedSources();
    seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);
    reslugMode = "error";

    await cycle();

    const lines = errorLines.filter((l) => l.includes("re-slug"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("anadolu-ajansi");
    expect(lines[0]).not.toMatch(/https?:\/\//);
    expect(lines[0]).not.toContain("4117359");
    expect(lines[0]).not.toContain("Gabar");
    expect(lines[0]).not.toContain("secret");
  });

  it("when the known-url lookup failed nothing is confirmed absent: no re-slug select, parsed pubDate", async () => {
    seedSources();
    seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);
    knownUrlFails = true;

    const stats = await cycle();

    expect(stats.knownUrlLookupErrors).toBe(1);
    expect(reslugReads).toEqual([]);
    expect(stats.reslugRestamped).toBe(0);
    expect(stats.reslugLookupErrors).toBe(0);
    expect(stored(RESLUG_URL)?.published_at).toBe(STUB_ISO);
  });
});

describe("the PostgREST filter is built from the captured digits only", () => {
  it("raw url text never reaches the filter: a url full of filter syntax contributes only its id", async () => {
    seedSources();
    const hostile = "https://www.aa.com.tr/tr/gundem/a),or(source_id.neq.x,url.like.*%25/4117360";
    setAaFeed([{ title: "Kötü niyetli bağlantı", link: hostile, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);

    const stats = await cycle();

    expect(reslugReads).toHaveLength(1);
    expect((reslugReads[0] as ReslugRead).or).toBe("url.like.*/4117360");
    expect(stats.reslugLookupErrors).toBe(0);
  });

  it("sends at most 50 ids per select and each filter stays under URL_LOOKUP_MAX_BYTES", async () => {
    seedSources();
    const items: FeedItem[] = [];
    for (let i = 0; i < 120; i++) {
      const id = 5_000_001 + i;
      items.push({
        title: `Haber ${LETTERS(i)} ayrintisi ${LETTERS(i * 7 + 3)} gelisme ${LETTERS(i * 13 + 5)}`,
        link: `https://www.aa.com.tr/tr/gundem/haber-numara-${id}-ayrinti-${i}/${id}`,
        pubDate: STUB_PUBDATE,
      });
    }
    // An earlier URL of id 5000075 (the 2nd batch): its re-slug must be found there.
    seedStored("https://www.aa.com.tr/tr/gundem/eski-baslik/5000075", "Eski başlık tamamen farkli");
    setAaFeed(items);
    setOtherFeed([]);
    const mod = (await import("../../supabase/functions/ingest/index.ts")) as unknown as {
      URL_LOOKUP_MAX_BYTES: number;
    };

    const stats = await cycle();

    expect(reslugReads.map((r) => likeIds(r.or).length)).toEqual([50, 50, 20]);
    for (const r of reslugReads) {
      expect(r.or).toMatch(/^url\.like\.\*\/[0-9]{6,9}(,url\.like\.\*\/[0-9]{6,9})*$/);
      expect(encodeURIComponent(r.or).length).toBeLessThan(mod.URL_LOOKUP_MAX_BYTES);
    }
    expect(stats.reslugRestamped).toBe(1);
    expect(stored("https://www.aa.com.tr/tr/gundem/haber-numara-5000075-ayrinti-74/5000075")?.published_at).toBe(
      NOW_ISO,
    );
    expect(stored("https://www.aa.com.tr/tr/gundem/haber-numara-5000001-ayrinti-0/5000001")?.published_at).toBe(
      STUB_ISO,
    );
  });
});

describe("a cycle with no AA item", () => {
  it("reports both counters as 0 and logs nothing about re-slugs", async () => {
    seedSources();
    setAaFeed([]);
    setOtherFeed([
      {
        title: "Başka bir yayıncıdan haber",
        link: "https://www.other-outlet.example/haber/baska-haber/7000001",
        pubDate: STUB_PUBDATE,
      },
    ]);

    const body = await cycle();

    expect(body.reslugRestamped).toBe(0);
    expect(body.reslugLookupErrors).toBe(0);
    expect(logLines.filter((l) => l.includes("re-slugged"))).toEqual([]);
    expect(reslugReads).toEqual([]);
  });
});

type IngestModule = {
  planReslugFilters: (ids: readonly string[], maxCount?: number, maxBytes?: number) => string[];
  restampResluggedRows: <T extends { url: string; published_at: string }>(
    supabase: unknown,
    slug: string,
    sourceId: string,
    rows: readonly T[],
    nowMs: number,
  ) => Promise<{ restamped: number; lookupErrors: number; urls: string[] }>;
  RESLUG_LOOKUP_BATCH: number;
  URL_LOOKUP_MAX_BYTES: number;
};

async function ingestModule(): Promise<IngestModule> {
  return (await import("../../supabase/functions/ingest/index.ts")) as unknown as IngestModule;
}

describe("planReslugFilters", () => {
  it("is one `url.like.*/<id>` filter per id, joined by commas, in order, duplicates once", async () => {
    const { planReslugFilters } = await ingestModule();
    expect(planReslugFilters(["4117359", "4116605", "4117359"])).toEqual([
      "url.like.*/4117359,url.like.*/4116605",
    ]);
  });

  it("is empty for no ids", async () => {
    const { planReslugFilters } = await ingestModule();
    expect(planReslugFilters([])).toEqual([]);
  });

  it("drops anything that is not all ASCII digits, so no operator character can reach the filter", async () => {
    const { planReslugFilters } = await ingestModule();
    const out = planReslugFilters([
      "4117359",
      "4117359,source_id.neq.x",
      "1),or(a.eq.1",
      "12 34",
      "٣٤٥٦٧٨٩",
      "",
      "4116605\n",
      "*",
      undefined as unknown as string,
      42 as unknown as string,
    ]);
    expect(out).toEqual(["url.like.*/4117359"]);
  });

  it("cuts at the id count and at the byte budget, losing no id", async () => {
    const { planReslugFilters, RESLUG_LOOKUP_BATCH } = await ingestModule();
    expect(RESLUG_LOOKUP_BATCH).toBe(50);
    const ids = Array.from({ length: 120 }, (_, i) => String(4_000_000 + i));
    const byCount = planReslugFilters(ids);
    expect(byCount.map((f) => f.split(",").length)).toEqual([50, 50, 20]);
    // A tiny byte budget forces more, smaller requests; every id is still sent once.
    const byBytes = planReslugFilters(ids, 50, 200);
    expect(byBytes.length).toBeGreaterThan(byCount.length);
    for (const f of byBytes) expect(encodeURIComponent(f).length).toBeLessThanOrEqual(200);
    expect(byBytes.flatMap(likeIds)).toEqual(ids);
  });
});

describe("restampResluggedRows", () => {
  const SOURCE_ID = "src-anadolu-ajansi";
  const row = (url: string) => ({ url, published_at: STUB_ISO });

  /** A supabase stand-in whose articles select answers `urls` for any `.or`. */
  function client(answer: () => { data: unknown; error: { message: string } | null }) {
    const calls: Array<{ or?: string; eq?: unknown; gte?: unknown }> = [];
    const builder = () => {
      const call: { or?: string; eq?: unknown; gte?: unknown } = {};
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: (_c: string, v: unknown) => ((call.eq = v), b),
        gte: (_c: string, v: unknown) => ((call.gte = v), b),
        or: (f: string) => ((call.or = f), b),
        then: (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) => {
          calls.push(call);
          return Promise.resolve(answer()).then(f, r);
        },
      });
      return b;
    };
    return { from: () => builder(), calls };
  }

  it("restamps a row whose id is stored under a different url, and no other", async () => {
    const { restampResluggedRows } = await ingestModule();
    const a = row(RESLUG_URL);
    const b = row("https://www.aa.com.tr/tr/gundem/baska-haber/4118000");
    const c = client(() => ({ data: [{ url: LIVE_URL }], error: null }));
    const out = await restampResluggedRows(c, "anadolu-ajansi", SOURCE_ID, [a, b], NOW);
    // `urls` names exactly the rows stamped, so the caller can count the ones that survive.
    expect(out).toEqual({ restamped: 1, lookupErrors: 0, urls: [RESLUG_URL] });
    expect(a.published_at).toBe(NOW_ISO);
    expect(b.published_at).toBe(STUB_ISO);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]?.eq).toBe(SOURCE_ID);
    expect(c.calls[0]?.gte).toBe("2026-11-02T18:09:00.000Z");
  });

  it("a stored row with the row's OWN url is not a re-slug", async () => {
    const { restampResluggedRows } = await ingestModule();
    const a = row(RESLUG_URL);
    const c = client(() => ({ data: [{ url: RESLUG_URL }], error: null }));
    const out = await restampResluggedRows(c, "anadolu-ajansi", SOURCE_ID, [a], NOW);
    expect(out.restamped).toBe(0);
    expect(a.published_at).toBe(STUB_ISO);
  });

  it("the row's own url next to another stored url still counts as a re-slug", async () => {
    const { restampResluggedRows } = await ingestModule();
    const a = row(RESLUG_URL);
    const c = client(() => ({ data: [{ url: RESLUG_URL }, { url: LIVE_URL }], error: null }));
    expect((await restampResluggedRows(c, "anadolu-ajansi", SOURCE_ID, [a], NOW)).restamped).toBe(1);
    expect(a.published_at).toBe(NOW_ISO);
  });

  it("ignores stored answers that are not urls of that id (malformed rows, other ids)", async () => {
    const { restampResluggedRows } = await ingestModule();
    const a = row(RESLUG_URL);
    const c = client(() => ({
      data: [{ url: null }, { url: 42 }, {}, { url: "https://www.aa.com.tr/tr/gundem/baska/4999999" }],
      error: null,
    }));
    const out = await restampResluggedRows(c, "anadolu-ajansi", SOURCE_ID, [a], NOW);
    expect(out).toEqual({ restamped: 0, lookupErrors: 0, urls: [] });
    expect(a.published_at).toBe(STUB_ISO);
  });

  it("makes no request for rows without an id or for a source that is not listed", async () => {
    const { restampResluggedRows } = await ingestModule();
    const c = client(() => ({ data: [{ url: LIVE_URL }], error: null }));
    const none = row("https://www.aa.com.tr/tr/gundem/sadece-slug");
    expect(await restampResluggedRows(c, "anadolu-ajansi", SOURCE_ID, [none], NOW)).toEqual({
      restamped: 0,
      lookupErrors: 0,
      urls: [],
    });
    const other = row(RESLUG_URL);
    expect(await restampResluggedRows(c, "trt-haber", "src-trt", [other], NOW)).toEqual({
      restamped: 0,
      lookupErrors: 0,
      urls: [],
    });
    expect(await restampResluggedRows(c, "anadolu-ajansi", SOURCE_ID, [], NOW)).toEqual({
      restamped: 0,
      lookupErrors: 0,
      urls: [],
    });
    expect(c.calls).toEqual([]);
    expect(other.published_at).toBe(STUB_ISO);
  });

  it("a failed batch loses only its own ids: the other batches still restamp", async () => {
    const { restampResluggedRows } = await ingestModule();
    // 60 new rows -> two batches (50 + 10). The first answers an error, the second finds a match.
    const rows = Array.from({ length: 60 }, (_, i) =>
      row(`https://www.aa.com.tr/tr/gundem/yeni-baslik-${i}/${4_200_000 + i}`),
    );
    let n = 0;
    const c = client(() => {
      n++;
      return n === 1
        ? { data: null, error: { message: "timeout" } }
        : { data: [{ url: "https://www.aa.com.tr/tr/gundem/eski-baslik/4200055" }], error: null };
    });
    const out = await restampResluggedRows(c, "anadolu-ajansi", SOURCE_ID, rows, NOW);
    expect(out).toEqual({ restamped: 1, lookupErrors: 1, urls: [rows[55]!.url] });
    expect(rows[55]?.published_at).toBe(NOW_ISO);
    expect(rows.filter((r) => r.published_at === NOW_ISO)).toHaveLength(1);
  });

  it("never throws: a nowMs that is not a date counts one error and restamps nothing", async () => {
    const { restampResluggedRows } = await ingestModule();
    const a = row(RESLUG_URL);
    const c = client(() => ({ data: [{ url: LIVE_URL }], error: null }));
    const out = await restampResluggedRows(c, "anadolu-ajansi", SOURCE_ID, [a], Number.NaN);
    expect(out).toEqual({ restamped: 0, lookupErrors: 1, urls: [] });
    expect(a.published_at).toBe(STUB_ISO);
  });
});

// ---------------------------------------------------------------------------
// h132-purity-1: a source OTHER than AA that reuses an article id under a different
// url (a new story under an old id) ships the old item's pubDate. dropExistingSource-
// ArticleKeyRows keeps the row (its headline shares no words with the stored one) and
// now stamps it with the poll clock when its pubDate is not later than the first time
// the id was seen. Cluster 99f8fd67: Evrensel key 6008841, pubDate 2026-11-10T13:11Z,
// the first row created 13:24Z, the second 20:24Z.
// ---------------------------------------------------------------------------
describe("a reused id from a source other than AA is stamped with the poll clock [h132-purity-1]", () => {
  const EV = "src-evrensel";
  const EV_RSS = "https://www.evrensel.net/rss/haber.xml";
  const EV_NOW = Date.parse("2026-11-10T20:24:11Z");
  const EV_NOW_ISO = "2026-11-10T20:24:11.000Z";
  // 16:11 Istanbul = 13:11Z, carried by both stories.
  const EV_PUBDATE = "Tue, 10 Nov 2026 16:11:00 +0300";
  const EV_PUB_ISO = "2026-11-10T13:11:00.000Z";
  const EV_OLD_URL =
    "https://www.evrensel.net/haber/6008841/fon-vurgunu-sorusturmasi-aralarinda-murat-gulkan-ve-yunus-arinci-nin-oldugu-5-kisi-adliyeye-sevk-edildi";
  const EV_OLD_TITLE =
    "Fon vurgunu soruşturması: Aralarında Murat Gülkan ve Yunus Arıncı'nın olduğu 5 kişi adliyeye sevk edildi";
  const EV_NEW_URL =
    "https://www.evrensel.net/haber/6008841/fon-vurgunu-sorusturmasi-eski-takasbank-genel-mudurunun-de-aralarinda-oldugu-3-kisiye-tutuklama-talebi";
  const EV_NEW_TITLE =
    "Fon vurgunu soruşturması: Eski Takasbank Genel Müdürü'nün de aralarında olduğu 3 kişiye tutuklama talebi";

  function seedAll(): void {
    seedSources();
    sourcesTable.push(source("evrensel", "https://www.evrensel.net", EV_RSS));
    vi.setSystemTime(EV_NOW);
  }
  function setEvFeed(items: FeedItem[]): void {
    feeds.set(new URL(EV_RSS).toString(), rss(items));
  }
  function seedEvOld(): ArticleRec {
    return seedStored(EV_OLD_URL, EV_OLD_TITLE, {
      sourceId: EV,
      key: "6008841",
      publishedAt: EV_PUB_ISO,
      createdAt: "2026-11-10T13:24:04.851Z",
    });
  }

  it("stamps the second story of key 6008841 with the poll clock and leaves the stored first one alone", async () => {
    seedAll();
    const first = seedEvOld();
    setAaFeed([]);
    setOtherFeed([]);
    setEvFeed([{ title: EV_NEW_TITLE, link: EV_NEW_URL, pubDate: EV_PUBDATE }]);

    const stats = await cycle();

    expect(stored(EV_NEW_URL)?.published_at).toBe(EV_NOW_ISO);
    expect(stats.keyReuseRestamped).toBe(1);
    expect(stats.reslugRestamped).toBe(0);
    expect(stats.inserted).toBe(1);
    expect(stats.twinsDropped).toBe(0);
    expect(stats.twinsKeptDistinct).toBe(1);
    // Stored rows are never rewritten.
    expect(stored(EV_OLD_URL)).toBe(first);
    expect(first.published_at).toBe(EV_PUB_ISO);
  });

  it("logs ONE count-only line for the chunk: no url, no key, no headline", async () => {
    seedAll();
    seedEvOld();
    setAaFeed([]);
    setOtherFeed([]);
    setEvFeed([{ title: EV_NEW_TITLE, link: EV_NEW_URL, pubDate: EV_PUBDATE }]);

    await cycle();

    const lines = logLines.filter((l) => l.includes("same-id row(s) whose pubDate predates"));
    expect(lines).toEqual([
      "[ingest] restamped 1 same-id row(s) whose pubDate predates the id's first sighting in chunk 0-1",
    ]);
    for (const l of lines) {
      expect(l).not.toMatch(/https?:\/\//);
      expect(l).not.toContain("6008841");
      expect(l).not.toContain("Takasbank");
    }
  });

  it("puts keyReuseRestamped in the cycle JSON and in the [ingest] cycle summary line", async () => {
    seedAll();
    seedEvOld();
    setAaFeed([]);
    setOtherFeed([]);
    setEvFeed([{ title: EV_NEW_TITLE, link: EV_NEW_URL, pubDate: EV_PUBDATE }]);

    const body = await cycle();

    expect(body.keyReuseRestamped).toBe(1);
    const summary = logLines.filter((l) => l.startsWith("[ingest] cycle"));
    expect(summary.length).toBeGreaterThan(0);
    const json = JSON.parse(
      (summary[summary.length - 1] as string).replace("[ingest] cycle", ""),
    ) as Record<string, unknown>;
    expect(json.keyReuseRestamped).toBe(1);
  });

  it("reports 0 (and logs nothing) when no id was reused", async () => {
    seedAll();
    setAaFeed([]);
    setOtherFeed([]);
    setEvFeed([{ title: EV_NEW_TITLE, link: EV_NEW_URL, pubDate: EV_PUBDATE }]);

    const body = await cycle();

    expect(body.keyReuseRestamped).toBe(0);
    expect(stored(EV_NEW_URL)?.published_at).toBe(EV_PUB_ISO);
    expect(logLines.filter((l) => l.includes("same-id row(s)"))).toEqual([]);
  });

  it("10. keyReuseRestamped equals the stamped rows that reach the upsert: a twin is neither stamped nor counted", async () => {
    seedAll();
    seedEvOld();
    // A second id with a stored story whose edited headline is a twin (dropped, never stamped).
    seedStored(
      "https://www.evrensel.net/haber/6008900/merkez-bankasi-faizi-sabit-tuttu",
      "Merkez Bankası faizi sabit tuttu",
      { sourceId: EV, key: "6008900", publishedAt: EV_PUB_ISO, createdAt: "2026-11-10T13:30:00.000Z" },
    );
    // A third id reused for an unrelated story.
    seedStored(
      "https://www.evrensel.net/haber/6008950/derbi-oncesi-kritik-aciklama",
      "Derbi öncesi kritik açıklama",
      { sourceId: EV, key: "6008950", publishedAt: EV_PUB_ISO, createdAt: "2026-11-10T13:31:00.000Z" },
    );
    setAaFeed([]);
    setOtherFeed([]);
    setEvFeed([
      { title: EV_NEW_TITLE, link: EV_NEW_URL, pubDate: EV_PUBDATE },
      {
        title: "Merkez Bankası faiz kararını açıkladı",
        link: "https://www.evrensel.net/haber/6008900/merkez-bankasi-faiz-kararini-acikladi",
        pubDate: EV_PUBDATE,
      },
      {
        title: "Deprem sonrası yeni açıklama",
        link: "https://www.evrensel.net/haber/6008950/deprem-sonrasi-yeni-aciklama",
        pubDate: EV_PUBDATE,
      },
      {
        title: "Hiç görülmemiş haber",
        link: "https://www.evrensel.net/haber/6009001/hic-gorulmemis-haber",
        pubDate: EV_PUBDATE,
      },
    ]);

    const stats = await cycle();

    expect(stats.twinsDroppedStored).toBe(1);
    expect(stored("https://www.evrensel.net/haber/6008900/merkez-bankasi-faiz-kararini-acikladi")).toBeUndefined();
    expect(stored(EV_NEW_URL)?.published_at).toBe(EV_NOW_ISO);
    expect(stored("https://www.evrensel.net/haber/6008950/deprem-sonrasi-yeni-aciklama")?.published_at).toBe(
      EV_NOW_ISO,
    );
    // A brand-new id keeps its feed pubDate.
    expect(stored("https://www.evrensel.net/haber/6009001/hic-gorulmemis-haber")?.published_at).toBe(EV_PUB_ISO);
    expect(stats.keyReuseRestamped).toBe(2);
    expect(stats.inserted).toBe(3);
    const stampedInStore = [...articlesStore.values()].filter(
      (r) => r.source_id === EV && r.published_at === EV_NOW_ISO,
    );
    expect(stampedInStore).toHaveLength(stats.keyReuseRestamped as number);
  });

  it("a later cycle takes the stamped row as a known url: nothing is stamped again", async () => {
    seedAll();
    seedEvOld();
    setAaFeed([]);
    setOtherFeed([]);
    const feed: FeedItem[] = [{ title: EV_NEW_TITLE, link: EV_NEW_URL, pubDate: EV_PUBDATE }];
    setEvFeed(feed);
    await cycle();

    vi.setSystemTime(EV_NOW + 600_000);
    setEvFeed([
      {
        title: "Hiç görülmemiş haber",
        link: "https://www.evrensel.net/haber/6009001/hic-gorulmemis-haber",
        pubDate: "Tue, 10 Nov 2026 23:30:00 +0300",
      },
      ...feed,
    ]);
    const again = await cycle();

    expect(again.itemsKnownSkipped).toBe(1);
    expect(again.keyReuseRestamped).toBe(0);
    expect(stored(EV_NEW_URL)?.published_at).toBe(EV_NOW_ISO);
  });

  it("9. AA: a re-slug stamped by restampResluggedRows is counted once, as reslugRestamped, never as keyReuseRestamped", async () => {
    seedAll();
    vi.setSystemTime(NOW);
    const live = seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);
    setEvFeed([]);

    const stats = await cycle();

    expect(stored(RESLUG_URL)?.published_at).toBe(NOW_ISO);
    expect(stats.reslugRestamped).toBe(1);
    expect(stats.keyReuseRestamped).toBe(0);
    expect(stats.inserted).toBe(1);
    expect(logLines.filter((l) => l.includes("same-id row(s)"))).toEqual([]);
    expect(live.published_at).toBe(STUB_ISO);
  });

  it("AA stays #262's: when its re-slug lookup failed the row keeps the parsed pubDate, the key layer does not rescue it", async () => {
    seedAll();
    vi.setSystemTime(NOW);
    seedStored(LIVE_URL, "CANLI - Cumhurbaşkanı Erdoğan konuşuyor");
    setAaFeed([{ title: RESLUG_TITLE, link: RESLUG_URL, pubDate: STUB_PUBDATE }]);
    setOtherFeed([]);
    setEvFeed([]);
    reslugMode = "error";

    const stats = await cycle();

    expect(stats.reslugLookupErrors).toBe(1);
    expect(stats.reslugRestamped).toBe(0);
    expect(stats.keyReuseRestamped).toBe(0);
    expect(stored(RESLUG_URL)?.published_at).toBe(STUB_ISO);
  });
});

describe("miniParseRss sanity for the inline feeds", () => {
  it("parses the items the tests rely on", () => {
    const parsed = miniParseRss(
      rss([{ title: "a", link: "https://x.example/1", pubDate: STUB_PUBDATE }]),
    ) as { rss: { channel: { item: Array<{ link?: string }> } } };
    expect(parsed.rss.channel.item[0]?.link).toBe("https://x.example/1");
  });
});
