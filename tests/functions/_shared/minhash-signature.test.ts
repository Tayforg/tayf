import { describe, it, expect } from "vitest";
import {
  fingerprint,
  jaccardFromSignatures,
  minhashSignature,
  MINHASH_VERSION,
  serializeSignature,
  deserializeSignature,
} from "../../../supabase/functions/_shared/cluster/fingerprint.ts";
import { MINHASH_SIG_K } from "../../../supabase/functions/_shared/cluster/constants.ts";

// ---------------------------------------------------------------------------
// serializeSignature / deserializeSignature round-trip against the Deno-port
// fingerprint.ts, mirroring scripts/lib/cluster/fingerprint.test.mjs's
// coverage of the .mjs reference.
// ---------------------------------------------------------------------------

describe("fingerprint.ts — serializeSignature / deserializeSignature", () => {
  it("MINHASH_VERSION is 1", () => {
    expect(MINHASH_VERSION).toBe(1);
  });

  it("round-trips a real signature with jaccard 1 and elementwise equality", () => {
    const bundle = fingerprint("Erdogan AKP grup toplantisi", "kabine aciklamasi yapti");
    const serialized = serializeSignature(bundle.signature);
    expect(serialized.length).toBe(MINHASH_SIG_K);

    const restored = deserializeSignature(serialized, MINHASH_VERSION);
    expect(restored).not.toBeNull();
    expect(restored).toBeInstanceOf(Uint32Array);
    expect(restored!.length).toBe(MINHASH_SIG_K);
    for (let i = 0; i < MINHASH_SIG_K; i++) {
      expect(restored![i]).toBe(bundle.signature[i]);
    }
    expect(jaccardFromSignatures(bundle.signature, restored)).toBe(1);
  });

  it("rejects a mismatched version", () => {
    const serialized = serializeSignature(minhashSignature(new Set(["abcd"]), MINHASH_SIG_K));
    expect(deserializeSignature(serialized, 0)).toBeNull();
    expect(deserializeSignature(serialized, 2)).toBeNull();
    expect(deserializeSignature(serialized, "1")).toBeNull();
    expect(deserializeSignature(serialized, null)).toBeNull();
    expect(deserializeSignature(serialized, undefined)).toBeNull();
  });

  it("rejects the wrong length", () => {
    expect(
      deserializeSignature(new Array(MINHASH_SIG_K - 1).fill(0), MINHASH_VERSION),
    ).toBeNull();
    expect(
      deserializeSignature(new Array(MINHASH_SIG_K + 1).fill(0), MINHASH_VERSION),
    ).toBeNull();
  });

  it("rejects non-array values", () => {
    expect(deserializeSignature("nope", MINHASH_VERSION)).toBeNull();
    expect(deserializeSignature(null, MINHASH_VERSION)).toBeNull();
    expect(deserializeSignature(undefined, MINHASH_VERSION)).toBeNull();
    expect(deserializeSignature({}, MINHASH_VERSION)).toBeNull();
  });

  it("accepts digit-string elements from int8-stringifying pg drivers", () => {
    const bundle = fingerprint("Galatasaray Fenerbahce derbisi", "3-1 galip geldi");
    const serialized = serializeSignature(bundle.signature).map(String);
    const restored = deserializeSignature(serialized, MINHASH_VERSION);
    expect(restored).not.toBeNull();
    for (let i = 0; i < MINHASH_SIG_K; i++) {
      expect(restored![i]).toBe(bundle.signature[i]);
    }
  });

  it("rejects out-of-range or non-integer elements", () => {
    const base = () => new Array(MINHASH_SIG_K).fill(0);

    const negative = base();
    negative[0] = -1;
    expect(deserializeSignature(negative, MINHASH_VERSION)).toBeNull();

    const overflow = base();
    overflow[0] = 2 ** 32;
    expect(deserializeSignature(overflow, MINHASH_VERSION)).toBeNull();

    const float = base();
    float[0] = 1.5;
    expect(deserializeSignature(float, MINHASH_VERSION)).toBeNull();

    const nonNumeric = base();
    nonNumeric[0] = "x";
    expect(deserializeSignature(nonNumeric, MINHASH_VERSION)).toBeNull();
  });
});
