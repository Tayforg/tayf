import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BALANCE_LABELS,
  balanceFromZoneCounts,
  type BalanceScore,
} from "@/lib/bias/balance";

import { BalanceChip } from "./balance-chip";

// BalanceChip is a synchronous, hookless presentational component, so it
// renders directly with react-dom/server.

const DENGELI: BalanceScore = {
  score: 72,
  tier: "dengeli",
  label: BALANCE_LABELS.dengeli,
  total: 8,
};
const YAKIN: BalanceScore = {
  score: 50,
  tier: "yakin",
  label: BALANCE_LABELS.yakin,
  total: 8,
};
const TEK: BalanceScore = {
  score: 30,
  tier: "tek",
  label: BALANCE_LABELS.tek,
  total: 10,
};

function render(
  balance: BalanceScore | null,
  variant: "compact" | "full",
): string {
  return renderToStaticMarkup(<BalanceChip balance={balance} variant={variant} />);
}

describe("BalanceChip — compact", () => {
  it("renders an accessible image pill with the short score", () => {
    const markup = render(DENGELI, "compact");

    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Denge puanı 72/100: Dengeli kapsama"');
    expect(markup).toContain('title="Denge puanı 72/100: Dengeli kapsama"');
    expect(markup).toContain("Denge 72");
    expect(markup).toContain("text-sky-700");
  });

  it("uses the card's pill base classes", () => {
    const markup = render(DENGELI, "compact");
    expect(markup).toContain(
      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium",
    );
  });

  it("renders nothing when there is no score", () => {
    expect(render(null, "compact")).toBe("");
  });

  it("hides the decorative scale icon from assistive tech", () => {
    expect(render(DENGELI, "compact")).toContain('aria-hidden="true"');
  });

  it("does not repeat the tier label in the short text", () => {
    const markup = render(DENGELI, "compact");
    const visible = markup.replace(/<[^>]*>/g, "");
    expect(visible).toBe("Denge 72");
  });
});

describe("BalanceChip — full", () => {
  it("shows the score out of 100 and the tier label", () => {
    const markup = render(TEK, "full");
    expect(markup).toContain("Denge puanı 30/100 · Tek tarafta");
    expect(markup).toContain('aria-label="Denge puanı 30/100: Tek tarafta"');
  });

  it("explains the missing score when there are too few sources", () => {
    const markup = render(null, "full");
    expect(markup).toContain("Denge puanı yok · Az kaynak");
    expect(markup).toContain("Az kaynak");
    expect(markup).toContain("en az 5 sınıflandırılmış");
    expect(markup).toContain('role="img"');
    expect(markup).toContain("border-dashed");
  });

  it("round-trips a computed score (2/2/2 -> 100)", () => {
    const balance = balanceFromZoneCounts({ iktidar: 2, bagimsiz: 2, muhalefet: 2 });
    expect(render(balance, "full")).toContain("Denge puanı 100/100 · Dengeli kapsama");
  });
});

describe("BalanceChip — tier styling", () => {
  it("gives each tier its own literal class string", () => {
    expect(render(DENGELI, "full")).toContain(
      "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    );
    expect(render(YAKIN, "full")).toContain(
      "border-border/40 bg-muted/50 text-muted-foreground",
    );
    expect(render(TEK, "full")).toContain(
      "border-border/60 bg-muted/50 text-foreground",
    );
    expect(render(null, "full")).toContain(
      "border-dashed border-border/60 text-muted-foreground",
    );
  });

  it("never uses an opacity-modified text token or an opacity utility (contrast guard)", () => {
    const markups = [
      render(DENGELI, "compact"),
      render(DENGELI, "full"),
      render(YAKIN, "compact"),
      render(YAKIN, "full"),
      render(TEK, "compact"),
      render(TEK, "full"),
      render(null, "full"),
    ];
    for (const markup of markups) {
      expect(markup).not.toContain("text-muted-foreground/");
      expect(markup).not.toContain("opacity-");
    }
  });
});
