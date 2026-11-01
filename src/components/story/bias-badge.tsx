import type { BiasCategory } from "@/types";
import { BIAS_COLORS, BIAS_LABELS } from "@/lib/bias/config";

// A plain <span> with literal classes, not the shadcn <Badge>. That primitive
// pulls Base UI useRender, class-variance-authority and tailwind-merge into the
// client graph of every route that renders a badge from a "use client" tree
// (saved-list.tsx via bias-spectrum.tsx), which cost ~32 KB of tailwind-merge
// on every public route (h13-weight-2). tests/guards/public-client-weight.test.ts
// keeps the primitive out; bias-badge.test.tsx pins that the classes below equal
// what the merged badge produced, for every bias and both sizes.
//
// The shared part is the outline badge with its conflicts already resolved (the
// outline variant's border/text colours lose to the palette's chip colours, and
// the default size's px/py/text-size lose to the sm size), so no runtime merge
// is needed. Keep every class string literal: Tailwind only emits classes it
// can read as whole tokens in source.
const BADGE_BASE =
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3! [a]:hover:bg-muted [a]:hover:text-muted-foreground";

const BADGE_SIZE = {
  default: "px-2 py-0.5 text-xs",
  sm: "text-[10px] px-1.5 py-0",
} as const;

export function BiasBadge({
  bias,
  size = "default",
}: {
  bias: BiasCategory;
  size?: "sm" | "default";
}) {
  return (
    <span
      className={`${BADGE_BASE} ${BADGE_SIZE[size]} ${BIAS_COLORS[bias].className}`}
    >
      {BIAS_LABELS[bias]}
    </span>
  );
}
