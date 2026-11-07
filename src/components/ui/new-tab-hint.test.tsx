import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { NEW_TAB_NOTICE, NewTabHint } from "./new-tab-hint";

// h60-newtab-1: the one shared "this link opens a new tab" cue for screen
// readers. The Turkish copy is asserted literally here on purpose: every
// other test may go through the constant, this one pins the words.
describe("NewTabHint", () => {
  it("keeps the Turkish copy 'yeni sekmede açılır'", () => {
    expect(NEW_TAB_NOTICE).toBe("yeni sekmede açılır");
  });

  it("renders a visually hidden span with a leading space and the notice in parentheses", () => {
    expect(renderToStaticMarkup(<NewTabHint />)).toBe(
      '<span class="sr-only"> (yeni sekmede açılır)</span>',
    );
  });

  it("extends the accessible name of the link it sits in, after the visible text", () => {
    const html = renderToStaticMarkup(
      <a href="https://example.com" target="_blank" rel="noopener noreferrer">
        Habere git
        <NewTabHint />
      </a>,
    );
    expect(html).toMatch(/>Habere git<span class="sr-only"> \(yeni sekmede açılır\)<\/span><\/a>$/);
  });
});
