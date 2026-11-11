import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

// ---------------------------------------------------------------------------
// kap-media-pickup — IO layer tests. Uses the shared chainable Supabase
// fake (tests/_helpers/supabase-fake.ts) directly against fetchTickerPickup
// (no createServerClient/createFinanceServerClient indirection needed
// there), and mocks next/cache + @/lib/supabase/server separately for the
// "use cache" getTickerPickup(Safe) wrappers.
// ---------------------------------------------------------------------------

const cacheMocks = vi.hoisted(() => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));

// errors.ts imports the Sentry helper; the classification below never calls it.
vi.mock("@/lib/sentry/server", () => ({ captureServerException: vi.fn() }));

vi.mock("next/cache", () => ({
  cacheLife: cacheMocks.cacheLife,
  cacheTag: cacheMocks.cacheTag,
}));

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-09-28T12:00:00.000Z").getTime();

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * An article_tickers handler that behaves like PostgREST: `total` rows in a
 * stable order, sliced by `.range()` (or `.limit()`), and a single response
 * NEVER longer than max_rows (1,000) whatever the caller asked for. Every
 * builder state is recorded in `seen`.
 */
function pagedMentions(total: number, seen: BuilderState[]) {
  const all = Array.from({ length: total }, (_, i) => ({
    article_id: `a${String(i).padStart(5, "0")}`,
    published_at: iso(NOW - HOUR),
    created_at: iso(NOW - HOUR),
    source_id: null,
  }));
  return (state: BuilderState) => {
    seen.push(state);
    const from = state.range ? state.range.from : 0;
    const asked = state.range ? state.range.to - state.range.from + 1 : (state.limit ?? all.length);
    return { data: all.slice(from, from + Math.min(asked, 1000)), error: null };
  };
}

// Order independence (vitest --sequence.shuffle): `vi.doMock` registrations
// survive `vi.resetModules()`, so the getTickerPickupSafe test's mocks of
// @/lib/supabase/server (a client whose .from is not a function) and of the
// module under test used to leak into whichever describe ran next. Every test
// therefore starts on a fresh module graph and leaves no doMock, fake timer or
// spy behind. The hoisted `vi.mock("next/cache")` above is unaffected by both.
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@/lib/supabase/server");
  vi.doUnmock("@/lib/finance/kap-pickup-query");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fetchTickerPickup", () => {
  it("no disclosures -> an empty legitimate result with no article_tickers query", async () => {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    let articleTickersCalled = false;
    const { client } = createSupabaseFake({
      tables: {
        kap_disclosures: () => ({ data: [], error: null }),
        article_tickers: () => {
          articleTickersCalled = true;
          return { data: [], error: null };
        },
      },
    });

    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    const result = await fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 });

    expect(result.pickups).toEqual([]);
    expect(result.totals.disclosures).toBe(0);
    expect(articleTickersCalled).toBe(false);
  });

  it("sends ONE combined or() (stock_codes OR related_stocks, no Devre Kesici, no Test Bildirimi) and no contains filter, and the mention gte = earliest disclosure - 3h", async () => {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    const captured: { disclosures?: unknown; mentions?: unknown } = {};

    const disclosedAt1 = NOW - 20 * DAY;
    const disclosedAt2 = NOW - 10 * DAY;

    const { client } = createSupabaseFake({
      tables: {
        kap_disclosures: (state) => {
          captured.disclosures = state;
          return {
            data: [
              { disclosure_index: 2, published_at: iso(disclosedAt2), stock_codes: ["THYAO"], subject: null, disclosure_class: "ODA" },
              { disclosure_index: 1, published_at: iso(disclosedAt1), stock_codes: ["THYAO"], subject: "Bildirim", disclosure_class: "ODA" },
            ],
            error: null,
          };
        },
        article_tickers: (state) => {
          captured.mentions = state;
          return { data: [], error: null };
        },
        jev_shadow_predictions: () => ({ data: [], error: null }),
        sources: () => ({ data: [], error: null }),
      },
    });

    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    await fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 });

    const dState = captured.disclosures as {
      contains: Array<{ col: string; val: unknown }>;
      or: string[];
      eq: Array<{ col: string; val: unknown }>;
    };
    // h11-finance-1: related_stocks-only notices (halts, bans) belong to the ticker too.
    expect(dState.or).toEqual([
      'and(or(stock_codes.cs.{THYAO},related_stocks.cs.{THYAO}),or(subject.is.null,subject.not.ilike.*Devre Kesici*),or(subject.is.null,subject.neq."Test Bildirimi"))',
    ]);
    expect(dState.contains).toEqual([]);

    const mState = captured.mentions as {
      eq: Array<{ col: string; val: unknown }>;
      gte: Array<{ col: string; val: unknown }>;
    };
    expect(mState.eq).toEqual([{ col: "ticker", val: "THYAO" }]);
    const gte = mState.gte.find((g) => g.col === "published_at");
    expect(gte?.val).toBe(iso(disclosedAt1 - 3 * HOUR));
  });

  it("250 mentions triggers 3 relevance `in` calls of at most 100 keys", async () => {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    const mentionRows = Array.from({ length: 250 }, (_, i) => ({
      article_id: `a${i}`,
      published_at: iso(NOW - HOUR),
      created_at: iso(NOW - HOUR),
      source_id: null,
    }));
    const relevanceInCalls: number[][] = [];

    const { client } = createSupabaseFake({
      tables: {
        kap_disclosures: () => ({
          data: [{ disclosure_index: 1, published_at: iso(NOW - 2 * DAY), stock_codes: ["THYAO"], subject: null, disclosure_class: null }],
          error: null,
        }),
        article_tickers: () => ({ data: mentionRows, error: null }),
        jev_shadow_predictions: (state) => {
          const inArg = state.in.find((x) => x.col === "subject_id");
          relevanceInCalls.push((inArg?.vals as string[]) ?? []);
          return { data: [], error: null };
        },
        sources: () => ({ data: [], error: null }),
      },
    });

    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    await fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 });

    expect(relevanceInCalls.length).toBe(3);
    for (const call of relevanceInCalls) expect(call.length).toBeLessThanOrEqual(100);
    expect(relevanceInCalls.reduce((s, c) => s + c.length, 0)).toBe(250);
  });

  it("a relevance error fails open: relevanceApplied false, no throw, all mentions kept", async () => {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    const { client } = createSupabaseFake({
      tables: {
        kap_disclosures: () => ({
          data: [{ disclosure_index: 1, published_at: iso(NOW - 2 * DAY), stock_codes: ["THYAO"], subject: null, disclosure_class: null }],
          error: null,
        }),
        article_tickers: () => ({
          data: [{ article_id: "a1", published_at: iso(NOW - DAY), created_at: iso(NOW - DAY), source_id: null }],
          error: null,
        }),
        jev_shadow_predictions: () => ({ data: null, error: { message: "boom" } }),
        sources: () => ({ data: [], error: null }),
      },
    });

    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    const result = await fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 });

    expect(result.relevanceApplied).toBe(false);
    expect(result.pickups[0]!.articles).toBe(1);
  });

  describe("h11-finance-3: the 30-day total behind the window label", () => {
    const rowsOf = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        disclosure_index: i + 1,
        published_at: iso(NOW - (i + 1) * 26 * HOUR),
        stock_codes: ["ISMEN"],
        subject: null,
        disclosure_class: null,
      }));

    async function run(opts: { rows: number; count?: number | null; countError?: string; limit?: number }) {
      const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
      const states: BuilderState[] = [];
      const { client } = createSupabaseFake({
        tables: {
          kap_disclosures: (state) => {
            states.push(state);
            if ((state.selectArgs[1] as { head?: boolean } | undefined)?.head === true) {
              if (opts.countError) return { data: null, error: { message: opts.countError } };
              return { data: null, error: null, count: opts.count ?? null };
            }
            return { data: rowsOf(opts.rows), error: null };
          },
          article_tickers: () => ({ data: [], error: null }),
          jev_shadow_predictions: () => ({ data: [], error: null }),
          sources: () => ({ data: [], error: null }),
        },
      });
      const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
      const result = await fetchTickerPickup(client as never, "ISMEN", NOW - 30 * DAY, NOW, { limit: opts.limit ?? 60 });
      return { result, states };
    }

    it("totalDisclosures comes from a head:true count with the same or() and window as the list", async () => {
      const { result, states } = await run({ rows: 60, count: 102 });
      expect(result.totalDisclosures).toBe(102);
      const count = states.find((s) => (s.selectArgs[1] as { head?: boolean } | undefined)?.head === true)!;
      expect(count.selectArgs).toEqual(["disclosure_index", { count: "exact", head: true }]);
      expect(count.or).toEqual([
        'and(or(stock_codes.cs.{ISMEN},related_stocks.cs.{ISMEN}),or(subject.is.null,subject.not.ilike.*Devre Kesici*),or(subject.is.null,subject.neq."Test Bildirimi"))',
      ]);
      expect(count.contains).toEqual([]);
      expect(count.gte).toEqual([{ col: "published_at", val: iso(NOW - 30 * DAY) }]);
      expect(count.lte).toEqual([{ col: "published_at", val: iso(NOW) }]);
      expect(count.limit).toBeNull();
    });

    it("capped is true exactly when the list reached the limit", async () => {
      expect((await run({ rows: 60, count: 102 })).result.capped).toBe(true);
      expect((await run({ rows: 59, count: 59 })).result.capped).toBe(false);
      expect((await run({ rows: 5, count: 5, limit: 5 })).result.capped).toBe(true);
    });

    it("totalDisclosures is null (with a warning, no throw) when the count fails", async () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { result } = await run({ rows: 3, countError: "canceling statement due to statement timeout" });
      expect(result.totalDisclosures).toBeNull();
      expect(result.pickups).toHaveLength(3);
      expect(spy.mock.calls.some((c) => String(c[0]).includes("fetchTickerPickup disclosure count ISMEN"))).toBe(true);
    });

    it("totalDisclosures is null when the count has no number", async () => {
      expect((await run({ rows: 3, count: null })).result.totalDisclosures).toBeNull();
    });

    it("an empty list returns totalDisclosures 0 / capped false without a mention query", async () => {
      const { result } = await run({ rows: 0, count: 0 });
      expect(result.pickups).toEqual([]);
      expect(result.totalDisclosures).toBe(0);
      expect(result.capped).toBe(false);
    });
  });

  // h108-kapdisclosures-3: KAP files a correction as a new disclosure; the original is not
  // scored a second time. The query reads modify_status, year, period and rule_type to tell.
  describe("h108-kapdisclosures-3: superseded originals", () => {
    const OTTO = {
      stock_codes: ["OTTO"],
      subject: "Sorumluluk Beyanı (Konsolide)",
      summary: "Otto Holding A.Ş. 3. Aylık Finansal Durum Raporu Ve Ekleri Sorumluluk Beyanı",
      year: "2026",
      period: "3",
      rule_type: "9 Aylık",
      disclosure_class: "FR",
    };
    const ORIGINAL = { ...OTTO, disclosure_index: 1694030, published_at: iso(NOW - 4 * DAY), modify_status: "DUZELTILEN" };
    const CORRECTION = { ...OTTO, disclosure_index: 1694331, published_at: iso(NOW - 4 * DAY + 38 * 60_000), modify_status: "DUZENLENEN" };
    const OTHER = { ...OTTO, disclosure_index: 1690000, published_at: iso(NOW - 9 * DAY), subject: "Genel Kurul", summary: null, year: null, period: null, rule_type: null, modify_status: null, disclosure_class: "ODA" };

    async function run(rows: unknown[], mentions: unknown[] = [], ticker = "OTTO") {
      const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
      const seen: { disclosures: BuilderState[]; mentions: BuilderState[] } = { disclosures: [], mentions: [] };
      const { client } = createSupabaseFake({
        tables: {
          kap_disclosures: (state) => {
            if ((state.selectArgs[1] as { head?: boolean } | undefined)?.head === true) return { data: null, error: null, count: rows.length };
            seen.disclosures.push(state);
            return { data: rows, error: null };
          },
          article_tickers: (state) => {
            seen.mentions.push(state);
            return { data: mentions, error: null };
          },
          jev_shadow_predictions: () => ({ data: [], error: null }),
          sources: () => ({ data: [], error: null }),
        },
      });
      const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
      const result = await fetchTickerPickup(client as never, ticker, NOW - 30 * DAY, NOW, { limit: 60 });
      return { result, seen };
    }

    it("selects modify_status, year, period, rule_type and related_stocks", async () => {
      const { seen } = await run([CORRECTION]);
      const cols = String(seen.disclosures[0]!.selectArgs[0]).split(",");
      expect(cols).toEqual(expect.arrayContaining(["modify_status", "year", "period", "rule_type", "stock_codes", "related_stocks"]));
    });

    it("the OTTO pair is one filing: the superseded original is out of the list and the totals", async () => {
      const mention = { article_id: "a1", published_at: iso(NOW - 4 * DAY + HOUR), created_at: iso(NOW - 4 * DAY + HOUR), source_id: null };
      const { result } = await run([CORRECTION, ORIGINAL, OTHER], [mention]);

      expect(result.pickups.map((p) => p.disclosureIndex)).toEqual([1694331, 1690000]);
      expect(result.totals.disclosures).toBe(2);
      expect(result.totals.pickedUp).toBe(1);
      expect(result.superseded).toBe(1);
      // The read was not cut by the limit.
      expect(result.capped).toBe(false);
    });

    it("an unflagged original (the ATEKS case) is found by its twin", async () => {
      const unflagged = { ...ORIGINAL, modify_status: null };
      const { result } = await run([CORRECTION, unflagged]);

      expect(result.pickups.map((p) => p.disclosureIndex)).toEqual([1694331]);
      expect(result.superseded).toBe(1);
    });

    it("the mention window starts at the earliest disclosure that still counts, not at the superseded one", async () => {
      const early = { ...ORIGINAL, disclosure_index: 1, published_at: iso(NOW - 20 * DAY), modify_status: "DUZELTILEN" };
      const { seen } = await run([CORRECTION, early]);

      const gte = seen.mentions[0]!.gte.find((g) => g.col === "published_at");
      expect(gte?.val).toBe(iso(NOW - 4 * DAY + 38 * 60_000 - 3 * HOUR));
    });

    it("rows with no correction are untouched: superseded 0", async () => {
      const { result } = await run([OTHER]);
      expect(result.superseded).toBe(0);
      expect(result.pickups).toHaveLength(1);
    });

    it("a list of one lone DUZELTILEN original summarises to nothing but still reports it", async () => {
      const { result } = await run([ORIGINAL]);
      expect(result.pickups).toEqual([]);
      expect(result.totals.disclosures).toBe(0);
      expect(result.superseded).toBe(1);
    });

    // h109: the TTKOM shape. The correction came 46 hours after the original, so the stories
    // published in between are the filing's pickup, not the correction's.
    describe("h109: the correction is anchored at its original", () => {
      const GAP_ORIGINAL = { ...OTTO, disclosure_index: 1692808, published_at: iso(NOW - 10 * DAY), modify_status: null };
      const GAP_CORRECTION = { ...OTTO, disclosure_index: 1694263, published_at: iso(NOW - 10 * DAY + 46 * HOUR), modify_status: "DUZENLENEN" };
      const mentionAt = (articleId: string, ms: number) => ({ article_id: articleId, published_at: iso(ms), created_at: iso(ms), source_id: null });

      it("a mention between the two counts on the correction's row, with the lag from the original", async () => {
        const { result } = await run([GAP_CORRECTION, GAP_ORIGINAL], [mentionAt("a1", NOW - 10 * DAY + HOUR)]);

        expect(result.pickups.map((p) => p.disclosureIndex)).toEqual([1694263]);
        expect(result.pickups[0]).toMatchObject({ articles: 1, firstLagMinutes: 60, disclosedAt: GAP_CORRECTION.published_at });
        expect(result.totals).toMatchObject({ disclosures: 1, pickedUp: 1 });
        expect(result.superseded).toBe(1);
      });

      it("reads mentions from the original's published_at minus the skew margin, to 48 h after it", async () => {
        const { seen } = await run([GAP_CORRECTION, GAP_ORIGINAL], [mentionAt("a1", NOW - 10 * DAY + HOUR)]);

        const state = seen.mentions[0]!;
        expect(state.gte.find((g) => g.col === "published_at")?.val).toBe(iso(NOW - 10 * DAY - 3 * HOUR));
        expect(state.lt.find((l) => l.col === "published_at")?.val).toBe(iso(NOW - 10 * DAY + 48 * HOUR + 3 * HOUR));
      });

      it("a mention 49 h after the original is past its window and does not count", async () => {
        const { result } = await run([GAP_CORRECTION, GAP_ORIGINAL], [mentionAt("a1", NOW - 10 * DAY + 49 * HOUR)]);

        expect(result.pickups[0]).toMatchObject({ articles: 0, firstLagMinutes: null });
      });

      it("a chain 1 <- 2 <- 3 anchors the last version at the first", async () => {
        const second = { ...GAP_CORRECTION, disclosure_index: 1694000, published_at: iso(NOW - 10 * DAY + 10 * HOUR) };
        const third = { ...GAP_CORRECTION, disclosure_index: 1694500, published_at: iso(NOW - 10 * DAY + 30 * HOUR) };
        const { result, seen } = await run([third, second, GAP_ORIGINAL], [mentionAt("a1", NOW - 10 * DAY + 2 * HOUR)]);

        expect(result.pickups.map((p) => p.disclosureIndex)).toEqual([1694500]);
        expect(result.pickups[0]).toMatchObject({ articles: 1, firstLagMinutes: 120 });
        expect(result.superseded).toBe(2);
        expect(seen.mentions[0]!.gte.find((g) => g.col === "published_at")?.val).toBe(iso(NOW - 10 * DAY - 3 * HOUR));
      });
    });

    // h109: one correction replaces one filing. TABGD files the same buyback notice every working
    // day; one DUZENLENEN row on the 23rd used to take all eight earlier days out of the list.
    it("a recurring daily notice with ONE correction: only its nearest twin is superseded", async () => {
      const TABGD = {
        stock_codes: ["TABGD"],
        related_stocks: [] as string[],
        subject: "Payların Geri Alınmasına İlişkin Bildirim",
        summary: "Pay Geri Alım İşlemleri",
        year: null,
        period: null,
        disclosure_class: "ODA",
        rule_type: null,
        modify_status: null as string | null,
      };
      const daily = Array.from({ length: 8 }, (_, i) => ({ ...TABGD, disclosure_index: 1680000 + i, published_at: iso(NOW - (12 - i) * DAY) }));
      const correction = { ...TABGD, disclosure_index: 1686985, published_at: iso(NOW - 3 * DAY), modify_status: "DUZENLENEN" };
      const { result } = await run([correction, ...[...daily].reverse()], [], "TABGD");

      expect(result.superseded).toBe(1);
      expect(result.pickups).toHaveLength(8);
      expect(result.pickups.map((p) => p.disclosureIndex)).not.toContain(1680007);
      expect(result.pickups.map((p) => p.disclosureIndex)).toContain(1680000);
      expect(result.totals.disclosures).toBe(8);
    });

    it("related_stocks tells one company's rating from another's: a THYAO correction replaces neither", async () => {
      const rating = {
        stock_codes: ["JCRAV"],
        subject: "Kredi Derecelendirmesi",
        summary: "KREDİ DERECELENDİRME BİLDİRİMİ",
        year: null,
        period: null,
        disclosure_class: "ODA",
        rule_type: null,
        modify_status: null as string | null,
      };
      const rows = [
        { ...rating, disclosure_index: 3, published_at: iso(NOW - DAY), related_stocks: ["THYAO"], modify_status: "DUZENLENEN" },
        { ...rating, disclosure_index: 2, published_at: iso(NOW - 2 * DAY), related_stocks: ["GARAN"] },
        { ...rating, disclosure_index: 1, published_at: iso(NOW - 2 * DAY - 1000), related_stocks: ["AKBNK"] },
      ];
      const { result } = await run(rows, [], "JCRAV");

      expect(result.superseded).toBe(0);
      expect(result.pickups).toHaveLength(3);
    });
  });

  it("a disclosure query error throws", async () => {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    const { client } = createSupabaseFake({
      tables: {
        kap_disclosures: () => ({ data: null, error: { message: "db down" } }),
      },
    });

    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    await expect(fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 })).rejects.toThrow();
  });

  it("a mention query error throws", async () => {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    const { client } = createSupabaseFake({
      tables: {
        kap_disclosures: () => ({
          data: [{ disclosure_index: 1, published_at: iso(NOW - 2 * DAY), stock_codes: ["THYAO"], subject: null, disclosure_class: null }],
          error: null,
        }),
        article_tickers: () => ({ data: null, error: { message: "db down" } }),
      },
    });

    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    await expect(fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 })).rejects.toThrow(
      /mentions.*db down/,
    );
  });

  it("a source query error throws", async () => {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    const { client } = createSupabaseFake({
      tables: {
        kap_disclosures: () => ({
          data: [{ disclosure_index: 1, published_at: iso(NOW - 2 * DAY), stock_codes: ["THYAO"], subject: null, disclosure_class: null }],
          error: null,
        }),
        article_tickers: () => ({
          data: [{ article_id: "a1", published_at: iso(NOW - DAY), created_at: iso(NOW - DAY), source_id: "s1" }],
          error: null,
        }),
        jev_shadow_predictions: () => ({ data: [], error: null }),
        sources: () => ({ data: null, error: { message: "db down" } }),
      },
    });

    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    await expect(fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 })).rejects.toThrow();
  });

  // h128-apiv1-3: every read error keeps its `[finance] fetchTickerPickup ...: <message>` text and
  // carries the PostgREST error (with the response status) as its cause, so the keyed
  // /api/v1/kap/pickup route can answer a database outage with the 503 instead of a 500.
  describe("h128-apiv1-3: a database outage stays classifiable", () => {
    type Reply = { data: unknown; error: { message: string; code?: string } | null; status?: number };
    const OUTAGES: Array<[string, { message: string; code?: string }, number]> = [
      ["a 57014 statement timeout", { message: "canceling statement due to statement timeout", code: "57014" }, 500],
      ["the reader cap's AbortError", { message: "AbortError: Supabase request exceeded 4000 ms", code: "" }, 0],
      ["a gateway answer with an HTML body (504)", { message: "<html>Gateway Timeout</html>", code: "" }, 504],
    ];
    const ISSUER_ROW = {
      disclosure_index: 1,
      published_at: iso(NOW - 2 * DAY),
      stock_codes: ["THYAO"],
      subject: null,
      disclosure_class: null,
    };
    const run = async (tables: Record<string, () => Reply>) => {
      const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
      const { client } = createSupabaseFake({ tables: tables as never });
      const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
      const { isUpstreamUnavailable } = await import("@/lib/api/errors");
      const err = await fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 }).catch(
        (e: unknown) => e,
      );
      return { err: err as Error, outage: isUpstreamUnavailable(err) };
    };

    it.each(OUTAGES)("the disclosure read, %s", async (_label, error, status) => {
      const { err, outage } = await run({
        kap_disclosures: () => ({ data: null, error, status }),
      });
      expect(err.message).toBe(`[finance] fetchTickerPickup disclosures: ${error.message}`);
      expect(outage).toBe(true);
    });

    it.each(OUTAGES)("the mention read, %s", async (_label, error, status) => {
      const { err, outage } = await run({
        kap_disclosures: () => ({ data: [ISSUER_ROW], error: null }),
        article_tickers: () => ({ data: null, error, status }),
      });
      expect(err.message).toBe(`[paging] fetchTickerPickup mentions THYAO: ${error.message}`);
      expect(outage).toBe(true);
    });

    it.each(OUTAGES)("the source read, %s", async (_label, error, status) => {
      const { err, outage } = await run({
        kap_disclosures: () => ({ data: [ISSUER_ROW], error: null }),
        article_tickers: () => ({
          data: [{ article_id: "a1", published_at: iso(NOW - DAY), created_at: iso(NOW - DAY), source_id: "s1" }],
          error: null,
        }),
        jev_shadow_predictions: () => ({ data: [], error: null }),
        sources: () => ({ data: null, error, status }),
      });
      expect(err.message).toBe(`[finance] fetchTickerPickup sources: ${error.message}`);
      expect(outage).toBe(true);
    });

    it("a unique violation on the disclosure read is not an outage", async () => {
      const { err, outage } = await run({
        kap_disclosures: () => ({ data: null, error: { message: "duplicate key", code: "23505" }, status: 409 }),
      });
      expect(err.message).toBe("[finance] fetchTickerPickup disclosures: duplicate key");
      expect(outage).toBe(false);
    });
  });

  // h48-ekonomi-2: issuer = the ticker is in the notice's own stock_codes. A notice
  // tagged only in related_stocks (Takasbank / MKK lists that name the share) is
  // listed but never scored, exactly like issuerDisclosureIndexes() in queries.ts.
  describe("h48-ekonomi-2: issuer vs related-only disclosures", () => {
    const ISSUER_ROW = {
      disclosure_index: 1685308,
      published_at: iso(NOW - 3 * DAY),
      stock_codes: ["ALARK"],
      subject: "Genel Kurul",
      disclosure_class: "ODA",
    };
    const RELATED_ROW = {
      disclosure_index: 1692166,
      published_at: iso(NOW - 2 * DAY),
      stock_codes: [] as string[],
      related_stocks: ["ALARK"],
      subject: "Temerrüt İşlemi",
      disclosure_class: "DG",
    };

    async function run(
      rows: unknown[],
      opts: { mentions?: Array<{ article_id: string; published_at: string; created_at: string; source_id: string | null }> } = {},
    ) {
      const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
      const kapStates: BuilderState[] = [];
      const mentionStates: BuilderState[] = [];
      const { client } = createSupabaseFake({
        tables: {
          kap_disclosures: (state) => {
            kapStates.push(state);
            if ((state.selectArgs[1] as { head?: boolean } | undefined)?.head === true) {
              return { data: null, error: null, count: rows.length };
            }
            return { data: rows, error: null };
          },
          article_tickers: (state) => {
            mentionStates.push(state);
            return { data: opts.mentions ?? [], error: null };
          },
          jev_shadow_predictions: () => ({ data: [], error: null }),
          sources: () => ({ data: [], error: null }),
        },
      });
      const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
      const result = await fetchTickerPickup(client as never, "ALARK", NOW - 30 * DAY, NOW, { limit: 60 });
      return { result, kapStates, mentionStates };
    }

    it("the disclosure list read selects stock_codes (the issuer rule needs it)", async () => {
      const { kapStates } = await run([ISSUER_ROW]);
      const list = kapStates.find((s) => (s.selectArgs[1] as { head?: boolean } | undefined)?.head !== true)!;
      expect(String(list.selectArgs[0]).split(",")).toContain("stock_codes");
    });

    it("stock_codes [] with related_stocks ['ALARK'] is issuer false; stock_codes ['ALARK'] is issuer true", async () => {
      const { result } = await run([RELATED_ROW, ISSUER_ROW]);
      const byIndex = new Map(result.pickups.map((p) => [p.disclosureIndex, p]));

      expect(byIndex.get(1692166)?.issuer).toBe(false);
      expect(byIndex.get(1685308)?.issuer).toBe(true);
    });

    it("a null or missing stock_codes is not an issuer filing", async () => {
      const { result } = await run([
        { ...RELATED_ROW, disclosure_index: 11, stock_codes: null },
        { disclosure_index: 12, published_at: iso(NOW - DAY), subject: null, disclosure_class: null },
      ]);

      expect(result.pickups.map((p) => p.issuer)).toEqual([false, false]);
    });

    it("a multi-issuer filing that includes the ticker is an issuer filing", async () => {
      const { result } = await run([{ ...ISSUER_ROW, stock_codes: ["AKSA", "ALARK"] }]);

      expect(result.pickups[0]?.issuer).toBe(true);
    });

    it("related-only notices get no mentions and stay out of the totals, even when the ticker has articles", async () => {
      const { result } = await run([RELATED_ROW, ISSUER_ROW], {
        mentions: [
          // Inside the related-only notice's window (2 d ago), not the issuer filing's (3 d ago, window ends 1 d ago).
          { article_id: "a1", published_at: iso(NOW - 2 * DAY + HOUR), created_at: iso(NOW - 2 * DAY + HOUR), source_id: null },
        ],
      });
      const related = result.pickups.find((p) => p.disclosureIndex === 1692166)!;

      expect(related.articles).toBe(0);
      expect(result.totals.disclosures).toBe(1);
      expect(result.totals.relatedOnly).toBe(1);
      expect(result.pickups).toHaveLength(2);
      expect(result.totalDisclosures).toBe(2);
    });

    it("ALARK shape: only related-only notices -> 3 rows listed, disclosures 0, pickupRate null, and no article_tickers read", async () => {
      const rows = [1692166, 1692046, 1685308].map((i, n) => ({
        ...RELATED_ROW,
        disclosure_index: i,
        published_at: iso(NOW - (n + 1) * DAY),
      }));
      const { result, mentionStates } = await run(rows);

      expect(result.pickups).toHaveLength(3);
      expect(result.pickups.every((p) => p.issuer === false && p.articles === 0)).toBe(true);
      expect(result.totals.disclosures).toBe(0);
      expect(result.totals.pickedUp).toBe(0);
      expect(result.totals.pickupRate).toBeNull();
      expect(result.totals.relatedOnly).toBe(3);
      expect(mentionStates).toHaveLength(0);
      expect(result.truncated).toBe(false);
      expect(result.capped).toBe(false);
    });

    it("the mention window is bounded by the issuer filings only", async () => {
      const { mentionStates } = await run([
        { ...RELATED_ROW, published_at: iso(NOW - 20 * DAY) },
        { ...ISSUER_ROW, published_at: iso(NOW - 10 * DAY) },
      ]);

      const gte = mentionStates[0]?.gte.find((g) => g.col === "published_at");
      expect(gte?.val).toBe(iso(NOW - 10 * DAY - 3 * HOUR));
    });

    it("an empty result carries relatedOnly 0", async () => {
      const { result } = await run([]);

      expect(result.totals.relatedOnly).toBe(0);
      expect(result.totals.pickupRate).toBeNull();
    });
  });

  describe("mention paging (PostgREST clamps every response at 1,000 rows)", () => {
    const oneDisclosure = () => ({
      data: [{ disclosure_index: 1, published_at: iso(NOW - 2 * DAY), stock_codes: ["THYAO"], subject: null, disclosure_class: null }],
      error: null,
    });

    it("1000 rows on page 1 and 200 on page 2: both pages are read, all 1200 mentions are used, not truncated", async () => {
      const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
      const seen: BuilderState[] = [];
      const relevanceKeysSeen: string[] = [];

      const { client } = createSupabaseFake({
        tables: {
          kap_disclosures: oneDisclosure,
          article_tickers: pagedMentions(1200, seen) as never,
          jev_shadow_predictions: (state) => {
            relevanceKeysSeen.push(...((state.in.find((x) => x.col === "subject_id")?.vals as string[]) ?? []));
            return { data: [], error: null };
          },
          sources: () => ({ data: [], error: null }),
        },
      });

      const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
      const result = await fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 });

      expect(seen.map((s) => s.range)).toEqual([
        { from: 0, to: 999 },
        { from: 1000, to: 1999 },
      ]);
      // Page 2's rows reach the relevance lookup (and so the pickup computation).
      expect(relevanceKeysSeen).toHaveLength(1200);
      expect(relevanceKeysSeen).toContain("a01199:THYAO");
      expect(result.pickups[0]!.articles).toBe(1200);
      expect(result.truncated).toBe(false);
    });

    it("a table of exactly 1000 mentions costs one empty extra page and is not truncated", async () => {
      const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
      const seen: BuilderState[] = [];

      const { client } = createSupabaseFake({
        tables: {
          kap_disclosures: oneDisclosure,
          article_tickers: pagedMentions(1000, seen) as never,
          jev_shadow_predictions: () => ({ data: [], error: null }),
          sources: () => ({ data: [], error: null }),
        },
      });

      const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
      const result = await fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 });

      expect(seen).toHaveLength(2);
      expect(result.truncated).toBe(false);
    });

    it("5 full pages: stops, truncated=true, and warns once naming the ticker", async () => {
      const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const seen: BuilderState[] = [];

      const { client } = createSupabaseFake({
        tables: {
          kap_disclosures: oneDisclosure,
          article_tickers: pagedMentions(6000, seen) as never,
          jev_shadow_predictions: () => ({ data: [], error: null }),
          sources: () => ({ data: [], error: null }),
        },
      });

      const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
      const result = await fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 });

      expect(seen).toHaveLength(5);
      expect(result.truncated).toBe(true);
      const truncationWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("THYAO") && /truncated/.test(String(c[0])));
      expect(truncationWarnings).toHaveLength(1);
    });

    it("orders the mention reads by published_at, then article_id, so .range() pages never skip or repeat a row", async () => {
      const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
      const seen: BuilderState[] = [];

      const { client } = createSupabaseFake({
        tables: {
          kap_disclosures: oneDisclosure,
          article_tickers: pagedMentions(1200, seen) as never,
          jev_shadow_predictions: () => ({ data: [], error: null }),
          sources: () => ({ data: [], error: null }),
        },
      });

      const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
      await fetchTickerPickup(client as never, "THYAO", NOW - 30 * DAY, NOW, { limit: 60 });

      expect(seen.length).toBeGreaterThan(1);
      for (const s of seen) {
        expect(s.order.map((o) => o.col)).toEqual(["published_at", "article_id"]);
        expect(s.limit).toBeNull();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Cold-read resilience for the page-facing wrappers: the panel is user-facing
// (/ekonomi/[ticker]), so the read runs under the 4 s reader cap, the "use
// cache" body never throws (attemptCached), and a failed attempt is memoised
// for "minutes" only. `getTickerPickup` still THROWS on failure (its callers
// decide), `getTickerPickupSafe` never does.
// ---------------------------------------------------------------------------

const TIMEOUT_ERROR = {
  message: "AbortError: Supabase request exceeded 4000 ms",
  hint: "Request was aborted (timeout or manual cancellation)",
  code: "",
};

describe("getTickerPickup / getTickerPickupSafe (cached attempt)", () => {
  const financeClient = vi.fn();

  async function loadWithClient(tables: Record<string, () => { data: unknown; error: unknown }>) {
    const { createSupabaseFake } = await import("../../../tests/_helpers/supabase-fake");
    const { client } = createSupabaseFake({ tables: tables as never });
    financeClient.mockReset();
    financeClient.mockImplementation(async () => client);
    vi.doMock("@/lib/supabase/server", () => ({
      READER_TIMEOUT_MS: 4000,
      createFinanceServerClient: (opts?: unknown) => financeClient(opts),
    }));
    return import("@/lib/finance/kap-pickup-query");
  }

  beforeEach(() => {
    financeClient.mockReset();
    cacheMocks.cacheLife.mockClear();
    cacheMocks.cacheTag.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("builds the finance client with the 4 s reader timeout", async () => {
    const { getTickerPickup } = await loadWithClient({
      kap_disclosures: () => ({ data: [], error: null }),
    });
    await getTickerPickup("THYAO");
    expect(financeClient).toHaveBeenCalledTimes(1);
    expect(financeClient).toHaveBeenCalledWith({ timeoutMs: 4000 });
  });

  it("success calls cacheLife exactly once with the normal 5-minute profile and tags the ticker", async () => {
    const { getTickerPickup } = await loadWithClient({
      kap_disclosures: () => ({ data: [], error: null }),
    });
    const result = await getTickerPickup("THYAO");
    expect(result.ticker).toBe("THYAO");
    expect(result.pickups).toEqual([]);
    expect(cacheMocks.cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheMocks.cacheLife).toHaveBeenCalledWith({ stale: 60, revalidate: 300, expire: 3600 });
    expect(cacheMocks.cacheTag).toHaveBeenCalledWith("finance-feed", "finance-ticker:THYAO");
  });

  it("a timeout calls cacheLife exactly once with minutes, and getTickerPickup rejects", async () => {
    const { getTickerPickup } = await loadWithClient({
      kap_disclosures: () => ({ data: null, error: TIMEOUT_ERROR }),
    });
    await expect(getTickerPickup("THYAO")).rejects.toThrow(/AbortError: Supabase request exceeded 4000 ms/);
    expect(cacheMocks.cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheMocks.cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("getTickerPickupSafe returns null on a timeout instead of throwing, still cached for minutes", async () => {
    const { getTickerPickupSafe } = await loadWithClient({
      kap_disclosures: () => ({ data: null, error: TIMEOUT_ERROR }),
    });
    await expect(getTickerPickupSafe("THYAO")).resolves.toBeNull();
    expect(cacheMocks.cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheMocks.cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("a client-construction failure is contained in the cached attempt: minutes, and Safe returns null", async () => {
    const { getTickerPickupSafe } = await loadWithClient({});
    financeClient.mockRejectedValue(new Error("Missing NEXT_PUBLIC_SUPABASE_URL"));
    await expect(getTickerPickupSafe("THYAO")).resolves.toBeNull();
    expect(cacheMocks.cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheMocks.cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("reads the clock inside the cached attempt: the 30-day lookback is anchored on the call time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    try {
      let seen: { gte: Array<{ col: string; val: unknown }> } | undefined;
      const { getTickerPickup } = await loadWithClient({
        kap_disclosures: ((state: unknown) => {
          seen = state as typeof seen;
          return { data: [], error: null };
        }) as never,
      });
      const result = await getTickerPickup("THYAO");
      expect(result.until).toBe(iso(NOW));
      expect(result.since).toBe(iso(NOW - 30 * DAY));
      expect(seen?.gte[0]?.val).toBe(iso(NOW - 30 * DAY));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getTickerPickupSafe", () => {
  it("returns null when fetchTickerPickup throws", async () => {
    vi.doMock("@/lib/supabase/server", () => ({
      READER_TIMEOUT_MS: 4000,
      createFinanceServerClient: async () => ({}) as never,
    }));
    vi.doMock("@/lib/finance/kap-pickup-query", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/finance/kap-pickup-query")>();
      return actual;
    });

    // Force a real failure path: a client whose .from() is not a function.
    const { getTickerPickupSafe } = await import("@/lib/finance/kap-pickup-query");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await getTickerPickupSafe("THYAO");
    expect(result).toBeNull();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });
});
