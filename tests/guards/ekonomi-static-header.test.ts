import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (h159-perf-2): the /ekonomi header (h1 + the static
// subtitle, the LCP text) renders in the PPR shell, not as a streamed segment.
//
// EkonomiPage used to be `async` and awaited connection() as its first
// statement, so the whole page, subtitle included, streamed as a hidden
// segment: React 19.3's $RC reveals it no earlier than $RT + 300 ms after the
// shell's first paint (measured: first paint 2260 ms, LCP 2660 ms). The
// subtitle is static copy; only the market cue below it and the body depend on
// data. So:
//   - EkonomiPage is a plain (sync) function: no await, no connection(), no
//     clock read in the shell;
//   - connection() lives in loadEkonomiView (React cache(): one read per
//     request for the cue and the body), which only the Suspense-wrapped
//     EkonomiMarketCue and EkonomiBody await;
//   - the subtitle text comes before the first <Suspense in the file.
//
// The page is a server component, so this reads the source as text and uses
// indexOf / slice / includes only (no regex over JSX).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const page = readFileSync(resolve(ROOT, "src/app/ekonomi/page.tsx"), "utf8");
const loading = readFileSync(resolve(ROOT, "src/app/ekonomi/loading.tsx"), "utf8");

const SUBTITLE = "Haberde adı geçen hisseler";
const LOAD_DECL = "export const loadEkonomiView = ";
const DEFAULT_DECL = "export default function EkonomiPage(";

/** Every index at which `needle` starts in `haystack` (linear scan). */
function indexesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + needle.length;
  }
}

/** Index of the next top-level `function ` / `async function ` / `export ` declaration after `from`; the end of the file when there is none. */
function nextTopLevel(src: string, from: number): number {
  const marks = [src.indexOf("\nfunction ", from), src.indexOf("\nasync function ", from), src.indexOf("\nexport ", from)].filter((i) => i !== -1);
  return marks.length === 0 ? src.length : Math.min(...marks) + 1;
}

/** The source of the declaration that starts at `decl`, up to the next top-level declaration. */
function declarationBody(src: string, decl: string): string {
  const start = src.indexOf(decl);
  expect(start, decl).toBeGreaterThan(-1);
  return src.slice(start, nextTopLevel(src, start + decl.length));
}

describe("/ekonomi static header (h159-perf-2)", () => {
  it("EkonomiPage is a plain function, not an async one", () => {
    expect(page).toContain(DEFAULT_DECL);
    expect(page).not.toContain("export default async function EkonomiPage");
  });

  it("every await connection() lies inside loadEkonomiView, and there is at least one", () => {
    const calls = indexesOf(page, "await connection()");
    expect(calls.length).toBeGreaterThan(0);
    const decl = page.indexOf(LOAD_DECL);
    expect(decl).toBeGreaterThan(-1);
    const end = nextTopLevel(page, decl + LOAD_DECL.length);
    for (const at of calls) {
      expect(at).toBeGreaterThan(decl);
      expect(at).toBeLessThan(end);
    }
  });

  it("connection() is the first statement of loadEkonomiView and the clock is read after it", () => {
    const body = declarationBody(page, LOAD_DECL);
    const open = body.indexOf("=> {");
    expect(open).toBeGreaterThan(-1);
    const connectionAt = body.indexOf("await connection()");
    expect(connectionAt).toBeGreaterThan(open);
    // Nothing but whitespace and comments sit between the opening brace and the call.
    const between = body.slice(open + 4, connectionAt);
    for (const line of between.split("\n")) {
      const t = line.trim();
      expect(t === "" || t.startsWith("//"), JSON.stringify(t)).toBe(true);
    }
    const clockAt = body.indexOf("currentTimeMs()");
    expect(clockAt).toBeGreaterThan(connectionAt);
  });

  it("loadEkonomiView is wrapped in React's cache() so the cue and the body share one read per request", () => {
    expect(page).toContain("export const loadEkonomiView = cache(async () => {");
    const importAt = page.indexOf('from "react";');
    expect(importAt).toBeGreaterThan(-1);
    const open = page.lastIndexOf("import {", importAt);
    const names = page.slice(open, importAt);
    expect(names).toContain("cache");
    expect(names).toContain("Suspense");
  });

  it("the subtitle text comes before the first <Suspense, so it is in the shell", () => {
    const subtitleAt = page.indexOf(SUBTITLE);
    expect(subtitleAt).toBeGreaterThan(-1);
    expect(indexesOf(page, SUBTITLE)).toHaveLength(1);
    const suspenseAt = page.indexOf("<Suspense");
    expect(suspenseAt).toBeGreaterThan(-1);
    expect(subtitleAt).toBeLessThan(suspenseAt);
  });

  it("the shell function reads no data and no clock", () => {
    const shell = declarationBody(page, DEFAULT_DECL);
    expect(shell).toContain(SUBTITLE);
    for (const banned of ["await ", "async ", "connection(", "loadEkonomiView", "currentTimeMs", "Date.now", "new Date("]) {
      expect(shell.includes(banned), banned).toBe(false);
    }
  });

  it("the only dynamic children of the shell are the Suspense-wrapped cue and body", () => {
    const shell = declarationBody(page, DEFAULT_DECL);
    expect(shell).toContain("<Suspense fallback={null}>");
    expect(shell).toContain("<EkonomiMarketCue />");
    expect(shell).toContain("<Suspense fallback={<EkonomiBodySkeleton />}>");
    expect(shell).toContain("<EkonomiBody />");
    expect(shell.indexOf("<Suspense fallback={null}>")).toBeLessThan(shell.indexOf("<EkonomiMarketCue />"));
    expect(shell.indexOf("<EkonomiMarketCue />")).toBeLessThan(shell.indexOf("</Suspense>"));
  });

  it("the cue and the body, not the shell, await the cached view", () => {
    for (const decl of ["export async function EkonomiMarketCue(", "export async function EkonomiBody("]) {
      expect(declarationBody(page, decl), decl).toContain("await loadEkonomiView()");
    }
  });

  it("does not swallow an essential-read failure: no .catch in the page, so error.tsx still renders", () => {
    expect(page.includes(".catch(")).toBe(false);
  });

  it("the body skeleton is shared: loading.tsx renders the exported EkonomiBodySkeleton, and the page imports it", () => {
    expect(loading).toContain("export function EkonomiBodySkeleton(");
    expect(loading).toContain("<EkonomiBodySkeleton />");
    expect(page).toContain("EkonomiBodySkeleton");
    const importAt = page.indexOf('from "./loading";');
    expect(importAt).toBeGreaterThan(-1);
    expect(page.slice(page.lastIndexOf("import {", importAt), importAt)).toContain("EkonomiBodySkeleton");
  });

  it("the body skeleton has no header line (the real header is above it) and keeps the tape block and the three panels", () => {
    const skeleton = declarationBody(loading, "export function EkonomiBodySkeleton(");
    expect(skeleton.includes("h-4 w-40")).toBe(false);
    expect(skeleton).toContain("h-14 w-full");
    expect(skeleton).toContain("lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]");
    expect(skeleton).toContain("h-[560px]");
    expect(indexesOf(skeleton, "h-[270px]")).toHaveLength(2);
    // The route-level fallback still shows the grey header bar before the shared body.
    const route = declarationBody(loading, "export default function EkonomiLoading(");
    expect(route).toContain("h-4 w-40");
    expect(route.indexOf("h-4 w-40")).toBeLessThan(route.indexOf("<EkonomiBodySkeleton />"));
  });
});
