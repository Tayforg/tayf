import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoAlias,
  dayRange,
  fetchWithRetry,
  foldTr,
  isBreakerTripStatus,
  istanbulDate,
  KAP_BREAKER_BLOCK_MS,
  KAP_CLASSES,
  KAP_PAGE_CAP,
  KapFetchError,
  mapDisclosure,
  parseCompanies,
  parseKapDate,
} from "../../supabase/functions/_shared/kap.ts";

// Pure-helper contract for the kap-ingest Edge Function. The I/O layer
// (fetch + upsert) is thin and mirrors ingest/index.ts; what can silently
// rot is the KAP row mapping, the Turkish fold (which must match
// public.fold_tr in migration 049) and the RSC company-list parse.

describe("kap helpers", () => {
  it("parses KAP publishDate as Istanbul time", () => {
    expect(parseKapDate("11.09.2026 23:33:31")).toBe("2026-09-11T23:33:31+03:00");
    expect(() => parseKapDate("2026-09-11")).toThrow();
  });

  it("maps a list item to a kap_disclosures row", () => {
    const row = mapDisclosure({
      publishDate: "11.09.2026 20:45:05",
      kapTitle: "ORZAKS İLAÇ VE KİMYA SANAYİ TİCARET A.Ş.",
      disclosureClass: "ODA",
      disclosureType: "ODA",
      disclosureCategory: "ODA",
      summary: "Özbekistan hk.\n",
      subject: "Özel Durum Açıklaması (Genel)",
      relatedStocks: "ABH, ABM",
      year: null,
      ruleType: "-",
      period: null,
      disclosureIndex: 1662124,
      isLate: false,
      stockCodes: "ORZAK",
      attachmentCount: 0,
      modifyStatus: null,
    });
    expect(row.disclosure_index).toBe(1662124);
    expect(row.stock_codes).toEqual(["ORZAK"]);
    expect(row.related_stocks).toEqual(["ABH", "ABM"]);
    expect(row.summary).toBe("Özbekistan hk.");
    expect(row.raw.disclosureIndex).toBe(1662124);
  });

  it("lifts the paper code out of an exchange-filed summary", () => {
    const row = mapDisclosure({
      publishDate: "14.09.2026 15:57:00",
      kapTitle: "BORSA İSTANBUL BISTECH DEVRE KESİCİ UYGULAMASI",
      disclosureClass: "DKB",
      disclosureType: "DUY",
      disclosureCategory: null,
      summary: "BETAE.E işlem sırasında Pay Bazında Devre Kesici Uygulaması devreye girmiştir",
      subject: "Pay Bazında Devre Kesici Bildirimi",
      relatedStocks: null,
      year: null,
      ruleType: "-",
      period: null,
      disclosureIndex: 1662400,
      isLate: false,
      stockCodes: null,
      attachmentCount: 0,
      modifyStatus: null,
    });
    expect(row.stock_codes).toEqual(["BETAE"]);
  });

  it("folds Turkish like public.fold_tr", () => {
    expect(foldTr("Türk Hava Yolları'nın")).toBe("turk hava yollari nin");
    expect(foldTr("ŞİŞECAM, Iğdır & İstanbul")).toBe("sisecam igdir istanbul");
  });

  it("derives one safe auto alias or none", () => {
    expect(autoAlias("VESTEL ELEKTRONİK SANAYİ VE TİCARET A.Ş.")).toBe("vestel");
    expect(autoAlias("AKBANK T.A.Ş.")).toBe("akbank");
    expect(autoAlias("TÜRKİYE İŞ BANKASI A.Ş.")).toBeNull();
    expect(autoAlias("AK YATIRIM MENKUL DEĞERLER A.Ş.")).toBeNull();
  });

  it("parses the escaped RSC company payload, merging duplicates", () => {
    const html = String.raw`x[{\"kapMemberOid\":\"OID1\",\"kapMemberType\":\"IGS\",\"kapMemberState\":\"A\",\"payIslemDurumu\":\"1\",\"mkkMemberOid\":\"M1\",\"kapMemberTitle\":\"VESTEL ELEKTRONİK SANAYİ VE TİCARET A.Ş.\",\"stockCode\":\"VESTL\",\"cityName\":\"MANİSA\"},{\"kapMemberOid\":\"OID2\",\"kapMemberState\":\"P\",\"payIslemDurumu\":\"0\",\"kapMemberTitle\":\"X A.Ş.\",\"stockCode\":\"XA, XB\"},{\"kapMemberOid\":\"OID3\",\"kapMemberTitle\":\"NO CODE A.Ş.\",\"stockCode\":null}]`;
    const rows = parseCompanies(html);
    expect(rows.map((r) => r.kap_member_oid)).toEqual(["OID1", "OID2"]);
    expect(rows[0]).toMatchObject({ tickers: ["VESTL"], shares_traded: true, city: "MANİSA" });
    expect(rows[1]).toMatchObject({ tickers: ["XA", "XB"], shares_traded: false });
  });

  it("walks day ranges and Istanbul dates", () => {
    expect(dayRange("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    // 22:30 UTC is already the next day in Istanbul.
    expect(istanbulDate(0, Date.parse("2026-09-12T22:30:00Z"))).toBe("2026-09-13");
    expect(istanbulDate(-1, Date.parse("2026-09-12T22:30:00Z"))).toBe("2026-09-12");
  });

  // SEC-07 follow-up: the single definition of "which statuses trip the
  // persisted breaker" (migration 059) -- only a definitive 403 or 429,
  // never a 5xx or anything else fetchWithRetry might return.
  it("trips the breaker only on 403 or 429, never on 5xx or 2xx", () => {
    expect(isBreakerTripStatus(403)).toBe(true);
    expect(isBreakerTripStatus(429)).toBe(true);
    expect(isBreakerTripStatus(500)).toBe(false);
    expect(isBreakerTripStatus(502)).toBe(false);
    expect(isBreakerTripStatus(503)).toBe(false);
    expect(isBreakerTripStatus(200)).toBe(false);
    expect(isBreakerTripStatus(404)).toBe(false);
  });

  it("blocks for 6 hours", () => {
    expect(KAP_BREAKER_BLOCK_MS).toBe(6 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// fetchWithRetry (SEC-07) — pure, no Deno polyfill needed.
// ---------------------------------------------------------------------------

describe("fetchWithRetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries a 429 honouring Retry-After, then succeeds", async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return new Response("rate limited", {
            status: 429,
            headers: { "Retry-After": "2" },
          });
        }
        return new Response("ok", { status: 200 });
      }),
    );

    const res = await fetchWithRetry("https://example.test/x", {}, { sleep });

    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(delays[0]).toBe(2000);
  });

  it("stops immediately on 403 without retrying", async () => {
    const sleep = vi.fn(async () => {});
    const fetchMock = vi.fn(async () => new Response("forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://example.test/x", {}, { sleep });

    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  // SEC-07 regression: a single AbortSignal.timeout() built once outside
  // the retry loop starts counting at construction, so the backoff sleep
  // burns the signal's own budget and the retried fetch can abort before it
  // even runs. Both existing tests above pass `{}` as init (no signal), so
  // the signal path was entirely untested until now.
  it("does not abort a real caller signal across two retries when timeoutMs is set", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const seenSignals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls++;
        seenSignals.push(init.signal ?? undefined);
        expect(init.signal?.aborted).toBe(false);
        if (calls < 3) {
          return new Response("rate limited", { status: 429, headers: { "Retry-After": "1" } });
        }
        return new Response("ok", { status: 200 });
      }),
    );

    // A real, never-firing caller signal (AbortController, not
    // AbortSignal.timeout — its own deadline must not matter here) plus a
    // short per-attempt timeoutMs, across two retries.
    const controller = new AbortController();
    const res = await fetchWithRetry(
      "https://example.test/x",
      { signal: controller.signal },
      { sleep, retries: 2, timeoutMs: 5000 },
    );

    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    // Every attempt got its OWN fresh signal (merged with the caller's),
    // not the exact same object reused across attempts.
    expect(new Set(seenSignals).size).toBe(3);
    for (const s of seenSignals) expect(s?.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// kap-ingest runCycle contract tests.
//
// The Edge Function is authored against Deno (Deno.serve, `npm:` module
// specifiers via _shared/supabase.ts); vitest runs in Node. Following the
// convention in tests/functions/cluster-consumer.test.ts / ingest.test.ts:
// polyfill the minimum Deno surface before dynamically importing the SUT,
// mock the Supabase factory with the shared proxy fake, and stub `fetch`
// per test to control KAP's response per day/class.
// ---------------------------------------------------------------------------

(globalThis as unknown as { Deno?: unknown }).Deno = {
  env: { get: (k: string) => process.env[k] },
  serve: (handler: (req: Request) => Promise<Response> | Response) => {
    (globalThis as unknown as { __kapIngestHandler?: unknown }).__kapIngestHandler = handler;
    return { finished: Promise.resolve() };
  },
};

// SEC-07 follow-up: kap_fetch_state (migration 059) is a live, mutable
// single-row fixture -- not a fixed array -- so tests can set
// `kapSupabaseFake.kapFetchState.blocked_until` etc. before calling
// runCycle and read back the `.update()` calls index.ts's readBreaker /
// tripBreaker / clearBreakerError issue against it.
//
// `kapFetchStateMissing` simulates the seeded row (migration 059) being
// absent: the fixture then reports zero matched rows (`data: [], count:
// 0`), the same shape a `.eq("id", 1)`-matching-nothing PostgREST update
// returns, so tripBreaker/clearBreakerError's zero-row-match warn path
// (E-08) is exercised for real instead of assumed.
const kapSupabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  const kapFetchState: {
    blocked_until: string | null;
    last_status: number | null;
    last_error: string | null;
  } = { blocked_until: null, last_status: null, last_error: null };
  const missing = { value: false };
  const fake = helper.createSupabaseFake({
    tables: {
      kap_fetch_state: () =>
        missing.value
          ? { data: [], error: null, count: 0 }
          : { data: [{ id: 1, ...kapFetchState }], error: null, count: 1 },
    },
  });
  // h30-alerts-5: the shared fake cannot fail a write (an upsert().select()
  // resolves from the patch, a table fixture only answers reads), so the two
  // Tayf-side faults the upstream classification must tell apart from a KAP
  // outage are injected by wrapping `from`:
  //   disclosuresUpsertError  -> every kap_disclosures write answers { error }
  //   breakerWriteThrows      -> kap_fetch_state .update() REJECTS (a client
  //                              that throws instead of returning { error })
  const faults = { disclosuresUpsertError: false, breakerWriteThrows: false };
  const settling = (settle: () => Promise<unknown>) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["upsert", "select", "update", "eq"]) chain[m] = () => chain;
    chain.then = (
      onFul?: (v: unknown) => unknown,
      onRej?: (e: unknown) => unknown,
    ) => settle().then(onFul, onRej);
    return chain;
  };
  const client = {
    ...fake.client,
    from: (table: string) => {
      if (table === "kap_disclosures" && faults.disclosuresUpsertError) {
        return settling(async () => ({ data: null, error: { message: "disclosures write failed" } }));
      }
      if (table === "kap_fetch_state" && faults.breakerWriteThrows) {
        const real = fake.client.from(table) as Record<string, unknown>;
        return new Proxy(real, {
          get: (target, prop: string) =>
            prop === "update"
              ? () =>
                  settling(async () => {
                    throw new Error("kap_fetch_state write blew up");
                  })
              : target[prop],
        });
      }
      return fake.client.from(table);
    },
  };
  return { ...fake, client, faults, kapFetchState, kapFetchStateMissing: missing };
});

const kapSentryCalls = vi.hoisted(() => ({
  captured: [] as Array<{ fn: string; err: unknown }>,
}));

vi.mock("../../supabase/functions/_shared/supabase.ts", () => ({
  createServiceClient: () => kapSupabaseFake.client,
}));

vi.mock("../../supabase/functions/_shared/sentry.ts", () => ({
  initSentry: async () => {},
  captureException: (fn: string, err: unknown) => {
    kapSentryCalls.captured.push({ fn, err });
  },
  withSentry:
    (_fn: string, handler: (req: Request) => Promise<Response> | Response) => handler,
}));

const TEST_SERVICE_ROLE_KEY = "test-service-role-key";

function authedRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${TEST_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

/** A valid KapListItem, overridable per test. */
function kapItem(disclosureIndex: number, overrides: Record<string, unknown> = {}) {
  return {
    publishDate: "11.09.2026 10:00:00",
    kapTitle: "TEST A.Ş.",
    disclosureClass: "ODA",
    disclosureType: "ODA",
    disclosureCategory: "ODA",
    summary: "s",
    subject: "s",
    relatedStocks: null,
    year: null,
    ruleType: "-",
    period: null,
    disclosureIndex,
    isLate: false,
    stockCodes: "THYAO",
    attachmentCount: 0,
    modifyStatus: null,
    ...overrides,
  };
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response> | Response;
let fetchImpl: FetchImpl = async () => new Response("[]", { status: 200 });
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];

describe("kap-ingest runCycle", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    fetchImpl = async () => new Response("[]", { status: 200 });
    kapSupabaseFake.calls.mutations.length = 0;
    kapSupabaseFake.calls.rpc.length = 0;
    kapSupabaseFake.kapFetchState.blocked_until = null;
    kapSupabaseFake.kapFetchState.last_status = null;
    kapSupabaseFake.kapFetchState.last_error = null;
    kapSupabaseFake.kapFetchStateMissing.value = false;
    kapSentryCalls.captured.length = 0;
    process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_SERVICE_ROLE_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init });
        return fetchImpl(url, init);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("continues to the next day when a day's fetch throws, recording the failure (TS-04)", async () => {
    const day1 = "2026-09-10";
    const day2 = "2026-09-11";
    fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body as string) as { fromDate: string };
      if (body.fromDate === day1) throw new TypeError("network down");
      return new Response(JSON.stringify([kapItem(7)]), { status: 200 });
    };

    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    const stats = await runCycle({ from: day1, to: day2 });

    expect(stats.days).toBe(1);
    expect(stats.upserted).toBe(1);
    expect(stats.errors.some((e) => e.startsWith(`${day1}:`))).toBe(true);
  });

  it("counts exactly one skip for a malformed publishDate and still ingests the rest", async () => {
    const day = "2026-09-12";
    fetchImpl = async () =>
      new Response(
        JSON.stringify([
          kapItem(101),
          { ...kapItem(102), publishDate: "not-a-date" },
          kapItem(103),
        ]),
        { status: 200 },
      );

    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    const stats = await runCycle({ from: day, to: day });

    expect(stats.fetched).toBe(3);
    expect(stats.skipped).toBe(1);
    expect(stats.upserted).toBe(2);
  });

  it("preserves capped-day rows whose disclosureClass is null or outside KAP_CLASSES (TS-05)", async () => {
    const day = "2026-09-13";
    const bulk = Array.from({ length: KAP_PAGE_CAP }, (_, i) =>
      kapItem(i + 1, { disclosureClass: KAP_CLASSES[i % KAP_CLASSES.length] }),
    );
    // Two stragglers a real per-class KAP query can never return: no class
    // at all, and a class outside the four KAP_CLASSES enumerates.
    const nullClassItem = kapItem(90001, { disclosureClass: null });
    const otherClassItem = kapItem(90002, { disclosureClass: "XYZ" });
    const all = [...bulk, nullClassItem, otherClassItem];
    expect(all.length).toBeGreaterThanOrEqual(KAP_PAGE_CAP);

    fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body as string) as { disclosureClass: string };
      if (body.disclosureClass === "") {
        return new Response(JSON.stringify(all), { status: 200 });
      }
      const subset = bulk.filter((r) => r.disclosureClass === body.disclosureClass);
      return new Response(JSON.stringify(subset), { status: 200 });
    };

    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    const stats = await runCycle({ from: day, to: day });

    expect(stats.fetched).toBe(all.length);
    const upsertedIndexes = new Set(
      kapSupabaseFake.calls
        .upsert("kap_disclosures")
        .flatMap((c) => c.patch as Array<{ disclosure_index: number }>)
        .map((r) => r.disclosure_index),
    );
    expect(upsertedIndexes.has(90001)).toBe(true);
    expect(upsertedIndexes.has(90002)).toBe(true);
  });

  it("sends an honest, contactable User-Agent", async () => {
    const day = "2026-09-14";
    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    await runCycle({ from: day, to: day });

    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const call of fetchCalls) {
      const headers = call.init.headers as Record<string, string>;
      // SEC-06/TS-03: reuses the identity the repo already publishes and
      // that already resolves (tayf.app), not the fabricated
      // tayfhaber.com/bot URL (src/app/ ships no `bot` route, so that
      // identity 404s).
      expect(headers["User-Agent"]).toContain("+https://tayf.app");
      expect(headers["User-Agent"]).not.toContain("tayfhaber.com");
      expect(headers["User-Agent"]).not.toContain("Windows NT");
      expect(headers["User-Agent"]).not.toContain("Chrome");
    }
  });

  // TSF-01: every day-level throw inside ingestRange was silently swallowed
  // into stats.errors with nothing after the loop inspecting it, so a total
  // outage on every attempted day still returned a healthy HTTP 200 -- less
  // observable than before this diff, inverting SEC-05's intent.
  //
  // h30-alerts-5: that guard now answers 502 only for a TAYF-side total
  // failure. Here KAP answers fine on every day but the state-table write that
  // follows the first good fetch throws, so no day completes. (A KAP 5xx /
  // network / timeout on every day is the upstream-outage describe below.)
  it("returns ok:false, HTTP 502, and captures exactly once when every day fails on a Tayf-side error", async () => {
    const day1 = "2026-09-10";
    const day2 = "2026-09-11";
    fetchImpl = async () => new Response("[]", { status: 200 });
    kapSupabaseFake.faults.breakerWriteThrows = true;

    try {
      await import("../../supabase/functions/kap-ingest/index.ts");
      const handler = (globalThis as unknown as {
        __kapIngestHandler?: (req: Request) => Promise<Response>;
      }).__kapIngestHandler;
      expect(handler).toBeTypeOf("function");

      const res = await handler!(authedRequest("http://localhost/kap-ingest", { from: day1, to: day2 }));
      const body = (await res.json()) as {
        ok: boolean;
        days: number;
        upstream_unavailable?: boolean;
        upstreamErrors: number;
        tayfErrors: number;
      };

      expect(res.status).toBe(502);
      expect(body.ok).toBe(false);
      expect(body.days).toBe(0);
      expect(body.upstream_unavailable).not.toBe(true);
      expect(body.upstreamErrors).toBe(0);
      expect(body.tayfErrors).toBe(2);
      expect(kapSentryCalls.captured).toHaveLength(1);
      expect(kapSentryCalls.captured[0]?.fn).toBe("kap-ingest");
    } finally {
      kapSupabaseFake.faults.breakerWriteThrows = false;
    }
  });
});

// ---------------------------------------------------------------------------
// SEC-07 follow-up: the persisted kap_fetch_state circuit breaker (migration
// 059). readBreaker gates the whole cycle before any KAP request; tripBreaker
// only fires when fetchWithRetry's ladder exhausts on a final 403/429;
// clearBreakerError fires once per cycle after the first successful fetch.
// ---------------------------------------------------------------------------

describe("kap-ingest circuit breaker (SEC-07 follow-up)", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    fetchImpl = async () => new Response("[]", { status: 200 });
    kapSupabaseFake.calls.mutations.length = 0;
    kapSupabaseFake.calls.rpc.length = 0;
    kapSupabaseFake.kapFetchState.blocked_until = null;
    kapSupabaseFake.kapFetchState.last_status = null;
    kapSupabaseFake.kapFetchState.last_error = null;
    kapSupabaseFake.kapFetchStateMissing.value = false;
    kapSentryCalls.captured.length = 0;
    process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_SERVICE_ROLE_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init });
        return fetchImpl(url, init);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns {skipped:true, reason:'kap_blocked'} without fetching while blocked_until is in the future", async () => {
    kapSupabaseFake.kapFetchState.blocked_until = new Date(Date.now() + 3_600_000).toISOString();
    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    const result = await runCycle({ from: "2026-09-15", to: "2026-09-15" });

    expect(result).toEqual({ skipped: true, reason: "kap_blocked" });
    expect(fetchCalls.length).toBe(0);
  });

  it("does not block when blocked_until is in the past", async () => {
    kapSupabaseFake.kapFetchState.blocked_until = new Date(Date.now() - 3_600_000).toISOString();
    const day = "2026-09-15";
    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    const result = await runCycle({ from: day, to: day });

    expect(result).not.toEqual({ skipped: true, reason: "kap_blocked" });
    expect(fetchCalls.length).toBeGreaterThan(0);
  });

  it("the Deno.serve handler returns HTTP 200 with the skip payload while blocked", async () => {
    kapSupabaseFake.kapFetchState.blocked_until = new Date(Date.now() + 3_600_000).toISOString();
    await import("../../supabase/functions/kap-ingest/index.ts");
    const handler = (globalThis as unknown as {
      __kapIngestHandler?: (req: Request) => Promise<Response>;
    }).__kapIngestHandler;

    const res = await handler!(authedRequest("http://localhost/kap-ingest", {}));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ skipped: true, reason: "kap_blocked" });
    expect(fetchCalls.length).toBe(0);
  });

  it("trips the breaker (blocked_until ~6h out, last_status 403) when the retry ladder exhausts on a final 403", async () => {
    const day = "2026-09-16";
    fetchImpl = async () => new Response("forbidden", { status: 403 });
    const before = Date.now();

    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    await runCycle({ from: day, to: day });

    const update = kapSupabaseFake.calls.update("kap_fetch_state").at(-1);
    expect(update).toBeDefined();
    const patch = update!.patch as { blocked_until: string; last_status: number; last_error: string };
    expect(patch.last_status).toBe(403);
    expect(typeof patch.last_error).toBe("string");
    const blockedAt = Date.parse(patch.blocked_until);
    expect(blockedAt).toBeGreaterThanOrEqual(before + KAP_BREAKER_BLOCK_MS - 2000);
    expect(blockedAt).toBeLessThanOrEqual(Date.now() + KAP_BREAKER_BLOCK_MS + 2000);
  });

  it("trips the breaker (last_status 429) when the retry ladder exhausts on a final 429", async () => {
    const day = "2026-09-17";
    fetchImpl = async () => new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });

    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    await runCycle({ from: day, to: day });

    const update = kapSupabaseFake.calls.update("kap_fetch_state").at(-1);
    expect(update?.patch).toMatchObject({ last_status: 429 });
  });

  // h30-alerts-5: a KAP 5xx / network error is recorded for the admin badge
  // (last_status / last_error, one write per cycle) but never blocks: no
  // update may carry blocked_until, so the next tick still polls KAP.
  const breakerBlocks = () =>
    kapSupabaseFake.calls
      .update("kap_fetch_state")
      .filter((u) => "blocked_until" in (u.patch as Record<string, unknown>));

  it("does not trip the breaker on a 5xx (single attempt, e.g. 502)", async () => {
    const day = "2026-09-18";
    fetchImpl = async () => new Response("bad gateway", { status: 502 });

    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    await runCycle({ from: day, to: day });

    expect(breakerBlocks()).toHaveLength(0);
    expect(kapSupabaseFake.calls.update("kap_fetch_state")).toHaveLength(1);
  });

  it("does not trip the breaker when the retry ladder exhausts on 503 (5xx, not 403/429)", async () => {
    const day = "2026-09-19";
    fetchImpl = async () => new Response("unavailable", { status: 503, headers: { "Retry-After": "0" } });

    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    await runCycle({ from: day, to: day });

    expect(breakerBlocks()).toHaveLength(0);
    expect(kapSupabaseFake.calls.update("kap_fetch_state")).toHaveLength(1);
  });

  it("does not trip the breaker on a thrown network error", async () => {
    const day = "2026-09-20";
    fetchImpl = async () => {
      throw new TypeError("network down");
    };

    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    await runCycle({ from: day, to: day });

    expect(breakerBlocks()).toHaveLength(0);
    expect(kapSupabaseFake.calls.update("kap_fetch_state")).toHaveLength(1);
  });

  it("clears last_error and sets last_status 200 after a successful fetch", async () => {
    kapSupabaseFake.kapFetchState.last_error = "[kap-ingest] KAP 403 for 2026-09-15/*";
    kapSupabaseFake.kapFetchState.last_status = 403;
    const day = "2026-09-21";
    fetchImpl = async () => new Response(JSON.stringify([kapItem(500)]), { status: 200 });

    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    await runCycle({ from: day, to: day });

    const update = kapSupabaseFake.calls.update("kap_fetch_state").at(-1);
    expect(update?.patch).toMatchObject({ last_error: null, last_status: 200 });
  });

  it("clears the breaker error at most once per cycle even across multiple successful days", async () => {
    fetchImpl = async () => new Response(JSON.stringify([kapItem(600)]), { status: 200 });
    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    await runCycle({ from: "2026-09-10", to: "2026-09-12" });

    expect(kapSupabaseFake.calls.update("kap_fetch_state").length).toBe(1);
  });

  // E-08: a `.eq("id", 1)` update matching zero rows is a silent
  // `{ error: null }` no-op in PostgREST — if the seeded row (migration
  // 059) is ever missing, the old code reported success while persisting
  // nothing. tripBreaker/clearBreakerError now request an exact row count
  // and warn once the write matches zero rows.
  it("warns once when tripBreaker's write matches zero rows (kap_fetch_state row missing)", async () => {
    kapSupabaseFake.kapFetchStateMissing.value = true;
    const day = "2026-09-22";
    fetchImpl = async () => new Response("forbidden", { status: 403 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    await runCycle({ from: day, to: day });

    expect(warnSpy).toHaveBeenCalledWith(
      "[kap-ingest] kap_fetch_state row 1 missing — breaker write did not persist",
    );
    warnSpy.mockRestore();
  });

  it("warns once when clearBreakerError's write matches zero rows (kap_fetch_state row missing)", async () => {
    kapSupabaseFake.kapFetchStateMissing.value = true;
    const day = "2026-09-23";
    fetchImpl = async () => new Response(JSON.stringify([kapItem(700)]), { status: 200 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    await runCycle({ from: day, to: day });

    expect(warnSpy).toHaveBeenCalledWith(
      "[kap-ingest] kap_fetch_state row 1 missing — breaker write did not persist",
    );
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// h30-alerts-5: an upstream KAP outage is not an edge 5xx.
//
// ops_health_report row 2 (edge_http_errors_30m) counts every pg_net response
// with status >= 500. While kap.org.tr was down, kap-drain (*/2) answered 502
// every 2 minutes and pinned that row at FAIL, so a real Edge fault added no
// signal. The handler now answers 200 {ok:false, upstream_unavailable:true}
// when EVERY failure in the cycle was KAP's (a final 5xx, a network error, a
// timeout, an unusable body); a Tayf-side failure, a mixed cycle or a breaker
// trip still answers 502.
// ---------------------------------------------------------------------------

describe("kap-ingest upstream outage classification (h30-alerts-5)", () => {
  interface CycleBody {
    ok: boolean;
    days: number;
    errors: string[];
    upstreamErrors: number;
    tayfErrors: number;
    upstream_unavailable?: boolean;
    failedDays: string[];
    partial?: boolean;
  }

  const DAY1 = "2026-09-10";
  const DAY2 = "2026-09-11";
  const DAY3 = "2026-09-12";
  const RANGE = { from: DAY1, to: DAY2 };

  const resetState = () => {
    fetchCalls.length = 0;
    fetchImpl = async () => new Response("[]", { status: 200 });
    kapSupabaseFake.calls.mutations.length = 0;
    kapSupabaseFake.calls.rpc.length = 0;
    kapSupabaseFake.kapFetchState.blocked_until = null;
    kapSupabaseFake.kapFetchState.last_status = null;
    kapSupabaseFake.kapFetchState.last_error = null;
    kapSupabaseFake.kapFetchStateMissing.value = false;
    kapSupabaseFake.faults.disclosuresUpsertError = false;
    kapSupabaseFake.faults.breakerWriteThrows = false;
    kapSentryCalls.captured.length = 0;
  };

  beforeEach(() => {
    resetState();
    process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_SERVICE_ROLE_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init });
        return fetchImpl(url, init);
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetState();
  });

  async function post(body: unknown): Promise<{ res: Response; json: CycleBody }> {
    await import("../../supabase/functions/kap-ingest/index.ts");
    const handler = (globalThis as unknown as {
      __kapIngestHandler?: (req: Request) => Promise<Response>;
    }).__kapIngestHandler;
    expect(handler).toBeTypeOf("function");
    const res = await handler!(authedRequest("http://localhost/kap-ingest", body));
    return { res, json: (await res.json()) as CycleBody };
  }

  const dayOf = (init: RequestInit): string => (JSON.parse(init.body as string) as { fromDate: string }).fromDate;
  const stateUpdates = () => kapSupabaseFake.calls.update("kap_fetch_state");
  const patchOf = (i: number) => stateUpdates()[i]?.patch as Record<string, unknown>;
  const blockedWrites = () => stateUpdates().filter((u) => "blocked_until" in (u.patch as Record<string, unknown>));

  describe("classifiers", () => {
    it("KapUpstreamError is an Error that carries the HTTP status (0 = no HTTP answer)", async () => {
      const { KapUpstreamError } = await import("../../supabase/functions/kap-ingest/index.ts");
      const err = new KapUpstreamError(0, "[kap-ingest] KAP unreachable for 2026-09-10/*: TypeError");
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("KapUpstreamError");
      expect(err.status).toBe(0);
      expect(err.message).toContain("unreachable");
      expect(new KapUpstreamError(200, "bad body").status).toBe(200);
    });

    it("isUpstreamUnavailable: KapUpstreamError and KapFetchError >= 500 are upstream, nothing else is", async () => {
      const { isUpstreamUnavailable, KapUpstreamError } = await import(
        "../../supabase/functions/kap-ingest/index.ts"
      );
      expect(isUpstreamUnavailable(new KapUpstreamError(0, "x"))).toBe(true);
      expect(isUpstreamUnavailable(new KapUpstreamError(200, "bad body"))).toBe(true);
      for (const status of [500, 502, 503, 504, 599]) {
        expect(isUpstreamUnavailable(new KapFetchError(status, "x")), String(status)).toBe(true);
      }
      for (const status of [400, 401, 403, 404, 429, 499]) {
        expect(isUpstreamUnavailable(new KapFetchError(status, "x")), String(status)).toBe(false);
      }
      for (const other of [new Error("x"), new TypeError("x"), "boom", null, undefined, 502, { status: 502 }]) {
        expect(isUpstreamUnavailable(other), String(other)).toBe(false);
      }
    });
  });

  describe("answers 200 {ok:false, upstream_unavailable:true} when every failure was KAP's", () => {
    it.each([500, 502, 503, 504])("a final KAP %i on every day", async (status) => {
      fetchImpl = async () => new Response("down", { status, headers: { "Retry-After": "0" } });

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(200);
      expect(json.ok).toBe(false);
      expect(json.upstream_unavailable).toBe(true);
      expect(json.days).toBe(0);
      expect(json.errors).toHaveLength(2);
      expect(json.errors[0]).toContain(`${DAY1}:`);
      expect(json.errors[0]).toContain(`KAP ${status}`);
      expect(json.errors[1]).toContain(`${DAY2}:`);
      expect(json.upstreamErrors).toBe(2);
      expect(json.tayfErrors).toBe(0);
    });

    it("a thrown network error (TypeError) on every day", async () => {
      fetchImpl = async () => {
        throw new TypeError("fetch failed");
      };

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(200);
      expect(json).toMatchObject({ ok: false, upstream_unavailable: true, days: 0 });
      expect(json.errors).toHaveLength(2);
      expect(json.errors[0]).toContain("KAP unreachable");
      expect(json.errors[0]).toContain("TypeError");
    });

    it("a timeout (DOMException TimeoutError) on every day", async () => {
      fetchImpl = async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      };

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(200);
      expect(json).toMatchObject({ ok: false, upstream_unavailable: true, upstreamErrors: 2, tayfErrors: 0 });
      expect(json.errors[0]).toContain("TimeoutError");
    });

    it("a KAP 200 whose body is not JSON", async () => {
      fetchImpl = async () => new Response("<html><body>Bakim calismasi</body></html>", { status: 200 });

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(200);
      expect(json).toMatchObject({ ok: false, upstream_unavailable: true, days: 0, upstreamErrors: 2, tayfErrors: 0 });
      expect(json.errors[0]).toContain("bad body");
    });

    it("a KAP 200 whose JSON is not a list of disclosures", async () => {
      fetchImpl = async () => new Response(JSON.stringify({ error: "maintenance" }), { status: 200 });

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(200);
      expect(json).toMatchObject({ ok: false, upstream_unavailable: true, upstreamErrors: 2, tayfErrors: 0 });
    });

    it("a mix of upstream kinds across days (5xx, then a network error)", async () => {
      fetchImpl = async (_url, init) => {
        if (dayOf(init) === DAY1) return new Response("bad gateway", { status: 502 });
        throw new TypeError("fetch failed");
      };

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(200);
      expect(json).toMatchObject({ ok: false, upstream_unavailable: true, upstreamErrors: 2, tayfErrors: 0 });
    });

    it("a deadline that cuts the loop short does not turn an upstream outage into a 502", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-12T10:00:00Z"));
      fetchImpl = async () => {
        vi.setSystemTime(Date.now() + 60_000);
        return new Response("bad gateway", { status: 502 });
      };

      const { res, json } = await post({ from: DAY1, to: DAY3 });

      expect(json.errors.some((e) => e.startsWith(`deadline before ${DAY2}`))).toBe(true);
      expect(json.upstreamErrors).toBe(1);
      expect(json.tayfErrors).toBe(0);
      expect(res.status).toBe(200);
      expect(json.upstream_unavailable).toBe(true);
    });

    it("still reports the failed cycle to Sentry once (only the HTTP status changes)", async () => {
      fetchImpl = async () => new Response("bad gateway", { status: 502 });

      await post(RANGE);

      expect(kapSentryCalls.captured).toHaveLength(1);
      expect(kapSentryCalls.captured[0]?.fn).toBe("kap-ingest");
    });
  });

  describe("keeps 502 for anything that is not purely KAP's", () => {
    it("KAP is fine but the disclosures upsert errors on every day: days > 0 keeps ok true and 200 (today's behaviour)", async () => {
      kapSupabaseFake.faults.disclosuresUpsertError = true;
      fetchImpl = async () => new Response(JSON.stringify([kapItem(1)]), { status: 200 });

      const { res, json } = await post(RANGE);

      expect(json.days).toBe(2);
      expect(json.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(json.upstream_unavailable).not.toBe(true);
      expect(json.tayfErrors).toBe(2);
      expect(json.errors.filter((e) => e.includes("upsert"))).toHaveLength(2);
      expect(kapSentryCalls.captured).toHaveLength(0);
    });

    it("every day fails with a non-upstream throw (the state-table client throws)", async () => {
      kapSupabaseFake.faults.breakerWriteThrows = true;

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(502);
      expect(json).toMatchObject({ ok: false, days: 0, upstreamErrors: 0, tayfErrors: 2 });
      expect(json.upstream_unavailable).not.toBe(true);
      expect(kapSentryCalls.captured).toHaveLength(1);
    });

    it("a KAP 404 on every day is a Tayf-side problem (the endpoint moved), not an outage", async () => {
      fetchImpl = async () => new Response("not found", { status: 404 });

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(502);
      expect(json).toMatchObject({ ok: false, upstreamErrors: 0, tayfErrors: 2 });
      expect(json.upstream_unavailable).not.toBe(true);
      expect(stateUpdates()).toHaveLength(0);
    });

    it("mixed: one day a KAP 5xx, the next a Tayf-side error, no day completed", async () => {
      kapSupabaseFake.faults.breakerWriteThrows = true;
      fetchImpl = async (_url, init) =>
        dayOf(init) === DAY1 ? new Response("bad gateway", { status: 502 }) : new Response("[]", { status: 200 });

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(502);
      expect(json).toMatchObject({ ok: false, days: 0, upstreamErrors: 1, tayfErrors: 1 });
      expect(json.upstream_unavailable).not.toBe(true);
      expect(kapSentryCalls.captured).toHaveLength(1);
    });

    it("mixed: a KAP 5xx and a KAP 404 write nothing to kap_fetch_state", async () => {
      fetchImpl = async (_url, init) =>
        dayOf(init) === DAY1
          ? new Response("bad gateway", { status: 502 })
          : new Response("not found", { status: 404 });

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(502);
      expect(json).toMatchObject({ upstreamErrors: 1, tayfErrors: 1 });
      expect(json.upstream_unavailable).not.toBe(true);
      expect(stateUpdates()).toHaveLength(0);
    });

    it.each([403, 429])("a final %i that trips the breaker still answers 502 and writes the breaker row as today", async (status) => {
      fetchImpl = async () => new Response("stop", { status, headers: { "Retry-After": "0" } });
      const before = Date.now();

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(502);
      expect(json.ok).toBe(false);
      expect(json.upstream_unavailable).not.toBe(true);
      // the trip stops the cycle: day 2 is never attempted
      expect(json.errors).toHaveLength(1);
      expect(stateUpdates()).toHaveLength(1);
      const patch = patchOf(0) as { blocked_until: string; last_status: number; last_error: string };
      expect(patch.last_status).toBe(status);
      expect(Date.parse(patch.blocked_until)).toBeGreaterThanOrEqual(before + KAP_BREAKER_BLOCK_MS - 2000);
    });

    it("a KAP 5xx day followed by a breaker trip is a 502 with exactly one (breaker) write", async () => {
      fetchImpl = async (_url, init) =>
        dayOf(init) === DAY1 ? new Response("bad gateway", { status: 502 }) : new Response("forbidden", { status: 403 });

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(502);
      expect(json.upstream_unavailable).not.toBe(true);
      expect(stateUpdates()).toHaveLength(1);
      expect(blockedWrites()).toHaveLength(1);
      expect(patchOf(0)).toMatchObject({ last_status: 403 });
    });
  });

  describe("an upstream_unavailable cycle writes kap_fetch_state id 1 once", () => {
    it("last_status is the final 5xx, last_error the first upstream message, updated_at set, blocked_until untouched", async () => {
      fetchImpl = async () => new Response("unavailable", { status: 503, headers: { "Retry-After": "0" } });

      const { res } = await post({ from: DAY1, to: DAY3 });

      expect(res.status).toBe(200);
      expect(stateUpdates()).toHaveLength(1);
      const patch = patchOf(0);
      expect(Object.keys(patch).sort()).toEqual(["last_error", "last_status", "updated_at"]);
      expect(patch.last_status).toBe(503);
      expect(patch.last_error).toBe(`[kap-ingest] KAP 503 for ${DAY1}/*`);
      expect(Number.isFinite(Date.parse(patch.updated_at as string))).toBe(true);
      expect(stateUpdates()[0]?.state.eq).toEqual([{ col: "id", val: 1 }]);
      expect(blockedWrites()).toHaveLength(0);
    });

    it("uses status 0 when KAP never answered", async () => {
      fetchImpl = async () => {
        throw new TypeError("fetch failed");
      };

      await post(RANGE);

      expect(stateUpdates()).toHaveLength(1);
      expect(patchOf(0).last_status).toBe(0);
      expect(patchOf(0).last_error).toBe(`[kap-ingest] KAP unreachable for ${DAY1}/*: TypeError`);
    });

    it("uses status 0 for a 200 with an unusable body, so the admin badge does not show '200 (normal)' beside an error", async () => {
      fetchImpl = async () => new Response("<html>Bakim</html>", { status: 200 });

      await post(RANGE);

      expect(patchOf(0).last_status).toBe(0);
      expect(String(patchOf(0).last_error)).toContain("bad body");
    });

    it("takes status and message together from the FIRST upstream failure of the cycle", async () => {
      fetchImpl = async (_url, init) => {
        if (dayOf(init) === DAY1) throw new DOMException("timed out", "TimeoutError");
        return new Response("bad gateway", { status: 502 });
      };

      await post(RANGE);

      expect(stateUpdates()).toHaveLength(1);
      expect(patchOf(0).last_status).toBe(0);
      expect(patchOf(0).last_error).toBe(`[kap-ingest] KAP unreachable for ${DAY1}/*: TimeoutError`);
    });

    it("bounds last_error to 300 characters", async () => {
      fetchImpl = async () => {
        const err = new Error("x");
        err.name = "N".repeat(400);
        throw err;
      };

      await post(RANGE);

      const lastError = String(patchOf(0).last_error);
      expect(lastError.length).toBe(300);
      expect(lastError.startsWith("[kap-ingest] KAP unreachable")).toBe(true);
    });

    it("warns when the write matches zero rows (kap_fetch_state row 1 missing), like tripBreaker", async () => {
      kapSupabaseFake.kapFetchStateMissing.value = true;
      fetchImpl = async () => new Response("bad gateway", { status: 502 });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(200);
      expect(json.upstream_unavailable).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith("[kap-ingest] kap_fetch_state row 1 missing — breaker write did not persist");
    });

    it("a state write that throws is logged and does not turn the outage into a 500", async () => {
      kapSupabaseFake.faults.breakerWriteThrows = true;
      fetchImpl = async () => new Response("bad gateway", { status: 502 });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(200);
      expect(json.upstream_unavailable).toBe(true);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("write failed"))).toBe(true);
    });

    it("a later successful cycle clears it through clearBreakerError, and never writes blocked_until either", async () => {
      fetchImpl = async () => new Response("bad gateway", { status: 502 });
      await post(RANGE);
      fetchImpl = async () => new Response(JSON.stringify([kapItem(900)]), { status: 200 });
      const { res, json } = await post(RANGE);

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.upstream_unavailable).toBeUndefined();
      expect(stateUpdates()).toHaveLength(2);
      expect(patchOf(0)).toMatchObject({ last_status: 502 });
      expect(patchOf(1)).toMatchObject({ last_error: null, last_status: 200 });
      expect(blockedWrites()).toHaveLength(0);
    });

    it("a healthy cycle makes no upstream record and carries no upstream_unavailable flag", async () => {
      fetchImpl = async () => new Response(JSON.stringify([kapItem(901)]), { status: 200 });

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(200);
      expect(json).toMatchObject({ ok: true, days: 2, upstreamErrors: 0, tayfErrors: 0 });
      expect(json.upstream_unavailable).toBeUndefined();
      // clearBreakerError only (once per cycle)
      expect(stateUpdates()).toHaveLength(1);
      expect(patchOf(0)).toMatchObject({ last_error: null, last_status: 200 });
    });

    it("a partial outage (one day fine, one day KAP 5xx) stays ok:true with no state record for the failed day", async () => {
      fetchImpl = async (_url, init) =>
        dayOf(init) === DAY1 ? new Response("bad gateway", { status: 502 }) : new Response("[]", { status: 200 });

      const { res, json } = await post(RANGE);

      expect(res.status).toBe(200);
      expect(json).toMatchObject({ ok: true, days: 1, upstreamErrors: 1, tayfErrors: 0 });
      expect(json.upstream_unavailable).toBeUndefined();
      expect(stateUpdates()).toHaveLength(1);
      expect(patchOf(0)).toMatchObject({ last_error: null, last_status: 200 });
    });
  });

  // -------------------------------------------------------------------------
  // h153-kap-health: a partial cycle (at least one day of the range ingested,
  // at least one did not) answers 200 ok:true exactly as before, but the body
  // now says which days did not ingest (failedDays) and marks the cycle
  // partial. `ok` and the HTTP status are deliberately unchanged:
  // scripts/kap-backfill.mjs aborts on !json.ok, and ops_health_report row 2
  // counts status codes only, so a 502 here would turn it red within five
  // kap-drain ticks.
  // -------------------------------------------------------------------------
  describe("partial cycles (h153-kap-health)", () => {
    // Default window at 2026-09-12T10:00:00Z: TODAY 2026-09-12, YDAY 2026-09-11
    // (istanbulDate). Only Date is faked, so no retry sleep is ever involved:
    // a KAP 502 is not retried and a 403 is returned at once.
    const TODAY = "2026-09-12";
    const YDAY = "2026-09-11";
    const DEFAULT_RANGE_LENGTH = 2;

    const freezeClock = () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-12T10:00:00Z"));
    };
    const items = (n: number) => new Response(JSON.stringify([kapItem(n)]), { status: 200 });
    const kap502 = () => new Response("bad gateway", { status: 502 });
    // The invariant every case shares: failedDays is the range minus the days
    // that ingested.
    const expectInvariant = (json: CycleBody, rangeLength: number) => {
      expect(json.failedDays.length).toBe(rangeLength - json.days);
    };

    it("today fails with a KAP 502 after yesterday ingested: 200, ok true, partial true, failedDays [today]", async () => {
      freezeClock();
      fetchImpl = async (_url, init) => (dayOf(init) === YDAY ? items(1) : kap502());

      const { res, json } = await post({});

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.partial).toBe(true);
      expect(json.failedDays).toEqual([TODAY]);
      expect(json.days).toBe(1);
      expect(json.upstreamErrors).toBe(1);
      expect(json.tayfErrors).toBe(0);
      expect(json.upstream_unavailable).toBeUndefined();
      expect(json.errors.filter((e) => e.startsWith(`${TODAY}:`))).toHaveLength(1);
      expect(kapSentryCalls.captured).toHaveLength(0);
      expectInvariant(json, DEFAULT_RANGE_LENGTH);
    });

    it("today fails with a network error after yesterday ingested: same contract", async () => {
      freezeClock();
      fetchImpl = async (_url, init) => {
        if (dayOf(init) === YDAY) return items(1);
        throw new TypeError("fetch failed");
      };

      const { res, json } = await post({});

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.partial).toBe(true);
      expect(json.failedDays).toEqual([TODAY]);
      expect(json.upstreamErrors).toBe(1);
      expectInvariant(json, DEFAULT_RANGE_LENGTH);
    });

    it("yesterday fails, today ingests: partial true, failedDays [yesterday]", async () => {
      freezeClock();
      fetchImpl = async (_url, init) => (dayOf(init) === YDAY ? kap502() : items(2));

      const { res, json } = await post({});

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.partial).toBe(true);
      expect(json.failedDays).toEqual([YDAY]);
      expectInvariant(json, DEFAULT_RANGE_LENGTH);
    });

    it("a breaker trip on today after yesterday ingested: still 200, partial true, clear then trip written and nothing else", async () => {
      freezeClock();
      fetchImpl = async (_url, init) =>
        dayOf(init) === YDAY ? items(3) : new Response("forbidden", { status: 403 });

      const { res, json } = await post({});

      // unchanged behaviour, pinned: days is 1, so ok stays true and the answer 200
      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.partial).toBe(true);
      expect(json.failedDays).toEqual([TODAY]);
      expect(json.tayfErrors).toBe(1);
      expect(stateUpdates()).toHaveLength(2);
      expect(patchOf(0)).toMatchObject({ last_error: null, last_status: 200 });
      expect(patchOf(1)).toMatchObject({ last_status: 403 });
      expect(patchOf(1)).toHaveProperty("blocked_until");
      expect(blockedWrites()).toHaveLength(1);
      expectInvariant(json, DEFAULT_RANGE_LENGTH);
    });

    it("the 50 s deadline before today: failedDays [today], partial true, no error counted by cause", async () => {
      freezeClock();
      fetchImpl = async (_url, init) => {
        if (dayOf(init) === YDAY) {
          vi.setSystemTime(Date.now() + 60_000);
          return items(4);
        }
        return kap502();
      };

      const { res, json } = await post({});

      expect(json.errors).toContain(`deadline before ${TODAY}`);
      expect(json.failedDays).toEqual([TODAY]);
      expect(json.partial).toBe(true);
      expect(json.upstreamErrors).toBe(0);
      expect(json.tayfErrors).toBe(0);
      expect(res.status).toBe(200);
      expectInvariant(json, DEFAULT_RANGE_LENGTH);
    });

    it("a healthy default cycle: failedDays [] and no partial key", async () => {
      freezeClock();
      fetchImpl = async () => items(5);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { res, json } = await post({});

      expect(json.failedDays).toEqual([]);
      expect(json.partial).toBeUndefined();
      expect(json).not.toHaveProperty("partial");
      expect(json.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("partial cycle"))).toBe(false);
      expectInvariant(json, DEFAULT_RANGE_LENGTH);
    });

    it("a total KAP outage lists every day, no partial, still 200 upstream_unavailable", async () => {
      fetchImpl = async () => kap502();

      const { res, json } = await post(RANGE);

      expect(json.failedDays).toEqual([DAY1, DAY2]);
      expect(json.partial).toBeUndefined();
      expect(json.ok).toBe(false);
      expect(json.upstream_unavailable).toBe(true);
      expect(res.status).toBe(200);
      expectInvariant(json, 2);
    });

    it("a breaker trip on the first day lists the untried day too, no partial, still 502", async () => {
      fetchImpl = async () => new Response("forbidden", { status: 403 });

      const { res, json } = await post(RANGE);

      expect(json.failedDays).toEqual([DAY1, DAY2]);
      expect(json.days).toBe(0);
      expect(json.partial).toBeUndefined();
      expect(res.status).toBe(502);
      expect(json.errors).toHaveLength(1);
      expectInvariant(json, 2);
    });

    it("an upsert error is not a failed day (scope unchanged): failedDays [] and no partial", async () => {
      kapSupabaseFake.faults.disclosuresUpsertError = true;
      fetchImpl = async () => items(1);

      const { res, json } = await post(RANGE);

      expect(json.days).toBe(2);
      expect(json.failedDays).toEqual([]);
      expect(json.partial).toBeUndefined();
      expect(json.tayfErrors).toBe(2);
      expect(res.status).toBe(200);
      expectInvariant(json, 2);
    });

    it("a partial cycle logs one warn line and sends no Sentry event", async () => {
      freezeClock();
      fetchImpl = async (_url, init) => (dayOf(init) === YDAY ? items(1) : kap502());
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { json } = await post({});

      expect(json.partial).toBe(true);
      // toHaveBeenCalledWith, not a call count: the REVALIDATE_URL warn also fires
      expect(warnSpy).toHaveBeenCalledWith("[kap-ingest] partial cycle: 2026-09-12 not ingested");
      expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes("partial cycle"))).toHaveLength(1);
      expect(kapSentryCalls.captured).toHaveLength(0);
    });

    it("failedDays keeps range order and the warn line joins several days with a comma", async () => {
      fetchImpl = async (_url, init) => (dayOf(init) === DAY2 ? items(7) : kap502());
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { res, json } = await post({ from: DAY1, to: DAY3 });

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.partial).toBe(true);
      expect(json.failedDays).toEqual([DAY1, DAY3]);
      expect(warnSpy).toHaveBeenCalledWith(`[kap-ingest] partial cycle: ${DAY1},${DAY3} not ingested`);
      expectInvariant(json, 3);
    });

    it("an explicit backfill range with one failed day keeps ok true (scripts/kap-backfill.mjs reads json.ok)", async () => {
      fetchImpl = async (_url, init) => (dayOf(init) === DAY1 ? kap502() : items(6));

      const { res, json } = await post(RANGE);

      expect(json.ok).toBe(true);
      expect(json.partial).toBe(true);
      expect(json.failedDays).toEqual([DAY1]);
      expect(res.status).toBe(200);
      expectInvariant(json, 2);
    });
  });

  describe("docs/ops-heartbeat.md row 2", () => {
    const doc = readFileSync(resolve(__dirname, "..", "..", "docs", "ops-heartbeat.md"), "utf8");
    const row2 = doc.split("\n").find((l) => l.startsWith("| 2 | `edge_http_errors_30m`")) ?? "";

    it("says a KAP outage no longer counts and where to look for it", () => {
      expect(row2).not.toBe("");
      expect(row2).toContain("upstream_unavailable");
      expect(row2).toContain('"upstream_unavailable":true');
      expect(row2).toContain("kap_fetch_state.last_status");
      expect(row2).toContain("last_error");
      expect(row2).toContain("/admin/ekonomi");
      expect(row2).toContain("net._http_response");
      expect(row2).toContain("--no-verify-jwt");
    });

    it("says a Tayf-side write failure, a mixed cycle and a breaker trip still answer 502 and count", () => {
      expect(row2).toMatch(/Tayf-side/);
      expect(row2).toMatch(/mixed cycle/);
      expect(row2).toMatch(/circuit-breaker trip/);
      expect(row2).toContain("502");
    });

    it("says a partial cycle answers 200 with partial and failedDays and does not count", () => {
      expect(row2).toContain('"partial":true');
      expect(row2).toContain("failedDays");
      expect(row2).toContain("h153");
      expect(row2).toContain("[kap-ingest] partial cycle:");
    });
  });
});
