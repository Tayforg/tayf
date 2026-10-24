import { describe, it, expect, vi } from "vitest";
import { isValidSourceSlug } from "@/lib/validation/source-input";
import { SOURCE_SLUG_RE, createSourceSlugGate } from "./source-slug-gate";

const URL_ = "https://proj.supabase.co";
const KEY = "anon-key";
const ENV = () => ({ url: URL_, anonKey: KEY });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * fetch fake for migration 116's RPCs: `rpc/source_slugs` answers the full
 * list, `rpc/source_slug_exists?p_slug=` answers a bare boolean.
 */
function fakeFetch(opts: { all?: string[]; confirm?: Record<string, boolean> }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    const m = u.match(/rpc\/source_slug_exists\?p_slug=([^&]+)/);
    if (m) {
      const slug = decodeURIComponent(m[1]);
      return json(opts.confirm?.[slug] === true);
    }
    return json((opts.all ?? []).map((slug) => ({ slug })));
  });
}

function mk(f: ReturnType<typeof fakeFetch>, extra: Record<string, unknown> = {}) {
  let t = 1_000_000;
  const now = () => t;
  const gate = createSourceSlugGate({
    getEnv: ENV,
    fetchImpl: f as unknown as typeof fetch,
    now,
    freshMs: 0, // legacy tests exercise the probe path
    ...extra,
  });
  return { gate, advance: (ms: number) => (t += ms) };
}

describe("createSourceSlugGate", () => {
  it("returns missing with no fetch for a malformed slug", async () => {
    const f = fakeFetch({});
    const { gate } = mk(f);
    for (const s of ["Bad_Slug!", "CNN", "-x", "", "a".repeat(65), "ç"]) {
      expect(await gate.check(s), s).toBe("missing");
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("returns exists for a slug in the set (one fetch, shared)", async () => {
    const f = fakeFetch({ all: ["cnn-turk", "bbc"] });
    const { gate } = mk(f);
    expect(await gate.check("cnn-turk")).toBe("exists");
    expect(await gate.check("bbc")).toBe("exists");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight set load across concurrent calls", async () => {
    const f = fakeFetch({ all: ["a", "b"] });
    const { gate } = mk(f);
    const r = await Promise.all([gate.check("a"), gate.check("b"), gate.check("a")]);
    expect(r).toEqual(["exists", "exists", "exists"]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("confirms an absent slug, returns missing, and negative-caches it for 60s", async () => {
    const f = fakeFetch({ all: ["a"] });
    const { gate, advance } = mk(f);
    expect(await gate.check("nope")).toBe("missing");
    expect(f).toHaveBeenCalledTimes(2); // list + confirm
    expect(await gate.check("nope")).toBe("missing");
    expect(f).toHaveBeenCalledTimes(2);
    advance(61_000);
    expect(await gate.check("nope")).toBe("missing");
    expect(f).toHaveBeenCalledTimes(3); // confirm again (set still fresh)
  });

  it("flood: unique unknown slugs cause no per-slug probes while the set is fresh", async () => {
    const f = fakeFetch({ all: ["a"] });
    const { gate, advance } = mk(f, { freshMs: 60_000 });
    for (let i = 0; i < 200; i++) expect(await gate.check(`junk-${i}`)).toBe("missing");
    expect(f).toHaveBeenCalledTimes(1); // only the set load
    expect(await gate.check("a")).toBe("exists");
    advance(61_000); // set older than freshMs (< setTtlMs): targeted probe allowed again
    expect(await gate.check("junk-x")).toBe("missing");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a confirmed row returns exists and joins the set", async () => {
    const f = fakeFetch({ all: ["a"], confirm: { fresh: true } });
    const { gate } = mk(f);
    expect(await gate.check("fresh")).toBe("exists");
    expect(f).toHaveBeenCalledTimes(2);
    expect(await gate.check("fresh")).toBe("exists");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("refetches the set after setTtlMs", async () => {
    const f = fakeFetch({ all: ["a"] });
    const { gate, advance } = mk(f);
    await gate.check("a");
    advance(299_000);
    await gate.check("a");
    expect(f).toHaveBeenCalledTimes(1);
    advance(2_000);
    await gate.check("a");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("returns unknown on reject, non-200 and missing env", async () => {
    const rej = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(
      await createSourceSlugGate({ getEnv: ENV, fetchImpl: rej as unknown as typeof fetch }).check("a"),
    ).toBe("unknown");

    const bad = vi.fn(async () => json({ message: "x" }, 500));
    expect(
      await createSourceSlugGate({ getEnv: ENV, fetchImpl: bad as unknown as typeof fetch }).check("a"),
    ).toBe("unknown");

    const f = fakeFetch({ all: ["a"] });
    for (const env of [{}, { url: URL_ }, { anonKey: KEY }]) {
      const g = createSourceSlugGate({ getEnv: () => env, fetchImpl: f as unknown as typeof fetch });
      expect(await g.check("a")).toBe("unknown");
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("returns unknown when the confirm request fails", async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      if (n === 1) return json([{ slug: "a" }]);
      throw new Error("timeout");
    });
    const g = createSourceSlugGate({ getEnv: ENV, fetchImpl: f as unknown as typeof fetch, freshMs: 0 });
    expect(await g.check("zzz")).toBe("unknown");
  });

  it("serves a stale set when a refresh fails (within staleMaxMs), then gives up", async () => {
    let fail = false;
    const f = vi.fn(async () => {
      if (fail) throw new Error("down");
      return json([{ slug: "a" }]);
    });
    const { gate, advance } = mk(f as unknown as ReturnType<typeof fakeFetch>);
    expect(await gate.check("a")).toBe("exists");
    fail = true;
    advance(400_000);
    expect(await gate.check("a")).toBe("exists"); // stale but usable
    advance(3_600_000);
    expect(await gate.check("a")).toBe("unknown");
  });

  it("caps negatives at maxNegatives (oldest evicted)", async () => {
    const f = fakeFetch({ all: [] });
    const { gate } = mk(f, { maxNegatives: 3 });
    for (const s of ["n1", "n2", "n3", "n4"]) await gate.check(s);
    const before = f.mock.calls.length;
    await gate.check("n4");
    await gate.check("n3");
    await gate.check("n2");
    expect(f.mock.calls.length).toBe(before); // still cached
    await gate.check("n1"); // evicted: re-confirmed
    expect(f.mock.calls.length).toBe(before + 1);
  });

  it("sends the documented RPC URLs and headers", async () => {
    const f = fakeFetch({ all: [] });
    const { gate } = mk(f);
    await gate.check("cnn-turk");
    const [listUrl, listInit] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(listUrl).toBe(`${URL_}/rest/v1/rpc/source_slugs`);
    expect(listInit.headers).toMatchObject({
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Accept: "application/json",
    });
    expect(listInit.signal).toBeInstanceOf(AbortSignal);
    const [confirmUrl, confirmInit] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(confirmUrl).toBe(`${URL_}/rest/v1/rpc/source_slug_exists?p_slug=cnn-turk`);
    expect(confirmInit.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });
    expect(confirmInit.signal).toBeInstanceOf(AbortSignal);
    // Never the sources table: 117 revokes anon SELECT on it.
    for (const [u] of f.mock.calls as unknown as [string][]) {
      expect(u).not.toContain("/rest/v1/sources");
    }
  });

  it("treats a non-boolean probe body as unknown and does not negative-cache it", async () => {
    for (const bad of [[], {}, [true], "true", null, 1, { source_slug_exists: false }]) {
      let probes = 0;
      const f = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("source_slug_exists")) {
          probes++;
          return json(bad);
        }
        return json([{ slug: "a" }]);
      });
      const { gate } = mk(f as unknown as ReturnType<typeof fakeFetch>);
      expect(await gate.check("zzz"), JSON.stringify(bad)).toBe("unknown");
      expect(await gate.check("zzz"), JSON.stringify(bad)).toBe("unknown");
      expect(probes).toBe(2); // not cached as missing
    }
  });

  it("treats a non-array list body as unknown", async () => {
    const f = vi.fn(async () => json({ message: "nope" }));
    const g = createSourceSlugGate({ getEnv: ENV, fetchImpl: f as unknown as typeof fetch });
    expect(await g.check("a")).toBe("unknown");
  });

  it("a probe answering true joins the set; false is negative-cached", async () => {
    const f = fakeFetch({ all: ["a"], confirm: { fresh: true } });
    const { gate } = mk(f);
    expect(await gate.check("fresh")).toBe("exists");
    expect(await gate.check("gone")).toBe("missing");
    const probes = () => f.mock.calls.filter(([u]) => String(u).includes("source_slug_exists")).length;
    expect(probes()).toBe(2);
    expect(await gate.check("fresh")).toBe("exists");
    expect(await gate.check("gone")).toBe("missing");
    expect(probes()).toBe(2);
  });
});

/**
 * A fetch fake whose backend health can be flipped mid-test, with counters for
 * the two RPCs. Modes: "ok" answers like fakeFetch; the rest are the three ways
 * a Supabase brownout shows up (HTTP 503, a thrown network error / timeout, and
 * a 200 whose body is not the expected shape).
 */
type Health = "ok" | "http503" | "reject" | "badBody";

function switchable(all: string[], confirm: Record<string, boolean> = {}) {
  let health: Health = "ok";
  const f = vi.fn(async (input: RequestInfo | URL) => {
    if (health === "reject") throw new Error("down");
    if (health === "http503") return json({ message: "unavailable" }, 503);
    if (health === "badBody") return json({ message: "nope" });
    const m = String(input).match(/rpc\/source_slug_exists\?p_slug=([^&]+)/);
    if (m) return json(confirm[decodeURIComponent(m[1]!)] === true);
    return json(all.map((slug) => ({ slug })));
  });
  return {
    f: f as unknown as ReturnType<typeof fakeFetch>,
    setHealth: (h: Health) => {
      health = h;
    },
    calls: () => f.mock.calls.length,
    loads: () => f.mock.calls.filter(([u]) => String(u).includes("rpc/source_slugs")).length,
    probes: () => f.mock.calls.filter(([u]) => String(u).includes("rpc/source_slug_exists")).length,
  };
}

describe("createSourceSlugGate — failure backoff (mirrors merged-cluster-gate)", () => {
  it.each(["http503", "reject", "badBody"] as const)(
    "(a) %s: 6 sequential checks make exactly 1 request; the retry opens at exactly 30 000 ms",
    async (health) => {
      const b = switchable(["a"]);
      b.setHealth(health);
      const { gate, advance } = mk(b.f);
      for (let i = 0; i < 6; i++) expect(await gate.check("a"), `check ${i}`).toBe("unknown");
      expect(b.calls()).toBe(1);
      advance(29_999);
      expect(await gate.check("a")).toBe("unknown");
      expect(b.calls()).toBe(1);
      advance(1);
      expect(await gate.check("a")).toBe("unknown");
      expect(b.calls()).toBe(2);
    },
  );

  it("(b) serves a stale set during the backoff with one refresh attempt, and never probes", async () => {
    const b = switchable(["known"]);
    const { gate, advance } = mk(b.f);
    expect(await gate.check("known")).toBe("exists");
    expect(b.loads()).toBe(1);

    advance(400_000); // past setTtlMs (300s), inside staleMaxMs (3600s)
    b.setHealth("http503");
    for (let i = 0; i < 5; i++) expect(await gate.check("known"), `check ${i}`).toBe("exists");
    expect(b.loads()).toBe(2); // exactly one refresh attempt

    // An absent slug would normally cost a per-slug probe; the backend is down, so it does not.
    expect(await gate.check("absent")).toBe("unknown");
    expect(b.probes()).toBe(0);
    expect(b.calls()).toBe(2);
  });

  it("(b) a negative-cached slug still answers missing during the backoff", async () => {
    const b = switchable(["known"]);
    // Negative entries outlive the set TTL here so one can be live while a refresh fails.
    const { gate, advance } = mk(b.f, { negativeTtlMs: 1_000_000 });
    expect(await gate.check("gone")).toBe("missing"); // list + probe, negative-cached
    expect(b.probes()).toBe(1);

    advance(400_000); // set stale, negative entry still live
    b.setHealth("reject");
    expect(await gate.check("gone")).toBe("missing"); // negative cache answers before the backoff check
    expect(b.loads()).toBe(2); // the refresh attempt that armed the backoff
    expect(await gate.check("other")).toBe("unknown"); // no live negative entry: no probe
    expect(b.probes()).toBe(1);
  });

  it("(b) stale verdict is evaluated against staleMaxMs during the backoff, not just at the failure", async () => {
    const b = switchable(["a"]);
    // Backoff longer than staleMaxMs so the stale window can expire inside it.
    const { gate, advance } = mk(b.f, { failureBackoffMs: 10_000_000 });
    expect(await gate.check("a")).toBe("exists");
    advance(400_000);
    b.setHealth("reject");
    expect(await gate.check("a")).toBe("exists"); // stale but usable; backoff armed
    advance(3_600_000);
    expect(await gate.check("a")).toBe("unknown"); // stale set too old; still no request
    expect(b.loads()).toBe(2);
  });

  it("(c) recovers after the window, reloads the set, and re-arms on a later failure", async () => {
    const b = switchable(["a"]);
    b.setHealth("http503");
    const { gate, advance } = mk(b.f);
    expect(await gate.check("a")).toBe("unknown");
    expect(b.loads()).toBe(1);

    advance(30_000);
    b.setHealth("ok");
    expect(await gate.check("a")).toBe("exists"); // set reloaded
    expect(b.loads()).toBe(2);
    // The successful load cleared the backoff, so the probe path works at once.
    expect(await gate.check("zzz")).toBe("missing");
    expect(b.probes()).toBe(1);

    advance(400_000);
    b.setHealth("http503");
    expect(await gate.check("a")).toBe("exists"); // stale, refresh failed, backoff armed again
    expect(b.loads()).toBe(3);
    for (let i = 0; i < 4; i++) expect(await gate.check("a")).toBe("exists");
    expect(await gate.check("other")).toBe("unknown");
    expect(b.loads()).toBe(3);
    expect(b.probes()).toBe(1);

    advance(30_000);
    expect(await gate.check("a")).toBe("exists");
    expect(b.loads()).toBe(4); // second window elapsed: one more attempt
  });

  it("(d) three parallel checks during a failing load share one request", async () => {
    let rejectLoad!: (e: Error) => void;
    const f = vi.fn(
      () =>
        new Promise<Response>((_, reject) => {
          // Only the first request is held open; any later one fails at once, so a
          // regression shows up as a request count rather than a hung test.
          if (f.mock.calls.length === 1) rejectLoad = reject;
          else reject(new Error("down"));
        }),
    );
    const { gate } = mk(f as unknown as ReturnType<typeof fakeFetch>);
    const pending = Promise.all([gate.check("a"), gate.check("b"), gate.check("c")]);
    expect(f).toHaveBeenCalledTimes(1);
    rejectLoad(new Error("down"));
    expect(await pending).toEqual(["unknown", "unknown", "unknown"]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(await gate.check("a")).toBe("unknown"); // and a late caller does not start a new load
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("(e) honours a custom failureBackoffMs, shorter and longer than the default", async () => {
    for (const ms of [5_000, 120_000]) {
      const b = switchable(["a"]);
      b.setHealth("reject");
      const { gate, advance } = mk(b.f, { failureBackoffMs: ms });
      expect(await gate.check("a")).toBe("unknown");
      advance(ms - 1);
      expect(await gate.check("a")).toBe("unknown");
      expect(b.calls(), `ms=${ms} before`).toBe(1);
      advance(1);
      expect(await gate.check("a")).toBe("unknown");
      expect(b.calls(), `ms=${ms} after`).toBe(2);
    }
  });

  it("a failed probe alone does not arm the backoff", async () => {
    const f = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("source_slug_exists")) throw new Error("probe timeout");
      return json([{ slug: "a" }]);
    });
    const { gate } = mk(f as unknown as ReturnType<typeof fakeFetch>);
    expect(await gate.check("x")).toBe("unknown");
    expect(await gate.check("y")).toBe("unknown");
    expect(await gate.check("x")).toBe("unknown");
    const probes = f.mock.calls.filter(([u]) => String(u).includes("source_slug_exists")).length;
    expect(probes).toBe(3); // every absent slug still gets its probe
    expect(await gate.check("a")).toBe("exists");
  });

  it("the backoff is per gate: one failing gate does not silence another", async () => {
    const down = switchable(["a"]);
    down.setHealth("reject");
    const up = switchable(["a"]);
    const g1 = mk(down.f).gate;
    const g2 = mk(up.f).gate;
    expect(await g1.check("a")).toBe("unknown");
    expect(await g2.check("a")).toBe("exists");
    expect(up.loads()).toBe(1);
  });
});

describe("SOURCE_SLUG_RE parity with isValidSourceSlug", () => {
  it("agrees on a sample list", () => {
    const sample = ["cnn-turk", "CNN", "-x", "a".repeat(64), "a".repeat(65), "a", "ç", "", "a b", "x_y", "0", "a-"];
    for (const s of sample) {
      expect(SOURCE_SLUG_RE.test(s), JSON.stringify(s)).toBe(isValidSourceSlug(s));
    }
  });
});
