import { describe, it, expect } from "vitest";
import {
  TWIN_MERGE_MAX_SIZE,
  TWIN_MERGE_MIN_ARTICLES,
  TWIN_MERGE_MIN_BRIDGE_SCORE,
  TWIN_MERGE_MIN_SOURCES,
  twinMergeDecision,
  type TwinBridge,
  type TwinSide,
} from "../../../supabase/functions/_shared/cluster/twin-merge.ts";
import {
  incidentVetoFires,
  subjectVetoFires,
} from "../../../supabase/functions/_shared/cluster/ensemble.ts";

// ---------------------------------------------------------------------------
// h19-recall-3: twin clusters are never repaired (cluster_merge_log has 0 rows
// ever) and the consumer throws away the evidence that two clusters are the same
// story. twinMergeDecision() is the SHADOW decision over that evidence: given the
// articles of one cluster that score >= 0.55 against the other (and the reverse),
// would the two clusters be merged? Nothing here merges anything; a human still
// merges in /admin/birlestir.
//
// FIXTURES are real. The bridge rows come from a read-only replay of the 24 h
// snapshot (scratchpad clusters24.json + members24.json, taken 2026-11-02 04:24
// UTC) with the repo scorer at HEAD (bridge.mjs: for each member of one cluster
// the best ensemble score against the other cluster's seed, latest member and
// recent headlines, exactly as the consumer's context scoring sees it; every
// article that scores >= 0.40 is listed, the sub-0.55 ones are kept on purpose so
// the threshold is exercised). Scores are rounded to 3 decimals. Seed titles are
// clusters.title_tr (the seed article's title at creation) read by primary key.
//
// REPLAY vs the hunter's bridge.json (h19-recall-3 evidence):
//   2c9941bd / 8ab93bbd  7+7 at >= 0.40, 5+5 at >= 0.55   (same as bridge.json)
//   9b7c7c35 / dcdf1c8e  11+0 at >= 0.40 and >= 0.55      (same)
//   1e1c5eb0 / e43afc1d  2 at >= 0.40, 1 at >= 0.55       (bridge.json: 0 at >= 0.55;
//                         one article, haber7 0.636, scores higher at HEAD; the
//                         verdict is unchanged: one article is below the minimum of
//                         two, and the incident veto fires first anyway)
//   285fd9c7 / ea226167  1+1 at >= 0.40, 0 at >= 0.55     (the Yayman statements)
// Sizes: article_count read by PK on 2026-11-02. dcdf1c8e held 7 articles in the
// snapshot and holds 23 now (it kept growing), so the 9b7c7c35 / dcdf1c8e case is
// asserted with both sizes.
// ---------------------------------------------------------------------------

const b = (articleId: string, sourceId: string | null, score: number): TwinBridge => ({
  articleId,
  sourceId,
  score,
});

// --- 1. Antalya-Alanya otoyolu: 2c9941bd (10) twin of 8ab93bbd (18) ----------
const ANTALYA_SMALL: TwinSide = {
  id: "2c9941bd-b6b4-417d-a225-ba45f77e2158",
  seedTitle: "Antalya'dan Alanya'ya ulaşım 36 dakikaya inecek, yıllık tasarruf 23,9 milyar lira",
  size: 10,
};
const ANTALYA_BIG: TwinSide = {
  id: "8ab93bbd-0433-49df-b333-4b358c03897c",
  seedTitle: "Antalya-Alanya otoyolu ile 2,5 saatlik yol 36 dakikaya düşüyor! Yıllık 23,9 milyar lira tasarruf sağlanacak",
  size: 18,
};
const ANTALYA_BRIDGES: TwinBridge[] = [
  // articles of 2c9941bd against 8ab93bbd
  b("58694ee5-7755-4f92-ae87-6a42c4dbe259", "aydinlik", 0.833),
  b("9edde7b9-64d7-4650-b69a-e9c964918758", "sozcu", 0.829),
  b("db537887-caa9-49d4-a475-b8882af61fe4", "bha", 0.814),
  b("6a59d5de-1a49-4b94-82ea-a3167cfbf78a", "hurriyet", 0.509),
  b("6a914578-9dff-4a5e-8c16-602d25337da7", "cnn-turk", 0.782),
  b("57cc13ca-4312-470c-8844-78d7d1800f68", "posta", 0.805),
  b("f8f8f392-5be8-4390-9591-958b788b9377", "haber-com", 0.469),
  // articles of 8ab93bbd against 2c9941bd
  b("6f3ac877-226c-4815-94ac-045240b273b9", "haberport", 0.997),
  b("c660c099-ceb2-40f0-852a-6dd0906cd4c4", "muhalif", 0.468),
  b("1c24d8cd-a671-44d3-adfa-19ae07f79bc0", "sputnik-turkce", 0.813),
  b("89e24200-ddfa-4e7b-862a-fb5d429fc597", "dunya", 0.417),
  b("b19dd812-5085-4c15-b4b6-073e918dbe91", "anadolu-ajansi", 0.829),
  b("85b7a79b-d720-4cbf-a555-9462a7384332", "gazete-oksijen", 0.833),
  b("ec353423-c5e0-4688-bae3-277b62f47434", "yenicag", 0.805),
];

// --- 2. Erdogan's Seoul trip: 9b7c7c35 (24) twin of dcdf1c8e ----------------
const SEOUL_BIG: TwinSide = {
  id: "9b7c7c35-fba6-44fa-9ba9-e9b0362e35e1",
  seedTitle: "Cumhurbaşkanı Erdoğan Güney Kore'ye gitti",
  size: 24,
};
const SEOUL_SMALL: TwinSide = {
  id: "dcdf1c8e-ff91-43b8-9826-38c444cbab0a",
  seedTitle: "Erdoğan Güney Kore’de",
  size: 23, // 7 in the replay snapshot, 23 when read by PK on 2026-11-02
};
const SEOUL_BRIDGES: TwinBridge[] = [
  // 11 articles of 9b7c7c35 against dcdf1c8e, none the other way round
  b("278d8820-caa6-47b1-83b3-3ba198c0d6ca", "trt-haber", 0.731),
  b("137e6231-f87b-44d6-aa0b-76257ff34e7d", "elips-haber", 0.697),
  b("c556d426-b5b4-4135-97bf-4922237b0db1", "anadolu-ajansi", 0.732),
  b("9c172c5e-4c6a-4d1a-ac4a-e9bf7ec1e844", "dunya", 0.735),
  b("f7544336-d22f-432b-aa25-3ff205b1450d", "yeni-akit", 0.69),
  b("c58a42fe-f881-422f-9df2-9e4762eee239", "dirilis-postasi", 0.74),
  b("5243778c-b031-41ca-b6ac-8bd6b14578d4", "cumhuriyet", 0.713),
  b("1a13b730-d2d4-48d0-9e0f-95dfe0cc5bf2", "gazete-oksijen", 0.746),
  b("5ffcd7e4-3593-4a75-9723-24dfcec013a9", "star", 0.746),
  b("3d01d559-cf24-4f78-be1e-f823c6a4a480", "cgtn-turk", 0.701),
  b("5e498cb0-71d4-4ca1-9009-9c868ccc7f0d", "odatv", 0.792),
];

// --- 3. Duzce / Bolu: two different pile-ups, N pair -------------------------
const DUZCE: TwinSide = {
  id: "1e1c5eb0-1aa0-4ea2-8ff6-96791eb8d72b",
  seedTitle: "Düzce'de TIR ve iki aracın karıştığı zincirleme kazada 3 kişi yaralandı",
  size: 6,
};
const BOLU: TwinSide = {
  id: "e43afc1d-6729-4492-922d-fea1de92663d",
  seedTitle: "Bolu Dağı Viyadükleri'nde zincirleme kaza",
  size: 2,
};
const DUZCE_BOLU_BRIDGES: TwinBridge[] = [
  b("0b8f65e2-07ae-48da-9618-bc3a7195a465", "haberport", 0.428),
  b("5ddda49c-5d0e-472b-8d7c-2c16ee289d4e", "haber7", 0.636),
];

// --- 4. Yayman: two different statements, N pair -----------------------------
const YAYMAN_TAKVIM: TwinSide = {
  id: "285fd9c7-0001-4399-ade8-0f15dd142a42",
  seedTitle: "Bir kez daha Erdoğan! AK Partili Yayman'dan \"2028\" mesajı: Cumhur İttifakı'na sahip çıkmamız lazım",
  size: 1,
};
const YAYMAN_MYNET: TwinSide = {
  id: "ea226167-a222-40cf-90cc-b05ba56d23a6",
  seedTitle: "AK Partili Yayman: 'Beytülmala dokunanlar gerekli cezaları alacak'",
  size: 1,
};
const YAYMAN_BRIDGES: TwinBridge[] = [
  b("04a67a0a-7e52-4c2d-9c8e-88251a7fc1b4", "takvim", 0.415),
  b("fb2f7295-bd8f-4bc3-86f5-52931e7bee76", "mynet", 0.415),
];

// Titles that never trip a veto, for the synthetic cases.
const A: TwinSide = { id: "aaaaaaaa-0000-4000-8000-000000000001", seedTitle: "Merkez Bankası faizi sabit tuttu", size: 5 };
const B: TwinSide = { id: "bbbbbbbb-0000-4000-8000-000000000002", seedTitle: "Merkez Bankası politika faizini sabit bıraktı", size: 4 };

const art = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** n distinct articles from n distinct sources, all at the given score. */
const strong = (n: number, score = 0.9): TwinBridge[] =>
  Array.from({ length: n }, (_, i) => b(art(i + 1), `src-${i + 1}`, score));

describe("twin-merge constants", () => {
  it("pins the shadow-decision thresholds", () => {
    expect(TWIN_MERGE_MIN_BRIDGE_SCORE).toBe(0.55);
    expect(TWIN_MERGE_MIN_ARTICLES).toBe(2);
    expect(TWIN_MERGE_MIN_SOURCES).toBe(2);
    expect(TWIN_MERGE_MAX_SIZE).toBe(60);
  });
});

describe("twinMergeDecision on the real h19-recall-3 pairs", () => {
  it("Antalya-Alanya 2c9941bd / 8ab93bbd: 10 articles from 10 sources at >= 0.55 -> would merge into the larger 8ab93bbd", () => {
    const d = twinMergeDecision(ANTALYA_BRIDGES, ANTALYA_SMALL, ANTALYA_BIG);
    expect(d).toEqual({
      wouldMerge: true,
      reason: "would_merge",
      targetId: "8ab93bbd-0433-49df-b333-4b358c03897c",
      sourceId: "2c9941bd-b6b4-417d-a225-ba45f77e2158",
      articles: 10,
      sources: 10,
    });
  });

  it("is symmetric in the argument order (a/b swapped, same target)", () => {
    const d = twinMergeDecision(ANTALYA_BRIDGES, ANTALYA_BIG, ANTALYA_SMALL);
    expect(d.wouldMerge).toBe(true);
    expect(d.targetId).toBe("8ab93bbd-0433-49df-b333-4b358c03897c");
    expect(d.sourceId).toBe("2c9941bd-b6b4-417d-a225-ba45f77e2158");
  });

  it("ignores the sub-0.55 rows (0.509, 0.469, 0.468, 0.417): only the 10 strong ones count", () => {
    const weakOnly = ANTALYA_BRIDGES.filter((x) => x.score < 0.55);
    expect(weakOnly).toHaveLength(4);
    const d = twinMergeDecision(weakOnly, ANTALYA_SMALL, ANTALYA_BIG);
    expect(d.wouldMerge).toBe(false);
    expect(d.reason).toBe("too_few_articles");
    expect(d.articles).toBe(0);
  });

  it("Seoul trip 9b7c7c35 / dcdf1c8e: 11 articles from 11 sources, all in one direction -> would merge into 9b7c7c35", () => {
    const d = twinMergeDecision(SEOUL_BRIDGES, SEOUL_BIG, SEOUL_SMALL);
    expect(d).toEqual({
      wouldMerge: true,
      reason: "would_merge",
      targetId: "9b7c7c35-fba6-44fa-9ba9-e9b0362e35e1",
      sourceId: "dcdf1c8e-ff91-43b8-9826-38c444cbab0a",
      articles: 11,
      sources: 11,
    });
  });

  it("Seoul trip with the snapshot size of dcdf1c8e (7): same decision", () => {
    const d = twinMergeDecision(SEOUL_BRIDGES, SEOUL_BIG, { ...SEOUL_SMALL, size: 7 });
    expect(d.wouldMerge).toBe(true);
    expect(d.targetId).toBe("9b7c7c35-fba6-44fa-9ba9-e9b0362e35e1");
  });

  it("Duzce 1e1c5eb0 / Bolu e43afc1d: different provinces -> blocked by the incident veto", () => {
    expect(incidentVetoFires(DUZCE.seedTitle, BOLU.seedTitle)).toBe(true);
    const d = twinMergeDecision(DUZCE_BOLU_BRIDGES, DUZCE, BOLU);
    expect(d.wouldMerge).toBe(false);
    expect(d.reason).toBe("incident_veto");
    expect(d.targetId).toBeNull();
    expect(d.sourceId).toBeNull();
  });

  it("Duzce / Bolu bridges alone are not enough either: one article at >= 0.55 (0.428 is below) -> too_few_articles", () => {
    // Same bridges, seed titles that trip no veto, so only the evidence is judged.
    const d = twinMergeDecision(
      DUZCE_BOLU_BRIDGES,
      { ...DUZCE, seedTitle: "Zincirleme kaza yaralılar var" },
      { ...BOLU, seedTitle: "Zincirleme kazada yaralılar var" },
    );
    expect(d.wouldMerge).toBe(false);
    expect(d.reason).toBe("too_few_articles");
    expect(d.articles).toBe(1);
    expect(d.sources).toBe(1);
  });

  it("Yayman takvim 285fd9c7 / mynet ea226167: two different statements, bridges at 0.415 -> no merge", () => {
    expect(subjectVetoFires(YAYMAN_TAKVIM.seedTitle, YAYMAN_MYNET.seedTitle)).toBe(false);
    expect(incidentVetoFires(YAYMAN_TAKVIM.seedTitle, YAYMAN_MYNET.seedTitle)).toBe(false);
    const d = twinMergeDecision(YAYMAN_BRIDGES, YAYMAN_TAKVIM, YAYMAN_MYNET);
    expect(d).toEqual({
      wouldMerge: false,
      reason: "too_few_articles",
      targetId: null,
      sourceId: null,
      articles: 0,
      sources: 0,
    });
  });
});

describe("twinMergeDecision boundaries and edge cases", () => {
  it("a bridge at exactly 0.55 counts; at 0.549 it does not", () => {
    const at = twinMergeDecision([b(art(1), "x", 0.55), b(art(2), "y", 0.55)], A, B);
    expect(at.wouldMerge).toBe(true);
    expect(at.articles).toBe(2);
    const below = twinMergeDecision([b(art(1), "x", 0.55), b(art(2), "y", 0.549)], A, B);
    expect(below.wouldMerge).toBe(false);
    expect(below.reason).toBe("too_few_articles");
    expect(below.articles).toBe(1);
  });

  it("two articles from one source -> too_few_sources", () => {
    const d = twinMergeDecision([b(art(1), "x", 0.9), b(art(2), "x", 0.9)], A, B);
    expect(d.wouldMerge).toBe(false);
    expect(d.reason).toBe("too_few_sources");
    expect(d.articles).toBe(2);
    expect(d.sources).toBe(1);
  });

  it("the same article listed twice counts once (even through two sources)", () => {
    const d = twinMergeDecision([b(art(1), "x", 0.9), b(art(1), "y", 0.8)], A, B);
    expect(d.wouldMerge).toBe(false);
    expect(d.reason).toBe("too_few_articles");
    expect(d.articles).toBe(1);
  });

  it("a duplicate row for an article does not inflate the article or source count", () => {
    const d = twinMergeDecision([b(art(1), "x", 0.9), b(art(1), "x", 0.9), b(art(2), "x", 0.9)], A, B);
    expect(d.articles).toBe(2);
    expect(d.sources).toBe(1);
    expect(d.reason).toBe("too_few_sources");
  });

  it("a NaN or infinite score is ignored", () => {
    const nan = twinMergeDecision([b(art(1), "x", Number.NaN), b(art(2), "y", 0.9)], A, B);
    expect(nan.wouldMerge).toBe(false);
    expect(nan.reason).toBe("too_few_articles");
    expect(nan.articles).toBe(1);
    const inf = twinMergeDecision([b(art(1), "x", Infinity), b(art(2), "y", 0.9)], A, B);
    expect(inf.reason).toBe("too_few_articles");
    expect(inf.articles).toBe(1);
    // the NaN row does not poison the others
    const ok = twinMergeDecision([b(art(1), "x", Number.NaN), b(art(2), "y", 0.9), b(art(3), "z", 0.9)], A, B);
    expect(ok.wouldMerge).toBe(true);
    expect(ok.articles).toBe(2);
  });

  it("null source ids never count as a source", () => {
    const allNull = twinMergeDecision([b(art(1), null, 0.9), b(art(2), null, 0.9)], A, B);
    expect(allNull.reason).toBe("too_few_sources");
    expect(allNull.sources).toBe(0);
    const oneNull = twinMergeDecision([b(art(1), null, 0.9), b(art(2), "y", 0.9)], A, B);
    expect(oneNull.reason).toBe("too_few_sources");
    expect(oneNull.sources).toBe(1);
    const enough = twinMergeDecision([b(art(1), null, 0.9), b(art(2), "y", 0.9), b(art(3), "z", 0.9)], A, B);
    expect(enough.wouldMerge).toBe(true);
    expect(enough.articles).toBe(3);
    expect(enough.sources).toBe(2);
  });

  it("no bridges and an empty list are both too_few_articles", () => {
    const d = twinMergeDecision([], A, B);
    expect(d).toEqual({ wouldMerge: false, reason: "too_few_articles", targetId: null, sourceId: null, articles: 0, sources: 0 });
  });

  it("merged size 60 is allowed, 61 is size_cap (31 + 30)", () => {
    const ok = twinMergeDecision(strong(3), { ...A, size: 30 }, { ...B, size: 30 });
    expect(ok.wouldMerge).toBe(true);
    const over = twinMergeDecision(strong(3), { ...A, size: 31 }, { ...B, size: 30 });
    expect(over.wouldMerge).toBe(false);
    expect(over.reason).toBe("size_cap");
    expect(over.targetId).toBeNull();
    expect(over.sourceId).toBeNull();
    expect(over.articles).toBe(3);
    expect(over.sources).toBe(3);
  });

  it("a dismissed pair is never merged, whatever the evidence", () => {
    const d = twinMergeDecision(strong(6), A, B, { dismissed: true });
    expect(d.wouldMerge).toBe(false);
    expect(d.reason).toBe("dismissed");
    expect(twinMergeDecision(strong(6), A, B, { dismissed: false }).wouldMerge).toBe(true);
    expect(twinMergeDecision(strong(6), A, B, {}).wouldMerge).toBe(true);
  });

  it("the same cluster on both sides is same_cluster, before any other rule (even dismissed)", () => {
    const d = twinMergeDecision(strong(6), A, { ...B, id: A.id }, { dismissed: true });
    expect(d.wouldMerge).toBe(false);
    expect(d.reason).toBe("same_cluster");
    expect(d.targetId).toBeNull();
  });

  it("target is the larger cluster; on a tie the lexicographically smaller id", () => {
    const larger = twinMergeDecision(strong(3), { ...A, size: 3 }, { ...B, size: 9 });
    expect(larger.targetId).toBe(B.id);
    expect(larger.sourceId).toBe(A.id);
    const tie = twinMergeDecision(strong(3), { ...B, size: 7 }, { ...A, size: 7 });
    expect(A.id < B.id).toBe(true);
    expect(tie.targetId).toBe(A.id);
    expect(tie.sourceId).toBe(B.id);
  });

  it("a subject veto (different actors, same template) blocks the merge", () => {
    const lavrov = "Lavrov, Japon mevkidaşı Motegi ile görüştü";
    const fidan = "Fidan, Atlanta'da Japon mevkidaşıyla yatırım ve üçüncü ülke iş birliğini görüştü";
    expect(subjectVetoFires(lavrov, fidan)).toBe(true);
    const d = twinMergeDecision(strong(6), { ...A, seedTitle: lavrov }, { ...B, seedTitle: fidan });
    expect(d.wouldMerge).toBe(false);
    expect(d.reason).toBe("subject_veto");
  });

  it("the veto is checked before the evidence and the size cap", () => {
    const lavrov = "Lavrov, Japon mevkidaşı Motegi ile görüştü";
    const fidan = "Fidan, Atlanta'da Japon mevkidaşıyla yatırım ve üçüncü ülke iş birliğini görüştü";
    const d = twinMergeDecision([], { ...A, seedTitle: lavrov, size: 59 }, { ...B, seedTitle: fidan, size: 59 });
    expect(d.reason).toBe("subject_veto");
  });

  it("rule order: too_few_articles beats too_few_sources beats size_cap", () => {
    const big = { ...A, size: 59 };
    const big2 = { ...B, size: 59 };
    expect(twinMergeDecision([b(art(1), "x", 0.9)], big, big2).reason).toBe("too_few_articles");
    expect(twinMergeDecision([b(art(1), "x", 0.9), b(art(2), "x", 0.9)], big, big2).reason).toBe("too_few_sources");
    expect(twinMergeDecision(strong(2), big, big2).reason).toBe("size_cap");
  });

  it("does not mutate its inputs and is deterministic", () => {
    const bridges = Object.freeze(strong(4).map((x) => Object.freeze({ ...x })));
    const a = Object.freeze({ ...A });
    const bb = Object.freeze({ ...B });
    const first = twinMergeDecision(bridges, a, bb);
    const second = twinMergeDecision(bridges, a, bb);
    expect(second).toEqual(first);
    expect(bridges).toHaveLength(4);
  });

  it("handles a large evidence list (10k rows) quickly", () => {
    const rows = strong(10_000, 0.7);
    const t0 = performance.now();
    const d = twinMergeDecision(rows, A, B);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(d.wouldMerge).toBe(true);
    expect(d.articles).toBe(10_000);
    expect(d.sources).toBe(10_000);
  });
});
