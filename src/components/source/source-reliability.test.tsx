import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { SourceReliabilityCard } from "./source-reliability";
import { toSourceKarne, type SourceKarneRead } from "@/lib/sources/karne";
import {
  toSourceReliability,
  type SourceReliabilityRead,
} from "@/lib/sources/reliability";

function reliability(
  over: Partial<SourceReliabilityRead> = {},
): SourceReliabilityRead {
  return {
    ...toSourceReliability({
      source_id: "9236e05a-56d9-47b0-a378-02ec8e880180",
      window_days: 30,
      window_start: "2026-08-30T12:00:00Z",
      window_end: "2026-09-29T12:00:00Z",
      n_articles: 600,
      active_days: 30,
      n_clusters: 100,
      n_wire_copy: 12,
      zone_mix: [
        [2, 2, 2, 10],
        [5, 0, 0, 10],
      ],
      computed_at: "2026-09-29T06:00:00Z",
    })!,
    isStale: false,
    ageDays: 0,
    ...over,
  };
}

function karne(over: Partial<SourceKarneRead> = {}): SourceKarneRead {
  return {
    ...toSourceKarne({
      source_id: "9236e05a-56d9-47b0-a378-02ec8e880180",
      window_days: 30,
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
    })!,
    isStale: false,
    ageDays: 0,
    ...over,
  };
}

function html(
  r: SourceReliabilityRead | null,
  k: SourceKarneRead | null = karne(),
  slug = "sozcu",
): string {
  return renderToStaticMarkup(
    createElement(SourceReliabilityCard, { reliability: r, karne: k, slug }),
  );
}

// renderToStaticMarkup HTML-escapes apostrophes; compare on decoded text.
function text(
  r: SourceReliabilityRead | null,
  k: SourceKarneRead | null = karne(),
  slug = "sozcu",
): string {
  return html(r, k, slug)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("SourceReliabilityCard", () => {
  it("renders nothing for a null reliability row (even with a karne row)", () => {
    expect(html(null)).toBe("");
    expect(html(null, null)).toBe("");
  });

  it("renders the title and the window subtitle", () => {
    const t = text(reliability());
    expect(t).toContain("Kaynak göstergeleri");
    expect(t).toContain("Son 30 gün · Tayf’ın yayın akışından hesaplanan sayılar");
    expect(html(reliability())).toContain("<h2");
  });

  it("a fresh row has no stale banner", () => {
    const h = html(reliability());
    expect(h).not.toContain("veriler güncel değil");
    expect(h).not.toContain("text-amber-700");
  });

  it("a stale row swaps the subtitle for the amber stale line and keeps the rows", () => {
    const r = reliability({ isStale: true, ageDays: 9 });
    const t = text(r);
    expect(t).toContain("Son hesaplama 9 gün önce — veriler güncel değil");
    expect(t).not.toContain("Tayf’ın yayın akışından hesaplanan sayılar");
    expect(html(r)).toContain(
      '<p class="text-[11px] font-medium text-amber-700 dark:text-amber-400">Son hesaplama 9 gün önce — veriler güncel değil</p>',
    );
    expect(t).toContain("%12 (12/100)");
  });

  it("renders the four labels in order, each with a 'Nasıl hesaplanır?' disclosure", () => {
    const h = html(reliability());
    const t = text(reliability());
    const labels = [
      "Yayın sıklığı",
      "Başka kaynaklarla aynı başlık ve özet",
      "Kör nokta kümelerindeki payı",
      "Bölge çeşitliliği",
    ];
    let last = -1;
    for (const l of labels) {
      const i = t.indexOf(l);
      expect(i, `label ${l}`).toBeGreaterThan(last);
      last = i;
    }
    expect(t.split("Nasıl hesaplanır?")).toHaveLength(5);
    expect(h.match(/<details/g)).toHaveLength(4);
    expect(h.match(/<summary class="text-\[11px\]/g)).toHaveLength(4);
    expect(h.match(/<dt/g)).toHaveLength(4);
    expect(h.match(/<dd/g)).toHaveLength(4);
  });

  it("renders the values and the 'how' texts", () => {
    const t = text(reliability());
    expect(t).toContain("20 haber/gün · 30/30 gün yayın");
    expect(t).toContain("%12 (12/100)");
    expect(t).toContain("%5 (6/120)");
    expect(t).toContain("Ortalama Denge puanı 50/100 (n = 20 küme)");
    expect(t).toContain(
      "Son 30 günün haber sayısı 30’a bölünür; etkin gün, en az bir haber yayımlanan gündür (Türkiye saati).",
    );
    expect(t).toContain(
      "Ajans dağıtımı sayılan kümelerde başlığı ve özeti başka bir kaynakla aynı olan haberlerin payı (haber gövdesi karşılaştırılmaz); yön belirtmez.",
    );
    expect(t).toContain(
      "Kaynağın yer aldığı haber kümelerinden kör nokta olarak işaretlenenlerin payı (Kapsama karnesiyle aynı sayım).",
    );
    expect(t).toContain(
      "En az 5 oy veren kaynağı olan kümelerin Denge puanı ortalaması (0 tek bölge, 100 üç bölgeye eşit).",
    );
  });

  it("shows the insufficient-sample note instead of a value below the gates", () => {
    const r = reliability({ nClusters: 19, nWireCopy: 3, zoneMix: [[2, 2, 2, 9]] });
    const t = text(r);
    expect(t).toContain("Yeterli örnek yok (n = 19, en az 20).");
    expect(t).toContain("Yeterli örnek yok (n = 9, en az 10).");
    expect(t).not.toContain("%16 (3/19)");
    expect(t).not.toContain("Ortalama Denge puanı");
    // Cadence and the karne-based blindspot share are not gated by these.
    expect(t).toContain("20 haber/gün · 30/30 gün yayın");
    expect(t).toContain("%5 (6/120)");
  });

  it("explains a missing karne row on the blindspot line only", () => {
    const t = text(reliability(), null);
    expect(t).toContain("Kapsama karnesi henüz hesaplanmadı.");
    expect(t).toContain("%12 (12/100)");
  });

  it("says so when the source published nothing", () => {
    const t = text(
      reliability({ nArticles: 0, activeDays: 0, nClusters: 0, nWireCopy: 0, zoneMix: [] }),
    );
    expect(t).toContain("Son 30 günde haber yok");
  });

  it("clamps active_days = window_days + 1 on screen", () => {
    const t = text(reliability({ activeDays: 31 }));
    expect(t).toContain("30/30 gün yayın");
    expect(t).not.toContain("31/30");
  });

  it("renders the neutral footnote", () => {
    expect(text(reliability())).toContain(
      "Bu göstergeler bir doğruluk ya da kalite notu değildir; yalnızca Tayf’ın gördüğü yayın akışını özetler. Ajans haberi kullanmak olağan bir yayıncılık pratiğidir.",
    );
  });

  it("has the method link and the dispute link, encoding the slug", () => {
    const h = html(reliability(), karne(), "a b&c/ü");
    expect(h).toContain('href="/metodoloji#kaynak-gostergeleri"');
    expect(h).toContain(">Yöntem<");
    expect(h).toContain(
      `href="/metodoloji?source=${encodeURIComponent("a b&c/ü").replace(/&/g, "&amp;")}#duzeltme"`,
    );
    expect(h).toContain("Bu sayılara itiraz et");
  });

  it("never renders accusatory or judging wording", () => {
    const variants = [
      html(reliability()),
      html(reliability({ isStale: true, ageDays: 4 })),
      html(reliability({ nClusters: 5, nWireCopy: 5, zoneMix: [] }), null),
      html(reliability({ nArticles: 0, activeDays: 0, nClusters: 0, nWireCopy: 0, zoneMix: [] })),
    ];
    for (const v of variants) {
      const t = v.replace(/<[^>]+>/g, " ");
      expect(t).not.toMatch(/güvenilmez|intihal|kopyacı|yalan|taraflı/i);
    }
  });

  it("uses literal Tailwind classes with no opacity-modified text tokens", () => {
    const h = html(reliability({ isStale: true, ageDays: 2 }));
    expect(h).not.toMatch(/\btext-(?:muted-foreground|brand)\/\d+/);
    expect(h).toContain("text-muted-foreground");
  });
});
