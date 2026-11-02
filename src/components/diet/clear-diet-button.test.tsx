import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ClearDietButton,
  ClearDietView,
  focusTargetFor,
  type ClearDietStep,
} from "./clear-diet-button";

// WCAG 2.4.3 / 4.1.3 for the /diyetim 'Verilerimi sil' flow: every step swaps
// the element the reader just activated for another one, so each transition
// hands focus to the element that replaces it, and the outcome messages are
// focusable (a status paragraph that mounts together with its text is often
// not announced).

const STEPS: readonly ClearDietStep[] = ["idle", "confirm", "done", "failed"];

const FOCUS_RING = ["focus-visible:outline-none", "focus-visible:ring-2", "focus-visible:ring-ring"];

/** Serialised opening tags of `<name ...>` in static markup (character scan, no regex over markup). */
function openingTags(markup: string, name: string): string[] {
  const tags: string[] = [];
  const needle = `<${name}`;
  let from = 0;
  for (;;) {
    const at = markup.indexOf(needle, from);
    if (at < 0) break;
    const after = markup[at + needle.length];
    const end = markup.indexOf(">", at);
    if (end > 0 && (after === " " || after === ">")) tags.push(markup.slice(at, end + 1));
    from = at + needle.length;
  }
  return tags;
}

/** Value of `name="..."` inside one serialised tag, undefined when absent. */
function attr(tag: string, name: string): string | undefined {
  const needle = ` ${name}="`;
  const at = tag.indexOf(needle);
  if (at < 0) return undefined;
  const start = at + needle.length;
  return tag.slice(start, tag.indexOf('"', start));
}

function view(step: ClearDietStep): string {
  return renderToStaticMarkup(
    <ClearDietView
      step={step}
      promptId="clear-diet-prompt"
      onAsk={() => {}}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );
}

describe("focusTargetFor", () => {
  it("idle -> confirm focuses the safe choice, 'Vazgeç'", () => {
    expect(focusTargetFor("idle", "confirm")).toBe("cancel");
  });

  it("confirm -> idle (cancelled) returns focus to the trigger", () => {
    expect(focusTargetFor("confirm", "idle")).toBe("trigger");
  });

  it("confirm -> done focuses the status message", () => {
    expect(focusTargetFor("confirm", "done")).toBe("status");
  });

  it("confirm -> failed focuses the alert message", () => {
    expect(focusTargetFor("confirm", "failed")).toBe("alert");
  });

  it("an unchanged step (the initial mount) moves nothing", () => {
    for (const step of STEPS) expect(focusTargetFor(step, step)).toBeNull();
  });

  it("every other pair moves nothing", () => {
    const named = new Set(["idle>confirm", "confirm>idle", "confirm>done", "confirm>failed"]);
    for (const prev of STEPS) {
      for (const next of STEPS) {
        if (prev === next || named.has(`${prev}>${next}`)) continue;
        expect(focusTargetFor(prev, next), `${prev} -> ${next}`).toBeNull();
      }
    }
  });
});

describe("ClearDietView", () => {
  it("idle: a single 'Verilerimi sil' trigger button", () => {
    const markup = view("idle");
    const buttons = openingTags(markup, "button");
    expect(buttons).toHaveLength(1);
    expect(attr(buttons[0]!, "type")).toBe("button");
    expect(markup).toContain(">Verilerimi sil</button>");
    expect(markup).not.toContain("Emin misiniz?");
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
  });

  it("confirm: a labelled group with the question and the two choices", () => {
    const markup = view("confirm");
    const groups = openingTags(markup, "div");
    expect(groups).toHaveLength(1);
    expect(attr(groups[0]!, "role")).toBe("group");
    expect(attr(groups[0]!, "aria-labelledby")).toBe("clear-diet-prompt");
    expect(markup).toContain('<span id="clear-diet-prompt">Emin misiniz?</span>');
    expect(markup).toContain(">Evet, sil</button>");
    expect(markup).toContain(">Vazgeç</button>");
    expect(openingTags(markup, "button")).toHaveLength(2);
    expect(markup).not.toContain("Verilerimi sil");
  });

  it("done: a focusable status paragraph", () => {
    const markup = view("done");
    const paragraphs = openingTags(markup, "p");
    expect(paragraphs).toHaveLength(1);
    expect(attr(paragraphs[0]!, "role")).toBe("status");
    expect(attr(paragraphs[0]!, "tabindex")).toBe("-1");
    expect(markup).toContain(">Haber diyeti verileriniz bu cihazdan silindi.</p>");
    expect(openingTags(markup, "button")).toHaveLength(0);
  });

  it("failed: a focusable alert paragraph", () => {
    const markup = view("failed");
    const paragraphs = openingTags(markup, "p");
    expect(paragraphs).toHaveLength(1);
    expect(attr(paragraphs[0]!, "role")).toBe("alert");
    expect(attr(paragraphs[0]!, "tabindex")).toBe("-1");
    expect(markup).toContain(
      ">Silinemedi: tarayıcı yerel depolamaya erişime izin vermiyor.</p>",
    );
    expect(openingTags(markup, "button")).toHaveLength(0);
  });

  it("keeps a visible focus ring on all three buttons", () => {
    const buttons = [...openingTags(view("idle"), "button"), ...openingTags(view("confirm"), "button")];
    expect(buttons).toHaveLength(3);
    for (const tag of buttons) {
      const classes = (attr(tag, "class") ?? "").split(" ");
      for (const token of FOCUS_RING) expect(classes, `${tag} lacks ${token}`).toContain(token);
    }
  });
});

describe("ClearDietButton before hydration", () => {
  it("renders the idle trigger (the server snapshot has storage available)", () => {
    const markup = renderToStaticMarkup(<ClearDietButton />);
    expect(markup).toContain(">Verilerimi sil</button>");
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
  });
});

describe("clear-diet-button.tsx source", () => {
  const src = readFileSync(join(__dirname, "clear-diet-button.tsx"), "utf8");
  const componentAt = src.indexOf("export function ClearDietButton");

  it("declares every hook above the 'storage unavailable' early return", () => {
    expect(componentAt).toBeGreaterThan(-1);
    const component = src.slice(componentAt);
    const earlyReturn = component.indexOf("if (!available) return null;");
    expect(earlyReturn).toBeGreaterThan(-1);
    for (const hook of ["useReadingDiet(", "useState", "useId(", "useRef", "useEffect("]) {
      expect(component.indexOf(hook), hook).toBeGreaterThan(-1);
      expect(component.lastIndexOf(hook), hook).toBeLessThan(earlyReturn);
    }
  });

  it("applies focusTargetFor from an effect keyed on the step", () => {
    const component = src.slice(componentAt);
    const keyedAt = component.indexOf("}, [step]);");
    expect(keyedAt).toBeGreaterThan(-1);
    const effect = component.slice(component.lastIndexOf("useEffect(", keyedAt), keyedAt);
    expect(effect).toContain("focusTargetFor(prevStep.current, step)");
    expect(effect).toContain(".focus()");
    // prevStep is advanced before focusing, so the next transition compares against this one.
    expect(effect.indexOf("prevStep.current = step")).toBeGreaterThan(-1);
    expect(effect.indexOf("prevStep.current = step")).toBeLessThan(effect.indexOf(".focus()"));
  });

  it("leaves the destructive action on the existing store function", () => {
    expect(src).toMatch(/import\s*\{[^}]*clearDiet[^}]*\}\s*from\s*["']@\/lib\/diet\/diet-store["']/);
    expect(src).toContain("clearDiet() ? \"done\" : \"failed\"");
  });
});
