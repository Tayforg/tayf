import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BiasSpectrum } from "@/components/story/bias-spectrum";

import { toSavedRowView } from "./saved-row";

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

  it("reads rows through the saved_clusters_v2 RPC (bias_distribution and is_blindspot are in its return shape)", () => {
    expect(src.match(/\.rpc\("saved_clusters_v2"/g)).toHaveLength(1);
    expect(src).toMatch(/\.rpc\("saved_clusters_v2",\s*\{\s*p_ids:\s*ids\s*\}\)/);
    expect(src).toContain("bias_distribution: unknown");
    expect(src).toContain("is_blindspot?: boolean");
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

  it("one v2 lookup plus a PGRST202-only v1 fallback (no new fetch for the diet)", () => {
    expect(src.match(/\.rpc\("saved_clusters_v2"/g)).toHaveLength(1);
    expect(src.match(/\.rpc\("saved_clusters"/g)).toHaveLength(1);
    expect(src).toMatch(/\.rpc\("saved_clusters",\s*\{\s*p_ids:\s*ids\s*\}\)/);
    // The v1 call sits behind the PGRST202 check, after the v2 call.
    const code = src.replace(/\/\/[^\n]*/g, "");
    const v2At = code.indexOf('.rpc("saved_clusters_v2"');
    const codeAt = code.indexOf("PGRST202");
    const v1At = code.indexOf('.rpc("saved_clusters",');
    expect(v2At).toBeGreaterThan(-1);
    expect(codeAt).toBeGreaterThan(v2At);
    expect(v1At).toBeGreaterThan(codeAt);
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

describe("saved-list.tsx v2 lookup and v1 fallback", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");
  // Line comments removed, so prose can neither satisfy nor trip a code guard.
  const code = src.replace(/\/\/[^\n]*/g, "");

  it("falls back to v1 only when v2 is missing from the schema cache (PGRST202), before the shared error handling", () => {
    expect(src).toMatch(/const client = createBrowserClient\(\);/);
    expect(src).toMatch(/let res = await client\.rpc\("saved_clusters_v2",\s*\{\s*p_ids:\s*ids\s*\}\);/);
    expect(src).toMatch(
      /if \(res\.error\?\.code === "PGRST202"\) \{\s*res = await client\.rpc\("saved_clusters",\s*\{\s*p_ids:\s*ids\s*\}\);\s*\}/,
    );
    const fallbackAt = src.indexOf('res = await client.rpc("saved_clusters",');
    const errorAt = src.indexOf("const { data, error } = res;");
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(errorAt).toBeGreaterThan(fallbackAt);
    // Exactly one PostgREST error code ever triggers the fallback.
    expect(code.match(/PGRST\d+/g)).toEqual(["PGRST202"]);
  });

  it("keeps the fail-open path for every other error code", () => {
    expect(src).toContain("if (error) {");
    expect(src).toContain("setFailed(true);");
  });
});

describe("saved-list.tsx blindspot pill and spectrum bar", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");
  const card = readFileSync(join(__dirname, "..", "story", "cluster-card.tsx"), "utf8");

  /** className of the "Kör nokta" pill that cluster-card.tsx renders after its AlertTriangle. */
  function cardPillClass(): string {
    const m = card.match(/<span className="([^"]+)">\s*<AlertTriangle[^>]*\/>\s*Kör nokta\s*<\/span>/);
    if (!m || m[1] === undefined) throw new Error("Kör nokta pill not found in cluster-card.tsx");
    return m[1];
  }

  it("imports toSavedRowView and BiasSpectrum", () => {
    expect(src).toMatch(/import\s*\{[^}]*toSavedRowView[^}]*\}\s*from\s*["']@\/components\/bookmark\/saved-row["']/);
    expect(src).toMatch(/import\s*\{[^}]*BiasSpectrum[^}]*\}\s*from\s*["']@\/components\/story\/bias-spectrum["']/);
  });

  it("uses the Kör nokta pill class string of cluster-card.tsx, with the AA light-mode text shade (so the two cannot drift)", () => {
    const cls = cardPillClass();
    expect(cls).toContain("bg-amber-500/15");
    // cluster-card.tsx still carries text-amber-700, which measures 4.42:1 on
    // the 15 % amber wash (below the 4.5:1 AA floor for 11 px text, WCAG 1.4.3).
    // This list is already AA-fixed, so it matches the card everywhere except
    // that one shade; tests/guards/text-contrast-tokens.test.ts pins it.
    const aaCls = cls.replace("text-amber-700", "text-amber-800");
    expect(aaCls).toContain("text-amber-800");
    expect(src).toContain(`className="${aaCls}"`);
    expect(src).not.toContain("text-amber-700");
  });

  it("renders the pill only for view.isBlindspot, with a decorative icon and the 'Kör nokta' copy", () => {
    expect(src).toMatch(/const view = toSavedRowView\(row\);/);
    expect(src).toMatch(
      /view\.isBlindspot && \(\s*<span className="[^"]+">\s*<AlertTriangle className="h-3 w-3" aria-hidden="true" \/>\s*Kör nokta\s*<\/span>\s*\)/,
    );
    expect(src).toMatch(/import\s*\{[^}]*AlertTriangle[^}]*\}\s*from\s*["']lucide-react["']/);
  });

  it("renders the compact spectrum bar for a non-null distribution, inside the Link, after the meta line", () => {
    expect(src).toMatch(
      /view\.distribution && \(\s*<div className="mt-2">\s*<BiasSpectrum distribution=\{view\.distribution\} compact \/>\s*<\/div>\s*\)/,
    );
    const linkOpen = src.indexOf("<Link");
    const linkClose = src.indexOf("</Link>");
    const barAt = src.indexOf("<BiasSpectrum");
    const pillAt = src.indexOf("Kör nokta");
    const metaAt = src.indexOf("text-[11px] text-muted-foreground");
    expect(barAt).toBeGreaterThan(linkOpen);
    expect(barAt).toBeLessThan(linkClose);
    expect(pillAt).toBeGreaterThan(metaAt);
    expect(pillAt).toBeLessThan(barAt);
  });

  it("keeps the remove button a sibling of the Link and the copy unchanged", () => {
    const linkClose = src.indexOf("</Link>");
    const buttonAt = src.indexOf("<button");
    expect(buttonAt).toBeGreaterThan(linkClose);
    expect(src).toContain("Kaydedilenlerden çıkar");
    expect(src).toContain("Henüz kaydettiğiniz bir hikâye yok");
    expect(src).toContain("Kaydedilenler yüklenemedi. Lütfen sayfayı yenileyin.");
  });

  it("BiasSpectrum's compact bar contains no interactive element (safe to nest inside the Link)", () => {
    const view = toSavedRowView({ bias_distribution: { pro_government: 2, center: 1, opposition: 3 } });
    expect(view.distribution).not.toBeNull();
    const markup = renderToStaticMarkup(
      createElement(BiasSpectrum, { distribution: view.distribution!, compact: true }),
    );
    expect(markup).toContain("İktidar");
    expect(markup).not.toMatch(/<(a|button|input|select|textarea|summary)[\s>]/i);
    expect(markup).not.toMatch(/\b(href|onclick|tabindex)=/i);
  });
});
