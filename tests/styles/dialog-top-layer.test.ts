import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Opening "Klavye kısayolları" threw the reader to the top of the page and left
// focus off-screen after close. The shortcuts help is a native <dialog> opened
// with showModal() and it is a direct child of <body> (layout.tsx). The global
// `@layer base { body > * { position: relative } }` is an author rule, so it
// beats the user-agent `dialog:modal { position: fixed }` and forces the
// top-layer dialog to `position: relative`, which the engine blockifies to
// `absolute`. An absolutely positioned dialog is laid out at the document top,
// and showModal() scrolls the page there. Excluding <dialog> from the rule lets
// the UA's fixed positioning apply again; `:where()` keeps the specificity at
// (0,0,1), exactly what `body > *` had, so nothing else changes.
//
// CodeQL: literal includes only; no regular expression runs over the source.

const ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const GLOBALS_CSS = read("src/app/globals.css");
const LAYOUT = read("src/app/layout.tsx");
const KBD_SHORTCUTS = read("src/components/kbd-shortcuts.tsx");

const WHY =
  "A top-layer <dialog> whose position is not fixed or absolute is forced to absolute and " +
  "laid out at the document top, so showModal() scrolls the page to 0 and closing leaves " +
  "focus off-screen.";

const SELECTOR = "body > :where(:not(dialog))";

/** The text from `needle` up to and including the first closing brace after it. */
function ruleBody(css: string, needle: string): string {
  const at = css.indexOf(needle);
  if (at === -1) throw new Error(`no rule starting with ${needle} in globals.css`);
  const close = css.indexOf("}", at);
  return css.slice(at, close + 1);
}

describe("top-layer <dialog> is not forced out of position:fixed", () => {
  it("globals.css no longer has the universal `body > * {` rule", () => {
    expect(
      GLOBALS_CSS.includes("body > * {"),
      `${WHY} The universal body-child rule must not come back; exclude dialog or scope it.`,
    ).toBe(false);
  });

  it("globals.css excludes <dialog> from the body-child stacking rule", () => {
    expect(
      GLOBALS_CSS.includes(SELECTOR),
      `${WHY} The rule must read \`${SELECTOR}\` (specificity stays 0,0,1).`,
    ).toBe(true);
  });

  it("the scoped rule still lifts header, main and footer above the body::before vignette", () => {
    const body = ruleBody(GLOBALS_CSS, SELECTOR);
    expect(body.includes("position: relative;"), `${WHY} Other body children keep position: relative.`).toBe(true);
    expect(body.includes("z-index: 1;"), "Other body children keep z-index: 1 above the vignette.").toBe(true);
  });

  it("the shortcuts help is still a direct <body> child opened with showModal()", () => {
    expect(
      LAYOUT.includes("<KbdShortcuts />"),
      `${WHY} KbdShortcuts is mounted in layout.tsx as a body child; if it moves, re-check this rule.`,
    ).toBe(true);
    expect(
      KBD_SHORTCUTS.includes("showModal"),
      `${WHY} The help opens with showModal(); if it stops, this guard can be revisited.`,
    ).toBe(true);
  });
});
