import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SearchEcho } from "./search-echo";

// h23-a11y-4: the reader's query is echoed back on "/?q=" (the result count
// line and the empty-search card). It used to be printed verbatim, so a pasted
// URL of 170 unbroken characters pushed the page to 1193 px wide at a 390 px
// viewport (WCAG 1.4.10 Reflow). The echo now goes through displayQuery (60
// code points, 59 plus an ellipsis) AND carries the wrap classes, so a long
// unbroken run can neither grow the line nor force a horizontal scroll.

const html = (q: string | undefined, className?: string) =>
  renderToStaticMarkup(<SearchEcho q={q} className={className} />);

/** The text between the curly quotes of the rendered echo. */
function quoted(markup: string): string {
  const open = markup.indexOf("“");
  const close = markup.lastIndexOf("”");
  expect(open, "an opening quote").toBeGreaterThan(-1);
  expect(close, "a closing quote").toBeGreaterThan(open);
  return markup.slice(open + 1, close);
}

/** Longest run of one repeated character in `text` (character scan). */
function longestRun(text: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (const c of text) {
    run = c === ch ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

describe("SearchEcho", () => {
  it("wraps the quoted query in a span with the break classes", () => {
    const markup = html("seçim");
    expect(markup.startsWith("<span ")).toBe(true);
    expect(markup.endsWith("</span>")).toBe(true);
    expect(markup).toContain("break-words");
    expect(markup).toContain("[overflow-wrap:anywhere]");
    expect(markup).toContain("“seçim”");
  });

  it("appends a caller className after the break classes", () => {
    const markup = html("seçim", "text-foreground");
    expect(markup).toContain("break-words");
    expect(markup).toContain("[overflow-wrap:anywhere]");
    expect(markup).toContain("text-foreground");
    expect(markup.indexOf("[overflow-wrap:anywhere]")).toBeLessThan(
      markup.indexOf("text-foreground"),
    );
  });

  it("does not print 'undefined' or a stray space when there is no className", () => {
    const markup = html("seçim");
    expect(markup).not.toContain("undefined");
    expect(markup).toContain('class="break-words [overflow-wrap:anywhere]"');
  });

  it("caps a 300 character run at 59 characters plus an ellipsis, never the whole run", () => {
    const markup = html("a".repeat(300));
    expect(quoted(markup)).toBe(`${"a".repeat(59)}…`);
    expect(markup).not.toContain("a".repeat(60));
    expect(longestRun(markup, "a")).toBe(59);
  });

  it("keeps a query of exactly 60 code points whole", () => {
    expect(quoted(html("b".repeat(60)))).toBe("b".repeat(60));
  });

  it("trims and collapses whitespace like the title and the live region do", () => {
    expect(quoted(html("  seçim \t\n  erdoğan "))).toBe("seçim erdoğan");
  });

  it("is code point safe: an emoji at the cut is kept whole, never a lone surrogate", () => {
    const q = `${"a".repeat(58)}😀${"b".repeat(5)}`;
    const inner = quoted(html(q));
    expect(inner).toBe(`${"a".repeat(58)}😀…`);
    expect(Array.from(inner)).toHaveLength(60);
    expect(inner).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(inner).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("is code point safe for Turkish text", () => {
    const q = "İstanbul’da Şişli çağrı ğüşiöç ".repeat(8);
    const inner = quoted(html(q));
    const points = Array.from(inner);
    expect(points).toHaveLength(60);
    expect(points[59]).toBe("…");
    expect(inner.startsWith("İstanbul’da Şişli çağrı ğüşiöç İstanbul")).toBe(true);
    expect(inner).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("escapes markup in the query", () => {
    const markup = html("<script>alert(1)</script>");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("“&lt;script&gt;alert(1)&lt;/script&gt;”");
  });

  it("escapes quotes and ampersands too", () => {
    const markup = html('"x" & <b>');
    expect(markup).not.toContain("<b>");
    expect(markup).toContain("&amp;");
    expect(markup).toContain("&lt;b&gt;");
  });

  it.each([undefined, "", "   ", "\t\n "])(
    "renders nothing for the blank query %j (no empty pair of quotes)",
    (q) => {
      expect(html(q)).toBe("");
    },
  );
});
