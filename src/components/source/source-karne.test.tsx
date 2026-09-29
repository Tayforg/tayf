import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { SourceKarneCard } from "./source-karne";
import { toSourceKarne, type SourceKarne } from "@/lib/sources/karne";

function karne(over: Partial<SourceKarne> = {}): SourceKarne {
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
    ...over,
  };
}

function html(k: SourceKarne | null, slug = "sozcu"): string {
  return renderToStaticMarkup(createElement(SourceKarneCard, { karne: k, slug }));
}

// renderToStaticMarkup HTML-escapes apostrophes; compare on decoded text.
function text(k: SourceKarne | null, slug = "sozcu"): string {
  return html(k, slug)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("SourceKarneCard", () => {
  it("renders nothing for a null karne", () => {
    expect(html(null)).toBe("");
  });

  it("renders title, subtitle with window and n", () => {
    const t = text(karne());
    expect(t).toContain("Kapsama karnesi");
    expect(t).toContain("Son 30 gün · 30.08.2026–29.09.2026 · n = 120 haber kümesi");
  });

  it("renders rows 1 and 2, zone block, note, blindspot row and footnote", () => {
    const t = text(karne());
    expect(t).toContain("Başka kaynakların da yazdığı haberler");
    expect(t).toContain("%50 (60/120)");
    expect(t).toContain("Tayf'ın başka bir kaynakla eşleştiremediği haberler");
    expect(t).toContain("Aynı haberi yazan diğer kaynakların bölgesi (60 çok kaynaklı haber)");
    expect(t).toContain("İktidar medyası");
    expect(t).toContain("Bağımsız medya");
    expect(t).toContain("Muhalefet medyası");
    expect(t).toContain("%50 (30/60)");
    expect(t).toContain("%75 (45/60)");
    expect(t).toContain("%25 (15/60)");
    expect(t.indexOf("İktidar medyası")).toBeLessThan(t.indexOf("Bağımsız medya"));
    expect(t.indexOf("Bağımsız medya")).toBeLessThan(t.indexOf("Muhalefet medyası"));
    expect(t).toContain(
      "Bir haber birden çok bölgeden kaynak içerebilir; oranların toplamı %100 değildir.",
    );
    expect(t).toContain(
      "Kör nokta işaretli haberler: 6 · 2 tanesinde haberi ağırlıkla yazan bölgedeydi",
    );
    expect(t).toContain("Kör noktalar →");
    expect(t).toContain(
      "Yalnızca Tayf'ın kümelediği (siyaset ve son dakika) haberler sayılır. Eşleştirilemeyen bir haber, başka kaynakların o olayı yazmadığı anlamına gelmez; farklı dildeki yayınlar ve eşleştirme hataları bu oranı etkiler. Karşı taraftan aynı olayı anlatan haber bulunan kümeler kör nokta sayısına dahil değildir. Son hesaplama: 29.09.2026.",
    );
    expect(t).toContain("Nasıl hesaplanıyor?");
    expect(t).toContain("Bu sayılara itiraz et");
  });

  it("has the right links and encodes the dispute slug", () => {
    const h = html(karne(), "a b&c/ü");
    expect(h).toContain('href="/blindspots"');
    expect(h).toContain('href="/metodoloji#kaynaklar"');
    expect(h).toContain(
      `href="/metodoloji?source=${encodeURIComponent("a b&c/ü").replace(/&/g, "&amp;")}#duzeltme"`,
    );
  });

  it("omits the same-side clause when there are no blindspots", () => {
    const t = text(karne({ nBlindspot: 0, nBlindspotSameSide: 0 }));
    expect(t).toContain("Kör nokta işaretli haberler: 0");
    expect(t).not.toContain("tanesinde");
  });

  it("shows the insufficient state below 20 clusters", () => {
    const t = text(karne({ nClusters: 19, nMulti: 5, nSolo: 14 }));
    expect(t).toContain("Kapsama karnesi");
    expect(t).toContain("Son 30 günde karne için yeterli haber yok (n = 19, en az 20 gerekir).");
    expect(t).not.toContain("Başka kaynakların da yazdığı haberler");
  });

  it("shows the zone-insufficient note when nMulti < 10", () => {
    const t = text(karne({ nClusters: 40, nMulti: 9, nSolo: 31 }));
    expect(t).toContain("Bölge dağılımı için yeterli çok kaynaklı haber yok (n = 9, en az 10).");
    expect(t).not.toContain("İktidar medyası");
  });

  it("never contains forbidden wording", () => {
    for (const k of [
      karne(),
      karne({ nClusters: 19, nMulti: 5, nSolo: 14 }),
      karne({ nMulti: 9, nSolo: 111 }),
    ]) {
      const t = text(k).toLowerCase();
      // Whole-word match: the mandated footnote says "yazmadığı" (a
      // different word that merely starts with "yazmadı"), so a plain
      // substring check would contradict the exact-copy assertion above.
      for (const w of ["yazmadı", "görmezden", "tık tuzağı", "başlık değiş"]) {
        expect(t).not.toMatch(new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, "u"));
      }
    }
  });
});
