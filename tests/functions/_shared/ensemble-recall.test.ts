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
