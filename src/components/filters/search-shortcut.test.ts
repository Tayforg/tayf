import { afterEach, describe, expect, it, vi } from "vitest";

import { SHORTCUT_PREF_KEY } from "@/lib/a11y/shortcut-pref";
import {
  isSearchArrivalHash,
  isSearchBarActive,
  isSearchShortcut,
  registerSearchBar,
} from "./search-shortcut";

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

// h60-forms-4: "/" on a page without the search bar sends the reader to "/#ara";
// the home page's SearchBar recognises that hash on mount and focuses its input.
describe("isSearchArrivalHash", () => {
  it("is true for exactly '#ara'", () => {
    expect(isSearchArrivalHash("#ara")).toBe(true);
  });

  it.each(["", "#", "#ar", "#ARA", "#Ara", "ara", "#ara ", " #ara", "#ara=1", "#arama", "##ara"])(
    "is false for %j",
    (hash) => {
      expect(isSearchArrivalHash(hash)).toBe(false);
    },
  );
});

// react-kbd-activity-hidden-searchbar: Next keeps a page it navigated away from
// in <Activity mode="hidden">. Its DOM stays (display:none) but its effects are
// cleaned up, so the "/" listener of SearchBar is gone while the <input> is
// still in the document. KbdShortcuts therefore asks "is a SearchBar listening
// right now?" instead of "is a search input in the DOM?". Every test releases
// what it registers, so the module-level counter is back at zero afterwards.
describe("registerSearchBar / isSearchBarActive", () => {
  it("is false before any search bar registered", () => {
    expect(isSearchBarActive()).toBe(false);
  });

  it("is true after registerSearchBar() and false once its cleanup ran", () => {
    const off = registerSearchBar();
    expect(isSearchBarActive()).toBe(true);
    off();
    expect(isSearchBarActive()).toBe(false);
  });

  it("returns a cleanup function", () => {
    const off = registerSearchBar();
    expect(typeof off).toBe("function");
    off();
  });

  it("decrements only once when the same cleanup runs twice", () => {
    const first = registerSearchBar();
    const second = registerSearchBar();
    first();
    first();
    // the second bar is still listening: a double cleanup of the first must
    // not have eaten its registration
    expect(isSearchBarActive()).toBe(true);
    second();
    expect(isSearchBarActive()).toBe(false);
  });

  it("needs one cleanup per registration before it reads false", () => {
    const a = registerSearchBar();
    const b = registerSearchBar();
    expect(isSearchBarActive()).toBe(true);
    a();
    expect(isSearchBarActive()).toBe(true);
    b();
    expect(isSearchBarActive()).toBe(false);
  });

  it("can register again after a cleanup (Activity hidden, then revealed)", () => {
    const hidden = registerSearchBar();
    hidden();
    expect(isSearchBarActive()).toBe(false);
    const revealed = registerSearchBar();
    expect(isSearchBarActive()).toBe(true);
    revealed();
    expect(isSearchBarActive()).toBe(false);
  });
});
