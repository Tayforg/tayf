import { describe, it, expect } from "vitest";
import { LabelCard, type ZoneHistoryEntry } from "./label-card";
import type { ReaderAgreement } from "@/lib/game/agreement";

// LabelCard is a synchronous Server Component (plain-data props, no
// Supabase, no hooks) so — same approach as source-chips.test.ts — it can
// be called directly as a function and its returned React element tree
// walked without a DOM. This file is `.test.tsx` per the brief (unlike
// source-chips.test.ts's `.test.ts`), so it IS covered by `tsc --noEmit`
// (tsconfig excludes `**/*.test.ts` but not `**/*.test.tsx`); it contains
// no literal JSX itself so that distinction doesn't otherwise matter here.

interface MinimalNode {
  props?: {
    children?: unknown;
    className?: string;
    href?: string;
  };
}

function isNode(value: unknown): value is MinimalNode {
  return typeof value === "object" && value !== null && "props" in value;
}

function collectText(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === "boolean") {
    return [];
  }
  if (typeof node === "string" || typeof node === "number") {
    return [String(node)];
  }
  if (Array.isArray(node)) {
    return node.flatMap(collectText);
  }
  const maybe = node as MinimalNode;
  if (maybe && typeof maybe === "object" && "props" in maybe) {
    return collectText(maybe.props?.children);
  }
  return [];
}

// Walks the element tree (including the root `node` itself) and returns
// every node — element or child — matching `predicate`.
function findAll(
  node: unknown,
  predicate: (n: MinimalNode) => boolean,
): MinimalNode[] {
  if (node === null || node === undefined || typeof node === "boolean") {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((child) => findAll(child, predicate));
  }
  if (!isNode(node)) return [];
  const self = predicate(node) ? [node] : [];
  return self.concat(findAll(node.props?.children, predicate));
}

const BASE_PROPS = {
  slug: "haberturk",
  bias: "pro_government" as const,
  zoneRationale: null,
  zoneRationaleAt: null,
  trusteeSince: null,
  trusteeNote: null,
  history: [] as ZoneHistoryEntry[],
  readerAgreement: null as ReaderAgreement | null,
};

describe("LabelCard — rationale", () => {
  it("renders the exact honest empty state when zone_rationale is null", () => {
    const el = LabelCard({ ...BASE_PROPS, zoneRationale: null });
    const text = collectText(el).join(" ");
    expect(text).toContain("Gerekçe henüz girilmedi");
  });

  it("renders the exact honest empty state when zone_rationale is an empty string", () => {
    const el = LabelCard({ ...BASE_PROPS, zoneRationale: "" });
    const text = collectText(el).join(" ");
    expect(text).toContain("Gerekçe henüz girilmedi");
  });

  it("renders the exact honest empty state when zone_rationale is whitespace-only", () => {
    const el = LabelCard({ ...BASE_PROPS, zoneRationale: "   " });
    const text = collectText(el).join(" ");
    expect(text).toContain("Gerekçe henüz girilmedi");
  });

  it("renders the rationale text and its formatted date when present", () => {
    const el = LabelCard({
      ...BASE_PROPS,
      zoneRationale: "Sürekli iktidar lehine manşet seçimi.",
      zoneRationaleAt: "2025-03-15T10:00:00Z",
    });
    const text = collectText(el).join(" ");
    expect(text).toContain("Sürekli iktidar lehine manşet seçimi.");
    expect(text).toContain("Son güncelleme: 15.03.2025");
    expect(text).not.toContain("Gerekçe henüz girilmedi");
  });

  it("never fabricates rationale text when none is supplied", () => {
    const el = LabelCard({ ...BASE_PROPS, zoneRationale: null });
    const text = collectText(el).join(" ");
    // Guards against an LLM-filled/synthesised rationale ever sneaking in —
    // the only sentence-shaped rationale text allowed here is the fixed
    // empty-state string itself.
    expect(text).toContain("Gerekçe henüz girilmedi");
    expect(text).not.toMatch(/[a-zçğıöşü]{4,}\s[a-zçğıöşü]{4,}\./i);
  });
});

describe("LabelCard — zone + bias reconciliation", () => {
  it("renders BOTH the zone label and the five-value bias label", () => {
    // pro_government -> iktidar zone: distinct label strings so the
    // assertion can't pass on one alone.
    const el = LabelCard({ ...BASE_PROPS, bias: "pro_government" });
    const text = collectText(el).join(" ");
    expect(text).toContain("İktidar");
    expect(text).toContain("Hükümete Yakın");
  });

  it("reconciles a different bias/zone pair correctly", () => {
    const el = LabelCard({ ...BASE_PROPS, bias: "opposition_leaning" });
    const text = collectText(el).join(" ");
    expect(text).toContain("Muhalefet");
    expect(text).toContain("Muhalefete Meyilli");
  });
});

describe("LabelCard — trustee badge", () => {
  it("renders nothing trustee-shaped when trustee_since is null", () => {
    const el = LabelCard({ ...BASE_PROPS, trusteeSince: null, trusteeNote: null });
    const text = collectText(el).join(" ");
    expect(text).not.toContain("Kayyum");
  });

  it("renders the trustee badge with a dd.mm.yyyy date only when trustee_since is set", () => {
    const el = LabelCard({
      ...BASE_PROPS,
      trusteeSince: "2025-09-11",
      trusteeNote: "TMSF kayyum atandı (Can Holding), 11.09.2025",
    });
    const text = collectText(el).join(" ");
    expect(text).toContain("Kayyum yönetiminde — 11.09.2025");
    expect(text).toContain("TMSF kayyum atandı (Can Holding), 11.09.2025");
  });

  it("never renders an undated 'Kayyum' claim when trustee_since is unparseable", () => {
    // An unparseable trustee_since must never surface as the dangling
    // "Kayyum yönetiminde — " string (an undated kayyum flag against a
    // named company is a new error, not a fact).
    const el = LabelCard({
      ...BASE_PROPS,
      trusteeSince: "not-a-date",
      trusteeNote: "TMSF kayyum atandı (Can Holding), 11.09.2025",
    });
    const text = collectText(el).join(" ");
    expect(text).not.toContain("Kayyum");
  });
});

describe("LabelCard — zone history", () => {
  it("renders the empty state when the history list is empty", () => {
    const el = LabelCard({ ...BASE_PROPS, history: [] });
    const text = collectText(el).join(" ");
    expect(text).toContain("Bu etiket hiç değişmedi.");
  });

  it("renders history rows newest-first with reason and rater when present", () => {
    const history: ZoneHistoryEntry[] = [
      {
        oldBias: "center",
        newBias: "opposition_leaning",
        reason: null,
        rater: null,
        changedAt: "2024-01-05T00:00:00Z",
      },
      {
        oldBias: "opposition_leaning",
        newBias: "opposition",
        reason: "Redaksiyon kararı",
        rater: "editör",
        changedAt: "2025-06-20T00:00:00Z",
      },
    ];
    const el = LabelCard({ ...BASE_PROPS, history });
    const text = collectText(el).join(" ");

    expect(text).toContain("05.01.2024");
    expect(text).toContain("20.06.2025");
    expect(text).toContain("Redaksiyon kararı");
    expect(text).toContain("editör");
    expect(text).not.toContain("Bu etiket hiç değişmedi.");

    // newest-first: the 2025 row's date must appear before the 2024 row's.
    expect(text.indexOf("20.06.2025")).toBeLessThan(text.indexOf("05.01.2024"));
  });

  it("does not invent a reason or rater for an unexplained history row", () => {
    const history: ZoneHistoryEntry[] = [
      {
        oldBias: "center",
        newBias: "opposition_leaning",
        reason: null,
        rater: null,
        changedAt: "2024-01-05T00:00:00Z",
      },
    ];
    const el = LabelCard({ ...BASE_PROPS, history });
    const text = collectText(el).join(" ");
    expect(text).not.toContain("Gerekçe:");
    expect(text).not.toContain("Değerlendiren:");
  });

  it("does not render a leading bare colon for a history row with an unparseable changedAt", () => {
    const history: ZoneHistoryEntry[] = [
      {
        oldBias: "center",
        newBias: "opposition_leaning",
        reason: null,
        rater: null,
        changedAt: "not-a-date",
      },
    ];
    const el = LabelCard({ ...BASE_PROPS, history });
    const texts = collectText(el);
    expect(texts.some((t) => t.trim().startsWith(":"))).toBe(false);
  });
});

describe("LabelCard — owner group", () => {
  it("omits the owner-group block entirely for an untagged slug rather than printing 'bilinmiyor'", () => {
    const el = LabelCard({ ...BASE_PROPS, slug: "bilinmeyen-kaynak-xyz" });
    const text = collectText(el).join(" ");
    expect(text).not.toContain("bilinmiyor");
    expect(text).not.toContain("sınıflandırılmamış");
  });

  it("renders the owner-group label for a tagged slug", () => {
    const el = LabelCard({ ...BASE_PROPS, slug: "haberturk" });
    const text = collectText(el).join(" ");
    expect(text).toContain("Ciner Medya");
  });
});

describe("LabelCard — dispute link", () => {
  it("links to /metodoloji?source=<slug>#duzeltme", () => {
    const el = LabelCard({ ...BASE_PROPS, slug: "haberturk" });
    const [disputeLink] = findAll(
      el,
      (n) => typeof n.props?.href === "string" && n.props.href.includes("#duzeltme"),
    );
    expect(disputeLink).toBeDefined();
    expect(disputeLink?.props?.href).toBe("/metodoloji?source=haberturk#duzeltme");
  });

  it("interpolates the slug for a different source", () => {
    const el = LabelCard({ ...BASE_PROPS, slug: "t24" });
    const [disputeLink] = findAll(
      el,
      (n) => typeof n.props?.href === "string" && n.props.href.includes("#duzeltme"),
    );
    expect(disputeLink?.props?.href).toBe("/metodoloji?source=t24#duzeltme");
  });
});

// U-03 follow-through — the reader-agreement line. Wording is load-bearing:
// it is a *guess share* ("okur tahmini"), never an accuracy claim, and the
// n is always shown next to it.
describe("LabelCard — reader agreement", () => {
  it("renders the honest empty state when there are too few guesses", () => {
    const el = LabelCard({ ...BASE_PROPS, readerAgreement: null });
    const text = collectText(el).join(" ");
    expect(text).toContain("Henüz yeterli tahmin yok");
    expect(text).not.toContain("Okur tahmini");
  });

  it("renders the exact sentence for 30 guesses at a 0.633 share", () => {
    const el = LabelCard({
      ...BASE_PROPS,
      readerAgreement: { n: 30, share: 0.633 },
    });
    const texts = collectText(el);
    expect(texts).toContain("Okur tahmini: %63,3 (30 tahmin)");
    expect(texts.join(" ")).not.toContain("Henüz yeterli tahmin yok");
  });

  it("formats the boundary shares 0 and 1 with a Turkish decimal comma", () => {
    expect(
      collectText(LabelCard({ ...BASE_PROPS, readerAgreement: { n: 30, share: 0 } })),
    ).toContain("Okur tahmini: %0,0 (30 tahmin)");
    expect(
      collectText(LabelCard({ ...BASE_PROPS, readerAgreement: { n: 412, share: 1 } })),
    ).toContain("Okur tahmini: %100,0 (412 tahmin)");
  });

  it("never uses the word 'doğruluk' in either state", () => {
    const withData = collectText(
      LabelCard({ ...BASE_PROPS, readerAgreement: { n: 120, share: 0.51 } }),
    ).join(" ");
    const without = collectText(
      LabelCard({ ...BASE_PROPS, readerAgreement: null }),
    ).join(" ");
    expect(withData.toLocaleLowerCase("tr-TR")).not.toContain("doğruluk");
    expect(without.toLocaleLowerCase("tr-TR")).not.toContain("doğruluk");
  });

  it("sits after the trustee block and before the label history", () => {
    const texts = collectText(
      LabelCard({
        ...BASE_PROPS,
        trusteeSince: "2016-10-29",
        readerAgreement: { n: 30, share: 0.633 },
      }),
    );
    const trustee = texts.findIndex((t) => t.includes("Kayyum yönetiminde"));
    const agreement = texts.findIndex((t) => t.includes("Okur tahmini"));
    const history = texts.findIndex((t) => t.includes("Etiket geçmişi"));
    expect(trustee).toBeGreaterThanOrEqual(0);
    expect(agreement).toBeGreaterThan(trustee);
    expect(history).toBeGreaterThan(agreement);
  });

  it("never leaks an individual guess — only the share and the n", () => {
    const el = LabelCard({
      ...BASE_PROPS,
      readerAgreement: { n: 30, share: 0.633 },
    });
    const text = collectText(el).join(" ");
    expect(text).not.toContain("iktidar tahmini");
    expect(text).not.toContain("0.633");
  });
});
