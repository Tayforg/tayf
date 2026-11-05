import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanHeadline, isAcceptableNeutral, loadedPenalty, pickNeutralTitle } from "./neutral-title";

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
    expect(changed.length / CLUSTERS.length).toBeLessThan(0.1);
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

describe("re-pick replay: the hunt-26 rules", () => {
  it("change none of the 150 corpus picks beyond the twelve that changed before (churn 12/150)", () => {
    const changed = CLUSTERS.filter((c) => {
      const next = repick(c);
      return next !== null && next !== c.stored;
    }).map((c) => c.cid);
    expect(changed.sort()).toEqual([...CORPUS_CHANGED_BEFORE_H26].sort());
    expect(changed.length / CLUSTERS.length).toBeLessThan(0.1);
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

  it("change the 150 corpus picks only by CORPUS_CHANGED_BY_H31 (the twelve before h26 plus none)", () => {
    const changed = corpusChanged();
    expect(changed.sort()).toEqual([...CORPUS_CHANGED_BEFORE_H26, ...CORPUS_CHANGED_BY_H31].sort());
  });

  it("churn stays under 10% (prior bar 12.7% at the v3 re-pick; the gate for this wave was 15%)", () => {
    // 12 / 150 = 0.08: the h31 rules add nothing. If a later rule pushes this past
    // 0.1, raise the bar to 0.15 here with a comment and a hand-reviewed list.
    expect(corpusChanged().length / CLUSTERS.length).toBeLessThan(0.1);
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

  it("change none of the 150 corpus picks beyond the twelve that changed before (churn 12/150 = 8%)", () => {
    const changed = corpusChanged();
    expect(changed.sort()).toEqual([...CORPUS_CHANGED_BEFORE_H26, ...CORPUS_CHANGED_BY_H31].sort());
    expect(changed.length / CLUSTERS.length).toBeLessThan(0.15);
    expect(changed.length / CLUSTERS.length).toBeLessThan(0.1);
  });

  it("the margin still keeps all 79 corpus titles whose fresh best pick differs from the stored one", () => {
    const keptByMargin = CLUSTERS.filter((c) => {
      const items = c.titles.map((title) => ({ title }));
      return pickNeutralTitle(items) !== c.stored && repick(c) === c.stored;
    });
    expect(keptByMargin).toHaveLength(79);
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
