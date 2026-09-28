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
