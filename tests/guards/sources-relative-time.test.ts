import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (h205-kaynak-1). /sources is prerendered and its data comes
// from a "use cache" read, so a copy can be served long after it was filled: a
// hunter capture 19.5 h old still said "2 saat önce" on a source and "Akış
// alınamıyor" on a healthy feed, with no hint that it was old. Two rules keep
// that visible:
//
//   1. Every age on the page is printed through <RelativeTime iso nowMs={asOfMs} />,
//      where asOfMs is the clock the cached read took when it filled. The first
//      render is the server text (stable hydration); after mount the component
//      re-bases to the reader's clock, so an old copy shows its real age. A label
//      baked at fill time ({source.lastSeenLabel}) or a direct
//      formatTurkishTimeAgo( call brings the frozen string back.
//   2. The page says when it was compiled: "Akış durumlarının derlenme zamanı:
//      <time>{fixed Istanbul stamp}</time> (<RelativeTime />)." The fill-time
//      markers ("Akış alınamıyor", "Akış donmuş"), the delivering figure and the
//      last-seen ages are read against that line. It never names the weekly
//      counts: those come from getSourceItemsPerDay's own cache entry, which
//      asOfMs does not date. The stamp keeps the raw HTML of an old copy from
//      claiming 'az önce' on its own, and the label form reads correctly when
//      the relative part turns into a bare date after 48 h.
//
// The clock rule stays as tests/guards/static-page-clock.test.ts and
// src/app/sources/page.test.tsx state it: the page body and every component under
// it are clock-free; readSourcesDirectory is the only place that reads it.
//
// Source scans on comment-stripped text, as in tests/guards/cluster-relative-time.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const PAGE = "src/app/sources/page.tsx";
const RELATIVE_TIME = "src/components/story/relative-time.tsx";

/** Blanks // and block comments (offsets kept) so prose cannot trip a match. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

function read(rel: string): string {
  return stripComments(readFileSync(resolve(ROOT, rel), "utf8"));
}

/**
 * The text of every `<Tag ... >` or `<Tag ... />` opening tag, found by scanning
 * to the closing `>` at brace depth 0 (a `>` inside an expression prop does not
 * end the element early).
 */
function openingTags(code: string, tag: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(new RegExp(`<${tag}\\b`, "g"))) {
    const start = m.index ?? 0;
    let depth = 0;
    let end = start + m[0].length;
    for (; end < code.length; end++) {
      const ch = code[end];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    out.push(code.slice(start, end + 1));
  }
  return out;
}

/** Source of `function <name>(...) { ... }`, matched by brace depth ("" when absent). */
function functionSource(code: string, name: string): string {
  const start = code.search(new RegExp(`function\\s+${name}\\b`));
  if (start === -1) return "";
  const open = code.indexOf("{", code.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(start, i + 1);
  }
  return "";
}

/** Clock reads in code: Date.now(), new Date() with no argument, currentTimeMs(). */
const CLOCK_READ = /\bDate\.now\s*\(\s*\)|\bnew Date\s*\(\s*\)|\bcurrentTimeMs\s*\(\s*\)/g;

describe("/sources prints ages through RelativeTime (h205-kaynak-1)", () => {
  const code = read(PAGE);

  it("renders no baked '{source.lastSeenLabel}' string and keeps no lastSeenLabel field at all", () => {
    expect(code).not.toMatch(/\{\s*source\.lastSeenLabel\s*\}/);
    expect(code).not.toMatch(/\blastSeenLabel\b/);
  });

  it("has no direct formatTurkishTimeAgo( call and does not import the helper", () => {
    expect(code).not.toMatch(/\bformatTurkishTimeAgo\s*\(/);
    expect(code).not.toMatch(/import[^;]*\bformatTurkishTimeAgo\b/);
  });

  it("imports RelativeTime from the shared client island and renders it", () => {
    expect(code).toMatch(
      /import\s*\{\s*RelativeTime\s*\}\s*from\s*"@\/components\/story\/relative-time"/,
    );
    expect(code).toContain("<RelativeTime");
  });

  it("every <RelativeTime> carries iso={...} and nowMs={asOfMs}: the cached read's own clock, never a fresh one", () => {
    const tags = openingTags(code, "RelativeTime");
    for (const tag of tags) {
      expect(tag).toMatch(/\biso=\{/);
      expect(tag).toMatch(/\bnowMs=\{asOfMs\}/);
    }
  });

  it("has two of them: the card's last-seen age and the as-of line", () => {
    const tags = openingTags(code, "RelativeTime");
    expect(tags).toHaveLength(2);
    expect(tags.filter((t) => /\biso=\{source\.lastPublishedAt\}/.test(t))).toHaveLength(1);
    expect(tags.filter((t) => /\biso=\{asOfIso\}/.test(t))).toHaveLength(1);
  });

  it("the card age sits behind a lastPublishedAt check, so a source with none prints nothing", () => {
    const at = code.indexOf("<RelativeTime iso={source.lastPublishedAt}");
    expect(at).toBeGreaterThan(-1);
    expect(code.slice(Math.max(0, at - 240), at)).toMatch(/source\.lastPublishedAt\s*&&/);
  });

  it("prints the as-of line copy and keeps the 'Kaynak durumu' link to /kaynaklar/durum", () => {
    expect(code).toContain("Akış durumlarının derlenme zamanı:");
    expect(code).toMatch(
      /Akış durumlarının derlenme zamanı:\s*\{" "\}\s*<time\s+dateTime=\{asOfIso\}>\s*\{asOfLabel\}\s*<\/time>\s*\(\s*<RelativeTime\s+iso=\{asOfIso\}\s+nowMs=\{asOfMs\}\s*\/>\s*\)\./,
    );
    // The old copy dated the weekly counts too, and ended in '<relative> derlendi.', which
    // reads wrong once the relative part is a bare year ("19 Kasım 2026 derlendi").
    expect(code).not.toContain("haber sayıları");
    expect(code).not.toMatch(/\/>\s*derlendi/);
    // The stamp is a format of the read's own instant (no clock read), computed once.
    expect(code).toMatch(/\bconst\s+asOfLabel\s*=\s*formatTurkishDateTime\(\s*asOfIso\s*\)/);
    expect(code).toMatch(/import\s*\{[^}]*\bformatTurkishDateTime\b[^}]*\}\s*from\s*"@\/lib\/time"/);
    expect(code).toMatch(/href="\/kaynaklar\/durum"[\s\S]*?Kaynak durumu/);
  });

  it("takes asOfMs as a required number on SourceDirectory and SourceDirectoryWithCounts", () => {
    for (const name of ["SourceDirectory", "SourceDirectoryWithCounts"]) {
      const fn = functionSource(code, name);
      expect(fn, name).not.toBe("");
      // Required (no `?`): a caller that forgets it fails typecheck instead of
      // silently printing a frozen age.
      expect(fn, name).toMatch(/\basOfMs:\s*number\b/);
      expect(fn, name).not.toMatch(/\basOfMs\?:/);
    }
    // `\b` after the name keeps <SourceDirectoryWithCounts> and <SourceDirectorySkeleton>
    // out of the <SourceDirectory> scan.
    for (const tag of ["SourceDirectory", "SourceDirectoryWithCounts"]) {
      const tags = openingTags(code, tag);
      expect(tags, tag).toHaveLength(1);
      expect(tags[0], tag).toMatch(/\basOfMs=\{asOfMs\}/);
    }
  });

  it("SourcesDirectory carries asOfMs: number and the reader returns the nowMs it already took", () => {
    expect(code).toMatch(/interface\s+SourcesDirectory\s*\{[^}]*\basOfMs:\s*number\b/);
    const reader = functionSource(code, "readSourcesDirectory");
    expect(reader).toMatch(/\bconst\s+nowMs\s*=\s*Date\.now\(\s*\)/);
    expect(reader).toMatch(/\basOfMs\s*:\s*nowMs\b/);
  });
});

describe("/sources reads the clock only inside readSourcesDirectory (static-page-clock rule)", () => {
  const code = read(PAGE);
  const reader = functionSource(code, "readSourcesDirectory");
  const outside = code.replace(reader, "");

  it("finds the cached reader (so the scan below is not vacuous)", () => {
    expect(reader).toContain("createSlowReaderClient()");
    expect(reader.match(CLOCK_READ)?.length ?? 0).toBeGreaterThan(0);
  });

  it("holds no Date.now(), new Date() or currentTimeMs() outside it", () => {
    expect(outside.match(CLOCK_READ) ?? []).toEqual([]);
  });

  it("stays a prerender: no connection(), the source-directory lifetime, the error branch and the 'Akış alınamıyor' marker", () => {
    expect(code).not.toMatch(/\bconnection\s*\(/);
    expect(code).toMatch(/\bcacheLife\(\s*"source-directory"\s*\)/);
    expect(code).toContain("Kaynak listesi şu an yüklenemedi");
    expect(code).toContain("Akış alınamıyor");
  });
});

describe("relative-time.tsx stays a tiny client island (h205-kaynak-1)", () => {
  const raw = readFileSync(resolve(ROOT, RELATIVE_TIME), "utf8");
  const code = stripComments(raw);

  it("is a client module that imports only react and @/lib/time", () => {
    expect(raw.trimStart().startsWith('"use client"')).toBe(true);
    const imports = [...code.matchAll(/^import[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["@/lib/time", "react"]);
  });
});

describe("guard self-tests", () => {
  it("stripComments blanks line and block comments but keeps a url in a string", () => {
    const stripped = stripComments(
      'const a = "https://x.y"; // {source.lastSeenLabel}\n/* Date.now() */ const b = 1;',
    );
    expect(stripped).toContain('"https://x.y"');
    expect(stripped).not.toContain("lastSeenLabel");
    expect(stripped).not.toContain("Date.now()");
  });

  it("openingTags reads to the closing > at brace depth 0", () => {
    const tags = openingTags('<RelativeTime iso={a > b ? c : d} nowMs={asOfMs} /> x <RelativeTime iso={z} />', "RelativeTime");
    expect(tags).toEqual([
      "<RelativeTime iso={a > b ? c : d} nowMs={asOfMs} />",
      "<RelativeTime iso={z} />",
    ]);
  });

  it("functionSource finds a body with nested braces and returns '' for a missing name", () => {
    const sample = "function a() { const x = { y: `${1}` }; return Date.now(); }\nfunction b() { return 1; }";
    expect(functionSource(sample, "a")).toContain("Date.now()");
    expect(functionSource(sample, "a")).not.toContain("function b");
    expect(functionSource(sample, "missing")).toBe("");
  });

  it("the clock pattern flags stray reads and ignores dated constructors", () => {
    expect("const t = Date.now();".match(CLOCK_READ)).toEqual(["Date.now()"]);
    expect("const t = new Date();".match(CLOCK_READ)).toEqual(["new Date()"]);
    expect("const t = currentTimeMs();".match(CLOCK_READ)).toEqual(["currentTimeMs()"]);
    expect("new Date(asOfMs).toISOString()".match(CLOCK_READ)).toBeNull();
  });
});
