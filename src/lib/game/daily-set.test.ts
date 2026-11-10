import { describe, it, expect } from "vitest";

import {
  DAILY_GAME_EPOCH,
  DAILY_ENGLISH_GATE_FROM,
  DAILY_GAME_SIZE,
  DAILY_MAX_PER_ZONE,
  DAILY_POLITICS_GATE_FROM,
  DAILY_TITLE_MAX,
  DAILY_TWIN_GATE_FROM,
  DAILY_TWIN_KEY_V2_FROM,
  ISTANBUL_OFFSET_MS,
  addDays,
  dailyHash,
  dailyIntroText,
  dailyTwinKeyVersion,
  isDailyEligible,
  isDateKey,
  pickDailySet,
  puzzleFallbackNotice,
  puzzleNumber,
  puzzleWindow,
  resolvePuzzleDate,
  resolvePuzzleDateWithReason,
  titleLeaksOutlet,
  type DailyCandidate,
  type PuzzleWindow,
} from "./daily-set";
import { ENGLISH_SOURCE_SLUGS } from "@/lib/sources/source-language";
import type { BiasCategory } from "@/types";

// A title long enough to satisfy DAILY_TITLE_MIN (25) but under
// DAILY_TITLE_MAX (180) and clear of pii-filter's exclusion patterns and
// any outlet-name leak in the fixtures below.
function title(text: string): string {
  const padded = text.length >= 25 ? text : `${text} — bir siyasi haber başlığı`;
  return padded.slice(0, 179);
}

function source(overrides: Partial<DailyCandidate["source"]> = {}): DailyCandidate["source"] {
  return {
    id: "src-1",
    name: "Örnek Gazete",
    slug: "ornek-gazete",
    bias: "center",
    kind: "outlet",
    active: true,
    ...overrides,
  };
}

// Window used across most fixtures below: puzzleWindow('2026-09-29').
const KEY = "2026-09-29";
const WINDOW: PuzzleWindow = puzzleWindow(KEY);
const OUTSIDE_ISO = "2026-09-25T10:00:00.000Z";

function candidate(overrides: Partial<DailyCandidate> = {}): DailyCandidate {
  return {
    articleId: "11111111-1111-1111-1111-111111111111",
    title: title("Meclis bugün önemli bir yasa tasarısını görüşecek"),
    url: "https://ornek.com/haber/1",
    publishedAt: WINDOW.startIso,
    createdAt: WINDOW.startIso,
    clusterId: "cluster-1",
    category: "politika",
    politicsAdmittedAt: null,
    source: source(),
    ...overrides,
  };
}

describe("istanbulDateKey", () => {
  it("2026-09-27T20:59:59Z is still 2026-09-27 in Istanbul", async () => {
    const { istanbulDateKey } = await import("./daily-set");
    expect(istanbulDateKey(Date.parse("2026-09-27T20:59:59.000Z"))).toBe("2026-09-27");
  });

  it("2026-09-27T21:00:00Z rolls into 2026-09-28 in Istanbul", async () => {
    const { istanbulDateKey } = await import("./daily-set");
    expect(istanbulDateKey(Date.parse("2026-09-27T21:00:00.000Z"))).toBe("2026-09-28");
  });
});

describe("puzzleWindow", () => {
  it("2026-09-28 -> [2026-09-26T21:00:00.000Z, 2026-09-27T21:00:00.000Z)", () => {
    expect(puzzleWindow("2026-09-28")).toEqual({
      startIso: "2026-09-26T21:00:00.000Z",
      endIso: "2026-09-27T21:00:00.000Z",
    });
  });
});

describe("puzzleNumber", () => {
  it("the epoch is puzzle #1", () => {
    expect(puzzleNumber(DAILY_GAME_EPOCH)).toBe(1);
  });

  it("the day after the epoch is puzzle #2", () => {
    expect(puzzleNumber(addDays(DAILY_GAME_EPOCH, 1))).toBe(2);
  });
});

describe("resolvePuzzleDate", () => {
  const today = "2026-10-05";

  it("array input takes the first element", () => {
    expect(resolvePuzzleDate(["2026-10-02", "ignored"], today)).toBe("2026-10-02");
  });

  it("an invalid string falls back to today", () => {
    expect(resolvePuzzleDate("not-a-date", today)).toBe(today);
  });

  it("undefined falls back to today", () => {
    expect(resolvePuzzleDate(undefined, today)).toBe(today);
  });

  it("a future date falls back to today", () => {
    expect(resolvePuzzleDate("2026-10-06", today)).toBe(today);
  });

  it("8 days old falls back to today", () => {
    expect(resolvePuzzleDate(addDays(today, -8), today)).toBe(today);
  });

  it("a date before the epoch falls back to today", () => {
    expect(resolvePuzzleDate("2026-09-01", today)).toBe(today);
  });

  it("a valid 3-day-old key is kept", () => {
    const threeDaysAgo = addDays(today, -3);
    expect(resolvePuzzleDate(threeDaysAgo, today)).toBe(threeDaysAgo);
  });
});

describe("resolvePuzzleDateWithReason", () => {
  const today = "2026-11-02";

  it("an expired key (7 days back) falls back to today and says 'expired'", () => {
    expect(resolvePuzzleDateWithReason("2026-10-26", today)).toEqual({
      dateKey: "2026-11-02",
      fellBack: "expired",
    });
  });

  it("the oldest replayable key (6 days back) is kept with no reason", () => {
    expect(resolvePuzzleDateWithReason("2026-10-27", today)).toEqual({
      dateKey: "2026-10-27",
      fellBack: null,
    });
  });

  it("today itself is kept with no reason", () => {
    expect(resolvePuzzleDateWithReason(today, today)).toEqual({ dateKey: today, fellBack: null });
  });

  it("a future key falls back to today and says 'future'", () => {
    expect(resolvePuzzleDateWithReason("2026-11-03", today)).toEqual({
      dateKey: today,
      fellBack: "future",
    });
  });

  it("a non-date string falls back to today and says 'invalid'", () => {
    expect(resolvePuzzleDateWithReason("abc", today)).toEqual({
      dateKey: today,
      fellBack: "invalid",
    });
  });

  it("a calendrically impossible key says 'invalid'", () => {
    expect(resolvePuzzleDateWithReason("2026-02-30", today)).toEqual({
      dateKey: today,
      fellBack: "invalid",
    });
  });

  it("an empty string is a present-but-invalid value, not an absent one", () => {
    expect(resolvePuzzleDateWithReason("", today)).toEqual({ dateKey: today, fellBack: "invalid" });
  });

  it("a key before the epoch says 'invalid' (there was never a puzzle that day)", () => {
    expect(resolvePuzzleDateWithReason("2026-09-01", today)).toEqual({
      dateKey: today,
      fellBack: "invalid",
    });
  });

  it("an absent value (undefined) falls back to today with no reason", () => {
    expect(resolvePuzzleDateWithReason(undefined, today)).toEqual({
      dateKey: today,
      fellBack: null,
    });
  });

  it("an empty array has no string, so it is absent: today, no reason", () => {
    expect(resolvePuzzleDateWithReason([], today)).toEqual({ dateKey: today, fellBack: null });
  });

  it("an array takes its first element", () => {
    expect(resolvePuzzleDateWithReason(["2026-10-30", "2026-10-31"], today)).toEqual({
      dateKey: "2026-10-30",
      fellBack: null,
    });
    expect(resolvePuzzleDateWithReason(["2026-11-09", "2026-10-31"], today)).toEqual({
      dateKey: today,
      fellBack: "future",
    });
  });

  it("checks the future before the epoch and the epoch before expiry (rule order)", () => {
    // Before the epoch AND old: 'invalid', never 'expired'.
    expect(resolvePuzzleDateWithReason("2020-01-01", today).fellBack).toBe("invalid");
    // Exactly at the epoch but long expired: 'expired'.
    expect(resolvePuzzleDateWithReason(DAILY_GAME_EPOCH, today).fellBack).toBe("expired");
  });

  it("agrees with resolvePuzzleDate on every input (wrapper contract)", () => {
    const inputs: (string | string[] | undefined)[] = [
      undefined,
      [],
      "",
      "abc",
      "2026-09-01",
      "2026-10-26",
      "2026-10-27",
      "2026-11-02",
      "2026-11-03",
      ["2026-10-30", "x"],
    ];
    for (const raw of inputs) {
      expect(resolvePuzzleDate(raw, today)).toBe(resolvePuzzleDateWithReason(raw, today).dateKey);
    }
  });
});

describe("puzzleFallbackNotice", () => {
  it("explains an expired link in natural Turkish", () => {
    expect(puzzleFallbackNotice("expired")).toBe(
      "Bu bağlantıdaki bulmaca artık oynanamıyor; bugünkü bulmaca gösteriliyor.",
    );
  });

  it("explains a future link in natural Turkish", () => {
    expect(puzzleFallbackNotice("future")).toBe(
      "Bu bağlantıdaki bulmaca henüz yayımlanmadı; bugünkü bulmaca gösteriliyor.",
    );
  });

  it("stays silent for a malformed link and for no fallback at all", () => {
    expect(puzzleFallbackNotice("invalid")).toBeNull();
    expect(puzzleFallbackNotice(null)).toBeNull();
    expect(puzzleFallbackNotice(undefined)).toBeNull();
  });
});

describe("dailyIntroText", () => {
  it("DAILY_POLITICS_GATE_FROM has not moved (replay byte-identity contract)", () => {
    expect(DAILY_POLITICS_GATE_FROM).toBe("2026-11-04");
  });

  it("today before the gate: 'Dünün (...) 5 manşeti.' with no 'siyasi'", () => {
    const text = dailyIntroText({
      dateKey: "2026-11-02",
      todayKey: "2026-11-02",
      number: 36,
      windowLabel: "1 Kasım 2026",
    });
    expect(text).toBe(
      "Dünün (1 Kasım 2026) 5 manşeti. Her biri hangi bölgedeki bir kaynaktan? Herkes aynı 5 manşeti görür. Günün Tayf’ı #36.",
    );
    expect(text).not.toContain("siyasi");
  });

  it("today after the gate: names the headlines 'siyasi'", () => {
    const text = dailyIntroText({
      dateKey: "2026-11-05",
      todayKey: "2026-11-05",
      number: 39,
      windowLabel: "4 Kasım 2026",
    });
    expect(text).toBe(
      "Dünün (4 Kasım 2026) 5 siyasi manşeti. Her biri hangi bölgedeki bir kaynaktan? Herkes aynı 5 manşeti görür. Günün Tayf’ı #39.",
    );
  });

  it("today exactly on the gate date is already 'siyasi' (>= the gate)", () => {
    const text = dailyIntroText({
      dateKey: DAILY_POLITICS_GATE_FROM,
      todayKey: DAILY_POLITICS_GATE_FROM,
      number: 38,
      windowLabel: "3 Kasım 2026",
    });
    expect(text).toContain("5 siyasi manşeti");
  });

  it("a pre-gate replay never says 'Dünün' (the window is not yesterday) and never says 'siyasi'", () => {
    const text = dailyIntroText({
      dateKey: "2026-10-27",
      todayKey: "2026-11-02",
      number: 30,
      windowLabel: "26 Ekim 2026",
    });
    expect(text).toBe(
      "Günün Tayf’ı #30 · 26 Ekim 2026 tarihli 5 manşet. Her biri hangi bölgedeki bir kaynaktan? Herkes aynı 5 manşeti görür.",
    );
    expect(text).not.toContain("Dünün");
    expect(text).not.toContain("siyasi");
  });

  it("a replay on or after the gate says 'siyasi'", () => {
    const text = dailyIntroText({
      dateKey: "2026-11-04",
      todayKey: "2026-11-06",
      number: 38,
      windowLabel: "3 Kasım 2026",
    });
    expect(text).toBe(
      "Günün Tayf’ı #38 · 3 Kasım 2026 tarihli 5 siyasi manşet. Her biri hangi bölgedeki bir kaynaktan? Herkes aynı 5 manşeti görür.",
    );
    expect(text).not.toContain("Dünün");
  });

  it("uses the typographic apostrophe U+2019 (what the old JSX &rsquo; rendered), never a straight one", () => {
    const text = dailyIntroText({
      dateKey: "2026-11-02",
      todayKey: "2026-11-02",
      number: 1,
      windowLabel: "x",
    });
    expect(text).toContain("Tayf\u2019ı");
    expect(text).not.toContain("'");
  });
});

describe("Istanbul offset matches Intl for sample dates", () => {
  const samples = ["2026-01-15", "2026-04-01", "2026-07-04", "2026-12-25"];

  it.each(samples)("%s", (dateKey) => {
    const ms = Date.parse(`${dateKey}T12:00:00.000Z`);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Istanbul",
      timeZoneName: "shortOffset",
    }).formatToParts(ms);
    const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    // e.g. "GMT+3"
    expect(offsetPart).toBe("GMT+3");
    expect(ISTANBUL_OFFSET_MS).toBe(3 * 60 * 60 * 1000);
  });
});

describe("dailyHash", () => {
  it("is stable for the same inputs", () => {
    expect(dailyHash("2026-09-28", "article-1")).toBe(dailyHash("2026-09-28", "article-1"));
  });

  it("differs across keys for the same articleId", () => {
    expect(dailyHash("2026-09-28", "article-1")).not.toBe(dailyHash("2026-09-29", "article-1"));
  });

  it("differs across articleIds for the same key", () => {
    expect(dailyHash("2026-09-28", "article-1")).not.toBe(dailyHash("2026-09-28", "article-2"));
  });
});

describe("titleLeaksOutlet", () => {
  it("catches a case-folded outlet name leak (SÖZCÜ)", () => {
    const sozcu = source({ name: "Sözcü", slug: "sozcu" });
    expect(titleLeaksOutlet("SÖZCÜ'nün iddiasına göre bakan istifa etti", sozcu)).toBe(true);
  });

  it("catches a 4+ char slug token leak", () => {
    const src = source({ name: "Bağımsız Haber Merkezi", slug: "bagimsiz-haber" });
    expect(titleLeaksOutlet("Haber sitesinde bugün yeni bir gelişme yaşandı", src)).toBe(true);
  });

  it("does not flag an unrelated title", () => {
    const src = source({ name: "Sözcü", slug: "sozcu" });
    expect(titleLeaksOutlet("Meclis bugün önemli bir yasayı görüşecek", src)).toBe(false);
  });
});

describe("isDailyEligible", () => {
  it("rejects a wire source", () => {
    expect(isDailyEligible(candidate({ source: source({ kind: "wire" }) }), WINDOW)).toBe(false);
  });

  it("rejects an aggregator source", () => {
    expect(isDailyEligible(candidate({ source: source({ kind: "aggregator" }) }), WINDOW)).toBe(
      false,
    );
  });

  it("rejects a niche source", () => {
    expect(isDailyEligible(candidate({ source: source({ kind: "niche" }) }), WINDOW)).toBe(false);
  });

  it("rejects an inactive source", () => {
    expect(isDailyEligible(candidate({ source: source({ active: false }) }), WINDOW)).toBe(false);
  });

  it("rejects a PII title (gözaltına alındı)", () => {
    expect(
      isDailyEligible(
        candidate({ title: title("Şüpheli bir kişi gözaltına alındı bugün sabah") }),
        WINDOW,
      ),
    ).toBe(false);
  });

  it("rejects an outlet-name leak, case-folded", () => {
    const sozcu = source({ name: "Sözcü", slug: "sozcu" });
    expect(
      isDailyEligible(
        candidate({
          title: title("SÖZCÜ'nün iddiasına göre bakan bugün istifa etti"),
          source: sozcu,
        }),
        WINDOW,
      ),
    ).toBe(false);
  });

  it("rejects a title shorter than DAILY_TITLE_MIN", () => {
    expect(isDailyEligible(candidate({ title: "Kısa başlık" }), WINDOW)).toBe(false);
  });

  it("rejects a title longer than DAILY_TITLE_MAX", () => {
    expect(isDailyEligible(candidate({ title: "a".repeat(DAILY_TITLE_MAX + 1) }), WINDOW)).toBe(
      false,
    );
  });

  it("rejects an article outside the window", () => {
    expect(
      isDailyEligible(
        candidate({ publishedAt: OUTSIDE_ISO, createdAt: OUTSIDE_ISO }),
        WINDOW,
      ),
    ).toBe(false);
  });

  it("accepts a future published_at whose created_at is inside the window", () => {
    const farFuture = new Date(Date.parse(WINDOW.endIso) + 999 * 24 * 3600 * 1000).toISOString();
    expect(
      isDailyEligible(
        candidate({ publishedAt: farFuture, createdAt: WINDOW.startIso }),
        WINDOW,
      ),
    ).toBe(true);
  });

  it("accepts an otherwise-clean candidate", () => {
    expect(isDailyEligible(candidate(), WINDOW)).toBe(true);
  });

  describe("politics gate (opts.politicsGate)", () => {
    const GATED = { politicsGate: true } as const;

    it("rejects an ekonomi article that was never admitted to politics", () => {
      expect(
        isDailyEligible(candidate({ category: "ekonomi", politicsAdmittedAt: null }), WINDOW, GATED),
      ).toBe(false);
    });

    it("accepts a politika article", () => {
      expect(isDailyEligible(candidate({ category: "politika" }), WINDOW, GATED)).toBe(true);
    });

    it("accepts a son_dakika article", () => {
      expect(isDailyEligible(candidate({ category: "son_dakika" }), WINDOW, GATED)).toBe(true);
    });

    it("accepts an ekonomi article that carries a politics_admitted_at stamp", () => {
      expect(
        isDailyEligible(
          candidate({ category: "ekonomi", politicsAdmittedAt: "2026-11-05T08:00:00Z" }),
          WINDOW,
          GATED,
        ),
      ).toBe(true);
    });

    it("rejects a null category with no admission stamp", () => {
      expect(
        isDailyEligible(candidate({ category: null, politicsAdmittedAt: null }), WINDOW, GATED),
      ).toBe(false);
    });

    it("still applies every other rule when the gate is on", () => {
      expect(
        isDailyEligible(candidate({ source: source({ active: false }) }), WINDOW, GATED),
      ).toBe(false);
    });

    it("without opts (or with the gate off) an ekonomi article stays eligible", () => {
      const ekonomi = candidate({ category: "ekonomi", politicsAdmittedAt: null });
      expect(isDailyEligible(ekonomi, WINDOW)).toBe(true);
      expect(isDailyEligible(ekonomi, WINDOW, {})).toBe(true);
      expect(isDailyEligible(ekonomi, WINDOW, { politicsGate: false })).toBe(true);
    });
  });

  describe("english gate (opts.englishGate)", () => {
    const GATED = { englishGate: true } as const;
    const english = (slug: string) =>
      candidate({ source: source({ slug, name: "Örnek Yayın" }) });

    it("rejects an outlet with slug 'hurriyet-daily-news' when the gate is on", () => {
      expect(isDailyEligible(english("hurriyet-daily-news"), WINDOW, GATED)).toBe(false);
    });

    it("accepts the same outlet when the gate is off (past puzzles keep their rules)", () => {
      expect(isDailyEligible(english("hurriyet-daily-news"), WINDOW)).toBe(true);
      expect(isDailyEligible(english("hurriyet-daily-news"), WINDOW, {})).toBe(true);
      expect(isDailyEligible(english("hurriyet-daily-news"), WINDOW, { englishGate: false })).toBe(
        true,
      );
    });

    it.each([...ENGLISH_SOURCE_SLUGS])("rejects the English-language outlet %s when the gate is on", (slug) => {
      expect(isDailyEligible(english(slug), WINDOW, GATED)).toBe(false);
    });

    it("accepts a Turkish outlet when the gate is on", () => {
      expect(isDailyEligible(candidate(), WINDOW, GATED)).toBe(true);
      expect(isDailyEligible(english("sozcu"), WINDOW, GATED)).toBe(true);
    });

    it("composes with the politics gate: both rules apply together", () => {
      const both = { politicsGate: true, englishGate: true } as const;
      expect(isDailyEligible(english("daily-sabah"), WINDOW, both)).toBe(false);
      expect(isDailyEligible(candidate({ category: "ekonomi" }), WINDOW, both)).toBe(false);
      expect(isDailyEligible(candidate({ category: "politika" }), WINDOW, both)).toBe(true);
    });
  });
});

describe("isDailyEligible -- twin gate (opts.twinGate)", () => {
  const GATED = { twinGate: true } as const;

  it("rejects a candidate flagged crossZoneTwin when the gate is on", () => {
    expect(isDailyEligible(candidate({ crossZoneTwin: true }), WINDOW, GATED)).toBe(false);
  });

  it("accepts the same candidate when the gate is off or absent (past puzzles keep their rules)", () => {
    const twin = candidate({ crossZoneTwin: true });
    expect(isDailyEligible(twin, WINDOW)).toBe(true);
    expect(isDailyEligible(twin, WINDOW, {})).toBe(true);
    expect(isDailyEligible(twin, WINDOW, { twinGate: false })).toBe(true);
  });

  it("accepts a candidate that is not a twin (false or no flag) when the gate is on", () => {
    expect(isDailyEligible(candidate({ crossZoneTwin: false }), WINDOW, GATED)).toBe(true);
    expect(isDailyEligible(candidate(), WINDOW, GATED)).toBe(true);
  });

  it("composes with the other gates: every rule applies together", () => {
    const all = { politicsGate: true, englishGate: true, twinGate: true } as const;
    expect(isDailyEligible(candidate({ crossZoneTwin: true }), WINDOW, all)).toBe(false);
    expect(isDailyEligible(candidate({ category: "ekonomi" }), WINDOW, all)).toBe(false);
    expect(isDailyEligible(candidate({ crossZoneTwin: false }), WINDOW, all)).toBe(true);
  });
});

describe("DAILY_TWIN_GATE_FROM", () => {
  it("is a valid date key", () => {
    expect(isDateKey(DAILY_TWIN_GATE_FROM)).toBe(true);
  });

  // It must be a puzzle key no player has seen when this deploys: every key up
  // to today is replayable and recomputes from a cold cache, so a gate on or
  // before today would silently rewrite a puzzle that was already played. The
  // PR merges on 2026-11-09 (Istanbul), so the first unseen key is 2026-11-10.
  it("is not earlier than 2026-11-10, a key nobody has seen at deploy time", () => {
    expect(DAILY_TWIN_GATE_FROM >= "2026-11-10").toBe(true);
  });

  it("comes after the English gate, so the gates keep their order", () => {
    expect(DAILY_TWIN_GATE_FROM > DAILY_ENGLISH_GATE_FROM).toBe(true);
  });
});

describe("DAILY_TWIN_KEY_V2_FROM", () => {
  it("is a valid date key", () => {
    expect(isDateKey(DAILY_TWIN_KEY_V2_FROM)).toBe(true);
  });

  // Same replay contract as the gates: every key up to the deploy day is
  // replayable and recomputes from a cold cache, so the key that switches the
  // twin key to version 2 must be one no player has seen. The change was built on
  // 2026-11-10 (Istanbul), whose key is already served, so 2026-11-11 is the
  // lowest value that can ever be right. The shipped value is later (the merge is
  // expected on 2026-11-11); raise it, never lower it, if the deploy slips.
  it("is not earlier than 2026-11-11, a key nobody has seen at deploy time", () => {
    expect(DAILY_TWIN_KEY_V2_FROM >= "2026-11-11").toBe(true);
  });

  it("comes after DAILY_TWIN_GATE_FROM, so the first gated days keep the version 1 key they were served with", () => {
    expect(DAILY_TWIN_KEY_V2_FROM > DAILY_TWIN_GATE_FROM).toBe(true);
  });
});

describe("dailyTwinKeyVersion", () => {
  it("is 1 for every key below DAILY_TWIN_KEY_V2_FROM, however far back", () => {
    expect(dailyTwinKeyVersion(DAILY_GAME_EPOCH)).toBe(1);
    expect(dailyTwinKeyVersion(DAILY_POLITICS_GATE_FROM)).toBe(1);
    expect(dailyTwinKeyVersion(DAILY_TWIN_GATE_FROM)).toBe(1);
    expect(dailyTwinKeyVersion(addDays(DAILY_TWIN_KEY_V2_FROM, -1))).toBe(1);
    expect(dailyTwinKeyVersion("2000-01-01")).toBe(1);
  });

  it("is 2 from DAILY_TWIN_KEY_V2_FROM on", () => {
    expect(dailyTwinKeyVersion(DAILY_TWIN_KEY_V2_FROM)).toBe(2);
    expect(dailyTwinKeyVersion(addDays(DAILY_TWIN_KEY_V2_FROM, 1))).toBe(2);
    expect(dailyTwinKeyVersion(addDays(DAILY_TWIN_KEY_V2_FROM, 365))).toBe(2);
  });

  it("switches on exactly one day", () => {
    const before = addDays(DAILY_TWIN_KEY_V2_FROM, -1);
    expect([dailyTwinKeyVersion(before), dailyTwinKeyVersion(DAILY_TWIN_KEY_V2_FROM)]).toEqual([1, 2]);
  });
});

describe("DAILY_POLITICS_GATE_FROM", () => {
  it("is a valid date key", () => {
    expect(isDateKey(DAILY_POLITICS_GATE_FROM)).toBe(true);
  });

  it("is not earlier than the first puzzle date after the gate was designed (2026-11-02)", () => {
    expect(DAILY_POLITICS_GATE_FROM >= "2026-11-02").toBe(true);
  });
});

describe("DAILY_ENGLISH_GATE_FROM", () => {
  it("is a valid date key", () => {
    expect(isDateKey(DAILY_ENGLISH_GATE_FROM)).toBe(true);
  });

  // It must be a puzzle key no player has seen when this deploys: every key up
  // to today is replayable and recomputes from a cold cache, so a gate on or
  // before today would silently rewrite a puzzle that was already played.
  it("is not earlier than 2026-11-05, a key nobody has seen at deploy time", () => {
    expect(DAILY_ENGLISH_GATE_FROM >= "2026-11-05").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pickDailySet
// ---------------------------------------------------------------------------

const ZONE_BIAS: Record<"iktidar" | "bagimsiz" | "muhalefet", BiasCategory> = {
  iktidar: "pro_government",
  bagimsiz: "center",
  muhalefet: "opposition",
};

// Builds a pool of `n` eligible candidates whose window fields match
// `key`'s own puzzleWindow — since the window shifts by exactly one day
// between consecutive keys, a pool built for one key is NOT eligible under
// a different key, so every pool consumer below must pass the SAME key to
// both `pool()` and `pickDailySet()` unless the test explicitly wants to
// compare two same-shaped-but-differently-windowed pools (see "different
// keys give different sets" below).
function pool(key: string, n: number): DailyCandidate[] {
  const zones: Array<"iktidar" | "bagimsiz" | "muhalefet"> = ["iktidar", "bagimsiz", "muhalefet"];
  const w = puzzleWindow(key);
  return Array.from({ length: n }, (_, i) => {
    const zone = zones[i % 3]!;
    return candidate({
      articleId: `aaaaaaaa-aaaa-aaaa-aaaa-${String(i).padStart(12, "0")}`,
      title: title(`Siyasi gündemde bugün ${i}. önemli bir gelişme yaşandı`),
      publishedAt: w.startIso,
      createdAt: w.startIso,
      clusterId: `cluster-${i}`,
      source: source({
        id: `source-${i}`,
        name: `Kaynak ${i}`,
        slug: `kaynak-${i}`,
        bias: ZONE_BIAS[zone],
      }),
    });
  });
}

function shuffled<T>(arr: readonly T[], seed: number): T[] {
  const copy = [...arr];
  let s = seed;
  for (let i = copy.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

describe("pickDailySet", () => {
  const KEY2 = "2026-09-30";

  it("returns exactly 5 headlines, 1-2 per zone, distinct sources and clusters", () => {
    const result = pickDailySet(KEY2, pool(KEY2, 30));
    expect(result).not.toBeNull();
    expect(result).toHaveLength(DAILY_GAME_SIZE);

    const zoneCounts: Record<string, number> = {};
    const sourceIds = new Set<string>();
    const clusterIds = new Set<string>();
    for (const h of result!) {
      zoneCounts[h.zone] = (zoneCounts[h.zone] ?? 0) + 1;
      expect(sourceIds.has(h.sourceId)).toBe(false);
      sourceIds.add(h.sourceId);
      if (h.clusterId) {
        expect(clusterIds.has(h.clusterId)).toBe(false);
        clusterIds.add(h.clusterId);
      }
    }
    for (const zone of ["iktidar", "bagimsiz", "muhalefet"]) {
      const count = zoneCounts[zone] ?? 0;
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(DAILY_MAX_PER_ZONE);
    }
  });

  it("is invariant to input order (shuffled 20 times)", () => {
    const base = pool(KEY2, 30);
    const first = pickDailySet(KEY2, base);
    expect(first).not.toBeNull();
    const firstIds = first!.map((h) => h.articleId);

    for (let seed = 1; seed <= 20; seed++) {
      const result = pickDailySet(KEY2, shuffled(base, seed));
      expect(result).not.toBeNull();
      expect(result!.map((h) => h.articleId)).toEqual(firstIds);
    }
  });

  it("is prefix-consistent: a hash-ordered prefix that already yields 5 matches the full list", () => {
    const base = pool(KEY2, 60);
    const full = pickDailySet(KEY2, base);
    expect(full).not.toBeNull();

    // Sort the pool by dailyHash the same way pickDailySet does internally,
    // then grow a prefix until it independently yields a full set.
    const sortedIds = [...base].sort(
      (a, b) => dailyHash(KEY2, a.articleId) - dailyHash(KEY2, b.articleId),
    );
    let minPrefixResult: ReturnType<typeof pickDailySet> = null;
    for (let n = DAILY_GAME_SIZE; n <= sortedIds.length; n++) {
      const attempt = pickDailySet(KEY2, sortedIds.slice(0, n));
      if (attempt) {
        minPrefixResult = attempt;
        break;
      }
    }
    expect(minPrefixResult).not.toBeNull();
    expect(minPrefixResult!.map((h) => h.articleId).sort()).toEqual(
      full!.map((h) => h.articleId).sort(),
    );
  });

  it("returns null when a zone has no eligible candidate", () => {
    const onlyTwoZones = pool(KEY2, 30).filter((c) => c.source.bias !== "opposition");
    expect(pickDailySet(KEY2, onlyTwoZones)).toBeNull();
  });

  it("the display order is not zone-grouped for a crafted fixture", () => {
    // Build exactly 5 candidates so pickDailySet's selection is forced, and
    // check the OUTPUT order differs from the selection-phase zone order
    // (iktidar, iktidar-or-bagimsiz, bagimsiz, muhalefet, muhalefet) for at
    // least one key — i.e. dailyHash(`${key}|order`, ...) really reorders.
    let foundNonGrouped = false;
    for (let k = 0; k < 40; k++) {
      const key = `2027-01-${String((k % 27) + 1).padStart(2, "0")}`;
      const result = pickDailySet(key, pool(key, 12));
      if (!result) continue;
      const zones = result.map((h) => h.zone);
      const isGrouped = zones.every((z, i) => i === 0 || z === zones[i - 1] || true);
      // A stronger, direct check: the zone sequence is not sorted according
      // to the fixed selection order (iktidar < bagimsiz < muhalefet).
      const order: Record<string, number> = { iktidar: 0, bagimsiz: 1, muhalefet: 2 };
      const sortedByPriority = [...zones].sort((a, b) => order[a]! - order[b]!);
      if (JSON.stringify(zones) !== JSON.stringify(sortedByPriority)) {
        foundNonGrouped = true;
      }
      void isGrouped;
    }
    expect(foundNonGrouped).toBe(true);
  });

  it("different keys give different sets on a 60-candidate pool", () => {
    const keyA = "2026-11-01";
    const keyB = "2026-11-02";
    // Same articleIds/sources/clusters in both pools (only the window-
    // matching timestamps differ) — dailyHash depends on (key, articleId)
    // only, so any difference in the resulting set is attributable purely
    // to the key, not to different candidate shapes.
    const a = pickDailySet(keyA, pool(keyA, 60));
    const b = pickDailySet(keyB, pool(keyB, 60));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.map((h) => h.articleId)).not.toEqual(b!.map((h) => h.articleId));
  });
});

describe("pickDailySet — politics gate", () => {
  // pool(key, 60) with every 2nd candidate (the odd indices) re-categorised
  // as ekonomi. Zones cycle i % 3, so politika (even i) still spans all three.
  function mixedPool(key: string): DailyCandidate[] {
    return pool(key, 60).map((c, i) =>
      i % 2 === 1 ? { ...c, category: "ekonomi" } : c,
    );
  }
  const allPolitika = (cs: readonly DailyCandidate[]): DailyCandidate[] =>
    cs.map((c) => ({ ...c, category: "politika" }));
  const ekonomiIds = (cs: readonly DailyCandidate[]): Set<string> =>
    new Set(cs.filter((c) => c.category === "ekonomi").map((c) => c.articleId));

  const PRE_GATE_KEYS = Array.from({ length: 7 }, (_, i) =>
    addDays(DAILY_POLITICS_GATE_FROM, -(i + 1)),
  );

  it("past puzzles are byte-identical to the ungated pick (cold-cache recompute is stable)", () => {
    for (const key of PRE_GATE_KEYS) {
      const mixed = mixedPool(key);
      expect(pickDailySet(key, mixed)).toEqual(pickDailySet(key, allPolitika(mixed)));
    }
  });

  it("the pre-gate byte-stability check is not vacuous: a past set still contains an ekonomi article", () => {
    const hits = PRE_GATE_KEYS.filter((key) => {
      const mixed = mixedPool(key);
      const result = pickDailySet(key, mixed);
      const ids = ekonomiIds(mixed);
      return result !== null && result.some((h) => ids.has(h.articleId));
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it.each([0, 1, 3])("from the gate date onward (+%i days) no ekonomi candidate is picked", (offset) => {
    const key = addDays(DAILY_POLITICS_GATE_FROM, offset);
    const mixed = mixedPool(key);
    const result = pickDailySet(key, mixed);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(DAILY_GAME_SIZE);
    const ids = ekonomiIds(mixed);
    expect(result!.some((h) => ids.has(h.articleId))).toBe(false);
  });

  it("a gated day is not affected by ekonomi rows being present at all (same set as an ekonomi-free pool)", () => {
    const key = DAILY_POLITICS_GATE_FROM;
    const mixed = mixedPool(key);
    const politikaOnly = mixed.filter((c) => c.category === "politika");
    expect(pickDailySet(key, mixed)).toEqual(pickDailySet(key, politikaOnly));
  });
});

describe("pickDailySet -- english gate", () => {
  const ENGLISH_SLUGS = [...ENGLISH_SOURCE_SLUGS];
  const ZONE_CYCLE = ["pro_government", "center", "opposition"] as const;

  // 30 politika candidates; every even index is an English-language outlet
  // (cycling through the five registered slugs), every odd index a Turkish one.
  // Zones cycle i % 3, so the Turkish half alone still covers all three zones.
  function mixedLanguagePool(key: string): DailyCandidate[] {
    const w = puzzleWindow(key);
    return Array.from({ length: 30 }, (_, i) =>
      candidate({
        articleId: `aaaaaaaa-aaaa-aaaa-aaaa-${String(i).padStart(12, "0")}`,
        title: title(`Siyasi gündemde bugün ${i}. önemli bir gelişme yaşandı`),
        publishedAt: w.startIso,
        createdAt: w.startIso,
        clusterId: `cluster-${i}`,
        source: source({
          id: `source-${i}`,
          name: `Kaynak ${i}`,
          slug: i % 2 === 0 ? (ENGLISH_SLUGS[(i / 2) % ENGLISH_SLUGS.length] as string) : `kaynak-${i}`,
          bias: ZONE_CYCLE[i % 3] as BiasCategory,
        }),
      }),
    );
  }

  const idOf = (i: number): string => `aaaaaaaa-aaaa-aaaa-aaaa-${String(i).padStart(12, "0")}`;

  // Snapshotted from the code as it was BEFORE the English rule existed
  // (display order matters). These keys are all earlier than
  // DAILY_ENGLISH_GATE_FROM, so the sets players already saw must not move,
  // even though each contains English-language outlets.
  const PRE_GATE_SNAPSHOT: ReadonlyArray<readonly [string, readonly number[]]> = [
    ["2026-10-30", [9, 8, 13, 18, 19]],
    ["2026-11-03", [19, 18, 11, 10, 12]],
    // After the politics gate, before the English gate.
    ["2026-11-04", [20, 25, 24, 27, 26]],
  ];

  it.each(PRE_GATE_SNAPSHOT)(
    "key %s (before DAILY_ENGLISH_GATE_FROM) returns exactly the pre-change set, English outlets included",
    (key, indexes) => {
      expect(key < DAILY_ENGLISH_GATE_FROM).toBe(true);
      const result = pickDailySet(key, mixedLanguagePool(key));

      expect(result).not.toBeNull();
      expect(result!.map((h) => h.articleId)).toEqual(indexes.map(idOf));
      // Not vacuous: each snapshot really does contain an English outlet.
      expect(result!.some((h) => ENGLISH_SOURCE_SLUGS.has(h.sourceSlug))).toBe(true);
    },
  );

  it.each([0, 1, 2, 10])(
    "from the gate date onward (+%i days) no English-language outlet is ever picked",
    (offset) => {
      const key = addDays(DAILY_ENGLISH_GATE_FROM, offset);
      const result = pickDailySet(key, mixedLanguagePool(key));

      expect(result).not.toBeNull();
      expect(result).toHaveLength(DAILY_GAME_SIZE);
      for (const headline of result!) {
        expect(ENGLISH_SOURCE_SLUGS.has(headline.sourceSlug)).toBe(false);
      }
    },
  );

  it("a gated day equals the pick from the Turkish-only half of the pool", () => {
    const key = DAILY_ENGLISH_GATE_FROM;
    const mixed = mixedLanguagePool(key);
    const turkishOnly = mixed.filter((c) => !ENGLISH_SOURCE_SLUGS.has(c.source.slug));

    expect(turkishOnly).toHaveLength(15);
    expect(pickDailySet(key, mixed)).toEqual(pickDailySet(key, turkishOnly));
  });

  it("returns null on a gated day when only English outlets cover a zone", () => {
    const key = DAILY_ENGLISH_GATE_FROM;
    const noTurkishOpposition = mixedLanguagePool(key).filter(
      (c) => c.source.bias !== "opposition" || ENGLISH_SOURCE_SLUGS.has(c.source.slug),
    );

    expect(pickDailySet(key, noTurkishOpposition)).toBeNull();
    // The same pool is still playable on a pre-gate day: the rule is gated on the key.
    const preKey = addDays(DAILY_ENGLISH_GATE_FROM, -1);
    const preFiltered = mixedLanguagePool(preKey).filter(
      (c) => c.source.bias !== "opposition" || ENGLISH_SOURCE_SLUGS.has(c.source.slug),
    );
    expect(pickDailySet(preKey, preFiltered)).not.toBeNull();
  });
});

describe("pickDailySet -- twin gate", () => {
  /**
   * `pool(key, 12)` with the dailyHash-first candidate flagged a cross-zone
   * twin. It is the first of its zone in hash order, so a pick that may use it
   * always does.
   */
  function poolWithHashFirstTwin(key: string): { all: DailyCandidate[]; twinId: string } {
    const all = pool(key, 12);
    const twin = [...all].sort((a, b) => dailyHash(key, a.articleId) - dailyHash(key, b.articleId))[0]!;
    return {
      all: all.map((c) => (c.articleId === twin.articleId ? { ...c, crossZoneTwin: true } : c)),
      twinId: twin.articleId,
    };
  }

  it.each([0, 1, 5])("excludes a twin candidate on and after the gate (+%i days)", (offset) => {
    const key = addDays(DAILY_TWIN_GATE_FROM, offset);
    const { all, twinId } = poolWithHashFirstTwin(key);

    const result = pickDailySet(key, all);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(DAILY_GAME_SIZE);
    expect(result!.some((h) => h.articleId === twinId)).toBe(false);
  });

  it("includes the same twin candidate the day before the gate (the sets players saw do not move)", () => {
    const key = addDays(DAILY_TWIN_GATE_FROM, -1);
    expect(key < DAILY_TWIN_GATE_FROM).toBe(true);
    const { all, twinId } = poolWithHashFirstTwin(key);

    const result = pickDailySet(key, all);

    expect(result).not.toBeNull();
    expect(result!.some((h) => h.articleId === twinId)).toBe(true);
  });

  it("a pre-gate puzzle is byte-identical with and without the twin flag", () => {
    for (let back = 1; back <= 7; back++) {
      const key = addDays(DAILY_TWIN_GATE_FROM, -back);
      const { all } = poolWithHashFirstTwin(key);
      const unflagged = all.map(({ crossZoneTwin: _flag, ...rest }) => rest);

      expect(pickDailySet(key, all)).toEqual(pickDailySet(key, unflagged));
    }
  });

  it("a gated day equals the pick from the pool without the twin candidates", () => {
    const key = DAILY_TWIN_GATE_FROM;
    const { all } = poolWithHashFirstTwin(key);
    const withoutTwins = all.filter((c) => c.crossZoneTwin !== true);

    expect(pickDailySet(key, all)).toEqual(pickDailySet(key, withoutTwins));
  });

  it("returns null on a gated day when twins leave a zone empty, but not on the day before", () => {
    const key = DAILY_TWIN_GATE_FROM;
    const flagMuhalefet = (candidates: DailyCandidate[]) =>
      candidates.map((c) => (c.source.bias === "opposition" ? { ...c, crossZoneTwin: true } : c));

    expect(pickDailySet(key, flagMuhalefet(pool(key, 12)))).toBeNull();
    const preKey = addDays(key, -1);
    expect(pickDailySet(preKey, flagMuhalefet(pool(preKey, 12)))).not.toBeNull();
  });
});

describe("isDateKey", () => {
  it("accepts a valid date", () => {
    expect(isDateKey("2026-09-28")).toBe(true);
  });

  it("rejects a calendrically invalid date", () => {
    expect(isDateKey("2026-02-30")).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(isDateKey(undefined)).toBe(false);
    expect(isDateKey(123)).toBe(false);
  });

  it("rejects a malformed string", () => {
    expect(isDateKey("28-09-2026")).toBe(false);
  });
});
