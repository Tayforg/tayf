import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PENDING_MS,
  SHORTCUTS,
  SHORTCUTS_HELP_EVENT,
  SHORTCUT_PREF_KEY,
  readShortcutsEnabled,
  resolveShortcut,
  writeShortcutsEnabled,
} from "./shortcut-pref";

// h17-a11y-3 (WCAG 2.1.4 Character Key Shortcuts): the site-wide single-key
// shortcuts (g h / g b / g s, ?, and "/" for search) had no off switch. The
// preference lives in localStorage and the decision of "what does this key
// press mean" is a pure function, so both are tested here with plain objects.

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("constants", () => {
  it("uses the documented storage key and help event name", () => {
    expect(SHORTCUT_PREF_KEY).toBe("tayf:kbd-shortcuts");
    expect(SHORTCUTS_HELP_EVENT).toBe("tayf:shortcuts-help");
  });

  it("waits one second for the second key of a g-sequence", () => {
    expect(PENDING_MS).toBe(1000);
  });

  it("lists the three g-sequences with Turkish labels", () => {
    expect(SHORTCUTS).toEqual([
      { keys: ["g", "h"], label: "Ana sayfa", href: "/" },
      { keys: ["g", "b"], label: "Kör noktalar", href: "/blindspots" },
      { keys: ["g", "s"], label: "Kaynaklar", href: "/sources" },
    ]);
  });
});

describe("readShortcutsEnabled / writeShortcutsEnabled", () => {
  it("defaults to enabled when nothing is stored", () => {
    expect(readShortcutsEnabled(fakeStorage())).toBe(true);
  });

  it("is false only for the stored value '0'", () => {
    expect(readShortcutsEnabled(fakeStorage({ [SHORTCUT_PREF_KEY]: "0" }))).toBe(false);
  });

  it.each(["1", "", "false", "off", "garbage", "00", " 0"])(
    "is true for the stored value %j",
    (v) => {
      expect(readShortcutsEnabled(fakeStorage({ [SHORTCUT_PREF_KEY]: v }))).toBe(true);
    },
  );

  it("round-trips false and true and stores '0' / '1'", () => {
    const s = fakeStorage();
    writeShortcutsEnabled(false, s);
    expect(s.data.get(SHORTCUT_PREF_KEY)).toBe("0");
    expect(readShortcutsEnabled(s)).toBe(false);
    writeShortcutsEnabled(true, s);
    expect(s.data.get(SHORTCUT_PREF_KEY)).toBe("1");
    expect(readShortcutsEnabled(s)).toBe(true);
  });

  it("reads as enabled when getItem throws", () => {
    const s = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
    };
    expect(readShortcutsEnabled(s)).toBe(true);
  });

  it("does not throw when setItem throws (quota, private mode)", () => {
    const s = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => writeShortcutsEnabled(false, s)).not.toThrow();
  });

  it("treats a null storage as enabled for reads and a no-op for writes", () => {
    expect(readShortcutsEnabled(null)).toBe(true);
    expect(() => writeShortcutsEnabled(false, null)).not.toThrow();
  });

  describe("default storage (window.localStorage)", () => {
    it("reads window.localStorage when no argument is given", () => {
      const fake = fakeStorage({ [SHORTCUT_PREF_KEY]: "0" });
      vi.stubGlobal("window", { localStorage: fake });
      expect(readShortcutsEnabled()).toBe(false);
    });

    it("writes window.localStorage when no storage argument is given", () => {
      const fake = fakeStorage();
      vi.stubGlobal("window", { localStorage: fake });
      writeShortcutsEnabled(false);
      expect(fake.data.get(SHORTCUT_PREF_KEY)).toBe("0");
      expect(readShortcutsEnabled()).toBe(false);
    });

    it("reads as enabled when the localStorage getter itself throws", () => {
      vi.stubGlobal("window", {
        get localStorage(): never {
          throw new Error("SecurityError: access denied");
        },
      });
      expect(readShortcutsEnabled()).toBe(true);
      expect(() => writeShortcutsEnabled(false)).not.toThrow();
    });

    it("reads as enabled when there is no window at all (SSR / node)", () => {
      expect(typeof window).toBe("undefined");
      expect(readShortcutsEnabled()).toBe(true);
      expect(() => writeShortcutsEnabled(false)).not.toThrow();
    });
  });
});

describe("resolveShortcut", () => {
  describe("help", () => {
    it("opens help for '?' with or without Shift", () => {
      expect(resolveShortcut({ key: "?" }, null, true)).toBe("help");
      expect(resolveShortcut({ key: "?", shiftKey: true }, null, true)).toBe("help");
    });
  });

  describe("g-sequences", () => {
    it("starts a sequence on a lowercase 'g'", () => {
      expect(resolveShortcut({ key: "g" }, null, true)).toBe("pending-g");
    });

    it("ignores an uppercase 'G' (Shift+g is not the shortcut)", () => {
      expect(resolveShortcut({ key: "G", shiftKey: true }, null, true)).toBeNull();
      expect(resolveShortcut({ key: "G" }, null, true)).toBeNull();
    });

    it.each([
      ["h", "/"],
      ["b", "/blindspots"],
      ["s", "/sources"],
    ])("resolves g then %s to %s", (key, href) => {
      expect(resolveShortcut({ key }, "g", true)).toEqual({ href });
    });

    it("matches the second key case-insensitively", () => {
      expect(resolveShortcut({ key: "H" }, "g", true)).toEqual({ href: "/" });
      expect(resolveShortcut({ key: "B", shiftKey: true }, "g", true)).toEqual({
        href: "/blindspots",
      });
    });

    it("returns null for an unknown second key or a '?' after g", () => {
      expect(resolveShortcut({ key: "x" }, "g", true)).toBeNull();
      expect(resolveShortcut({ key: "?" }, "g", true)).toBeNull();
      expect(resolveShortcut({ key: "g" }, "g", true)).toBeNull();
    });

    it("returns null for h, b and s when no g is pending", () => {
      for (const key of ["h", "b", "s"]) {
        expect(resolveShortcut({ key }, null, true)).toBeNull();
      }
    });
  });

  describe("unrelated keys", () => {
    it.each(["a", "/", "Escape", "Enter", "Tab", " ", "1", "", "Dead"])(
      "returns null for key %j",
      (key) => {
        expect(resolveShortcut({ key }, null, true)).toBeNull();
      },
    );
  });

  describe("malformed events", () => {
    it("returns null, without throwing, when the event has no key (autofill)", () => {
      const noKey = { key: undefined as unknown as string };
      expect(resolveShortcut(noKey, null, true)).toBeNull();
      expect(resolveShortcut(noKey, "g", true)).toBeNull();
    });
  });

  describe("shortcuts turned off", () => {
    it("returns null for '?', 'g' and a pending g + h", () => {
      expect(resolveShortcut({ key: "?" }, null, false)).toBeNull();
      expect(resolveShortcut({ key: "g" }, null, false)).toBeNull();
      expect(resolveShortcut({ key: "h" }, "g", false)).toBeNull();
    });
  });

  describe("modifiers", () => {
    it.each(["ctrlKey", "metaKey", "altKey"] as const)(
      "returns null for '?', 'g' and pending g + h with %s held",
      (mod) => {
        expect(resolveShortcut({ key: "?", [mod]: true }, null, true)).toBeNull();
        expect(resolveShortcut({ key: "g", [mod]: true }, null, true)).toBeNull();
        expect(resolveShortcut({ key: "h", [mod]: true }, "g", true)).toBeNull();
      },
    );
  });

  describe("IME composition", () => {
    it("returns null while a composition is in progress", () => {
      expect(resolveShortcut({ key: "?", isComposing: true }, null, true)).toBeNull();
      expect(resolveShortcut({ key: "g", isComposing: true }, null, true)).toBeNull();
      expect(resolveShortcut({ key: "h", isComposing: true }, "g", true)).toBeNull();
    });
  });

  describe("typing targets", () => {
    it.each(["INPUT", "TEXTAREA", "SELECT", "input", "Textarea", "select"])(
      "returns null when the target is <%s>",
      (targetTag) => {
        expect(resolveShortcut({ key: "?", targetTag }, null, true)).toBeNull();
        expect(resolveShortcut({ key: "g", targetTag }, null, true)).toBeNull();
        expect(resolveShortcut({ key: "h", targetTag }, "g", true)).toBeNull();
      },
    );

    it("returns null when the target is contenteditable", () => {
      const input = { targetTag: "DIV", isContentEditable: true };
      expect(resolveShortcut({ key: "?", ...input }, null, true)).toBeNull();
      expect(resolveShortcut({ key: "g", ...input }, null, true)).toBeNull();
      expect(resolveShortcut({ key: "h", ...input }, "g", true)).toBeNull();
    });

    it.each(["A", "BUTTON", "BODY", null])("allows the shortcuts on target %j", (targetTag) => {
      expect(resolveShortcut({ key: "?", targetTag }, null, true)).toBe("help");
      expect(resolveShortcut({ key: "g", targetTag }, null, true)).toBe("pending-g");
      expect(resolveShortcut({ key: "h", targetTag }, "g", true)).toEqual({ href: "/" });
    });

    it("allows the shortcuts when the target is not editable", () => {
      expect(
        resolveShortcut({ key: "?", targetTag: "DIV", isContentEditable: false }, null, true),
      ).toBe("help");
    });
  });
});
