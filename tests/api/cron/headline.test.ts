import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HEADLINE_MIN_ARTICLE_COUNT,
  HEADLINE_PROMPT_VERSION,
} from "@/lib/headline/prompt";

// revalidateTag: mocked so we can assert the post-batch cache invalidation
// (cluster-detail:<id> per rewrote cluster + clusters-politics once) without
// touching a real Next.js cache.
const { revalidateTagMock } = vi.hoisted(() => ({
  revalidateTagMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidateTag: revalidateTagMock,
}));

// ---------------------------------------------------------------------------
// Contract tests for /api/cron/headline (Vercel cron, runtime: nodejs).
//
// The route is owned by B6. The salient contract bits are:
//
//   1. CRON_SECRET bearer check (constant-time, `crypto.timingSafeEqual`).
//   2. FAIL-CLOSED: if `CRON_SECRET` env var is unset, the route must
//      return 503 — NEVER 200. (Audit T3 P0-9 verification.)
//   3. With a valid bearer, the route reads N clusters lacking
//      `title_tr_neutral`, calls the LLM, and updates the clusters.
//   4. The LLM client is `vi.mock`ed so no real API is called.
//
// These tests mirror the style of `tests/api/admin.test.ts` — chainable
// Supabase mock, lazy `await import(...)` so the env / mock state is
// established before the route module's top-level code runs.
// ---------------------------------------------------------------------------

interface TableResponse {
  data?: unknown;
  count?: number | null;
  error?: { message: string } | null;
}

const DEFAULT_RESPONSE: TableResponse = { data: [], count: 0, error: null };

const tableResponses: Record<string, TableResponse> = {};

// Real backing storage; the proxy below flushes the shared fake's mutation
// log into this array on every property access so assertions never see a
// stale snapshot.
const _updateCallsStore: Array<{
  table: string;
  patch: unknown;
  eqId: string | null;
}> = [];
const updateCalls = new Proxy(_updateCallsStore, {
  get(target, prop, recv) {
    flushUpdateCalls();
    return Reflect.get(target, prop, recv);
  },
});

function setTableResponse(table: string, response: TableResponse) {
  tableResponses[table] = { ...DEFAULT_RESPONSE, ...response };
}

// Spy on `crypto.timingSafeEqual` via a partial node:crypto mock. The
// route imports the named export at module top-level; we need to wrap it
// here so the constant-time test can assert the comparator was actually
// invoked (rather than the route silently early-exiting on length / `===`).
//
// The closure holds the real implementation captured at mock-factory time
// so we never recurse into the spied symbol.
const timingSafeEqualSpy = vi.fn<
  [NodeJS.ArrayBufferView, NodeJS.ArrayBufferView],
  boolean
>();

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  timingSafeEqualSpy.mockImplementation((a, b) => actual.timingSafeEqual(a, b));
  return {
    ...actual,
    default: actual,
    timingSafeEqual: timingSafeEqualSpy,
  };
});

// The Supabase fake comes from the shared proxy-based factory under
// `tests/_helpers/supabase-fake.ts` — every PostgREST chain method
// (`.select()`, `.eq()`, `.gte()`, `.lte()`, `.is()`, `.in()`, `.range()`,
// `.order()`, `.limit()`, `.update()`, `.upsert()`, `.insert()`,
// `.delete()`, `.single()`, `.maybeSingle()`, `then`/`catch`/`finally`)
// returns the proxy until the terminal `await` resolves to a `{data,error}`
// envelope. The legacy `tableResponses` / `updateCalls` arrays still drive
// the per-test data + assertions; bridges below map between the proxy fake
// and the legacy test surface.
const supabaseFake = await vi.hoisted(async () => {
  // Async hoisted factory; dynamic `import()` resolves `.ts` under
  // vitest's loader (CommonJS `require` does not).
  const helper = await import("../../_helpers/supabase-fake");
  const tableData: Record<string, {
    data?: unknown;
    count?: number | null;
    error?: { message: string } | null;
  }> = {};
  // Every resolver invocation (SELECT *and* the terminal `await` of an
  // UPDATE both route through here — see tests/_helpers/supabase-fake.ts's
  // `resolve()`) is logged with its accumulated builder state. This is the
  // single source of truth for two things this suite needs to assert on:
  //   1. "zero DB access" for the HEADLINE_PAUSED short-circuit — the log
  //      must stay empty.
  //   2. the pick query's predicates (`.eq('is_archived', false)`,
  //      `.order('updated_at', ...)`) — identified by `order.length > 0`,
  //      since only the pick query calls `.order()`; the per-row `.update()`
  //      calls only ever `.eq('id', ...)`.
  const dbAccessLog: Array<{
    table: string;
    state: import("../../_helpers/supabase-fake").BuilderState;
  }> = [];
  const fake = helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        dbAccessLog.push({ table: "clusters", state });
        const r = tableData["clusters"] ?? { data: [], count: 0, error: null };
        return {
          data: r.data ?? [],
          error: r.error ?? null,
          count: r.count ?? null,
        };
      },
      cluster_articles: (state) => {
        dbAccessLog.push({ table: "cluster_articles", state });
        const r =
          tableData["cluster_articles"] ?? { data: [], count: 0, error: null };
        return {
          data: r.data ?? [],
          error: r.error ?? null,
          count: r.count ?? null,
        };
      },
    },
  });
  return { fake, tableData, dbAccessLog };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    const innerClient = supabaseFake.fake.client as {
      from: (t: string) => unknown;
      rpc: (n: string, a?: unknown) => Promise<unknown>;
      auth: unknown;
    };
    return {
      from: (table: string) => {
        // Mirror the outer `tableResponses` into the hoisted resolver map so
        // each test's `setTableResponse(...)` is visible to the fake.
        for (const k of Object.keys(supabaseFake.tableData))
          delete supabaseFake.tableData[k];
        for (const [k, v] of Object.entries(tableResponses))
          supabaseFake.tableData[k] = v;
        return innerClient.from(table);
      },
      rpc: (...a: unknown[]) => innerClient.rpc(a[0] as string, a[1]),
      auth: innerClient.auth,
    };
  },
}));

// Bridge: drain the shared fake's mutation log into the legacy
// `_updateCallsStore` shape. Called from the `updateCalls` Proxy on every
// property access so the assertions see every write the route issued —
// independent of whether the chain's terminal `then` was intercepted.
function flushUpdateCalls(): void {
  const log = supabaseFake.fake.calls.mutations;
  for (let i = _updateCallsStore.length; i < log.length; i++) {
    const m = log[i];
    if (m.op !== "update") continue;
    const eqId =
      (m.state.eq.find((p) => p.col === "id")?.val as string | undefined) ??
      null;
    _updateCallsStore.push({ table: m.table, patch: m.patch, eqId });
  }
}

// LLM client interception. The headline route talks to Anthropic's
// `/v1/messages` endpoint over plain `fetch` (no vendored SDK), so we
// intercept at the network boundary rather than via `vi.mock("openai", …)`
// — that older mock targeted a dependency the route no longer imports and
// silently allowed the real fetch through.
const LLM_API_URL = "https://api.anthropic.com/v1/messages";
const originalFetch = globalThis.fetch;
let llmFetchSpy: ReturnType<typeof vi.spyOn> | null = null;

function installLlmFetchSpy(): void {
  llmFetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith(LLM_API_URL)) {
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "Tarafsız başlık" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Anything else is unexpected for this route — fail loud rather
      // than punch through to the real network.
      throw new Error(`unexpected fetch to ${url}`);
    });
}

// next/server connection() shim — same rationale as admin.test.ts.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: async () => {},
  };
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  // The route reads ANTHROPIC_API_KEY directly; without it the LLM call
  // path returns null and the test never observes the fetch spy.
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  delete process.env.CRON_SECRET;
  delete process.env.HEADLINE_PAUSED;
  for (const k of Object.keys(tableResponses)) delete tableResponses[k];
  _updateCallsStore.length = 0;
  // Reset the shared Supabase fake's mutation log so each test observes
  // only its own writes.
  supabaseFake.fake.calls.mutations.length = 0;
  supabaseFake.fake.calls.rpc.length = 0;
  supabaseFake.dbAccessLog.length = 0;
  timingSafeEqualSpy.mockClear();
  revalidateTagMock.mockClear();
  installLlmFetchSpy();
});

afterEach(() => {
  if (llmFetchSpy) {
    llmFetchSpy.mockRestore();
    llmFetchSpy = null;
  }
  globalThis.fetch = originalFetch;
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CRON_SECRET",
    "ANTHROPIC_API_KEY",
    "HEADLINE_PAUSED",
  ]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

async function tryImportRoute(): Promise<
  | { GET?: (req: Request) => Promise<Response>; POST?: (req: Request) => Promise<Response> }
  | null
> {
  // No try/catch — a broken route import must surface as a test failure
  // rather than masquerade as a silent skip.
  return await import("@/app/api/cron/headline/route");
}

describe("GET /api/cron/headline", () => {
  it("FAIL-CLOSED: returns 503 when CRON_SECRET env var is unset [T3 P0-9]", async () => {
    delete process.env.CRON_SECRET;

    const mod = await tryImportRoute();
    expect(mod).toBeDefined();
    const handler = mod?.GET ?? mod?.POST;
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const res = await handler(
      new Request("http://example.com/api/cron/headline", {
        headers: { Authorization: "Bearer anything" },
      }),
    );
    // The contract: NEVER 200 without a configured secret.
    expect(res.status).not.toBe(200);
    expect([503, 500]).toContain(res.status);
  });

  it("returns 401 when CRON_SECRET is set but the Authorization header is missing or wrong", async () => {
    process.env.CRON_SECRET = "shhh";

    const mod = await tryImportRoute();
    expect(mod).toBeDefined();
    const handler = mod?.GET ?? mod?.POST;
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const noAuth = await handler(
      new Request("http://example.com/api/cron/headline"),
    );
    expect(noAuth.status).toBe(401);

    const wrong = await handler(
      new Request("http://example.com/api/cron/headline", {
        headers: { Authorization: "Bearer not-the-right-token" },
      }),
    );
    expect(wrong.status).toBe(401);
  });

  it("returns 200 when CRON_SECRET matches and there are no clusters to title (no-op)", async () => {
    process.env.CRON_SECRET = "shhh";
    setTableResponse("clusters", { data: [], error: null });

    const mod = await tryImportRoute();
    expect(mod).toBeDefined();
    const handler = mod?.GET ?? mod?.POST;
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const res = await handler(
      new Request("http://example.com/api/cron/headline", {
        headers: { Authorization: "Bearer shhh" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("calls the LLM and writes title_tr_neutral when clusters lack one", async () => {
    process.env.CRON_SECRET = "shhh";
    // ANTHROPIC_API_KEY is set in beforeEach.
    // Cluster needs `article_count >= MIN_ARTICLE_COUNT` (3) to pass the
    // `.gte("article_count", MIN_ARTICLE_COUNT)` filter on the candidate
    // query. `title_neutral_at` null marks it as needing rewrite.
    setTableResponse("clusters", {
      data: [
        {
          id: "c1",
          title_tr: "Original TR",
          summary_tr: "Original summary",
          title_tr_neutral: null,
          title_neutral_at: null,
          article_count: 4,
        },
      ],
      error: null,
    });
    // Member titles are fetched via cluster_articles -> articles join. The
    // shared fake returns the table fixture verbatim; the join shape
    // mirrors what the supabase-js typed query produces.
    setTableResponse("cluster_articles", {
      data: [
        {
          articles: { title: "Headline A", published_at: "2026-01-01T00:00:00Z" },
        },
        {
          articles: { title: "Headline B", published_at: "2026-01-02T00:00:00Z" },
        },
        {
          articles: { title: "Headline C", published_at: "2026-01-03T00:00:00Z" },
        },
      ],
      error: null,
    });

    const mod = await tryImportRoute();
    expect(mod).toBeDefined();
    const handler = mod?.GET ?? mod?.POST;
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const res = await handler(
      new Request("http://example.com/api/cron/headline", {
        headers: { Authorization: "Bearer shhh" },
      }),
    );
    expect(res.status).toBe(200);
    // Tripwire (R4-P3): the route MUST have written back a
    // non-null `title_tr_neutral`. Soft-conditional asserts that the
    // previous version of this test used silently green-passed when the
    // chain fake didn't carry the `.gte()` method; the proxy fake makes
    // the chain Just Work, so this assertion now bites if the route
    // regresses or the fake silently no-ops the write path.
    const clusterUpdate = updateCalls.find((u) => u.table === "clusters");
    expect(clusterUpdate).toBeDefined();
    const patch = clusterUpdate!.patch as { title_tr_neutral?: unknown };
    expect(patch.title_tr_neutral).toBeDefined();
    expect(patch.title_tr_neutral).not.toBeNull();
    expect(typeof patch.title_tr_neutral).toBe("string");
    expect((patch.title_tr_neutral as string).length).toBeGreaterThan(0);

    // Cache invalidation: one cluster-detail tag per rewrote cluster, plus
    // clusters-politics once, both on the "max" cache profile.
    expect(revalidateTagMock).toHaveBeenCalledWith("cluster-detail:c1", "max");
    expect(revalidateTagMock).toHaveBeenCalledWith("clusters-politics", "max");
    expect(revalidateTagMock).toHaveBeenCalledTimes(2);
  });

  it("does not revalidate any tag when there are no candidates (no-op)", async () => {
    process.env.CRON_SECRET = "shhh";
    setTableResponse("clusters", { data: [], error: null });

    const mod = await tryImportRoute();
    const handler = mod?.GET ?? mod?.POST;
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const res = await handler(
      new Request("http://example.com/api/cron/headline", {
        headers: { Authorization: "Bearer shhh" },
      }),
    );
    expect(res.status).toBe(200);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("HEADLINE_PAUSED kill switch: returns {skipped:true, reason:'paused'} and touches no DB", async () => {
    process.env.CRON_SECRET = "shhh";
    process.env.HEADLINE_PAUSED = "true";
    // If the pause check were bypassed, the route would try to read this —
    // leaving it unset means any accidental DB read surfaces as an empty
    // (not error) result rather than a false-positive pass.
    setTableResponse("clusters", { data: [], error: null });

    const mod = await tryImportRoute();
    const handler = mod?.GET ?? mod?.POST;
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const res = await handler(
      new Request("http://example.com/api/cron/headline", {
        headers: { Authorization: "Bearer shhh" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: boolean; reason?: string };
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("paused");
    // Zero DB access: no SELECT (pick query, member-titles query) and no
    // UPDATE was ever issued against Supabase.
    expect(supabaseFake.dbAccessLog).toHaveLength(0);
    expect(supabaseFake.fake.calls.mutations).toHaveLength(0);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("HEADLINE_PAUSED='false' does NOT pause (only a non-empty value other than the literal 'false' pauses)", async () => {
    process.env.CRON_SECRET = "shhh";
    process.env.HEADLINE_PAUSED = "false";
    setTableResponse("clusters", { data: [], error: null });

    const mod = await tryImportRoute();
    const handler = mod?.GET ?? mod?.POST;
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const res = await handler(
      new Request("http://example.com/api/cron/headline", {
        headers: { Authorization: "Bearer shhh" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: boolean; reason?: string };
    // Falls through to the normal "no candidates" no-op path, not paused.
    expect(body.reason).not.toBe("paused");
    expect(supabaseFake.dbAccessLog.length).toBeGreaterThan(0);
  });

  it("pick query filters is_archived=false and orders by updated_at desc (recency-first)", async () => {
    process.env.CRON_SECRET = "shhh";
    setTableResponse("clusters", { data: [], error: null });

    const mod = await tryImportRoute();
    const handler = mod?.GET ?? mod?.POST;
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    await handler(
      new Request("http://example.com/api/cron/headline", {
        headers: { Authorization: "Bearer shhh" },
      }),
    );

    // The pick query is the only "clusters" access that calls `.order()`
    // (the per-row `.update()` calls never do).
    const pick = supabaseFake.dbAccessLog.find(
      (a) => a.table === "clusters" && a.state.order.length > 0,
    );
    expect(pick).toBeDefined();
    expect(pick!.state.eq).toContainEqual({ col: "is_archived", val: false });
    expect(pick!.state.order).toContainEqual({
      col: "updated_at",
      opts: expect.objectContaining({ ascending: false }),
    });
    // article_count DESC must be gone from the ordering (recency-first,
    // not popularity-first).
    expect(
      pick!.state.order.some((o) => o.col === "article_count"),
    ).toBe(false);
    // The MIN_ARTICLE_COUNT gate (migration 019's partial index) must
    // still apply.
    expect(pick!.state.gte).toContainEqual({
      col: "article_count",
      val: HEADLINE_MIN_ARTICLE_COUNT,
    });
  });

  it("writes title_neutral_model and title_neutral_prompt_version alongside title_tr_neutral", async () => {
    process.env.CRON_SECRET = "shhh";
    setTableResponse("clusters", {
      data: [
        {
          id: "c1",
          title_tr: "Original TR",
          summary_tr: "Original summary",
          title_tr_neutral: null,
          title_neutral_at: null,
          article_count: 4,
        },
      ],
      error: null,
    });
    setTableResponse("cluster_articles", {
      data: [
        {
          articles: { title: "Headline A", published_at: "2026-01-01T00:00:00Z" },
        },
      ],
      error: null,
    });

    const mod = await tryImportRoute();
    const handler = mod?.GET ?? mod?.POST;
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const res = await handler(
      new Request("http://example.com/api/cron/headline", {
        headers: { Authorization: "Bearer shhh" },
      }),
    );
    expect(res.status).toBe(200);

    const clusterUpdate = updateCalls.find((u) => u.table === "clusters");
    expect(clusterUpdate).toBeDefined();
    const patch = clusterUpdate!.patch as {
      title_neutral_model?: unknown;
      title_neutral_prompt_version?: unknown;
    };
    // Model id actually used — the existing LLM_MODEL env override / default,
    // not a hardcoded literal, so this stays true if the default ever moves.
    expect(patch.title_neutral_model).toBe(
      process.env.LLM_MODEL ?? "claude-haiku-4-5-20251001",
    );
    expect(patch.title_neutral_prompt_version).toBe(HEADLINE_PROMPT_VERSION);
  });

  it("uses a constant-time comparator (no timing leak via early-exit on first byte)", async () => {
    process.env.CRON_SECRET = "abcdefghijklmnop";

    const mod = await tryImportRoute();
    expect(mod).toBeDefined();
    const handler = mod?.GET ?? mod?.POST;
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    // Two wrong tokens of the same length but differing in different
    // positions. If the comparator is constant-time, both should take
    // roughly the same number of microseconds and both return 401.
    const wrong1 = await handler(
      new Request("http://example.com/api/cron/headline", {
        headers: { Authorization: "Bearer Xbcdefghijklmnop" },
      }),
    );
    const wrong2 = await handler(
      new Request("http://example.com/api/cron/headline", {
        headers: { Authorization: "Bearer abcdefghijklmnoX" },
      }),
    );
    expect(wrong1.status).toBe(401);
    expect(wrong2.status).toBe(401);
    // Tripwire: the route must actually invoke the constant-time
    // comparator. If the code regresses to a plain `===`, the spy never
    // fires and this assertion catches it.
    expect(timingSafeEqualSpy).toHaveBeenCalled();
  });
});

describe("GET /api/cron/headline — extractive mode (no LLM key)", () => {
  it("writes a cleaned member headline with extractive provenance, no title_neutral_at, and never calls the LLM", async () => {
    process.env.CRON_SECRET = "shhh";
    delete process.env.ANTHROPIC_API_KEY;
    setTableResponse("clusters", {
      data: [
        {
          id: "c1",
          title_tr: "Original TR",
          summary_tr: "",
          title_tr_neutral: null,
          title_neutral_at: null,
          article_count: 2,
        },
      ],
      error: null,
    });
    setTableResponse("cluster_articles", {
      data: [
        { articles: { title: "Atama kararları Resmi Gazete'de!", published_at: "2026-01-01T00:00:00Z" } },
        { articles: { title: "Atama kararları Resmi Gazete'de yayımlandı", published_at: "2026-01-02T00:00:00Z" } },
      ],
      error: null,
    });

    const mod = await tryImportRoute();
    const handler = mod?.GET ?? mod?.POST;
    if (!handler) throw new Error("route has no handler");
    const res = await handler(
      new Request("http://example.com/api/cron/headline", {
        headers: { Authorization: "Bearer shhh" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode?: string; rewrote?: number };
    expect(body.mode).toBe("extractive");
    expect(body.rewrote).toBe(1);
    expect(llmFetchSpy).not.toHaveBeenCalled();

    const clusterUpdate = updateCalls.find((u) => u.table === "clusters");
    expect(clusterUpdate).toBeDefined();
    const patch = clusterUpdate!.patch as {
      title_tr_neutral?: unknown;
      title_neutral_at?: unknown;
      title_neutral_model?: unknown;
      title_neutral_prompt_version?: unknown;
    };
    expect(patch.title_tr_neutral).toBe("Atama kararları Resmi Gazete'de yayımlandı");
    expect(patch.title_neutral_model).toBe("extractive-v1");
    expect(patch.title_neutral_at).toBeUndefined();
    expect(patch.title_neutral_prompt_version).toBeUndefined();
  });
});
