import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CrossSpectrumCaption } from "./cross-spectrum-caption";

// ---------------------------------------------------------------------------
// h194-a11y-1 (WCAG 1.3.1 / 2.4.6): the 'Sürpriz kesişimler' label used to be a
// styled <p> and the 'Neden?' link a bare link, so a screen-reader user who
// navigates by heading never reached the note. The label is now a real <h2> that
// names its own <section>, with no visible change: same classes, same copy.
// ---------------------------------------------------------------------------

const LINES = ["İlke TV (muhalefet) de bu habere yer verdi"];

const render = (lines: string[] = LINES) =>
  renderToStaticMarkup(<CrossSpectrumCaption lines={lines} />);

/** `{ id, text }` of every <h2> in the markup (text = its string content, tags excluded). */
function h2s(html: string): { id: string | null; text: string }[] {
  return [...html.matchAll(/<h2\b([^>]*)>([^<]*)<\/h2>/g)].map((m) => ({
    id: m[1]!.match(/\bid="([^"]*)"/)?.[1] ?? null,
    text: m[2]!,
  }));
}

describe("<CrossSpectrumCaption> heading (h194-a11y-1)", () => {
  it("renders the label as exactly one <h2> reading 'Sürpriz kesişimler'", () => {
    const found = h2s(render());
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toBe("Sürpriz kesişimler");
    expect(found[0]!.id).toBeTruthy();
  });

  it("no longer renders the label as a styled <p>", () => {
    expect(render()).not.toMatch(/<p\b[^>]*>\s*Sürpriz kesişimler\s*<\/p>/);
  });

  it("wraps everything in a <section> whose aria-labelledby is the <h2>'s id", () => {
    const html = render();
    const id = h2s(html)[0]!.id;
    expect(html.startsWith("<section ")).toBe(true);
    expect(html).toContain(`<section aria-labelledby="${id}"`);
    // Exactly one element carries that id, so the reference is unambiguous.
    expect(html.match(new RegExp(`\\sid="${id}"`, "g"))).toHaveLength(1);
  });

  it("keeps the heading id stable: 'surpriz-kesisimler'", () => {
    expect(h2s(render())[0]!.id).toBe("surpriz-kesisimler");
  });

  it("keeps the 'Neden?' link visible text and adds an sr-only 'sürpriz kesişimler' suffix inside it", () => {
    const html = render();
    const link = html.match(/<a\b[^>]*href="\/metodoloji#surpriz"[^>]*>([\s\S]*?)<\/a>/);
    expect(link).not.toBeNull();
    const inner = link![1]!;
    // The visible text still starts the link name (WCAG 2.5.3 label in name) ...
    expect(inner.startsWith("Neden?")).toBe(true);
    // ... and the sr-only part names what the link is about.
    expect(inner).toContain('<span class="sr-only">');
    expect(inner).toContain("sürpriz kesişimler");
  });

  it("keeps every line as its own paragraph", () => {
    const lines = ["İlke TV (muhalefet) de bu habere yer verdi", "Cumhuriyet (muhalefet) de yer verdi"];
    const html = render(lines);
    for (const line of lines) expect(html).toContain(`>${line}</p>`);
    expect(html.match(/<p\b/g)).toHaveLength(lines.length);
  });

  it("keeps the same visual classes on the wrapper, the label and the link (no visible change)", () => {
    // The label is an h2 and globals.css gives every h1-h3 the serif heading font,
    // so it carries font-sans (tracking-wider already overrides the heading's
    // -0.02em) to stay the sans label it was.
    const html = render();
    expect(html).toContain(
      'class="flex items-start gap-2.5 rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-4 py-3"',
    );
    expect(html).toContain(
      'class="font-sans text-xs font-semibold uppercase tracking-wider text-yellow-800 dark:text-yellow-400"',
    );
    expect(html).toContain(
      'class="text-[11px] text-yellow-800 dark:text-yellow-400 underline decoration-dotted underline-offset-2 hover:text-yellow-900 dark:hover:text-yellow-300"',
    );
  });

  it("renders null for an empty list: no section, no heading, no id", () => {
    const html = render([]);
    expect(html).toBe("");
    expect(h2s(html)).toHaveLength(0);
  });
});
