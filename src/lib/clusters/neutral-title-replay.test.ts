import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isAcceptableNeutral, pickNeutralTitle } from "./neutral-title";

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
