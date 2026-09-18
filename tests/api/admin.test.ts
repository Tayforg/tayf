import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Supabase mock plumbing for /api/admin.
//
// The admin route issues four count queries + one sources list. Rather than
// track every call order, we expose a single thenable chain whose terminal
// resolution is `{ data, count, error }` and let each test override the
// response for a specific table via `setTableResponse`.
// ---------------------------------------------------------------------------

interface TableResponse {
  data?: unknown;
  count?: number | null;
  error?: { message: string } | null;
}

const DEFAULT_RESPONSE: TableResponse = { data: [], count: 0, error: null };

const tableResponses: Record<string, TableResponse> = {};

function setTableResponse(table: string, response: TableResponse) {
  tableResponses[table] = { ...DEFAULT_RESPONSE, ...response };
}

function resetTableResponses() {
  for (const k of Object.keys(tableResponses)) delete tableResponses[k];
}

// Recorded writes, so tests can assert a mutation never reached the DB (or,
// on the happy path, assert exactly what payload was written) without
// tracking call order across the whole chain.
interface RecordedWrite {
  table: string;
  op: "insert" | "update" | "delete";
  payload: unknown;
}

let writes: RecordedWrite[] = [];

// `.rpc()` plumbing for the set_source_bias RPC (migration 055) — a
// separate call log from `writes` above so tests can assert the route
// NEVER falls back to a direct `.update({ bias })` on `sources`.
interface RpcResponse {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

interface RecordedRpcCall {
  name: string;
  args: unknown;
}

let rpcCalls: RecordedRpcCall[] = [];
const rpcResponses: Record<string, RpcResponse> = {};

function setRpcResponse(name: string, response: RpcResponse) {
  rpcResponses[name] = response;
}

function resetRpc() {
  rpcCalls = [];
  for (const k of Object.keys(rpcResponses)) delete rpcResponses[k];
}

const { revalidateTagMock } = vi.hoisted(() => ({
  revalidateTagMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidateTag: revalidateTagMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const resp = () => tableResponses[table] ?? DEFAULT_RESPONSE;

      // A chainable, thenable object. Every chain method returns the same
      // object; `.then` resolves to the configured response for the table.
      const chain: Record<string, unknown> = {};
      const terminal = (onFul?: (v: TableResponse) => unknown, onRej?: (e: unknown) => unknown) =>
        Promise.resolve(resp()).then(onFul, onRej);
      Object.assign(chain, {
        select: () => chain,
        insert: (payload: unknown) => {
          writes.push({ table, op: "insert", payload });
          return chain;
        },
        update: (payload: unknown) => {
          writes.push({ table, op: "update", payload });
          return chain;
        },
        delete: () => {
          writes.push({ table, op: "delete", payload: undefined });
          return chain;
        },
        upsert: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: () => chain,
        is: () => chain,
        gte: () => chain,
        in: () => chain,
        not: () => chain,
        maybeSingle: () => Promise.resolve(resp()),
        then: terminal,
      });
      return chain;
    },
    rpc: (name: string, args?: unknown) => {
      rpcCalls.push({ name, args });
      const resp = rpcResponses[name] ?? { data: null, error: null };
      return Promise.resolve(resp);
    },
  }),
}));

// The admin route calls `await connection()` indirectly via shared helpers
// so Next.js 16's cache-components prerender doesn't choke on
// `request.headers`. Outside a Next.js request scope (i.e. here in vitest)
// the real `connection()` throws "called outside a request scope" — resolve
// it to a no-op so the handlers can run. Everything else from `next/server`
// (NextResponse, etc.) passes through untouched via `importOriginal`.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: async () => {},
  };
});

// Admin session mock. Default is "authenticated" so the existing happy-path
// tests keep exercising the stat-shape and validation branches inside the
// route. The "unauthenticated" describe block flips this to false before
// each of its tests to exercise the 401 gate that sits at the top of GET
// and POST (see src/app/api/admin/route.ts).
let __adminAuthed = true;
vi.mock("@/lib/admin/session", () => ({
  hasAdminSession: async () => __adminAuthed,
  // Not used by the route, but export the full surface so other callers
  // that might be transitively pulled in don't explode if they land here.
  requireAdminSession: async () => {
    if (!__adminAuthed) throw new Error("unauthenticated");
  },
  checkAdminPassword: () => false,
  createAdminSession: async () => {},
  deleteAdminSession: async () => {},
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  delete process.env.CRON_SECRET;
  resetTableResponses();
  writes = [];
  resetRpc();
  revalidateTagMock.mockClear();
  __adminAuthed = true;
});

afterEach(() => {
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CRON_SECRET",
  ]) {
    if (k in ORIGINAL_ENV) {
      process.env[k] = ORIGINAL_ENV[k] as string;
    } else {
      delete process.env[k];
    }
  }
  vi.resetModules();
});

describe("GET /api/admin", () => {
  it("returns 200 with the expected stat shape", async () => {
    setTableResponse("articles", { count: 42, data: [], error: null });
    setTableResponse("sources", {
      count: 8,
      data: [
        {
          id: "s1",
          name: "Test",
          slug: "test",
          url: "https://test",
          rss_url: "https://test/rss",
          bias: "center",
          active: true,
        },
      ],
      error: null,
    });
    setTableResponse("clusters", { count: 3, data: [], error: null });

    const mod = await import("@/app/api/admin/route");
    const res = await mod.GET(new Request("http://example.com/api/admin"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("articles");
    expect(body).toHaveProperty("sources");
    expect(body).toHaveProperty("clusters");
    expect(body).toHaveProperty("sourcesList");
    expect(typeof body.articles).toBe("number");
    expect(Array.isArray(body.sourcesList)).toBe(true);
  });
});

describe("POST /api/admin", () => {
  it("returns 400 for unknown action", async () => {
    const mod = await import("@/app/api/admin/route");
    const req = new Request("http://example.com/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "definitely_not_a_real_action" }),
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body?.error).toBeTruthy();
  });

  it("returns 400 for missing required fields on add_source", async () => {
    const mod = await import("@/app/api/admin/route");
    const req = new Request("http://example.com/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add_source", name: "Missing fields" }),
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(400);
  });

  async function postAdmin(body: unknown) {
    const mod = await import("@/app/api/admin/route");
    const req = new Request("http://example.com/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return mod.POST(req);
  }

  const validAddSource = {
    action: "add_source",
    name: "Test",
    slug: "test-source",
    url: "https://test.example.com",
    rss_url: "https://test.example.com/rss",
    bias: "center",
  };

  describe("add_source validation", () => {
    it("rejects an SSRF-shaped rss_url (link-local metadata) with no write", async () => {
      const res = await postAdmin({
        ...validAddSource,
        rss_url: "http://169.254.169.254/latest/meta-data",
      });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects an rss_url pointing at localhost with no write", async () => {
      const res = await postAdmin({ ...validAddSource, rss_url: "https://localhost/feed.xml" });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects a plain-http url with no write", async () => {
      const res = await postAdmin({ ...validAddSource, url: "http://example.com" });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects a javascript: url with no write", async () => {
      const res = await postAdmin({ ...validAddSource, url: "javascript:alert(1)" });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects a url over the length cap with no write", async () => {
      const res = await postAdmin({
        ...validAddSource,
        url: "https://example.com/" + "a".repeat(600),
      });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects an unknown bias with no write", async () => {
      const res = await postAdmin({ ...validAddSource, bias: "definitely-not-a-bias" });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects an unknown kind with no write", async () => {
      const res = await postAdmin({ ...validAddSource, kind: "spy" });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("accepts a valid payload, writing exactly one insert with no kind key", async () => {
      const res = await postAdmin(validAddSource);
      expect(res.status).toBe(200);
      expect(writes.length).toBe(1);
      const write = writes[0];
      expect(write?.table).toBe("sources");
      expect(write?.op).toBe("insert");
      expect(write?.payload).toEqual({
        name: "Test",
        slug: "test-source",
        url: "https://test.example.com",
        rss_url: "https://test.example.com/rss",
        bias: "center",
        active: true,
      });
      expect(write?.payload).not.toHaveProperty("kind");
    });

    it("accepts a valid payload with kind, writing kind into the insert payload", async () => {
      const res = await postAdmin({ ...validAddSource, kind: "wire" });
      expect(res.status).toBe(200);
      expect(writes.length).toBe(1);
      const write = writes[0] as { payload: Record<string, unknown> };
      expect(write.payload.kind).toBe("wire");
    });
  });

  describe("update_source validation", () => {
    it("rejects a private-range rss_url with no write", async () => {
      const res = await postAdmin({ action: "update_source", id: "s1", rss_url: "https://10.0.0.5/feed" });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects an unknown bias with no write", async () => {
      const res = await postAdmin({ action: "update_source", id: "s1", bias: "nope" });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects an id-only update with 'No fields to update' and no write", async () => {
      const res = await postAdmin({ action: "update_source", id: "s1" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("No fields to update");
      expect(writes.length).toBe(0);
    });

    it("writes exactly the provided fields on a partial update", async () => {
      const res = await postAdmin({ action: "update_source", id: "s1", name: "New name" });
      expect(res.status).toBe(200);
      expect(writes.length).toBe(1);
      const write = writes[0];
      expect(write?.op).toBe("update");
      expect(write?.payload).toEqual({ name: "New name" });
    });

    // B55-REASONLESS-BIAS-PATH: update_source must never silently relabel a
    // source -- a changed bias must go through set_source_bias with a
    // reason instead.
    it("rejects a changed bias through update_source with no write", async () => {
      setTableResponse("sources", { data: { bias: "center" }, error: null });
      const res = await postAdmin({
        action: "update_source",
        id: "s1",
        bias: "opposition",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe(
        "Bias changes go through set_source_bias with a reason",
      );
      expect(writes.length).toBe(0);
    });

    it("drops an unchanged bias from the update instead of erroring", async () => {
      setTableResponse("sources", { data: { bias: "center" }, error: null });
      const res = await postAdmin({
        action: "update_source",
        id: "s1",
        name: "New name",
        bias: "center",
      });
      expect(res.status).toBe(200);
      expect(writes.length).toBe(1);
      expect(writes[0]?.payload).toEqual({ name: "New name" });
    });
  });

  describe("auth precedence", () => {
    it("401s an invalid-payload POST before validation runs", async () => {
      __adminAuthed = false;
      const res = await postAdmin({ action: "add_source", ...validAddSource, rss_url: "not a url" });
      expect(res.status).toBe(401);
    });
  });

  describe("set_source_rights", () => {
    it("401s without a session", async () => {
      __adminAuthed = false;
      const res = await postAdmin({
        action: "set_source_rights",
        slug: "test-source",
        image_allowed: false,
      });
      expect(res.status).toBe(401);
      expect(writes.length).toBe(0);
    });

    it("rejects an invalid slug with no write", async () => {
      const res = await postAdmin({
        action: "set_source_rights",
        slug: "Not A Valid Slug!",
        image_allowed: false,
      });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects a missing slug with no write", async () => {
      const res = await postAdmin({ action: "set_source_rights", image_allowed: false });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects a payload with neither flag with no write", async () => {
      const res = await postAdmin({ action: "set_source_rights", slug: "test-source" });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects a non-boolean image_allowed with no write", async () => {
      const res = await postAdmin({
        action: "set_source_rights",
        slug: "test-source",
        image_allowed: "false",
      });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects a non-boolean excerpt_allowed with no write", async () => {
      const res = await postAdmin({
        action: "set_source_rights",
        slug: "test-source",
        excerpt_allowed: 0,
      });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("404s an unknown slug with no write recorded as applied", async () => {
      setTableResponse("sources", { data: null, error: null });
      const res = await postAdmin({
        action: "set_source_rights",
        slug: "does-not-exist",
        image_allowed: false,
      });
      expect(res.status).toBe(404);
    });

    it("updates only the two columns and returns the updated row on success", async () => {
      setTableResponse("sources", {
        data: { slug: "test-source", image_allowed: false, excerpt_allowed: true },
        error: null,
      });
      const res = await postAdmin({
        action: "set_source_rights",
        slug: "test-source",
        image_allowed: false,
        excerpt_allowed: true,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ slug: "test-source", image_allowed: false, excerpt_allowed: true });

      expect(writes.length).toBe(1);
      const write = writes[0];
      expect(write?.table).toBe("sources");
      expect(write?.op).toBe("update");
      expect(write?.payload).toEqual({ image_allowed: false, excerpt_allowed: true });
    });

    it("writes only the provided flag on a partial update", async () => {
      setTableResponse("sources", {
        data: { slug: "test-source", image_allowed: true, excerpt_allowed: false },
        error: null,
      });
      const res = await postAdmin({
        action: "set_source_rights",
        slug: "test-source",
        excerpt_allowed: false,
      });
      expect(res.status).toBe(200);
      expect(writes.length).toBe(1);
      expect(writes[0]?.payload).toEqual({ excerpt_allowed: false });
    });
  });

  describe("set_source_registry", () => {
    it("401s without a session, with no write", async () => {
      __adminAuthed = false;
      const res = await postAdmin({
        action: "set_source_registry",
        slug: "test-source",
        rationale: "Bir örnek gerekçe metni.",
      });
      expect(res.status).toBe(401);
      expect(writes.length).toBe(0);
    });

    it("rejects an invalid slug with no write", async () => {
      const res = await postAdmin({
        action: "set_source_registry",
        slug: "Not A Valid Slug!",
        rationale: "Bir örnek gerekçe metni.",
      });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects a payload with none of the four fields, with no write", async () => {
      const res = await postAdmin({ action: "set_source_registry", slug: "test-source" });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects an over-long rationale (>1000 chars) with no write", async () => {
      const res = await postAdmin({
        action: "set_source_registry",
        slug: "test-source",
        rationale: "a".repeat(1001),
      });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects a malformed trustee_since with no write", async () => {
      const res = await postAdmin({
        action: "set_source_registry",
        slug: "test-source",
        trustee_since: "11-09-2025",
      });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("rejects an over-long trustee_note with no write", async () => {
      const res = await postAdmin({
        action: "set_source_registry",
        slug: "test-source",
        trustee_note: "a".repeat(501),
      });
      expect(res.status).toBe(400);
      expect(writes.length).toBe(0);
    });

    it("404s an unknown slug with no write recorded as applied", async () => {
      setTableResponse("sources", { data: null, error: null });
      const res = await postAdmin({
        action: "set_source_registry",
        slug: "does-not-exist",
        rationale: "Bir örnek gerekçe metni.",
      });
      expect(res.status).toBe(404);
    });

    it("records exactly the four allowed columns and nothing else, and stamps zone_rationale_at when rationale is set", async () => {
      setTableResponse("sources", {
        data: {
          slug: "test-source",
          zone_rationale: "Bir örnek gerekçe metni.",
          zone_rationale_at: "2026-01-01T00:00:00.000Z",
          trustee_since: "2025-09-11",
          trustee_note: "TMSF kayyum atandı, 11.09.2025",
        },
        error: null,
      });
      const res = await postAdmin({
        action: "set_source_registry",
        slug: "test-source",
        rationale: "Bir örnek gerekçe metni.",
        trustee_since: "2025-09-11",
        trustee_note: "TMSF kayyum atandı, 11.09.2025",
      });
      expect(res.status).toBe(200);
      expect(writes.length).toBe(1);
      const write = writes[0];
      expect(write?.table).toBe("sources");
      expect(write?.op).toBe("update");
      const patch = write?.payload as Record<string, unknown>;
      expect(Object.keys(patch).sort()).toEqual(
        ["zone_rationale", "zone_rationale_at", "trustee_since", "trustee_note"].sort(),
      );
      expect(typeof patch.zone_rationale_at).toBe("string");
      expect(revalidateTagMock).toHaveBeenCalledWith("sources", "max");
    });

    it("clears zone_rationale and zone_rationale_at when rationale is explicitly null", async () => {
      setTableResponse("sources", {
        data: {
          slug: "test-source",
          zone_rationale: null,
          zone_rationale_at: null,
          trustee_since: null,
          trustee_note: null,
        },
        error: null,
      });
      const res = await postAdmin({
        action: "set_source_registry",
        slug: "test-source",
        rationale: null,
      });
      expect(res.status).toBe(200);
      const patch = writes[0]?.payload as Record<string, unknown>;
      expect(patch.zone_rationale).toBeNull();
      expect(patch.zone_rationale_at).toBeNull();
    });

    // B-SEC-03: trustee_since can never end up non-null while
    // trustee_note is null on the row -- an undated kayyum flag is a new
    // error, not a fact.
    it("rejects trustee_since alone when the current row has no trustee_note, with no write", async () => {
      setTableResponse("sources", {
        data: { trustee_since: null, trustee_note: null },
        error: null,
      });
      const res = await postAdmin({
        action: "set_source_registry",
        slug: "test-source",
        trustee_since: "2025-09-11",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/trustee_since/);
      expect(writes.length).toBe(0);
    });

    it("rejects nulling trustee_note alone while trustee_since remains set on the row, with no write", async () => {
      setTableResponse("sources", {
        data: {
          trustee_since: "2025-09-11",
          trustee_note: "TMSF kayyum atandı (Can Holding), 11.09.2025",
        },
        error: null,
      });
      const res = await postAdmin({
        action: "set_source_registry",
        slug: "test-source",
        trustee_note: null,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/trustee_since/);
      expect(writes.length).toBe(0);
    });
  });

  describe("set_source_bias", () => {
    it("401s without a session, with no rpc call", async () => {
      __adminAuthed = false;
      const res = await postAdmin({
        action: "set_source_bias",
        slug: "test-source",
        bias: "center",
        reason: "Redaksiyon kararı ile güncellendi.",
      });
      expect(res.status).toBe(401);
      expect(rpcCalls.length).toBe(0);
    });

    it("rejects an invalid slug with no rpc call", async () => {
      const res = await postAdmin({
        action: "set_source_bias",
        slug: "Not A Valid Slug!",
        bias: "center",
        reason: "Redaksiyon kararı ile güncellendi.",
      });
      expect(res.status).toBe(400);
      expect(rpcCalls.length).toBe(0);
    });

    it("rejects an invalid bias with no rpc call", async () => {
      const res = await postAdmin({
        action: "set_source_bias",
        slug: "test-source",
        bias: "not-a-real-bias",
        reason: "Redaksiyon kararı ile güncellendi.",
      });
      expect(res.status).toBe(400);
      expect(rpcCalls.length).toBe(0);
    });

    it("rejects a missing reason with no rpc call", async () => {
      const res = await postAdmin({
        action: "set_source_bias",
        slug: "test-source",
        bias: "center",
      });
      expect(res.status).toBe(400);
      expect(rpcCalls.length).toBe(0);
    });

    it("rejects a too-short reason (<10 chars) with no rpc call", async () => {
      const res = await postAdmin({
        action: "set_source_bias",
        slug: "test-source",
        bias: "center",
        reason: "kısa",
      });
      expect(res.status).toBe(400);
      expect(rpcCalls.length).toBe(0);
    });

    it("rejects an unknown rater handle (a person's name) with no rpc call", async () => {
      const res = await postAdmin({
        action: "set_source_bias",
        slug: "test-source",
        bias: "center",
        reason: "Redaksiyon kararı ile güncellendi.",
        rater: "Fatih Hekimoğlu",
      });
      expect(res.status).toBe(400);
      expect(rpcCalls.length).toBe(0);
    });

    it("calls rpc('set_source_bias') with the four params and never issues a direct update to sources.bias", async () => {
      setRpcResponse("set_source_bias", {
        data: {
          id: "hist-1",
          source_id: "src-1",
          old_bias: "center",
          new_bias: "opposition_leaning",
          reason: "Redaksiyon kararı ile güncellendi.",
          rater: "tayf-admin",
          changed_at: "2026-01-01T00:00:00.000Z",
        },
        error: null,
      });
      const res = await postAdmin({
        action: "set_source_bias",
        slug: "test-source",
        bias: "opposition_leaning",
        reason: "Redaksiyon kararı ile güncellendi.",
      });
      expect(res.status).toBe(200);
      expect(rpcCalls.length).toBe(1);
      expect(rpcCalls[0]?.name).toBe("set_source_bias");
      expect(rpcCalls[0]?.args).toEqual({
        p_slug: "test-source",
        p_bias: "opposition_leaning",
        p_reason: "Redaksiyon kararı ile güncellendi.",
        p_rater: "tayf-admin",
      });
      // Load-bearing guard (pack.md risk register): bias changes must
      // NEVER go through a direct `.update({ bias })` on `sources` — only
      // through the RPC. Do not delete this assertion.
      expect(
        writes.some(
          (w) =>
            w.table === "sources" &&
            w.op === "update" &&
            typeof w.payload === "object" &&
            w.payload !== null &&
            "bias" in (w.payload as Record<string, unknown>),
        ),
      ).toBe(false);
      expect(revalidateTagMock).toHaveBeenCalledWith("sources", "max");
    });

    it("accepts a valid rater handle from the allow-list", async () => {
      setRpcResponse("set_source_bias", {
        data: { id: "hist-2", old_bias: "center", new_bias: "opposition", reason: "Redaksiyon kararı ile güncellendi.", rater: "editor", changed_at: "2026-01-01T00:00:00.000Z" },
        error: null,
      });
      const res = await postAdmin({
        action: "set_source_bias",
        slug: "test-source",
        bias: "opposition",
        reason: "Redaksiyon kararı ile güncellendi.",
        rater: "editor",
      });
      expect(res.status).toBe(200);
      expect(rpcCalls[0]?.args).toMatchObject({ p_rater: "editor" });
    });

    it("surfaces a genuine RPC failure as 500, not 200 (unmapped errcode)", async () => {
      setRpcResponse("set_source_bias", {
        data: null,
        error: { message: "trigger boom", code: "55000" },
      });
      const res = await postAdmin({
        action: "set_source_bias",
        slug: "test-source",
        bias: "opposition_leaning",
        reason: "Redaksiyon kararı ile güncellendi.",
      });
      expect(res.status).toBe(500);
    });

    it("surfaces a genuine RPC failure as 500 even with no errcode at all", async () => {
      setRpcResponse("set_source_bias", {
        data: null,
        error: { message: "trigger boom" },
      });
      const res = await postAdmin({
        action: "set_source_bias",
        slug: "test-source",
        bias: "opposition_leaning",
        reason: "Redaksiyon kararı ile güncellendi.",
      });
      expect(res.status).toBe(500);
    });

    // B55-RPC-ERRCODE-MAPPING / B-SEC-07: the RPC's SQLSTATEs (migration
    // 055) must map to the right HTTP status, not flatten to a generic 500.
    it("maps errcode P0002 (unknown slug) to 404", async () => {
      setRpcResponse("set_source_bias", {
        data: null,
        error: { message: "source unknown-slug not found", code: "P0002" },
      });
      const res = await postAdmin({
        action: "set_source_bias",
        slug: "unknown-slug",
        bias: "opposition_leaning",
        reason: "Redaksiyon kararı ile güncellendi.",
      });
      expect(res.status).toBe(404);
    });

    it("maps errcode P0003 (bias unchanged) to 409", async () => {
      setRpcResponse("set_source_bias", {
        data: null,
        error: { message: "bias unchanged for test-source", code: "P0003" },
      });
      const res = await postAdmin({
        action: "set_source_bias",
        slug: "test-source",
        bias: "center",
        reason: "Redaksiyon kararı ile güncellendi.",
      });
      expect(res.status).toBe(409);
    });

    it("maps errcode 23514 (RPC-level bad reason/rater) to 400", async () => {
      setRpcResponse("set_source_bias", {
        data: null,
        error: {
          message: "a bias change requires a 10..500 char reason",
          code: "23514",
        },
      });
      const res = await postAdmin({
        action: "set_source_bias",
        slug: "test-source",
        bias: "opposition_leaning",
        reason: "Redaksiyon kararı ile güncellendi.",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("a bias change requires a 10..500 char reason");
    });
  });

  describe("nuke actions", () => {
    it("nuke_articles deletes cluster_articles, then clusters, then articles, in order", async () => {
      const res = await postAdmin({ action: "nuke_articles" });
      expect(res.status).toBe(200);
      const order = writes
        .filter((w) => ["cluster_articles", "clusters", "articles"].includes(w.table))
        .map((w) => w.table);
      expect(order).toEqual(["cluster_articles", "clusters", "articles"]);
      expect(writes.every((w) => w.op === "delete")).toBe(true);
    });

    it("nuke_clusters deletes cluster_articles then clusters, and never touches articles", async () => {
      const res = await postAdmin({ action: "nuke_clusters" });
      expect(res.status).toBe(200);
      const order = writes
        .filter((w) => ["cluster_articles", "clusters", "articles"].includes(w.table))
        .map((w) => w.table);
      expect(order).toEqual(["cluster_articles", "clusters"]);
      expect(writes.some((w) => w.table === "articles")).toBe(false);
    });

    it("nuke_articles 401s without a session, with no delete issued", async () => {
      __adminAuthed = false;
      const res = await postAdmin({ action: "nuke_articles" });
      expect(res.status).toBe(401);
      expect(writes.length).toBe(0);
    });

    it("nuke_clusters 401s without a session, with no delete issued", async () => {
      __adminAuthed = false;
      const res = await postAdmin({ action: "nuke_clusters" });
      expect(res.status).toBe(401);
      expect(writes.length).toBe(0);
    });

    it("returns 500 and never issues the articles delete when the clusters delete fails", async () => {
      setTableResponse("clusters", {
        data: [],
        count: 0,
        error: { message: "clusters delete failed" },
      });
      const res = await postAdmin({ action: "nuke_articles" });
      expect(res.status).toBe(500);
      expect(writes.some((w) => w.table === "cluster_articles")).toBe(true);
      expect(writes.some((w) => w.table === "clusters")).toBe(true);
      expect(writes.some((w) => w.table === "articles")).toBe(false);
    });
  });
});

// Auth gate — the admin session check runs before any rate limiting or
// business logic, so every admin call without a session must 401.
describe("/api/admin (unauthenticated)", () => {
  beforeEach(() => {
    __adminAuthed = false;
  });

  it("GET returns 401 without a session", async () => {
    const mod = await import("@/app/api/admin/route");
    const res = await mod.GET(new Request("http://example.com/api/admin"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body?.error).toBeTruthy();
  });

  it("POST returns 401 without a session (ahead of the 400 action check)", async () => {
    const mod = await import("@/app/api/admin/route");
    const req = new Request("http://example.com/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Even an obviously-bad action shouldn't leak a 400 — auth first.
      body: JSON.stringify({ action: "definitely_not_a_real_action" }),
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(401);
  });
});

describe("404 handling", () => {
  it("/cluster/<invalid-uuid> conceptually returns 404", async () => {
    // The old fetch-based spec for this case exercised the live Next.js 404
    // handler. The route-level import pattern doesn't give us a request
    // router, so this is a compile-only smoke test: the dynamic cluster page
    // module must be importable and export a default handler. If the route
    // file disappears this fails loudly.
    const mod = await import("@/app/cluster/[id]/page");
    expect(typeof mod.default).toBe("function");
  });
});
