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

  it("reads rows through the saved_clusters RPC (bias_distribution is in its return shape)", () => {
    expect(src.match(/\.rpc\("saved_clusters"/g)).toHaveLength(1);
    expect(src).toMatch(/\.rpc\("saved_clusters",\s*\{\s*p_ids:\s*ids\s*\}\)/);
    expect(src).toContain("bias_distribution: unknown");
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

describe("saved-list.tsx reading-diet card", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");

  it("imports SavedMixCard from the saved-mix-card module", () => {
    expect(src).toMatch(/import\s*\{[^}]*SavedMixCard[^}]*\}\s*from\s*["']@\/components\/bookmark\/saved-mix-card["']/);
  });

  it("renders the card with the already-loaded rows", () => {
    expect(src).toContain("<SavedMixCard rows={rows} />");
  });

  it("does not import the click tracker (the diet is computed, never sent)", () => {
    expect(src).not.toContain("@/lib/track");
    expect(src).not.toMatch(/\btrack\(/);
  });

  it("still issues exactly one lookup, now the saved_clusters RPC (no new fetch for the diet)", () => {
    expect(src.match(/\.rpc\("saved_clusters"/g)).toHaveLength(1);
    // Array.from(...) is not a PostgREST table call.
    expect(src.match(/(?<!Array)\.from\(/g)).toBeNull();
  });
});

describe("saved-list.tsx RPC input hygiene", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");

  it("sends only well-formed UUIDs, capped at the newest 200 (the RPC's own cap)", () => {
    expect(src).toMatch(/const SAVED_RPC_MAX_IDS = 200;/);
    expect(src).toMatch(
      /const ids = idList\s*\.filter\(\(id\) => typeof id === "string" && UUID_RE\.test\(id\)\)\s*\.slice\(-SAVED_RPC_MAX_IDS\);/,
    );
  });

  it("short-circuits an empty id list without importing the client", () => {
    const emptyAt = src.indexOf("ids.length === 0");
    const importAt = src.indexOf(`await import("@/lib/supabase/browser")`);
    expect(emptyAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(emptyAt);
    expect(src.slice(emptyAt, importAt)).toMatch(/setRows\(\[\]\);[\s\S]*setFailed\(false\);[\s\S]*return;/);
  });

  it("keeps the fail-open error copy and prunes snapshots against the full saved list", () => {
    expect(src).toContain("Kaydedilenler yüklenemedi. Lütfen sayfayı yenileyin.");
    expect(src).toContain("pruneSnapshots(idList);");
  });
});
