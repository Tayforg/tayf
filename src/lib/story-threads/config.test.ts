import { describe, it, expect, afterEach } from "vitest";

import {
  STORY_THREAD_CRON,
  STORY_THREAD_TITLE_MAX,
  STORY_THREAD_TITLE_MIN,
  isStoryThreadsEnabled,
  isValidThreadSlug,
  threadSlug,
  validateThreadTitle,
} from "./config";

const ID = "a1b2c3d4-0000-4000-8000-000000000000";

describe("threadSlug", () => {
  it("transliterates Turkish letters and appends 6 hex of the id", () => {
    expect(threadSlug("Sarpyener fon soruşturması: yeni gözaltılar", ID)).toBe(
      "sarpyener-fon-sorusturmasi-yeni-gozaltilar-a1b2c3",
    );
  });

  it("handles dotted/dotless i in both cases", () => {
    expect(threadSlug("İstanbul ILIK ışık Çığ Öğün Şükür", ID)).toBe(
      "istanbul-ilik-isik-cig-ogun-sukur-a1b2c3",
    );
  });

  it("transliterates circumflex vowels", () => {
    expect(threadSlug("Hâdise îtiraf ûlema", ID)).toBe("hadise-itiraf-ulema-a1b2c3");
  });

  it("cuts the base to 60 characters and strips a trailing dash", () => {
    const slug = threadSlug("a".repeat(59) + " bbbbbbbb", ID);
    expect(slug).toBe(`${"a".repeat(59)}-a1b2c3`);
    const long = threadSlug("kelime ".repeat(30), ID);
    const base = long.slice(0, -"-a1b2c3".length);
    expect(base.length).toBeLessThanOrEqual(60);
    expect(base.endsWith("-")).toBe(false);
    expect(isValidThreadSlug(long)).toBe(true);
  });

  it("falls back to hikaye-<6hex> for an all-symbol or too-short title", () => {
    expect(threadSlug("!!! ??? ***", ID)).toBe("hikaye-a1b2c3");
    expect(threadSlug("ab", ID)).toBe("hikaye-a1b2c3");
  });

  it("removes dashes from the id before taking hex", () => {
    expect(threadSlug("Merhaba dünya", "ab-cd-ef-1234")).toBe("merhaba-dunya-abcdef");
  });
});

describe("isValidThreadSlug", () => {
  it("accepts lowercase dash-separated slugs of 3..80 chars", () => {
    expect(isValidThreadSlug("abc")).toBe(true);
    expect(isValidThreadSlug("sarpyener-fon-a1b2c3")).toBe(true);
    expect(isValidThreadSlug("a".repeat(80))).toBe(true);
  });
  it("rejects bad shapes", () => {
    for (const s of ["ab", "a".repeat(81), "Abc", "a--b", "-abc", "abc-", "a b c", "../x", "", "a_b_c"]) {
      expect(isValidThreadSlug(s)).toBe(false);
    }
    expect(isValidThreadSlug(undefined as unknown as string)).toBe(false);
    expect(isValidThreadSlug(5 as unknown as string)).toBe(false);
  });
});

describe("validateThreadTitle", () => {
  it("trims and returns valid titles", () => {
    expect(validateThreadTitle("  Sarpyener soruşturması  ")).toBe("Sarpyener soruşturması");
  });
  it("enforces the 8..140 bounds", () => {
    expect(validateThreadTitle("a".repeat(STORY_THREAD_TITLE_MIN - 1))).toBeNull();
    expect(validateThreadTitle("a".repeat(STORY_THREAD_TITLE_MIN))).not.toBeNull();
    expect(validateThreadTitle("a".repeat(STORY_THREAD_TITLE_MAX))).not.toBeNull();
    expect(validateThreadTitle("a".repeat(STORY_THREAD_TITLE_MAX + 1))).toBeNull();
    expect(validateThreadTitle("a".repeat(141))).toBeNull();
    expect(validateThreadTitle("a".repeat(7))).toBeNull();
  });
  it("rejects control characters and non-strings", () => {
    expect(validateThreadTitle("başlık\nikinci satır")).toBeNull();
    expect(validateThreadTitle("başlık\u0000sonrası")).toBeNull();
    expect(validateThreadTitle("başlık\u007fsonrası")).toBeNull();
    for (const v of [null, undefined, 5, {}, []]) expect(validateThreadTitle(v)).toBeNull();
  });
  it("measures length after trimming", () => {
    expect(validateThreadTitle("   abc   ")).toBeNull();
  });
});

describe("isStoryThreadsEnabled", () => {
  const ORIGINAL = process.env.STORY_THREADS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.STORY_THREADS;
    else process.env.STORY_THREADS = ORIGINAL;
  });
  it("is on unless STORY_THREADS is exactly 'off'", () => {
    delete process.env.STORY_THREADS;
    expect(isStoryThreadsEnabled()).toBe(true);
    process.env.STORY_THREADS = "on";
    expect(isStoryThreadsEnabled()).toBe(true);
    process.env.STORY_THREADS = "off";
    expect(isStoryThreadsEnabled()).toBe(false);
  });
});

describe("constants", () => {
  it("cron literal", () => {
    expect(STORY_THREAD_CRON).toBe("53 1 * * *");
  });
});
