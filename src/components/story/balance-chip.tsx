import { Scale } from "lucide-react";

import {
  BALANCE_INSUFFICIENT_LABEL,
  balanceAriaLabel,
  type BalanceScore,
  type BalanceTier,
} from "@/lib/bias/balance";

// "Denge puanı" chip: a 0-100 summary of how evenly a cluster's coverage is
// spread over the three Medya DNA zones (see lib/bias/balance.ts for the
// formula and /metodoloji#denge-puani for the reader-facing explanation).
//
// Pure presentational: no hooks, no next/link, so it renders inside the
// ClusterCard Server Component (itself nested in a <Link> -- the chip must
// stay non-interactive) and on the cluster page alike.
//
// Tailwind class strings are literals so the JIT sees them. Text uses full
// tokens only -- opacity-modified text tokens fail WCAG 1.4.3 (see
// tests/guards/text-contrast-tokens.test.ts, which scans this directory).

// Same pill the card's other meta chips use.
const PILL =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium";

const TIER_CLASS: Record<BalanceTier, string> = {
  dengeli: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  yakin: "border-border/40 bg-muted/50 text-muted-foreground",
  tek: "border-border/60 bg-muted/50 text-foreground",
};

const INSUFFICIENT_CLASS =
  "border-dashed border-border/60 text-muted-foreground";

interface BalanceChipProps {
  /** `null` = too few classified sources to score. */
  balance: BalanceScore | null;
  /**
   * `compact` is the card pill ("Denge 72"; renders nothing without a score so
   * thin clusters don't grow a chip on every card). `full` is the cluster-page
   * chip, which also explains a missing score.
   */
  variant: "compact" | "full";
}

export function BalanceChip({ balance, variant }: BalanceChipProps) {
  if (balance === null && variant === "compact") return null;

  const label = balanceAriaLabel(balance);
  const tone = balance === null ? INSUFFICIENT_CLASS : TIER_CLASS[balance.tier];

  let text: string;
  if (balance === null) {
    text = `Denge puanı yok · ${BALANCE_INSUFFICIENT_LABEL}`;
  } else if (variant === "compact") {
    text = `Denge ${balance.score}`;
  } else {
    text = `Denge puanı ${balance.score}/100 · ${balance.label}`;
  }

  return (
    <span role="img" aria-label={label} title={label} className={`${PILL} ${tone}`}>
      <Scale className="h-3 w-3" aria-hidden="true" />
      {text}
    </span>
  );
}
