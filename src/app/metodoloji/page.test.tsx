import { createHash } from "node:crypto";
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
import {
  detectWireRedistribution,
  SAME_DESCRIPTION_MIN_CHARS,
  WIRE_MIN_MEMBERS,
  WIRE_UNIQUE_HASH_RATIO,
} from "@/lib/clusters/wire";
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
import {
  RECALL_MATCH_MIN_PROB,
  RECALL_MATCH_NOTE,
} from "@/lib/clusters/recall-matched-zones";
import { SIBLING_VETO } from "@/lib/clusters/sibling-veto";
import {
  NEAR_BLINDSPOT_DISPLAY_LIMIT,
  NEAR_BLINDSPOT_LOOKBACK_DAYS,
  NEAR_BLINDSPOT_MIN_SHARE,
} from "@/lib/clusters/near-blindspot-rule";
import {
  buildKarneView,
  karneFreshness,
  KARNE_MIN_CLUSTERS,
  KARNE_MIN_MULTI_FOR_ZONES,
  KARNE_STALE_AFTER_HOURS,
  KARNE_WINDOW_DAYS,
  toSourceKarne,
} from "@/lib/sources/karne";
import { WINDOW_OVERFLOW_RECENT_MS } from "@/lib/sources/feed-status";
import {
  buildReliabilityView,
  toSourceReliability,
  WINDOW_OVERFLOW_NOTE,
} from "@/lib/sources/reliability";
import { SourceKarneCard } from "@/components/source/source-karne";
import { isNoticeOnlyCluster } from "@/lib/seo/notice-only-clusters";
import { AD_CLICK_HOSTS, isAdClickLink } from "../../../supabase/functions/_shared/rss/ad-link";
import { isLegalNotice } from "../../../supabase/functions/_shared/rss/legal-notice";
import {
  isPaidContentUrl,
  PAID_CONTENT_SEGMENTS,
} from "../../../supabase/functions/_shared/rss/paid-content";
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

// h176-methodtruth-1: the CHANGELOG entries of 2026-11-11 to 2026-11-13, written from the
// constants the code runs on (never typed): the paid url sections (paid-content.ts), the
// ad-click hosts (ad-link.ts), the feed-window overflow window (feed-status.ts) and the
// wire floor (wire.ts). The page and these pins both read the same constants.
const DAY_MS = 86_400_000;
const PAID_SECTIONS = PAID_CONTENT_SEGMENTS.map((segment) => `/${segment}/`).join(" ya da ");
const AD_HOST_EXAMPLES = AD_CLICK_HOSTS.slice(0, 3).join(", ");
const OVERFLOW_DAYS = WINDOW_OVERFLOW_RECENT_MS / DAY_MS;
const NOTICES_ENTRY =
  "Resmî ilanların ayıklanması genişledi: özeti “İlan-” ile başlayan mahkeme ilanları ve EKAP ihale duyuruları da artık haber olarak kaydedilmiyor; yalnızca bu tür ilanlardan oluşan haber sayfaları arama motorlarına kapalı. Ayrıntı “Habere sayılmayanlar” bölümünde.";
const CADENCE_ENTRY = `Yayın sıklığı: akışı her seferinde yalnızca son haberleri veren ve bu sınırı son ${OVERFLOW_DAYS} günde aşan kaynaklarda değer artık “en az … haber/gün” diye gösteriliyor, çünkü bazı haberler Tayf’a ulaşmamıştır; sayının hesabı değişmedi.`;
const COPY_ENTRY = `Kapsama karnesinin nasıl hesaplandığı ve “Tek kaynaktan dağıtım” kartındaki en az ${WIRE_MIN_MEMBERS} farklı kaynak koşulu yazıldı; kural değişmedi.`;
const PAID_ENTRY = `Ücretli tanıtım içerikleri artık haber olarak kaydedilmiyor: adresinin ilk iki yol bölümünden biri ${PAID_SECTIONS} olan içerikler kaynaktan alınırken ayıklanıyor.`;
const AD_ENTRY = `Reklam ve tıklama izleme adreslerine (ör. ${AD_HOST_EXAMPLES}) giden bağlantılar artık haber olarak kaydedilmiyor.`;

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
    // Only voting sources count toward both thresholds (h120-methodology-1).
    expect(text).toContain(`en az ${BLINDSPOT.minSources} oy veren kaynak (haber kuruluşu ya da ajans) yer almalı`);
    expect(text).toContain(`≥ %${Math.round(BLINDSPOT.dominantShare * 100)}`);
    expect(text).toContain(`${BLINDSPOT.feedDelayHours} saat sonra`);

    expect(text).toContain(`en az ${SURPRISE.minSources} oy veren kaynak`);
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

  // h106-blindspotbadges-1: the one sentence that explains the wording change on
  // the cards, the cluster page and the "yer vermedi" band for a side Jev matched
  // in another cluster. The kör nokta rule itself is not touched, and the number
  // comes from the shared module, never from a literal.
  it("explains that a silent side Jev matched in another cluster reads 'benzer haber başka kümede olabilir' and that the rule is unchanged (h106-blindspotbadges-1)", async () => {
    const { default: MethodologyPage } = await import("./page");
    const tree = await MethodologyPage();
    const section = collectText(
      findElement(tree, (el) => el.type === "section" && el.props?.["aria-labelledby"] === "kor-nokta"),
    ).join("");

    const sentence = `Tayf'ın otomatik kontrolü (Jev, olasılık ≥ %${Math.round(RECALL_MATCH_MIN_PROB * 100)}) sessiz görünen taraftaki bir kaynağın aynı olayı başka bir kümede verdiğini bulursa, o taraf küme sayfasında “sessizlik” yerine “benzer haber başka kümede olabilir” diye gösterilir, kartlarda “Sadece X yazdı” yerine “Kümede sadece X” yazar ve “Bu listede kim yer vermedi?” özetine o taraf sayılmaz; kör nokta kuralı bu yüzden değişmez.`;
    expect(section).toContain(sentence);
    expect(RECALL_MATCH_MIN_PROB).toBe(0.7);

    // Placement: after the sibling-veto paragraph, before "Besleme sağlığı".
    const siblingEnd = section.indexOf(
      "Bu haberleri veren kaynaklar da sayıma eklenir; baskınlık eşiği artık tutmuyorsa kör nokta işareti yine gösterilmez.",
    );
    const mine = section.indexOf(sentence);
    const feedHealth = section.indexOf("Besleme sağlığı");
    expect(siblingEnd).toBeGreaterThan(0);
    expect(mine).toBeGreaterThan(siblingEnd);
    expect(feedHealth).toBeGreaterThan(mine);
  });

  // h120-methodology-1: the footer is pinned to the FIRST rendered entry, never to a
  // literal of an older entry, so the next CHANGELOG line cannot leave a stale pin
  // behind. The date below is the newest entry's (h176-methodtruth-1: 2026-11-13).
  it("lists the 2026-11-13 CHANGELOG entry first and the footer reads the first rendered entry's date (h120-methodology-1, h176-methodtruth-1)", async () => {
    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    const tail = text.slice(text.indexOf("Son güncelleme:"));
    const footer = /Son güncelleme: (\d{4}-\d{2}-\d{2})/.exec(tail)?.[1];
    const entryDates = tail.match(/\d{4}-\d{2}-\d{2}/g)?.slice(1) ?? [];
    // The footer is the first rendered entry's date, and that is the newest.
    expect(footer).toBe(entryDates[0]);
    expect(footer).toBe("2026-11-13");
    expect(tail.startsWith(`Son güncelleme: ${entryDates[0]}`)).toBe(true);
    // The first list item: its date directly precedes its text, and it comes
    // before the 2026-11-12, -11, -10, -09, -08 and -07 entries.
    const first = tail.indexOf(`${entryDates[0]} ${NOTICES_ENTRY}`);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(tail.indexOf("2026-11-12 Ücretli tanıtım içerikleri"));
    expect(tail.indexOf("2026-11-12 Ücretli tanıtım içerikleri")).toBeLessThan(
      tail.indexOf("2026-11-11 Ajans ağırlıklı rozeti"),
    );
    expect(tail.indexOf("2026-11-11 Ajans ağırlıklı rozeti")).toBeLessThan(
      tail.indexOf("2026-11-10 Kör nokta ifadesi:"),
    );
    expect(tail.indexOf("2026-11-10 Kör nokta ifadesi:")).toBeLessThan(
      tail.indexOf("2026-11-09 Kaynak göstergeleri:"),
    );
    expect(tail.indexOf("2026-11-09 Kaynak göstergeleri:")).toBeLessThan(
      tail.indexOf("2026-11-08 Kör Noktalar listesi:"),
    );
    expect(tail.indexOf("2026-11-08 Kör Noktalar listesi:")).toBeLessThan(
      tail.indexOf("2026-11-07 Denge puanı:"),
    );
    expect(tail.indexOf("2026-11-07 Denge puanı:")).toBeLessThan(
      tail.indexOf("2026-11-06 Köşe yazıları:"),
    );
  });

  // h120-methodology-1 (b): the date order of the whole list, newest first.
  // h176-methodtruth-1: three 2026-11-13 entries, one 2026-11-12, and the ad-link entry
  // joins the two 2026-11-11 ones (h138-roadmap2-1, h130-blindspots-2).
  it("renders the CHANGELOG dates newest first: 2026-11-13 (three), -12, -11 (three), -10, -09, -08, -07, -06, ... (h120-methodology-1, h176-methodtruth-1)", async () => {
    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    const tail = text.slice(text.indexOf("Son güncelleme:"));
    const entryDates = (tail.match(/\d{4}-\d{2}-\d{2}/g) ?? []).slice(1);
    expect(entryDates.slice(0, 15)).toEqual([
      "2026-11-13",
      "2026-11-13",
      "2026-11-13",
      "2026-11-12",
      "2026-11-11",
      "2026-11-11",
      "2026-11-11",
      "2026-11-10",
      "2026-11-09",
      "2026-11-08",
      "2026-11-07",
      "2026-11-06",
      "2026-11-05",
      "2026-11-02",
      "2026-11-01",
    ]);
    // Newest first all the way down: the list is already in descending order.
    expect(entryDates).toEqual([...entryDates].sort().reverse());
  });

  // h120-methodology-1 (c): each new entry names the change it logs, the numbers
  // from the constants the code runs on, never typed.
  describe("the 2026-11-08 to 2026-11-10 CHANGELOG entries (h120-methodology-1)", () => {
    async function changelogEntry(date: string): Promise<string> {
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");
      const tail = text.slice(text.indexOf("Son güncelleme:"));
      // From "<date> " to the next ISO date (the next entry), or the end.
      const start = tail.indexOf(`${date} `, "Son güncelleme: ".length + date.length);
      expect(start).toBeGreaterThan(0);
      const rest = tail.slice(start + date.length + 1);
      const next = rest.search(/\d{4}-\d{2}-\d{2}/);
      return next === -1 ? rest : rest.slice(0, next);
    }

    it("2026-11-10 is wording only: the Jev threshold, the cards' and the cluster page's new wording, and 'the rule did not change'", async () => {
      const entry = await changelogEntry("2026-11-10");

      expect(RECALL_MATCH_MIN_PROB).toBe(0.7);
      expect(entry).toContain(`%${Math.round(RECALL_MATCH_MIN_PROB * 100)}`);
      expect(entry).toContain(RECALL_MATCH_NOTE);
      expect(entry).toContain("“Sadece X yazdı” yerine “Kümede sadece X”");
      expect(entry).toContain("Kör nokta kuralının kendisi değişmedi; yalnızca ifade değişti.");
    });

    it("2026-11-09 has the Başka kaynaklarla aynı başlık ve özet change (every cluster) and the rare-stem tier, numbers from SIBLING_VETO", async () => {
      const entry = await changelogEntry("2026-11-09");

      expect(entry).toContain("Başka kaynaklarla aynı başlık ve özet");
      expect(entry).toContain("kaynağın yer aldığı her kümeyi");
      expect(entry).toContain("tek kaynaktan dağıtım");
      expect(entry).toContain(`%${Math.round(SIBLING_VETO.looseMinJaccard * 100)}`);
      expect(entry).toContain(
        `%${(SIBLING_VETO.rareMaxDocShare * 100).toLocaleString("tr-TR")}'inde`,
      );
      expect(entry).toContain(`en az ${SIBLING_VETO.rareMinShared} seyrek kökü`);
      expect(entry).toContain(`yine en az ${SIBLING_VETO.looseMinShared}`);
      expect(entry).toContain("seyrek kök");
      expect(entry).toContain("aynı olay sayılıyor");
      // The veto still only withdraws the claim when the added sources break the threshold.
      expect(entry).toContain("baskınlık eşiği tutmuyorsa kör nokta işareti gösterilmiyor");
    });

    it("2026-11-08 says the list drops a story below the independent-text share, and that the label can still show on the card and the story page", async () => {
      const entry = await changelogEntry("2026-11-08");

      expect(BLINDSPOT_LIST_FILTERS.minIndependentTextRatio).toBe(0.5);
      expect(entry).toContain(
        `%${Math.round(BLINDSPOT_LIST_FILTERS.minIndependentTextRatio * 100)}'den azı birbirinden farklıysa`,
      );
      expect(entry).toContain("aynı içerik özeti ya da aynı başlık tek metin sayılır");
      expect(entry).toContain("kartta ve haber sayfasında yine görünebilir");
    });

    it("quotes no typed digit: every number in the ten entries from 2026-11-08 up comes from a constant (the three 2026-11-13, the 2026-11-12 and the three 2026-11-11 ones included, h176-methodtruth-1, h130-blindspots-2, h138-roadmap2-1)", () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const source = readFileSync(join(here, "page.tsx"), "utf8");
      // The CHANGELOG array, from its opening to the first entry older than these ten.
      const block = source.slice(source.indexOf("const CHANGELOG = ["), source.indexOf('date: "2026-11-07"'));
      const entries = block.split(/\n\s*\{\n/).filter((piece) => piece.includes("text:"));
      expect(entries).toHaveLength(10);
      for (const entry of entries) {
        const text = entry.slice(entry.indexOf("text:")).replace(/\$\{[^}]*\}/g, "#");
        expect(text).not.toMatch(/\d/);
      }
    });
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
    // It comes before the 2026-11-02 and 2026-11-01 sibling-veto entries. The marker
    // carries the date: the 2026-11-09 entry (h120-methodology-1) opens its second
    // sentence with the same "Kör nokta doğrulaması genişledi:" and sits above this one.
    expect(tail.indexOf(entry)).toBeLessThan(
      tail.indexOf("2026-11-02 Kör nokta doğrulaması genişledi:"),
    );
    expect(tail.indexOf("2026-11-02 Kör nokta doğrulaması genişledi:")).toBeGreaterThan(0);
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
    // footer (the newest entry's date), then the three 2026-11-13 entries, the 2026-11-12
    // one and the three 2026-11-11 ones (h176-methodtruth-1; h138-roadmap2-1 and
    // h130-blindspots-2 among them), the 2026-11-10, -09 and -08 entries
    // (h120-methodology-1), the 2026-11-07, 2026-11-06 (h62-methodology-2),
    // 2026-11-05 and 2026-11-02 (h62-methodology-1) entries, then this one.
    expect(dates.slice(0, 16)).toEqual([
      "2026-11-13",
      "2026-11-13",
      "2026-11-13",
      "2026-11-13",
      "2026-11-12",
      "2026-11-11",
      "2026-11-11",
      "2026-11-11",
      "2026-11-10",
      "2026-11-09",
      "2026-11-08",
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
    // h176-methodtruth-1: the Kapsama karnesi item (id=kapsama-karnesi) is the last thing in
    // the section, so it is the one id between the section heading and Başlıklar.
    expect(ids.indexOf("kapsama-karnesi")).toBe(ids.indexOf("kaynak-gostergeleri") + 1);
    expect(ids.indexOf("basliklar")).toBe(ids.indexOf("kapsama-karnesi") + 1);
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
    // h103-sourcescores-1: the share counts every cluster the source is in, not
    // only the ones the wire gate flags, so the definition carries no gate.
    expect(text).toContain(
      "Kaynağın yer aldığı haber kümelerinden, ilk haberinin başlığı ve özeti başka bir kaynağın haberiyle birebir aynı (aynı parmak izi) olanların payı. Küme büyüklüğü aranmaz; toplayıcı siteler sayılmaz.",
    );
    expect(text).toContain(
      "Karşılaştırma başlık ve özetin parmak iziyle yapılır; haber gövdesi karşılaştırılmaz.",
    );
    expect(text).not.toContain("kaynak başına bir haber alındığında en az 3 haber");
    expect(text).not.toContain("ajans dağıtımı sayılan kümelerde");
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
    // footer, then the three 2026-11-13 entries, the 2026-11-12 one and the three
    // 2026-11-11 ones (h176-methodtruth-1; h138-roadmap2-1, h130-blindspots-2),
    // the 2026-11-10, -09 and -08 entries (h120-methodology-1), the
    // 2026-11-07 balance/English entry, the 2026-11-06 column
    // entry, the 2026-11-05 feed-delay entry, the 2026-11-02 unclustered-arm
    // entry (148), the 2026-11-01 sibling-veto entry (126), then the three
    // 2026-10-22 entries
    expect(dates.slice(0, 19)).toEqual([
      "2026-11-13",
      "2026-11-13",
      "2026-11-13",
      "2026-11-13",
      "2026-11-12",
      "2026-11-11",
      "2026-11-11",
      "2026-11-11",
      "2026-11-10",
      "2026-11-09",
      "2026-11-08",
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

// h120-methodology-1: the Kör nokta and Sürpriz rule cards said "en az 5 kaynak",
// but both rules count the voting sources only (detectBlindspot reads the voting
// tally, cross-spectrum.ts filters isVotingSource), so a cluster of 7 members of
// which 4 vote is not a Kör nokta. Copy only: the numbers still come from
// BLINDSPOT / SURPRISE.
describe("/metodoloji page: the Kör nokta and Sürpriz cards count voting sources only (h120-methodology-1)", () => {
  async function renderTree() {
    const { default: MethodologyPage } = await import("./page");
    return MethodologyPage();
  }

  function section(tree: unknown, id: string): Node {
    const found = findElement(
      tree,
      (el) => el.type === "section" && el.props?.["aria-labelledby"] === id,
    );
    expect(found).not.toBeNull();
    return found as Node;
  }

  /** The text of the rule card (dt + dd) inside `sectionNode` whose term is `term`. */
  function cardText(sectionNode: Node, term: string): string {
    const card = findElement(
      sectionNode,
      (el) =>
        el.type === "div" && collectText(el.props?.children).join("").startsWith(term),
    );
    expect(card).not.toBeNull();
    return collectText(card).join("");
  }

  const dominantSharePct = Math.round(BLINDSPOT.dominantShare * 100);
  const surpriseSharePct = Math.round(SURPRISE.dominantShare * 100);

  it("Kör nokta 'Kaynak eşiği' asks for voting sources (haber kuruluşu ya da ajans), the number from BLINDSPOT.minSources", async () => {
    const tree = await renderTree();
    const card = cardText(section(tree, "kor-nokta"), "Kaynak eşiği");

    expect(card).toBe(
      `Kaynak eşiğiKümede en az ${BLINDSPOT.minSources} oy veren kaynak (haber kuruluşu ya da ajans) yer almalı,`,
    );
    expect(card).toContain(`en az ${BLINDSPOT.minSources} oy veren kaynak`);
    expect(BLINDSPOT.minSources).toBe(5);
  });

  it("Kör nokta 'Baskınlık eşiği' takes the share of the voting sources and says aggregators and niche sources are not counted", async () => {
    const tree = await renderTree();
    const card = cardText(section(tree, "kor-nokta"), "Baskınlık eşiği");

    expect(card).toBe(
      `Baskınlık eşiğive bu oy veren kaynakların tek bir Medya DNA bölgesi (İktidar, Bağımsız veya Muhalefet) payı ≥ %${dominantSharePct} olmalı; toplayıcı ve niş kaynaklar sayılmaz.`,
    );
    expect(dominantSharePct).toBe(80);
  });

  it("the paragraph under the cards names the voting-source floor", async () => {
    const tree = await renderTree();
    const kor = collectText(section(tree, "kor-nokta")).join("");

    expect(kor).toContain(`Kümede ${BLINDSPOT.minSources} oy veren kaynaktan azı varsa`);
    expect(kor).not.toContain(`Kümede ${BLINDSPOT.minSources} kaynaktan azı varsa`);
  });

  it("Sürpriz 'Kaynak eşiği' and 'Baskınlık eşiği' read the voting sources, numbers from SURPRISE", async () => {
    const tree = await renderTree();
    const surpriz = section(tree, "surpriz");

    expect(cardText(surpriz, "Kaynak eşiği")).toBe(
      `Kaynak eşiğiKümede en az ${SURPRISE.minSources} oy veren kaynak varsa,`,
    );
    expect(cardText(surpriz, "Baskınlık eşiği")).toBe(
      `Baskınlık eşiğibir Medya DNA bölgesi oy veren kaynakların ≥ %${surpriseSharePct}'ini oluşturuyorsa,`,
    );
    expect(SURPRISE.minSources).toBe(5);
    expect(surpriseSharePct).toBe(65);
  });

  it("Sürpriz 'Karşı taraf + marj' counts voting sources too, the margin from SURPRISE.minMargin", async () => {
    const tree = await renderTree();
    const card = cardText(section(tree, "surpriz"), "Karşı taraf + marj");

    expect(card).toBe(
      `Karşı taraf + marjve karşıt bölgeden en az bir oy veren kaynak habere yer vermiş, baskın bölgedeki oy veren kaynak sayısı ise karşıt bölgedekinden en az ${SURPRISE.minMargin} fazla olmalı.`,
    );
  });

  it("the page no longer says the bare 'kaynak' thresholds", async () => {
    const text = collectText(await renderTree()).join("");

    expect(text).not.toContain(`Kümede en az ${BLINDSPOT.minSources} kaynak yer almalı`);
    expect(text).not.toContain(`Kümede en az ${SURPRISE.minSources} kaynak varsa`);
    expect(text).not.toContain("ve bu kaynakların tek bir Medya DNA bölgesi");
    expect(text).not.toContain("bir Medya DNA bölgesi kümenin ≥");
  });

  it("states the thresholds in one text node, so the sentence reads as written in the HTML", async () => {
    const tree = await renderTree();
    const dd = findElement(
      tree,
      (el) =>
        el.type === "dd" &&
        typeof el.props?.children === "string" &&
        el.props.children.startsWith("Kümede en az"),
    );
    expect(dd).not.toBeNull();
    expect(collectText(dd).join("")).toContain(
      "oy veren kaynak (haber kuruluşu ya da ajans) yer almalı",
    );
  });
});

// h130-blindspots-2: the page presented the 24 h wait as the catch-up window, but the
// sibling veto searches SIBLING_VETO.scopeHours (48 h) and the cron re-scores any
// blindspot touched in the last 26 h, so a claim can still be withdrawn after it went
// public (3 cron vetoes on clusters first published 2026-10-28 to 2026-11-11 came 25.6
// to 34.8 h after first_published). Copy only: no rule, no threshold, no query changed.
describe("/metodoloji page: a public claim can be withdrawn after the wait (h130-blindspots-2)", () => {
  const WITHDRAWN_SENTENCE = `Kardeş başlık denetimi bir haberi ilk yayından sonraki ${SIBLING_VETO.scopeHours} saat boyunca yeniden tarar; bu yüzden etiket göründükten sonra da kaldırılabilir. Kaldırılan haber Kör Noktalar listesinden ve RSS akışından çıkar.`;

  async function pageText(): Promise<string> {
    const { default: MethodologyPage } = await import("./page");
    return collectText(await MethodologyPage()).join("");
  }

  it("says the sibling check rescans for SIBLING_VETO.scopeHours hours after first publication, so the label can be withdrawn after it shows", async () => {
    const text = await pageText();

    // Read from the constants the code runs on, never typed: the scan is longer than the wait.
    expect(SIBLING_VETO.scopeHours).toBeGreaterThan(BLINDSPOT.feedDelayHours);
    expect(text).toContain(`${SIBLING_VETO.scopeHours} saat boyunca`);
    expect(text).toContain("kaldırılabilir");
    expect(text).toContain(WITHDRAWN_SENTENCE);
  });

  it("follows the feed-delay sentence in the same Kör nokta section, before the Jev paragraph, and the delay sentence itself is unchanged", async () => {
    const text = await pageText();

    const delay = `ilk yayından ${BLINDSPOT.feedDelayHours} saat sonra görünür — veritabanındaki işaretleme anlıktır.`;
    const delayAt = text.indexOf(delay);
    const mine = text.indexOf(WITHDRAWN_SENTENCE);
    const jevParagraph = text.indexOf("Tayf'ın kümeleyicisi aynı olayı bazen iki ayrı kümeye böler");
    expect(delayAt).toBeGreaterThan(0);
    expect(mine).toBe(delayAt + delay.length + 1);
    expect(jevParagraph).toBeGreaterThan(mine);
  });

  it("no longer presents the wait as a guarantee: it says nothing like 'bir daha kaldırılmaz'", async () => {
    const text = await pageText();

    expect(text).not.toContain("kaldırılmaz");
    expect(text).not.toContain("geri alınmaz");
  });

  it("the h130-blindspots-2 entry is dated 2026-11-11 (under the h138-roadmap2-1 entry of the same day, above the 2026-11-10 ones) and says the rule did not change", async () => {
    const text = await pageText();
    const entry = `Kör nokta etiketinin, göründükten sonra da ilk ${SIBLING_VETO.scopeHours} saat içinde kaldırılabileceği açıkça yazıldı; kural değişmedi.`;

    const tail = text.slice(text.indexOf("Son güncelleme:"));
    // Its date directly precedes its text; the h138-roadmap2-1 entry of the same day sits above it.
    expect(tail).toContain(`2026-11-11 ${entry}`);
    expect(tail.indexOf("2026-11-11 Ajans ağırlıklı rozeti")).toBeLessThan(
      tail.indexOf(`2026-11-11 ${entry}`),
    );
    expect(tail.indexOf(`2026-11-11 ${entry}`)).toBeLessThan(
      tail.indexOf("2026-11-10 Kör nokta ifadesi:"),
    );
    const entryDates = tail.match(/\d{4}-\d{2}-\d{2}/g)?.slice(1) ?? [];
    // h176-methodtruth-1: the 2026-11-13 and -12 entries sit above the 2026-11-11 ones.
    expect(entryDates[0]).toBe("2026-11-13");
    expect(entryDates).toEqual([...entryDates].sort().reverse());
  });
});

// h138-roadmap2-1: the wire rule now links members that share the same agency lead
// (description) under a reworded headline. The "Tek kaynaktan dağıtım" card says so,
// and the 2026-11-11 CHANGELOG entry logs it; the number comes from the constant.
describe("/metodoloji page: same agency lead is one text (h138-roadmap2-1)", () => {
  async function pageText() {
    const { default: MethodologyPage } = await import("./page");
    return collectText(await MethodologyPage()).join("");
  }
  const ENTRY_CORE =
    "Ajans ağırlıklı rozeti artık aynı ajans özetini paylaşan ama başlığı değiştirilmiş haberleri de tek metin sayıyor";

  it("the Tek kaynaktan dağıtım card says the same fingerprint or the same summary counts as one text, with the floor from the constant", async () => {
    const text = await pageText();
    // The card's two paragraphs: from its first sentence to the "/kalite" note.
    const start = text.indexOf("aslında birden fazla gazetecilik çabası değil");
    const end = text.indexOf("Güncel kalite sayıları:");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const card = text.slice(start, end);

    expect(SAME_DESCRIPTION_MIN_CHARS).toBe(40);
    expect(card).toContain(
      `aynı içerik parmak izine (content hash) ya da aynı haber özetine (RSS özeti; büyük/küçük harf, noktalama ve boşluk farkları yok sayılır, en az ${SAME_DESCRIPTION_MIN_CHARS} karakter) sahip haberler tek metin sayılır`,
    );
    expect(card).toContain("başlığını değiştirip ajansın özetini aynen basan haber de kopya sayılır");
    // The ratio keeps its published value, and the badge the page now names is the one on the cards.
    expect(card).toContain(`benzersiz metin oranı ≤ %${Math.round(WIRE_UNIQUE_HASH_RATIO * 100)}`);
    expect(card).toContain("Ajans ağırlıklı");
    expect(card).toContain("benzersiz metin sayısına indirilir");
    // The headline paragraph keeps its own meaning: the independent-headline count is untouched.
    expect(card).toContain("Tayf ayrıca aynı başlığı kullanan kaynakları sayar");
    expect(card).toContain("12 kaynak · 4 bağımsız başlık");
  });

  it("no longer describes the rule as hash-only", async () => {
    const text = await pageText();
    expect(text).not.toContain("makalelerin içerik özetlerinin (content hash) kaçının birbirinden");
    expect(text).not.toContain("benzersiz dispeç sayısına indirilir");
  });

  it("the 2026-11-11 entry that logs it stays the first of that day, above the h130-blindspots-2 entry (h176-methodtruth-1: the 2026-11-13 and -12 entries now sit above both)", async () => {
    const text = await pageText();
    const tail = text.slice(text.indexOf("Son güncelleme:"));

    const entry = `${ENTRY_CORE} (özet en az ${SAME_DESCRIPTION_MIN_CHARS} karakter olmalı); bu kümelerde gösterilen kaynak sayısı da buna göre düşüyor. Oran eşiği (%${Math.round(WIRE_UNIQUE_HASH_RATIO * 100)}) değişmedi.`;
    // Its date directly precedes its text, after the 2026-11-12 entry.
    expect(tail).toContain(`2026-11-11 ${entry}`);
    expect(tail.indexOf("2026-11-12 Ücretli tanıtım içerikleri")).toBeLessThan(
      tail.indexOf(`2026-11-11 ${entry}`),
    );
    expect(tail.indexOf(`2026-11-11 ${entry}`)).toBeLessThan(
      tail.indexOf("2026-11-11 Kör nokta etiketinin, göründükten sonra da"),
    );
    // It says the ratio did not move, so it is not a rule change of the threshold.
    expect(entry).toContain("Oran eşiği");
    expect(entry).toContain("değişmedi");
  });
});

// h176-methodtruth-1: /metodoloji lagged the rule changes of 2026-11-11 to 2026-11-13. It now
// says what is dropped before it counts as news (paid-content.ts, ad-link.ts, legal-notice.ts,
// notice-only-clusters.ts), the cadence floor (reliability.ts, feed-window.ts, feed-status.ts),
// the Kapsama karnesi (karne.ts) and the wire card's member floor (wire.ts). Every number below
// is read from the constant the code runs on, and each statement is also run against the
// function it describes, so the copy cannot drift from the code unnoticed.
describe("/metodoloji page: what Tayf does not count as news (h176-methodtruth-1)", () => {
  async function renderTree() {
    const { default: MethodologyPage } = await import("./page");
    return MethodologyPage();
  }
  const byId = (tree: unknown, id: string) => findElement(tree, (el) => el.props?.id === id);
  const sectionOf = (tree: unknown, id: string) =>
    findElement(tree, (el) => el.type === "section" && el.props?.["aria-labelledby"] === id);
  const textOfEl = (el: unknown) => collectText(el).join("");

  describe("the Habere sayılmayanlar card", () => {
    it("is a card with id=habere-sayilmayanlar, the last child of the #kaynaklar section, after the category card", async () => {
      const tree = await renderTree();
      const section = sectionOf(tree, "kaynaklar");
      expect(section).not.toBeNull();
      expect(collectIds(section)).toContain("habere-sayilmayanlar");
      const children = section?.props?.children as unknown[];
      const last = children[children.length - 1] as Node;
      expect(last.props?.id).toBe("habere-sayilmayanlar");
      // The category table card is above it, not replaced by it.
      expect(collectIds(section).indexOf("habere-sayilmayanlar")).toBeGreaterThan(
        collectIds(section).indexOf("kaynaklar"),
      );
      expect(textOfEl(last).startsWith("Habere sayılmayanlar")).toBe(true);
    });

    it("names every PAID_CONTENT_SEGMENTS value (imported, not retyped), the first AD_CLICK_HOSTS, 'ilan' and the search-engine closure", async () => {
      const card = textOfEl(byId(await renderTree(), "habere-sayilmayanlar"));

      expect(PAID_CONTENT_SEGMENTS.length).toBeGreaterThan(0);
      for (const segment of PAID_CONTENT_SEGMENTS) expect(card).toContain(segment);
      expect(card).toContain(PAID_SECTIONS);
      expect(card).toContain("doubleclick.net");
      expect(AD_CLICK_HOSTS[0]).toBe("doubleclick.net");
      for (const host of AD_CLICK_HOSTS.slice(0, 3)) expect(card).toContain(host);
      expect(card).toContain("ilan");
      expect(card.includes("noindex") || card.includes("arama motorlarına kapalı")).toBe(true);
    });

    it("states the four rules in plain Turkish, the paid sections and the example hosts from the constants", async () => {
      const card = textOfEl(byId(await renderTree(), "habere-sayilmayanlar"));

      expect(card).toContain(
        `Adresinin ilk iki yol bölümünden biri ${PAID_SECTIONS} olan içerikler (ücretli tanıtım yazıları ve basın bültenleri) haber olarak kaydedilmez.`,
      );
      expect(card).toContain(
        "Mahkeme, icra ve ihale ilanları (Basın İlan Kurumu resmî ilanları, EKAP ihale duyuruları) haber olarak kaydedilmez; yalnızca bu tür ilanlardan oluşan haber sayfaları arama motorlarına kapalıdır (noindex).",
      );
      expect(card).toContain(
        `Reklam ve tıklama izleme adreslerine giden bağlantılar (ör. ${AD_HOST_EXAMPLES}; alt alan adları dahil) haber olarak kaydedilmez.`,
      );
      expect(card).toContain(
        "Bu yüzden bir kaynağın Tayf'ta görünen haber sayısı, RSS akışındaki öğe sayısından az olabilir.",
      );
      // The rules run when an item is taken from the feed: an older stored item can still exist.
      expect(card).toContain(
        "Bu kurallar kaynaktan alma sırasında çalışır; kuraldan önce kaydedilmiş benzer içerikler olabilir.",
      );
    });

    it("the paid-content sentence is true of isPaidContentUrl: the first or the second path segment, whole, not the third", () => {
      for (const segment of PAID_CONTENT_SEGMENTS) {
        expect(isPaidContentUrl(`https://example.com/${segment}/yazi-1`)).toBe(true);
        expect(isPaidContentUrl(`https://example.com/tr/${segment}/yazi-1`)).toBe(true);
        expect(isPaidContentUrl(`https://example.com/a/b/${segment}/yazi-1`)).toBe(false);
        expect(isPaidContentUrl(`https://example.com/haber/${segment}-ajansi-kuruldu-1`)).toBe(false);
      }
    });

    it("the ad-link sentence is true of isAdClickLink: each example host and its subdomains, not a lookalike", () => {
      for (const host of AD_CLICK_HOSTS.slice(0, 3)) {
        expect(isAdClickLink(`https://${host}/clk?id=1`)).toBe(true);
        expect(isAdClickLink(`https://pubads.g.${host}/gampad/clk?id=1`)).toBe(true);
        expect(isAdClickLink(`https://not${host}/clk?id=1`)).toBe(false);
        expect(isAdClickLink(`https://${host}.example.com/clk?id=1`)).toBe(false);
      }
    });

    it("the notice sentence is true of isLegalNotice and isNoticeOnlyCluster: court, icra and EKAP notices drop; real news and a mixed cluster do not", () => {
      type Member = { title: string; url: string; description?: string | null };
      const court: Member = { title: "T.C. SAMSUN 2. SULH HUKUK MAHKEMESİNDEN", url: "https://example.com/a/1" };
      const icra: Member = { title: "BAKIRKÖY GAYRİMENKUL SATIŞ İCRA DAİRESİ", url: "https://example.com/a/2" };
      const tender: Member = {
        title: "ÜMRANİYE BELEDİYE BAŞKANLIĞI",
        url: "https://example.com/a/3",
        description: "4734 sayılı Kamu İhale Kanunu'nun 21/b maddesi gereği ihale edilecektir.",
      };
      const news: Member = { title: "Anayasa Mahkemesi CHP'nin başvurusunu reddetti", url: "https://example.com/a/4" };
      // The 2026-11-13 widening (migration 210): a notice under a mixed-case title that only its
      // summary marks ("İlan-"). Title and url alone do not drop it, the summary does.
      const dashed: Member = {
        title: "Kırıkhan Asliye Ceza Mahkemesi ilanı",
        url: "https://example.com/a/5",
        description: "İlan-T.C. Kırıkhan 2. Asliye Ceza Mahkemesi 2024/1 Esas sayılı dosya",
      };

      for (const notice of [court, icra, tender]) {
        expect(isLegalNotice(notice.title, notice.url, notice.description)).toBe(true);
      }
      expect(isLegalNotice(news.title, news.url)).toBe(false);
      // The tender law alone, under a mixed-case title, is real news and is not dropped.
      expect(isLegalNotice(news.title, news.url, tender.description)).toBe(false);

      expect(isLegalNotice(dashed.title, dashed.url)).toBe(false);
      expect(isLegalNotice(dashed.title, dashed.url, dashed.description)).toBe(true);

      expect(isNoticeOnlyCluster([court, tender, dashed])).toBe(true);
      expect(isNoticeOnlyCluster([court, news])).toBe(false);
      expect(isNoticeOnlyCluster([])).toBe(false);
    });
  });

  describe("the Yayın sıklığı definition", () => {
    const FLOOR_SENTENCE = `Akışı her seferinde yalnızca son haberleri veren ve bu sınırı son ${OVERFLOW_DAYS} günde aşan kaynaklarda değer “en az … haber/gün” diye gösterilir; bazı haberler Tayf’a ulaşmamıştır.`;

    async function cadenceDd(): Promise<string> {
      const dd = findElement(
        await renderTree(),
        (el) =>
          el.type === "dd" &&
          textOfEl(el).startsWith(`Son ${KARNE_WINDOW_DAYS} günde yayımlanan haber sayısının`),
      );
      expect(dd).not.toBeNull();
      return textOfEl(dd);
    }

    it("contains 'en az' as the cadence floor, with the overflow window read from WINDOW_OVERFLOW_RECENT_MS", async () => {
      const dd = await cadenceDd();

      expect(OVERFLOW_DAYS).toBe(7);
      expect(dd).toContain("en az");
      expect(dd).toContain(FLOOR_SENTENCE);
      // The existing definition is kept, the floor comes after it.
      expect(dd).toContain(
        `Son ${KARNE_WINDOW_DAYS} günde yayımlanan haber sayısının ${KARNE_WINDOW_DAYS}’a bölümü; etkin gün, en az bir haber yayımlanan takvim günüdür (Türkiye saati).`,
      );
      expect(dd.indexOf("Türkiye saati")).toBeLessThan(dd.indexOf("“en az … haber/gün”"));
    });

    it("says what WINDOW_OVERFLOW_NOTE (the note the source page prints) says: the feed shows only its newest items, in the last OVERFLOW_DAYS days", async () => {
      const dd = await cadenceDd();

      for (const phrase of [
        "her seferinde yalnızca son haberleri",
        `son ${OVERFLOW_DAYS} günde`,
      ]) {
        expect(WINDOW_OVERFLOW_NOTE).toContain(phrase);
        expect(dd).toContain(phrase);
      }
    });

    it("is true of buildReliabilityView: 'en az <rate> haber/gün' only when the feed window overflowed recently", () => {
      const rel = toSourceReliability({
        source_id: "9236e05a-56d9-47b0-a378-02ec8e880180",
        window_days: KARNE_WINDOW_DAYS,
        window_start: "2026-08-29T21:00:00Z",
        window_end: "2026-09-28T21:00:00Z",
        n_articles: 600,
        active_days: 30,
        n_clusters: 100,
        n_wire_copy: 12,
        zone_mix: [
          [2, 2, 1, 10],
          [0, 5, 0, 5],
        ],
        computed_at: "2026-09-29T00:00:00Z",
      });
      expect(rel).not.toBeNull();
      const valueOf = (recent: boolean) =>
        buildReliabilityView(rel!, null, { windowOverflowRecent: recent }).find((r) => r.key === "cadence")?.value;

      expect(valueOf(true)?.startsWith("en az ")).toBe(true);
      expect(valueOf(true)).toContain(" haber/gün");
      expect(valueOf(false)?.startsWith("en az ")).toBe(false);
    });
  });

  describe("the Kapsama karnesi definition", () => {
    async function karneItem() {
      const tree = await renderTree();
      const section = sectionOf(tree, "kaynak-gostergeleri");
      expect(section).not.toBeNull();
      expect(collectIds(section)).toContain("kapsama-karnesi");
      const item = byId(section, "kapsama-karnesi");
      expect(item).not.toBeNull();
      return { tree, item };
    }

    it("is an item with id=kapsama-karnesi inside #kaynak-gostergeleri, headed 'Kapsama karnesi' (dt)", async () => {
      const { item } = await karneItem();
      const dt = findElement(item, (el) => el.type === "dt");
      expect(textOfEl(dt)).toBe("Kapsama karnesi");
      expect(findElement(item, (el) => el.type === "dd")).not.toBeNull();
    });

    it("contains the window, both floors and the staleness hours, read from the karne constants", async () => {
      const { item } = await karneItem();
      const text = textOfEl(item);

      expect(text).toContain(String(KARNE_MIN_CLUSTERS));
      expect(text).toContain(String(KARNE_MIN_MULTI_FOR_ZONES));
      expect(text).toContain(String(KARNE_WINDOW_DAYS));
      expect(text).toContain(`son ${KARNE_WINDOW_DAYS} gün`);
      expect(text).toContain(`en az ${KARNE_MIN_CLUSTERS} haber kümesi yoksa karne yerine “yeterli haber yok” notu gösterilir`);
      expect(text).toContain(`en az ${KARNE_MIN_MULTI_FOR_ZONES} çok kaynaklı haber`);
      expect(text).toContain("günde bir kez yeniden hesaplanır");
      expect(text).toContain(`${KARNE_STALE_AFTER_HOURS} saatten eski`);
    });

    it("defines the four things the card shows: the shared share, the unmatched share, the other zones, the kör nokta count", async () => {
      const { item } = await karneItem();
      const text = textOfEl(item);
      const k = toSourceKarne({
        source_id: "9236e05a-56d9-47b0-a378-02ec8e880180",
        window_days: KARNE_WINDOW_DAYS,
        window_start: "2026-08-30T12:00:00Z",
        window_end: "2026-09-29T12:00:00Z",
        n_clusters: 120,
        n_multi: 60,
        co_iktidar: 30,
        co_bagimsiz: 45,
        co_muhalefet: 15,
        n_blindspot: 6,
        n_blindspot_same_side: 2,
        computed_at: "2026-09-29T06:00:00Z",
      })!;
      const view = buildKarneView(k);
      expect(view.state).toBe("ok");
      if (view.state !== "ok") return;

      // The labels the card prints on a source page, so a reader finds them here word for word.
      expect(text).toContain("Başka kaynakların da yazdığı haberler");
      expect(text).toContain("Tayf'ın başka bir kaynakla eşleştiremediği haberler");
      expect(text).toContain("Aynı haberi yazan diğer kaynakların bölgesi");
      expect(view.zoneHeader.startsWith("Aynı haberi yazan diğer kaynakların bölgesi")).toBe(true);
      // The zone note of the card, whole: a story can count for several zones, so they need not add up to 100.
      expect(text).toContain(view.zoneNote);
      expect(text).toContain("Kör nokta işaretli haberler");
      expect(view.blindspotText.startsWith("Kör nokta işaretli haberler")).toBe(true);
    });

    it("the floors are true of buildKarneView: under KARNE_MIN_CLUSTERS no figures, under KARNE_MIN_MULTI_FOR_ZONES no zone rows", () => {
      const row = (nClusters: number, nMulti: number) =>
        toSourceKarne({
          source_id: "9236e05a-56d9-47b0-a378-02ec8e880180",
          window_days: KARNE_WINDOW_DAYS,
          window_start: "2026-08-30T12:00:00Z",
          window_end: "2026-09-29T12:00:00Z",
          n_clusters: nClusters,
          n_multi: nMulti,
          co_iktidar: 0,
          co_bagimsiz: 0,
          co_muhalefet: 0,
          n_blindspot: 0,
          n_blindspot_same_side: 0,
          computed_at: "2026-09-29T06:00:00Z",
        })!;

      expect(buildKarneView(row(KARNE_MIN_CLUSTERS - 1, 0)).state).toBe("insufficient");
      const atFloor = buildKarneView(row(KARNE_MIN_CLUSTERS, KARNE_MIN_MULTI_FOR_ZONES - 1));
      expect(atFloor.state).toBe("ok");
      expect(atFloor.state === "ok" && atFloor.zones).toBeNull();
      const withZones = buildKarneView(row(KARNE_MIN_CLUSTERS, KARNE_MIN_MULTI_FOR_ZONES));
      expect(withZones.state === "ok" && withZones.zones).toHaveLength(3);
    });

    it("the staleness hours are true of karneFreshness: older than KARNE_STALE_AFTER_HOURS is stale, exactly that is not", () => {
      const computedAt = "2026-09-29T06:00:00Z";
      const at = Date.parse(computedAt) + KARNE_STALE_AFTER_HOURS * 3_600_000;
      expect(karneFreshness(computedAt, at).isStale).toBe(false);
      expect(karneFreshness(computedAt, at + 1).isStale).toBe(true);
    });

    it("the source page's 'Nasıl hesaplanıyor?' link lands on this item", async () => {
      const { tree } = await karneItem();
      const k = toSourceKarne({
        source_id: "9236e05a-56d9-47b0-a378-02ec8e880180",
        window_days: KARNE_WINDOW_DAYS,
        window_start: "2026-08-30T12:00:00Z",
        window_end: "2026-09-29T12:00:00Z",
        n_clusters: 120,
        n_multi: 60,
        co_iktidar: 30,
        co_bagimsiz: 45,
        co_muhalefet: 15,
        n_blindspot: 6,
        n_blindspot_same_side: 2,
        computed_at: "2026-09-29T06:00:00Z",
      })!;
      const card = SourceKarneCard({ karne: { ...k, isStale: false, ageDays: 0 }, slug: "sozcu" });
      const link = findElement(
        card,
        (el) => typeof el.props?.href === "string" && textOfEl(el) === "Nasıl hesaplanıyor?",
      );
      expect(link?.props?.href).toBe("/metodoloji#kapsama-karnesi");
      const [path, fragment] = String(link?.props?.href).split("#");
      expect(path).toBe("/metodoloji");
      expect(collectIds(tree)).toContain(fragment);
      // ... and the old target is still a real section, but no longer the karne's link.
      expect(collectIds(tree)).toContain("kaynaklar");
    });
  });

  describe("the Tek kaynaktan dağıtım card", () => {
    it("says the floor: 'En az WIRE_MIN_MEMBERS farklı kaynaktan haberi olan kümelerde ...; daha küçük kümeler işaretlenmez.'", async () => {
      const card = textOfEl(sectionOf(await renderTree(), "tek-kaynak"));

      expect(WIRE_MIN_MEMBERS).toBe(3);
      expect(card).toContain(`En az ${WIRE_MIN_MEMBERS} farklı kaynaktan`);
      expect(card).toContain(
        `En az ${WIRE_MIN_MEMBERS} farklı kaynaktan haberi olan kümelerde, benzersiz metin oranı ≤ %${Math.round(WIRE_UNIQUE_HASH_RATIO * 100)} ise küme "tek kaynaktan dağıtım" olarak işaretlenir`,
      );
      expect(card).toContain("Daha küçük kümeler işaretlenmez.");
    });

    it("is true of detectWireRedistribution: the same text in WIRE_MIN_MEMBERS - 1 members is not marked, in WIRE_MIN_MEMBERS it is", () => {
      const same = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ id: `a${i}`, content_hash: "h" }));
      expect(detectWireRedistribution(same(WIRE_MIN_MEMBERS - 1)).isWire).toBe(false);
      expect(detectWireRedistribution(same(WIRE_MIN_MEMBERS)).isWire).toBe(true);
    });
  });

  describe("the CHANGELOG entries of 2026-11-11 to 2026-11-13", () => {
    async function tailOf(): Promise<string> {
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");
      return text.slice(text.indexOf("Son güncelleme:"));
    }

    it("the footer reads 'Son güncelleme: 2026-11-13'", async () => {
      const tail = await tailOf();
      expect(tail.startsWith("Son güncelleme: 2026-11-13")).toBe(true);
    });

    it("lists the five entries under their dates, newest first, each date directly before its text", async () => {
      const tail = await tailOf();
      const at = (date: string, entry: string) => {
        const index = tail.indexOf(`${date} ${entry}`);
        expect(index, `${date} ${entry.slice(0, 40)}`).toBeGreaterThan(0);
        return index;
      };

      const notices = at("2026-11-13", NOTICES_ENTRY);
      const cadence = at("2026-11-13", CADENCE_ENTRY);
      const copy = at("2026-11-13", COPY_ENTRY);
      const paid = at("2026-11-12", PAID_ENTRY);
      const ad = at("2026-11-11", AD_ENTRY);
      const tenth = tail.indexOf("2026-11-10 Kör nokta ifadesi:");
      expect(notices).toBeLessThan(cadence);
      expect(cadence).toBeLessThan(copy);
      expect(copy).toBeLessThan(paid);
      expect(paid).toBeLessThan(tail.indexOf("2026-11-11 Ajans ağırlıklı rozeti"));
      expect(tail.indexOf("2026-11-11 Ajans ağırlıklı rozeti")).toBeLessThan(ad);
      expect(ad).toBeLessThan(tenth);
    });

    it("the 2026-11-13 notice entry says the summary-marked court notices and EKAP tenders are dropped too, and notice-only pages are closed to search engines", async () => {
      expect(NOTICES_ENTRY).toContain("özeti “İlan-” ile başlayan mahkeme ilanları ve EKAP ihale duyuruları da artık haber olarak kaydedilmiyor");
      expect(NOTICES_ENTRY).toContain("arama motorlarına kapalı");
      expect((await tailOf()).includes(NOTICES_ENTRY)).toBe(true);
    });

    it("the 2026-11-12 entry names every paid url section, the 2026-11-11 entry the example ad hosts, the cadence entry the overflow days", () => {
      for (const segment of PAID_CONTENT_SEGMENTS) expect(PAID_ENTRY).toContain(`/${segment}/`);
      for (const host of AD_CLICK_HOSTS.slice(0, 3)) expect(AD_ENTRY).toContain(host);
      expect(CADENCE_ENTRY).toContain(`son ${WINDOW_OVERFLOW_RECENT_MS / DAY_MS} günde`);
    });
  });

  describe("source guard", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pageSource = readFileSync(join(here, "page.tsx"), "utf8");

    it("imports the constants it prints instead of retyping them", () => {
      expect(pageSource).toContain("PAID_CONTENT_SEGMENTS");
      expect(pageSource).toContain("AD_CLICK_HOSTS");
      expect(pageSource).toContain("WIRE_MIN_MEMBERS");
      expect(pageSource).toContain("WINDOW_OVERFLOW_RECENT_MS");
      expect(pageSource).toContain("_shared/rss/paid-content");
      expect(pageSource).toContain("_shared/rss/ad-link");
    });

    it("does not spell the segments, the hosts or the floor as literals in the copy", () => {
      for (const segment of PAID_CONTENT_SEGMENTS) {
        expect(pageSource, segment).not.toContain(`"${segment}"`);
        expect(pageSource, segment).not.toContain(`/${segment}/`);
      }
      for (const host of AD_CLICK_HOSTS) expect(pageSource, host).not.toContain(host);
      expect(pageSource).not.toContain("En az 3 haberi");
      expect(pageSource).not.toContain("son 7 günde");
    });
  });
});

// h120-methodology-1 (e): the page text outside the CHANGELOG is the published rule
// contract. This pin makes any edit to it visible in review.
describe("/metodoloji page: rule text pin (h120-methodology-1)", () => {
  // If this fails and the change alters a rule or the meaning of a published number,
  // add a CHANGELOG entry; then update the hash.
  // h126-a11y-2: 93291c7d... -> d4d007b9... adds exactly one string, the sr-only
  // caption "Kategori tanımları" of the category table (assistive-technology
  // label, no rule and no published number). Removing that caption restores the
  // old hash, so no CHANGELOG entry.
  // h130-blindspots-2: d4d007b9... -> 8b500eb4... adds exactly one sentence to the
  // feed-delay paragraph of "Kör nokta nedir" (the sibling check rescans a story for
  // SIBLING_VETO.scopeHours, so the label can be withdrawn after it showed; checked by
  // rendering the HEAD page and this one: the new text is the old text with that
  // sentence inserted after "veritabanındaki işaretleme anlıktır.", nothing else).
  // It changes what the page tells a reader about the wait, so it has the 2026-11-11
  // CHANGELOG entry ("kural değişmedi": no threshold, delay, veto or query moved).
  // h138-roadmap2-1: 8b500eb4... -> b386e447... rewrites exactly one paragraph of the
  // "Tek kaynaktan dağıtım" card (its first, the wire rule): the flag now reads "the
  // same content fingerprint OR the same RSS summary of SAME_DESCRIPTION_MIN_CHARS
  // characters or more counts as one text", names the "Ajans ağırlıklı" badge, and says
  // "benzersiz metin" where it said "benzersiz içerik" / "benzersiz dispeç". The code
  // changed with it (wire.ts links members that share a summary), so it has the second
  // 2026-11-11 CHANGELOG entry; the ratio (WIRE_UNIQUE_HASH_RATIO) did not move.
  // h176-methodtruth-1: b386e447... -> b2fd400c... adds five things and changes nothing else
  // (checked by rendering the HEAD page and this one and diffing the two texts, as above): the
  // "Habere sayılmayanlar" card at the end of #kaynaklar (paid url sections, court and tender
  // notices, ad-click hosts: all three already enforced at ingest), the cadence floor sentence
  // of "Yayın sıklığı", the "Kapsama karnesi" item of #kaynak-gostergeleri, and in the Tek
  // kaynaktan dağıtım card the sentence's opening "En az WIRE_MIN_MEMBERS haberi olan
  // kümelerde," (it began "Benzersiz"; reworded to "farklı kaynaktan haberi olan" below) plus "Daha küçük kümeler işaretlenmez." (wire.ts's
  // floor, unchanged since the card was written). No rule or threshold moved: copy only,
  // logged by the three 2026-11-13 CHANGELOG entries and the 2026-11-12 and 2026-11-11 ones.
  // h177 review (h176-methodtruth-1 wording): b2fd400c... -> 7044f6d5... inserts exactly one
  // phrase, "farklı kaynaktan" (distinct sources), into that same sentence's opening, which now
  // reads "En az WIRE_MIN_MEMBERS farklı kaynaktan haberi olan kümelerde,". Both callers
  // (politics-query dedupedMembers, timeline-query dedupeEarliestPerSource) keep one member per
  // source before detectWireRedistribution, so the floor counts sources, not articles. The rule
  // did not move: copy only, logged by the 2026-11-13 "kural değişmedi" entry.
  const RULES_SHA256 = "7044f6d5b149855b5c075b9d469d7707e903d4377e76d208f639f8f627866e9d";

  it("the rendered text of everything above the CHANGELOG hashes to the pinned value", async () => {
    // The two inputs that are not the page's own text: the registry-backed tagged
    // count (an empty registry prints zeros) and the contact mailto.
    mockNeutralStatus = { neutralized: 0, eligible: 12 };
    mockActiveSlugs = [];
    mockExtraMetadata = {};
    const originalEmail = process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    try {
      vi.resetModules();
      const { default: MethodologyPage } = await import("./page");
      const text = collectText(await MethodologyPage()).join("");
      const rules = text.slice(0, text.indexOf("Son güncelleme:"));

      // Non-vacuous: the rule cards and the prompt are in the pinned text.
      expect(rules).toContain(`en az ${BLINDSPOT.minSources} oy veren kaynak`);
      expect(rules).toContain(HEADLINE_PROMPT_TEMPLATE);
      expect(rules).not.toContain("2026-11-");

      expect(createHash("sha256").update(rules).digest("hex")).toBe(RULES_SHA256);
    } finally {
      if (originalEmail === undefined) delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
      else process.env.NEXT_PUBLIC_CONTACT_EMAIL = originalEmail;
      mockActiveSlugs = ["sabah", "anadolu-ajansi", "bilinmeyen-kaynak"];
    }
  });
});

// h126-a11y-2 (WCAG 1.3.1, technique H63): the category cell that names each row
// of the "Kaynaklar nasıl etiketleniyor" table was a <td>, so a screen reader read
// "İktidar" with no category in front of it. It is now <th scope="row"> (text-left
// and the old font-medium made explicit: th is bold and centred by default), and
// the table has an sr-only caption.
describe("/metodoloji page: category table row headers (h126-a11y-2)", () => {
  async function renderTree() {
    const { default: MethodologyPage } = await import("./page");
    return MethodologyPage();
  }

  /** Every element (depth-first) whose props match `pred`. */
  function allMatching(node: unknown, pred: (el: Node) => boolean, out: Node[] = []): Node[] {
    if (Array.isArray(node)) {
      for (const child of node) allMatching(child, pred, out);
      return out;
    }
    if (node && typeof node === "object") {
      const el = node as Node;
      if (el.props && pred(el)) out.push(el);
      if (el.props?.children !== undefined) allMatching(el.props.children, pred, out);
    }
    return out;
  }

  const rowHeads = (tree: unknown) =>
    allMatching(tree, (el) => el.type === "th" && el.props?.scope === "row");
  const tokens = (el: Node | undefined): string[] => String(el?.props?.className).split(/\s+/);

  it("renders one th scope=row per WRITABLE_SOURCE_BIAS row, and the first reads the first category", async () => {
    const tree = await renderTree();
    const heads = rowHeads(tree);

    expect(heads).toHaveLength(WRITABLE_SOURCE_BIAS.length);
    expect(WRITABLE_SOURCE_BIAS).toHaveLength(5);
    expect(collectText(heads[0]).join("")).toBe(BIAS_LABELS[WRITABLE_SOURCE_BIAS[0]!]);
    expect(heads.map((h) => collectText(h).join(""))).toEqual(
      WRITABLE_SOURCE_BIAS.map((k) => BIAS_LABELS[k]),
    );
  });

  it("makes the category the th and the zone the td in every row", async () => {
    const tbody = findElement(await renderTree(), (el) => el.type === "tbody");
    const rows = (tbody?.props?.children ?? []) as Array<{ props: { children: Node[] } }>;

    expect(rows).toHaveLength(WRITABLE_SOURCE_BIAS.length);
    for (const row of rows) {
      expect(row.props.children.map((c) => c.type)).toEqual(["th", "td"]);
    }
  });

  it("keeps the font-medium look and sets text-left on the row header", async () => {
    const heads = rowHeads(await renderTree());
    expect(heads).toHaveLength(WRITABLE_SOURCE_BIAS.length);
    for (const th of heads) {
      for (const token of ["py-2.5", "pr-4", "font-medium", "text-foreground", "text-left"]) {
        expect(tokens(th), token).toContain(token);
      }
      expect(tokens(th)).not.toContain("font-bold");
    }
  });

  it("gives the table an sr-only caption 'Kategori tanımları' as its first child", async () => {
    const tables = allMatching(await renderTree(), (el) => el.type === "table");
    expect(tables).toHaveLength(1);
    const children = tables[0]!.props?.children as Node[];
    expect(children[0]!.type).toBe("caption");
    expect(tokens(children[0])).toContain("sr-only");
    expect(collectText(children[0]).join("")).toBe("Kategori tanımları");
  });
});
