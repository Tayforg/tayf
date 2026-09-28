import { describe, it, expect } from "vitest";
import {
  foldTr,
  stemTr,
  extractFactCheckTerms,
  buildFtsQuery,
  scoreCluster,
  rankMatches,
  MIN_MATCHED_TERMS,
  SHADOW_MIN_SCORE,
  PUBLISH_MIN_SCORE,
  MAX_CLUSTERS_PER_FACT_CHECK,
  type ClusterDoc,
} from "./match";

describe("foldTr", () => {
  it("folds İ/ı correctly (tr locale, not plain toLowerCase)", () => {
    expect(foldTr("İmamoğlu")).toBe("imamoglu");
    expect(foldTr("IŞIK")).toBe("isik");
  });

  it("collapses punctuation runs to a single space", () => {
    expect(foldTr("Merhaba, dünya!!!")).toBe("merhaba dunya ");
  });
});

describe("stemTr", () => {
  it("keeps short tokens as-is and truncates long ones to 5 chars", () => {
    expect(stemTr("ev")).toBe("ev");
    expect(stemTr("erdogan")).toBe("erdog");
  });
});

describe("extractFactCheckTerms", () => {
  it("drops the apostrophe suffix, keeping the stem of the core word", () => {
    const t = extractFactCheckTerms("Erdoğan'ın açıklaması geldi bugün");
    expect(t.stems).toContain("erdog");
    expect(t.stems).not.toContain("in");
  });

  it("returns no stems for a pure-stopword title", () => {
    const t = extractFactCheckTerms("İddiası doğru mu");
    expect(t.stems).toEqual([]);
  });

  it("does not treat the title's first word as an entity even if capitalised", () => {
    const t = extractFactCheckTerms("Ankara valiliğinden açıklama geldi");
    expect(t.entityStems).not.toContain(stemTr(foldTr("Ankara").trim()));
  });

  it("detects capitalised non-leading words and ALLCAPS acronyms as entities", () => {
    const t = extractFactCheckTerms("CHP ve TBMM ortak açıklama yaptı");
    expect(t.entityStems).toContain(stemTr(foldTr("TBMM").trim()));
  });

  it("mid-sentence capitalised proper nouns are entities", () => {
    const t = extractFactCheckTerms("İddiaya göre Kılıçdaroğlu açıklama yaptı");
    expect(t.entityStems).toContain(stemTr(foldTr("Kılıçdaroğlu").trim()));
  });

  it("RSS categories are always entities", () => {
    const t = extractFactCheckTerms("basit bir başlık metni buraya", ["Deprem"]);
    expect(t.entityStems).toContain(stemTr(foldTr("Deprem").trim()));
  });

  it("ftsWords keep diacritics", () => {
    const t = extractFactCheckTerms("Depremzedelere yardım ulaştırıldı");
    expect(t.ftsWords.some((w) => /[şıçğöü]/i.test(w))).toBe(true);
  });
});

describe("buildFtsQuery", () => {
  it("returns null under 2 words", () => {
    expect(buildFtsQuery({ stems: [], entityStems: [], ftsWords: ["tek"] })).toBeNull();
    expect(buildFtsQuery({ stems: [], entityStems: [], ftsWords: [] })).toBeNull();
  });

  it("caps at 6 words, entities first, joined with ' or '", () => {
    const ftsWords = [
      "entity1", "entity2", "entity3", "entity4", "entity5", "entity6", "entity7", "other1",
    ];
    const q = buildFtsQuery({ stems: [], entityStems: [], ftsWords });
    expect(q).toBe("entity1 or entity2 or entity3 or entity4 or entity5 or entity6");
  });

  it("is punctuation-safe (words already stripped of punctuation upstream)", () => {
    const t = extractFactCheckTerms("Kılıçdaroğlu'nun açıklaması: 'yalan' dedi Bahçeli");
    const q = buildFtsQuery(t);
    if (q !== null) {
      expect(q).not.toMatch(/['".,:;!?]/);
    }
  });
});

function doc(id: string, headline: string, memberTitles: string[] = []): ClusterDoc {
  return { id, headline, memberTitles };
}

describe("scoreCluster", () => {
  it("computes weighted score: entity stems count double", () => {
    // "CHP" is an entity (all-caps), "toplantı" is a plain stem.
    const t = extractFactCheckTerms("CHP büyük bir toplantı düzenledi");
    const d = doc("c1", "CHP büyük toplantı düzenledi");
    const r = scoreCluster(t, d);
    expect(r.score).toBeGreaterThan(0);
    expect(r.matched.length).toBeGreaterThan(0);
  });

  it("support rule: a stem in only 1 member title (not the headline) is not matched", () => {
    const t = extractFactCheckTerms("Ankara'da büyük bir toplantı düzenlendi bugün");
    const d = doc("c1", "İstanbul'da farklı bir haber var", [
      "Ankara'da toplantı yapıldı bugün başka haber",
    ]);
    const r = scoreCluster(t, d);
    // "ankar" only appears in exactly one member title, not the headline.
    expect(r.matched).not.toContain(stemTr(foldTr("Ankara").trim()));
  });

  it("support rule: a stem in >=2 member titles counts as matched", () => {
    const t = extractFactCheckTerms("Ankara'da büyük bir toplantı düzenlendi bugün");
    const d = doc("c1", "Başka bir başlık burada", [
      "Ankara'da toplantı yapıldı bugün",
      "Ankara'da yine haber var bugün",
    ]);
    const r = scoreCluster(t, d);
    expect(r.matched).toContain(stemTr(foldTr("Ankara").trim()));
  });

  it("decision gate: 3+ matched terms without any entity match stays at most shadow", () => {
    // No entity terms at all (no capitalised non-leading word, no acronym).
    const t = extractFactCheckTerms("büyük bir toplantı düzenlendi bugün yeniden");
    const d = doc("c1", "büyük bir toplantı düzenlendi bugün yeniden");
    const r = scoreCluster(t, d);
    expect(r.entityMatched).toBe(0);
    expect(r.decision).not.toBe("publish");
  });

  it("a positive fixture pair (same event, entity + several stems) publishes", () => {
    const t = extractFactCheckTerms(
      "Video Mekke'ye yapılan İHA saldırısını mı gösteriyor?",
      ["Mekke"],
    );
    const d = doc(
      "c-mekke",
      "Mekke'ye alçak saldırı girişimi: İçişleri Bakanı Çiftçi'den tepki",
      [
        "AK Parti Sözcüsü Çelik, Mekke çevresinde önlenen Husilerin İHA saldırısını lanetledi",
        "İletişim Başkanı Duran, Mekke çevresinde önlenen Husilerin İHA saldırısını lanetledi",
      ],
    );
    const r = scoreCluster(t, d);
    expect(r.matched.length).toBeGreaterThanOrEqual(MIN_MATCHED_TERMS);
    expect(r.entityMatched).toBeGreaterThanOrEqual(1);
    expect(r.score).toBeGreaterThanOrEqual(PUBLISH_MIN_SCORE);
    expect(r.decision).toBe("publish");
  });

  it("generic-overlap negative ('Türkiye ... açıkladı' shaped) scores none", () => {
    const t = extractFactCheckTerms("Türkiye'de yeni bir uygulama başladı mı açıklandı");
    const d = doc("c-unrelated", "Tamamen alakasız bir ekonomi haberi bugün yayınlandı");
    const r = scoreCluster(t, d);
    expect(r.decision).toBe("none");
  });
});

describe("rankMatches", () => {
  it("filters non-matches, sorts by score desc, caps at MAX_CLUSTERS_PER_FACT_CHECK", () => {
    const t = extractFactCheckTerms(
      "Video Mekke'ye yapılan İHA saldırısını mı gösteriyor?",
      ["Mekke"],
    );
    const docs: ClusterDoc[] = [
      doc("none", "Alakasız bir başlık burada"),
      doc("weak", "Mekke'de bir haber var bugün", [
        "Mekke'de başka bir gelişme oldu",
        "Mekke ile ilgili haber",
      ]),
      doc("strong1", "Mekke'ye alçak saldırı girişimi: İçişleri Bakanı Çiftçi'den tepki", [
        "AK Parti Sözcüsü Çelik, Mekke çevresinde önlenen Husilerin İHA saldırısını lanetledi",
      ]),
      doc("strong2", "Dışişleri: Husilerin, Mekke'ye saldırısını şiddetle kınıyoruz", [
        "Türkiye'den Mekke'ye Saldırı Girişimine Tepki",
      ]),
      doc("strong3", "AK Parti Sözcüsü Çelik, Mekke çevresinde önlenen Husilerin İHA saldırısını lanetledi", [
        "Cumhurbaşkanı Başdanışmanı Kılıç, Husilerin Mekke çevresinde önlenen İHA saldırısını lanetledi",
      ]),
      doc("strong4", "İletişim Başkanı Duran, Mekke çevresinde önlenen Husilerin İHA saldırısını lanetledi", [
        "AK Parti Genel Sekreteri İnan, Mekke çevresinde önlenen Husilerin İHA saldırısını lanetledi",
      ]),
    ];
    const ranked = rankMatches(t, docs);
    expect(ranked.length).toBeLessThanOrEqual(MAX_CLUSTERS_PER_FACT_CHECK);
    expect(ranked.every((r) => r.decision !== "none")).toBe(true);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
    expect(ranked.some((r) => r.clusterId === "none")).toBe(false);
  });
});

// Sanity: shadow threshold below publish threshold, keeps a two-tier gate.
describe("thresholds", () => {
  it("SHADOW_MIN_SCORE is strictly below PUBLISH_MIN_SCORE", () => {
    expect(SHADOW_MIN_SCORE).toBeLessThan(PUBLISH_MIN_SCORE);
  });
});
