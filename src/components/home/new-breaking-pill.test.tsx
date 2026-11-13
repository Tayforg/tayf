import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRef, type ComponentProps, type DependencyList, type EffectCallback } from "react";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { renderToStaticMarkup } from "react-dom/server";

import { blankComments } from "../../../tests/_helpers/blank-comments";

// ---------------------------------------------------------------------------
// h170-roadmap-2: the home page's "N yeni son dakika haberi · Yenile" pill.
//
// The repo has no DOM test environment, so this file works like
// new-clusters-pill.test.tsx (the /timeline pill it mirrors) in three layers:
//   1. what the server renders: ONE empty, always-mounted status region (the
//      count is 0 until the poller has run in an effect);
//   2. the region's states, through its presentational half (BreakingPillRegion),
//      rendered with react-dom/server;
//   3. the real component with react's useEffect run synchronously (the house
//      pattern of page-last-visit.test.tsx) against fake timers, a fake tab and a
//      fake fetch: the first poll after 120 s and never on mount, no poll while
//      hidden, backoff on a 503;
// plus source guards for what a static render cannot show (the click wiring, the
// literal class names, the outcome timers).
// The counting itself is tested in src/lib/clusters/home-head.test.ts.
// ---------------------------------------------------------------------------

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const effects = vi.hoisted(() => ({ run: false, cleanups: [] as Array<() => void> }));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return {
    ...actual,
    // renderToStaticMarkup never runs effects: when asked, run the body at once and keep its cleanup.
    useEffect: (fn: EffectCallback, deps?: DependencyList): void => {
      if (effects.run) {
        const cleanup = fn();
        if (typeof cleanup === "function") effects.cleanups.push(cleanup);
      } else {
        actual.useEffect(fn, deps);
      }
    },
  };
});

import { BreakingPillRegion, NewBreakingPill } from "./new-breaking-pill";

const SPEC_WRAPPER_TOKENS = [
  "fixed",
  "inset-x-0",
  "bottom-[max(1rem,env(safe-area-inset-bottom))]",
  "z-40",
  "flex",
  "justify-center",
  "pointer-events-none",
];

/** The class tokens of the first element whose opening tag carries `attr` (e.g. `role="status"`). */
function tokensOfTag(markup: string, attr: string): string[] {
  const at = markup.indexOf(attr);
  if (at === -1) return [];
  const open = markup.lastIndexOf("<", at);
  const close = markup.indexOf(">", at);
  const tag = markup.slice(open, close + 1);
  const classAt = tag.indexOf('class="');
  if (classAt === -1) return [];
  const end = tag.indexOf('"', classAt + 7);
  return tag
    .slice(classAt + 7, end)
    .split(" ")
    .filter(Boolean);
}

function region(props: Partial<ComponentProps<typeof BreakingPillRegion>> = {}) {
  return renderToStaticMarkup(
    <BreakingPillRegion
      regionRef={createRef<HTMLDivElement>()}
      count={0}
      busy={false}
      outcome="none"
      onClick={() => {}}
      {...props}
    />,
  );
}

// ---------------------------------------------------------------------------
// 1. Server render
// ---------------------------------------------------------------------------

describe("NewBreakingPill -- server render", () => {
  const markup = renderToStaticMarkup(<NewBreakingPill knownIds={["a", "b"]} />);

  it("renders a polite status live region, mounted and empty (WCAG 4.1.3)", () => {
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup.startsWith("<div ")).toBe(true);
    expect(markup.endsWith("></div>")).toBe(true);
    expect(markup.split("<").length - 1).toBe(2); // the opening and the closing tag, nothing inside
  });

  it("makes the region a programmatic focus target (tabindex -1), not a tab stop", () => {
    expect(markup).toContain('tabindex="-1"');
  });

  it("renders no button, no count and no outcome text", () => {
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("yeni son dakika");
    expect(markup).not.toContain("Yenile");
    expect(markup).not.toContain("Liste");
  });

  it("is the same empty region whatever the page knows (hydration-safe)", () => {
    expect(renderToStaticMarkup(<NewBreakingPill knownIds={[]} />)).toBe(
      renderToStaticMarkup(<NewBreakingPill knownIds={["x", "y", "z"]} />),
    );
  });

  // CLS 0: the region is out of flow, so no state of the pill can move the page.
  it("sits out of flow: fixed, full width, safe-area aware, above the page, click-through", () => {
    const tokens = tokensOfTag(markup, 'role="status"');
    for (const token of SPEC_WRAPPER_TOKENS) expect(tokens, token).toContain(token);
    for (const flow of ["relative", "absolute", "static", "sticky", "block", "h-8"]) {
      expect(tokens, flow).not.toContain(flow);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The region's states
// ---------------------------------------------------------------------------

describe("BreakingPillRegion -- states", () => {
  it("count 0, nothing settled: an empty but mounted status region", () => {
    const html = region();
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<p");
  });

  it("count 1: the button, named by its visible text, and only that", () => {
    const html = region({ count: 1 });
    expect(html).toContain("<button");
    expect(html).toContain("1 yeni son dakika haberi · Yenile");
    expect(html).not.toContain("aria-label");
    expect(html).toContain('aria-disabled="false"');
    expect(html).toContain('type="button"');
  });

  it("count 3 names the count", () => {
    expect(region({ count: 3 })).toContain("3 yeni son dakika haberi · Yenile");
  });

  it("the button is a 44 px target on a phone, 32 px from sm up, round, and takes the clicks the wrapper ignores", () => {
    const tokens = tokensOfTag(region({ count: 2 }), "<button");
    for (const token of ["pointer-events-auto", "min-h-11", "sm:min-h-8", "rounded-full", "bg-primary", "text-primary-foreground"]) {
      expect(tokens, token).toContain(token);
    }
  });

  it("busy: 'Yenileniyor…' and aria-disabled, with or without a count (the retry wait keeps the button up)", () => {
    for (const count of [0, 2]) {
      const html = region({ count, busy: true });
      expect(html).toContain("Yenileniyor…");
      expect(html).toContain('aria-disabled="true"');
      expect(html).not.toContain("yeni son dakika");
      expect(html).not.toContain(" disabled");
    }
  });

  it("'updated': the confirmation, in the live region", () => {
    const html = region({ outcome: "updated" });
    expect(html).toContain("Liste güncellendi");
    expect(html).not.toContain("<button");
  });

  it("'unchanged': says so, instead of the button, even though the count is still up", () => {
    const html = region({ outcome: "unchanged", count: 2 });
    expect(html).toContain("Liste henüz güncellenmedi, tekrar deneyin");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Liste güncellendi");
  });

  it("the outcome text of an unchanged page is never the confirmation, and 'updated' never shows the button back", () => {
    expect(region({ outcome: "unchanged" })).not.toContain("Liste güncellendi");
    expect(region({ outcome: "updated", count: 0 })).not.toContain("<button");
  });

  it("every state keeps the one region wrapper with the spec's class tokens", () => {
    for (const props of [{}, { count: 3 }, { busy: true }, { outcome: "updated" as const }, { outcome: "unchanged" as const }]) {
      const tokens = tokensOfTag(region(props), 'role="status"');
      for (const token of SPEC_WRAPPER_TOKENS) expect(tokens, `${JSON.stringify(props)} ${token}`).toContain(token);
    }
  });

  it("the wrapper's class list is the same in every state (no state can resize or move it)", () => {
    const base = tokensOfTag(region(), 'role="status"').join(" ");
    for (const props of [{ count: 3 }, { busy: true }, { outcome: "updated" as const }, { outcome: "unchanged" as const }]) {
      expect(tokensOfTag(region(props), 'role="status"').join(" ")).toBe(base);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The poller, through the real component
// ---------------------------------------------------------------------------

describe("NewBreakingPill -- polling", () => {
  let visibility: "visible" | "hidden";
  let visibilityListeners: Set<() => void>;
  let fetchTimes: number[];
  let fetchUrls: unknown[];
  let started: number;
  let replies: Array<{ ok: boolean; retryAfter?: string; body?: unknown }>;

  const fetchMock = vi.fn((url: unknown) => {
    fetchTimes.push(Date.now() - started);
    fetchUrls.push(url);
    const next = replies.shift() ?? { ok: true, body: { breaking: [] } };
    return Promise.resolve({
      ok: next.ok,
      headers: { get: (name: string) => (name === "Retry-After" ? (next.retryAfter ?? null) : null) },
      json: () => Promise.resolve(next.body ?? { breaking: [] }),
    });
  });

  /** Renders the pill with every effect run at once: the poller starts, as it does after hydration. */
  function mount(knownIds: string[] = ["a"]): void {
    effects.run = true;
    try {
      renderToStaticMarkup(<NewBreakingPill knownIds={knownIds} />);
    } finally {
      effects.run = false;
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 13, 9, 0, 0));
    started = Date.now();
    visibility = "visible";
    visibilityListeners = new Set();
    fetchTimes = [];
    fetchUrls = [];
    replies = [];
    effects.cleanups.length = 0;
    fetchMock.mockClear();
    refresh.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (_type: string, cb: () => void) => visibilityListeners.add(cb),
      removeEventListener: (_type: string, cb: () => void) => visibilityListeners.delete(cb),
      activeElement: null,
      body: {},
    });
    vi.stubGlobal("window", {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    });
  });

  afterEach(() => {
    for (const cleanup of effects.cleanups) cleanup();
    effects.cleanups.length = 0;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("the harness runs the poller: it subscribes to the tab's visibility on mount", () => {
    mount();
    expect(visibilityListeners.size).toBe(1);
    expect(effects.cleanups.length).toBeGreaterThan(0);
  });

  it("never polls on mount: the first request comes after 120 s", async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchTimes).toEqual([120_000]);
  });

  it("asks /api/home/head and nothing else, with no query string (the CDN key stays constant)", async () => {
    mount();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchUrls.length).toBeGreaterThan(0);
    for (const url of fetchUrls) expect(url).toBe("/api/home/head");
  });

  it("one request per 120 s while visible: ten minutes is five requests", async () => {
    mount();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchTimes).toEqual([120_000, 240_000, 360_000, 480_000, 600_000]);
  });

  it("a hidden tab never polls", async () => {
    visibility = "hidden";
    mount();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("going hidden stops the polling, and coming back after the gap polls once at once, then every 120 s", async () => {
    mount();
    await vi.advanceTimersByTimeAsync(130_000);
    expect(fetchTimes).toEqual([120_000]);
    visibility = "hidden";
    for (const cb of [...visibilityListeners]) cb();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchTimes).toEqual([120_000]);
    visibility = "visible";
    for (const cb of [...visibilityListeners]) cb();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchTimes).toEqual([120_000, 430_000]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchTimes).toEqual([120_000, 430_000, 550_000]);
  });

  it("backs off after a 503: 240 s, then 480 s, and a success goes back to 120 s", async () => {
    replies = [{ ok: false }, { ok: false }, { ok: true }, { ok: true }];
    mount();
    await vi.advanceTimersByTimeAsync(120_000 + 240_000 + 480_000 + 120_000);
    expect(fetchTimes).toEqual([120_000, 360_000, 840_000, 960_000]);
  });

  it("a 503 with Retry-After longer than the backoff waits for it", async () => {
    replies = [{ ok: false, retryAfter: "300" }];
    mount();
    await vi.advanceTimersByTimeAsync(120_000 + 300_000);
    expect(fetchTimes).toEqual([120_000, 420_000]);
  });

  it("never refreshes on its own: a poll that finds a new story only offers the button", async () => {
    replies = [{ ok: true, body: { breaking: [{ id: "new", first_published: "2026-11-13T08:55:00.000Z" }] } }];
    mount(["a"]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("unmounting stops it: no request after the cleanup, and the tab listener is gone", async () => {
    mount();
    await vi.advanceTimersByTimeAsync(130_000);
    expect(fetchTimes).toEqual([120_000]);
    for (const cleanup of effects.cleanups) cleanup();
    expect(visibilityListeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchTimes).toEqual([120_000]);
  });
});

// Source-guard helpers: balanced-bracket scans, never a regex over the source.

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

/** Every `name( ... )` call in `text`, as its source text. */
function callsOf(text: string, name: string): string[] {
  const out: string[] = [];
  for (let at = text.indexOf(`${name}(`); at !== -1; at = text.indexOf(`${name}(`, at + 1)) {
    const end = closeOf(text, at + name.length);
    if (end === -1) break;
    out.push(text.slice(at, end + 1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Source guards
// ---------------------------------------------------------------------------

describe("NewBreakingPill -- source guard", () => {
  const source = readFileSync(resolve(__dirname, "new-breaking-pill.tsx"), "utf8");
  // Comments blanked (by a character scan) so prose cannot trip or satisfy a check.
  const code = blankComments(source);

  const importList = (from: string): string[] => {
    const at = code.indexOf(`from "${from}"`);
    if (at === -1) return [];
    const open = code.lastIndexOf("{", at);
    const close = code.indexOf("}", open);
    return code
      .slice(open + 1, close)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  };

  it("the guard helpers find balanced calls (so the guards below are not vacuous)", () => {
    expect(callsOf("a(b(c)) x f(1) y f(2(3))", "f")).toEqual(["f(1)", "f(2(3))"]);
    expect(callsOf("nothing here", "f")).toEqual([]);
    expect(importList("@/lib/clusters/timeline-head").length).toBeGreaterThan(0);
  });

  it("is a client component that refreshes through the router and polls via startHeadPolling", () => {
    expect(source.trimStart().startsWith('"use client"')).toBe(true);
    expect(code).toMatch(/router\.refresh\(\)/);
    expect(code).toMatch(/startHeadPolling\s*\(/);
  });

  it("shares timeline-head.ts: the poller, the refresh verdict, the signature and the timers", () => {
    const names = importList("@/lib/clusters/timeline-head");
    for (const name of [
      "startHeadPolling",
      "refreshOutcome",
      "pageSignature",
      "remainingMs",
      "PILL_STATUS_MS",
      "TIMELINE_REFRESH_RETRY_MS",
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it("takes the count, the label and the request from home-head.ts", () => {
    const names = importList("@/lib/clusters/home-head");
    for (const name of ["countNewBreaking", "fetchHomeHead", "newBreakingLabel"]) {
      expect(names, name).toContain(name);
    }
    expect(code).toMatch(/fetchHead:\s*\(\s*signal\s*\)\s*=>\s*fetchHomeHead\(\s*signal\s*\)/);
  });

  it("owns no URL and no fetch (the endpoint lives in home-head.ts, one constant)", () => {
    expect(code).not.toMatch(/\/api\//);
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it("pulls in nothing server-side (the chunk stays tiny: timeline-head and home-head only)", () => {
    expect(code).not.toMatch(/politics-query|timeline-query|supabase|next\/cache|server-only|date-fns|lucide/);
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

  it("never uses the `disabled` attribute on the button (aria-disabled + early return keep keyboard focus)", () => {
    expect(code).not.toMatch(/(?<![-\w])disabled\s*=/);
    expect(code).toMatch(/aria-disabled=\{/);
    expect(code).toMatch(/if\s*\(\s*busy\s*\)\s*return\b/);
    expect(code).toMatch(/const\s+busy\s*=\s*pending\s*\|\|\s*settled\.kind\s*===\s*["']retrying["']/);
  });

  it("refreshes inside a transition, from the click and from the one automatic retry only", () => {
    const refreshes = code.match(/router\.refresh\(\)/g) ?? [];
    expect(refreshes).toHaveLength(2);
    const transitions = callsOf(code, "startTransition").filter((c) => c.includes("router.refresh()"));
    expect(transitions).toHaveLength(2);
  });

  it("hands focus to the status region when the outcome text replaces the button, without scrolling", () => {
    expect(code).toMatch(/tabIndex=\{-1\}/);
    expect(code).toMatch(/\.focus\(\s*\{\s*preventScroll:\s*true\s*\}\s*\)/);
    expect(code).toMatch(/document\.body/);
  });

  it("confirms the refresh only when the page really changed, and says so when it did not", () => {
    expect(code.match(/Liste güncellendi/g) ?? []).toHaveLength(1);
    expect(code).toContain("Liste henüz güncellenmedi");
    expect(code).toContain("tekrar deneyin");
    expect(code).toMatch(/outcome\s*===\s*["']changed["']/);
    expect(code).toMatch(/["']retry["']/);
    expect(code).toMatch(/refreshOutcome\(/);
    expect(code).toContain("Yenileniyor…");
  });

  it("fingerprints the page by the ids it knows, with no newest row (the props are ids only)", () => {
    expect(code).toMatch(/pageSignature\(\s*null\s*,\s*\w+\s*\)/);
    expect(code).toMatch(/hit\.sig\s*===\s*signatureOf\(\s*knownIds\s*\)/);
    expect(code).toMatch(/knownIds:\s*string\[\]\s*;/);
  });

  it("counts a poll against the latest props through a ref, so a refresh does not restart the poller", () => {
    expect(code).toMatch(/const latest = useRef\(\{\s*knownIds\s*\}\)/);
    const onRows = callsOf(code, "countNewBreaking");
    expect(onRows).toHaveLength(1);
    expect(onRows[0]).toMatch(/new Set\(/);
    // The poller effect has no dependencies: it starts once.
    const pollerEffect = callsOf(code, "useEffect").find((c) => c.includes("startHeadPolling("));
    expect(pollerEffect).toBeDefined();
    expect((pollerEffect ?? "").trimEnd().endsWith("}, [])")).toBe(true);
  });

  it("the click does not clear the count: an unchanged page keeps it", () => {
    const clickAt = code.indexOf("onClick={() =>");
    const clickBody = clickAt === -1 ? "" : code.slice(clickAt, closeOf(code, code.indexOf("{", clickAt)) + 1);
    expect(clickBody).toMatch(/startTransition\(/);
    expect(clickBody).toMatch(/attempt:\s*0/);
    expect(clickBody).toMatch(/signatureOf\(\s*knownIds\s*\)/);
    expect(clickBody).not.toMatch(/setHit\s*\(/);
  });

  it("every className is one static literal (no template, no expression), and none carries a margin", () => {
    expect(code.match(/className=(?!")/g) ?? []).toHaveLength(0);
    const literals = code.match(/className="[^"]*"/g) ?? [];
    expect(literals.length).toBeGreaterThanOrEqual(3);
    for (const literal of literals) {
      expect(literal).not.toMatch(/[{}$`]/);
      expect(literal).not.toMatch(/(?<![\w-])-?m[trblxy]?-/);
    }
  });

  it("the region's className sits right after tabIndex={-1}, is the only one on the element, and is fixed", () => {
    const literal = /tabIndex=\{-1\}\s+className="([^"{}$`]*)"\s*>/.exec(code);
    expect(literal).not.toBeNull();
    const tokens = (literal?.[1] ?? "").split(" ").filter(Boolean);
    for (const token of SPEC_WRAPPER_TOKENS) expect(tokens, token).toContain(token);
    const roleAt = code.indexOf('role="status"');
    const regionTag = code.slice(code.lastIndexOf("<div", roleAt), code.indexOf(">", roleAt) + 1);
    expect(regionTag.startsWith("<div")).toBe(true);
    expect(regionTag.split("className=").length - 1).toBe(1);
  });

  it("the button's literal carries the spec's target size and the timeline pill's colours", () => {
    const classAt = code.indexOf('className="', code.indexOf("<button"));
    const button = code.slice(classAt + 11, code.indexOf('"', classAt + 11));
    const tokens = button.split(" ").filter(Boolean);
    for (const token of ["pointer-events-auto", "min-h-11", "sm:min-h-8", "rounded-full", "bg-primary", "text-primary-foreground"]) {
      expect(tokens, token).toContain(token);
    }
  });

  it("every status text is a single text-xs line with a literal class", () => {
    const paragraphs = code.match(/<p\b[^>]*>/g) ?? [];
    expect(paragraphs.length).toBeGreaterThanOrEqual(2);
    for (const tag of paragraphs) {
      expect(tag).toMatch(/className="[^"{}$`]*\btext-xs\b[^"{}$`]*"/);
    }
  });

  it("the longest status text fits a 360 px viewport at text-xs (about 6.5 px a character)", () => {
    const at = code.indexOf("Liste henüz güncellenmedi");
    expect(at).toBeGreaterThanOrEqual(0);
    const end = code.indexOf("<", at);
    const text = code.slice(at, end).trim();
    expect(text.length).toBeGreaterThan(0);
    expect(text.length * 6.5).toBeLessThan(360 - 32 - 24);
  });
});

// react-L1: with cacheComponents Next keeps "/" mounted in a hidden <Activity> while a cluster is open; React runs every
// effect cleanup on hide and every effect again on reveal, but keeps state. The outcome timers need an identity and a
// pinned deadline, exactly as in the /timeline pill, or a reveal brings back a stale "Yenileniyor…" and an unrequested refresh.
describe("NewBreakingPill -- survives a hidden Activity boundary (source guard)", () => {
  const code = blankComments(readFileSync(resolve(__dirname, "new-breaking-pill.tsx"), "utf8"));

  it("settled carries an identity, and every transition out of a finished refresh bumps it", () => {
    expect(code).toMatch(/type\s+SettledState\s*=\s*\{\s*kind:\s*Settled;\s*seq:\s*number\s*\}/);
    expect(code).toMatch(/useState<SettledState>\(\s*\{\s*kind:\s*["']none["']\s*,\s*seq:\s*0\s*\}\s*\)/);
    for (const kind of ["updated", "retrying", "unchanged"]) {
      expect(code).toMatch(
        new RegExp(`setSettled\\(\\s*\\{\\s*kind:\\s*["']${kind}["']\\s*,\\s*seq:\\s*settled\\.seq\\s*\\+\\s*1\\s*\\}\\s*\\)`),
      );
    }
    expect(code).not.toMatch(/setSettled\(\s*["']/);
  });

  it("pins each outcome's deadline in a ref and re-arms with what is left, dropping an expired retry", () => {
    expect(code).toMatch(/const\s+deadline\s*=\s*useRef<\{\s*seq:\s*number;\s*at:\s*number\s*\}\s*\|\s*null>\(\s*null\s*\)/);
    expect(code).toMatch(/deadline\.current\s*=\s*\{\s*seq\s*,\s*at:\s*readClock\(\)\s*\+\s*TIMELINE_REFRESH_RETRY_MS\s*\}/);
    expect(code).toMatch(/deadline\.current\s*=\s*\{\s*seq\s*,\s*at:\s*readClock\(\)\s*\+\s*PILL_STATUS_MS\s*\}/);
    expect(code).toMatch(/remainingMs\(\s*deadline\.current\.at\s*,\s*readClock\(\)\s*\)/);
    expect(code).toMatch(/if\s*\(\s*left\s*===\s*null\s*\)/);
    // No timer is armed with a fixed delay.
    expect(code).not.toMatch(/window\.setTimeout\([^)]*,\s*(TIMELINE_REFRESH_RETRY_MS|PILL_STATUS_MS|\d{4,})\s*\)/);
  });

  it("both outcome effects re-run on the outcome's identity (kind and seq), not on the whole state", () => {
    const effectsList = callsOf(code, "useEffect");
    const retry = effectsList.find((e) => e.includes('settled.kind !== "retrying"')) ?? "";
    const status = effectsList.find((e) => e.includes('settled.kind !== "updated"')) ?? "";
    expect(retry).not.toBe("");
    expect(status).not.toBe("");
    for (const body of [retry, status]) {
      expect(body).toContain("settled.kind, settled.seq");
      expect(body).not.toMatch(/\[\s*settled\s*[,\]]/);
    }
    expect(retry).toContain("startTransition");
  });
});

// The classes are literal strings (Tailwind finds them by scanning the source), so a typo or an
// arbitrary value Tailwind cannot parse would silently ship an unstyled, in-flow pill. One real
// compile of globals.css, the way tests/guards/new-pill-no-shift.test.ts does it.
describe("NewBreakingPill -- the literal classes compile", () => {
  const ROOT = resolve(__dirname, "../../..");
  const GLOBALS = resolve(ROOT, "src/app/globals.css");

  /** A class name as it appears in a compiled selector: every character but [A-Za-z0-9_-] backslash-escaped. */
  const escaped = (token: string) =>
    [...token].map((c) => (/[A-Za-z0-9_-]/.test(c) ? c : `\\${c}`)).join("");

  const compiled = (async () => {
    const result = await postcss([tailwindcss({ base: ROOT })]).process(
      readFileSync(GLOBALS, "utf8"),
      { from: GLOBALS },
    );
    return postcss.parse(result.css);
  })();

  it("has a rule for every token of the wrapper and of the button", async () => {
    const root = await compiled;
    const selectors: string[] = [];
    root.walkRules((rule) => void selectors.push(rule.selector));
    const tokens = [
      ...SPEC_WRAPPER_TOKENS,
      "pointer-events-auto",
      "min-h-11",
      "sm:min-h-8",
      "rounded-full",
      "bg-primary",
      "text-primary-foreground",
    ];
    for (const token of tokens) {
      expect(
        selectors.some((sel) => sel.includes(`.${escaped(token)}`)),
        `no compiled rule for .${token}`,
      ).toBe(true);
    }
  });

  it("the bottom offset is the larger of 1rem and the safe-area inset, and the wrapper is position: fixed", async () => {
    const root = await compiled;
    let bottom: string | undefined;
    let position: string | undefined;
    root.walkRules((rule) => {
      if (rule.selector === ".fixed") rule.walkDecls("position", (d) => void (position = d.value));
      if (rule.selector.includes("safe-area-inset-bottom")) {
        rule.walkDecls("bottom", (d) => void (bottom = d.value));
      }
    });
    expect((bottom ?? "").split(" ").join("")).toBe("max(1rem,env(safe-area-inset-bottom))");
    expect(position).toBe("fixed");
  });

  it("space-y-5 puts its gap on every child but the last (margin-block-end), so a fixed sibling that is not last moves nothing", async () => {
    const root = await compiled;
    let selector: string | undefined;
    let prop: string | undefined;
    root.walkRules((rule) => {
      if (rule.selector.includes(".space-y-5 >")) {
        selector = rule.selector;
        rule.walkDecls((d) => {
          if (d.prop === "margin-block-end") prop = d.prop;
        });
      }
    });
    expect(selector ?? "").toContain(":not(:last-child)");
    expect(prop).toBe("margin-block-end");
  });
});
