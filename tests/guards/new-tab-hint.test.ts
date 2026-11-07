import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (WCAG G201 / 3.2.5 AAA, h60-newtab-1, which merged the
// deferred h59-screenreader-1). A link that opens a new tab changes the
// reader's context; sighted users see it happen, a screen-reader user hears
// only the link text. Before this guard 110 of the 111 outbound links on a big
// cluster page said nothing, and /source/* and /ekonomi/* none at all.
//
// Every public `target="_blank"` anchor must end its accessible name with
// "(yeni sekmede açılır)":
//   - put <NewTabHint /> (src/components/ui/new-tab-hint.tsx) inside the
//     anchor, or
//   - where an aria-label overrides the content (the share chips, the corner
//     arrow on /kaynaklar), append the notice to the aria-label, or
//   - in a hand-built HTML string (src/lib/embed/embed-html.ts) emit the
//     literal visually-hidden span.
// The check reads from the anchor's opening tag to its first closing tag
// (</a>, </Link>, </TrackedLink>) or, for a link built inside a template
// string, to the end of that string. Admin pages are out of scope.
//
// There is no allowlist: a new outbound link adds the hint, it does not add an
// exception here.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SCAN_DIRS = ["src/app", "src/components", "src/lib/embed"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "admin") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

/** Blanks // and block comments, keeping offsets. Good enough for these files (`//` after `:` is a URL). */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

// Any string literal "_blank" / '_blank' / `_blank`: `target="_blank"`,
// `target={"_blank"}` and a conditional `target={x ? "_blank" : undefined}`.
const BLANK_RE = /["'`]_blank["'`]/g;
const OPEN_RE = /<(?:a|Link|TrackedLink)(?=[\s>])/g;
const CLOSE_RE = /<\/(?:a|Link|TrackedLink)>/g;
// <NewTabHint /> inside the anchor; the literal copy (a hand-built span or an
// aria-label); or the shared constant, which is how an aria-label spells it.
const HINT_TOKENS = ["<NewTabHint", "yeni sekmede açılır", "NEW_TAB_NOTICE"] as const;

interface NewTabViolation {
  /** 1-based line of the `_blank` literal */
  line: number;
  /** The anchor source that was searched */
  text: string;
}

interface NewTabScan {
  /** How many `_blank` literals the source holds */
  total: number;
  /** The ones whose anchor carries no hint */
  violations: NewTabViolation[];
}

/** Every `_blank` link of one source string and which of them lack the hint. */
function scanNewTabLinks(source: string): NewTabScan {
  const src = blankComments(source);
  const violations: NewTabViolation[] = [];
  let total = 0;
  let m: RegExpExecArray | null;
  BLANK_RE.lastIndex = 0;
  while ((m = BLANK_RE.exec(src)) !== null) {
    total++;
    const at = m.index;

    // Start of the element: the nearest opening <a / <Link / <TrackedLink
    // before the literal, so an aria-label written ahead of target= counts.
    let start = at;
    OPEN_RE.lastIndex = 0;
    let o: RegExpExecArray | null;
    while ((o = OPEN_RE.exec(src)) !== null && o.index < at) start = o.index;

    // End of the element: its first closing tag, else the end of the template
    // string the literal sits in (the next backtick), else the file.
    CLOSE_RE.lastIndex = at;
    const close = CLOSE_RE.exec(src);
    let end: number;
    if (close) end = close.index;
    else {
      const tick = src.indexOf("`", at);
      end = tick === -1 ? src.length : tick;
    }

    const text = src.slice(start, end);
    if (!HINT_TOKENS.some((t) => text.includes(t))) {
      violations.push({ line: src.slice(0, at).split("\n").length, text });
    }
  }
  return { total, violations };
}

describe("scanNewTabLinks (the scanner itself)", () => {
  it("flags an anchor with no hint", () => {
    const r = scanNewTabLinks('<a href="x" target="_blank" rel="noopener">Oku</a>');
    expect(r.total).toBe(1);
    expect(r.violations).toHaveLength(1);
  });

  it("flags a TrackedLink and a next/link Link with no hint", () => {
    const src = [
      '<TrackedLink event="outbound" href={u} target="_blank">Oku</TrackedLink>',
      '<Link href={u} target="_blank">Oku</Link>',
    ].join("\n");
    const r = scanNewTabLinks(src);
    expect(r.total).toBe(2);
    expect(r.violations).toHaveLength(2);
  });

  it("flags a target written with braces, single quotes or a condition", () => {
    for (const attr of [`target={"_blank"}`, `target='_blank'`, `target={ext ? "_blank" : undefined}`]) {
      const r = scanNewTabLinks(`<a href="x" ${attr}>Oku</a>`);
      expect(r.violations, attr).toHaveLength(1);
    }
  });

  it("passes an anchor that holds <NewTabHint />", () => {
    const r = scanNewTabLinks(
      '<a href="x" target="_blank">\n  Oku\n  <NewTabHint />\n</a>',
    );
    expect(r.total).toBe(1);
    expect(r.violations).toEqual([]);
  });

  it("passes a TrackedLink that holds <NewTabHint />", () => {
    const r = scanNewTabLinks(
      '<TrackedLink href={u} target="_blank">{title}<NewTabHint /></TrackedLink>',
    );
    expect(r.violations).toEqual([]);
  });

  it("passes an aria-label that carries the notice, written before or after target=", () => {
    const before = scanNewTabLinks(
      '<a href="x" aria-label={`${n} ile paylaş (${NEW_TAB_NOTICE})`} target="_blank">{n}</a>',
    );
    const after = scanNewTabLinks(
      '<a href="x" target="_blank" aria-label="X sitesi (yeni sekmede açılır)"><span>↗</span></a>',
    );
    expect(before.violations).toEqual([]);
    expect(after.violations).toEqual([]);
  });

  it("passes a literal hidden span inside a template string", () => {
    const ok = scanNewTabLinks(
      "const h = `<a class=\"a\" href=\"x\" target=\"_blank\">oku<span class=\"v\"> (yeni sekmede açılır)</span></a>`;",
    );
    expect(ok.violations).toEqual([]);
    const bad = scanNewTabLinks("const h = `<a class=\"a\" href=\"x\" target=\"_blank\">oku</a>`;");
    expect(bad.violations).toHaveLength(1);
  });

  it("does not let the next anchor's hint rescue a bare one", () => {
    const src =
      '<a href="a" target="_blank">A</a>\n<a href="b" target="_blank">B<NewTabHint /></a>';
    const r = scanNewTabLinks(src);
    expect(r.total).toBe(2);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.line).toBe(1);
  });

  it("does not count a hint that sits only in a comment", () => {
    const src = '<a href="a" target="_blank">A{/* <NewTabHint /> yeni sekmede açılır */}</a>';
    expect(scanNewTabLinks(src).violations).toHaveLength(1);
  });

  it("ignores a link that opens in the same tab", () => {
    const r = scanNewTabLinks('<a href="x" rel="nofollow">Oku</a>');
    expect(r.total).toBe(0);
    expect(r.violations).toEqual([]);
  });
});

describe("every public target=_blank link announces the new tab (h60-newtab-1)", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(resolve(ROOT, d)));
  const scans = files.map((file) => ({
    path: relative(ROOT, file),
    scan: scanNewTabLinks(readFileSync(file, "utf8")),
  }));

  it("scans the app, the components and the embed renderer, never an admin file or a test", () => {
    const paths = scans.map((s) => s.path);
    expect(paths.some((p) => p.startsWith("src/app/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("src/components/"))).toBe(true);
    expect(paths).toContain("src/lib/embed/embed-html.ts");
    expect(paths.filter((p) => /(^|\/)admin\//.test(p))).toEqual([]);
    expect(paths.filter((p) => /\.test\./.test(p))).toEqual([]);
  });

  it("still finds the known outbound links, so the scan cannot go vacuous", () => {
    const withLinks = scans.filter((s) => s.scan.total > 0).map((s) => s.path);
    const total = scans.reduce((n, s) => n + s.scan.total, 0);
    expect(total).toBeGreaterThanOrEqual(15);
    for (const known of [
      "src/components/story/read-across-spectrum.tsx",
      "src/components/story/framing-comparison.tsx",
      "src/components/story/share-button.tsx",
      "src/app/sources/page.tsx",
      "src/lib/embed/embed-html.ts",
    ]) {
      expect(withLinks, known).toContain(known);
    }
  });

  it("gives every one of them the hint (<NewTabHint />, or the notice in its aria-label)", () => {
    const missing = scans.flatMap((s) =>
      s.scan.violations.map((v) => `${s.path}:${v.line}`),
    );
    expect(missing, `target="_blank" without 'yeni sekmede açılır':\n${missing.join("\n")}`).toEqual([]);
  });
});
