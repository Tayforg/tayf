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
