import { describe, it, expect, vi } from "vitest";
import { isValidSourceSlug } from "@/lib/validation/source-input";
import { SOURCE_SLUG_RE, createSourceSlugGate } from "./source-slug-gate";

const URL_ = "https://proj.supabase.co";
const KEY = "anon-key";
const ENV = () => ({ url: URL_, anonKey: KEY });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** fetch fake: full list request has no `slug=eq.`; confirm request does. */
function fakeFetch(opts: { all?: string[]; confirm?: Record<string, boolean> }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    const m = u.match(/slug=eq\.([^&]+)/);
    if (m) {
      const slug = decodeURIComponent(m[1]);
      return json(opts.confirm?.[slug] ? [{ slug }] : []);
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

  it("sends the documented URLs and headers, encoding the slug", async () => {
    const f = fakeFetch({ all: [] });
    const { gate } = mk(f);
    await gate.check("cnn-turk");
    const [listUrl, listInit] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(listUrl).toBe(`${URL_}/rest/v1/sources?select=slug`);
    expect(listInit.headers).toMatchObject({
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Accept: "application/json",
    });
    expect(listInit.signal).toBeInstanceOf(AbortSignal);
    const [confirmUrl] = f.mock.calls[1] as unknown as [string];
    expect(confirmUrl).toBe(`${URL_}/rest/v1/sources?select=slug&slug=eq.cnn-turk&limit=1`);
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
