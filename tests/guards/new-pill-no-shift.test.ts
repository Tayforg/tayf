import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { createElement } from "react";
import type { DependencyList, EffectCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LAST_VISIT_KEY, LAST_VISIT_SEEN_KEY } from "@/lib/last-visit";

// ---------------------------------------------------------------------------
// Permanent CI guard (h68-lcp-1): the home "N yeni haber" pill must not move
// the feed.
//
// The pill used to switch its wrapper from `sr-only` (absolutely positioned, no
// height) to an in-flow block once the client had read localStorage's last-visit
// stamp. For every returning reader that pushed the whole feed, the LCP card
// included, down by ~48 px after hydration (CLS 0.033 at 390x844). The hydrated
// client and the server HTML must now have the same layout:
//
//   - NewSinceLastVisit renders a CONSTANT tree: a `data-new-pill-slot` wrapper
//     that holds the always-mounted role="status" region. Only the <p> pill
//     inside it depends on the stamp.
//   - An inline script (src/lib/returning-reader-script.ts, first child of
//     <body>) puts `data-rv` on <html> before the feed is parsed when the stamp
//     exists, and globals.css turns the wrapper from sr-only geometry into a
//     reserved 26 px slot under `html[data-rv]` ... but only when the render
//     also carries `data-reserve` (server-decided: items.length > 0, i.e.
//     this render shows clusters). The outage shell, EmptyClusters and a search
//     with no in-feed matches pass items=[], where the count is always 0
//     and no row may be reserved. The pill has an exact height (h-6.5
//     leading-4) so filling the slot moves nothing.
//   - A layout effect sets `data-rv` before paint when count > 0, for the soft
//     navigation to "/" that mounts the pill after another tab wrote the stamp
//     (the inline script only runs at document parse).
//
// The repo has no DOM test environment, so: the component's markup is rendered
// with react-dom/server, the client snapshot is injected by replacing
// useSyncExternalStore (house pattern, see daily-game-hydration.test.tsx), and
// the CSS and the layout wiring are pinned by source text plus one real
// Tailwind compile.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const COMPONENT = "src/components/home/new-since-last-visit.tsx";
const GLOBALS = "src/app/globals.css";

/** Blanks // and block comments, keeping offsets. Good enough for these files (no `//` inside strings). */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

/** Number of non-overlapping occurrences of `needle` in `hay`. */
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

/** The value of every `className=` attribute: the quoted string, or the balanced `{...}` expression. */
function classNameValues(src: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf("className=", from);
    if (at === -1) return out;
    const start = at + "className=".length;
    const open = src[start];
    let end = start + 1;
    if (open === '"') {
      end = src.indexOf('"', start + 1) + 1;
    } else if (open === "{") {
      let depth = 0;
      for (end = start; end < src.length; end++) {
        const c = src[end];
        if (c === "{") depth++;
        else if (c === "}" && --depth === 0) {
          end++;
          break;
        }
      }
    }
    out.push(src.slice(start, end));
    from = Math.max(end, start + 1);
  }
}

// ---------------------------------------------------------------------------
// (a) source shape of the component
// ---------------------------------------------------------------------------

describe("new-since-last-visit.tsx renders a constant tree", () => {
  const code = blankComments(read(COMPONENT));

  it("has at least one className, and none of them depends on count", () => {
    const values = classNameValues(code);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(v, `className ${v} must not depend on count`).not.toMatch(/\bcount\b/);
      expect(v, `className ${v} must not be a conditional expression`).not.toContain("?");
    }
  });

  it("no longer toggles an sr-only class at all (the geometry lives in globals.css)", () => {
    expect(code).not.toContain("sr-only");
    expect(code).not.toMatch(/count > 0 \?/);
  });

  it("has the data-new-pill-slot wrapper around the always-mounted polite status region", () => {
    const slotAt = code.indexOf("data-new-pill-slot");
    const statusAt = code.indexOf('role="status"');
    const pillAt = code.indexOf("<p");
    expect(slotAt).toBeGreaterThan(-1);
    expect(statusAt).toBeGreaterThan(slotAt);
    expect(pillAt).toBeGreaterThan(statusAt);
    expect(code).toContain('aria-live="polite"');
    expect(code.split('role="status"').length - 1).toBe(1);
    expect(code.split("data-new-pill-slot").length - 1).toBe(1);
  });

  it("gives the pill an exact height so filling the slot moves nothing", () => {
    const pill = code.slice(code.indexOf("<p"), code.indexOf("</p>"));
    expect(pill).toContain("h-6.5");
    expect(pill).toContain("leading-4");
  });

  it("makes the pill a block-level flex box: an inline-flex pill sits in a 28 px line box (16 px font x 1.5), 2 px taller than the 26 px slot", () => {
    const pill = code.slice(code.indexOf("<p"), code.indexOf("</p>"));
    const classes = classNameValues(pill)[0]!.split(/[\s"]+/);
    expect(classes).toContain("flex");
    expect(classes).toContain("w-fit");
    expect(classes).not.toContain("inline-flex");
    expect(classes).not.toContain("inline-block");
  });
});

// ---------------------------------------------------------------------------
// (b) server HTML and client render have the same wrapper
// ---------------------------------------------------------------------------

const mode = vi.hoisted(() => ({ client: false }));

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return {
    ...actual,
    // client: the post-hydration snapshot (reads localStorage). server: the real
    // hook, which Fizz answers from getServerSnapshot.
    useSyncExternalStore: <T>(
      subscribe: (onChange: () => void) => () => void,
      getSnapshot: () => T,
      getServerSnapshot?: () => T,
    ): T =>
      mode.client ? getSnapshot() : actual.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot),
    // client: run the layout-effect body synchronously (renderToString never runs
    // effects), so the component's before-paint side effect is observable.
    // server: the real hook.
    useLayoutEffect: (fn: EffectCallback, deps?: DependencyList): void => {
      if (mode.client) fn();
      else actual.useLayoutEffect(fn, deps);
    },
  };
});

/** `document.documentElement.setAttribute` of the stubbed client document. */
const setAttribute = vi.fn();

afterEach(() => {
  mode.client = false;
  setAttribute.mockClear();
  vi.unstubAllGlobals();
});

const STAMP = "2026-11-08T06:00:00.000Z";
const NEWER = ["2026-11-08T08:00:00.000Z", "2026-11-08T07:30:00.000Z"];
const OLDER = ["2026-11-08T05:00:00.000Z"];

/**
 * One render of the component with a fresh module (the stamp is frozen in module
 * state once read). `stored` is what the client's localStorage holds; the server
 * render runs with no `window` and no `document` at all. A client render stubs
 * `document` with the shared `setAttribute` spy.
 */
async function render(opts: {
  client: boolean;
  stored?: string | null;
  /** What localStorage holds under LAST_VISIT_SEEN_KEY (absent = a legacy reader). */
  storedSeen?: string | null;
  /** first_published of the rendered clusters; each becomes an item with its own id. */
  timestamps: string[];
  /** The page's `stamp` prop (default true: page 1 of the plain feed). */
  stamp?: boolean;
}): Promise<string> {
  vi.resetModules();
  setAttribute.mockClear();
  mode.client = opts.client;
  if (opts.client) {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) =>
          key === LAST_VISIT_KEY
            ? (opts.stored ?? null)
            : key === LAST_VISIT_SEEN_KEY
              ? (opts.storedSeen ?? null)
              : null,
      },
    });
    vi.stubGlobal("document", { documentElement: { setAttribute } });
  }
  const { NewSinceLastVisit } = await import("@/components/home/new-since-last-visit");
  const { renderToString } = await import("react-dom/server");
  const items = opts.timestamps.map((firstPublished, i) => ({ id: `cluster-${i}`, firstPublished }));
  // `listed` (every cluster the plain feed lists) only feeds the stamp effect, which renderToString never runs.
  return renderToString(createElement(NewSinceLastVisit, { stamp: opts.stamp ?? true, items, listed: items }));
}

/** The markup with the (first) pill <p> removed. */
const withoutPill = (html: string) => html.replace(/<p\b[\s\S]*?<\/p>/, "");

describe("NewSinceLastVisit: server HTML and hydrated client share one wrapper", () => {
  it("the server markup is the slot around an empty polite status region, with no class and no pill", async () => {
    const server = await render({ client: false, timestamps: NEWER });
    expect(server).toContain("data-new-pill-slot");
    expect(server).toContain('role="status"');
    expect(server).toContain('aria-live="polite"');
    expect(server).not.toContain("class=");
    expect(server).not.toContain("<p");
    expect(server).not.toContain("yeni haber");
  });

  it("a returning reader with newer items: the client adds only the pill; the wrapper is byte-identical", async () => {
    const server = await render({ client: false, timestamps: NEWER });
    const client = await render({ client: true, stored: STAMP, timestamps: NEWER });
    expect(client).toMatch(/2(?:<!-- -->)? yeni haber/);
    expect(client).toContain("<p");
    expect(withoutPill(client)).toBe(server);
  });

  it("a returning reader with nothing new: the client markup is the server markup", async () => {
    const server = await render({ client: false, timestamps: OLDER });
    const client = await render({ client: true, stored: STAMP, timestamps: OLDER });
    expect(client).toBe(server);
  });

  it("a first visit (no stamp): the client markup is the server markup", async () => {
    const server = await render({ client: false, timestamps: NEWER });
    const client = await render({ client: true, stored: null, timestamps: NEWER });
    expect(client).toBe(server);
  });

  it("an unreadable stamp counts nothing and keeps the same markup", async () => {
    const server = await render({ client: false, timestamps: NEWER });
    const client = await render({ client: true, stored: "not-a-date", timestamps: NEWER });
    expect(client).toBe(server);
  });

  it("keeps the Turkish copy and the exact pill height in the hydrated pill", async () => {
    const client = await render({ client: true, stored: STAMP, timestamps: NEWER });
    expect(client).toContain(" yeni haber");
    expect(client).toContain("h-6.5");
    expect(client).toContain("leading-4");
  });
});

// ---------------------------------------------------------------------------
// h112-follows-1: a story that became listed after the stamp but was first
// published before it is counted through the seen record; the wrapper never moves
// ---------------------------------------------------------------------------

describe("NewSinceLastVisit: the seen record counts late-listed stories", () => {
  // Three clusters, all first published BEFORE the stamp. cluster-0 and cluster-1
  // were on the stamped render; cluster-2 (30 min before the stamp) became listed
  // after it (its 2nd source arrived later).
  const ALL = ["2026-11-08T05:50:00.000Z", "2026-11-08T05:00:00.000Z", "2026-11-08T05:30:00.000Z"];
  const SEEN = JSON.stringify({ v: 1, ids: ["cluster-0", "cluster-1"], floor: "2026-11-08T04:00:00.000Z" });

  it("a returning reader with the record: counts the late story the stamp rule misses; the wrapper is unchanged", async () => {
    const server = await render({ client: false, timestamps: ALL });
    const legacy = await render({ client: true, stored: STAMP, timestamps: ALL });
    expect(legacy).not.toContain("yeni haber");
    const client = await render({ client: true, stored: STAMP, storedSeen: SEEN, timestamps: ALL });
    expect(client).toMatch(/1(?:<!-- -->)? yeni haber/);
    expect(withoutPill(client)).toBe(server);
  });

  it("sets data-rv for that count, exactly like the stamp rule does", async () => {
    await render({ client: true, stored: STAMP, storedSeen: SEEN, timestamps: ALL });
    expect(setAttribute).toHaveBeenCalledTimes(1);
    expect(setAttribute).toHaveBeenCalledWith("data-rv", "");
  });

  it("a story older than the floor that merely resurfaced is not counted", async () => {
    const old = JSON.stringify({ v: 1, ids: ["cluster-0", "cluster-1"], floor: "2026-11-08T05:45:00.000Z" });
    const client = await render({ client: true, stored: STAMP, storedSeen: old, timestamps: ALL });
    expect(client).not.toContain("yeni haber");
  });

  it("h113 correctness-1: a render that does not stamp (?page>=2, ?q=) counts with the stamp rule and ignores the record", async () => {
    // NEWER were first published after the stamp, and the record knows both: the record says 0,
    // the stamp rule says 2. A non-stamping view must give HEAD's 2 (the record describes page 1).
    const known = JSON.stringify({ v: 1, ids: ["cluster-0", "cluster-1"], floor: "2026-11-08T04:00:00.000Z" });
    const onPage1 = await render({ client: true, stored: STAMP, storedSeen: known, timestamps: NEWER });
    expect(onPage1).not.toContain("yeni haber");
    const onPage2 = await render({ client: true, stored: STAMP, storedSeen: known, timestamps: NEWER, stamp: false });
    expect(onPage2).toMatch(/2(?:<!-- -->)? yeni haber/);
    // and the late-listed story the record would have counted is NOT counted there (stamp rule: before the stamp)
    const late = await render({ client: true, stored: STAMP, storedSeen: SEEN, timestamps: ALL, stamp: false });
    expect(late).not.toContain("yeni haber");
  });

  it("a garbage record falls back to the stamp rule (no pill here; the usual 2 for newer items)", async () => {
    expect(await render({ client: true, stored: STAMP, storedSeen: "{oops", timestamps: ALL })).not.toContain(
      "yeni haber",
    );
    expect(await render({ client: true, stored: STAMP, storedSeen: "{oops", timestamps: NEWER })).toMatch(
      /2(?:<!-- -->)? yeni haber/,
    );
  });
});

// ---------------------------------------------------------------------------
// react-L1: the slot is reserved only when this render shows clusters
// ---------------------------------------------------------------------------

describe("NewSinceLastVisit: data-reserve is decided by the server prop, never by the stamp", () => {
  it("empty items (outage shell, EmptyClusters, search with no in-feed matches): server and client are byte-identical and reserve nothing", async () => {
    const server = await render({ client: false, timestamps: [] });
    const client = await render({ client: true, stored: STAMP, timestamps: [] });
    expect(client).toBe(server);
    expect(server).toContain("data-new-pill-slot");
    expect(server).not.toContain("data-reserve");
    expect(client).not.toContain("data-reserve");
  });

  it("non-empty items: server and client both carry data-reserve on the slot", async () => {
    const server = await render({ client: false, timestamps: NEWER });
    const client = await render({ client: true, stored: STAMP, timestamps: NEWER });
    expect(server).toContain('data-new-pill-slot="" data-reserve=""');
    expect(client).toContain('data-new-pill-slot="" data-reserve=""');
    expect(withoutPill(client)).toBe(server);
  });

  it("non-empty items with nothing new, a first visit and an unreadable stamp all still carry data-reserve (the server cannot know the stamp)", async () => {
    for (const [stored, timestamps] of [
      [STAMP, OLDER],
      [null, NEWER],
      ["not-a-date", NEWER],
    ] as const) {
      const server = await render({ client: false, timestamps: [...timestamps] });
      const client = await render({ client: true, stored, timestamps: [...timestamps] });
      expect(server).toContain('data-new-pill-slot="" data-reserve=""');
      expect(client).toBe(server);
    }
  });
});

// ---------------------------------------------------------------------------
// react-L2: a soft navigation to "/" opens the slot before paint
// ---------------------------------------------------------------------------

describe("NewSinceLastVisit: a before-paint layout effect sets data-rv when count > 0", () => {
  it("client, stored stamp, newer items: sets data-rv on <html> exactly once", async () => {
    await render({ client: true, stored: STAMP, timestamps: NEWER });
    expect(setAttribute).toHaveBeenCalledTimes(1);
    expect(setAttribute).toHaveBeenCalledWith("data-rv", "");
  });

  it("client, stored stamp, nothing newer: never touches <html>", async () => {
    await render({ client: true, stored: STAMP, timestamps: OLDER });
    expect(setAttribute).not.toHaveBeenCalled();
  });

  it("client, first visit (no stamp): never touches <html>", async () => {
    await render({ client: true, stored: null, timestamps: NEWER });
    expect(setAttribute).not.toHaveBeenCalled();
  });

  it("client, unreadable stamp: never touches <html>", async () => {
    await render({ client: true, stored: "not-a-date", timestamps: NEWER });
    expect(setAttribute).not.toHaveBeenCalled();
  });

  it("client, empty items: never touches <html> (count is always 0)", async () => {
    await render({ client: true, stored: STAMP, timestamps: [] });
    expect(setAttribute).not.toHaveBeenCalled();
  });

  it("server render: no document access, does not throw, sets nothing", async () => {
    expect(typeof document).toBe("undefined");
    await expect(render({ client: false, timestamps: NEWER })).resolves.toContain("data-new-pill-slot");
    expect(setAttribute).not.toHaveBeenCalled();
  });

  it("source: the useLayoutEffect body sets data-rv only under `if (count > 0)`, and depends on [count]", () => {
    const code = blankComments(read(COMPONENT));
    expect(code).toMatch(/import \{[^}]*\buseLayoutEffect\b[^}]*\} from "react";/);
    expect(count(code, "useLayoutEffect(")).toBe(1);
    expect(code).toMatch(
      /useLayoutEffect\(\(\) => \{\s*if \(count > 0\) document\.documentElement\.setAttribute\("data-rv", ""\);\s*\}, \[count\]\);/,
    );
    // the only place the component touches <html>
    expect(count(code, "document.documentElement")).toBe(1);
  });

  it("source: the wrapper sets data-reserve from items.length, with no className and nothing that reads count", () => {
    const code = blankComments(read(COMPONENT));
    expect(code).toContain('<div data-new-pill-slot="" data-reserve={items.length > 0 ? "" : undefined}>');
    const slotAt = code.indexOf("data-new-pill-slot");
    const tag = code.slice(code.lastIndexOf("<div", slotAt), code.indexOf(">", slotAt));
    expect(tag).not.toContain("className");
    expect(tag).not.toMatch(/\bcount\b/);
  });
});

// ---------------------------------------------------------------------------
// (c) the inline script
// ---------------------------------------------------------------------------

describe("RETURNING_READER_SCRIPT", () => {
  const load = async () => (await import("@/lib/returning-reader-script")).RETURNING_READER_SCRIPT;

  /** Runs the script against a stub page; returns the attributes it set. */
  function run(script: string, localStorage: { getItem: (key: string) => string | null }) {
    const attrs: [string, string][] = [];
    runInNewContext(script, {
      localStorage,
      document: { documentElement: { setAttribute: (k: string, v: string) => attrs.push([k, v]) } },
    });
    return attrs;
  }

  it("reads the same key the pill reads (JSON.stringify(LAST_VISIT_KEY)), in a try/catch, and sets data-rv on <html>", async () => {
    const script = await load();
    expect(script).toContain(JSON.stringify(LAST_VISIT_KEY));
    expect(script.startsWith("try{")).toBe(true);
    expect(script).toContain("catch(");
    expect(script).toContain("localStorage.getItem(");
    expect(script).toContain('document.documentElement.setAttribute("data-rv","")');
  });

  it("cannot terminate its own <script> element", async () => {
    const script = await load();
    expect(script).not.toContain("<");
  });

  it("sets data-rv when a stamp exists", async () => {
    const script = await load();
    const asked: string[] = [];
    const attrs = run(script, {
      getItem: (k) => {
        asked.push(k);
        return STAMP;
      },
    });
    expect(asked).toEqual([LAST_VISIT_KEY]);
    expect(attrs).toEqual([["data-rv", ""]]);
  });

  it("sets nothing for a first visit (no stamp or an empty one)", async () => {
    const script = await load();
    expect(run(script, { getItem: () => null })).toEqual([]);
    expect(run(script, { getItem: () => "" })).toEqual([]);
  });

  it("swallows a blocked localStorage and does not throw", async () => {
    const script = await load();
    expect(
      run(script, {
        getItem: () => {
          throw new Error("SecurityError");
        },
      }),
    ).toEqual([]);
  });
});

describe("root layout wires the script", () => {
  const layout = blankComments(read("src/app/layout.tsx"));

  it("imports RETURNING_READER_SCRIPT and renders it as the FIRST child of <body>, before the JSON-LD script", () => {
    expect(layout).toMatch(/import \{ RETURNING_READER_SCRIPT \} from "@\/lib\/returning-reader-script";/);
    const bodyAt = layout.indexOf("<body");
    const scriptAt = layout.indexOf("RETURNING_READER_SCRIPT }}");
    const ldAt = layout.indexOf("application/ld+json");
    expect(bodyAt).toBeGreaterThan(-1);
    expect(scriptAt).toBeGreaterThan(bodyAt);
    expect(ldAt).toBeGreaterThan(scriptAt);
    // nothing but whitespace and (blanked) JSX comments between <body ...> and the script
    const between = layout.slice(layout.indexOf(">", bodyAt) + 1, layout.lastIndexOf("<script", scriptAt));
    expect(between.split(/[\s{}]+/).join("")).toBe("");
    expect(layout.slice(layout.lastIndexOf("<script", scriptAt), scriptAt)).toContain("dangerouslySetInnerHTML");
  });

  it("marks <html> suppressHydrationWarning (the script adds data-rv before React hydrates)", () => {
    const htmlAt = layout.indexOf("<html");
    const tag = layout.slice(htmlAt, layout.indexOf(">", htmlAt));
    expect(tag).toContain("suppressHydrationWarning");
  });
});

// ---------------------------------------------------------------------------
// (d) the CSS
// ---------------------------------------------------------------------------

/** Declarations of the first rule whose selector is exactly `selector`, whitespace-normalised. */
function declarations(css: string, selector: string): string[] {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css
    .slice(open + 1, close)
    .split(";")
    .map((d) => d.split(/\s+/).filter(Boolean).join(" "))
    .filter(Boolean);
}

describe("globals.css reserves the slot for returning readers", () => {
  const css = read(GLOBALS);

  it("by default the slot has the sr-only geometry", () => {
    const decls = declarations(css, "[data-new-pill-slot]");
    for (const d of [
      "position: absolute",
      "width: 1px",
      "height: 1px",
      "padding: 0",
      "margin: -1px",
      "overflow: hidden",
      "clip: rect(0, 0, 0, 0)",
      "white-space: nowrap",
      "border: 0",
    ]) {
      expect(decls, `default slot rule must declare ${d}`).toContain(d);
    }
  });

  it("html[data-rv] with data-reserve resets it to an in-flow block with a 1.625rem minimum", () => {
    const decls = declarations(css, "html[data-rv] [data-new-pill-slot][data-reserve]");
    for (const d of [
      "position: static",
      "width: auto",
      "height: auto",
      "margin: 0",
      "overflow: visible",
      "clip: auto",
      "white-space: normal",
      "min-height: 1.625rem",
    ]) {
      expect(decls, `returning-reader slot rule must declare ${d}`).toContain(d);
    }
  });

  it("both rules sit in @layer base, so the feed's space-y-5 margin (utilities) still wins over `margin: 0`", () => {
    const baseAt = css.indexOf("@layer base {");
    const utilitiesAt = css.indexOf("@layer utilities {");
    expect(baseAt).toBeGreaterThan(-1);
    expect(utilitiesAt).toBeGreaterThan(baseAt);
    for (const sel of ["[data-new-pill-slot] {", "html[data-rv] [data-new-pill-slot][data-reserve] {"]) {
      const at = css.indexOf(sel);
      expect(at, `${sel} rule`).toBeGreaterThan(baseAt);
      expect(at, `${sel} rule must precede @layer utilities`).toBeLessThan(utilitiesAt);
    }
  });

  it("the reservation can never apply without data-reserve (react-L1: no row for empty-timestamp renders)", () => {
    expect(css).not.toContain("html[data-rv] [data-new-pill-slot] {");
    expect(css).not.toMatch(/html\[data-rv\] \[data-new-pill-slot\]\s*[{,]/);
  });
});

describe("Tailwind really emits the pill's utilities, in the right layers", () => {
  /** The `@layer` names a rule sits in (outermost last). */
  function layersOf(root: postcss.Root, match: (selector: string) => boolean): string[] {
    const found = new Set<string>();
    root.walkRules((rule) => {
      if (!match(rule.selector)) return;
      for (let p: postcss.Container | postcss.Document | undefined = rule.parent; p; p = p.parent) {
        if (p.type === "atrule" && (p as postcss.AtRule).name === "layer") found.add((p as postcss.AtRule).params);
      }
    });
    return [...found];
  }

  it("h-6.5 is a valid v4 spacing utility (6.5 x 0.25rem = 26px = the slot's min-height); the slot rules are in base, space-y-5 in utilities", async () => {
    const path = join(ROOT, GLOBALS);
    const result = await postcss([tailwindcss({ base: ROOT })]).process(read(GLOBALS), { from: path });
    const root = postcss.parse(result.css);

    let h65: string | undefined;
    root.walkRules((rule) => {
      if (rule.selector === ".h-6\\.5") rule.walkDecls("height", (d) => void (h65 = d.value));
    });
    expect(h65, "no .h-6.5 { height } rule in the compiled sheet").toBe("calc(var(--spacing) * 6.5)");
    expect(layersOf(root, (sel) => sel === ".leading-4")).toEqual(["utilities"]);

    // Layer priority follows the declared order, not source order: utilities beat base.
    let order: string | undefined;
    root.walkAtRules("layer", (a) => {
      if (a.nodes === undefined && a.params.includes(",")) order = a.params;
    });
    expect(order).toBe("theme, base, components, utilities");

    expect(layersOf(root, (sel) => sel === "[data-new-pill-slot]")).toEqual(["base"]);
    expect(layersOf(root, (sel) => sel === "html[data-rv] [data-new-pill-slot][data-reserve]")).toEqual(["base"]);
    expect(layersOf(root, (sel) => sel.includes(".space-y-5"))).toEqual(["utilities"]);
  }, 60_000);
});
