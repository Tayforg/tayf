import { describe, expect, it } from "vitest";

import corpusJson from "../../fixtures/ingest-corpus.json";
import * as legacy from "../../fixtures/ingest-corpus-legacy";
import {
  normalizeTurkish,
  shingleSet,
  strictFingerprint,
} from "../../../supabase/functions/_shared/cluster/fingerprint.ts";
import {
  completeItem,
  normalizeItem,
  prepareItem,
} from "../../../supabase/functions/_shared/rss/normalize.ts";
import type {
  NormalizeCounters,
  NormalizedArticle,
} from "../../../supabase/functions/_shared/rss/normalize.ts";
import type { RawFeedItem } from "../../../supabase/functions/_shared/rss/fetcher.ts";

// ---------------------------------------------------------------------------
// A-ingest-cpu (hunt-11): the ingest hot path was rewritten for CPU (one
// regex replace for the diacritic fold, one normalisation per fingerprint, a
// cheap prepare phase that runs before a stored-url lookup and a heavy
// complete phase that runs only for items that are not already stored).
//
// `articles.content_hash` is stored and deduplicated on, so none of that may
// change a single byte of output. This file pins it against
//   * tests/fixtures/ingest-corpus-legacy.ts, a verbatim copy of the old
//     normalizeTurkish / shingleSet / strictFingerprint, and
//   * tests/fixtures/ingest-corpus.json, ~500 real headlines and descriptions
//     (public text only) plus synthetic markup / entity / date / link
//     variants, with the hash and the normalised row that the code produced
//     BEFORE the rewrite frozen next to each item.
// ---------------------------------------------------------------------------

interface CorpusRow {
  slug: string;
  sourceUrl: string;
  item: RawFeedItem;
  expected: {
    hash: string | null;
    normalized: NormalizedArticle | null;
    contentless?: true;
  };
}

interface Corpus {
  nowMs: number;
  rows: CorpusRow[];
}

const corpus = corpusJson as unknown as Corpus;

function sourceOf(row: CorpusRow) {
  return { id: `src-${row.slug}`, name: row.slug, slug: row.slug, url: row.sourceUrl, rss_url: "" };
}

const setToSorted = (s: Set<string>): string[] => [...s].sort();

describe("ingest corpus fixture", () => {
  it("holds at least 200 rows and exercises the interesting shapes", () => {
    expect(corpus.rows.length).toBeGreaterThanOrEqual(200);
    expect(corpus.nowMs).toBe(1793000000000);

    const nulls = corpus.rows.filter((r) => r.expected.normalized === null);
    const contentless = corpus.rows.filter((r) => r.expected.contentless);
    const noHash = corpus.rows.filter((r) => r.expected.hash === null);
    // The fixture is only a good oracle while it keeps both outcomes of every
    // branch: dropped and kept rows, a null fingerprint (sha1(url) fallback),
    // contentless titles, relative links and a non-trivial slug spread.
    expect(nulls.length).toBeGreaterThan(0);
    expect(nulls.length).toBeLessThan(corpus.rows.length);
    expect(contentless.length).toBeGreaterThan(0);
    expect(noHash.length).toBeGreaterThan(0);
    expect(corpus.rows.some((r) => !/^https?:\/\//i.test(r.item.link ?? ""))).toBe(true);
    expect(new Set(corpus.rows.map((r) => r.slug)).size).toBeGreaterThan(10);
  });

  it("carries public text only: no field outside title, link, contentSnippet, pubDate", () => {
    const allowed = new Set(["title", "link", "contentSnippet", "pubDate"]);
    for (const row of corpus.rows) {
      expect(Object.keys(row).sort()).toEqual(["expected", "item", "slug", "sourceUrl"]);
      for (const key of Object.keys(row.item)) expect(allowed.has(key)).toBe(true);
    }
  });
});

describe("strictFingerprint over the ingest corpus", () => {
  it("equals the frozen legacy implementation and the recorded hash for every row", () => {
    const mismatches: string[] = [];
    for (const [i, row] of corpus.rows.entries()) {
      const fresh = strictFingerprint(row.item.title, row.item.contentSnippet);
      const old = legacy.strictFingerprint(row.item.title, row.item.contentSnippet);
      if (fresh !== old || fresh !== row.expected.hash) {
        mismatches.push(`#${i} fresh=${fresh} legacy=${old} recorded=${row.expected.hash}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("equals legacy on the cleaned title and description the pipeline actually hashes", () => {
    const mismatches: string[] = [];
    for (const [i, row] of corpus.rows.entries()) {
      const n = row.expected.normalized;
      if (!n) continue;
      if (strictFingerprint(n.title, n.description) !== legacy.strictFingerprint(n.title, n.description)) {
        mismatches.push(`#${i}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("normalizeTurkish / shingleSet over the ingest corpus", () => {
  it("equal legacy for the title, the description and title + ' ' + description", () => {
    const mismatches: string[] = [];
    for (const [i, row] of corpus.rows.entries()) {
      const title = row.item.title ?? "";
      const description = row.item.contentSnippet ?? "";
      for (const text of [title, description, `${title} ${description}`]) {
        if (normalizeTurkish(text) !== legacy.normalizeTurkish(text)) {
          mismatches.push(`normalizeTurkish #${i}`);
        }
        const a = setToSorted(shingleSet(text, null));
        const b = setToSorted(legacy.shingleSet(text, null));
        if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push(`shingleSet #${i}`);
      }
      const a = setToSorted(shingleSet(title, description));
      const b = setToSorted(legacy.shingleSet(title, description));
      if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push(`shingleSet(title, description) #${i}`);
      // A non-default shingle size takes the same path.
      const c = setToSorted(shingleSet(title, description, 3));
      const d = setToSorted(legacy.shingleSet(title, description, 3));
      if (JSON.stringify(c) !== JSON.stringify(d)) mismatches.push(`shingleSet n=3 #${i}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("equal legacy for every single UTF-16 code unit, alone and between letters", () => {
    const mismatches: number[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      for (const text of [ch, `a${ch}b`, `${ch}${ch}`]) {
        if (normalizeTurkish(text) !== legacy.normalizeTurkish(text)) {
          mismatches.push(c);
          break;
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("equal legacy on 4000 seeded random strings built from the characters that matter", () => {
    // Deterministic LCG: the test must not depend on Math.random.
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const alphabet = [
      ..."aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPrRsStTuUvVyYzZ",
      ..."şŞıİüÜöÖçÇğĞâÂîÎûÛ",
      ..."0123456789",
      " ", " ", " ", "\t", "\n", " ", "​", "̇", "İ", "İ",
      ".", ",", "-", "'", "’", "&", ";", "<", ">",
      "\u{1f600}", "\u{1f1f9}\u{1f1f7}", "\ud83d", "\ude00",
      "ß", "ǆ", "Σ", "ς", "ﬁ", "é", "ñ",
    ];
    const mismatches: string[] = [];
    for (let n = 0; n < 4000; n++) {
      const len = next() % 61;
      let title = "";
      for (let k = 0; k < len; k++) title += alphabet[next() % alphabet.length]!;
      const description = next() % 3 === 0 ? null : title.split("").reverse().join("");
      if (normalizeTurkish(title) !== legacy.normalizeTurkish(title)) mismatches.push(`norm ${JSON.stringify(title)}`);
      if (strictFingerprint(title, description) !== legacy.strictFingerprint(title, description)) {
        mismatches.push(`hash ${JSON.stringify(title)}`);
      }
      if (JSON.stringify(setToSorted(shingleSet(title, description))) !== JSON.stringify(setToSorted(legacy.shingleSet(title, description)))) {
        mismatches.push(`shingles ${JSON.stringify(title)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("keeps the empty / nullish contract", () => {
    for (const v of [null, undefined, ""]) {
      expect(normalizeTurkish(v)).toBe("");
      expect(strictFingerprint(v, v)).toBeNull();
      expect(shingleSet(v, v).size).toBe(0);
    }
  });
});

describe("normalizeItem over the ingest corpus", () => {
  it("returns exactly the row recorded before the rewrite (nulls included)", () => {
    const mismatches: string[] = [];
    for (const [i, row] of corpus.rows.entries()) {
      const got = normalizeItem(sourceOf(row), row.item, corpus.nowMs);
      if (JSON.stringify(got) !== JSON.stringify(row.expected.normalized)) mismatches.push(`#${i}`);
    }
    expect(mismatches).toEqual([]);
    // And structurally, so a key-order-only change cannot hide a type change.
    for (const row of corpus.rows) {
      expect(normalizeItem(sourceOf(row), row.item, corpus.nowMs)).toEqual(row.expected.normalized);
    }
  });

  it("counts a contentless title exactly where it was counted before", () => {
    for (const row of corpus.rows) {
      const counters: NormalizeCounters = { contentlessTitles: 0 };
      normalizeItem(sourceOf(row), row.item, corpus.nowMs, counters);
      expect(counters.contentlessTitles).toBe(row.expected.contentless ? 1 : 0);
    }
  });
});

describe("prepareItem + completeItem over the ingest corpus", () => {
  it("compose to exactly normalizeItem, nulls included, with identical contentless counts", () => {
    for (const row of corpus.rows) {
      const source = sourceOf(row);
      const whole: NormalizeCounters = { contentlessTitles: 0 };
      const expected = normalizeItem(source, row.item, corpus.nowMs, whole);

      const split: NormalizeCounters = { contentlessTitles: 0 };
      const prepared = prepareItem(source, row.item, split);
      const composed = prepared ? completeItem(source, prepared, corpus.nowMs) : null;

      expect(composed).toEqual(expected);
      expect(composed).toEqual(row.expected.normalized);
      // The counter fires in the prepare phase, whether or not completion runs.
      expect(split).toEqual(whole);
    }
  });

  it("prepareItem keeps the cheap derivations the stored-url lookup relies on", () => {
    for (const row of corpus.rows) {
      const expected = row.expected.normalized;
      const prepared = prepareItem(sourceOf(row), row.item);
      if (!expected) {
        // Dropped for a reason the heavy phase decides (a legal notice) still
        // prepares; the other drops (no link, contentless) never do.
        continue;
      }
      expect(prepared).not.toBeNull();
      expect(prepared!.title).toBe(expected.title);
      expect(prepared!.url).toBe(expected.url);
      expect(prepared!.item).toBe(row.item);
    }
  });

  it("prepareItem returns null without a link (silently) and for a contentless title (counted)", () => {
    const source = { id: "s", name: "s", slug: "s", url: "https://s.test", rss_url: "" };
    const counters: NormalizeCounters = { contentlessTitles: 0 };
    expect(prepareItem(source, { title: "Başlık", link: "  " }, counters)).toBeNull();
    expect(counters.contentlessTitles).toBe(0);
    expect(prepareItem(source, { title: "   ", link: "/a" }, counters)).toBeNull();
    expect(counters.contentlessTitles).toBe(1);
    expect(prepareItem(source, { title: "&nbsp", link: "/a" }, counters)).toBeNull();
    expect(counters.contentlessTitles).toBe(2);
    // A link-less contentless title is still silent: the link check is first.
    expect(prepareItem(source, { title: "-", link: "" }, counters)).toBeNull();
    expect(counters.contentlessTitles).toBe(2);
  });
});
