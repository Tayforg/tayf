import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { NewClustersPill } from "./new-clusters-pill";

// ---------------------------------------------------------------------------
// The pill is client-only state: the server (and the first client render) must
// agree on an EMPTY live region, so there is nothing to hydrate-mismatch. The
// count only appears after the poller has run in an effect, which no static
// render executes. The poll/diff logic itself is covered in
// src/lib/clusters/timeline-head.test.ts.
// ---------------------------------------------------------------------------

describe("NewClustersPill -- server render", () => {
  const markup = renderToStaticMarkup(
    <NewClustersPill newestPublished="2026-09-18T10:00:00.000Z" knownIds={[]} />,
  );

  it("renders a polite status live region", () => {
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
  });

  it("makes the region a programmatic focus target (tabindex -1), not a tab stop", () => {
    expect(markup).toContain('tabindex="-1"');
  });

  it("renders no button and no count (SSR count is 0, hydration-safe)", () => {
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("yeni küme");
    expect(markup).not.toContain("Yenile");
    expect(markup).not.toContain("Liste güncellendi");
  });

  it("renders the same empty region when the page has no rows at all", () => {
    const empty = renderToStaticMarkup(
      <NewClustersPill newestPublished={null} knownIds={[]} />,
    );
    expect(empty).toContain('role="status"');
    expect(empty).not.toContain("<button");
  });
});

describe("NewClustersPill -- source guard", () => {
  const source = readFileSync(
    resolve(__dirname, "new-clusters-pill.tsx"),
    "utf8",
  );
  // Comments blanked so prose cannot trip or satisfy a check.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));

  it("is a client component that refreshes through the router and polls via startHeadPolling", () => {
    expect(source.trimStart().startsWith('"use client"')).toBe(true);
    expect(code).toMatch(/router\.refresh\(\)/);
    expect(code).toMatch(/startHeadPolling\s*\(/);
  });

  it("polls the head endpoint, with no query string (CDN key stays constant)", () => {
    expect(code).toMatch(/["']\/api\/timeline\/head["']/);
    expect(code).not.toMatch(/\/api\/timeline\/head\?/);
  });

  it("owns no raw interval and no randomness (the poller owns the schedule)", () => {
    expect(code).not.toMatch(/\bsetInterval\b/);
    expect(code).not.toMatch(/Math\.random/);
  });

  it("reads the clock only through the injected '() => Date.now()' dependency", () => {
    const all = code.match(/Date\.now/g) ?? [];
    const wrapped = code.match(/\(\)\s*=>\s*Date\.now\(\)/g) ?? [];
    expect(all.length).toBe(wrapped.length);
  });

  it("is named by its visible text: no aria-label (WCAG 2.5.3)", () => {
    expect(code).not.toMatch(/aria-label/);
  });

  it("keeps a target of at least 24 px (WCAG 2.2 2.5.8)", () => {
    expect(code).toMatch(/\bmin-h-8\b/);
  });

  it("clears the count before refreshing, inside a transition", () => {
    expect(code).toMatch(/setHit\(null\)/);
    expect(code).toMatch(/startTransition\(\s*\(\)\s*=>\s*(\{\s*)?router\.refresh\(\)/);
  });

  // Keyboard focus: a `disabled` button drops focus (HTML focus fixup), and once
  // the refresh settles the count is 0 and the button unmounts, so focus would
  // fall to <body>. The control stays focusable (aria-disabled + early return)
  // and the always-mounted status region takes focus back when it vanishes.
  it("never uses the `disabled` attribute on the button (aria-disabled + early return)", () => {
    expect(code).not.toMatch(/(?<![-\w])disabled\s*=/);
    expect(code).toMatch(/aria-disabled=\{/);
    expect(code).toMatch(/if\s*\(\s*pending\s*\)\s*return\b/);
  });

  it("hands focus to the status region when the refresh settles, without scrolling", () => {
    expect(code).toMatch(/tabIndex=\{-1\}/);
    expect(code).toMatch(/\.focus\(\s*\{\s*preventScroll:\s*true\s*\}\s*\)/);
    // Only rescue focus that was actually lost; never steal it from another control.
    expect(code).toMatch(/document\.body/);
  });

  it("confirms the refresh in the live region (WCAG 4.1.3)", () => {
    expect(code).toContain("Liste güncellendi");
  });
});
