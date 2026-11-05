import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { SourceKarneCard } from "./source-karne";
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

// Character scan (not a tag regex): every tag becomes one space.
function stripTags(markup: string): string {
  let out = "";
  let inTag = false;
  for (const ch of markup) {
    if (ch === "<") {
      inTag = true;
      out += " ";
    } else if (ch === ">" && inTag) {
      inTag = false;
    } else if (!inTag) {
      out += ch;
    }
  }
  return out;
}

// renderToStaticMarkup HTML-escapes apostrophes; compare on decoded text.
function text(
  r: SourceReliabilityRead | null,
  k: SourceKarneRead | null = karne(),
  slug = "sozcu",
): string {
  return stripTags(html(r, k, slug))
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("SourceReliabilityCard", () => {
  it("prints the karne basis under the blindspot value, in the muted 11px style", () => {
    const h = html(reliability());
    const basis =
      '<p class="text-[11px] text-muted-foreground">Oran, Kapsama karnesinin 29.09.2026 15:00 itibarıyla saydığı 120 haber kümesi üzerinden hesaplanır.</p>';
    expect(h).toContain(basis);
    // Exactly one row carries a basis, and it sits under the blindspot value
    // (after the value paragraph, before the disclosure of the next row).
    expect(h.split("Oran, Kapsama karnesinin").length - 1).toBe(1);
    const value = h.indexOf("%5 (6/120)");
    expect(value).toBeGreaterThan(-1);
    expect(h.indexOf(basis)).toBeGreaterThan(value);
    expect(h.indexOf(basis)).toBeLessThan(h.indexOf("Bölge çeşitliliği"));
  });

  it("prints no basis line when the karne row is missing", () => {
    const h = html(reliability(), null);
    expect(h).not.toContain("Oran, Kapsama karnesinin");
    expect(h).not.toContain("saydığı 120");
    expect(text(reliability(), null)).toContain("Kapsama karnesi henüz hesaplanmadı.");
  });

  it("renders nothing for a null reliability row (even with a karne row)", () => {
    expect(html(null)).toBe("");
    expect(html(null, null)).toBe("");
  });

  it("renders the title and a subtitle that says what is counted and as of when", () => {
    const t = text(reliability());
    expect(t).toContain("Kaynak göstergeleri");
    // window_end 2026-09-29T12:00:00Z is 15:00 in Istanbul.
    expect(t).toContain(
      "Son 30 gün · 29.09.2026 15:00 itibarıyla · bu kaynağın en az bir haberinin bulunduğu 100 haber kümesi",
    );
    expect(t).not.toContain("Tayf’ın yayın akışından hesaplanan sayılar");
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
    expect(t).not.toContain("bu kaynağın en az bir haberinin bulunduğu");
    expect(t).not.toContain("Son 30 gün ·");
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
    // The fixture window (12:00Z -> 12:00Z) is rolling, so it touches 31
    // Istanbul dates and 30 active days print as 30/31 (h41-derived-3).
    expect(t).toContain("20 haber/gün · 30/31 gün yayın");
    expect(t).toContain("%12 (12/100)");
    expect(t).toContain("%5 (6/120)");
    expect(t).toContain("Ortalama Denge puanı 50/100 (n = 20 küme)");
    expect(t).toContain(
      "Son 30 günün haber sayısı 30’a bölünür. Etkin gün, en az bir haber yayımlanan takvim günüdür (Türkiye saati); 30 günlük pencere 31 takvim gününe yayılır, ilk ve son gün kısmidir.",
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
    expect(t).toContain("20 haber/gün · 30/31 gün yayın");
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

  it("shows 31/31 for a source that published on every date the window touches", () => {
    const t = text(reliability({ activeDays: 31 }));
    expect(t).toContain("31/31 gün yayın");
    expect(t).not.toContain("30/30 gün yayın");
  });

  // h41-derived-3: /source/haberport printed "30/30 gün yayın" with no article
  // on 2026-10-24 (fayn: 2026-10-11) because 31 dates were clamped to 30.
  it("never prints 30/30 for a missed-day source on a rolling 31-date window (haberport shape)", () => {
    const t = text(
      reliability({
        windowStart: "2026-10-06T15:00:00.000Z",
        windowEnd: "2026-11-05T15:00:00.000Z",
        nArticles: 15_615,
        activeDays: 30,
      }),
    );
    expect(t).toContain("520,5 haber/gün · 30/31 gün yayın");
    expect(t).not.toContain("30/30");
  });

  it("keeps 30/30 and the short explanation on an Istanbul-midnight aligned window", () => {
    const t = text(
      reliability({
        windowStart: "2026-10-05T21:00:00.000Z",
        windowEnd: "2026-11-04T21:00:00.000Z",
        activeDays: 30,
      }),
    );
    expect(t).toContain("20 haber/gün · 30/30 gün yayın");
    expect(t).toContain(
      "Son 30 günün haber sayısı 30’a bölünür; etkin gün, en az bir haber yayımlanan gündür (Türkiye saati).",
    );
    expect(t).not.toContain("takvim gününe yayılır");
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
      const t = stripTags(v);
      expect(t).not.toMatch(/güvenilmez|intihal|kopyacı|yalan|taraflı/i);
    }
  });

  // h18-numbers-3 (2026-11-02): /source/medya-gazete printed "n = 149 haber
  // kümesi" (karne, window_end 2026-11-01T22:45Z) next to a reliability card
  // whose own clusters were counted at 2026-11-01T06:45Z (n = 244), both under
  // the same "Son 30 gün". Both counts use one definition; the cards must say
  // which instant each belongs to and what is counted.
  describe("h18 regression: two cluster counts, two labelled instants", () => {
    const karneProd = karne({
      nClusters: 149,
      windowStart: "2026-10-02T22:45:00.000Z",
      windowEnd: "2026-11-01T22:45:00.000Z",
      computedAt: "2026-11-01T22:45:00.000Z",
    });
    const reliabilityProd = reliability({
      nClusters: 244,
      windowStart: "2026-10-02T06:45:00.000Z",
      windowEnd: "2026-11-01T06:45:00.000Z",
      computedAt: "2026-11-01T06:45:00.000Z",
    });
    const karneHtml = renderToStaticMarkup(
      createElement(SourceKarneCard, { karne: karneProd, slug: "medya-gazete" }),
    );
    const reliabilityHtml = html(reliabilityProd, karneProd, "medya-gazete");

    it("the karne card names its own instant and count", () => {
      const t = stripTags(karneHtml).replace(/\s+/g, " ");
      expect(t).toContain(
        "02.11.2026 01:45 itibarıyla · bu kaynağın en az bir haberinin bulunduğu 149 haber kümesi",
      );
      expect(t).not.toContain("n = 149 haber kümesi");
    });

    it("the reliability card names its own instant and count, and the karne basis it divides by", () => {
      const t = stripTags(reliabilityHtml).replace(/\s+/g, " ");
      expect(t).toContain(
        "01.11.2026 09:45 itibarıyla · bu kaynağın en az bir haberinin bulunduğu 244 haber kümesi",
      );
      expect(t).toContain(
        "Oran, Kapsama karnesinin 02.11.2026 01:45 itibarıyla saydığı 149 haber kümesi üzerinden hesaplanır.",
      );
      expect(t).not.toContain("n = 149 haber kümesi");
      expect(t).not.toContain("n = 244 haber kümesi");
    });

    it("no card prints the old window start or the bare n = form for the cluster count", () => {
      for (const markup of [karneHtml, reliabilityHtml]) {
        const t = stripTags(markup);
        expect(t).not.toContain("n = 149 haber");
        // The window start dates (03.10.2026 / 02.10.2026) are not printed.
        expect(t).not.toContain("03.10.2026");
        expect(t).not.toContain("02.10.2026");
        expect(t).not.toContain("Tayf’ın yayın akışından hesaplanan sayılar");
      }
    });
  });

  it("uses literal Tailwind classes with no opacity-modified text tokens", () => {
    const h = html(reliability({ isStale: true, ageDays: 2 }));
    expect(h).not.toMatch(/\btext-(?:muted-foreground|brand)\/\d+/);
    expect(h).toContain("text-muted-foreground");
  });
});
