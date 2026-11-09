import { describe, it, expect } from "vitest";
import {
  foldTr,
  stemTr,
  extractFactCheckTerms,
  buildFtsQuery,
  scoreCluster,
  rankMatches,
  MATCH_METHOD,
  GENERIC_CLAIM_VERB_STEMS,
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
    expect(
      buildFtsQuery({ stems: [], entityStems: [], nameSpans: [], ftsWords: ["tek"] }),
    ).toBeNull();
    expect(
      buildFtsQuery({ stems: [], entityStems: [], nameSpans: [], ftsWords: [] }),
    ).toBeNull();
  });

  it("caps at 6 words, entities first, joined with ' or '", () => {
    const ftsWords = [
      "entity1", "entity2", "entity3", "entity4", "entity5", "entity6", "entity7", "other1",
    ];
    const q = buildFtsQuery({ stems: [], entityStems: [], nameSpans: [], ftsWords });
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

// ---------------------------------------------------------------------------
// h36-data-2: a person's first + last name plus one generic claim verb must
// not clear the publish gate (keyword-v2).
// ---------------------------------------------------------------------------

const FIDAN_TITLE = "Hakan Fidan'ın Almanca konuştuğu video gerçek mi?";
const TUGAY_TITLE =
  "Cemil Tugay’ın katıldığı temizlik çalışmalarını gösteren video güncel mi?";
const NASA_TITLE = "NASA astronotu Deniz Burnham’ın Türkçe konuştuğu video gerçek";
const PANAMA_TITLE = "Video Panama’da Gerçekleşen 7.7 Büyüklüğündeki Depremi mi Gösteriyor?";

describe("MATCH_METHOD", () => {
  it("is keyword-v2 so rows written by the name-span rule are distinguishable", () => {
    expect(MATCH_METHOD).toBe("keyword-v2");
  });
});

describe("GENERIC_CLAIM_VERB_STEMS", () => {
  it("holds exactly the claim-verb stems stemTr can produce", () => {
    expect([...GENERIC_CLAIM_VERB_STEMS].sort()).toEqual(
      ["acikl", "goste", "katil", "konus", "payla", "soyle", "yapti"].sort(),
    );
  });

  it("every entry is reachable: the stemmer keeps at most 5 characters", () => {
    for (const stem of GENERIC_CLAIM_VERB_STEMS) {
      expect(stem.length).toBeLessThanOrEqual(5);
      expect(stemTr(stem)).toBe(stem);
    }
  });

  it("maps real verb forms onto the set (paylaştı, konuştuğu, katıldığı, ...)", () => {
    for (const word of [
      "paylaştı",
      "paylaştığı",
      "konuştuğu",
      "katıldığı",
      "gösteren",
      "açıkladı",
      "söyledi",
      "yaptığı",
    ]) {
      expect(GENERIC_CLAIM_VERB_STEMS.has(stemTr(foldTr(word).trim()))).toBe(true);
    }
  });
});

describe("extractFactCheckTerms nameSpans", () => {
  it("finds the person name in a sentence-case title, first word allowed", () => {
    expect(extractFactCheckTerms(FIDAN_TITLE).nameSpans).toEqual([["hakan", "fidan"]]);
    expect(extractFactCheckTerms(TUGAY_TITLE).nameSpans).toEqual([["cemil", "tugay"]]);
  });

  it("finds a mid-title name that ends at its apostrophe word", () => {
    expect(extractFactCheckTerms(NASA_TITLE).nameSpans).toEqual([["deniz", "burnh"]]);
  });

  it("yields no spans for a Title Case title (Doğruluk Payı style)", () => {
    expect(extractFactCheckTerms(PANAMA_TITLE).nameSpans).toEqual([]);
    expect(
      extractFactCheckTerms(
        "Cemil Tugay’ın Katıldığı Temizlik Çalışmalarını Gösteren Video Güncel mi?",
      ).nameSpans,
    ).toEqual([]);
    expect(
      extractFactCheckTerms("Doğu Akdeniz'de Deniz Sınırları Neden Tartışmalı?").nameSpans,
    ).toEqual([]);
  });

  it("does not read an all-capitalised title as one long name", () => {
    // One run swallows the whole title; with no lowercase content word it is Title Case.
    expect(extractFactCheckTerms("Bir Okul Saldırısı Başlamadan Önlenebilir mi?").nameSpans).toEqual(
      [],
    );
    expect(
      extractFactCheckTerms("2. Trump Döneminde Avrupa’da Aşırı Sağ").nameSpans,
    ).toEqual([]);
  });

  it("keeps role + name runs of a sentence-case title as one name each", () => {
    expect(
      extractFactCheckTerms(
        "Dışişleri Bakanı Hakan Fidan’ın Adalet Bakanı Akın Gürlek’in elini sıkmadığı iddiası",
      ).nameSpans,
    ).toEqual([
      ["disis", "bakan", "hakan", "fidan"],
      ["adale", "bakan", "akin", "gurle"],
    ]);
  });

  it("stops a run before the next lowercase word when no apostrophe ends it", () => {
    expect(
      extractFactCheckTerms("Deniz Burnham astronotu mesaj verdi").nameSpans,
    ).toEqual([["deniz", "burnh"]]);
  });

  it("returns one span per name, each ending at its own apostrophe word", () => {
    expect(
      extractFactCheckTerms("Cemil Tugay’ın Kadir Topbaş’la görüştüğü iddia edilen video")
        .nameSpans,
    ).toEqual([
      ["cemil", "tugay"],
      ["kadir", "topba"],
    ]);
  });

  it("does not span a single capitalised word", () => {
    expect(
      extractFactCheckTerms("Erdoğan'ın açıklaması geldi bugün").nameSpans,
    ).toEqual([]);
  });

  it("does not merge two names separated by a comma", () => {
    expect(extractFactCheckTerms("Erdoğan, Bahçeli ile görüştü").nameSpans).toEqual([]);
  });

  it("does not count a leading stopword as part of a name", () => {
    // "Video" is a stopword: only "mekke" is left, which is not a 2-word name.
    expect(
      extractFactCheckTerms("Video Mekke'ye yapılan İHA saldırısını mı gösteriyor?")
        .nameSpans,
    ).toEqual([]);
  });

  it("is empty for an empty title, an all-lowercase title and RSS categories", () => {
    expect(extractFactCheckTerms("").nameSpans).toEqual([]);
    expect(extractFactCheckTerms("büyük bir toplantı düzenlendi").nameSpans).toEqual([]);
    expect(
      extractFactCheckTerms("basit bir başlık metni buraya", ["Hakan Fidan"]).nameSpans,
    ).toEqual([]);
  });

  it("keeps the existing stems and entityStems unchanged", () => {
    const t = extractFactCheckTerms(FIDAN_TITLE);
    expect(t.stems).toEqual(["hakan", "fidan", "alman", "konus"]);
    expect(t.entityStems).toEqual(["fidan", "alman"]);
  });
});

describe("scoreCluster distinctTerms", () => {
  function termsOf(stems: string[], nameSpans: string[][] = [], entityStems = stems.slice(0, 1)) {
    return { stems, entityStems, nameSpans, ftsWords: [] };
  }

  it("is exposed on the result and is 0 when nothing matches", () => {
    const r = scoreCluster(termsOf(["alpha", "beta"]), doc("c", "tamamen alakasız"));
    expect(r.distinctTerms).toBe(0);
  });

  it("counts a name span once however many of its stems matched", () => {
    const t = termsOf(["hakan", "fidan", "konus", "zirve"], [["hakan", "fidan"]], ["fidan"]);
    const r = scoreCluster(t, doc("c", "hakan fidan zirve"));
    expect(r.matched).toEqual(["hakan", "fidan", "zirve"]);
    expect(r.distinctTerms).toBe(2);
  });

  it("counts a span when only one of its stems matched", () => {
    const t = termsOf(["hakan", "fidan", "zirve"], [["hakan", "fidan"]], ["fidan"]);
    const r = scoreCluster(t, doc("c", "bakan fidan zirve"));
    expect(r.matched).toEqual(["fidan", "zirve"]);
    expect(r.distinctTerms).toBe(2);
  });

  it("does not count a span none of whose stems matched", () => {
    const t = termsOf(["hakan", "fidan", "zirve"], [["hakan", "fidan"]], ["fidan"]);
    const r = scoreCluster(t, doc("c", "bakan zirve"));
    expect(r.distinctTerms).toBe(1);
  });

  it("counts two different name spans separately", () => {
    const t = termsOf(
      ["cemil", "tugay", "kadir", "topba"],
      [
        ["cemil", "tugay"],
        ["kadir", "topba"],
      ],
      ["tugay"],
    );
    const r = scoreCluster(t, doc("c", "cemil tugay kadir topbaş"));
    expect(r.distinctTerms).toBe(2);
  });

  it("generic claim-verb stems still weigh in the score but never count as distinct terms", () => {
    const t = termsOf(["alpha", "beta", "konus", "katil"], [], ["alpha"]);
    const r = scoreCluster(t, doc("c", "alpha beta konus katil"));
    expect(r.matched).toEqual(["alpha", "beta", "konus", "katil"]);
    // alpha is an entity (weight 2); the two verb stems still carry weight 1
    // each, so 5 matched weight / 5 total weight.
    expect(r.score).toBe(1);
    expect(r.distinctTerms).toBe(2);
    expect(r.decision).toBe("shadow");
  });

  it("a third non-generic term lifts the same pair to publish", () => {
    const t = termsOf(["alpha", "beta", "gamma", "konus"], [], ["alpha"]);
    const r = scoreCluster(t, doc("c", "alpha beta gamma konus"));
    expect(r.distinctTerms).toBe(3);
    expect(r.decision).toBe("publish");
  });

  it("every generic verb stem is excluded from the distinct count", () => {
    for (const verb of GENERIC_CLAIM_VERB_STEMS) {
      const t = termsOf(["alpha", "beta", verb], [], ["alpha"]);
      const r = scoreCluster(t, doc("c", `alpha beta ${verb}`));
      expect(r.matched).toContain(verb);
      expect(r.distinctTerms).toBe(2);
      expect(r.decision).toBe("shadow");
    }
  });

  it("a name span keeps counting even when its stem is also a generic verb stem", () => {
    const t = termsOf(["konus", "katil", "zirve"], [["konus", "katil"]], ["zirve"]);
    const r = scoreCluster(t, doc("c", "konus katil zirve"));
    expect(r.distinctTerms).toBe(2);
  });

  it("the shadow rule is unchanged: 2 matched terms and score >= 0.3 stays shadow", () => {
    const t = termsOf(["alpha", "beta", "konus"], [], ["alpha"]);
    const r = scoreCluster(t, doc("c", "alpha konus"));
    expect(r.matched.length).toBe(2);
    expect(r.distinctTerms).toBe(1);
    expect(r.decision).toBe("shadow");
  });

  // ct-1, an accepted recall cost. A span is any run of 2+ capitalised words, so
  // a role before the name or a place after it joins the person's span and the
  // whole run counts once. The on-topic pair below has 4 matched stems and a
  // 0.727 score, so keyword-v1 (matched >= 3) would have published it; keyword-v2
  // sees 2 distinct terms (the span, and "g20") and parks it in shadow, where an
  // operator can promote it. A wrong box is worse than none, so the heuristic is
  // not loosened without labelled data. See "Known recall cost" in
  // docs/fact-checks.md.
  it("a role and a place that join the name's span cost recall: an on-topic pair lands in shadow", () => {
    const t = extractFactCheckTerms(
      "Cumhurbaşkanı Erdoğan Yeni Delhi'de G20 zirvesine katıldı mı?",
    );
    expect(t.nameSpans).toEqual([["cumhu", "erdog", "yeni", "delhi"]]);

    const r = scoreCluster(t, doc("c", "Erdoğan Yeni Delhi'de G20"));
    expect(r.matched).toEqual(["erdog", "yeni", "delhi", "g20"]);
    expect(r.distinctTerms).toBe(2);
    expect(r.score).toBe(0.727);
    expect(r.decision).toBe("shadow");
  });

  // secdb-2: two spans that share a stem are one person, not two pieces of
  // evidence. "Ali Veli", "Veli Ali" and "Ali Veli Can" all match through the
  // same two stems, so the pair has ONE distinct term and must not publish.
  it("overlapping name spans that share matched stems count once", () => {
    const t = extractFactCheckTerms("Ali Veli, Veli Ali, Ali Veli Can ne dedi?");
    expect(t.nameSpans).toEqual([
      ["ali", "veli"],
      ["veli", "ali"],
      ["ali", "veli", "can"],
    ]);

    const r = scoreCluster(t, doc("c", "Ali Veli"));
    expect(r.matched).toEqual(["ali", "veli"]);
    expect(r.distinctTerms).toBe(1);
    expect(r.decision).toBe("shadow");
  });

  it("the same person named twice in one title (Hakan Fidan ... Hakan Fidan'ın) is one term", () => {
    const t = extractFactCheckTerms(
      "Bakan Hakan Fidan ve Hakan Fidan'ın Almanca konuştuğu video",
    );
    const r = scoreCluster(t, doc("c", "Hakan Fidan Almanca"));
    expect(r.matched).toEqual(["hakan", "fidan", "alman"]);
    // The person (once) + "alman"; before the fix the two overlapping spans
    // counted twice and the pair published.
    expect(r.distinctTerms).toBe(2);
    expect(r.decision).toBe("shadow");
  });

  it("a span counts only if it claims a matched stem no earlier span claimed", () => {
    const t = {
      stems: ["alpha", "beta", "gamma", "delta"],
      entityStems: ["alpha"],
      nameSpans: [
        ["alpha", "beta"],
        ["beta", "gamma"],
        ["delta", "epsil"],
      ],
      ftsWords: [],
    };
    // beta, gamma and delta match. Span 1 claims beta; span 2 claims gamma (new);
    // span 3 claims delta (new). Three distinct terms.
    const r = scoreCluster(t, doc("c", "beta gamma delta"));
    expect(r.matched).toEqual(["beta", "gamma", "delta"]);
    expect(r.distinctTerms).toBe(3);
    // Without "gamma" span 2 only repeats beta and adds nothing.
    const r2 = scoreCluster(t, doc("c", "beta delta"));
    expect(r2.matched).toEqual(["beta", "delta"]);
    expect(r2.distinctTerms).toBe(2);
  });
});

/**
 * The 11 auto-published keyword-v1 rows audited on 2026-11-05. Each ClusterDoc
 * is the real cluster headline (`title_tr_neutral`) plus the real member
 * titles, trimmed to the titles that carry the support for the stored
 * `matched_terms` (the full clusters have up to 23 members). Every fixture is
 * asserted to reproduce the stored `matched_terms` and `score` under the
 * current stemmer, so the replay below is a replay of the live rows.
 */
interface RealPair {
  id: string;
  factCheckTitle: string;
  headline: string;
  memberTitles: string[];
  storedMatched: string[];
  storedScore: number;
}

const WRONG_PUBLISHED_PAIRS: RealPair[] = [
  {
    id: "2df57b90",
    factCheckTitle: "Cemil Tugay’ın katıldığı temizlik çalışmalarını gösteren video güncel mi?",
    headline: "CHP'den Özel'e \"Cemil Tugay\" tepkisi",
    memberTitles: [
      "CHP Sözcüsü Müslim Sarı: Özgür Özel'e ilk defa katılıyorum; Partisini satıp gidenler haindir",
      "CHP Sözcüsü Sarı, Kılıçdaroğlu'nun Özel'e tavsiyesini açıkladı: \"Cemil Tugay'ı bir daha aday göstermeyiniz\"",
      "CHP Sözcüsü Müslim Sarı'dan Özgür Özel açıklaması: \"İlk defa katılıyorum, partisini satan haindir\"",
      "CHP'li Sarı: Cemil Tugay'ı aday gösterenler İzmir halkından özür dileyecek",
    ],
    storedMatched: ["cemil", "tugay", "katil", "goste"],
    storedScore: 0.625,
  },
  {
    id: "cc57f5f6",
    factCheckTitle: "Hakan Fidan'ın Almanca konuştuğu video gerçek mi?",
    headline: "Dışişleri Bakanı Hakan Fidan konuşuyor",
    memberTitles: [],
    storedMatched: ["hakan", "fidan", "konus"],
    storedScore: 0.667,
  },
  {
    id: "26e48fc5",
    factCheckTitle: "Hakan Fidan'ın Almanca konuştuğu video gerçek mi?",
    headline: "Bakü’de Herzog protestosu: Türkiye dahil çok sayıda ülke salonu terk etti",
    memberTitles: [
      "Dışişleri Bakanı Hakan Fidan İsrail Cumhurbaşkanı Herzog'un konuşması başlarken salonu terk etti",
      "Hakan Fidan, Bakü'de: İsrail Cumhurbaşkanı konuşurken salonu terk etti",
    ],
    storedMatched: ["hakan", "fidan", "konus"],
    storedScore: 0.667,
  },
  {
    id: "9a0d12b4",
    factCheckTitle: "Hakan Fidan'ın Almanca konuştuğu video gerçek mi?",
    headline: "Bakan Fidan: Bağımsız ve egemen bir Filistin Devleti kurulmalı",
    memberTitles: [
      "Bakü’de İsrail protestosu: Hakan Fidan, konuşma sırasında salonu terk etti!",
      "Dışişleri Bakanı Hakan Fidan Bakü'deki CICA Zirvesi'nde konuştu: Bağımsız Filistin Devleti kurulmalı",
    ],
    storedMatched: ["hakan", "fidan", "konus"],
    storedScore: 0.667,
  },
];

const RIGHT_PUBLISHED_PAIRS: RealPair[] = [
  {
    id: "7b68e915",
    factCheckTitle: "Bir Okul Saldırısı Başlamadan Önlenebilir mi?",
    headline: "TBMM Okul Saldırılarının Nedenlerini Araştırma Komisyonu Manisa'da çalışmalarına başladı",
    memberTitles: [],
    storedMatched: ["okul", "saldi", "basla"],
    storedScore: 0.75,
  },
  {
    id: "1b427672",
    factCheckTitle: "Video Rusya’nın Ukrayna’ya Yaptığı Saldırıyı mı Gösteriyor?",
    headline: "Rusya Ukrayna Bilim Akademisi'ni vurdu: 3'ü çocuk 19 kişi yaralandı",
    memberTitles: [
      "Ukrayna: Kiev'deki Ukrayna Bilimler Akademisi'ne düzenlenen saldırıda 1 kişi öldü, 4 kişi yaralandı",
      "Kiev'deki Bilimler Akademisi'ne saldırı: 1 ölü, 4 yaralı",
    ],
    storedMatched: ["rusya", "ukray", "saldi"],
    storedScore: 0.6,
  },
  {
    id: "34787e03",
    factCheckTitle: "Video Fransa’daki Öğrenci Eylemlerini mi Gösteriyor?",
    headline: "Fransa'da Eğitim Bakanı ile görüşen öğrenciler, eylemlerini sürdürecek",
    memberTitles: [],
    storedMatched: ["frans", "ogren", "eylem"],
    storedScore: 0.75,
  },
  {
    id: "2eec34a0",
    factCheckTitle: "NASA astronotu Deniz Burnham’ın Türkçe konuştuğu video gerçek",
    headline: "NASA'nın Adanalı astronotu Deniz Burnham'dan hemşehrilerine mesaj var: Uzaydan el sallayacağım",
    memberTitles: [],
    storedMatched: ["nasa", "astro", "deniz", "burnh"],
    storedScore: 0.7,
  },
  {
    id: "0fdb8c08",
    factCheckTitle: "Video Panama’da Gerçekleşen 7.7 Büyüklüğündeki Depremi mi Gösteriyor?",
    headline: "Panama'da depremin ardından \"Ulusal Acil Durum\" ilan edildi",
    memberTitles: [
      "Panama'da 7.7 büyüklüğünde deprem! \"Ulusal Acil Durum\" ilan edildi",
      "Panama'da 7,7 büyüklüğünde deprem: Ulusal acil durum ilan edildi",
    ],
    storedMatched: ["panam", "buyuk", "depre"],
    storedScore: 0.6,
  },
  {
    id: "b789fa23",
    factCheckTitle: "Video Panama’da Gerçekleşen 7.7 Büyüklüğündeki Depremi mi Gösteriyor?",
    headline: "Panama'da 7.6 büyüklüğünde deprem. Çok sayıda ülke için tsunami uyarısı",
    memberTitles: [],
    storedMatched: ["panam", "buyuk", "depre"],
    storedScore: 0.6,
  },
  {
    id: "d2b6332c",
    factCheckTitle: "Doğu Akdeniz'de Deniz Sınırları Neden Tartışmalı?",
    headline: "AB'den Türkiye-Libya Anlaşmasına Tepki: Kılıçdaroğlu'ndan Brüksel'e Sert Yanıt",
    memberTitles: [
      "Kılıçdaroğlu'ndan AB'ye 'Libya mutabakatı' tepkisi: ‘Doğu Akdeniz milli bir meseledir’",
      "Dışişleri Bakanı Hakan Fidan: 'Doğu Akdeniz'e gelecek olan istikrar fevkalade önemli'",
      "Bakan Fidan: LibyaTürkiye deniz yetki alanları mutabakatı meşru bir anlaşmadır",
      "Libya'nın attığı tarih adım! Bakan Fidan: Tartışmaya gerek yok son derece meşru bir anlaşma",
      "Mısır’dan Türkiye-Libya deniz yetki muhtırasının onaylanmasına ilişkin açıklama: 'Reddediyoruz'",
      "Dışişleri Bakanı Fidan’dan AB’ye Libya mesajı: Meşru bir anlaşmadır, tartışmaya gerek yok",
    ],
    storedMatched: ["dogu", "akden", "deniz", "tarti"],
    storedScore: 0.778,
  },
];

describe("replay of the audited published rows (keyword-v2)", () => {
  it.each(WRONG_PUBLISHED_PAIRS)(
    "wrong pair $id reproduces its stored terms but is no longer publishable",
    (pair) => {
      const t = extractFactCheckTerms(pair.factCheckTitle);
      const r = scoreCluster(t, doc(pair.id, pair.headline, pair.memberTitles));
      expect(r.matched).toEqual(pair.storedMatched);
      expect(r.score).toBe(pair.storedScore);
      // Before the fix this pair cleared 3 matched terms, an entity and 0.6.
      expect(r.matched.length).toBeGreaterThanOrEqual(MIN_MATCHED_TERMS);
      expect(r.entityMatched).toBeGreaterThanOrEqual(1);
      expect(r.score).toBeGreaterThanOrEqual(PUBLISH_MIN_SCORE);
      // The person's name is one distinct term; the claim verbs add none.
      expect(r.distinctTerms).toBe(1);
      expect(r.distinctTerms).toBeLessThanOrEqual(r.matched.length);
      expect(r.decision).toBe("shadow");
    },
  );

  it.each(RIGHT_PUBLISHED_PAIRS)(
    "on-topic pair $id reproduces its stored terms and stays publishable",
    (pair) => {
      const t = extractFactCheckTerms(pair.factCheckTitle);
      const r = scoreCluster(t, doc(pair.id, pair.headline, pair.memberTitles));
      expect(r.matched).toEqual(pair.storedMatched);
      expect(r.score).toBe(pair.storedScore);
      expect(r.distinctTerms).toBeGreaterThanOrEqual(MIN_MATCHED_TERMS);
      expect(r.distinctTerms).toBeLessThanOrEqual(r.matched.length);
      expect(r.decision).toBe("publish");
    },
  );

  it("rankMatches keeps the wrong Fidan clusters as shadow rows, not publish", () => {
    const t = extractFactCheckTerms(FIDAN_TITLE);
    const docs = WRONG_PUBLISHED_PAIRS.filter((p) => p.factCheckTitle === FIDAN_TITLE).map(
      (p) => doc(p.id, p.headline, p.memberTitles),
    );
    expect(docs).toHaveLength(3);
    const ranked = rankMatches(t, docs);
    expect(ranked).toHaveLength(3);
    expect(ranked.every((r) => r.decision === "shadow")).toBe(true);
  });
});

/**
 * Two real fact-check/cluster pairs that candidate retrieval never scored (h87-factchecks-1, read 2026-11-09).
 * The cron kept the 25 LARGEST clusters matching the title's OR query, and a small same-event cluster
 * (4 and 3 articles) ranked far below that line: the Peru piece's cluster was #139 of 315 by article count,
 * the Resmi Gazete piece's cluster was beyond 25 as well. Migration 181 now takes the 25 best by ts_rank_cd.
 * The matcher was never the problem: both pairs score publish here, with the real headlines and member
 * titles of the stored clusters (506da2d9 and 903f9541), which is what these two cases pin.
 */
interface MissedPair {
  id: string;
  factCheckTitle: string;
  headline: string;
  memberTitles: string[];
  score: number;
  matched: string[];
  distinctTerms: number;
}

const MISSED_BY_SIZE_ORDER_PAIRS: MissedPair[] = [
  {
    id: "506da2d9",
    // Teyit f8a58b4b, 2026-10-09: four shadow links, none to this cluster.
    factCheckTitle: "Peru'da Hitler Mussolini adlı bir aday belediye başkanı seçildi",
    headline: "Sol aday Hitler Mussolini Peru'da yerel seçimi kazandı",
    memberTitles: [
      "Belediye başkanlığı seçimini Hitler Mussolini Simeon Flores kazandı",
      "Sol aday Hitler Mussolini Peru'da yerel seçimi kazandı",
      "Peru’da Hitler Mussolini Simeon Flores, sosyal demokrat partiden belediye başkanı oldu",
      "Peru'da solcu Hitler Mussolini belediye başkanı seçildi",
    ],
    score: 0.8,
    matched: ["peru", "hitle", "musso", "aday", "beled", "baska"],
    distinctTerms: 5,
  },
  {
    id: "903f9541",
    // Teyit 28f0f694, 2026-10-14: four shadow links, none to this cluster.
    factCheckTitle: "Sosyal medyada yaşa takılanlar: Yaş kısıtlaması Resmi Gazete’de",
    headline: "Resmi Gazete'de yayımlandı: Sosyal medyada 15 yaş Şartı",
    memberTitles: [
      "Resmi Gazete'de yayımlandı: 15 yaşını doldurmamış kimseler sosyal medya hesabı açamayacak",
      "Resmi Gazete'de yayımlandı: Sosyal medyada 15 yaş Şartı",
      "Resmi Gazete'de yayımlandı: Sosyal medyaya 15 sınırı getirildi",
    ],
    score: 0.7,
    matched: ["medya", "yas", "resmi", "gazet"],
    distinctTerms: 3,
  },
];

describe("pairs the size-ordered candidate cut never scored (h87-factchecks-1)", () => {
  it.each(MISSED_BY_SIZE_ORDER_PAIRS)(
    "pair $id is an on-topic publish once it reaches the matcher: the matcher was never the problem",
    (pair) => {
      const t = extractFactCheckTerms(pair.factCheckTitle);
      const r = scoreCluster(t, doc(pair.id, pair.headline, pair.memberTitles));
      expect(r.decision).toBe("publish");
      expect(r.score).toBe(pair.score);
      expect(r.matched).toEqual(pair.matched);
      expect(r.distinctTerms).toBe(pair.distinctTerms);
      expect(r.distinctTerms).toBeGreaterThanOrEqual(MIN_MATCHED_TERMS);
      expect(r.score).toBeGreaterThanOrEqual(PUBLISH_MIN_SCORE);
    },
  );

  it("rankMatches puts each of them first and publishes it next to an unrelated same-word cluster", () => {
    for (const pair of MISSED_BY_SIZE_ORDER_PAIRS) {
      const t = extractFactCheckTerms(pair.factCheckTitle);
      const unrelated = doc("unrelated", "Belediye başkanı yeni bir aday gösterdi", []);
      const ranked = rankMatches(t, [unrelated, doc(pair.id, pair.headline, pair.memberTitles)]);
      expect(ranked[0]?.clusterId).toBe(pair.id);
      expect(ranked[0]?.decision).toBe("publish");
    }
  });

  it("the Peru fact-check's search query is the six-word OR query that matches 315 clusters", () => {
    // 315 clusters match this query inside the cron's window, so a limit of 25 has to be a relevance cut, not a size cut.
    const t = extractFactCheckTerms(MISSED_BY_SIZE_ORDER_PAIRS[0]!.factCheckTitle);
    expect(buildFtsQuery(t)).toBe("hitler or mussolini or peru or adlı or aday or belediye");
  });
});

/**
 * SEC-factcheck-autopublish-fp-1: the matcher's own 'publish' line (0.6 with 3 distinct terms) lets a pair
 * through that is NOT the same claim. Read 2026-11-09 from the stored rows: Teyit 29c5930e is about a clip said
 * to show a carrier strike, cluster 087390a8 is about satellite images of the damage to US bases. Same war, two
 * claims. Once migration 181 ranks candidates by relevance, such a cluster reaches the matcher, so the cron
 * (src/app/api/cron/fact-checks/route.ts) holds an RPC-sourced pair below RPC_PUBLISH_MIN_SCORE = 0.7 as a
 * shadow row. match.ts and PUBLISH_MIN_SCORE stay as they are; this pin documents why the route floor exists.
 */
describe("a 0.6 publish that is a different claim (SEC-factcheck-autopublish-fp-1)", () => {
  const IRAN_FACT_CHECK_TITLE =
    "Görüntülerin İran'ın ABD uçak gemisini vurduğunu anlatan belgeselden olduğu iddiası";
  const IRAN_HEADLINE =
    "Uydu görüntüleriyle incelendi: İran'ın vurduğu ABD üslerindeki hasar milyarlarca doları buldu";
  const IRAN_MEMBER_TITLES = [
    IRAN_HEADLINE,
    "İran'dan ABD'ye ağır darbe! Orta Doğu'daki milyarlarca dolarlık zarar ortaya çıktı",
  ];

  it("Iran/ABD pair 29c5930e -> 087390a8 scores 0.6 with 3 distinct terms and decision 'publish'", () => {
    const t = extractFactCheckTerms(IRAN_FACT_CHECK_TITLE);
    const r = scoreCluster(t, doc("087390a8", IRAN_HEADLINE, IRAN_MEMBER_TITLES));
    expect(r.score).toBe(0.6);
    expect(r.distinctTerms).toBe(3);
    expect(r.decision).toBe("publish");
    expect(r.matched).toEqual(["gorun", "iran", "abd", "vurdu"]);
  });

  it("rankMatches keeps it as the one 'publish' decision of its fact-check, which is what the route floor then holds", () => {
    const t = extractFactCheckTerms(IRAN_FACT_CHECK_TITLE);
    const ranked = rankMatches(t, [doc("087390a8", IRAN_HEADLINE, IRAN_MEMBER_TITLES)]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ clusterId: "087390a8", score: 0.6, decision: "publish" });
  });
});

// Sanity: shadow threshold below publish threshold, keeps a two-tier gate.
describe("thresholds", () => {
  it("SHADOW_MIN_SCORE is strictly below PUBLISH_MIN_SCORE", () => {
    expect(SHADOW_MIN_SCORE).toBeLessThan(PUBLISH_MIN_SCORE);
  });
});
