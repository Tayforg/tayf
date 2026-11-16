import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// ---------------------------------------------------------------------------
// h198-ekonomi-2: /ekonomi/KARCL drew the 12.11 five-minute chart under a header that prices the 13.11 session
// (the ticker had no bars for 13.11) with no sentence linking the two. The page now compares the chart's session
// day with the header's day and hands the result to intradayPanelMeta, which words it in one clause.
//
// Static on purpose: the page is an async server component, which this repo does not render in tests.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(here, "../../src/app/ekonomi/[ticker]/page.tsx");

describe("/ekonomi/<ticker> intraday panel meta names a newer header session", () => {
  const page = readFileSync(PAGE, "utf8");

  it("imports intradayBehindDay from the session lib", () => {
    expect(page).toMatch(/import\s*\{[^}]*\bintradayBehindDay\b[^}]*\}\s*from\s*"@\/lib\/finance\/session"/);
  });

  it("derives the header's day from the quote's session day, falling back to the stat's last day", () => {
    expect(page).toMatch(
      /const\s+headerDay\s*=\s*quoteSessionDay\(\s*quote\?\.asOf\s*\)\s*\?\?\s*\(\s*stat\s*\?\s*stat\.lastDay\.slice\(\s*0\s*,\s*10\s*\)\s*:\s*null\s*\)/,
    );
  });

  it("compares the chart's session day with that header day", () => {
    expect(page).toMatch(/const\s+behindDay\s*=\s*intradayBehindDay\(\s*sessionDay\s*,\s*headerDay\s*\)/);
  });

  it("passes behindDay as the third argument of intradayPanelMeta", () => {
    expect(page).toMatch(
      /intradayPanelMeta\(\s*sessionDay\s*,\s*cut\s*&&\s*lastBar\s*\?\s*lastBar\.ts\s*:\s*null\s*,\s*behindDay\s*\)/,
    );
  });

  it("holds none of the wording itself: the clause lives in session.ts", () => {
    expect(page).not.toContain("seansının verisi toplanmadı");
  });
});
