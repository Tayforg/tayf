import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SHORTCUTS } from "@/lib/a11y/shortcut-pref";
import { ShortcutsHelpPanel } from "./kbd-shortcuts";
import { ShortcutsHelpButton } from "./layout/shortcuts-help-button";

// h17-a11y-3 (WCAG 2.1.4, 4.1.2, 2.4.3): the "?" overlay was a plain <div>
// with no role, name or focus handling, and the single-key shortcuts had no
// off switch. The help is now a native <dialog> opened with showModal() (top
// layer, rest of the page inert, Escape closes it), with a real switch inside.
//
// Behaviour that needs a browser (focus trap, focus return) is verified with
// real key events in the wave report; here we cover the presentational panel
// by markup and pin the wiring by source text.

const kbdSrc = readFileSync(resolve(__dirname, "kbd-shortcuts.tsx"), "utf-8");
const buttonSrc = readFileSync(resolve(__dirname, "layout/shortcuts-help-button.tsx"), "utf-8");

/** Blanks block and line comments (a `//` after `:` is a URL, not a comment). */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

const kbdCode = blankComments(kbdSrc);
const buttonCode = blankComments(buttonSrc);

function panel(enabled: boolean): string {
  return renderToStaticMarkup(
    <ShortcutsHelpPanel titleId="kbd-title" enabled={enabled} onToggle={() => undefined} />,
  );
}

/** The inner HTML of the first <label> in `html`. */
function labelInner(html: string): string {
  const m = /<label\b[^>]*>([\s\S]*?)<\/label>/.exec(html);
  if (!m) throw new Error("no <label> in markup");
  return m[1] ?? "";
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, "");

describe("ShortcutsHelpPanel", () => {
  it("renders the title as an <h2> carrying the id the dialog points at", () => {
    expect(panel(true)).toMatch(/<h2 id="kbd-title"[^>]*>Klavye kısayolları<\/h2>/);
  });

  it("lists every g-sequence with its label and both keys", () => {
    const html = panel(true);
    for (const s of SHORTCUTS) {
      expect(html).toContain(s.label);
      const [first, second] = s.keys;
      expect(html).toMatch(
        new RegExp(`<kbd[^>]*>${first}</kbd><span class="sr-only"> sonra </span><kbd[^>]*>${second}</kbd>`),
      );
    }
  });

  it("separates the two keys of a sequence with a screen-reader-only 'sonra'", () => {
    const count = (panel(true).match(/<span class="sr-only"> sonra <\/span>/g) ?? []).length;
    expect(count).toBe(SHORTCUTS.length);
  });

  it("lists the search and help keys", () => {
    const html = panel(true);
    expect(html).toMatch(/Ara<\/span><kbd[^>]*>\/<\/kbd>/);
    expect(html).toMatch(/Yardım<\/span><kbd[^>]*>\?<\/kbd>/);
  });

  it("renders the on/off control as a switch inside its label", () => {
    const html = panel(true);
    const inner = labelInner(html);
    expect(inner).toMatch(/<input type="checkbox" role="switch"/);
    // The label names the setting; the switch's own checked state carries
    // açık/kapalı (APG switch pattern), so the label must not state a state.
    expect(stripTags(inner).trim()).toBe("Tek tuş kısayolları");
  });

  it("keeps the label state-free whether shortcuts are on or off", () => {
    for (const enabled of [true, false]) {
      const text = stripTags(labelInner(panel(enabled))).trim();
      expect(text).not.toMatch(/açık|kapalı/i);
    }
  });

  it("marks the switch checked when shortcuts are enabled", () => {
    const input = /<input\b[^>]*>/.exec(labelInner(panel(true)))?.[0] ?? "";
    expect(input).toMatch(/\schecked(=""|\s|\/|>)/);
  });

  it("leaves the switch unchecked when shortcuts are disabled", () => {
    const input = /<input\b[^>]*>/.exec(labelInner(panel(false)))?.[0] ?? "";
    expect(input).toContain('role="switch"');
    expect(input).not.toMatch(/\schecked/);
  });

  it("explains how to get the dialog back once shortcuts are off", () => {
    const html = panel(true);
    expect(html).toContain(
      "Kapalıyken g ile başlayan kısayollar, / ve ? tuşları çalışmaz. " +
        "Bu pencereyi sayfanın altındaki “Klavye kısayolları” düğmesiyle yeniden açabilirsiniz.",
    );
  });

  it("closes through a method=dialog form with a visible 'Kapat' button", () => {
    const m = /<form method="dialog">([\s\S]*?)<\/form>/.exec(panel(true));
    expect(m).not.toBeNull();
    expect(m?.[1]).toMatch(/<button[^>]*>Kapat<\/button>/);
    expect(m?.[1]).toContain('type="submit"');
  });

  it("gives the Kapat button a visible focus ring", () => {
    const m = /<button[^>]*>Kapat<\/button>/.exec(panel(true));
    expect(m?.[0]).toContain("focus-visible:ring-2");
  });
});

describe("ShortcutsHelpButton", () => {
  const html = renderToStaticMarkup(<ShortcutsHelpButton />);

  it("is a plain button that announces it opens a dialog", () => {
    expect(html).toMatch(/^<button type="button" aria-haspopup="dialog"/);
  });

  it("carries the visible Turkish label", () => {
    expect(html).toMatch(/>Klavye kısayolları<\/button>$/);
  });

  it("has a visible focus ring and a 44px touch target on small screens", () => {
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain("max-sm:min-h-11");
  });
});

describe("kbd-shortcuts.tsx source", () => {
  it("keeps the KbdShortcuts export that layout.tsx mounts", () => {
    expect(kbdCode).toMatch(/export function KbdShortcuts\(/);
  });

  it("is a client module", () => {
    expect(kbdSrc.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("renders a native <dialog> opened with showModal() and named by its title", () => {
    expect(kbdCode).toContain("<dialog");
    expect(kbdCode).toContain("showModal()");
    expect(kbdCode).toContain("aria-labelledby");
    expect(kbdCode).toContain("onClose");
  });

  it("routes keys through the pure resolver and the stored preference", () => {
    expect(kbdCode).toContain("resolveShortcut(");
    expect(kbdCode).toContain("readShortcutsEnabled(");
    expect(kbdCode).toContain("writeShortcutsEnabled(");
    expect(kbdCode).toContain("SHORTCUTS_HELP_EVENT");
  });

  it("does not pull the Base UI dialog or any ui/ primitive into the public client graph", () => {
    expect(kbdCode).not.toMatch(/from\s+["']@\/components\/ui\//);
    expect(kbdCode).not.toMatch(/from\s+["'][^"']*@base-ui/);
    expect(kbdCode).not.toMatch(/from\s+["']@\/lib\/utils["']/);
  });

  it("does not fake a dialog with role=dialog", () => {
    expect(kbdCode).not.toMatch(/role=["']dialog["']/);
  });

  it("no longer handles Escape itself or runs a setTimeout for the g-sequence", () => {
    expect(kbdCode).not.toMatch(/["']Escape["']/);
    expect(kbdCode).not.toContain("setTimeout");
  });

  it("ignores key events that originate inside an open dialog", () => {
    expect(kbdCode).toContain("dialog[open]");
  });

  it("only mounts the dialog markup while open (SSR output stays empty)", () => {
    expect(kbdCode).toMatch(/if\s*\(\s*!open\s*\)\s*return null/);
  });
});

describe("shortcuts-help-button.tsx source", () => {
  it("is a client module", () => {
    expect(buttonSrc.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("fires the shared help event on window", () => {
    expect(buttonCode).toContain("SHORTCUTS_HELP_EVENT");
    expect(buttonCode).toContain("dispatchEvent(");
  });

  it("imports only the event name, nothing heavy", () => {
    const imports = [...buttonCode.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["@/lib/a11y/shortcut-pref"]);
  });
});
