// supabase/functions/_shared/cluster/constants.ts
//
// Ensemble clustering tunables. Change these here — everything downstream
// imports from this module so thresholds stay consistent across the pipeline.
//
// Ported from `scripts/lib/cluster/constants.mjs`. Keep numeric values in
// lock-step with the .mjs reference: behaviour parity is the contract the
// Edge Function refactor signs against the existing tmux clusterer.

// --- Weighted ensemble tunables -------------------------------------------

// Sept-2026 recall re-tune. A 48h replay of prod politics articles (3014
// articles, 87 live sources) showed only 17% of articles ever joined a
// multi-source cluster. Two causes, both structural:
//   (a) 60% of articles carry 0-1 whitelist entities, so the 2-shared-entity
//       candidate gate silently excluded 80% of them from scoring at all.
//   (b) With ENTITY_WEIGHT 0.60 and the /3 noise floor, a pair sharing one
//       entity capped the entity lane at 0.20, so identical headlines from two
//       outlets (tfidf 0.69) scored 0.47 < 0.48. Unrelated stories sharing two
//       generic entities (turkiye+bakan) scored 0.44 on entities alone.
// Text similarity is the signal; entities are the tiebreaker. Re-weighting
// 0.70/0.30 at threshold 0.40 with a 1-entity gate doubled recall (17% -> 33%
// of articles in multi-source clusters) with the marginal band still
// dominated by true matches. Regression: tests/functions/_shared/ensemble-recall.test.ts
export const MATCH_THRESHOLD = 0.40;
export const TIME_WINDOW_HOURS = 48;
export const MIN_SHARED_ENTITIES = 1;

// Sept-2026: candidate generation used to depend solely on the ~150-token
// entity whitelist, which left 34% of politics articles with no candidate
// cluster at all. Member titles are now also indexed by their normalized,
// stemmed tokens (length >= TOKEN_MIN_LEN, digits excluded); a cluster
// becomes a candidate when it shares TOKEN_CANDIDATE_MIN_SHARED such tokens
// with the incoming title. Replay: 33% -> 43% of articles in multi-source
// clusters at cap 60, with token-only matches (no shared entity) still
// dominated by true pairs.
export const TOKEN_CANDIDATE_MIN_SHARED = 2;
export const TOKEN_MIN_LEN = 4;

export const MINHASH_SOFT_ACCEPT_JACCARD = 0.5;

export const TFIDF_WEIGHT = 0.70;
export const ENTITY_WEIGHT = 0.30;

export const MINHASH_SIG_K = 64;

// --- Legacy exports (still imported by the candidate-gen pipeline) --------

export const MAX_CANDIDATE_CLUSTERS = 20;
export const ENTITY_DENOM_MIN = 3;

// A1 cluster-glue fix: entity contribution decays on this window so hot
// entities can't carry a pair across threshold when the underlying stories
// describe different actions.
export const ENTITY_FRESHNESS_HOURS = 6;

// --- 2026-11-01 recall wave: headline lane, text floor, sticky context ------
//
// Prod QA of 2026-10-30..11-01 politics clusters found three structural gaps
// in the scorer / context, all fixed together because they trade off.
// Evidence: an online replay of the 4,641 politics articles of 2026-10-30..31
// (newest-200 context, with vs without these changes): share of articles in
// multi-source clusters 49.45% -> 49.86%, the Sarigul group 4 -> 3 clusters,
// the 15 Dervisoglu articles stuck to the "Turkiye Yuzyili milli davamiz"
// seed cluster -> 0, and the 33-case pairwise replay (seed/latest score >=
// MATCH_THRESHOLD) 15 -> 23 of 33. A hand-judged sample of the merges that
// only the new scorer makes (100 events) found ~4% wrong, against ~10% wrong
// among the merges it stops making (40 events).
//
// (1) Same headline, different outlet, separate clusters. Sarigul "Yeni
//     Parti'den istifa etti" (clusters 6f4d9ac2 / cffe669c) and the Bakirkoy
//     municipality arrests ("39 kisi tutuklandi") each split in two. The
//     headlines were near-identical, but tfidf (which also reads the
//     description) sat near 0.25 and the pair carried 0-1 whitelist
//     entities, so primary = 0.7*0.25 + ~0 = 0.18 < MATCH_THRESHOLD. A pure
//     headline comparison recovers them: when two headlines share at least
//     HEADLINE_LANE_MIN_SHARED stemmed tokens with Jaccard >=
//     HEADLINE_LANE_MIN_JACCARD inside HEADLINE_LANE_MAX_HOURS, and any
//     numerals agree, the pair joins (score 0.5 + 0.5 * Jaccard, so the
//     lane's floor 0.85 clears the threshold even after the 0.85 haberler-com
//     penalty). 0.7 sits exactly on the Sarigul pair (7 shared of 10), hence
//     the >= comparison. Numerals must agree because "61 supheli" vs "39 kisi
//     tutuklandi" are different developments of one investigation.
export const HEADLINE_LANE_MIN_SHARED = 4;
export const HEADLINE_LANE_MIN_JACCARD = 0.7;
export const HEADLINE_LANE_MAX_HOURS = 6;
// Headline tokens are kept from 3 characters (candidate-generation tokens
// stay at TOKEN_MIN_LEN = 4): the Sarigul pair only reaches 7/10 because
// "den" (from "Parti'den") counts.
export const HEADLINE_TOKEN_MIN_LEN = 3;
// Wire boilerplate that opens countless unrelated headlines. A token is
// dropped when it STARTS WITH one of these (so inflections go too):
// "CANLI | Cumhurbaskani Erdogan konusuyor" vs "Cumhurbaskani Erdogan
// aciklamalarda bulunuyor" would otherwise share 2-3 tokens. "son"/"dakika"
// are already in the normalizer's STOP_WORDS.
export const HEADLINE_GENERIC_PREFIXES: readonly string[] = [
  "cumhurbaskan",
  "erdogan",
  "bakan",
  "turkiye",
  "canli",
  "konusuyor",
  "aciklama",
];

// (2) Entity-driven false joins. Cluster dd5535a7 was seeded by an entity-
//     heavy ceremony story (10 entities); an unrelated 3-entity article
//     shared 3 of them, scored 3 / max(3, min(3, 10)) = 1.0 on the entity
//     lane (old `min` denominator) and joined at ~0.41 with tfidf 0.163. The
//     denominator is now max(|A|, |B|) (shared 3 of 10 = 0.3), and a pair
//     whose text similarity is below ENTITY_TEXT_FLOOR can no longer be
//     carried over the threshold by entities alone: its entity/tfidf lane is
//     capped just under MATCH_THRESHOLD (MinHash and the headline lane are
//     unaffected). Pairs with tfidf >= 0.20 keep the entity-driven positive
//     (tfidf 0.35 + 3 identical entities at 1 h still scores ~0.48).
//     The cap value (0.39) lies inside cluster-consumer's fallback window
//     [MATCH_THRESHOLD * 0.9, MATCH_THRESHOLD), where a candidate is joined
//     when the primary was skipped as a duplicate-source. The consumer
//     therefore ignores a sub-threshold result that the capped lane alone
//     produced (components.textFloorCapped with raw above jaccardScore) when
//     it picks a fallback join; Jev's low band can still review such a pair.
export const ENTITY_TEXT_FLOOR = 0.20;

// (3) Follow-ups to busy stories. At peak, the CONTEXT_CLUSTER_CAP = 200
//     most recently updated clusters span only ~2 h, so a 20-article story
//     that went quiet for 3 h dropped out of the context and its next
//     follow-up opened a duplicate cluster. Besides the newest-200 window the
//     consumer now also loads up to CONTEXT_STICKY_MAX clusters with at least
//     CONTEXT_STICKY_MIN_ARTICLES articles updated within CONTEXT_STICKY_HOURS
//     (largest first). Bounded: the context is at most cap + 60 clusters.
export const CONTEXT_STICKY_MIN_ARTICLES = 5;
export const CONTEXT_STICKY_HOURS = 12;
export const CONTEXT_STICKY_MAX = 60;
