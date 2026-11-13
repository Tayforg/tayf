import { describe, it, expect } from "vitest";
import {
  headlineLane,
  headlineOnlyScore,
  isMatch,
  score,
} from "../../../supabase/functions/_shared/cluster/ensemble.ts";
import { extractEntities } from "../../../supabase/functions/_shared/cluster/entities.ts";
import {
  fingerprint,
  headlineTokens,
  type HeadlineTokens,
} from "../../../supabase/functions/_shared/cluster/fingerprint.ts";
import {
  ENTITY_SPARSE_TEXT_FACTOR,
  HEADLINE_CONTAIN_BLOCK_PREFIXES,
  HEADLINE_CONTAIN_MIN,
  HEADLINE_CONTAIN_MIN_SIZE_RATIO,
  HEADLINE_CONTAIN_MIN_TOKENS,
  HEADLINE_LANE_MAX_HOURS,
  HEADLINE_LANE_MIN_JACCARD,
  HEADLINE_TITLE_MAX_CHARS,
  MATCH_THRESHOLD,
  MINHASH_SOLE_CARRIER_MIN_JACCARD,
  TFIDF_WEIGHT,
  TIME_WINDOW_HOURS,
} from "../../../supabase/functions/_shared/cluster/constants.ts";

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

// ---------------------------------------------------------------------------
// Headline containment (wave AB follow-up). The Jaccard lane needs 0.7 over the
// full token sets, so a bare wire headline ("Mustafa Sarigul Yeni Parti'den
// istifa etti", 7 tokens) never joined the same story's long headline
// ("... : Adalet tecelli edecek, partime doneceğim", 12 tokens, Jaccard 7/12 =
// 0.583) although every token of the short one is in the long one. The
// containment variant fires when the smaller token set (numerals excluded) has
// at least HEADLINE_CONTAIN_MIN_TOKENS words, at least HEADLINE_CONTAIN_MIN of
// them occur in the larger one, the numeral sets are identical, the pair is
// within the lane's hour limit and the extra words of the longer headline do
// not start with a denial/qualifier prefix. Fixtures below are real prod
// headlines (clusters 6f4d9ac2 / cffe669c, 2026-10-30; 71800f1c / 4e57766e,
// 2026-10-31; 22c347c7 / 791a9867 / a5065669 / 30c752a7, 2026-10-30), with their
// real published_at, found by mining every pair within 6 h of the 4,641-article
// corpus where containment fires and the Jaccard lane does not.
// ---------------------------------------------------------------------------

function hoursBetweenIso(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 3_600_000;
}

function wordsOf(title: string): string[] {
  const h = headlineTokens(title);
  return [...h.tokens].filter((t) => !h.numbers.has(t));
}

// Synthetic token bags for the boundary tests (the lane only reads the sets).
function bag(words: string[], numbers: string[] = []): HeadlineTokens {
  return { tokens: new Set([...words, ...numbers]), numbers: new Set(numbers) };
}

function seq(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}_${i}`);
}

const SARIGUL_SHORT = {
  title: "Mustafa Sarıgül Yeni Parti'den istifa etti",
  slug: "elips-haber",
  at: "2026-10-30T10:18:00+00:00",
};
const SARIGUL_LONG = {
  title: "Mustafa Sarıgül Yeni Parti'den istifa etti: Adalet tecelli edecek, partime döneceğim",
  slug: "haberler-com",
  at: "2026-10-30T10:25:32+00:00",
};
const SPK_SHORT = {
  title: "SPK Başkanlığına Muhsin Atcı atandı",
  slug: "elips-haber",
  at: "2026-10-31T21:14:00+00:00",
};
const SPK_LONG = {
  title: "SPK Başkanlığına Muhsin Atcı atandı! Karar Resmi Gazete'de",
  slug: "yeni-asir",
  at: "2026-10-31T21:45:07+00:00",
};

function scorePair(
  a: { title: string; slug: string },
  b: { title: string; slug: string },
  hoursDelta: number,
  tfidf = 0.2,
) {
  return score(noFp, noFp, [], [], tfidf, hoursDelta, {
    aTitle: a.title,
    bTitle: b.title,
    aSourceSlug: a.slug,
    bSourceSlug: b.slug,
  });
}

describe("headline lane: containment", () => {
  describe("positives (zero shared entities, tfidf 0.2, real time gaps)", () => {
    it("joins the short Sarigul headline to the long cffe669c headline", () => {
      const dh = hoursBetweenIso(SARIGUL_SHORT.at, SARIGUL_LONG.at);
      expect(dh).toBeGreaterThan(0.1);
      expect(dh).toBeLessThan(HEADLINE_LANE_MAX_HOURS);
      const r = scorePair(SARIGUL_SHORT, SARIGUL_LONG, dh);
      expect(r.components.headlineKind).toBe("containment");
      expect(r.components.headlineLane).toBe(true);
      expect(r.components.headlineContainment).toBe(1);
      expect(r.components.headlineShared).toBe(7);
      expect(r.components.headlineSim).toBeCloseTo(7 / 12, 10);
      // Jaccard alone (the unchanged rule) cannot carry this pair.
      expect(r.components.headlineSim).toBeLessThan(HEADLINE_LANE_MIN_JACCARD);
      expect(r.components.textFloorCapped).toBe(false);
      expect(r.components.sharedEntities).toBe(0);
      expect(isMatch(r)).toBe(true);
      // haberler-com carries the 0.85 aggregator penalty and still clears.
      expect(r.components.sourcePenalty).toBe(0.85);
      expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    });

    it("joins a second real same-event pair: SPK appointment, bare vs 'Resmi Gazete' headline", () => {
      const dh = hoursBetweenIso(SPK_SHORT.at, SPK_LONG.at);
      expect(dh).toBeLessThan(HEADLINE_LANE_MAX_HOURS);
      const r = scorePair(SPK_SHORT, SPK_LONG, dh);
      expect(r.components.headlineKind).toBe("containment");
      expect(r.components.headlineLane).toBe(true);
      expect(r.components.headlineContainment).toBe(1);
      expect(r.components.headlineSim).toBeLessThan(HEADLINE_LANE_MIN_JACCARD);
      expect(isMatch(r)).toBe(true);
    });

    it("is symmetric: swapping the sides gives the same kind and score", () => {
      const dh = hoursBetweenIso(SARIGUL_SHORT.at, SARIGUL_LONG.at);
      const fwd = scorePair(SARIGUL_SHORT, SARIGUL_LONG, dh);
      const rev = scorePair(SARIGUL_LONG, SARIGUL_SHORT, dh);
      expect(rev.components.headlineKind).toBe("containment");
      expect(rev.score).toBe(fwd.score);
      expect(rev.components.headlineContainment).toBe(fwd.components.headlineContainment);
    });

    it("still reports kind 'jaccard' when the Jaccard rule fires (containment is only a second chance)", () => {
      const r = score(noFp, noFp, [], [], 0.25, 0.2, {
        aTitle: "Son dakika... Mustafa Sarıgül YENİ Parti'den istifa etti",
        bTitle: "Mustafa Sarıgül Yeni Parti'den istifa etti: Adalet tecelli edecek",
      });
      expect(r.components.headlineKind).toBe("jaccard");
      expect(r.components.headlineLane).toBe(true);
    });
  });

  describe("negatives", () => {
    it("the same Sarigul pair 7 h apart does not fire", () => {
      const r = scorePair(SARIGUL_SHORT, SARIGUL_LONG, 7);
      expect(r.components.headlineKind).toBeNull();
      expect(r.components.headlineLane).toBe(false);
      expect(r.components.headlineContainment).toBe(1);
      expect(isMatch(r)).toBe(false);
    });

    it("fires exactly up to the lane's hour limit and not a minute past it", () => {
      expect(scorePair(SARIGUL_SHORT, SARIGUL_LONG, HEADLINE_LANE_MAX_HOURS).components.headlineKind)
        .toBe("containment");
      expect(scorePair(SARIGUL_SHORT, SARIGUL_LONG, HEADLINE_LANE_MAX_HOURS + 1 / 60).components.headlineKind)
        .toBeNull();
    });

    it("a shorter side with only 4 non-numeral tokens does not fire, even fully contained", () => {
      const short = { title: "Sarıgül Yeni Parti istifa", slug: "x" };
      expect(wordsOf(short.title)).toHaveLength(4);
      const r = scorePair(short, SARIGUL_LONG, 0.1);
      expect(r.components.headlineContainment).toBe(1);
      expect(r.components.headlineLane).toBe(false);
      expect(r.components.headlineKind).toBeNull();
      expect(isMatch(r)).toBe(false);
    });

    it("numerals do not count toward the minimum: 4 words plus a numeral still does not fire", () => {
      const short = { title: "Bakırköy soruşturmasında 39 kişi tutuklandı", slug: "x" };
      const long = {
        title: "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı! Başkan yardımcıları dahil",
        slug: "y",
      };
      expect(wordsOf(short.title)).toHaveLength(4);
      expect(headlineTokens(short.title).tokens.size).toBe(5);
      const r = scorePair(short, long, 0.4);
      expect(r.components.headlineContainment).toBe(1);
      expect(r.components.headlineLane).toBe(false);
    });

    it("differing numeral sets ({39} vs {39,22}) do not fire although every word is contained", () => {
      const r = scorePair(
        { title: "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı", slug: "a" },
        { title: "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı, 22 kişi adli kontrolle serbest", slug: "b" },
        0.5,
      );
      expect(r.components.headlineContainment).toBe(1);
      expect(r.components.headlineSim).toBeLessThan(HEADLINE_LANE_MIN_JACCARD);
      expect(r.components.headlineLane).toBe(false);
      expect(r.components.headlineKind).toBeNull();
      expect(isMatch(r)).toBe(false);
    });

    it("the same numerals on both sides do fire (control for the numeral rule)", () => {
      const r = scorePair(
        { title: "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı", slug: "a" },
        { title: "Bakırköy Belediyesi soruşturması: Başkan yardımcıları dahil 39 kişi tutuklandı", slug: "b" },
        0.4,
      );
      expect(r.components.headlineKind).toBe("containment");
      expect(isMatch(r)).toBe(true);
    });

    it("a denial follow-up does not fire when its extra words carry a denial prefix", () => {
      const denial = {
        title: "Mustafa Sarıgül Yeni Parti'den istifa etti iddiasına yalanlama: İstifa etmedim, partimin yanındayım",
        slug: "b",
      };
      const r = scorePair(SARIGUL_SHORT, denial, 0.3);
      // Every word of the short headline is contained and the Jaccard rule is
      // far off (7/12), so only the block prefix stands between this pair and a merge.
      expect(r.components.headlineContainment).toBe(1);
      expect(r.components.headlineSim).toBeLessThan(HEADLINE_LANE_MIN_JACCARD);
      expect(r.components.headlineKind).toBeNull();
      expect(r.components.headlineLane).toBe(false);
      expect(isMatch(r)).toBe(false);
    });

    it("the verbatim denial headline is caught by the unchanged Jaccard rule (7/9), not by containment", () => {
      // 'iddiasina' + 'yalanlama' add only two tokens, so the pre-existing
      // Jaccard rule (>= 0.7) already joins this pair. Containment's block
      // prefixes deliberately do not touch that rule.
      const r = scorePair(
        SARIGUL_SHORT,
        { title: "Mustafa Sarıgül Yeni Parti'den istifa etti iddiasına yalanlama", slug: "b" },
        0.3,
      );
      expect(r.components.headlineSim).toBeCloseTo(7 / 9, 10);
      expect(r.components.headlineKind).toBe("jaccard");
    });

    it.each([
      ["iddiasına yalanlama geldi", "yalan"],
      // Bare "degil" is a stop word and never reaches the token set; only its
      // inflections ("degildir", "degildi") do, which is what the prefix catches.
      ["haberi doğru değildir", "degil"],
      ["iddia edildi", "iddia"],
      ["tekzip yayımlandı", "tekzip"],
    ])("a long headline whose extra words include %s (%s) is blocked, the same length without it fires", (tail, prefix) => {
      expect(HEADLINE_CONTAIN_BLOCK_PREFIXES).toContain(prefix);
      const blocked = scorePair(
        SARIGUL_SHORT,
        { title: `Mustafa Sarıgül Yeni Parti'den istifa etti: ${tail}, açıklama bekleniyor Ankara kulis`, slug: "b" },
        0.2,
      );
      expect(blocked.components.headlineContainment).toBe(1);
      expect(blocked.components.headlineKind).toBeNull();
      const control = scorePair(
        SARIGUL_SHORT,
        { title: "Mustafa Sarıgül Yeni Parti'den istifa etti: yeni görev kararı, açıklama bekleniyor Ankara kulis", slug: "b" },
        0.2,
      );
      expect(control.components.headlineKind).toBe("containment");
    });
  });

  describe("real different-event pairs that share a person and a verb", () => {
    // Fidan met several counterparts on the sidelines of one G20 meeting; each
    // meeting is its own event although person + verb ("Fidan ... gorustu")
    // are shared.
    const NASIR = {
      title: "Bakan Fidan, Endonezya Dışişleri Bakanı Nasir ile görüştü",
      slug: "sabah",
      at: "2026-10-30T16:41:33+00:00",
    };
    const RUBIO = {
      title: "Dışişleri Bakanı Fidan, ABD Dışişleri Bakanı Rubio ile görüştü",
      slug: "sputnik-turkce",
      at: "2026-10-30T21:05:14+00:00",
    };
    const WADEPHUL = {
      title: "Dışişleri Bakanı Fidan, Atlanta'da Wadephul ile Gazze ve Ukrayna'yı görüştü",
      slug: "haberler-com",
      at: "2026-10-30T21:07:34+00:00",
    };
    const RUBIO_B = {
      title: "Bakan Fidan, ABD Dışişleri Bakanı Rubio ile görüştü",
      slug: "haber-global",
      at: "2026-10-30T21:08:00+00:00",
    };

    it("Fidan-Nasir vs Fidan-Rubio (4.4 h apart) does not fire", () => {
      const r = scorePair(NASIR, RUBIO, hoursBetweenIso(NASIR.at, RUBIO.at));
      expect(r.components.headlineLane).toBe(false);
      expect(r.components.headlineKind).toBeNull();
      expect(r.components.headlineContainment).toBeLessThan(HEADLINE_CONTAIN_MIN);
      expect(isMatch(r)).toBe(false);
    });

    it("Fidan-Wadephul vs Fidan-Rubio (seconds apart) does not fire", () => {
      const r = scorePair(WADEPHUL, RUBIO_B, hoursBetweenIso(WADEPHUL.at, RUBIO_B.at));
      expect(r.components.headlineLane).toBe(false);
      expect(r.components.headlineKind).toBeNull();
      expect(r.components.headlineContainment).toBeLessThan(HEADLINE_CONTAIN_MIN);
      expect(isMatch(r)).toBe(false);
    });

    it("two outlets' Fidan-Rubio headlines are still the same event (control: lane fires)", () => {
      const r = scorePair(RUBIO, RUBIO_B, hoursBetweenIso(RUBIO.at, RUBIO_B.at));
      expect(r.components.headlineLane).toBe(true);
    });
  });

  describe("headlineLane() boundaries", () => {
    const S20 = seq("w", 20);

    it("fires at containment exactly HEADLINE_CONTAIN_MIN (17 of 20) and not below (16 of 20)", () => {
      expect(HEADLINE_CONTAIN_MIN).toBe(0.85);
      const large = seq("L", 13);
      const at = headlineLane(bag(S20), bag([...S20.slice(0, 17), ...large]), 1);
      expect(at.containment).toBe(0.85);
      expect(at.fired).toBe(true);
      expect(at.kind).toBe("containment");
      const below = headlineLane(bag(S20), bag([...S20.slice(0, 16), ...large]), 1);
      expect(below.containment).toBe(0.8);
      expect(below.fired).toBe(false);
      expect(below.kind).toBeNull();
    });

    it("needs HEADLINE_CONTAIN_MIN_TOKENS words on the smaller side (5 fires, 4 does not)", () => {
      expect(HEADLINE_CONTAIN_MIN_TOKENS).toBe(5);
      const large = seq("L", 5);
      expect(headlineLane(bag(seq("s", 5)), bag([...seq("s", 5), ...large]), 1).fired).toBe(true);
      expect(headlineLane(bag(seq("s", 4)), bag([...seq("s", 4), ...large]), 1).fired).toBe(false);
    });

    it("honours the hour limit inclusively", () => {
      const a = bag(seq("s", 6));
      const b = bag([...seq("s", 6), ...seq("L", 6)]);
      expect(headlineLane(a, b, HEADLINE_LANE_MAX_HOURS).fired).toBe(true);
      expect(headlineLane(a, b, HEADLINE_LANE_MAX_HOURS + 0.001).fired).toBe(false);
    });

    it("treats two empty numeral sets as equal and unequal sets as a veto", () => {
      const s = seq("s", 6);
      const big = seq("L", 6);
      expect(headlineLane(bag(s), bag([...s, ...big]), 1).fired).toBe(true);
      expect(headlineLane(bag(s, ["5"]), bag([...s, ...big], ["5"]), 1).fired).toBe(true);
      expect(headlineLane(bag(s, ["5"]), bag([...s, ...big]), 1).fired).toBe(false);
      expect(headlineLane(bag(s, ["5"]), bag([...s, ...big], ["6"]), 1).fired).toBe(false);
      expect(headlineLane(bag(s, ["5"]), bag([...s, ...big], ["5", "6"]), 1).fired).toBe(false);
    });

    it("only the words missing from the smaller side are checked for block prefixes", () => {
      const shared = [...seq("s", 5), "iddiasina"];
      const big = seq("L", 6);
      // 'iddiasina' is in both headlines (shared) -> no veto.
      expect(headlineLane(bag(shared), bag([...shared, ...big]), 1).fired).toBe(true);
      // The same token only in the longer headline -> veto.
      expect(headlineLane(bag(seq("s", 6)), bag([...seq("s", 6), "iddiasina", ...big]), 1).fired).toBe(false);
      // Control: the same pair without the prefixed token fires.
      expect(headlineLane(bag(seq("s", 6)), bag([...seq("s", 6), ...big]), 1).fired).toBe(true);
    });

    it("returns the documented result shape: containment score is 0.5 + 0.5 * full-set Jaccard", () => {
      const s = seq("s", 7);
      const l = [...s, ...seq("L", 5)];
      const r = headlineLane(bag(s), bag(l), 0.5);
      expect(r).toEqual({
        fired: true,
        kind: "containment",
        sim: 7 / 12,
        shared: 7,
        containment: 1,
        score: 0.5 + 0.5 * (7 / 12),
      });
    });

    it("keeps the Jaccard rule byte-for-byte: kind 'jaccard' and the same score formula", () => {
      const a = bag(["a1", "b1", "c1", "d1", "e1", "f1", "g1"]);
      const b = bag(["a1", "b1", "c1", "d1", "e1", "f1", "g1", "h1", "i1", "j1"]);
      const r = headlineLane(a, b, 0.2);
      expect(r.kind).toBe("jaccard");
      expect(r.fired).toBe(true);
      expect(r.sim).toBeCloseTo(0.7, 10);
      expect(r.shared).toBe(7);
      expect(r.score).toBeCloseTo(0.85, 10);
    });

    it("returns an inert result for empty, one-sided and non-overlapping inputs", () => {
      const inert = { fired: false, kind: null, sim: 0, shared: 0, containment: 0, score: 0 };
      expect(headlineLane(bag([]), bag([]), 0)).toEqual(inert);
      expect(headlineLane(bag([]), bag(seq("s", 8)), 0)).toEqual(inert);
      expect(headlineLane(bag(seq("s", 8)), bag([]), 0)).toEqual(inert);
      const disjoint = headlineLane(bag(seq("s", 8)), bag(seq("t", 8)), 0);
      expect(disjoint.fired).toBe(false);
      expect(disjoint.kind).toBeNull();
      expect(disjoint.shared).toBe(0);
      expect(disjoint.containment).toBe(0);
      expect(disjoint.score).toBe(0);
    });

    it("is symmetric for equal-size sets (the tie never changes the verdict)", () => {
      const a = bag([...seq("s", 18), "x1", "x2"]);
      const b = bag([...seq("s", 18), "y1", "y2"]);
      const fwd = headlineLane(a, b, 1);
      const rev = headlineLane(b, a, 1);
      expect(rev).toEqual(fwd);
      // 18 of 20 contained = 0.9 and full-set Jaccard 18/22 = 0.82: the Jaccard rule owns it.
      expect(fwd.kind).toBe("jaccard");
    });

    it("rejects non-finite or negative hour gaps without throwing", () => {
      const s = seq("s", 6);
      const l = bag([...s, ...seq("L", 6)]);
      expect(headlineLane(bag(s), l, Number.NaN).fired).toBe(false);
      expect(headlineLane(bag(s), l, Number.POSITIVE_INFINITY).fired).toBe(false);
      // A negative gap is treated like the existing lane does: <= limit passes.
      expect(headlineLane(bag(s), l, -1).fired).toBe(true);
    });
  });

  // Size guard (review of wave AB). Containment alone carries a pair over the
  // threshold and switches the text floor off, so without a bound on how much
  // longer the long headline may be, ONE roundup / keyword-stuffed headline
  // (source feeds are untrusted; titles are stored unshortened) is "contained"
  // by every unrelated short headline of the same 6 h and would pull them all
  // into its cluster.
  describe("size guard: a long headline cannot swallow unrelated short ones", () => {
    const BANK = "Merkez Bankası faiz kararını açıkladı";
    const DERBY = "Galatasaray derbide Fenerbahçe'yi üç golle yendi";
    const RAIN = "İstanbul'da sağanak nedeniyle seferler iptal edildi";
    const ROUNDUP = `${BANK}; ${DERBY}; ${RAIN}`;
    // Distinct alphabetic 4-letter words (seq() would add numerals, which the
    // numeral rule then vetoes for a reason unrelated to the size guard).
    const alphaAt = (i: number): string =>
      "w" + [Math.floor(i / 676) % 26, Math.floor(i / 26) % 26, i % 26]
        .map((c) => String.fromCharCode(97 + c))
        .join("");
    const alpha = (n: number): string[] => Array.from({ length: n }, (_, i) => alphaAt(i));
    const SHORTS = [
      { name: "central bank rate decision", title: BANK },
      { name: "derby result", title: DERBY },
      { name: "Istanbul rain cancellations", title: RAIN },
    ];

    it("pins the constants", () => {
      expect(HEADLINE_CONTAIN_MIN_SIZE_RATIO).toBe(0.4);
      expect(HEADLINE_TITLE_MAX_CHARS).toBe(300);
    });

    it.each(SHORTS)("fixture: the $name headline is fully contained in the roundup and long enough (the guard, not the other rules, must stop it)", ({ title }) => {
      const s = wordsOf(title);
      const l = wordsOf(ROUNDUP);
      expect(s.length).toBeGreaterThanOrEqual(HEADLINE_CONTAIN_MIN_TOKENS);
      expect(s.every((w) => l.includes(w))).toBe(true);
      expect(headlineTokens(title).numbers.size).toBe(0);
      expect(headlineTokens(ROUNDUP).numbers.size).toBe(0);
      // None of the roundup's extra words trips a block prefix.
      const extras = l.filter((w) => !s.includes(w));
      expect(extras.some((w) => HEADLINE_CONTAIN_BLOCK_PREFIXES.some((p) => w.startsWith(p)))).toBe(false);
      // The headline is under a third of the roundup.
      expect(s.length / l.length).toBeLessThan(HEADLINE_CONTAIN_MIN_SIZE_RATIO);
    });

    it.each(SHORTS)("headlineLane() does not fire containment for the $name headline, in either argument order, at 1 h and 5.9 h", ({ title }) => {
      const s = headlineTokens(title);
      const l = headlineTokens(ROUNDUP);
      for (const hours of [0, 1, 5.9]) {
        for (const [a, b] of [[s, l], [l, s]] as const) {
          const r = headlineLane(a, b, hours);
          expect(r.containment).toBe(1);
          expect(r.sim).toBeLessThan(HEADLINE_LANE_MIN_JACCARD);
          expect(r.kind).not.toBe("containment");
          expect(r.kind).toBeNull();
          expect(r.fired).toBe(false);
          expect(r.score).toBe(0);
        }
      }
    });

    it.each(SHORTS)("headlineOnlyScore() is 0 for the $name headline against the roundup", ({ title }) => {
      const s = headlineTokens(title);
      const l = headlineTokens(ROUNDUP);
      for (const hours of [0.2, 1, 5.9]) {
        expect(headlineOnlyScore(s, l, hours, {})).toBe(0);
        expect(headlineOnlyScore(l, s, hours, { aSourceSlug: "sozcu", bSourceSlug: "haberler-com" })).toBe(0);
      }
    });

    it.each(SHORTS)("score() does not join the $name headline to the roundup on headlines alone (no entities, tfidf 0.2)", ({ title }) => {
      for (const hours of [1, 5.9]) {
        const r = scorePair({ title, slug: "a" }, { title: ROUNDUP, slug: "b" }, hours, 0.15);
        expect(r.components.headlineLane).toBe(false);
        expect(r.components.headlineKind).toBeNull();
        // The text floor stays on, so a low-tfidf pair cannot ride the lane.
        expect(r.components.textFloorCapped).toBe(true);
        expect(isMatch(r)).toBe(false);
      }
    });

    it("a keyword-stuffed title (the same short headline buried in dozens of extra words) is inert", () => {
      const stuffed = `${BANK} ${alpha(35).join(" ")}`;
      expect(wordsOf(stuffed).length).toBeGreaterThan(30);
      expect(headlineTokens(stuffed).numbers.size).toBe(0);
      const r = headlineLane(headlineTokens(BANK), headlineTokens(stuffed), 1);
      expect(r.containment).toBe(1);
      expect(r.fired).toBe(false);
      expect(headlineOnlyScore(headlineTokens(BANK), headlineTokens(stuffed), 1, {})).toBe(0);
    });

    describe("boundary of HEADLINE_CONTAIN_MIN_SIZE_RATIO (words only, numerals excluded)", () => {
      const S10 = seq("s", 10);

      it("fires at exactly 10 / 25 = 0.4 and not at 10 / 26", () => {
        expect(HEADLINE_CONTAIN_MIN_SIZE_RATIO).toBe(0.4);
        const at = headlineLane(bag(S10), bag([...S10, ...seq("L", 15)]), 1);
        expect(at.fired).toBe(true);
        expect(at.kind).toBe("containment");
        const past = headlineLane(bag(S10), bag([...S10, ...seq("L", 16)]), 1);
        expect(past.containment).toBe(1);
        expect(past.fired).toBe(false);
        expect(past.kind).toBeNull();
      });

      it("is symmetric: the verdict does not depend on which side is passed first", () => {
        const small = bag(S10);
        for (const extra of [15, 16]) {
          const large = bag([...S10, ...seq("L", extra)]);
          expect(headlineLane(large, small, 1)).toEqual(headlineLane(small, large, 1));
        }
      });

      it("counts words only: shared numerals on both sides do not loosen the ratio", () => {
        const nums = ["2026", "11"];
        const past = headlineLane(bag(S10, nums), bag([...S10, ...seq("L", 16)], nums), 1);
        expect(past.fired).toBe(false);
        const at = headlineLane(bag(S10, nums), bag([...S10, ...seq("L", 15)], nums), 1);
        expect(at.fired).toBe(true);
      });

      it("does not touch the Jaccard rule: a same-size pair at 0.7 still joins as 'jaccard'", () => {
        const r = headlineLane(
          bag(["a1", "b1", "c1", "d1", "e1", "f1", "g1"]),
          bag(["a1", "b1", "c1", "d1", "e1", "f1", "g1", "h1", "i1", "j1"]),
          0.2,
        );
        expect(r.kind).toBe("jaccard");
      });
    });

    describe("title length cap (HEADLINE_TITLE_MAX_CHARS)", () => {
      it("ignores everything past the cap", () => {
        const head = `${BANK} `;
        const filler = "x".repeat(HEADLINE_TITLE_MAX_CHARS - head.length - 1);
        const tail = "zebracik kaplumbaga ornitorenk";
        const t = headlineTokens(`${head}${filler} ${tail}`);
        const starts = (p: string) => [...t.tokens].some((x) => x.startsWith(p));
        expect(starts("zebra")).toBe(false);
        expect(starts("kaplum")).toBe(false);
        expect(starts("ornit")).toBe(false);
        // The part inside the cap is still tokenised.
        expect(starts("faiz")).toBe(true);
      });

      it("leaves a title of exactly the cap length untouched", () => {
        const pad = "y".repeat(HEADLINE_TITLE_MAX_CHARS - " sonkelime".length);
        const title = `${pad} sonkelime`;
        expect(title.length).toBe(HEADLINE_TITLE_MAX_CHARS);
        expect([...headlineTokens(title).tokens].some((x) => x.startsWith("sonkel"))).toBe(true);
      });

      it("bounds the token count of a megabyte-sized title", () => {
        const huge = Array.from({ length: 17_000 }, (_, i) => alphaAt(i)).join(" ");
        const t = headlineTokens(huge);
        expect(t.tokens.size).toBeGreaterThan(0);
        expect(t.tokens.size).toBeLessThanOrEqual(HEADLINE_TITLE_MAX_CHARS / 2);
      });

      it("an over-long roundup of many headlines cannot match a short one through score() either", () => {
        const many = SHORTS.map((s) => s.title).join(" ") + " " + alpha(100).join(" ");
        const r = scorePair({ title: BANK, slug: "a" }, { title: many, slug: "b" }, 1);
        expect(r.components.headlineLane).toBe(false);
        expect(isMatch(r)).toBe(false);
      });
    });

    it("the real positives still pass the guard with room to spare", () => {
      for (const [short, long] of [[SARIGUL_SHORT, SARIGUL_LONG], [SPK_SHORT, SPK_LONG]] as const) {
        const s = wordsOf(short.title).length;
        const l = wordsOf(long.title).length;
        expect(s / l).toBeGreaterThanOrEqual(HEADLINE_CONTAIN_MIN_SIZE_RATIO);
        const r = headlineLane(headlineTokens(short.title), headlineTokens(long.title), 0.2);
        expect(r.kind).toBe("containment");
      }
    });
  });

  describe("headlineOnlyScore()", () => {
    const haA = headlineTokens(SARIGUL_SHORT.title);
    const haB = headlineTokens(SARIGUL_LONG.title);

    it("is lane score x time decay x source penalty, and equals score() when only the lane carries the pair", () => {
      const dh = hoursBetweenIso(SARIGUL_SHORT.at, SARIGUL_LONG.at);
      const lane = headlineLane(haA, haB, dh);
      const expected = lane.score * Math.max(0, 1 - dh / TIME_WINDOW_HOURS) * 0.85;
      const got = headlineOnlyScore(haA, haB, dh, {
        aSourceSlug: SARIGUL_SHORT.slug,
        bSourceSlug: SARIGUL_LONG.slug,
      });
      expect(got).toBeCloseTo(expected, 12);
      expect(got).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      // Pair carried only by the lane: no entities, tfidf 0.
      const full = score(noFp, noFp, [], [], 0, dh, {
        aTitle: SARIGUL_SHORT.title,
        bTitle: SARIGUL_LONG.title,
        aSourceSlug: SARIGUL_SHORT.slug,
        bSourceSlug: SARIGUL_LONG.slug,
      });
      expect(got).toBe(full.score);
    });

    it("applies no penalty for ordinary sources and the smaller multiplier when either side is penalised", () => {
      const plain = headlineOnlyScore(haA, haB, 1, { aSourceSlug: "sozcu", bSourceSlug: "milliyet" });
      const penalised = headlineOnlyScore(haA, haB, 1, { aSourceSlug: "sozcu", bSourceSlug: "haberler-com" });
      const nullSlugs = headlineOnlyScore(haA, haB, 1, { aSourceSlug: null, bSourceSlug: null });
      expect(nullSlugs).toBe(plain);
      expect(penalised).toBeCloseTo(plain * 0.85, 12);
    });

    it("returns 0 when the lane does not fire (too far apart, empty titles, different events)", () => {
      expect(headlineOnlyScore(haA, haB, 7, {})).toBe(0);
      expect(headlineOnlyScore(headlineTokens(""), haB, 0.1, {})).toBe(0);
      expect(headlineOnlyScore(haA, headlineTokens("Hava durumu yarın yağmurlu"), 0.1, {})).toBe(0);
    });

    it("decays with the time gap like score() does (0 h scores above 6 h)", () => {
      const near = headlineOnlyScore(haA, haB, 0, {});
      const far = headlineOnlyScore(haA, haB, 6, {});
      expect(near).toBeGreaterThan(far);
      expect(far).toBeCloseTo(near * (1 - 6 / TIME_WINDOW_HOURS), 12);
    });

    it("never mixes in tfidf, entities or fingerprints (no opts needed)", () => {
      expect(headlineOnlyScore(haA, haB, 0.2)).toBeGreaterThan(0);
    });
  });

  describe("ScoreComponents: new fields", () => {
    it("reports headlineContainment and headlineKind in every branch", () => {
      const plain = score(noFp, noFp, [], [], 0.25, 1);
      expect(plain.components.headlineContainment).toBe(0);
      expect(plain.components.headlineKind).toBeNull();

      const auto = score(
        { strict: "same", signature: null },
        { strict: "same", signature: null },
        [],
        [],
        0.1,
        1,
        { aTitle: SARIGUL_SHORT.title, bTitle: SARIGUL_LONG.title },
      );
      expect(auto.components.autoAccept).toBe(true);
      expect(auto.components.headlineContainment).toBe(0);
      expect(auto.components.headlineKind).toBeNull();

      const oneSided = score(noFp, noFp, [], [], 0.25, 1, { aTitle: SARIGUL_SHORT.title, bTitle: "" });
      expect(oneSided.components.headlineContainment).toBe(0);
      expect(oneSided.components.headlineKind).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// h19-recall-1: entity-sparse same-event pairs (hunt 19, 2026-11-02).
//
// A pair where either article carries no whitelist entity used to be scored
// 0.7*tfidf + 0.3*0 -- at most 0.70 of its text similarity -- so a paraphrase
// needed tfidf >= 0.571 before decay to reach MATCH_THRESHOLD. Such pairs are
// the main source of twin clusters (16.7% of live clusters of the 24 h replay).
// With either side entity-less the pair is now scored on text alone, at
// tfidf * ENTITY_SPARSE_TEXT_FACTOR.
//
// Fixture provenance: the four rows are read-only prod rows (title, published_at,
// source slug) of the hunt-19 24 h replay (2026-11-02). Each description is the
// output of the CURRENT cleanDescription() at the time of writing, pasted as a
// literal (identical to the stored text for all four rows); this file must not
// import description-clean, which a parallel wave edits. tfidf is the replay's
// own TfidfIndex.cosine over the 1,550-article 24 h corpus, passed as the
// override; entities are the real extractEntities(title + ' ' + description).
// Hours come from published_at; the slugs and titles go to the scorer as the
// consumer passes them.
// ---------------------------------------------------------------------------

interface SparseSide {
  title: string;
  description: string;
  slug: string;
  publishedAt: string;
}

interface SparseFixture {
  label: string;
  aId: string;
  bId: string;
  a: SparseSide;
  b: SparseSide;
  tfidf: number;
  replayScoreBefore: number;
}

const SPARSE_FIXTURES: readonly SparseFixture[] = [
  {
    label: "Bolivya El Nino: yenicag vs evrensel",
    // Twin clusters d957ab67 / d40993ab, created 9 min apart.
    aId: "0d2d8da3",
    bId: "38c66e27",
    a: {
      title: "Bolivya'da El Nino kaynaklı kuraklık ve sel riskine karşı ulusal acil durum kararnamesi imzalandı",
      description: "Bolivya Devlet Başkanı Rodrigo Paz, El Nino hava olayının ülkede şiddetli kuraklığa ve sellere yol açabileceği yönündeki tahminler üzerine ulusal acil durum kararnamesini imzaladığını açıkladı.",
      slug: "yenicag",
      publishedAt: "2026-11-01T10:36:04Z",
    },
    b: {
      title: "Bolivya'da El Nino nedeniyle ulusal acil durum ilan edildi",
      description: "Bolivya Devlet Başkanı Rodrigo Paz, El Nino iklim olayının yol açtığı kuraklıkla mücadele etmek ve gelecek aylarda yaşanabilecek olası sel baskınlarına karşı hazırlık yapmak amacıyla ülke genelinde ulusal acil durum ilan eden kararnameyi imzaladı.",
      slug: "evrensel",
      publishedAt: "2026-11-01T10:43:00Z",
    },
    // Replay tf-idf (artpairs.json comp.tfidf), passed as the override.
    tfidf: 0.568691843667328,
    // Replay score before the change (artpairs.json score).
    replayScoreBefore: 0.3971259394972457,
  },
  {
    label: "Trakya cifte vatandaslar: haberler-com vs anadolu-ajansi",
    // Twin clusters 75bf668a / d6f5ba87; haberler-com carries the 0.85 source penalty.
    aId: "2d95f57c",
    bId: "db167c9c",
    a: {
      title: "Trakya'daki çifte vatandaşlar Bulgaristan seçiminin 2. turunda 15 sandıkta oy veriyor",
      description: "Bulgaristan'da cumhurbaşkanı ve cumhurbaşkanı yardımcısı seçiminin ikinci turunda Edirne, Kırklareli ve Tekirdağ'daki çifte vatandaşlar oy kullanmaya başladı. Seçim için 15'i Trakya'da olmak üzere Türkiye'de 78 sandık kuruldu; Edirne'de oy verme işlemi Başkonsoloslukta sürüyor.",
      slug: "haberler-com",
      publishedAt: "2026-11-01T06:11:37Z",
    },
    b: {
      title: "Trakya'daki çifte vatandaşlar Bulgaristan'daki cumhurbaşkanı seçiminin ikinci turu için sandık başına gitti",
      description: "Edirne, Kırklareli ve Tekirdağ'da yaşayan çifte vatandaşlar, Bulgaristan'daki cumhurbaşkanı ve cumhurbaşkanı yardımcısı seçiminin ikinci turu için sandık başına gitti.",
      slug: "anadolu-ajansi",
      publishedAt: "2026-11-01T06:14:11Z",
    },
    // Replay tf-idf (artpairs.json comp.tfidf), passed as the override.
    tfidf: 0.6579567037103748,
    // Replay score before the change (artpairs.json score).
    replayScoreBefore: 0.3911353465041951,
  },
];

// Same clamp as the scorer's clip01 (non-finite -> 0), written out here so the
// expected value is an independent computation.
function clip01Local(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function scoreSparseFixture(f: SparseFixture) {
  const entitiesA = extractEntities(`${f.a.title} ${f.a.description}`);
  const entitiesB = extractEntities(`${f.b.title} ${f.b.description}`);
  const hours = Math.abs(Date.parse(f.a.publishedAt) - Date.parse(f.b.publishedAt)) / 3_600_000;
  const result = score(
    fingerprint(f.a.title, f.a.description),
    fingerprint(f.b.title, f.b.description),
    entitiesA,
    entitiesB,
    f.tfidf,
    hours,
    { aSourceSlug: f.a.slug, bSourceSlug: f.b.slug, aTitle: f.a.title, bTitle: f.b.title },
  );
  return { entitiesA, entitiesB, hours, result };
}

describe("h19-recall-1 entity-sparse same-event pairs", () => {
  it("exposes the text factor at 0.90", () => {
    expect(ENTITY_SPARSE_TEXT_FACTOR).toBe(0.9);
  });

  for (const f of SPARSE_FIXTURES) {
    describe(f.label, () => {
      it("has one side without any whitelist entity (the fixture is entity-sparse)", () => {
        const { entitiesA, entitiesB } = scoreSparseFixture(f);
        // Observed at write time: Bolivya [] / [] (the stored 'gelecek' of the
        // evrensel row is a homograph the h12 entity fix no longer emits),
        // Trakya ['secim', 'turkiye'] / [].
        expect(Math.min(entitiesA.length, entitiesB.length)).toBe(0);
      });

      it("scores at or above MATCH_THRESHOLD", () => {
        const { result } = scoreSparseFixture(f);
        expect(result.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
        expect(isMatch(result)).toBe(true);
        // Neither veto nor the headline lane carries the pair: the text does.
        expect(result.components.headlineLane).toBe(false);
        expect(result.components.subjectVeto).toBe(false);
        expect(result.components.incidentVeto).toBe(false);
        expect(result.components.raw).toBe(result.components.primary);
      });

      it("uses the text-only primary, clip01(tfidf * ENTITY_SPARSE_TEXT_FACTOR)", () => {
        const { result } = scoreSparseFixture(f);
        expect(result.components.tfidfScore).toBe(f.tfidf);
        expect(result.components.entityRatio).toBe(0);
        expect(result.components.primary).toBe(clip01Local(f.tfidf * ENTITY_SPARSE_TEXT_FACTOR));
      });

      it("fell short before the change: old primary x timeDecay x sourcePenalty < MATCH_THRESHOLD", () => {
        const { result } = scoreSparseFixture(f);
        const c = result.components;
        const oldPrimary = TFIDF_WEIGHT * f.tfidf;
        expect(oldPrimary * c.timeDecay * c.sourcePenalty).toBeLessThan(MATCH_THRESHOLD);
        // The old end-to-end score (MinHash lane included) reproduces the
        // replay's recorded value, so the fixture really is the pair that missed.
        const oldScore = Math.max(c.jaccardScore, oldPrimary) * c.timeDecay * c.sourcePenalty;
        expect(oldScore).toBeCloseTo(f.replayScoreBefore, 12);
        expect(oldScore).toBeLessThan(MATCH_THRESHOLD);
      });

      it("is symmetric in the two sides", () => {
        const { result } = scoreSparseFixture(f);
        const swapped = scoreSparseFixture({ ...f, a: f.b, b: f.a });
        expect(swapped.result.score).toBe(result.score);
        expect(swapped.result.components.primary).toBe(result.components.primary);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// h172-clusterpurity-1/2/3: three narrow false-merge guards (the MinHash sole-carrier
// cap, the bilateral counterpart veto, the leading event tag). Each only vetoes the
// pattern its spec proves; every pair below is the SAME event under the same or a
// reworded headline and must keep matching. The 36 h production replay (every
// non-first join of the window, old vs new scorer) is in the PR; these are its
// regression pins.
// ---------------------------------------------------------------------------
describe("h172 guards: recall is unchanged for same-event pairs", () => {
  // Two 64-slot signatures that agree on `agree` slots: J = agree / 64.
  const sigs = (agree: number) => {
    const a = new Uint32Array(64);
    const b = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
      a[i] = i + 1;
      b[i] = i < agree ? i + 1 : i + 1000;
    }
    return [{ strict: null, signature: a }, { strict: null, signature: b }] as const;
  };
  const ENTS = ["erdogan", "antalya"];

  describe("MinHash sole-carrier guard", () => {
    const AA_LIVE = "CANLI - Cumhurbaşkanı Erdoğan konuşuyor";
    const SERIF = "Cumhurbaşkanı Erdoğan, Pakistan Başbakanı Şerif'i kabul etti";

    it("a wire rewrite (J >= the floor, zero shared headline tokens) still joins", () => {
      const floorSlots = Math.ceil(MINHASH_SOLE_CARRIER_MIN_JACCARD * 64);
      const [fa, fb] = sigs(floorSlots);
      const r = score(fa, fb, ENTS, ENTS, 0.2, 2.5, { aTitle: AA_LIVE, bTitle: SERIF });
      expect(r.components.headlineShared).toBe(0);
      expect(r.components.minhashSoleCarrierCapped).toBe(false);
      expect(isMatch(r)).toBe(true);
    });

    it("a near-duplicate with two shared headline tokens at J 0.53 still joins", () => {
      const [fa, fb] = sigs(34);
      const r = score(fa, fb, ["chp"], ["chp"], 0.2, 2, {
        aTitle: "Merkezefendi başkanvekili seçimi sonuçlandı",
        bTitle: "Merkezefendi Belediyesi'nde başkanvekili belli oldu",
      });
      expect(r.components.headlineShared).toBe(2);
      expect(r.components.minhashSoleCarrierCapped).toBe(false);
      expect(isMatch(r)).toBe(true);
    });

    it("a pair the headline lane or the primary lane carries is scored exactly as before", () => {
      // Same fixture with and without titles: the guard never lowers a score the other lanes carry.
      const [fa, fb] = sigs(34);
      for (const tfidf of [0.5, 0.6, 0.8, 1]) {
        const withTitles = score(fa, fb, ENTS, ENTS, tfidf, 1, { aTitle: AA_LIVE, bTitle: SERIF });
        const without = score(fa, fb, ENTS, ENTS, tfidf, 1);
        expect(withTitles.score, `tfidf ${tfidf}`).toBe(without.score);
        expect(withTitles.components.minhashSoleCarrierCapped).toBe(false);
      }
    });

    it("the strict fingerprint still auto-accepts and the pair without signatures is untouched", () => {
      const same = { strict: "a".repeat(40), signature: null };
      expect(score(same, same, [], [], 0, 1, { aTitle: AA_LIVE, bTitle: SERIF }).score).toBe(1);
      const noFp = { strict: null, signature: null };
      const r = score(noFp, noFp, ["erdogan"], ["erdogan"], 0.69, 0.5, { aTitle: AA_LIVE, bTitle: SERIF });
      expect(isMatch(r)).toBe(true);
    });
  });

  describe("counterpart veto", () => {
    const noFp = { strict: null, signature: null };
    const HOURS = 0.5;
    const IRAK_TITLES = [
      "Cumhurbaşkanı Erdoğan, Irak Cumhurbaşkanı Amedi ile görüştü",
      "Erdoğan, Irak Cumhurbaşkanı Nizar Amedi ile görüştü",
      "Antalya- Cumhurbaşkanı Erdoğan, Irak Cumhurbaşkanı Nizar Amedi ile görüştü",
      "Erdoğan, Iraklı mevkidaşı Amedi ile görüştü",
      "Erdoğan, Irak Cumhurbaşkanı Amedi ile bir araya geldi",
      "Cumhurbaşkanı Erdoğan, Irak Cumhurbaşkanı Amedi ile Antalya'da görüştü",
    ];
    const KONGO_TITLES = [
      "Cumhurbaşkanı Erdoğan, Kongo Cumhuriyeti Cumhurbaşkanı Nguesso ile Antalya’da görüştü",
      "Başkan Erdoğan, Kongo Cumhurbaşkanı ile görüştü!",
      "Erdoğan, Kongo Cumhurbaşkanı Sassou Nguesso ile bir araya geldi",
    ];

    it("the same counterpart under every wording of the ddae920b cluster still joins (all pairs, both orders)", () => {
      for (const group of [IRAK_TITLES, KONGO_TITLES]) {
        for (const a of group) {
          for (const b of group) {
            if (a === b) continue;
            const r = score(noFp, noFp, ["erdogan"], ["erdogan"], 0.6, HOURS, { aTitle: a, bTitle: b });
            expect(r.components.counterpartVeto, `${a} | ${b}`).toBe(false);
            expect(isMatch(r), `${a} | ${b}`).toBe(true);
          }
        }
      }
    });

    it("the Bosna-Hersek meeting named by its guests and by their office still joins (birgun vs sabah, 0.87)", () => {
      const names = "Başkan Erdoğan, Becirovic ve Komsic ile görüştü";
      const office = "Erdoğan, Bosna-Hersek Devlet Başkanlığı Konseyi Başkanı ile bir araya geldi";
      for (const [a, b] of [[names, office], [office, names]] as const) {
        const r = score(noFp, noFp, ["erdogan"], ["erdogan"], 0.6, 0.03, { aTitle: a, bTitle: b });
        expect(r.components.counterpartVeto, `${a} | ${b}`).toBe(false);
        expect(isMatch(r), `${a} | ${b}`).toBe(true);
      }
    });

    it("a guest named by person in one headline and by country in the other still joins", () => {
      const r = score(noFp, noFp, ["erdogan"], ["erdogan"], 0.6, 0.5, {
        aTitle: "Erdoğan, Hırvatistan Başbakanı ile görüştü",
        bTitle: "Erdoğan, Plenkoviç ile görüştü",
      });
      expect(r.components.counterpartVeto).toBe(false);
      expect(isMatch(r)).toBe(true);
    });

    it("the same meeting with the parties in the other order still joins", () => {
      const r = score(noFp, noFp, ["fidan"], ["fidan"], 0.6, HOURS, {
        aTitle: "Bakan Fidan, Japon mevkidaşı Motegi ile görüştü",
        bTitle: "Japonya Dışişleri Bakanı Motegi, Bakan Fidan ile görüştü",
      });
      expect(r.components.counterpartVeto).toBe(false);
      expect(isMatch(r)).toBe(true);
    });

    it("a bilateral title against a non-bilateral report of the same meeting still joins", () => {
      for (const other of [
        "Erdoğan ile Sassou Nguesso'nun görüşmesi ikili ilişkilerde yeni dönem işareti",
        "Antalya'da kritik zirve: Erdoğan ve N'Guesso iklim ve ticaret gündemiyle buluştu",
        "Antalya’daki Erdoğan-Nguesso görüşmesinde ikili ilişkiler ele alındı",
      ]) {
        const r = score(noFp, noFp, ["erdogan", "antalya"], ["erdogan", "antalya"], 0.55, HOURS, {
          aTitle: KONGO_TITLES[0]!,
          bTitle: other,
        });
        expect(r.components.counterpartVeto, other).toBe(false);
        expect(isMatch(r), other).toBe(true);
      }
    });

    it("the headline lane between two identical counterpart headlines is not withdrawn", () => {
      const title = "Cumhurbaşkanı Erdoğan, Katar Emiri ile görüştü: Kalkınma Yolu Projesi, enerji iş birliği ve bölgesel gelişmeler ele alındı";
      const r = score(noFp, noFp, ["erdogan"], ["erdogan"], 0.3, 1, { aTitle: title, bTitle: title.replaceAll("Cumhurbaşkanı", "Başkan") });
      expect(r.components.headlineLane).toBe(true);
      expect(r.components.counterpartVeto).toBe(false);
      expect(r.components.actorVeto).toBe(false);
      expect(isMatch(r)).toBe(true);
    });
  });

  describe("event tag prefix", () => {
    const noFp = { strict: null, signature: null };
    const DURAN = "İletişim Başkanı Duran'dan COP31 Liderler Zirvesi'ne ilişkin açıklama:";
    const ERDOGAN = "Cumhurbaşkanı Erdoğan'dan COP31 Liderler Zirvesi'ne ilişkin açıklama";

    it("the same speaker with and without a tag, and under two different tags, still joins (haberler-com seed, posta, sabah)", () => {
      const titles = [`COP31 LİDERLER ZİRVESİ - ${DURAN}`, DURAN, `İKLİM ZİRVESİ COP31 ANTALYA - ${DURAN}`, `SON DAKİKA | ${DURAN}`];
      for (const a of titles) {
        for (const b of titles) {
          if (a === b) continue;
          const r = score(noFp, noFp, ["cop31"], ["cop31"], 0.7, 2, { aTitle: a, bTitle: b });
          expect(r.components.templateVeto, `${a} | ${b}`).toBe(false);
          expect(r.components.actorVeto, `${a} | ${b}`).toBe(false);
          expect(isMatch(r), `${a} | ${b}`).toBe(true);
        }
      }
    });

    it("the same Erdoğan statement with and without a tag still joins (hurriyet, milliyet)", () => {
      const tagged = `COP31 LİDERLER ZİRVESİ - ${ERDOGAN}`;
      for (const [a, b] of [[tagged, ERDOGAN], [ERDOGAN, tagged]] as const) {
        const r = score(noFp, noFp, ["erdogan", "cop31"], ["erdogan", "cop31"], 0.7, 2, { aTitle: a, bTitle: b });
        expect(r.components.templateVeto).toBe(false);
        expect(isMatch(r)).toBe(true);
        expect(headlineOnlyScore(headlineTokens(a), headlineTokens(b), 2, { aTitle: a, bTitle: b })).toBeGreaterThan(MATCH_THRESHOLD);
      }
    });

    it("a title that only looks tagged keeps today's behaviour: a speaker before a colon, a two-word tag", () => {
      for (const t of ["BAHÇELİ: Türkiye Yüzyılı'nda kimse yalnız kalmayacak", "SON DAKİKA | Bahçeli'den önemli açıklama geldi"]) {
        const r = score(noFp, noFp, ["bahceli"], ["bahceli"], 0.7, 1, { aTitle: t, bTitle: t });
        expect(isMatch(r), t).toBe(true);
      }
    });
  });
});
