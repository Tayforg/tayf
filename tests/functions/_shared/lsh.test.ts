import { describe, it, expect, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// LSH banding over the existing MinHash signatures.
//
// Why this module exists: `findCandidateClusters` admits a cluster only via an
// exact strict-fingerprint match or >=2 shared whitelist entities. The ensemble
// scorer — MinHash jaccard and TF-IDF cosine — runs ONLY on candidates that
// already cleared that gate, so the strongest similarity signals can never
// rescue a pair the weakest one rejected.
//
// Measured against production (24h politics, n=948): 50.5% of articles carry
// fewer than 2 entities, making the >=2-shared gate arithmetically unreachable
// for half the corpus. Singleton rate was 91.8%.
//
// The pairs below are real recall misses from `scripts/audit-clusters.mjs`.
// Each scored 0.94-1.00 on jaccard yet landed in SEPARATE clusters, because
// neither route admitted them:
//
//   haber7   "1 milyon TL"  vs "1,5 milyon TL"   -> 1 shared entity (erdogan)
//   haber-global "İngiltere'yi" vs "Londra'yı"   -> 0 shared entities
//                                                   ("londra" is not in the
//                                                    ~80-term whitelist)
//
// Banding these signatures gives them a third route into the candidate set,
// after which the existing scorer decides on the merits. This file pins that
// behaviour: high-jaccard pairs MUST share a band, unrelated pairs MUST NOT.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
let fingerprint: any;
let bandKeys: any;
let LSH_BANDS: any;
let LSH_ROWS: any;
let MINHASH_SIG_K: any;
let jaccardFromSignatures: any;

beforeAll(async () => {
  try {
    const fp = await import(
      "../../../supabase/functions/_shared/cluster/fingerprint.ts"
    );
    const lsh = await import("../../../supabase/functions/_shared/cluster/lsh.ts");
    const constants = await import(
      "../../../supabase/functions/_shared/cluster/constants.ts"
    );
    fingerprint = fp.fingerprint;
    jaccardFromSignatures = fp.jaccardFromSignatures;
    bandKeys = lsh.bandKeys;
    LSH_BANDS = lsh.LSH_BANDS;
    LSH_ROWS = lsh.LSH_ROWS;
    MINHASH_SIG_K = constants.MINHASH_SIG_K;
  } catch (err) {
    expect.fail(
      `LSH module failed to load: ${err instanceof Error ? err.message : err}`,
    );
  }
});

function keysFor(title: string, description = "") {
  return bandKeys(fingerprint(title, description).signature);
}

function sharedBands(a: string[], b: string[]) {
  const setB = new Set(b);
  return a.filter((k) => setB.has(k));
}

describe("LSH band geometry", () => {
  it("bands tile the signature exactly — LSH_BANDS * LSH_ROWS === MINHASH_SIG_K", () => {
    // If this drifts, some signature slots stop contributing to candidate
    // generation and recall silently degrades.
    expect(LSH_BANDS * LSH_ROWS).toBe(MINHASH_SIG_K);
  });

  it("emits one key per band", () => {
    expect(keysFor("Erdoğan Ankara'da kabine toplantısına başkanlık etti")).toHaveLength(
      LSH_BANDS,
    );
  });

  it("returns no keys for an uncomparable (empty-shingle) signature", () => {
    // minhashSignature fills 0xFFFFFFFF for an empty shingle set, and its own
    // docs say to treat that as "not comparable" rather than identical. If
    // those were banded, every contentless article would collide with every
    // other one and the candidate set would fill with garbage.
    expect(bandKeys(fingerprint("", "").signature)).toEqual([]);
    expect(bandKeys(null)).toEqual([]);
    expect(bandKeys(undefined)).toEqual([]);
  });

  it("keys are band-positional — the same 4 values in a different band do not collide", () => {
    const keys = keysFor("Meclis'te bütçe görüşmeleri sürüyor");
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("LSH admits the real recall misses from the production audit", () => {
  it("haber7: '1 milyon TL' vs '1,5 milyon TL' (jac 0.98, 1 shared entity)", () => {
    const a = keysFor(
      "Başkan Erdoğan peş peşe açıkladı: 15 bin sosyal konut geliyor, esnafa 1 milyon TL kredi!",
    );
    const b = keysFor(
      "Başkan Erdoğan peş peşe açıkladı: 15 bin sosyal konut geliyor, esnafa 1,5 milyon TL kredi!",
    );
    expect(sharedBands(a, b).length).toBeGreaterThan(0);
  });

  it("haber-global: 'İngiltere'yi' vs 'Londra'yı' (jac 0.94, ZERO shared entities)", () => {
    const a = keysFor(
      "İngiltere'yi karıştıran yazışma, yeni Başbakan’ın başı ağrıyacak.",
    );
    const b = keysFor(
      "Londra'yı karıştıran yazışma, yeni Başbakan’ın başı ağrıyacak",
    );
    expect(sharedBands(a, b).length).toBeGreaterThan(0);
  });

  it("cumhuriyet: 'beraat skandalı' vs 'beraat kararı' (jac ~0.94)", () => {
    const a = keysFor(
      "Cumhuriyet yazarı Barış Terkoğlu gündeme getirmişti: Cinsel saldırı davasındaki 'beraat' skandalı Meclis'te",
    );
    const b = keysFor(
      "Cumhuriyet yazarı Barış Terkoğlu gündeme getirmişti: Cinsel saldırı davasındaki 'beraat' kararı Meclis'te",
    );
    expect(sharedBands(a, b).length).toBeGreaterThan(0);
  });

  it("identical text shares every band", () => {
    const t = "Kedi Zafer CHP'de mi kaldı, Yeni Parti'ye mi geçti?";
    expect(sharedBands(keysFor(t), keysFor(t))).toHaveLength(LSH_BANDS);
  });
});

describe("LSH does not flood the candidate set", () => {
  // Precision guard. The consumer caps candidates at MAX_CANDIDATE_CLUSTERS,
  // so a banding scheme that collides on unrelated stories would evict real
  // matches before they are ever scored. These headlines share topic-level
  // vocabulary but describe different events.
  const UNRELATED: Array<[string, string]> = [
    [
      "Merkez Bankası faiz kararını açıkladı",
      "Galatasaray deplasmanda kazandı",
    ],
    [
      "İstanbul'da sağanak yağış bekleniyor",
      "Meclis'te bütçe görüşmeleri sürüyor",
    ],
    [
      "Erdoğan kabine toplantısına başkanlık etti",
      "CHP kurultayı için tarih belirlendi",
    ],
  ];

  it.each(UNRELATED)("shares no band: %s / %s", (a, b) => {
    const ka = keysFor(a);
    const kb = keysFor(b);
    // Sanity: these really are dissimilar, so the assertion below is
    // measuring the bander and not a badly-chosen fixture.
    const jac = jaccardFromSignatures(
      fingerprint(a, "").signature,
      fingerprint(b, "").signature,
    );
    expect(jac).toBeLessThan(0.3);
    expect(sharedBands(ka, kb)).toHaveLength(0);
  });
});
