import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Link from "next/link";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// h90-livearia-1: "Aramayı temizle" used to be a plain <Link href="/"> inside
// the empty and unavailable cards. Those cards unmount when the navigation
// commits, so a keyboard user's focused link vanished and focus fell to <body>.
// ClearSearchLink hands focus to the feed container (tabIndex -1) instead.
//
// This repo's vitest runs in node with no DOM library and no new dependencies,
// so the effects are driven by a small hook runtime (useEffect with deps and
// cleanup, useRef) that replaces those two hooks while a test is mounted, and
// the DOM the component touches (document.activeElement / getElementById) is a
// stub. The same approach as route-title-announcer.test.tsx.

const nav = vi.hoisted(() => ({ search: "q=zzqxkv" }));

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

import { ClearSearchLink } from "./clear-search-link";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const FEED_ID = "haber-akisi";

interface FakeDocument {
  activeElement: { tagName: string } | null;
  getElementById: ReturnType<typeof vi.fn>;
}

let feed: { focus: ReturnType<typeof vi.fn> };
let doc: FakeDocument;

beforeEach(() => {
  nav.search = "q=zzqxkv";
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

type LinkProps = {
  href: string;
  scroll: boolean;
  className: string;
  children: string;
  onClick?: unknown;
  onNavigate: (event: { preventDefault: () => void }) => void;
};

function mount(targetId = FEED_ID) {
  const app = new rt.Runtime(() => ClearSearchLink({ targetId }));
  app.render();
  const link = () => {
    const out = app.outputs[app.outputs.length - 1] as { type: unknown; props: LinkProps };
    return out;
  };
  return {
    app,
    link,
    /** What a click on the link does once Link decides to navigate in-app. */
    click: () => link().props.onNavigate({ preventDefault: vi.fn() }),
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

describe("ClearSearchLink: markup", () => {
  it("renders a plain anchor to / labelled 'Aramayı temizle' with the 44 px target", () => {
    const html = renderToStaticMarkup(<ClearSearchLink targetId={FEED_ID} />);
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="/"');
    expect(html).toContain(">Aramayı temizle</a>");
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain("touch-manipulation");
  });

  it("keeps the exact classes the two cards used before", () => {
    const html = renderToStaticMarkup(<ClearSearchLink targetId={FEED_ID} />);
    expect(html).toContain(
      'class="mt-1 inline-flex min-h-[44px] touch-manipulation items-center rounded-full border border-border/60 bg-background px-4 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"',
    );
  });

  it("is a next/link with scroll={false}, so the page does not jump to the top", () => {
    const view = mount();
    expect(view.link().type).toBe(Link);
    expect(view.link().props.href).toBe("/");
    expect(view.link().props.scroll).toBe(false);
    expect(view.link().props.children).toBe("Aramayı temizle");
  });

  it("hangs the pending flag off onNavigate, never onClick (a Cmd/Ctrl-click or new tab must not arm it)", () => {
    const view = mount();
    expect(view.link().props.onClick).toBeUndefined();
    expect(typeof view.link().props.onNavigate).toBe("function");
  });

  it("never prevents the default, so the navigation proceeds", () => {
    const view = mount();
    const preventDefault = vi.fn();
    view.link().props.onNavigate({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("renders on the server without touching document", () => {
    vi.unstubAllGlobals();
    expect(typeof document).toBe("undefined");
    expect(() => renderToStaticMarkup(<ClearSearchLink targetId={FEED_ID} />)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Focus hand-over
// ---------------------------------------------------------------------------

describe("ClearSearchLink: focus hand-over", () => {
  it("click, then q becomes '' while the link is still mounted: focuses the feed once", () => {
    const view = mount();
    view.click();
    expect(feed.focus).not.toHaveBeenCalled();
    view.setSearch("");
    expect(doc.getElementById).toHaveBeenCalledWith(FEED_ID);
    expect(feed.focus).toHaveBeenCalledTimes(1);
    // The flag is spent: a re-render with the same URL does not focus again.
    view.app.render();
    view.setSearch("");
    expect(feed.focus).toHaveBeenCalledTimes(1);
  });

  it("the card holding the link unmounts with the navigation (the usual case): focuses the feed", () => {
    const view = mount();
    view.click();
    // The commit that clears q also removes the card, so the link never sees q === ''.
    view.app.unmount();
    expect(feed.focus).toHaveBeenCalledTimes(1);
  });

  it("does not scroll when it takes focus (scroll={false} keeps the reader where they are)", () => {
    const view = mount();
    view.click();
    view.setSearch("");
    expect(feed.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("stays put while q is still non-empty after the click (a slow navigation)", () => {
    const view = mount();
    view.click();
    view.setSearch("q=baska");
    expect(feed.focus).not.toHaveBeenCalled();
    view.setSearch("");
    expect(feed.focus).toHaveBeenCalledTimes(1);
  });

  it("never moves focus when the link was not clicked (the visitor emptied the box instead)", () => {
    const view = mount();
    view.setSearch("");
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
    view.setSearch("");
    view.app.unmount();
    expect(feed.focus).toHaveBeenCalledTimes(1);
  });

  it("does nothing, and does not throw, when the target element is missing", () => {
    const view = mount("yok");
    view.click();
    expect(() => view.setSearch("")).not.toThrow();
    expect(feed.focus).not.toHaveBeenCalled();
    expect(() => view.app.unmount()).not.toThrow();
  });

  it("leaves focus alone when the visitor is typing in a field", () => {
    const view = mount();
    view.click();
    doc.activeElement = { tagName: "INPUT" };
    view.setSearch("");
    expect(feed.focus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Source pins
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "clear-search-link.tsx"), "utf8");
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

describe("clear-search-link.tsx source", () => {
  it('starts with the "use client" directive', () => {
    const head = src.trimStart();
    expect(head.startsWith('"use client"') || head.startsWith("'use client'")).toBe(true);
  });

  it("keeps the public client graph light: no cn, no tailwind-merge, no ui primitives", () => {
    const specs = importSpecifiers(src).sort();
    expect(specs).toEqual(["./focus-feed-on-page-change", "next/link", "next/navigation", "react"]);
    for (const spec of specs) {
      expect(spec).not.toContain("utils");
      expect(spec).not.toContain("tailwind-merge");
      expect(spec).not.toContain("components/ui");
    }
  });
});

describe("page.tsx wiring", () => {
  it("imports ClearSearchLink and renders it in both cards with the feed's id", () => {
    expect(pageSrc).toContain('import { ClearSearchLink } from "@/components/home/clear-search-link";');
    expect(pageSrc.split("<ClearSearchLink targetId={HOME_FEED_ID} />")).toHaveLength(3);
  });

  it("no longer carries a plain 'Aramayı temizle' link of its own", () => {
    expect(pageSrc).not.toContain("Aramayı temizle");
  });
});
