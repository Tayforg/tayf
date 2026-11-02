import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// footer.tsx is an async-child Server Component (ActiveSourceCount), so these
// assert on the SOURCE TEXT, same technique as tests/app/konu-routes.test.ts.
//
// /oyun was reachable only by typing the URL: no page linked to it (the only
// hit for "/oyun" in src/ was the page's own canonical), which is half of why
// framing_votes and zone_guesses stayed at 0 rows. The footer is rendered on
// every page, so one NAV_LINKS entry makes the games discoverable site-wide.
// ---------------------------------------------------------------------------

const footerSrc = readFileSync(
  resolve(__dirname, "../../src/components/layout/footer.tsx"),
  "utf-8",
);

describe("footer.tsx /oyun link", () => {
  it("NAV_LINKS carry exactly one link to /oyun", () => {
    const matches = footerSrc.match(/href:\s*"\/oyun"/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("labels it with the page's own Turkish name", () => {
    expect(footerSrc).toMatch(/\{\s*href:\s*"\/oyun",\s*label:\s*"Tarafı Tahmin Et"\s*\}/);
  });

  it("keeps the existing links (no accidental removal)", () => {
    for (const href of ["/", "/blindspots", "/sources", "/konu", "/metodoloji"]) {
      expect(footerSrc).toContain(`href: "${href}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// h17-a11y-3 (WCAG 2.1.4): single-key shortcuts can be switched off, and the
// switch lives in the "?" help dialog. A reader who has never heard of "?" (or
// who has turned the shortcuts off) still needs a way to open that dialog, so
// the footer carries a "Klavye kısayolları" button. The button is a tiny client
// component; the footer itself stays a Server Component.
// ---------------------------------------------------------------------------

describe("footer.tsx keyboard-shortcuts button", () => {
  it("imports ShortcutsHelpButton from the layout folder", () => {
    expect(footerSrc).toMatch(
      /import\s*\{\s*ShortcutsHelpButton\s*\}\s*from\s*"(\.\/shortcuts-help-button|@\/components\/layout\/shortcuts-help-button)"/,
    );
  });

  it("renders <ShortcutsHelpButton /> inside the 'Alt menü' nav", () => {
    const nav = /<nav aria-label="Alt menü"[\s\S]*?<\/nav>/.exec(footerSrc)?.[0] ?? "";
    expect(nav).toContain("<ShortcutsHelpButton />");
  });

  it("places it right after the RSS link", () => {
    const nav = /<nav aria-label="Alt menü"[\s\S]*?<\/nav>/.exec(footerSrc)?.[0] ?? "";
    const rssEnd = nav.indexOf("</a>", nav.indexOf('href="/rss.xml"'));
    const button = nav.indexOf("<ShortcutsHelpButton />");
    expect(rssEnd).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(rssEnd);
    expect(nav.slice(rssEnd + "</a>".length, button).trim()).toBe("");
  });

  it("stays a Server Component (no 'use client' directive)", () => {
    expect(footerSrc.trimStart().startsWith('"use client"')).toBe(false);
    expect(footerSrc.trimStart().startsWith("'use client'")).toBe(false);
  });
});
