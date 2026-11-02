"use client";

import { SHORTCUTS_HELP_EVENT } from "@/lib/a11y/shortcut-pref";

// Footer button that opens the keyboard-shortcuts dialog (KbdShortcuts listens
// for the event). It makes the off switch for single-key shortcuts reachable
// without knowing the "?" key, and after the shortcuts have been turned off.
// Kept apart from footer.tsx so the footer stays a Server Component; this file
// imports only the event name.
export function ShortcutsHelpButton() {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={() => window.dispatchEvent(new Event(SHORTCUTS_HELP_EVENT))}
      className="text-[11px] text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
    >
      Klavye kısayolları
    </button>
  );
}
