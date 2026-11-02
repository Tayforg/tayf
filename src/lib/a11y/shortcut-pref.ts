// Single-key keyboard shortcuts (g h / g b / g s, ?, and "/" for search) and the
// reader's preference to turn them off (WCAG 2.1.4 Character Key Shortcuts).
//
// Pure and DOM-free so it is unit-testable with plain objects: the preference
// is read and written through a storage-shaped argument that defaults to
// window.localStorage, and resolveShortcut() maps a described key press to an
// action. KbdShortcuts and SearchBar are the only callers; both ship in the
// public first-load bundle, so this module imports nothing.

export const SHORTCUT_PREF_KEY = "tayf:kbd-shortcuts";

/** Fired on window by the footer button; KbdShortcuts opens the help dialog. */
export const SHORTCUTS_HELP_EVENT = "tayf:shortcuts-help";

/** How long the second key of a g-sequence is awaited, in milliseconds. */
export const PENDING_MS = 1000;

// The admin panel intentionally isn't listed here: it's behind a login and
// shouldn't advertise itself to normal visitors via the help dialog. Admins
// can still type /admin directly; with no session they are redirected to
// /admin/login.
export const SHORTCUTS = [
  { keys: ["g", "h"], label: "Ana sayfa", href: "/" },
  { keys: ["g", "b"], label: "Kör noktalar", href: "/blindspots" },
  { keys: ["g", "s"], label: "Kaynaklar", href: "/sources" },
] as const;

/** The two Storage methods the preference needs (also satisfied by test fakes). */
export type ShortcutStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * `undefined` (argument omitted) means "use window.localStorage"; `null` means
 * "no storage available". Resolved inside the caller's try block because the
 * localStorage getter itself throws in some privacy modes.
 */
function resolveStorage(storage: ShortcutStorage | null | undefined): ShortcutStorage | null {
  if (storage !== undefined) return storage;
  return typeof window === "undefined" ? null : window.localStorage;
}

/** True unless the reader switched shortcuts off. Any failure reads as enabled. */
export function readShortcutsEnabled(storage?: ShortcutStorage | null): boolean {
  try {
    const s = resolveStorage(storage);
    if (s === null) return true;
    return s.getItem(SHORTCUT_PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Stores the preference as "1" / "0". Storage failures are swallowed. */
export function writeShortcutsEnabled(enabled: boolean, storage?: ShortcutStorage | null): void {
  try {
    const s = resolveStorage(storage);
    if (s === null) return;
    s.setItem(SHORTCUT_PREF_KEY, enabled ? "1" : "0");
  } catch {
    // storage unavailable (private mode, quota): the switch simply won't persist
  }
}

export interface ShortcutInput {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  targetTag?: string | null;
  isContentEditable?: boolean;
}

export type ShortcutAction = "help" | "pending-g" | { href: string };

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * What a key press means. `pending` is "g" when a g-sequence was started less
 * than PENDING_MS ago. Returns null for anything that is not a shortcut:
 * shortcuts turned off, a held Ctrl / Cmd / Alt (browser and OS shortcuts), an
 * IME composition, or a key typed into an input, textarea, select or
 * contenteditable element. Shift is not checked: "?" needs it on most layouts.
 */
export function resolveShortcut(
  input: ShortcutInput,
  pending: "g" | null,
  enabled: boolean,
): ShortcutAction | null {
  if (!enabled) return null;
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  if (input.isComposing) return null;
  if (input.isContentEditable === true) return null;
  if (typeof input.targetTag === "string" && TYPING_TAGS.has(input.targetTag.toUpperCase())) {
    return null;
  }

  // Autofill and some assistive tools dispatch keydown events with no `key`.
  const key = typeof input.key === "string" ? input.key : "";

  if (pending === "g") {
    const second = key.toLowerCase();
    const match = SHORTCUTS.find((s) => s.keys[1] === second);
    return match ? { href: match.href } : null;
  }

  if (key === "?") return "help";
  if (key === "g") return "pending-g";
  return null;
}
