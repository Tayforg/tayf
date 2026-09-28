import { describe, it, expect } from "vitest";
import { parseDate } from "../../supabase/functions/_shared/rss/normalize.ts";

// ---------------------------------------------------------------------------
// ingest-fixes (migration 074) -- parseDate() contract.
//
// nowMs is fixed so every "clamp to now" assertion is deterministic. Every
// case here must resolve its own explicit offset before ever touching the
// Date constructor -- vitest here runs on a machine set to Europe/Istanbul,
// Deno Deploy runs in UTC, and a test that (accidentally) depends on either
// runtime's local TZ would pass in CI and lie about production, or vice
// versa. Every assertion below is against an absolute instant / ISO string,
// never against a component read off a *local* Date getter, so this file's
// own outcome cannot depend on which TZ vitest happens to run under.
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-09-28T15:00:00Z");

describe("parseDate [ingest-fixes / migration 074]", () => {
  it("a +0300 RFC date is honoured (no correction) for a non-cnn-turk source", () => {
    const iso = parseDate("Mon, 28 Sep 2026 12:00:00 +0300", {
      nowMs: NOW_MS,
      sourceSlug: "some-other-source",
    });
    // 12:00 +03:00 == 09:00 UTC.
    expect(iso).toBe("2026-09-28T09:00:00.000Z");
  });

  it("a zone-less ISO-like string is interpreted as Europe/Istanbul (+03:00)", () => {
    const iso = parseDate("2026-09-28 12:00:00", {
      nowMs: NOW_MS,
      sourceSlug: "some-source",
    });
    expect(iso).toBe("2026-09-28T09:00:00.000Z");
  });

  it("a zone-less RFC-822-like string is interpreted as Europe/Istanbul (+03:00)", () => {
    const iso = parseDate("Mon, 28 Sep 2026 12:00:00", {
      nowMs: NOW_MS,
      sourceSlug: "some-source",
    });
    expect(iso).toBe("2026-09-28T09:00:00.000Z");
  });

  it("cnn-turk + a Z designator subtracts 3h (Istanbul wall-clock mislabelled UTC)", () => {
    const iso = parseDate("2026-09-28T12:00:00Z", {
      nowMs: NOW_MS,
      sourceSlug: "cnn-turk",
    });
    // 12:00 UTC label, minus 3h correction => 09:00 UTC actual instant.
    expect(iso).toBe("2026-09-28T09:00:00.000Z");
  });

  it("cnn-turk + a GMT designator subtracts 3h", () => {
    const iso = parseDate("Mon, 28 Sep 2026 12:00:00 GMT", {
      nowMs: NOW_MS,
      sourceSlug: "cnn-turk",
    });
    expect(iso).toBe("2026-09-28T09:00:00.000Z");
  });

  it("another slug with a Z designator is left unchanged (rule 3 is cnn-turk-only)", () => {
    const iso = parseDate("2026-09-28T12:00:00Z", {
      nowMs: NOW_MS,
      sourceSlug: "some-other-source",
    });
    expect(iso).toBe("2026-09-28T12:00:00.000Z");
  });

  it("cnn-turk with an explicit non-UTC-like offset is NOT corrected (rule 3 only fires on a UTC-like designator)", () => {
    const iso = parseDate("2026-09-28T12:00:00+03:00", {
      nowMs: NOW_MS,
      sourceSlug: "cnn-turk",
    });
    // Already correctly offset -- no designator-based correction applies.
    expect(iso).toBe("2026-09-28T09:00:00.000Z");
  });

  it("a future date (past nowMs, e.g. via an explicit offset) is clamped to nowMs", () => {
    const iso = parseDate("2026-09-29T00:00:00Z", {
      nowMs: NOW_MS,
      sourceSlug: "some-source",
    });
    expect(iso).toBe(new Date(NOW_MS).toISOString());
  });

  it("an invalid / unparseable date string falls back to nowMs", () => {
    expect(parseDate("not a date", { nowMs: NOW_MS })).toBe(
      new Date(NOW_MS).toISOString(),
    );
    expect(parseDate("", { nowMs: NOW_MS })).toBe(new Date(NOW_MS).toISOString());
    expect(parseDate(undefined, { nowMs: NOW_MS })).toBe(
      new Date(NOW_MS).toISOString(),
    );
  });

  it("the real CNN Türk feed fixture resolves to an instant <= nowMs", () => {
    // Raw pubDate pulled live from https://www.cnnturk.com/feed/rss/all/news
    // on 2026-09-28 (read-only GET, V1b): the feed stamps a GMT designator
    // on what is still Istanbul wall-clock time -- at fetch time real UTC
    // was 18:51, the feed's newest item carried "21:42:45 GMT" (~2h51m
    // ahead), which is exactly the rule-3 shape (cnn-turk + UTC-like
    // designator) and matches synth.md's measured max of +2h53m.
    const raw = "Mon, 28 Sep 2026 21:42:45 GMT";
    const iso = parseDate(raw, { nowMs: NOW_MS, sourceSlug: "cnn-turk" });
    expect(Date.parse(iso)).toBeLessThanOrEqual(NOW_MS);
  });

  it("never passes a zone-less string straight to the Date constructor (Istanbul-vs-UTC runtime divergence)", () => {
    // If a zone-less string were passed straight through, `new Date(...)`
    // would resolve it against the RUNTIME's local TZ (Istanbul here,
    // sometimes UTC on Deno Deploy) rather than always to +03:00. Pin the
    // Istanbul interpretation regardless of what TZ this test happens to
    // run under.
    const iso = parseDate("2026-01-15 08:00:00", {
      nowMs: Date.parse("2026-01-15T12:00:00Z"),
      sourceSlug: "some-source",
    });
    // 08:00 Istanbul (+03:00, no DST) == 05:00 UTC, regardless of the
    // process's local TZ.
    expect(iso).toBe("2026-01-15T05:00:00.000Z");
  });
});
