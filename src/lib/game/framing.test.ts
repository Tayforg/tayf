import { describe, it, expect } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  FRAMING_MIN_TALLY_N,
  FRAMING_VOTES,
  hasComparableTally,
  isFramingVote,
  newSessionId,
  hashSessionId,
  normalizeTally,
  pluralityVote,
  formatTallyLine,
  summariseFramingRound,
  type FramingRoundEntry,
  type FramingTally,
} from "./framing";

// ---------------------------------------------------------------------------
// Unit tests for the pure/isomorphic Çerçeve ("Framing") helpers (PACK D /
// R10). No Supabase, no network — every export here is pure aside from
// `newSessionId`'s randomness and `hashSessionId`'s Web Crypto call.
// ---------------------------------------------------------------------------

describe("FRAMING_VOTES", () => {
  it("matches migration 068's vote CHECK list", () => {
    expect(FRAMING_VOTES).toEqual(["iktidar", "muhalefet", "none"]);
  });
});

describe("isFramingVote", () => {
  it("rejects unknown strings, numbers, null and objects", () => {
    expect(isFramingVote("iktidar")).toBe(true);
    expect(isFramingVote("muhalefet")).toBe(true);
    expect(isFramingVote("none")).toBe(true);
    expect(isFramingVote("tarafsiz")).toBe(false);
    expect(isFramingVote("")).toBe(false);
    expect(isFramingVote(1)).toBe(false);
    expect(isFramingVote(null)).toBe(false);
    expect(isFramingVote(undefined)).toBe(false);
    expect(isFramingVote({})).toBe(false);
    expect(isFramingVote(["iktidar"])).toBe(false);
  });
});

describe("hashSessionId", () => {
  it("returns a stable 64-char lowercase hex that never equals the raw id", async () => {
    const raw = "0123456789abcdef0123456789abcdef";
    const first = await hashSessionId(raw);
    const second = await hashSessionId(raw);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(raw);

    const otherRaw = "fedcba9876543210fedcba9876543210";
    const other = await hashSessionId(otherRaw);
    expect(other).not.toBe(first);
  });
});

describe("newSessionId", () => {
  it("returns 32 lowercase hex chars and differs between calls", () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("normalizeTally", () => {
  it("coerces missing, negative and non-finite counts to 0", () => {
    expect(normalizeTally(undefined)).toEqual({ n: 0, iktidar: 0, muhalefet: 0, none: 0 });
    expect(normalizeTally(null)).toEqual({ n: 0, iktidar: 0, muhalefet: 0, none: 0 });
    expect(normalizeTally({})).toEqual({ n: 0, iktidar: 0, muhalefet: 0, none: 0 });
    expect(
      normalizeTally({ n: -5, iktidar: Number.NaN, muhalefet: Number.POSITIVE_INFINITY, none: -1 }),
    ).toEqual({ n: 0, iktidar: 0, muhalefet: 0, none: 0 });
    expect(normalizeTally({ n: 10, iktidar: 4, muhalefet: 3, none: 3 })).toEqual({
      n: 10,
      iktidar: 4,
      muhalefet: 3,
      none: 3,
    });
    expect(normalizeTally({ n: 10, iktidar: 4, muhalefet: 3, neutral_n: 3 })).toEqual({
      n: 10,
      iktidar: 4,
      muhalefet: 3,
      none: 3,
    });
  });
});

describe("pluralityVote", () => {
  it("returns null on an empty tally and on a two-way tie", () => {
    expect(pluralityVote({ n: 0, iktidar: 0, muhalefet: 0, none: 0 })).toBeNull();
    expect(pluralityVote({ n: 8, iktidar: 4, muhalefet: 4, none: 0 })).toBeNull();
    expect(pluralityVote({ n: 6, iktidar: 4, muhalefet: 1, none: 1 })).toBe("iktidar");
  });
});

describe("formatTallyLine", () => {
  it("renders the n and three Turkish-prefixed percentages", () => {
    expect(formatTallyLine({ n: 0, iktidar: 0, muhalefet: 0, none: 0 })).toBe("Henüz oy yok");
    expect(formatTallyLine({ n: 10, iktidar: 5, muhalefet: 3, none: 2 })).toBe(
      "10 oy · İktidar %50 · Muhalefet %30 · Tarafsız %20",
    );
  });

  it("uses largest-remainder rounding so the three percentages total 100", () => {
    // Naive Math.round gives 33 + 33 + 33 = 99.
    expect(formatTallyLine({ n: 3, iktidar: 1, muhalefet: 1, none: 1 })).toBe(
      "3 oy · İktidar %34 · Muhalefet %33 · Tarafsız %33",
    );
    // Naive Math.round gives 88 + 13 + 0 = 101.
    expect(formatTallyLine({ n: 8, iktidar: 7, muhalefet: 1, none: 0 })).toBe(
      "8 oy · İktidar %88 · Muhalefet %12 · Tarafsız %0",
    );
  });
});

describe("hasComparableTally (the one n >= FRAMING_MIN_TALLY_N floor)", () => {
  it("is false below the floor and true from it on", () => {
    expect(FRAMING_MIN_TALLY_N).toBe(3);
    expect(hasComparableTally({ n: 0, iktidar: 0, muhalefet: 0, none: 0 })).toBe(false);
    expect(hasComparableTally({ n: 1, iktidar: 1, muhalefet: 0, none: 0 })).toBe(false);
    expect(hasComparableTally({ n: 2, iktidar: 1, muhalefet: 1, none: 0 })).toBe(false);
    expect(hasComparableTally({ n: 3, iktidar: 1, muhalefet: 1, none: 1 })).toBe(true);
    expect(hasComparableTally({ n: 4000, iktidar: 4000, muhalefet: 0, none: 0 })).toBe(true);
  });

  it("is derived from the constant, not from a literal 3 (the floor is written once)", () => {
    const at = (n: number): FramingTally => ({ n, iktidar: n, muhalefet: 0, none: 0 });
    expect(hasComparableTally(at(FRAMING_MIN_TALLY_N - 1))).toBe(false);
    expect(hasComparableTally(at(FRAMING_MIN_TALLY_N))).toBe(true);
    // comments are dropped first: the doc comment names the rule in prose
    const src = readFileSync(resolve(__dirname, "framing.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // one comparison against the constant (inside hasComparableTally); the summary and the tally line call that function
    expect(src.split("n >= FRAMING_MIN_TALLY_N").length - 1).toBe(1);
    expect(src.split("hasComparableTally(").length - 1).toBe(3); // the declaration, the tally line, the summary
  });
});

describe("formatTallyLine below the n >= 3 floor", () => {
  it("n = 1: no percentage at all, only the Turkish 'not enough votes yet' line with the n/3 progress", () => {
    const line = formatTallyLine({ n: 1, iktidar: 1, muhalefet: 0, none: 0 });
    expect(line).toBe("Bu başlık için henüz yeterli oy yok (1/3).");
    expect(line).not.toContain("%");
    expect(line).toContain("1/3");
    expect(line).not.toContain("İktidar");
  });

  it("n = 2 likewise, whatever the split", () => {
    for (const tally of [
      { n: 2, iktidar: 2, muhalefet: 0, none: 0 },
      { n: 2, iktidar: 1, muhalefet: 1, none: 0 },
      { n: 2, iktidar: 0, muhalefet: 0, none: 2 },
    ] satisfies FramingTally[]) {
      const line = formatTallyLine(tally);
      expect(line).toBe("Bu başlık için henüz yeterli oy yok (2/3).");
      expect(line).not.toContain("%");
    }
  });

  it("the progress is written from the constant: n/FRAMING_MIN_TALLY_N", () => {
    expect(formatTallyLine({ n: 1, iktidar: 1, muhalefet: 0, none: 0 })).toBe(
      `Bu başlık için henüz yeterli oy yok (1/${FRAMING_MIN_TALLY_N}).`,
    );
  });

  it("n = 0 keeps 'Henüz oy yok'; n = 3 is today's largest-remainder percentage line, unchanged", () => {
    expect(formatTallyLine({ n: 0, iktidar: 0, muhalefet: 0, none: 0 })).toBe("Henüz oy yok");
    expect(formatTallyLine({ n: 3, iktidar: 3, muhalefet: 0, none: 0 })).toBe(
      "3 oy · İktidar %100 · Muhalefet %0 · Tarafsız %0",
    );
    expect(formatTallyLine({ n: 3, iktidar: 1, muhalefet: 1, none: 1 })).toBe(
      "3 oy · İktidar %34 · Muhalefet %33 · Tarafsız %33",
    );
  });

  it("a percentage is printed if and only if the tally is comparable (one floor, n = 0 to 12)", () => {
    for (let n = 0; n <= 12; n++) {
      const tally: FramingTally = { n, iktidar: n, muhalefet: 0, none: 0 };
      expect(formatTallyLine(tally).includes("%"), `n = ${n}`).toBe(hasComparableTally(tally));
    }
  });

  it("a round of two single-vote headlines: neither reveal shows a percentage, and the summary says there is not enough data (one floor everywhere)", () => {
    const entries: FramingRoundEntry[] = [
      { vote: "iktidar", tally: { n: 1, iktidar: 1, muhalefet: 0, none: 0 } },
      { vote: "muhalefet", tally: { n: 1, iktidar: 0, muhalefet: 1, none: 0 } },
    ];
    for (const entry of entries) expect(formatTallyLine(entry.tally)).not.toContain("%");
    const result = summariseFramingRound(entries);
    expect(result.eligible).toBe(0);
    expect(result.line).toBe("Henüz karşılaştırmak için yeterli oy yok.");
  });
});

describe("summariseFramingRound", () => {
  it("counts only headlines with at least 3 votes and names its denominator", () => {
    const entries: FramingRoundEntry[] = [
      { vote: "iktidar", tally: { n: 5, iktidar: 4, muhalefet: 1, none: 0 } }, // eligible, agrees
      { vote: "muhalefet", tally: { n: 4, iktidar: 3, muhalefet: 1, none: 0 } }, // eligible, disagrees
      { vote: "none", tally: { n: 2, iktidar: 1, muhalefet: 1, none: 0 } }, // not eligible: n < 3
    ];
    const result = summariseFramingRound(entries);
    expect(result.total).toBe(3);
    expect(result.eligible).toBe(2);
    expect(result.agree).toBe(1);
    expect(result.line).toBe("1 başlıkta çoğunlukla aynı fikirdesiniz");
    expect(result.detail).toBe("Yeterli oyu olan 2 başlık üzerinden · bu turda 3 başlık oyladın.");
  });

  it("falls back to the 'yeterli oy yok' line when nothing qualifies", () => {
    const entries: FramingRoundEntry[] = [
      { vote: "iktidar", tally: { n: 1, iktidar: 1, muhalefet: 0, none: 0 } },
      { vote: "none", tally: { n: 0, iktidar: 0, muhalefet: 0, none: 0 } },
    ];
    const result = summariseFramingRound(entries);
    expect(result.eligible).toBe(0);
    expect(result.agree).toBe(0);
    expect(result.line).toBe("Henüz karşılaştırmak için yeterli oy yok.");
    expect(result.detail).toBe("Yeterli oyu olan 0 başlık üzerinden · bu turda 2 başlık oyladın.");
  });
});

describe("summariseFramingRound at the floor", () => {
  it("n = 2 is not eligible and n = 3 is, through the same hasComparableTally the reveal line uses", () => {
    const two: FramingRoundEntry = { vote: "iktidar", tally: { n: 2, iktidar: 2, muhalefet: 0, none: 0 } };
    const three: FramingRoundEntry = { vote: "iktidar", tally: { n: 3, iktidar: 3, muhalefet: 0, none: 0 } };
    expect(summariseFramingRound([two]).eligible).toBe(0);
    expect(summariseFramingRound([three]).eligible).toBe(1);
    expect(summariseFramingRound([three]).agree).toBe(1);
    for (const entry of [two, three]) {
      expect(summariseFramingRound([entry]).eligible === 1).toBe(hasComparableTally(entry.tally));
      expect(formatTallyLine(entry.tally).includes("%")).toBe(hasComparableTally(entry.tally));
    }
  });
});
