import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { expectLinear, rep } from "../tests/_helpers/linear-time";
import { SKIPPED_SHELLS, collectHtmlFiles, findInlineCssProblems, isEntryPoint, run } from "./check-inline-css.mjs";

// h159-perf-1: experimental.inlineCss puts the Tailwind sheet in a <style
// data-precedence="next"> of every prerendered shell instead of a render-blocking
// <link rel="stylesheet">. scripts/check-inline-css.mjs scans the built shells
// (.next/server/app/**/*.html) and fails CI when a shell still links the sheet,
// carries no inline style, or has a url() in a style that would break once the CSS
// moved out of /_next/static/chunks (a relative path such as ../media/x.woff2
// resolves against the PAGE url, so the font would 404). These tests use short
// literal fixtures and never run a regex over HTML.

const STYLE_OPEN = '<style data-precedence="next">';
const STYLE_CLOSE = "</style>";

const style = (css, open = STYLE_OPEN) => `${open}${css}${STYLE_CLOSE}`;
const face = (target) => `@font-face{font-family:f;src:url(${target}) format("woff2")}`;
const page = (head, body = "") => `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;

const NO_STYLE = '<style data-precedence="next"> element is missing: the CSS is not inlined';
const bad = (target) => `url() target "${target}" is not under /_next/static/, data: or #`;

describe("findInlineCssProblems: shells that pass", () => {
  it("accepts a shell whose head carries the inline sheet and absolute font urls", () => {
    const html = page(
      `${style(`${face("/_next/static/media/a.woff2")}body{color:red}`)}<script async src="/_next/static/chunks/a.js"></script>`,
      "<main>merhaba</main>",
    );
    expect(findInlineCssProblems(html)).toEqual([]);
  });

  it("accepts the live Vercel path /_next/static/immutable/media/x.woff2", () => {
    expect(findInlineCssProblems(page(style(face("/_next/static/immutable/media/x.woff2"))))).toEqual([]);
  });

  it("accepts data: urls, quoted or not, and a fragment reference", () => {
    const css = `a{background:url(data:image/png;base64,AAAA)}b{background:url("data:image/svg+xml,%3Csvg%3E")}c{filter:url(#blur)}`;
    expect(findInlineCssProblems(page(style(css)))).toEqual([]);
  });

  it("accepts a quoted data: url that itself holds parentheses and a quote of the other kind", () => {
    const css = `a{background:url("data:image/svg+xml;utf8,<svg fill='rgb(1,2,3)'/>")}b{background:url('data:image/svg+xml;utf8,<svg fill="rgb(1,2,3)"/>')}`;
    expect(findInlineCssProblems(page(style(css)))).toEqual([]);
  });

  it("accepts spaces around the target and a style with no url() at all", () => {
    expect(findInlineCssProblems(page(style(`a{background:url(  /_next/static/media/a.woff2  )}b{background:url( "/_next/static/media/b.woff2" )}`)))).toEqual([]);
    expect(findInlineCssProblems(page(style("body{margin:0}")))).toEqual([]);
  });

  it("accepts further attributes on the style tag and several style elements", () => {
    const html = page(
      `${style("a{color:red}", '<style data-href="/x" data-precedence="next" nonce="n">')}${style(face("/_next/static/media/a.woff2"), "<style>")}`,
    );
    expect(findInlineCssProblems(html)).toEqual([]);
  });

  it("accepts Unicode and emoji around the style", () => {
    expect(findInlineCssProblems(page(style("a{color:red}"), "<p>Türkçe haber ğüşiöç 📰</p>"))).toEqual([]);
  });

  it("accepts a stylesheet link that is not under /_next/static/ and non-stylesheet links", () => {
    const head = `${style("a{color:red}")}<link rel="stylesheet" href="https://fonts.example/x.css"><link rel="preload" as="font" href="/_next/static/media/a.woff2" crossorigin=""><link rel="icon" href="/_next/static/media/i.ico">`;
    expect(findInlineCssProblems(page(head))).toEqual([]);
  });

  it("does not take a data-href or data-rel attribute for href or rel", () => {
    const head = `${style("a{color:red}")}<link rel="stylesheet" data-href="/_next/static/a.css"><link data-rel="stylesheet" href="/_next/static/b.css">`;
    expect(findInlineCssProblems(page(head))).toEqual([]);
  });

  it("ignores a url( outside every style element", () => {
    const html = page(style("a{color:red}"), '<div style="background:url(../x.png)">url(../y.png)</div>');
    expect(findInlineCssProblems(html)).toEqual([]);
  });
});

describe("findInlineCssProblems: relative url() targets", () => {
  it("flags an unquoted relative url and names the target", () => {
    expect(findInlineCssProblems(page(style(face("../media/x.woff2"))))).toEqual([bad("../media/x.woff2")]);
  });

  it("flags a double-quoted and a single-quoted relative url without the quotes", () => {
    expect(findInlineCssProblems(page(style(`a{src:url("../media/x.woff2")}`)))).toEqual([bad("../media/x.woff2")]);
    expect(findInlineCssProblems(page(style(`a{src:url('../media/x.woff2')}`)))).toEqual([bad("../media/x.woff2")]);
  });

  it("flags a bare file name, a protocol-relative url, an https url and a url with spaces inside quotes", () => {
    expect(findInlineCssProblems(page(style("a{src:url(x.woff2)}")))).toEqual([bad("x.woff2")]);
    expect(findInlineCssProblems(page(style("a{src:url(//cdn.example/x.woff2)}")))).toEqual([bad("//cdn.example/x.woff2")]);
    expect(findInlineCssProblems(page(style("a{src:url(https://cdn.example/x.woff2)}")))).toEqual([bad("https://cdn.example/x.woff2")]);
    expect(findInlineCssProblems(page(style(`a{src:url( " ../x.woff2 " )}`)))).toEqual([bad(" ../x.woff2 ")]);
  });

  it("flags a path that only looks like /_next/static (no trailing slash, other prefix)", () => {
    expect(findInlineCssProblems(page(style("a{src:url(/_next/staticx/a.woff2)}")))).toEqual([bad("/_next/staticx/a.woff2")]);
    expect(findInlineCssProblems(page(style("a{src:url(/media/a.woff2)}")))).toEqual([bad("/media/a.woff2")]);
    expect(findInlineCssProblems(page(style("a{src:url(DATA:x)}")))).toEqual([bad("DATA:x")]);
  });

  it("flags an empty url()", () => {
    expect(findInlineCssProblems(page(style("a{src:url()}")))).toEqual([bad("")]);
  });

  it("reports every bad url across every style element, in document order", () => {
    const html = page(
      `${style(`${face("../a.woff2")}${face("/_next/static/media/ok.woff2")}`)}${style(face("b.woff2"), "<style>")}`,
    );
    expect(findInlineCssProblems(html)).toEqual([bad("../a.woff2"), bad("b.woff2")]);
  });

  it("checks a style element without data-precedence too", () => {
    expect(findInlineCssProblems(page(`${style("a{color:red}")}${style(face("../x.woff2"), "<style>")}`))).toEqual([bad("../x.woff2")]);
  });

  it("reports a url( that never closes and stops reading that style", () => {
    expect(findInlineCssProblems(page(style("a{src:url(/_next/static/media/a.woff2")))).toEqual([
      "url( is never closed inside a <style> element",
    ]);
  });
});

describe("findInlineCssProblems: stylesheet links and missing style", () => {
  it("flags a render-blocking stylesheet link to /_next/static/ and names its href", () => {
    const html = page(`${style("a{color:red}")}<link rel="stylesheet" href="/_next/static/chunks/0256gv6h48rgd.css" data-precedence="next">`);
    expect(findInlineCssProblems(html)).toEqual(['stylesheet <link> to /_next/static/chunks/0256gv6h48rgd.css is still in the document']);
  });

  it("flags the link with its attributes in the other order", () => {
    const html = page(`${style("a{color:red}")}<link href="/_next/static/c.css" rel="stylesheet">`);
    expect(findInlineCssProblems(html)).toEqual(["stylesheet <link> to /_next/static/c.css is still in the document"]);
  });

  it("flags every stylesheet link, not only the first", () => {
    const head = `${style("a{color:red}")}<link rel="stylesheet" href="/_next/static/a.css"><link rel="stylesheet" href="/_next/static/b.css">`;
    expect(findInlineCssProblems(page(head))).toHaveLength(2);
  });

  it("flags a document with no style element", () => {
    expect(findInlineCssProblems(page("<title>x</title>"))).toEqual([NO_STYLE]);
    expect(findInlineCssProblems("")).toEqual([NO_STYLE]);
  });

  it("flags a document whose only style is not Next's data-precedence=next one", () => {
    expect(findInlineCssProblems(page(style("a{color:red}", "<style>")))).toEqual([NO_STYLE]);
    expect(findInlineCssProblems(page(style("a{color:red}", '<style data-precedence="high">')))).toEqual([NO_STYLE]);
  });

  it("does not take data-precedence=next from an element that is not a <style> tag", () => {
    expect(findInlineCssProblems(page('<styles data-precedence="next"></styles><div data-precedence="next"></div>'))).toEqual([NO_STYLE]);
    expect(findInlineCssProblems(page(style("a{color:red}", '<style x-data-precedence="next">')))).toEqual([NO_STYLE]);
  });

  it("reports the missing style and the link together", () => {
    const problems = findInlineCssProblems(page('<link rel="stylesheet" href="/_next/static/a.css">'));
    expect(problems).toEqual([NO_STYLE, "stylesheet <link> to /_next/static/a.css is still in the document"]);
  });

  it("flags a style element that is never closed", () => {
    expect(findInlineCssProblems(`<html><head>${STYLE_OPEN}a{color:red}`)).toEqual(["<style> element is never closed"]);
  });

  it("flags input that is not a string instead of throwing", () => {
    for (const input of [null, undefined, 42, {}, []]) {
      expect(findInlineCssProblems(input)).toEqual(["the document is not a string"]);
    }
  });
});

// A blow-up (rescanning to the end of the document from every `<link`, `<style` or `url(`) is a property of
// how the time grows with the input, so it is measured as growth (CPU time over a size ladder), not wall clock.
describe("findInlineCssProblems scales linearly", () => {
  const OPTS = { n: 400_000, ceilingMs: 4_000 };
  const shapes = [
    ["url( with no closing parenthesis", rep("url(", STYLE_OPEN)],
    ['url(" with no closing quote', rep('url("', STYLE_OPEN)],
    ["url(' with no closing quote", rep("url('", STYLE_OPEN)],
    ["url( pieces closed once at the very end", rep("url(", `${STYLE_OPEN}`, ")")],
    ["url(x) pieces", rep("url(../x)", STYLE_OPEN, STYLE_CLOSE)],
    ["<link with no closing >", rep("<link ")],
    ["<link rel=stylesheet pieces closed once at the end", rep('<link rel="stylesheet" ', "", ">")],
    ["complete <link> tags", rep('<link rel="stylesheet" href="/x.css">')],
    ["<style with no closing >", rep("<style ")],
    ["<style data-precedence=next with no closing >", rep(STYLE_OPEN.slice(0, -1))],
    ["<style> elements that never close", rep("<style>")],
    ["complete <style> elements", rep("<style>a{}</style>")],
    ["</style pieces", rep("</style", STYLE_OPEN)],
  ];
  it.each(shapes)("%s", (_label, gen) => {
    expectLinear(gen, (html) => findInlineCssProblems(html), OPTS);
  });
});

describe("collectHtmlFiles and run", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "check-inline-css-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel, text) => {
    const file = join(dir, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  const capture = () => {
    const out = [];
    const err = [];
    return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } };
  };
  const GOOD = page(style(face("/_next/static/media/a.woff2")));

  it("walks nested directories for *.html only, in a stable order", () => {
    const b = write("b.html", GOOD);
    const a = write("a.html", GOOD);
    const deep = write(join("x", "y", "deep.html"), GOOD);
    write("a.rsc", "not html");
    write(join("x", "notes.txt"), "no");
    write("page.html.bak", "no");
    expect(collectHtmlFiles(dir)).toEqual([a, b, deep]);
  });

  it("returns an empty list for a directory without html", () => {
    write("a.rsc", "x");
    expect(collectHtmlFiles(dir)).toEqual([]);
  });

  it("exits 0 and reports the count when every shell is sound", () => {
    write("index.html", GOOD);
    write(join("cluster", "[id].html"), GOOD);
    const { out, err, io } = capture();
    expect(run(dir, io)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual(["check-inline-css: scanned 2 shells, no problems"]);
  });

  it("exits 1 and prints `<file>: <problem>` for each problem", () => {
    const badFile = write(join("sub", "bad.html"), page(style(face("../media/x.woff2"))));
    write("index.html", GOOD);
    const { out, err, io } = capture();
    expect(run(dir, io)).toBe(1);
    expect(err).toEqual([`${badFile}: ${bad("../media/x.woff2")}`]);
    expect(out).toEqual(["check-inline-css: scanned 2 shells, 1 problem"]);
  });

  it("exits 1 when zero files were scanned", () => {
    write("a.rsc", "x");
    const { err, io } = capture();
    expect(run(dir, io)).toBe(1);
    expect(err).toEqual([`check-inline-css: no *.html shell to scan under ${dir}; was the build run?`]);
  });

  it("exits 1 when the directory does not exist", () => {
    const missing = join(dir, "nope");
    const { err, io } = capture();
    expect(run(missing, io)).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain(missing);
  });

  it("keeps scanning after a failing shell and prints every problem", () => {
    const one = write("one.html", page("<title>x</title>"));
    const two = write("two.html", page(`${style("a{color:red}")}<link rel="stylesheet" href="/_next/static/a.css">`));
    const { out, err, io } = capture();
    expect(run(dir, io)).toBe(1);
    expect(err).toEqual([
      `${one}: ${NO_STYLE}`,
      `${two}: stylesheet <link> to /_next/static/a.css is still in the document`,
    ]);
    expect(out).toEqual(["check-inline-css: scanned 2 shells, 2 problems"]);
  });
});

describe("run: the one shell that never had the site CSS", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "check-inline-css-skip-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel, text) => {
    const file = join(dir, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  };
  const capture = () => {
    const out = [];
    const err = [];
    return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } };
  };
  // Next's built-in global-error page: its own <style> (--next-error-* variables), no site layout, no Tailwind sheet.
  const BUILT_IN_ERROR_PAGE = '<!DOCTYPE html><html id="__next_error__"><head><style>:root{--next-error-bg:#fff}</style></head><body></body></html>';
  const GOOD = page(style(face("/_next/static/media/a.woff2")));

  it("names exactly the top-level _global-error.html", () => {
    expect(SKIPPED_SHELLS).toEqual(["_global-error.html"]);
    expect(findInlineCssProblems(BUILT_IN_ERROR_PAGE)).toEqual([NO_STYLE]);
  });

  it("skips it, says so, and still passes", () => {
    write("_global-error.html", BUILT_IN_ERROR_PAGE);
    write("index.html", GOOD);
    write("_not-found.html", GOOD);
    const { out, err, io } = capture();
    expect(run(dir, io)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual(["check-inline-css: scanned 2 shells (skipped _global-error.html), no problems"]);
  });

  it("skips only the top-level file: a nested _global-error.html is scanned like any other shell", () => {
    write("index.html", GOOD);
    write(join("sub", "_global-error.html"), BUILT_IN_ERROR_PAGE);
    const { err, io } = capture();
    expect(run(dir, io)).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain(join("sub", "_global-error.html"));
  });

  it("does not let the exemption hide a bad shell next to it", () => {
    write("_global-error.html", BUILT_IN_ERROR_PAGE);
    write("index.html", page(style(face("../media/x.woff2"))));
    const { out, err, io } = capture();
    expect(run(dir, io)).toBe(1);
    expect(err).toHaveLength(1);
    expect(out).toEqual(["check-inline-css: scanned 1 shell (skipped _global-error.html), 1 problem"]);
  });

  it("exits 1 when the skipped shell is the only one (nothing was scanned)", () => {
    write("_global-error.html", BUILT_IN_ERROR_PAGE);
    const { err, io } = capture();
    expect(run(dir, io)).toBe(1);
    expect(err).toEqual([`check-inline-css: no *.html shell to scan under ${dir}; was the build run?`]);
  });
});

describe("isEntryPoint", () => {
  it("is true only for the script that node was started with", () => {
    const self = fileURLToPath(new URL("./check-inline-css.mjs", import.meta.url));
    const url = pathToFileURL(self).href;
    expect(isEntryPoint(url, self)).toBe(true);
    expect(isEntryPoint(url, `${self}.other`)).toBe(false);
    expect(isEntryPoint(url, undefined)).toBe(false);
    expect(isEntryPoint(url, "")).toBe(false);
  });

  // macOS: /tmp is a symlink to /private/tmp. Node resolves symlinks in import.meta.url but process.argv[1] keeps the typed
  // path, so comparing URLs made `node /tmp/.../check-inline-css.mjs` exit 0 without scanning anything (a false green).
  describe("through a symlink", () => {
    let linkDir;
    beforeEach(() => {
      linkDir = mkdtempSync(join(tmpdir(), "check-inline-css-link-"));
    });
    afterEach(() => {
      rmSync(linkDir, { recursive: true, force: true });
    });

    const self = fileURLToPath(new URL("./check-inline-css.mjs", import.meta.url));
    const url = pathToFileURL(self).href;

    it("is true when argv[1] is a symlink to the script", () => {
      const link = join(linkDir, "check.mjs");
      symlinkSync(self, link);
      expect(isEntryPoint(url, link)).toBe(true);
    });

    it("is true when argv[1] runs through a symlinked directory that holds the script", () => {
      const dirLink = join(linkDir, "scripts-link");
      symlinkSync(dirname(self), dirLink);
      expect(isEntryPoint(url, join(dirLink, "check-inline-css.mjs"))).toBe(true);
    });

    it("is false for a symlink to some other file", () => {
      const other = join(linkDir, "other.mjs");
      writeFileSync(other, "// not the script\n");
      const link = join(linkDir, "other-link.mjs");
      symlinkSync(other, link);
      expect(isEntryPoint(url, link)).toBe(false);
    });

    it("is false for a dangling symlink instead of throwing", () => {
      const link = join(linkDir, "dangling.mjs");
      symlinkSync(join(linkDir, "does-not-exist.mjs"), link);
      expect(isEntryPoint(url, link)).toBe(false);
    });

    it("is true for a relative argv[1] that resolves to the script", () => {
      expect(isEntryPoint(url, relative(process.cwd(), self))).toBe(true);
    });
  });
});
