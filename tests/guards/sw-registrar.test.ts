import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (sw-shell): the service worker is registered in exactly
// one place, only in production builds, and the /offline page stays a static,
// network-free shell.
//
//  - The registrar is mounted once in the root layout behind a
//    NODE_ENV === "production" check, so dev servers (HMR, no CSP for the
//    worker) never get a worker that could pin stale chunks.
//  - register.ts owns the single `.register(` call (so the kill-switch ordering
//    in registerServiceWorker cannot be bypassed) and it uses SW_URL.
//  - /offline is precached by the worker at install: it must not fetch,
//    import Supabase or soft-navigate (next/link needs RSC over the network).
//  - /embed is a route handler (framed on third-party sites) and must never
//    pull the registrar in.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Strips block and line comments (keeps `://` inside strings and URLs). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const code = (rel: string) => stripComments(read(rel));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const count = (haystack: string, needle: RegExp) => (haystack.match(needle) ?? []).length;

describe("stripComments (scanner sanity check)", () => {
  it("drops comments but keeps URLs in strings", () => {
    const src = 'a(); // x.register(\n/* <SwRegistrar /> */ const u = "https://x.test"; // tail';
    const out = stripComments(src);
    expect(out).not.toContain(".register(");
    expect(out).not.toContain("SwRegistrar");
    expect(out).toContain("https://x.test");
  });
});

describe("root layout", () => {
  const layout = code("src/app/layout.tsx");

  it("renders <SwRegistrar /> exactly once", () => {
    expect(count(layout, /<SwRegistrar\b/g)).toBe(1);
    expect(count(layout, /<SwRegistrar \/>/g)).toBe(1);
  });

  it("renders it only on the production-gated line", () => {
    const lines = layout.split("\n").filter((l) => l.includes("<SwRegistrar"));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.trim()).toBe('{process.env.NODE_ENV === "production" ? <SwRegistrar /> : null}');
  });

  it("imports the registrar from the pwa components", () => {
    expect(layout).toMatch(/import \{ SwRegistrar \} from "@\/components\/pwa\/sw-registrar";/);
  });
});

describe("sw-registrar.tsx", () => {
  const src = code("src/components/pwa/sw-registrar.tsx");

  it("is a client component that renders nothing", () => {
    expect(read("src/components/pwa/sw-registrar.tsx").trimStart().startsWith('"use client"')).toBe(
      true,
    );
    expect(src).toMatch(/return null;/);
  });

  it("bails out of non-production builds and browsers without service workers", () => {
    expect(src).toContain('process.env.NODE_ENV !== "production"');
    expect(src).toContain('"serviceWorker" in navigator');
  });

  it("waits for the window load event", () => {
    expect(src).toContain('"load"');
  });

  it("never calls .register( directly", () => {
    expect(src).not.toMatch(/\.register\(/);
  });

  it("runs its effect once per mount: an empty dependency array", () => {
    // Without deps the effect re-runs on every re-render (router.refresh() re-renders the layout subtree)
    // and every run posts a sync, i.e. up to three server-side cluster renders per run.
    expect(src).toMatch(/\}\s*,\s*\[\]\s*\)\s*;/);
  });

  it("registers at most once per document, even across remounts", () => {
    expect(src).toMatch(/^let started = false;$/m);
    expect(src).toMatch(/if \(started\) return;\s*started = true;/);
  });

  it("hands the page's CacheStorage to the registrar so the kill switch can purge it", () => {
    expect(src).toContain("cachesLike");
  });
});

describe("register.ts", () => {
  const src = code("src/lib/pwa/register.ts");

  it("has exactly one .register( call and it uses SW_URL", () => {
    const calls = src.match(/\.register\([^)]*/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("SW_URL");
  });

  it("never awaits navigator.serviceWorker.ready (it can hang forever)", () => {
    expect(src).not.toMatch(/\.ready\b/);
  });
});

describe("/offline stays a static, network-free shell", () => {
  for (const rel of ["src/app/offline/page.tsx", "src/components/pwa/offline-saved-list.tsx"]) {
    describe(rel, () => {
      const src = code(rel);

      it("imports no Supabase client", () => {
        expect(src).not.toContain("@/lib/supabase");
      });

      it("does not call fetch(", () => {
        expect(src).not.toMatch(/\bfetch\(/);
      });

      it("does not use next/link (soft navigation needs the network)", () => {
        expect(src).not.toContain("next/link");
      });
    });
  }

  it("the page reads no request-time data", () => {
    const src = code("src/app/offline/page.tsx");
    expect(src).not.toMatch(/\b(connection|cookies|headers)\(/);
    expect(src).not.toMatch(/next\/headers/);
  });
});

describe("/embed", () => {
  const files = walk(join(ROOT, "src/app/embed"));

  it("scanner finds the embed route handlers", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(existsSync(join(ROOT, "src/app/embed"))).toBe(true);
  });

  it("no file under src/app/embed imports sw-registrar", () => {
    const offenders = files.filter((f) => /sw-registrar/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
