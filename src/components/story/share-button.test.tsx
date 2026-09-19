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

// Acceptance criterion: the cluster page links the card at its own stable
// URL. Asserted on the rendered markup rather than via @testing-library —
// this suite runs in vitest's `node` environment with no DOM.
describe("ShareButton — Kartı indir link", () => {
  it("points at /cluster/<id>/kart and saves under a deterministic filename", () => {
    const html = renderToStaticMarkup(
      <ShareButton clusterId="3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b" title="t" />,
    );

    const anchorMatch = html.match(/<a[^>]*>[^<]*Kartı indir[^<]*<\/a>/);
    expect(anchorMatch).not.toBeNull();
    const anchor = anchorMatch![0];
    expect(anchor).toContain(
      'href="/cluster/3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b/kart"',
    );
    // KART-06: a valueless `download` would save an extensionless file,
    // since the URL's last segment is "kart".
    expect(anchor).toContain('download="tayf-kart.png"');
    expect(anchor).not.toContain('target="_blank"');
  });
});
