import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const KEY = "abcdef0123456789abcdef0123456789";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const h = vi.hoisted(() => ({
  states: [] as Array<{ in: Array<{ col: string; vals: unknown[] }>; eq: Array<{ col: string; val: unknown }>; gte: Array<{ col: string; val: unknown }> }>,
  error: null as { message: string } | null,
}));

const fake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        h.states.push(state as never);
        if (h.error) return { data: null, error: h.error };
        const ids = (state.in.find((f) => f.col === "id")?.vals ?? []) as string[];
        return { data: ids.map((id) => ({ id })), error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({ createClient: () => fake.client }));

type Mod = typeof import("./indexnow");
let mod: Mod;
let fetchMock: ReturnType<typeof vi.fn>;
const ENV_KEYS = ["INDEXNOW_KEY", "NEXT_PUBLIC_SITE_URL", "VERCEL_ENV", "VERCEL_PROJECT_PRODUCTION_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.INDEXNOW_KEY = KEY;
  process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
  delete process.env.VERCEL_ENV;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  h.states.length = 0;
  h.error = null;
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T10:00:00Z"));
  fetchMock = vi.fn(async () => new Response("", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  mod = await import("./indexnow");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("readIndexNowKey / indexNowEnabled", () => {
  it("validates the key", () => {
    expect(mod.readIndexNowKey({ INDEXNOW_KEY: KEY })).toBe(KEY);
    expect(mod.readIndexNowKey({})).toBeNull();
    expect(mod.readIndexNowKey({ INDEXNOW_KEY: "short" })).toBeNull();
    expect(mod.readIndexNowKey({ INDEXNOW_KEY: "has space in it 12345" })).toBeNull();
    expect(mod.readIndexNowKey({ INDEXNOW_KEY: "a".repeat(129) })).toBeNull();
    expect(mod.readIndexNowKey({ INDEXNOW_KEY: "a".repeat(128) })).not.toBeNull();
  });
  it("is enabled only for a valid key, https site, and production/unset VERCEL_ENV", () => {
    expect(mod.indexNowEnabled({ INDEXNOW_KEY: KEY } as never)).toBe(true);
    expect(mod.indexNowEnabled({ INDEXNOW_KEY: KEY, VERCEL_ENV: "production" } as never)).toBe(true);
    expect(mod.indexNowEnabled({ INDEXNOW_KEY: KEY, VERCEL_ENV: "preview" } as never)).toBe(false);
    expect(mod.indexNowEnabled({} as never)).toBe(false);
    process.env.NEXT_PUBLIC_SITE_URL = "http://tayf.test";
    expect(mod.indexNowEnabled({ INDEXNOW_KEY: KEY } as never)).toBe(false);
  });
});

describe("clusterIdsFromTags / buildIndexNowPayload", () => {
  it("extracts only cluster-detail uuids", () => {
    expect(mod.clusterIdsFromTags(["clusters", `cluster-detail:${ID(1)}`, "cluster-detail:nope", `cluster-detail:${ID(2)}`])).toEqual([ID(1), ID(2)]);
    expect(mod.clusterIdsFromTags([])).toEqual([]);
  });
  it("builds the payload shape", () => {
    expect(mod.buildIndexNowPayload("https://tayf.test", KEY, ["https://tayf.test/cluster/a"])).toEqual({
      host: "tayf.test",
      key: KEY,
      keyLocation: "https://tayf.test/indexnow-key.txt",
      urlList: ["https://tayf.test/cluster/a"],
    });
  });
});

describe("pingIndexNowForClusters", () => {
  it("is disabled without key / on preview / on http: no DB call, no fetch", async () => {
    delete process.env.INDEXNOW_KEY;
    expect((await mod.pingIndexNowForClusters([ID(1)])).status).toBe("disabled");
    process.env.INDEXNOW_KEY = KEY;
    process.env.VERCEL_ENV = "preview";
    expect((await mod.pingIndexNowForClusters([ID(1)])).status).toBe("disabled");
    delete process.env.VERCEL_ENV;
    process.env.NEXT_PUBLIC_SITE_URL = "http://tayf.test";
    expect((await mod.pingIndexNowForClusters([ID(1)])).status).toBe("disabled");
    expect(h.states).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies the sitemap eligibility filters in one query and posts the payload", async () => {
    const r = await mod.pingIndexNowForClusters([ID(1), ID(2)]);
    expect(r).toEqual({ status: "sent", count: 2, httpStatus: 200 });
    expect(h.states).toHaveLength(1);
    const s = h.states[0]!;
    expect(s.eq).toContainEqual({ col: "is_archived", val: false });
    expect(s.gte).toContainEqual({ col: "article_count", val: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.indexnow.org/indexnow");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body.host).toBe("tayf.test");
    expect(body.key).toBe(KEY);
    expect(body.keyLocation).toBe("https://tayf.test/indexnow-key.txt");
    expect(body.urlList).toEqual([`https://tayf.test/cluster/${ID(1)}`, `https://tayf.test/cluster/${ID(2)}`]);
  });

  it("caps the batch at 100", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => ID(i + 1));
    const r = await mod.pingIndexNowForClusters(ids);
    expect(r.count).toBe(100);
    expect((h.states[0]!.in[0]!.vals as string[]).length).toBe(100);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).urlList).toHaveLength(100);
  });

  it("dedupes ids pinged within the TTL and lets them through after it", async () => {
    await mod.pingIndexNowForClusters([ID(1)]);
    const again = await mod.pingIndexNowForClusters([ID(1)]);
    expect(again.status).toBe("empty");
    expect(again.count).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + mod.DEDUPE_TTL_MS + 1000);
    // refill the limiter bucket window is irrelevant: 2 tokens available
    const later = await mod.pingIndexNowForClusters([ID(1)]);
    expect(later.status).toBe("sent");
  });

  it("does not mark ids as pinged when the endpoint fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    const r = await mod.pingIndexNowForClusters([ID(1)]);
    expect(r.status).toBe("error");
    expect(r.httpStatus).toBe(500);
    const retry = await mod.pingIndexNowForClusters([ID(1)]);
    expect(retry.status).toBe("sent");
  });

  it("marks ids as pinged on 202", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 202 }));
    expect((await mod.pingIndexNowForClusters([ID(1)])).status).toBe("sent");
    expect((await mod.pingIndexNowForClusters([ID(1)])).status).toBe("empty");
  });

  it("the limiter blocks a 3rd call within 60 s", async () => {
    expect((await mod.pingIndexNowForClusters([ID(1)])).status).toBe("sent");
    expect((await mod.pingIndexNowForClusters([ID(2)])).status).toBe("sent");
    const third = await mod.pingIndexNowForClusters([ID(3)]);
    expect(third.status).toBe("rate-limited");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a 429 starts the cooldown, which blocks later sends until it lapses", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    const first = await mod.pingIndexNowForClusters([ID(1)]);
    expect(first).toEqual({ status: "rejected", count: 1, httpStatus: 429 });
    const second = await mod.pingIndexNowForClusters([ID(2)]);
    expect(second.status).toBe("cooldown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + mod.COOLDOWN_MS + 1000);
    expect((await mod.pingIndexNowForClusters([ID(3)])).status).toBe("sent");
  });

  it.each([403, 422])("a %i also starts the cooldown", async (code) => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: code }));
    await mod.pingIndexNowForClusters([ID(1)]);
    expect((await mod.pingIndexNowForClusters([ID(2)])).status).toBe("cooldown");
  });

  it("a rejected fetch gives 'error' without throwing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    const r = await mod.pingIndexNowForClusters([ID(1)]);
    expect(r.status).toBe("error");
  });

  it("a DB error gives 'error' without fetching", async () => {
    h.error = { message: "db down" };
    const r = await mod.pingIndexNowForClusters([ID(1)]);
    expect(r.status).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 'empty' when no id is eligible", async () => {
    const r = await mod.pingIndexNowForClusters([]);
    expect(r.status).toBe("empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never logs the key", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    fetchMock.mockRejectedValueOnce(new Error(`network ${KEY}`));
    await mod.pingIndexNowForClusters([ID(1)]);
    await mod.pingIndexNowForClusters([ID(2)]);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).toContain("[indexnow]");
    expect(logged).not.toContain(KEY);
  });
});
