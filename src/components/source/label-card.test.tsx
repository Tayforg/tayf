import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LabelCard, ZONE_HISTORY_RECORDED_SINCE, type ZoneHistoryEntry } from "./label-card";
import type { ReaderAgreement } from "@/lib/game/agreement";
import { BIAS_LABELS, ZONE_META, zoneOf } from "@/lib/bias/config";
import {
  FACTUALITY_LABELS,
  SOURCE_METADATA,
  getSourceMetadata,
} from "@/lib/sources/factuality";

// Two fixture slugs the real metadata map has no entry shaped like (no tagged
// source has `factuality: null` today). Every other slug falls through to the
// real map, so the rest of this file still reads the shipped data.
vi.mock("@/lib/sources/factuality", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sources/factuality")>();
  const fixtures: Record<string, import("@/lib/sources/factuality").SourceFactualityMetadata> = {
    "test-null-factuality": {
      factuality: null,
      ownership: "Test Sahibi",
      ownerGroup: "independent",
    },
    "test-factuality-only": {
      factuality: "low",
      ownership: null,
      ownerGroup: null,
    },
  };
  return {
    ...actual,
    getSourceMetadata: (slug: string) => fixtures[slug] ?? actual.getSourceMetadata(slug),
  };
});

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

  // h28-journey-5: bias "opposition" is labelled "Muhalefet" and sits in the
  // Muhalefet zone, so the card used to print the same chip twice.
  it("renders the label once when the bias label equals the zone label", () => {
    const texts = collectText(LabelCard({ ...BASE_PROPS, bias: "opposition" }));

    expect(texts.filter((t) => t === "Muhalefet")).toHaveLength(1);
    expect(texts.join(" ")).not.toContain("Ayrıntılı etiket");
  });

  it("renders both chips, the second with a screen-reader caption, when the labels differ", () => {
    const texts = collectText(LabelCard({ ...BASE_PROPS, bias: "pro_government" }));

    expect(texts).toContain("İktidar");
    expect(texts).toContain("Hükümete Yakın");
    expect(texts).toContain("Ayrıntılı etiket: ");
    // The caption comes right before the five-value label it describes.
    expect(texts.indexOf("Ayrıntılı etiket: ")).toBe(texts.indexOf("Hükümete Yakın") - 1);
  });

  it("hides the caption from sighted readers with sr-only", () => {
    const [caption] = findAll(
      LabelCard({ ...BASE_PROPS, bias: "pro_government" }),
      (n) => n.props?.children === "Ayrıntılı etiket: ",
    );

    expect(caption?.props?.className).toBe("sr-only");
  });

  it("collapses the chip for every bias whose label equals its zone label, and only those", () => {
    const biases = [
      "pro_government",
      "gov_leaning",
      "state_media",
      "islamist_conservative",
      "center",
      "international",
      "pro_kurdish",
      "opposition_leaning",
      "opposition",
      "nationalist",
    ] as const;

    for (const bias of biases) {
      const texts = collectText(LabelCard({ ...BASE_PROPS, bias }));
      const hasCaption = texts.includes("Ayrıntılı etiket: ");
      const zoneLabel = ZONE_META[zoneOf(bias)].label;
      expect(hasCaption, bias).toBe(BIAS_LABELS[bias] !== zoneLabel);
      expect(texts.filter((t) => t === zoneLabel), bias).toHaveLength(1);
    }
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

// h122-sourcepages-3: the empty state used to say "Bu etiket hiç değişmedi." on
// every profile. Label changes have been recorded only since 18 Eylül 2026
// (migration 055 added the trigger; migration 175 states the table is not
// backfilled), and /metodoloji records the 'Bağımsız' -> 'Merkez' rename, so
// "never changed" was a claim the data cannot back. The card now says only that
// no change is on record, and since when changes are recorded.
const EMPTY_HISTORY_SENTENCE =
  "Kayıtlı bir etiket değişikliği yok (etiket değişiklikleri 18 Eylül 2026'dan beri kaydediliyor).";
const HISTORY_UNAVAILABLE_SENTENCE = "Etiket geçmişi şu anda okunamadı.";

describe("LabelCard — zone history", () => {
  it("an empty history says no change is on record and since when changes are recorded", () => {
    const el = LabelCard({ ...BASE_PROPS, history: [] });
    const text = collectText(el).join(" ");
    expect(text).toContain(EMPTY_HISTORY_SENTENCE);
  });

  it("an empty history never claims the label 'hiç değişmedi' (history is recorded only since 18 Eylül 2026)", () => {
    for (const historyUnavailable of [undefined, false, true]) {
      const text = collectText(LabelCard({ ...BASE_PROPS, history: [], historyUnavailable })).join(" ");
      expect(text, String(historyUnavailable)).not.toContain("hiç değişmedi");
    }
  });

  it("names the recording start as ZONE_HISTORY_RECORDED_SINCE = 2026-09-18 and prints it in Turkish long form", () => {
    expect(ZONE_HISTORY_RECORDED_SINCE).toBe("2026-09-18");
    const text = collectText(LabelCard({ ...BASE_PROPS, history: [] })).join(" ");
    expect(text).toContain("18 Eylül 2026'dan beri");
  });

  it("with historyUnavailable the card says the history could not be read, instead of the empty-state sentence", () => {
    const el = LabelCard({ ...BASE_PROPS, history: [], historyUnavailable: true });
    const text = collectText(el).join(" ");
    expect(text).toContain(HISTORY_UNAVAILABLE_SENTENCE);
    expect(text).not.toContain("Kayıtlı bir etiket değişikliği yok");
    expect(text).not.toContain("hiç değişmedi");
  });

  it("historyUnavailable false or absent keeps the empty-state sentence and none of the unavailable one", () => {
    for (const historyUnavailable of [undefined, false]) {
      const text = collectText(LabelCard({ ...BASE_PROPS, history: [], historyUnavailable })).join(" ");
      expect(text, String(historyUnavailable)).toContain(EMPTY_HISTORY_SENTENCE);
      expect(text, String(historyUnavailable)).not.toContain(HISTORY_UNAVAILABLE_SENTENCE);
    }
  });

  it("recorded rows win: with rows present neither the empty-state nor the unavailable sentence renders", () => {
    const history: ZoneHistoryEntry[] = [
      {
        oldBias: "center",
        newBias: "opposition_leaning",
        reason: null,
        rater: null,
        changedAt: "2026-10-05T00:00:00Z",
      },
    ];
    for (const historyUnavailable of [false, true]) {
      const text = collectText(LabelCard({ ...BASE_PROPS, history, historyUnavailable })).join(" ");
      expect(text).toContain("05.10.2026");
      expect(text).not.toContain("Kayıtlı bir etiket değişikliği yok");
      expect(text).not.toContain(HISTORY_UNAVAILABLE_SENTENCE);
    }
  });

  it("the component source no longer contains the unprovable 'hiç değişmedi' claim", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(readFileSync(resolve(here, "label-card.tsx"), "utf8")).not.toContain("hiç değişmedi");
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
    expect(text).not.toContain("hiç değişmedi");
    expect(text).not.toContain("Kayıtlı bir etiket değişikliği yok");
    expect(text).not.toContain(HISTORY_UNAVAILABLE_SENTENCE);

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

  it("does not duplicate the owner name when the group label and ownership string are identical (cnn-turk/demiroren)", () => {
    const el = LabelCard({ ...BASE_PROPS, slug: "cnn-turk" });
    const texts = collectText(el);
    const occurrences = texts.filter((t) => t.includes("Demirören Medya")).length;
    expect(occurrences).toBe(1);
  });

  // h28-journey-5: a bare "Bağımsız" owner line read like the centre zone.
  it("prefixes an independent owner line with 'Sahiplik: ' so it cannot read as the centre zone", () => {
    // Precondition: if evrensel is ever re-tagged, pick another independent slug.
    expect(getSourceMetadata("evrensel")?.ownerGroup).toBe("independent");

    const texts = collectText(LabelCard({ ...BASE_PROPS, slug: "evrensel", bias: "opposition" }));

    expect(texts).toContain("Sahiplik: Bağımsız");
    expect(texts).not.toContain("Bağımsız");
  });

  it("prefixes other owner groups too and keeps the secondary part unchanged", () => {
    const texts = collectText(LabelCard({ ...BASE_PROPS, slug: "haberturk" }));

    const owner = texts.find((t) => t.startsWith("Sahiplik: "));
    expect(owner).toBeDefined();
    expect(owner).toContain("Ciner Medya");
    expect(owner).not.toContain("Sahiplik: Sahiplik: ");
    // One string per primary part: the prefix is not a separate text node.
    expect(texts).not.toContain("Sahiplik: ");
  });

  it("keeps the ' · ' secondary part unchanged after the prefixed primary (trt-haber)", () => {
    const texts = collectText(LabelCard({ ...BASE_PROPS, slug: "trt-haber" }));
    const primaryAt = texts.indexOf("Sahiplik: Devlet medyası (TRT/AA)");

    expect(primaryAt).toBeGreaterThanOrEqual(0);
    expect(texts.slice(primaryAt + 1, primaryAt + 3)).toEqual([" · ", "Devlet (TRT)"]);
    expect(texts.filter((t) => t.startsWith("Sahiplik: "))).toHaveLength(1);
  });

  it("never repeats 'kayyum' twice when the trustee badge is shown (haberturk/can-holding)", () => {
    const el = LabelCard({ ...BASE_PROPS, slug: "haberturk", trusteeSince: "2025-09-11" });
    const texts = collectText(el);
    const kayyumCount = texts.filter((t) => /kayyum/i.test(t)).length;
    expect(kayyumCount).toBeLessThanOrEqual(1);
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
    // An untagged slug: a tagged one prints its hand-tagged factuality label
    // ("... doğruluk") in its own line, which is not the agreement sentence.
    const untagged = { ...BASE_PROPS, slug: "bilinmeyen-kaynak-xyz" };
    const withData = collectText(
      LabelCard({ ...untagged, readerAgreement: { n: 120, share: 0.51 } }),
    ).join(" ");
    const without = collectText(
      LabelCard({ ...untagged, readerAgreement: null }),
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

// h37-content-2: the label exists for an aggregator / niche source (the chips
// stay), but the card says in the open that it does not vote.
describe("LabelCard — non-voting kinds", () => {
  const NOTE_AGGREGATOR = "Toplayıcı kaynak; spektruma ve ilk sıraya sayılmaz.";
  const NOTE_NICHE = "Niş kaynak; spektruma ve ilk sıraya sayılmaz.";

  it("shows the aggregator note right under the chips and above the rationale", () => {
    const texts = collectText(LabelCard({ ...BASE_PROPS, bias: "gov_leaning", kind: "aggregator" }));

    expect(texts).toContain(NOTE_AGGREGATOR);
    expect(texts.indexOf(NOTE_AGGREGATOR)).toBeGreaterThan(texts.indexOf("Hükümete Meyilli"));
    expect(texts.indexOf(NOTE_AGGREGATOR)).toBeLessThan(texts.indexOf("Gerekçe henüz girilmedi"));
  });

  it("keeps the zone and bias chips for a non-voting source (the label exists)", () => {
    const texts = collectText(LabelCard({ ...BASE_PROPS, bias: "gov_leaning", kind: "aggregator" }));

    expect(texts).toContain("İktidar");
    expect(texts).toContain("Hükümete Meyilli");
  });

  it("shows the same line with the niche label for kind niche", () => {
    const texts = collectText(LabelCard({ ...BASE_PROPS, kind: "niche" }));

    expect(texts).toContain(NOTE_NICHE);
    expect(texts).not.toContain(NOTE_AGGREGATOR);
  });

  it("reuses the cluster-page wording verbatim after the kind name", () => {
    const text = collectText(LabelCard({ ...BASE_PROPS, kind: "aggregator" })).join(" ");

    expect(text).toContain("spektruma ve ilk sıraya sayılmaz");
  });

  it("renders no such line for outlet, wire, null or an omitted kind", () => {
    for (const kind of ["outlet", "wire", null, undefined] as const) {
      const text = collectText(LabelCard({ ...BASE_PROPS, kind })).join(" ");
      expect(text, String(kind)).not.toContain("sayılmaz");
      expect(text, String(kind)).not.toContain("Toplayıcı");
      expect(text, String(kind)).not.toContain("Niş kaynak");
    }
  });

  it("leaves every other section as it was (output differs only by the one note)", () => {
    const voting = collectText(LabelCard({ ...BASE_PROPS, kind: "outlet" }));
    const aggregator = collectText(LabelCard({ ...BASE_PROPS, kind: "aggregator" }));

    expect(aggregator.filter((t) => t !== NOTE_AGGREGATOR)).toEqual(voting);
    expect(collectText(LabelCard(BASE_PROPS))).toEqual(voting);
  });
});

// h74-sourcepages-1: /sources cards and every story's Kaynak künyesi print the
// hand-tagged factuality label; the profile used to drop it. The wording says
// in the open that it is an editorial label, and links to /metodoloji.
describe("LabelCard — factuality line", () => {
  const FACTUALITY_HREF = "/metodoloji#guvenilirlik";

  function factualityOf(slug: string) {
    return getSourceMetadata(slug)?.factuality ?? null;
  }

  it("renders the label of a high-factuality slug, derived from the metadata map", () => {
    const factuality = factualityOf("anadolu-ajansi");
    expect(factuality).toBe("high");

    const texts = collectText(LabelCard({ ...BASE_PROPS, slug: "anadolu-ajansi" }));

    expect(texts).toContain(FACTUALITY_LABELS[factuality!]);
    expect(texts).toContain("Yüksek doğruluk");
  });

  it("renders 'Karışık doğruluk' for sozcu", () => {
    const factuality = factualityOf("sozcu");
    expect(factuality).toBe("mixed");

    const texts = collectText(LabelCard({ ...BASE_PROPS, slug: "sozcu", bias: "opposition_leaning" }));

    expect(texts).toContain(FACTUALITY_LABELS[factuality!]);
    expect(texts).toContain("Karışık doğruluk");
    expect(texts).not.toContain("Yüksek doğruluk");
  });

  it("pins the three label strings the chips and the profile share", () => {
    expect(FACTUALITY_LABELS).toEqual({
      high: "Yüksek doğruluk",
      mixed: "Karışık doğruluk",
      low: "Düşük doğruluk",
    });
  });

  it("renders the label of every hand-tagged source, and only that one", () => {
    let checked = 0;
    for (const [slug, meta] of Object.entries(SOURCE_METADATA)) {
      if (meta.factuality === null) continue;
      checked += 1;
      const texts = collectText(LabelCard({ ...BASE_PROPS, slug }));
      const labels = Object.values(FACTUALITY_LABELS);
      expect(texts.filter((t) => labels.includes(t)), slug).toEqual([
        FACTUALITY_LABELS[meta.factuality],
      ]);
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("renders no 'doğruluk' text for an untagged slug (haber3)", () => {
    expect(getSourceMetadata("haber3")).toBeNull();

    const text = collectText(LabelCard({ ...BASE_PROPS, slug: "haber3" })).join(" ");

    expect(text.toLocaleLowerCase("tr-TR")).not.toContain("doğruluk");
    expect(text).not.toContain("nasıl belirleniyor?");
    expect(
      findAll(LabelCard({ ...BASE_PROPS, slug: "haber3" }), (n) => n.props?.href === FACTUALITY_HREF),
    ).toHaveLength(0);
  });

  it("renders no 'doğruluk' text for a tagged entry whose factuality is null", () => {
    // Precondition: the fixture is tagged (the owner line shows) but unrated.
    expect(getSourceMetadata("test-null-factuality")).toEqual({
      factuality: null,
      ownership: "Test Sahibi",
      ownerGroup: "independent",
    });

    const el = LabelCard({ ...BASE_PROPS, slug: "test-null-factuality" });
    const texts = collectText(el);

    expect(texts.some((t) => t.startsWith("Sahiplik: "))).toBe(true);
    expect(texts.join(" ").toLocaleLowerCase("tr-TR")).not.toContain("doğruluk");
    expect(findAll(el, (n) => n.props?.href === FACTUALITY_HREF)).toHaveLength(0);
  });

  it("renders the line even when the entry has no owner group (factuality only)", () => {
    const texts = collectText(LabelCard({ ...BASE_PROPS, slug: "test-factuality-only" }));

    expect(texts).toContain("Düşük doğruluk");
    expect(texts.some((t) => t.startsWith("Sahiplik: "))).toBe(false);
  });

  it("links to /metodoloji#guvenilirlik with 'nasıl belirleniyor?'", () => {
    const links = findAll(
      LabelCard({ ...BASE_PROPS, slug: "anadolu-ajansi" }),
      (n) => n.props?.href === FACTUALITY_HREF,
    );

    expect(links).toHaveLength(1);
    expect(collectText(links[0]).join("")).toBe("nasıl belirleniyor?");
  });

  it("says it is a hand-entered label and not an independent rating", () => {
    const text = collectText(LabelCard({ ...BASE_PROPS, slug: "anadolu-ajansi" })).join("");

    expect(text).toContain(
      "Yüksek doğruluk · elle girilen etiket, bağımsız bir derecelendirme değil · nasıl belirleniyor?",
    );
  });

  it("sits right above the Sahiplik line and after the rationale", () => {
    const texts = collectText(
      LabelCard({
        ...BASE_PROPS,
        slug: "anadolu-ajansi",
        zoneRationale: "Resmi ajans.",
      }),
    );
    const rationale = texts.indexOf("Resmi ajans.");
    const factuality = texts.indexOf("Yüksek doğruluk");
    const owner = texts.findIndex((t) => t.startsWith("Sahiplik: "));

    expect(rationale).toBeGreaterThanOrEqual(0);
    expect(factuality).toBeGreaterThan(rationale);
    expect(owner).toBeGreaterThan(factuality);
    // Nothing but the line's own clause, link text and spacing in between.
    expect(texts.slice(factuality + 1, owner)).toEqual([
      " · elle girilen etiket, bağımsız bir derecelendirme değil · ",
      "nasıl belirleniyor?",
    ]);
  });
});
