import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// browser-2 (footer CLS): the footer used to paint inside the first viewport
// beneath the short loading.tsx skeletons and was then pushed off-screen when
// the streamed content arrived (measured CLS 0.27 on /sources desktop,
// 0.03-0.08 on /ekonomi, /cluster and /blindspots). <main> now reserves at
// least one viewport minus the header, so the footer always starts below the
// first viewport while a skeleton shows. Moving an off-screen element is not
// counted as layout shift.

const layoutSource = readFileSync(resolve(__dirname, "layout.tsx"), "utf8");
const headerSource = readFileSync(
  resolve(__dirname, "../components/layout/header.tsx"),
  "utf8",
);

describe("root layout <main> — footer CLS guard", () => {
  it("reserves one small viewport minus the 59px header", () => {
    expect(layoutSource).toContain(
      '<main id="main" tabIndex={-1} className="flex-1 min-h-[calc(100svh-59px)]">',
    );
  });

  it("keeps the 59px offset equal to the HeaderFallback height", () => {
    // The `59px` in layout.tsx's calc() must stay equal to the height the
    // HeaderFallback reserves (header.tsx: 2px accent + 56px row + 1px
    // border). If the header height changes, change both numbers together —
    // otherwise the footer drifts into (or far below) the first viewport.
    expect(headerSource).toContain("h-[59px]");
  });
});
