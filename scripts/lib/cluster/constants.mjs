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

// --- 2026-11-01 hunt 12, wave AJ: precision and recall of the scorer ---------
//
// (4) h12-cluster-2: chain-drift joins. Cluster 30c752a7 ("Fidan, Atlanta'da
//     Japon mevkidasiyla ...", 14 articles, live, indexable) held a Sputnik
//     Lavrov item ("Lavrov, Japon mevkidasi Motegi ile gorustu"), three
//     Fidan-Rubio items (aksam, dirilis-postasi, haber-global; Fidan-Rubio has
//     its own cluster 791a9867) and two Fidan-Wadephul items (star, muhalif).
//     Each joined an earlier member on whitelist entities that EVERY Fidan
//     story shares (bakan, disisleri, abd, fidan) plus template tf-idf: the
//     entity lane scored 3-4 shared of 4 = 0.75-1.0.
//
//     (4a) Generic entities weigh GENERIC_ENTITY_WEIGHT each in the entity
//     ratio. The numerator is max(min(shared, 1), sum of weights): one shared
//     generic entity keeps its old value (the 'istanbul' tfidf 0.51 positive
//     of ensemble-recall.test.ts stays a match; without the floor of one it
//     would fall to 0.37), four shared generic entities are worth
//     4 * GENERIC_ENTITY_WEIGHT. The denominator is unchanged. Only the entity
//     lane moves, so a pair with real text overlap is untouched.
//     The weight is the precision/recall dial of this mechanism, so it was
//     measured instead of guessed (offline replay of the 12 prod story groups,
//     509 article decisions; agreement with the prod cluster, 403 before the
//     wave): weight 1.0 (off, veto and homograph entities on) 395, 0.75 390, 0.6 386, 0.5 381, 0.4 375,
//     0.25 363. The chain this item exists for is ONE bridge: yenicag ("Bakan
//     Fidan, Japon mevkidasi Motegi ile bir araya geldi") scores 0.444 against
//     aksam ("Bakan Fidan, ABD Disisleri Bakani Rubio ile bir araya geldi") on
//     tf-idf over the shared template and four generic entities, which is how
//     the Rubio and Wadephul items entered 30c752a7. At 0.75 that pair is
//     0.397 (no margin), at 0.6 it is 0.369, at 0.25 below 0.35 -- the
//     bridge is already cut at 0.6, while 0.25 costs another 23 agreements and
//     takes the Fidan-Motegi pairs themselves under the threshold (2 of the
//     7 that join at weight 1.0 survive, against 4 at 0.6). Hence 0.6.
export const GENERIC_ENTITIES = [
  "bakan",
  "disisleri",
  "abd",
  "turkiye",
  "erdogan",
  "fidan",
  "istanbul",
];
export const GENERIC_ENTITY_WEIGHT = 0.6;

//     (4b) Subject veto. "Lavrov, Japon ..." and "Fidan, Atlanta'da Japon ..."
//     are different events with the same template. The subject of a headline
//     is the run of words before its first ',' when that comes within the
//     first SUBJECT_SPAN_MAX_WORDS words (a decimal comma such as "2,5" does
//     not count); only capitalised words count and SUBJECT_STOP_WORDS (titles,
//     roles, wire boilerplate) are dropped. When both headlines have a
//     subject, the subjects are disjoint and no subject word of either side
//     occurs anywhere in the other headline, the pair is a different actor
//     doing the same thing, and the primary and MinHash lanes are capped at
//     SUBJECT_VETO_CAP. The cap sits under the consumer's fallback floor
//     (MATCH_THRESHOLD * 0.9 = 0.36), so a vetoed pair is neither a join nor a
//     fallback join nor a Jev band candidate. A headline lane that fired is
//     never vetoed: the headlines already agree.
//     A colon is NOT a subject break. Measured over every pair of the 458
//     distinct replay articles within 48 h (about 100k): with ',' and ':' the veto
//     removed 51 pairs that scored >= 0.40, nearly all of them one story
//     ("TBMM'de kritik hafta: ..." vs "Meclis'te bu hafta: ...", "MHP'den
//     gundem degistirme salvosu: ..." vs "Bahceli, 100 il ..." , "Istanbul'da
//     kritik gorusme: ..." vs "Dolmabahce'de kritik zirve: ..."); with ','
//     alone it removes exactly 5, all Lavrov vs Fidan.
export const SUBJECT_SPAN_MAX_WORDS = 6;
export const SUBJECT_STOP_WORDS = [
  "bakan",
  "bakani",
  "baskan",
  "baskani",
  "cumhurbaskani",
  "disisleri",
  "icisleri",
  "genel",
  "sozcusu",
  "lideri",
  "eski",
  "yardimcisi",
  "milletvekili",
  "valisi",
  "son",
  "dakika",
  "canli",
  "flas",
  "haber",
];
export const SUBJECT_VETO_CAP = MATCH_THRESHOLD * 0.9 - 0.01;

//     (4c) Entity homographs. Eleven whitelist tokens are also ordinary
//     Turkish words: 'Ozel sektor kredileri artti' -> [ozel], 'Adiyaman
//     Kahta'da para tartismasinda iyi bir isci' -> [iyi], 'COP31'e 91 devlet
//     baskani gelecek' -> [gelecek], 'Turk Tip Dunyasi Kurultayi cuma gunu'
//     -> [tip, cuma] (the 20800ac6 / b04edded kurultay clusters of 2026-10-31
//     shared 'tip' on the MoU and the congress speech). With
//     MIN_SHARED_ENTITIES = 1 every such word is a phantom party overlap.
//     ENTITY_AMBIGUOUS tokens are only emitted next to a disambiguator (see
//     entities.ts); ENTITY_PROPER_NOUNS are the ones that are also names, so a
//     capitalised mid-sentence occurrence or an apostrophe suffix ("Ozel'den")
//     is enough. Replay (kurultay group): with the homographs fixed the six
//     congress items that prod had put into the MoU cluster 20800ac6
//     (yeni-safak, haber7, sabah, bir-gazete, haberport, posta) no longer join
//     it; 'tip' from "Turk Tip Dunyasi Kurultayi" was the shared entity.
export const ENTITY_AMBIGUOUS = [
  "ozel",
  "iyi",
  "gelecek",
  "tip",
  "dem",
  "adalet",
  "cuma",
  "spor",
  "saadet",
  "vatan",
  "rum",
];
export const ENTITY_PROPER_NOUNS = [
  "ozel",
  "adalet",
  "cuma",
  "spor",
  "saadet",
  "vatan",
  "rum",
];

//     (4d) Incident province veto (h16-precision-1). Cluster 1e1c5eb0 held two
//     different crashes: the Duzce / Anadolu Otoyolu pile-up (3 yaralı) and a
//     separate Bolu Dagi viaduct crash (2 yaralı, own cluster e43afc1d). Both
//     headlines are 'zincirleme kaza' + an injured count with no subject
//     comma, so (4b) could not fire; the pair scored 0.377 (MinHash 0.38, tfidf
//     0.58 on template tokens, 0 shared entities, headline Jaccard 0.20), Jev
//     returned p=0.70 in the low band and decideMarginal joined it, and the
//     weak joiner then pulled in two more Bolu articles as 'latest'. Jev's own
//     cluster_member shadow task disagreed on all three (p 0.34 / 0.10 / 0.20).
//     Over the last 72 h pair_marginal logged 200 low-band joins, 37 of them at
//     p in [0.70, 0.80). The veto: when the headline lane did not fire, both
//     headlines (clipped to HEADLINE_TITLE_MAX_CHARS) carry an incident word
//     (kaza, yangin, deprem, patlama, cinayet, saldiri, carpisti, devrildi,
//     facia, yarali; see provinces.ts) and each names at least one province
//     (a capitalised word, up to its first apostrophe, equal to one of the 81
//     folded il names), and the two province sets are disjoint, the primary
//     and MinHash lanes are capped at SUBJECT_VETO_CAP -- under the 0.36
//     fallback / Jev floor, so the pair is neither joined nor sent to Jev. A
//     highway ('Anadolu Otoyolu') is not a province, so a side without a
//     province never vetoes; 'Bolu-Duzce' names both and overlaps 'Duzce'.
//     Collateral measured on the 96 h corpus: 0 of 12,380 pairs scoring
//     >= 0.40 are vetoed. No new constant: the cap is SUBJECT_VETO_CAP.

// (5) h12-cluster-3: the headline lane missed same-story pairs. Measured on
//     main fffeff1 with the real headlineLane() (scratchpad ana/pairs.mjs):
//     Bahceli '100 il 1000 ilce ...' vs '19 yeni il ve 78 ilce onerisi'
//     (containment 0.88, blocked by the numeral sets {100,1000} vs {19,78}),
//     Bakirkoy 39b (Jaccard 0.50: belediyesi / Belediyesine, sorusturmada),
//     'Erdogan, Zelenskiy'i kabul etti' vs 'Erdogan Zelenski'yi kabul etti'
//     (3 identical stems, below HEADLINE_LANE_MIN_SHARED) and the live splits
//     f4c68960 / 112a68bd (24 min apart), 71800f1c / 4e57766e,
//     144cfc04 / c5627cb9. 'CANLI | Cumhurbaskani Erdogan konusuyor' reduces
//     to no token at all, so identical live titles of different outlets could
//     never meet.
//
//     Measured on the 458 distinct replay articles (every pair within 48 h,
//     about 100k): the headline-lane changes (headline stemmer, numeral class
//     shift, short identical sets, live title) bring 64 pairs over 0.40 and
//     take none away. 30 of the 64 sit inside one prod cluster, 34 bridge two
//     prod clusters of the same story (the twin splits this item is about).
//     By story: Bakirkoy 39 x24, Zelenski arrival x23, Korea x9, Bulgaria x5,
//     three others. Hand-judged: 63 are the same story; the one doubtful pair
//     is two identical generic titles "Cumhurbaskani Erdogan'dan onemli
//     aciklamalar" 4.6 h apart, a 2-token set once the apostrophe fragment
//     'dan' counts (fragments are kept on purpose: the Sarigul pair needs
//     'den').
//
//     A bare identical set is evidence only when it has a few words: two
//     identical headlines of HEADLINE_SHORT_MIN_TOKENS..HEADLINE_LANE_MIN_SHARED-1
//     tokens join inside the lane window. One identical token never does.
export const HEADLINE_SHORT_MIN_TOKENS = 2;
//     A headline whose every word is boilerplate carries a key (its
//     normalised title); two equal keys within HEADLINE_LIVE_TITLE_MAX_HOURS
//     are the same live broadcast announced by two outlets. Half an hour is a
//     different broadcast with the same name, so the window is tight.
export const HEADLINE_LIVE_TITLE_MAX_HOURS = 10 / 60;
//     Spelling variants of one name, applied to the folded headline token
//     after the generic-prefix check and before stemming.
export const HEADLINE_ALIASES = {
  zelensky: "zelenski",
  zelenskiy: "zelenski",
  zelenskyy: "zelenski",
};

//     The headline lane has its own stemmer (stemHeadlineToken in
//     fingerprint.ts): stemTurkish feeds the persisted TF-IDF and the
//     candidate-token index and must not move, but its locative rule turned
//     'Gazete'de' into 'gaze' and 'Atlanta' into 'atlan' and missed -si / -ne /
//     -ye / -yla (belediyesi / Belediyesine / belediye, mevkidasiyla / mevkidasi).
//     One pass strips each matching suffix at most once, longest first, so
//     "belediyesinde" loses -nde, -si, -ye and -di in one sweep and meets
//     "belediye" and "Belediyesine" at 'bele'. Up to HEADLINE_STEM_MAX_PASSES
//     passes run until nothing changes (a sweep can expose a suffix that sits
//     earlier in the list: toplantilarindan -> toplantilarin -> toplan).
export const HEADLINE_STEM_MAX_PASSES = 3;
