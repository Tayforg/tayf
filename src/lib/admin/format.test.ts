import { describe, it, expect } from "vitest";

import {
  fmtInt,
  fmtPct,
  fmtBytes,
  fmtUsd,
  fmtDateTime,
  fmtRelative,
  rateTone,
  parseStatePreview,
} from "./format";

describe("fmtInt", () => {
  it("returns the em dash for null/undefined/non-finite", () => {
    expect(fmtInt(null)).toBe("—");
    expect(fmtInt(undefined)).toBe("—");
    expect(fmtInt(Number.NaN)).toBe("—");
  });

  it("formats with tr-TR grouping", () => {
    expect(fmtInt(1234)).toBe("1.234");
    expect(fmtInt(0)).toBe("0");
  });
});

describe("fmtPct", () => {
  it("rounds 0..1 to a percent string", () => {
    expect(fmtPct(0.724)).toBe("%72");
    expect(fmtPct(1)).toBe("%100");
    expect(fmtPct(0)).toBe("%0");
  });

  it("returns the em dash for null", () => {
    expect(fmtPct(null)).toBe("—");
  });
});

describe("fmtBytes", () => {
  it("formats under 1024 as whole bytes", () => {
    expect(fmtBytes(812)).toBe("812 B");
  });

  it("formats KB/MB/GB with one decimal and a tr-TR comma", () => {
    expect(fmtBytes(1536)).toBe("1,5 KB");
    expect(fmtBytes(3_400_000)).toBe("3,2 MB");
    expect(fmtBytes(1_181_116_006)).toBe("1,1 GB");
  });
});

describe("fmtUsd", () => {
  it("formats with two digits and a trailing dollar sign by default", () => {
    expect(fmtUsd(0.42)).toBe("0,42 $");
  });

  it("respects a custom digit count", () => {
    expect(fmtUsd(1.5, 0)).toBe("2 $");
  });
});

describe("fmtDateTime", () => {
  it("returns the em dash for an unparseable date", () => {
    expect(fmtDateTime("bad")).toBe("—");
    expect(fmtDateTime(null)).toBe("—");
    expect(fmtDateTime(undefined)).toBe("—");
  });

  it("formats a valid ISO date pinned to Europe/Istanbul", () => {
    const out = fmtDateTime("2026-09-23T11:05:00Z");
    expect(out).toMatch(/^\d{2}\.\d{2}\.2026 \d{2}:\d{2}$/);
  });
});

describe("fmtRelative", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");

  it("returns the em dash for an unparseable date", () => {
    expect(fmtRelative("bad", now)).toBe("—");
    expect(fmtRelative(null, now)).toBe("—");
  });

  it("delegates to formatTurkishTimeAgo with a 7-day absolute cutoff", () => {
    expect(fmtRelative("2026-09-23T11:59:00Z", now)).toBe("1 dakika önce");
  });
});

describe("rateTone", () => {
  it("is muted for null/undefined", () => {
    expect(rateTone(null)).toBe("muted");
    expect(rateTone(undefined)).toBe("muted");
  });

  it("applies the default thresholds", () => {
    expect(rateTone(0.4)).toBe("bad");
    expect(rateTone(0.6)).toBe("warn");
    expect(rateTone(0.8)).toBe("ok");
  });

  it("respects custom thresholds", () => {
    expect(rateTone(0.6, { warnBelow: 0.5, badBelow: 0.3 })).toBe("ok");
    expect(rateTone(0.2, { warnBelow: 0.5, badBelow: 0.3 })).toBe("bad");
  });
});

describe("parseStatePreview", () => {
  it("maps a valid JSON object's known fields to Turkish labels", () => {
    const fields = parseStatePreview(
      JSON.stringify({ title: "Örnek Başlık", description: "Açıklama metni" }),
    );
    expect(fields).toEqual([
      { label: "Başlık", value: "Örnek Başlık" },
      { label: "Açıklama", value: "Açıklama metni" },
    ]);
  });

  it("falls back to a regex read for truncated JSON without throwing", () => {
    const fields = parseStatePreview('{"title":"Abc","description":"De…');
    expect(fields).not.toBeNull();
    expect(fields).toContainEqual({ label: "Başlık", value: "Abc" });
    expect(fields).toContainEqual({ label: "Açıklama", value: "De…" });
  });

  it("returns null for plain, non-JSON text", () => {
    expect(parseStatePreview("plain text, no fields here")).toBeNull();
  });

  it("never throws on malformed input", () => {
    expect(() => parseStatePreview('{"')).not.toThrow();
    expect(parseStatePreview('{"')).toBeNull();
  });

  it("skips null and empty values and keeps unknown keys as-is", () => {
    const fields = parseStatePreview(
      JSON.stringify({ mystery_key: "x", empty: "", nothing: null }),
    );
    expect(fields).toEqual([{ label: "mystery_key", value: "x" }]);
  });

  it("joins array values and stringifies nested objects", () => {
    const fields = parseStatePreview(
      JSON.stringify({ stock_codes: ["THYAO", "ASELS"], source: { slug: "aa" } }),
    );
    expect(fields).toEqual([
      { label: "Hisse kodları", value: "THYAO, ASELS" },
      { label: "Kaynak", value: JSON.stringify({ slug: "aa" }) },
    ]);
  });
});
