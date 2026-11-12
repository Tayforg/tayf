import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CANDIDATE_SQL,
  MIN_DAYS,
  MIN_TITLES,
  WINDOW_DAYS,
  parseRows,
  run,
  unmatchedRows,
} from "./placeholder-candidates.mjs";

// The runbook helper for PLACEHOLDER_IMAGE_ASSETS (h164-heroimg-1): Karar and
// Istiklal rotate their 'SON DAKIKA' card file every 3-5 days, so the exact keys
// need a weekly look. The helper prints a read-only query, and given that
// query's rows it lists the images the placeholder rules do NOT yet match.

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "placeholder-candidates.mjs");

const row = (extra = {}) => ({
  source_id: "00000000-0000-4000-8000-000000000001",
  slug: "karar",
  image_url: "https://cdn.karar.com/news/1999999.jpg",
  titles: 12,
  days: 4,
  ...extra,
});

/** Run the CLI in-process with canned stdin; returns what it wrote and its exit code. */
function runCli(argv, stdin = "") {
  const out = [];
  const err = [];
  let stdinReads = 0;
  const code = run(argv, {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readStdin: () => {
      stdinReads++;
      return stdin;
    },
  });
  return { code, out: out.join("\n"), err: err.join("\n"), stdinReads };
}

describe("CANDIDATE_SQL", () => {
  it("names the thresholds: 7 days, >= 5 distinct titles, >= 3 distinct publication days", () => {
    expect(WINDOW_DAYS).toBe(7);
    expect(MIN_TITLES).toBe(5);
    expect(MIN_DAYS).toBe(3);
    expect(CANDIDATE_SQL).toContain("interval '7 days'");
    expect(CANDIDATE_SQL).toContain("count(distinct a.title) >= 5");
    expect(CANDIDATE_SQL).toContain("count(distinct a.published_at::date) >= 3");
  });

  it("groups per source_id and image_url", () => {
    expect(CANDIDATE_SQL).toMatch(/group by a\.source_id, [^\n]*a\.image_url/);
    expect(CANDIDATE_SQL).toContain("a.source_id");
    expect(CANDIDATE_SQL).toContain("a.image_url");
  });

  it("is one read-only SELECT: no write or DDL keyword, no second statement, no comment", () => {
    expect(CANDIDATE_SQL.trimStart().toLowerCase().startsWith("select ")).toBe(true);
    expect(CANDIDATE_SQL).not.toMatch(/;/);
    expect(CANDIDATE_SQL).not.toMatch(/--|\/\*/);
    const words = new Set(CANDIDATE_SQL.toLowerCase().split(/[^a-z_]+/));
    for (const word of ["insert", "update", "delete", "drop", "alter", "create", "truncate", "grant", "copy", "call"]) {
      expect(words.has(word)).toBe(false);
    }
    // The tokeniser does see real words (so the check above is not vacuous).
    expect(words.has("select")).toBe(true);
    expect(words.has("distinct")).toBe(true);
  });

  it("only reads public.articles and public.sources", () => {
    expect(CANDIDATE_SQL).toContain("from public.articles a");
    expect(CANDIDATE_SQL).toContain("join public.sources s");
  });
});

describe("parseRows", () => {
  it("parses the JSON array a read-only runner prints", () => {
    expect(parseRows(JSON.stringify([row(), row({ titles: 6 })]))).toHaveLength(2);
  });

  it("tolerates surrounding whitespace and a BOM", () => {
    expect(parseRows(`\uFEFF \n${JSON.stringify([row()])}\n `)).toHaveLength(1);
  });

  it("accepts an empty array", () => {
    expect(parseRows("[]")).toEqual([]);
  });

  it.each([
    ["empty input", ""],
    ["whitespace only", "  \n "],
    ["invalid JSON", "{not json"],
    ["an HTTP error line", 'HTTP 400 {"message":"statement timeout"}'],
    ["a JSON object", '{"rows":[]}'],
    ["a JSON string", '"x"'],
    ["null", "null"],
  ])("throws for %s", (_label, text) => {
    expect(() => parseRows(text)).toThrow(Error);
  });
});

describe("unmatchedRows", () => {
  it("drops the rows isPlaceholderImageUrl already matches and keeps the rest, in order", () => {
    const rows = [
      row({ image_url: "https://cdn.karar.com/news/1946618.jpg" }), // exact key (h164)
      row({ image_url: "https://cdn.karar.com/news/1999999.jpg", titles: 9 }), // unseen card
      row({ image_url: "https://www.indyturk.com/sites/default/files/default_images/index1.png" }), // directory rule
      row({ image_url: "https://img.piri.net/img/son-dakika.jpg" }), // basename rule
      row({ image_url: "https://cdn.istiklal.com.tr/news/700000.jpg", titles: 7 }), // unseen card
    ];
    const { unmatched, matched, unreadable } = unmatchedRows(rows);
    expect(unmatched.map((r) => r.image_url)).toEqual([
      "https://cdn.karar.com/news/1999999.jpg",
      "https://cdn.istiklal.com.tr/news/700000.jpg",
    ]);
    expect(matched).toBe(3);
    expect(unreadable).toBe(0);
  });

  it("matches through a doubled leading slash, a query and a resizer wrapper like the render filter", () => {
    const rows = [
      row({ image_url: "https://cdn.karar.com//news/1946618.jpg" }),
      row({ image_url: "https://cdn.karar.com/news/1946618.jpg?v=3" }),
      row({ image_url: "https://iaahbr.tmgrup.com.tr/c1/1/1/0/0/1/1?u=https://iahbr.tmgrup.com.tr/Defaults/Upload/ahbr-default-1754911102530.png" }),
    ];
    expect(unmatchedRows(rows)).toEqual({ unmatched: [], matched: 3, unreadable: 0 });
  });

  it("keeps every field of a kept row untouched", () => {
    const r = row({ extra: { nested: [1, 2] }, first_seen: "2026-11-06" });
    const { unmatched } = unmatchedRows([r]);
    expect(unmatched).toEqual([r]);
    expect(unmatched[0]).toBe(r);
  });

  it("counts rows without a usable image_url as unreadable and never throws", () => {
    const rows = [row({ image_url: null }), row({ image_url: "" }), row({ image_url: 42 }), null, "x", [], row({ image_url: undefined })];
    const out = unmatchedRows(rows);
    expect(out.unmatched).toEqual([]);
    expect(out.matched).toBe(0);
    expect(out.unreadable).toBe(7);
  });

  it("a row whose image_url is not an image URL at all is kept for a human to look at", () => {
    const { unmatched } = unmatchedRows([row({ image_url: "not a url" })]);
    expect(unmatched).toHaveLength(1);
  });

  it("handles a large result without trouble", () => {
    const rows = Array.from({ length: 20000 }, (_, i) => row({ image_url: `https://cdn.karar.com/news/${2000000 + i}.jpg` }));
    expect(unmatchedRows(rows).unmatched).toHaveLength(20000);
  });
});

describe("run", () => {
  it("--print-sql prints exactly the candidate query and never reads stdin", () => {
    const r = runCli(["--print-sql"], "ignored");
    expect(r.code).toBe(0);
    expect(r.out).toBe(CANDIDATE_SQL);
    expect(r.stdinReads).toBe(0);
  });

  it("prints the unmatched rows as a JSON array on stdout and a summary on stderr", () => {
    const input = JSON.stringify([
      row({ image_url: "https://cdn.karar.com/news/1946618.jpg" }),
      row({ image_url: "https://cdn.karar.com/news/1999999.jpg", titles: 9 }),
    ]);
    const r = runCli([], input);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([row({ image_url: "https://cdn.karar.com/news/1999999.jpg", titles: 9 })]);
    expect(r.err).toMatch(/2 rows/);
    expect(r.err).toMatch(/1 already matched/);
    expect(r.err).toMatch(/1 candidate/);
    expect(r.stdinReads).toBe(1);
  });

  it("prints [] when every row is already matched", () => {
    const r = runCli([], JSON.stringify([row({ image_url: "https://cdn.karar.com/news/1947232.jpg" })]));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
    expect(r.err).toMatch(/0 candidate/);
  });

  it("an empty result is fine (nothing recurred), not an error", () => {
    const r = runCli([], "[]");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
  });

  it("reports unreadable rows on stderr", () => {
    const r = runCli([], JSON.stringify([row({ image_url: null }), row()]));
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/1 unreadable/);
  });

  it.each([
    ["no input", ""],
    ["invalid JSON", "{nope"],
    ["a JSON object", "{}"],
  ])("exits 1 with a reason on stderr for %s, and writes nothing to stdout", (_label, input) => {
    const r = runCli([], input);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err.length).toBeGreaterThan(0);
  });

  it("exits 1 when stdin cannot be read", () => {
    const out = [];
    const err = [];
    const code = run([], {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      readStdin: () => {
        throw new Error("EAGAIN");
      },
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/EAGAIN/);
  });

  it("exits 2 with the usage on an unknown option or a stray argument", () => {
    for (const argv of [["--nope"], ["file.json"], ["--print-sql", "--nope"]]) {
      const r = runCli(argv);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/usage:/);
      expect(r.stdinReads).toBe(0);
    }
  });

  it("--help prints the usage and exits 0", () => {
    const r = runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/usage:/);
    expect(r.out).toMatch(/--print-sql/);
  });
});

describe("the CLI under plain Node (type stripping)", () => {
  // The script imports supabase/functions/_shared/image-url.ts directly, which
  // needs Node's built-in type stripping (on by default from Node 22.18).
  const strips = Boolean(process.features.typescript);

  it.skipIf(!strips)("--print-sql runs and prints the query", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--print-sql"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(CANDIDATE_SQL);
  });

  it.skipIf(!strips)("filters rows read from a real stdin pipe with the shipped placeholder rules", () => {
    const input = JSON.stringify([
      row({ image_url: "https://cdn.istiklal.com.tr/news/668615.jpg" }),
      row({ image_url: "https://cdn.istiklal.com.tr/news/700001.jpg" }),
    ]);
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", input });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).map((x) => x.image_url)).toEqual(["https://cdn.istiklal.com.tr/news/700001.jpg"]);
  });
});
