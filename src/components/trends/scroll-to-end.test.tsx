import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  isAtStart,
  ScrollHint,
  ScrollToEnd,
  scrollToEndIfOverflowing,
} from "./scroll-to-end";

// browser-5: at 390 px the /trends chart scroller opened at scrollLeft 0, so
// the oldest days showed and the newest bar was off-screen. <ScrollToEnd>
// scrolls its overflow container to the newest day on mount and shows a
// "← önceki günler" hint while older days remain off-screen to the left.

describe("scrollToEndIfOverflowing", () => {
  it("scrolls to the end and returns true when content overflows", () => {
    const el = { scrollWidth: 640, clientWidth: 324, scrollLeft: 0 };
    expect(scrollToEndIfOverflowing(el)).toBe(true);
    expect(el.scrollLeft).toBe(640);
  });

  it("returns false and leaves scrollLeft alone when nothing overflows", () => {
    const el = { scrollWidth: 324, clientWidth: 324, scrollLeft: 0 };
    expect(scrollToEndIfOverflowing(el)).toBe(false);
    expect(el.scrollLeft).toBe(0);
  });

  it("treats a 1px rounding difference as not overflowing", () => {
    const el = { scrollWidth: 325, clientWidth: 324, scrollLeft: 0 };
    expect(scrollToEndIfOverflowing(el)).toBe(false);
    expect(el.scrollLeft).toBe(0);
  });

  it("treats 2px of extra width as overflowing", () => {
    const el = { scrollWidth: 326, clientWidth: 324, scrollLeft: 0 };
    expect(scrollToEndIfOverflowing(el)).toBe(true);
    expect(el.scrollLeft).toBe(326);
  });
});

describe("isAtStart", () => {
  it("is true at scrollLeft 0", () => {
    expect(isAtStart({ scrollLeft: 0 })).toBe(true);
  });

  it("is true within 1px of the start (sub-pixel rounding)", () => {
    expect(isAtStart({ scrollLeft: 1 })).toBe(true);
  });

  it("is false once scrolled away from the start", () => {
    expect(isAtStart({ scrollLeft: 316 })).toBe(false);
    expect(isAtStart({ scrollLeft: 2 })).toBe(false);
  });
});

describe("<ScrollToEnd> — server markup", () => {
  const markup = renderToStaticMarkup(
    <ScrollToEnd className="w-full overflow-x-auto spectrum-glow">
      <svg />
    </ScrollToEnd>,
  );

  it("renders the scroller div with exactly the given className around the child", () => {
    expect(markup).toContain('<div class="w-full overflow-x-auto spectrum-glow">');
    expect(markup).toContain("<svg></svg>");
  });

  it("renders no hint on the server (initial state is not overflowing; SSR must match the first client render)", () => {
    expect(markup).not.toContain("önceki günler");
    expect(markup).not.toContain("kaydırılabilir");
    expect(markup).not.toContain("pointer-events-none");
  });
});

describe("<ScrollHint>", () => {
  const markup = renderToStaticMarkup(<ScrollHint />);

  it("says 'önceki günler'", () => {
    expect(markup).toContain("önceki günler");
  });

  it("hides the arrow from assistive tech", () => {
    expect(markup).toContain('<span aria-hidden="true">← </span>');
  });

  it("gives screen readers the scrollable-chart note", () => {
    expect(markup).toContain(
      '<span class="sr-only"> (grafik yatay kaydırılabilir)</span>',
    );
  });

  it("renders an aria-hidden, non-interactive left fade", () => {
    expect(markup).toMatch(
      /<div aria-hidden="true" class="[^"]*pointer-events-none[^"]*bg-gradient-to-r[^"]*"><\/div>/,
    );
  });

  it("keeps the hint text itself non-interactive", () => {
    expect(markup).toMatch(/<p class="pointer-events-none[^"]*">/);
  });
});

describe("scroll-to-end.tsx — source guard", () => {
  const source = readFileSync(resolve(__dirname, "scroll-to-end.tsx"), "utf8");

  it("is a client component", () => {
    expect(source.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("attaches via a stable useCallback ref", () => {
    expect(source).toMatch(/useCallback\(/);
  });

  it("does not use an effect hook (react-hooks/set-state-in-effect)", () => {
    expect(source).not.toMatch(/useEffect|useLayoutEffect/);
  });

  it("renders the hint only while overflowing and not at the start", () => {
    expect(source).toContain("overflowing && !atStart");
  });
});
