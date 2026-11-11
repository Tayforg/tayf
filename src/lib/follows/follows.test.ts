import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// topic-query.ts imports next/cache at module scope; the parity test below only
// needs its exported constants (same stub as src/app/konu/[slug]/page.test.tsx).
vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

import {
  addFollow,
  canonicalFollow,
  countNew,
  FOLLOW_TOPIC_LABELS,
  FOLLOW_TOPIC_SLUGS,
  FOLLOWS_CHANGE_EVENT,
  FOLLOWS_KEY,
  followApiPath,
  focusTargetAfterRemove,
  followEmptyText,
  followHref,
  followKey,
  followLabel,
  followListCaption,
  followRowMeta,
  followRowsToShow,
  hasFollow,
  isFollowGundemKey,
  isFollowTopicSlug,
  isNewItem,
  KEYWORD_MAX,
  KEYWORD_MIN,
  keywordIdentity,
  keywordRejectReason,
  markSeen,
  MAX_FOLLOWS,
  normalizeFollowValue,
  normalizeKeyword,
  parseFollowItems,
  parseFollowKey,
  parseStoredFollows,
  RAW_MAX,
  removeFollow,
  runWithConcurrency,
  SEARCH_FOLD_FROM,
  SEARCH_FOLD_TO,
  serializeFollows,
  type Follow,
  type FollowItem,
} from "./follows";
import { TOPIC_LABELS_TR, TOPIC_SLUGS } from "@/lib/clusters/topic-query";
import {
  foldTr,
  MAX_SEARCH_QUERY_LENGTH,
  pgLower,
  SEARCH_FOLD_FROM as QUERY_FOLD_FROM,
  SEARCH_FOLD_TO as QUERY_FOLD_TO,
} from "@/lib/clusters/turkish-query";
import { formatTurkishTimeAgo } from "@/lib/time";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";

const NOW = "2026-10-22T09:00:00.000Z";

function q(value: string, over: Partial<Follow> = {}): Follow {
  return { kind: "q", value, addedAt: NOW, seenAt: NOW, seenIds: null, seenFloor: null, ...over };
}
function konu(value: string, over: Partial<Follow> = {}): Follow {
  return { kind: "konu", value, addedAt: NOW, seenAt: NOW, seenIds: null, seenFloor: null, ...over };
}
function gundem(value: string, over: Partial<Follow> = {}): Follow {
  return { kind: "gundem", value, addedAt: NOW, seenAt: NOW, seenIds: null, seenFloor: null, ...over };
}

describe("constants", () => {
  it("pins the storage contract", () => {
    expect(FOLLOWS_KEY).toBe("tayf:follows");
    expect(FOLLOWS_CHANGE_EVENT).toBe("tayf:follows-change");
    expect(MAX_FOLLOWS).toBe(20);
    expect(KEYWORD_MIN).toBe(2);
    expect(RAW_MAX).toBe(200);
  });

  // follows.ts may not import turkish-query (client-bundle whitelist), so the
  // two numbers are tied together here instead. A follow longer than the
  // archive's own cut would silently search something else; a follow shorter
  // than it hides "Takip et" for searches the archive really runs (h60-forms-3).
  it("offers a follow for every search the archive actually runs (KEYWORD_MAX === MAX_SEARCH_QUERY_LENGTH)", () => {
    expect(KEYWORD_MAX).toBe(MAX_SEARCH_QUERY_LENGTH);
  });

  it("mirrors topic-query's slugs and labels exactly (parity guard)", () => {
    expect([...FOLLOW_TOPIC_SLUGS]).toEqual([...TOPIC_SLUGS]);
    expect(FOLLOW_TOPIC_LABELS).toEqual(TOPIC_LABELS_TR);
  });
});

describe("normalizeKeyword", () => {
  // h112-follows-2: the stored value is the DISPLAY form and keeps the reader's
  // case; two spellings of one keyword are told apart by keywordIdentity.
  it("trims and keeps the reader's case (no Turkish lower-casing of the display value)", () => {
    expect(normalizeKeyword("  İMAMOĞLU  ")).toBe("İMAMOĞLU");
    expect(normalizeKeyword("ISPARTA")).toBe("ISPARTA");
    expect(normalizeKeyword("IMF")).toBe("IMF");
  });

  it("collapses runs of whitespace (including tabs and newlines) to one space", () => {
    expect(normalizeKeyword("Asgari   Ücret")).toBe("Asgari Ücret");
    expect(normalizeKeyword("asgari\t\n ücret")).toBe("asgari ücret");
  });

  it("normalises to NFC", () => {
    const nfd = "ü"; // u + combining diaeresis
    const out = normalizeKeyword(`${nfd}cret`);
    expect(out).toBe("ücret");
    expect(out).toBe("ücret".normalize("NFC"));
  });

  it("counts code points, not UTF-16 units, against the 2..KEYWORD_MAX window", () => {
    expect(normalizeKeyword("ab")).toBe("ab");
    expect(normalizeKeyword("🙂🙂")).toBe("🙂🙂"); // 2 code points, 4 units
    expect(normalizeKeyword("🙂")).toBeNull(); // 1 code point
    expect(normalizeKeyword("a".repeat(KEYWORD_MAX))).toBe("a".repeat(KEYWORD_MAX));
    expect(normalizeKeyword("🙂".repeat(KEYWORD_MAX))).toBe("🙂".repeat(KEYWORD_MAX));
    expect(normalizeKeyword("🙂".repeat(KEYWORD_MAX + 1))).toBeNull();
  });

  it("accepts a 41..64 character search and rejects 65 (h60-forms-3)", () => {
    const real = "Cumhurbaşkanı Erdoğan Azerbaycan'a gidecek";
    expect([...real]).toHaveLength(42);
    // The reader's capitals are kept.
    expect(normalizeKeyword(real)).toBe(real);
    expect(normalizeKeyword("a".repeat(41))).toBe("a".repeat(41));
    expect(normalizeKeyword("a".repeat(64))).toBe("a".repeat(64));
    expect(normalizeKeyword("a".repeat(65))).toBeNull();
  });

  it("rejects too short, too long, control characters and over-long raw input", () => {
    expect(normalizeKeyword("a")).toBeNull();
    expect(normalizeKeyword("  a  ")).toBeNull();
    expect(normalizeKeyword("")).toBeNull();
    expect(normalizeKeyword("   ")).toBeNull();
    expect(normalizeKeyword("a".repeat(KEYWORD_MAX + 1))).toBeNull();
    expect(normalizeKeyword("\u0000ab")).toBeNull();
    expect(normalizeKeyword("ab\u007f")).toBeNull();
    expect(normalizeKeyword("a".repeat(201))).toBeNull();
    // The raw cap applies BEFORE trimming: 200 chars of padding + a word is out.
    expect(normalizeKeyword(`${" ".repeat(RAW_MAX)}ab`)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(normalizeKeyword(123)).toBeNull();
    expect(normalizeKeyword(null)).toBeNull();
    expect(normalizeKeyword(undefined)).toBeNull();
    expect(normalizeKeyword({})).toBeNull();
    expect(normalizeKeyword(["ab"])).toBeNull();
  });

  it("rejects lone surrogates (encodeURIComponent would throw on them)", () => {
    expect(normalizeKeyword("ab\ud800")).toBeNull();
    expect(normalizeKeyword("\udc00ab")).toBeNull();
  });

  it("keeps SQL / markup characters verbatim (escaping is the renderer's job)", () => {
    expect(normalizeKeyword("a'; drop--")).toBe("a'; drop--");
    expect(normalizeKeyword("<b>ab</b>")).toBe("<b>ab</b>");
  });

  it("is idempotent", () => {
    for (const raw of ["  İMAMOĞLU  ", "Asgari   Ücret", "ISPARTA", "ẍyz"]) {
      const once = normalizeKeyword(raw);
      expect(once).not.toBeNull();
      expect(normalizeKeyword(once)).toBe(once);
    }
  });
});

describe("keywordRejectReason", () => {
  it("is null exactly when normalizeKeyword accepts the input", () => {
    for (const raw of [
      "seçim",
      "  İMAMOĞLU  ",
      "ab",
      "a".repeat(KEYWORD_MAX),
      "🙂🙂",
      "cumhurbaşkanı erdoğan azerbaycan'a gidecek",
    ]) {
      expect(normalizeKeyword(raw)).not.toBeNull();
      expect(keywordRejectReason(raw)).toBeNull();
    }
  });

  it("says 'too-long' above KEYWORD_MAX and for raw input over RAW_MAX", () => {
    expect(keywordRejectReason("a".repeat(KEYWORD_MAX + 1))).toBe("too-long");
    expect(keywordRejectReason("🙂".repeat(KEYWORD_MAX + 1))).toBe("too-long");
    expect(keywordRejectReason("a".repeat(RAW_MAX + 1))).toBe("too-long");
    // Padding that collapses away is not length: 200 raw chars, 2 kept.
    expect(keywordRejectReason(`ab${" ".repeat(RAW_MAX - 2)}`)).toBeNull();
  });

  it("says 'too-short' below KEYWORD_MIN, including whitespace-only and empty input", () => {
    expect(keywordRejectReason("a")).toBe("too-short");
    expect(keywordRejectReason("  a  ")).toBe("too-short");
    expect(keywordRejectReason("🙂")).toBe("too-short");
    expect(keywordRejectReason("")).toBe("too-short");
    expect(keywordRejectReason("   ")).toBe("too-short");
  });

  it("says 'invalid' for control characters, lone surrogates and non-strings", () => {
    expect(keywordRejectReason("\u0000ab")).toBe("invalid");
    expect(keywordRejectReason("ab\u007f")).toBe("invalid");
    expect(keywordRejectReason("ab\ud800")).toBe("invalid");
    expect(keywordRejectReason(123)).toBe("invalid");
    expect(keywordRejectReason(null)).toBe("invalid");
    expect(keywordRejectReason(undefined)).toBe("invalid");
    expect(keywordRejectReason({})).toBe("invalid");
  });

  it("checks forbidden characters before length, like normalizeKeyword", () => {
    // NUL is not whitespace, so it survives the collapse and is judged first.
    expect(keywordRejectReason(`\u0000${"a".repeat(KEYWORD_MAX + 1)}`)).toBe("invalid");
  });
});

describe("isFollowTopicSlug / normalizeFollowValue", () => {
  it("accepts exactly the six hub slugs", () => {
    for (const s of FOLLOW_TOPIC_SLUGS) expect(isFollowTopicSlug(s)).toBe(true);
    expect(FOLLOW_TOPIC_SLUGS).toHaveLength(6);
  });

  it("rejects politika, traversal, casing variants and non-strings", () => {
    expect(isFollowTopicSlug("politika")).toBe(false);
    expect(isFollowTopicSlug("../x")).toBe(false);
    expect(isFollowTopicSlug("Ekonomi")).toBe(false);
    expect(isFollowTopicSlug("")).toBe(false);
    expect(isFollowTopicSlug(null)).toBe(false);
    expect(isFollowTopicSlug(42)).toBe(false);
  });

  it("normalizeFollowValue dispatches on kind", () => {
    expect(normalizeFollowValue("q", "  SEÇİM ")).toBe("SEÇİM");
    expect(normalizeFollowValue("q", "a")).toBeNull();
    expect(normalizeFollowValue("konu", "ekonomi")).toBe("ekonomi");
    expect(normalizeFollowValue("konu", "Ekonomi")).toBeNull();
    expect(normalizeFollowValue("konu", "politika")).toBeNull();
  });
});

describe("followKey / href / label / apiPath", () => {
  it("builds a kind-prefixed key (a keyword's key is its identity, see the h112-follows-2 block)", () => {
    expect(followKey(q("seçim"))).toBe("q:secim");
    expect(followKey(konu("spor"))).toBe("konu:spor");
  });

  it("builds the destination href", () => {
    expect(followHref(q("asgari ücret"))).toBe("/?q=asgari%20%C3%BCcret");
    expect(followHref(q("a&b=c#d"))).toBe("/?q=a%26b%3Dc%23d");
    expect(followHref(konu("ekonomi"))).toBe("/konu/ekonomi");
  });

  it("builds the label", () => {
    expect(followLabel(q("seçim"))).toBe("“seçim”");
    expect(followLabel(konu("yasam"))).toBe("Yaşam");
    expect(followLabel(konu("dunya"))).toBe("Dünya");
  });

  it("builds the API path with an encoded keyword", () => {
    expect(followApiPath(q("asgari ücret"))).toBe(
      "/api/takip?q=asgari%20%C3%BCcret",
    );
    expect(followApiPath(q("a&konu=spor"))).toBe("/api/takip?q=a%26konu%3Dspor");
    expect(followApiPath(konu("teknoloji"))).toBe("/api/takip?konu=teknoloji");
  });
});

// A keyword search has no date window and ranks by corroboration, while a
// topic read is the last 7 days newest-first -- the copy must not promise
// "recent" for a keyword.
describe("followEmptyText / followListCaption", () => {
  it("does not claim a time window for a keyword follow", () => {
    expect(followEmptyText("q")).toBe("Eşleşen hikâye bulunamadı.");
    expect(followEmptyText("q")).not.toMatch(/son/i);
  });

  it("keeps the recent-window wording for a topic follow", () => {
    expect(followEmptyText("konu")).toBe("Son dönemde eşleşen hikâye yok.");
  });

  it("labels a keyword list as corroboration-ranked; a topic list needs no caption", () => {
    expect(followListCaption("q")).toBe("En çok kaynaklı eşleşmeler · yeniden eskiye");
    expect(followListCaption("konu")).toBeNull();
  });
});

describe("parseStoredFollows", () => {
  it("returns [] for null, bad JSON and non-arrays", () => {
    expect(parseStoredFollows(null)).toEqual([]);
    expect(parseStoredFollows("")).toEqual([]);
    expect(parseStoredFollows("{oops")).toEqual([]);
    expect(parseStoredFollows("{}")).toEqual([]);
    expect(parseStoredFollows("null")).toEqual([]);
    expect(parseStoredFollows('"seçim"')).toEqual([]);
    expect(parseStoredFollows("42")).toEqual([]);
  });

  it("drops invalid entries", () => {
    expect(parseStoredFollows('[1,null,{"kind":"x"}]')).toEqual([]);
    expect(
      parseStoredFollows(
        JSON.stringify([
          { kind: "q", value: "a" }, // too short
          { kind: "q", value: 5 },
          { kind: "konu", value: "politika" },
          { kind: "konu", value: "../x" },
          { kind: "q" },
          [],
          true,
        ]),
      ),
    ).toEqual([]);
  });

  it("treats a bare string as a legacy keyword and normalises it", () => {
    expect(parseStoredFollows('["Seçim"]')).toEqual([
      { kind: "q", value: "Seçim", addedAt: null, seenAt: null, seenIds: null, seenFloor: null },
    ]);
    expect(parseStoredFollows('["x"]')).toEqual([]);
  });

  it("round-trips a valid list", () => {
    const list = [q("seçim"), konu("ekonomi", { seenAt: null })];
    expect(parseStoredFollows(serializeFollows(list))).toEqual(list);
  });

  it("re-normalises stored keyword values", () => {
    // A non-hub keyword: "  İMAMOĞLU " now upgrades to the hub (see the legacy
    // upgrade block below), so the plain re-normalisation is pinned on a
    // keyword no hub is named after.
    const raw = JSON.stringify([
      { kind: "q", value: "  SEÇİM   SONUÇLARI ", addedAt: NOW, seenAt: NOW },
    ]);
    expect(parseStoredFollows(raw)[0]?.value).toBe("SEÇİM SONUÇLARI");
  });

  it("turns an unparseable addedAt / seenAt into null, and keeps a parseable one", () => {
    const raw = JSON.stringify([
      { kind: "q", value: "seçim", addedAt: "not a date", seenAt: 12345 },
      { kind: "konu", value: "spor", addedAt: NOW, seenAt: "" },
    ]);
    expect(parseStoredFollows(raw)).toEqual([
      { kind: "q", value: "seçim", addedAt: null, seenAt: null, seenIds: null, seenFloor: null },
      { kind: "konu", value: "spor", addedAt: NOW, seenAt: null, seenIds: null, seenFloor: null },
    ]);
  });

  it("collapses duplicates (first wins), including a legacy string vs object", () => {
    const raw = JSON.stringify([
      "Seçim",
      { kind: "q", value: "seçim", addedAt: NOW, seenAt: NOW },
      { kind: "konu", value: "spor", addedAt: NOW, seenAt: null },
      { kind: "konu", value: "spor", addedAt: null, seenAt: NOW },
    ]);
    const out = parseStoredFollows(raw);
    expect(out.map(followKey)).toEqual(["q:secim", "konu:spor"]);
    expect(out[0]?.addedAt).toBeNull(); // the legacy string came first
    expect(out[1]?.seenAt).toBeNull();
  });

  it("keeps only the first MAX_FOLLOWS of 25 valid entries", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      kind: "q",
      value: `kelime ${i}`,
      addedAt: NOW,
      seenAt: NOW,
    }));
    const out = parseStoredFollows(JSON.stringify(entries));
    expect(out).toHaveLength(MAX_FOLLOWS);
    expect(out[0]?.value).toBe("kelime 0");
    expect(out[19]?.value).toBe("kelime 19");
  });

  it("does not let duplicates or invalid entries eat into the cap", () => {
    const entries: unknown[] = [];
    for (let i = 0; i < 30; i++) entries.push({ kind: "q", value: "tekrar" });
    for (let i = 0; i < 30; i++) entries.push(7);
    for (let i = 0; i < 20; i++) entries.push({ kind: "q", value: `kelime ${i}` });
    const out = parseStoredFollows(JSON.stringify(entries));
    expect(out).toHaveLength(MAX_FOLLOWS);
    expect(out[0]?.value).toBe("tekrar");
    expect(out[19]?.value).toBe("kelime 18");
  });

  it("ignores prototype-pollution style keys", () => {
    const raw = '[{"kind":"q","value":"seçim","__proto__":{"polluted":true},"addedAt":null,"seenAt":null}]';
    const out = parseStoredFollows(raw);
    expect(out).toEqual([{ kind: "q", value: "seçim", addedAt: null, seenAt: null, seenIds: null, seenFloor: null }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("serializeFollows", () => {
  it("emits only the six Follow fields", () => {
    const withExtra = { ...q("seçim"), extra: "x" } as Follow;
    expect(JSON.parse(serializeFollows([withExtra]))).toEqual([
      { kind: "q", value: "seçim", addedAt: NOW, seenAt: NOW, seenIds: null, seenFloor: null },
    ]);
  });

  it("serialises an empty list as []", () => {
    expect(serializeFollows([])).toBe("[]");
  });
});

describe("addFollow", () => {
  it("adds a normalised keyword (the reader's case kept) with addedAt = seenAt = now", () => {
    const r = addFollow([], { kind: "q", value: "  SEÇİM " }, NOW);
    expect(r.result).toBe("added");
    expect(r.list).toEqual([q("SEÇİM")]);
  });

  it("adds a topic slug", () => {
    const r = addFollow([], { kind: "konu", value: "ekonomi" }, NOW);
    expect(r.result).toBe("added");
    expect(r.list).toEqual([konu("ekonomi")]);
  });

  it("reports exists (by normalised key) and leaves the list untouched", () => {
    const base = [q("seçim", { seenAt: "2026-10-01T00:00:00.000Z" })];
    const r = addFollow(base, { kind: "q", value: "SEÇİM" }, NOW);
    expect(r.result).toBe("exists");
    expect(r.list).toBe(base);
    expect(r.list[0]?.seenAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("treats the same text under a different kind as a different follow", () => {
    const r = addFollow([q("spor")], { kind: "konu", value: "spor" }, NOW);
    expect(r.result).toBe("added");
    expect(r.list).toHaveLength(2);
  });

  it("reports full at MAX_FOLLOWS, but exists wins for an already-followed entry", () => {
    const full = Array.from({ length: MAX_FOLLOWS }, (_, i) => q(`kelime ${i}`));
    const blocked = addFollow(full, { kind: "q", value: "yeni kelime" }, NOW);
    expect(blocked.result).toBe("full");
    expect(blocked.list).toBe(full);
    const dup = addFollow(full, { kind: "q", value: "kelime 3" }, NOW);
    expect(dup.result).toBe("exists");
  });

  it("reports invalid for bad keywords, bad slugs and unknown kinds", () => {
    const base = [q("seçim")];
    for (const input of [
      { kind: "q" as const, value: "a" },
      { kind: "q" as const, value: "\u0000ab" },
      { kind: "q" as const, value: "a".repeat(201) },
      { kind: "konu" as const, value: "politika" },
      { kind: "konu" as const, value: "../x" },
      { kind: "x" as unknown as "q", value: "seçim2" },
    ]) {
      const r = addFollow(base, input, NOW);
      expect(r.result).toBe("invalid");
      expect(r.list).toBe(base);
    }
  });

  it("does not mutate its input list", () => {
    const base: readonly Follow[] = Object.freeze([q("seçim")]);
    expect(() => addFollow(base, { kind: "konu", value: "spor" }, NOW)).not.toThrow();
    expect(base).toHaveLength(1);
  });
});

describe("removeFollow", () => {
  it("removes by key and keeps order", () => {
    const list = [q("a1"), konu("spor"), q("b2")];
    expect(removeFollow(list, "konu:spor").map(followKey)).toEqual(["q:a1", "q:b2"]);
  });

  it("ignores an unknown key", () => {
    const list = [q("a1")];
    expect(removeFollow(list, "q:zzz")).toEqual(list);
  });
});

describe("markSeen", () => {
  const rows = { ids: [ID(1)], floor: "2026-10-22T07:00:00.000Z" };

  it("touches only the given keys", () => {
    const old = "2026-10-01T00:00:00.000Z";
    const list = [q("a1", { seenAt: old }), konu("spor", { seenAt: old }), q("b2", { seenAt: null })];
    const out = markSeen(list, new Map([["konu:spor", rows], ["q:b2", rows]]), NOW);
    expect(out[0]).toEqual(list[0]);
    expect(out[1]?.seenAt).toBe(NOW);
    expect(out[2]?.seenAt).toBe(NOW);
    // addedAt is never rewritten
    expect(out[1]?.addedAt).toBe(list[1]?.addedAt);
  });

  it("returns an equal list for an empty map and does not mutate", () => {
    const list = Object.freeze([q("a1")]);
    expect(markSeen(list, new Map(), NOW)).toEqual(list);
  });
});

describe("countNew", () => {
  const items = [
    { firstPublished: "2026-10-22T08:00:00.000Z" },
    { firstPublished: "2026-10-22T10:00:00.000Z" },
    { firstPublished: "2026-10-22T11:30:00+00:00" },
  ];

  it("returns 0 when seenAt is null (never claim novelty without a baseline)", () => {
    expect(countNew(items, null)).toBe(0);
  });

  it("counts items published strictly after seenAt", () => {
    expect(countNew(items, "2026-10-22T09:00:00.000Z")).toBe(2);
    expect(countNew(items, "2026-10-22T10:00:00.000Z")).toBe(1);
    expect(countNew(items, "2026-10-22T12:00:00.000Z")).toBe(0);
  });

  it("compares instants, not strings (offset and millisecond formats differ)", () => {
    expect(
      countNew([{ firstPublished: "2026-10-22T10:00:00+00:00" }], "2026-10-22T10:00:00.000Z"),
    ).toBe(0);
    expect(
      countNew([{ firstPublished: "2026-10-22T10:00:00.500+00:00" }], "2026-10-22T10:00:00.000Z"),
    ).toBe(1);
  });

  it("never counts an item with an unparseable timestamp, and tolerates a bad seenAt", () => {
    expect(countNew([{ firstPublished: "garbage" }], "2026-10-22T09:00:00.000Z")).toBe(0);
    expect(countNew(items, "garbage")).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(countNew([], NOW)).toBe(0);
  });
});

describe("followRowsToShow", () => {
  const SEEN = "2026-10-22T09:00:00.000Z";
  const NEW_AT = "2026-10-22T10:00:00+00:00";
  const OLD_AT = "2026-10-22T08:00:00+00:00";

  /** One item per flag: true = published after SEEN, false = before it. */
  const items = (flags: boolean[]) =>
    flags.map((isNew) => ({ firstPublished: isNew ? NEW_AT : OLD_AT }));
  const repeat = (flag: boolean, n: number) => Array.from({ length: n }, () => flag);

  it("shows every row when all 10 items are new, even past the base", () => {
    expect(followRowsToShow(items(repeat(true, 10)), SEEN, 5)).toBe(10);
  });

  it("extends to the last new row: 7 new at indices 0-6 plus 3 old -> 7", () => {
    expect(followRowsToShow(items([...repeat(true, 7), ...repeat(false, 3)]), SEEN, 5)).toBe(7);
  });

  it("a new item deep in an updated_at-ordered list pulls the cut-off down to it", () => {
    const flags = repeat(false, 10);
    flags[0] = true;
    flags[6] = true;
    expect(followRowsToShow(items(flags), SEEN, 5)).toBe(7);
  });

  it("keeps the base when the new rows already fit inside it", () => {
    expect(followRowsToShow(items([true, true, ...repeat(false, 8)]), SEEN, 5)).toBe(5);
  });

  it("is the base when nothing is new", () => {
    expect(followRowsToShow(items(repeat(false, 10)), SEEN, 5)).toBe(5);
  });

  it("is the base with no baseline (seenAt null): the feed claims no novelty", () => {
    expect(followRowsToShow(items(repeat(true, 10)), null, 5)).toBe(5);
  });

  it("is the base for an unparseable seenAt", () => {
    expect(followRowsToShow(items(repeat(true, 10)), "garbage", 5)).toBe(5);
  });

  it("never shows more rows than there are items", () => {
    expect(followRowsToShow(items(repeat(false, 3)), SEEN, 5)).toBe(3);
    expect(followRowsToShow(items(repeat(true, 3)), SEEN, 5)).toBe(3);
  });

  it("is 0 for an empty list", () => {
    expect(followRowsToShow([], SEEN, 5)).toBe(0);
    expect(followRowsToShow([], null, 5)).toBe(0);
  });

  it("an item with an unparseable timestamp is not new, so it never extends the cut-off", () => {
    const list = [
      ...items(repeat(false, 6)),
      { firstPublished: "garbage" },
      ...items(repeat(false, 3)),
    ];
    expect(followRowsToShow(list, SEEN, 5)).toBe(5);
  });

  it("compares instants like countNew (offset vs Z, equal is not new)", () => {
    const list = [
      ...items(repeat(false, 6)),
      { firstPublished: "2026-10-22T09:00:00+00:00" }, // == SEEN: not new
      { firstPublished: "2026-10-22T09:00:00.500+00:00" }, // 0.5 s after: new
      ...items(repeat(false, 2)),
    ];
    expect(followRowsToShow(list, SEEN, 5)).toBe(8);
  });

  it("agrees with countNew: every new item sits inside the rows shown", () => {
    for (const flags of [
      repeat(true, 10),
      [...repeat(true, 7), ...repeat(false, 3)],
      [false, true, false, false, false, false, false, true, false, false],
      repeat(false, 10),
    ]) {
      const list = items(flags);
      const shown = list.slice(0, followRowsToShow(list, SEEN, 5));
      expect(countNew(shown, SEEN)).toBe(countNew(list, SEEN));
    }
  });
});

describe("parseFollowItems", () => {
  const ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";
  const good = {
    id: ID,
    title: "Başlık",
    firstPublished: "2026-10-22T08:00:00+00:00",
    updatedAt: "2026-10-22T09:00:00+00:00",
    sourceCount: 4,
    isBlindspot: false,
    zoneLine: "İktidar 1 · Bağımsız 2 · Muhalefet 1",
  };

  it("accepts a well-formed payload", () => {
    expect(parseFollowItems({ items: [good] })).toEqual([good]);
    expect(parseFollowItems({ items: [] })).toEqual([]);
  });

  it("rejects a payload without an items array", () => {
    expect(parseFollowItems(null)).toBeNull();
    expect(parseFollowItems([])).toBeNull();
    expect(parseFollowItems({})).toBeNull();
    expect(parseFollowItems({ items: "x" })).toBeNull();
  });

  it("drops malformed items, including non-uuid ids that would forge a link", () => {
    const out = parseFollowItems({
      items: [
        good,
        { ...good, id: "../../admin" },
        { ...good, id: 7 },
        { ...good, title: 3 },
        { ...good, sourceCount: "4" },
        { ...good, isBlindspot: "yes" },
        null,
        "x",
      ],
    });
    expect(out).toEqual([good]);
  });

  it("caps the list at 10 items", () => {
    const many = Array.from({ length: 14 }, () => good);
    expect(parseFollowItems({ items: many })).toHaveLength(10);
  });

  // h47-personal-1: the server now sends countHead (sourceCountHead's wording).
  // An old cached 200 body (s-maxage=300, swr=600) has none.
  describe("countHead", () => {
    const withHead = { ...good, countHead: "4 kaynak (3 sınıflandırılmış)" };

    it("keeps a non-empty string countHead", () => {
      expect(parseFollowItems({ items: [withHead] })).toEqual([withHead]);
    });

    it("an old body without countHead still parses, and the item carries no countHead", () => {
      const out = parseFollowItems({ items: [good] });
      expect(out).toHaveLength(1);
      expect(out?.[0]).toEqual(good);
      expect(out?.[0] && "countHead" in out[0]).toBe(false);
    });

    it("a non-string or empty countHead is treated as missing: the item is kept, not rejected", () => {
      const hostile: unknown[] = [5, null, true, {}, ["x"], ""];
      for (const countHead of hostile) {
        const out = parseFollowItems({ items: [{ ...good, countHead }] });
        expect(out, String(countHead)).toHaveLength(1);
        expect(out?.[0] && "countHead" in out[0], String(countHead)).toBe(false);
        expect(out?.[0]?.sourceCount).toBe(4);
      }
    });
  });
});

describe("runWithConcurrency", () => {
  it("never runs more than `limit` workers at once and visits every item", async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(n);
      active--;
    });
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("resolves for an empty list and when limit exceeds the list length", async () => {
    await expect(runWithConcurrency([], 3, async () => {})).resolves.toBeUndefined();
    const seen: number[] = [];
    await runWithConcurrency([1, 2], 10, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2]);
  });

  it("keeps going when one worker rejects (workers own their error handling)", async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3], 1, async (n) => {
      try {
        if (n === 2) throw new Error("boom");
        seen.push(n);
      } catch {
        /* swallowed by the worker */
      }
    });
    expect(seen).toEqual([1, 3]);
  });
});

describe("parseFollowKey", () => {
  it("inverts followKey", () => {
    // A keyword's key carries its identity, a slug's carries the slug itself.
    expect(parseFollowKey(followKey(q("seçim")))).toEqual({ kind: "q", value: "secim" });
    expect(parseFollowKey(followKey(q("a: b")))).toEqual({ kind: "q", value: "a: b" });
    expect(parseFollowKey(followKey(konu("spor")))).toEqual({ kind: "konu", value: "spor" });
    for (const f of [q("seçim"), q("IMF"), q("a: b"), konu("spor")]) {
      expect(followKey({ ...f, ...(parseFollowKey(followKey(f)) ?? {}) })).toBe(followKey(f));
    }
  });

  it("splits on the FIRST colon, so a keyword may contain colons", () => {
    expect(parseFollowKey("q:saat 10:30")).toEqual({ kind: "q", value: "saat 10:30" });
  });

  it("rejects anything followKey could not have produced", () => {
    for (const key of [
      "",
      "q",
      "x:seçim",
      "q:a",
      "q:  Seçim ", // not in normal form
      "q:İMAM", // display case, not an identity
      "q:Seçim",
      "konu:politika",
      "konu:Ekonomi",
      ":spor",
    ]) {
      expect(parseFollowKey(key)).toBeNull();
    }
  });
});

describe("hasFollow", () => {
  const list = [q("seçim"), konu("spor")];

  it("matches on the normalised key", () => {
    expect(hasFollow(list, "q", "  SEÇİM ")).toBe(true);
    expect(hasFollow(list, "konu", "spor")).toBe(true);
  });

  it("is false for other kinds, other values and invalid input", () => {
    expect(hasFollow(list, "konu", "seçim")).toBe(false);
    expect(hasFollow(list, "q", "spor")).toBe(false);
    expect(hasFollow(list, "q", "a")).toBe(false);
    expect(hasFollow(list, "konu", "politika")).toBe(false);
    expect(hasFollow([], "q", "seçim")).toBe(false);
  });
});

describe("focusTargetAfterRemove", () => {
  it("hands focus to the NEXT follow when there is one", () => {
    expect(focusTargetAfterRemove(["a", "b", "c"], "b")).toBe("c");
    expect(focusTargetAfterRemove(["a", "b", "c"], "a")).toBe("b");
  });

  it("falls back to the PREVIOUS follow when the last one is removed", () => {
    expect(focusTargetAfterRemove(["a", "b", "c"], "c")).toBe("b");
  });

  it("is null when the removed follow was the only one", () => {
    expect(focusTargetAfterRemove(["a"], "a")).toBeNull();
  });

  it("is null for a key that is not in the list (nothing was removed)", () => {
    expect(focusTargetAfterRemove(["a", "b"], "zzz")).toBeNull();
    expect(focusTargetAfterRemove([], "a")).toBeNull();
  });

  it("does not mutate its input", () => {
    const keys = Object.freeze(["a", "b", "c"]) as readonly string[];
    focusTargetAfterRemove(keys, "b");
    expect(keys).toEqual(["a", "b", "c"]);
  });
});

describe("followRowMeta", () => {
  const NOW_MS = Date.parse("2026-10-22T12:00:00.000Z");
  const ITEM: FollowItem = {
    id: "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb",
    title: "Başlık",
    // Published 3 hours ago, but the cluster was touched 10 minutes ago: the
    // row must age by when the STORY first appeared (ClusterCard and the
    // "yeni" count use firstPublished too), not by the last update.
    firstPublished: "2026-10-22T09:00:00+00:00",
    updatedAt: "2026-10-22T11:50:00+00:00",
    sourceCount: 4,
    isBlindspot: false,
    zoneLine: "İktidar 1 · Bağımsız 2 · Muhalefet 1",
  };

  it("is '{n} kaynak · {firstPublished ago} · {zoneLine}'", () => {
    expect(followRowMeta(ITEM, NOW_MS)).toBe(
      `${ITEM.sourceCount} kaynak · ${formatTurkishTimeAgo(ITEM.firstPublished, { now: NOW_MS })} · ${ITEM.zoneLine}`,
    );
    expect(followRowMeta(ITEM, NOW_MS)).toBe(
      "4 kaynak · 3 saat önce · İktidar 1 · Bağımsız 2 · Muhalefet 1",
    );
  });

  it("differs from the updatedAt variant when the two instants differ", () => {
    const byUpdated = `${ITEM.sourceCount} kaynak · ${formatTurkishTimeAgo(ITEM.updatedAt, { now: NOW_MS })} · ${ITEM.zoneLine}`;
    expect(byUpdated).toContain("10 dakika önce");
    expect(followRowMeta(ITEM, NOW_MS)).not.toBe(byUpdated);
    expect(followRowMeta(ITEM, NOW_MS)).not.toContain("10 dakika önce");
  });

  it("falls back to the real clock when no `now` is given", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOW_MS);
      expect(followRowMeta(ITEM)).toBe(followRowMeta(ITEM, NOW_MS));
    } finally {
      vi.useRealTimers();
    }
  });

  it("switches to an absolute date for an old story", () => {
    const old = { ...ITEM, firstPublished: "2026-09-01T08:00:00+00:00" };
    expect(followRowMeta(old, NOW_MS)).toBe(
      `4 kaynak · 1 Eylül 2026 · ${ITEM.zoneLine}`,
    );
  });

  it("keeps the count and zone line when the date is unparseable (empty time-ago)", () => {
    const bad = { ...ITEM, firstPublished: "not-a-date" };
    const meta = followRowMeta(bad, NOW_MS);
    expect(meta.startsWith("4 kaynak · ")).toBe(true);
    expect(meta.endsWith(ITEM.zoneLine)).toBe(true);
  });

  // h47-personal-1: the head is the site's sourceCountHead wording, built by
  // the server, so the figures add up to the zone line next to it.
  it("prints the server's countHead in front of the age and zone line", () => {
    const item = {
      sourceCount: 5,
      countHead: "5 kaynak (4 sınıflandırılmış)",
      firstPublished: "2026-10-22T10:00:00+00:00",
      zoneLine: "İktidar 4 · Bağımsız 0 · Muhalefet 0",
    };
    expect(followRowMeta(item, NOW_MS)).toBe(
      "5 kaynak (4 sınıflandırılmış) · 2 saat önce · İktidar 4 · Bağımsız 0 · Muhalefet 0",
    );
  });

  it("falls back to '{n} kaynak' when there is no countHead (old cached body)", () => {
    const { sourceCount, firstPublished, zoneLine } = ITEM;
    expect(followRowMeta({ sourceCount, firstPublished, zoneLine }, NOW_MS)).toBe(
      "4 kaynak · 3 saat önce · İktidar 1 · Bağımsız 2 · Muhalefet 1",
    );
  });

  it("a parsed old body (no countHead) and a parsed new body render through the same function", () => {
    const base = {
      id: "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b",
      title: "Başlık",
      firstPublished: "2026-10-22T10:00:00+00:00",
      updatedAt: "2026-10-22T11:50:00+00:00",
      sourceCount: 5,
      isBlindspot: false,
      zoneLine: "İktidar 4 · Bağımsız 0 · Muhalefet 0",
    };
    const old = parseFollowItems({ items: [base] })?.[0] as FollowItem;
    const fresh = parseFollowItems({
      items: [{ ...base, countHead: "5 kaynak (4 sınıflandırılmış)" }],
    })?.[0] as FollowItem;
    const junk = parseFollowItems({ items: [{ ...base, countHead: 42 }] })?.[0] as FollowItem;
    expect(followRowMeta(old, NOW_MS)).toBe(
      "5 kaynak · 2 saat önce · İktidar 4 · Bağımsız 0 · Muhalefet 0",
    );
    expect(followRowMeta(fresh, NOW_MS)).toBe(
      "5 kaynak (4 sınıflandırılmış) · 2 saat önce · İktidar 4 · Bağımsız 0 · Muhalefet 0",
    );
    expect(followRowMeta(junk, NOW_MS)).toBe(followRowMeta(old, NOW_MS));
  });
});

// ---------------------------------------------------------------------------
// h43-entities-1: the "gundem" kind. A /gundem/<key> hub follows the ENTITY
// (matched by the hub's aliases, excludes and word boundaries), not its bare
// label as a free-text archive search ("deva" matches "devam", "Meclis"
// matches every municipal council).
// ---------------------------------------------------------------------------

describe("gundem follow kind", () => {
  it("isFollowGundemKey accepts exactly the RISING_ENTITIES keys", () => {
    for (const e of RISING_ENTITIES) expect(isFollowGundemKey(e.key)).toBe(true);
    expect(isFollowGundemKey("deva")).toBe(true);
    expect(isFollowGundemKey("not-a-key")).toBe(false);
    expect(isFollowGundemKey("DEVA")).toBe(false);
    expect(isFollowGundemKey(" deva")).toBe(false);
    expect(isFollowGundemKey("")).toBe(false);
    expect(isFollowGundemKey(null)).toBe(false);
    expect(isFollowGundemKey(42)).toBe(false);
    expect(isFollowGundemKey(["deva"])).toBe(false);
  });

  it("isFollowGundemKey is not fooled by Object.prototype names", () => {
    for (const k of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(isFollowGundemKey(k)).toBe(false);
    }
  });

  it("normalizeFollowValue('gundem', v) returns v only for a known key", () => {
    expect(normalizeFollowValue("gundem", "deva")).toBe("deva");
    expect(normalizeFollowValue("gundem", "iyi-parti")).toBe("iyi-parti");
    expect(normalizeFollowValue("gundem", "not-a-key")).toBeNull();
    expect(normalizeFollowValue("gundem", "DEVA")).toBeNull();
    // A label is not a key.
    expect(normalizeFollowValue("gundem", "Özgür Özel")).toBeNull();
    expect(normalizeFollowValue("gundem", "../x")).toBeNull();
    expect(normalizeFollowValue("gundem", "__proto__")).toBeNull();
    expect(normalizeFollowValue("gundem", 7)).toBeNull();
    expect(normalizeFollowValue("gundem", null)).toBeNull();
  });

  it("builds key, href, label and API path from the entity", () => {
    const f = gundem("deva");
    expect(followKey(f)).toBe("gundem:deva");
    expect(followApiPath(f)).toBe("/api/takip?gundem=deva");
    expect(followHref(f)).toBe("/gundem/deva");
    expect(followLabel(f)).toBe("DEVA");
    expect(followLabel(gundem("ozgur-ozel"))).toBe("Özgür Özel");
    expect(followLabel(gundem("tcmb"))).toBe("Merkez Bankası");
  });

  it("labels every entity with its RISING_ENTITIES label and links to its hub", () => {
    for (const e of RISING_ENTITIES) {
      expect(followLabel(gundem(e.key))).toBe(e.label);
      expect(followHref(gundem(e.key))).toBe(`/gundem/${e.key}`);
      expect(followApiPath(gundem(e.key))).toBe(`/api/takip?gundem=${e.key}`);
    }
  });

  it("the q and konu helpers are unchanged by the new kind", () => {
    expect(followHref(q("deva partisi"))).toBe("/?q=deva%20partisi");
    expect(followApiPath(q("deva partisi"))).toBe("/api/takip?q=deva%20partisi");
    expect(followHref(konu("ekonomi"))).toBe("/konu/ekonomi");
    expect(followApiPath(konu("ekonomi"))).toBe("/api/takip?konu=ekonomi");
  });

  it("a hub is a recency list: topic-style empty copy, no corroboration caption", () => {
    expect(followEmptyText("gundem")).toBe("Son dönemde eşleşen hikâye yok.");
    expect(followListCaption("gundem")).toBeNull();
  });

  it("parseFollowKey round-trips gundem:<key> and rejects anything else", () => {
    expect(parseFollowKey("gundem:deva")).toEqual({ kind: "gundem", value: "deva" });
    expect(parseFollowKey(followKey(gundem("iyi-parti")))).toEqual({
      kind: "gundem",
      value: "iyi-parti",
    });
    for (const key of ["gundem:", "gundem:DEVA", "gundem:nope", "gundem:../x", "gundem:__proto__"]) {
      expect(parseFollowKey(key)).toBeNull();
    }
  });

  it("round-trips through serializeFollows and parseStoredFollows", () => {
    const list = [q("seçim"), gundem("deva"), konu("ekonomi", { seenAt: null }), gundem("meclis", { addedAt: null })];
    expect(parseStoredFollows(serializeFollows(list))).toEqual(list);
    expect(JSON.parse(serializeFollows([gundem("deva")]))).toEqual([
      { kind: "gundem", value: "deva", addedAt: NOW, seenAt: NOW, seenIds: null, seenFloor: null },
    ]);
  });

  it("drops a stored gundem entry whose key is unknown, wrong-cased or not a string", () => {
    const raw = JSON.stringify([
      { kind: "gundem", value: "not-a-key", addedAt: NOW, seenAt: NOW },
      { kind: "gundem", value: "DEVA", addedAt: NOW, seenAt: NOW },
      { kind: "gundem", value: 5, addedAt: NOW, seenAt: NOW },
      { kind: "gundem", addedAt: NOW, seenAt: NOW },
      { kind: "gundem", value: "__proto__", addedAt: NOW, seenAt: NOW },
    ]);
    expect(parseStoredFollows(raw)).toEqual([]);
  });

  it("addFollow adds a gundem follow with addedAt = seenAt = now and refuses unknown keys", () => {
    const r = addFollow([], { kind: "gundem", value: "deva" }, NOW);
    expect(r.result).toBe("added");
    expect(r.list).toEqual([gundem("deva")]);

    const base = [q("seçim")];
    const bad = addFollow(base, { kind: "gundem", value: "not-a-key" }, NOW);
    expect(bad.result).toBe("invalid");
    expect(bad.list).toBe(base);

    const dup = addFollow(r.list, { kind: "gundem", value: "deva" }, NOW);
    expect(dup.result).toBe("exists");
  });
});

// A hub button used to store the bare label as a keyword follow, so every
// reader who tapped "Takip et" on /gundem/deva holds {kind:"q", value:"deva"}.
// Those upgrade, on read, to the hub follow they were meant to be.
describe("legacy keyword follow -> gundem follow upgrade", () => {
  it("upgrades a stored q whose value is a RISING_ENTITIES label, keeping the stamps", () => {
    const raw = JSON.stringify([{ kind: "q", value: "DEVA", addedAt: NOW, seenAt: NOW }]);
    expect(parseStoredFollows(raw)).toEqual([gundem("deva")]);

    const stamped = JSON.stringify([
      { kind: "q", value: "deva", addedAt: "2026-10-01T00:00:00.000Z", seenAt: null },
    ]);
    expect(parseStoredFollows(stamped)).toEqual([
      gundem("deva", { addedAt: "2026-10-01T00:00:00.000Z", seenAt: null }),
    ]);
  });

  it("matches the label in its stored (lower-cased, Turkish-folded) form", () => {
    // What the old hub button really stored: normalizeKeyword(label).
    const raw = JSON.stringify([
      { kind: "q", value: normalizeKeyword("İYİ Parti"), addedAt: NOW, seenAt: NOW },
      { kind: "q", value: normalizeKeyword("Merkez Bankası"), addedAt: NOW, seenAt: NOW },
      { kind: "q", value: normalizeKeyword("Anayasa Mahkemesi"), addedAt: NOW, seenAt: NOW },
    ]);
    expect(parseStoredFollows(raw).map(followKey)).toEqual([
      "gundem:iyi-parti",
      "gundem:tcmb",
      "gundem:aym",
    ]);
  });

  it("upgrades every label to its own key (labels are unique after normalisation)", () => {
    const normalised = RISING_ENTITIES.map((e) => normalizeKeyword(e.label));
    expect(new Set(normalised).size).toBe(RISING_ENTITIES.length);
    for (const e of RISING_ENTITIES) {
      const raw = JSON.stringify([{ kind: "q", value: e.label, addedAt: NOW, seenAt: NOW }]);
      expect(parseStoredFollows(raw), e.key).toEqual([gundem(e.key)]);
    }
  });

  it("applies the add-time rule: a padded or re-cased label upgrades to the hub", () => {
    // Parse and add share canonicalFollow, so what addFollow would store for
    // "  İMAMOĞLU " / "Deva" is what a stored copy reads back as.
    const raw = JSON.stringify([
      { kind: "q", value: "  İMAMOĞLU ", addedAt: NOW, seenAt: NOW },
      { kind: "q", value: "Deva", addedAt: NOW, seenAt: NOW },
    ]);
    expect(parseStoredFollows(raw).map(followKey)).toEqual(["gundem:imamoglu", "gundem:deva"]);
  });

  it("parse is idempotent and agrees with hasFollow / addFollow on non-canonical data", () => {
    const raw = JSON.stringify([
      { kind: "q", value: "Deva", addedAt: NOW, seenAt: NOW },
      { kind: "q", value: "  İMAMOĞLU ", addedAt: NOW, seenAt: NOW },
      { kind: "q", value: "deva partisi", addedAt: NOW, seenAt: NOW },
      { kind: "konu", value: "ekonomi", addedAt: NOW, seenAt: NOW },
      { kind: "gundem", value: "tcmb", addedAt: NOW, seenAt: NOW },
      "DEVA",
      "  Merkez   Bankası ",
    ]);
    const parsed = parseStoredFollows(raw);

    // serialize -> parse is a fixed point.
    expect(parseStoredFollows(serializeFollows(parsed))).toEqual(parsed);
    // Every follow the list holds is found by the lookup the button uses ...
    for (const f of parsed) expect(hasFollow(parsed, f.kind, f.value), followKey(f)).toBe(true);
    // ... and re-adding the hub a stored keyword became is "exists", never a duplicate.
    expect(parsed.map(followKey)).toEqual([
      "gundem:deva",
      "gundem:imamoglu",
      "q:deva partisi",
      "konu:ekonomi",
      "gundem:tcmb",
    ]);
    const again = addFollow(parsed, { kind: "gundem", value: "deva" }, NOW);
    expect(again.result).toBe("exists");
    expect(again.list).toBe(parsed);
    // The keyword the reader stored and the hub it upgraded to are one follow.
    expect(hasFollow(parsed, "q", "deva")).toBe(true);
    expect(hasFollow(parsed, "gundem", "deva")).toBe(true);
  });

  it("upgrades a label stored padded and upper-cased, for every hub", () => {
    for (const e of RISING_ENTITIES) {
      const raw = JSON.stringify([
        { kind: "q", value: `  ${e.label.toLocaleUpperCase("tr")} `, addedAt: NOW, seenAt: NOW },
      ]);
      expect(parseStoredFollows(raw), e.key).toEqual([gundem(e.key)]);
    }
  });

  it("leaves a keyword that merely contains a label alone", () => {
    const raw = JSON.stringify([
      { kind: "q", value: "deva partisi", addedAt: NOW, seenAt: NOW },
      { kind: "q", value: "chp'li", addedAt: NOW, seenAt: NOW },
      { kind: "q", value: "devam", addedAt: NOW, seenAt: NOW },
    ]);
    expect(parseStoredFollows(raw).map(followKey)).toEqual([
      "q:deva partisi",
      "q:chp'li",
      "q:devam",
    ]);
  });

  it("upgrades a legacy bare-string keyword too", () => {
    expect(parseStoredFollows('["DEVA"]')).toEqual([
      gundem("deva", { addedAt: null, seenAt: null }),
    ]);
  });

  it("never touches a konu follow (a topic slug is not a label)", () => {
    const raw = JSON.stringify([{ kind: "konu", value: "ekonomi", addedAt: NOW, seenAt: NOW }]);
    expect(parseStoredFollows(raw)).toEqual([konu("ekonomi")]);
  });

  it("dedupes q:DEVA and gundem:deva into ONE gundem follow (first wins)", () => {
    const both = JSON.stringify([
      { kind: "q", value: "DEVA", addedAt: NOW, seenAt: NOW },
      { kind: "gundem", value: "deva", addedAt: null, seenAt: null },
    ]);
    const out = parseStoredFollows(both);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(gundem("deva"));

    const reversed = JSON.stringify([
      { kind: "gundem", value: "deva", addedAt: null, seenAt: null },
      { kind: "q", value: "DEVA", addedAt: NOW, seenAt: NOW },
    ]);
    const out2 = parseStoredFollows(reversed);
    expect(out2).toHaveLength(1);
    expect(out2[0]).toEqual(gundem("deva", { addedAt: null, seenAt: null }));
  });

  it("an upgraded entry frees its slot toward MAX_FOLLOWS like any duplicate", () => {
    const entries: unknown[] = [
      { kind: "q", value: "DEVA", addedAt: NOW, seenAt: NOW },
      { kind: "gundem", value: "deva", addedAt: NOW, seenAt: NOW },
    ];
    for (let i = 0; i < MAX_FOLLOWS; i++) {
      entries.push({ kind: "q", value: `kelime ${i}`, addedAt: NOW, seenAt: NOW });
    }
    const out = parseStoredFollows(JSON.stringify(entries));
    expect(out).toHaveLength(MAX_FOLLOWS);
    expect(out[0]?.kind).toBe("gundem");
    expect(out[MAX_FOLLOWS - 1]?.value).toBe(`kelime ${MAX_FOLLOWS - 2}`);
  });

  it("canonicalFollow applies the same rule to a fresh value", () => {
    expect(canonicalFollow("q", "  DEVA ")).toEqual({ kind: "gundem", value: "deva" });
    expect(canonicalFollow("q", "deva partisi")).toEqual({ kind: "q", value: "deva partisi" });
    expect(canonicalFollow("q", "a")).toBeNull();
    expect(canonicalFollow("gundem", "deva")).toEqual({ kind: "gundem", value: "deva" });
    expect(canonicalFollow("gundem", "DEVA")).toBeNull();
    expect(canonicalFollow("konu", "ekonomi")).toEqual({ kind: "konu", value: "ekonomi" });
    expect(canonicalFollow("konu", "politika")).toBeNull();
    expect(canonicalFollow("x" as unknown as "q", "seçim")).toBeNull();
  });

  // Without this the same keyword would flip kind on the next page load: a
  // search-box "Takip et" on ?q=deva would store q:deva, read back as
  // gundem:deva after a reload, and the button would forget it was followed.
  it("addFollow and hasFollow agree with the upgrade, so a keyword never flips kind on reload", () => {
    const added = addFollow([], { kind: "q", value: "  DEVA " }, NOW);
    expect(added.result).toBe("added");
    expect(added.list).toEqual([gundem("deva")]);

    const list = [gundem("deva")];
    expect(hasFollow(list, "q", "DEVA")).toBe(true);
    expect(hasFollow(list, "gundem", "deva")).toBe(true);
    expect(hasFollow(list, "q", "deva partisi")).toBe(false);
    expect(addFollow(list, { kind: "q", value: "deva" }, NOW).result).toBe("exists");
    expect(parseStoredFollows(serializeFollows(added.list))).toEqual(added.list);
  });
});

describe("module purity (bundled to the client)", () => {
  it("imports nothing from react, next or the server -- only the pure time helpers and the pure hub vocabulary", () => {
    const src = readFileSync(resolve(__dirname, "follows.ts"), "utf8");
    const imports = src.match(/^\s*(?:import|export)\s[^;]*?from\s+["'][^"']+["']/gm) ?? [];
    const specifiers = imports.map((i) => /from\s+["']([^"']+)["']/.exec(i)?.[1]);
    expect(specifiers).toEqual(["@/lib/time", "@/lib/trends/rising-entities"]);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });

  it("the hub vocabulary it reads is itself import-free (it is also bundled to the Edge middleware)", () => {
    const src = readFileSync(resolve(__dirname, "../trends/rising-entities.ts"), "utf8");
    const imports = src.match(/^\s*(?:import|export)\s[^;]*?from\s+["'][^"']+["']/gm) ?? [];
    expect(imports).toEqual([]);
  });

  it("the one allowed dependency is itself import-free", () => {
    const src = readFileSync(resolve(__dirname, "../time.ts"), "utf8");
    const imports = src.match(/^\s*(?:import|export)\s[^;]*?from\s+["'][^"']+["']/gm) ?? [];
    expect(imports).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// h112-follows-1: "yeni" must also count a story that became listed (2nd source)
// after the reader's last /takip visit although it was first published before it.
// A visit stores the ids it showed and the oldest first_published among them.
// ---------------------------------------------------------------------------

const ID = (n: number) => `aaaaaaaa-1111-4111-8111-${String(n).padStart(12, "0")}`;
const SEEN_T = "2026-10-22T09:00:00.000Z";
const SEEN_T_MS = Date.parse(SEEN_T);
const hoursBefore = (h: number) => new Date(SEEN_T_MS - h * 3_600_000).toISOString();
const FLOOR = hoursBefore(5);
/** A baseline of a visit at SEEN_T that showed ids 0..4 and whose oldest row was FLOOR. */
const BASELINE = { seenAt: SEEN_T, seenIds: [ID(0), ID(1), ID(2), ID(3), ID(4)], seenFloor: FLOOR };
const LEGACY = { seenAt: SEEN_T, seenIds: null, seenFloor: null };
const row = (n: number, firstPublished: string) => ({ id: ID(n), firstPublished });

describe("isNewItem [h112-follows-1]", () => {
  it("with seenIds: a late-visible item (unseen id, older than the visit, newer than the floor) is new", () => {
    expect(isNewItem(row(9, hoursBefore(1)), BASELINE)).toBe(true);
    expect(isNewItem(row(9, hoursBefore(1)), LEGACY)).toBe(false); // today's rule misses it
  });

  it("with seenIds: a resurfaced old item below the floor is not new", () => {
    expect(isNewItem(row(9, hoursBefore(6)), BASELINE)).toBe(false);
  });

  it("with seenIds: a tie at the floor is not new, one millisecond above it is", () => {
    expect(isNewItem(row(9, FLOOR), BASELINE)).toBe(false);
    expect(isNewItem(row(9, new Date(Date.parse(FLOOR) + 1).toISOString()), BASELINE)).toBe(true);
  });

  it("with seenIds: an item the visit showed is never new, whatever its time or the id's case", () => {
    expect(isNewItem(row(2, hoursBefore(1)), BASELINE)).toBe(false);
    expect(isNewItem({ id: ID(2).toUpperCase(), firstPublished: hoursBefore(1) }, BASELINE)).toBe(false);
  });

  it("with seenIds: an item published after the visit is new", () => {
    expect(isNewItem(row(9, new Date(SEEN_T_MS + 60_000).toISOString()), BASELINE)).toBe(true);
  });

  it("with seenIds: an unparseable first_published is never new", () => {
    expect(isNewItem(row(9, "garbage"), BASELINE)).toBe(false);
  });

  it("without seenIds it is today's rule: firstPublished strictly after seenAt, instants compared numerically", () => {
    expect(isNewItem(row(9, new Date(SEEN_T_MS + 1).toISOString()), LEGACY)).toBe(true);
    expect(isNewItem(row(9, SEEN_T), LEGACY)).toBe(false);
    expect(isNewItem(row(9, "2026-10-22T09:00:00+00:00"), LEGACY)).toBe(false);
    expect(isNewItem(row(9, "2026-10-22T09:00:00.500+00:00"), LEGACY)).toBe(true);
    expect(isNewItem(row(9, hoursBefore(1)), { seenAt: null, seenIds: null, seenFloor: null })).toBe(false);
    expect(isNewItem(row(9, hoursBefore(1)), { seenAt: "garbage", seenIds: null, seenFloor: null })).toBe(false);
  });

  it("falls back to the seenAt rule when the stored floor cannot be read (never claims novelty it cannot back up)", () => {
    const broken = { seenAt: SEEN_T, seenIds: [ID(0)], seenFloor: "garbage" };
    expect(isNewItem(row(9, hoursBefore(1)), broken)).toBe(false);
    expect(isNewItem(row(9, new Date(SEEN_T_MS + 60_000).toISOString()), broken)).toBe(true);
  });
});

describe("countNew / followRowsToShow with a seen baseline [h112-follows-1]", () => {
  const items = [
    row(10, new Date(SEEN_T_MS + 60_000).toISOString()), // published after the visit
    row(0, hoursBefore(1)), // shown at the visit
    row(9, hoursBefore(2)), // late-visible
    row(1, hoursBefore(3)), // shown
    row(2, hoursBefore(4)), // shown
    row(3, hoursBefore(4.5)), // shown
    row(4, hoursBefore(4.8)), // shown
    row(11, hoursBefore(8)), // resurfaced, below the floor
  ];

  it("counts the late-visible item and the post-visit item, not the shown or resurfaced ones", () => {
    expect(countNew(items, BASELINE)).toBe(2);
    expect(countNew(items, LEGACY)).toBe(1);
  });

  it("legacy follows behave as before: a bare seenAt string or null still works", () => {
    expect(countNew(items, SEEN_T)).toBe(1);
    expect(countNew(items, null)).toBe(0);
    expect(followRowsToShow(items, SEEN_T, 5)).toBe(5);
    expect(followRowsToShow(items, null, 2)).toBe(2);
  });

  it("followRowsToShow reaches the last new item under the same rule as countNew", () => {
    // New items sit at index 0 and 2: with base 2 the list must grow to 3 rows.
    expect(followRowsToShow(items, BASELINE, 2)).toBe(3);
    expect(followRowsToShow(items, LEGACY, 2)).toBe(2);
    const shown = items.slice(0, followRowsToShow(items, BASELINE, 2));
    expect(countNew(shown, BASELINE)).toBe(countNew(items, BASELINE));
  });

  it("an item below the floor that is not shown never extends the list", () => {
    expect(followRowsToShow([row(11, hoursBefore(8))], BASELINE, 5)).toBe(1);
    expect(countNew([row(11, hoursBefore(8))], BASELINE)).toBe(0);
  });
});

describe("markSeen with the rows shown [h112-follows-1]", () => {
  const shownRows = new Map([["konu:spor", { ids: [ID(1), ID(2)], floor: hoursBefore(3) }]]);

  it("stores seenAt, the ids and the floor for the given keys only", () => {
    const list = [q("a1", { seenAt: NOW }), konu("spor", { seenAt: "2026-10-01T00:00:00.000Z" })];
    const out = markSeen(list, shownRows, SEEN_T);
    expect(out[0]).toBe(list[0]);
    expect(out[1]).toEqual(konu("spor", { seenAt: SEEN_T, seenIds: [ID(1), ID(2)], seenFloor: hoursBefore(3) }));
  });

  it("is a no-op for an empty map or an unknown key", () => {
    const list = [q("a1")];
    expect(markSeen(list, new Map(), SEEN_T)).toEqual(list);
    expect(markSeen(list, shownRows, SEEN_T)).toEqual(list);
  });

  it("an empty response (no rows, no floor) moves seenAt and goes back to the legacy rule", () => {
    const list = [konu("spor", { seenIds: [ID(1)], seenFloor: FLOOR })];
    const out = markSeen(list, new Map([["konu:spor", { ids: [], floor: null }]]), SEEN_T);
    expect(out[0]).toEqual(konu("spor", { seenAt: SEEN_T, seenIds: null, seenFloor: null }));
  });

  it("an unreadable floor is stored as the legacy rule too, and ids are de-duplicated and capped at 40", () => {
    const many = Array.from({ length: 60 }, (_, i) => ID(i));
    const out = markSeen([konu("spor")], new Map([["konu:spor", { ids: [ID(1), ID(1), ...many], floor: FLOOR }]]), SEEN_T);
    expect(out[0]?.seenIds).toHaveLength(40);
    expect(new Set(out[0]?.seenIds).size).toBe(40);
    const bad = markSeen([konu("spor")], new Map([["konu:spor", { ids: [ID(1)], floor: "garbage" }]]), SEEN_T);
    expect(bad[0]).toEqual(konu("spor", { seenAt: SEEN_T, seenIds: null, seenFloor: null }));
  });

  it("what it stores survives serialize -> parse unchanged", () => {
    const out = markSeen([konu("spor")], shownRows, SEEN_T);
    expect(parseStoredFollows(serializeFollows(out))).toEqual(out);
  });
});

describe("seenIds / seenFloor in storage [h112-follows-1]", () => {
  const parseOne = (extra: Record<string, unknown>) =>
    parseStoredFollows(JSON.stringify([{ kind: "konu", value: "spor", addedAt: NOW, seenAt: NOW, ...extra }]))[0];

  it("legacy shapes (no fields at all, a bare string) parse with both null", () => {
    expect(parseOne({})).toEqual(konu("spor"));
    expect(parseStoredFollows('["seçim"]')).toEqual([q("seçim", { addedAt: null, seenAt: null })]);
  });

  it("keeps valid ids and a valid floor", () => {
    expect(parseOne({ seenIds: [ID(1), ID(2)], seenFloor: FLOOR })).toEqual(
      konu("spor", { seenIds: [ID(1), ID(2)], seenFloor: FLOOR }),
    );
  });

  it("maps a garbage seenIds or seenFloor to null, whatever the other field holds", () => {
    for (const bad of ["abc", 5, {}, true, null]) {
      expect(parseOne({ seenIds: bad, seenFloor: FLOOR })?.seenIds).toBeNull();
    }
    for (const bad of ["garbage", "", 5, null, {}, "x".repeat(65)]) {
      expect(parseOne({ seenIds: [ID(1)], seenFloor: bad })?.seenFloor).toBeNull();
    }
  });

  it("keeps only uuid-shaped ids, de-duplicated, at most 40", () => {
    const ids = [ID(1), "not-a-uuid", 7, null, ID(1), ID(2)];
    expect(parseOne({ seenIds: ids, seenFloor: FLOOR })?.seenIds).toEqual([ID(1), ID(2)]);
    const many = Array.from({ length: 55 }, (_, i) => ID(i));
    expect(parseOne({ seenIds: many, seenFloor: FLOOR })?.seenIds).toEqual(many.slice(0, 40));
  });

  it("an inconsistent record (ids without a floor) counts with the seenAt rule, not as 'nothing is new'", () => {
    const f = parseOne({ seenIds: [ID(1)], seenFloor: "garbage" })!;
    expect(isNewItem(row(9, new Date(SEEN_T_MS + 60_000).toISOString()), f)).toBe(true);
    expect(isNewItem(row(9, hoursBefore(1)), f)).toBe(false);
  });

  it("serializeFollows writes both fields", () => {
    const raw = JSON.parse(serializeFollows([konu("spor", { seenIds: [ID(1)], seenFloor: FLOOR })]));
    expect(raw).toEqual([{ kind: "konu", value: "spor", addedAt: NOW, seenAt: NOW, seenIds: [ID(1)], seenFloor: FLOOR }]);
  });

  it("addFollow stores nulls: the new follow uses the seenAt rule until its first /takip visit", () => {
    const { list } = addFollow([], { kind: "konu", value: "spor" }, NOW);
    expect(list[0]).toEqual(konu("spor", { addedAt: NOW, seenAt: NOW, seenIds: null, seenFloor: null }));
  });
});

// ---------------------------------------------------------------------------
// h112-follows-2: a keyword keeps the reader's case; identity folds.
// ---------------------------------------------------------------------------

const ZWSP = "\u200b";

describe("keyword display value [h112-follows-2]", () => {
  it("keeps the reader's case: 'IMF' is stored, labelled and linked as IMF", () => {
    expect(normalizeKeyword("IMF")).toBe("IMF");
    expect(normalizeKeyword("FIFA")).toBe("FIFA");
    expect(followLabel(q("IMF"))).toBe("“IMF”");
    expect(followHref(q("IMF"))).toBe("/?q=IMF");
    expect(followApiPath(q("IMF"))).toBe("/api/takip?q=IMF");
    expect(canonicalFollow("q", "IMF")).toEqual({ kind: "q", value: "IMF" });
  });

  it("'Irak' displays “Irak” (a real dotless I) with identity 'irak'", () => {
    expect(normalizeKeyword("Irak")).toBe("Irak");
    expect(followLabel(q("Irak"))).toBe("“Irak”");
    expect(keywordIdentity("Irak")).toBe("irak");
    expect(keywordIdentity("Isparta")).toBe("isparta");
  });

  it("strips format characters (Cf) and still rejects control characters and lone surrogates", () => {
    expect(normalizeKeyword(`seçim${ZWSP}`)).toBe("seçim");
    for (const cf of ["\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\u2060", "\ufeff", "\u00ad", "\u202e"]) {
      expect(normalizeKeyword(`se${cf}çim`), cf.charCodeAt(0).toString(16)).toBe("seçim");
    }
    expect(normalizeKeyword("\u0000ab")).toBeNull();
    expect(normalizeKeyword("ab\ud800")).toBeNull();
    expect(keywordRejectReason("ab\u0000")).toBe("invalid");
  });

  it("collapses whitespace around a stripped format character and trims", () => {
    expect(normalizeKeyword(`  Asgari ${ZWSP} \t Ücret  `)).toBe("Asgari Ücret");
  });

  it("applies the length limits to the stored value (format characters do not count)", () => {
    expect(normalizeKeyword(`a${ZWSP}`)).toBeNull();
    expect(keywordRejectReason(`a${ZWSP}`)).toBe("too-short");
    expect(keywordRejectReason(ZWSP.repeat(5))).toBe("too-short");
    expect(normalizeKeyword(`${"a".repeat(KEYWORD_MAX)}${ZWSP.repeat(10)}`)).toBe("a".repeat(KEYWORD_MAX));
    expect(keywordRejectReason("a".repeat(KEYWORD_MAX + 1))).toBe("too-long");
    expect(keywordRejectReason("a".repeat(RAW_MAX + 1))).toBe("too-long");
    expect(keywordRejectReason("a")).toBe("too-short");
  });

  it("normalizeKeyword stays idempotent on its own output", () => {
    for (const raw of ["IMF", "  İMAMOĞLU ", `Irak${ZWSP}`, "Asgari   Ücret"]) {
      const once = normalizeKeyword(raw);
      expect(normalizeKeyword(once)).toBe(once);
    }
  });
});

describe("keywordIdentity [h112-follows-2]", () => {
  it("folds İ, I and ı to i and lower-cases the rest, then folds Turkish letters to ASCII", () => {
    expect(keywordIdentity("IMF")).toBe("imf");
    expect(keywordIdentity("ımf")).toBe("imf");
    expect(keywordIdentity("İmf")).toBe("imf");
    expect(keywordIdentity("Istanbul")).toBe("istanbul");
    expect(keywordIdentity("FIFA")).toBe("fifa");
    expect(keywordIdentity("BIST")).toBe("bist");
    expect(keywordIdentity("SEÇİM")).toBe("secim");
    expect(keywordIdentity("Şişli Çağlayan Öğüt")).toBe("sisli caglayan ogut");
  });

  it("is idempotent", () => {
    for (const v of ["IMF", "ımf", "SEÇİM", "Şişli", "Irak", "Âlem"]) {
      expect(keywordIdentity(keywordIdentity(v))).toBe(keywordIdentity(v));
    }
  });

  it("mirrors the search fold of turkish-query.ts: same two strings, same results (parity guard)", () => {
    expect(SEARCH_FOLD_FROM).toBe(QUERY_FOLD_FROM);
    expect(SEARCH_FOLD_TO).toBe(QUERY_FOLD_TO);
    expect([...SEARCH_FOLD_FROM]).toHaveLength([...SEARCH_FOLD_TO].length);
    for (const word of ["IMF", "Irak", "SEÇİM", "Şişli", "Çağlayan", "ÖĞRETMEN", "Isparta", "IŞIK", "ıslak", "İYİ Parti", "Âlem", "Mûsiki"]) {
      expect(keywordIdentity(word), word).toBe(foldTr(pgLower(word)));
    }
  });
});

describe("keyword follows share one identity [h112-follows-2]", () => {
  it("followKey for a keyword is its identity; konu / gundem keys are unchanged", () => {
    expect(followKey(q("IMF"))).toBe("q:imf");
    expect(followKey(q("ımf"))).toBe("q:imf");
    expect(followKey(q("Seçim"))).toBe("q:secim");
    expect(followKey(konu("spor"))).toBe("konu:spor");
    expect(followKey(gundem("deva"))).toBe("gundem:deva");
  });

  it("adding 'imf' after 'IMF' returns 'exists' and keeps the reader's case", () => {
    const first = addFollow([], { kind: "q", value: "IMF" }, NOW);
    expect(first.result).toBe("added");
    expect(first.list[0]?.value).toBe("IMF");
    const again = addFollow(first.list, { kind: "q", value: "imf" }, NOW);
    expect(again.result).toBe("exists");
    expect(again.list).toBe(first.list);
  });

  it("a legacy stored 'ımf' keeps its display; a later 'IMF' is 'exists'", () => {
    const stored = parseStoredFollows(JSON.stringify([{ kind: "q", value: "ımf", addedAt: NOW, seenAt: NOW }]));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.value).toBe("ımf");
    expect(followLabel(stored[0]!)).toBe("“ımf”");
    expect(addFollow(stored, { kind: "q", value: "IMF" }, NOW).result).toBe("exists");
    expect(hasFollow(stored, "q", "IMF")).toBe(true);
    expect(hasFollow(stored, "q", "imf")).toBe(true);
  });

  it("'seçim' plus a zero-width space is the same follow as 'seçim'", () => {
    const base = addFollow([], { kind: "q", value: "seçim" }, NOW).list;
    expect(addFollow(base, { kind: "q", value: `seçim${ZWSP}` }, NOW).result).toBe("exists");
    expect(hasFollow(base, "q", `seçim${ZWSP}`)).toBe(true);
    const added = addFollow([], { kind: "q", value: `seçim${ZWSP}` }, NOW);
    expect(added.list[0]?.value).toBe("seçim");
  });

  it("'deva' plus a zero-width space still becomes the DEVA hub follow, in any case", () => {
    expect(canonicalFollow("q", `deva${ZWSP}`)).toEqual({ kind: "gundem", value: "deva" });
    expect(canonicalFollow("q", "DEVA")).toEqual({ kind: "gundem", value: "deva" });
    const out = parseStoredFollows(JSON.stringify([{ kind: "q", value: `deva${ZWSP}`, addedAt: NOW, seenAt: NOW }]));
    expect(out).toEqual([gundem("deva")]);
  });

  it("parse collapses legacy duplicates of one identity (first wins), and never rewrites storage itself", () => {
    const raw = JSON.stringify([
      { kind: "q", value: "ımf", addedAt: NOW, seenAt: NOW },
      { kind: "q", value: "imf", addedAt: NOW, seenAt: NOW },
    ]);
    expect(parseStoredFollows(raw).map((f) => f.value)).toEqual(["ımf"]);
  });

  it("the 20-follow cap is unchanged, and an identity that already exists is 'exists', not 'full'", () => {
    let list: readonly Follow[] = [];
    for (let i = 0; i < MAX_FOLLOWS; i++) {
      const r = addFollow(list, { kind: "q", value: `kelime${String.fromCharCode(97 + i)}` }, NOW);
      expect(r.result).toBe("added");
      list = r.list;
    }
    expect(addFollow(list, { kind: "q", value: "Yeni Kelime" }, NOW).result).toBe("full");
    expect(addFollow(list, { kind: "q", value: "KELİMEA" }, NOW).result).toBe("exists");
    expect(addFollow(list, { kind: "q", value: "a" }, NOW).result).toBe("invalid");
  });

  it("hasFollow, removeFollow and parseFollowKey agree on the identity key", () => {
    const list = [q("IMF")];
    expect(hasFollow(list, "q", "imf")).toBe(true);
    expect(removeFollow(list, followKey({ kind: "q", value: "imf" }))).toEqual([]);
    expect(parseFollowKey("q:imf")).toEqual({ kind: "q", value: "imf" });
    // the key is the identity, so a display-cased value is not a key
    expect(parseFollowKey("q:IMF")).toBeNull();
  });

  it("every hub label still canonicalises to its hub, typed in any case or with the ASCII look-alikes", () => {
    for (const e of RISING_ENTITIES) {
      const viaLabel = canonicalFollow("q", e.label);
      expect(viaLabel, e.label).toEqual({ kind: "gundem", value: e.key });
      const viaUpper = canonicalFollow("q", e.label.toLocaleUpperCase("tr"));
      expect(viaUpper, e.label).toEqual({ kind: "gundem", value: e.key });
    }
  });
});
