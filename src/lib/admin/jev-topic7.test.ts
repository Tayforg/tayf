import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Topic (7) ölçütleri (migration 090, T7a). Mirrors jev-gold.test.ts /
// jev-shadow-status.test.ts: the shared chainable Supabase fake plus its
// `rpc` fixture map, since getJevTopic7Yardsticks is a single RPC.

const fixture = vi.hoisted(() => ({
  rows: [
    {
      question_key: "a1b2c3d4e5f6",
      question_set: "2026-09-24.1",
      n: 340,
      feed_agree: 0.53,
      section_n: 120,
      section_agree: 0.8,
      p080_share: 0.7,
      genel_share: 0.12,
      politika_share: 0.2,
      dunya_share: 0.15,
    },
  ] as unknown[],
  error: null as { message: string } | null,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    rpc: {
      jev_topic7_yardsticks: () => {
        if (fixture.error) return { data: null, error: fixture.error };
        return { data: fixture.rows, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { toYardstickRows, shortQuestionKey, getJevTopic7Yardsticks } from "./jev-topic7";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.rows = [
    {
      question_key: "a1b2c3d4e5f6",
      question_set: "2026-09-24.1",
      n: 340,
      feed_agree: 0.53,
      section_n: 120,
      section_agree: 0.8,
      p080_share: 0.7,
      genel_share: 0.12,
      politika_share: 0.2,
      dunya_share: 0.15,
    },
  ];
  fixture.error = null;
  supabaseFake.calls.rpc.length = 0;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("toYardstickRows", () => {
  it("coerces numeric-looking strings and never produces NaN", () => {
    const rows = toYardstickRows([
      {
        question_key: "abc",
        question_set: null,
        n: "10",
        feed_agree: "0.5",
        section_n: "not-a-number",
        section_agree: null,
        p080_share: undefined,
        genel_share: "0.1",
        politika_share: "0.2",
        dunya_share: "0.3",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      questionKey: "abc",
      questionSet: null,
      n: 10,
      feedAgree: 0.5,
      sectionN: 0,
      sectionAgree: null,
      p080Share: null,
      genelShare: 0.1,
      politikaShare: 0.2,
      dunyaShare: 0.3,
    });
  });

  it("drops rows without a string question_key and never throws on junk input", () => {
    expect(toYardstickRows(null)).toEqual([]);
    expect(toYardstickRows(undefined)).toEqual([]);
    expect(toYardstickRows("not-an-array")).toEqual([]);
    expect(toYardstickRows([{ question_key: 42 }, { foo: "bar" }])).toEqual([]);
  });
});

describe("shortQuestionKey", () => {
  it("shortens a fingerprint to its first 8 hex chars", () => {
    expect(shortQuestionKey("a1b2c3d4e5f6")).toBe("a1b2c3d4");
  });

  it("renders a legacy qs: key as '{question_set} (eski)'", () => {
    expect(shortQuestionKey("qs:2026-09-21.3")).toBe("2026-09-21.3 (eski)");
  });
});

describe("getJevTopic7Yardsticks", () => {
  it("calls the RPC with { p_days: 7 } by default", async () => {
    await getJevTopic7Yardsticks();
    const call = supabaseFake.calls.rpc.find((c) => c.name === "jev_topic7_yardsticks");
    expect(call?.args).toEqual({ p_days: 7 });
  });

  it("passes through a custom days value", async () => {
    await getJevTopic7Yardsticks(14);
    const call = supabaseFake.calls.rpc.find((c) => c.name === "jev_topic7_yardsticks");
    expect(call?.args).toEqual({ p_days: 14 });
  });

  it("returns rows on success", async () => {
    const rows = await getJevTopic7Yardsticks(7);
    expect(rows).not.toBeNull();
    expect(rows![0]?.questionKey).toBe("a1b2c3d4e5f6");
  });

  it("returns null on an RPC error, never throws", async () => {
    fixture.error = { message: "boom" };
    const rows = await getJevTopic7Yardsticks(7);
    expect(rows).toBeNull();
  });
});
