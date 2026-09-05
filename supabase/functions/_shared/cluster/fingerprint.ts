// supabase/functions/_shared/cluster/fingerprint.ts
//
// Turkish-aware text normalization + fingerprinting for near-duplicate
// wire-copy detection. Ported from `scripts/lib/cluster/fingerprint.mjs`.
//
// Three tiers of similarity:
//   1. strictFingerprint(title, description)  — SHA-1 over sorted 4-gram set
//   2. shingleSet(title, description, n=4)     — raw character n-gram Set
//   3. minhashSignature(shingles, k=64) + jaccardFromSignatures(a, b)
//
// Deno notes:
//   - `node:crypto` is supported in Deno 2.x (via `npm:`/`node:` compat).
//     We use it for `createHash('sha1'|'sha256').update(...).digest()` so the
//     hot MinHash loop stays synchronous (Web Crypto's `subtle.digest` is
//     async-only and would force a per-shingle `await`, ballooning latency).
//   - We work with `Uint8Array` buffers throughout so the byte indexing
//     used by `baseHash32` is portable between Node and Deno.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const DIACRITIC_MAP: Record<string, string> = {
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

const STOP_WORDS: Set<string> = new Set([
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
 * Lower-case, diacritic-fold, strip punctuation, drop stop words, collapse
 * whitespace. Digits ARE preserved (R2 finding). Output is a canonical
 * space-separated token string.
 */
export function normalizeTurkish(text: string | null | undefined): string {
  if (!text) return "";
  let out = "";
  for (const ch of text) {
    out += DIACRITIC_MAP[ch] ?? ch;
  }
  out = out.toLowerCase();
  out = out.replace(/[^a-z0-9\s]/g, " ");
  const tokens = out
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => {
      if (!t) return false;
      if (STOP_WORDS.has(t)) return false;
      if (t.length < 2 && !/^\d$/.test(t)) return false;
      return true;
    });
  return tokens.join(" ");
}

// ---------------------------------------------------------------------------
// Turkish suffix stripping (used by TF-IDF only)
// ---------------------------------------------------------------------------

export function stemTurkish(token: string): string {
  if (!token || token.length <= 4 || /^\d+$/.test(token)) return token;
  const rules: Array<[string, number]> = [
    ["lerden", 3], ["lardan", 3],
    ["lerde", 3], ["larda", 3], ["lerin", 3], ["larin", 3],
    ["leri", 3], ["lari", 3], ["lere", 3], ["lara", 3],
    ["ler", 3], ["lar", 3],
    ["dan", 3], ["den", 3], ["tan", 3], ["ten", 3],
    ["nin", 3], ["nun", 3],
    ["nda", 3], ["nde", 3],
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
 * Candidate-generation tokens for a headline: normalized, stemmed, digits
 * and short tokens dropped. Used by the cluster consumer's inverted index so
 * two outlets covering the same story can meet even when neither headline
 * contains a whitelisted entity.
 */
export function titleTokens(title: string | null | undefined, minLen = 4): Set<string> {
  const out = new Set<string>();
  for (const tok of normalizeTurkish(title).split(" ")) {
    if (tok.length < minLen || /^d+$/.test(tok)) continue;
    out.add(stemTurkish(tok));
  }
  return out;
}

export function shingleSet(
  title: string | null | undefined,
  description: string | null | undefined,
  n = 4,
): Set<string> {
  const norm = normalizeTurkish(`${title || ""} ${description || ""}`);
  const shingles = new Set<string>();
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
// Strict fingerprint — sha1 of sorted unique 4-gram shingles
// ---------------------------------------------------------------------------

export function strictFingerprint(
  title: string | null | undefined,
  description: string | null | undefined,
): string | null {
  const norm = normalizeTurkish(`${title || ""} ${description || ""}`);
  if (!norm) return null;
  const shingles = shingleSet(title, description, 4);
  if (shingles.size === 0) return sha1(norm);
  const sorted = [...shingles].sort().join("|");
  return sha1(sorted);
}

/**
 * SHA-1 hex digest of the input string. Exported so other modules (e.g.
 * `_shared/rss/normalize.ts`) can derive a 40-char fingerprint from arbitrary
 * bytes (such as a URL) and satisfy the `articles.content_hash` CHECK
 * constraint when the shingle-based fingerprint is unavailable. Implementation
 * is byte-equivalent to the hashing used by `strictFingerprint`.
 */
export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// MinHash signature
// ---------------------------------------------------------------------------

const MINHASH_PRIME = 2147483647;            // 2^31 - 1
const MINHASH_MOD = 0x1_0000_0000;           // 2^32

/**
 * Deterministic 32-bit base hash of a shingle string: first 4 bytes of
 * sha256 read as an unsigned 32-bit big-endian int.
 */
function baseHash32(s: string): number {
  // createHash().digest() returns a Node Buffer in Node and a Uint8Array-like
  // in Deno's node:crypto shim. Both expose indexed byte access, so we
  // coerce via `Uint8Array.from(...)` to make the typing portable.
  const buf = Uint8Array.from(
    createHash("sha256").update(s).digest() as unknown as ArrayLike<number>,
  );
  return (
    (buf[0] * 0x1000000) +
    ((buf[1] << 16) >>> 0) +
    (buf[2] << 8) +
    buf[3]
  ) >>> 0;
}

interface Coeffs {
  A: Uint32Array;
  B: Uint32Array;
}

function minhashCoeffs(k: number): Coeffs {
  const A = new Uint32Array(k);
  const B = new Uint32Array(k);
  for (let i = 0; i < k; i++) {
    A[i] = (baseHash32(`a:${i}`) % (MINHASH_PRIME - 1)) + 1;
    B[i] = baseHash32(`b:${i}`) % MINHASH_PRIME;
  }
  return { A, B };
}

const COEFF_CACHE = new Map<number, Coeffs>();
function getCoeffs(k: number): Coeffs {
  let c = COEFF_CACHE.get(k);
  if (!c) {
    c = minhashCoeffs(k);
    COEFF_CACHE.set(k, c);
  }
  return c;
}

/**
 * Classic MinHash. Empty shingle sets yield a signature of all 0xFFFFFFFF;
 * callers should treat those as "not comparable" rather than identical.
 */
export function minhashSignature(
  shingles: Set<string> | null | undefined,
  k = 64,
): Uint32Array {
  const sig = new Uint32Array(k);
  sig.fill(0xFFFFFFFF);
  if (!shingles || shingles.size === 0) return sig;

  const { A, B } = getCoeffs(k);

  for (const sh of shingles) {
    const h = baseHash32(sh);
    for (let i = 0; i < k; i++) {
      const hp = h % MINHASH_PRIME;
      const mixed = (A[i] * hp + B[i]) % MINHASH_PRIME;
      const v = mixed % MINHASH_MOD;
      if (v < sig[i]) sig[i] = v;
    }
  }
  return sig;
}

/**
 * Estimates Jaccard similarity from two MinHash signatures.
 */
export function jaccardFromSignatures(
  sigA: Uint32Array | null | undefined,
  sigB: Uint32Array | null | undefined,
): number {
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

export interface FingerprintBundle {
  strict: string | null;
  shingles: Set<string>;
  signature: Uint32Array;
}

export function fingerprint(
  title: string | null | undefined,
  description: string | null | undefined,
): FingerprintBundle {
  const shingles = shingleSet(title, description, 4);
  return {
    strict: strictFingerprint(title, description),
    shingles,
    signature: minhashSignature(shingles, 64),
  };
}
