"use client";

import { useState } from "react";
import Link from "next/link";
import { Columns2 } from "lucide-react";

import { useCompareTray } from "@/components/compare/use-compare-tray";
import { normalizeCompareId } from "@/lib/compare/compare-params";
import {
  COMPARE_TRAY_MAX,
  compareHint,
  trayHref,
} from "@/lib/compare/compare-tray";

interface CompareButtonProps {
  clusterId: string;
}

// Same chip look as BookmarkButton's "chip" variant, so the two sit together
// in the cluster page's meta row.
const CHIP =
  "inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 hover:bg-muted/70 px-3 py-1.5 text-[11px] font-medium transition-colors text-muted-foreground hover:text-foreground";

// The chip LOOK stays the bookmark chip's (CHIP above is deliberately not
// edited); this only lifts the tap target to 44px for the compare controls.
const CHIP_TARGET = "min-h-[44px] touch-manipulation";

// Quiet text-button look for the secondary actions ("Vazgeç" / "Temizle").
const TEXT_BUTTON =
  "inline-flex min-h-[44px] items-center px-1 touch-manipulation text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground";

// Spoken after "Vazgeç" / "Temizle" empty the tray: nothing else on screen
// changes, so without these a screen-reader user hears nothing at all.
const NOTICE_WITHDRAWN = "Karşılaştırmadan çıkarıldı";
const NOTICE_CLEARED = "Seçim temizlendi";

interface CompareButtonViewProps {
  clusterId: string;
  tray: readonly string[];
  add: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** Outcome of the reader's last Vazgeç / Temizle; only spoken for an empty tray. */
  notice: string;
}

// Accessibility contract (do not "simplify" back to three separate returns):
//  - ONE wrapper and ONE <button> at a fixed slot in every state. Pressing the
//    button changes the tray, hence the label/handler, but React keeps the DOM
//    node because type and position are unchanged -- so focus stays on the
//    button instead of falling back to <body> when a keyboard or screen-reader
//    user activates "Karşılaştır" / "Vazgeç" / "Temizle".
//  - ONE role="status" live region, mounted in every state (a region inserted
//    together with its text is usually not announced). Its text and whether it
//    is visible come from compareHint(): a visible hint while the reader is
//    building a pair (including the warning that a third pick evicts the
//    first), screen-reader-only confirmations otherwise; when there is nothing
//    to say it is present but empty.
// Slots are fixed by position: [compare link | null] [status] [button].
//
// Hook-free (the tray and notice come in as props) so every state can be
// rendered without a browser; CompareButton below wires the real hook.
export function CompareButtonView({
  clusterId,
  tray,
  add,
  remove,
  clear,
  notice,
}: CompareButtonViewProps) {
  // The route param may be any case; the tray only ever holds lowercase ids.
  const id = normalizeCompareId(clusterId);
  if (!id) return null;

  const inTray = tray.includes(id);
  const full = inTray && tray.length >= COMPARE_TRAY_MAX;
  const href = full ? trayHref(tray) : null;
  const hint = compareHint({ tray, id, notice });

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {href ? (
        <Link href={href} className={`${CHIP} ${CHIP_TARGET}`}>
          <Columns2 className="h-3 w-3" aria-hidden="true" />
          <span>Karşılaştır (2) →</span>
        </Link>
      ) : null}
      <span
        role="status"
        aria-live="polite"
        // A screen-reader-only region takes no flex gap when empty.
        className={hint.srOnly ? "sr-only" : "text-[11px] text-muted-foreground"}
      >
        {hint.text}
      </span>
      {inTray ? (
        <button
          type="button"
          onClick={() => (full ? clear() : remove(id))}
          className={TEXT_BUTTON}
        >
          {full ? "Temizle" : "Vazgeç"}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => add(id)}
          className={`${CHIP} ${CHIP_TARGET}`}
        >
          <Columns2 className="h-3 w-3" aria-hidden="true" />
          <span>Karşılaştır</span>
        </button>
      )}
    </span>
  );
}

export function CompareButton({ clusterId }: CompareButtonProps) {
  const { tray, add, remove, clear } = useCompareTray();
  const [notice, setNotice] = useState("");

  // Server snapshot is an empty tray, so SSR / first paint is always the plain
  // "Karşılaştır" button and the real state pops in after hydration.
  return (
    <CompareButtonView
      clusterId={clusterId}
      tray={tray}
      add={(id) => {
        setNotice("");
        add(id);
      }}
      remove={(id) => {
        setNotice(NOTICE_WITHDRAWN);
        remove(id);
      }}
      clear={() => {
        setNotice(NOTICE_CLEARED);
        clear();
      }}
      notice={notice}
    />
  );
}
