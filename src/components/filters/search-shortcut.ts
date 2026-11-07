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

// How many SearchBars are listening for "/" right now. SearchBar registers in
// the effect that adds its keydown listener and releases in that effect's
// cleanup. That cleanup runs on unmount AND when Next hides the page in
// <Activity mode="hidden"> (the App Router keeps up to three previous pages
// that way): the DOM, including the <input type="search">, stays in the
// document with display:none while the listener is gone. KbdShortcuts asks
// isSearchBarActive() rather than looking for the input in the DOM, so a hidden
// home page does not make it believe the bar will handle the "/".
let mountedSearchBars = 0;

/** Marks one SearchBar as listening. Call the returned cleanup (idempotent) to release it. */
export function registerSearchBar(): () => void {
  mountedSearchBars += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mountedSearchBars -= 1;
  };
}

/** True while at least one SearchBar is mounted and visible to the router (not hidden in Activity). */
export function isSearchBarActive(): boolean {
  return mountedSearchBars > 0;
}

// "/" on a page that has no search bar (KbdShortcuts, site-wide) sends the
// reader to "/#ara". SearchBar, which owns the element with id="ara", checks
// the hash on mount with this predicate, focuses its input and strips the hash.
// Exact match: "#ARA" or "#ara2" are ordinary anchors and must not steal focus.
export function isSearchArrivalHash(hash: string): boolean {
  return hash === "#ara";
}
