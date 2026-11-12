import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXTRACTIVE_MODEL_ID,
  cleanHeadline,
  incumbentIsMemberTitle,
  isAcceptableNeutral,
  loadedPenalty,
  pickNeutralTitle,
} from "./neutral-title";

// Replay of the headline cron's re-pick over production data. The fixture is
// 150 clusters (article_count >= 4, the most recently updated) captured on
// 2026-11-01: each has the title the cluster carried then (`stored`, a good
// extractive-v1 title in almost every case) and the titles of its members.
//
// Why it exists (hunt 16): #156 re-picked every non-current row and rewrote
// about 48% of them; the first conservative margin (0.05) still rewrote 38%
// because the spread of scores between two good member titles of one cluster
// is wider than 0.05. Unit tests on a handful of clusters cannot see that, so
// this pins the churn rate itself. Migration 141 offers the whole 14-day
// window once per extractive-model bump, so the rate here is the share of
// good titles readers lose on the next bump. If a scorer or margin change
// pushes it past the cap, the change is not conservative; do not raise the cap
// to make the test pass.

interface ReplayCluster {
  cid: string;
  stored: string;
  titles: string[];
}

const CLUSTERS: ReplayCluster[] = JSON.parse(
  readFileSync(resolve(__dirname, "../../../tests/fixtures/neutral-title-repick-replay.json"), "utf8"),
) as ReplayCluster[];

const byId = (cid: string): ReplayCluster => {
  const c = CLUSTERS.find((x) => x.cid === cid);
  if (!c) throw new Error(`fixture cluster ${cid} missing`);
  return c;
};

const repick = (c: ReplayCluster): string | null =>
  pickNeutralTitle(
    c.titles.map((title) => ({ title })),
    { incumbent: c.stored },
  );

describe("re-pick replay over 150 production clusters", () => {
  it("the fixture is intact (150 clusters, 4+ member titles each, a stored title each)", () => {
    expect(CLUSTERS).toHaveLength(150);
    for (const c of CLUSTERS) {
      expect(c.titles.length, c.cid).toBeGreaterThanOrEqual(4);
      expect(c.stored.trim().length, c.cid).toBeGreaterThan(0);
    }
  });

  it("changes under 15% of the stored titles (the 0.05 margin changed 38%, #156 48%)", () => {
    const changed = CLUSTERS.filter((c) => {
      const next = repick(c);
      return next !== null && next !== c.stored;
    });
    // 16/150 = 0.107 since hunt 42 (CORPUS_CHANGED_BY_H42: three stored titles no member carries and one the
    // no-margin rules replace); 12/150 = 0.08 before. The bar in the title is 15%.
    expect(changed.length / CLUSTERS.length).toBeLessThan(0.15);
  });

  it("never returns null for these clusters (a stored title is always kept or replaced)", () => {
    for (const c of CLUSTERS) expect(repick(c), c.cid).not.toBeNull();
  });

  it("is idempotent: re-picking with the pick as incumbent returns it", () => {
    for (const c of CLUSTERS) {
      const picked = repick(c);
      expect(pickNeutralTitle(c.titles.map((title) => ({ title })), { incumbent: picked }), c.cid).toBe(picked);
    }
  });

  it("never picks a fragment (under 30 characters) for a cluster of 4+ members", () => {
    for (const c of CLUSTERS) {
      const picked = repick(c);
      expect(picked!.length, `${c.cid}: ${picked}`).toBeGreaterThanOrEqual(30);
    }
  });

  it("keeps the full-length titles #156 and the 0.05 margin used to rewrite", () => {
    // Gaps 0.079 (73 chars), 0.060 (102 chars), 0.057 (70 chars): outscored, but
    // not clearly. 55a8c57c used to become a different meeting ('Alman
    // mevkidaşı'), 070cbfc0 'Üç bakanlıkta yeni genel müdürlükler kuruldu'.
    for (const cid of ["55a8c57c", "070cbfc0", "97575687"]) {
      const c = byId(cid);
      expect(c.stored.length, cid).toBeGreaterThanOrEqual(45);
      expect(repick(c), cid).toBe(c.stored);
    }
  });

  it("replaces a stored title that fails the gate (generic placeholder, surviving lead-in)", () => {
    const generic = byId("2c15fdcf");
    expect(generic.stored).toBe("Kısa haberler");
    expect(repick(generic)).not.toBe(generic.stored);

    const leadIn = byId("c26c8c14");
    expect(leadIn.stored).toMatch(/^SON DAKİKA/);
    expect(repick(leadIn)).not.toMatch(/^SON DAKİKA/);
  });

  it("replaces a short stored title that a longer member title clearly beats", () => {
    // 'Boğaz trafiği askıya alındı' (27 chars) -> the Istanbul Strait title.
    const short = byId("1e96c356");
    expect(short.stored.length).toBeLessThan(45);
    expect(repick(short)).toBe("İstanbul Boğazı'nda gemi trafiği askıya alındı");
  });

  it("holds a full-length title to a wider margin than a short one at the same score gap", () => {
    // Both are outscored by about 0.10. The 34-character title is replaced
    // (REPICK_MARGIN 0.05), the 94-character one stays (REPICK_MARGIN_FULL_LENGTH 0.20).
    const short = byId("9088bea9");
    const full = byId("b2a03549");
    expect(short.stored.length).toBeLessThan(45);
    expect(full.stored.length).toBeGreaterThanOrEqual(45);
    expect(repick(short)).not.toBe(short.stored);
    expect(repick(full)).toBe(full.stored);
  });

  it("replaces a full-length title that is beaten by a wide margin (gaps 0.455 and 0.317)", () => {
    for (const cid of ["7148f645", "8262e836"]) {
      const c = byId(cid);
      expect(c.stored.length, cid).toBeGreaterThanOrEqual(45);
      expect(repick(c), cid).not.toBe(c.stored);
    }
  });
});

// Hunt 22 (h22-editorial-3, 2026-11-02): two clusters the extractive-v3 picker
// titled with a verdict word and with a mid-title ticker. Their member titles are
// the stored ones (read-only SELECT, newest first). They live here and not in the
// fixture above because that file's count of 150 is pinned.
const HUNT22: ReplayCluster[] = [
  {
    cid: "310aedf3",
    stored: "Emir Sarıgül itiraf etti: Babam, Özgür Özel'e 350 bin dolar verdi",
    titles: [
      "Emir Sarıgül savcılığa konuştu! İfadesinde Özgür Özel de var",
      "Emir Sarıgül'den babası ve Özgür Özel hakkında \"350 bin dolar\" iddiası: Aracına koydu",
      "Emir Sarıgül'ün ifadesi CNN Türk'te: \"Babam, Özgür Özel'e 350 bin dolar rüşvet verdi\"",
      "Emir Sarıgül'den babası Mustafa Sarıgül ve Özgür Özel hakkında çok çarpıcı itiraf",
      "Son dakika... Emir Sarıgül'ün ek ifadesi ortaya çıktı! 'Babam Özgür Özel'e rüşvet verdi'",
      "Emir Sarıgül itiraf etti: Babam, Özgür Özel'e 350 bin dolar verdi",
      "Emir Sarıgül'ün ek ifadesi gündeme oturdu: ‘Babam, Özgür Özel’e 350 bin dolar verdi’",
      "Mustafa Sarıgül'ün oğlu Emir Sarıgül: 'Babam Özgür Özel'e 350 bin dolar verdi'",
      "Emir Sarıgül’ün ifadesi ortaya çıktı! 350 bin dolarlık itiraf: Babam Özel’in arabasına bıraktı",
    ],
  },
  {
    cid: "80bfb011",
    stored: "Altın Fiyatlarında Son Dakika. 1 Yılın Dibini Gördü, Yeniden Yükselişe Geçti",
    titles: [
      "2 Kasım altın ne kadar oldu, daha düşecek mi? SON DAKİKA! Altın fiyatları yükseldi mi, düştü mü? Güncel altın fiyatları!",
      "Altın yeni haftaya yükselişle başladı: Gözler kritik verilerde",
      "Altın Fiyatlarında Son Dakika! 1 Yılın Dibini Gördü, Yeniden Yükselişe Geçti",
    ],
  },
];

describe("re-pick replay: the hunt-22 clusters", () => {
  const byHunt22 = (cid: string): ReplayCluster => {
    const c = HUNT22.find((x) => x.cid === cid);
    if (!c) throw new Error(`hunt-22 cluster ${cid} missing`);
    return c;
  };

  it("310aedf3: the stored verdict title is replaced by a title that neither says 'itiraf' nor drops the hedge", () => {
    const c = byHunt22("310aedf3");
    const picked = repick(c);
    expect(picked).not.toBeNull();
    expect(picked).not.toBe(c.stored);
    expect(picked).not.toMatch(/itiraf/i);
    expect(picked).toMatch(/iddia|ifade|öne sürd/i);
    expect(isAcceptableNeutral(picked!, c.titles)).toBe(true);
  });

  it("80bfb011: the stored title with a mid-title 'Son Dakika.' is replaced by one without a ticker", () => {
    const c = byHunt22("80bfb011");
    const picked = repick(c);
    expect(picked).not.toBeNull();
    expect(picked).not.toBe(c.stored);
    expect(picked!.toLocaleLowerCase("tr")).not.toContain("son dakika");
    expect(isAcceptableNeutral(picked!, c.titles)).toBe(true);
  });

  it("is idempotent: re-picking with the pick as incumbent returns it", () => {
    for (const c of HUNT22) {
      const picked = repick(c);
      expect(pickNeutralTitle(c.titles.map((title) => ({ title })), { incumbent: picked }), c.cid).toBe(picked);
    }
  });

  it("the fresh pick (no incumbent) is the same title", () => {
    for (const c of HUNT22) {
      expect(pickNeutralTitle(c.titles.map((title) => ({ title }))), c.cid).toBe(repick(c));
    }
  });

  it("the fixture's count stays pinned: these clusters are not in it", () => {
    for (const c of HUNT22) expect(CLUSTERS.some((x) => x.cid === c.cid)).toBe(false);
    expect(CLUSTERS).toHaveLength(150);
  });
});

// Hunt 26 (h26-editorial-1, 2026-11-02): eight clusters the extractive-v4 picker
// titled with hype ('görkemli', 'önemli mesajlar'), a verdict ('vurgun'), a full
// appointment where the members wrote 'vekaleten', or a teaser '...' (member
// titles read-only from cluster_articles x articles). They live in their own
// fixture because the count of the 150-cluster file above is pinned.
const H26: ReplayCluster[] = JSON.parse(
  readFileSync(resolve(__dirname, "../../../tests/fixtures/neutral-title-h26-flips.json"), "utf8"),
) as ReplayCluster[];

// Hunt 31 (h31-reader-2, 2026-11-04): the two top stories the extractive-v4 picker
// kept on a simile ('tehdit gibi') and on a sequel teaser ('cerrah da'). Live member
// titles, read-only (see neutral-title.test.ts); a separate fixture because the count
// of the 150-cluster file is pinned.
const H31: ReplayCluster[] = JSON.parse(
  readFileSync(resolve(__dirname, "../../../tests/fixtures/neutral-title-h31-loaded.json"), "utf8"),
) as ReplayCluster[];

// The twelve clusters the 150-cluster corpus changed BEFORE the h26 rules
// (measured on HEAD 5bbc2c3: 12/150 = 0.08). The h26 word list, the qualifier
// penalty and the teaser-pause rule change none of the 150 picks, so this set
// is the same after them: a rule that moves it is not as conservative as h26
// claims.
const CORPUS_CHANGED_BEFORE_H26 = [
  "144cfc04",
  "ce49387a",
  "2c15fdcf",
  "f0afcdef",
  "9088bea9",
  "b04edded",
  "e81b94fd",
  "1e96c356",
  "7148f645",
  "8262e836",
  "c26c8c14",
  "2cc0838e",
];

// hunt 42 (2026-11-05). Two sets of changes beyond the twelve above, hand-reviewed (old -> new).
//
// h42-titles-1: a stored title that no current member carries (the outlet edited it away, or the member
// that carried it left) is no longer protected as an incumbent. Three of the 150 corpus clusters hold such
// a title (a fourth, c26c8c14, is in the list above already: its stored "SON DAKİKA..." title fails the gate):
//   112a68bd  "Zelenski İstanbul’a geldi: Erdoğan ile görüşecek"
//             -> "İstanbul’a gelen Zelenski Cumhurbaşkanı Erdoğan ile görüştü"   better: the members report
//                the meeting as held, the stored future tense is superseded
//   d6675bd8  "Bakırköy Belediyesi soruşturması: 39 tutuklama"
//             -> "Bakırköy Belediyesine yönelik soruşturmada 39 tutuklama"        lateral: same facts, a
//                member's own wording instead of a fragment no member says
//   e3262ca6  "Dışişleri Bakanı Fidan: Rusya ve Ukrayna, büyük bir fedakarlıkta bulunarak bir anlaşmaya
//              varmak zorundalar" -> "Bakan Fidan: Rusya ve Ukrayna anlaşmaya varmak zorunda"
//             lateral: the same statement without the 108-character paraphrase no member carries
// h42-titles-2: the stored title gives way with no margin (loaded wording, a dropped hedge, a cut number,
// Title Case). One of the 150 corpus clusters (the first version changed three; the review fixes took two
// back, below):
//   66173a8a  "ABD, Ukrayna'ya 2,1 milyar dolarlık 500 adet PAC-3 füzesi satışına onay verdi"  (hedge)
//             -> "ABD, Ukrayna'ya savunma alanında 2,1 milyar dolarlık olası satışı onayladı"   better: an
//                approval of a possible sale, not a sale made
// Left out after the h42 review (these two used to be in the list, so the count is 16/150 = 10.7%, not 18/150):
//   9e5b27cb  "Cenazeye giden aile ölümden döndü: Bolu Dağı Tüneli'nde korkunç kaza"  (loaded, editorial-6)
//             stays: the stored title is central (mean member overlap 0.505) and the event title it was
//             swapped for is not (0.321); the loaded rule needs a target at least as central. The first
//             version judged that swap better, so this is a better change given up for the guard that stops
//             ad76f79a's central 'perde arkası' title losing to a 1-of-6 angle.
//   e67ede66  "Bakırköy Belediyesi soruşturmasında 40 kişi tutuklandı"                (number, editorial-2)
//             stays: the stored 40 is one outlet's figure, but the best title (39) does not restate it, so the
//             number rule (which repairs only a figure cut short and restated in full) no longer fires.
const CORPUS_CHANGED_BY_H42 = ["112a68bd", "d6675bd8", "e3262ca6", "66173a8a"];

describe("re-pick replay: the hunt-26 rules", () => {
  it("change none of the 150 corpus picks beyond the twelve that changed before and the four of hunt 42 (churn 16/150)", () => {
    const changed = CLUSTERS.filter((c) => {
      const next = repick(c);
      return next !== null && next !== c.stored;
    }).map((c) => c.cid);
    expect(changed.sort()).toEqual([...CORPUS_CHANGED_BEFORE_H26, ...CORPUS_CHANGED_BY_H42].sort());
    expect(changed.length / CLUSTERS.length).toBeLessThan(0.15);
    // The h26 rules themselves move none of the picks: the twelve are the ones before them.
    expect(changed.filter((cid) => !CORPUS_CHANGED_BY_H42.includes(cid)).sort()).toEqual(
      [...CORPUS_CHANGED_BEFORE_H26].sort(),
    );
  });

  it("the h26 fixture is intact (8 clusters, none of them in the 150 corpus)", () => {
    expect(H26).toHaveLength(8);
    for (const c of H26) {
      expect(CLUSTERS.some((x) => x.cid === c.cid), c.cid).toBe(false);
      expect(c.titles.length, c.cid).toBeGreaterThanOrEqual(2);
    }
    expect(CLUSTERS).toHaveLength(150);
  });

  it("re-picks replace the stored hype, content-free and full-appointment titles", () => {
    for (const cid of ["0b5eee69", "388a7dac", "806ae4e8", "7fa63071", "4433b6f7"]) {
      const c = H26.find((x) => x.cid === cid)!;
      const picked = repick(c);
      expect(picked, cid).not.toBeNull();
      expect(picked, cid).not.toBe(c.stored);
    }
  });

  it("re-picks keep the stored titles no member beats (957cdb46: every member says 'vurgun')", () => {
    const c = H26.find((x) => x.cid === "957cdb46")!;
    expect(repick(c)).toBe(c.stored);
  });

  it("is idempotent: re-picking with the pick as incumbent returns it", () => {
    for (const c of H26) {
      const picked = repick(c);
      expect(pickNeutralTitle(c.titles.map((title) => ({ title })), { incumbent: picked }), c.cid).toBe(picked);
    }
  });
});

// Hunt 31 (h31-reader-2, 2026-11-04, extractive-v5): 'tehdit gibi', 'yıktı',
// 'hezimet...' and 'tarihe geçen' join the loaded words and a sequel teaser
// ("Gazze'nin tanığı cerrah da ...") pays one loaded unit. Measured with the
// neutral-title.ts of ed2fc79 (HEAD of the branch) and the new one side by side: the
// 150-corpus picks are identical, so the list is empty. The rules do reach 2 member
// titles of the corpus ("Mehmet Pehlivan'ın ağabeyi de tutuklandı", "Bedelli
// askerliğe de hak tanındı"), neither of which is the pick or beats the stored
// title by the 0.20 margin. A rule that adds a cid here has to be hand-reviewed
// (old -> new, better / lateral / worse) before it is listed.
const CORPUS_CHANGED_BY_H31: string[] = [];

describe("re-pick replay: the hunt-31 rules", () => {
  const corpusChanged = (): string[] =>
    CLUSTERS.filter((c) => {
      const next = repick(c);
      return next !== null && next !== c.stored;
    }).map((c) => c.cid);

  it("change the 150 corpus picks only by CORPUS_CHANGED_BY_H31 (the twelve before h26 plus none) and CORPUS_CHANGED_BY_H42", () => {
    const changed = corpusChanged();
    expect(changed.sort()).toEqual(
      [...CORPUS_CHANGED_BEFORE_H26, ...CORPUS_CHANGED_BY_H31, ...CORPUS_CHANGED_BY_H42].sort(),
    );
  });

  it("churn stays under 15% (prior bar 12.7% at the v3 re-pick; the gate for this wave was 15%)", () => {
    // 12 / 150 = 0.08: the h31 rules add nothing. Hunt 42 pushed it to 16 / 150 = 0.107 (hand-reviewed at
    // CORPUS_CHANGED_BY_H42), so the bar is the 15% gate.
    expect(corpusChanged().length / CLUSTERS.length).toBeLessThan(0.15);
    expect(corpusChanged().filter((cid) => !CORPUS_CHANGED_BY_H42.includes(cid)).length / CLUSTERS.length).toBeLessThan(0.1);
  });

  it("keeps the corpus titles that carry an additive 'de' / 'da' within the first words", () => {
    // 4248e457 ('... ağabeyi de tutuklandı') and 97575687 ('Bedelli askerliğe de
    // hak tanındı') trip the sequel-teaser rule as member titles; no pick moves.
    for (const cid of ["4248e457", "97575687"]) {
      const c = byId(cid);
      expect(repick(c), cid).toBe(c.stored);
    }
  });

  it("the h31 fixture is intact (2 clusters, none in the 150 corpus, CLUSTERS stays 150)", () => {
    expect(H31.map((c) => c.cid)).toEqual(["2ee853c9", "d89374ba"]);
    for (const c of H31) expect(CLUSTERS.some((x) => x.cid === c.cid), c.cid).toBe(false);
    expect(CLUSTERS).toHaveLength(150);
  });

  it("re-picks replace the stored simile and sequel titles with a factual member title", () => {
    expect(repick(H31[0]!)).toBe("İran'dan Trump'a seçim mesajı: ABD halkı 'savaşa hayır' dedi");
    expect(repick(H31[1]!)).toBe(
      "Gazze'de gönüllü doktorluk yapan Adam Hamawy, ABD Kongresi'ne seçildi: New Jersey'de bir ilk",
    );
  });

  it("is idempotent: re-picking with the pick as incumbent returns it", () => {
    for (const c of H31) {
      const picked = repick(c);
      expect(pickNeutralTitle(c.titles.map((title) => ({ title })), { incumbent: picked }), c.cid).toBe(picked);
    }
  });
});

// Hunt 27 (h27-copy-2, 2026-11-02): recasing a lower-case-sourced candidate from
// its siblings. The first version of the rule applied the sibling forms to every
// candidate and changed three fresh picks of the 150-cluster corpus, two of them
// for the worse ('olağan Kurultayı', 'Mekke Savunma ittifakına': a sibling
// capitalises part of an event name and the sentence-case candidate got half of it).
// The rule now applies only to the odd one out on capitalisation (a title the
// outlet wrote in lower case, or one that disagrees on more names than it
// agrees on), and over the corpus and the h26 clusters it changes no pick, with
// or without an incumbent and with or without { floor: true }.
describe("re-pick replay: the hunt-27 lower-case-sourced rule", () => {
  const fresh = (c: ReplayCluster, floor = false): string | null =>
    pickNeutralTitle(c.titles.map((title) => ({ title })), floor ? { floor: true } : {});

  it("every fresh pick of the 150 corpus clusters is some member's cleaned title (nothing was recased)", () => {
    for (const c of CLUSTERS) {
      const picked = fresh(c);
      expect(picked, c.cid).not.toBeNull();
      expect(
        c.titles.some((t) => cleanHeadline(t) === picked),
        `${c.cid}: ${picked}`,
      ).toBe(true);
    }
  });

  it("the three clusters the first version recased keep their sentence-case wording", () => {
    expect(fresh(byId("d3af1551"))).toBe("Yeni Parti’nin ilk olağan kurultayı 14-15 Kasım’da yapılacak");
    expect(fresh(byId("73d2638e"))).toBe("Suriye, Mekke savunma ittifakına katılımı değerlendiriyor");
    expect(fresh(byId("9e5b27cb"))).toBe(
      "Cenazeye giderken Bolu Dağı tüneli'nde takla attılar, kaçan tır aranıyor",
    );
  });

  it("a first pick (floor) over the corpus is the same title whenever a normal pick exists", () => {
    for (const c of CLUSTERS) {
      const picked = fresh(c);
      if (picked !== null) expect(fresh(c, true), c.cid).toBe(picked);
    }
  });

  it("the h26 clusters are unaffected: the fresh pick is a member's cleaned title", () => {
    for (const c of H26) {
      const picked = fresh(c);
      if (picked === null) continue;
      expect(
        c.titles.some((t) => cleanHeadline(t) === picked),
        `${c.cid}: ${picked}`,
      ).toBe(true);
    }
  });

  // The two live clusters, member titles as stored (Haberport writes U+2019,
  // Haberler.com a straight apostrophe). The stored neutral titles are the
  // lower-case ones the picker shipped.
  const LIVE: ReplayCluster[] = [
    {
      cid: "7a9ac17b",
      stored: "Avrupa, türkiye’yi stratejik ortak olarak görmeli çağrısı berlinden yükseldi",
      titles: [
        "avrupa, türkiye’yi stratejik ortak olarak görmeli çağrısı berlinden yükseldi",
        "Fuat Oktay Berlin'de Avrupa'dan Türkiye'yi stratejik ortak görmesini istedi",
      ],
    },
    {
      cid: "65cb64f9",
      stored: "Bilal Erdoğan: türkiye ile japonya ilişkileri stratejik ortaklığa doğru ilerliyor",
      titles: [
        "Bilal Erdoğan: türkiye ile japonya ilişkileri stratejik ortaklığa doğru ilerliyor",
        "Bilal Erdoğan Tokyo'da Türkiye-Japonya ilişkilerine stratejik ortaklık dedi",
      ],
    },
  ];

  it("a fresh pick of the live clusters ships properly cased names", () => {
    expect(fresh(LIVE[0]!)).toBe("Fuat Oktay Berlin'de Avrupa'dan Türkiye'yi stratejik ortak görmesini istedi");
    expect(fresh(LIVE[1]!)).toBe(
      "Bilal Erdoğan: Türkiye ile Japonya ilişkileri stratejik ortaklığa doğru ilerliyor",
    );
    expect(fresh(LIVE[0]!, true)).toBe(fresh(LIVE[0]!));
    expect(fresh(LIVE[1]!, true)).toBe(fresh(LIVE[1]!));
  });

  it("a re-pick leaves the stored rows alone (no backfill: the incumbent path is untouched)", () => {
    for (const c of LIVE) expect(repick(c), c.cid).toBe(c.stored);
  });
});

// Hunt 28 (h28-live-2, 2026-11-02): #176 recased common nouns on first picks.
// Six clusters whose candidate opens with a capital (never lower-case-sourced)
// shipped 'Net Mesaj', 'Kadın ... Aile', 'Soyut Resim', 'Acil Sağlık', and for
// 85deda69 the recasing made the candidate odd, so the leak guard swapped in
// 'İddia: Vali yardımcısının intihar sebebi yasak aşk'. Member titles are read
// from cluster_articles x articles in the cron's order (newest first, ties on
// the title). `expected` is what the pre-#176 picker returned, `bad` what #176
// returned. They live in their own fixture because the 150-cluster file is pinned.
interface H28Cluster extends ReplayCluster {
  expected: string;
  bad: string;
}

const H28: H28Cluster[] = JSON.parse(
  readFileSync(resolve(__dirname, "../../../tests/fixtures/neutral-title-h28-recase.json"), "utf8"),
) as H28Cluster[];

describe("hunt-28: a title that opens with a capital is never recased", () => {
  const members = (c: ReplayCluster) => c.titles.map((title) => ({ title }));

  it("the fixture is intact (6 clusters, none in the 150 corpus, CLUSTERS stays 150)", () => {
    expect(H28.map((c) => c.cid)).toEqual(["f972e6c1", "ee5b26b1", "0cd5d8fd", "44411a81", "a84aecfc", "85deda69"]);
    expect(H28).toHaveLength(6);
    for (const c of H28) {
      expect(CLUSTERS.some((x) => x.cid === c.cid), c.cid).toBe(false);
      expect(c.titles.length, c.cid).toBeGreaterThanOrEqual(2);
      expect(c.cid, c.cid).toHaveLength(8);
      expect(c.bad, c.cid).not.toBe(c.expected);
      // The expected pick is a member's cleaned title, as written.
      expect(
        c.titles.some((t) => cleanHeadline(t) === c.expected),
        `${c.cid}: ${c.expected}`,
      ).toBe(true);
    }
    expect(CLUSTERS).toHaveLength(150);
  });

  it.each(H28.map((c) => [c.cid, c] as const))("%s: a first pick (floor) is the pre-#176 title", (_cid, c) => {
    expect(pickNeutralTitle(members(c), { floor: true })).toBe(c.expected);
  });

  it.each(H28.map((c) => [c.cid, c] as const))("%s: a normal pick gives the same title", (_cid, c) => {
    expect(pickNeutralTitle(members(c), {})).toBe(c.expected);
  });

  it.each(H28.map((c) => [c.cid, c] as const))("%s: the #176 output is gone", (_cid, c) => {
    expect(pickNeutralTitle(members(c), { floor: true })).not.toBe(c.bad);
    expect(pickNeutralTitle(members(c), {})).not.toBe(c.bad);
  });

  it("85deda69 keeps the plain title instead of the more sensational member", () => {
    const c = H28.find((x) => x.cid === "85deda69")!;
    expect(pickNeutralTitle(members(c), { floor: true })).toBe(
      "Vali yardımcısının ölümünde yeni iddia: Başsavcı vekili açığa alındı",
    );
  });

  it("a re-pick leaves the stored rows alone (no backfill)", () => {
    for (const c of H28) expect(pickNeutralTitle(members(c), { incumbent: c.stored }), c.cid).toBe(c.stored);
  });
});

// Hunt 34 (h34-reader-1, 2026-11-05, extractive-v6): incumbentDefect lowers the re-pick
// margin to zero for a stored title that is itself the defect (a minority claim that omits
// what most members say, a Title Case run, a majority subject it lacks). It would be wrong
// to measure that on the 150-cluster corpus alone, so this replays two populations.
//
// 1. The 150-cluster corpus above: the v6 rules change exactly the twelve picks that changed
//    before h26, i.e. 12/150 = 0.08, under the 0.15 gate of this wave (the first version of the
//    rule, "its own words are rare and the best has a common word", changed 26 = 17.3% and
//    swapped Fidan's G20 attendance for his meeting with Rubio).
// 2. Every extractive-v5 cluster active in the last 7 days (2026-11-05, read-only SELECT of 1,891
//    clusters and their 9,090 member titles, stored title as incumbent): 15 changed, 2 of them
//    by the picker as it stood at HEAD (a80e9457 and 6ff2e710, whose full-length stored titles
//    lost by more than the 0.20 margin), 13 by the new rule. The 13 are in
//    __fixtures__/h34-incumbents.json with their hand verdict: 10 better, 3 lateral, 0 worse
//    (a lateral swap trades one acceptable title for another of the same value: a campaign
//    slogan quote for a neutral description, Title Case for a sentence-case line that loses a
//    place name, a minority quote for the line most members carry).
//    The fixture also holds 268d231b, the one live cluster of the finding no rule heals.
interface H34Replay {
  cid: string;
  stored: string;
  titles: string[];
  expected: string;
  verdict: "better" | "lateral" | "kept";
}

const H34_REPLAY: H34Replay[] = JSON.parse(
  readFileSync(resolve(__dirname, "__fixtures__/h34-incumbents.json"), "utf8"),
) as H34Replay[];

describe("re-pick replay: the hunt-34 rules", () => {
  const corpusChanged = (): string[] =>
    CLUSTERS.filter((c) => {
      const next = repick(c);
      return next !== null && next !== c.stored;
    }).map((c) => c.cid);

  it("change none of the 150 corpus picks beyond the twelve that changed before and the four of hunt 42 (churn 16/150 = 10.7%)", () => {
    const changed = corpusChanged();
    expect(changed.sort()).toEqual(
      [...CORPUS_CHANGED_BEFORE_H26, ...CORPUS_CHANGED_BY_H31, ...CORPUS_CHANGED_BY_H42].sort(),
    );
    expect(changed.length / CLUSTERS.length).toBeLessThan(0.15);
    // Without the four of hunt 42 it is still the 12/150 = 8% of before.
    expect(changed.filter((cid) => !CORPUS_CHANGED_BY_H42.includes(cid)).length / CLUSTERS.length).toBeLessThan(0.1);
  });

  it("the margin still keeps all 76 corpus titles whose fresh best pick differs from the stored one (79 before hunt 42)", () => {
    const keptByMargin = CLUSTERS.filter((c) => {
      const items = c.titles.map((title) => ({ title }));
      return pickNeutralTitle(items) !== c.stored && repick(c) === c.stored;
    });
    // 79 - 4 + 1: the four of CORPUS_CHANGED_BY_H42 no longer stay, and e3281cbd joins: its stored
    // "KOBİ'lere patent müjdesi: ..." was its own fresh pick, and now that 'müjdesi' is framing the
    // fresh pick is the Kacır title while the margin keeps the stored one. 9e5b27cb and e67ede66 (the
    // first version replaced them, see CORPUS_CHANGED_BY_H42) stay, which is the 2 more of the first count (74).
    expect(keptByMargin).toHaveLength(76);
    expect(keptByMargin.map((c) => c.cid)).toContain("e3281cbd");
    const nowReplaced = CLUSTERS.filter((c) => {
      const items = c.titles.map((title) => ({ title }));
      return pickNeutralTitle(items) !== c.stored && repick(c) !== c.stored && CORPUS_CHANGED_BY_H42.includes(c.cid);
    });
    expect(nowReplaced.map((c) => c.cid).sort()).toEqual([...CORPUS_CHANGED_BY_H42].sort());
  });

  it("the fixture holds 14 clusters (13 changed by the rule, 268d231b kept), none in the 150 corpus", () => {
    expect(H34_REPLAY).toHaveLength(14);
    expect(H34_REPLAY.filter((c) => c.verdict === "kept").map((c) => c.cid)).toEqual(["268d231b"]);
    for (const c of H34_REPLAY) expect(CLUSTERS.some((x) => x.cid === c.cid), c.cid).toBe(false);
    expect(CLUSTERS).toHaveLength(150);
  });

  it("the 7-day replay: 10 better, 3 lateral, 0 worse, every new title acceptable, unloaded and a fixed point", () => {
    const verdicts = H34_REPLAY.map((c) => c.verdict);
    expect(verdicts.filter((v) => v === "better")).toHaveLength(10);
    expect(verdicts.filter((v) => v === "lateral")).toHaveLength(3);
    expect(verdicts.filter((v) => v === "kept")).toHaveLength(1);
    for (const c of H34_REPLAY) {
      const picked = repick(c);
      expect(picked, c.cid).toBe(c.expected);
      if (c.verdict === "kept") {
        expect(picked, c.cid).toBe(c.stored);
        continue;
      }
      expect(picked, c.cid).not.toBe(c.stored);
      expect(isAcceptableNeutral(picked!, c.titles.filter((t) => cleanHeadline(t) !== picked)), c.cid).toBe(true);
      expect(loadedPenalty(picked!), c.cid).toBe(0);
      expect(pickNeutralTitle(c.titles.map((title) => ({ title })), { incumbent: picked }), c.cid).toBe(picked);
    }
  });

  it("a first pick (no incumbent) over the 14 fixture clusters is the re-pick, except where the stored title stays", () => {
    for (const c of H34_REPLAY) {
      const fresh = pickNeutralTitle(c.titles.map((title) => ({ title })));
      if (c.verdict === "kept") expect(fresh, c.cid).not.toBe(c.stored);
      else expect(fresh, c.cid).toBe(c.expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Hunt 42 (h42-titles-1 and h42-titles-2): the replay over the 14-day re-pick set.
//
// The set: every cluster that neutral_title_repick_candidates walks (not archived, no LLM title, a stored
// extractive title, article_count >= 2, updated in the last 14 days): 3,884 clusters on 2026-11-05 (3,739
// stamped v6, 145 still v4), each with its member titles newest first (read-only SELECT of cluster_articles
// x articles, nothing written). pickNeutralTitle(members, { incumbent: stored }) before (HEAD 11af736) and
// after the hunt-42 change, as first written and as it stands after the review fixes (sec-db-1,
// correctness-2, editorial-1 to editorial-6):
//
//                         HEAD              first version          after the review fixes
//   changed titles        12 = 0.31%        158 = 4.07%            139 = 3.58%   (limit for the v7 bump: 15%)
//   by the rule that made the change (final, 139): stored title no member carries (h42-titles-1) 96,
//                         loaded wording 12, number 9, hedge 6, Title Case 5, margin 5, incumbentDefect 4,
//                         gate or first pick 1, glued-twin tiebreak 1 (e02ef916, "Tel Aviv-Washington")
//   stored title not a member title (the churn guard of h42-titles-1): 97 of 3,884 = 2.5% (limit 5%);
//                         96 are replaced by a member's wording, 1 (fd5896d8) stays: its stored title passes the
//                         gate and its one other member is a 193-character quote that does not (the 162 residue)
//   the 150-cluster corpus: 12 -> 18 (first version) -> 16 of 150 = 10.7% (CORPUS_CHANGED_BY_H42)
//   85 clusters of the set return null (nothing passes the gate and the stored title is a member's own: the
//                         cron keeps it, as before)
//   fixed points: 138 of the 139 picks are kept by the next re-pick; 04d5f3a4's stale pick is the best
//                         member that is neither Title Case nor more framed, and a later regular re-pick takes
//                         the top-scored (Title Case) line through incumbentDefect: it does not loop, the cron
//                         stamps the row after one pick
//
// Thirty of the 146 changes of the FIRST version that differed from HEAD's result were drawn at random
// (seed 4242) and judged by hand as a Turkish editor, old -> new, in
// src/lib/clusters/__fixtures__/h42-replay-sample.json: 14 better, 12 lateral, 4 worse. Re-run on the
// final picker, 25 of the 30 still change (14 better, 10 lateral, 1 worse: 59bcbd7c) and 5 now keep the
// stored title (e0c9b092 and the number rule, d5a6d9ab and the hedge vocabulary, 9e5b27cb and bb37c171 and
// the centrality guard, ce1fefd7 and the lexicon). The `first` and `firstVerdict` fields keep the first
// version's judgment of the eight entries whose result moved. The sample was not redrawn: it is the first
// version's, re-run. The remaining worse one keeps the v7 bump from shipping (the gate is "no regression
// in the sample"), and the v6 heal had not finished either (84 of the set were still extractive-v4 at 18:00Z).
// The picker rules ship without the bump: they reach first picks, the re-picks of grown clusters and the
// stale-edit clusters migration 162 offers.
// ---------------------------------------------------------------------------

interface H42Sample {
  cid: string;
  id: string;
  rule: "nonmember" | "loaded" | "number" | "hedge" | "titleCase" | "defect" | "margin";
  stored: string;
  model: string;
  article_count: number;
  titles: string[];
  expected: string;
  verdict: "better" | "lateral" | "worse" | "kept";
  why: string;
  /** The first version's result and judgment, where the review fixes moved the entry. */
  first?: string;
  firstVerdict?: "better" | "lateral" | "worse";
}

const H42_SAMPLE: H42Sample[] = JSON.parse(
  readFileSync(resolve(__dirname, "__fixtures__/h42-replay-sample.json"), "utf8"),
) as H42Sample[];

const h42SampleMembers = (c: H42Sample) => c.titles.map((title) => ({ title }));

describe("re-pick replay: the hunt-42 sample of the 14-day set", () => {
  it("holds the 30 hand-reviewed entries: 25 still change (14 better, 10 lateral, 1 worse) and 5 keep the stored title, each with a reason", () => {
    expect(H42_SAMPLE).toHaveLength(30);
    const count = (v: string) => H42_SAMPLE.filter((c) => c.verdict === v).length;
    expect([count("better"), count("lateral"), count("worse"), count("kept")]).toEqual([14, 10, 1, 5]);
    expect(H42_SAMPLE.filter((c) => c.verdict === "worse").map((c) => c.cid)).toEqual(["59bcbd7c"]);
    expect(H42_SAMPLE.filter((c) => c.verdict === "kept").map((c) => c.cid)).toEqual([
      "e0c9b092",
      "d5a6d9ab",
      "9e5b27cb",
      "bb37c171",
      "ce1fefd7",
    ]);
    // The eight entries the review fixes moved carry the first version's result and judgment.
    expect(H42_SAMPLE.filter((c) => c.first !== undefined).map((c) => c.cid).sort()).toEqual(
      ["39a2cd01", "57c73dc7", "620362a3", "9e5b27cb", "bb37c171", "ce1fefd7", "d5a6d9ab", "e0c9b092"].sort(),
    );
    for (const c of H42_SAMPLE) {
      expect(c.why.length, c.cid).toBeGreaterThan(10);
      expect(c.id.startsWith(c.cid), c.cid).toBe(true);
      expect(c.titles.length, c.cid).toBe(c.article_count);
    }
  });

  it.each(H42_SAMPLE.filter((c) => c.verdict !== "kept").map((c) => [c.cid] as const))(
    "%s: the re-pick returns the recorded title",
    (cid) => {
      const c = H42_SAMPLE.find((x) => x.cid === cid)!;
      const picked = pickNeutralTitle(h42SampleMembers(c), { incumbent: c.stored });
      expect(picked).toBe(c.expected);
      expect(picked).not.toBe(c.stored);
      expect(c.titles.some((t) => cleanHeadline(t) === picked), `${cid}: ${picked}`).toBe(true);
      expect(isAcceptableNeutral(picked!, c.titles.filter((t) => cleanHeadline(t) !== picked))).toBe(true);
      // A fixed point: the pick is a member title, so the next re-pick keeps it.
      expect(pickNeutralTitle(h42SampleMembers(c), { incumbent: picked })).toBe(picked);
    },
  );

  it.each(H42_SAMPLE.filter((c) => c.verdict === "kept").map((c) => [c.cid] as const))(
    "%s: the review fixes keep the stored title (the first version replaced it)",
    (cid) => {
      const c = H42_SAMPLE.find((x) => x.cid === cid)!;
      expect(c.first, cid).toBeDefined();
      expect(c.first, cid).not.toBe(c.stored);
      expect(c.expected, cid).toBe(c.stored);
      expect(pickNeutralTitle(h42SampleMembers(c), { incumbent: c.stored }), cid).toBe(c.stored);
    },
  );

  it("the non-member rule's sample entries are exactly the stored titles no member carries", () => {
    for (const c of H42_SAMPLE) {
      expect(incumbentIsMemberTitle(c.stored, c.titles), c.cid).toBe(c.rule !== "nonmember");
    }
  });

  it("the loaded-rule entries that still change replace a loaded stored title with an unloaded one", () => {
    for (const c of H42_SAMPLE.filter((x) => x.rule === "loaded" && x.verdict !== "kept")) {
      expect(loadedPenalty(c.stored), c.cid).toBeGreaterThan(0);
      expect(loadedPenalty(c.expected), c.cid).toBe(0);
    }
  });

  it("no model bump: the id stays extractive-v6 while the sample holds a regression and the v6 heal is unfinished", () => {
    expect(H42_SAMPLE.some((c) => c.verdict === "worse")).toBe(true);
    expect(EXTRACTIVE_MODEL_ID).toBe("extractive-v6");
  });
});

// ---------------------------------------------------------------------------
// hunt 164 (2026-11-12): h164-titles-1 (the "<kişi>'den açıklamalar" placeholder, the teasers that ask without a '?') and
// h164-titles-2 (İşçi Haber's lost capitals, the mispaired quote). The budget: the rules reach new picks, the cron's re-picks of
// the clusters migration 208 offers, and the re-picks of grown clusters; they change NONE of the 150 corpus picks.
//
// Read-only replay on production, 2026-11-12 ~19:10Z, the cron's call (pickNeutralTitle(members, { incumbent: stored, floor: the
// stored title fails the gate }), members flagged caseUnreliable by their source slug), before (HEAD 286b39e) and after:
//   1,402 clusters (extractive-v6, not archived, no LLM title, 2+ members, updated in the last 6 days; 7,020 members):
//     11 re-picks change title (0.8%), every one hand-checked, old -> new:
//       3039d877  "Bakan Bayraktar'dan libya ve venezuela mesajı"                  -> "...'dan Libya ve Venezuela ile enerji işbirliği mesajı"  better
//       4797e4f6  "Bakan kurum: Tarihte bugün ..."                                 -> "Bakan Kurum: Bugün hiç olmadığımız ..."                 better
//       ecbc23a0  "Bakan memişoğlu: Bilgi ve tecrübeyi ..."                        -> "Bakan Memişoğlu: Bilgi ve tecrübeyi ..."                better
//       3175d6f7  "Dışişleri bakanlığından Mısır'daki kazaya taziye"              -> "Dışişleri Bakanlığından Mısır'a tren kazası için ..."   better
//       37915ace  "Cevdet yılmaz COP31 zirvesinde ..."                             -> "Cevdet Yılmaz COP31 zirvesinde ..."                    better
//       2040cdf1  "Emine Erdoğan, undp Başkanı de croo ile ..."                    -> "... undp Başkanı De Croo ile ..."                       better (undp stays: no sibling spells it)
//       8541cbe6  "İranlı bakandan batı basınına soykırım eleştirisi"              -> "İranlı bakandan Batı basınına ..."                      lateral
//       9df76d26  "111. Dönem Kaymakamlar Kurası Töreni. Cumhurbaşkanı Erdoğan'dan önemli açıklamalar" (stale)
//                 -> "Cumhurbaşkanı Erdoğan 111. dönem Kaymakamlar Kurası'nda"       lateral (HEAD's replacement had 'kaymakamlar')
//       0aa78ccd  "MHP'li Yıldız'dan komisyonda sarsıcı çıkış. ..."                -> "MHP’li Yıldız’dan Komisyonda sarsıcı çıkış. ..."          lateral (Yeni Akit's twin stands for İşçi Haber's)
//       32a3e53c  "İş Dünyası ve Yatırım Zirvesi'nin Açılış Programı. Bakan Kurum'dan açıklamalar" -> "COP31 İş Dünyası ve Yatırım Zirvesi
//                 yapıldı. Cumhurbaşkanı Yardımcısı Yılmaz’dan ortak yatırım çağrısı"                                                 better
//       fd7428e8  "Tera'nın patronu Emre Tezmen YENİ Parti ile neden görüşmedi"    -> "Tera Yatırım'ın patronu Emre Tezmen, Yeni Parti’nin görüşme talebini reddetti"  better
//     0 worse. No stored title that was good changes. Two first picks (not re-picks) move for a member title judged a placeholder by
//     the tail rule (c9525327: two "...! Bakan Akın Gürlek’ten açıklama" members; b19ea407: "...İşte Bakü’den Mesajlar"): lateral.
//   211 clusters of the last 7 days that have an isci-haber member (1,948 members): 12 re-picks change (the nine above that are İşçi
//     Haber's, plus 609f9e22 'çöp31' -> 'COP31', cdc9adfb 'palestine action' -> 'Palestine Action' and ad976c62 'Cumhurbaşkanı
//     yardımcısı' -> "Cumhurbaşkanı Yardımcısı Yılmaz: Türkiye, krizlerin çözümünde aktif rol üstleniyor"), all better or lateral;
//     zero changes in any of the 1,402 clusters without an isci-haber member apart from the placeholder and teaser clusters of
//     h164-titles-1 (32a3e53c, fd7428e8 re-picks; b19ea407 a first pick) and the 150 corpus clusters (none).
// ---------------------------------------------------------------------------

interface H164ReplayFixture {
  clusters: Array<{
    cid: string;
    stored: string;
    members: Array<{ source: string; title: string; opinion: boolean }>;
  }>;
}

const h164Fixture = (name: string): H164ReplayFixture =>
  JSON.parse(readFileSync(resolve(__dirname, `__fixtures__/${name}`), "utf8")) as H164ReplayFixture;

/** The cron's re-pick call for a stored title, members flagged the way the cron flags them. */
function h164Repick(c: H164ReplayFixture["clusters"][number]): string | null {
  const titles = c.members.map((m) => m.title);
  return pickNeutralTitle(
    c.members.map((m) => ({ title: m.title, opinion: m.opinion, caseUnreliable: m.source === "isci-haber" })),
    { incumbent: c.stored, floor: !isAcceptableNeutral(c.stored, titles) },
  );
}

describe("re-pick replay: the hunt-164 rules", () => {
  it("change none of the 150 corpus picks beyond the sixteen of before (churn 16/150 = 10.7%)", () => {
    const changed = CLUSTERS.filter((c) => {
      const next = repick(c);
      return next !== null && next !== c.stored;
    }).map((c) => c.cid);
    expect(changed.sort()).toEqual(
      [...CORPUS_CHANGED_BEFORE_H26, ...CORPUS_CHANGED_BY_H31, ...CORPUS_CHANGED_BY_H42].sort(),
    );
    expect(changed).toHaveLength(16);
    expect(changed.length / CLUSTERS.length).toBeLessThan(0.15);
  });

  it("the ten placeholder and teaser clusters: nine get a member's own wording (HEAD: four), the all-teaser one is kept for the floor", () => {
    const fixture = h164Fixture("h164-generic.json");
    expect(fixture.clusters).toHaveLength(10);
    const changed = fixture.clusters.filter((c) => {
      const next = h164Repick(c);
      return next !== null && next !== c.stored;
    });
    expect(changed.map((c) => c.cid).sort()).toEqual(
      ["298bbb75", "32a3e53c", "404dda61", "67695cbd", "9d5ad97a", "9df76d26", "df08098c", "ece7ef31", "fd7428e8"].sort(),
    );
    for (const c of changed) {
      const next = h164Repick(c) as string;
      expect(incumbentIsMemberTitle(next, c.members.map((m) => m.title)), `${c.cid}: ${next}`).toBe(true);
      // A fixed point: the next re-pick keeps what this one wrote.
      expect(
        pickNeutralTitle(
          c.members.map((m) => ({ title: m.title, opinion: m.opinion, caseUnreliable: m.source === "isci-haber" })),
          { incumbent: next },
        ),
        c.cid,
      ).toBe(next);
    }
    const kept = fixture.clusters.find((c) => c.cid === "1c7c34ba")!;
    expect(h164Repick(kept)).toBe(kept.stored);
  });

  it("the eight casing clusters: every stored title is replaced (HEAD: one, 588c58ce), by a member's wording with its capitals", () => {
    const fixture = h164Fixture("h164-casing.json");
    expect(fixture.clusters).toHaveLength(8);
    for (const c of fixture.clusters) {
      const next = h164Repick(c);
      expect(next, c.cid).not.toBeNull();
      expect(next, c.cid).not.toBe(c.stored);
    }
  });
});
