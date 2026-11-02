import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SITE_REDIRECTS } from "./redirects";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const APP_DIR = join(ROOT, "src/app");

describe("SITE_REDIRECTS", () => {
  it("is exactly the /status -> /durum and /kaynaklar -> /sources permanent redirects", () => {
    expect([...SITE_REDIRECTS]).toEqual([
      { source: "/status", destination: "/durum", permanent: true },
      { source: "/kaynaklar", destination: "/sources", permanent: true },
    ]);
  });

  it("only redirects to destinations that have an app page", () => {
    for (const { destination } of SITE_REDIRECTS) {
      expect(
        existsSync(join(APP_DIR, destination, "page.tsx")),
        `src/app${destination}/page.tsx is missing`,
      ).toBe(true);
    }
  });

  it("never shadows a real route: no app page or route at the exact source path", () => {
    // /kaynaklar has an app directory, but only as the parent of durum/
    // (/kaynaklar/durum is the feed-health page and stays a 200), so the check
    // is for a page or route file AT the source, not for the directory.
    for (const { source } of SITE_REDIRECTS) {
      for (const file of ["page.tsx", "page.ts", "route.ts"]) {
        expect(
          existsSync(join(APP_DIR, source, file)),
          `src/app${source}/${file} exists; a redirect would hide it`,
        ).toBe(false);
      }
    }
  });

  it("uses exact, pattern-free sources and destinations (no ':' '*' '(' or '?'), so nested pages keep working", () => {
    for (const { source, destination } of SITE_REDIRECTS) {
      for (const path of [source, destination]) {
        for (const ch of [":", "*", "(", "?"]) {
          expect(path.includes(ch), `${path} contains ${ch}`).toBe(false);
        }
      }
    }
  });

  it("keeps /kaynaklar/durum (the feed-health page) as a real page next to the /kaynaklar redirect", () => {
    expect(SITE_REDIRECTS.some((r) => r.source === "/kaynaklar")).toBe(true);
    expect(existsSync(join(APP_DIR, "kaynaklar/durum/page.tsx"))).toBe(true);
    expect(SITE_REDIRECTS.some((r) => r.source.startsWith("/kaynaklar/"))).toBe(false);
  });

  it("has unique sources", () => {
    const sources = SITE_REDIRECTS.map((r) => r.source);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it("uses only permanent, path-absolute entries", () => {
    for (const r of SITE_REDIRECTS) {
      expect(r.permanent).toBe(true);
      expect(r.source.startsWith("/")).toBe(true);
      expect(r.destination.startsWith("/")).toBe(true);
    }
  });

  it("has no source in the middleware matcher (next.config redirects run first, the middleware never sees them)", () => {
    const middleware = readFileSync(join(ROOT, "src/middleware.ts"), "utf8");
    const matcher = /matcher:\s*\[([^\]]*)\]/.exec(middleware);
    expect(matcher, "middleware matcher not found").not.toBeNull();
    for (const { source } of SITE_REDIRECTS) {
      expect(matcher![1]).not.toContain(`"${source}"`);
      expect(matcher![1]).not.toContain(`"${source}/`);
    }
  });

  it("has no imports, so next.config.ts can load it by relative path", () => {
    const text = readFileSync(join(here, "redirects.ts"), "utf8");
    expect(text).not.toMatch(/^\s*import\s/m);
  });
});
