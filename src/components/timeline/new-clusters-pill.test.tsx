import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import {
  NewClustersPill,
  STALE_LIST_PROBE_MS,
  isListStale,
  startStaleProbe,
} from "./new-clusters-pill";
import {
  TIMELINE_POLL_MS,
  startHeadPolling,
  type HeadFetchResult,
  type TimelineHeadRow,
} from "@/lib/clusters/timeline-head";

// Source-guard helpers. `code` below is the file with comments blanked.

/** Index of the bracket that closes the one opened at `openAt` (or -1). */
function closeOf(text: string, openAt: number): number {
  const open = text[openAt];
  const close = open === "(" ? ")" : open === "{" ? "}" : "";
  if (close === "") return -1;
  let depth = 0;
  for (let i = openAt; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}

/** `text` with every `name(...)` call (balanced parentheses) cut out. */
function stripCalls(text: string, name: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const at = text.indexOf(`${name}(`, from);
    if (at === -1) return out + text.slice(from);
    const end = closeOf(text, at + name.length);
    if (end === -1) return out + text.slice(from);
    out += text.slice(from, at);
    from = end + 1;
  }
}

/** The `{ ... }` block that follows the first `head` in `text` (without braces). */
function blockAfter(text: string, head: RegExp): string | null {
  const m = head.exec(text);
  if (m === null) return null;
  const open = text.indexOf("{", m.index + m[0].length - 1);
  const close = open === -1 ? -1 : closeOf(text, open);
  return close === -1 ? null : text.slice(open + 1, close);
}

// ---------------------------------------------------------------------------
// The pill is client-only state: the server (and the first client render) must
// agree on an EMPTY live region, so there is nothing to hydrate-mismatch. The
// count only appears after the poller has run in an effect, which no static
// render executes. The poll/diff logic itself is covered in
// src/lib/clusters/timeline-head.test.ts.
// ---------------------------------------------------------------------------

describe("NewClustersPill -- server render", () => {
  const markup = renderToStaticMarkup(
    <NewClustersPill
      newestPublished="2026-09-18T10:00:00.000Z"
      floorPublished={null}
      knownIds={[]}
    />,
  );

  it("renders a polite status live region", () => {
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
  });

  it("makes the region a programmatic focus target (tabindex -1), not a tab stop", () => {
    expect(markup).toContain('tabindex="-1"');
  });

  it("renders no button and no count (SSR count is 0, hydration-safe)", () => {
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("yeni küme");
    expect(markup).not.toContain("Yenile");
    expect(markup).not.toContain("Liste güncellendi");
  });

  it("renders the same empty region when the page has no rows at all", () => {
    const empty = renderToStaticMarkup(
      <NewClustersPill newestPublished={null} floorPublished={null} knownIds={[]} />,
    );
    expect(empty).toContain('role="status"');
    expect(empty).not.toContain("<button");
  });

  // CLS 0: the region is positioned in the parent's 32 px space-y-8 gap, out of
  // flow, with a fixed 32 px box. The pill and the "Liste güncellendi" text
  // appear inside that box, so nothing below it can move.
  it("reserves its own box out of flow: absolute, full width, 32 px tall, centred", () => {
    const tag = /<[a-z]+\b[^>]*\brole="status"[^>]*>/.exec(markup)?.[0];
    expect(tag).toBeDefined();
    const classes = /\bclass="([^"]*)"/.exec(tag ?? "")?.[1] ?? "";
    const tokens = classes.split(/\s+/).filter(Boolean);
    for (const token of [
      "absolute",
      "inset-x-0",
      "top-full",
      "h-8",
      "flex",
      "items-center",
      "justify-center",
    ]) {
      expect(tokens).toContain(token);
    }
  });
});

describe("NewClustersPill -- source guard", () => {
  const source = readFileSync(
    resolve(__dirname, "new-clusters-pill.tsx"),
    "utf8",
  );
  // Comments blanked so prose cannot trip or satisfy a check.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));

  it("is a client component that refreshes through the router and polls via startHeadPolling", () => {
    expect(source.trimStart().startsWith('"use client"')).toBe(true);
    expect(code).toMatch(/router\.refresh\(\)/);
    expect(code).toMatch(/startHeadPolling\s*\(/);
  });

  it("polls the head endpoint, with no query string (CDN key stays constant)", () => {
    expect(code).toMatch(/["']\/api\/timeline\/head["']/);
    expect(code).not.toMatch(/\/api\/timeline\/head\?/);
  });

  it("owns no raw interval and no randomness (the poller owns the schedule)", () => {
    expect(code).not.toMatch(/\bsetInterval\b/);
    expect(code).not.toMatch(/Math\.random/);
  });

  it("reads the clock only through the injected '() => Date.now()' dependency", () => {
    const all = code.match(/Date\.now/g) ?? [];
    const wrapped = code.match(/\(\)\s*=>\s*Date\.now\(\)/g) ?? [];
    expect(all.length).toBe(wrapped.length);
  });

  it("is named by its visible text: no aria-label (WCAG 2.5.3)", () => {
    expect(code).not.toMatch(/aria-label/);
  });

  it("keeps a target of at least 24 px (WCAG 2.2 2.5.8)", () => {
    expect(code).toMatch(/\bmin-h-8\b/);
  });

  it("refreshes inside a transition", () => {
    expect(code).toMatch(/startTransition\(\s*\(\)\s*=>\s*(\{\s*)?router\.refresh\(\)/);
  });

  // Keyboard focus: a `disabled` button drops focus (HTML focus fixup), and once
  // the refresh settles the count is 0 and the button unmounts, so focus would
  // fall to <body>. The control stays focusable (aria-disabled + early return)
  // and the always-mounted status region takes focus back when it vanishes.
  it("never uses the `disabled` attribute on the button (aria-disabled + early return)", () => {
    expect(code).not.toMatch(/(?<![-\w])disabled\s*=/);
    expect(code).toMatch(/aria-disabled=\{/);
    // Ignored while a refresh runs OR while the automatic retry is waiting.
    expect(code).toMatch(/if\s*\(\s*busy\s*\)\s*return\b/);
    expect(code).toMatch(/const\s+busy\s*=\s*pending\s*\|\|\s*settled\.kind\s*===\s*["']retrying["']/);
  });

  it("hands focus to the status region when the refresh settles, without scrolling", () => {
    expect(code).toMatch(/tabIndex=\{-1\}/);
    expect(code).toMatch(/\.focus\(\s*\{\s*preventScroll:\s*true\s*\}\s*\)/);
    // Only rescue focus that was actually lost; never steal it from another control.
    expect(code).toMatch(/document\.body/);
  });

  it("confirms the refresh in the live region (WCAG 4.1.3)", () => {
    expect(code).toContain("Liste güncellendi");
  });

  // CLS 0: no state may change the region's box. Its className is one static
  // literal (no template, no expression) placed right after tabIndex={-1}, so
  // neither `count`, `pending` nor `updated` can resize or move it.
  it("the region's className is ONE static literal right after tabIndex={-1}", () => {
    const literal = /tabIndex=\{-1\}\s+className="([^"{}$`]*)"\s*>/.exec(code);
    expect(literal).not.toBeNull();
    const tokens = (literal?.[1] ?? "").split(/\s+/).filter(Boolean);
    expect(tokens).toEqual(
      expect.arrayContaining(["absolute", "inset-x-0", "top-full", "h-8"]),
    );
    // The only className on the region element itself.
    const regionTag = /<div\b[^>]*\brole="status"[^>]*>/.exec(code)?.[0] ?? "";
    expect(regionTag.match(/className\s*=/g)).toHaveLength(1);
  });

  it("no className literal carries an mt- margin (a margin would push the list)", () => {
    expect(code).not.toMatch(/className="[^"]*(?<![\w-])mt-/);
  });

  it("the margin guard really matches an mt- token and ignores look-alikes", () => {
    const margin = /className="[^"]*(?<![\w-])mt-/;
    expect('className="mt-4 flex"').toMatch(margin);
    expect('className="flex mt-4"').toMatch(margin);
    expect('className="flex min-h-8 text-xs"').not.toMatch(margin);
    expect('className="flex smt-4"').not.toMatch(margin);
  });
});

// ---------------------------------------------------------------------------
// h76-timeline-1: a click that gets the STALE ISR copy back used to clear the
// count, hide the pill and announce "Liste güncellendi" over an unchanged list.
// The logic is in timeline-head.ts (pageSignature, refreshOutcome); the repo has
// no jsdom, so the component's wiring is pinned with source guards.
// ---------------------------------------------------------------------------

describe("NewClustersPill -- the refresh is verified, not assumed (source guard)", () => {
  const source = readFileSync(
    resolve(__dirname, "new-clusters-pill.tsx"),
    "utf8",
  );
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));

  /** The body of the button's onClick, up to the className that follows it. */
  const handler = /onClick=\{([\s\S]*?)\}\s*className=/.exec(code)?.[1] ?? "";

  it("finds the click handler (so the guards below are not vacuous)", () => {
    expect(handler).toMatch(/startTransition\(/);
    expect(handler).toMatch(/router\.refresh\(\)/);
  });

  it("(a) the click handler no longer clears the count: an unchanged page keeps it", () => {
    expect(handler).not.toMatch(/setHit\s*\(/);
  });

  it("the click snapshots the page signature and starts at attempt 0", () => {
    expect(handler).toMatch(/pageSignature\(/);
    expect(handler).toMatch(/attempt:\s*0/);
  });

  it("(b) imports pageSignature, refreshOutcome and TIMELINE_REFRESH_RETRY_MS from timeline-head", () => {
    const imp = /import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/clusters\/timeline-head["']/.exec(code)?.[1] ?? "";
    expect(imp).toMatch(/\bpageSignature\b/);
    expect(imp).toMatch(/\brefreshOutcome\b/);
    expect(imp).toMatch(/\bTIMELINE_REFRESH_RETRY_MS\b/);
  });

  it("(c) says so when the list did not update: 'Liste henüz güncellenmedi'", () => {
    expect(code).toContain("Liste henüz güncellenmedi");
    expect(code).toContain("tekrar deneyin");
  });

  it("(d) 'Liste güncellendi' is shown from exactly one place, and only for the 'changed' outcome", () => {
    expect(source.match(/Liste güncellendi/g) ?? []).toHaveLength(1);
    expect(code.match(/Liste güncellendi/g) ?? []).toHaveLength(1);
    expect(code).toMatch(/["']changed["']/);
    expect(code).toMatch(/outcome\s*===\s*["']changed["']/);
  });

  it("handles all three outcomes of refreshOutcome", () => {
    expect(code).toMatch(/["']retry["']/);
    expect(code).toMatch(/["']unchanged["']/);
    expect(code).toMatch(/refreshOutcome\(/);
  });

  it("the settled-state compare reads the CURRENT props through pageSignature", () => {
    expect(code).toMatch(/refreshOutcome\([^)]*pageSignature\(\s*newestPublished\s*,\s*knownIds\s*\)/);
  });

  it("the automatic retry waits out a TIMELINE_REFRESH_RETRY_MS deadline, refreshes once more and clears its timer", () => {
    // The wait is pinned as an absolute deadline (react-L1) and the timer is armed
    // with what is LEFT of it, so the constant now sits in the deadline, not in the
    // setTimeout call.
    expect(code).toMatch(/at:\s*\w+\(\)\s*\+\s*TIMELINE_REFRESH_RETRY_MS\b/);
    expect(code).toMatch(/window\.setTimeout\([\s\S]*?,\s*left\s*\)/);
    expect(code).toMatch(/window\.clearTimeout\(/);
    expect(code.match(/router\.refresh\(\)/g) ?? []).toHaveLength(2);
    expect(code).toMatch(/attempt:\s*1/);
  });

  it("keeps the button up as 'Yenileniyor…' (aria-disabled) while it retries", () => {
    expect(code).toContain("Yenileniyor…");
    expect(code).toMatch(/aria-disabled=\{busy\}/);
  });

  it("stays render-pure: no setInterval, no ref read for the outcome, no setState-in-effect body", () => {
    expect(code).not.toMatch(/\bsetInterval\b/);
    // The effect that arms the retry only schedules a timer; its setState calls
    // live in the timer callback.
    const retryEffect =
      /useEffect\(\(\)\s*=>\s*\{\s*if\s*\(settled\.kind\s*!==\s*["']retrying["']\)\s*return;([\s\S]*?)\},\s*\[/.exec(code)?.[1] ?? "";
    expect(retryEffect).not.toBe("");
    expect(retryEffect).toMatch(/window\.setTimeout\(/);
    const outsideTimer = stripCalls(retryEffect, "window.setTimeout");
    expect(outsideTimer).not.toMatch(/\bset[A-Z]\w*\(/);
  });

  it("every status text sits in the one h-8 region as a single text-xs line with literal classes", () => {
    const paragraphs = code.match(/<p\b[^>]*>/g) ?? [];
    expect(paragraphs.length).toBeGreaterThanOrEqual(2);
    for (const tag of paragraphs) {
      expect(tag).toMatch(/className="[^"{}$`]*\btext-xs\b[^"{}$`]*"/);
    }
  });

  it("the longest status text fits a 360 px viewport at text-xs (about 6.5 px a character)", () => {
    const text = /Liste henüz güncellenmedi[^<{"]*/.exec(code)?.[0] ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text.length * 6.5).toBeLessThan(360 - 32);
  });
});

// ---------------------------------------------------------------------------
// react-L1: cacheComponents keeps /timeline mounted in a hidden <Activity> while
// a cluster is open, and React runs effect cleanups on hide and re-runs the
// effects on reveal. The retry timer and the 6 s status timer are cleared on
// hide, but `settled` and `cycle` survive, so a plain re-arm would bring back a
// "Yenileniyor…" button and an unrequested router.refresh() 4 s later (or move
// focus again and repeat the old message for another 6 s). Every settle outcome
// therefore has an identity (seq) and a pinned deadline; a re-run waits only for
// what is left, an expired retry is dropped without refreshing, and focus moves
// on the first run only. No jsdom here, so this is pinned with source guards.
// ---------------------------------------------------------------------------

describe("NewClustersPill -- survives a hidden Activity boundary (react-L1, source guard)", () => {
  const source = readFileSync(
    resolve(__dirname, "new-clusters-pill.tsx"),
    "utf8",
  );
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));

  const COMPARE = "deadline.current?.seq !== ";

  it("the guard helpers find balanced calls and blocks (so the guards below are not vacuous)", () => {
    expect(stripCalls("a(b(c)) x f(1) y", "f")).toBe("a(b(c)) x  y");
    expect(stripCalls("a x(1) b x(2(3)) c", "x")).toBe("a  b  c");
    expect(blockAfter("if (a === null) { go(); { deep } } else { no }", /if\s*\(a\s*===\s*null\)\s*\{/)).toBe(
      " go(); { deep } ",
    );
    expect(blockAfter("nothing here", /if\s*\(/)).toBeNull();
  });

  it("imports remainingMs and PILL_STATUS_MS from timeline-head", () => {
    const imp = /import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/clusters\/timeline-head["']/.exec(code)?.[1] ?? "";
    expect(imp).toMatch(/\bremainingMs\b/);
    expect(imp).toMatch(/\bPILL_STATUS_MS\b/);
    expect(imp).toMatch(/\bTIMELINE_REFRESH_RETRY_MS\b/);
  });

  it("no timer is armed with a fixed delay any more", () => {
    expect(code).not.toContain("}, TIMELINE_REFRESH_RETRY_MS);");
    expect(code).not.toContain("}, 6000);");
    expect(code).not.toMatch(/\b6000\b/);
    expect(code).not.toMatch(/window\.setTimeout\([\s\S]*?,\s*(TIMELINE_REFRESH_RETRY_MS|PILL_STATUS_MS)\s*\)/);
  });

  it("settled carries an identity: { kind, seq }, and every transition bumps seq", () => {
    expect(code).toMatch(/type\s+SettledState\s*=\s*\{\s*kind:\s*Settled;\s*seq:\s*number\s*\}/);
    expect(code).toMatch(/useState<SettledState>\(\s*\{\s*kind:\s*["']none["']\s*,\s*seq:\s*0\s*\}\s*\)/);
    // The three transitions out of a finished refresh, in the render-phase derivation.
    const derivation = /if\s*\(pending\s*!==\s*pendingSeen\)\s*\{([\s\S]*?)\n  \}\n/.exec(code)?.[1] ?? "";
    expect(derivation).not.toBe("");
    for (const kind of ["updated", "retrying", "unchanged"]) {
      expect(derivation).toMatch(
        new RegExp(`setSettled\\(\\s*\\{\\s*kind:\\s*["']${kind}["']\\s*,\\s*seq:\\s*settled\\.seq\\s*\\+\\s*1\\s*\\}\\s*\\)`),
      );
    }
    // No bare string state is left behind.
    expect(code).not.toMatch(/setSettled\(\s*["']/);
    expect(code).not.toMatch(/settled\s*[!=]==\s*["']/);
  });

  it("keeps the deadline in a ref, and the click handler resets it (an event handler may write a ref)", () => {
    expect(code).toMatch(
      /const\s+deadline\s*=\s*useRef<\{\s*seq:\s*number;\s*at:\s*number\s*\}\s*\|\s*null>\(\s*null\s*\)/,
    );
    const handler = /onClick=\{([\s\S]*?)\}\s*className=/.exec(code)?.[1] ?? "";
    expect(handler).toMatch(/deadline\.current\s*=\s*null\s*;/);
  });

  it("the clock is read only inside effects (never while rendering)", () => {
    expect(code).not.toMatch(/Date\.now\(\)[^;\n]*\bsettled\b/);
    // Cut the effects and the click handler out: what is left is the render body.
    const render = stripCalls(code, "useEffect").replace(/onClick=\{[\s\S]*?\}\s*className=/, "className=");
    // The only mention of the clock left is its one-line definition.
    const calls = render.match(/\b(?:Date\.now|readClock)\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(render).toMatch(/const\s+readClock\s*=\s*\(\)\s*=>\s*Date\.now\(\)/);
  });

  // The two effects, cut out by their guard line.
  const retryEffect =
    /useEffect\(\(\)\s*=>\s*\{\s*if\s*\(settled\.kind\s*!==\s*["']retrying["']\)\s*return;([\s\S]*?)\},\s*\[([^\]]*)\]/.exec(code);
  const statusEffect =
    /useEffect\(\(\)\s*=>\s*\{\s*if\s*\(settled\.kind\s*!==\s*["']updated["']\s*&&\s*settled\.kind\s*!==\s*["']unchanged["']\)\s*return;([\s\S]*?)\},\s*\[([^\]]*)\]/.exec(code);

  it("finds both effects (so the guards below are not vacuous)", () => {
    expect(retryEffect?.[1] ?? "").toMatch(/router\.refresh\(\)/);
    expect(statusEffect?.[1] ?? "").toMatch(/setSettled\(/);
  });

  it("both effects re-run on the outcome's identity, not just its kind", () => {
    const deps = (m: RegExpExecArray | null) =>
      (m?.[2] ?? "").split(",").map((d) => d.trim()).filter(Boolean);
    expect(deps(retryEffect)).toEqual(
      expect.arrayContaining(["settled.kind", "settled.seq", "router", "startTransition"]),
    );
    expect(deps(statusEffect)).toEqual(expect.arrayContaining(["settled.kind", "settled.seq"]));
    expect(deps(statusEffect)).not.toContain("settled");
    expect(deps(retryEffect)).not.toContain("settled");
  });

  it("the retry effect pins a deadline once per outcome and re-arms with what is left", () => {
    const body = retryEffect?.[1] ?? "";
    expect(body).toContain(COMPARE);
    expect(body).toMatch(/deadline\.current\s*=\s*\{\s*seq\s*,\s*at:\s*\w+\(\)\s*\+\s*TIMELINE_REFRESH_RETRY_MS\s*\}/);
    expect(body).toMatch(/remainingMs\(\s*deadline\.current\.at\s*,\s*\w+\(\)\s*\)/);
    expect(body).toMatch(/window\.setTimeout\([\s\S]*?,\s*left\s*\)/);
    expect(body).toMatch(/window\.clearTimeout\(/);
  });

  it("an expired retry is dropped: it clears the cycle and settles to none, and never refreshes", () => {
    const body = retryEffect?.[1] ?? "";
    const expired = blockAfter(body, /if\s*\(\s*left\s*===\s*null\s*\)\s*\{/);
    expect(expired).not.toBeNull();
    expect(expired).toMatch(/setCycle\(\s*null\s*\)/);
    expect(expired).toMatch(/setSettled\(\s*\{\s*kind:\s*["']none["']\s*,\s*seq\s*\}\s*\)/);
    expect(expired).not.toMatch(/router\.refresh/);
    expect(expired).not.toMatch(/startTransition/);
    // Its state calls run in a timer callback (delay 0), not in the effect body.
    expect(expired).toMatch(/window\.setTimeout\([\s\S]*,\s*0\s*\)/);
    expect(stripCalls(expired ?? "", "window.setTimeout")).not.toMatch(/\bset[A-Z]\w*\(/);
    expect(expired).toMatch(/return\b/);
  });

  it("the single refresh stays in the live branch of the retry effect", () => {
    const body = retryEffect?.[1] ?? "";
    expect(body.match(/router\.refresh\(\)/g) ?? []).toHaveLength(1);
    const expiredAt = body.search(/if\s*\(\s*left\s*===\s*null\s*\)/);
    expect(expiredAt).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("router.refresh()")).toBeGreaterThan(expiredAt);
  });

  it("the status effect pins a deadline of PILL_STATUS_MS and re-arms with what is left (0 if past)", () => {
    const body = statusEffect?.[1] ?? "";
    expect(body).toContain(COMPARE);
    expect(body).toMatch(/deadline\.current\s*=\s*\{\s*seq\s*,\s*at:\s*\w+\(\)\s*\+\s*PILL_STATUS_MS\s*\}/);
    expect(body).toMatch(/remainingMs\(\s*deadline\.current\.at\s*,\s*\w+\(\)\s*\)\s*\?\?\s*0/);
    expect(body).toMatch(/window\.setTimeout\([\s\S]*?,\s*left\s*\)/);
    expect(body).toMatch(/setSettled\(\s*\{\s*kind:\s*["']none["']\s*,\s*seq\s*\}\s*\)/);
    expect(body).toMatch(/window\.clearTimeout\(/);
  });

  it("focus moves only after a `deadline.current?.seq !== ` comparison, inside its first-run block", () => {
    const focusAt: number[] = [];
    for (let i = code.indexOf(".focus("); i !== -1; i = code.indexOf(".focus(", i + 1)) focusAt.push(i);
    expect(focusAt.length).toBeGreaterThan(0);
    for (const at of focusAt) {
      const compareAt = code.lastIndexOf(COMPARE, at);
      expect(compareAt).toBeGreaterThanOrEqual(0);
      // The focus call sits inside the `{ ... }` of that comparison's `if`.
      const open = code.indexOf("{", compareAt);
      expect(open).toBeGreaterThan(compareAt);
      const close = closeOf(code, open);
      expect(open).toBeLessThan(at);
      expect(close).toBeGreaterThan(at);
    }
    // And that block is the status effect's, not the retry effect's.
    expect(statusEffect?.[1] ?? "").toContain(".focus(");
    expect(retryEffect?.[1] ?? "").not.toContain(".focus(");
  });

  it("focus is not moved by the re-arm path: it runs before the remaining-time read", () => {
    const body = statusEffect?.[1] ?? "";
    expect(body.indexOf(".focus(")).toBeLessThan(body.indexOf("remainingMs("));
    // The block that moves focus is closed before the re-arm.
    const block = blockAfter(body, /if\s*\(\s*deadline\.current\?\.seq\s*!==\s*seq\s*\)\s*\{/) ?? "";
    expect(block).toContain(".focus(");
    expect(block).not.toMatch(/window\.setTimeout/);
  });
});

// ---------------------------------------------------------------------------
// h103-timeline-1: the pill used to skip every unknown head row older than the
// page's newest row, but a cluster becomes visible when its SECOND source is
// ingested (median 39 min after first_published), so about half of all new
// clusters landed below the newest row and appeared silently. The count now uses
// a floor at the page's 50th row (`floorPublished`), and the poll result is keyed
// by the page signature so a refresh that only inserts late rows cannot keep an
// old count. The counting itself is tested in timeline-head.test.ts; no jsdom
// here, so the wiring is pinned with source guards.
// ---------------------------------------------------------------------------

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

describe("NewClustersPill -- counts against the page's 50th row, not its newest (h103-timeline-1, source guard)", () => {
  const code = stripComments(
    readFileSync(resolve(__dirname, "new-clusters-pill.tsx"), "utf8"),
  );
  const pageCode = stripComments(
    readFileSync(resolve(__dirname, "../../app/timeline/page.tsx"), "utf8"),
  );

  /** The call `countNewClusters( ... )` inside the poller's onRows. */
  const countCall = (() => {
    const at = code.indexOf("countNewClusters(");
    if (at === -1) return "";
    const end = closeOf(code, at + "countNewClusters".length);
    return end === -1 ? "" : code.slice(at, end + 1);
  })();

  it("finds the countNewClusters call (so the guards below are not vacuous)", () => {
    expect(countCall).not.toBe("");
    expect(countCall).toMatch(/knownIds/);
  });

  it("the pill takes a floorPublished prop: string | null", () => {
    expect(code).toMatch(/floorPublished:\s*string\s*\|\s*null\s*;/);
    // Destructured from the props, next to the other two.
    expect(code).toMatch(
      /export function NewClustersPill\(\{[^}]*\bfloorPublished\b[^}]*\}: NewClustersPillProps\)/,
    );
  });

  it("holds floorPublished in the `latest` ref the poller reads", () => {
    const refInit = /const latest = useRef\(\{([^}]*)\}\)/.exec(code)?.[1] ?? "";
    expect(refInit).toMatch(/\bfloorPublished\b/);
    expect(refInit).toMatch(/\bnewestPublished\b/);
    expect(refInit).toMatch(/\bknownIds\b/);
    const assign = /latest\.current\s*=\s*\{([^}]*)\}/.exec(code)?.[1] ?? "";
    expect(assign).toMatch(/\bfloorPublished\b/);
  });

  it("passes floorPublished (not newestPublished) to countNewClusters", () => {
    expect(countCall).toMatch(/\bfloorPublished\b/);
    expect(countCall).not.toMatch(/\bnewestPublished\b/);
    expect(countCall).not.toMatch(/\bnewest\b/);
  });

  it("Hit carries the page signature: { sig: string; count: number }", () => {
    expect(code).toMatch(/type\s+Hit\s*=\s*\{\s*sig:\s*string;\s*count:\s*number\s*\}/);
    expect(code).not.toMatch(/\bhit\.newest\b/);
    expect(code).not.toMatch(/\bprev\.newest\b/);
  });

  it("the poll result is stamped with pageSignature of the props it was counted against", () => {
    const onRows = /onRows:\s*\(rows\)\s*=>\s*\{([\s\S]*?)\n\s{6}\},/.exec(code)?.[1] ?? "";
    expect(onRows).not.toBe("");
    expect(onRows).toMatch(/pageSignature\(/);
    expect(onRows).toMatch(/setHit\(/);
    expect(onRows).toMatch(/\bsig\b/);
  });

  it("the visible count compares hit.sig with pageSignature(newestPublished, knownIds)", () => {
    expect(code).toMatch(
      /const count =\s*hit !== null && hit\.sig === pageSignature\(\s*newestPublished\s*,\s*knownIds\s*\)\s*\?\s*hit\.count\s*:\s*0/,
    );
  });

  // page.tsx -----------------------------------------------------------------

  const pillElement = /<NewClustersPill\b([\s\S]*?)\/>/.exec(pageCode)?.[1] ?? "";

  it("finds the <NewClustersPill> element in page.tsx", () => {
    expect(pillElement).not.toBe("");
    expect(pillElement).toMatch(/newestPublished=/);
    expect(pillElement).toMatch(/knownIds=/);
  });

  it("page.tsx passes floorPublished derived from rows[TIMELINE_HEAD_LIMIT - 1], null for a shorter page", () => {
    expect(pillElement).toMatch(
      /floorPublished=\{\s*rows\[\s*TIMELINE_HEAD_LIMIT\s*-\s*1\s*\]\?\.first_published\s*\?\?\s*null\s*\}/,
    );
  });

  it("page.tsx still passes the first TIMELINE_HEAD_LIMIT ids and the newest row, and never all 200 ids", () => {
    expect(pillElement).toMatch(/knownIds=\{\s*rows\.slice\(\s*0\s*,\s*TIMELINE_HEAD_LIMIT\s*\)/);
    expect(pillElement).toMatch(/newestPublished=\{\s*rows\[0\]\?\.first_published\s*\?\?\s*null\s*\}/);
  });

  it("the floor expression yields the 50th row's first_published, and null below 50 rows", () => {
    // The expression as page.tsx writes it, evaluated on arrays of both sizes.
    const expr = /floorPublished=\{([^}]*)\}/.exec(pillElement)?.[1] ?? "";
    expect(expr).not.toBe("");
    const evaluate = new Function(
      "rows",
      "TIMELINE_HEAD_LIMIT",
      `return ${expr};`,
    ) as (rows: Array<{ first_published: string }>, limit: number) => string | null;
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ first_published: `t${i}` }));
    expect(evaluate(mk(200), 50)).toBe("t49");
    expect(evaluate(mk(50), 50)).toBe("t49");
    expect(evaluate(mk(49), 50)).toBeNull();
    expect(evaluate(mk(0), 50)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// h201-timeline-1: a first reader can be served a day-old cached list under "Son 24 saat", and the pill's first
// poll came a full TIMELINE_POLL_MS (120 s) after mount. On mount the pill now compares the newest shown row with
// the client clock and, when the list is older than STALE_LIST_PROBE_MS, probes /api/timeline/head at once. The
// decision (isListStale) and the one-shot probe (startStaleProbe) take every side effect as a dependency, so they
// are tested here with fakes; the wiring into the effect is pinned with source guards below.
// ---------------------------------------------------------------------------

describe("isListStale", () => {
  const NOW = Date.UTC(2026, 10, 17, 16, 57, 0);
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const MIN = 60_000;

  it("the threshold is 15 minutes", () => {
    expect(STALE_LIST_PROBE_MS).toBe(15 * MIN);
  });

  it("is true for a list whose newest row is a day old (the observed 30 h copy too)", () => {
    expect(isListStale(ago(24 * 60 * MIN), NOW)).toBe(true);
    expect(isListStale(ago(30 * 60 * MIN), NOW)).toBe(true);
  });

  it("is true just past the threshold and false at or below it", () => {
    expect(isListStale(ago(STALE_LIST_PROBE_MS + 1), NOW)).toBe(true);
    expect(isListStale(ago(STALE_LIST_PROBE_MS), NOW)).toBe(false);
    expect(isListStale(ago(STALE_LIST_PROBE_MS - 1), NOW)).toBe(false);
    expect(isListStale(ago(0), NOW)).toBe(false);
  });

  it("is false for a newest row in the future (a client clock that runs behind)", () => {
    expect(isListStale(ago(-10 * MIN), NOW)).toBe(false);
  });

  it("an empty page (null) has nothing to trust, so it is stale", () => {
    expect(isListStale(null, NOW)).toBe(true);
  });

  it.each(["", "not a date", "2026-13-45"])("an unparseable newest %j is not judged (false), the poller covers it", (bad) => {
    expect(isListStale(bad, NOW)).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("a non-finite clock reading (%s) is not judged", (bad) => {
    expect(isListStale(ago(24 * 60 * MIN), bad)).toBe(false);
    expect(isListStale(null, bad)).toBe(false);
  });
});

describe("startStaleProbe", () => {
  const NOW = Date.UTC(2026, 10, 17, 16, 57, 0);
  const STALE = new Date(NOW - 30 * 60 * 60_000).toISOString();
  const FRESH = new Date(NOW - 60_000).toISOString();
  const ROWS: TimelineHeadRow[] = [{ id: "c1", first_published: new Date(NOW - 5 * 60_000).toISOString() }];

  function setup(opts: { visible?: boolean; result?: () => Promise<HeadFetchResult> } = {}) {
    let visible = opts.visible ?? true;
    let clock = NOW;
    const visibilityListeners = new Set<() => void>();
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const signals: AbortSignal[] = [];
    const fetchHead = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return (opts.result ?? (() => Promise.resolve<HeadFetchResult>({ ok: true, rows: ROWS })))();
    });
    const onRows = vi.fn();
    const deps = {
      fetchHead,
      onRows,
      isVisible: () => visible,
      subscribeVisibility: (cb: () => void) => {
        visibilityListeners.add(cb);
        return () => visibilityListeners.delete(cb);
      },
      now: () => clock,
      // Only startHeadPolling uses these two (the poller shares this object in the double-fetch tests).
      setTimer: (fn: () => void) => {
        const id = nextTimer++;
        timers.set(id, fn);
        return id;
      },
      clearTimer: (handle: unknown) => {
        timers.delete(handle as number);
      },
    };
    return {
      deps,
      fetchHead,
      onRows,
      signals,
      visibilityListeners,
      timers,
      advance(ms: number) {
        clock += ms;
      },
      setVisible(v: boolean) {
        visible = v;
        for (const cb of [...visibilityListeners]) cb();
      },
    };
  }

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("a stale list in a visible tab fetches the head at once, with an abort signal, and hands the rows over", async () => {
    const t = setup();
    startStaleProbe(t.deps, STALE);
    expect(t.fetchHead).toHaveBeenCalledTimes(1); // immediately, not after TIMELINE_POLL_MS
    expect(t.signals[0]).toBeInstanceOf(AbortSignal);
    await flush();
    expect(t.onRows).toHaveBeenCalledTimes(1);
    expect(t.onRows).toHaveBeenCalledWith(ROWS);
  });

  it("an empty page is probed at once as well", async () => {
    const t = setup();
    startStaleProbe(t.deps, null);
    expect(t.fetchHead).toHaveBeenCalledTimes(1);
    await flush();
    expect(t.onRows).toHaveBeenCalledWith(ROWS);
  });

  it("a fresh list is left to the poller: no fetch and no visibility subscription", () => {
    const t = setup();
    const stop = startStaleProbe(t.deps, FRESH);
    expect(t.fetchHead).not.toHaveBeenCalled();
    expect(t.visibilityListeners.size).toBe(0);
    expect(() => stop()).not.toThrow();
  });

  it("a hidden tab never fetches; the first time it turns visible the probe runs, once", async () => {
    const t = setup({ visible: false });
    startStaleProbe(t.deps, STALE);
    expect(t.fetchHead).not.toHaveBeenCalled();
    expect(t.visibilityListeners.size).toBe(1);

    t.setVisible(false); // another change event while still hidden
    expect(t.fetchHead).not.toHaveBeenCalled();

    t.setVisible(true);
    expect(t.fetchHead).toHaveBeenCalledTimes(1);
    expect(t.visibilityListeners.size).toBe(0); // done waiting
    await flush();
    expect(t.onRows).toHaveBeenCalledWith(ROWS);

    t.setVisible(false);
    t.setVisible(true);
    expect(t.fetchHead).toHaveBeenCalledTimes(1); // one probe per start
  });

  it("a non-ok answer or a rejection hands nothing over and does not throw", async () => {
    const bad = setup({ result: () => Promise.resolve<HeadFetchResult>({ ok: false, retryAfterMs: 5000 }) });
    startStaleProbe(bad.deps, STALE);
    const rejected = setup({ result: () => Promise.reject(new TypeError("offline")) });
    startStaleProbe(rejected.deps, STALE);
    await flush();
    expect(bad.fetchHead).toHaveBeenCalledTimes(1);
    expect(rejected.fetchHead).toHaveBeenCalledTimes(1);
    expect(bad.onRows).not.toHaveBeenCalled();
    expect(rejected.onRows).not.toHaveBeenCalled();
  });

  it("a throwing onRows is swallowed (no unhandled rejection)", async () => {
    const t = setup();
    t.onRows.mockImplementation(() => {
      throw new Error("consumer bug");
    });
    startStaleProbe(t.deps, STALE);
    await flush();
    expect(t.onRows).toHaveBeenCalledTimes(1);
  });

  it("stop() aborts the request in flight and drops its result", async () => {
    let resolve: (r: HeadFetchResult) => void = () => {};
    const t = setup({ result: () => new Promise<HeadFetchResult>((r) => (resolve = r)) });
    const stop = startStaleProbe(t.deps, STALE);
    expect(t.signals[0]?.aborted).toBe(false);
    stop();
    expect(t.signals[0]?.aborted).toBe(true);
    resolve({ ok: true, rows: ROWS });
    await flush();
    expect(t.onRows).not.toHaveBeenCalled();
  });

  it("stop() while still waiting for the tab to show unsubscribes and never fetches", () => {
    const t = setup({ visible: false });
    const stop = startStaleProbe(t.deps, STALE);
    expect(t.visibilityListeners.size).toBe(1);
    stop();
    expect(t.visibilityListeners.size).toBe(0);
    t.setVisible(true);
    expect(t.fetchHead).not.toHaveBeenCalled();
  });

  it("stop() is idempotent", () => {
    const t = setup();
    const stop = startStaleProbe(t.deps, STALE);
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
  });

  // A tab that is hidden at mount: the poller counts mount as its last attempt, so a reveal after
  // TIMELINE_POLL_MS polls at once (its catch-up poll), and the deferred probe gives way to it.
  describe("a deferred probe gives way to the poller's catch-up poll", () => {
    it("a reveal after 3 min: the probe does not fetch and stops listening", () => {
      const t = setup({ visible: false });
      startStaleProbe(t.deps, STALE);
      t.advance(3 * 60_000);
      t.setVisible(true);
      expect(t.fetchHead).not.toHaveBeenCalled();
      expect(t.visibilityListeners.size).toBe(0);
      t.setVisible(false);
      t.setVisible(true);
      expect(t.fetchHead).not.toHaveBeenCalled(); // and it never wakes up again
    });

    it("a reveal after 30 s: the poller has nothing due, so the probe fetches, once", () => {
      const t = setup({ visible: false });
      startStaleProbe(t.deps, STALE);
      t.advance(30_000);
      t.setVisible(true);
      expect(t.fetchHead).toHaveBeenCalledTimes(1);
      expect(t.visibilityListeners.size).toBe(0);
    });

    it("the cut is the poller's own first delay: one ms short of it the probe still fetches", () => {
      const early = setup({ visible: false });
      startStaleProbe(early.deps, STALE);
      early.advance(TIMELINE_POLL_MS - 1);
      early.setVisible(true);
      expect(early.fetchHead).toHaveBeenCalledTimes(1);

      const due = setup({ visible: false });
      startStaleProbe(due.deps, STALE);
      due.advance(TIMELINE_POLL_MS);
      due.setVisible(true);
      expect(due.fetchHead).not.toHaveBeenCalled();
    });

    it("a visible mount is unaffected: the probe fetches at once whatever the clock says", () => {
      const t = setup();
      startStaleProbe(t.deps, STALE);
      expect(t.fetchHead).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["a reveal after 3 min", 3 * 60_000],
      ["a reveal after 30 s", 30_000],
      ["a reveal exactly at the poll interval", TIMELINE_POLL_MS],
    ])("poller and probe on one shared deps object, %s: exactly one fetch", (_name, hiddenMs) => {
      const t = setup({ visible: false });
      const stopPolling = startHeadPolling(t.deps);
      const stopProbe = startStaleProbe(t.deps, STALE);
      expect(t.fetchHead).not.toHaveBeenCalled(); // hidden: neither fetches
      t.advance(hiddenMs);
      t.setVisible(true); // ONE visibilitychange
      expect(t.fetchHead).toHaveBeenCalledTimes(1);
      stopProbe();
      stopPolling();
    });

    it("the order the two subscribed in does not matter: still exactly one fetch", () => {
      for (const hiddenMs of [30_000, 3 * 60_000]) {
        const t = setup({ visible: false });
        const stopProbe = startStaleProbe(t.deps, STALE);
        const stopPolling = startHeadPolling(t.deps);
        t.advance(hiddenMs);
        t.setVisible(true);
        expect(t.fetchHead, `${hiddenMs} ms`).toHaveBeenCalledTimes(1);
        stopProbe();
        stopPolling();
      }
    });
  });
});

describe("NewClustersPill -- probes a stale list on mount (h201-timeline-1, source guard)", () => {
  const source = readFileSync(resolve(__dirname, "new-clusters-pill.tsx"), "utf8");
  const code = stripComments(source);

  /** The poller effect: from `useEffect(() => {` that builds the head poller up to its `}, []);`. */
  const pollerEffect = /useEffect\(\(\)\s*=>\s*\{\s*const deps[^=]*=\s*\{([\s\S]*?)\n  \}, \[\]\);/.exec(code)?.[1] ?? "";

  it("finds the poller effect (so the guards below are not vacuous)", () => {
    expect(pollerEffect).not.toBe("");
    expect(pollerEffect).toMatch(/startHeadPolling\(\s*deps\s*\)/);
  });

  it("starts the probe in that same effect, from the same deps (one onRows, one fetch), judged against the page's newest row", () => {
    expect(pollerEffect).toMatch(/startStaleProbe\(\s*deps\s*,\s*latest\.current\.newestPublished\s*\)/);
  });

  it("stops both the probe and the poller on cleanup", () => {
    const cleanup = /return\s*\(\)\s*=>\s*\{([^}]*)\}/.exec(pollerEffect)?.[1] ?? "";
    expect(cleanup).toMatch(/stopProbe\(\)/);
    expect(cleanup).toMatch(/stopPolling\(\)/);
  });

  it("the probe reads the clock only through the injected readClock dependency", () => {
    expect(pollerEffect).toMatch(/now:\s*readClock\b/);
    expect(code.match(/Date\.now/g) ?? []).toHaveLength(1);
  });

  it("adds no refresh path: the probe only feeds the count, the click still owns router.refresh()", () => {
    const probe = /export function startStaleProbe[\s\S]*?\n\}\n/.exec(code)?.[0] ?? "";
    expect(probe).not.toBe("");
    expect(probe).not.toMatch(/router|refresh|startTransition/);
    expect(code.match(/router\.refresh\(\)/g) ?? []).toHaveLength(2);
  });

  it("changes no caching config: the head URL keeps its constant, query-free key", () => {
    expect(code.match(/\/api\/timeline\/head/g) ?? []).toHaveLength(1);
    expect(code).not.toMatch(/\/api\/timeline\/head\?/);
  });
});
