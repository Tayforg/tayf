import { describe, it, expect } from "vitest";
import { BIAS_ORDER, SOURCE_KINDS } from "@/lib/bias/config";
import {
  MAX_SOURCE_URL_LENGTH,
  isValidSourceUrl,
  isBiasCategory,
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
