import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Link from "next/link";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// h185-roadmap2-1: when a multi-word search finds nothing, the empty card offers
// one chip per typed word. RelaxedSearchLinks renders them; each is a plain
// search URL (?q=word) that does not prefetch (a chip is a DB-backed search and
// six of them must not fire six RPCs when the card scrolls into view).
//
// Like "Aramayı temizle" (clear-search-link.test.tsx, h90-livearia-1) a chip
// sits in a card that unmounts when the navigation commits, so a keyboard user's
// focused link would vanish and focus would fall to <body> (WCAG 2.4.3). The chips
// hand focus to the feed container instead, once the query changes or the card
// goes. The same small hook runtime and DOM stub as that test drive the effects:
// this repo's vitest runs in node with no DOM library.

const nav = vi.hoisted(() => ({ search: "q=emekli+bayram+ikramiyesi+ne+zaman" }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const rt = vi.hoisted(() => {
  interface Slot {
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

    constructor(private readonly component: () => unknown) {}

    render(): void {
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
    }

    unmount(): void {
      for (const slot of this.slots) {
        if (typeof slot.cleanup === "function") (slot.cleanup as () => void)();
        slot.cleanup = undefined;
      }
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
    useRef: (initial: unknown) =>
      rt.state.current ? rt.state.current.useRef(initial) : actual.useRef(initial as never),
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) =>
      rt.state.current
        ? rt.state.current.useEffect(effect, deps)
        : actual.useEffect(effect as never, deps as never),
  };
});

import { RelaxedSearchLinks } from "./relaxed-search-links";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const FEED_ID = "haber-akisi";
const WORDS = ["emekli", "bayram", "ikramiyesi", "zaman"] as const;

interface FakeDocument {
  activeElement: { tagName: string } | null;
  getElementById: ReturnType<typeof vi.fn>;
}

let feed: { focus: ReturnType<typeof vi.fn> };
let doc: FakeDocument;

beforeEach(() => {
  nav.search = "q=emekli+bayram+ikramiyesi+ne+zaman";
  feed = { focus: vi.fn() };
  doc = {
    activeElement: { tagName: "BODY" },
    getElementById: vi.fn((id: string) => (id === FEED_ID ? feed : null)),
  };
  vi.stubGlobal("document", doc);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Elementish = { type?: unknown; props?: Record<string, unknown> };

type LinkProps = {
  href: string;
  prefetch: boolean;
  scroll: boolean;
  className: string;
  children: string;
  onClick?: unknown;
  onNavigate: (event: { preventDefault: () => void }) => void;
};

/** Every element in an output tree, children walked recursively (no hooks run). */
function elementsOf(node: unknown, out: Elementish[] = []): Elementish[] {
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as Elementish;
    if (el.type !== undefined) out.push(el);
    if (el.props?.children !== undefined) elementsOf(el.props.children, out);
  }
  return out;
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object") return textOf((node as Elementish).props?.children);
  return "";
}

function mount(words: readonly string[] = WORDS, targetId = FEED_ID, sort?: "yeni" | null) {
  const app = new rt.Runtime(() => RelaxedSearchLinks({ words, targetId, ...(sort === undefined ? {} : { sort }) }));
  app.render();
  const tree = () => app.outputs[app.outputs.length - 1];
  const links = (): { type: unknown; props: LinkProps }[] =>
    elementsOf(tree()).filter((e) => e.type === Link) as { type: unknown; props: LinkProps }[];
  return {
    app,
    tree,
    links,
    /** What a click on chip `i` does once Link decides to navigate in-app. */
    click: (i = 0) => links()[i]!.props.onNavigate({ preventDefault: vi.fn() }),
    /** The URL changes (the navigation committed, or the visitor typed). */
    setSearch(search: string) {
      nav.search = search;
      app.render();
    },
  };
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

describe("RelaxedSearchLinks: markup", () => {
  it("renders the label and one anchor per word, in order", () => {
    const html = renderToStaticMarkup(<RelaxedSearchLinks words={WORDS} targetId={FEED_ID} />);
    expect(html).toContain("Kelimeleri tek tek deneyin:");
    expect(html.split("<a ")).toHaveLength(WORDS.length + 1);
    let from = 0;
    for (const word of WORDS) {
      const at = html.indexOf(`href="/?q=${word}"`, from);
      expect(at, word).toBeGreaterThanOrEqual(from);
      from = at;
      expect(html, word).toContain(`>${word}</a>`);
    }
  });

  it("puts the label in a muted paragraph and the chips in a wrapping list", () => {
    const html = renderToStaticMarkup(<RelaxedSearchLinks words={WORDS} targetId={FEED_ID} />);
    expect(html).toContain('<p class="text-xs text-muted-foreground">Kelimeleri tek tek deneyin:</p>');
    expect(html).toContain("<ul ");
    expect(html).toContain("flex-wrap");
    expect(html.split("<li").length - 1).toBe(WORDS.length);
  });

  it("each href is /?q= plus the word, percent-encoded by URLSearchParams", () => {
    const view = mount(["emekli", "yasası", "a&b", "a#b", 'a"b', "o'neil", "a b", "a+b", "100%"]);
    expect(view.links().map((l) => l.props.href)).toEqual([
      "/?q=emekli",
      "/?q=yasas%C4%B1",
      "/?q=a%26b",
      "/?q=a%23b",
      "/?q=a%22b",
      "/?q=o%27neil",
      "/?q=a+b",
      "/?q=a%2Bb",
      "/?q=100%25",
    ]);
  });

  it("builds the href with URLSearchParams, word for word", () => {
    const words = ["bahçeli", "ışık", "a&b=c", "x?y", "<b>", "ğ#ş"];
    const view = mount(words);
    expect(view.links().map((l) => l.props.href)).toEqual(
      words.map((w) => `/?${new URLSearchParams({ q: w }).toString()}`),
    );
  });

  it("a word with '&', '#' or a quote cannot add a parameter or end the query early", () => {
    const view = mount(["a&arsiv=9", "a#b", 'a"b']);
    for (const link of view.links()) {
      const url = new URL(link.props.href, "https://tayf.test");
      expect(url.pathname).toBe("/");
      expect(url.hash).toBe("");
      expect([...url.searchParams.keys()]).toEqual(["q"]);
    }
    expect(new URL(view.links()[0]!.props.href, "https://tayf.test").searchParams.get("q")).toBe("a&arsiv=9");
  });

  it("escapes markup in a word when rendering: it is a React child, never HTML", () => {
    const html = renderToStaticMarkup(
      <RelaxedSearchLinks words={['<img src=x onerror="alert(1)">', "a&b"]} targetId={FEED_ID} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain(">a&amp;b</a>");
    expect(html).toContain('href="/?q=a%26b"');
    // The href is encoded too, so no raw quote or angle bracket can leave the attribute.
    expect(html).toContain('href="/?q=%3Cimg+src%3Dx+onerror%3D%22alert%281%29%22%3E"');
  });

  it("every chip is a next/link with prefetch={false} and scroll={false}", () => {
    const view = mount();
    expect(view.links()).toHaveLength(WORDS.length);
    for (const link of view.links()) {
      expect(link.type).toBe(Link);
      expect(link.props.prefetch).toBe(false);
      expect(link.props.scroll).toBe(false);
    }
  });

  it("gives every chip the SearchIntentRow chip class, a 24 px target (44 px on a phone)", () => {
    const view = mount();
    for (const link of view.links()) {
      expect(link.props.className).toBe(
        "inline-flex items-center min-h-6 max-sm:min-h-11 rounded-full border border-border/60 bg-muted/50 px-3 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      );
    }
  });

  it("labels each chip with its word", () => {
    const view = mount();
    expect(view.links().map((l) => l.props.children)).toEqual([...WORDS]);
  });

  it("renders nothing for an empty word list (the card shows no chips)", () => {
    expect(renderToStaticMarkup(<RelaxedSearchLinks words={[]} targetId={FEED_ID} />)).toBe("");
    expect(mount([]).tree()).toBeNull();
  });

  it("hangs the pending flag off onNavigate, never onClick (a Cmd/Ctrl-click or new tab must not arm it)", () => {
    const view = mount();
    for (const link of view.links()) {
      expect(link.props.onClick).toBeUndefined();
      expect(typeof link.props.onNavigate).toBe("function");
    }
  });

  it("never prevents the default, so the navigation proceeds", () => {
    const view = mount();
    const preventDefault = vi.fn();
    view.links()[1]!.props.onNavigate({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("the label reads as a lead-in to the chips (Turkish copy)", () => {
    const view = mount();
    expect(textOf(view.tree())).toContain("Kelimeleri tek tek deneyin:");
  });

  it("renders on the server without touching document", () => {
    vi.unstubAllGlobals();
    expect(typeof document).toBe("undefined");
    expect(() =>
      renderToStaticMarkup(<RelaxedSearchLinks words={WORDS} targetId={FEED_ID} />),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Focus hand-over
// ---------------------------------------------------------------------------

describe("RelaxedSearchLinks: focus hand-over", () => {
  it("click, then the query changes while the chips are still mounted: focuses the feed once", () => {
    const view = mount();
    view.click(0);
    expect(feed.focus).not.toHaveBeenCalled();
    view.setSearch("q=emekli");
    expect(doc.getElementById).toHaveBeenCalledWith(FEED_ID);
    expect(feed.focus).toHaveBeenCalledTimes(1);
    // The flag is spent: more renders and another change do not focus again.
    view.app.render();
    view.setSearch("q=emekli");
    view.setSearch("q=bayram");
    expect(feed.focus).toHaveBeenCalledTimes(1);
  });

  it("the card holding the chips unmounts with the navigation (the usual case): focuses the feed", () => {
    const view = mount();
    view.click(2);
    // The commit that changes q also removes the card, so a chip never sees the new query.
    view.app.unmount();
    expect(feed.focus).toHaveBeenCalledTimes(1);
  });

  it("does not scroll when it takes focus (scroll={false} keeps the reader where they are)", () => {
    const view = mount();
    view.click();
    view.setSearch("q=emekli");
    expect(feed.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("stays put while the query is unchanged after the click (a slow navigation)", () => {
    const view = mount();
    view.click();
    view.app.render();
    view.app.render();
    expect(feed.focus).not.toHaveBeenCalled();
    view.setSearch("q=emekli");
    expect(feed.focus).toHaveBeenCalledTimes(1);
  });

  it("any chip arms the one flag, so two quick clicks still focus once", () => {
    const view = mount();
    view.click(0);
    view.click(1);
    view.setSearch("q=bayram");
    view.app.unmount();
    expect(feed.focus).toHaveBeenCalledTimes(1);
  });

  it("an activation that never navigates (a modified click) does not arm it", () => {
    const view = mount();
    // Link never calls onNavigate for a Cmd/Ctrl/Shift/Alt click or a new-tab target.
    view.setSearch("q=baska");
    view.app.unmount();
    expect(feed.focus).not.toHaveBeenCalled();
    expect(doc.getElementById).not.toHaveBeenCalled();
  });

  it("an unmount without a click does not move focus (a re-render of the feed)", () => {
    const view = mount();
    view.app.unmount();
    expect(feed.focus).not.toHaveBeenCalled();
  });

  it("a spent flag is not used again by the unmount", () => {
    const view = mount();
    view.click();
    view.setSearch("q=emekli");
    view.app.unmount();
    expect(feed.focus).toHaveBeenCalledTimes(1);
  });

  it("a spent flag is not used again by a later query change", () => {
    const view = mount();
    view.click();
    view.app.unmount();
    expect(feed.focus).toHaveBeenCalledTimes(1);
    view.setSearch("q=baska");
    expect(feed.focus).toHaveBeenCalledTimes(1);
  });

  it("does nothing, and does not throw, when the target element is missing", () => {
    const view = mount(WORDS, "yok");
    view.click();
    expect(() => view.setSearch("q=emekli")).not.toThrow();
    expect(feed.focus).not.toHaveBeenCalled();
    expect(() => view.app.unmount()).not.toThrow();
  });

  it.each(["INPUT", "TEXTAREA", "SELECT"])(
    "leaves focus alone when the visitor is typing in a %s (WCAG 2.4.3 must not steal the caret)",
    (tagName) => {
      const view = mount();
      view.click();
      doc.activeElement = { tagName };
      view.setSearch("q=emekli");
      expect(feed.focus).not.toHaveBeenCalled();
      // Spent even though it did not move focus: a later change or the unmount must not retry.
      doc.activeElement = { tagName: "BODY" };
      view.setSearch("q=bayram");
      view.app.unmount();
      expect(feed.focus).not.toHaveBeenCalled();
    },
  );

  it.each(["A", "BODY"])("focuses when the active element is a %s (not editable)", (tagName) => {
    const view = mount();
    view.click();
    doc.activeElement = { tagName };
    view.setSearch("q=emekli");
    expect(feed.focus).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Source pins
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "relaxed-search-links.tsx"), "utf8");
const clearSrc = readFileSync(resolve(here, "clear-search-link.tsx"), "utf8");
const pageSrc = readFileSync(resolve(here, "..", "..", "app", "page.tsx"), "utf8");

/** Specifiers of line-leading `import ... from "x"` / `import "x"` statements. */
function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("import ")) continue;
    const q = line.includes('"') ? '"' : "'";
    const end = line.lastIndexOf(q);
    const start = line.lastIndexOf(q, end - 1);
    if (start >= 0 && end > start) out.push(line.slice(start + 1, end));
  }
  return out;
}

describe("relaxed-search-links.tsx source", () => {
  it('starts with the "use client" directive', () => {
    const head = src.trimStart();
    expect(head.startsWith('"use client"') || head.startsWith("'use client'")).toBe(true);
  });

  it("keeps the public client graph light: no cn, no tailwind-merge, no ui primitives", () => {
    const specs = importSpecifiers(src).sort();
    // h191: the one new module is search-sort, a pure constant and a type (no cn, no ui primitive, no network)
    expect(specs).toEqual(["./clear-search-link", "@/lib/search/search-sort", "next/link", "next/navigation", "react"]);
    for (const spec of specs) {
      expect(spec).not.toContain("utils");
      expect(spec).not.toContain("tailwind-merge");
      expect(spec).not.toContain("components/ui");
    }
  });

  it("reuses clear-search-link's focusTarget instead of a second copy", () => {
    expect(clearSrc).toContain("export function focusTarget(");
    expect(src).toContain("focusTarget");
    expect(src).not.toContain("document.getElementById");
    expect(src).not.toContain("document.activeElement");
  });

  it("builds the href with URLSearchParams, never by string concatenation of the word", () => {
    expect(src).toContain("new URLSearchParams");
    expect(src).not.toContain("encodeURIComponent");
    expect(src).not.toContain('"/?q=" +');
    expect(src).not.toContain("`/?q=${word}");
  });

  it("opts every chip out of viewport prefetch", () => {
    expect(src).toContain("prefetch={false}");
    expect(src).toContain("scroll={false}");
  });
});

describe("page.tsx wiring", () => {
  it("imports RelaxedSearchLinks and relaxedSearchWords", () => {
    expect(pageSrc).toContain('import { RelaxedSearchLinks } from "@/components/home/relaxed-search-links";');
    expect(pageSrc).toContain('import { relaxedSearchWords } from "@/lib/search/relaxed-search";');
  });

  it("renders the chips with the feed's id, once, and keeps both ClearSearchLink uses", () => {
    expect(pageSrc.split("<RelaxedSearchLinks words={words} targetId={HOME_FEED_ID} />")).toHaveLength(2);
    expect(pageSrc.split("<ClearSearchLink targetId={HOME_FEED_ID} />")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// h191: in the newest-first order (?sirala=yeni) a chip keeps the order: /?q=word&sirala=yeni. Without it (or with any
// other value) the chip is exactly what it was.
// ---------------------------------------------------------------------------

describe("RelaxedSearchLinks: the newest-first order (h191)", () => {
  it("sort='yeni': every chip keeps sirala=yeni after the word", () => {
    const view = mount(["emekli", "yasası", "a b"], FEED_ID, "yeni");
    expect(view.links().map((l) => l.props.href)).toEqual([
      "/?q=emekli&sirala=yeni",
      "/?q=yasas%C4%B1&sirala=yeni",
      "/?q=a+b&sirala=yeni",
    ]);
  });

  it("no sort, null and an unknown value leave the chips exactly as they were", () => {
    const plain = mount().links().map((l) => l.props.href);
    expect(plain).toEqual(WORDS.map((w) => `/?q=${w}`));
    expect(mount(WORDS, FEED_ID, null).links().map((l) => l.props.href)).toEqual(plain);
    expect(mount(WORDS, FEED_ID, "relevance" as never).links().map((l) => l.props.href)).toEqual(plain);
  });

  it("a word cannot add or override a parameter, with or without the sort", () => {
    const view = mount(["a&sirala=yeni", "b&arsiv=9", "c#d"], FEED_ID, "yeni");
    for (const link of view.links()) {
      const url = new URL(link.props.href, "https://tayf.test");
      expect(url.hash).toBe("");
      expect([...url.searchParams.keys()]).toEqual(["q", "sirala"]);
      expect(url.searchParams.get("sirala")).toBe("yeni");
    }
    const plain = mount(["a&sirala=yeni"]);
    expect([...new URL(plain.links()[0]!.props.href, "https://tayf.test").searchParams.keys()]).toEqual(["q"]);
  });

  it("the chip class, prefetch and scroll are the same in both orders", () => {
    const a = mount(WORDS, FEED_ID, "yeni").links();
    const b = mount().links();
    expect(a.map((l) => l.props.className)).toEqual(b.map((l) => l.props.className));
    for (const link of a) {
      expect(link.props.prefetch).toBe(false);
      expect(link.props.scroll).toBe(false);
    }
  });

  it("page.tsx renders the plain chips element exactly as before for the ranked order and passes sort='yeni' in the other", () => {
    expect(pageSrc.split("<RelaxedSearchLinks words={words} targetId={HOME_FEED_ID} />")).toHaveLength(2);
    expect(pageSrc).toContain('<RelaxedSearchLinks words={words} targetId={HOME_FEED_ID} sort="yeni" />');
  });
});
