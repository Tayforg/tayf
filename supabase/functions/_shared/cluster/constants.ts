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

// (1b) Headline containment (wave AB follow-up). The Jaccard rule needs 0.7
//     over the FULL token sets, so a bare wire headline never joined the long
//     headline of the same story: Sarigul "Mustafa Sarigul Yeni Parti'den
//     istifa etti" (7 tokens) vs "... : Adalet tecelli edecek, partime
//     donecegim" (12 tokens) is Jaccard 7/12 = 0.58 although every token of
//     the short one occurs in the long one. Containment is the second chance
//     for exactly that shape, evaluated only when the Jaccard rule did not
//     fire: with the numeral tokens removed, the smaller token set must have
//     at least HEADLINE_CONTAIN_MIN_TOKENS words, at least HEADLINE_CONTAIN_MIN
//     of them must occur in the larger set, the numeral sets of the two titles
//     must be IDENTICAL (both empty is fine; stricter than the Jaccard rule,
//     which tolerates one empty side), the pair must be inside
//     HEADLINE_LANE_MAX_HOURS, and no word that only the longer headline has
//     may start with one of HEADLINE_CONTAIN_BLOCK_PREFIXES (a denial, a
//     "claim" or a rebuttal: "... istifa etti" vs "... istifa etti iddiasina
//     yalanlama" are two developments, not one). The score is the lane's usual
//     0.5 + 0.5 * Jaccard, so Sarigul lands at 0.79 before decay and the 0.85
//     haberler-com penalty, clearly over MATCH_THRESHOLD.
//     Evidence (offline replay of the 4,641 politics articles of 2026-10-30..31,
//     newest-200 + sticky context, vs the scorer before this change): clusters
//     2,851 -> 2,821, articles in multi-source clusters 49.86% -> 50.31%, merge
//     events 1,790 -> 1,820, and the 33-case pairwise replay (seed/latest/
//     member score >= MATCH_THRESHOLD) 23 -> 25 with containment alone and 30
//     with the member scan below. Mining: of 3.28M article pairs within 6 h the
//     Jaccard rule fires on 1,486; containment adds 657 pairs (477 distinct
//     title pairs). Hand-judged: 40 of the 227 merges only the new code makes
//     -> 0 wrong; every one of the 51 of them that containment itself carries
//     was read -> 1 wrong, 1 unclear; 40 of the 197 merges it stops making ->
//     0 wrong. Known residual: a live-blog headline whose words are only an
//     event name ("CANLI | Erdogan, TDT Zirvesi'nde konusuyor", 5 words after
//     the generic prefixes go) is contained in every headline of that summit
//     (one Tokayev item joined it); MIN_TOKENS = 6 would drop exactly that
//     class at the price of the 5-word SPK/Bakirkoy positives. "degil" alone is
//     a normalizer stop word, so the "degil" prefix only catches its
//     inflections ("degildir", "degildi").
//
//     Size guard (review of this wave). Containment lifts the text floor and
//     scores >= 0.5 on its own, and a source controls its titles (they are
//     stored unshortened), so without a bound on the size difference ONE
//     roundup or keyword-stuffed headline is "contained" by every unrelated
//     short headline of the same 6 h: a roundup of three unrelated 5-6 word
//     headlines (central bank rate decision, a derby result, Istanbul rain
//     cancellations) fired containment for all three (full-set Jaccard 0.16-0.38
//     over the review probe and the regression fixtures) and scored 0.5-0.7
//     through score() and headlineOnlyScore(), over MATCH_THRESHOLD at 1 h and
//     at 5.9 h.
//     The member scan made it worse: any of a cluster's 12 newest members
//     could be that headline. HEADLINE_CONTAIN_MIN_SIZE_RATIO therefore
//     requires |S| / |L| >= 0.4 over the word sets (numerals excluded), i.e.
//     the long headline is at most 2.5x the short one. Any ratio above 1/3
//     keeps a long headline from holding three disjoint short headlines, and
//     0.4 costs far less recall than 0.5: of the 657 mined containment pairs
//     (516 distinct title pairs, see above) the ratio drops 15 (14 distinct),
//     13 of them genuine same-story pairs whose long headline is a 13-22 word
//     lede quote ("MSB acı haberi duyurdu: Hakkari'de hudut geçiş olayına
//     müdahale ederken ... asker şehit oldu" vs the 5-word wire line) and one
//     the known Tokayev residual, which it now also removes; 0.5 would drop 59
//     (47 distinct), 0.3 only 1. The Sarigul positive is 7/12 = 0.58, SPK 5/8 = 0.63.
//     Replay with the guard (same corpus and harness as above, member scan on):
//     clusters 2,821, merge events 1,820, articles in multi-source clusters
//     50.33% (50.31% without the guard); the 33-case pairwise replay is
//     unchanged at 23 -> 25 -> 30.
//     The ratio is a bound on structure, not a tuned score threshold; it is
//     applied only to the containment variant, never to the Jaccard rule.
//     HEADLINE_TITLE_MAX_CHARS clips the title handed to headlineTokens() so a
//     megabyte-long title cannot cost O(length) tokenisation per comparison
//     nor become a many-token needle; the longest title of the 4,641-article
//     replay corpus is 300 characters, so nothing real is cut.
export const HEADLINE_CONTAIN_MIN = 0.85;
export const HEADLINE_CONTAIN_MIN_TOKENS = 5;
export const HEADLINE_CONTAIN_MIN_SIZE_RATIO = 0.4;
export const HEADLINE_TITLE_MAX_CHARS = 300;
export const HEADLINE_CONTAIN_BLOCK_PREFIXES: readonly string[] = [
  "yalan",
  "iddia",
  "degil",
  "tekzip",
];
// Member-headline scan. An incoming article is compared with the seed and the
// latest of a candidate cluster by the full scorer and, headline lane only,
// with the HEADLINE_MEMBER_SCAN_MAX newest member headlines the consumer
// already holds from the member rows its context load fetches. The cap bounds
// memory and per-article CPU (<= 20 candidates x 12 lane evaluations); the
// replay is insensitive to it (clusters: cap 4 -> 2,818, 12 -> 2,821, 24 ->
// 2,820, unbounded -> 2,820), so it is not a tuned value.
export const HEADLINE_MEMBER_SCAN_MAX = 12;

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
