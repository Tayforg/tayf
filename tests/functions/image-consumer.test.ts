import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for the image-consumer Edge Function (audit T3 P1-5).
//
// The mandatory check in this file is the SSRF block: when an article page's
// `og:image` resolves to a private / link-local / cloud-metadata IP, the
// consumer MUST refuse to fetch the image and MUST NOT write any URL back
// to the row. The fixture uses `http://169.254.169.254/...`, the AWS / GCP
// instance-metadata host that is the canonical SSRF target.
//
// We also cover the happy path (public CDN image makes it to the row),
// poison messages (read_ct > 3 → archived, never deleted, so the payload
// survives in pgmq.a_image_backfill), and the visibility-timeout /
// batch-size contract that pg_cron relies on.
//
// All collaborators are mocked. No network. No Supabase. No DNS.
// ---------------------------------------------------------------------------

(globalThis as unknown as { Deno?: unknown }).Deno = {
  env: { get: (k: string) => process.env[k] },
  serve: (handler: (req: Request) => Promise<Response> | Response) => {
    (globalThis as unknown as { __imageHandler?: unknown }).__imageHandler = handler;
    return { finished: Promise.resolve() };
  },
};

// Service-role bearer matching `SUPABASE_SERVICE_ROLE_KEY` set in `beforeEach`.
// Every authorised `new Request(...)` is built via `authedRequest(...)` so the
// `requireServiceRoleBearer` gate in the handler accepts the call. The 401
// regression test below intentionally bypasses this helper.
const TEST_SERVICE_ROLE_KEY = "test-service-role-key";

function authedRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${TEST_SERVICE_ROLE_KEY}`,
    },
  });
}

interface PgmqMessage {
  msg_id: number;
  read_ct: number;
  message: { article_id: string };
}

const pgmqState: {
  pending: PgmqMessage[];
  archived: number[];
  deleted: number[];
} = { pending: [], archived: [], deleted: [] };

function resetPgmqState() {
  pgmqState.pending = [];
  pgmqState.archived = [];
  pgmqState.deleted = [];
}

// Names mirror the real `_shared/pgmq.ts` exports (`readBatch`, `archive`,
// `deleteMessage`, `send`, `queueDepth`); any drift means the SUT silently
// sees undefined.
//
// Signatures take the Supabase client as the leading positional arg —
// matching the real module's `readBatch(client, queue, vt, qty)` etc. —
// so a caller-side drift surfaces as a clear arity mismatch instead of
// being absorbed by JS's lenient positional binding.
vi.mock("../../supabase/functions/_shared/pgmq.ts", () => ({
  readBatch: vi.fn(
    async (_client: unknown, _queue: string, _vt: number, qty: number) => {
      const batch = pgmqState.pending.slice(0, qty);
      pgmqState.pending = pgmqState.pending.slice(qty);
      return batch;
    },
  ),
  archive: vi.fn(
    async (_client: unknown, _queue: string, msgId: number) => {
      pgmqState.archived.push(msgId);
      return true;
    },
  ),
  deleteMessage: vi.fn(
    async (_client: unknown, _queue: string, msgId: number) => {
      pgmqState.deleted.push(msgId);
      return true;
    },
  ),
  send: vi.fn(
    async (_client: unknown, _queue: string, _payload: unknown) => 1,
  ),
  queueDepth: vi.fn(
    async (_client: unknown, _queue: string) => ({
      depth: pgmqState.pending.length,
      oldest_msg_age_sec: null,
    }),
  ),
}));

// Supabase mock: the shared proxy-based fake (see
// `tests/_helpers/supabase-fake.ts`) auto-handles every PostgREST chain
// method — `.select().eq().maybeSingle()`, `.update().eq()`, `.upsert()`,
// `.in()`, `.range()`, etc. — without the test having to enumerate each
// method. The fake's mutation log is mirrored into the legacy
// `articleUpdates` array shape so the existing tripwires
// (`expect(articleUpdates).toContainEqual({...})`,
// `expect(articleUpdates.length).toBeGreaterThan(0)`) keep working
// unmodified.
const fakeArticles: Record<string, { url: string; image_url?: string | null }> =
  {};

// Real backing storage for the article-updates log. The bridge function
// below flushes the shared fake's mutation log into this array; the
// exported `articleUpdates` is a Proxy that flushes before any read so
// assertions never miss in-flight writes.
const _articleUpdatesStore: Array<{ id: string; image_url: string | null }> =
  [];
const articleUpdates = new Proxy(_articleUpdatesStore, {
  get(target, prop, recv) {
    // Lazy flush on any read. Cheap (O(n) over the mutation log) and
    // guarantees assertions like `articleUpdates.length` or
    // `articleUpdates.toContainEqual(...)` see every write the SUT issued.
    flushArticleUpdates();
    return Reflect.get(target, prop, recv);
  },
});

const supabaseFake = await vi.hoisted(async () => {
  // `vi.hoisted` runs before regular imports; vitest 1.x+ supports async
  // factories, and dynamic `import()` resolves `.ts` under vitest's loader
  // (CommonJS `require` does not).
  const helper = await import("../_helpers/supabase-fake");
  const articlesFixture: Record<
    string,
    { url: string; image_url?: string | null }
  > = {};
  const fake = helper.createSupabaseFake({
    tables: {
      articles: (state) => {
        const eqId = state.eq.find((p) => p.col === "id")?.val as
          | string
          | undefined;
        if (eqId !== undefined) {
          const row = articlesFixture[eqId] ?? null;
          return { data: row, error: null, count: row ? 1 : 0 };
        }
        const inIds = state.in.find((p) => p.col === "id")?.vals as
          | string[]
          | undefined;
        if (inIds && inIds.length > 0) {
          const rows = inIds
            .map((id) => articlesFixture[id])
            .filter(
              (r): r is { url: string; image_url?: string | null } =>
                r !== undefined,
            );
          return { data: rows, error: null, count: rows.length };
        }
        return { data: [], error: null, count: 0 };
      },
      // Source id -> slug rows for the extractor choice. The consumer caches
      // this map for 30 minutes after the first message, so the fixture is
      // static: no existing test sets source_id on its article (slug null).
      sources: [
        { id: "src-haberler", slug: "haberler-com" },
        { id: "src-trt", slug: "trt-haber" },
        { id: "src-aa", slug: "anadolu-ajansi" },
        { id: "src-plain", slug: "cumhuriyet" },
        { id: "src-medyascope", slug: "medyascope" },
      ],
    },
  });
  return { fake, articlesFixture };
});

// Bridge: drain the shared fake's mutation log into the legacy
// `_articleUpdatesStore` array shape. Called from the Proxy's getter so
// every read of `articleUpdates` sees the latest writes the SUT issued.
function flushArticleUpdates(): void {
  const log = supabaseFake.fake.calls.update("articles");
  for (let i = _articleUpdatesStore.length; i < log.length; i++) {
    const m = log[i];
    const id = m.state.eq.find((p) => p.col === "id")?.val as
      | string
      | undefined;
    if (!id) continue;
    const patch = (m.patch ?? {}) as { image_url?: string | null };
    _articleUpdatesStore.push({ id, image_url: patch.image_url ?? null });
  }
}

vi.mock("../../supabase/functions/_shared/supabase.ts", () => ({
  createServiceClient: () => {
    const innerClient = supabaseFake.fake.client as {
      from: (t: string) => unknown;
      rpc: (n: string, a?: unknown) => Promise<unknown>;
      auth: unknown;
    };
    return {
      from: (table: string) => {
        // Sync the test-supplied fixture rows into the hoisted resolver
        // map every time the SUT begins a chain so freshly-added articles
        // are visible to the resolver. The hoisted closure can't read the
        // outer `fakeArticles` directly because it captures its own scope.
        for (const k of Object.keys(supabaseFake.articlesFixture))
          delete supabaseFake.articlesFixture[k];
        for (const [k, v] of Object.entries(fakeArticles))
          supabaseFake.articlesFixture[k] = v;
        return innerClient.from(table);
      },
      rpc: (...a: unknown[]) => innerClient.rpc(a[0] as string, a[1]),
      auth: innerClient.auth,
    };
  },
}));

// Mock the SSRF-safe fetch. The error class name must match what
// `_shared/safe-fetch.ts` actually exports — `SafeFetchError` — so the
// SUT's `instanceof` / named-import checks resolve correctly.
class SafeFetchError extends Error {
  code: string;
  constructor(message: string, code = "SSRF_BLOCKED") {
    super(message);
    this.code = code;
  }
}

// Per-test toggle controlling whether the SUT calls the real safe-fetch
// (with Deno.resolveDns + globalThis.fetch stubbed at the global level) or
// the cheap deny-list stub. Default is the stub so the rest of the suite
// stays hermetic and fast; the "real safe-fetch end-to-end happy path"
// test below sets `useRealSafeFetch.value = true` so its single message
// goes through the actual module surface (Round-4 R4-P1).
const safeFetchToggle = vi.hoisted(() => ({
  useReal: false,
  realSafeFetch: null as
    | ((url: string, opts?: unknown) => Promise<unknown>)
    | null,
}));

vi.mock("../../supabase/functions/_shared/safe-fetch.ts", () => ({
  SafeFetchError,
  safeFetch: vi.fn(async (url: string, init?: RequestInit) => {
    if (safeFetchToggle.useReal && safeFetchToggle.realSafeFetch) {
      return safeFetchToggle.realSafeFetch(url, init);
    }
    // Block any URL pointing at link-local, RFC1918, or loopback hosts.
    if (
      /https?:\/\/169\.254\./.test(url) ||
      /https?:\/\/10\./.test(url) ||
      /https?:\/\/192\.168\./.test(url) ||
      /https?:\/\/172\.(1[6-9]|2[0-9]|3[01])\./.test(url) ||
      /https?:\/\/127\./.test(url) ||
      /https?:\/\/\[?::1\]?/.test(url)
    ) {
      throw new SafeFetchError(`blocked: ${url}`, "SSRF_BLOCKED");
    }
    const res = await globalThis.fetch(url, init);
    return {
      status: res.status,
      headers: res.headers,
      body: await res.text(),
      finalUrl: url,
    };
  }),
}));

// `og:image` extraction. We keep this minimal — the real helper does more
// (head-only fetch, charset sniff). The mocked export names mirror the
// real module: `fetchOgImageResult` / `fetchHeroImageResult` (async, fetch the
// article HTML and answer found / none / blocked; these are what the SUT calls),
// the thin url|null wrappers `fetchOgImage` / `fetchHeroImage`, and the
// `isValidImageUrl` guard. The SUT imports them by name. A non-2xx answer is
// classified by the REAL `classifyFetchBlock`, so the block markers under test
// are the production ones.
vi.mock("../../supabase/functions/_shared/og-image.ts", async () => {
  // Pull the mocked safeFetch through the standard module path so the SUT
  // and these helpers share the same instance — and so flipping the
  // safeFetchToggle (Round-4 R4-P1) routes both the SUT and the helpers
  // through the real safe-fetch in the un-stubbed happy-path test.
  const safeFetchModule = await import(
    "../../supabase/functions/_shared/safe-fetch.ts"
  );
  const actualOgImage = await vi.importActual<
    typeof import("../../supabase/functions/_shared/og-image.ts")
  >("../../supabase/functions/_shared/og-image.ts");
  const ogImageFromHtml = (html: string): string | null => {
    const m =
      html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+name="twitter:image"\s+content="([^"]+)"/i);
    return m ? m[1] : null;
  };
  // Validate the extracted og:image URL against the SSRF gate before
  // returning it. The real `safeFetch` rejects private / link-local /
  // metadata-host URLs and throws `SafeFetchError`; here we only need to
  // run the URL through the same deny-list (a tiny HEAD-style probe) to
  // mirror the contract that an SSRF-aware extractor enforces — the SUT
  // writes `image_url` straight to the row, so the URL must already be
  // safe by the time it leaves the extractor.
  const validateImageUrl = async (
    candidate: string | null,
  ): Promise<string | null> => {
    if (!candidate) return null;
    try {
      // Attempting to safeFetch the image URL exercises the deny-list;
      // success means the host resolved to a public IP (or, in mock
      // mode, didn't match the RFC1918 / link-local regex). Failure
      // (SafeFetchError) means we drop the candidate.
      await safeFetchModule.safeFetch(candidate);
      return candidate;
    } catch {
      return null;
    }
  };
  type MockResult =
    | { kind: "found"; url: string }
    | { kind: "none" }
    | { kind: "blocked"; status: number };
  const resultFor = async (articleUrl: string): Promise<MockResult> => {
    try {
      const res = await safeFetchModule.safeFetch(articleUrl);
      const body = typeof (res as { body?: unknown }).body === "string"
        ? (res as { body: string }).body
        : "";
      const status = (res as { status?: number }).status ?? 200;
      if (status < 200 || status >= 300) {
        const headers = (res as { headers?: Headers }).headers;
        return actualOgImage.classifyFetchBlock(status, headers, body) ===
            "challenge"
          ? { kind: "blocked", status }
          : { kind: "none" };
      }
      const url = await validateImageUrl(ogImageFromHtml(body));
      return url === null ? { kind: "none" } : { kind: "found", url };
    } catch {
      return { kind: "none" };
    }
  };
  const fetchOgImageResult = vi.fn(
    async (articleUrl: string, _opts?: unknown) => resultFor(articleUrl),
  );
  const fetchHeroImageResult = vi.fn(
    async (articleUrl: string, _slug?: unknown, _opts?: unknown) =>
      resultFor(articleUrl),
  );
  const fetchOgImage = vi.fn(async (articleUrl: string, _opts?: unknown) => {
    const r = await resultFor(articleUrl);
    return r.kind === "found" ? r.url : null;
  });
  const fetchHeroImage = vi.fn(
    async (articleUrl: string, _slug?: unknown, _opts?: unknown) => {
      const r = await resultFor(articleUrl);
      return r.kind === "found" ? r.url : null;
    },
  );
  const isValidImageUrl = (u: unknown): u is string =>
    typeof u === "string" && /^https?:\/\//.test(u);
  return {
    fetchOgImage,
    fetchHeroImage,
    fetchOgImageResult,
    fetchHeroImageResult,
    isValidImageUrl,
  };
});

// ---------------------------------------------------------------------------
// Global fetch stub for the article HTML responses.
// ---------------------------------------------------------------------------

const htmlResponses: Record<string, string> = {};
// h40-edgefns-1: a URL listed here is answered with exactly this status,
// headers and body instead of a 200 from `htmlResponses` (a Cloudflare challenge
// is a 403 with `cf-mitigated: challenge`). `fetchedUrls` logs every request the
// stub served, so a test can prove the consumer made one request, not a retry.
const rawResponses: Record<
  string,
  { status: number; headers?: Record<string, string>; body?: string }
> = {};
const fetchedUrls: string[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetPgmqState();
  for (const k of Object.keys(fakeArticles)) delete fakeArticles[k];
  for (const k of Object.keys(htmlResponses)) delete htmlResponses[k];
  for (const k of Object.keys(rawResponses)) delete rawResponses[k];
  fetchedUrls.length = 0;
  _articleUpdatesStore.length = 0;
  // Reset the shared Supabase fake's mutation log so each test observes
  // only its own writes — the bridge above derives `articleUpdates` from
  // this log on every read.
  supabaseFake.fake.calls.mutations.length = 0;
  supabaseFake.fake.calls.rpc.length = 0;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_SERVICE_ROLE_KEY;

  globalThis.fetch = (async (
    input: RequestInfo | URL,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    fetchedUrls.push(url);
    const raw = rawResponses[url];
    if (raw !== undefined) {
      return new Response(raw.body ?? "", {
        status: raw.status,
        headers: raw.headers ?? {},
      });
    }
    const html = htmlResponses[url];
    if (html === undefined) return new Response("not found", { status: 404 });
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }) as typeof fetch;
});

// Snapshot the original Deno stub installed at module load so the Round-4
// R4-P1 happy-path test can swap in a resolveDns-capable replacement and
// the suite-wide afterEach can restore the original shape for later tests.
const originalDeno = (globalThis as unknown as { Deno: unknown }).Deno;

afterEach(() => {
  globalThis.fetch = originalFetch;
  // Reset the Round-4 R4-P1 toggle so the next test re-enters with the
  // cheap deny-list stub and the suite's original Deno stub shape.
  safeFetchToggle.useReal = false;
  safeFetchToggle.realSafeFetch = null;
  (globalThis as unknown as { Deno: unknown }).Deno = originalDeno;
  vi.clearAllMocks();
});

async function importHandler(): Promise<
  ((req: Request) => Promise<Response>) | null
> {
  // No try/catch: a failed import must surface as a real test failure,
  // not a silent skip.
  await import("../../supabase/functions/image-consumer/index.ts");
  const reg = (globalThis as unknown as {
    __imageHandler?: (req: Request) => Promise<Response>;
  }).__imageHandler;
  return reg ?? null;
}

describe("image-consumer Edge Function", () => {
  it("backfills a public og:image URL onto the article row (happy path)", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeArticles["art-safe"] = {
      id: "art-safe",
      url: "https://news.example.com/story",
      image_url: null,
    } as { url: string; image_url?: string | null };
    htmlResponses["https://news.example.com/story"] =
      '<html><head>' +
      '<meta property="og:image" content="https://cdn.example.com/cover.jpg" />' +
      "</head></html>";
    pgmqState.pending = [
      { msg_id: 1, read_ct: 1, message: { article_id: "art-safe" } },
    ];

    await handler(authedRequest("http://localhost/image-consumer", { method: "POST" }));

    // Tripwire (R4-P3): the chainable Supabase fake observed at least one
    // article-row update on the happy path. If the proxy fake silently
    // green-passes by no-op-ing the chain, this catches it.
    expect(articleUpdates.length).toBeGreaterThan(0);
    expect(articleUpdates).toContainEqual({
      id: "art-safe",
      image_url: "https://cdn.example.com/cover.jpg",
    });
    expect(pgmqState.archived).toContain(1);
  });

  it("backfills a public og:image through the REAL safe-fetch module (Round-4 R4-P1 un-stub)", async () => {
    // Replace the cheap deny-list stub with the actual safe-fetch
    // implementation for this case. Deno.resolveDns is stubbed at the
    // global level to return a public IPv4; globalThis.fetch is the same
    // article-HTML stub used by every other test. End-to-end: the SUT
    // calls fetchOgImage → real safeFetch → real validateOutboundUrl →
    // stubbed Deno.resolveDns → real fetch → og:image parsed → row
    // updated. Closes the green-for-wrong-reason gap that hid the
    // isPrivateAddress "unparseable address" footgun for two rounds.
    const realSafeFetchModule = await vi.importActual<
      typeof import("../../supabase/functions/_shared/safe-fetch.ts")
    >("../../supabase/functions/_shared/safe-fetch.ts");
    safeFetchToggle.realSafeFetch = realSafeFetchModule.safeFetch as unknown as (
      url: string,
      opts?: unknown,
    ) => Promise<unknown>;
    safeFetchToggle.useReal = true;

    // Install a Deno.resolveDns stub for this case. The fetch stub in
    // beforeEach already serves article HTML keyed by URL. We start from
    // the suite-wide original Deno stub so env.get + serve keep working.
    const denoBase = originalDeno as {
      env: { get: (k: string) => string | undefined };
      serve: (handler: (req: Request) => Promise<Response> | Response) => unknown;
    };
    (globalThis as unknown as { Deno: unknown }).Deno = {
      env: denoBase.env,
      serve: denoBase.serve,
      resolveDns: async (_host: string, recordType: string) => {
        if (recordType === "A") return ["93.184.215.14"];
        throw new Error("NotFound");
      },
    };

    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeArticles["art-real-safefetch"] = {
      id: "art-real-safefetch",
      url: "https://news.example.com/realstory",
      image_url: null,
    } as { url: string; image_url?: string | null };
    htmlResponses["https://news.example.com/realstory"] =
      "<html><head>" +
      '<meta property="og:image" content="https://cdn.example.com/real-cover.jpg" />' +
      "</head></html>";
    pgmqState.pending = [
      { msg_id: 42, read_ct: 1, message: { article_id: "art-real-safefetch" } },
    ];

    await handler(
      authedRequest("http://localhost/image-consumer", { method: "POST" }),
    );

    expect(articleUpdates).toContainEqual({
      id: "art-real-safefetch",
      image_url: "https://cdn.example.com/real-cover.jpg",
    });
    expect(pgmqState.archived).toContain(42);
  });

  it("refuses to fetch og:image targets that resolve to 169.254.169.254 [SSRF — T3 P1-5]", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeArticles["art-ssrf"] = {
      id: "art-ssrf",
      url: "https://attacker.example.com/page",
      image_url: null,
    } as { url: string; image_url?: string | null };
    htmlResponses["https://attacker.example.com/page"] =
      '<html><head>' +
      // The mandatory hostile fixture: AWS / GCP instance-metadata host.
      '<meta property="og:image" content="http://169.254.169.254/latest/meta-data/iam/security-credentials/" />' +
      "</head></html>";
    pgmqState.pending = [
      { msg_id: 2, read_ct: 1, message: { article_id: "art-ssrf" } },
    ];

    await handler(authedRequest("http://localhost/image-consumer", { method: "POST" }));

    // Critical post-condition: NO update with the hostile URL.
    const sawHostile = articleUpdates.some(
      (u) => u.id === "art-ssrf" && u.image_url?.includes("169.254"),
    );
    expect(sawHostile).toBe(false);

    // Either the row was left untouched, or it was patched with NULL — both
    // are acceptable contract outcomes; what matters is the metadata URL
    // never reached storage.
    for (const u of articleUpdates) {
      if (u.id === "art-ssrf") {
        expect(u.image_url ?? "").not.toMatch(/169\.254/);
      }
    }
  });

  it("refuses to follow redirects into RFC1918 / loopback / link-local space", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const hostile = [
      "http://10.0.0.5/img.jpg",
      "http://192.168.1.1/img.jpg",
      "http://172.16.0.1/img.jpg",
      "http://127.0.0.1/img.jpg",
      "http://[::1]/img.jpg",
    ];
    hostile.forEach((u, i) => {
      const articleId = `art-priv-${i}`;
      fakeArticles[articleId] = {
        id: articleId,
        url: `https://news.example.com/s${i}`,
        image_url: null,
      } as { url: string; image_url?: string | null };
      htmlResponses[`https://news.example.com/s${i}`] =
        `<html><head><meta property="og:image" content="${u}" /></head></html>`;
      pgmqState.pending.push({
        msg_id: 100 + i,
        read_ct: 1,
        message: { article_id: articleId },
      });
    });

    await handler(authedRequest("http://localhost/image-consumer", { method: "POST" }));

    for (const u of articleUpdates) {
      expect(u.image_url ?? "").not.toMatch(
        /(?:^|\/)(?:10|127|192\.168|169\.254|172\.(?:1[6-9]|2\d|3[01])|\[?::1)/,
      );
    }
  });

  it("archives (never deletes) messages with read_ct > 3 (poison)", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    pgmqState.pending = [
      { msg_id: 200, read_ct: 4, message: { article_id: "ghost" } },
    ];
    // No fakeArticles["ghost"] → fetch will 404 / article lookup misses.

    // Poison messages are pgmq.archive'd — the body survives in the
    // pgmq.a_image_backfill archive table as the audit trail — and must
    // never be pgmq.delete'd (audit S12).
    await handler(authedRequest("http://localhost/image-consumer", { method: "POST" }));
    expect(pgmqState.archived).toContain(200);
    expect(pgmqState.deleted).not.toContain(200);
  });

  it("returns 200 on empty queue (no work is not an error)", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const res = await handler(
      authedRequest("http://localhost/image-consumer", { method: "POST" }),
    );
    expect(res.status).toBe(200);
  });

  it("caps batch processing under the 30 s wall (smoke)", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const start = Date.now();
    await handler(authedRequest("http://localhost/image-consumer", { method: "POST" }));
    expect(Date.now() - start).toBeLessThan(30_000);
  });

  it("returns 401 without a service-role bearer", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    // No Authorization header → handler must reject before touching the queue.
    const res = await handler(
      new Request("http://localhost/image-consumer", { method: "POST" }),
    );
    expect(res.status).toBe(401);
    expect(articleUpdates).toHaveLength(0);
    expect(pgmqState.archived.length + pgmqState.deleted.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// db-4 ingest half: the og:image backfill must never store a publisher logo
// card or a 'son dakika' stand-in. A rejected placeholder is counted as an
// attempt (bumpAttempt, parked after 5) and the message is archived, so it
// cannot loop. The mocked `isValidImageUrl` above accepts any http(s) URL on
// purpose: only the explicit isPlaceholderImageUrl check in the SUT stands
// between a placeholder og:image and the row.
// ---------------------------------------------------------------------------

describe("image-consumer db-4 ingest half: placeholder og:image is never stored", () => {
  const CNN =
    "https://image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg";

  type FixtureRow = {
    id: string;
    url: string;
    image_url: string | null;
    image_backfill_attempts: number;
  };

  function seedArticle(id: string, attempts: number, ogImage: string): void {
    const row: FixtureRow = {
      id,
      url: `https://news.example.com/${id}`,
      image_url: null,
      image_backfill_attempts: attempts,
    };
    fakeArticles[id] = row as unknown as { url: string; image_url?: string | null };
    htmlResponses[row.url] =
      "<html><head>" +
      `<meta property="og:image" content="${ogImage}" />` +
      "</head></html>";
  }

  function patchesFor(id: string): Array<Record<string, unknown>> {
    return supabaseFake.fake.calls
      .update("articles")
      .filter((m) => m.state.eq.some((p) => p.col === "id" && p.val === id))
      .map((m) => (m.patch ?? {}) as Record<string, unknown>);
  }

  async function runOne(
    msgId: number,
    articleId: string,
  ): Promise<Record<string, number>> {
    const handler = await importHandler();
    if (!handler) throw new Error("handler not registered");
    pgmqState.pending = [
      { msg_id: msgId, read_ct: 1, message: { article_id: articleId } },
    ];
    const res = await handler(
      authedRequest("http://localhost/image-consumer", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, number>;
  }

  it("rejects a cnn-turk placeholder og:image: no image_url write, attempts N -> N+1, archived, summary counts it", async () => {
    seedArticle("art-ph-1", 2, CNN);

    const summary = await runOne(301, "art-ph-1");

    const patches = patchesFor("art-ph-1");
    // Tripwire: the bump DID go through the fake, so the next assertion is
    // not green merely because the chain no-op'd.
    expect(patches).toHaveLength(1);
    expect(patches.some((p) => "image_url" in p)).toBe(false);
    expect(patches[0]?.image_backfill_attempts).toBe(3);
    expect(pgmqState.archived).toContain(301);
    expect(pgmqState.deleted).not.toContain(301);
    expect(summary.placeholders).toBe(1);
    expect(summary.found).toBe(0);
    expect(summary.notFound).toBe(0);
    expect(summary.errored).toBe(0);
    expect(summary.drained).toBe(1);
  });

  it("parks the row (attempted_at about 7 days ahead) when a placeholder is the 5th attempt", async () => {
    seedArticle("art-ph-2", 4, CNN);

    const before = Date.now();
    const summary = await runOne(302, "art-ph-2");

    const patches = patchesFor("art-ph-2");
    expect(patches).toHaveLength(1);
    expect(patches.some((p) => "image_url" in p)).toBe(false);
    expect(patches[0]?.image_backfill_attempts).toBe(5);
    const parkedAt = Date.parse(String(patches[0]?.image_backfill_attempted_at));
    const week = 7 * 24 * 3600 * 1000;
    expect(parkedAt).toBeGreaterThanOrEqual(before + week - 1000);
    expect(parkedAt).toBeLessThanOrEqual(Date.now() + week + 1000);
    expect(pgmqState.archived).toContain(302);
    expect(summary.placeholders).toBe(1);
  });

  it.each([
    ["a basename-pattern placeholder", "https://foto.haberler.com/haber/2026/07/03/son-dakika_o.jpg"],
    [
      "a resizer URL wrapping a placeholder in u=",
      "https://iaahbr.tmgrup.com.tr/c18248/1200/675/0/0/1200/675?u=https://iahbr.tmgrup.com.tr/Defaults/Upload/ahbr-default-1754911102530.png",
    ],
  ])("rejects %s the same way", async (_label, og) => {
    seedArticle("art-ph-3", 0, og);

    const summary = await runOne(303, "art-ph-3");

    const patches = patchesFor("art-ph-3");
    expect(patches.some((p) => "image_url" in p)).toBe(false);
    expect(patches[0]?.image_backfill_attempts).toBe(1);
    expect(pgmqState.archived).toContain(303);
    expect(summary.placeholders).toBe(1);
    expect(summary.found).toBe(0);
  });

  it("still backfills a real og:image and reports placeholders 0", async () => {
    seedArticle("art-ph-4", 2, "https://cdn.example.com/real-cover.jpg");

    const summary = await runOne(304, "art-ph-4");

    expect(patchesFor("art-ph-4")).toContainEqual(
      expect.objectContaining({
        image_url: "https://cdn.example.com/real-cover.jpg",
        image_backfill_attempts: 0,
      }),
    );
    expect(pgmqState.archived).toContain(304);
    expect(summary.found).toBe(1);
    expect(summary.placeholders).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// h15-images-2: the three hero-image slugs read up to 200 KB of heavy pages and
// are retried hourly by the image-backfill-requeue cron job (migration 142), so
// their single fetch gets 8 s; every other slug keeps the 5 s og:image fetch.
// ---------------------------------------------------------------------------
describe("image-consumer extractor timeout by source slug (h15-images-2)", () => {
  const COVER = "https://cdn.example.com/cover.jpg";

  async function runWithSource(articleId: string, sourceId: string): Promise<string> {
    const handler = await importHandler();
    if (!handler) throw new Error("handler not registered");
    const url = `https://news.example.com/${articleId}`;
    fakeArticles[articleId] = {
      id: articleId,
      url,
      source_id: sourceId,
      image_url: null,
      image_backfill_attempts: 1,
    } as unknown as { url: string; image_url?: string | null };
    htmlResponses[url] =
      `<html><head><meta property="og:image" content="${COVER}" /></head></html>`;
    pgmqState.pending = [
      { msg_id: 501, read_ct: 1, message: { article_id: articleId } },
    ];
    const res = await handler(
      authedRequest("http://localhost/image-consumer", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    return url;
  }

  async function extractors() {
    const og = await import("../../supabase/functions/_shared/og-image.ts");
    return {
      hero: og.fetchHeroImageResult as unknown as ReturnType<typeof vi.fn>,
      plain: og.fetchOgImageResult as unknown as ReturnType<typeof vi.fn>,
    };
  }

  it.each([
    ["haberler-com", "src-haberler"],
    ["trt-haber", "src-trt"],
    ["anadolu-ajansi", "src-aa"],
  ])("fetches a %s article with fetchHeroImageResult and an 8000 ms timeout", async (slug, sourceId) => {
    const { hero, plain } = await extractors();
    const url = await runWithSource(`art-hero-${slug}`, sourceId);

    expect(hero).toHaveBeenCalledTimes(1);
    expect(hero.mock.calls[0]).toEqual([url, slug, { timeoutMs: 8000 }]);
    expect(plain).not.toHaveBeenCalled();
    // and the fetched image still lands on the row
    expect(articleUpdates).toContainEqual({ id: `art-hero-${slug}`, image_url: COVER });
  });

  it("fetches any other slug with fetchOgImageResult and a 5000 ms timeout", async () => {
    const { hero, plain } = await extractors();
    const url = await runWithSource("art-plain-1", "src-plain");

    expect(plain).toHaveBeenCalledTimes(1);
    expect(plain.mock.calls[0]).toEqual([url, { timeoutMs: 5000 }]);
    expect(hero).not.toHaveBeenCalled();
    expect(articleUpdates).toContainEqual({ id: "art-plain-1", image_url: COVER });
  });

  it("fetches an article without a source with fetchOgImageResult and a 5000 ms timeout", async () => {
    const handler = await importHandler();
    if (!handler) throw new Error("handler not registered");
    const { hero, plain } = await extractors();
    const url = "https://news.example.com/art-nosource-1";
    fakeArticles["art-nosource-1"] = {
      id: "art-nosource-1",
      url,
      image_url: null,
      image_backfill_attempts: 1,
    } as unknown as { url: string; image_url?: string | null };
    htmlResponses[url] =
      `<html><head><meta property="og:image" content="${COVER}" /></head></html>`;
    pgmqState.pending = [
      { msg_id: 502, read_ct: 1, message: { article_id: "art-nosource-1" } },
    ];
    await handler(authedRequest("http://localhost/image-consumer", { method: "POST" }));

    expect(plain).toHaveBeenCalledTimes(1);
    expect(plain.mock.calls[0]).toEqual([url, { timeoutMs: 5000 }]);
    expect(hero).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// h40-edgefns-1: a Cloudflare-challenged page is not "no image". Medyascope has
// answered every article fetch with 403 + `cf-mitigated: challenge` since
// 2026-10-29 (about 90% of its articles stored without an image); the consumer
// counted each as 'not-found' and nothing showed it. A blocked fetch now has its
// own outcome and summary counters (`blocked`, `blockedBySource`, slugs only),
// but it is handled exactly like not-found: one bumpAttempt, one archive, so the
// row stops at attempts 3 and the 15-minute requeue (attempts 1-2 only) asks a
// blocking site at most 3 times. Nothing is retried here, and no second request
// is made.
// ---------------------------------------------------------------------------
describe("image-consumer blocked pages (h40-edgefns-1)", () => {
  const CHALLENGE_BODY =
    '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>' +
    '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';
  const CHALLENGE_HEADERS = {
    "cf-mitigated": "challenge",
    server: "cloudflare",
    "content-type": "text/html; charset=UTF-8",
  };
  const COVER = "https://cdn.example.com/photos/cover.jpg";

  type Summary = Record<string, unknown> & {
    drained: number;
    found: number;
    notFound: number;
    placeholders: number;
    errored: number;
    blocked: number;
    blockedBySource: Record<string, number>;
  };

  function seed(
    id: string,
    opts: { attempts?: number; sourceId?: string | null } = {},
  ): string {
    const url = `https://medyascope.tv/2026/11/05/${id}/`;
    fakeArticles[id] = {
      id,
      url,
      source_id: opts.sourceId === undefined ? "src-medyascope" : opts.sourceId,
      image_url: null,
      image_backfill_attempts: opts.attempts ?? 0,
    } as unknown as { url: string; image_url?: string | null };
    return url;
  }

  function block(url: string, status = 403): void {
    rawResponses[url] = { status, headers: CHALLENGE_HEADERS, body: CHALLENGE_BODY };
  }

  function patchesFor(id: string): Array<Record<string, unknown>> {
    return supabaseFake.fake.calls
      .update("articles")
      .filter((m) => m.state.eq.some((p) => p.col === "id" && p.val === id))
      .map((m) => (m.patch ?? {}) as Record<string, unknown>);
  }

  async function drainMessages(
    messages: Array<{ msgId: number; articleId: string }>,
  ): Promise<Summary> {
    const handler = await importHandler();
    if (!handler) throw new Error("handler not registered");
    pgmqState.pending = messages.map((m) => ({
      msg_id: m.msgId,
      read_ct: 1,
      message: { article_id: m.articleId },
    }));
    const res = await handler(
      authedRequest("http://localhost/image-consumer", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as Summary;
  }

  it("a challenged page is outcome 'blocked': summary blocked 1, blockedBySource {medyascope: 1}, not a not-found", async () => {
    block(seed("art-blk-1", { attempts: 2 }));

    const summary = await drainMessages([{ msgId: 601, articleId: "art-blk-1" }]);

    expect(summary.blocked).toBe(1);
    expect(summary.blockedBySource).toEqual({ medyascope: 1 });
    expect(summary.notFound).toBe(0);
    expect(summary.found).toBe(0);
    expect(summary.placeholders).toBe(0);
    expect(summary.errored).toBe(0);
    expect(summary.drained).toBe(1);
  });

  it("is handled exactly like not-found: one bumpAttempt (N -> N+1), no image_url write, the message archived not deleted", async () => {
    block(seed("art-blk-2", { attempts: 2 }));

    await drainMessages([{ msgId: 602, articleId: "art-blk-2" }]);

    const patches = patchesFor("art-blk-2");
    // Tripwire: the bump went through the fake, so the next assertions are not green because the chain no-op'd.
    expect(patches).toHaveLength(1);
    expect(patches.some((p) => "image_url" in p)).toBe(false);
    expect(patches[0]?.image_backfill_attempts).toBe(3);
    expect(typeof patches[0]?.image_backfill_attempted_at).toBe("string");
    expect(pgmqState.archived).toEqual([602]);
    expect(pgmqState.deleted).toEqual([]);
  });

  it("parks the row (attempted_at about 7 days ahead) when a blocked fetch is the 5th attempt (a re-enqueued row)", async () => {
    block(seed("art-blk-3", { attempts: 4 }));

    const before = Date.now();
    await drainMessages([{ msgId: 603, articleId: "art-blk-3" }]);

    const patches = patchesFor("art-blk-3");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.image_backfill_attempts).toBe(5);
    const parkedAt = Date.parse(String(patches[0]?.image_backfill_attempted_at));
    const week = 7 * 24 * 3600 * 1000;
    expect(parkedAt).toBeGreaterThanOrEqual(before + week - 1000);
    expect(parkedAt).toBeLessThanOrEqual(Date.now() + week + 1000);
    expect(pgmqState.archived).toContain(603);
  });

  it("makes exactly one request per blocked article: no retry, no second endpoint", async () => {
    const url = seed("art-blk-4");
    block(url);

    await drainMessages([{ msgId: 604, articleId: "art-blk-4" }]);

    expect(fetchedUrls).toEqual([url]);
  });

  it("a 503 'Just a moment...' page and a 429 with the challenge script are blocked too", async () => {
    rawResponses[seed("art-blk-5")] = { status: 503, headers: {}, body: CHALLENGE_BODY };
    rawResponses[seed("art-blk-6")] = {
      status: 429,
      headers: {},
      body: '<script src="/cdn-cgi/challenge-platform/scripts/x.js"></script>',
    };

    const summary = await drainMessages([
      { msgId: 605, articleId: "art-blk-5" },
      { msgId: 606, articleId: "art-blk-6" },
    ]);

    expect(summary.blocked).toBe(2);
    expect(summary.blockedBySource).toEqual({ medyascope: 2 });
    expect(summary.notFound).toBe(0);
  });

  it("counts blocks per source in one drain, slugs only: two outlets and an article without a source", async () => {
    block(seed("art-blk-7"));
    block(seed("art-blk-8"));
    block(seed("art-blk-9", { sourceId: "src-plain" }));
    block(seed("art-blk-10", { sourceId: null }));

    const summary = await drainMessages([
      { msgId: 607, articleId: "art-blk-7" },
      { msgId: 608, articleId: "art-blk-8" },
      { msgId: 609, articleId: "art-blk-9" },
      { msgId: 610, articleId: "art-blk-10" },
    ]);

    expect(summary.blocked).toBe(4);
    expect(summary.blockedBySource).toEqual({ medyascope: 2, cumhuriyet: 1, unknown: 1 });
    expect(pgmqState.archived.sort()).toEqual([607, 608, 609, 610]);
  });

  it("the drain summary carries no URL, host or article id", async () => {
    block(seed("art-blk-11"));

    const summary = await drainMessages([{ msgId: 611, articleId: "art-blk-11" }]);

    const text = JSON.stringify(summary);
    expect(text).not.toContain("http");
    expect(text).not.toContain("medyascope.tv");
    expect(text).not.toContain("art-blk-11");
    expect(text).toContain("medyascope");
  });

  it("a hero-slug source that is blocked is counted by its slug too (fetchHeroImageResult path)", async () => {
    block(seed("art-blk-12", { sourceId: "src-aa" }));

    const summary = await drainMessages([{ msgId: 612, articleId: "art-blk-12" }]);

    expect(summary.blocked).toBe(1);
    expect(summary.blockedBySource).toEqual({ "anadolu-ajansi": 1 });
    expect(patchesFor("art-blk-12")[0]?.image_backfill_attempts).toBe(1);
  });

  it("not-found is unchanged: a plain 403, a 404 and a page with no image are notFound, blocked stays 0", async () => {
    rawResponses[seed("art-nf-1")] = { status: 403, headers: { server: "cloudflare" }, body: "<html>Forbidden</html>" };
    seed("art-nf-2"); // no response registered: the stub answers 404
    const noImage = seed("art-nf-3");
    htmlResponses[noImage] = "<html><head><title>Haber</title></head></html>";

    const summary = await drainMessages([
      { msgId: 621, articleId: "art-nf-1" },
      { msgId: 622, articleId: "art-nf-2" },
      { msgId: 623, articleId: "art-nf-3" },
    ]);

    expect(summary.notFound).toBe(3);
    expect(summary.blocked).toBe(0);
    expect(summary.blockedBySource).toEqual({});
    for (const id of ["art-nf-1", "art-nf-2", "art-nf-3"]) {
      expect(patchesFor(id)[0]?.image_backfill_attempts).toBe(1);
    }
    expect(pgmqState.archived.sort()).toEqual([621, 622, 623]);
  });

  it("a found image is unchanged: written to the row, attempts reset, blocked 0", async () => {
    const url = seed("art-ok-1", { attempts: 2 });
    htmlResponses[url] = `<html><head><meta property="og:image" content="${COVER}" /></head></html>`;

    const summary = await drainMessages([{ msgId: 631, articleId: "art-ok-1" }]);

    expect(patchesFor("art-ok-1")).toContainEqual(
      expect.objectContaining({ image_url: COVER, image_backfill_attempts: 0 }),
    );
    expect(summary.found).toBe(1);
    expect(summary.blocked).toBe(0);
    expect(summary.blockedBySource).toEqual({});
  });

  it("a placeholder og:image is unchanged: placeholders 1, blocked 0", async () => {
    const url = seed("art-ph-b1");
    htmlResponses[url] =
      '<html><head><meta property="og:image" content="https://image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg" /></head></html>';

    const summary = await drainMessages([{ msgId: 641, articleId: "art-ph-b1" }]);

    expect(summary.placeholders).toBe(1);
    expect(summary.blocked).toBe(0);
    expect(summary.notFound).toBe(0);
  });

  it("a mixed batch keeps every counter apart", async () => {
    block(seed("art-mix-1"));
    const ok = seed("art-mix-2");
    htmlResponses[ok] = `<html><head><meta property="og:image" content="${COVER}" /></head></html>`;
    seed("art-mix-3"); // 404

    const summary = await drainMessages([
      { msgId: 651, articleId: "art-mix-1" },
      { msgId: 652, articleId: "art-mix-2" },
      { msgId: 653, articleId: "art-mix-3" },
    ]);

    expect(summary).toMatchObject({
      drained: 3,
      found: 1,
      notFound: 1,
      blocked: 1,
      blockedBySource: { medyascope: 1 },
      errored: 0,
    });
  });
});
