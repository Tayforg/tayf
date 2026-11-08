import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BALANCE_LABELS,
  BALANCE_SHORT_LABELS,
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
const IKI: BalanceScore = {
  score: 63,
  tier: "iki",
  label: BALANCE_LABELS.iki,
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

/** Text nodes only (static markup from our own component; not a sanitizer). */
function visibleText(markup: string): string {
  return [...markup.matchAll(/>([^<]+)</g)].map((m) => m[1]).join("");
}

describe("BalanceChip — compact", () => {
  it("renders an accessible image pill with the short score", () => {
    const markup = render(DENGELI, "compact");

    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Denge puanı 72/100: Dengeli kapsama"');
    expect(markup).toContain('title="Denge puanı 72/100: Dengeli kapsama"');
    expect(markup).toContain("Denge 72 · dengeli");
    expect(markup).toContain("text-sky-800");
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

  // h72-newreader-2: the verdict used to live in colour plus title only
  // (WCAG 1.4.1), so on one page "Denge 75" (Tek tarafa yakın) read as better
  // than "Denge 72" (Dengeli kapsama). The visible text now carries the tier.
  it.each([
    [{ score: 75, tier: "yakin", label: BALANCE_LABELS.yakin, total: 8 }, "Denge 75 · tek tarafa yakın"],
    [{ score: 72, tier: "dengeli", label: BALANCE_LABELS.dengeli, total: 8 }, "Denge 72 · dengeli"],
    [{ score: 63, tier: "iki", label: BALANCE_LABELS.iki, total: 8 }, "Denge 63 · iki tarafa dengeli"],
    [{ score: 30, tier: "tek", label: BALANCE_LABELS.tek, total: 10 }, "Denge 30 · tek tarafta"],
  ] as Array<[BalanceScore, string]>)(
    "prints the tier word in the visible text (%j)",
    (balance, expected) => {
      expect(visibleText(render(balance, "compact"))).toBe(expected);
    },
  );

  it("keeps the full accessible name on the compact chip", () => {
    const markup = render({ score: 75, tier: "yakin", label: BALANCE_LABELS.yakin, total: 8 }, "compact");
    expect(markup).toContain('aria-label="Denge puanı 75/100: Tek tarafa yakın"');
    expect(markup).toContain('title="Denge puanı 75/100: Tek tarafa yakın"');
  });

  it("every tier's compact text includes its short tier word", () => {
    for (const balance of [DENGELI, IKI, YAKIN, TEK]) {
      expect(visibleText(render(balance, "compact"))).toBe(
        `Denge ${balance.score} · ${BALANCE_SHORT_LABELS[balance.tier]}`,
      );
    }
  });
});

describe("BalanceChip — full", () => {
  it("shows the score out of 100 and the tier label", () => {
    const markup = render(TEK, "full");
    expect(markup).toContain("Denge puanı 30/100 · Tek tarafta");
    expect(markup).toContain('aria-label="Denge puanı 30/100: Tek tarafta"');
  });

  it("shows the İki tarafa dengeli label with the score and an accessible name", () => {
    const markup = render(IKI, "full");
    expect(markup).toContain("Denge puanı 63/100 · İki tarafa dengeli");
    expect(markup).toContain('aria-label="Denge puanı 63/100: İki tarafa dengeli"');
    expect(markup).toContain('title="Denge puanı 63/100: İki tarafa dengeli"');
    expect(markup).not.toContain("Tek tarafa yakın");
  });

  it("round-trips an even İktidar 4 / Muhalefet 4 split (4/0/4 -> 63, iki)", () => {
    const balance = balanceFromZoneCounts({ iktidar: 4, bagimsiz: 0, muhalefet: 4 });
    expect(render(balance, "full")).toContain("Denge puanı 63/100 · İki tarafa dengeli");
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
      "border-sky-500/30 bg-sky-500/10 text-sky-800 dark:text-sky-300",
    );
    expect(render(IKI, "full")).toContain(
      "border-sky-500/30 bg-muted/50 text-foreground",
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
      render(IKI, "compact"),
      render(IKI, "full"),
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
