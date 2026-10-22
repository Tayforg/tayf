"use client";

import Link from "next/link";
import { Check, Plus } from "lucide-react";

import { useFollows } from "@/components/follow/use-follows";
import {
  MAX_FOLLOWS,
  normalizeFollowValue,
  type FollowKind,
} from "@/lib/follows/follows";

interface FollowButtonViewProps {
  followed: boolean;
  /** The list is at MAX_FOLLOWS. Only blocks a NEW follow, never an unfollow. */
  full: boolean;
  onToggle: () => void;
  className?: string;
}

// Presentational half, split out so every state can be rendered without a
// browser (the hook's server snapshot is always "not followed").
export function FollowButtonView({
  followed,
  full,
  onToggle,
  className = "",
}: FollowButtonViewProps) {
  const blocked = full && !followed;

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={followed}
        disabled={blocked}
        title={
          blocked
            ? `En fazla ${MAX_FOLLOWS} takip; /takip sayfasından birini çıkarın.`
            : undefined
        }
        className={`inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 hover:bg-muted/70 px-3 py-1.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-muted/40 ${
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
      {followed && (
        <Link
          href="/takip"
          className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
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
      className={className}
    />
  );
}
