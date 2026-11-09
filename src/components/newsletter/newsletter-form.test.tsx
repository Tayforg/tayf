import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

// A scripted `useState` (same device as framing-game.test.tsx and correction-form.test.tsx): while `scripted.values`
// is set, the form's useState calls (in declaration order, named from the source) return those values, so the real
// JSX of the "sending" state can be rendered with renderToStaticMarkup. Otherwise every call is the real useState.
const scripted = vi.hoisted(() => ({
  values: null as Record<string, unknown> | null,
  names: [] as string[],
  calls: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: ((initial: unknown) => {
      if (scripted.values !== null) {
        const name = scripted.names[scripted.calls++];
        if (name !== undefined && name in scripted.values) return [scripted.values[name], () => undefined];
      }
      return (actual.useState as (i: unknown) => unknown)(initial);
    }) as typeof actual.useState,
  };
});

import { NewsletterForm } from "./newsletter-form";

// ---------------------------------------------------------------------------
// h90-livearia-3: like the correction form, the newsletter button used
// `disabled={status === "sending"}`, which drops focus to <body> the moment the
// focused button is disabled. aria-disabled keeps it focusable, and the submit
// handler ignores a submit that arrives while one is in flight. The vitest
// environment is "node" (no DOM): markup through renderToStaticMarkup, the
// handler pinned on the source. Nothing here sends a request.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(resolve(__dirname, "newsletter-form.tsx"), "utf8");

const STATE_NAMES = [...SOURCE.matchAll(/const \[(\w+), set\w+\] = useState/g)].map((m) => m[1] as string);

function renderWithState(values: Record<string, unknown>): string {
  scripted.values = values;
  scripted.names = STATE_NAMES;
  scripted.calls = 0;
  try {
    return renderToStaticMarkup(<NewsletterForm />);
  } finally {
    scripted.values = null;
  }
}

function attrValue(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`, "i"))?.[1];
}

function submitTag(markup: string): string {
  const tags = markup.match(/<button\b[^>]*>/g) ?? [];
  expect(tags, "exactly one button in the form").toHaveLength(1);
  return tags[0] as string;
}

/** True when the tag carries the native boolean `disabled` attribute (not aria-disabled, not a disabled: class). */
function hasNativeDisabled(tag: string): boolean {
  return /\sdisabled(?=[\s=>])/.test(tag);
}

/** The text of `async function handleSubmit` up to the closing of the function. */
function handleSubmitSource(): string {
  const start = SOURCE.indexOf("async function handleSubmit");
  expect(start, "handleSubmit not found").toBeGreaterThan(-1);
  const end = SOURCE.indexOf("\n  }\n", start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("NewsletterForm -- the submit button keeps focus while sending [h90-livearia-3]", () => {
  it("the state script names the states it expects (the harness is not vacuous)", () => {
    expect(STATE_NAMES).toEqual(["status"]);
  });

  it("idle: 'Kaydol' with aria-disabled=\"false\" and no native disabled attribute", () => {
    const markup = renderToStaticMarkup(<NewsletterForm />);
    const tag = submitTag(markup);
    expect(attrValue(tag, "type")).toBe("submit");
    expect(attrValue(tag, "aria-disabled")).toBe("false");
    expect(hasNativeDisabled(tag)).toBe(false);
    expect(markup).toContain(">Kaydol</button>");
  });

  it("sending: aria-disabled=\"true\", no native disabled attribute, 'Kaydediliyor...' and aria-busy on the form", () => {
    const markup = renderWithState({ status: "sending" });
    const tag = submitTag(markup);
    expect(attrValue(tag, "aria-disabled")).toBe("true");
    expect(hasNativeDisabled(tag)).toBe(false);
    expect(markup).toContain("Kaydediliyor...");
    expect(markup).toMatch(/<form\b[^>]*\baria-busy="true"/);
  });

  it("error: the button is enabled again and the role=alert text is unchanged", () => {
    const markup = renderWithState({ status: "error" });
    expect(attrValue(submitTag(markup), "aria-disabled")).toBe("false");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Bir şeyler ters gitti, lütfen tekrar deneyin.");
  });

  it("styles the pending state with aria-disabled: variants, no disabled: variants left", () => {
    const cls = attrValue(submitTag(renderToStaticMarkup(<NewsletterForm />)), "class") ?? "";
    expect(cls).toContain("aria-disabled:pointer-events-none");
    expect(cls).toContain("aria-disabled:opacity-50");
    expect(cls).not.toMatch(/(?<![\w-])disabled:/);
    expect(SOURCE).not.toMatch(/(?<![\w-])disabled:/);
  });

  it("the source drives the attribute from the status, never disabled={...}", () => {
    expect(SOURCE).toContain('aria-disabled={status === "sending"}');
    expect(SOURCE).not.toMatch(/\sdisabled=\{/);
  });

  it("handleSubmit returns early while a submit is in flight, after preventDefault and before it sets 'sending'", () => {
    const body = handleSubmitSource();
    const prevent = body.indexOf("event.preventDefault();");
    const guard = body.indexOf('if (status === "sending") return;');
    const sending = body.indexOf('setStatus("sending");');
    expect(prevent).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(prevent);
    expect(sending).toBeGreaterThan(guard);
    expect(body.indexOf("fetch(")).toBeGreaterThan(guard);
  });

  it("leaves every piece of reader-facing copy and the honeypot untouched", () => {
    const markup = renderToStaticMarkup(<NewsletterForm />);
    expect(markup).toContain("Haftalık bülten");
    expect(markup).toContain("Cumartesi sabahı: iki tarafın ne yazdığı, tek mailde.");
    expect(markup).toContain("E-posta adresi");
    // React serialises `name` last on an <input>, so find the tag by it and check the rest inside the tag
    const honeypot = markup.match(/<input\b[^>]*\bname="website"[^>]*>/)?.[0] ?? "";
    expect(honeypot).not.toBe("");
    expect(honeypot).toContain('tabindex="-1"');
    expect(honeypot).toContain('aria-hidden="true"');
    expect(SOURCE).toContain("Onay bağlantısı e-posta adresinize gönderildi.");
    expect(SOURCE).toContain('body: JSON.stringify({ email, website })');
  });
});
