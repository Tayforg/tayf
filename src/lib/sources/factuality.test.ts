import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

import { SOURCE_METADATA, getSourceMetadata } from "./factuality";
import { OWNER_GROUPS } from "./ownership";

/**
 * Every single-quoted SQL literal on one line, in order. A character scan, not
 * a regex: `''` inside a literal is an escaped quote and stays part of the
 * value, anything outside a literal (commas, `true`, `--` comments) is skipped.
 */
function quotedLiterals(line: string): string[] {
  const literals: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "'") {
      i += 1;
      continue;
    }
    let value = "";
    i += 1; // opening quote
    while (i < line.length) {
      const ch = line[i] as string;
      if (ch === "'") {
        if (line[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        break; // closing quote
      }
      value += ch;
      i += 1;
    }
    literals.push(value);
    i += 1; // closing quote
  }
  return literals;
}

/** Slugs of supabase/seed_sources.sql: the 2nd literal of every tuple line. */
function seedSlugs(sql: string): string[] {
  const slugs: string[] = [];
  for (const line of sql.split("\n")) {
    if (!line.trimStart().startsWith("('")) continue;
    const slug = quotedLiterals(line)[1];
    if (slug !== undefined) slugs.push(slug);
  }
  return slugs;
}

const SEED_SQL = readFileSync(
  resolve(__dirname, "../../../supabase/seed_sources.sql"),
  "utf8",
);

describe("SOURCE_METADATA ownerGroup", () => {
  it("every tagged entry has a non-null ownerGroup", () => {
    for (const [slug, meta] of Object.entries(SOURCE_METADATA)) {
      expect(meta.ownerGroup, `${slug} should have an ownerGroup`).not.toBeNull();
    }
  });

  it("every ownerGroup is a key of OWNER_GROUPS", () => {
    for (const [slug, meta] of Object.entries(SOURCE_METADATA)) {
      expect(
        Object.keys(OWNER_GROUPS),
        `${slug}'s ownerGroup "${meta.ownerGroup}" should be a known OWNER_GROUPS key`,
      ).toContain(meta.ownerGroup);
    }
  });
});

describe("Independent Türkçe is keyed by its live slug", () => {
  it("getSourceMetadata('indyturk') carries the mixed / SRMG tag", () => {
    const meta = getSourceMetadata("indyturk");

    expect(meta).not.toBeNull();
    expect(meta?.factuality).toBe("mixed");
    expect(meta?.ownerGroup).toBe("srmg");
    expect(meta?.ownership).toBe("Independent Türkçe (SRMG lisansı)");
  });

  it("the old registry key 'independent-turkce' no longer resolves", () => {
    expect(getSourceMetadata("independent-turkce")).toBeNull();
    expect(Object.keys(SOURCE_METADATA)).not.toContain("independent-turkce");
  });
});

describe("seed_sources.sql slug parser", () => {
  it("takes the 2nd literal of a tuple line", () => {
    const line =
      "  ('Sabah', 'sabah', 'https://www.sabah.com.tr', 'https://www.sabah.com.tr/rss/gundem.xml', 'pro_government', 'outlet', true),";
    expect(quotedLiterals(line)[1]).toBe("sabah");
  });

  it("honours '' escapes inside a literal and does not split on them", () => {
    const line = "  ('Cumhuriyet''in Sesi', 'cumhuriyet-sesi', 'https://x.example', 'https://x.example/rss', 'opposition', 'outlet', true),";
    expect(quotedLiterals(line)).toEqual([
      "Cumhuriyet'in Sesi",
      "cumhuriyet-sesi",
      "https://x.example",
      "https://x.example/rss",
      "opposition",
      "outlet",
    ]);
    expect(seedSlugs(line)).toEqual(["cumhuriyet-sesi"]);
  });

  it("keeps a '$' and other punctuation in a URL literal intact", () => {
    const line = "  ('VOA Türkçe', 'voa-turkce', 'https://www.voaturkce.com', 'https://www.voaturkce.com/api/zr$ymetqvi', 'international', 'outlet', false),";
    expect(quotedLiterals(line)[3]).toBe("https://www.voaturkce.com/api/zr$ymetqvi");
  });

  it("ignores comment, blank and non-tuple lines", () => {
    const sql = ["-- ('not', 'a-slug')", "", "  -- Pro-Government", "insert into sources (a) values", "on conflict (slug) do nothing;"].join("\n");
    expect(seedSlugs(sql)).toEqual([]);
  });

  it("finds more than 100 slugs in the real seed file, so the guard below is not vacuous", () => {
    const slugs = seedSlugs(SEED_SQL);

    expect(slugs.length).toBeGreaterThan(100);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain("sabah");
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("seeds Independent Türkçe as 'indyturk' and no longer as 'independent-turkce'", () => {
    const slugs = seedSlugs(SEED_SQL);

    expect(slugs).toContain("indyturk");
    expect(slugs).not.toContain("independent-turkce");
  });
});

// A registry key that matches no source slug is a tag that can never render
// (this is how 'independent-turkce' went unnoticed after the live slug became
// 'indyturk'). A future rename of either side now fails CI.
describe("SOURCE_METADATA keys round-trip to the seeded source slugs", () => {
  it("every SOURCE_METADATA key appears as a slug in supabase/seed_sources.sql", () => {
    const seeded = new Set(seedSlugs(SEED_SQL));
    const missing = Object.keys(SOURCE_METADATA).filter((key) => !seeded.has(key));

    expect(missing).toEqual([]);
  });
});
