import { describe, it, expect } from "vitest";

import {
  FRAMING_VOTES,
  isFramingVote,
  readSessionCookie,
  newSessionId,
  hashSessionId,
  normalizeTally,
  pluralityVote,
  formatTallyLine,
  summariseFramingRound,
  type FramingRoundEntry,
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

function cookieRequest(cookieHeader: string | null): Request {
  const headers: Record<string, string> = {};
  if (cookieHeader !== null) headers["Cookie"] = cookieHeader;
  return new Request("http://example.com/", { headers });
}

describe("readSessionCookie", () => {
  const VALID = "0123456789abcdef0123456789abcdef";

  it("returns the 32-hex value and null for an absent, short or non-hex cookie", () => {
    expect(readSessionCookie(cookieRequest(`tayf_cerceve_sid=${VALID}`))).toBe(VALID);
    expect(readSessionCookie(cookieRequest(`other=1; tayf_cerceve_sid=${VALID}`))).toBe(VALID);
    expect(readSessionCookie(cookieRequest(null))).toBeNull();
    expect(readSessionCookie(cookieRequest("tayf_cerceve_sid=abc123"))).toBeNull();
    expect(readSessionCookie(cookieRequest(`tayf_cerceve_sid=${"g".repeat(32)}`))).toBeNull();
    expect(readSessionCookie(cookieRequest("some_other_cookie=1"))).toBeNull();
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
