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
    opts?: { aTitle?: string | null; bTitle?: string | null },
  ): { score: number; components: Record<string, unknown> };
  titleTokens(title: string | null | undefined, minLen?: number): Set<string>;
  headlineTokens(title: string | null | undefined): {
    tokens: Set<string>;
    numbers: Set<string>;
  };
  headlineLane(
    ha: { tokens: Set<string>; numbers: Set<string> },
    hb: { tokens: Set<string>; numbers: Set<string> },
    hoursDelta: number,
  ): {
    fired: boolean;
    kind: "jaccard" | "containment" | null;
    sim: number;
    shared: number;
    containment: number;
    score: number;
  };
  headlineOnlyScore(
    ha: { tokens: Set<string>; numbers: Set<string> },
    hb: { tokens: Set<string>; numbers: Set<string> },
    hoursDelta: number,
    opts?: { aSourceSlug?: string | null; bSourceSlug?: string | null },
  ): number;
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
      headlineLane: legacyEnsemble.headlineLane,
      headlineOnlyScore: legacyEnsemble.headlineOnlyScore,
      titleTokens: legacyFingerprint.titleTokens,
      headlineTokens: legacyFingerprint.headlineTokens,
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
      headlineLane: portEnsemble.headlineLane,
      headlineOnlyScore: portEnsemble.headlineOnlyScore,
      titleTokens: portFingerprint.titleTokens,
      headlineTokens: portFingerprint.headlineTokens,
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
    // 2026-11-01 recall wave: headline lane, text floor, sticky context.
    expect(portConstants.HEADLINE_LANE_MIN_SHARED).toBe(
      legacyConstants.HEADLINE_LANE_MIN_SHARED,
    );
    expect(portConstants.HEADLINE_LANE_MIN_JACCARD).toBe(
      legacyConstants.HEADLINE_LANE_MIN_JACCARD,
    );
    expect(portConstants.HEADLINE_LANE_MAX_HOURS).toBe(
      legacyConstants.HEADLINE_LANE_MAX_HOURS,
    );
    expect(portConstants.HEADLINE_TOKEN_MIN_LEN).toBe(
      legacyConstants.HEADLINE_TOKEN_MIN_LEN,
    );
    expect([...portConstants.HEADLINE_GENERIC_PREFIXES]).toEqual([
      ...legacyConstants.HEADLINE_GENERIC_PREFIXES,
    ]);
    // Headline containment (wave AB follow-up).
    expect(portConstants.HEADLINE_CONTAIN_MIN).toBe(legacyConstants.HEADLINE_CONTAIN_MIN);
    expect(portConstants.HEADLINE_CONTAIN_MIN_TOKENS).toBe(
      legacyConstants.HEADLINE_CONTAIN_MIN_TOKENS,
    );
    expect([...portConstants.HEADLINE_CONTAIN_BLOCK_PREFIXES]).toEqual([
      ...legacyConstants.HEADLINE_CONTAIN_BLOCK_PREFIXES,
    ]);
    expect(portConstants.HEADLINE_MEMBER_SCAN_MAX).toBe(
      legacyConstants.HEADLINE_MEMBER_SCAN_MAX,
    );
    // Pin the shipped values so "both undefined" can never pass as parity.
    expect(legacyConstants.HEADLINE_CONTAIN_MIN).toBe(0.85);
    expect(legacyConstants.HEADLINE_CONTAIN_MIN_TOKENS).toBe(5);
    expect([...legacyConstants.HEADLINE_CONTAIN_BLOCK_PREFIXES]).toEqual([
      "yalan",
      "iddia",
      "degil",
      "tekzip",
    ]);
    expect(legacyConstants.HEADLINE_MEMBER_SCAN_MAX).toBe(12);
    // Size guard (review of wave AB).
    expect(portConstants.HEADLINE_CONTAIN_MIN_SIZE_RATIO).toBe(
      legacyConstants.HEADLINE_CONTAIN_MIN_SIZE_RATIO,
    );
    expect(portConstants.HEADLINE_TITLE_MAX_CHARS).toBe(legacyConstants.HEADLINE_TITLE_MAX_CHARS);
    expect(legacyConstants.HEADLINE_CONTAIN_MIN_SIZE_RATIO).toBe(0.4);
    expect(legacyConstants.HEADLINE_TITLE_MAX_CHARS).toBe(300);
    expect(portConstants.ENTITY_TEXT_FLOOR).toBe(legacyConstants.ENTITY_TEXT_FLOOR);
    expect(portConstants.CONTEXT_STICKY_MIN_ARTICLES).toBe(
      legacyConstants.CONTEXT_STICKY_MIN_ARTICLES,
    );
    expect(portConstants.CONTEXT_STICKY_HOURS).toBe(legacyConstants.CONTEXT_STICKY_HOURS);
    expect(portConstants.CONTEXT_STICKY_MAX).toBe(legacyConstants.CONTEXT_STICKY_MAX);
    expect(portConstants.TOKEN_MIN_LEN).toBe(legacyConstants.TOKEN_MIN_LEN);
    expect(portConstants.TOKEN_CANDIDATE_MIN_SHARED).toBe(
      legacyConstants.TOKEN_CANDIDATE_MIN_SHARED,
    );
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
            { aTitle: aArt.title, bTitle: bArt.title },
          );
          const rPort = port.score(
            fpsPort[i],
            fpsPort[j],
            entsPort[i]!,
            entsPort[j]!,
            tfidfCosine,
            hoursDelta,
            { aTitle: aArt.title, bTitle: bArt.title },
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

  describe("headline lane + token helpers (2026-11-01 recall wave)", () => {
    // Golden headline pairs, including the lane boundary (7/10), a numeral
    // clash, an out-of-window pair and generic-prefix boilerplate.
    const titlePairs: Array<{
      a: string;
      b: string;
      tfidf: number;
      hours: number;
      kind?: "jaccard" | "containment" | null;
    }> = [
      {
        a: "Son dakika... Mustafa Sarıgül YENİ Parti'den istifa etti",
        b: "Mustafa Sarıgül Yeni Parti'den istifa etti: Adalet tecelli edecek",
        tfidf: 0.25,
        hours: 0.2,
      },
      {
        a: "Son dakika... Mustafa Sarıgül YENİ Parti'den istifa etti",
        b: "Mustafa Sarıgül Yeni Parti'den istifa etti: Adalet tecelli edecek",
        tfidf: 0.25,
        hours: 8,
      },
      {
        a: "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı!",
        b: "Bakırköy Belediyesi'ne yolsuzluk soruşturması: 39 kişi tutuklandı",
        tfidf: 0.25,
        hours: 1,
      },
      {
        a: "Bakırköy Belediyesi soruşturmasında 61 kişi tutuklandı",
        b: "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı",
        tfidf: 0.25,
        hours: 1,
      },
      {
        a: "CANLI | Cumhurbaşkanı Erdoğan konuşuyor",
        b: "Cumhurbaşkanı Erdoğan açıklamalarda bulunuyor",
        tfidf: 0.3,
        hours: 0.5,
      },
      { a: "", b: "Mustafa Sarıgül istifa etti", tfidf: 0.25, hours: 1 },
      // Headline containment (wave AB follow-up). Real prod headlines; the
      // "kind" column pins the verdict both implementations must reach.
      // fire: the bare Sarigul headline is fully contained in the long one.
      {
        a: "Mustafa Sarıgül Yeni Parti'den istifa etti",
        b: "Mustafa Sarıgül Yeni Parti'den istifa etti: Adalet tecelli edecek, partime döneceğim",
        tfidf: 0.2,
        hours: 0.1256,
        kind: "containment",
      },
      // fire: SPK appointment, bare vs Resmi Gazete headline.
      {
        a: "SPK Başkanlığına Muhsin Atcı atandı",
        b: "SPK Başkanlığına Muhsin Atcı atandı! Karar Resmi Gazete'de",
        tfidf: 0.2,
        hours: 0.5186,
        kind: "containment",
      },
      // fire at the hour limit, no fire a hair past it.
      {
        a: "Mustafa Sarıgül Yeni Parti'den istifa etti",
        b: "Mustafa Sarıgül Yeni Parti'den istifa etti: Adalet tecelli edecek, partime döneceğim",
        tfidf: 0.2,
        hours: 6,
        kind: "containment",
      },
      {
        a: "Mustafa Sarıgül Yeni Parti'den istifa etti",
        b: "Mustafa Sarıgül Yeni Parti'den istifa etti: Adalet tecelli edecek, partime döneceğim",
        tfidf: 0.2,
        hours: 7,
        kind: null,
      },
      // no fire: numeral sets {39} vs {39,22}.
      {
        a: "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı",
        b: "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı, 22 kişi adli kontrolle serbest",
        tfidf: 0.2,
        hours: 0.5,
        kind: null,
      },
      // no fire: only 4 non-numeral words on the shorter side.
      {
        a: "Sarıgül Yeni Parti istifa",
        b: "Mustafa Sarıgül Yeni Parti'den istifa etti: Adalet tecelli edecek, partime döneceğim",
        tfidf: 0.2,
        hours: 0.1,
        kind: null,
      },
      // no fire: denial prefix in the extra words.
      {
        a: "Mustafa Sarıgül Yeni Parti'den istifa etti",
        b: "Mustafa Sarıgül Yeni Parti'den istifa etti iddiasına yalanlama: İstifa etmedim, partimin yanındayım",
        tfidf: 0.2,
        hours: 0.3,
        kind: null,
      },
      // no fire: same person and verb, different counterpart (real G20 pair).
      {
        a: "Bakan Fidan, Endonezya Dışişleri Bakanı Nasir ile görüştü",
        b: "Dışişleri Bakanı Fidan, ABD Dışişleri Bakanı Rubio ile görüştü",
        tfidf: 0.2,
        hours: 4.39,
        kind: null,
      },
      // the Jaccard rule keeps its own kind.
      {
        a: "Son dakika... Mustafa Sarıgül YENİ Parti'den istifa etti",
        b: "Mustafa Sarıgül Yeni Parti'den istifa etti: Adalet tecelli edecek",
        tfidf: 0.2,
        hours: 0.2,
        kind: "jaccard",
      },
      // Size guard (review of wave AB): a roundup headline holding three
      // unrelated short headlines must not be "contained" by any of them.
      {
        a: "Merkez Bankası faiz kararını açıkladı",
        b: "Merkez Bankası faiz kararını açıkladı; Galatasaray derbide Fenerbahçe'yi üç golle yendi; İstanbul'da sağanak nedeniyle seferler iptal edildi",
        tfidf: 0.2,
        hours: 1,
        kind: null,
      },
      {
        a: "Galatasaray derbide Fenerbahçe'yi üç golle yendi",
        b: "Merkez Bankası faiz kararını açıkladı; Galatasaray derbide Fenerbahçe'yi üç golle yendi; İstanbul'da sağanak nedeniyle seferler iptal edildi",
        tfidf: 0.2,
        hours: 5.9,
        kind: null,
      },
      {
        a: "İstanbul'da sağanak nedeniyle seferler iptal edildi",
        b: "Merkez Bankası faiz kararını açıkladı; Galatasaray derbide Fenerbahçe'yi üç golle yendi; İstanbul'da sağanak nedeniyle seferler iptal edildi",
        tfidf: 0.2,
        hours: 0.2,
        kind: null,
      },
      // fire: the real Fidan-Rubio pair at ratio 5/11 = 0.45, just over the guard.
      {
        a: "Dışişleri Bakanı Fidan, ABD Dışişleri Bakanı Rubio ile görüştü",
        b: "Dışişleri Bakanı Hakan Fidan, Atlanta'da G20 Dışişleri Bakanları Toplantısı marjında ABD Dışişleri Bakanı Marco Rubio ile görüştü",
        tfidf: 0.2,
        hours: 3,
        kind: "containment",
      },
      // no fire (the known recall cost of the guard): a genuine same-story pair
      // whose long headline is 13 words against 5, ratio 0.38.
      {
        a: "Pegasus uçağı kuş sürüsüne çarptı",
        b: "Pegasus uçağı kuş sürüsüne çarptı: Kanadı hasar alan uçak İstanbul'a acil iniş yaptı",
        tfidf: 0.2,
        hours: 0.3,
        kind: null,
      },
      // no fire: a stuffed title cut at HEADLINE_TITLE_MAX_CHARS keeps only
      // the part inside the cap, so the short headline stays a minority.
      {
        a: "Merkez Bankası faiz kararını açıkladı",
        b: `Merkez Bankası faiz kararını açıkladı ${Array.from({ length: 400 }, (_, i) => `kelime${"abcdefghij"[i % 10]}${"klmnopqrst"[Math.floor(i / 10) % 10]}${"uvwxyzabcd"[Math.floor(i / 100) % 10]}`).join(" ")}`,
        tfidf: 0.2,
        hours: 1,
        kind: null,
      },
    ];

    it("score() is byte-equivalent for the golden headline pairs", () => {
      if (!legacy || !port) expect.fail("cluster libs not loaded");
      const noFp = { strict: null, signature: null };
      const mismatches: string[] = [];
      for (const [i, p] of titlePairs.entries()) {
        const opts = { aTitle: p.a, bTitle: p.b };
        const l = legacy.score(noFp, noFp, [], [], p.tfidf, p.hours, opts);
        const r = port.score(noFp, noFp, [], [], p.tfidf, p.hours, opts);
        if (l.score !== r.score) mismatches.push(`pair ${i}: score ${l.score} vs ${r.score}`);
        const lk = Object.keys(l.components).sort();
        const rk = Object.keys(r.components).sort();
        if (lk.join(",") !== rk.join(",")) {
          mismatches.push(`pair ${i}: keys [${lk}] vs [${rk}]`);
          continue;
        }
        for (const k of lk) {
          const lv = (l.components as Record<string, unknown>)[k];
          const rv = (r.components as Record<string, unknown>)[k];
          if (lv !== rv) mismatches.push(`pair ${i}: ${k} ${String(lv)} vs ${String(rv)}`);
        }
      }
      expect(mismatches).toEqual([]);
      // The new component keys exist on both sides (also for the lane-less branch).
      const keys = Object.keys(
        legacy.score(noFp, noFp, [], [], 0.1, 1).components,
      );
      for (const k of [
        "headlineSim",
        "headlineShared",
        "headlineLane",
        "textFloorCapped",
        "headlineContainment",
        "headlineKind",
      ]) {
        expect(keys).toContain(k);
      }
    });

    it("the golden containment pairs reach the pinned verdict on both implementations", () => {
      if (!legacy || !port) expect.fail("cluster libs not loaded");
      const noFp = { strict: null, signature: null };
      const pinned = titlePairs.filter((p) => p.kind !== undefined);
      // At least three containment fire cases and three no-fire cases.
      expect(pinned.filter((p) => p.kind === "containment").length).toBeGreaterThanOrEqual(3);
      expect(pinned.filter((p) => p.kind === null).length).toBeGreaterThanOrEqual(3);
      const wrong: string[] = [];
      for (const [i, p] of pinned.entries()) {
        for (const [name, side] of [["legacy", legacy], ["port", port]] as const) {
          const r = side.score(noFp, noFp, [], [], p.tfidf, p.hours, { aTitle: p.a, bTitle: p.b });
          if ((r.components as Record<string, unknown>).headlineKind !== p.kind) {
            wrong.push(`${name} pair ${i}: kind ${String((r.components as Record<string, unknown>).headlineKind)} !== ${String(p.kind)}`);
          }
          if (Boolean((r.components as Record<string, unknown>).headlineLane) !== (p.kind !== null)) {
            wrong.push(`${name} pair ${i}: headlineLane does not follow kind`);
          }
        }
      }
      expect(wrong).toEqual([]);
    });

    it("headlineLane() and headlineOnlyScore() are byte-equivalent for every golden pair", () => {
      if (!legacy || !port) expect.fail("cluster libs not loaded");
      const mismatches: string[] = [];
      for (const [i, p] of titlePairs.entries()) {
        const lh = [legacy.headlineTokens(p.a), legacy.headlineTokens(p.b)] as const;
        const ph = [port.headlineTokens(p.a), port.headlineTokens(p.b)] as const;
        const lLane = legacy.headlineLane(lh[0], lh[1], p.hours);
        const pLane = port.headlineLane(ph[0], ph[1], p.hours);
        if (JSON.stringify(lLane) !== JSON.stringify(pLane)) {
          mismatches.push(`pair ${i}: lane ${JSON.stringify(lLane)} vs ${JSON.stringify(pLane)}`);
        }
        for (const slugs of [{}, { aSourceSlug: "sozcu", bSourceSlug: "haberler-com" }]) {
          const lo = legacy.headlineOnlyScore(lh[0], lh[1], p.hours, slugs);
          const po = port.headlineOnlyScore(ph[0], ph[1], p.hours, slugs);
          if (lo !== po) mismatches.push(`pair ${i}: headlineOnlyScore ${lo} vs ${po}`);
          // The member scan relies on this equality to rank a member like a seed.
          if (lLane.fired && lo <= 0) mismatches.push(`pair ${i}: fired lane scored ${lo}`);
          if (!lLane.fired && lo !== 0) mismatches.push(`pair ${i}: inert lane scored ${lo}`);
        }
      }
      expect(mismatches).toEqual([]);
    });

    it("titleTokens / headlineTokens agree on every corpus and golden title", () => {
      if (!legacy || !port) expect.fail("cluster libs not loaded");
      const titles = [
        ...articles.map((a) => a.title),
        ...titlePairs.flatMap((p) => [p.a, p.b]),
        "2026 bütçesi 1500 kişi",
        // Over-long titles are clipped identically on both sides, with a
        // numeral and a word straddling the cap.
        `Merkez Bankası faiz kararı ${"kelime ".repeat(60)}2026 sonkelimeler`,
        "a".repeat(299) + " bölünenkelime 2026",
        "ğ".repeat(500),
        null,
      ];
      for (const t of titles) {
        expect([...port.titleTokens(t, 4)].sort()).toEqual([...legacy.titleTokens(t, 4)].sort());
        const l = legacy.headlineTokens(t);
        const r = port.headlineTokens(t);
        expect([...r.tokens].sort()).toEqual([...l.tokens].sort());
        expect([...r.numbers].sort()).toEqual([...l.numbers].sort());
      }
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
