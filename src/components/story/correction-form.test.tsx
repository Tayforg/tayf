import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// CorrectionForm reads ?cluster= / ?source= via next/navigation, which needs
// the App Router context that is absent when rendering the component alone.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

import { CorrectionForm } from "./correction-form";

/** The serialised opening tag of the <input>/<textarea> carrying `attr="value"`. */
function tagWith(markup: string, attr: string, value: string): string {
  const match = markup.match(
    new RegExp(`<(?:input|textarea)\\b[^>]*\\b${attr}="${value}"[^>]*>`),
  );
  expect(match, `no element with ${attr}="${value}" in the markup`).not.toBeNull();
  return match![0];
}

/**
 * Value of an attribute inside one serialised tag. Case-insensitive on the
 * name: React serialises `autoComplete` / `tabIndex` however its attribute
 * table says, and HTML attribute names are case-insensitive anyway.
 */
function attrValue(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`, "i"))?.[1];
}

describe("CorrectionForm — input purpose (WCAG 1.3.5)", () => {
  const markup = renderToStaticMarkup(<CorrectionForm />);

  it("marks the reporter's own e-mail field as type=email with autocomplete=email", () => {
    const tag = tagWith(markup, "id", "correction-email");
    expect(attrValue(tag, "type")).toBe("email");
    expect(attrValue(tag, "autocomplete")).toBe("email");
  });

  it("opts the article-URL field out of autofill (it is not the user's own URL)", () => {
    const tag = tagWith(markup, "id", "correction-url");
    expect(attrValue(tag, "type")).toBe("url");
    expect(attrValue(tag, "autocomplete")).toBe("off");
  });

  it("opts the free-text message out of autofill", () => {
    const tag = tagWith(markup, "id", "correction-message");
    expect(attrValue(tag, "autocomplete")).toBe("off");
  });

  it("leaves the honeypot unchanged (hidden, untabbable, autocomplete off)", () => {
    const tag = tagWith(markup, "name", "website");
    expect(attrValue(tag, "type")).toBe("text");
    expect(attrValue(tag, "tabindex")).toBe("-1");
    expect(attrValue(tag, "autocomplete")).toBe("off");
    expect(attrValue(tag, "aria-hidden")).toBe("true");
  });
});
