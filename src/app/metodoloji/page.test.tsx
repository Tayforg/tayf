import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";

vi.mock("@/components/story/correction-form", () => ({
  CorrectionForm: () => null,
}));

// Mutable per-test status, mirrored via a `let` (like the rss.xml test
// suite) so each test can pick its own neutralized/eligible/null shape.
// Default mirrors production reality today: zero clusters neutralized.
let mockNeutralStatus: { neutralized: number; eligible: number } | null = {
  neutralized: 0,
  eligible: 12,
};

vi.mock("@/lib/headline/status", () => ({
  getNeutralizedStatus: vi.fn(async () => mockNeutralStatus),
}));

// The slugs of the ACTIVE sources, as registry-query's cached read returns
// them (null when that read failed). Mutable per test, same shape as above.
let mockActiveSlugs: string[] | null = ["sabah", "anadolu-ajansi", "bilinmeyen-kaynak"];

vi.mock("@/lib/sources/registry-query", () => ({
  getActiveSourceSlugs: vi.fn(async () => mockActiveSlugs),
}));

// Per-test extra registry entries on top of the real SOURCE_METADATA (none of the
// hand-tagged slugs is "ownership only" today, so that branch needs a fake one).
// Passthrough for every other slug, so the real table still drives the page.
let mockExtraMetadata: Record<string, SourceFactualityMetadata> = {};

vi.mock("@/lib/sources/factuality", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sources/factuality")>();
  return {
    ...actual,
    getSourceMetadata: (slug: string) =>
      mockExtraMetadata[slug] ?? actual.getSourceMetadata(slug),
  };
});

import {
  BIAS_LABELS,
  BIAS_TO_ZONE,
  BLINDSPOT,
  SURPRISE,
  ZONE_META,
} from "@/lib/bias/config";
import { WRITABLE_SOURCE_BIAS } from "@/lib/validation/source-input";
import {
  BALANCE_BALANCED_MAX_SHARE,
  BALANCE_BALANCED_MIN,
  BALANCE_LABELS,
  BALANCE_MIN_SOURCES,
  BALANCE_ONE_SIDED_MAX,
  BALANCE_TWO_ZONE_MIN_SHARE,
} from "@/lib/bias/balance";
import { WIRE_UNIQUE_HASH_RATIO } from "@/lib/clusters/wire";
import { BLINDSPOT_LIST_FILTERS } from "@/lib/clusters/blindspot-feed";
import {
  BLINDSPOT_LIST_LOOKBACK_DAYS,
  DEFAULT_PICK_SIZE,
} from "@/lib/clusters/blindspot-pick";
import {
  FEED_HEALTH_MAX_AGE_MS,
  FEED_HEALTH_MIN_SHARE,
  FEED_HEALTH_MIN_YIELD_SHARE,
  FEED_YIELD_WINDOW_MS,
} from "@/lib/clusters/feed-health";
import { RECALL_VETO_MIN_PROB } from "@/lib/clusters/recall-veto";
import { SIBLING_VETO } from "@/lib/clusters/sibling-veto";
import {
  NEAR_BLINDSPOT_DISPLAY_LIMIT,
  NEAR_BLINDSPOT_LOOKBACK_DAYS,
  NEAR_BLINDSPOT_MIN_SHARE,
} from "@/lib/clusters/near-blindspot-rule";
import {
  KARNE_MIN_CLUSTERS,
  KARNE_MIN_MULTI_FOR_ZONES,
  KARNE_STALE_AFTER_HOURS,
  KARNE_WINDOW_DAYS,
} from "@/lib/sources/karne";
import { countClassifiedSources } from "@/lib/sources/classification";
import { getSourceMetadata, type SourceFactualityMetadata } from "@/lib/sources/factuality";
import { OPINION_PATH_SEGMENTS } from "@/lib/articles/opinion-url";
import {
  ENGLISH_ONLY_EMPTY_COLUMN,
  ENGLISH_SOURCE_SLUGS,
} from "@/lib/sources/source-language";
import { OWNER_GROUPS } from "@/lib/sources/ownership";
import {
  EXTRACTIVE_MIN_ARTICLE_COUNT,
  HEADLINE_MIN_ARTICLE_COUNT,
  HEADLINE_PROMPT_TEMPLATE,
} from "@/lib/headline/prompt";

function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { children?: ReactNode } };
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

/** Collects every `href` prop found anywhere in a React element tree. */
function collectHrefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { href?: unknown; children?: ReactNode } };
    if (typeof el.props?.href === "string") out.push(el.props.href);
    if (el.props?.children !== undefined) collectHrefs(el.props.children, out);
  }
  return out;
}

/** Collects every `id` prop found anywhere in a React element tree. */
function collectIds(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectIds(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { id?: unknown; children?: ReactNode } };
    if (typeof el.props?.id === "string") out.push(el.props.id);
    if (el.props?.children !== undefined) collectIds(el.props.children, out);
  }
  return out;
}

/**
 * Walks every prop (className, href, children text, etc.) of every element
 * in the tree and collects every string value found, recursing into nested
 * elements and arrays. Unlike `collectText`, this also sees strings that
 * were passed through a prop (e.g. a `PageHero subtitle`) rather than
 * rendered as a JSX child.
 */
function collectStringProps(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectStringProps(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: Record<string, unknown> };
    if (el.props && typeof el.props === "object") {
      for (const value of Object.values(el.props)) {
        if (typeof value === "string") {
          out.push(value);
        } else if (value && typeof value === "object") {
          collectStringProps(value, out);
        }
      }
    }
  }
  return out;
}

describe("/metodoloji page", () => {
  beforeEach(() => {
    mockNeutralStatus = { neutralized: 0, eligible: 12 };
    mockActiveSlugs = ["sabah", "anadolu-ajansi", "bilinmeyen-kaynak"];
    mockExtraMetadata = {};
  });

  it("renders every bias-zone contract number and label from the shared config", async () => {
    const { default: MethodologyPage } = await import("./page");
    const tree = await MethodologyPage();
    const text = collectText(tree).join("");

    // Assert the interpolated phrasing, not bare digits — a bare-digit
    // assertion (e.g. `toContain("5")`) would still pass if the prose used
    // a hardcoded literal instead of the contract constant.
    expect(text).toContain(`en az ${BLINDSPOT.minSources} kaynak yer almalı`);
    expect(text).toContain(`≥ %${Math.round(BLINDSPOT.dominantShare * 100)}`);
    expect(text).toContain(`${BLINDSPOT.feedDelayHours} saat sonra`);

    expect(text).toContain(`en az ${SURPRISE.minSources} kaynak`);
    expect(text).toContain(`≥ %${Math.round(SURPRISE.dominantShare * 100)}`);
    expect(text).toContain(`${SURPRISE.minMargin} fazla`);

    expect(text).toContain(`≤ %${Math.round(WIRE_UNIQUE_HASH_RATIO * 100)}`);
    // The cron gates on clusters.article_count (member articles), not on distinct outlets.
    expect(text).toContain(`En az ${HEADLINE_MIN_ARTICLE_COUNT} haberi olan kümeler için`);
    expect(text).toContain(`en az ${EXTRACTIVE_MIN_ARTICLE_COUNT} haberi olan kümeler için`);
    expect(text).not.toContain("kaynağı olan kümeler için");

    // Only the biases production can store are documented (h43-sources-1):
    // the other five BiasCategory labels must NOT be on the page.
    for (const bias of WRITABLE_SOURCE_BIAS) {
      expect(text).toContain(BIAS_LABELS[bias]);
    }
    for (const zone of Object.values(ZONE_META)) {
      expect(text).toContain(zone.label);
    }
    for (const group of Object.values(OWNER_GROUPS)) {
      expect(text).toContain(group);
    }

    expect(text).toContain(HEADLINE_PROMPT_TEMPLATE);

    // Stale-literal regression guard: this threshold used to be spelled
    // out as a word instead of interpolated from BLINDSPOT.minSources.
    expect(text).not.toMatch(/Beş kaynak/);

    // Source-kind sentence: aggregator/niche kinds are cluster members but
    // never vote in the spectrum, blindspot or surprise calculations.
    expect(text).toContain(
      "yanlılık dağılımına, kör nokta ve sürpriz hesaplarına sayılmaz",
    );
    expect(collectHrefs(tree)).toContain("/sources");
    expect(collectHrefs(tree)).toContain("/gelistirici");
  });

  it("says the Kör nokta label waits BLINDSPOT.feedDelayHours on cards (the saved list included, no exception), the story page, the weekly summary and the list, and that the stored flag is immediate (h37-content-1, h38-saved-1)", async () => {
    const { default: MethodologyPage } = await import("./page");
    const tree = await MethodologyPage();
    const text = collectText(tree).join("");

    expect(text).toContain(
      `Bir küme eşikleri geçtiğinde bile, karşı tarafa yetişme fırsatı tanımak için “Kör nokta” etiketi kartlarda, haber sayfasında, haftalık özette ve Kör Noktalar listesinde ilk yayından ${BLINDSPOT.feedDelayHours} saat sonra görünür — veritabanındaki işaretleme anlıktır.`,
    );
    // /saved waits too since migration 158 (saved_clusters_v3 returns first_published): the h37 exception is gone.
    expect(text).not.toContain("Kaydedilenler listesi hariç");
    expect(text).not.toContain("(Kaydedilenler");
    // The old wording promised the wait only for the list.
    expect(text).not.toContain("gecikme sadece herkese açık listeleme içindir");
  });

  it("explains the blindspot recall veto (migration 071) with the threshold from the shared module", async () => {
    const { default: MethodologyPage } = await import("./page");
    const tree = await MethodologyPage();
    const text = collectText(tree).join("");

    expect(text).toContain("aynı olayı bazen iki ayrı kümeye böler");
    expect(text).toContain(`(Jev ile, olasılık ≥ %${Math.round(RECALL_VETO_MIN_PROB * 100)})`);
    expect(text).toContain("o kümede kör nokta işareti gösterilmez");
    expect(text).toContain(
      "Kör nokta doğrulaması: karşı taraftan aynı olayı anlatan haber bulunan kümelerde kör nokta işareti artık gösterilmiyor.",
    );
  });

  it("explains the sibling-headline veto (migration 126) with the numbers from SIBLING_VETO, right after the Jev paragraph", async () => {
    const { default: MethodologyPage } = await import("./page");
    const tree = await MethodologyPage();
    const text = collectText(tree).join("");

    // "en az yarısı" is the word form of minJaccard; pin the number it stands for.
    expect(SIBLING_VETO.minJaccard).toBe(0.5);
    // the rare tier's numbers, spelled once so a change to a constant shows up here too
    expect(SIBLING_VETO.looseMinJaccard).toBe(0.3);
    expect(SIBLING_VETO.rareMaxDocShare).toBe(0.0025);
    expect(SIBLING_VETO.rareMinShared).toBe(2);
    expect(SIBLING_VETO.looseMinShared).toBe(3);
    const sentences = [
      "Aynı olay bazen neredeyse aynı başlıkla ikinci bir kümeye düşer.",
      // h62-methodology-1: since 2026-11-02 (migration 148) the search also covers
      // voting-source articles that sit in no cluster; the old "diğer kümelerde" is gone.
      `Bu yüzden ${SIBLING_VETO.windowHours} saat içinde yayımlanmış oy veren kaynak (haber kuruluşu ya da ajans) haberleri arasında, başka bir kümede yer alanlar da hiçbir kümeye girmemiş olanlar da dahil, başlığı büyük ölçüde örtüşenler de aranır (kümeleyici yalnızca politika ve son dakika haberlerini aldığından, karşı tarafın dünya, genel ya da yaşam kategorisinde verdiği haber çoğu zaman hiçbir kümede değildir): iki başlığın kelime kökleri karşılaştırılır (${SIBLING_VETO.tokenMinLen} harften kısa kelimeler sayılmaz, kök = kelimenin ilk ${SIBLING_VETO.stemLen} harfi); ortak köklerin sayısı en az ${SIBLING_VETO.minShared} olmalı ve iki başlıktaki tüm köklerin (ortak olanlar bir kez sayılır) en az yarısını oluşturmalı.`,
      // h85-blindspotprecision-1 (migration 180): the rare-stem tier, every number from SIBLING_VETO.
      `Ortak köklerin payı yarıdan azsa da en az %${Math.round(SIBLING_VETO.looseMinJaccard * 100)} ise ve iki başlık, aranan haberlerin başlıklarının en çok %${(SIBLING_VETO.rareMaxDocShare * 100).toLocaleString("tr-TR")}'inde geçen en az ${SIBLING_VETO.rareMinShared} seyrek kökü paylaşıyorsa (ortak köklerin sayısı yine en az ${SIBLING_VETO.looseMinShared} olmalı) haberler yine aynı olay sayılır.`,
      "Bu haberleri veren kaynaklar da sayıma eklenir; baskınlık eşiği artık tutmuyorsa kör nokta işareti yine gösterilmez.",
    ];
    for (const sentence of sentences) expect(text).toContain(sentence);
    expect(text).toContain(sentences.join(" "));
    expect(text).toContain("hiçbir kümeye girmemiş olanlar da dahil");
    expect(text).not.toContain("bulunmasınlar");
    expect(text).toContain("politika ve son dakika");
    // The pre-148 wording searched other clusters only.
    expect(text).not.toContain("saat içindeki diğer kümelerde");
    expect(SIBLING_VETO.windowHours).toBe(24);

    // Placement: inside #kor-nokta, after the Jev paragraph, before "Kör noktaya yakın".
    const section = collectText(
      findElement(tree, (el) => el.type === "section" && el.props?.["aria-labelledby"] === "kor-nokta"),
    ).join("");
    const jev = section.indexOf("o kümede kör nokta işareti gösterilmez.");
    const sibling = section.indexOf(sentences[0] as string);
    const near = section.indexOf("Kör noktaya yakın");
    expect(jev).toBeGreaterThan(0);
    expect(sibling).toBeGreaterThan(jev);
    expect(near).toBeGreaterThan(sibling);
  });

  it("lists the 2026-11-07 CHANGELOG entry first and the footer reads that date (h62-methodology-2)", async () => {
    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    const tail = text.slice(text.indexOf("Son güncelleme:"));
    expect(tail.startsWith("Son güncelleme: 2026-11-07")).toBe(true);
    expect(/Son güncelleme: (\d{4}-\d{2}-\d{2})/.exec(tail)?.[1]).toBe("2026-11-07");
    // The first list item: its date directly precedes its text, and the footer
    // is not left on the date of the previous newest entry (2026-11-05).
    expect(tail).toContain("2026-11-07 Denge puanı:");
    expect(tail.startsWith("Son güncelleme: 2026-11-05")).toBe(false);
    expect(tail.indexOf("2026-11-07 Denge puanı:")).toBeLessThan(
      tail.indexOf("2026-11-06 Köşe yazıları:"),
    );
  });

  it("keeps the feed-delay CHANGELOG entry, dated 2026-11-05, with no exception for the saved list (h37-content-1)", async () => {
    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    const entry = `Kör nokta etiketi artık kartlarda, haber sayfasında ve haftalık özette de ilk yayından ${BLINDSPOT.feedDelayHours} saat sonra görünüyor; daha önce bu bekleme yalnızca Kör Noktalar listesi içindi.`;
    expect(text).toContain(entry);
    // The entry carries no exception for the saved list any more (h38-saved-1).
    expect(entry).not.toContain("Kaydedilenler");
    const tail = text.slice(text.indexOf("Son güncelleme:"));
    expect(tail).toContain(`2026-11-05 ${entry}`);
    // It comes before the 2026-11-02 and 2026-11-01 sibling-veto entries.
    expect(tail.indexOf(entry)).toBeLessThan(tail.indexOf("Kör nokta doğrulaması genişledi:"));
  });

  it("lists the sibling-veto CHANGELOG entry after the feed-delay and unclustered-arm entries, dated 2026-11-01", async () => {
    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    const entry =
      "Kör nokta doğrulaması genişledi: aynı olayı neredeyse aynı başlıkla veren kardeş bir kümede karşı taraf da varsa kör nokta işareti gösterilmiyor.";
    expect(text).toContain(entry);
    const tail = text.slice(text.indexOf("Son güncelleme:"));
    // The entry's date directly precedes its text.
    expect(tail).toContain(`2026-11-01 ${entry}`);
    const dates = tail.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    // footer, then the 2026-11-07, 2026-11-06 (h62-methodology-2), 2026-11-05 and
    // 2026-11-02 (h62-methodology-1) entries, then this one.
    expect(dates.slice(0, 6)).toEqual([
      "2026-11-07",
      "2026-11-07",
      "2026-11-06",
      "2026-11-05",
      "2026-11-02",
      "2026-11-01",
    ]);
    expect(tail.indexOf(entry)).toBeLessThan(
      tail.indexOf("Kör noktaya yakın: kör nokta eşiğinin hemen altında"),
    );
  });

  it("shows the mailto link only when NEXT_PUBLIC_CONTACT_EMAIL is set", async () => {
    const original = process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    vi.resetModules();
    const { default: WithoutEmail } = await import("./page");
    expect(collectText(await WithoutEmail()).join("")).not.toContain("@");

    process.env.NEXT_PUBLIC_CONTACT_EMAIL = "duzeltme@tayfhaber.com";
    vi.resetModules();
    const { default: WithEmail } = await import("./page");
    expect(collectText(await WithEmail()).join("")).toContain(
      "duzeltme@tayfhaber.com",
    );

    if (original === undefined) {
      delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    } else {
      process.env.NEXT_PUBLIC_CONTACT_EMAIL = original;
    }
  });

  // Regression guard: a table-of-contents pill pointing at a renamed or
  // removed section id would silently break in-page navigation.
  it("links every table-of-contents pill to a section id that exists on the page", async () => {
    const { default: MethodologyPage } = await import("./page");
    const tree = await MethodologyPage();
    const ids = collectIds(tree);
    const anchors = collectHrefs(tree).filter((href) => href.startsWith("#"));
    expect(anchors.length).toBeGreaterThanOrEqual(7);
    for (const href of anchors) expect(ids).toContain(href.slice(1));
    // The cluster page and card deep-link here: both ends must exist.
    expect(anchors).toContain("#denge-puani");
    expect(ids).toContain("denge-puani");
  });

  // Regression guard: catches the stale "144 Türk haber kaynağı" claim
  // (the count belongs on /sources, which computes it live) and a bias-zone
  // column rendered as bare text without its contract dot colour.
  it("never hard-codes a source count and marks each Medya DNA zone with its contract dot colour", async () => {
    const { default: MethodologyPage } = await import("./page");
    const strings = collectStringProps(await MethodologyPage()).join(" ");
    expect(strings).not.toMatch(/\d+\s*Türk haber kaynağ/);
    for (const zone of Object.values(ZONE_META)) expect(strings).toContain(zone.dot);
  });

  // Pack B — neutralizer honesty: the "Başlıklar nasıl tarafsızlaştırılıyor"
  // section must never claim AI-neutralization without live evidence.
  describe("neutralization status line", () => {
    it("renders the closed-loop sentence when neutralized === 0", async () => {
      mockNeutralStatus = { neutralized: 0, eligible: 12 };

      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");

      expect(text).toContain(
        "Bu adım şu anda kapalı: üretimde hiçbir başlık tarafsızlaştırılmadı.",
      );
    });

    it("renders the live count when neutralized > 0, and drops the closed-loop sentence", async () => {
      mockNeutralStatus = { neutralized: 7, eligible: 12 };

      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");

      expect(text).toContain("Şu ana kadar 7 kümenin başlığı tarafsızlaştırıldı.");
      expect(text).not.toContain("Bu adım şu anda kapalı");
    });

    it("renders neither sentence when getNeutralizedStatus() returns null", async () => {
      mockNeutralStatus = null;

      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");

      expect(text).not.toContain("Bu adım şu anda kapalı");
      expect(text).not.toContain("kümenin başlığı tarafsızlaştırıldı");
    });
  });

  describe("reader-data: honest source count v2 + ekonomi ticker relevance", () => {
    it("adds the same-headline paragraph to the #tek-kaynak card", async () => {
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");

      expect(text).toContain("aynı başlığı kullanan kaynakları sayar");
      expect(text).toContain("12 kaynak · 4 bağımsız başlık");
      expect(text).toContain("25 karakterden ve 4 kelimeden kısa başlıklar");
    });

    it("adds both new CHANGELOG entries, dated 2026-09-28", async () => {
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");

      expect(text).toContain(
        "Bağımsız başlık sayısı: aynı başlığı kullanan kaynaklar küme sayfasında ayrıca belirtiliyor",
      );
      expect(text).toContain(
        "ilgisiz bulduğu şirket eşleşmeleri",
      );
    });
  });
  describe("Denge puanı (balance score)", () => {
    it("explains the entropy formula and what counts", async () => {
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");

      expect(text).toContain("Denge puanı, bir kümeyi hangi Medya DNA bölgelerinin haber yaptığını tek bir sayıyla özetler.");
      expect(text).toContain("Yalnızca sınıflandırılmış (oy veren) kaynaklar sayılır; toplayıcı ve niş kaynaklar, spektrum çubuğunda olduğu gibi, hesaba katılmaz.");
      expect(text).toContain("Shannon entropisi");
      expect(text).toContain(
        `tek bölgeden gelen kapsama 0, üç bölgeye eşit dağılan kapsama 100 alır; iki bölgeye eşit bölünen bir küme yaklaşık 63 alır ve “${BALANCE_LABELS.iki}” olarak etiketlenir.`,
      );
      expect(text).toContain(
        "Formül: puan = 100 × (−Σ pᵢ · ln pᵢ) / ln 3 — pᵢ, bir bölgenin oy veren kaynaklar içindeki payıdır.",
      );
    });

    it("renders the tier thresholds from the shared constants", async () => {
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");

      expect(text).toContain(`Puan ≥ ${BALANCE_BALANCED_MIN}`);
      expect(text).toContain(`Puan ≤ ${BALANCE_ONE_SIDED_MAX}`);
      expect(text).toContain(
        `${BALANCE_ONE_SIDED_MAX + 1}–${BALANCE_BALANCED_MIN - 1}`,
      );
      for (const label of Object.values(BALANCE_LABELS)) {
        expect(text).toContain(label);
      }
    });

    it("defines the İki tarafa dengeli tier with the share threshold from the shared constant", async () => {
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");

      expect(text).toContain(BALANCE_LABELS.iki);
      expect(text).toContain("İki tarafa dengeli");
      expect(text).toContain("Kapsama iki bölgeye dengeli bölünmüş; üçüncü bölge yok.");
      expect(text).toContain(`en az %${BALANCE_TWO_ZONE_MIN_SHARE * 100}`);
      expect(text).toContain(
        `Puan ${BALANCE_ONE_SIDED_MAX + 1}–${BALANCE_BALANCED_MIN - 1}; kaynaklar yalnızca iki bölgede`,
      );
    });

    it("keeps the Tek tarafa yakın range and says the even two-zone split is excluded from it", async () => {
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");

      expect(text).toContain(
        `${BALANCE_ONE_SIDED_MAX + 1}–${BALANCE_BALANCED_MIN - 1} (iki bölgeye dengeli bölünme hariç)`,
      );
    });

    // hunt-59 homefeed-2: the printed rule matches balanceFromZoneCounts, which
    // refuses "Dengeli kapsama" when one zone reaches SURPRISE.dominantShare.
    it("states the dominant-zone cap on Dengeli kapsama from the shared constant", async () => {
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");

      expect(BALANCE_BALANCED_MAX_SHARE).toBe(SURPRISE.dominantShare);
      const pct = Math.round(BALANCE_BALANCED_MAX_SHARE * 100);
      expect(pct).toBe(65);
      expect(text).toContain(
        `Puan ≥ ${BALANCE_BALANCED_MIN} ve hiçbir bölge kaynakların %${pct}'ine ulaşmıyor`,
      );
    });

    it("tells the reader a 67+ score with a dominant zone reads Tek tarafa yakın", async () => {
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");
      const pct = Math.round(BALANCE_BALANCED_MAX_SHARE * 100);

      expect(text).toContain(
        `(ya da puan ≥ ${BALANCE_BALANCED_MIN} iken bir bölge %${pct} ve üstü)`,
      );
    });

    it("states the source floor from the shared constant", async () => {
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");

      expect(text).toContain(
        `Kümede ${BALANCE_MIN_SOURCES} sınıflandırılmış kaynaktan azı varsa puan hesaplanmaz ("Az kaynak").`,
      );
    });

    it("says the score is not a quality grade and does not reorder stories", async () => {
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");

      expect(text).toContain(
        "Puan bir kalite notu değildir ve haberlerin sıralamasını değiştirmez; yalnızca kapsamanın genişliğini gösterir.",
      );
    });

    it("lists the section in the table of contents and as a heading", async () => {
      const { default: MethodologyPage } = await import("./page");
      const tree = await MethodologyPage();
      expect(collectHrefs(tree)).toContain("#denge-puani");
      expect(collectIds(tree)).toContain("denge-puani");
      // The TOC pill text, and the SectionHeading props (title + meta).
      expect(collectText(tree)).toContain("Denge puanı");
      const strings = collectStringProps(tree);
      expect(strings).toContain("Denge puanı");
      expect(strings).toContain("0–100");
    });

    it("adds the 2026-10-22 changelog entry", async () => {
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");

      expect(text).toContain("2026-10-22");
      expect(text).toContain(
        "Denge puanı eklendi: kartlarda ve küme sayfasında kapsamanın üç bölgeye ne kadar dengeli dağıldığını gösteren 0–100 arası puan.",
      );
    });
  });

  // The footer date must be derived from the CHANGELOG, not hard-coded: a
  // stale "Son güncelleme" next to a newer changelog entry contradicts itself
  // on a transparency page.
  describe("Son güncelleme footer", () => {
    const DATE = /\d{4}-\d{2}-\d{2}/g;

    it("equals the newest CHANGELOG entry date", async () => {
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");

      const footer = /Son güncelleme: (\d{4}-\d{2}-\d{2})/.exec(text);
      expect(footer).not.toBeNull();

      // Every date on the page is a CHANGELOG date (the footer included);
      // ISO dates sort lexicographically, so the max is the newest entry.
      const dates = text.match(DATE) ?? [];
      const newest = [...dates].sort().at(-1);
      expect(footer?.[1]).toBe(newest);
    });

    it("is not older than any CHANGELOG entry (newest-first ordering holds)", async () => {
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");

      const footer = /Son güncelleme: (\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
      const entryDates = text
        .slice(text.indexOf("Son güncelleme:"))
        .match(DATE)
        ?.slice(1);
      expect(entryDates?.length).toBeGreaterThan(0);
      // The first rendered entry is the newest and must match the footer.
      expect(entryDates?.[0]).toBe(footer);
    });
  });

  // Contrast sweep (a11y-2): opacity-modified text tokens composite below the
  // WCAG 1.4.3 floor; this page now uses the full tokens everywhere.
  describe("contrast sweep", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pageSource = readFileSync(join(here, "page.tsx"), "utf8");

    it("uses no opacity-modified muted-foreground or brand text token", () => {
      expect(pageSource).not.toContain("text-muted-foreground/");
      expect(pageSource).not.toContain("text-brand/");
    });

    it("keeps the brand link hover on the underline, not on a faded colour", () => {
      expect(pageSource).toContain("hover:decoration-solid");
    });
  });
});

// ---------------------------------------------------------------------------
// near-blindspots + source-reliability additions (2026-10-22)
// ---------------------------------------------------------------------------

type Node = { type?: unknown; props?: Record<string, unknown> };

/** First element (depth-first) whose props match `pred`. */
function findElement(node: unknown, pred: (el: Node) => boolean): Node | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, pred);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const el = node as Node;
    if (el.props && pred(el)) return el;
    if (el.props?.children !== undefined) return findElement(el.props.children, pred);
  }
  return null;
}

describe("/metodoloji page: Kör noktaya yakın", () => {
  const nearPct = Math.round(NEAR_BLINDSPOT_MIN_SHARE * 100);
  const dominantSharePct = Math.round(BLINDSPOT.dominantShare * 100);

  it("states the band, the delay, the lookback and the cap from the shared constants", async () => {
    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    expect(text).toContain(
      `Eşiğe ulaşmayan ama tek bir bölgenin ağırlıkta olduğu haberler Kör Noktalar sayfasında ayrı bir “Kör noktaya yakın” bölümünde listelenir: en az ${BLINDSPOT.minSources} oy veren kaynak ve en büyük bölgenin payı %${nearPct} ile %${dominantSharePct} arasında (%${dominantSharePct} hariç). Aynı ${BLINDSPOT.feedDelayHours} saatlik bekleme, yukarıdaki besleme sağlığı kuralı ve liste filtreleri uygulanır; son ${NEAR_BLINDSPOT_LOOKBACK_DAYS} günden en fazla ${NEAR_BLINDSPOT_DISPLAY_LIMIT} haber gösterilir. Bu haberler kör nokta sayılmaz; kör nokta sayımlarına ve “Bu listede kim yer vermedi?” özetine katılmaz.`,
    );
    // The two numbers the reader compares, from constants (not bare digits).
    expect(nearPct).toBe(70);
    expect(dominantSharePct).toBe(80);
  });

  it("anchors the subsection inside the #kor-nokta section, as an h3 deep link target", async () => {
    const { default: MethodologyPage } = await import("./page");
    const tree = await MethodologyPage();

    const section = findElement(
      tree,
      (el) => el.type === "section" && el.props?.["aria-labelledby"] === "kor-nokta",
    );
    expect(section).not.toBeNull();
    expect(collectIds(section)).toContain("kor-noktaya-yakin");

    const heading = findElement(
      tree,
      (el) => el.type === "h3" && el.props?.id === "kor-noktaya-yakin",
    );
    expect(heading).not.toBeNull();
    expect(collectText(heading).join("")).toBe("Kör noktaya yakın");
    // The global html scroll-padding-top already clears the sticky header; a
    // per-heading scroll-mt would stack on top of it (tests/styles/anchor-offset).
    expect(String(heading?.props?.className ?? "")).not.toContain("scroll-mt");
  });

  it("adds its changelog entry as the newest line, dated 2026-10-22", async () => {
    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    expect(text).toContain(
      "Kör noktaya yakın: kör nokta eşiğinin hemen altında kalan, tek bölgenin ağırlıkta olduğu haberler Kör Noktalar sayfasında ayrı bir bölümde listeleniyor.",
    );
  });
});

// h62-methodology-1: the Kör nokta section used to point at "kalite filtreleri ve
// besleme sağlığı kuralı" without defining either. Every number below is computed
// from the constant the code enforces, never typed.
describe("/metodoloji page: besleme sağlığı and Kör Noktalar listesi (h62-methodology-1)", () => {
  const pct = (share: number) => Math.round(share * 100);
  const hours = (ms: number) => ms / 3_600_000;

  async function renderTree() {
    const { default: MethodologyPage } = await import("./page");
    return MethodologyPage();
  }

  function korNoktaSection(tree: unknown) {
    const section = findElement(
      tree,
      (el) => el.type === "section" && el.props?.["aria-labelledby"] === "kor-nokta",
    );
    expect(section).not.toBeNull();
    return section;
  }

  /** The h3 with `id`, and the element right after it in its parent's children. */
  function headingAndParagraph(tree: unknown, id: string) {
    const heading = findElement(tree, (el) => el.type === "h3" && el.props?.id === id);
    const parent = findElement(
      tree,
      (el) =>
        Array.isArray(el.props?.children) &&
        (el.props.children as unknown[]).includes(heading),
    );
    expect(heading).not.toBeNull();
    expect(parent).not.toBeNull();
    const siblings = parent?.props?.children as unknown[];
    const paragraph = siblings[siblings.indexOf(heading) + 1] as Node;
    return { heading, paragraph };
  }

  it("reads the feed-health numbers from the constants the gate runs on", () => {
    // Pin the values the prose below prints, so a constant change is a conscious edit.
    expect(pct(FEED_HEALTH_MIN_SHARE)).toBe(70);
    expect(hours(FEED_HEALTH_MAX_AGE_MS)).toBe(2);
    expect(pct(FEED_HEALTH_MIN_YIELD_SHARE)).toBe(50);
    expect(hours(FEED_YIELD_WINDOW_MS)).toBe(72);
  });

  it("defines the besleme sağlığı rule in an h3 inside #kor-nokta, with every number from feed-health", async () => {
    const tree = await renderTree();
    expect(collectIds(korNoktaSection(tree))).toContain("besleme-sagligi");

    const { heading, paragraph } = headingAndParagraph(tree, "besleme-sagligi");
    expect(collectText(heading).join("")).toBe("Besleme sağlığı");
    expect(String(heading?.props?.className ?? "")).not.toContain("scroll-mt");

    const text = collectText(paragraph).join("");
    expect(text).toContain(`%${pct(FEED_HEALTH_MIN_SHARE)}`);
    expect(text).toContain(`${hours(FEED_HEALTH_MAX_AGE_MS)} saat`);
    expect(text).toContain(`%${pct(FEED_HEALTH_MIN_YIELD_SHARE)}`);
    expect(text).toContain(`${hours(FEED_YIELD_WINDOW_MS)} saat`);
    expect(text).toBe(
      `Bir bölgenin sessizliği, o bölgenin beslemeleri çalışmıyorsa bir yayın tercihi sayılamaz. Bu yüzden baskın bölge dışındaki İktidar ya da Muhalefet bölgesinde aktif RSS beslemelerinin %${pct(FEED_HEALTH_MIN_SHARE)}'inden azı son ${hours(FEED_HEALTH_MAX_AGE_MS)} saat içinde hatasız yanıt verdiyse ya da kaynakların %${pct(FEED_HEALTH_MIN_YIELD_SHARE)}'sinden azı son ${hours(FEED_YIELD_WINDOW_MS)} saatte en az bir haber yayımladıysa, kör nokta işareti kartlarda, haber sayfasında, haftalık özette ve Kör Noktalar listesinde gösterilmez. Besleme durumu okunamazsa işaret gösterilmeye devam eder.`,
    );
  });

  it("defines the Kör Noktalar listesi filters in an h3 inside #kor-nokta, with every number from the constants", async () => {
    const tree = await renderTree();
    expect(collectIds(korNoktaSection(tree))).toContain("kor-noktalar-listesi");

    const { heading, paragraph } = headingAndParagraph(tree, "kor-noktalar-listesi");
    expect(collectText(heading).join("")).toBe("Kör Noktalar listesi");
    expect(String(heading?.props?.className ?? "")).not.toContain("scroll-mt");

    const text = collectText(paragraph).join("");
    expect(text).toContain(`son ${BLINDSPOT_LIST_LOOKBACK_DAYS} gün`);
    expect(text).toContain(`en fazla ${DEFAULT_PICK_SIZE} haberi kart olarak`);
    expect(text).toContain(`%${pct(BLINDSPOT_LIST_FILTERS.minUniqueHashRatio)}'den azı`);
    expect(text).toContain(`%${pct(BLINDSPOT_LIST_FILTERS.maxDunyaShare)}'sinden fazlası`);
    expect(text).toContain(`%${pct(BLINDSPOT_LIST_FILTERS.minPoliticsShare)}'ından azı`);
    // h66-dupes-1: the copy_dedup clause, right after the hash clause, quoting its
    // own constant. Voting members only, and one headline counts as one text.
    expect(text).toContain(
      `içerik özetlerinin %${pct(BLINDSPOT_LIST_FILTERS.minUniqueHashRatio)}'den azı birbirinden farklı olanlar; spektruma sayılan kaynakların metinlerinin (aynı içerik özeti ya da aynı başlık tek metin sayılır) %${pct(BLINDSPOT_LIST_FILTERS.minIndependentTextRatio)}'den azı birbirinden farklı olanlar; haberlerinin %`,
    );
    // The four shares as the reader sees them: %50, %50, %50 and %60.
    expect(
      [
        BLINDSPOT_LIST_FILTERS.minUniqueHashRatio,
        BLINDSPOT_LIST_FILTERS.minIndependentTextRatio,
        BLINDSPOT_LIST_FILTERS.maxDunyaShare,
        BLINDSPOT_LIST_FILTERS.minPoliticsShare,
      ].map((share) => `%${pct(share)}`),
    ).toEqual(["%50", "%50", "%50", "%60"]);
    // The SEO-explainer examples the spec allows (the pattern list itself is not described).
    expect(text).toContain("kimdir");
    expect(text).toContain("nedir?");
    expect(text).toContain("canlı izle");
    expect(text).toContain("Her kaynaktan yalnızca ilk haber sayılır");
    expect(text).toContain("Dünya kategorisinde");
    expect(text).toContain("politika ya da son dakika");
    expect(text).toContain(
      "Bu haberler kartta ve haber sayfasında kör nokta etiketini yine taşıyabilir.",
    );
  });

  it("says where the claims beyond the card cap go: compact rows under 'Diğer kör noktalar', not hidden", async () => {
    // src/app/blindspots/page.tsx renders `result.more` as MoreBlindspotList (h2 id diger-kor-noktalar).
    const { paragraph } = headingAndParagraph(await renderTree(), "kor-noktalar-listesi");
    const text = collectText(paragraph).join("");
    expect(text).toContain("Kalanlar “Diğer kör noktalar” bölümünde birer satır olarak listelenir.");
  });

  it("does not describe the private-individual / SEO pattern list beyond the three allowed examples", async () => {
    const { paragraph } = headingAndParagraph(await renderTree(), "kor-noktalar-listesi");
    const text = collectText(paragraph).join("");
    for (const hidden of ["kaç yaşında", "ne zaman", "kaç bin", "ne dedi", "regex", "desen"]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("places the two rules after the sibling-veto paragraph and before 'Kör noktaya yakın', in that order", async () => {
    const section = collectText(korNoktaSection(await renderTree())).join("");
    const sibling = section.indexOf("Aynı olay bazen neredeyse aynı başlıkla");
    const health = section.indexOf("Bir bölgenin sessizliği");
    const list = section.indexOf("Kör Noktalar listesi son");
    const near = section.indexOf("Eşiğe ulaşmayan ama tek bir bölgenin");
    expect(sibling).toBeGreaterThan(0);
    expect(health).toBeGreaterThan(sibling);
    expect(list).toBeGreaterThan(health);
    expect(near).toBeGreaterThan(list);
  });

  it("replaces the undefined 'kalite filtreleri ve besleme sağlığı kuralı' with links to the two definitions", async () => {
    const tree = await renderTree();
    const text = collectText(tree).join("");
    expect(text).not.toContain("kalite filtreleri ve besleme sağlığı kuralı");
    expect(text).toContain(
      `Aynı ${BLINDSPOT.feedDelayHours} saatlik bekleme, yukarıdaki besleme sağlığı kuralı ve liste filtreleri uygulanır;`,
    );

    const { paragraph: nearParagraph } = headingAndParagraph(tree, "kor-noktaya-yakin");
    const hrefs = collectHrefs(nearParagraph);
    expect(hrefs).toEqual(["#besleme-sagligi", "#kor-noktalar-listesi"]);
    const links = collectText(nearParagraph);
    expect(links).toContain("besleme sağlığı kuralı");
    expect(links).toContain("liste filtreleri");
    // Both link targets exist on the page.
    expect(collectIds(tree)).toEqual(expect.arrayContaining(["besleme-sagligi", "kor-noktalar-listesi"]));
  });

  it("says the Bağımsız zone has no opposite, right after the Karşı taraf + marj card in #surpriz", async () => {
    const tree = await renderTree();
    const section = collectText(
      findElement(tree, (el) => el.type === "section" && el.props?.["aria-labelledby"] === "surpriz"),
    ).join("");
    const sentence =
      "Karşıt bölge, İktidar için Muhalefet, Muhalefet için İktidar'dır; Bağımsız bölgenin karşıtı yoktur, bu yüzden Bağımsız ağırlıklı bir küme sürpriz kesişim sayılmaz.";
    expect(section).toContain(sentence);
    expect(section).toContain("Bağımsız bölgenin karşıtı yoktur");
    expect(section.indexOf(sentence)).toBeGreaterThan(section.indexOf("Karşı taraf + marj"));
  });

  it("adds the 2026-11-02 CHANGELOG entry for the unclustered sibling arm, between 2026-11-05 and 2026-11-01", async () => {
    const text = collectText(await renderTree()).join("");
    const entry =
      "Kör nokta doğrulaması genişledi: karşı tarafta aynı olayı hiçbir kümeye girmeyen bir haberle (ör. dünya ya da genel kategorisinde) veren kaynaklar da artık sayıma ekleniyor; baskınlık eşiği bu yüzden tutmuyorsa kör nokta işareti gösterilmiyor.";
    const tail = text.slice(text.indexOf("Son güncelleme:"));
    expect(tail).toContain(`2026-11-02 ${entry}`);
    expect(text).not.toContain("kör nokta işaretini kaldırıyor");
    const feedDelay = tail.indexOf("Kör nokta etiketi artık kartlarda");
    const unclustered = tail.indexOf(entry);
    const sibling = tail.indexOf("aynı olayı neredeyse aynı başlıkla veren kardeş");
    expect(feedDelay).toBeGreaterThan(0);
    expect(unclustered).toBeGreaterThan(feedDelay);
    expect(sibling).toBeGreaterThan(unclustered);
  });
});

// h62-methodology-2: the page lagged PRs #217 (columns) and #221 (Dengeli kapsama,
// Turkish-first titles, English-only clusters). Copy only; the numbers come from the
// constants the code runs on.
describe("/metodoloji page: columns, English-only clusters and Dengeli kapsama (h62-methodology-2)", () => {
  async function renderTree() {
    const { default: MethodologyPage } = await import("./page");
    return MethodologyPage();
  }

  function sectionText(tree: unknown, id: string): string {
    const section = findElement(
      tree,
      (el) => el.type === "section" && el.props?.["aria-labelledby"] === id,
    );
    expect(section).not.toBeNull();
    return collectText(section).join("");
  }

  it("logs the 2026-11-07 Dengeli kapsama / Turkish-first / English-only change, numbers from the balance constants", async () => {
    const text = collectText(await renderTree()).join("");
    const pct = Math.round(BALANCE_BALANCED_MAX_SHARE * 100);
    const entry = `Denge puanı: “${BALANCE_LABELS.dengeli}” etiketi artık yalnızca puanı ${BALANCE_BALANCED_MIN} veya üzeri olan ve hiçbir bölgenin oy veren kaynakların %${pct}'ine ulaşmadığı kümelere veriliyor; bir bölge %${pct} veya üzerindeyse etiket “${BALANCE_LABELS.yakin}” oluyor. Türkçe ve İngilizce haberlerin karıştığı kümelerde Türkçe başlık seçiliyor; yalnızca İngilizce kaynaklardan oluşan kümeler bölgeler arasında karşılaştırılmıyor.`;

    const tail = text.slice(text.indexOf("Son güncelleme:"));
    expect(tail).toContain(`2026-11-07 ${entry}`);
    expect(entry).toContain(`“${BALANCE_LABELS.dengeli}”`);
    expect(entry).toContain(`${BALANCE_BALANCED_MIN}`);
    expect(entry).toContain(`%${pct}`);
    expect(entry).toContain("Türkçe");
    expect(entry).toContain("İngilizce");
    // The same threshold the Denge puanı card prints.
    expect(text).toContain(
      `Puan ≥ ${BALANCE_BALANCED_MIN} ve hiçbir bölge kaynakların %${pct}'ine ulaşmıyor`,
    );
  });

  it("logs the 2026-11-06 column change, dated between 2026-11-07 and 2026-11-05", async () => {
    const text = collectText(await renderTree()).join("");
    const tail = text.slice(text.indexOf("Son güncelleme:"));
    const entry =
      "Köşe yazıları: kümede en az bir haber varsa başlık bir köşe yazısından seçilmiyor; özet de uygun başka bir üye varken köşe yazısından alınmıyor, köşe yazısından gelen özet “köşe yazısı” diye belirtiliyor.";
    expect(entry).toContain("köşe yazısı");
    expect(tail).toContain(`2026-11-06 ${entry}`);
    expect(tail.indexOf("2026-11-07 Denge puanı:")).toBeLessThan(tail.indexOf(entry));
    expect(tail.indexOf(entry)).toBeLessThan(tail.indexOf("2026-11-05 Kör nokta etiketi"));
  });

  it("describes the column and Turkish-first rules in the Başlıklar section, after the extractive-pick sentence", async () => {
    const section = sectionText(await renderTree(), "basliklar");
    expect(section).toContain("köşe yazısı");
    expect(section).toContain("Türkçe başlık");
    expect(section).toContain(
      "Başlık seçiminde köşe yazıları haberin yerine geçmez: kümede en az bir haber varsa köşe yazısının başlığı seçilmez; yalnızca köşe yazılarından oluşan kümede başlık yine seçilir ve küme sayfasında “Köşe yazısı” etiketi görünür.",
    );
    // Verified against summary-agreement.ts (opinion seed is replaced only by a
    // member that clears every other gate; with none it stays and is labelled).
    expect(section).toContain(
      "Özet de, başlığa uygun başka bir üyenin açıklaması varken köşe yazısından alınmaz; yoksa köşe yazısının özeti kalır ve “köşe yazısı” diye belirtilir.",
    );
    expect(section).toContain(
      "Türkçe ve İngilizce kaynakların karıştığı kümelerde Türkçe başlık İngilizce başlığa tercih edilir.",
    );
    expect(section.indexOf("ve yukarıdaki sayıma dahil edilmez.")).toBeLessThan(
      section.indexOf("Başlık seçiminde köşe yazıları"),
    );
  });

  it("explains columns and English-only clusters in the Kaynaklar note, after the Toplayıcı/niş note", async () => {
    const section = sectionText(await renderTree(), "kaynaklar");
    const emptyColumn = ENGLISH_ONLY_EMPTY_COLUMN.replace(/^—\s*|\s*—$/g, "");
    expect(emptyColumn).toBe("Türkçe kaynaklarla karşılaştırılmadı");
    expect(section).toContain("Köşe yazıları");
    expect(section).toContain(emptyColumn);
    expect(section).toContain(
      "Köşe yazıları ayrı bir kaynak türü sayılmaz: bir yayın kuruluşunun köşe yazısı, kümede o kaynağın haberi gibi yanlılık dağılımına, kör nokta ve denge hesaplarına katılır. Tayf bir yazıyı adresindeki yol bölümünden (ör. /yazarlar/, /kose-yazilari/, /opinion/) köşe yazısı olarak tanır; adresi bu kalıpta olmayan köşe yazıları haber gibi işlem görür.",
    );
    // The empty-column wording of a normal cluster is "— bu tarafta sessizlik —"
    // (framing-comparison.tsx), not "haber yapmadı".
    expect(section).toContain(
      `Yalnızca İngilizce yayın yapan kaynakların (ör. Daily Sabah, TRT World) oluşturduğu kümeler Türkçe haberlerle eşleşmediği için bölgeler arasında karşılaştırılmaz: ana sayfada listelenmez ve küme sayfasında boş bir bölge “bu tarafta sessizlik” yerine “${emptyColumn}” diye gösterilir.`,
    );
    expect(section.indexOf("hangi kaynağın hangi türde olduğu")).toBeLessThan(
      section.indexOf("Köşe yazıları ayrı bir kaynak türü sayılmaz"),
    );
  });

  it("only names example outlets and path segments the registries really hold", () => {
    for (const slug of ["daily-sabah", "trt-world"]) {
      expect(ENGLISH_SOURCE_SLUGS.has(slug)).toBe(true);
    }
    for (const segment of ["yazarlar", "kose-yazilari", "opinion"]) {
      expect(OPINION_PATH_SEGMENTS.has(segment)).toBe(true);
    }
  });
});

describe("/metodoloji page: Kaynak göstergeleri", () => {
  const W = KARNE_WINDOW_DAYS;

  it("is in the TOC right after Güvenilirlik and resolves to a heading id, in the same order", async () => {
    const { default: MethodologyPage } = await import("./page");
    const tree = await MethodologyPage();
    const anchors = collectHrefs(tree).filter((h) => h.startsWith("#"));
    const ids = collectIds(tree);

    expect(anchors).toContain("#kaynak-gostergeleri");
    expect(ids).toContain("kaynak-gostergeleri");
    // TOC pills are the first anchors, in SECTIONS order.
    expect(anchors.indexOf("#kaynak-gostergeleri")).toBe(
      anchors.indexOf("#guvenilirlik") + 1,
    );
    // The section itself sits between Güvenilirlik and Başlıklar.
    expect(ids.indexOf("kaynak-gostergeleri")).toBe(ids.indexOf("guvenilirlik") + 1);
    expect(ids.indexOf("basliklar")).toBe(ids.indexOf("kaynak-gostergeleri") + 1);
    expect(collectText(tree)).toContain("Kaynak göstergeleri");
  });

  it("titles the section and shows the window from KARNE_WINDOW_DAYS", async () => {
    const { default: MethodologyPage } = await import("./page");
    const strings = collectStringProps(await MethodologyPage());

    expect(strings).toContain("Kaynak göstergeleri");
    expect(strings).toContain(`Son ${W} gün`);
  });

  it("says the indicators are not a quality grade and never reorder anything", async () => {
    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    expect(text).toContain(
      "Kaynak sayfalarındaki göstergeler Tayf’ın gördüğü yayın akışından hesaplanan sayılardır; bir doğruluk ya da kalite notu değildir ve hiçbir sıralamayı değiştirmez. Örnek sayısı yetersizse gösterge yerine “Yeterli örnek yok” notu ve örnek sayısı gösterilir.",
    );
    expect(text).toContain("kalite notu değildir");
    // reliability.ts insufficient() renders "Yeterli örnek yok (n = …, en az …)." rather than hiding the row.
    expect(text).not.toContain("gösterge gizlenir");
    expect(text).toContain("Yeterli örnek yok");
  });

  it("describes the four indicators with the sample floors from the karne constants", async () => {
    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    for (const term of [
      "Yayın sıklığı",
      "Başka kaynaklarla aynı başlık ve özet",
      "Kör nokta kümelerindeki payı",
      "Bölge çeşitliliği",
    ]) {
      expect(text).toContain(term);
    }

    expect(text).toContain(
      `Son ${W} günde yayımlanan haber sayısının ${W}’a bölümü; etkin gün, en az bir haber yayımlanan takvim günüdür (Türkiye saati).`,
    );
    expect(text).toContain(
      `(kaynak başına bir haber alındığında en az 3 haber ve farklı içerik parmak izi oranı en fazla %${Math.round(WIRE_UNIQUE_HASH_RATIO * 100)})`,
    );
    expect(text).toContain(
      "başlığı ve özeti başka bir kaynakla aynı olanların payı. Karşılaştırma başlık ve özetin parmak iziyle yapılır; haber gövdesi karşılaştırılmaz.",
    );
    expect(text).toContain(
      `Yön belirtmez: başlık ve özeti ilk yayımlayan da aynen kullanan da sayılır; ajans haberi kullanmak olağan bir yayıncılık pratiğidir. En az ${KARNE_MIN_CLUSTERS} haber kümesi gerekir.`,
    );
    // The fingerprint covers title + RSS summary only, so the page must never
    // claim the article text itself is identical.
    expect(text).not.toMatch(/birebir aynı metin|aynı metin payı/);
    expect(text).toContain(
      `Kaynağın yer aldığı kümelerden kör nokta olarak işaretlenenlerin payı (yukarıdaki kural; Kapsama karnesiyle aynı sayım). En az ${KARNE_MIN_CLUSTERS} haber kümesi gerekir.`,
    );
    expect(text).toContain(
      `En az ${BALANCE_MIN_SOURCES} oy veren kaynağı olan kümelerin Denge puanı ortalaması. En az ${KARNE_MIN_MULTI_FOR_ZONES} böyle küme gerekir.`,
    );
  });

  it("links the Bölge çeşitliliği definition to the Denge puanı section", async () => {
    const { default: MethodologyPage } = await import("./page");
    const tree = await MethodologyPage();

    const dd = findElement(tree, (el) =>
      collectText(el.props?.children).join("").startsWith(`En az ${BALANCE_MIN_SOURCES} oy veren kaynağı`),
    );
    expect(dd).not.toBeNull();
    expect(collectHrefs(dd)).toEqual(["#denge-puani"]);
  });

  it("states the recompute cadence and the staleness window from KARNE_STALE_AFTER_HOURS", async () => {
    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    expect(text).toContain(
      `Göstergeler kaynak kaynak, günde bir kez yeniden hesaplanır; ${KARNE_STALE_AFTER_HOURS} saatten eski bir hesaplama kaynak sayfasında belirtilir.`,
    );
  });

  it("adds its changelog entry, dated 2026-10-22", async () => {
    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    expect(text).toContain(
      "Kaynak göstergeleri: kaynak sayfalarında yayın sıklığı, başlık ve özeti başka kaynaklarla aynı olan haberlerin payı, kör nokta payı ve bölge çeşitliliği.",
    );
  });
});

describe("/metodoloji page: changelog order", () => {
  it("lists the two new entries first (both 2026-10-22), then the Denge puanı entry; the footer date is the newest", async () => {
    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    const tail = text.slice(text.indexOf("Son güncelleme:"));
    const near = tail.indexOf("Kör noktaya yakın: kör nokta eşiğinin hemen altında");
    const sources = tail.indexOf("Kaynak göstergeleri: kaynak sayfalarında");
    const denge = tail.indexOf("Denge puanı eklendi:");
    expect(near).toBeGreaterThan(0);
    expect(sources).toBeGreaterThan(near);
    expect(denge).toBeGreaterThan(sources);

    const dates = tail.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    // footer, then the 2026-11-07 balance/English entry, the 2026-11-06 column
    // entry, the 2026-11-05 feed-delay entry, the 2026-11-02 unclustered-arm
    // entry (148), the 2026-11-01 sibling-veto entry (126), then the three
    // 2026-10-22 entries
    expect(dates.slice(0, 9)).toEqual([
      "2026-11-07",
      "2026-11-07",
      "2026-11-06",
      "2026-11-05",
      "2026-11-02",
      "2026-11-01",
      "2026-10-22",
      "2026-10-22",
      "2026-10-22",
    ]);
    expect([...dates].sort().at(-1)).toBe(dates[0]);
  });
});

// The tagged-source sentence counts the ACTIVE registry (the same slugs /sources
// feeds to countClassifiedSources), not every key of SOURCE_METADATA: the two
// pages used to print 41 and 37 for the same fact (h24-scores-1).
describe("/metodoloji page: tagged-source counts follow the active registry", () => {
  const highOf = (slugs: readonly string[]) =>
    slugs.filter((slug) => getSourceMetadata(slug)?.factuality === "high").length;
  const lowOf = (slugs: readonly string[]) =>
    slugs.filter((slug) => getSourceMetadata(slug)?.factuality === "low").length;
  const mixedOf = (slugs: readonly string[]) =>
    slugs.filter((slug) => getSourceMetadata(slug)?.factuality === "mixed").length;

  beforeEach(() => {
    mockNeutralStatus = { neutralized: 0, eligible: 12 };
  });

  afterEach(() => {
    mockActiveSlugs = ["sabah", "anadolu-ajansi", "bilinmeyen-kaynak"];
    mockExtraMetadata = {};
  });

  it("prints countClassifiedSources(activeSlugs) and the high/low counts of those same slugs", async () => {
    const slugs = ["indyturk", "sabah", "anadolu-ajansi", "bilinmeyen-kaynak"];
    mockActiveSlugs = slugs;

    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    const tagged = countClassifiedSources(slugs);
    const high = highOf(slugs);
    const mixed = mixedOf(slugs);
    const low = lowOf(slugs);
    expect(text).toContain(`Şu anda ${tagged} kaynak etiketli`);
    expect(text).toContain(`${high} tanesi Yüksek`);
    expect(text).toContain(`${mixed} tanesi Karışık`);
    expect(text).toContain(`${low} tanesi Düşük`);
    expect(text).toContain(
      `Şu anda ${tagged} kaynak etiketli: ${high} tanesi Yüksek, ${mixed} tanesi Karışık, ${low} tanesi Düşük güvenilirlik notu taşıyor. Etiketsiz kaynaklar henüz derecelendirilmemiştir.`,
    );
    // The old wording read "geri kalan" straight after Yüksek/Düşük, as if the
    // Karışık sources were unrated (h62-methodology-2).
    expect(text).not.toContain("Düşük; geri kalan kaynaklar henüz derecelendirilmemiştir");
    // Every tagged source here has a factuality, so there is no remainder to name.
    expect(text).not.toContain("yalnızca sahiplik bilgisi var");
    // Pin the values themselves too, so the helpers above cannot drift with the code:
    // indyturk (mixed), sabah (mixed), anadolu-ajansi (high); the unknown slug is untagged.
    expect(tagged).toBe(3);
    expect(high).toBe(1);
    expect(mixed).toBe(2);
    expect(low).toBe(0);
    expect(high + mixed + low).toBe(tagged);
  });

  it("names the remainder when a tagged source has ownership only, and counts a Düşük source", async () => {
    mockExtraMetadata = {
      "sadece-sahiplik": { factuality: null, ownership: "Örnek Holding", ownerGroup: null },
      "dusuk-kaynak": { factuality: "low", ownership: null, ownerGroup: null },
      "bos-kayit": { factuality: null, ownership: null, ownerGroup: null },
    };
    const slugs = ["anadolu-ajansi", "sabah", "sadece-sahiplik", "dusuk-kaynak", "bos-kayit", "bilinmeyen-kaynak"];
    mockActiveSlugs = slugs;

    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    const tagged = countClassifiedSources(slugs);
    const high = highOf(slugs);
    const mixed = mixedOf(slugs);
    const low = lowOf(slugs);
    const rest = tagged - high - mixed - low;
    // anadolu-ajansi (high), sabah (mixed), dusuk-kaynak (low), sadece-sahiplik (ownership only);
    // bos-kayit has neither field and bilinmeyen-kaynak has no entry: both are untagged.
    expect([tagged, high, mixed, low, rest]).toEqual([4, 1, 1, 1, 1]);
    expect(text).toContain(
      `Şu anda ${tagged} kaynak etiketli: ${high} tanesi Yüksek, ${mixed} tanesi Karışık, ${low} tanesi Düşük güvenilirlik notu taşıyor; ${rest} kaynakta yalnızca sahiplik bilgisi var. Etiketsiz kaynaklar henüz derecelendirilmemiştir.`,
    );
  });

  it("counts indyturk: the renamed registry key now matches the live slug", async () => {
    mockActiveSlugs = ["indyturk"];

    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    expect(text).toContain(
      "Şu anda 1 kaynak etiketli: 0 tanesi Yüksek, 1 tanesi Karışık, 0 tanesi Düşük güvenilirlik notu taşıyor.",
    );
  });

  it("does not count a tagged key that is not an active source (inactive outlets, an unknown slug)", async () => {
    // fotomac, fanatik and tgrt-haber stay in the registry but are inactive.
    expect(getSourceMetadata("fotomac")).not.toBeNull();
    mockActiveSlugs = ["sabah"];

    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    expect(text).toContain("Şu anda 1 kaynak etiketli");
    expect(text).not.toContain("Şu anda 2 kaynak etiketli");
  });

  it("prints zero counts for an empty (but successfully read) registry", async () => {
    mockActiveSlugs = [];

    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    expect(text).toContain(
      "Şu anda 0 kaynak etiketli: 0 tanesi Yüksek, 0 tanesi Karışık, 0 tanesi Düşük güvenilirlik notu taşıyor.",
    );
  });

  it("leaves the numbers out and says only that untagged sources are unrated when the registry read failed", async () => {
    mockActiveSlugs = null;

    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    expect(text).not.toContain("kaynak etiketli");
    expect(text).not.toContain("Şu anda");
    expect(text).not.toContain("tanesi Yüksek");
    expect(text).not.toContain("tanesi Karışık");
    expect(text).toContain("Etiketlenmemiş kaynaklar henüz derecelendirilmemiştir.");
    // The rest of the page is unaffected by the missing counts.
    expect(text).toContain("Sahiplik, kaynakları holding/grup bazında toplayan bir başka sinyaldir");
  });

  it("no longer counts the module-level SOURCE_METADATA table", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pageSource = readFileSync(join(here, "page.tsx"), "utf8");

    expect(pageSource).not.toContain("taggedSources");
    expect(pageSource).not.toContain("SOURCE_METADATA");
    expect(pageSource).toContain('from "@/lib/sources/registry-query"');
  });
});

// h43-sources-1: the category table documents the five biases production can
// store (the live CHECK sources_alignment_check, WRITABLE_SOURCE_BIAS), not the
// ten the app can parse. The other five (Devlet Medyası, İslamcı/Muhafazakâr,
// Uluslararası, Kürt Yanlısı, Milliyetçi) have no row in production, and the
// old "Milliyetçi -> İktidar" note contradicted the live labels (odatv and
// yenicag are Muhalefet, benguturk is Merkez). Widening the CHECK is a founder
// decision (h26-integrity-1), so this page follows WRITABLE_SOURCE_BIAS and
// never a literal.
describe("/metodoloji page: category table follows WRITABLE_SOURCE_BIAS (h43-sources-1)", () => {
  type Row = { key: string | null; props: { children: unknown[] } };

  async function renderTree() {
    const { default: MethodologyPage } = await import("./page");
    return MethodologyPage();
  }

  function tableRows(tree: unknown): Row[] {
    const tbody = findElement(tree, (el) => el.type === "tbody");
    expect(tbody).not.toBeNull();
    return (tbody?.props?.children ?? []) as Row[];
  }

  it("renders exactly one row per WRITABLE_SOURCE_BIAS key, keyed by it, in order", async () => {
    const rows = tableRows(await renderTree());

    // The shared constant is the source of the row count; pin 5 so a silent
    // widening shows up here as a conscious edit, not a quiet page change.
    expect(WRITABLE_SOURCE_BIAS).toHaveLength(5);
    expect(rows).toHaveLength(WRITABLE_SOURCE_BIAS.length);
    expect(rows.map((r) => r.key)).toEqual([...WRITABLE_SOURCE_BIAS]);
  });

  it("labels each row BIAS_LABELS[k] and zones it BIAS_TO_ZONE[k] (İktidar, İktidar, Bağımsız, Muhalefet, Muhalefet)", async () => {
    const rows = tableRows(await renderTree());
    const cells = rows.map((r) => r.props.children.map((c) => collectText(c).join("")));

    expect(cells).toEqual(
      WRITABLE_SOURCE_BIAS.map((k) => [BIAS_LABELS[k], ZONE_META[BIAS_TO_ZONE[k]].label]),
    );
    // And the literal copy the spec names, so the contract tables cannot drift
    // together with the page unnoticed.
    expect(cells).toEqual([
      ["Hükümete Yakın", "İktidar"],
      ["Hükümete Meyilli", "İktidar"],
      ["Merkez", "Bağımsız"],
      ["Muhalefete Meyilli", "Muhalefet"],
      ["Muhalefet", "Muhalefet"],
    ]);
  });

  it("keeps each row's contract dot colour", async () => {
    const rows = tableRows(await renderTree());
    const strings = collectStringProps(rows).join(" ");
    for (const k of WRITABLE_SOURCE_BIAS) {
      expect(strings).toContain(ZONE_META[BIAS_TO_ZONE[k]].dot);
    }
  });

  it("reads '5 kategori → 3 bölge' in the section meta", async () => {
    const tree = await renderTree();
    const heading = findElement(
      tree,
      (el) => el.props?.id === "kaynaklar" && typeof el.props?.meta === "string",
    );
    expect(heading).not.toBeNull();
    expect(heading?.props?.meta).toBe("5 kategori → 3 bölge");
    expect(heading?.props?.title).toBe("Kaynaklar nasıl etiketleniyor");
  });

  it("says 5 yanlılık kategorisi in the exact copy and keeps the rest of the paragraph", async () => {
    const text = collectText(await renderTree()).join("");

    expect(text).toContain(
      'Her kaynak, editoryal duruşuna göre 5 yanlılık kategorisinden birine atanır. Bu 5 kategori, gösterimde ve kör nokta/sürpriz hesaplamalarında 3 geniş "Medya DNA" bölgesine (İktidar, Bağımsız, Muhalefet) toplanır.',
    );
    expect(text).toContain(
      "Kategoriler ve güvenilirlik notları Tayf ekibi tarafından, kaynağın yayın geçmişine bakılarak elle atanır; dış bir derecelendirme kuruluşunun verisi değildir. Bir etikete itiraz etmek için düzeltme formunu kullanın.",
    );
  });

  it("never mentions the ten-category taxonomy or the five unstorable categories", async () => {
    const tree = await renderTree();
    const text = collectText(tree).join("");
    const strings = collectStringProps(tree).join(" ");

    for (const stale of [
      "10 kategori",
      "10 ayrıntılı",
      "Devlet Medyası",
      "Kürt Yanlısı",
      "Milliyetçi",
      "Uluslararası",
      "İslamcı/Muhafazakâr",
    ]) {
      expect(text).not.toContain(stale);
      expect(strings).not.toContain(stale);
    }
    // The deleted "Milliyetçi -> İktidar" note's own claim.
    expect(text).not.toContain("Cumhur İttifakı");
    expect(text).not.toMatch(/\bMHP\b/);
    // The five labels of the unstorable categories, straight from the contract.
    const storable = new Set<string>(WRITABLE_SOURCE_BIAS);
    for (const [bias, label] of Object.entries(BIAS_LABELS)) {
      if (storable.has(bias)) continue;
      expect(text).not.toContain(label);
    }
  });

  it("keeps the Toplayıcı/niş note and the #kaynaklar / #duzeltme anchors", async () => {
    const tree = await renderTree();
    const text = collectText(tree).join("");

    expect(text).toContain(
      "Toplayıcı (ör. Haberler.com, Onedio) ve niş (spor, finans, kurumsal) türündeki kaynaklar kümelerde listelenir ama yanlılık dağılımına, kör nokta ve sürpriz hesaplarına sayılmaz; hangi kaynağın hangi türde olduğu Kaynaklar sayfasında işaretlidir.",
    );
    const ids = collectIds(tree);
    expect(ids).toContain("kaynaklar");
    expect(ids).toContain("duzeltme");
    const hrefs = collectHrefs(tree);
    expect(hrefs).toContain("#kaynaklar");
    expect(hrefs).toContain("#duzeltme");
  });

  // The guard: the page maps the IMPORTED constant. A literal key list (or the
  // ten-key BIAS_ORDER) would let a future CHECK widening update the contract
  // and leave this table behind, or the reverse.
  describe("source guard", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "page.tsx"), "utf8");
    // Blank comments (offsets kept) so prose cannot satisfy or trip a pattern.
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
        p1 + " ".repeat(m.length - p1.length),
      );

    it("imports WRITABLE_SOURCE_BIAS from @/lib/validation/source-input and maps it", () => {
      expect(source).toMatch(
        /import\s*\{[^}]*\bWRITABLE_SOURCE_BIAS\b[^}]*\}\s*from\s*["']@\/lib\/validation\/source-input["']/,
      );
      expect(source).toContain("WRITABLE_SOURCE_BIAS.map(");
    });

    it("does not map the ten-key BIAS_ORDER or spell any bias key as a literal", () => {
      expect(source).not.toContain("BIAS_ORDER");
      for (const key of Object.keys(BIAS_LABELS)) {
        expect(source).not.toContain(`"${key}"`);
        expect(source).not.toContain(`'${key}'`);
      }
    });
  });
});
