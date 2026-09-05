"use client";

import { Bookmark } from "lucide-react";

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
}

export function BookmarkButton({
  clusterId,
  variant = "chip",
  className = "",
}: BookmarkButtonProps) {
  const { has, toggle } = useBookmarks();
  // Server snapshot is always empty, so SSR/first paint renders "not
  // saved" and the real state pops in after hydration — standard
  // useSyncExternalStore behavior, no hydration mismatch.
  const saved = has(clusterId);

  const label = saved ? "Kaydedilenlerden çıkar" : "Hikâyeyi kaydet";

  if (variant === "overlay") {
    return (
      <button
        type="button"
        onClick={() => toggle(clusterId)}
        aria-label={label}
        aria-pressed={saved}
        title={label}
        className={`inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/60 bg-card/80 backdrop-blur-sm transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
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

  return (
    <button
      type="button"
      onClick={() => toggle(clusterId)}
      aria-label={label}
      aria-pressed={saved}
      className={`inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 hover:bg-muted/70 px-3 py-1.5 text-[11px] font-medium transition-colors ${
        saved
          ? "text-brand"
          : "text-muted-foreground hover:text-foreground"
      } ${className}`}
    >
      <Bookmark className="h-3 w-3" fill={saved ? "currentColor" : "none"} />
      <span>{saved ? "Kaydedildi" : "Kaydet"}</span>
    </button>
  );
}
