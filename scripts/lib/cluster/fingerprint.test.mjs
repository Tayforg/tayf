import { describe, it, expect } from "vitest";
import {
  normalizeTurkish,
  stemTurkish,
  shingleSet,
  strictFingerprint,
  minhashSignature,
  jaccardFromSignatures,
  fingerprint,
  MINHASH_VERSION,
  serializeSignature,
  deserializeSignature,
} from "./fingerprint.mjs";
import { MINHASH_SIG_K } from "./constants.mjs";

describe("normalizeTurkish", () => {
  it("returns empty string for empty or nullish input", () => {
    expect(normalizeTurkish("")).toBe("");
    expect(normalizeTurkish(null)).toBe("");
    expect(normalizeTurkish(undefined)).toBe("");
  });

  it("folds Turkish diacritics to ASCII", () => {
    // "İstanbul şehri" → "istanbul sehri" (punctuation stripped, diacritics folded).
    // "bir" is a stop word and should be dropped.
    expect(normalizeTurkish("İstanbul şehri bir güzel")).toBe("istanbul sehri guzel");
  });

  it("lower-cases the output", () => {
    expect(normalizeTurkish("ERDOGAN")).toBe("erdogan");
  });

  it("preserves digits including multi-digit runs (R2 fix)", () => {
    // R2: "AYM 2020/2003" must NOT collapse to "aym 2003" — digits survive,
    // and "/" becomes a space so both numbers stay as distinct tokens.
    expect(normalizeTurkish("AYM 2020/2003")).toBe("aym 2020 2003");
  });

  it("drops Turkish stop words", () => {
    // "ve", "bir", "bu" are all in STOP_WORDS.
    expect(normalizeTurkish("ve bir bu erdogan")).toBe("erdogan");
  });

  it("drops single-character alpha tokens but keeps single-digit tokens", () => {
    // "a" is single-char alpha (dropped). "3" is a single-digit token (kept).
    // "ab" is 2-char alpha (kept). "abc" (kept).
    expect(normalizeTurkish("a ab abc 3")).toBe("ab abc 3");
  });

  it("collapses punctuation to whitespace", () => {
    expect(normalizeTurkish("merkez-bankasi, faiz!")).toBe("merkez bankasi faiz");
  });

  it("treats dotted İ and dotless ı as both i (deliberate fold)", () => {
    // Canonical form is insensitive to dot/dotless confusion across publishers.
    expect(normalizeTurkish("İI ıi")).toBe("ii ii");
  });

  it("folds the news-boilerplate stop phrase 'son dakika haber'", () => {
    // "son", "dakika", "haber" are all explicit stop words.
    expect(normalizeTurkish("son dakika haber erdogan")).toBe("erdogan");
  });
});

describe("stemTurkish", () => {
  it("returns the token unchanged for short tokens (<= 4 chars)", () => {
    expect(stemTurkish("ab")).toBe("ab");
    expect(stemTurkish("abcd")).toBe("abcd");
  });

  it("returns numeric tokens unchanged", () => {
    expect(stemTurkish("2020")).toBe("2020");
    expect(stemTurkish("12345")).toBe("12345");
  });

  it("returns empty/nullish unchanged", () => {
    expect(stemTurkish("")).toBe("");
    expect(stemTurkish(null)).toBe(null);
    expect(stemTurkish(undefined)).toBe(undefined);
  });

  it("strips the longest matching suffix first (compound first)", () => {
    // "bakanlardan" → should strip "lardan" (6-char compound) not "lar" (3-char).
    expect(stemTurkish("bakanlardan")).toBe("bakan");
  });

  it("strips common plural suffixes", () => {
    // length-5 token "evler" → stripping "ler" leaves "ev" (< minStem 3), so NOT stripped.
    // The token is also length <= 4? No, 5 chars — but the early length guard is <= 4,
    // so "evler" passes that guard. Stem-length guard (minStem=3) then protects it.
    expect(stemTurkish("evler")).toBe("evler");
    // "kitaplar" (8 chars) → stripping "lar" leaves "kitap" (5 chars, >= 3) → stripped.
    expect(stemTurkish("kitaplar")).toBe("kitap");
    // "sebzeler" (8) → stripping "ler" leaves "sebze" (5, >= 3) → stripped.
    expect(stemTurkish("sebzeler")).toBe("sebze");
  });

  it("strips locative suffixes when min stem length is met", () => {
    expect(stemTurkish("mecliste")).toBe("meclis");
    expect(stemTurkish("meclisten")).toBe("meclis");
  });

  it("strips genitive/ablative forms", () => {
    expect(stemTurkish("parktan")).toBe("park");
    expect(stemTurkish("evinden")).toBe("evin"); // evin + den (>= 3)
  });

  it("leaves short stems alone to avoid over-stemming", () => {
    // "dolar" ends in "lar" but length-3 stem = "do" which is below minStem 3.
    // Wait: "dolar" has length 5, stripping "lar" leaves "do" (length 2) which
    // is < minStem 3, so "lar" should NOT be stripped.
    expect(stemTurkish("dolar")).toBe("dolar");
  });

  it("conflates surface forms of the same stem (meclis family)", () => {
    // All three Turkish surface forms of "meclis" should reduce to "meclis".
    expect(stemTurkish("mecliste")).toBe(stemTurkish("meclisten"));
    expect(stemTurkish("meclisten")).toBe("meclis");
  });
});

describe("shingleSet", () => {
  it("returns an empty set for empty input", () => {
    expect(shingleSet("", "").size).toBe(0);
    expect(shingleSet(null, undefined).size).toBe(0);
  });

  it("returns a single-element set when input is shorter than n", () => {
    // Normalized "ab" has length 2, n=4 → falls into the short-input branch.
    const s = shingleSet("ab", "");
    expect(s.size).toBe(1);
    expect(s.has("ab")).toBe(true);
  });

  it("produces the correct number of 4-gram shingles over normalized text", () => {
    // "hello" (normalized "hello", 5 chars) → 4-grams: "hell", "ello" → 2 shingles.
    // But stop-word filter and min-token filter may interact — let's use a safe
    // lowercase ASCII input with no stop words.
    const shingles = shingleSet("hello", "");
    // Normalized = "hello" (5 chars, no stop word). 4-grams = 5 - 4 + 1 = 2.
    expect(shingles.size).toBe(2);
    expect(shingles.has("hell")).toBe(true);
    expect(shingles.has("ello")).toBe(true);
  });

  it("includes shingles from both title and description", () => {
    // Title + " " + description → "abcd efgh" normalized.
    // Normalization drops stop words, but "abcd" and "efgh" are not stop words.
    const s = shingleSet("abcd", "efgh");
    // Normalized: "abcd efgh" (9 chars). 4-grams = 6.
    expect(s.size).toBe(6);
    expect(s.has("abcd")).toBe(true);
    expect(s.has("efgh")).toBe(true);
  });

  it("respects custom n parameter", () => {
    // "abcdef" (6 chars), n=3 → 3-grams: abc, bcd, cde, def → 4 shingles.
    const s = shingleSet("abcdef", "", 3);
    expect(s.size).toBe(4);
    expect(s.has("abc")).toBe(true);
    expect(s.has("def")).toBe(true);
  });

  it("dedupes repeated n-grams", () => {
    // "abab abab" normalized: "abab abab" (9 chars).
    // 4-grams: "abab", "bab ", "ab a", "b ab", " aba", "abab"
    // Duplicates ("abab") collapse in the Set.
    const s = shingleSet("abab abab", "");
    // At least the 4-gram "abab" appears twice but Set dedupes.
    expect(s.has("abab")).toBe(true);
    // Total unique shingles < total positions.
    expect(s.size).toBeLessThan(9 - 4 + 1 + 1);
  });
});

describe("strictFingerprint", () => {
  it("returns null for empty input", () => {
    expect(strictFingerprint("", "")).toBe(null);
    expect(strictFingerprint(null, null)).toBe(null);
  });

  it("returns a stable SHA-1 hex string for non-empty input", () => {
    const fp = strictFingerprint("Erdogan konustu", "");
    expect(typeof fp).toBe("string");
    expect(fp).toMatch(/^[a-f0-9]{40}$/); // 40-hex SHA-1.
  });

  it("is deterministic — same input yields same fingerprint", () => {
    const a = strictFingerprint("Merkez Bankasi faiz", "karari");
    const b = strictFingerprint("Merkez Bankasi faiz", "karari");
    expect(a).toBe(b);
  });

  it("distinguishes digit-variant inputs (R2: 2020 vs 2024)", () => {
    const y20 = strictFingerprint("2020 yilinda olay", "");
    const y24 = strictFingerprint("2024 yilinda olay", "");
    expect(y20).not.toBe(y24);
  });

  it("identical wire copy has identical strict fingerprints", () => {
    const title = "Cumhurbaskani Erdogan kabine toplantisi sonrasi aciklama yapti";
    const desc = "Cumhurbaskani bugun ankara da konustu";
    const a = strictFingerprint(title, desc);
    const b = strictFingerprint(title, desc);
    expect(a).toBe(b);
    expect(a).not.toBe(null);
  });

  it("differs for rewrites with different characters (MHP-fesh class)", () => {
    // "feshetti" vs "fesh etti" differ by one space → 4-gram shingle sets
    // overlap substantially but are not identical → different SHA-1.
    const a = strictFingerprint("MHP istanbul feshetti", "");
    const b = strictFingerprint("MHP istanbul fesh etti", "");
    expect(a).not.toBe(b);
  });
});

describe("minhashSignature", () => {
  it("returns a Uint32Array of length k", () => {
    const shingles = new Set(["abcd", "bcde", "cdef"]);
    const sig = minhashSignature(shingles, 64);
    expect(sig).toBeInstanceOf(Uint32Array);
    expect(sig.length).toBe(64);
  });

  it("honors custom k", () => {
    const shingles = new Set(["abcd"]);
    const sig = minhashSignature(shingles, 16);
    expect(sig.length).toBe(16);
  });

  it("fills with 0xFFFFFFFF for empty shingle set", () => {
    const sig = minhashSignature(new Set(), 8);
    for (let i = 0; i < 8; i++) {
      expect(sig[i]).toBe(0xffffffff);
    }
  });

  it("fills with 0xFFFFFFFF for nullish shingles", () => {
    const sig = minhashSignature(null, 4);
    expect(sig.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(sig[i]).toBe(0xffffffff);
    }
  });

  it("is deterministic for identical inputs (same index coefficients)", () => {
    const shA = new Set(["abcd", "bcde", "cdef"]);
    const shB = new Set(["abcd", "bcde", "cdef"]);
    const sigA = minhashSignature(shA, 32);
    const sigB = minhashSignature(shB, 32);
    for (let i = 0; i < 32; i++) {
      expect(sigA[i]).toBe(sigB[i]);
    }
  });

  it("writes non-sentinel values for non-empty input", () => {
    const sig = minhashSignature(new Set(["abcd"]), 8);
    // At least one slot must be less than 0xFFFFFFFF (the initial fill).
    let anyLess = false;
    for (let i = 0; i < 8; i++) {
      if (sig[i] < 0xffffffff) {
        anyLess = true;
        break;
      }
    }
    expect(anyLess).toBe(true);
  });
});

describe("jaccardFromSignatures", () => {
  it("returns 0 for nullish inputs", () => {
    expect(jaccardFromSignatures(null, new Uint32Array(4))).toBe(0);
    expect(jaccardFromSignatures(new Uint32Array(4), null)).toBe(0);
  });

  it("returns 0 when either signature has length 0", () => {
    expect(jaccardFromSignatures(new Uint32Array(0), new Uint32Array(4))).toBe(0);
  });

  it("returns 1.0 for identical signatures (MinHash collision ceiling)", () => {
    const sig = new Uint32Array(8);
    for (let i = 0; i < 8; i++) sig[i] = 1000 + i;
    expect(jaccardFromSignatures(sig, sig)).toBe(1.0);
  });

  it("returns 0.0 for fully-disjoint signatures", () => {
    const a = new Uint32Array(8);
    const b = new Uint32Array(8);
    for (let i = 0; i < 8; i++) {
      a[i] = 1000 + i;
      b[i] = 2000 + i;
    }
    expect(jaccardFromSignatures(a, b)).toBe(0);
  });

  it("matches the hand-computed fraction of matching slots", () => {
    // 3 of 8 slots match → Jaccard estimate = 0.375 exactly.
    const a = new Uint32Array(8);
    const b = new Uint32Array(8);
    for (let i = 0; i < 8; i++) {
      a[i] = i;
      b[i] = i < 3 ? i : 100 + i;
    }
    expect(jaccardFromSignatures(a, b)).toBe(3 / 8);
  });

  it("uses the shorter length when signatures differ in size", () => {
    const a = new Uint32Array(16);
    const b = new Uint32Array(4);
    for (let i = 0; i < 16; i++) a[i] = i;
    for (let i = 0; i < 4; i++) b[i] = i; // All 4 slots match.
    // min(|a|, |b|) = 4, all 4 match → 1.0
    expect(jaccardFromSignatures(a, b)).toBe(1.0);
  });

  it("estimates high Jaccard for paraphrases (MHP-fesh class)", () => {
    // Near-duplicate Turkish rewrites should estimate Jaccard >= 0.5.
    const a = "MHP Istanbul'da il teskilatini feshetti";
    const b = "MHP Istanbul il teskilatini fesh etti";
    const sigA = minhashSignature(shingleSet(a, ""), 64);
    const sigB = minhashSignature(shingleSet(b, ""), 64);
    const j = jaccardFromSignatures(sigA, sigB);
    expect(j).toBeGreaterThanOrEqual(0.5);
  });

  it("estimates low Jaccard for unrelated stories", () => {
    const a = "Erdogan Almanya'yi ziyaret edecek";
    const b = "Merkez Bankasi faiz kararini acikladi";
    const sigA = minhashSignature(shingleSet(a, ""), 64);
    const sigB = minhashSignature(shingleSet(b, ""), 64);
    const j = jaccardFromSignatures(sigA, sigB);
    expect(j).toBeLessThan(0.15);
  });
});

describe("fingerprint (bundled)", () => {
  it("returns all three tiers", () => {
    const b = fingerprint("Erdogan konustu", "kabine toplantisi");
    expect(typeof b.strict).toBe("string");
    expect(b.shingles).toBeInstanceOf(Set);
    expect(b.signature).toBeInstanceOf(Uint32Array);
    expect(b.signature.length).toBe(64);
  });

  it("returns null strict and empty shingles/signature for empty input", () => {
    const b = fingerprint("", "");
    expect(b.strict).toBe(null);
    expect(b.shingles.size).toBe(0);
    // Empty shingles → sentinel-filled signature.
    expect(b.signature[0]).toBe(0xffffffff);
  });

  it("produces consistent tiers across calls", () => {
    const a = fingerprint("Merkez Bankasi faiz karari", "aciklandi");
    const b = fingerprint("Merkez Bankasi faiz karari", "aciklandi");
    expect(a.strict).toBe(b.strict);
    // Same shingle sets (value equality over sets is awkward; size + membership suffices).
    expect(a.shingles.size).toBe(b.shingles.size);
    for (const s of a.shingles) expect(b.shingles.has(s)).toBe(true);
    for (let i = 0; i < 64; i++) expect(a.signature[i]).toBe(b.signature[i]);
  });
});

describe("serializeSignature / deserializeSignature", () => {
  it("MINHASH_VERSION is 1", () => {
    expect(MINHASH_VERSION).toBe(1);
  });

  it("round-trips a real fingerprint signature with jaccard 1 against the original", () => {
    const bundle = fingerprint("Erdogan AKP grup toplantisi", "kabine aciklamasi yapti");
    const serialized = serializeSignature(bundle.signature);
    expect(Array.isArray(serialized)).toBe(true);
    expect(serialized.length).toBe(MINHASH_SIG_K);

    const restored = deserializeSignature(serialized, MINHASH_VERSION);
    expect(restored).toBeInstanceOf(Uint32Array);
    expect(restored.length).toBe(MINHASH_SIG_K);
    for (let i = 0; i < MINHASH_SIG_K; i++) {
      expect(restored[i]).toBe(bundle.signature[i]);
    }
    expect(jaccardFromSignatures(bundle.signature, restored)).toBe(1);
  });

  it("rejects a version that does not match MINHASH_VERSION", () => {
    const serialized = serializeSignature(minhashSignature(new Set(["abcd"]), MINHASH_SIG_K));
    expect(deserializeSignature(serialized, 0)).toBe(null);
    expect(deserializeSignature(serialized, 2)).toBe(null);
    expect(deserializeSignature(serialized, "1")).toBe(null);
    expect(deserializeSignature(serialized, null)).toBe(null);
    expect(deserializeSignature(serialized, undefined)).toBe(null);
  });

  it("rejects arrays of the wrong length", () => {
    const short = new Array(MINHASH_SIG_K - 1).fill(0);
    const long = new Array(MINHASH_SIG_K + 1).fill(0);
    expect(deserializeSignature(short, MINHASH_VERSION)).toBe(null);
    expect(deserializeSignature(long, MINHASH_VERSION)).toBe(null);
  });

  it("rejects non-array values", () => {
    expect(deserializeSignature("not an array", MINHASH_VERSION)).toBe(null);
    expect(deserializeSignature(null, MINHASH_VERSION)).toBe(null);
    expect(deserializeSignature(undefined, MINHASH_VERSION)).toBe(null);
    expect(deserializeSignature({}, MINHASH_VERSION)).toBe(null);
  });

  it("rejects arrays containing an out-of-range or non-integer element", () => {
    const base = () => new Array(MINHASH_SIG_K).fill(0);
    const withNegative = base();
    withNegative[0] = -1;
    expect(deserializeSignature(withNegative, MINHASH_VERSION)).toBe(null);

    const withOverflow = base();
    withOverflow[0] = 2 ** 32;
    expect(deserializeSignature(withOverflow, MINHASH_VERSION)).toBe(null);

    const withFloat = base();
    withFloat[0] = 1.5;
    expect(deserializeSignature(withFloat, MINHASH_VERSION)).toBe(null);

    const withNonNumericString = base();
    withNonNumericString[0] = "x";
    expect(deserializeSignature(withNonNumericString, MINHASH_VERSION)).toBe(null);
  });

  it("accepts digit-string elements (int8-stringifying pg drivers)", () => {
    const bundle = fingerprint("Galatasaray Fenerbahce derbisi", "3-1 galip geldi");
    const serialized = serializeSignature(bundle.signature).map(String);
    const restored = deserializeSignature(serialized, MINHASH_VERSION);
    expect(restored).toBeInstanceOf(Uint32Array);
    for (let i = 0; i < MINHASH_SIG_K; i++) {
      expect(restored[i]).toBe(bundle.signature[i]);
    }
  });
});
