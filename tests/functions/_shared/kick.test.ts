import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  clusterKickTarget,
  KICK_ENV,
  KICK_PATH,
  KICK_TIMEOUT_MS,
  kickClusterConsumer,
  scheduleClusterKick,
  shouldKick,
} from "../../../supabase/functions/_shared/kick.ts";

// ---------------------------------------------------------------------------
// Direct tests for supabase/functions/_shared/kick.ts (h106-attachdesign-1).
//
// After an ingest cycle that inserted articles, ingest POSTs {"trigger":"ingest"} to cluster-consumer so
// the new cluster_work messages are read seconds after the insert instead of at the next cron minute.
// The one rule that cannot bend (the #252 failure mode, h102-pollregression-1): the kick is NEVER awaited
// inside ingest's response path. pg_net 0.20.0 starts its next batch only after the previous request
// ended, so a handler that waits on the consumer holds ingest-drain's request open. The kick therefore
// runs inside EdgeRuntime.waitUntil (an un-awaited promise where the runtime has none, i.e. in tests),
// and every failure (a rejected fetch, a timeout, a non-2xx answer) is captured and warned, never thrown.
//
// All collaborators (fetch, waitUntil, the clock, the log, Sentry, the environment) are injected.
// ---------------------------------------------------------------------------

const KEY = "sb_secret_test_key_0123456789";
const URL_BASE = "https://abc.supabase.co";

interface Probe {
  fetchFn: ReturnType<typeof vi.fn>;
  logs: string[];
  warns: string[];
  captured: unknown[];
  deps: NonNullable<Parameters<typeof kickClusterConsumer>[1]>;
}

function probe(
  answer: (input: string, init: RequestInit) => Promise<Response> | Response = () => Response.json({ ok: true, drained: 3 }),
  extra: Partial<NonNullable<Parameters<typeof kickClusterConsumer>[1]>> = {},
): Probe {
  const logs: string[] = [];
  const warns: string[] = [];
  const captured: unknown[] = [];
  let t = 10_000;
  const fetchFn = vi.fn(async (input: string, init: RequestInit) => {
    t += 1_234;
    return await answer(input, init);
  });
  return {
    fetchFn,
    logs,
    warns,
    captured,
    deps: {
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => t,
      log: (line: string) => void logs.push(line),
      warn: (line: string) => void warns.push(line),
      capture: (err: unknown) => void captured.push(err),
      ...extra,
    },
  };
}

const target = { url: URL_BASE, key: KEY };

afterEach(() => {
  delete (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime;
  vi.useRealTimers();
});

describe("shouldKick", () => {
  it("names the flag CLUSTER_KICK and the path /functions/v1/cluster-consumer", () => {
    expect(KICK_ENV).toBe("CLUSTER_KICK");
    expect(KICK_PATH).toBe("/functions/v1/cluster-consumer");
    expect(KICK_TIMEOUT_MS).toBe(45_000);
  });

  it("kicks only when the flag is exactly 'on' and the cycle inserted at least one article", () => {
    expect(shouldKick("on", 1)).toBe(true);
    expect(shouldKick("on", 250)).toBe(true);
  });

  it.each([undefined, null, "", "off", "ON", "On", "true", "1", " on", "on ", "yes"])("never kicks for the flag %j", (flag) => {
    expect(shouldKick(flag, 5)).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, "3", [], {}])("never kicks for inserted = %j", (inserted) => {
    expect(shouldKick("on", inserted)).toBe(false);
  });
});

describe("clusterKickTarget", () => {
  const env = (m: Record<string, string>) => (name: string) => m[name];

  it("builds the target from SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY", () => {
    expect(clusterKickTarget(env({ SUPABASE_URL: URL_BASE, SUPABASE_SERVICE_ROLE_KEY: KEY }))).toEqual({ url: URL_BASE, key: KEY });
  });

  it("drops trailing slashes from the URL", () => {
    expect(clusterKickTarget(env({ SUPABASE_URL: `${URL_BASE}//`, SUPABASE_SERVICE_ROLE_KEY: KEY }))?.url).toBe(URL_BASE);
  });

  it("reads the same fallbacks createServiceClient reads (SB_URL, NEXT_PUBLIC_SUPABASE_URL, SB_SERVICE_ROLE_KEY)", () => {
    expect(clusterKickTarget(env({ SB_URL: URL_BASE, SB_SERVICE_ROLE_KEY: KEY }))).toEqual({ url: URL_BASE, key: KEY });
    expect(clusterKickTarget(env({ NEXT_PUBLIC_SUPABASE_URL: URL_BASE, SUPABASE_SERVICE_ROLE_KEY: KEY }))).toEqual({ url: URL_BASE, key: KEY });
  });

  it.each([
    [{ SUPABASE_URL: URL_BASE }],
    [{ SUPABASE_SERVICE_ROLE_KEY: KEY }],
    [{ SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: KEY }],
    [{ SUPABASE_URL: URL_BASE, SUPABASE_SERVICE_ROLE_KEY: "" }],
    [{}],
  ])("is null when either half is missing (%j)", (m) => {
    expect(clusterKickTarget(env(m as Record<string, string>))).toBeNull();
  });

  it("is null for a URL that is not http(s): the target is never built from anything but a web address", () => {
    expect(clusterKickTarget(env({ SUPABASE_URL: "file:///etc/passwd", SUPABASE_SERVICE_ROLE_KEY: KEY }))).toBeNull();
    expect(clusterKickTarget(env({ SUPABASE_URL: "not a url", SUPABASE_SERVICE_ROLE_KEY: KEY }))).toBeNull();
  });
});

describe("kickClusterConsumer: the request", () => {
  it("POSTs {\"trigger\":\"ingest\"} to <SUPABASE_URL>/functions/v1/cluster-consumer with the service-role bearer", async () => {
    const p = probe();
    await kickClusterConsumer(target, p.deps);
    expect(p.fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = p.fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${URL_BASE}/functions/v1/cluster-consumer`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"trigger":"ingest"}');
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("carries an abort signal built for 45 000 ms", async () => {
    const asked: number[] = [];
    const signal = new AbortController().signal;
    const p = probe(undefined, { timeoutSignal: (ms: number) => (asked.push(ms), signal) });
    await kickClusterConsumer(target, p.deps);
    expect(asked).toEqual([45_000]);
    expect((p.fetchFn.mock.calls[0] as [string, RequestInit])[1].signal).toBe(signal);
  });

  it("uses AbortSignal.timeout(45000) when no signal factory is injected", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      const p = probe();
      await kickClusterConsumer(target, p.deps);
      expect(spy).toHaveBeenCalledWith(45_000);
      expect((p.fetchFn.mock.calls[0] as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("kickClusterConsumer: outcomes (never throws)", () => {
  it("2xx: logs status, drained and the elapsed ms, captures and warns nothing", async () => {
    const p = probe(() => Response.json({ ok: true, drained: 3, matched: 2 }));
    const out = await kickClusterConsumer(target, p.deps);
    expect(out).toEqual({ ok: true, status: 200, drained: 3, ms: 1_234 });
    expect(p.logs).toHaveLength(1);
    const fields = JSON.parse(p.logs[0]!.slice(p.logs[0]!.indexOf("{")));
    expect(fields).toMatchObject({ status: 200, drained: 3, ms: 1_234 });
    expect(p.warns).toEqual([]);
    expect(p.captured).toEqual([]);
  });

  it("2xx busy answer: logged with its reason, not an error", async () => {
    const p = probe(() => Response.json({ ok: true, busy: true, reason: "lease" }));
    const out = await kickClusterConsumer(target, p.deps);
    expect(out).toMatchObject({ ok: true, status: 200, drained: null });
    const fields = JSON.parse(p.logs[0]!.slice(p.logs[0]!.indexOf("{")));
    expect(fields).toMatchObject({ status: 200, busy: true, reason: "lease" });
    expect(p.captured).toEqual([]);
    expect(p.warns).toEqual([]);
  });

  it("2xx with a body that is not JSON: still a success, drained null", async () => {
    const p = probe(() => new Response("<html>ok</html>", { status: 200 }));
    const out = await kickClusterConsumer(target, p.deps);
    expect(out).toMatchObject({ ok: true, status: 200, drained: null });
    expect(p.captured).toEqual([]);
  });

  it.each([400, 401, 500, 502, 503, 504, 546])("non-2xx %s: captured and warned once, never rethrown", async (status) => {
    const p = probe(() => new Response(JSON.stringify({ ok: false, error: "internal-error" }), { status }));
    const out = await kickClusterConsumer(target, p.deps);
    expect(out).toMatchObject({ ok: false, status });
    expect(p.captured).toHaveLength(1);
    expect((p.captured[0] as Error).message).toContain(String(status));
    expect(p.warns).toHaveLength(1);
    expect(p.warns[0]).toContain(String(status));
  });

  it("a rejected fetch: captured and warned, never rethrown", async () => {
    const p = probe(() => Promise.reject(new TypeError("fetch failed")));
    const out = await kickClusterConsumer(target, p.deps);
    expect(out).toMatchObject({ ok: false, status: null });
    expect(p.captured).toHaveLength(1);
    expect((p.captured[0] as Error).message).toContain("fetch failed");
    expect(p.warns).toHaveLength(1);
  });

  it("a timeout (the signal fires, fetch rejects with a TimeoutError): captured and warned, never rethrown", async () => {
    const ctl = new AbortController();
    const p = probe(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("The operation timed out.", "TimeoutError")));
        }),
      { timeoutSignal: () => ctl.signal },
    );
    const pending = kickClusterConsumer(target, p.deps);
    ctl.abort();
    const out = await pending;
    expect(out).toMatchObject({ ok: false, status: null });
    expect(p.captured).toHaveLength(1);
    expect((p.captured[0] as Error).message).toContain("timed out");
    expect(p.warns).toHaveLength(1);
  });

  it("a fetch that throws synchronously is handled like a rejection", async () => {
    const p = probe();
    p.deps.fetchFn = (() => {
      throw new Error("sync boom");
    }) as unknown as typeof fetch;
    const out = await kickClusterConsumer(target, p.deps);
    expect(out.ok).toBe(false);
    expect(p.captured).toHaveLength(1);
  });

  it("a capture hook that itself throws does not escape", async () => {
    const p = probe(() => Promise.reject(new Error("x")), {
      capture: () => {
        throw new Error("sentry down");
      },
    });
    await expect(kickClusterConsumer(target, p.deps)).resolves.toMatchObject({ ok: false });
  });

  it("reads and discards a non-2xx body so the connection is released, and never logs it", async () => {
    const p = probe(() => new Response("SECRET-DIAGNOSTIC-BODY", { status: 500 }));
    await kickClusterConsumer(target, p.deps);
    const everything = [...p.logs, ...p.warns, ...p.captured.map((e) => (e as Error).message)].join("\n");
    expect(everything.includes("SECRET-DIAGNOSTIC-BODY")).toBe(false);
  });
});

describe("kickClusterConsumer: the key is never logged", () => {
  it("on success, on a non-2xx answer and on a failure whose own message contains the key", async () => {
    const cases: Array<() => Promise<Response> | Response> = [
      () => Response.json({ ok: true, drained: 1 }),
      () => new Response("denied", { status: 401, headers: { "x-echo": `Bearer ${KEY}` } }),
      () => Promise.reject(new Error(`request to ${URL_BASE} with Bearer ${KEY} failed`)),
    ];
    for (const answer of cases) {
      const p = probe(answer);
      await kickClusterConsumer(target, p.deps);
      const everything = [...p.logs, ...p.warns, ...p.captured.map((e) => `${(e as Error).message}\n${(e as Error).stack ?? ""}`)].join("\n");
      expect(everything.includes(KEY), everything).toBe(false);
      expect(everything.toLowerCase().includes("authorization")).toBe(false);
    }
  });

  it("redacts the key from a captured error message instead of dropping the error", async () => {
    const p = probe(() => Promise.reject(new Error(`bad Bearer ${KEY} here`)));
    await kickClusterConsumer(target, p.deps);
    expect((p.captured[0] as Error).message).toContain("[redacted]");
    expect((p.captured[0] as Error).message).toContain("bad Bearer");
  });
});

describe("scheduleClusterKick: never awaited, never thrown", () => {
  it("hands the kick to waitUntil exactly once and returns before the consumer answers", async () => {
    let release: (r: Response) => void = () => {};
    const p = probe(() => new Promise<Response>((resolve) => (release = resolve)));
    const handed: Array<Promise<unknown>> = [];
    const out = scheduleClusterKick(target, { ...p.deps, waitUntil: (pr) => void handed.push(pr) });
    expect(out).toBeUndefined(); // nothing to await: a void return
    expect(handed).toHaveLength(1);
    expect(p.fetchFn).toHaveBeenCalledTimes(1); // started now, answering later
    let settled = false;
    void handed[0]!.then(() => (settled = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false); // the consumer has not answered: the caller is already free to respond
    release(Response.json({ ok: true, drained: 2 }));
    await handed[0];
    expect(settled).toBe(true);
    expect(p.logs).toHaveLength(1);
  });

  it("uses EdgeRuntime.waitUntil when the runtime has one, called as a method", async () => {
    const p = probe();
    const calls: Array<{ self: unknown; promise: Promise<unknown> }> = [];
    const edge = {
      waitUntil(this: unknown, promise: Promise<unknown>) {
        calls.push({ self: this, promise });
      },
    };
    (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime = edge;
    scheduleClusterKick(target, p.deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.self).toBe(edge);
    await calls[0]!.promise;
    expect(p.logs).toHaveLength(1);
  });

  it("falls back to an un-awaited promise when EdgeRuntime is undefined (tests, local serve)", async () => {
    const p = probe(() => Promise.reject(new Error("down")));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(() => scheduleClusterKick(target, p.deps)).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));
      expect(p.fetchFn).toHaveBeenCalledTimes(1);
      expect(p.captured).toHaveLength(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("an EdgeRuntime without a waitUntil function counts as undefined", async () => {
    (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime = { waitUntil: "nope" };
    const p = probe();
    scheduleClusterKick(target, p.deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(p.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a waitUntil that throws is warned about and swallowed", () => {
    const p = probe();
    expect(() =>
      scheduleClusterKick(target, {
        ...p.deps,
        waitUntil: () => {
          throw new Error("isolate is shutting down");
        },
      }),
    ).not.toThrow();
    expect(p.warns).toHaveLength(1);
    expect(p.warns[0]).toContain("isolate is shutting down");
  });

  it("without a target (URL or key missing) it neither fetches nor throws, and warns once without naming a value", () => {
    const p = probe();
    const handed: unknown[] = [];
    expect(() => scheduleClusterKick(null, { ...p.deps, waitUntil: (pr) => void handed.push(pr) })).not.toThrow();
    expect(p.fetchFn).not.toHaveBeenCalled();
    expect(handed).toEqual([]);
    expect(p.warns).toHaveLength(1);
    expect(p.captured).toEqual([]);
  });

  it("the default environment reader is used when no target is passed: SUPABASE_URL and the service role key", async () => {
    const saved = (globalThis as { Deno?: unknown }).Deno;
    (globalThis as { Deno?: unknown }).Deno = {
      env: { get: (k: string) => ({ SUPABASE_URL: URL_BASE, SUPABASE_SERVICE_ROLE_KEY: KEY })[k] },
    };
    try {
      const p = probe();
      const handed: Array<Promise<unknown>> = [];
      scheduleClusterKick(undefined, { ...p.deps, waitUntil: (pr) => void handed.push(pr) });
      await handed[0];
      expect((p.fetchFn.mock.calls[0] as [string])[0]).toBe(`${URL_BASE}/functions/v1/cluster-consumer`);
    } finally {
      (globalThis as { Deno?: unknown }).Deno = saved;
    }
  });
});

describe("kick.ts: static", () => {
  const src = readFileSync(resolve(__dirname, "..", "..", "..", "supabase", "functions", "_shared", "kick.ts"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
    .join("\n");

  it("reads only the environment the functions already read (createServiceClient's names), plus nothing new", () => {
    const read = [...code.matchAll(/readEnv\("([A-Z0-9_]+)"\)/g)].map((m) => m[1]);
    expect(new Set(read)).toEqual(
      new Set(["SUPABASE_URL", "SB_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SB_SERVICE_ROLE_KEY"]),
    );
    // the same names, in the same two groups, as _shared/supabase.ts
    const client = readFileSync(resolve(__dirname, "..", "..", "..", "supabase", "functions", "_shared", "supabase.ts"), "utf8");
    for (const name of read) expect(client, name).toContain(`"${name}"`);
    expect(code.includes("Deno.env.get(")).toBe(true); // only through the guarded reader below
    expect([...code.matchAll(/Deno\.env\.get\(/g)]).toHaveLength(1);
  });

  it("never passes the key or the headers to a logger, a capture hook or console", () => {
    for (const line of code.split("\n")) {
      if (/\b(log|warn|capture|console\.\w+)\(/.test(line)) {
        expect(/\bkey\b|headers|authorization/i.test(line), line).toBe(false);
      }
    }
  });

  it("holds no await on the consumer call outside the kick's own async function (the caller never awaits it)", () => {
    expect(code).toContain("export function scheduleClusterKick(");
    expect(code.includes("export async function scheduleClusterKick")).toBe(false);
  });
});
