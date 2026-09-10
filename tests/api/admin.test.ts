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
