import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (h177-perfsweep-1): /kaynaklar/durum paints its static hero
// (the h1, the LCP text) in the PPR shell, not as a streamed segment.
//
// The default export used to be `async` and to open with `await connection()`,
// so the h1 streamed inside a hidden Suspense segment after ~431 KB of HTML:
// mobile LCP 2.56-2.72 s against ~1 s on the prerendered siblings. Same shape as
// /ekonomi (h159-perf-2, tests/guards/ekonomi-static-header.test.ts), same fix:
//   - the default export is a plain (sync) function: no await, no connection(),
//     no clock read, no searchParams read in the shell;
//   - the PageHero (literal title) is returned by the default export outside any
//     <Suspense>;
//   - connection() and every data read live in the async child, which sits in
//     its own <Suspense> behind a same-footprint skeleton;
//   - nothing new catches a rejected read, so error.tsx still renders as before.
//
// /oyun was left as is (spec fallback): its ?mod=gunluk / ?gun= first render is ~330 px
// against the 212 px Bolge box at 360 px, so the shell disclaimer (the LCP block) would move
// ~118 px (CLS ~ 0.05 > 0.01).
//
// The page is a server component, so this reads the source as text and uses
// indexOf / slice / includes and a linear character scan only (no regex over JSX).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

interface HeroPage {
  route: string;
  file: string;
  /** Name of the default export (the shell). */
  shell: string;
  /** Name of the async child that holds connection() and the reads. */
  child: string;
  /** Name of the child's Suspense fallback. */
  skeleton: string;
  /** The PageHero title literal (also the h1 text). */
  title: string;
}

const PAGES: readonly HeroPage[] = [
  {
    route: "/kaynaklar/durum",
    file: "src/app/kaynaklar/durum/page.tsx",
    shell: "KaynakDurumPage",
    child: "DurumBody",
    skeleton: "DurumBodySkeleton",
    title: "Kaynak durumu",
  },
];

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

/** `chunk` with every character but newlines turned into a space (offsets and lines stay put). */
function blank(chunk: string): string {
  const out: string[] = [];
  for (const ch of chunk) out.push(ch === "\n" ? "\n" : " ");
  return out.join("");
}

/**
 * The source with `/* ... *\/` (JSX comments included) and `//` line comments blanked, so prose in a
 * comment cannot satisfy or trip an indexOf check. A single linear pass; a `//` right after a colon
 * (a URL) is left alone.
 */
function blankComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out.push(blank(src.slice(i, stop)));
      i = stop;
    } else if (src.startsWith("//", i) && src.charAt(i - 1) !== ":") {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? src.length : nl;
      out.push(blank(src.slice(i, stop)));
      i = stop;
    } else {
      out.push(src.charAt(i));
      i += 1;
    }
  }
  return out.join("");
}

/** Index of the next top-level declaration after `from`; the end of the file when there is none. */
function nextTopLevel(src: string, from: number): number {
  const marks = ["\nfunction ", "\nasync function ", "\nexport ", "\nconst ", "\ntype ", "\ninterface "]
    .map((m) => src.indexOf(m, from))
    .filter((i) => i !== -1);
  return marks.length === 0 ? src.length : Math.min(...marks) + 1;
}

/** The source of the declaration that starts at `decl`, up to the next top-level declaration. */
function declarationBody(src: string, decl: string): string {
  const start = src.indexOf(decl);
  expect(start, decl).toBeGreaterThan(-1);
  return src.slice(start, nextTopLevel(src, start + decl.length));
}

/** The `<PageHero ... />` tag that starts at the first `<PageHero` in `src`. */
function heroTag(src: string): string {
  const open = src.indexOf("<PageHero");
  expect(open, "<PageHero").toBeGreaterThan(-1);
  const close = src.indexOf("/>", open);
  expect(close, "<PageHero ... />").toBeGreaterThan(open);
  return src.slice(open, close + 2);
}

for (const page of PAGES) {
  const raw = readFileSync(resolve(ROOT, page.file), "utf8");
  const code = blankComments(raw);
  const SHELL_DECL = `export default function ${page.shell}(`;
  const CHILD_DECL = `export async function ${page.child}(`;
  const SKELETON_DECL = `export function ${page.skeleton}(`;
  const FALLBACK = `<Suspense fallback={<${page.skeleton} />}>`;

  describe(`${page.route} static hero shell (h177-perfsweep-1)`, () => {
    it(`${page.shell} is a plain function, not an async one`, () => {
      expect(code).toContain(SHELL_DECL);
      expect(code.includes("export default async")).toBe(false);
      expect(code.includes(`async function ${page.shell}`)).toBe(false);
    });

    it("the PageHero with its literal title is returned by the shell, before and outside any Suspense", () => {
      const shell = declarationBody(code, SHELL_DECL);
      const hero = heroTag(shell);
      expect(hero).toContain(`title="${page.title}"`);
      expect(indexesOf(code, `title="${page.title}"`)).toHaveLength(1);
      const heroAt = shell.indexOf("<PageHero");
      expect(heroAt).toBeGreaterThan(shell.indexOf("return ("));
      expect(heroAt).toBeLessThan(shell.indexOf("<Suspense"));
      // The only Suspense in the shell opens after the hero and closes after the child.
      expect(indexesOf(shell, "<Suspense")).toHaveLength(1);
      expect(indexesOf(shell, "</Suspense>")).toHaveLength(1);
    });

    it(`${page.child} is the async child, and every connection() call lies inside it, as its first statement`, () => {
      expect(code).toContain(CHILD_DECL);
      const calls = indexesOf(code, "connection(");
      // One import line mentions `connection }`, not `connection(`; the call sites are the awaits.
      expect(indexesOf(code, "await connection()").length).toBeGreaterThan(0);
      expect(calls).toHaveLength(indexesOf(code, "await connection()").length);
      const start = code.indexOf(CHILD_DECL);
      const end = nextTopLevel(code, start + CHILD_DECL.length);
      for (const at of calls) {
        expect(at).toBeGreaterThan(start);
        expect(at).toBeLessThan(end);
      }
      const child = declarationBody(code, CHILD_DECL);
      const open = child.indexOf(") {");
      expect(open).toBeGreaterThan(-1);
      const connectionAt = child.indexOf("await connection()");
      expect(connectionAt).toBeGreaterThan(open);
      // Nothing but whitespace sits between the opening brace and the call.
      expect(child.slice(open + 3, connectionAt).trim()).toBe("");
    });

    it("the shell reads no data, no clock and no request input", () => {
      const shell = declarationBody(code, SHELL_DECL);
      for (const banned of [
        "await ",
        "async ",
        "connection(",
        "currentTimeMs",
        "Date.now",
        "new Date(",
        "getSourceFeedStatuses",
        "getSourceItemsPerDay",
        "loadGameHeadlines",
        "getDailyPuzzle",
        "cookies(",
        "headers(",
        ".then(",
      ]) {
        expect(shell.includes(banned), banned).toBe(false);
      }
    });

    it("the only dynamic child of the shell is the one Suspense-wrapped child, behind the named skeleton", () => {
      const shell = declarationBody(code, SHELL_DECL);
      expect(shell).toContain(FALLBACK);
      expect(shell.includes("fallback={null}")).toBe(false);
      const open = shell.indexOf(FALLBACK);
      // The trailing space keeps `<DurumBody ` from also matching `<DurumBodySkeleton `.
      const childAt = shell.indexOf(`<${page.child} `, open);
      const closeAt = shell.indexOf("</Suspense>", open);
      expect(childAt).toBeGreaterThan(open);
      expect(closeAt).toBeGreaterThan(childAt);
      expect(indexesOf(shell, `<${page.child} `)).toHaveLength(1);
      // Suspense comes from react, the skeleton is declared and exported by the page itself.
      const importAt = code.indexOf('from "react";');
      expect(importAt).toBeGreaterThan(-1);
      expect(code.slice(code.lastIndexOf("import ", importAt), importAt)).toContain("Suspense");
      expect(code).toContain(SKELETON_DECL);
    });

    it("does not swallow a failed read: no .catch and no try block in the page, so error.tsx still renders", () => {
      expect(code.includes(".catch(")).toBe(false);
      expect(code.includes("try {")).toBe(false);
    });

    it("keeps the hero and every Turkish string out of the skeleton (no copy is duplicated while streaming)", () => {
      const skeleton = declarationBody(code, SKELETON_DECL);
      expect(skeleton.includes("<PageHero")).toBe(false);
      expect(skeleton.includes("<h1")).toBe(false);
      expect(skeleton.includes("<h2")).toBe(false);
      expect(skeleton.includes(page.title)).toBe(false);
      expect(skeleton).toContain('aria-hidden="true"');
      expect(skeleton).toContain("animate-pulse");
    });
  });
}

describe("/kaynaklar/durum shell holds the static pointer; the child holds the reads", () => {
  const page = PAGES[0] as HeroPage;
  const code = blankComments(readFileSync(resolve(ROOT, page.file), "utf8"));
  // Looked up inside each test: a page that lost its split fails that test, not the whole file.
  const shellOf = () => declarationBody(code, `export default function ${page.shell}(`);
  const childOf = () => declarationBody(code, `export async function ${page.child}(`);

  it("the 'Sistem durumu' pointer is static shell copy: after the hero, before the Suspense", () => {
    const shell = shellOf();
    const pointerAt = shell.indexOf('href="/durum"');
    expect(pointerAt).toBeGreaterThan(shell.indexOf("<PageHero"));
    expect(pointerAt).toBeLessThan(shell.indexOf("<Suspense"));
    expect(shell).toContain("Haber akışının genel durumu için");
    expect(indexesOf(code, 'href="/durum"')).toHaveLength(1);
  });

  it("the child awaits the feed rows and starts the items-per-day read without awaiting it (PERF-01)", () => {
    const child = childOf();
    expect(indexesOf(child, "await getSourceFeedStatuses()")).toHaveLength(1);
    expect(indexesOf(child, "getSourceItemsPerDay()")).toHaveLength(1);
    expect(child.includes("await getSourceItemsPerDay()")).toBe(false);
    expect(child.indexOf("await connection()")).toBeLessThan(child.indexOf("await getSourceFeedStatuses()"));
    expect(child.indexOf("await getSourceFeedStatuses()")).toBeLessThan(child.indexOf("getSourceItemsPerDay()"));
  });

  it("the unavailable state and the table body both render from the child", () => {
    const shell = shellOf();
    const child = childOf();
    expect(child).toContain("rows === null");
    expect(child).toContain("Kaynak durumu şu anda bilinmiyor");
    expect(child).toContain("<KaynakDurumBody rows={rows} itemsPerDayPromise={itemsPerDayPromise} />");
    expect(shell.includes("rows === null")).toBe(false);
    expect(shell.includes("KaynakDurumBody")).toBe(false);
  });

  it("the skeleton reserves the totals line and the table card with its header row", () => {
    const child = childOf();
    const skeleton = declarationBody(code, `export function ${page.skeleton}(`);
    // The same card chrome as the loaded table card, so the card does not change shape on the swap.
    expect(skeleton).toContain("rounded-xl ring-1 ring-border/60 bg-card p-4 sm:p-6");
    expect(child.includes("rounded-xl ring-1 ring-border/60 bg-card p-4 sm:p-6")).toBe(false);
    expect(code).toContain("rounded-xl ring-1 ring-border/60 bg-card p-4 sm:p-6");
    expect(skeleton).toContain("border-b border-border/60");
    expect(skeleton).toContain("min-h-[");
  });
});
