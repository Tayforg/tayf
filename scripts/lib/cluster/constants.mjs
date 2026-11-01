// scripts/lib/cluster/constants.mjs
//
// Ensemble clustering tunables. Change these here — everything downstream
// imports from this module so thresholds stay consistent across the pipeline.
//
// W2-D3: rewired per R3's precision-audit + R2's duplicate-audit findings
// (see `team/logs/precision-audit.md` §5 and `team/logs/duplicate-audit.md`).
// W5-A3: re-tuned per V4's precision-recheck (`team/logs/precision-recheck.md`)
// — see the per-constant comments below for the updated values.
//
//  - `MATCH_THRESHOLD` lowered 0.55 → 0.48 (R3 §5.3: biggest single-knob
//    recall win; the 0.45–0.55 band contains Fidan-Barrack / Hormuz
//    fragments that should be merging). V4 kept this at 0.48.
//  - MinHash Jaccard joins the ensemble as a "ceiling-raiser" lane via
//    `MINHASH_SOFT_ACCEPT_JACCARD` (R3 §5.1: 70/71 MHP-fesh articles had
//    distinct strict fingerprints, so the soft Jaccard tier is what
//    actually recovers that story). W5-A3 dropped the soft-accept floor
//    from 0.6 → 0.5 because V4 found 0.6 still too strict for Turkish
//    rewording (123/173 distinct fingerprints).
//  - Entity ratio weight tilted entity-heavy (`0.65`) vs TF-IDF (`0.35`)
//    per R3 §4 — the current 50/50 split underweights the most
//    discriminating signal we have. W5-A3 nudged this back toward
//    tfidf (0.40 / 0.60) because V4 found entity-heavy 0.65 was gluing
//    meta-stories that share hot entity sets.
//
// The entity-ratio denominator fix (`max → min(|A|,|B|)` with a noise
// floor of `max(3, ...)`) lives in ensemble.mjs, not here — the constant
// below is just the floor.

// --- Weighted ensemble tunables -------------------------------------------

// W5-A3: V4 precision-recheck tuning (`team/logs/precision-recheck.md`).
// Wave 2 fell to 83% precision / 23% recall. V4 traced the regressions to
// (a) MinHash Jaccard ≥ 0.6 still being too tight for Turkish rewording,
// and (b) entity-heavy 0.65 + 0.48 threshold gluing meta-stories that share
// hot entity sets but describe different actions. The three knobs below are
// re-tuned per V4's recommendations; MATCH_THRESHOLD stays at 0.48.

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
export const MATCH_THRESHOLD = 0.40;               // was 0.48 (Sept-2026 replay)
export const TIME_WINDOW_HOURS = 48;               // articles older than this can't match
export const MIN_SHARED_ENTITIES = 1;              // was 2 (Sept-2026 replay); entity-vote floor for ensemble candidacy

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

// W5-A3: lowered 0.6 → 0.5. V4 §7 #2: "MinHash Jaccard ≥ 0.6 is still too
// strict for Turkish rewording. R3's measured ceiling was 70/71 distinct
// fingerprints; mine is 123/173. The Jaccard tier is only catching exact-
// phrase survivors." Dropping to 0.5 lets the soft-accept lane recover the
// MHP-fesh sub-clusters that Wave 2 left fragmented.
export const MINHASH_SOFT_ACCEPT_JACCARD = 0.5;    // was 0.6 (W5 V4 §7 #2)

// W5-A3: raised 0.35 → 0.40 (and ENTITY_WEIGHT lowered 0.65 → 0.60). V4 §7
// #3: "Entity-heavy weight (0.65) + lowered threshold (0.48) overfit MIXED
// precision. The 7 MIXED clusters all share the failure pattern 'hot entity
// set + same day + different actions'... Need a tfidf floor ≥ 0.30 before
// the entity score can dominate." A small tfidf bump + entity trim gives
// the lexical signal more pull without changing the formula shape.
// Weights still sum to 1.0 so the primary lane stays in [0,1].
export const TFIDF_WEIGHT = 0.70;                  // was 0.40 (Sept-2026 replay)
export const ENTITY_WEIGHT = 0.30;                 // was 0.60 (Sept-2026 replay)

export const MINHASH_SIG_K = 64;                   // MinHash signature length (must match fingerprint.mjs)

// --- Legacy exports (still imported by cluster-worker.mjs) ----------------
// Keeping MAX_CANDIDATE_CLUSTERS + ENTITY_DENOM_MIN so the worker keeps
// compiling and the candidate-gen pipeline stays unchanged. ENTITY_DENOM_MIN
// is the noise-floor used by ensemble.mjs when computing
// `shared / max(ENTITY_DENOM_MIN, min(|A|,|B|))`.

export const MAX_CANDIDATE_CLUSTERS = 20;          // per-article candidate cap before tfidf scoring
export const ENTITY_DENOM_MIN = 3;                 // R2 + R3: noise floor so tiny sets don't inflate

// A1 cluster-glue fix: entity contribution decays on this window so hot
// entities (Erdoğan, MHP, …) can't carry a pair across threshold when the
// underlying stories describe different actions. At ENTITY_FRESHNESS_HOURS
// the raw formula `1 - Δt/window` would hit 0; the 0.5 floor in ensemble.mjs
// keeps late follow-ups reachable. Increased from 4 → 6: the old 4h window
// hit the 0.5 floor at just 2h, which was too aggressive for multi-hour
// developing stories (e.g. a cabinet reshuffle unfolding over 3-5h). At 6h
// the floor engages at 3h — still tight enough to split unrelated hot-entity
// pairs while giving genuine follow-ups more room to merge.
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
export const HEADLINE_GENERIC_PREFIXES = [
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
export const HEADLINE_CONTAIN_BLOCK_PREFIXES = [
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
