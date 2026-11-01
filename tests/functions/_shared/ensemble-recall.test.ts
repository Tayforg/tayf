import { describe, it, expect } from "vitest";
import { score, isMatch } from "../../../supabase/functions/_shared/cluster/ensemble.ts";

// Regression for the Sept-2026 recall collapse (~5% of clusters had 2+
// articles). Replaying 48h of prod politics articles showed the entity lane
// (weight 0.6) was capped at 1/3 whenever a pair shared only one whitelisted
// entity — which is most pairs — so two outlets running the *same headline*
// scored 0.47 against a 0.48 threshold. Meanwhile unrelated stories that
// happened to share two generic entities (turkiye + bakan, 2026 + istanbul)
// reached 0.44 on entity overlap alone. Text similarity is the signal;
// entities are a tiebreaker. Component values below are taken from real
// prod pairs observed in the replay.

// Signatures are omitted so the MinHash lane contributes nothing and the
// verdict rests entirely on the weighted primary lane.
const noFp = { strict: null, signature: null };

describe("ensemble recall: same story, thin entity evidence", () => {
  it("matches two outlets running the same headline with one shared entity", () => {
    // haberturk vs haber7, "Cumhurbaşkanı Erdoğan, Al Nahyan ile görüştü".
    const r = score(noFp, noFp, ["erdogan"], ["erdogan"], 0.69, 0.5);
    expect(isMatch(r)).toBe(true);
  });

  it("matches a moderately reworded story with one shared entity", () => {
    // a-haber vs haberturk, Bakırköy hotel fire: tfidf 0.51, shared=1.
    const r = score(noFp, noFp, ["istanbul"], ["istanbul"], 0.51, 1);
    expect(isMatch(r)).toBe(true);
  });
});

describe("ensemble precision: generic entity overlap is not a story", () => {
  it("rejects unrelated stories that share two generic entities", () => {
    // cumhuriyet Masterchef listicle vs elips-haber Akdeniz Oyunları:
    // tfidf 0.04, shared {turkiye, 2026}.
    const r = score(noFp, noFp, ["turkiye", "2026"], ["turkiye", "2026"], 0.04, 0.5);
    expect(isMatch(r)).toBe(false);
  });

  it("rejects same-day ministry stories with different actions", () => {
    // anadolu-ajansi Bakan Tekin vs haber-com Bakan Göktaş: tfidf 0.04,
    // shared {bakan, turkiye}.
    const r = score(noFp, noFp, ["bakan", "turkiye", "meb"], ["bakan", "turkiye"], 0.04, 0.5);
    expect(isMatch(r)).toBe(false);
  });
});

describe("candidate generation: title tokens reach stories the entity whitelist misses", () => {
  it("two headlines about the same unlisted person share enough tokens to become candidates", async () => {
    const { titleTokens } = await import("../../../supabase/functions/_shared/cluster/fingerprint.ts");
    const { extractEntities } = await import("../../../supabase/functions/_shared/cluster/entities.ts");
    const { TOKEN_CANDIDATE_MIN_SHARED } = await import("../../../supabase/functions/_shared/cluster/constants.ts");
    const a = "Oyuncu Serhat Mustafa Kılıç evinde ölü bulundu";
    const b = "Ünlü oyuncu Serhat Kılıç'tan acı haber: evinde ölü bulundu";
    // Neither headline carries a whitelisted entity, so the entity gate alone
    // could never propose them to the scorer.
    expect(extractEntities(a)).toEqual([]);
    expect(extractEntities(b)).toEqual([]);
    const shared = [...titleTokens(a)].filter((t) => titleTokens(b).has(t));
    expect(shared.length).toBeGreaterThanOrEqual(TOKEN_CANDIDATE_MIN_SHARED);
  });
});

// ---------------------------------------------------------------------------
// 2026-11-01 recall wave: headline lane, max entity denominator, text floor.
//
// Prod QA found (1) outlets running a near-identical headline minutes apart
// stayed in separate clusters because the shared whitelist entities were few
// and tfidf (which also sees the description) sat around 0.25, (2) a two-
// sentence story stuck to a cluster seeded by an entity-heavy ceremony piece
// purely on entity overlap (dd5535a7), because `min(|A|,|B|)` made a 3-entity
// article score 3/3 against a 10-entity seed.
// ---------------------------------------------------------------------------

describe("headline lane: near-identical headlines from different outlets", () => {
  it("joins Sarigul 'YENI Parti'den istifa' across outlets (7/10 sits exactly on the boundary)", () => {
    // Token sets (normalized + stemmed, len >= 3, generic prefixes dropped):
    //   A = {mustafa sarigul yeni parti den istifa etti}                 (7)
    //   B = A + {adalet tecelli edecek}                                  (10)
    // |A n B| = 7, |A u B| = 10 -> Jaccard 7/10 = 0.7, exactly the
    // HEADLINE_LANE_MIN_JACCARD boundary. 'den' (from "Parti'den") only counts
    // because HEADLINE_TOKEN_MIN_LEN is 3, and the comparison must be >=.
    const r = score(noFp, noFp, [], [], 0.25, 0.2, {
      aTitle: "Son dakika... Mustafa Sarıgül YENİ Parti'den istifa etti",
      bTitle: "Mustafa Sarıgül Yeni Parti'den istifa etti: Adalet tecelli edecek",
      aSourceSlug: "haberler-com",
    });
    expect(r.components.headlineLane).toBe(true);
    expect(r.components.headlineShared).toBe(7);
    expect(r.components.headlineSim).toBeCloseTo(0.7, 10);
    expect(isMatch(r)).toBe(true);
  });

  it("joins the Bakirkoy arrest headlines that differ only in wording around the numeral", () => {
    const r = score(noFp, noFp, [], [], 0.25, 1, {
      aTitle: "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı!",
      bTitle: "Bakırköy Belediyesi'ne yolsuzluk soruşturması: 39 kişi tutuklandı",
    });
    expect(r.components.headlineLane).toBe(true);
    expect(r.components.headlineShared).toBe(6);
    expect(isMatch(r)).toBe(true);
  });

  it("reports an inert lane in both branches when no titles are passed", () => {
    const plain = score(noFp, noFp, [], [], 0.25, 1);
    expect(plain.components.headlineLane).toBe(false);
    expect(plain.components.headlineShared).toBe(0);
    expect(plain.components.headlineSim).toBe(0);
    expect(plain.components.textFloorCapped).toBe(false);

    const auto = score(
      { strict: "same", signature: null },
      { strict: "same", signature: null },
      [],
      [],
      0.1,
      1,
      { aTitle: "x y z", bTitle: "x y z" },
    );
    expect(auto.components.autoAccept).toBe(true);
    expect(auto.components.headlineLane).toBe(false);
    expect(auto.components.headlineShared).toBe(0);
    expect(auto.components.headlineSim).toBe(0);
    expect(auto.components.textFloorCapped).toBe(false);
  });

  it("does not fire when only one side has a title", () => {
    const r = score(noFp, noFp, [], [], 0.25, 1, {
      aTitle: "Mustafa Sarıgül Yeni Parti'den istifa etti",
      bTitle: "",
    });
    expect(r.components.headlineLane).toBe(false);
    expect(r.components.headlineShared).toBe(0);
  });
});

describe("headline lane: must not glue distinct stories", () => {
  it("rejects live-blog boilerplate that only shares generic prefixes", () => {
    // 'CANLI', 'Cumhurbaşkanı', 'Erdoğan', 'konuşuyor', 'açıklama...' are all
    // generic prefixes, so the headline token sets share nothing.
    const r = score(noFp, noFp, ["erdogan"], ["erdogan"], 0.3, 0.5, {
      aTitle: "CANLI | Cumhurbaşkanı Erdoğan konuşuyor",
      bTitle: "Cumhurbaşkanı Erdoğan açıklamalarda bulunuyor",
    });
    expect(r.components.headlineLane).toBe(false);
    expect(isMatch(r)).toBe(false);
  });

  it("rejects a different follow-up in the same investigation (shares only 3 tokens)", () => {
    const r = score(noFp, noFp, [], [], 0.25, 1, {
      aTitle: "Bakırköy Belediyesi soruşturmasında 61 şüpheli adliyeye sevk edildi",
      bTitle: "Bakırköy Belediyesi'ne yolsuzluk soruşturması: 39 kişi tutuklandı",
    });
    expect(r.components.headlineShared).toBe(3);
    expect(r.components.headlineLane).toBe(false);
    expect(isMatch(r)).toBe(false);
  });

  it("rejects the same sentence with different numerals (61 vs 39 detained)", () => {
    // Jaccard is 5/7 = 0.714 and would pass, but the numerals differ.
    const r = score(noFp, noFp, [], [], 0.25, 1, {
      aTitle: "Bakırköy Belediyesi soruşturmasında 61 kişi tutuklandı",
      bTitle: "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı",
    });
    expect(r.components.headlineShared).toBe(5);
    expect(r.components.headlineSim).toBeCloseTo(5 / 7, 10);
    expect(r.components.headlineLane).toBe(false);
  });

  it("rejects the Sarigul pair once the articles are 8 h apart", () => {
    const r = score(noFp, noFp, [], [], 0.25, 8, {
      aTitle: "Son dakika... Mustafa Sarıgül YENİ Parti'den istifa etti",
      bTitle: "Mustafa Sarıgül Yeni Parti'den istifa etti: Adalet tecelli edecek",
      aSourceSlug: "haberler-com",
    });
    expect(r.components.headlineLane).toBe(false);
    expect(isMatch(r)).toBe(false);
  });
});

describe("entity ratio: max denominator", () => {
  it("does not let a 3-entity article ride an entity-heavy ceremony seed (dd5535a7)", () => {
    const r = score(
      noFp,
      noFp,
      ["bahceli", "mhp", "iyi"],
      ["erdogan", "kurtulmus", "ozel", "bahceli", "kilicdaroglu", "dervisoglu", "mhp", "iyi", "chp", "akp"],
      0.163,
      0.1,
    );
    expect(r.components.sharedEntities).toBe(3);
    expect(r.components.entityRatioRaw).toBeCloseTo(0.3, 10);
    expect(isMatch(r)).toBe(false);
  });
});

describe("text floor: entities alone cannot carry a pair", () => {
  const ents = ["a1", "a2", "a3"];

  it("caps a fully entity-driven pair with tfidf below the floor", () => {
    const r = score(noFp, noFp, ents, ents, 0.15, 0.5);
    expect(r.components.textFloorCapped).toBe(true);
    expect(isMatch(r)).toBe(false);
  });

  it("the cap binds: tfidf 0.19 + 3/3 entities at 0 h would score 0.433 uncapped", () => {
    const r = score(noFp, noFp, ents, ents, 0.19, 0);
    expect(r.components.primary).toBeGreaterThan(0.40);
    expect(r.components.textFloorCapped).toBe(true);
    expect(r.components.raw).toBeLessThan(0.40);
    expect(isMatch(r)).toBe(false);
  });

  it("keeps the entity-driven positive when tfidf clears the floor", () => {
    const r = score(noFp, noFp, ents, ents, 0.35, 1);
    expect(r.components.textFloorCapped).toBe(false);
    expect(r.score).toBeGreaterThan(0.47);
    expect(r.score).toBeLessThan(0.50);
    expect(isMatch(r)).toBe(true);
  });

  it("does not cap the MinHash lane", () => {
    const sig = new Uint32Array(64).fill(7);
    const r = score(
      { strict: "x", signature: sig },
      { strict: "y", signature: sig },
      [],
      [],
      0.05,
      1,
    );
    expect(r.components.jaccard).toBe(1);
    expect(isMatch(r)).toBe(true);
  });

  it("does not cap a pair carried by the headline lane even when tfidf is low", () => {
    const r = score(noFp, noFp, [], [], 0.1, 0.2, {
      aTitle: "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı!",
      bTitle: "Bakırköy Belediyesi'ne yolsuzluk soruşturması: 39 kişi tutuklandı",
    });
    expect(r.components.headlineLane).toBe(true);
    expect(r.components.textFloorCapped).toBe(false);
    expect(isMatch(r)).toBe(true);
  });
});
