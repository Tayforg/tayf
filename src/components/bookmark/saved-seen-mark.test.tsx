import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// h185-roadmap2-2: opening a saved story's page marks it seen on this device, so the /saved
// "kaydettiğinizden beri yeni gelişme" badge can clear. SavedSeenMark is the one client piece of
// that: it renders nothing, and once the story is known to be bookmarked it calls markStorySeen.
//
// This repo's vitest runs in node with no DOM library and no new dependencies, so the effect is
// driven by a small hook runtime that replaces useEffect while a test is mounted, and the bookmark
// store and the snapshot module are mocked. The same approach as clear-search-link.test.tsx.

const bm = vi.hoisted(() => ({
  saved: new Set<string>(),
  markStorySeen: vi.fn(),
}));

vi.mock("@/components/bookmark/use-bookmarks", () => ({
  useBookmarks: () => ({ has: (id: string) => bm.saved.has(id) }),
}));

vi.mock("@/components/bookmark/bookmark-snapshots", () => ({
  markStorySeen: bm.markStorySeen,
}));

const rt = vi.hoisted(() => {
  interface Slot {
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
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) =>
      rt.state.current
        ? rt.state.current.useEffect(effect, deps)
        : actual.useEffect(effect as never, deps as never),
  };
});

import { SavedSeenMark } from "./saved-seen-mark";

const ID = "6ea8b39a-6ca7-4efe-ab30-71fdf1a2187b";
const OTHER = "1e801e36-0000-4000-8000-000000000001";
// The server's clusters.updated_at of the page copy the reader rendered (never the client clock).
const UPDATED = "2026-11-10T08:00:00.000Z";
const UPDATED_LATER = "2026-11-12T09:30:00.000Z";

beforeEach(() => {
  bm.saved.clear();
  bm.markStorySeen.mockReset();
});

function mount(clusterId = ID, updatedAt = UPDATED) {
  const props = { clusterId, updatedAt };
  const app = new rt.Runtime(() => SavedSeenMark(props));
  app.render();
  return {
    app,
    /** The bookmark store changed (this tab or another one) and the component re-rendered. */
    rerender: () => app.render(),
    setCluster(next: string) {
      props.clusterId = next;
      app.render();
    },
    /** The page re-rendered with a newer server copy of the same story. */
    setUpdatedAt(next: string) {
      props.updatedAt = next;
      app.render();
    },
  };
}

describe("SavedSeenMark", () => {
  it("renders nothing: no element, no layout shift, no live region", () => {
    bm.saved.add(ID);
    const view = mount();
    expect(view.app.outputs).toEqual([null]);
    expect(renderToStaticMarkup(<SavedSeenMark clusterId={ID} updatedAt={UPDATED} />)).toBe("");
  });

  it("does not mark anything on the server render", () => {
    bm.saved.add(ID);
    renderToStaticMarkup(<SavedSeenMark clusterId={ID} updatedAt={UPDATED} />);
    expect(bm.markStorySeen).not.toHaveBeenCalled();
  });

  it("marks the story seen once after mount when it is bookmarked", () => {
    bm.saved.add(ID);
    mount();
    expect(bm.markStorySeen).toHaveBeenCalledTimes(1);
    expect(bm.markStorySeen).toHaveBeenCalledWith(ID, UPDATED);
  });

  it("hands markStorySeen the id and the server stamp of the rendered copy, and nothing else (no clock, no deps)", () => {
    bm.saved.add(ID);
    mount();
    expect(bm.markStorySeen.mock.calls).toEqual([[ID, UPDATED]]);
    expect(bm.markStorySeen.mock.calls[0]).toHaveLength(2);
  });

  it("marks again, with the new stamp, when the same mounted component is handed a newer copy of the story", () => {
    bm.saved.add(ID);
    const view = mount();
    view.rerender();
    expect(bm.markStorySeen).toHaveBeenCalledTimes(1);
    view.setUpdatedAt(UPDATED_LATER);
    expect(bm.markStorySeen.mock.calls).toEqual([
      [ID, UPDATED],
      [ID, UPDATED_LATER],
    ]);
    view.rerender();
    expect(bm.markStorySeen).toHaveBeenCalledTimes(2);
  });

  it("does not mark on a stamp change while the story is not bookmarked", () => {
    const view = mount();
    view.setUpdatedAt(UPDATED_LATER);
    expect(bm.markStorySeen).not.toHaveBeenCalled();
  });

  it("does not mark it again on a re-render while the state is unchanged", () => {
    bm.saved.add(ID);
    const view = mount();
    view.rerender();
    view.rerender();
    expect(bm.markStorySeen).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the story is not bookmarked", () => {
    const view = mount();
    view.rerender();
    expect(bm.markStorySeen).not.toHaveBeenCalled();
  });

  it("ignores other bookmarked stories", () => {
    bm.saved.add(OTHER);
    mount();
    expect(bm.markStorySeen).not.toHaveBeenCalled();
  });

  it("marks again only when the saved state flips false -> true (the first paint reads 'not saved', then the store answers)", () => {
    const view = mount();
    expect(bm.markStorySeen).not.toHaveBeenCalled();
    bm.saved.add(ID);
    view.rerender();
    expect(bm.markStorySeen).toHaveBeenCalledTimes(1);
    view.rerender();
    expect(bm.markStorySeen).toHaveBeenCalledTimes(1);
    // un-saved from the page: no call
    bm.saved.delete(ID);
    view.rerender();
    expect(bm.markStorySeen).toHaveBeenCalledTimes(1);
    // saved again: one more
    bm.saved.add(ID);
    view.rerender();
    expect(bm.markStorySeen).toHaveBeenCalledTimes(2);
    expect(bm.markStorySeen).toHaveBeenLastCalledWith(ID, UPDATED);
  });

  it("marks the new story when the same mounted component is handed another saved cluster", () => {
    bm.saved.add(ID);
    bm.saved.add(OTHER);
    const view = mount();
    view.setCluster(OTHER);
    expect(bm.markStorySeen.mock.calls).toEqual([
      [ID, UPDATED],
      [OTHER, UPDATED],
    ]);
  });

  it("unmounting does not mark or throw", () => {
    bm.saved.add(ID);
    const view = mount();
    expect(() => view.app.unmount()).not.toThrow();
    expect(bm.markStorySeen).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Source pins
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "saved-seen-mark.tsx"), "utf8");
const pageSrc = readFileSync(resolve(here, "..", "..", "app", "cluster", "[id]", "page.tsx"), "utf8");

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

describe("saved-seen-mark.tsx source", () => {
  it('starts with the "use client" directive', () => {
    const head = src.trimStart();
    expect(head.startsWith('"use client"') || head.startsWith("'use client'")).toBe(true);
  });

  it("imports only React, the bookmark store BookmarkButton already ships and the light snapshot module", () => {
    expect(importSpecifiers(src).sort()).toEqual([
      "@/components/bookmark/bookmark-snapshots",
      "@/components/bookmark/use-bookmarks",
      "react",
    ]);
  });

  it("takes the cluster id and the server stamp of the rendered copy, never a count or a member list (the page's wire count is not the snapshot's measure)", () => {
    expect(src).toContain("{ clusterId, updatedAt }: { clusterId: string; updatedAt: string }");
    expect(src).toContain("markStorySeen(clusterId, updatedAt)");
    expect(src).toContain("[saved, clusterId, updatedAt]");
    expect(src).not.toMatch(/Date\.now|new Date|toISOString/);
  });

  it("has no network, tracking or storage surface of its own", () => {
    expect(src).not.toMatch(/\bfetch\s*\(|sendBeacon|XMLHttpRequest|WebSocket/);
    expect(src).not.toMatch(/\btrack\s*\(|supabase|localStorage|sessionStorage|document\.cookie/i);
  });
});

describe("cluster page wiring", () => {
  it("imports SavedSeenMark and mounts it once, with the route id, between the BookmarkButton and the CompareButton", () => {
    expect(pageSrc).toContain('import { SavedSeenMark } from "@/components/bookmark/saved-seen-mark";');
    const tag = "<SavedSeenMark clusterId={id} updatedAt={cluster.updated_at} />";
    expect(pageSrc.split(tag)).toHaveLength(2);
    const at = pageSrc.indexOf(tag);
    expect(pageSrc.indexOf("<BookmarkButton")).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(pageSrc.indexOf("<BookmarkButton"));
    expect(at).toBeLessThan(pageSrc.indexOf("<CompareButton"));
  });
});
