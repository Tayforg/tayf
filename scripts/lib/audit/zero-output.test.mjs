import { describe, it, expect } from "vitest";
import { evaluateZeroOutput, ZERO_OUTPUT_WINDOW_HOURS } from "./zero-output.mjs";

describe("ZERO_OUTPUT_WINDOW_HOURS", () => {
  it("is 24", () => {
    expect(ZERO_OUTPUT_WINDOW_HOURS).toBe(24);
  });
});

describe("evaluateZeroOutput", () => {
  it("reports no failures when both counts are healthy and the key is present", () => {
    const { failures, lines } = evaluateZeroOutput({
      neutralTitles24h: 5,
      ingestCycles24h: 462,
      anthropicKeyPresent: true,
    });
    expect(failures).toEqual([]);
    expect(lines.some((l) => l.includes("5"))).toBe(true);
    expect(lines.some((l) => l.includes("462"))).toBe(true);
  });

  it("fails exactly once, mentioning 'neutral', when no cluster got a neutral title and the key is set", () => {
    const { failures } = evaluateZeroOutput({
      neutralTitles24h: 0,
      ingestCycles24h: 462,
      anthropicKeyPresent: true,
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/neutral/);
  });

  it("does not fail on zero neutral titles when the key is unset, and says so in a line", () => {
    const { failures, lines } = evaluateZeroOutput({
      neutralTitles24h: 0,
      ingestCycles24h: 462,
      anthropicKeyPresent: false,
    });
    expect(failures).toEqual([]);
    expect(lines.some((l) => l.includes("skipped"))).toBe(true);
  });

  it("fails exactly once, mentioning 'ingest_cycles', when ingest_cycles has zero rows", () => {
    const { failures } = evaluateZeroOutput({
      neutralTitles24h: 5,
      ingestCycles24h: 0,
      anthropicKeyPresent: true,
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/ingest_cycles/);
  });

  it("fails twice when both checks are zero and the key is present", () => {
    const { failures } = evaluateZeroOutput({
      neutralTitles24h: 0,
      ingestCycles24h: 0,
      anthropicKeyPresent: true,
    });
    expect(failures).toHaveLength(2);
    expect(failures.some((f) => f.includes("neutral"))).toBe(true);
    expect(failures.some((f) => f.includes("ingest_cycles"))).toBe(true);
    // Every failure string carries the literal digits of the observed
    // count (both are 0 here) so an operator can read the alarm without
    // cross-referencing the query.
    for (const f of failures) {
      expect(f).toMatch(/\d/);
      expect(f).toContain("0");
    }
  });

  it("fails once, naming the check, when a count could not be read (null)", () => {
    const { failures } = evaluateZeroOutput({
      neutralTitles24h: null,
      ingestCycles24h: 462,
      anthropicKeyPresent: true,
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/neutral/);
    expect(failures[0]).toMatch(/could not|unreadable|failed/i);
  });

  it("fails once, naming the check, when ingest count could not be read (undefined)", () => {
    const { failures } = evaluateZeroOutput({
      neutralTitles24h: 5,
      ingestCycles24h: undefined,
      anthropicKeyPresent: true,
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/ingest_cycles/);
    expect(failures[0]).toMatch(/could not|unreadable|failed/i);
  });

  it("carries the literal digits of the observed count in each numeric failure", () => {
    const neutralZero = evaluateZeroOutput({
      neutralTitles24h: 0,
      ingestCycles24h: 462,
      anthropicKeyPresent: true,
    });
    expect(neutralZero.failures[0]).toContain("0");

    const ingestZero = evaluateZeroOutput({
      neutralTitles24h: 5,
      ingestCycles24h: 0,
      anthropicKeyPresent: true,
    });
    expect(ingestZero.failures[0]).toContain("0");
  });

  it("always emits one line per check, regardless of pass/fail", () => {
    const { lines } = evaluateZeroOutput({
      neutralTitles24h: 5,
      ingestCycles24h: 462,
      anthropicKeyPresent: true,
    });
    expect(lines).toHaveLength(2);
  });
});
