import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for the three /api/admin/jev-gold/* routes (pack JEV şimdi,
// migration 063, W3). Modelled line for line on tests/api/admin-corrections.test.ts:
// the shared proxy-based Supabase fake, the __adminAuthed switch, and a
// per-test nextIp() so the rate limiter does not bleed between tests.
// ---------------------------------------------------------------------------

const dbState = vi.hoisted(() => ({
  foreignKeyError: false,
}));

const { cookieSetMock } = vi.hoisted(() => ({
  cookieSetMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: cookieSetMock,
    delete: () => {},
  }),
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      jev_gold_labels: () => {
        if (dbState.foreignKeyError) {
          return {
            data: null,
            error: { message: "violates foreign key constraint", code: "23503" },
          } as never;
        }
        return { data: [{ article_id: "x", labeler: 1 }], error: null };
      },
    },
    rpc: {
      jev_gold_seed: () => ({ data: 128, error: null }),
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: async () => {},
  };
});

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
const ARTICLE_ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  __adminAuthed = true;
  dbState.foreignKeyError = false;
  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
  cookieSetMock.mockClear();
});

afterEach(() => {
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

function postRequest(path: string, body: unknown, ip = nextIp()): Request {
  return new Request(`http://example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/admin/jev-gold/label", () => {
  it("401s when unauthenticated and never touches the DB", async () => {
    __adminAuthed = false;
    const mod = await import("@/app/api/admin/jev-gold/label/route");

    const res = await mod.POST(
      postRequest("/api/admin/jev-gold/label", {
        article_id: ARTICLE_ID,
        labeler: 1,
        is_politics: true,
        topic: "politika",
      }),
    );

    expect(res.status).toBe(401);
    expect(supabaseFake.calls.forTable("jev_gold_labels")).toHaveLength(0);
  });

  it("400s on malformed JSON", async () => {
    const mod = await import("@/app/api/admin/jev-gold/label/route");
    const res = await mod.POST(postRequest("/api/admin/jev-gold/label", "{not json"));
    expect(res.status).toBe(400);
  });

  it("400s on a non-uuid article_id, labeler 0/3/'1', a non-boolean is_politics, and an unknown topic, without mutating", async () => {
    const mod = await import("@/app/api/admin/jev-gold/label/route");

    const base = {
      article_id: ARTICLE_ID,
      labeler: 1,
      is_politics: true,
      topic: "politika",
    };

    const bad = [
      { ...base, article_id: "not-a-uuid" },
      { ...base, labeler: 0 },
      { ...base, labeler: 3 },
      { ...base, labeler: "1" },
      { ...base, is_politics: "true" },
      { ...base, topic: "not-a-topic" },
    ];

    for (const body of bad) {
      const res = await mod.POST(postRequest("/api/admin/jev-gold/label", body));
      expect(res.status).toBe(400);
    }

    expect(supabaseFake.calls.forTable("jev_gold_labels")).toHaveLength(0);
  });

  it("accepts a note of exactly 300 chars", async () => {
    const mod = await import("@/app/api/admin/jev-gold/label/route");
    const note = "a".repeat(300);

    const res = await mod.POST(
      postRequest("/api/admin/jev-gold/label", {
        article_id: ARTICLE_ID,
        labeler: 1,
        is_politics: true,
        topic: "politika",
        note,
      }),
    );

    expect(res.status).toBe(200);
    const upserts = supabaseFake.calls.upsert("jev_gold_labels");
    expect(upserts).toHaveLength(1);
    const patch = upserts[0]?.patch as { note: string };
    expect(patch.note).toHaveLength(300);
  });

  it("400s a note of 301 chars", async () => {
    const mod = await import("@/app/api/admin/jev-gold/label/route");
    const note = "a".repeat(301);

    const res = await mod.POST(
      postRequest("/api/admin/jev-gold/label", {
        article_id: ARTICLE_ID,
        labeler: 1,
        is_politics: true,
        topic: "politika",
        note,
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid note");
    expect(supabaseFake.calls.forTable("jev_gold_labels")).toHaveLength(0);
  });

  it("200s and writes note: null when note is explicitly null", async () => {
    const mod = await import("@/app/api/admin/jev-gold/label/route");

    const res = await mod.POST(
      postRequest("/api/admin/jev-gold/label", {
        article_id: ARTICLE_ID,
        labeler: 1,
        is_politics: true,
        topic: "politika",
        note: null,
      }),
    );

    expect(res.status).toBe(200);
    const upserts = supabaseFake.calls.upsert("jev_gold_labels");
    expect(upserts).toHaveLength(1);
    const patch = upserts[0]?.patch as { note: string | null };
    expect(patch.note).toBeNull();
  });

  it("200s and upserts with onConflict article_id,labeler", async () => {
    const mod = await import("@/app/api/admin/jev-gold/label/route");

    const res = await mod.POST(
      postRequest("/api/admin/jev-gold/label", {
        article_id: ARTICLE_ID,
        labeler: 2,
        is_politics: false,
        topic: "spor",
        note: "not",
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    const upserts = supabaseFake.calls.upsert("jev_gold_labels");
    expect(upserts).toHaveLength(1);
    const patch = upserts[0]?.patch as Record<string, unknown>;
    expect(patch).toMatchObject({
      article_id: ARTICLE_ID,
      labeler: 2,
      is_politics: false,
      topic: "spor",
      note: "not",
    });
  });

  it("maps a 23503 to 404", async () => {
    dbState.foreignKeyError = true;
    const mod = await import("@/app/api/admin/jev-gold/label/route");

    const res = await mod.POST(
      postRequest("/api/admin/jev-gold/label", {
        article_id: ARTICLE_ID,
        labeler: 1,
        is_politics: true,
        topic: "politika",
      }),
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Gold article not found");
  });

  it("returns 429 after 60 successful posts from one IP, on the 61st", async () => {
    const mod = await import("@/app/api/admin/jev-gold/label/route");
    const ip = "198.51.100.77";
    for (let i = 0; i < 60; i++) {
      const res = await mod.POST(
        postRequest(
          "/api/admin/jev-gold/label",
          { article_id: ARTICLE_ID, labeler: 1, is_politics: true, topic: "politika" },
          ip,
        ),
      );
      expect(res.status).toBe(200);
    }
    const res = await mod.POST(
      postRequest(
        "/api/admin/jev-gold/label",
        { article_id: ARTICLE_ID, labeler: 1, is_politics: true, topic: "politika" },
        ip,
      ),
    );
    expect(res.status).toBe(429);
  });
});

describe("POST /api/admin/jev-gold/labeler", () => {
  it("401s when unauthenticated", async () => {
    __adminAuthed = false;
    const mod = await import("@/app/api/admin/jev-gold/labeler/route");
    const res = await mod.POST(postRequest("/api/admin/jev-gold/labeler", { labeler: 1 }));
    expect(res.status).toBe(401);
  });

  it("400s on a labeler that is not 1 or 2", async () => {
    const mod = await import("@/app/api/admin/jev-gold/labeler/route");
    for (const labeler of [0, 3, "1", null]) {
      const res = await mod.POST(postRequest("/api/admin/jev-gold/labeler", { labeler }));
      expect(res.status).toBe(400);
    }
  });

  it("200s and sets the jev_labeler cookie httpOnly/lax/30d", async () => {
    const mod = await import("@/app/api/admin/jev-gold/labeler/route");
    const res = await mod.POST(postRequest("/api/admin/jev-gold/labeler", { labeler: 2 }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, labeler: 2 });

    expect(cookieSetMock).toHaveBeenCalledTimes(1);
    const [name, value, options] = cookieSetMock.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe("jev_labeler");
    expect(value).toBe("2");
    expect(options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 2_592_000,
    });
  });

  it("never touches the database", async () => {
    const mod = await import("@/app/api/admin/jev-gold/labeler/route");
    await mod.POST(postRequest("/api/admin/jev-gold/labeler", { labeler: 1 }));

    expect(supabaseFake.calls.mutations).toHaveLength(0);
    expect(supabaseFake.calls.rpc).toHaveLength(0);
  });

  it("returns 429 after 20 successful posts from one IP, on the 21st", async () => {
    const mod = await import("@/app/api/admin/jev-gold/labeler/route");
    const ip = "198.51.100.88";
    for (let i = 0; i < 20; i++) {
      const res = await mod.POST(postRequest("/api/admin/jev-gold/labeler", { labeler: 1 }, ip));
      expect(res.status).toBe(200);
    }
    const res = await mod.POST(postRequest("/api/admin/jev-gold/labeler", { labeler: 1 }, ip));
    expect(res.status).toBe(429);
  });
});

describe("POST /api/admin/jev-gold/seed", () => {
  it("401s when unauthenticated", async () => {
    __adminAuthed = false;
    const mod = await import("@/app/api/admin/jev-gold/seed/route");
    const res = await mod.POST(postRequest("/api/admin/jev-gold/seed", {}));
    expect(res.status).toBe(401);
  });

  it("200s with the inserted count from the RPC", async () => {
    const mod = await import("@/app/api/admin/jev-gold/seed/route");
    const res = await mod.POST(postRequest("/api/admin/jev-gold/seed", {}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, inserted: 128 });
  });

  it("calls jev_gold_seed with no arguments", async () => {
    const mod = await import("@/app/api/admin/jev-gold/seed/route");
    await mod.POST(postRequest("/api/admin/jev-gold/seed", {}));

    const call = supabaseFake.calls.rpc.find((c) => c.name === "jev_gold_seed");
    expect(call).toBeDefined();
    expect(call!.args).toBeUndefined();
  });
});
