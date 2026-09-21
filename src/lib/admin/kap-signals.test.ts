import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Pack "Sinyaller" (migration 065), W3. Modelled line for line on
// src/lib/admin/jev-gold.test.ts: the shared chainable Supabase fake
// (tests/_helpers/supabase-fake.ts) plus its `rpc` fixture map for the two
// SECURITY DEFINER functions, and a function-shaped `kap_disclosures` table
// fixture so the test can introspect the RPC's `p_indexes` argument. No
// next/cache mock here -- getKapSignals is a plain async fetcher on purpose
// (/admin/ekonomi is cookie-gated and dynamic, never "use cache").

const fixture = vi.hoisted(() => ({
  disclosures: [
    {
      disclosure_index: 200,
      kap_title: "Yönetim kurulu kararı",
      subject: "AAA",
      disclosure_class: "ODA",
      published_at: "2026-09-20T10:00:00.000Z",
    },
    {
      disclosure_index: 100,
      kap_title: "Finansal rapor",
      subject: "BBB",
      disclosure_class: "FR",
      published_at: "2026-09-19T08:00:00.000Z",
    },
  ] as unknown[],
  signals: [
    { disclosure_index: 200, materiality: 1.5, materiality_level: "orta", class_agree: true, question_set: "2026-09-21.1" },
  ] as unknown[],
  canary: [{ kap_n: 42, disagreements: 5, disagreement_rate: 0.119, over_threshold: true }] as unknown[],
  disclosuresError: null as { message: string } | null,
  signalsError: null as { message: string } | null,
  canaryError: null as { message: string } | null,
  signalsArgs: null as unknown,
  canaryArgs: null as unknown,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      kap_disclosures: () => {
        if (fixture.disclosuresError) return { data: null, error: fixture.disclosuresError };
        return { data: fixture.disclosures, error: null };
      },
    },
    rpc: {
      kap_disclosure_signals_for: (args: unknown) => {
        fixture.signalsArgs = args;
        if (fixture.signalsError) return { data: null, error: fixture.signalsError };
        return { data: fixture.signals, error: null };
      },
      jev_kap_canary_status: (args: unknown) => {
        fixture.canaryArgs = args;
        if (fixture.canaryError) return { data: null, error: fixture.canaryError };
        return { data: fixture.canary, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { getKapSignals, toKapSignalRows, KAP_SIGNALS_LIMIT } from "./kap-signals";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.disclosures = [
    {
      disclosure_index: 200,
      kap_title: "Yönetim kurulu kararı",
      subject: "AAA",
      disclosure_class: "ODA",
      published_at: "2026-09-20T10:00:00.000Z",
    },
    {
      disclosure_index: 100,
      kap_title: "Finansal rapor",
      subject: "BBB",
      disclosure_class: "FR",
      published_at: "2026-09-19T08:00:00.000Z",
    },
  ];
  fixture.signals = [
    { disclosure_index: 200, materiality: 1.5, materiality_level: "orta", class_agree: true, question_set: "2026-09-21.1" },
  ];
  fixture.canary = [{ kap_n: 42, disagreements: 5, disagreement_rate: 0.119, over_threshold: true }];
  fixture.disclosuresError = null;
  fixture.signalsError = null;
  fixture.canaryError = null;
  fixture.signalsArgs = null;
  fixture.canaryArgs = null;
  supabaseFake.calls.rpc.length = 0;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("toKapSignalRows", () => {
  it("left-joins signal rows onto disclosures by disclosure_index and preserves the disclosure ordering", () => {
    const rows = toKapSignalRows(
      [
        { disclosure_index: 200, kap_title: "A", subject: "x", disclosure_class: "ODA", published_at: "2026-09-20T10:00:00.000Z" },
        { disclosure_index: 100, kap_title: "B", subject: "y", disclosure_class: "FR", published_at: "2026-09-19T08:00:00.000Z" },
      ],
      [{ disclosure_index: 200, materiality: 1.5, materiality_level: "orta", class_agree: true, question_set: "2026-09-21.1" }],
    );

    expect(rows.map((r) => r.disclosure_index)).toEqual([200, 100]);
    expect(rows[0]!.materiality).toBe(1.5);
    expect(rows[0]!.materiality_level).toBe("orta");
  });

  it("yields null materiality and level for a disclosure with no prediction row", () => {
    const rows = toKapSignalRows(
      [{ disclosure_index: 300, kap_title: "C", subject: null, disclosure_class: null, published_at: "2026-09-18T00:00:00.000Z" }],
      [],
    );

    expect(rows[0]!.materiality).toBeNull();
    expect(rows[0]!.materiality_level).toBeNull();
    expect(rows[0]!.class_agree).toBeNull();
    expect(rows[0]!.question_set).toBeNull();
  });

  it("narrows materiality_level to the three known levels and nulls anything else", () => {
    const rows = toKapSignalRows(
      [
        { disclosure_index: 1, kap_title: "a", subject: null, disclosure_class: null, published_at: "2026-09-18T00:00:00.000Z" },
        { disclosure_index: 2, kap_title: "b", subject: null, disclosure_class: null, published_at: "2026-09-18T00:00:00.000Z" },
        { disclosure_index: 3, kap_title: "c", subject: null, disclosure_class: null, published_at: "2026-09-18T00:00:00.000Z" },
        { disclosure_index: 4, kap_title: "d", subject: null, disclosure_class: null, published_at: "2026-09-18T00:00:00.000Z" },
      ],
      [
        { disclosure_index: 1, materiality: 0.5, materiality_level: "düşük", class_agree: null, question_set: null },
        { disclosure_index: 2, materiality: 1.2, materiality_level: "orta", class_agree: null, question_set: null },
        { disclosure_index: 3, materiality: 2.5, materiality_level: "yüksek", class_agree: null, question_set: null },
        { disclosure_index: 4, materiality: 2.5, materiality_level: "unexpected-garbage", class_agree: null, question_set: null },
      ],
    );

    expect(rows.map((r) => r.materiality_level)).toEqual(["düşük", "orta", "yüksek", null]);
  });

  it("coerces disclosure_index and materiality sent as strings", () => {
    const rows = toKapSignalRows(
      [{ disclosure_index: "200", kap_title: "A", subject: "x", disclosure_class: "ODA", published_at: "2026-09-20T10:00:00.000Z" }],
      [{ disclosure_index: "200", materiality: "1.75", materiality_level: "orta", class_agree: true, question_set: "2026-09-21.1" }],
    );

    expect(rows[0]!.disclosure_index).toBe(200);
    expect(typeof rows[0]!.disclosure_index).toBe("number");
    expect(rows[0]!.materiality).toBe(1.75);
    expect(typeof rows[0]!.materiality).toBe("number");
  });
});

describe("getKapSignals", () => {
  it("passes exactly the fetched disclosure indexes as p_indexes", async () => {
    await getKapSignals();

    expect(fixture.signalsArgs).toEqual({ p_indexes: [200, 100] });
  });

  it("calls jev_kap_canary_status with no arguments so the SQL default day wins", async () => {
    await getKapSignals();

    const call = supabaseFake.calls.rpc.find((c) => c.name === "jev_kap_canary_status");
    expect(call).toBeDefined();
    expect(call!.args).toBeUndefined();
  });

  it("still returns the canary when there are no disclosures", async () => {
    fixture.disclosures = [];

    const result = await getKapSignals();

    expect(result).not.toBeNull();
    expect(result!.disclosures).toEqual([]);
    expect(result!.canary).not.toBeNull();
    expect(result!.canary!.n).toBe(42);
    const call = supabaseFake.calls.rpc.find((c) => c.name === "jev_kap_canary_status");
    expect(call).toBeDefined();
  });

  it("a disclosures error -> null; an RPC error -> null", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.disclosuresError = { message: "boom" };
    await expect(getKapSignals()).resolves.toBeNull();

    fixture.disclosuresError = null;
    fixture.canaryError = { message: "boom2" };
    await expect(getKapSignals()).resolves.toBeNull();

    errorSpy.mockRestore();
  });

  it("missing env vars -> null, never throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getKapSignals()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("uses KAP_SIGNALS_LIMIT (30) as the default disclosure limit", () => {
    expect(KAP_SIGNALS_LIMIT).toBe(30);
  });
});
