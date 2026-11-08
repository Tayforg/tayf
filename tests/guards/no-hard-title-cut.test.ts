import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Permanent CI guard (h64-ogcards-2): a headline shown on a share surface is cut
// at a WORD, never at a fixed count.
//
// The Manşet Kartı, the embed and oEmbed cut a title with
// `points.slice(0, max - 1).join("") + "…"`: '…32 binden fazla bu…' (inside
// 'buluntu'), '…hesaba çekilme…' (which turns the stored 'çekilmeli' - "should be
// held to account" - into a noun). The OG card had used the word-boundary clamp
// since h20-contracts-1. cutAtWord() in src/lib/seo/og-title.ts is that clamp,
// exported; every share surface calls it.
//
// What this sweep flags: in the runtime code (comments blanked) of the share
// surface directories below, a `.slice(0, ...)` / `.substring(0, ...)` /
// `.substr(0, ...)` whose statement (up to the next `;`, at most STATEMENT_SPAN
// characters) also holds an ellipsis: "…", "\u2026", or a string that is just
// "...". That is a title cut at a fixed count with a closing ellipsis, whatever
// the variable is called. Slices without an ellipsis (`members.slice(0, 5)`,
// `error.slice(0, ERROR_MAX_LEN)`) are not title cuts and are left alone.
//
// Fix a hit by calling cutAtWord(text, max) (or, where the unit must be
// graphemes, by wrapping it as src/lib/social/compose.ts does), not by editing
// this guard.
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Where a title or headline reaches a card, a frame, an oEmbed consumer or a post.
 * src/lib/clusters holds the X / Bluesky share-intent text (share.ts), which is a
 * headline too.
 */
const SHARE_SURFACE_DIRS = [
  "src/app/cluster",
  "src/lib/cards",
  "src/lib/embed",
  "src/lib/social",
  "src/app/api/oembed",
  "src/lib/clusters",
];

const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);
const SOURCE_FILE = /\.(?:ts|tsx)$/;
const TEST_FILE = /\.test\.(?:ts|tsx)$/;
const STATEMENT_SPAN = 240;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SOURCE_FILE.test(name) && !TEST_FILE.test(name)) out.push(full);
  }
  return out;
}

/**
 * The code with block and line comments replaced by blanks (newlines kept), so a
 * "…" in prose cannot read as an ellipsis next to a slice. A `//` right after a
 * ':' (a URL) is not a comment.
 */
function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

const CUT_CALL = /\.(?:slice|substring|substr)\(\s*0\s*,/g;
const ELLIPSIS = /…|\\u2026|\\u\{2026\}|(["'`])\.\.\.\1|\}\.\.\.`/;

/** Offsets (as 1-based line numbers) of every fixed-count cut closed by an ellipsis. */
function hardTitleCuts(code: string): number[] {
  const lines: number[] = [];
  for (const m of code.matchAll(CUT_CALL)) {
    const rest = code.slice(m.index, m.index + STATEMENT_SPAN);
    const end = rest.indexOf(";");
    const statement = end === -1 ? rest : rest.slice(0, end);
    if (!ELLIPSIS.test(statement)) continue;
    lines.push(code.slice(0, m.index).split("\n").length);
  }
  return lines;
}

describe("hardTitleCuts (the detector)", () => {
  it("flags the cut the kart, the embed and the Bluesky text used", () => {
    expect(hardTitleCuts('return `${points.slice(0, max - 1).join("")}…`;')).toEqual([1]);
    expect(hardTitleCuts('return `${points.slice(0, EMBED_TITLE_MAX - 1).join("").trimEnd()}…`;')).toEqual([1]);
    expect(hardTitleCuts('return graphemes.slice(0, Math.max(0, maxGraphemes - 1)).join("") + "…";')).toEqual([1]);
  });

  it("flags the other shapes of the same cut", () => {
    expect(hardTitleCuts('const t = title.slice(0, 110) + "…";')).toEqual([1]);
    expect(hardTitleCuts("const t = `${title.slice(0, 110)}\\u2026`;")).toEqual([1]);
    expect(hardTitleCuts('const t = title.substring(0, 110) + "...";')).toEqual([1]);
    expect(hardTitleCuts("const t = `${title.substr(0, 110)}...`;")).toEqual([1]);
    expect(hardTitleCuts('const t = title.slice( 0 , n - 3 ) + "\\u2026";')).toEqual([1]);
    // The ellipsis on the next line of the same statement.
    expect(hardTitleCuts('const t =\n  title.slice(0, 110) +\n  "…";')).toEqual([2]);
    // Reports the line of each cut.
    expect(hardTitleCuts('const a = 1;\nconst b = x.slice(0, 5) + "…";\nconst c = y.slice(0, 9) + "…";')).toEqual([2, 3]);
  });

  it("leaves a slice that is not closed by an ellipsis alone", () => {
    expect(hardTitleCuts("const top = members.slice(0, 5);")).toEqual([]);
    expect(hardTitleCuts("return out.slice(0, ERROR_MAX_LEN);")).toEqual([]);
    expect(hardTitleCuts("const all = [...items.slice(0, 3), ...more];")).toEqual([]);
    expect(hardTitleCuts('const a = x.slice(0, 5);\nconst b = "…";')).toEqual([]);
    expect(hardTitleCuts("const head = text.slice(1, 9) + 'a…';")).toEqual([]);
  });

  it("leaves the word cut alone", () => {
    expect(hardTitleCuts("return cutAtWord(value.trim(), max);")).toEqual([]);
    expect(hardTitleCuts("return cutAtWord(trimmed, EMBED_TITLE_MAX);")).toEqual([]);
  });

  it("does not read an ellipsis inside a comment as part of the cut", () => {
    const code = stripComments("const top = list.slice(0, 5); // shown as 'a, b, …'\n/* … */\nconst x = 1;");
    expect(hardTitleCuts(code)).toEqual([]);
    // A URL in a string is code, not a comment.
    expect(stripComments('const u = "https://tayfhaber.com/a";')).toBe('const u = "https://tayfhaber.com/a";');
  });
});

describe("no hard title cut on a share surface", () => {
  const files = SHARE_SURFACE_DIRS.flatMap((d) => walk(resolve(ROOT, d)));

  it("scans the share surfaces it names (the sweep cannot go empty)", () => {
    const rel = files.map((f) => relative(ROOT, f).split("\\").join("/"));
    expect(rel).toContain("src/app/cluster/[id]/kart/route.tsx");
    expect(rel).toContain("src/lib/embed/embed-html.ts");
    expect(rel).toContain("src/lib/social/compose.ts");
    expect(rel).toContain("src/app/api/oembed/route.ts");
    expect(rel).toContain("src/lib/clusters/share.ts");
    expect(files.length).toBeGreaterThan(10);
  });

  it("no runtime file under a share surface cuts a title at a fixed count with an ellipsis", () => {
    const hits = files.flatMap((f) =>
      hardTitleCuts(stripComments(readFileSync(f, "utf8"))).map(
        (line) => `${relative(ROOT, f).split("\\").join("/")}:${line}`,
      ),
    );
    expect(
      hits,
      "a title cut with .slice(0, n) + '…' ends mid-word ('…32 binden fazla bu…'); use cutAtWord() from src/lib/seo/og-title.ts",
    ).toEqual([]);
  });
});

describe("the kart and the embed cut through cutAtWord", () => {
  const code = (path: string): string => stripComments(readFileSync(resolve(ROOT, path), "utf8"));
  const IMPORT_CUT_AT_WORD = /import\s*{[^}]*\bcutAtWord\b[^}]*}\s*from\s*["']@\/lib\/seo\/og-title["']/;

  it.each(["src/app/cluster/[id]/kart/route.tsx", "src/lib/embed/embed-html.ts"])(
    "%s imports cutAtWord from og-title and calls it",
    (path) => {
      const src = code(path);
      expect(src).toMatch(IMPORT_CUT_AT_WORD);
      expect(src).toMatch(/\bcutAtWord\(/);
    },
  );

  it.each(["src/app/cluster/[id]/kart/route.tsx", "src/lib/embed/embed-html.ts"])(
    "%s has no fixed-count `max - 1` cut left",
    (path) => {
      const src = code(path);
      expect(src).not.toMatch(/\.slice\(\s*0\s*,\s*max\s*-\s*1\s*\)/);
      expect(src).not.toMatch(/EMBED_TITLE_MAX\s*-\s*1/);
      expect(src).not.toMatch(/Array\.from\(\s*trimmed\s*\)/);
    },
  );

  it("the oEmbed route takes its title from safeEmbedTitle, so it cuts at a word too", () => {
    const src = code("src/app/api/oembed/route.ts");
    expect(src).toMatch(/title:\s*safeEmbedTitle\(/);
    expect(hardTitleCuts(src)).toEqual([]);
  });

  it("og-title.ts exports cutAtWord and clampOgTitle calls it", () => {
    const src = code("src/lib/seo/og-title.ts");
    expect(src).toMatch(/export\s+function\s+cutAtWord\s*\(/);
    expect(src).toMatch(/=\s*cutAtWord\(/);
  });
});
