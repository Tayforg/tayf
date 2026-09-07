import { describe, it, expect, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// Golden-vector parity tests between the legacy `scripts/lib/cluster/*.mjs`
// reference implementation and the Deno port at
// `supabase/functions/_shared/cluster/*.ts`.
//
// The Edge Function cluster lane MUST stay byte-for-byte equivalent to the
// long-running tmux clusterer that the worker-stream refactor replaces — any
// silent drift would change which articles get merged into the same cluster
// and produce a behaviour regression that the unit-level consumer tests
// (`tests/functions/cluster-consumer.test.ts`) cannot catch, because they
// mock the scorer at the import boundary.
//
// This file imports both implementations directly, runs them over a fixed
// 10-article Turkish-news corpus, and asserts equality on every observable
// output:
//
//   - `strictFingerprint(title, description)` per article
//   - `extractEntities(title + " " + description)` per article (sorted)
//   - `tfidf.cosine(idA, idB)` for every pair after `addDoc` over the corpus
//   - `score(a, b, aEnts, bEnts, tfidfCosine, hoursDelta)` per pair
//
// "No silent skips" — if either implementation fails to load, the failure
// surfaces loud via an `expect.fail(...)` inside a `beforeAll` so the suite
// goes red rather than green-for-zero-tests.
// ---------------------------------------------------------------------------

// Each test driver bundles the symbols it needs from one side of the parity
// boundary. Loaded lazily inside `beforeAll` so the entire suite can fail
// gracefully (loud, not silent) if the dynamic-import path is wrong.
interface ClusterSide {
  strictFingerprint(
    title: string | null | undefined,
    description: string | null | undefined,
  ): string | null;
  extractEntities(text: string | null | undefined): string[];
  fingerprint(
    title: string | null | undefined,
    description: string | null | undefined,
  ): {
    strict: string | null;
    shingles: Set<string>;
    signature: Uint32Array;
  };
  TfidfIndex: new () => {
    addDoc(id: string, text: string | null | undefined): void;
    finalize(): void;
    cosine(idA: string, idB: string): number;
    query(text: string | null | undefined): { tf: Map<string, number> };
    cosineQuery(q: { tf: Map<string, number> }, id: string): number;
  };
  score(
    a: unknown,
    b: unknown,
    aEnts: Iterable<string>,
    bEnts: Iterable<string>,
    tfidfCosine: number,
    hoursDelta: number,
  ): { score: number; components: Record<string, unknown> };
  MINHASH_VERSION: number;
  serializeSignature(sig: Uint32Array): number[];
  deserializeSignature(value: unknown, version: unknown): Uint32Array | null;
}

let legacy: ClusterSide | null = null;
let port: ClusterSide | null = null;
let loadError: unknown = null;

// Frozen 10-article corpus. Deliberately small so the assertion matrix
// (10 fingerprints + 10 entity sets + 45 cosine pairs + 45 ensemble pairs)
// stays under 110 individual checks, which keeps wall-clock under a second.
// Topics span the failure modes the legacy clusterer was tuned for:
//   - MHP-fesh structural-recall rewrites (R3 §5.1)
//   - Multi-word "Cumhurbaşkanı Erdoğan" entity de-pollution (W2-D2)
//   - Year + percentage extraction
//   - Sports / finance / religion / minority bridge lanes
//   - An English-titled a-news article for the EN→TR bridge
//   - Unrelated stories to anchor the low-Jaccard / low-cosine end.
interface Article {
  id: string;
  title: string;
  description: string;
  // hoursDelta against `articles[0]` — used only when scoring pairs against
  // index 0. The ensemble scorer takes an explicit `hoursDelta` argument.
  hoursFromAnchor: number;
}

const articles: readonly Article[] = [
  {
    id: "a0",
    title: "MHP İstanbul'da il teşkilatını feshetti",
    description: "MHP Genel Başkanı Bahçeli İstanbul il teşkilatının feshedildiğini açıkladı",
    hoursFromAnchor: 0,
  },
  {
    id: "a1",
    title: "MHP İstanbul il teşkilatını fesh etti",
    description: "Bahçeli açıklamasında İstanbul'daki il teşkilatının feshedildiğini söyledi",
    hoursFromAnchor: 0.5,
  },
  {
    id: "a2",
    title: "Cumhurbaşkanı Erdoğan Almanya ziyaretinde konuştu",
    description: "Erdoğan Berlin'deki temaslarında ekonomi ve dış politika gündemine değindi",
    hoursFromAnchor: 2,
  },
  {
    id: "a3",
    title: "TCMB faiz kararını 2024 yılında açıkladı",
    description: "Merkez Bankası yüzde 47 seviyesindeki politika faizini sabit tuttu",
    hoursFromAnchor: 3,
  },
  {
    id: "a4",
    title: "Galatasaray Fenerbahçe derbisinde 3-1 galip geldi",
    description: "Süper Lig'in dev derbisi Galatasaray'ın üstünlüğüyle sonuçlandı",
    hoursFromAnchor: 5,
  },
  {
    id: "a5",
    title: "Galatasaray Fenerbahçe maçında 3 gol attı",
    description: "Derbi mücadelesinde sarı-kırmızılılar üç gollü galibiyetle ayrıldı",
    hoursFromAnchor: 5.5,
  },
  {
    id: "a6",
    title: "Diyanet Cuma hutbesinde Ramazan açıklaması yaptı",
    description: "Diyanet İşleri Başkanlığı camide okunan hutbede Ramazan ayına değindi",
    hoursFromAnchor: 7,
  },
  {
    id: "a7",
    title: "Hrant Dink anması İstanbul'da yapıldı",
    description: "Ermeni gazeteci Hrant Dink ölümünün yıl dönümünde Agos önünde anıldı",
    hoursFromAnchor: 10,
  },
  {
    id: "a8",
    title: "Turkey's parliament passed the new economy bill",
    description: "Turkish president Erdogan praised the central bank's policy stance",
    hoursFromAnchor: 12,
  },
  {
    id: "a9",
    title: "AYM 2020/2003 başvurusunu reddetti",
    description: "Anayasa Mahkemesi bireysel başvurunun esastan reddedildiğini duyurdu",
    hoursFromAnchor: 18,
  },
];

function entityText(article: Article): string {
  return `${article.title} ${article.description}`;
}

beforeAll(async () => {
  try {
    const [
      legacyConstants,
      legacyFingerprint,
      legacyEntities,
      legacyTfidf,
      legacyEnsemble,
      portConstants,
      portFingerprint,
      portEntities,
      portTfidf,
      portEnsemble,
    ] = await Promise.all([
      import("../../../scripts/lib/cluster/constants.mjs"),
      import("../../../scripts/lib/cluster/fingerprint.mjs"),
      import("../../../scripts/lib/cluster/entities.mjs"),
      import("../../../scripts/lib/cluster/tfidf.mjs"),
      import("../../../scripts/lib/cluster/ensemble.mjs"),
      import("../../../supabase/functions/_shared/cluster/constants.ts"),
      import("../../../supabase/functions/_shared/cluster/fingerprint.ts"),
      import("../../../supabase/functions/_shared/cluster/entities.ts"),
      import("../../../supabase/functions/_shared/cluster/tfidf.ts"),
      import("../../../supabase/functions/_shared/cluster/ensemble.ts"),
    ]);

    legacy = {
      strictFingerprint: legacyFingerprint.strictFingerprint,
      extractEntities: legacyEntities.extractEntities,
      fingerprint: legacyFingerprint.fingerprint,
      TfidfIndex: legacyTfidf.TfidfIndex,
      score: legacyEnsemble.score,
      MINHASH_VERSION: legacyFingerprint.MINHASH_VERSION,
      serializeSignature: legacyFingerprint.serializeSignature,
      deserializeSignature: legacyFingerprint.deserializeSignature,
    };
    port = {
      strictFingerprint: portFingerprint.strictFingerprint,
      extractEntities: portEntities.extractEntities,
      fingerprint: portFingerprint.fingerprint,
      TfidfIndex: portTfidf.TfidfIndex,
      score: portEnsemble.score,
      MINHASH_VERSION: portFingerprint.MINHASH_VERSION,
      serializeSignature: portFingerprint.serializeSignature,
      deserializeSignature: portFingerprint.deserializeSignature,
    };

    // Smoke-check the constants line up — if the .ts port drifts numerically
    // from the .mjs reference, the ensemble parity test below will fail too,
    // but failing here gives a clearer error message.
    expect(portConstants.MATCH_THRESHOLD).toBe(legacyConstants.MATCH_THRESHOLD);
    expect(portConstants.TFIDF_WEIGHT).toBe(legacyConstants.TFIDF_WEIGHT);
    expect(portConstants.ENTITY_WEIGHT).toBe(legacyConstants.ENTITY_WEIGHT);
    expect(portConstants.MINHASH_SOFT_ACCEPT_JACCARD).toBe(
      legacyConstants.MINHASH_SOFT_ACCEPT_JACCARD,
    );
    expect(portConstants.ENTITY_DENOM_MIN).toBe(legacyConstants.ENTITY_DENOM_MIN);
    expect(portConstants.ENTITY_FRESHNESS_HOURS).toBe(
      legacyConstants.ENTITY_FRESHNESS_HOURS,
    );
    expect(portConstants.TIME_WINDOW_HOURS).toBe(legacyConstants.TIME_WINDOW_HOURS);
    expect(portConstants.MIN_SHARED_ENTITIES).toBe(legacyConstants.MIN_SHARED_ENTITIES);
    expect(portConstants.MINHASH_SIG_K).toBe(legacyConstants.MINHASH_SIG_K);
  } catch (err) {
    loadError = err;
  }
});

describe("cluster-libs golden-vector parity (scripts/lib/cluster ↔ supabase/functions/_shared/cluster)", () => {
  it("loads both implementations without error", () => {
    if (loadError) {
      // Surface the original error verbatim so a missing dep or path typo is
      // obvious on the first run. Never silently `return` on import failure.
      expect.fail(
        `failed to dynamic-import one or both cluster implementations: ${String(loadError)}`,
      );
    }
    expect(legacy).not.toBeNull();
    expect(port).not.toBeNull();
  });

  describe("strictFingerprint", () => {
    for (const article of articles) {
      it(`matches for ${article.id}`, () => {
        if (!legacy || !port) expect.fail("cluster libs not loaded");
        const a = legacy.strictFingerprint(article.title, article.description);
        const b = port.strictFingerprint(article.title, article.description);
        expect(b).toBe(a);
      });
    }
  });

  describe("extractEntities", () => {
    for (const article of articles) {
      it(`matches for ${article.id}`, () => {
        if (!legacy || !port) expect.fail("cluster libs not loaded");
        const a = [...legacy.extractEntities(entityText(article))].sort();
        const b = [...port.extractEntities(entityText(article))].sort();
        expect(b).toEqual(a);
      });
    }
  });

  describe("TfidfIndex.cosine over the full corpus", () => {
    it("produces byte-equivalent pairwise cosine values", () => {
      if (!legacy || !port) expect.fail("cluster libs not loaded");
      const legacyIdx = new legacy.TfidfIndex();
      const portIdx = new port.TfidfIndex();
      for (const article of articles) {
        const text = entityText(article);
        legacyIdx.addDoc(article.id, text);
        portIdx.addDoc(article.id, text);
      }
      legacyIdx.finalize();
      portIdx.finalize();

      const mismatches: string[] = [];
      for (let i = 0; i < articles.length; i++) {
        for (let j = i; j < articles.length; j++) {
          const idA = articles[i]!.id;
          const idB = articles[j]!.id;
          const a = legacyIdx.cosine(idA, idB);
          const b = portIdx.cosine(idA, idB);
          // Both implementations share identical token preprocessing, IDF
          // smoothing, and dot-product loops; the floating-point result is
          // deterministically equal byte-for-byte.
          if (a !== b) {
            mismatches.push(
              `pair (${idA}, ${idB}): legacy=${a}, port=${b}, diff=${a - b}`,
            );
          }
        }
      }
      expect(mismatches).toEqual([]);
    });
  });

  describe("ensemble.score over every candidate pair", () => {
    it("produces byte-equivalent score + components for each pair", () => {
      if (!legacy || !port) expect.fail("cluster libs not loaded");
      // Pre-compute fingerprints + entity sets per article once.
      const fpsLegacy = articles.map((a) =>
        legacy!.fingerprint(a.title, a.description),
      );
      const fpsPort = articles.map((a) =>
        port!.fingerprint(a.title, a.description),
      );
      const entsLegacy = articles.map((a) =>
        legacy!.extractEntities(entityText(a)),
      );
      const entsPort = articles.map((a) =>
        port!.extractEntities(entityText(a)),
      );

      // Use the legacy TF-IDF index as the cosine feed for both sides. The
      // index itself is asserted byte-equal above, so either index would do
      // — picking one keeps the input to `score()` identical on both sides.
      const tfidfIdx = new legacy.TfidfIndex();
      for (const a of articles) {
        tfidfIdx.addDoc(a.id, entityText(a));
      }
      tfidfIdx.finalize();

      const mismatches: string[] = [];
      for (let i = 0; i < articles.length; i++) {
        for (let j = i + 1; j < articles.length; j++) {
          const aArt = articles[i]!;
          const bArt = articles[j]!;
          const tfidfCosine = tfidfIdx.cosine(aArt.id, bArt.id);
          const hoursDelta = Math.abs(
            aArt.hoursFromAnchor - bArt.hoursFromAnchor,
          );

          const rLegacy = legacy.score(
            fpsLegacy[i],
            fpsLegacy[j],
            entsLegacy[i]!,
            entsLegacy[j]!,
            tfidfCosine,
            hoursDelta,
          );
          const rPort = port.score(
            fpsPort[i],
            fpsPort[j],
            entsPort[i]!,
            entsPort[j]!,
            tfidfCosine,
            hoursDelta,
          );

          if (rLegacy.score !== rPort.score) {
            mismatches.push(
              `pair (${aArt.id}, ${bArt.id}): legacy.score=${rLegacy.score}, port.score=${rPort.score}`,
            );
            continue;
          }
          // Compare every component key. Both sides emit the same shape; if
          // a future port adds a key, the deep equality will catch it.
          const legacyKeys = Object.keys(rLegacy.components).sort();
          const portKeys = Object.keys(rPort.components).sort();
          if (legacyKeys.join(",") !== portKeys.join(",")) {
            mismatches.push(
              `pair (${aArt.id}, ${bArt.id}): components keys differ — legacy=[${legacyKeys.join(",")}], port=[${portKeys.join(",")}]`,
            );
            continue;
          }
          for (const key of legacyKeys) {
            const lv = (rLegacy.components as Record<string, unknown>)[key];
            const pv = (rPort.components as Record<string, unknown>)[key];
            if (lv !== pv) {
              mismatches.push(
                `pair (${aArt.id}, ${bArt.id}): component ${key} — legacy=${String(lv)}, port=${String(pv)}`,
              );
            }
          }
        }
      }
      expect(mismatches).toEqual([]);
    });
  });

  describe("MinHash signature persistence — MINHASH_VERSION", () => {
    it("matches between the .mjs reference and the Deno port", () => {
      if (!legacy || !port) expect.fail("cluster libs not loaded");
      expect(port.MINHASH_VERSION).toBe(legacy.MINHASH_VERSION);
    });
  });

  describe("MinHash signature persistence — cross-implementation round trip", () => {
    for (const article of articles) {
      it(`legacy-serialized signature deserializes correctly on the port, and vice versa (${article.id})`, () => {
        if (!legacy || !port) expect.fail("cluster libs not loaded");
        const legacyFp = legacy.fingerprint(article.title, article.description);
        const portFp = port.fingerprint(article.title, article.description);

        // legacy.serialize -> port.deserialize must equal the port's own
        // fresh signature for the same article, elementwise.
        const legacySerialized = legacy.serializeSignature(legacyFp.signature);
        const restoredOnPort = port.deserializeSignature(
          legacySerialized,
          port.MINHASH_VERSION,
        );
        expect(restoredOnPort).not.toBeNull();
        for (let i = 0; i < portFp.signature.length; i++) {
          expect(restoredOnPort![i]).toBe(portFp.signature[i]);
        }

        // And the reverse: port.serialize -> legacy.deserialize must equal
        // the legacy's own fresh signature.
        const portSerialized = port.serializeSignature(portFp.signature);
        const restoredOnLegacy = legacy.deserializeSignature(
          portSerialized,
          legacy.MINHASH_VERSION,
        );
        expect(restoredOnLegacy).not.toBeNull();
        for (let i = 0; i < legacyFp.signature.length; i++) {
          expect(restoredOnLegacy![i]).toBe(legacyFp.signature[i]);
        }
      });
    }
  });

  describe("TfidfIndex.cosineQuery leave-one-out parity", () => {
    it("legacy.cosineQuery === port.cosineQuery === legacy per-article build, for every (query, doc) pair", () => {
      if (!legacy || !port) expect.fail("cluster libs not loaded");

      // Leave-one-out: for each article treated as the "incoming" query,
      // the context index holds only the OTHER 9 articles (S = 9), mirroring
      // production where ctx.tfidf never contains the incoming article
      // itself. 10 queries * 9 others = 90 ordered pairs.
      const mismatches: string[] = [];
      for (const queryArticle of articles) {
        const others = articles.filter((a) => a.id !== queryArticle.id);
        const queryText = entityText(queryArticle);

        const legacyCtx = new legacy.TfidfIndex();
        const portCtx = new port.TfidfIndex();
        for (const other of others) {
          const text = entityText(other);
          legacyCtx.addDoc(other.id, text);
          portCtx.addDoc(other.id, text);
        }
        const legacyQuery = legacyCtx.query(queryText);
        const portQuery = portCtx.query(queryText);

        // Legacy per-article build — the pre-persistence behaviour this
        // migration replaces: a fresh index over S=9 docs plus the incoming
        // query article, finalized, then a plain cosine() call.
        const rebuilt = new legacy.TfidfIndex();
        for (const other of others) {
          rebuilt.addDoc(other.id, entityText(other));
        }
        rebuilt.addDoc(queryArticle.id, queryText);
        rebuilt.finalize();

        for (const docArticle of others) {
          const viaLegacyCosineQuery = legacyCtx.cosineQuery(legacyQuery, docArticle.id);
          const viaPortCosineQuery = portCtx.cosineQuery(portQuery, docArticle.id);
          const viaLegacyRebuild = rebuilt.cosine(queryArticle.id, docArticle.id);

          if (
            viaLegacyCosineQuery !== viaPortCosineQuery ||
            viaLegacyCosineQuery !== viaLegacyRebuild
          ) {
            mismatches.push(
              `query=${queryArticle.id} doc=${docArticle.id}: ` +
                `legacy.cosineQuery=${viaLegacyCosineQuery}, port.cosineQuery=${viaPortCosineQuery}, ` +
                `legacy.rebuild=${viaLegacyRebuild}`,
            );
          }
        }
      }
      expect(mismatches).toEqual([]);
    });
  });
});
