/**
 * The screen-reader cue for a link that opens a new tab (WCAG G201 / 3.2.5
 * AAA, h60-newtab-1). A sighted reader sees the tab open; a screen-reader user
 * hears only the link text, so the context change comes as a surprise.
 *
 * Put <NewTabHint /> as the LAST child of every public `target="_blank"`
 * anchor, so the accessible name ends with "(yeni sekmede açılır)". It is an
 * sr-only span: no visual change. Where an aria-label overrides the anchor's
 * content (the share chips, the corner arrow on /kaynaklar) a child span is
 * never read, so append ` (${NEW_TAB_NOTICE})` to the label instead.
 * tests/guards/new-tab-hint.test.ts fails on a new `target="_blank"` without one
 * of the two. src/lib/embed/embed-html.ts builds its HTML as a string and
 * spells the same span out by hand (class "v").
 *
 * Hookless and stateless, so it renders in Server and Client Components alike.
 */
export const NEW_TAB_NOTICE = "yeni sekmede açılır";

export function NewTabHint() {
  // One template string, not " (" + {NOTICE} + ")": three adjacent text nodes
  // would be served with <!-- --> separators between them.
  return <span className="sr-only">{` (${NEW_TAB_NOTICE})`}</span>;
}
