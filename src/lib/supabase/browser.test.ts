import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The browser client is a plain fetch wrapper around PostgREST (see the header
// of browser.ts for why it is no longer supabase-js). Every test loads a fresh
// copy of the module (the client is a module-level singleton) with a stubbed
// env and a stubbed global fetch, so nothing here touches the network.

const URL_ENV = "https://proj.supabase.co";
const ANON = "anon-key-for-tests";
const ID = "123e4567-e89b-42d3-a456-426614174000";

type Browser = typeof import("./browser");

async function load(env: { url?: string; key?: string } = { url: URL_ENV, key: ANON }): Promise<Browser> {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", env.url ?? "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", env.key ?? "");
  return await import("./browser");
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("createBrowserClient: request shape", () => {
  it("POSTs rpc('saved_clusters_v2', args) once, to the PostgREST rpc URL, with the anon key and no credentials", async () => {
    const fetchMock = stubFetch(async () => json([]));
    const { createBrowserClient } = await load();
    const args = { p_ids: [ID] };
    await createBrowserClient().rpc("saved_clusters_v2", args);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${URL_ENV}/rest/v1/rpc/saved_clusters_v2`);
    expect(init.method).toBe("POST");
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      apikey: ANON,
      authorization: `Bearer ${ANON}`,
      "content-type": "application/json",
      accept: "application/json",
    });
    expect(init.body).toBe(JSON.stringify(args));
    expect(init.credentials).toBe("omit");
  });

  it("POSTs rpc('saved_clusters_v3', args) to its own PostgREST rpc URL (migration 158, first_published)", async () => {
    const fetchMock = stubFetch(async () => json([]));
    const { createBrowserClient } = await load();
    const args = { p_ids: [ID] };
    await createBrowserClient().rpc("saved_clusters_v3", args);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${URL_ENV}/rest/v1/rpc/saved_clusters_v3`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(args));
    expect(init.credentials).toBe("omit");
  });

  it("POSTs rpc('saved_clusters_v4', args) to its own PostgREST rpc URL (migration 192, effective_article_count)", async () => {
    const fetchMock = stubFetch(async () => json([]));
    const { createBrowserClient } = await load();
    const args = { p_ids: [ID] };
    await createBrowserClient().rpc("saved_clusters_v4", args);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${URL_ENV}/rest/v1/rpc/saved_clusters_v4`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(args));
    expect(init.credentials).toBe("omit");
  });

  it("also reaches the v1 function by name", async () => {
    const fetchMock = stubFetch(async () => json([]));
    const { createBrowserClient } = await load();
    await createBrowserClient().rpc("saved_clusters", { p_ids: [ID] });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${URL_ENV}/rest/v1/rpc/saved_clusters`);
  });

  it("strips trailing slashes from the project URL", async () => {
    const fetchMock = stubFetch(async () => json([]));
    const { createBrowserClient } = await load({ url: `${URL_ENV}/`, key: ANON });
    await createBrowserClient().rpc("saved_clusters_v2", { p_ids: [ID] });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${URL_ENV}/rest/v1/rpc/saved_clusters_v2`);

    const second = stubFetch(async () => json([]));
    const again = await load({ url: `${URL_ENV}///`, key: ANON });
    await again.createBrowserClient().rpc("saved_clusters", { p_ids: [ID] });
    expect(second.mock.calls[0]![0]).toBe(`${URL_ENV}/rest/v1/rpc/saved_clusters`);
  });

  it("sends no timeout signal and no cookies: the same as supabase-js did", async () => {
    const fetchMock = stubFetch(async () => json([]));
    const { createBrowserClient } = await load();
    await createBrowserClient().rpc("saved_clusters_v2", { p_ids: [ID] });
    const init = fetchMock.mock.calls[0]![1];
    expect(init.signal).toBeUndefined();
    expect(init.credentials).toBe("omit");
  });
});

describe("createBrowserClient: responses", () => {
  it("returns {data, error: null} for a 200 array", async () => {
    const rows = [{ id: ID, title: "Başlık" }];
    stubFetch(async () => json(rows));
    const { createBrowserClient } = await load();
    const res = await createBrowserClient().rpc("saved_clusters_v2", { p_ids: [ID] });
    expect(res).toEqual({ data: rows, error: null });
  });

  it("returns an empty array as data, not as an error", async () => {
    stubFetch(async () => json([]));
    const { createBrowserClient } = await load();
    const res = await createBrowserClient().rpc("saved_clusters_v2", { p_ids: [ID] });
    expect(res).toEqual({ data: [], error: null });
  });

  it("maps a PostgREST error body to {data: null, error: {code, message, details, hint}} (saved-list keys its v1 fallback on PGRST202)", async () => {
    stubFetch(async () =>
      json(
        {
          code: "PGRST202",
          message: "Could not find the function public.saved_clusters_v2(p_ids) in the schema cache",
          details: null,
          hint: "Perhaps you meant to call the function public.saved_clusters",
        },
        404,
      ),
    );
    const { createBrowserClient } = await load();
    const res = await createBrowserClient().rpc("saved_clusters_v2", { p_ids: [ID] });
    expect(res.data).toBeNull();
    expect(res.error).toEqual({
      code: "PGRST202",
      message: "Could not find the function public.saved_clusters_v2(p_ids) in the schema cache",
      details: null,
      hint: "Perhaps you meant to call the function public.saved_clusters",
    });
    expect(res.error?.code).toBe("PGRST202");
  });

  it("copies only code, message, details and hint from an error body", async () => {
    stubFetch(async () =>
      json({ code: "22P02", message: "invalid input syntax", details: "d", hint: "h", secret: "x", stack: "s" }, 400),
    );
    const { createBrowserClient } = await load();
    const res = await createBrowserClient().rpc("saved_clusters", { p_ids: ["nope"] });
    expect(res.error).toEqual({ code: "22P02", message: "invalid input syntax", details: "d", hint: "h" });
  });

  it("ignores error fields of the wrong type and falls back to the status for the message", async () => {
    stubFetch(async () => json({ code: 42, message: { a: 1 }, details: 1, hint: [] }, 400));
    const { createBrowserClient } = await load();
    const res = await createBrowserClient().rpc("saved_clusters", { p_ids: [ID] });
    expect(res).toEqual({ data: null, error: { message: "HTTP 400" } });
  });

  it("maps a non-JSON 500 body to {message: 'HTTP 500'} without echoing the body", async () => {
    stubFetch(async () => new Response("<html>upstream exploded: apikey=" + ANON + "</html>", { status: 500 }));
    const { createBrowserClient } = await load();
    const res = await createBrowserClient().rpc("saved_clusters_v2", { p_ids: [ID] });
    expect(res).toEqual({ data: null, error: { message: "HTTP 500" } });
    expect(JSON.stringify(res)).not.toContain(ANON);
  });

  it("maps a JSON error body that is not an object to the status message", async () => {
    stubFetch(async () => json("nope", 502));
    const { createBrowserClient } = await load();
    expect(await createBrowserClient().rpc("saved_clusters_v2", { p_ids: [ID] })).toEqual({
      data: null,
      error: { message: "HTTP 502" },
    });
    stubFetch(async () => json(null, 503));
    expect(await createBrowserClient().rpc("saved_clusters_v2", { p_ids: [ID] })).toEqual({
      data: null,
      error: { message: "HTTP 503" },
    });
  });

  it("maps a 200 with invalid JSON to {message: 'Invalid JSON response'}", async () => {
    stubFetch(async () => new Response("<html>captive portal</html>", { status: 200 }));
    const { createBrowserClient } = await load();
    const res = await createBrowserClient().rpc("saved_clusters_v2", { p_ids: [ID] });
    expect(res).toEqual({ data: null, error: { message: "Invalid JSON response" } });
  });

  it("maps a 200 with an empty body to the same invalid-JSON error", async () => {
    stubFetch(async () => new Response("", { status: 200 }));
    const { createBrowserClient } = await load();
    const res = await createBrowserClient().rpc("saved_clusters_v2", { p_ids: [ID] });
    expect(res).toEqual({ data: null, error: { message: "Invalid JSON response" } });
  });
});

describe("createBrowserClient: failures never throw", () => {
  it("resolves {data: null, error: {message}} when fetch rejects with a TypeError", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { createBrowserClient } = await load();
    const res = await createBrowserClient().rpc("saved_clusters_v2", { p_ids: [ID] });
    expect(res).toEqual({ data: null, error: { message: "Failed to fetch" } });
  });

  it("uses a generic message when fetch rejects with something that is not an Error", async () => {
    stubFetch(() => Promise.reject("boom: " + ANON));
    const { createBrowserClient } = await load();
    const res = await createBrowserClient().rpc("saved_clusters_v2", { p_ids: [ID] });
    expect(res).toEqual({ data: null, error: { message: "Network error" } });
    expect(JSON.stringify(res)).not.toContain(ANON);
  });

  it("resolves an error when the body cannot be serialised", async () => {
    const fetchMock = stubFetch(async () => json([]));
    const { createBrowserClient } = await load();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const res = await createBrowserClient().rpc("saved_clusters_v2", circular);
    expect(res.data).toBeNull();
    expect(typeof res.error?.message).toBe("string");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createBrowserClient: env and singleton", () => {
  const MESSAGE = "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.";

  it("throws the exact message when the URL or the key is missing", async () => {
    stubFetch(async () => json([]));
    for (const env of [
      { url: undefined, key: undefined },
      { url: URL_ENV, key: undefined },
      { url: undefined, key: ANON },
      { url: "", key: "" },
    ]) {
      const { createBrowserClient } = await load(env);
      expect(() => createBrowserClient()).toThrow(new Error(MESSAGE));
    }
  });

  it("does not throw at import time, only when the client is created", async () => {
    await expect(load({})).resolves.toBeDefined();
  });

  it("is a singleton: two calls return the same object", async () => {
    stubFetch(async () => json([]));
    const { createBrowserClient } = await load();
    expect(createBrowserClient()).toBe(createBrowserClient());
  });

  it("keeps the first client even if the env changes afterwards", async () => {
    const fetchMock = stubFetch(async () => json([]));
    const { createBrowserClient } = await load();
    const first = createBrowserClient();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://other.supabase.co");
    expect(createBrowserClient()).toBe(first);
    await first.rpc("saved_clusters", { p_ids: [ID] });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${URL_ENV}/rest/v1/rpc/saved_clusters`);
  });
});

describe("createBrowserClient: runtime allowlist", () => {
  it("refuses a name outside the allowlist without calling fetch", async () => {
    const fetchMock = stubFetch(async () => json([]));
    const { createBrowserClient } = await load();
    const client = createBrowserClient();
    const names = [
      "merged_cluster_map",
      "source_slugs",
      "saved_clusters_v5",
      "saved_clusters_v4/../other",
      "saved_clusters_v4?select=*",
      "saved_clusters_v3/../other",
      "saved_clusters_v3?select=*",
      "SAVED_CLUSTERS_V3",
      "SAVED_CLUSTERS_V4",
      "",
      "saved_clusters/../other",
      "saved_clusters?select=*",
      "saved_clusters ",
      "SAVED_CLUSTERS",
      "constructor",
      "__proto__",
      "toString",
    ];
    for (const name of names) {
      const res = await client.rpc(name as never, { p_ids: [ID] });
      expect(res, name).toEqual({ data: null, error: { message: "rpc not allowed" } });
    }
    const notStrings = await client.rpc(42 as never, {});
    expect(notStrings).toEqual({ data: null, error: { message: "rpc not allowed" } });
    expect(await client.rpc(undefined as never, {})).toEqual({ data: null, error: { message: "rpc not allowed" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
