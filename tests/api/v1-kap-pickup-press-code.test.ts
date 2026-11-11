import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { toV1PickupBody } from "@/lib/api/v1-kap-pickup";
import type { TickerPickup } from "@/lib/finance/kap-pickup-query";
import type { BuilderState } from "../_helpers/supabase-fake";

// ---------------------------------------------------------------------------
// h128-apiv1-2 part A: GET /api/v1/kap/pickup applies the "Basın şu kodla anıyor"
// rule the /ekonomi panel applies (h108-kapdisclosures-2). bist_companies holds one
// row per company with every code it trades under ({ISATR,ISBTR,ISCTR,ISKUR,TIB}),
// KAP fans a filing out to every code and the resolver matches press to ONE of them
// (ISCTR). The endpoint used to report ISATR at picked_up 0 / pickup_rate 0 while
// the panel said "ISCTR koduyla". Now the body carries `press_code`, and the rate
// and the median lag are null when it is set.
// ---------------------------------------------------------------------------

const KEY = `tayf_${"9".repeat(40)}`;
const KEY_HASH = crypto.createHash("sha256").update(KEY).digest("hex");

const IS_BANK = ["ISATR", "ISBTR", "ISCTR", "ISKUR", "TIB"];
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const DISCLOSED_AT = NOW - 2 * DAY;

const db = vi.hoisted(() => ({
  /** Every code the company trades under; the company row is returned for any of them. */
  companyTickers: [] as string[],
  /** What a head:true count of article_tickers answers, per ticker. */
  counts: {} as Record<string, number>,
  /** The article_tickers rows the paged mention read returns, per ticker. */
  mentionRows: {} as Record<string, unknown[]>,
  /** A head:true count for this ticker answers an error (a statement timeout). */
  countErrorFor: null as string | null,
  /** The bist_companies read answers an error / throws. */
  companyMode: "ok" as "ok" | "error" | "throw",
  /** The page ticker: the issuer of the one disclosure the fake returns. */
  ticker: "ISATR",
  /** Builder state of every article_tickers head:true count, in call order. */
  headReads: [] as Array<{ ticker: string; state: BuilderState }>,
  companyReads: 0,
}));

const fake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      kap_disclosures: (state) => {
        const head = (state.selectArgs[1] as { head?: boolean } | undefined)?.head === true;
        if (head) return { data: null, error: null, count: 1 };
        return {
          data: [
            {
              disclosure_index: 7001,
              published_at: new Date(Date.parse("2026-11-11T12:00:00.000Z") - 2 * 86_400_000).toISOString(),
              stock_codes: [db.ticker],
              related_stocks: [],
              subject: "Genel Kurul Toplantısı",
              summary: null,
              disclosure_class: "ODA",
              modify_status: null,
              year: null,
              period: null,
              rule_type: null,
            },
          ],
          error: null,
        };
      },
      article_tickers: (state) => {
        const ticker = String(state.eq.find((e) => e.col === "ticker")?.val);
        const head = (state.selectArgs[1] as { head?: boolean } | undefined)?.head === true;
        if (head) {
          db.headReads.push({ ticker, state });
          if (db.countErrorFor === ticker) {
            return {
              data: null,
              error: { message: "canceling statement due to statement timeout", code: "57014" },
              status: 500,
            };
          }
          return { data: null, error: null, count: db.counts[ticker] ?? 0 };
        }
        return { data: db.mentionRows[ticker] ?? [], error: null };
      },
      bist_companies: (state) => {
        db.companyReads += 1;
        if (db.companyMode === "throw") throw new TypeError("fetch failed");
        if (db.companyMode === "error") {
          return { data: null, error: { message: "AbortError: Supabase request exceeded 4000 ms", code: "" }, status: 0 };
        }
        const wanted = (state.contains.find((c) => c.col === "tickers")?.val ?? []) as string[];
        const rows = wanted.every((t) => db.companyTickers.includes(t)) ? [{ tickers: db.companyTickers }] : [];
        return { data: rows, error: null };
      },
      jev_shadow_predictions: () => ({ data: [], error: null }),
      sources: () => ({
        data: [{ id: "src-1", slug: "sabah", bias: "pro_government", kind: "outlet" }],
        error: null,
      }),
      api_keys: () => ({ data: [], error: null }),
      api_key_usage_daily: () => ({ data: [{ calls: 0 }], error: null }),
    },
    rpc: {
      api_key_touch: (args) => {
        const { p_key_hash } = args as { p_key_hash: string };
        if (p_key_hash !== KEY_HASH) return { data: [], error: null };
        return { data: [{ key_id: 909, tier: "free" }], error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({ createClient: () => fake.client }));

vi.mock("@/lib/sentry/server", () => ({ captureServerException: vi.fn() }));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});

const ORIGINAL_ENV = { ...process.env };
let ipCounter = 0;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://tayfhaber.com";
  db.companyTickers = [];
  db.counts = {};
  db.mentionRows = {};
  db.countErrorFor = null;
  db.companyMode = "ok";
  db.ticker = "ISATR";
  db.headReads = [];
  db.companyReads = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SITE_URL"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

async function pickup(ticker: string) {
  ipCounter += 1;
  db.ticker = ticker;
  const { GET } = await import("@/app/api/v1/kap/pickup/route");
  return GET(
    new Request(`http://example.com/api/v1/kap/pickup?ticker=${ticker}`, {
      headers: { authorization: `Bearer ${KEY}`, "x-forwarded-for": `203.0.113.${ipCounter % 250}` },
    }),
  );
}

/** One real mention one hour after the filing, from a voting outlet: pickup 1/1, lag 60 min. */
function oneMention(ticker: string) {
  return [
    {
      article_id: `${ticker}-a1`,
      published_at: new Date(DISCLOSED_AT + HOUR).toISOString(),
      created_at: new Date(DISCLOSED_AT + HOUR).toISOString(),
      source_id: "src-1",
    },
  ];
}

describe("GET /api/v1/kap/pickup: press_code (a sibling share code carries the press)", () => {
  it("ISATR with 0 own mentions and ISCTR 205: press_code ISCTR, rate and median lag null, the rest unchanged", async () => {
    db.companyTickers = IS_BANK;
    db.counts = { ISCTR: 205, ISBTR: 3 };

    const res = await pickup("ISATR");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.press_code).toBe("ISCTR");
    expect(body.totals.pickup_rate).toBeNull();
    expect(body.totals.median_first_lag_minutes).toBeNull();
    // Everything else the mapper emits for this fixture is as before.
    expect(body.totals).toMatchObject({
      disclosures: 1,
      picked_up: 0,
      outlets: 0,
      zones: { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
      related_only: 0,
    });
    expect(body.count).toBe(1);
    expect(body.disclosures[0]).toMatchObject({
      disclosure_index: 7001,
      issuer: true,
      articles: 0,
      outlets: 0,
      first_lag_minutes: null,
    });
    expect(body.ticker).toBe("ISATR");
    expect(body.capped).toBe(false);
    expect(body.superseded).toBe(0);
  });

  it("counts the ticker's own mentions once, then each sibling once, over the request window", async () => {
    db.companyTickers = IS_BANK;
    db.counts = { ISCTR: 205 };

    await pickup("ISATR");

    expect(db.headReads.map((r) => r.ticker).sort()).toEqual(["ISATR", "ISBTR", "ISCTR", "ISKUR", "TIB"]);
    const own = db.headReads.find((r) => r.ticker === "ISATR")!;
    expect(own.state.selectArgs[1]).toEqual({ count: "exact", head: true });
    const since = own.state.gte.find((g) => g.col === "published_at")!.val;
    expect(since).toBe(new Date(NOW - 30 * DAY).toISOString());
    for (const read of db.headReads.filter((r) => r.ticker !== "ISATR")) {
      expect(read.state.gte.find((g) => g.col === "published_at")!.val).toBe(since);
    }
  });

  it("ISCTR itself has press: press_code null, no sibling is counted, and the numbers are exactly today's", async () => {
    db.companyTickers = IS_BANK;
    db.counts = { ISCTR: 205 };
    db.mentionRows = { ISCTR: oneMention("ISCTR") };

    const res = await pickup("ISCTR");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.press_code).toBeNull();
    expect(body.totals).toMatchObject({ disclosures: 1, picked_up: 1, pickup_rate: 1, median_first_lag_minutes: 60 });
    // No sibling read: only the ticker's own count.
    expect(db.headReads.map((r) => r.ticker)).toEqual(["ISCTR"]);

    // Byte for byte what fetchTickerPickup + the mapper (without a press code) give.
    const { fetchTickerPickup } = await import("@/lib/finance/kap-pickup-query");
    const { registryEnvelope } = await import("@/lib/sources/registry");
    const direct = await fetchTickerPickup(fake.client as never, "ISCTR", NOW - 30 * DAY, NOW, { limit: 50 });
    expect(body).toEqual(JSON.parse(JSON.stringify(registryEnvelope({ ...toV1PickupBody(direct) }))));
  });

  it("a company with one code reads no sibling and no own count: press_code null", async () => {
    db.companyTickers = ["THYAO"];

    const res = await pickup("THYAO");

    expect(res.status).toBe(200);
    expect((await res.json()).press_code).toBeNull();
    expect(db.headReads).toEqual([]);
  });

  it("a ticker with no company row: press_code null, still 200", async () => {
    const res = await pickup("ZZZZZ");

    expect(res.status).toBe(200);
    expect((await res.json()).press_code).toBeNull();
    expect(db.headReads).toEqual([]);
  });

  it("siblings without press: press_code null and the rate is the ticker's own (0)", async () => {
    db.companyTickers = IS_BANK;

    const body = await (await pickup("ISATR")).json();

    expect(body.press_code).toBeNull();
    expect(body.totals.pickup_rate).toBe(0);
  });

  it("one failing sibling count fails open: press_code null, status 200, a console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.companyTickers = IS_BANK;
    db.counts = { ISBTR: 5, ISCTR: 205 };
    db.countErrorFor = "TIB";

    const res = await pickup("ISATR");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.press_code).toBeNull();
    expect(body.totals.pickup_rate).toBe(0);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("[finance] v1 kap/pickup press code unavailable: "))).toBe(true);
    // The ticker came from the request: it is not part of the warning line.
    expect(lines.some((l) => l.includes("ISATR"))).toBe(false);
  });

  it("a failing own-mention count fails open the same way", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.companyTickers = IS_BANK;
    db.counts = { ISCTR: 205 };
    db.countErrorFor = "ISATR";

    const res = await pickup("ISATR");

    expect(res.status).toBe(200);
    expect((await res.json()).press_code).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it.each(["error", "throw"] as const)("a company read that %ss fails open: press_code null, status 200", async (mode) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.companyMode = mode;

    const res = await pickup("ISATR");

    expect(res.status).toBe(200);
    expect((await res.json()).press_code).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("never serialises a database error into the body", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    db.companyTickers = IS_BANK;
    db.countErrorFor = "TIB";

    const text = await (await pickup("ISATR")).text();

    expect(text).not.toContain("statement timeout");
    expect(text).not.toContain("57014");
  });
});

describe("toV1PickupBody: the press_code argument", () => {
  const ZONES = { iktidar: 1, bagimsiz: 0, muhalefet: 0 };
  const pickupResult: TickerPickup = {
    ticker: "ISATR",
    since: "2026-10-12T12:00:00.000Z",
    until: "2026-11-11T12:00:00.000Z",
    pickups: [],
    totals: {
      disclosures: 4,
      relatedOnly: 1,
      pickedUp: 3,
      pickupRate: 0.75,
      medianFirstLagMinutes: 184,
      outlets: 7,
      zones: ZONES,
    },
    relevanceApplied: true,
    truncated: false,
    totalDisclosures: 5,
    superseded: 0,
    capped: false,
  };

  it("defaults to null: press_code is null and every number is the query's own", () => {
    const body = toV1PickupBody(pickupResult);
    expect(body.press_code).toBeNull();
    expect(body.totals.pickup_rate).toBe(0.75);
    expect(body.totals.median_first_lag_minutes).toBe(184);
  });

  it("with a press code, nulls pickup_rate and median_first_lag_minutes and nothing else", () => {
    const plain = toV1PickupBody(pickupResult);
    const withCode = toV1PickupBody(pickupResult, "ISCTR");

    expect(withCode.press_code).toBe("ISCTR");
    expect(withCode.totals.pickup_rate).toBeNull();
    expect(withCode.totals.median_first_lag_minutes).toBeNull();
    expect({ ...withCode, press_code: null, totals: { ...withCode.totals, pickup_rate: 0.75, median_first_lag_minutes: 184 } }).toEqual(plain);
  });

  it("does not mutate the shared totals object of the query result", () => {
    toV1PickupBody(pickupResult, "ISCTR");
    expect(pickupResult.totals.pickupRate).toBe(0.75);
    expect(pickupResult.totals.medianFirstLagMinutes).toBe(184);
  });

  it("places press_code in the body once, as the key right after superseded", () => {
    const keys = Object.keys(toV1PickupBody(pickupResult, "ISCTR"));
    expect(keys.filter((k) => k === "press_code")).toHaveLength(1);
    expect(keys[keys.indexOf("superseded") + 1]).toBe("press_code");
  });
});

// The rule lives in ONE place: /ekonomi (queries.ts) and the keyed route both go through
// src/lib/finance/press-code.ts, so the panel and the endpoint cannot drift apart again.
describe("readPressCode has one definition", () => {
  const SRC = path.join(process.cwd(), "src");
  const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("press-code.ts exports readPressCode and fetchPressCodeForWindow", async () => {
    const mod = await import("@/lib/finance/press-code");
    expect(typeof mod.readPressCode).toBe("function");
    expect(typeof mod.fetchPressCodeForWindow).toBe("function");
  });

  it("queries.ts imports readPressCode from press-code.ts and keeps no copy of its own", () => {
    const queries = read("lib/finance/queries.ts");
    expect(queries).toMatch(/import\s*\{[^}]*\breadPressCode\b[^}]*\}\s*from\s*"@\/lib\/finance\/press-code"/);
    expect(queries).not.toMatch(/function\s+readPressCode\b/);
  });

  it("the keyed pickup route reaches the same module through fetchPressCodeForWindow", () => {
    const route = read("app/api/v1/kap/pickup/route.ts");
    expect(route).toMatch(/import\s*\{[^}]*\bfetchPressCodeForWindow\b[^}]*\}\s*from\s*"@\/lib\/finance\/press-code"/);
    const helper = read("lib/finance/press-code.ts");
    expect(helper).toMatch(/export\s+async\s+function\s+readPressCode\b/);
    // fetchPressCodeForWindow hands the answer to readPressCode rather than re-deriving the rule.
    const body = helper.slice(helper.indexOf("export async function fetchPressCodeForWindow"));
    expect(body).toMatch(/\breadPressCode\(/);
  });

  it("no other source file defines readPressCode", () => {
    const definers = walk(SRC)
      .filter((f) => /function\s+readPressCode\b|const\s+readPressCode\b/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f));
    expect(definers).toEqual(["lib/finance/press-code.ts"]);
  });
});
