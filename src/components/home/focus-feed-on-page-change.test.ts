import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isEditableTarget, shouldFocusFeed } from "./focus-feed-on-page-change";

// h17-a11y-4: after a client-side page change of the home pager the feed
// container gets focus (it used to fall to <body>). The decision is a pure
// function so it can be tested without a DOM; the effect itself only reads
// the active element and calls focus().

describe("shouldFocusFeed", () => {
  it("never moves focus on the first render of a document (nothing seen yet)", () => {
    expect(shouldFocusFeed(null, { page: 1, query: "" }, false)).toBe(false);
    expect(shouldFocusFeed(null, { page: 3, query: "" }, false)).toBe(false);
  });

  it("does nothing when neither the page nor the query changed", () => {
    expect(
      shouldFocusFeed({ page: 1, query: "" }, { page: 1, query: "" }, false),
    ).toBe(false);
    expect(
      shouldFocusFeed({ page: 2, query: "ak" }, { page: 2, query: "ak" }, false),
    ).toBe(false);
  });

  it("moves focus when the page changes forwards or backwards", () => {
    expect(
      shouldFocusFeed({ page: 1, query: "" }, { page: 2, query: "" }, false),
    ).toBe(true);
    expect(
      shouldFocusFeed({ page: 2, query: "" }, { page: 1, query: "" }, false),
    ).toBe(true);
    expect(
      shouldFocusFeed({ page: 2, query: "ak" }, { page: 3, query: "ak" }, false),
    ).toBe(true);
  });

  it("leaves focus alone when the query changed too (the search box drops ?page while the user types)", () => {
    expect(
      shouldFocusFeed({ page: 2, query: "" }, { page: 1, query: "ak" }, false),
    ).toBe(false);
    expect(
      shouldFocusFeed({ page: 2, query: "ak" }, { page: 1, query: "akp" }, false),
    ).toBe(false);
  });

  it("leaves focus alone when the user is typing in a field", () => {
    expect(
      shouldFocusFeed({ page: 1, query: "" }, { page: 2, query: "" }, true),
    ).toBe(false);
  });
});

describe("isEditableTarget", () => {
  it("is true for INPUT, TEXTAREA and SELECT", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
  });

  it("is true for a contenteditable element", () => {
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(
      true,
    );
  });

  it("is false for links, plain elements and nothing", () => {
    expect(isEditableTarget({ tagName: "A" })).toBe(false);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: false })).toBe(
      false,
    );
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("FocusFeedOnPageChange (effect wiring)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("react");
    vi.resetModules();
  });

  // Fresh module per test: `lastSeen` is module state by design.
  async function load() {
    vi.resetModules();
    // useEffect runs its callback immediately; the deps array is irrelevant to
    // what this wiring test pins.
    vi.doMock("react", () => ({
      useEffect: (fn: () => void) => {
        fn();
      },
    }));
    return import("./focus-feed-on-page-change");
  }

  function stubDocument(activeElement: unknown) {
    const feed = { focus: vi.fn() };
    const getElementById = vi.fn((id: string) =>
      id === "haber-akisi" ? feed : null,
    );
    vi.stubGlobal("document", { activeElement, getElementById });
    return { feed, getElementById };
  }

  it("returns null (renders nothing)", async () => {
    stubDocument(null);
    const { FocusFeedOnPageChange } = await load();
    expect(
      FocusFeedOnPageChange({ page: 1, query: "", targetId: "haber-akisi" }),
    ).toBeNull();
  });

  it("does not focus on the first load, even on page 2", async () => {
    const { feed } = stubDocument({ tagName: "BODY" });
    const { FocusFeedOnPageChange } = await load();
    FocusFeedOnPageChange({ page: 2, query: "", targetId: "haber-akisi" });
    expect(feed.focus).not.toHaveBeenCalled();
  });

  it("focuses the feed once after a page change, scrolling to it", async () => {
    const { feed } = stubDocument({ tagName: "A" });
    const { FocusFeedOnPageChange } = await load();
    FocusFeedOnPageChange({ page: 1, query: "", targetId: "haber-akisi" });
    FocusFeedOnPageChange({ page: 2, query: "", targetId: "haber-akisi" });
    expect(feed.focus).toHaveBeenCalledTimes(1);
    expect(feed.focus).toHaveBeenCalledWith({ preventScroll: false });
    // A re-run with the same props (a re-render) must not steal focus again.
    FocusFeedOnPageChange({ page: 2, query: "", targetId: "haber-akisi" });
    expect(feed.focus).toHaveBeenCalledTimes(1);
  });

  it("keeps focus in the search box when the page change comes from typing", async () => {
    const { feed } = stubDocument({ tagName: "INPUT" });
    const { FocusFeedOnPageChange } = await load();
    FocusFeedOnPageChange({ page: 2, query: "", targetId: "haber-akisi" });
    FocusFeedOnPageChange({ page: 1, query: "ak", targetId: "haber-akisi" });
    expect(feed.focus).not.toHaveBeenCalled();
  });

  it("does not throw when the target element is missing", async () => {
    stubDocument({ tagName: "A" });
    const { FocusFeedOnPageChange } = await load();
    FocusFeedOnPageChange({ page: 1, query: "", targetId: "yok" });
    expect(() =>
      FocusFeedOnPageChange({ page: 2, query: "", targetId: "yok" }),
    ).not.toThrow();
  });
});

describe("focus-feed-on-page-change.tsx source", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(
    resolve(here, "focus-feed-on-page-change.tsx"),
    "utf8",
  );

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

  it('starts with the "use client" directive', () => {
    const head = src.trimStart();
    expect(
      head.startsWith('"use client"') || head.startsWith("'use client'"),
    ).toBe(true);
  });

  it("imports only react (keeps the public client graph light)", () => {
    expect(importSpecifiers(src)).toEqual(["react"]);
  });

  it("scrolls the feed into view when it takes focus", () => {
    expect(src).toContain("preventScroll: false");
  });
});
