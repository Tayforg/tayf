import { describe, it, expect } from "vitest";

import { classifyDrawResponse, startRoundClock } from "./framing-draw";

describe("classifyDrawResponse", () => {
  it("treats a 500 response as an error", () => {
    expect(classifyDrawResponse({ ok: false, body: null })).toEqual({
      kind: "error",
    });
  });

  it("treats a 429 response as an error, not pool-empty", () => {
    expect(
      classifyDrawResponse({ ok: false, body: { article_id: null } }),
    ).toEqual({ kind: "error" });
  });

  it("treats a thrown fetch (represented as null) as an error", () => {
    expect(classifyDrawResponse(null)).toEqual({ kind: "error" });
  });

  it("treats malformed JSON (article_id/title missing or wrong type) as an error", () => {
    expect(classifyDrawResponse({ ok: true, body: {} })).toEqual({
      kind: "error",
    });
    expect(
      classifyDrawResponse({ ok: true, body: { article_id: 123, title: "x" } }),
    ).toEqual({ kind: "error" });
    expect(classifyDrawResponse({ ok: true, body: null })).toEqual({
      kind: "error",
    });
    expect(classifyDrawResponse({ ok: true, body: "not an object" })).toEqual({
      kind: "error",
    });
  });

  it("treats article_id: null on a 2xx as pool-empty", () => {
    expect(
      classifyDrawResponse({ ok: true, body: { article_id: null, title: null } }),
    ).toEqual({ kind: "pool-empty" });
  });

  it("treats a valid string article_id + title on a 2xx as a headline", () => {
    expect(
      classifyDrawResponse({
        ok: true,
        body: { article_id: "abc-123", title: "Başlık" },
      }),
    ).toEqual({ kind: "headline", articleId: "abc-123", title: "Başlık" });
  });
});

describe("startRoundClock", () => {
  it("starts the clock at now + roundSeconds when currentEndsAtMs is 0", () => {
    const now = 1_000_000;
    expect(startRoundClock(0, now, 60)).toBe(now + 60_000);
  });

  it("keeps an already-set deadline unchanged", () => {
    const now = 1_000_000;
    const existing = 999_999;
    expect(startRoundClock(existing, now, 60)).toBe(existing);
  });
});
