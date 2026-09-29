import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for POST /api/admin/cluster-merge (merge queue, migration
// 099). Same harness as tests/api/admin-story-threads.test.ts: shared proxy
// Supabase fake, an __adminAuthed switch and a per-test nextIp() so the rate
// limiter never bleeds between tests. mergeClusters is mocked: its own
// behaviour is covered by src/lib/clusters/merge.test.ts.
// ---------------------------------------------------------------------------

const S = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const T = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const s = S.toLowerCase();

const dbState = vi.hoisted(() => ({
  upsertError: null as null | { message: string },
  touched: [] as string[],
  upsertArgs: [] as unknown[][],
}));

const revalidateTag = vi.hoisted(() => vi.fn());
const mergeClusters = vi.hoisted(() => vi.fn());
const mergeRevalidationTags = vi.hoisted(() => vi.fn());

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      cluster_merge_dismissals: () => {
        dbState.touched.push("cluster_merge_dismissals");
        return { data: null, error: dbState.upsertError };
      },
    },
  });
});

// Wrap the fake so the upsert OPTIONS (which the fake does not record) are visible.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    ...supabaseFake.client,
    from: (table: string) => {
      const builder = supabaseFake.client.from(table) as Record<string, (...a: unknown[]) => unknown>;
      return new Proxy(builder, {
        get(target, prop: string) {
          if (prop === "upsert") {
            return (...args: unknown[]) => {
              dbState.upsertArgs.push(args);
              return target.upsert(...args);
            };
          }
          return target[prop];
        },
      });
    },
  }),
}));

vi.mock("next/cache", () => ({
  revalidateTag,
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

vi.mock("@/lib/clusters/merge", () => ({
  mergeClusters,
  mergeRevalidationTags,
}));

let __adminAuthed = true;
vi.mock("@/lib/admin/session", () => ({
  hasAdminSession: async () => __adminAuthed,
  requireAdminSession: async () => {
    if (!__adminAuthed) throw new Error("unauthenticated");
  },
  checkAdminPassword: () => false,
  createAdminSession: async () => {},
  deleteAdminSession: async () => {},
}));

const ORIGINAL_ENV = { ...process.env };

const OUTCOME = {
  logId: 3,
  resweep: true,
  moved: 4,
  duplicates: 1,
  sourceCountBefore: 4,
  targetCountBefore: 9,
  targetCountAfter: 12,
  targetBlindspotBefore: true,
  targetBlindspotAfter: false,
};

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  __adminAuthed = true;
  dbState.upsertError = null;
  dbState.touched.length = 0;
  dbState.upsertArgs.length = 0;
  supabaseFake.calls.mutations.length = 0;
  revalidateTag.mockClear();
  mergeClusters.mockReset();
  mergeClusters.mockResolvedValue({ ok: true, outcome: OUTCOME });
  mergeRevalidationTags.mockReset();
  mergeRevalidationTags.mockReturnValue(["clusters", `cluster-detail:${s}`, `cluster-detail:${T}`]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function postRequest(body: unknown, ip = nextIp()): Request {
  return new Request("http://example.com/api/admin/cluster-merge", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function load() {
  return import("@/app/api/admin/cluster-merge/route");
}

const merge = (over: Record<string, unknown> = {}) => ({
  action: "merge",
  source: S,
  target: T,
  origin: "thread",
  ...over,
});

describe("POST /api/admin/cluster-merge guards", () => {
  it("401s with no session before the body is read and touches nothing", async () => {
    __adminAuthed = false;
    const mod = await load();
    const req = new Request("http://example.com/api/admin/cluster-merge", {
      method: "POST",
      headers: { "x-forwarded-for": nextIp() },
    });
    req.json = () => {
      throw new Error("body must not be read");
    };
    const res = await mod.POST(req);
    expect(res.status).toBe(401);
    expect(mergeClusters).not.toHaveBeenCalled();
    expect(dbState.touched).toHaveLength(0);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("429s once the bucket is empty", async () => {
    const mod = await load();
    const ip = nextIp();
    let last = 200;
    for (let i = 0; i < 30; i++) {
      last = (await mod.POST(postRequest(merge(), ip))).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  it("400s on bad JSON and non-object bodies", async () => {
    const mod = await load();
    expect((await mod.POST(postRequest("{not json"))).status).toBe(400);
    expect((await mod.POST(postRequest([merge()]))).status).toBe(400);
    expect((await mod.POST(postRequest("null"))).status).toBe(400);
    expect(mergeClusters).not.toHaveBeenCalled();
  });

  it("400s on an unknown or missing action", async () => {
    const mod = await load();
    expect((await mod.POST(postRequest(merge({ action: "delete" })))).status).toBe(400);
    expect((await mod.POST(postRequest(merge({ action: undefined })))).status).toBe(400);
    expect(mergeClusters).not.toHaveBeenCalled();
  });

  it("400s on non-UUID ids and equal ids", async () => {
    const mod = await load();
    expect((await mod.POST(postRequest(merge({ source: "nope" })))).status).toBe(400);
    expect((await mod.POST(postRequest(merge({ target: 5 })))).status).toBe(400);
    expect((await mod.POST(postRequest(merge({ target: S.toLowerCase() })))).status).toBe(400);
    expect(mergeClusters).not.toHaveBeenCalled();
    expect(
      (await mod.POST(postRequest({ action: "dismiss", a: "x", b: T, origin: "thread" }))).status,
    ).toBe(400);
    expect(
      (await mod.POST(postRequest({ action: "dismiss", a: T, b: T.toUpperCase(), origin: "thread" }))).status,
    ).toBe(400);
    expect(dbState.touched).toHaveLength(0);
  });
});

describe("POST /api/admin/cluster-merge merge", () => {
  it("calls mergeClusters with actor admin, lowercased ids and the origin", async () => {
    const mod = await load();
    const res = await mod.POST(postRequest(merge({ origin: "recall" })));
    expect(res.status).toBe(200);
    expect(mergeClusters).toHaveBeenCalledWith({ source: s, target: T, actor: "admin", origin: "recall" });
  });

  it("accepts manual, thread and recall origins and 400s on anything else", async () => {
    const mod = await load();
    for (const origin of ["manual", "thread", "recall"]) {
      expect((await mod.POST(postRequest(merge({ origin })))).status).toBe(200);
    }
    mergeClusters.mockClear();
    for (const origin of ["auto", undefined, 3]) {
      expect((await mod.POST(postRequest(merge({ origin })))).status).toBe(400);
    }
    expect(mergeClusters).not.toHaveBeenCalled();
  });

  it("returns the outcome and revalidates every tag with 'max'", async () => {
    const mod = await load();
    const res = await mod.POST(postRequest(merge()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, target: T, moved: 4, target_count_after: 12 });
    expect(mergeRevalidationTags).toHaveBeenCalledWith(s, T);
    expect(revalidateTag.mock.calls).toEqual([
      ["clusters", "max"],
      [`cluster-detail:${s}`, "max"],
      [`cluster-detail:${T}`, "max"],
    ]);
  });

  it.each([
    ["invalid", 400],
    ["not-found", 404],
    ["conflict", 409],
    ["error", 500],
  ])("maps reason %s to %i without revalidating", async (reason, status) => {
    mergeClusters.mockResolvedValue({ ok: false, reason });
    const mod = await load();
    const res = await mod.POST(postRequest(merge()));
    expect(res.status).toBe(status);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/cluster-merge dismiss", () => {
  const dismiss = (over: Record<string, unknown> = {}) => ({
    action: "dismiss",
    a: T,
    b: S,
    origin: "thread",
    ...over,
  });

  it("upserts the ordered pair with ignoreDuplicates and actor admin, and revalidates nothing", async () => {
    const mod = await load();
    const res = await mod.POST(postRequest(dismiss()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const ups = supabaseFake.calls.upsert("cluster_merge_dismissals");
    expect(ups).toHaveLength(1);
    expect(ups[0].patch).toEqual({ cluster_a: s, cluster_b: T, origin: "thread", actor: "admin" });
    expect(revalidateTag).not.toHaveBeenCalled();
    expect(mergeClusters).not.toHaveBeenCalled();
  });

  it("never touches story_thread_candidates", async () => {
    const mod = await load();
    await mod.POST(postRequest(dismiss({ origin: "recall" })));
    expect(supabaseFake.calls.forTable("story_thread_candidates")).toHaveLength(0);
  });

  it("passes onConflict cluster_a,cluster_b and ignoreDuplicates", async () => {
    const mod = await load();
    await mod.POST(postRequest(dismiss()));
    expect(dbState.upsertArgs).toHaveLength(1);
    expect(dbState.upsertArgs[0][1]).toEqual({ onConflict: "cluster_a,cluster_b", ignoreDuplicates: true });
  });

  it("400s when origin is not thread or recall", async () => {
    const mod = await load();
    expect((await mod.POST(postRequest(dismiss({ origin: "manual" })))).status).toBe(400);
    expect((await mod.POST(postRequest(dismiss({ origin: undefined })))).status).toBe(400);
    expect(dbState.touched).toHaveLength(0);
  });

  it("500s on a DB error without leaking the message", async () => {
    dbState.upsertError = { message: "connection reset" };
    const mod = await load();
    const res = await mod.POST(postRequest(dismiss()));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("connection reset");
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
