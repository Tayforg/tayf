#!/usr/bin/env node
// scripts/check-inline-css.mjs
//
// Fails when a prerendered shell of the production build does not carry the
// Tailwind sheet inline (h159-perf-1). Run by the `build` job of
// .github/workflows/ci.yml right after `npx next build`, and by hand:
// `npx next build && node scripts/check-inline-css.mjs`.
//
// Why it exists: next.config.ts sets experimental.inlineCss so first paint no
// longer waits on a 20 KB-br stylesheet that fair-shares a slow link with fonts,
// async JS and the LCP image. Nothing else would notice the flag silently
// stopping to work (a Next upgrade renaming it, a build that falls back to the
// <link>), and one thing can break loudly in production only: the CSS moves out
// of /_next/static/chunks/x.css into the HTML document, so a RELATIVE url() in
// it (../media/x.woff2) would resolve against the PAGE url and 404 the font.
// Next writes the font urls absolute (/_next/static/media/...), which is what
// this check pins.
//
// What it reads: every *.html under .next/server/app, the prerendered (PPR)
// shells. The routes that render per request are not covered by a build. One
// file is skipped by name, see SKIPPED_SHELLS: _global-error.html.
//
// Rules for one document (findInlineCssProblems):
//   (a) at least one <style> opening tag with data-precedence="next" exists;
//   (b) no <link> tag is a rel="stylesheet" whose href starts /_next/static/;
//   (c) every url( inside a <style> element body points at /_next/static/,
//       a data: URI or a #fragment. The target is the text up to the next `)`,
//       trimmed, minus one pair of surrounding quotes. A quoted target is read
//       to its closing quote first, so a data: URI that holds `)` is not cut.
//   Also reported: a <style> element or a url( that never closes.
//
// Only indexOf / slice / startsWith / endsWith are used, never a regular
// expression over the document, and every scan moves forward: a search that
// finds no end (`<link ` with no `>`, `url(` with no `)`) stops the whole scan,
// because no later start can find one either. Cost is linear in the document
// (guarded by scripts/check-inline-css.test.mjs with tests/_helpers/linear-time.ts).
//
// Exit code: 0 when every shell is sound, 1 on any problem or when no shell was
// found (a skipped build must not report green). Output: `<file>: <problem>` on
// stderr per problem, a one-line summary on stdout. Pure Node built-ins only.

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The prerendered shells of `next build`, resolved from this file so the cwd does not matter. */
const APP_DIR = fileURLToPath(new URL("../.next/server/app", import.meta.url));

/** The prefixes a url() target may start with once the CSS lives in the HTML document. */
const ALLOWED_TARGET_PREFIXES = ["/_next/static/", "data:", "#"];

const MAX_TARGET_SHOWN = 200;

/**
 * Shells that are not the site's own and never carried its CSS, by path relative to the scanned
 * directory (top level only). _global-error.html is Next's built-in default global-error page: its
 * own <style> of --next-error-* variables and inline styles, no root layout, no Tailwind sheet. It
 * is the same size before and after experimental.inlineCss (9,917 bytes, 2026-11-12), so rule (a)
 * cannot hold for it. Drop this exception the day src/app gets a global-error.tsx of its own.
 */
export const SKIPPED_SHELLS = ["_global-error.html"];

function isSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/** The character after `<style` / `<link` must end the tag name, or `<styles` and `<linkx` would count. */
function endsTagName(ch) {
  return ch === ">" || ch === "/" || (ch !== undefined && isSpace(ch));
}

/** A character that can be part of an attribute name, so `data-href=` is not mistaken for `href=`. */
function isNameChar(ch) {
  if (ch === undefined) return false;
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "-" || ch === "_" || ch === ":" || ch === ".";
}

/** The double-quoted value of attribute `name` in one tag's text, or null. Linear in the tag. */
function attrValue(tag, name) {
  const needle = `${name}="`;
  let from = 0;
  for (;;) {
    const at = tag.indexOf(needle, from);
    if (at === -1) return null;
    const start = at + needle.length;
    if (!isNameChar(tag[at - 1])) {
      const end = tag.indexOf('"', start);
      return end === -1 ? null : tag.slice(start, end);
    }
    from = start;
  }
}

/** The text of every `<link ...>` tag. Stops at the first tag with no `>`: no later tag can end either. */
function linkTags(html) {
  const tags = [];
  let from = 0;
  for (;;) {
    const at = html.indexOf("<link", from);
    if (at === -1) return tags;
    if (!endsTagName(html[at + 5])) {
      from = at + 5;
      continue;
    }
    const gt = html.indexOf(">", at);
    if (gt === -1) return tags;
    tags.push(html.slice(at, gt + 1));
    from = gt + 1;
  }
}

/**
 * Every `<style ...>` element as { open, body, closed }. An opening tag with no `>` ends the scan; a missing
 * `</style` makes the rest of the document the body of the last element.
 */
function styleElements(html) {
  const elements = [];
  let from = 0;
  for (;;) {
    const at = html.indexOf("<style", from);
    if (at === -1) return elements;
    if (!endsTagName(html[at + 6])) {
      from = at + 6;
      continue;
    }
    const gt = html.indexOf(">", at);
    if (gt === -1) return elements;
    const open = html.slice(at, gt + 1);
    const close = html.indexOf("</style", gt + 1);
    if (close === -1) {
      elements.push({ open, body: html.slice(gt + 1), closed: false });
      return elements;
    }
    elements.push({ open, body: html.slice(gt + 1, close), closed: true });
    from = close + "</style".length;
  }
}

/** One surrounding quote pair removed, decided by the first and the last character. */
function unquote(text) {
  const first = text[0];
  if (text.length >= 2 && (first === '"' || first === "'") && text.endsWith(first)) return text.slice(1, -1);
  return text;
}

function clip(text) {
  return text.length > MAX_TARGET_SHOWN ? `${text.slice(0, MAX_TARGET_SHOWN)}...` : text;
}

/** The problems with the url( references of one style element body. */
function urlProblems(css) {
  const problems = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf("url(", from);
    if (at === -1) return problems;
    let start = at + "url(".length;
    while (start < css.length && isSpace(css[start])) start++;
    const quote = css[start];
    let end;
    if (quote === '"' || quote === "'") {
      // Read a quoted target to its closing quote, then to the `)`: a quoted data: URI may hold `)`.
      const close = css.indexOf(quote, start + 1);
      end = css.indexOf(")", close === -1 ? start : close);
    } else {
      end = css.indexOf(")", start);
    }
    if (end === -1) {
      problems.push("url( is never closed inside a <style> element");
      return problems;
    }
    const target = unquote(css.slice(start, end).trim());
    if (!ALLOWED_TARGET_PREFIXES.some((prefix) => target.startsWith(prefix))) {
      problems.push(`url() target "${clip(target)}" is not under /_next/static/, data: or #`);
    }
    from = end + 1;
  }
}

/**
 * The problems with one prerendered HTML document, as readable lines; [] when the sheet is inline and
 * every url() in it is absolute under /_next/static/, a data: URI or a fragment.
 * @param {string} html
 * @returns {string[]}
 */
export function findInlineCssProblems(html) {
  if (typeof html !== "string") return ["the document is not a string"];
  const problems = [];
  const styles = styleElements(html);

  // (a) the inline sheet itself
  if (!styles.some((el) => attrValue(el.open, "data-precedence") === "next")) {
    problems.push('<style data-precedence="next"> element is missing: the CSS is not inlined');
  }

  // (b) no render-blocking stylesheet link to the build output
  for (const tag of linkTags(html)) {
    const href = attrValue(tag, "href");
    if (attrValue(tag, "rel") === "stylesheet" && href !== null && href.startsWith("/_next/static/")) {
      problems.push(`stylesheet <link> to ${clip(href)} is still in the document`);
    }
  }

  // (c) every url( inside a style element
  for (const el of styles) {
    if (!el.closed) problems.push("<style> element is never closed");
    problems.push(...urlProblems(el.body));
  }
  return problems;
}

function walk(dir, files) {
  const entries = readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (entry.isFile() && entry.name.endsWith(".html")) files.push(path);
  }
}

/** Every *.html under `dir`, depth first, by name (a symlink is not followed). Throws when `dir` cannot be read. */
export function collectHtmlFiles(dir) {
  const files = [];
  walk(dir, files);
  return files;
}

const defaultIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

/** A path for the log: relative to the cwd when that is below it, else as given. */
function shown(file) {
  const rel = relative(process.cwd(), file);
  return rel === "" || rel.startsWith("..") ? file : rel;
}

const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Scans every shell under `dir`. Returns the exit code: 0 when all are sound, 1 on a problem, on an
 * unreadable directory or when there was nothing to scan.
 * @param {string} [dir]
 * @param {{ out: (line: string) => void, err: (line: string) => void }} [io]
 */
export function run(dir = APP_DIR, io = defaultIo) {
  let all;
  try {
    all = collectHtmlFiles(dir);
  } catch (error) {
    io.err(`check-inline-css: cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const files = [];
  const skipped = [];
  for (const file of all) {
    const name = relative(dir, file);
    if (SKIPPED_SHELLS.includes(name)) skipped.push(name);
    else files.push(file);
  }
  if (files.length === 0) {
    io.err(`check-inline-css: no *.html shell to scan under ${dir}; was the build run?`);
    return 1;
  }
  let problems = 0;
  for (const file of files) {
    let found;
    try {
      found = findInlineCssProblems(readFileSync(file, "utf8"));
    } catch (error) {
      found = [`cannot read the file: ${error instanceof Error ? error.message : String(error)}`];
    }
    for (const problem of found) io.err(`${shown(file)}: ${problem}`);
    problems += found.length;
  }
  const skippedNote = skipped.length === 0 ? "" : ` (skipped ${skipped.join(", ")})`;
  io.out(`check-inline-css: scanned ${count(files.length, "shell")}${skippedNote}, ${problems === 0 ? "no problems" : count(problems, "problem")}`);
  return problems === 0 ? 0 : 1;
}

/**
 * True when `argv1` (process.argv[1]) is this very file. Compared by real path: Node resolves symlinks in
 * import.meta.url but keeps argv[1] as typed, so on macOS `node /tmp/.../check-inline-css.mjs` (/tmp is a symlink to
 * /private/tmp) would compare unequal, run() would never execute and the guard would exit 0 without scanning.
 * A path that cannot be resolved (missing, dangling link) is not this file.
 */
export function isEntryPoint(metaUrl, argv1) {
  if (typeof argv1 !== "string" || argv1 === "") return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  process.exitCode = run();
}
