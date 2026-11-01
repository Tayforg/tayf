import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { BIAS_LABELS, BLINDSPOT, SURPRISE, ZONE_META } from "@/lib/bias/config";
import {
  BALANCE_BALANCED_MIN,
  BALANCE_LABELS,
  BALANCE_MIN_SOURCES,
  BALANCE_ONE_SIDED_MAX,
} from "@/lib/bias/balance";
import { WIRE_UNIQUE_HASH_RATIO } from "@/lib/clusters/wire";
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
import { OWNER_GROUPS } from "@/lib/sources/ownership";
import {
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
    expect(text).toContain(`En az ${HEADLINE_MIN_ARTICLE_COUNT} kaynağı`);

    for (const label of Object.values(BIAS_LABELS)) {
      expect(text).toContain(label);
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
    const sentences = [
      "Aynı olay bazen neredeyse aynı başlıkla ikinci bir kümeye düşer.",
      `Bu yüzden ${SIBLING_VETO.windowHours} saat içindeki diğer kümelerde başlığı büyük ölçüde örtüşen haberler de aranır (kelimelerin en az yarısı ve en az ${SIBLING_VETO.minShared} kelime ortak olmalı).`,
      "Bu haberleri veren kaynaklar da sayıma eklenir; baskınlık eşiği artık tutmuyorsa kör nokta işareti yine gösterilmez.",
    ];
    for (const sentence of sentences) expect(text).toContain(sentence);
    expect(text).toContain(sentences.join(" "));

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

  it("lists the sibling-veto CHANGELOG entry first, dated 2026-11-01, and the footer follows it", async () => {
    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    const entry =
      "Kör nokta doğrulaması genişledi: aynı olayı neredeyse aynı başlıkla veren kardeş bir kümede karşı taraf da varsa kör nokta işareti gösterilmiyor.";
    expect(text).toContain(entry);
    const tail = text.slice(text.indexOf("Son güncelleme:"));
    expect(/Son güncelleme: (\d{4}-\d{2}-\d{2})/.exec(tail)?.[1]).toBe("2026-11-01");
    // The entry is the first list item: its date directly precedes its text.
    expect(tail).toContain(`2026-11-01 ${entry}`);
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
        "tek bölgeden gelen kapsama 0, üç bölgeye eşit dağılan kapsama 100 alır; iki bölgeye eşit bölünen bir küme yaklaşık 63 alır.",
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
      `Eşiğe ulaşmayan ama tek bir bölgenin ağırlıkta olduğu haberler Kör Noktalar sayfasında ayrı bir “Kör noktaya yakın” bölümünde listelenir: en az ${BLINDSPOT.minSources} oy veren kaynak ve en büyük bölgenin payı %${nearPct} ile %${dominantSharePct} arasında (%${dominantSharePct} hariç). Aynı ${BLINDSPOT.feedDelayHours} saatlik bekleme, kalite filtreleri ve besleme sağlığı kuralı uygulanır; son ${NEAR_BLINDSPOT_LOOKBACK_DAYS} günden en fazla ${NEAR_BLINDSPOT_DISPLAY_LIMIT} haber gösterilir. Bu haberler kör nokta sayılmaz; kör nokta sayımlarına ve “Bu listede kim yer vermedi?” özetine katılmaz.`,
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
    expect(String(heading?.props?.className)).toContain("scroll-mt-24");
  });

  it("adds its changelog entry as the newest line, dated 2026-10-22", async () => {
    const { default: MethodologyPage } = await import("./page");
    const text = collectText(await MethodologyPage()).join("");

    expect(text).toContain(
      "Kör noktaya yakın: kör nokta eşiğinin hemen altında kalan, tek bölgenin ağırlıkta olduğu haberler Kör Noktalar sayfasında ayrı bir bölümde listeleniyor.",
    );
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
      "Kaynak sayfalarındaki göstergeler Tayf’ın gördüğü yayın akışından hesaplanan sayılardır; bir doğruluk ya da kalite notu değildir ve hiçbir sıralamayı değiştirmez. Örnek sayısı yetersizse gösterge gizlenir.",
    );
    expect(text).toContain("kalite notu değildir");
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
    // footer, then the 2026-11-01 sibling-veto entry (126), then the three 2026-10-22 entries
    expect(dates.slice(0, 5)).toEqual([
      "2026-11-01",
      "2026-11-01",
      "2026-10-22",
      "2026-10-22",
      "2026-10-22",
    ]);
    expect([...dates].sort().at(-1)).toBe(dates[0]);
  });
});
