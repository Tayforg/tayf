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
  return { ...fake, kapFetchState, kapFetchStateMissing: missing };
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
  // KAP outage (or a WAF block) on every attempted day still returned a
  // healthy HTTP 200 — less observable than before this diff, inverting
  // SEC-05's intent.
  it("returns ok:false, HTTP 502, and captures exactly once when every day fails", async () => {
    const day1 = "2026-09-10";
    const day2 = "2026-09-11";
    fetchImpl = async () => {
      throw new TypeError("network down");
    };

    await import("../../supabase/functions/kap-ingest/index.ts");
    const handler = (globalThis as unknown as {
      __kapIngestHandler?: (req: Request) => Promise<Response>;
    }).__kapIngestHandler;
    expect(handler).toBeTypeOf("function");

    const res = await handler!(authedRequest("http://localhost/kap-ingest", { from: day1, to: day2 }));
    const body = (await res.json()) as { ok: boolean; days: number };

    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.days).toBe(0);
    expect(kapSentryCalls.captured).toHaveLength(1);
    expect(kapSentryCalls.captured[0]?.fn).toBe("kap-ingest");
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

  it("does not trip the breaker on a 5xx (single attempt, e.g. 502)", async () => {
    const day = "2026-09-18";
    fetchImpl = async () => new Response("bad gateway", { status: 502 });

    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    await runCycle({ from: day, to: day });

    expect(kapSupabaseFake.calls.update("kap_fetch_state").length).toBe(0);
  });

  it("does not trip the breaker when the retry ladder exhausts on 503 (5xx, not 403/429)", async () => {
    const day = "2026-09-19";
    fetchImpl = async () => new Response("unavailable", { status: 503, headers: { "Retry-After": "0" } });

    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    await runCycle({ from: day, to: day });

    expect(kapSupabaseFake.calls.update("kap_fetch_state").length).toBe(0);
  });

  it("does not trip the breaker on a thrown network error", async () => {
    const day = "2026-09-20";
    fetchImpl = async () => {
      throw new TypeError("network down");
    };

    const { runCycle } = await import("../../supabase/functions/kap-ingest/index.ts");
    await runCycle({ from: day, to: day });

    expect(kapSupabaseFake.calls.update("kap_fetch_state").length).toBe(0);
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
