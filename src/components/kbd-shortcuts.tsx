"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  PENDING_MS,
  SHORTCUTS,
  SHORTCUTS_HELP_EVENT,
  readShortcutsEnabled,
  resolveShortcut,
  writeShortcutsEnabled,
} from "@/lib/a11y/shortcut-pref";

// Site-wide single-key shortcuts (g h / g b / g s, ? for this help; "/" lives
// in SearchBar) and the help dialog that also holds their off switch
// (h17-a11y-3: WCAG 2.1.4 Character Key Shortcuts, 4.1.2 Name Role Value,
// 2.4.3 Focus Order).
//
// The help is a native <dialog> opened with showModal(): the browser puts it in
// the top layer, makes the rest of the page inert (that is the focus trap),
// names it from the title via aria-labelledby, and closes it on Escape. The
// Base UI dialog in components/ui is deliberately not used: it would drag Base
// UI and tailwind-merge into every page's first-load JS
// (tests/guards/public-client-weight.test.ts, rule R2).

const KBD_CLASS =
  "inline-flex items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]";

interface ShortcutsHelpPanelProps {
  titleId: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

/** The dialog's content. Presentational, so it can be rendered to static markup. */
export function ShortcutsHelpPanel({ titleId, enabled, onToggle }: ShortcutsHelpPanelProps) {
  return (
    <div className="space-y-3">
      <h2 id={titleId} className="text-sm font-semibold">Klavye kısayolları</h2>
      <ul className="space-y-2">
        {SHORTCUTS.map((s) => (
          <li key={s.href} className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{s.label}</span>
            <span className="flex gap-1">
              <kbd className={KBD_CLASS}>{s.keys[0]}</kbd>
              <span className="sr-only"> sonra </span>
              <kbd className={KBD_CLASS}>{s.keys[1]}</kbd>
            </span>
          </li>
        ))}
        <li className="flex items-center justify-between text-xs pt-1 border-t border-border/30">
          <span className="text-muted-foreground">Ara</span>
          <kbd className={KBD_CLASS}>/</kbd>
        </li>
        <li className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Yardım</span>
          <kbd className={KBD_CLASS}>?</kbd>
        </li>
      </ul>
      <label className="flex items-center justify-between gap-3 text-xs">
        Tek tuş kısayolları
        <input
          type="checkbox"
          role="switch"
          checked={enabled}
          onChange={(e) => onToggle(e.currentTarget.checked)}
          className="h-4 w-4 accent-brand"
        />
      </label>
      <p className="text-[11px] text-muted-foreground">
        Kapalıyken g ile başlayan kısayollar, / ve ? tuşları çalışmaz. Bu pencereyi sayfanın
        altındaki “Klavye kısayolları” düğmesiyle yeniden açabilirsiniz.
      </p>
      <form method="dialog">
        <button
          type="submit"
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Kapat
        </button>
      </form>
    </div>
  );
}

export function KbdShortcuts() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(true);
  // Time of the last "g" press; a g-sequence is pending for PENDING_MS after it.
  const pendingRef = useRef<number | null>(null);
  // What had focus when the dialog opened, so closing can hand focus back.
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const openHelp = useCallback(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEnabled(readShortcutsEnabled());
    setOpen(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Keys typed inside the open dialog (the switch, Kapat) are not shortcuts.
      if (e.target instanceof Element && e.target.closest("dialog[open]")) return;

      const pending =
        pendingRef.current !== null && Date.now() - pendingRef.current <= PENDING_MS ? "g" : null;
      pendingRef.current = null;

      // Autofill can dispatch keydown events with no `key`. Only "g", "?" and
      // the second key of a pending sequence can matter, so skip the storage
      // read for everything else.
      const key = typeof e.key === "string" ? e.key : "";
      if (pending === null && key !== "g" && key !== "?") return;

      const target = e.target instanceof HTMLElement ? e.target : null;
      const action = resolveShortcut(
        {
          key,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          isComposing: e.isComposing,
          targetTag: target?.tagName ?? null,
          isContentEditable: target?.isContentEditable ?? false,
        },
        pending,
        readShortcutsEnabled(),
      );

      if (action === null) return;
      if (action === "pending-g") {
        pendingRef.current = Date.now();
        return;
      }
      e.preventDefault();
      if (action === "help") {
        openHelp();
        return;
      }
      router.push(action.href);
    };

    // The footer button asks for the dialog this way, so the off switch stays
    // reachable for readers who never press "?" or who turned shortcuts off.
    const onHelpRequest = () => openHelp();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(SHORTCUTS_HELP_EVENT, onHelpRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(SHORTCUTS_HELP_EVENT, onHelpRequest);
    };
  }, [router, openHelp]);

  // A callback ref, not an effect: showModal() runs the moment the element is
  // attached, and throws if the element is not in the document yet.
  const showOnAttach = useCallback((el: HTMLDialogElement | null) => {
    if (el && !el.open) el.showModal();
  }, []);

  // Fires for Escape and for the Kapat button (form method="dialog") alike.
  const handleClose = useCallback(() => {
    setOpen(false);
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected) opener.focus();
  }, []);

  const handleToggle = useCallback((next: boolean) => {
    writeShortcutsEnabled(next);
    setEnabled(next);
  }, []);

  if (!open) return null;

  return (
    <dialog
      ref={showOnAttach}
      aria-labelledby={titleId}
      onClose={handleClose}
      className="m-auto w-[calc(100%-2rem)] max-w-xs rounded-xl border border-border bg-card p-6 text-foreground shadow-lg backdrop:bg-background/80 backdrop:backdrop-blur-sm"
    >
      <ShortcutsHelpPanel titleId={titleId} enabled={enabled} onToggle={handleToggle} />
    </dialog>
  );
}
