import { describe, it, expect } from "vitest";
import { buildHeadlinePrompt, HEADLINE_PROMPT_TEMPLATE } from "./prompt";

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
