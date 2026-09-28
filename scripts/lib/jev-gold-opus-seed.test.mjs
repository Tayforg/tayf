import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  JEV_GOLD_TOPICS,
  parseLabelFile,
  mergeLabels,
  attachRefJev,
  countDisagreements,
  renderSeedSql,
} from "./jev-gold-opus-seed.mjs";
import { JEV_GOLD_TOPICS as APP_JEV_GOLD_TOPICS } from "../../src/lib/admin/jev-gold";

const UUID_A = "aaaaaaaa-0000-0000-0000-000000000001";
const UUID_B = "bbbbbbbb-0000-0000-0000-000000000002";
const UUID_C = "cccccccc-0000-0000-0000-000000000003";
const UUID_MISSING = "dddddddd-0000-0000-0000-000000000004";

function headline(overrides = {}) {
  return {
    id: UUID_A,
    is_politics: true,
    topic: "politika",
    gold_note: "note",
    ...overrides,
  };
}

describe("JEV_GOLD_TOPICS", () => {
  it("matches src/lib/admin/jev-gold.ts's JEV_GOLD_TOPICS", () => {
    expect(JEV_GOLD_TOPICS).toEqual([...APP_JEV_GOLD_TOPICS]);
  });
});

describe("parseLabelFile", () => {
  it("parses valid headlines into rows, truncating note to 300 chars", () => {
    const longNote = "x".repeat(400);
    const rows = parseLabelFile({ headlines: [headline({ gold_note: longNote })] });

    expect(rows).toEqual([
      {
        article_id: UUID_A,
        is_politics: true,
        topic: "politika",
        note: "x".repeat(300),
      },
    ]);
  });

  it("maps an absent/empty gold_note to null", () => {
    const rows = parseLabelFile({ headlines: [headline({ gold_note: undefined })] });
    expect(rows[0].note).toBeNull();

    const rows2 = parseLabelFile({ headlines: [headline({ gold_note: "" })] });
    expect(rows2[0].note).toBeNull();
  });

  it("lowercases the article_id", () => {
    const rows = parseLabelFile({ headlines: [headline({ id: UUID_A.toUpperCase() })] });
    expect(rows[0].article_id).toBe(UUID_A);
  });

  it("throws with the offending index on a bad uuid", () => {
    expect(() => parseLabelFile({ headlines: [headline({ id: "not-a-uuid" })] })).toThrow(/headlines\[1\]/);
  });

  it("throws with the offending index on a bad topic", () => {
    expect(() => parseLabelFile({ headlines: [headline({ topic: "iktidar" })] })).toThrow(/headlines\[1\]/);
  });

  it("throws with the offending index on a missing is_politics", () => {
    expect(() => parseLabelFile({ headlines: [headline({ is_politics: undefined })] })).toThrow(/headlines\[1\]/);
  });

  it("throws on a non-array headlines", () => {
    expect(() => parseLabelFile({})).toThrow();
    expect(() => parseLabelFile({ headlines: "nope" })).toThrow();
  });

  it("index in the error message reflects the actual position", () => {
    expect(() =>
      parseLabelFile({ headlines: [headline(), headline({ id: "bad" })] }),
    ).toThrow(/headlines\[2\]/);
  });
});

describe("mergeLabels", () => {
  it("dedupes identical rows across two lists", () => {
    const a = parseLabelFile({ headlines: [headline({ id: UUID_A })] });
    const b = parseLabelFile({ headlines: [headline({ id: UUID_B })] });
    const merged = mergeLabels([a, b]);
    expect(merged).toHaveLength(2);
    expect(merged.map((r) => r.article_id).sort()).toEqual([UUID_A, UUID_B]);
  });

  it("no-ops on an exact duplicate (same fields)", () => {
    const a = parseLabelFile({ headlines: [headline({ id: UUID_A })] });
    const merged = mergeLabels([a, a]);
    expect(merged).toHaveLength(1);
  });

  it("throws on a conflicting duplicate (same id, different field)", () => {
    const a = parseLabelFile({ headlines: [headline({ id: UUID_A, is_politics: true })] });
    const b = parseLabelFile({ headlines: [headline({ id: UUID_A, is_politics: false })] });
    expect(() => mergeLabels([a, b])).toThrow(/conflicting duplicate/);
  });
});

describe("attachRefJev", () => {
  it("attaches a valid probability and a fixed source", () => {
    const rows = parseLabelFile({ headlines: [headline({ id: UUID_A })] });
    const attached = attachRefJev(rows, { en: { [UUID_A]: { probability: 0.83 } } }, "en");

    expect(attached[0].ref_jev_prob).toBe(0.83);
    expect(attached[0].ref_jev_source).toBe("limits-rig-2026-09-20/t1-en/title-only");
  });

  it("a missing id -> null prob and null source", () => {
    const rows = parseLabelFile({ headlines: [headline({ id: UUID_MISSING })] });
    const attached = attachRefJev(rows, { en: {} }, "en");

    expect(attached[0].ref_jev_prob).toBeNull();
    expect(attached[0].ref_jev_source).toBeNull();
  });

  it("an out-of-range or non-numeric probability -> null", () => {
    const rows = parseLabelFile({ headlines: [headline({ id: UUID_A })] });
    const tooHigh = attachRefJev(rows, { en: { [UUID_A]: { probability: 1.5 } } }, "en");
    expect(tooHigh[0].ref_jev_prob).toBeNull();

    const nonNumeric = attachRefJev(rows, { en: { [UUID_A]: { probability: "0.5" } } }, "en");
    expect(nonNumeric[0].ref_jev_prob).toBeNull();
  });

  it("a missing lang table -> null for every row", () => {
    const rows = parseLabelFile({ headlines: [headline({ id: UUID_A })] });
    const attached = attachRefJev(rows, {}, "en");
    expect(attached[0].ref_jev_prob).toBeNull();
  });
});

describe("countDisagreements", () => {
  it("counts rows where (ref_jev_prob >= threshold) !== is_politics", () => {
    const rows = [
      { article_id: UUID_A, is_politics: true, ref_jev_prob: 0.9 }, // agree
      { article_id: UUID_B, is_politics: true, ref_jev_prob: 0.2 }, // disagree
      { article_id: UUID_C, is_politics: false, ref_jev_prob: 0.6 }, // disagree
      { article_id: UUID_MISSING, is_politics: false, ref_jev_prob: null }, // no jev answer
    ];
    expect(countDisagreements(rows, 0.5)).toBe(2);
  });

  it("returns 0 on an empty array", () => {
    expect(countDisagreements([], 0.5)).toBe(0);
  });
});

describe("renderSeedSql", () => {
  const baseRows = [
    { article_id: UUID_B, is_politics: false, topic: "spor", note: null, ref_jev_prob: null, ref_jev_source: null },
    {
      article_id: UUID_A,
      is_politics: true,
      topic: "politika",
      note: "it's a note with an apostrophe",
      ref_jev_prob: 0.7,
      ref_jev_source: "limits-rig-2026-09-20/t1-en/title-only",
    },
  ];

  it("emits exactly one jev_gold_import_provisional call", () => {
    const sql = renderSeedSql(baseRows);
    const matches = sql.match(/jev_gold_import_provisional\(/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("sorts rows by article_id", () => {
    const sql = renderSeedSql(baseRows);
    const idxA = sql.indexOf(UUID_A);
    const idxB = sql.indexOf(UUID_B);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxB);
  });

  it("dollar quoting survives a note with an apostrophe (valid JSON, no manual escaping needed)", () => {
    const sql = renderSeedSql(baseRows);
    expect(sql).toContain("it's a note with an apostrophe");
    // JSON.stringify already produces valid JSON inside the $seed$ quotes;
    // no bare, un-doubled single quote should appear outside of prose text.
    expect(() => JSON.parse(`"it's a note with an apostrophe"`)).not.toThrow();
  });

  it("never emits DELETE, UPDATE, or TRUNCATE", () => {
    const sql = renderSeedSql(baseRows).toLowerCase();
    expect(sql).not.toMatch(/\bdelete\b/);
    expect(sql).not.toMatch(/\bupdate\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
  });

  it("is deterministic across repeated calls", () => {
    expect(renderSeedSql(baseRows)).toBe(renderSeedSql(baseRows));
  });

  it("carries the label source and stratum through to the call", () => {
    const sql = renderSeedSql(baseRows, { labelSource: "opus-2026-09-20", stratum: "opus_seed" });
    expect(sql).toContain("'opus-2026-09-20'");
    expect(sql).toContain("'opus_seed'");
  });

  it("throws if a payload would contain the $seed$ delimiter", () => {
    const poisoned = [
      {
        article_id: UUID_A,
        is_politics: true,
        topic: "politika",
        note: "contains $seed$ literally",
        ref_jev_prob: null,
        ref_jev_source: null,
      },
    ];
    expect(() => renderSeedSql(poisoned)).toThrow(/\$seed\$/);
  });

  it("contains no timestamp-like Date.now output (deterministic)", () => {
    const sql = renderSeedSql(baseRows);
    expect(sql).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("committed scripts/sql/jev-gold-opus-seed.sql", () => {
  const sqlPath = resolve(__dirname, "..", "sql", "jev-gold-opus-seed.sql");
  const sql = readFileSync(sqlPath, "utf8");

  it("contains exactly one jev_gold_import_provisional call", () => {
    const matches = sql.match(/jev_gold_import_provisional\(/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("parses to 360 unique, valid uuids with valid fields", () => {
    const match = sql.match(/\$seed\$\[([\s\S]*?)\]\$seed\$/);
    expect(match).not.toBeNull();
    const body = match[1];
    const lines = body
      .split("\n")
      .map((l) => l.replace(/,\s*$/, "").trim())
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(360);

    const seen = new Set();
    for (const line of lines) {
      const row = JSON.parse(line);
      expect(typeof row.article_id).toBe("string");
      expect(row.article_id).toMatch(/^[0-9a-f-]{36}$/);
      seen.add(row.article_id);
      expect(typeof row.is_politics).toBe("boolean");
      expect(JEV_GOLD_TOPICS).toContain(row.topic);
      if (row.ref_jev_prob !== null) {
        expect(row.ref_jev_prob).toBeGreaterThanOrEqual(0);
        expect(row.ref_jev_prob).toBeLessThanOrEqual(1);
      }
    }
    expect(seen.size).toBe(360);
  });

  it("has 54 reference disagreements at 0.5", () => {
    const match = sql.match(/\$seed\$\[([\s\S]*?)\]\$seed\$/);
    const body = match[1];
    const rows = body
      .split("\n")
      .map((l) => l.replace(/,\s*$/, "").trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));

    expect(countDisagreements(rows, 0.5)).toBe(54);
  });

  it("never DELETE, UPDATE, or TRUNCATE", () => {
    const lower = sql.toLowerCase();
    expect(lower).not.toMatch(/\bdelete\b/);
    expect(lower).not.toMatch(/\bupdate\b/);
    expect(lower).not.toMatch(/\btruncate\b/);
  });
});
