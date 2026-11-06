import { describe, it, expect } from "vitest";
import {
  buildHeadlinePrompt,
  EXTRACTIVE_MIN_ARTICLE_COUNT,
  HEADLINE_MIN_ARTICLE_COUNT,
  HEADLINE_PROMPT_TEMPLATE,
} from "./prompt";

describe("article-count gates", () => {
  // The cron route imports both from this module; migrations 127 and 141 carry
  // hand-written copies of the numbers. Changing either is a behaviour change
  // (and a new migration), not a copy edit, so pin them here.
  it("the extractive gate is 2 member articles (moved here from the cron route, same value)", () => {
    expect(EXTRACTIVE_MIN_ARTICLE_COUNT).toBe(2);
  });

  it("the LLM gate is 3 member articles, stricter than the extractive gate", () => {
    expect(HEADLINE_MIN_ARTICLE_COUNT).toBe(3);
    expect(HEADLINE_MIN_ARTICLE_COUNT).toBeGreaterThan(EXTRACTIVE_MIN_ARTICLE_COUNT);
  });
});

describe("buildHeadlinePrompt", () => {
  it("builds the numbered title list exactly like the old inline template literal", () => {
    const titles = ["Dolar yükseldi", "Merkez Bankası açıklama yaptı"];
    const expected = HEADLINE_PROMPT_TEMPLATE.replace(
      "{titles}",
      titles.map((t, i) => `${i + 1}. ${t}`).join("\n"),
    );
    expect(buildHeadlinePrompt(titles)).toBe(expected);
  });

  it("does not corrupt the prompt when a title contains regex-replacement patterns ($', $&, $$)", () => {
    const titles = ["Dolar 40$'ı aştı", "Petrol $& yükseldi", "Kur $$ olay"];
    const result = buildHeadlinePrompt(titles);

    // The {titles} placeholder must be fully gone (not re-inserted via $&).
    expect(result).not.toContain("{titles}");
    // The template's closing line must survive, not be spliced mid-list.
    expect(result.trim().endsWith("TARAFSIZ TOPLU BAŞLIK:")).toBe(true);
    // Every literal title must appear verbatim, untouched by $-substitution.
    for (const t of titles) {
      expect(result).toContain(t);
    }
  });
});
