import { afterEach, describe, expect, it, vi } from "vitest";

import { SHORTCUT_PREF_KEY } from "@/lib/a11y/shortcut-pref";
import { isSearchShortcut } from "./search-shortcut";

// h10-a11y-2: the global "/" shortcut used to fire for any "/" keydown whose
// activeElement was not an <input>, so it ate "/" typed into a textarea, a
// select or a contenteditable, fired for Ctrl+/ and Cmd+/ (browser/OS
// shortcuts) and for IME composition. Plain objects only: the predicate reads
// a handful of fields and never touches the DOM.

const body = { tagName: "BODY" };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A window whose localStorage holds the shortcut preference `value`. */
function stubPref(value: string | null) {
  const getItem = vi.fn((k: string) => (k === SHORTCUT_PREF_KEY ? value : null));
  vi.stubGlobal("window", { localStorage: { getItem, setItem: vi.fn() } });
  return getItem;
}

describe("isSearchShortcut", () => {
  it("is true for a plain '/' whose target is the page body", () => {
    expect(isSearchShortcut({ key: "/", target: body })).toBe(true);
  });

  it("is true for a '/' on a link or a button (focus moves to the search box)", () => {
    expect(isSearchShortcut({ key: "/", target: { tagName: "A" } })).toBe(true);
    expect(isSearchShortcut({ key: "/", target: { tagName: "BUTTON" } })).toBe(true);
  });

  it("is true when no target is available", () => {
    expect(isSearchShortcut({ key: "/" })).toBe(true);
    expect(isSearchShortcut({ key: "/", target: null })).toBe(true);
  });

  it("is true with Shift held: on a Turkish Q keyboard '/' is Shift+7", () => {
    const e = { key: "/", shiftKey: true, target: body };
    expect(isSearchShortcut(e)).toBe(true);
  });

  it.each(["metaKey", "ctrlKey", "altKey"] as const)("is false with %s set", (mod) => {
    const e: Parameters<typeof isSearchShortcut>[0] = { key: "/", target: body };
    e[mod] = true;
    expect(isSearchShortcut(e)).toBe(false);
  });

  it("is false while an IME composition is in progress", () => {
    expect(isSearchShortcut({ key: "/", isComposing: true, target: body })).toBe(false);
  });

  it("is false when another handler already consumed the event", () => {
    expect(isSearchShortcut({ key: "/", defaultPrevented: true, target: body })).toBe(false);
  });

  it.each(["INPUT", "TEXTAREA", "SELECT"])("is false when the target is a <%s>", (tagName) => {
    expect(isSearchShortcut({ key: "/", target: { tagName } })).toBe(false);
  });

  it("matches the tag name case-insensitively", () => {
    expect(isSearchShortcut({ key: "/", target: { tagName: "input" } })).toBe(false);
    expect(isSearchShortcut({ key: "/", target: { tagName: "Textarea" } })).toBe(false);
  });

  it("is false when the target is contenteditable", () => {
    expect(
      isSearchShortcut({ key: "/", target: { tagName: "DIV", isContentEditable: true } }),
    ).toBe(false);
  });

  it("is true for a non-editable element that merely has isContentEditable false", () => {
    expect(
      isSearchShortcut({ key: "/", target: { tagName: "DIV", isContentEditable: false } }),
    ).toBe(true);
  });

  it.each(["?", "a", "Enter", "Escape", "", "\\"])("is false for key %j", (key) => {
    expect(isSearchShortcut({ key, target: body })).toBe(false);
  });

  it("does not throw on an odd target (string, number, object without a tagName)", () => {
    expect(isSearchShortcut({ key: "/", target: "body" })).toBe(true);
    expect(isSearchShortcut({ key: "/", target: 42 })).toBe(true);
    expect(isSearchShortcut({ key: "/", target: {} })).toBe(true);
    expect(isSearchShortcut({ key: "/", target: { tagName: 7 } })).toBe(true);
  });

  // h17-a11y-3 (WCAG 2.1.4): readers can switch single-key shortcuts off, and
  // "/" has to honour that too.
  describe("shortcut preference", () => {
    it("is false when shortcuts are explicitly disabled", () => {
      expect(isSearchShortcut({ key: "/", target: body }, false)).toBe(false);
    });

    it("is true when shortcuts are explicitly enabled", () => {
      expect(isSearchShortcut({ key: "/", target: body }, true)).toBe(true);
    });

    it("reads the stored preference by default: '0' turns it off", () => {
      stubPref("0");
      expect(isSearchShortcut({ key: "/", target: body })).toBe(false);
    });

    it("reads the stored preference by default: '1' keeps it on", () => {
      stubPref("1");
      expect(isSearchShortcut({ key: "/", target: body })).toBe(true);
    });

    it("stays on when nothing is stored", () => {
      stubPref(null);
      expect(isSearchShortcut({ key: "/", target: body })).toBe(true);
    });

    it("an explicit argument wins over the stored preference", () => {
      stubPref("0");
      expect(isSearchShortcut({ key: "/", target: body }, true)).toBe(true);
      stubPref("1");
      expect(isSearchShortcut({ key: "/", target: body }, false)).toBe(false);
    });

    it("does not touch storage for keys that are not '/' or already excluded", () => {
      const getItem = stubPref("1");
      isSearchShortcut({ key: "a", target: body });
      isSearchShortcut({ key: "/", ctrlKey: true, target: body });
      isSearchShortcut({ key: "/", target: { tagName: "INPUT" } });
      isSearchShortcut({ key: "/", isComposing: true, target: body });
      expect(getItem).not.toHaveBeenCalled();
    });

    it("reads storage once for a real '/'", () => {
      const getItem = stubPref("1");
      isSearchShortcut({ key: "/", target: body });
      expect(getItem).toHaveBeenCalledTimes(1);
      expect(getItem).toHaveBeenCalledWith(SHORTCUT_PREF_KEY);
    });
  });
});
