import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Pack JEV şimdi (migration 063), W3. Modelled line for line on
// src/lib/admin/jev-shadow-status.test.ts: the shared chainable Supabase
// fake (tests/_helpers/supabase-fake.ts) plus its `rpc` fixture map, since
// getJevGoldNext / getJevGoldScorecard are each built on a single RPC.
// No next/cache mock here — both getters are plain async fetchers on
// purpose (the /admin page is cookie-gated and dynamic, never "use cache").

const fixture = vi.hoisted(() => ({
  nextRow: [
    {
      article_id: "11111111-2222-3333-4444-555555555555",
      title: "Başlık",
      description: "Açıklama",
      category: "politika",
      source_slug: "kaynak",
      gold_position: 3,
      total: 128,
      done: 12,
    },
  ] as unknown[],
  scorecard: {
    labeled: { "1": 44, "2": 38 },
    double_labeled: { n: 36, politics_agree: 34, politics_rate: 0.944, topic_agree: 30, topic_rate: 0.833 },
    gold_n: 30,
    jev_politics_050: { n: 30, correct: 28, rate: 0.933 },
    jev_politics_070: { n: 30, correct: 27, rate: 0.9 },
    feed_politics: { n: 30, correct: 22, rate: 0.733 },
    jev_topic: { n: 29, correct: 25, rate: 0.862 },
  } as unknown,
  nextError: null as { message: string } | null,
  scorecardError: null as { message: string } | null,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    rpc: {
      jev_gold_next: () => {
        if (fixture.nextError) return { data: null, error: fixture.nextError };
        return { data: fixture.nextRow, error: null };
      },
      jev_gold_scorecard: () => {
        if (fixture.scorecardError) return { data: null, error: fixture.scorecardError };
        return { data: fixture.scorecard, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import {
  getJevGoldNext,
  getJevGoldScorecard,
  parseLabelerCookie,
  isJevLabeler,
  isJevGoldTopic,
  JEV_GOLD_TOPICS,
} from "./jev-gold";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.nextRow = [
    {
      article_id: "11111111-2222-3333-4444-555555555555",
      title: "Başlık",
      description: "Açıklama",
      category: "politika",
      source_slug: "kaynak",
      gold_position: 3,
      total: 128,
      done: 12,
    },
  ];
  fixture.scorecard = {
    labeled: { "1": 44, "2": 38 },
    double_labeled: { n: 36, politics_agree: 34, politics_rate: 0.944, topic_agree: 30, topic_rate: 0.833 },
    gold_n: 30,
    jev_politics_050: { n: 30, correct: 28, rate: 0.933 },
    jev_politics_070: { n: 30, correct: 27, rate: 0.9 },
    feed_politics: { n: 30, correct: 22, rate: 0.733 },
    jev_topic: { n: 29, correct: 25, rate: 0.862 },
  };
  fixture.nextError = null;
  fixture.scorecardError = null;
  supabaseFake.calls.rpc.length = 0;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("getJevGoldNext", () => {
  it("returns the article and progress from the single RPC row", async () => {
    const result = await getJevGoldNext(1);

    expect(result).toEqual({
      article: {
        article_id: "11111111-2222-3333-4444-555555555555",
        title: "Başlık",
        description: "Açıklama",
        category: "politika",
        source_slug: "kaynak",
        position: 3,
      },
      total: 128,
      done: 12,
    });
  });

  it("passes p_labeler through to the RPC", async () => {
    await getJevGoldNext(2);

    const call = supabaseFake.calls.rpc.find((c) => c.name === "jev_gold_next");
    expect(call).toBeDefined();
    expect(call!.args).toEqual({ p_labeler: 2 });
  });

  it("coerces total/done sent as strings", async () => {
    fixture.nextRow = [
      {
        article_id: "a1",
        title: "t",
        description: null,
        category: "dunya",
        source_slug: "s",
        gold_position: 1,
        total: "128",
        done: "12",
      },
    ];

    const result = await getJevGoldNext(1);

    expect(result!.total).toBe(128);
    expect(result!.done).toBe(12);
    expect(typeof result!.total).toBe("number");
    expect(typeof result!.done).toBe("number");
  });

  it("a null article_id means finished, not an error", async () => {
    fixture.nextRow = [
      {
        article_id: null,
        title: null,
        description: null,
        category: null,
        source_slug: null,
        gold_position: null,
        total: "128",
        done: "128",
      },
    ];

    const result = await getJevGoldNext(1);

    expect(result).not.toBeNull();
    expect(result!.article).toBeNull();
    expect(result!.total).toBe(128);
    expect(result!.done).toBe(128);
  });

  it("an RPC error -> null and exactly one PII-free [admin] line", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.nextError = { message: "relation \"jev_gold_set\" does not exist" };

    const result = await getJevGoldNext(1);

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[admin] jev gold"),
    );

    errorSpy.mockRestore();
  });

  it("missing env vars -> null, never throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getJevGoldNext(1)).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe("getJevGoldScorecard", () => {
  it("maps every figure and its n", async () => {
    const result = await getJevGoldScorecard();

    expect(result).not.toBeNull();
    expect(result!.labeled).toEqual({ "1": 44, "2": 38 });
    expect(result!.doubleLabeled).toEqual({
      n: 36,
      politicsAgree: 34,
      politicsRate: 0.944,
      topicAgree: 30,
      topicRate: 0.833,
    });
    expect(result!.goldN).toBe(30);
    expect(result!.jevPolitics050).toEqual({ n: 30, correct: 28, rate: 0.933 });
    expect(result!.jevPolitics070).toEqual({ n: 30, correct: 27, rate: 0.9 });
    expect(result!.feedPolitics).toEqual({ n: 30, correct: 22, rate: 0.733 });
    expect(result!.jevTopic).toEqual({ n: 29, correct: 25, rate: 0.862 });
  });

  it("keeps a null rate null instead of NaN", async () => {
    fixture.scorecard = {
      labeled: {},
      double_labeled: { n: 0, politics_agree: 0, politics_rate: null, topic_agree: 0, topic_rate: null },
      gold_n: 0,
      jev_politics_050: { n: 0, correct: 0, rate: null },
      jev_politics_070: { n: 0, correct: 0, rate: null },
      feed_politics: { n: 0, correct: 0, rate: null },
      jev_topic: { n: 0, correct: 0, rate: null },
    };

    const result = await getJevGoldScorecard();

    expect(result!.doubleLabeled.politicsRate).toBeNull();
    expect(result!.doubleLabeled.topicRate).toBeNull();
    expect(result!.jevPolitics050.rate).toBeNull();
    expect(Number.isNaN(result!.jevPolitics050.rate as unknown as number)).toBe(false);
  });

  it("missing keys -> zeros, not a throw", async () => {
    fixture.scorecard = {};

    const result = await getJevGoldScorecard();

    expect(result).not.toBeNull();
    expect(result!.labeled).toEqual({});
    expect(result!.doubleLabeled).toEqual({ n: 0, politicsAgree: 0, politicsRate: null, topicAgree: 0, topicRate: null });
    expect(result!.goldN).toBe(0);
    expect(result!.jevPolitics050).toEqual({ n: 0, correct: 0, rate: null });
    expect(result!.jevPolitics070).toEqual({ n: 0, correct: 0, rate: null });
    expect(result!.feedPolitics).toEqual({ n: 0, correct: 0, rate: null });
    expect(result!.jevTopic).toEqual({ n: 0, correct: 0, rate: null });
  });

  it("an RPC error -> null", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.scorecardError = { message: "boom" };

    const result = await getJevGoldScorecard();

    expect(result).toBeNull();

    errorSpy.mockRestore();
  });
});

describe("parseLabelerCookie", () => {
  it("'2' -> 2", () => {
    expect(parseLabelerCookie("2")).toBe(2);
  });

  it("'1', undefined, garbage -> 1", () => {
    expect(parseLabelerCookie("1")).toBe(1);
    expect(parseLabelerCookie(undefined)).toBe(1);
    expect(parseLabelerCookie("garbage")).toBe(1);
    expect(parseLabelerCookie("3")).toBe(1);
    expect(parseLabelerCookie("")).toBe(1);
  });
});

describe("vocabulary", () => {
  it("isJevLabeler accepts only 1 and 2", () => {
    expect(isJevLabeler(1)).toBe(true);
    expect(isJevLabeler(2)).toBe(true);
    expect(isJevLabeler(0)).toBe(false);
    expect(isJevLabeler(3)).toBe(false);
    expect(isJevLabeler("1")).toBe(false);
    expect(isJevLabeler(null)).toBe(false);
    expect(isJevLabeler(undefined)).toBe(false);
  });

  it("isJevGoldTopic accepts exactly the seven feed topics", () => {
    for (const topic of JEV_GOLD_TOPICS) {
      expect(isJevGoldTopic(topic)).toBe(true);
    }
    expect(isJevGoldTopic("nope")).toBe(false);
    expect(isJevGoldTopic("")).toBe(false);
    expect(isJevGoldTopic(1)).toBe(false);
    expect(isJevGoldTopic(null)).toBe(false);
    expect(isJevGoldTopic(undefined)).toBe(false);
  });

  it("JEV_GOLD_TOPICS matches migration 063's CHECK list", () => {
    expect(JEV_GOLD_TOPICS).toEqual([
      "politika",
      "dunya",
      "ekonomi",
      "spor",
      "yasam",
      "teknoloji",
      "genel",
    ]);
  });
});
