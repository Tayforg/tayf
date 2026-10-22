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
  countNew,
  FOLLOW_TOPIC_LABELS,
  FOLLOW_TOPIC_SLUGS,
  FOLLOWS_CHANGE_EVENT,
  FOLLOWS_KEY,
  followApiPath,
  followEmptyText,
  followHref,
  followKey,
  followLabel,
  followListCaption,
  hasFollow,
  isFollowTopicSlug,
  KEYWORD_MAX,
  KEYWORD_MIN,
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
  serializeFollows,
  type Follow,
} from "./follows";
import { TOPIC_LABELS_TR, TOPIC_SLUGS } from "@/lib/clusters/topic-query";

const NOW = "2026-10-22T09:00:00.000Z";

function q(value: string, over: Partial<Follow> = {}): Follow {
  return { kind: "q", value, addedAt: NOW, seenAt: NOW, ...over };
}
function konu(value: string, over: Partial<Follow> = {}): Follow {
  return { kind: "konu", value, addedAt: NOW, seenAt: NOW, ...over };
}

describe("constants", () => {
  it("pins the storage contract", () => {
    expect(FOLLOWS_KEY).toBe("tayf:follows");
    expect(FOLLOWS_CHANGE_EVENT).toBe("tayf:follows-change");
    expect(MAX_FOLLOWS).toBe(20);
    expect(KEYWORD_MIN).toBe(2);
    expect(KEYWORD_MAX).toBe(40);
    expect(RAW_MAX).toBe(200);
  });

  it("mirrors topic-query's slugs and labels exactly (parity guard)", () => {
    expect([...FOLLOW_TOPIC_SLUGS]).toEqual([...TOPIC_SLUGS]);
    expect(FOLLOW_TOPIC_LABELS).toEqual(TOPIC_LABELS_TR);
  });
});

describe("normalizeKeyword", () => {
  it("trims and folds Turkish case", () => {
    expect(normalizeKeyword("  İMAMOĞLU  ")).toBe("imamoğlu");
    expect(normalizeKeyword("ISPARTA")).toBe("ısparta");
  });

  it("collapses runs of whitespace (including tabs and newlines) to one space", () => {
    expect(normalizeKeyword("Asgari   Ücret")).toBe("asgari ücret");
    expect(normalizeKeyword("asgari\t\n ücret")).toBe("asgari ücret");
  });

  it("normalises to NFC", () => {
    const nfd = "ü"; // u + combining diaeresis
    const out = normalizeKeyword(`${nfd}cret`);
    expect(out).toBe("ücret");
    expect(out).toBe("ücret".normalize("NFC"));
  });

  it("counts code points, not UTF-16 units, against the 2..40 window", () => {
    expect(normalizeKeyword("ab")).toBe("ab");
    expect(normalizeKeyword("🙂🙂")).toBe("🙂🙂"); // 2 code points, 4 units
    expect(normalizeKeyword("🙂")).toBeNull(); // 1 code point
    expect(normalizeKeyword("a".repeat(40))).toBe("a".repeat(40));
    expect(normalizeKeyword("🙂".repeat(40))).toBe("🙂".repeat(40));
    expect(normalizeKeyword("🙂".repeat(41))).toBeNull();
  });

  it("rejects too short, too long, control characters and over-long raw input", () => {
    expect(normalizeKeyword("a")).toBeNull();
    expect(normalizeKeyword("  a  ")).toBeNull();
    expect(normalizeKeyword("")).toBeNull();
    expect(normalizeKeyword("   ")).toBeNull();
    expect(normalizeKeyword("a".repeat(41))).toBeNull();
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
    expect(normalizeFollowValue("q", "  SEÇİM ")).toBe("seçim");
    expect(normalizeFollowValue("q", "a")).toBeNull();
    expect(normalizeFollowValue("konu", "ekonomi")).toBe("ekonomi");
    expect(normalizeFollowValue("konu", "Ekonomi")).toBeNull();
    expect(normalizeFollowValue("konu", "politika")).toBeNull();
  });
});

describe("followKey / href / label / apiPath", () => {
  it("builds a kind-prefixed key", () => {
    expect(followKey(q("seçim"))).toBe("q:seçim");
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
      { kind: "q", value: "seçim", addedAt: null, seenAt: null },
    ]);
    expect(parseStoredFollows('["x"]')).toEqual([]);
  });

  it("round-trips a valid list", () => {
    const list = [q("seçim"), konu("ekonomi", { seenAt: null })];
    expect(parseStoredFollows(serializeFollows(list))).toEqual(list);
  });

  it("re-normalises stored keyword values", () => {
    const raw = JSON.stringify([{ kind: "q", value: "  İMAMOĞLU ", addedAt: NOW, seenAt: NOW }]);
    expect(parseStoredFollows(raw)[0]?.value).toBe("imamoğlu");
  });

  it("turns an unparseable addedAt / seenAt into null, and keeps a parseable one", () => {
    const raw = JSON.stringify([
      { kind: "q", value: "seçim", addedAt: "not a date", seenAt: 12345 },
      { kind: "konu", value: "spor", addedAt: NOW, seenAt: "" },
    ]);
    expect(parseStoredFollows(raw)).toEqual([
      { kind: "q", value: "seçim", addedAt: null, seenAt: null },
      { kind: "konu", value: "spor", addedAt: NOW, seenAt: null },
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
    expect(out.map(followKey)).toEqual(["q:seçim", "konu:spor"]);
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
    expect(out).toEqual([{ kind: "q", value: "seçim", addedAt: null, seenAt: null }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("serializeFollows", () => {
  it("emits only the four Follow fields", () => {
    const withExtra = { ...q("seçim"), extra: "x" } as Follow;
    expect(JSON.parse(serializeFollows([withExtra]))).toEqual([
      { kind: "q", value: "seçim", addedAt: NOW, seenAt: NOW },
    ]);
  });

  it("serialises an empty list as []", () => {
    expect(serializeFollows([])).toBe("[]");
  });
});

describe("addFollow", () => {
  it("adds a normalised keyword with addedAt = seenAt = now", () => {
    const r = addFollow([], { kind: "q", value: "  SEÇİM " }, NOW);
    expect(r.result).toBe("added");
    expect(r.list).toEqual([q("seçim")]);
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
  it("touches only the given keys", () => {
    const old = "2026-10-01T00:00:00.000Z";
    const list = [q("a1", { seenAt: old }), konu("spor", { seenAt: old }), q("b2", { seenAt: null })];
    const out = markSeen(list, new Set(["konu:spor", "q:b2"]), NOW);
    expect(out[0]).toEqual(list[0]);
    expect(out[1]?.seenAt).toBe(NOW);
    expect(out[2]?.seenAt).toBe(NOW);
    // addedAt is never rewritten
    expect(out[1]?.addedAt).toBe(list[1]?.addedAt);
  });

  it("returns an equal list for an empty key set and does not mutate", () => {
    const list = Object.freeze([q("a1")]);
    expect(markSeen(list, new Set(), NOW)).toEqual(list);
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
    for (const f of [q("seçim"), q("a: b"), konu("spor")]) {
      expect(parseFollowKey(followKey(f))).toEqual({ kind: f.kind, value: f.value });
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
      "q:İMAM",
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

describe("module purity (bundled to the client)", () => {
  it("imports nothing from react, next or the server", () => {
    const src = readFileSync(resolve(__dirname, "follows.ts"), "utf8");
    const imports = src.match(/^\s*(?:import|export)\s[^;]*?from\s+["'][^"']+["']/gm) ?? [];
    expect(imports).toEqual([]);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});
