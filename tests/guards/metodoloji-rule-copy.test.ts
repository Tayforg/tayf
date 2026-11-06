import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { siblingTitlesMatch, SIBLING_VETO } from "@/lib/clusters/sibling-veto";
import {
  EXTRACTIVE_MIN_ARTICLE_COUNT,
  HEADLINE_MIN_ARTICLE_COUNT,
} from "@/lib/headline/prompt";

// h48-transparency-1: /metodoloji is the site's published rule contract, and
// two of its sentences misdescribed the code.
//
// 1. Headlines. The cron gates on `clusters.article_count` (member ARTICLES,
//    `.gte("article_count", ...)` in src/app/api/cron/headline/route.ts), not on
//    distinct outlets; the same outlet can contribute several members. The copy
//    said "kaynağı olan kümeler" (clusters with N sources). It must say "haberi"
//    (N articles), and the numbers must be the constants, never literals.
// 2. Sibling veto. The title rule is a Jaccard index over STEM sets
//    (src/lib/clusters/sibling-veto.ts), not "half of the words". The copy must
//    talk about stems ("kök"), name the word-length and stem-length cut-offs and
//    the shared-stem floor, and render all of them from SIBLING_VETO.
//
// How: the page source is read as text (the repo does not render-test server
// components for copy). Whitespace is collapsed first, because JSX wraps lines
// inside a sentence.

const ROOT = join(__dirname, "..", "..");
const PAGE = readFileSync(join(ROOT, "src", "app", "metodoloji", "page.tsx"), "utf8");

/** Runs of whitespace (JSX line wraps) collapsed to one space. */
function flat(text: string): string {
  return text.split(/\s+/).join(" ");
}

/** The text of `source` between the first `from` and the next `to` after it ("" when absent). */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  if (start === -1) return "";
  const end = source.indexOf(to, start + from.length);
  return end === -1 ? "" : source.slice(start, end);
}

/** `${...}` interpolations replaced by a placeholder, so only literal text is left. */
function withoutInterpolations(template: string): string {
  return template.replace(/\$\{[^}]*\}/g, "#");
}

const page = flat(PAGE);

// The Başlıklar section, up to its closing tag.
const headlines = between(page, '<section aria-labelledby="basliklar"', "</section>");

// The two rule paragraphs inside it: the LLM gate and the extractive fallback.
const llmParagraph = between(headlines, "En az {HEADLINE_MIN_ARTICLE_COUNT}", "</p>");
const extractiveParagraph = between(headlines, "LLM kapalıyken ara bir adım çalışır:", "</p>");

// The sibling-veto sentence: the template literal that opens with the window.
const siblingSentence = between(page, "{`Bu yüzden ${SIBLING_VETO.windowHours} saat", "`}");

describe("/metodoloji Başlıklar paragraphs count articles, not sources", () => {
  it("finds the Başlıklar section and both rule paragraphs (non-vacuous)", () => {
    expect(headlines).not.toBe("");
    expect(llmParagraph).not.toBe("");
    expect(extractiveParagraph).not.toBe("");
  });

  it('no longer says "kaynağı olan kümeler" anywhere in the Başlıklar section', () => {
    expect(headlines).not.toContain("kaynağı olan kümeler");
    expect(headlines).not.toContain("kaynağı olan küme");
  });

  it("the LLM gate interpolates HEADLINE_MIN_ARTICLE_COUNT next to \"haberi\"", () => {
    expect(llmParagraph).toContain("En az {HEADLINE_MIN_ARTICLE_COUNT} haberi olan kümeler için");
  });

  it("the extractive gate interpolates EXTRACTIVE_MIN_ARTICLE_COUNT next to \"haberi\"", () => {
    expect(extractiveParagraph).toContain(
      "en az {EXTRACTIVE_MIN_ARTICLE_COUNT} haberi olan kümeler için",
    );
  });

  it("neither gate is a digit literal", () => {
    expect(llmParagraph).not.toMatch(/[Ee]n az \d/);
    expect(extractiveParagraph).not.toMatch(/[Ee]n az \d/);
  });

  it("imports EXTRACTIVE_MIN_ARTICLE_COUNT from the headline prompt module, next to HEADLINE_MIN_ARTICLE_COUNT", () => {
    const names = /import \{([^}]*)\} from "@\/lib\/headline\/prompt"/.exec(page)?.[1] ?? "";
    expect(names).toContain("HEADLINE_MIN_ARTICLE_COUNT");
    expect(names).toContain("EXTRACTIVE_MIN_ARTICLE_COUNT");
  });
});

describe("/metodoloji sibling-veto sentence describes the stem-set rule", () => {
  it("finds the sentence (non-vacuous)", () => {
    expect(siblingSentence).not.toBe("");
  });

  it("renders the word-length cut-off, the stem length and the shared-stem floor from SIBLING_VETO", () => {
    expect(siblingSentence).toContain("${SIBLING_VETO.tokenMinLen}");
    expect(siblingSentence).toContain("${SIBLING_VETO.stemLen}");
    expect(siblingSentence).toContain("${SIBLING_VETO.minShared}");
  });

  it("carries no digit literal: every number in the sentence is an interpolation", () => {
    expect(withoutInterpolations(siblingSentence)).not.toMatch(/\d/);
  });

  it('talks about stems ("kök") and the union ("tüm köklerin ... en az yarısı"), not "half of the words"', () => {
    expect(siblingSentence).toContain("kök");
    expect(siblingSentence).toContain("iki başlıktaki tüm köklerin");
    expect(siblingSentence).toContain("en az yarısı");
    expect(siblingSentence).not.toContain("kelimelerin en az yarısı");
    expect(siblingSentence).not.toContain("kelime ortak");
  });

  it("the word \"yarısı\" is minJaccard (0.5): change the constant and this copy must change with it", () => {
    expect(SIBLING_VETO.minJaccard).toBe(0.5);
  });
});

describe("the copy is true of the code it quotes", () => {
  // "ortak köklerin sayısı ... iki başlıktaki tüm köklerin (ortak olanlar bir kez
  // sayılarak) en az yarısı": shared / (|A| + |B| - shared) >= 0.5.
  const A = "alfa beta gama delta";

  it("accepts shared stems that are exactly half of the union (3 of 6)", () => {
    expect(siblingTitlesMatch(A, "alfa beta gama kappa sigma")).toBe(true);
  });

  it("rejects shared stems that are just under half of the union (3 of 7)", () => {
    expect(siblingTitlesMatch(A, "alfa beta gama kappa sigma omega")).toBe(false);
  });

  it("counts a stem shared by both titles once in the union, not twice (3 of 5, not 3 of 8)", () => {
    expect(siblingTitlesMatch(A, "alfa beta gama kappa")).toBe(true);
  });

  it("needs minShared shared stems even when the union share is high (2 of 2)", () => {
    expect(SIBLING_VETO.minShared).toBe(3);
    expect(siblingTitlesMatch("alfa beta", "alfa beta")).toBe(false);
  });

  it("drops words shorter than tokenMinLen (7 short words would otherwise sink the union share to 3 of 10)", () => {
    expect(SIBLING_VETO.tokenMinLen).toBe(4);
    expect(siblingTitlesMatch("alfa beta gama ve bir iki uc on al ay", "alfa beta gama")).toBe(true);
  });

  it("cuts words to stemLen letters, so inflected forms share a stem", () => {
    expect(SIBLING_VETO.stemLen).toBe(5);
    // kazalar/kazalarda -> kazal, yaralar/yaralarda -> yaral, bakanlar/bakanlarda -> bakan.
    expect(siblingTitlesMatch("kazalar yaralar bakanlar", "kazalarda yaralarda bakanlarda")).toBe(true);
  });
});

describe("the article-count gates the copy quotes", () => {
  it("EXTRACTIVE_MIN_ARTICLE_COUNT is 2 (moved to the prompt module with the same value: the route's behaviour is unchanged)", () => {
    expect(EXTRACTIVE_MIN_ARTICLE_COUNT).toBe(2);
  });

  it("HEADLINE_MIN_ARTICLE_COUNT is 3", () => {
    expect(HEADLINE_MIN_ARTICLE_COUNT).toBe(3);
  });
});
