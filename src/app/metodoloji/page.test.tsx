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
