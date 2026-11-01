"use client";

import { Bookmark } from "lucide-react";
import { track } from "@/lib/track";

import {
  bookmarkChipSuffix,
  bookmarkStoryLabel,
} from "@/components/bookmark/bookmark-label";
import { useBookmarks } from "@/components/bookmark/use-bookmarks";

interface BookmarkButtonProps {
  clusterId: string;
  /**
   * - "chip"    — pill with icon + label, matches ShareButton (detail page)
   * - "overlay" — icon-only circle for card corners. Rendered as a SIBLING
   *   of the card's wrapping <Link> (positioned absolutely by the caller's
   *   className) — never nest it inside the Link, buttons inside anchors
   *   are invalid HTML and break hydration.
   */
  variant?: "chip" | "overlay";
  className?: string;
  /**
   * Title of the story this button saves. Puts the story into the accessible
   * name (WCAG 2.5.3 / 4.1.2), so a feed full of bookmark buttons is not a
   * list of identical "Hikâyeyi kaydet". Without it the name falls back to the
   * generic copy.
   */
  storyTitle?: string | null;
}

export function BookmarkButton({
  clusterId,
  variant = "chip",
  className = "",
  storyTitle = null,
}: BookmarkButtonProps) {
  const { has, toggle } = useBookmarks();
  // Server snapshot is always empty, so SSR/first paint renders "not
  // saved" and the real state pops in after hydration — standard
  // useSyncExternalStore behavior, no hydration mismatch.
  const saved = has(clusterId);

  function handleToggle() {
    track("bookmark", { clusterId, kind: saved ? "remove" : "add" });
    toggle(clusterId);
  }

  // Tooltip only; it follows the state. The accessible name does not.
  const tooltip = saved ? "Kaydedilenlerden çıkar" : "Hikâyeyi kaydet";

  if (variant === "overlay") {
    // Icon-only, so the name is explicit and stays the same in both states;
    // aria-pressed carries whether the story is saved (APG toggle button).
    return (
      <button
        type="button"
        onClick={handleToggle}
        aria-label={bookmarkStoryLabel(storyTitle)}
        aria-pressed={saved}
        title={tooltip}
        className={`inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/60 bg-card/80 backdrop-blur-sm transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:before:absolute max-sm:before:-inset-1 max-sm:before:-m-px max-sm:before:content-[''] ${
          saved ? "text-brand" : "text-muted-foreground hover:text-foreground"
        } ${className}`}
      >
        <Bookmark
          className="h-4 w-4"
          fill={saved ? "currentColor" : "none"}
        />
      </button>
    );
  }

  // Chip: no explicit label. The name is the visible text plus an sr-only
  // story suffix, so it starts with what sighted users read (WCAG 2.5.3).
  const suffix = bookmarkChipSuffix(storyTitle);

  return (
    <button
      type="button"
      onClick={handleToggle}
      aria-pressed={saved}
      className={`inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 hover:bg-muted/70 px-3 py-1.5 text-[11px] font-medium transition-colors max-sm:min-h-11 ${
        saved
          ? "text-brand"
          : "text-muted-foreground hover:text-foreground"
      } ${className}`}
    >
      <Bookmark className="h-3 w-3" fill={saved ? "currentColor" : "none"} />
      <span>{saved ? "Kaydedildi" : "Kaydet"}</span>
      {suffix !== null && <span className="sr-only">{suffix}</span>}
    </button>
  );
}
