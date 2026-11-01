import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SITE_REDIRECTS } from "./redirects";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const APP_DIR = join(ROOT, "src/app");

describe("SITE_REDIRECTS", () => {
  it("is exactly the /status -> /durum permanent redirect", () => {
    expect([...SITE_REDIRECTS]).toEqual([
      { source: "/status", destination: "/durum", permanent: true },
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

  it("never shadows a real route: no source has an app directory", () => {
    for (const { source } of SITE_REDIRECTS) {
      expect(
        existsSync(join(APP_DIR, source)),
        `src/app${source} exists; a redirect would hide the page`,
      ).toBe(false);
    }
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
