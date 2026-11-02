import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BIAS_ORDER, SOURCE_KINDS } from "@/lib/bias/config";
import {
  MAX_SOURCE_URL_LENGTH,
  WRITABLE_SOURCE_BIAS,
  isValidSourceUrl,
  isBiasCategory,
  isWritableSourceBias,
  isSourceKindValue,
  isValidSourceSlug,
  isValidSourceName,
} from "./source-input";

describe("isValidSourceUrl", () => {
  const accepted = [
    "https://www.example.com/feed.xml",
    "https://example.com.tr/rss?x=1",
    "https://www.example.com./feed.xml",
  ];

  it.each(accepted)("accepts %s", (value) => {
    expect(isValidSourceUrl(value)).toBe(true);
  });

  const rejected: Array<[string, unknown]> = [
    ["http (non-https)", "http://example.com/feed.xml"],
    ["non-http(s) scheme", "ftp://example.com/f"],
    ["javascript scheme", "javascript:alert(1)"],
    ["embedded credentials", "https://user:pass@example.com/"],
    ["IPv4 literal (loopback)", "https://127.0.0.1/x"],
    ["IPv4 literal (private 10/8)", "https://10.0.0.5/feed"],
    ["IPv4 literal (private 192.168/16)", "https://192.168.1.5/rss"],
    ["IPv4 literal (cloud metadata)", "https://169.254.169.254/latest/meta-data"],
    ["bracketed IPv6 literal", "https://[::1]/x"],
    ["localhost", "https://localhost/x"],
    [".local suffix", "https://intranet.local/x"],
    ["trailing-dot .internal", "https://attacker.internal./feed.xml"],
    ["trailing-dot .lan", "https://nas.lan./feed.xml"],
    ["trailing-dot .local", "https://intranet.local./x"],
    ["trailing-dot .home.arpa", "https://foo.home.arpa./x"],
    ["trailing-dot .localhost", "https://foo.localhost./x"],
    ["trailing-dot bare localhost", "https://localhost./x"],
    ["no dot in hostname", "https://box/"],
    ["over length cap", "https://example.com/" + "a".repeat(600)],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["null", null],
    ["number", 42],
    ["undefined", undefined],
  ];

  it.each(rejected)("rejects %s", (_label, value) => {
    expect(isValidSourceUrl(value)).toBe(false);
  });

  it("enforces MAX_SOURCE_URL_LENGTH as the exact cap", () => {
    const base = "https://example.com/";
    const path = "a".repeat(MAX_SOURCE_URL_LENGTH - base.length);
    const atCap = base + path;
    expect(atCap.length).toBe(MAX_SOURCE_URL_LENGTH);
    expect(isValidSourceUrl(atCap)).toBe(true);
    expect(isValidSourceUrl(atCap + "a")).toBe(false);
  });
});

describe("isBiasCategory", () => {
  it.each(BIAS_ORDER)("accepts contract bias %s", (bias) => {
    expect(isBiasCategory(bias)).toBe(true);
  });

  const rejected: Array<[string, unknown]> = [
    ["british spelling", "centre"],
    ["empty string", ""],
    ["null", null],
    ["wrong case", "PRO_GOVERNMENT"],
  ];

  it.each(rejected)("rejects %s", (_label, value) => {
    expect(isBiasCategory(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WRITABLE_SOURCE_BIAS mirrors production's live CHECK on sources.bias
// (sources_alignment_check, 2026-11-02): five of the ten BiasCategory keys.
// The other five parse as a BiasCategory (legacy rows still render) but a
// write of them is a 23514 in the database, so the admin API must refuse
// them before any DB call.
// ---------------------------------------------------------------------------
describe("WRITABLE_SOURCE_BIAS / isWritableSourceBias", () => {
  const FIVE = ["pro_government", "gov_leaning", "center", "opposition_leaning", "opposition"];
  const LEGACY = ["state_media", "islamist_conservative", "international", "pro_kurdish", "nationalist"];

  it("is exactly prod's five alignment keys, in spectrum order", () => {
    expect([...WRITABLE_SOURCE_BIAS]).toEqual(FIVE);
  });

  it.each(FIVE)("accepts writable key %s", (bias) => {
    expect(isWritableSourceBias(bias)).toBe(true);
  });

  it.each(LEGACY)("rejects legacy key %s (a BiasCategory, but not writable)", (bias) => {
    expect(isBiasCategory(bias)).toBe(true);
    expect(isWritableSourceBias(bias)).toBe(false);
  });

  it("the writable and legacy sets partition BIAS_ORDER", () => {
    expect([...FIVE, ...LEGACY].sort()).toEqual([...BIAS_ORDER].sort());
  });

  const rejected: Array<[string, unknown]> = [
    ["empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a number", 3],
    ["an object", { bias: "center" }],
    ["upper-case", "CENTER"],
    ["leading space", " center"],
    ["trailing space", "center "],
  ];

  it.each(rejected)("rejects %s", (_label, value) => {
    expect(isWritableSourceBias(value)).toBe(false);
  });

  it("every writable key is also a BiasCategory", () => {
    for (const bias of WRITABLE_SOURCE_BIAS) expect(isBiasCategory(bias)).toBe(true);
  });

  /** The quoted literals of one seed tuple line; '' inside a literal is an escaped quote. */
  function literals(line: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] !== "'") {
        i += 1;
        continue;
      }
      let value = "";
      i += 1;
      while (i < line.length) {
        if (line[i] === "'") {
          if (line[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          break;
        }
        value += line[i];
        i += 1;
      }
      out.push(value);
      i += 1;
    }
    return out;
  }

  it("every bias in supabase/seed_sources.sql is writable (the seed must run against prod's CHECK)", () => {
    const seed = readFileSync(resolve(__dirname, "../../../supabase/seed_sources.sql"), "utf8");
    const biases: string[] = [];
    for (const line of seed.split("\n")) {
      if (!line.trimStart().startsWith("('")) continue;
      const lits = literals(line);
      // ('name', 'slug', 'url', 'rss_url', 'bias', 'kind', active)
      expect(lits.length, line).toBeGreaterThanOrEqual(6);
      biases.push(lits[4] as string);
    }
    expect(biases.length).toBeGreaterThan(100);
    const offenders = biases.filter((b) => !isWritableSourceBias(b));
    expect(offenders).toEqual([]);
  });
});

describe("isSourceKindValue", () => {
  it.each(SOURCE_KINDS)("accepts contract kind %s", (kind) => {
    expect(isSourceKindValue(kind)).toBe(true);
  });

  const rejected: Array<[string, unknown]> = [
    ["plural typo", "outlets"],
    ["empty string", ""],
    ["null", null],
  ];

  it.each(rejected)("rejects %s", (_label, value) => {
    expect(isSourceKindValue(value)).toBe(false);
  });
});

describe("isValidSourceSlug", () => {
  const accepted = ["cumhuriyet", "t24-plus"];

  it.each(accepted)("accepts %s", (value) => {
    expect(isValidSourceSlug(value)).toBe(true);
  });

  const rejected: Array<[string, unknown]> = [
    ["uppercase", "Cumhuriyet"],
    ["leading hyphen", "-lead"],
    ["over 64 chars", "a".repeat(65)],
    ["empty string", ""],
  ];

  it.each(rejected)("rejects %s", (_label, value) => {
    expect(isValidSourceSlug(value)).toBe(false);
  });
});

describe("isValidSourceName", () => {
  it("accepts a normal name", () => {
    expect(isValidSourceName("Cumhuriyet")).toBe(true);
  });

  const rejected: Array<[string, unknown]> = [
    ["empty string", ""],
    ["whitespace only", "   "],
    ["over 120 chars", "x".repeat(121)],
  ];

  it.each(rejected)("rejects %s", (_label, value) => {
    expect(isValidSourceName(value)).toBe(false);
  });
});
