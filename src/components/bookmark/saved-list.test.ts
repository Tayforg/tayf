import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source guard (same approach as framing-game.test.tsx): saved-list.tsx must
// not statically import supabase-js into the /saved route's bundle — it
// should be pulled in lazily, inside the effect, only when there are
// bookmarked ids to look up.
describe("saved-list.tsx source", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");

  it("does not statically import the browser Supabase client", () => {
    expect(src).not.toMatch(/^\s*import\s*\{[^}]*createBrowserClient[^}]*\}\s*from\s*["']@\/lib\/supabase\/browser["']/m);
  });

  it("dynamically imports the browser Supabase client", () => {
    expect(src).toContain(`await import("@/lib/supabase/browser")`);
  });
});

describe("saved-list.tsx change badges", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");

  it("selects bias_distribution", () => {
    expect(src).toMatch(/\.select\("[^"]*bias_distribution[^"]*"\)/);
  });

  it("imports reconcileSnapshots and changeBadgeLabels", () => {
    expect(src).toMatch(/import\s*\{[^}]*reconcileSnapshots[^}]*\}\s*from\s*["']@\/components\/bookmark\/bookmark-snapshots["']/);
    expect(src).toMatch(/import\s*\{[^}]*changeBadgeLabels[^}]*\}\s*from\s*["']@\/components\/bookmark\/bookmark-snapshots["']/);
  });

  it("never touches localStorage directly and reads snapshots only inside the effect", () => {
    expect(src).not.toContain("localStorage");
    const effectAt = src.indexOf("useEffect(");
    const firstRead = src.indexOf("readSnapshots(");
    expect(effectAt).toBeGreaterThan(-1);
    expect(firstRead).toBeGreaterThan(effectAt);
    expect(src.indexOf("readSnapshots(", firstRead + 1)).toBe(-1);
  });
});
