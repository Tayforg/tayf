import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// h61-journey-2: after a client-side navigation Next's assertive route
// announcer read the previous page's hidden <h1>, because the streamed <title>
// lands ~500 ms after the tree commit and the announcer only looks once. The
// replacement announces the NEW title, politely, once, and hides Next's own
// announcer from assistive tech.
//
// There is no DOM library in this repo (vitest runs in node, and no new
// dependencies are allowed), so the behaviour is covered in three layers:
//   1. the pure pieces (suffix strip, heading fallback, poll, observer helper)
//      against hand-made fakes and fake timers;
//   2. the real component's effects, run by a ~50 line hook runtime that
//      replaces useState/useRef/useEffect while a test is mounted;
//   3. the first-render markup, rendered by react-dom/server.

const nav = vi.hoisted(() => ({ pathname: "/blindspots", search: "" }));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const rt = vi.hoisted(() => {
  interface Slot {
    value?: unknown;
    current?: unknown;
    deps?: readonly unknown[];
    cleanup?: unknown;
  }

  class Runtime {
    /** Every committed output, one entry per render pass. */
    readonly outputs: unknown[] = [];
    private readonly slots: Slot[] = [];
    private cursor = 0;
    private pending: Array<() => void> = [];
    private dirty = false;
    private flushing = false;

    constructor(private readonly component: () => unknown) {}

    render(): void {
      this.flushing = true;
      try {
        do {
          this.dirty = false;
          this.cursor = 0;
          this.pending = [];
          const outer = state.current;
          state.current = this;
          try {
            this.outputs.push(this.component());
          } finally {
            state.current = outer;
          }
          for (const effect of this.pending) effect();
        } while (this.dirty);
      } finally {
        this.flushing = false;
      }
    }

    unmount(): void {
      for (const slot of this.slots) {
        if (typeof slot.cleanup === "function") (slot.cleanup as () => void)();
        slot.cleanup = undefined;
      }
    }

    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const slot = (this.slots[this.cursor] ??= {
        value: typeof initial === "function" ? (initial as () => unknown)() : initial,
      });
      this.cursor++;
      const set = (next: unknown) => {
        const value = typeof next === "function" ? (next as (prev: unknown) => unknown)(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        if (this.flushing) this.dirty = true;
        else this.render();
      };
      return [slot.value, set];
    }

    useRef(initial: unknown): { current: unknown } {
      const slot = (this.slots[this.cursor] ??= { current: initial });
      this.cursor++;
      return slot as { current: unknown };
    }

    useEffect(effect: () => unknown, deps?: readonly unknown[]): void {
      const first = this.slots[this.cursor] === undefined;
      const slot = (this.slots[this.cursor] ??= {});
      this.cursor++;
      const changed = first || deps === undefined || !deps.every((d, i) => Object.is(d, slot.deps?.[i]));
      if (!changed) return;
      slot.deps = deps;
      this.pending.push(() => {
        if (typeof slot.cleanup === "function") (slot.cleanup as () => void)();
        slot.cleanup = effect();
      });
    }
  }

  const state: { current: Runtime | null } = { current: null };
  return { state, Runtime };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    default: actual,
    useState: (initial: unknown) =>
      rt.state.current ? rt.state.current.useState(initial) : actual.useState(initial as never),
    useRef: (initial: unknown) =>
      rt.state.current ? rt.state.current.useRef(initial) : actual.useRef(initial as never),
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) =>
      rt.state.current
        ? rt.state.current.useEffect(effect, deps)
        : actual.useEffect(effect as never, deps as never),
  };
});

import {
  RouteTitleAnnouncer,
  firstVisibleHeadingText,
  hideNextRouteAnnouncer,
  routeKey,
  startTitlePoll,
  stripSiteSuffix,
  type HeadingNode,
} from "./route-title-announcer";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeNode extends HeadingNode {
  display: string;
  attrs: string[];
  parentElement: FakeNode | null;
}

/** A node whose `closest` walks its own chain, like Element.closest. */
function node(over: Partial<Pick<FakeNode, "textContent" | "display" | "attrs" | "parentElement">> = {}): FakeNode {
  const self: FakeNode = {
    textContent: over.textContent ?? "",
    display: over.display ?? "block",
    attrs: over.attrs ?? [],
    parentElement: over.parentElement ?? null,
    closest(selectors: string) {
      for (let n: FakeNode | null = self; n; n = n.parentElement) {
        if (n.attrs.some((a) => selectors.includes(`[${a}]`))) return n;
      }
      return null;
    },
  };
  return self;
}

const h1 = (text: string, over: Parameters<typeof node>[0] = {}) => node({ ...over, textContent: text });

/** An h1 inside <div style="display:none"> (what Activity does to a left route). */
const hiddenByAncestor = (text: string) => h1(text, { parentElement: node({ display: "none" }) });

class FakeElement {
  readonly attrs = new Map<string, string>();
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
}

class FakeBody {
  readonly children: FakeElement[] = [];
  querySelectorAll(selectors: string): FakeElement[] {
    return this.children.filter((c) => c.tag === selectors);
  }
}

class FakeObserver {
  static instances: FakeObserver[] = [];
  observed: Array<{ target: unknown; options: unknown }> = [];
  disconnected = false;
  constructor(private readonly callback: () => void) {
    FakeObserver.instances.push(this);
  }
  observe(target: unknown, options: unknown): void {
    this.observed.push({ target, options });
  }
  disconnect(): void {
    this.disconnected = true;
  }
  /** Fire the callback as the browser does after a childList mutation. */
  fire(): void {
    if (!this.disconnected) this.callback();
  }
}

interface FakeDocument {
  title: string;
  body: FakeBody;
  headings: HeadingNode[];
  querySelectorAll(selectors: string): HeadingNode[];
}

function makeDocument(): FakeDocument {
  const doc: FakeDocument = {
    title: "",
    body: new FakeBody(),
    headings: [],
    querySelectorAll: (selectors) => (selectors === "h1" ? doc.headings : []),
  };
  return doc;
}

let doc: FakeDocument;

beforeEach(() => {
  vi.useFakeTimers();
  nav.pathname = "/blindspots";
  nav.search = "";
  FakeObserver.instances = [];
  doc = makeDocument();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("MutationObserver", FakeObserver);
  vi.stubGlobal("getComputedStyle", (el: FakeNode) => ({ display: el.display }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

describe("stripSiteSuffix", () => {
  it("removes the trailing ' — Tayf'", () => {
    expect(stripSiteSuffix("Halepli Alabed çağrısı — Tayf")).toBe("Halepli Alabed çağrısı");
  });

  it("keeps an em dash that is part of the page title", () => {
    expect(stripSiteSuffix("Dünya haberleri — Sayfa 2")).toBe("Dünya haberleri — Sayfa 2");
    expect(stripSiteSuffix("Dünya haberleri — Sayfa 2 — Tayf")).toBe("Dünya haberleri — Sayfa 2");
  });

  it("leaves the home title and a bare brand name alone", () => {
    expect(stripSiteSuffix("Tayf — Türkiye Haber Analizi")).toBe("Tayf — Türkiye Haber Analizi");
    expect(stripSiteSuffix("Tayf")).toBe("Tayf");
  });

  it("needs whitespace on both sides of the dash and only strips at the end", () => {
    expect(stripSiteSuffix("Haber—Tayf")).toBe("Haber—Tayf");
    expect(stripSiteSuffix("Haber —Tayf")).toBe("Haber —Tayf");
    expect(stripSiteSuffix("Haber — Tayf Spor")).toBe("Haber — Tayf Spor");
  });

  it("tolerates wider whitespace and trims the result", () => {
    expect(stripSiteSuffix("  Kör noktalar  —\t Tayf  ")).toBe("Kör noktalar");
  });

  it("handles the empty string and stays linear on a long whitespace run", () => {
    expect(stripSiteSuffix("")).toBe("");
    const long = `a${" ".repeat(200_000)}x`;
    const started = performance.now();
    expect(stripSiteSuffix(long)).toBe(long);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("routeKey", () => {
  it("changes on a path change and on a search-only change", () => {
    expect(routeKey("/konu/dunya", "")).not.toBe(routeKey("/konu/dunya", "sayfa=2"));
    expect(routeKey("/konu/dunya", "")).not.toBe(routeKey("/blindspots", ""));
  });

  it("is stable for identical input", () => {
    expect(routeKey("/konu/dunya", "sayfa=2")).toBe(routeKey("/konu/dunya", "sayfa=2"));
  });

  it("ignores the search box's ?q and the newsletter banner's ?bulten (UI chatter, not navigation)", () => {
    expect(routeKey("/", "q=a")).toBe(routeKey("/", "q=ab"));
    expect(routeKey("/", "q=a")).toBe(routeKey("/", ""));
    expect(routeKey("/", "bulten=ok")).toBe(routeKey("/", ""));
    expect(routeKey("/", "q=a&bulten=ok&page=2")).toBe(routeKey("/", "page=2"));
    // ...while a real search-param change and a path change still differ.
    expect(routeKey("/", "page=2")).not.toBe(routeKey("/", "page=3"));
    expect(routeKey("/", "q=a")).not.toBe(routeKey("/konu/dunya", "q=a"));
  });
});

describe("firstVisibleHeadingText", () => {
  const style = (el: HeadingNode) => ({ display: (el as FakeNode).display });
  const root = (headings: HeadingNode[]) => ({ querySelectorAll: () => headings });

  it("returns the first h1 that nothing hides", () => {
    expect(firstVisibleHeadingText(root([h1("Birinci"), h1("İkinci")]), style)).toBe("Birinci");
  });

  it("skips an h1 inside an ancestor with display:none", () => {
    expect(firstVisibleHeadingText(root([hiddenByAncestor("Kör noktalar"), h1("Yeni sayfa")]), style)).toBe(
      "Yeni sayfa",
    );
  });

  it("skips an h1 that is itself display:none", () => {
    expect(firstVisibleHeadingText(root([h1("Gizli", { display: "none" }), h1("Görünen")]), style)).toBe("Görünen");
  });

  it("skips [hidden], [inert] and [aria-hidden=\"true\"] h1s (itself or an ancestor)", () => {
    const hidden = h1("a", { attrs: ["hidden"] });
    const inert = h1("b", { parentElement: node({ attrs: ["inert"] }) });
    const ariaHidden = h1("c", { parentElement: node({ attrs: ['aria-hidden="true"'] }) });
    expect(firstVisibleHeadingText(root([hidden, inert, ariaHidden, h1("Görünen")]), style)).toBe("Görünen");
  });

  it("skips h1s with no text and collapses inner whitespace", () => {
    expect(firstVisibleHeadingText(root([h1("   "), h1("  Haftanın\n  özeti ")]), style)).toBe("Haftanın özeti");
  });

  it("returns '' when no h1 is visible", () => {
    expect(firstVisibleHeadingText(root([]), style)).toBe("");
    expect(firstVisibleHeadingText(root([hiddenByAncestor("Haberler")]), style)).toBe("");
  });
});

describe("startTitlePoll", () => {
  function setup(readFallback = () => "Yedek başlık") {
    const state = { title: "" };
    const settled: string[] = [];
    const cancel = startTitlePoll({
      readTitle: () => state.title,
      readFallback,
      onSettled: (text) => settled.push(text),
    });
    return { state, settled, cancel };
  }

  it("waits for the streamed title, strips the suffix and announces once", () => {
    const { state, settled } = setup();
    setTimeout(() => {
      state.title = "Halepli Alabed çağrısı — Tayf";
    }, 500);
    vi.advanceTimersByTime(600);
    expect(settled).toEqual([]);
    vi.advanceTimersByTime(5000);
    expect(settled).toEqual(["Halepli Alabed çağrısı"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("needs three consecutive equal non-empty polls (100 ms apart) before announcing", () => {
    const { state, settled } = setup();
    state.title = "Hazır — Tayf";
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    expect(settled).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(settled).toEqual(["Hazır"]);
  });

  it("old -> '' -> new announces only the final stable title", () => {
    const { state, settled } = setup();
    state.title = "Kör noktalar — Tayf";
    setTimeout(() => {
      state.title = "";
    }, 150);
    setTimeout(() => {
      state.title = "Yeni sayfa — Tayf";
    }, 500);
    vi.advanceTimersByTime(5000);
    expect(settled).toEqual(["Yeni sayfa"]);
  });

  it("a title that changes before it settles restarts the count", () => {
    const { state, settled } = setup();
    state.title = "Bir — Tayf";
    setTimeout(() => {
      state.title = "İki — Tayf";
    }, 250);
    vi.advanceTimersByTime(5000);
    expect(settled).toEqual(["İki"]);
  });

  it("falls back to the visible h1 when the title stays empty for 4000 ms", () => {
    const { settled } = setup(() => "Yeni sayfa");
    vi.advanceTimersByTime(3999);
    expect(settled).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(settled).toEqual(["Yeni sayfa"]);
    vi.advanceTimersByTime(10_000);
    expect(settled).toEqual(["Yeni sayfa"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("announces nothing when there is neither a title nor a visible h1", () => {
    const { settled } = setup(() => "");
    vi.advanceTimersByTime(10_000);
    expect(settled).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancel stops the poll and suppresses the announcement", () => {
    const { state, settled, cancel } = setup();
    state.title = "Geç — Tayf";
    vi.advanceTimersByTime(200);
    cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(settled).toEqual([]);
  });
});

describe("hideNextRouteAnnouncer", () => {
  function announcer(): FakeElement {
    return new FakeElement("next-route-announcer");
  }

  it("hides an announcer that already exists", () => {
    const body = new FakeBody();
    const existing = announcer();
    body.children.push(existing);
    hideNextRouteAnnouncer(body, FakeObserver);
    expect(existing.attrs.get("aria-hidden")).toBe("true");
  });

  it("watches direct children of the root only (childList, no subtree)", () => {
    const body = new FakeBody();
    hideNextRouteAnnouncer(body, FakeObserver);
    expect(FakeObserver.instances).toHaveLength(1);
    expect(FakeObserver.instances[0]!.observed).toEqual([{ target: body, options: { childList: true } }]);
  });

  it("hides an announcer Next appends (or recreates) after mount, and nothing else", () => {
    const body = new FakeBody();
    hideNextRouteAnnouncer(body, FakeObserver);
    const late = announcer();
    const other = new FakeElement("div");
    body.children.push(late, other);
    FakeObserver.instances[0]!.fire();
    expect(late.attrs.get("aria-hidden")).toBe("true");
    expect(other.attrs.has("aria-hidden")).toBe(false);
  });

  it("disconnects the observer on cleanup", () => {
    const body = new FakeBody();
    const stop = hideNextRouteAnnouncer(body, FakeObserver);
    stop();
    expect(FakeObserver.instances[0]!.disconnected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The real component, effects included
// ---------------------------------------------------------------------------

type RegionProps = {
  role: string;
  "aria-live": string;
  "aria-atomic": string;
  className: string;
  children: string;
};

function mount() {
  const app = new rt.Runtime(() => RouteTitleAnnouncer());
  app.render();
  const props = (output: unknown) => (output as ReactElement<RegionProps>).props;
  return {
    app,
    text: () => props(app.outputs[app.outputs.length - 1]).children,
    /** Distinct texts the live region received, in order, ignoring the empty resets. */
    announced: () => {
      const seen: string[] = [];
      let previous = "";
      for (const output of app.outputs) {
        const text = props(output).children;
        if (text !== "" && text !== previous) seen.push(text);
        previous = text;
      }
      return seen;
    },
    navigate(pathname: string, search = "") {
      nav.pathname = pathname;
      nav.search = search;
      app.render();
    },
  };
}

describe("RouteTitleAnnouncer", () => {
  it("renders an empty polite status region on first render", () => {
    const html = renderToStaticMarkup(<RouteTitleAnnouncer />);
    expect(html).toBe('<div role="status" aria-live="polite" aria-atomic="true" class="sr-only"></div>');
  });

  it("does not announce on the first load, whatever the title is", () => {
    doc.title = "Kör noktalar — Tayf";
    const view = mount();
    expect(view.text()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(view.text()).toBe("");
    expect(view.announced()).toEqual([]);
  });

  it("re-renders of the same route do not poll or announce", () => {
    doc.title = "Kör noktalar — Tayf";
    const view = mount();
    view.app.render();
    view.app.render();
    expect(vi.getTimerCount()).toBe(0);
    expect(view.announced()).toEqual([]);
  });

  it("announces the NEW title once after a pathname change, not the hidden previous h1", () => {
    doc.title = "Kör noktalar — Tayf";
    const view = mount();

    // Client navigation: Next drops the old <title> at once, streams the new one at +500 ms,
    // and keeps the left route's h1 in a display:none Activity wrapper earlier in the DOM.
    doc.title = "";
    doc.headings = [hiddenByAncestor("Kör noktalar"), h1("Cumhurbaşkanı Erdoğan'a kelebek figürü takdim eden Halepli Alabed")];
    setTimeout(() => {
      doc.title = "Halepli Alabed çağrısı — Tayf";
    }, 500);
    view.navigate("/cluster/c859c91b");

    expect(view.text()).toBe("");
    vi.advanceTimersByTime(499);
    expect(view.text()).toBe("");
    vi.advanceTimersByTime(5000);
    expect(view.text()).toBe("Halepli Alabed çağrısı");
    expect(view.announced()).toEqual(["Halepli Alabed çağrısı"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("title old -> '' -> new announces only the final stable title", () => {
    doc.title = "Kör noktalar — Tayf";
    const view = mount();
    setTimeout(() => {
      doc.title = "";
    }, 50);
    setTimeout(() => {
      doc.title = "Dünya haberleri — Tayf";
    }, 500);
    view.navigate("/konu/dunya");
    vi.advanceTimersByTime(6000);
    expect(view.announced()).toEqual(["Dünya haberleri"]);
  });

  it("falls back to the first visible h1 when the title stays empty for 4000 ms", () => {
    const view = mount();
    doc.title = "";
    doc.headings = [hiddenByAncestor("Kör noktalar"), h1("Gizli", { attrs: ["inert"] }), h1("Haftanın özeti")];
    view.navigate("/haftalik");
    vi.advanceTimersByTime(3999);
    expect(view.text()).toBe("");
    vi.advanceTimersByTime(1);
    expect(view.text()).toBe("Haftanın özeti");
    expect(view.announced()).toEqual(["Haftanın özeti"]);
  });

  it("a search-only change (?sayfa=2) re-announces the page title", () => {
    doc.title = "Dünya haberleri — Tayf";
    nav.pathname = "/konu/dunya";
    const view = mount();
    doc.title = "Dünya haberleri — Sayfa 2 — Tayf";
    view.navigate("/konu/dunya", "sayfa=2");
    vi.advanceTimersByTime(1000);
    expect(view.text()).toBe("Dünya haberleri — Sayfa 2");
    expect(view.announced()).toEqual(["Dünya haberleri — Sayfa 2"]);
  });

  it("typing in the search box (?q=a -> ?q=ab) announces nothing and starts no poll", () => {
    doc.title = "“a” araması — Tayf";
    nav.pathname = "/";
    nav.search = "q=a";
    const view = mount();
    doc.title = "“ab” araması — Tayf";
    view.navigate("/", "q=ab");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(view.text()).toBe("");
    expect(view.announced()).toEqual([]);
  });

  it("search-nav dropping ?page while typing (/?page=2 -> /?q=a) announces nothing", () => {
    doc.title = "Tayf — Türkiye Haber Analizi";
    nav.pathname = "/";
    nav.search = "page=2";
    const view = mount();
    doc.title = "“a” araması — Tayf";
    view.navigate("/", "q=a");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(view.announced()).toEqual([]);
  });

  it("dismissing the newsletter banner (/?bulten=ok -> /) announces nothing", () => {
    doc.title = "Tayf — Türkiye Haber Analizi";
    nav.pathname = "/";
    nav.search = "bulten=ok";
    const view = mount();
    view.navigate("/", "");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(view.announced()).toEqual([]);
  });

  it("leaving a page for a search (/konu/dunya -> /?q=a) is a pathname change and announces once", () => {
    doc.title = "Dünya haberleri — Tayf";
    nav.pathname = "/konu/dunya";
    const view = mount();
    doc.title = "“a” araması — Tayf";
    view.navigate("/", "q=a");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(view.announced()).toEqual(["“a” araması"]);
    // The next keystroke is the search box again: no second announcement.
    doc.title = "“ab” araması — Tayf";
    view.navigate("/", "q=ab");
    vi.advanceTimersByTime(10_000);
    expect(view.announced()).toEqual(["“a” araması"]);
  });

  it("clears the region on navigation so an identical title is announced again", () => {
    doc.title = "Dünya haberleri — Tayf";
    nav.pathname = "/konu/dunya";
    const view = mount();
    view.navigate("/konu/dunya", "sayfa=2");
    vi.advanceTimersByTime(1000);
    expect(view.text()).toBe("Dünya haberleri");
    view.navigate("/konu/dunya", "sayfa=3");
    expect(view.text()).toBe("");
    vi.advanceTimersByTime(1000);
    expect(view.text()).toBe("Dünya haberleri");
    expect(view.announced()).toEqual(["Dünya haberleri", "Dünya haberleri"]);
  });

  it("a second navigation before the first settles cancels the first poll", () => {
    const view = mount();
    doc.title = "Birinci — Tayf";
    view.navigate("/birinci");
    vi.advanceTimersByTime(150);
    doc.title = "İkinci — Tayf";
    view.navigate("/ikinci");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(view.announced()).toEqual(["İkinci"]);
  });

  it("hides Next's announcer on mount and again when Next recreates it", () => {
    const first = new FakeElement("next-route-announcer");
    doc.body.children.push(first);
    mount();
    expect(first.attrs.get("aria-hidden")).toBe("true");

    const observer = FakeObserver.instances[0]!;
    expect(observer.observed).toEqual([{ target: doc.body, options: { childList: true } }]);
    const recreated = new FakeElement("next-route-announcer");
    doc.body.children.push(recreated);
    observer.fire();
    expect(recreated.attrs.get("aria-hidden")).toBe("true");
  });

  it("unmount cancels the poll and disconnects the observer", () => {
    const view = mount();
    doc.title = "";
    view.navigate("/cluster/x");
    expect(vi.getTimerCount()).toBe(1);
    view.app.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeObserver.instances[0]!.disconnected).toBe(true);
    doc.title = "Geç — Tayf";
    vi.advanceTimersByTime(10_000);
    expect(view.announced()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Source pins
// ---------------------------------------------------------------------------

const componentSrc = readFileSync(resolve(__dirname, "route-title-announcer.tsx"), "utf-8");
const layoutSrc = readFileSync(resolve(__dirname, "..", "app", "layout.tsx"), "utf-8");

/** `src` without block comments and full-line comments, by index scans (no regex over source). */
function code(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
    } else {
      out += src[i];
      i++;
    }
  }
  return out
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

/** `src` without `{/* ... *\/}` JSX comment blocks, by index scans. */
function withoutJsxComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("{/*", i)) {
      const end = src.indexOf("*/}", i + 3);
      i = end === -1 ? src.length : end + 3;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

describe("wiring", () => {
  it("is a client component", () => {
    expect(componentSrc.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("never writes into Next's shadow DOM (React owns that text node)", () => {
    expect(code(componentSrc).includes("shadowRoot")).toBe(false);
  });

  it("layout mounts it under Suspense next to <KbdShortcuts />", () => {
    expect(layoutSrc.includes('import { RouteTitleAnnouncer } from "@/components/route-title-announcer";')).toBe(true);
    const kbd = layoutSrc.indexOf("<KbdShortcuts />");
    const at = layoutSrc.indexOf("<RouteTitleAnnouncer />");
    expect(kbd).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(kbd);
    const before = layoutSrc.slice(0, at);
    expect(before.lastIndexOf('<Suspense fallback={null}>')).toBeGreaterThan(before.lastIndexOf("</Suspense>"));
    expect(layoutSrc.indexOf("</Suspense>", at)).toBeGreaterThan(at);
    // "next to" means no other element sits between the two (JSX comments aside).
    const between = withoutJsxComments(layoutSrc.slice(kbd + "<KbdShortcuts />".length, at));
    expect(between.split("").filter((ch) => ch.trim() !== "").join("")).toBe('<Suspensefallback={null}>');
  });
});
