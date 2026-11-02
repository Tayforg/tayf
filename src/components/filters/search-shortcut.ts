// Decides whether a keydown should move focus to the search box (the global
// "/" shortcut). Pure and DOM-free so it is unit-testable with plain objects;
// SearchBar passes the real KeyboardEvent.
//
// It fires only for a bare "/" typed outside an editable control:
//   - Ctrl / Cmd / Alt + "/" belong to the browser or the OS. Shift is NOT
//     checked: on a Turkish Q keyboard "/" is Shift+7, so excluding it would
//     disable the shortcut for the site's own audience.
//   - an IME composition in progress, or an event another handler already
//     consumed, is left alone.
//   - "/" typed into an input, textarea, select or contenteditable is text.
//     The event target (the focused element), not document.activeElement, is
//     what is checked; the old check only knew about <input>.
//   - a reader who switched single-key shortcuts off (WCAG 2.1.4, see
//     src/lib/a11y/shortcut-pref.ts) gets no "/" shortcut either. The stored
//     preference is read LAST, after every cheap check, so localStorage is
//     touched only for a real "/" keydown. Pass `enabled` to skip the read.

import { readShortcutsEnabled } from "@/lib/a11y/shortcut-pref";

export interface SearchShortcutEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
}

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isSearchShortcut(e: SearchShortcutEvent, enabled?: boolean): boolean {
  if (e.key !== "/") return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.isComposing || e.defaultPrevented) return false;

  const target = e.target;
  if (target !== null && typeof target === "object") {
    const { tagName, isContentEditable } = target as {
      tagName?: unknown;
      isContentEditable?: unknown;
    };
    if (typeof tagName === "string" && TYPING_TAGS.has(tagName.toUpperCase())) {
      return false;
    }
    if (isContentEditable === true) return false;
  }
  return enabled ?? readShortcutsEnabled();
}
