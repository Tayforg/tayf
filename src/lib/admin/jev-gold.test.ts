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
  nextPrioritizedRow: [
    {
      article_id: "22222222-2222-3333-4444-555555555555",
      title: "Anlaşmazlık",
      description: null,
      category: "politika",
      source_slug: "kaynak",
      gold_position: 1,
      total: 304,
      done: 10,
      priority: "disagreement",
      disagree_total: 54,
      disagree_done: 5,
    },
  ] as unknown[],
  provisionalScorecard: {
    provisional_n: 360,
    jev_n: 340,
    jev_live_n: 30,
    jev_agree_n: 286,
    disagree_n: 54,
    adjudicated_n: 10,
    human_sided_jev: 6,
    human_sided_provisional: 4,
    human_n: 10,
    provisional_vs_human_agree: 8,
    jev_vs_human_n: 10,
    jev_vs_human_agree: 6,
  } as unknown,
  nextPrioritizedError: null as { message: string } | null,
  provisionalScorecardError: null as { message: string } | null,
  topic7Scorecard: {
    by_split: {
      dev: { n: 356, final_by_source: { human_agreed: 300, human_single: 40, provisional: 16 }, prov_vs_human_n: 340, prov_vs_human_agree: 300 },
      heldout: { n: 300, final_by_source: { none: 300 }, prov_vs_human_n: 0, prov_vs_human_agree: 0 },
    },
    stored_vs_final: [{ split: "dev", stored_key: "qs:2026-09-21.3", n: 340, correct: 300 }],
    note: "…",
  } as unknown,
  topic7ScorecardError: null as { message: string } | null,
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
      jev_gold_next_prioritized: () => {
        if (fixture.nextPrioritizedError) return { data: null, error: fixture.nextPrioritizedError };
        return { data: fixture.nextPrioritizedRow, error: null };
      },
      jev_gold_provisional_scorecard: () => {
        if (fixture.provisionalScorecardError) return { data: null, error: fixture.provisionalScorecardError };
        return { data: fixture.provisionalScorecard, error: null };
      },
      jev_gold_topic7_scorecard: () => {
        if (fixture.topic7ScorecardError) return { data: null, error: fixture.topic7ScorecardError };
        return { data: fixture.topic7Scorecard, error: null };
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
  getJevGoldNextPrioritized,
  getJevGoldProvisionalScorecard,
  parseLabelerCookie,
  isJevLabeler,
  isJevGoldTopic,
  priorityBadge,
  buildProvisionalScorecardLines,
  JEV_GOLD_TOPICS,
  JEV_GOLD_MIN_N,
  JEV_GOLD_TOPIC_LABELS_TR,
  JEV_TOPIC7_GUIDE_TR,
  preLabelFields,
  revealLine,
  parseTopic7Scorecard,
  getJevGoldTopic7Scorecard,
  type JevGoldProvisionalScorecard,
  type JevGoldArticle,
} from "./jev-gold";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  fixture.nextPrioritizedRow = [
    {
      article_id: "22222222-2222-3333-4444-555555555555",
      title: "Anlaşmazlık",
      description: null,
      category: "politika",
      source_slug: "kaynak",
      gold_position: 1,
      total: 304,
      done: 10,
      priority: "disagreement",
      disagree_total: 54,
      disagree_done: 5,
    },
  ];
  fixture.provisionalScorecard = {
    provisional_n: 360,
    jev_n: 340,
    jev_live_n: 30,
    jev_agree_n: 286,
    disagree_n: 54,
    adjudicated_n: 10,
    human_sided_jev: 6,
    human_sided_provisional: 4,
    human_n: 10,
    provisional_vs_human_agree: 8,
    jev_vs_human_n: 10,
    jev_vs_human_agree: 6,
  };
  fixture.nextPrioritizedError = null;
  fixture.provisionalScorecardError = null;
  fixture.topic7ScorecardError = null;
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

// Pack "gold-seed" (migration 076), W2. getJevGoldNextPrioritized /
// getJevGoldProvisionalScorecard follow the exact same fixture-RPC style as
// getJevGoldNext / getJevGoldScorecard above -- see that pair's fixture
// wiring for the shared chainable Supabase fake.

describe("getJevGoldNextPrioritized", () => {
  it("returns the article, progress, priority and disagreement counters", async () => {
    const result = await getJevGoldNextPrioritized(1);

    expect(result).toEqual({
      article: {
        article_id: "22222222-2222-3333-4444-555555555555",
        title: "Anlaşmazlık",
        description: null,
        category: "politika",
        source_slug: "kaynak",
        position: 1,
      },
      total: 304,
      done: 10,
      priority: "disagreement",
      disagreements: { total: 54, done: 5 },
    });
  });

  it("passes p_labeler through to the RPC", async () => {
    await getJevGoldNextPrioritized(2);

    const call = supabaseFake.calls.rpc.find((c) => c.name === "jev_gold_next_prioritized");
    expect(call).toBeDefined();
    expect(call!.args).toEqual({ p_labeler: 2 });
  });

  it("coerces numeric-string totals/counters", async () => {
    fixture.nextPrioritizedRow = [
      {
        article_id: "a1",
        title: "t",
        description: null,
        category: "dunya",
        source_slug: "s",
        gold_position: "1",
        total: "304",
        done: "10",
        priority: "gold",
        disagree_total: "54",
        disagree_done: "5",
      },
    ];

    const result = await getJevGoldNextPrioritized(1);

    expect(result!.total).toBe(304);
    expect(result!.done).toBe(10);
    expect(result!.disagreements).toEqual({ total: 54, done: 5 });
    expect(result!.article!.position).toBe(1);
  });

  it("a null article_id -> article null, priority still mapped (or null)", async () => {
    fixture.nextPrioritizedRow = [
      {
        article_id: null,
        title: null,
        description: null,
        category: null,
        source_slug: null,
        gold_position: null,
        total: "304",
        done: "304",
        priority: null,
        disagree_total: "54",
        disagree_done: "54",
      },
    ];

    const result = await getJevGoldNextPrioritized(1);

    expect(result).not.toBeNull();
    expect(result!.article).toBeNull();
    expect(result!.priority).toBeNull();
    expect(result!.disagreements).toEqual({ total: 54, done: 54 });
  });

  it("maps each priority string through unchanged", async () => {
    for (const priority of ["disagreement", "gold", "provisional"] as const) {
      fixture.nextPrioritizedRow = [
        {
          article_id: "a1",
          title: "t",
          description: null,
          category: "dunya",
          source_slug: "s",
          gold_position: 1,
          total: 304,
          done: 10,
          priority,
          disagree_total: 54,
          disagree_done: 5,
        },
      ];
      const result = await getJevGoldNextPrioritized(1);
      expect(result!.priority).toBe(priority);
    }
  });

  it("an RPC error -> null (e.g. 076 not applied yet)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.nextPrioritizedError = { message: 'function "jev_gold_next_prioritized" does not exist' };

    const result = await getJevGoldNextPrioritized(1);

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("missing env vars -> null, never throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getJevGoldNextPrioritized(1)).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe("getJevGoldProvisionalScorecard", () => {
  it("maps every camelCase field from the jsonb keys", async () => {
    const result = await getJevGoldProvisionalScorecard();

    expect(result).toEqual({
      provisionalN: 360,
      jevN: 340,
      jevLiveN: 30,
      jevAgreeN: 286,
      disagreeN: 54,
      adjudicatedN: 10,
      humanSidedJev: 6,
      humanSidedProvisional: 4,
      humanN: 10,
      provisionalVsHumanAgree: 8,
      jevVsHumanN: 10,
      jevVsHumanAgree: 6,
    });
  });

  it("coerces numeric strings", async () => {
    fixture.provisionalScorecard = {
      provisional_n: "360",
      jev_n: "340",
      jev_live_n: "30",
      jev_agree_n: "286",
      disagree_n: "54",
      adjudicated_n: "10",
      human_sided_jev: "6",
      human_sided_provisional: "4",
      human_n: "10",
      provisional_vs_human_agree: "8",
      jev_vs_human_n: "10",
      jev_vs_human_agree: "6",
    };

    const result = await getJevGoldProvisionalScorecard();

    expect(result!.provisionalN).toBe(360);
    expect(typeof result!.provisionalN).toBe("number");
  });

  it("missing keys -> zeros, not a throw", async () => {
    fixture.provisionalScorecard = {};

    const result = await getJevGoldProvisionalScorecard();

    expect(result).not.toBeNull();
    expect(result!.provisionalN).toBe(0);
    expect(result!.disagreeN).toBe(0);
  });

  it("an RPC error -> null", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.provisionalScorecardError = { message: "boom" };

    const result = await getJevGoldProvisionalScorecard();

    expect(result).toBeNull();

    errorSpy.mockRestore();
  });
});

describe("priorityBadge", () => {
  it("disagreement -> Anlaşmazlık / warn", () => {
    expect(priorityBadge("disagreement")).toEqual({ label: "Anlaşmazlık", tone: "warn" });
  });

  it("gold -> Altın küme örneği / neutral", () => {
    expect(priorityBadge("gold")).toEqual({ label: "Altın küme örneği", tone: "neutral" });
  });

  it("provisional -> Geçici etiketli / muted", () => {
    expect(priorityBadge("provisional")).toEqual({ label: "Geçici etiketli", tone: "muted" });
  });

  it("null -> null (no badge)", () => {
    expect(priorityBadge(null)).toBeNull();
  });
});

describe("buildProvisionalScorecardLines", () => {
  const fullCard: JevGoldProvisionalScorecard = {
    provisionalN: 360,
    jevN: 340,
    jevLiveN: 30,
    jevAgreeN: 286,
    disagreeN: 54,
    adjudicatedN: 40,
    humanSidedJev: 24,
    humanSidedProvisional: 16,
    humanN: 40,
    provisionalVsHumanAgree: 32,
    jevVsHumanN: 40,
    jevVsHumanAgree: 28,
  };

  it("returns one line per figure with real numbers when n is at/above JEV_GOLD_MIN_N", () => {
    const lines = buildProvisionalScorecardLines(fullCard);
    expect(lines.length).toBeGreaterThan(0);
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l.text]));
    expect(byLabel["Geçici etiketli haber"]).toContain("360");
    expect(byLabel["Anlaşmazlık"]).toContain("54");
  });

  it("gates rate lines below JEV_GOLD_MIN_N with 'henüz yok'", () => {
    const smallCard: JevGoldProvisionalScorecard = {
      ...fullCard,
      adjudicatedN: JEV_GOLD_MIN_N - 1,
      humanN: JEV_GOLD_MIN_N - 1,
      jevVsHumanN: JEV_GOLD_MIN_N - 1,
    };
    const lines = buildProvisionalScorecardLines(smallCard);
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l.text]));
    expect(byLabel["Geçici etiketin insanla uyumu"]).toContain("henüz yok");
    expect(byLabel["Jev'in insanla uyumu"]).toContain("henüz yok");
  });

  it("shows a rate once n reaches JEV_GOLD_MIN_N", () => {
    const bigCard: JevGoldProvisionalScorecard = {
      ...fullCard,
      humanN: JEV_GOLD_MIN_N,
      provisionalVsHumanAgree: JEV_GOLD_MIN_N - 2,
    };
    const lines = buildProvisionalScorecardLines(bigCard);
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l.text]));
    expect(byLabel["Geçici etiketin insanla uyumu"]).not.toContain("henüz yok");
  });
});

describe("JEV_TOPIC7_GUIDE_TR (090)", () => {
  it("class order matches JEV_GOLD_TOPICS, and each label matches JEV_GOLD_TOPIC_LABELS_TR", () => {
    expect(JEV_TOPIC7_GUIDE_TR.classes.map((c) => c.topic)).toEqual([...JEV_GOLD_TOPICS]);
    for (const c of JEV_TOPIC7_GUIDE_TR.classes) {
      expect(c.label).toBe(JEV_GOLD_TOPIC_LABELS_TR[c.topic]);
    }
  });

  it("each rule starts with its 1-based ordinal marker", () => {
    JEV_TOPIC7_GUIDE_TR.rules.forEach((rule, i) => {
      expect(rule.startsWith(`${i + 1}) `)).toBe(true);
    });
  });

  it("genel is 'Olaylar (genel)'", () => {
    expect(JEV_GOLD_TOPIC_LABELS_TR.genel).toBe("Olaylar (genel)");
  });
});

describe("preLabelFields (090)", () => {
  const article: JevGoldArticle = {
    article_id: "11111111-2222-3333-4444-555555555555",
    title: "Başlık",
    description: "Açıklama",
    category: "politika",
    source_slug: "kaynak",
    position: 7,
  };

  it("returns only Sıra, excluding Kaynak and Akış kategorisi", () => {
    const fields = preLabelFields(article);
    expect(fields).toEqual([{ label: "Sıra", value: "7" }]);
    const labels = fields.map((f) => f.label);
    expect(labels).not.toContain("Kaynak");
    expect(labels).not.toContain("Akış kategorisi");
  });
});

describe("revealLine (090)", () => {
  it("renders both fields", () => {
    expect(revealLine({ sourceSlug: "kaynak", category: "politika" })).toBe(
      "Az önce etiketlenen haber: kaynak kaynak · akış kategorisi politika",
    );
  });

  it("handles nulls as em dash", () => {
    expect(revealLine({ sourceSlug: null, category: null })).toBe(
      "Az önce etiketlenen haber: kaynak — · akış kategorisi —",
    );
  });
});

describe("static read of jev-altin/page.tsx (090)", () => {
  it("never renders next.article.source_slug or next.article.category directly", () => {
    const path = resolve(__dirname, "..", "..", "app", "admin", "(protected)", "jev-altin", "page.tsx");
    const src = readFileSync(path, "utf8");
    expect(src).not.toMatch(/next\.article\.source_slug/);
    expect(src).not.toMatch(/next\.article\.category/);
  });
});

describe("parseTopic7Scorecard (090)", () => {
  it("returns null for null", () => {
    expect(parseTopic7Scorecard(null)).toBeNull();
  });

  it("returns empty-shaped object for {}", () => {
    expect(parseTopic7Scorecard({})).toEqual({ bySplit: {}, storedVsFinal: [] });
  });

  it("handles a missing split", () => {
    const parsed = parseTopic7Scorecard({
      by_split: { dev: { n: 5, final_by_source: {}, prov_vs_human_n: 0, prov_vs_human_agree: 0 } },
      stored_vs_final: [],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.bySplit.dev).toBeDefined();
    expect(parsed!.bySplit.heldout).toBeUndefined();
  });

  it("drops stored_vs_final rows with non-numeric fields", () => {
    const parsed = parseTopic7Scorecard({
      by_split: {},
      stored_vs_final: [
        { split: "dev", stored_key: "qs:x", n: "not-a-number", correct: 3 },
        { split: "dev", stored_key: "qs:y", n: 10, correct: 8 },
      ],
    });
    expect(parsed!.storedVsFinal).toEqual([{ split: "dev", storedKey: "qs:y", n: 10, correct: 8 }]);
  });

  it("coerces numeric-looking strings in split figures", () => {
    const parsed = parseTopic7Scorecard({
      by_split: {
        dev: { n: "356", final_by_source: { human_agreed: "300" }, prov_vs_human_n: "340", prov_vs_human_agree: "300" },
      },
      stored_vs_final: [],
    });
    expect(parsed!.bySplit.dev).toEqual({
      n: 356,
      finalBySource: { human_agreed: 300 },
      provVsHumanN: 340,
      provVsHumanAgree: 300,
    });
  });
});

describe("getJevGoldTopic7Scorecard (090)", () => {
  it("parses a well-formed RPC result", async () => {
    const card = await getJevGoldTopic7Scorecard();
    expect(card).not.toBeNull();
    expect(card!.bySplit.dev?.n).toBe(356);
    expect(card!.storedVsFinal[0]?.storedKey).toBe("qs:2026-09-21.3");
  });

  it("returns null on an RPC error", async () => {
    fixture.topic7ScorecardError = { message: "boom" };
    const card = await getJevGoldTopic7Scorecard();
    expect(card).toBeNull();
  });
});
