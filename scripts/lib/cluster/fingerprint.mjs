// scripts/lib/cluster/fingerprint.mjs
//
// Turkish-aware text normalization + fingerprinting for near-duplicate
// wire-copy detection (AA / DHA / IHA reshuffle).
//
// This module exposes three tiers of similarity, so the clusterer can
// combine a cheap exact-match gate with a fuzzy structural signal:
//
//   1. strictFingerprint(title, description)
//        SHA-1 over the sorted 4-gram shingle set. Only identical
//        rewrites collide — used by the auto-accept lane.
//
//   2. shingleSet(title, description, n=4)
//        The raw 4-gram shingle Set<string>. Feeds MinHash + Jaccard.
//
//   3. minhashSignature(shingles, k=64) + jaccardFromSignatures(a, b)
//        Classic k=64 MinHash with the universal-hash trick
//        h_i(x) = ((a_i * h(x) + b_i) mod p) mod 2^32.
//        Lets the clusterer score "70 different headlines, same story"
//        without brute-forcing Jaccard over every shingle set.
//
// R2 (duplicate-audit.md §Q5) found fingerprint.mjs:50 was stripping
// digits, over-folding Hukuki Haber's "AYM 2020/2003 başvuru" templates.
// R3 (precision-audit.md §3.4) found the MHP fesh story had 70 distinct
// fingerprints across 71 articles — the shingle SHA-1 was binary and
// every Turkish reword broke it. This rewrite addresses both:
// digits are preserved, and MinHash gives us a Jaccard proxy for soft
// matching at the ensemble layer.
//
// Pure JS, only depends on node:crypto.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// Turkish diacritic fold — lowercase-ish + strip accents. We fold dotted
// capital İ to "i" and dotless ı to "i" on purpose: the canonical form
// should be insensitive to dot/dotless confusion between publishers.
const DIACRITIC_MAP = {
  ş: "s", Ş: "s",
  ı: "i", İ: "i", I: "i",
  ü: "u", Ü: "u",
  ö: "o", Ö: "o",
  ç: "c", Ç: "c",
  ğ: "g", Ğ: "g",
  â: "a", Â: "a",
  î: "i", Î: "i",
  û: "u", Û: "u",
};

// Very common Turkish stop words — don't discriminate between stories.
// Kept small and domain-aware. "son dakika" / "haber(ler)" filed here
// because they are boilerplate across sources.
const STOP_WORDS = new Set([
  "ve", "ile", "bir", "bu", "da", "de", "ki", "mi", "mı", "mu", "mü",
  "o", "ne", "için", "icin", "ama", "fakat", "ancak", "ya", "ya da",
  "ise", "gibi", "kadar", "daha", "çok", "cok", "az", "en", "her",
  "hiç", "hic", "bazı", "bazi", "olan", "olarak", "var", "yok",
  "oldu", "olduğu", "oldugu", "olan", "olması", "olmasi",
  "değil", "degil", "şu", "su", "o", "ben", "sen", "biz", "siz",
  "onlar", "şey", "sey", "yine", "de", "da", "te", "ta",
  "son", "dakika", "haber", "haberler",
]);

/**
 * Lower-case, diacritic-fold, strip punctuation, drop stop words,
 * collapse whitespace. Digits ARE preserved (R2 finding: Hukuki Haber
 * "AYM 2020/2003" vs "AYM 2021/63800" were collapsing when digits were
 * stripped). Output is a canonical token string, space-separated.
 *
 * Exported so the entity extractor (D2) can reuse the same canonical
 * form for whitelist matching.
 */
export function normalizeTurkish(text) {
  if (!text) return "";
  let out = "";
  for (const ch of text) {
    out += DIACRITIC_MAP[ch] ?? ch;
  }
  out = out.toLowerCase();
  // Keep a-z, 0-9, and whitespace. Punctuation (including /, ', -) becomes
  // a space so "2020/2003" → "2020 2003" (two tokens, still discriminating).
  out = out.replace(/[^a-z0-9\s]/g, " ");
  // Tokenize, drop stop words. Keep single-digit tokens (years/numbers
  // sometimes abbreviate) but drop single-char alpha tokens (noise).
  const tokens = out
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => {
      if (!t) return false;
      if (STOP_WORDS.has(t)) return false;
      // Drop single-character alpha tokens; keep digit runs of any length.
      if (t.length < 2 && !/^\d$/.test(t)) return false;
      return true;
    });
  return tokens.join(" ");
}

// ---------------------------------------------------------------------------
// Turkish suffix stripping (for TF-IDF only — NOT used by fingerprinting)
// ---------------------------------------------------------------------------
//
// Turkish is agglutinative: "mecliste", "meclisten", "meclisin" are all
// "meclis" but without stemming they produce 3 distinct TF-IDF tokens,
// reducing cosine similarity between paraphrased articles about the same
// topic. This conservative stemmer strips the most common *nominal*
// suffixes (plural, case, genitive) to conflate surface forms.
//
// Design choices:
//   - Longest suffix first so compound suffixes match before their
//     components ("bakanlardan" → strip "lardan" → "bakan", not "lar" →
//     "bakandan").
//   - Minimum stem length of 3 (or 4 for 2-char suffixes) to prevent
//     over-stemming short words (e.g. "dolar" stays "dolar", not "do").
//   - Only nominal suffixes — no verb morphology (too noisy for bag-of-words).
//   - Exported separately from normalizeTurkish() so fingerprinting stays
//     unchanged; only imported by tfidf.mjs.

export function stemTurkish(token) {
  if (!token || token.length <= 4 || /^\d+$/.test(token)) return token;
  // [suffix, minStemLength] pairs ordered longest-first.
  const rules = [
    // 6-char: plural + ablative
    ["lerden", 3], ["lardan", 3],
    // 5-char: plural + locative / genitive
    ["lerde", 3], ["larda", 3], ["lerin", 3], ["larin", 3],
    // 4-char: plural + accusative / dative
    ["leri", 3], ["lari", 3], ["lere", 3], ["lara", 3],
    // 3-char: plural
    ["ler", 3], ["lar", 3],
    // 3-char: ablative
    ["dan", 3], ["den", 3], ["tan", 3], ["ten", 3],
    // 3-char: genitive (buffer-n forms)
    ["nin", 3], ["nun", 3],
    // 3-char: locative (buffer-n forms)
    ["nda", 3], ["nde", 3],
    // 2-char: locative (stricter min stem to avoid false conflation)
    ["da", 4], ["de", 4], ["ta", 4], ["te", 4],
  ];
  for (const [suf, minStem] of rules) {
    if (token.endsWith(suf) && (token.length - suf.length) >= minStem) {
      return token.slice(0, -suf.length);
    }
  }
  return token;
}

// ---------------------------------------------------------------------------
// Shingling
// ---------------------------------------------------------------------------

/**
 * Returns the raw n-gram shingle set over the normalized title+description.
 * Shingles are **character** n-grams (default n=4) over the space-joined
 * token stream. Character-level was chosen over word-level after R3's
 * audit: Turkish headlines are short (5–10 tokens), so word 4-grams
 * barely overlap between rewrites ("feshetti" vs "fesh etti" shares 1
 * word 4-gram but 30+ character 4-grams). Character n-grams give the
 * soft-matching signal that the MHP-fesh cluster needs to recover.
 *
 * Returns an empty set for empty input, and a single-element set
 * containing the full canonical string for inputs shorter than n chars.
 */

/**
 * Candidate-generation tokens for a headline: normalized, stemmed, digits
 * and short tokens dropped. Used by the cluster consumer's inverted index so
 * two outlets covering the same story can meet even when neither headline
 * contains a whitelisted entity.
 */
export function titleTokens(title, minLen = 4) {
  const out = new Set();
  for (const tok of normalizeTurkish(title).split(" ")) {
    if (tok.length < minLen || /^d+$/.test(tok)) continue;
    out.add(stemTurkish(tok));
  }
  return out;
}

export function shingleSet(title, description, n = 4) {
  const norm = normalizeTurkish(`${title || ""} ${description || ""}`);
  const shingles = new Set();
  if (!norm) return shingles;
  if (norm.length < n) {
    shingles.add(norm);
    return shingles;
  }
  for (let i = 0; i <= norm.length - n; i++) {
    shingles.add(norm.slice(i, i + n));
  }
  return shingles;
}

// ---------------------------------------------------------------------------
// Strict fingerprint — used by the auto-accept lane
// ---------------------------------------------------------------------------

/**
 * Stable SHA-1 hash of the sorted unique 4-gram shingle set. Two articles
 * that share every character shingle will hash identically (auto-accept);
 * any reword that introduces or drops a single 4-char substring will
 * diverge. This is the direct successor to the old `fingerprint()` —
 * same purpose, digit-preserving (R2), now over character shingles to
 * keep the strict and soft tiers aligned on the same token space.
 */
export function strictFingerprint(title, description) {
  const norm = normalizeTurkish(`${title || ""} ${description || ""}`);
  if (!norm) return null;
  const shingles = shingleSet(title, description, 4);
  if (shingles.size === 0) return sha1(norm);
  const sorted = [...shingles].sort().join("|");
  return sha1(sorted);
}

function sha1(s) {
  return createHash("sha1").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// MinHash signature — used for soft Jaccard similarity
// ---------------------------------------------------------------------------

// Mersenne prime 2^31 - 1 = 2147483647. Fits in a signed 32-bit int, which
// makes the modular arithmetic safe inside JavaScript's 53-bit Number
// without needing BigInt in the hot loop.
const MINHASH_PRIME = 2147483647;
// 2^32, for the final outer mod. Used with unsigned 32-bit arithmetic.
const MINHASH_MOD = 0x1_0000_0000;

/**
 * Deterministic 32-bit base hash of a shingle string. We take the first
 * 4 bytes of sha256 and read them as an unsigned 32-bit big-endian int.
 * Collisions are vanishingly rare at the shingle population sizes we
 * care about (dozens to low thousands per article).
 */
function baseHash32(s) {
  const buf = createHash("sha256").update(s).digest();
  // buf[0..3] as uint32 big-endian.
  return (
    (buf[0] * 0x1000000) +
    (buf[1] << 16 >>> 0) +
    (buf[2] << 8) +
    buf[3]
  ) >>> 0;
}

/**
 * Deterministic per-index coefficient for the universal hash family.
 * Seeds `a_i` and `b_i` from `i` so the same index always yields the
 * same pair — signatures are comparable across processes. `a_i` must be
 * non-zero mod p to stay a valid universal-hash coefficient.
 */
function minhashCoeffs(k) {
  const A = new Uint32Array(k);
  const B = new Uint32Array(k);
  for (let i = 0; i < k; i++) {
    // Hash "a:<i>" and "b:<i>" for independent streams.
    A[i] = (baseHash32(`a:${i}`) % (MINHASH_PRIME - 1)) + 1; // ∈ [1, p-1]
    B[i] = baseHash32(`b:${i}`) % MINHASH_PRIME;             // ∈ [0, p-1]
  }
  return { A, B };
}

// Coefficient cache keyed by k — regenerating per-call is wasteful.
const COEFF_CACHE = new Map();
function getCoeffs(k) {
  let c = COEFF_CACHE.get(k);
  if (!c) {
    c = minhashCoeffs(k);
    COEFF_CACHE.set(k, c);
  }
  return c;
}

/**
 * Classic MinHash. For each of k hash functions `i`, compute
 * `h_i(x) = ((a_i * h(x) + b_i) mod p) mod 2^32` for every shingle x
 * in the set and keep the minimum. Returns a Uint32Array(k).
 *
 * Empty shingle sets yield a signature of all 0xFFFFFFFF (max uint32),
 * so two empty signatures trivially report Jaccard=1.0. Callers should
 * treat empty-set signatures as "not comparable".
 */
export function minhashSignature(shingles, k = 64) {
  const sig = new Uint32Array(k);
  sig.fill(0xFFFFFFFF);
  if (!shingles || shingles.size === 0) return sig;

  const { A, B } = getCoeffs(k);

  for (const sh of shingles) {
    const h = baseHash32(sh);
    for (let i = 0; i < k; i++) {
      // Use Math.imul + additions carefully: a_i can be ~2^31 and h can
      // be ~2^32, so we stay in floating-point (a * h fits in 2^63,
      // which is > 2^53 — so we split with Math.floor + % p).
      // a_i ∈ [1, p-1] < 2^31, h ∈ [0, 2^32). Product fits in 2^63.
      // JS Number can exactly represent integers up to 2^53, so we can't
      // multiply directly. Reduce h mod p first so both operands are < 2^31.
      const hp = h % MINHASH_PRIME;            // < 2^31
      const mixed = (A[i] * hp + B[i]) % MINHASH_PRIME; // < 2^31, exact
      const v = mixed % MINHASH_MOD;           // < 2^32 (always here)
      if (v < sig[i]) sig[i] = v;
    }
  }
  return sig;
}

/**
 * Estimates Jaccard similarity of two shingle sets from their MinHash
 * signatures. The classic result: for each index i,
 * Pr[sigA[i] === sigB[i]] = J(A, B). Averaging over k slots gives an
 * unbiased estimate with std dev ~1/sqrt(k) (~12.5% at k=64).
 */
export function jaccardFromSignatures(sigA, sigB) {
  if (!sigA || !sigB) return 0;
  const k = Math.min(sigA.length, sigB.length);
  if (k === 0) return 0;
  let matches = 0;
  for (let i = 0; i < k; i++) {
    if (sigA[i] === sigB[i]) matches++;
  }
  return matches / k;
}

// ---------------------------------------------------------------------------
// Bundled one-shot helper
// ---------------------------------------------------------------------------

/**
 * Computes all three tiers in one pass — used by cluster-worker.mjs so
 * a single article only tokenizes + shingles once per ingest.
 *
 * Returns:
 *   strict    — SHA-1 string, or null for empty input
 *   shingles  — Set<string> of 4-gram shingles
 *   signature — Uint32Array(64) MinHash
 */
export function fingerprint(title, description) {
  const shingles = shingleSet(title, description, 4);
  return {
    strict: strictFingerprint(title, description),
    shingles,
    signature: minhashSignature(shingles, 64),
  };
}

// ---------------------------------------------------------------------------
// Self-test (run `node scripts/lib/cluster/fingerprint.mjs`)
// ---------------------------------------------------------------------------

if (process.argv[1] === import.meta.url.replace("file://", "")) {
  let failed = 0;
  const assert = (cond, msg) => {
    if (!cond) {
      console.error("FAIL -", msg);
      failed++;
      return;
    }
    console.log("ok   -", msg);
  };

  // Test 1: strict fingerprint of MHP-fesh rewrites should differ
  // (same story, slightly different wording — R3's structural-recall bug).
  const mhpA = "MHP İstanbul'da il teşkilatını feshetti";
  const mhpB = "MHP İstanbul il teşkilatını fesh etti";
  const strictA = strictFingerprint(mhpA, "");
  const strictB = strictFingerprint(mhpB, "");
  assert(
    strictA !== null && strictB !== null && strictA !== strictB,
    `MHP rewrites have different strict fingerprints (${strictA?.slice(0, 8)} vs ${strictB?.slice(0, 8)})`
  );

  // Test 2: MinHash-estimated Jaccard of the two MHP rewrites ≥ 0.6.
  const shA = shingleSet(mhpA, "");
  const shB = shingleSet(mhpB, "");
  const sigMhpA = minhashSignature(shA, 64);
  const sigMhpB = minhashSignature(shB, 64);
  const jaccardMhp = jaccardFromSignatures(sigMhpA, sigMhpB);
  assert(
    jaccardMhp >= 0.6,
    `MHP rewrite Jaccard ≥ 0.6 (actual: ${jaccardMhp.toFixed(3)})`
  );

  // Test 3: completely different stories should score well below 0.15.
  const erdogan = "Erdoğan Almanya'yı ziyaret edecek";
  const mb = "Merkez Bankası faiz kararını açıkladı";
  const sigE = minhashSignature(shingleSet(erdogan, ""), 64);
  const sigM = minhashSignature(shingleSet(mb, ""), 64);
  const jaccardDiff = jaccardFromSignatures(sigE, sigM);
  assert(
    jaccardDiff < 0.15,
    `Unrelated-stories Jaccard < 0.15 (actual: ${jaccardDiff.toFixed(3)})`
  );

  // Test 4: strict fingerprint must differ on "2020 yılında" vs "2024 yılında"
  // (R2 finding — digit preservation). Since neither is ≥4 tokens we take
  // the < 3 tokens branch inside strictFingerprint; but after normalization
  // both are 2 tokens so they hash the canonical string, which now differs.
  const year20 = strictFingerprint("2020 yılında", "");
  const year24 = strictFingerprint("2024 yılında", "");
  assert(
    year20 !== null && year24 !== null && year20 !== year24,
    `Digit-preserving strict fingerprint differs (${year20?.slice(0, 8)} vs ${year24?.slice(0, 8)})`
  );

  // Sanity: bundled fingerprint() returns all three components.
  const bundle = fingerprint(mhpA, "");
  assert(
    typeof bundle.strict === "string" &&
      bundle.shingles instanceof Set &&
      bundle.signature instanceof Uint32Array &&
      bundle.signature.length === 64,
    "fingerprint() bundles { strict, shingles, signature:Uint32Array(64) }"
  );

  // Print signature size in bytes (64 * 4 = 256) and jaccard scores, for
  // the report.
  const sigBytes = bundle.signature.byteLength;
  console.log(
    `\nsignature size: ${sigBytes} bytes (${bundle.signature.length} × uint32)`
  );
  console.log(`MHP-rewrite Jaccard   : ${jaccardMhp.toFixed(3)}`);
  console.log(`unrelated Jaccard     : ${jaccardDiff.toFixed(3)}`);

  if (failed > 0) {
    console.error(`\n${failed} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nfingerprint.mjs OK — all tests PASSED");
  process.exit(0);
}
