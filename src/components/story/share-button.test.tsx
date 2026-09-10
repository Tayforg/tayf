import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ShareButton } from "./share-button";

// react-a11y-1: the live region must NOT be a descendant of the <button> —
// ARIA 1.2 marks `button` children-presentational, so a role="status"
// nested inside it is never exposed to assistive tech.
describe("ShareButton — a11y live region", () => {
  it("keeps the live region outside the button, and the button itself free of status semantics", () => {
    const html = renderToStaticMarkup(
      <ShareButton clusterId="c1" title="t" />,
    );

    const buttonMatch = html.match(/<button[^]*?<\/button>/);
    expect(buttonMatch).not.toBeNull();
    const button = buttonMatch![0];
    expect(button).not.toContain('role="status"');

    const afterButton = html.slice(html.indexOf(button) + button.length);
    const statusMatch = afterButton.match(/<span[^>]*role="status"[^>]*>([^<]*)<\/span>/);
    expect(statusMatch).not.toBeNull();
    expect(statusMatch![0]).toContain('aria-live="polite"');
    expect(statusMatch![1]).toBe("");
  });
});
