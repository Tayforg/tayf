"use client";

import { useId } from "react";
import Link from "next/link";
import { Check, Plus } from "lucide-react";

import { useFollows } from "@/components/follow/use-follows";
import {
  followLabel,
  MAX_FOLLOWS,
  normalizeFollowValue,
  type FollowKind,
} from "@/lib/follows/follows";

interface FollowButtonViewProps {
  followed: boolean;
  /** The list is at MAX_FOLLOWS. Only blocks a NEW follow, never an unfollow. */
  full: boolean;
  onToggle: () => void;
  /**
   * What is being followed ("Ekonomi", "“seçim”"). Becomes the accessible name
   * ("Takip et: Ekonomi") so several buttons on one page are told apart.
   */
  label?: string;
  className?: string;
}

// Presentational half, split out so every state can be rendered without a
// browser (the hook's server snapshot is always "not followed").
export function FollowButtonView({
  followed,
  full,
  onToggle,
  label,
  className = "",
}: FollowButtonViewProps) {
  const blocked = full && !followed;
  const hintId = useId();

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {/* aria-disabled, not disabled: a natively disabled button leaves the tab
          order and its reason (a title) never reaches touch or keyboard users.
          Staying focusable lets the hint below be read and its link reached. */}
      <button
        type="button"
        onClick={blocked ? () => {} : onToggle}
        aria-pressed={followed}
        aria-disabled={blocked || undefined}
        aria-describedby={blocked ? hintId : undefined}
        aria-label={
          label === undefined
            ? undefined
            : `${followed ? "Takip ediliyor" : "Takip et"}: ${label}`
        }
        className={`inline-flex min-h-[44px] touch-manipulation items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 hover:bg-muted/70 px-3 py-1.5 text-[11px] font-medium transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:bg-muted/40 ${
          followed
            ? "text-brand"
            : "text-muted-foreground hover:text-foreground"
        } ${className}`}
      >
        {followed ? (
          <Check className="h-3 w-3" aria-hidden="true" />
        ) : (
          <Plus className="h-3 w-3" aria-hidden="true" />
        )}
        <span>{followed ? "Takip ediliyor" : "Takip et"}</span>
      </button>
      {blocked && (
        <span id={hintId} className="text-[11px] text-muted-foreground">
          {`En fazla ${MAX_FOLLOWS} takip · `}
          <Link
            href="/takip"
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            birini çıkarın
          </Link>
        </span>
      )}
      {followed && (
        <Link
          href="/takip"
          className="inline-flex min-h-[44px] touch-manipulation items-center text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Takip ettiklerim
        </Link>
      )}
    </span>
  );
}

interface FollowButtonProps {
  kind: FollowKind;
  value: string;
  className?: string;
}

export function FollowButton({ kind, value, className }: FollowButtonProps) {
  const { has, toggle, isFull } = useFollows();
  // Server snapshot is always empty, so SSR / first paint renders "Takip et"
  // and the real state pops in after hydration (no hydration mismatch).
  const normalized = normalizeFollowValue(kind, value);
  if (normalized === null) return null;

  return (
    <FollowButtonView
      followed={has(kind, normalized)}
      full={isFull}
      onToggle={() => {
        toggle(kind, normalized);
      }}
      label={followLabel({ kind, value: normalized })}
      className={className}
    />
  );
}
