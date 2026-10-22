"use client";

import Link from "next/link";
import { Columns2 } from "lucide-react";

import { useCompareTray } from "@/components/compare/use-compare-tray";
import { normalizeCompareId } from "@/lib/compare/compare-params";
import { COMPARE_TRAY_MAX, trayHref } from "@/lib/compare/compare-tray";

interface CompareButtonProps {
  clusterId: string;
}

// Same chip look as BookmarkButton's "chip" variant, so the two sit together
// in the cluster page's meta row.
const CHIP =
  "inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 hover:bg-muted/70 px-3 py-1.5 text-[11px] font-medium transition-colors text-muted-foreground hover:text-foreground";

// Quiet text-button look for the secondary actions ("Vazgeç" / "Temizle").
const TEXT_BUTTON =
  "text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground";

const HINT_ONE = "Karşılaştırmaya eklendi · ikinci haberi açıp “Karşılaştır”a dokunun";
const HINT_TWO = "İki haber seçildi · karşılaştırmaya hazır";

// Accessibility contract (do not "simplify" back to three separate returns):
//  - ONE wrapper and ONE <button> at a fixed slot in every state. Pressing the
//    button changes the tray, hence the label/handler, but React keeps the DOM
//    node because type and position are unchanged -- so focus stays on the
//    button instead of falling back to <body> when a keyboard or screen-reader
//    user activates "Karşılaştır" / "Vazgeç" / "Temizle".
//  - ONE role="status" live region, mounted in every state (a region inserted
//    together with its text is usually not announced). It carries the visible
//    hint for the one-story state and a screen-reader-only confirmation for the
//    two-story state; when there is nothing to say it is present but empty.
// Slots are fixed by position: [compare link | null] [status] [button].
export function CompareButton({ clusterId }: CompareButtonProps) {
  const { tray, add, remove, clear } = useCompareTray();
  // The route param may be any case; the tray only ever holds lowercase ids.
  const id = normalizeCompareId(clusterId);
  // Server snapshot is an empty tray, so SSR / first paint is always the plain
  // "Karşılaştır" button and the real state pops in after hydration.
  if (!id) return null;

  const inTray = tray.includes(id);
  const full = inTray && tray.length >= COMPARE_TRAY_MAX;
  const href = full ? trayHref(tray) : null;

  let hint = "";
  if (full) hint = HINT_TWO;
  else if (inTray) hint = HINT_ONE;

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {href ? (
        <Link href={href} className={CHIP}>
          <Columns2 className="h-3 w-3" aria-hidden="true" />
          <span>Karşılaştır (2) →</span>
        </Link>
      ) : null}
      <span
        role="status"
        aria-live="polite"
        className={
          // The two-story confirmation is redundant on screen (the link above
          // says it); empty must not take a flex gap either.
          full || !inTray ? "sr-only" : "text-[11px] text-muted-foreground"
        }
      >
        {hint}
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
        <button type="button" onClick={() => add(id)} className={CHIP}>
          <Columns2 className="h-3 w-3" aria-hidden="true" />
          <span>Karşılaştır</span>
        </button>
      )}
    </span>
  );
}
