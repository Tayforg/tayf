import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { BuilderState } from "../../_helpers/supabase-fake";
import { CLUSTERS, LAVROV_FIDAN, type ClusterFixture } from "./content-twin-fixtures";

// Content-twin detector (migration 139, /admin/birlestir "Olası içerik ikizleri").
//
// Three layers, tested separately and then together on LABELLED real pairs:
//   1. isContentTwinCandidate: the TypeScript mirror of the SQL pre-filter (title
//      word stems, 6 h window). Its constants are pinned against the migration in
//      tests/migrations/139-content-twin-candidates.test.ts.
//   2. rescoreContentPairs: the clustering ensemble (scripts/lib/cluster) re-scores
//      each candidate; only pairs at or above MATCH_THRESHOLD are listed.
//   3. getContentTwinPairs: the reader the page calls (one rpc, dismissals, refs).
//
// The labelled fixtures are verbatim production rows (tests/lib/admin/content-twin-fixtures.ts).
// A merge pair that misses is NOT fixed by tuning the scorer: it sits in KNOWN_MISSES
// below, asserted to stay a miss, with its numbers, so a later change that starts to
// catch it fails this file loudly and the list gets updated on purpose.

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

interface Res {
  data: unknown;
  error: { message: string } | null;
}

const log = vi.hoisted(() => ({ states: [] as BuilderState[] }));

const fx = vi.hoisted(() => ({
  rpc: { data: [], error: null } as Res,
  rpcThrows: null as Error | null,
  dismissals: { data: [], error: null } as Res,
  clusters: { data: [], error: null } as Res,
  headlines: [] as unknown[],
  headlinesError: null as { message: string } | null,
  createThrows: false,
}));

const fake = await vi.hoisted(async () => {
  const helper = await import("../../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    rpc: {
      admin_content_twin_pairs: () => {
        if (fx.rpcThrows) throw fx.rpcThrows;
        return fx.rpc;
      },
    },
    tables: {
      cluster_merge_dismissals: (s) => {
        log.states.push(s);
        return fx.dismissals;
      },
      clusters: (s) => {
        log.states.push(s);
        return fx.clusters;
      },
      cluster_articles: (s) => {
        log.states.push(s);
        if (fx.headlinesError) return { data: null, error: fx.headlinesError };
        const from = s.range?.from ?? 0;
        const to = s.range?.to ?? fx.headlines.length - 1;
        return { data: fx.headlines.slice(from, to + 1), error: null };
      },
    },
  });
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => {
    if (fx.createThrows) throw new Error("no client");
    return fake.client;
  },
}));

import {
  CONTENT_TWIN,
  CONTENT_TWIN_GENERIC_STEMS,
  CONTENT_TWIN_LANE_LABEL,
  candidateStems,
  excludeKeys,
  formatContentTwinDetail,
  getContentTwinPairs,
  isContentTwinCandidate,
  stemOverlap,
} from "@/lib/admin/content-twins";
import { foldTr } from "@/lib/clusters/turkish-query";
import { MATCH_THRESHOLD, rescoreContentPairs } from "../../../scripts/lib/content-twin-rescore.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Side {
  id: string;
  title: string;
  summary: string;
  firstPublished: string;
  articleCount?: number;
}

/** An RPC-shaped row for two sides; ids are ordered a < b like the SQL does. */
function rpcRow(x: Side, y: Side, over: Record<string, unknown> = {}) {
  const [a, b] = x.id < y.id ? [x, y] : [y, x];
  const o = stemOverlap(a.title, b.title);
  return {
    cluster_a: a.id,
    cluster_b: b.id,
    title_a: a.title,
    title_b: b.title,
    summary_a: a.summary,
    summary_b: b.summary,
    published_a: a.firstPublished,
    published_b: b.firstPublished,
    article_count_a: a.articleCount ?? 5,
    article_count_b: b.articleCount ?? 5,
    shared_stems: o.shared,
    jaccard: o.jaccard,
    ...over,
  };
}

const fxc = (prefix: string): ClusterFixture => {
  const c = CLUSTERS[prefix];
  if (!c) throw new Error(`no fixture ${prefix}`);
  return c;
};

const hoursBetween = (x: string, y: string) => Math.abs(Date.parse(x) - Date.parse(y)) / 3_600_000;

function clusterRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title_tr: `tr ${id.slice(-1)}`,
    title_tr_neutral: null,
    article_count: 5,
    first_published: "2026-11-01T10:00:00Z",
    bias_distribution: null,
    is_blindspot: false,
    is_archived: false,
    merged_into: null,
    ...over,
  };
}

function statesOf(table: string) {
  return log.states.filter((s) => s.table === table);
}

// ---------------------------------------------------------------------------
// 1. The SQL pre-filter, mirrored
// ---------------------------------------------------------------------------

describe("CONTENT_TWIN constants", () => {
  it("states the clamp, window and stem parameters in one place", () => {
    expect(CONTENT_TWIN.windowHours).toBe(6);
    expect(CONTENT_TWIN.stemLen).toBe(5);
    expect(CONTENT_TWIN.tokenMinLen).toBe(4);
    expect(CONTENT_TWIN.defaultHours).toBe(48);
    expect(CONTENT_TWIN.maxHours).toBe(168);
    expect(CONTENT_TWIN.defaultLimit).toBe(50);
    expect(CONTENT_TWIN.maxLimit).toBe(100);
    expect(Number.isInteger(CONTENT_TWIN.minSharedStems)).toBe(true);
    expect(CONTENT_TWIN.minJaccard).toBeGreaterThan(0);
    expect(CONTENT_TWIN.minJaccard).toBeLessThan(1);
  });

  it("keeps the generic-stem list short, unique, folded, stem-length and free of named entities", () => {
    expect(CONTENT_TWIN_GENERIC_STEMS.length).toBeLessThanOrEqual(25);
    expect(new Set(CONTENT_TWIN_GENERIC_STEMS).size).toBe(CONTENT_TWIN_GENERIC_STEMS.length);
    for (const s of CONTENT_TWIN_GENERIC_STEMS) {
      expect(s).toMatch(/^[a-z0-9]+$/);
      expect(s.length).toBeGreaterThanOrEqual(CONTENT_TWIN.tokenMinLen);
      expect(s.length).toBeLessThanOrEqual(CONTENT_TWIN.stemLen);
    }
    // Named entities carry story identity: they must never be filtered out.
    for (const entity of ["erdog", "israi", "trump", "istan", "ankar", "bahce", "ozel", "iran", "turki", "zelen"]) {
      expect(CONTENT_TWIN_GENERIC_STEMS).not.toContain(entity);
    }
  });
});

describe("candidateStems (mirror of the SQL stem rule)", () => {
  it("folds Turkish letters, keeps words of 4+ letters and cuts them to 5 characters", () => {
    expect([...candidateStems("Bahçeli'den ÇIKIŞ")].sort()).toEqual(["bahce", "cikis"]);
    // "İstanbul'a" -> istanbul + a: the one-letter suffix is dropped, the stem is istan.
    expect([...candidateStems("İstanbul'a geldi")].sort()).toEqual(["geldi", "istan"]);
  });

  it("drops words shorter than 4 letters before cutting, and digits-only words of 3 or fewer", () => {
    expect([...candidateStems("SPK ile bir 39 kişi")]).toEqual(["kisi"]);
    expect([...candidateStems("2026 yılı")].sort()).toEqual(["2026", "yili"]);
  });

  it("is distinct: two words with the same first five letters give one stem", () => {
    expect([...candidateStems("Belediyesi Belediyesine belediyede")]).toEqual(["beled"]);
  });

  it("excludes the generic stems entirely", () => {
    const generic = CONTENT_TWIN_GENERIC_STEMS[0] as string;
    expect(candidateStems(`${generic} yeni gelişme`).has(generic)).toBe(false);
    expect([...candidateStems("Son dakika: canlı yayın")].sort()).toEqual(["yayin"]);
  });

  it("returns an empty set for null, undefined, empty and non-string input", () => {
    for (const v of [null, undefined, "", "   ", 42 as unknown as string, {} as unknown as string]) {
      expect(candidateStems(v).size).toBe(0);
    }
  });

  it("handles emoji, punctuation runs and SQL characters without throwing", () => {
    expect([...candidateStems("🔥🔥 Erdoğan!!! '; drop table clusters;-- %_")].sort()).toEqual([
      "clust",
      "drop",
      "erdog",
      "table",
    ]);
  });

  it("agrees with foldTr on the fold (the TypeScript twin of tayf_search_fold)", () => {
    const title = "İÇİŞLERİ Bakanı Şükrü Çağlar";
    const viaFold = new Set(
      foldTr(title)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= CONTENT_TWIN.tokenMinLen)
        .map((w) => w.slice(0, CONTENT_TWIN.stemLen))
        .filter((s) => !CONTENT_TWIN_GENERIC_STEMS.includes(s)),
    );
    expect(candidateStems(title)).toEqual(viaFold);
  });
});

describe("stemOverlap / isContentTwinCandidate", () => {
  const stems = (n: number, prefix = "kelm") => Array.from({ length: n }, (_, i) => `${prefix}${String.fromCharCode(97 + i)}`);
  const title = (words: string[]) => words.join(" ");

  it("reports shared, union and jaccard", () => {
    const o = stemOverlap("alpha bravo charlie delta", "alpha bravo charlie echoo");
    expect(o).toEqual({ shared: 3, union: 5, jaccard: 0.6 });
    expect(stemOverlap("", "alpha")).toEqual({ shared: 0, union: 1, jaccard: 0 });
    expect(stemOverlap("", "")).toEqual({ shared: 0, union: 0, jaccard: 0 });
  });

  it("accepts a pair exactly on both thresholds (boundary values)", () => {
    const min = CONTENT_TWIN.minSharedStems;
    // Build two titles whose shared count is exactly `min` and whose jaccard is exactly minJaccard
    // when possible, by padding each side with unique words.
    const shared = stems(min, "shar");
    const wantUnion = Math.floor(min / CONTENT_TWIN.minJaccard);
    const pad = wantUnion - min; // unique words, split across the two sides
    const left = [...shared, ...stems(Math.floor(pad / 2), "left")];
    const right = [...shared, ...stems(pad - Math.floor(pad / 2), "righ")];
    const o = stemOverlap(title(left), title(right));
    expect(o.shared).toBe(min);
    expect(o.jaccard).toBeGreaterThanOrEqual(CONTENT_TWIN.minJaccard);
    expect(isContentTwinCandidate(title(left), title(right), 1)).toBe(true);
  });

  it("rejects one shared stem short of the minimum, even with jaccard 1", () => {
    const words = stems(CONTENT_TWIN.minSharedStems - 1, "shar");
    expect(isContentTwinCandidate(title(words), title(words), 0)).toBe(false);
  });

  it("rejects a pair with enough shared stems but a jaccard just under the minimum", () => {
    const min = CONTENT_TWIN.minSharedStems;
    const shared = stems(min, "shar");
    // union one larger than the largest union that still passes.
    const unionOver = Math.floor(min / CONTENT_TWIN.minJaccard) + 1;
    const pad = unionOver - min;
    const left = [...shared, ...stems(pad, "left")];
    const o = stemOverlap(title(left), title(shared));
    expect(o.shared).toBe(min);
    expect(o.jaccard).toBeLessThan(CONTENT_TWIN.minJaccard);
    expect(isContentTwinCandidate(title(left), title(shared), 0)).toBe(false);
  });

  it("applies the 6 hour window inclusively and symmetrically", () => {
    const t = "alpha bravo charlie delta";
    expect(isContentTwinCandidate(t, t, 6)).toBe(true);
    expect(isContentTwinCandidate(t, t, 6.01)).toBe(false);
    expect(isContentTwinCandidate(t, t, -6)).toBe(true);
    expect(isContentTwinCandidate(t, t, -6.01)).toBe(false);
    expect(isContentTwinCandidate(t, t, 0)).toBe(true);
  });

  it("does not count generic stems as shared", () => {
    const g = CONTENT_TWIN_GENERIC_STEMS.slice(0, 6).join(" ");
    expect(isContentTwinCandidate(g, g, 0)).toBe(false);
  });

  it("is false for null/undefined/garbage titles and a non-finite delta", () => {
    expect(isContentTwinCandidate(null, null, 0)).toBe(false);
    expect(isContentTwinCandidate(undefined, "alpha bravo charlie delta", 0)).toBe(false);
    expect(isContentTwinCandidate("alpha bravo charlie delta", "alpha bravo charlie delta", Number.NaN)).toBe(false);
    expect(isContentTwinCandidate(1 as unknown as string, 2 as unknown as string, 0)).toBe(false);
  });

  it("survives a 10,000-word title", () => {
    const big = Array.from({ length: 10_000 }, (_, i) => `w${i.toString(36).padStart(4, "0")}`).join(" ");
    expect(isContentTwinCandidate(big, big, 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Labelled pairs through both stages
// ---------------------------------------------------------------------------

function sideOf(prefix: string): Side {
  const c = fxc(prefix);
  return { id: c.id, title: c.title, summary: c.summary, firstPublished: c.firstPublished, articleCount: c.articleCount };
}

/** MERGE pairs from the finding h12-cluster-4, in its order. */
const MERGE_PAIRS: [string, string][] = [
  ["f4c68960", "112a68bd"],
  ["144cfc04", "c5627cb9"],
  ["144cfc04", "9e83921e"],
  ["c5627cb9", "9e83921e"],
  ["71800f1c", "4e57766e"],
  ["8ab93bbd", "2c9941bd"],
];

/** Merge pairs that pass BOTH stages. */
const CAUGHT: [string, string][] = [["8ab93bbd", "2c9941bd"]];

/**
 * Merge pairs that do NOT reach the list. Not tuned away (the pre-filter constants
 * and the ensemble are fixed by the spec); each carries its numbers and the stage that
 * loses it. `rescored` is what the ensemble ALONE says in the shared batch, so the
 * table also shows how many of them the pre-filter, not the scorer, throws away.
 *
 *   stage "candidate": the SQL pre-filter (title stems, 6 h window) drops it.
 *   stage "rescore":   it is a candidate but the ensemble scores it under MATCH_THRESHOLD.
 *
 * At the spec's first choice (4 shared stems, Jaccard 0.6) none of the six is a
 * candidate; 126's 3 / 0.5 (used here) lets exactly one through.
 */
interface KnownMiss {
  pair: [string, string];
  stage: "candidate" | "rescore";
  why: string;
  shared: number;
  hoursApart: number;
  /** ensemble score computed in the shared batch (rescoreContentPairs), 2 decimals. */
  rescored: number;
  /** would the ensemble alone have listed it (rescored >= MATCH_THRESHOLD)? */
  rescoreMatch: boolean;
}

const KNOWN_MISSES: KnownMiss[] = [
  {
    pair: ["f4c68960", "112a68bd"],
    stage: "candidate",
    why: "titles share zelen/istan/geldi but differ in every other word: 3 of 8 stems, Jaccard 0.375",
    shared: 3,
    hoursApart: 0.5,
    rescored: 0.46,
    rescoreMatch: true,
  },
  {
    pair: ["144cfc04", "c5627cb9"],
    stage: "candidate",
    why: "opened 13.9 h apart (window 6 h) and the titles share only bahce/ilce; the ensemble also says 0.35",
    shared: 2,
    hoursApart: 13.9,
    rescored: 0.35,
    rescoreMatch: false,
  },
  {
    pair: ["144cfc04", "9e83921e"],
    stage: "candidate",
    why: "opened 15.7 h apart; 9e83921e was seeded by an unrelated milliyet article (age-verification scam) that carries a Bahçeli link blurb, so its title shares nothing",
    shared: 0,
    hoursApart: 15.7,
    rescored: 0.21,
    rescoreMatch: false,
  },
  {
    pair: ["c5627cb9", "9e83921e"],
    stage: "candidate",
    why: "same mis-seeded title as above: zero shared stems although the clusters tell one story",
    shared: 0,
    hoursApart: 1.9,
    rescored: 0.41,
    rescoreMatch: true,
  },
  {
    pair: ["71800f1c", "4e57766e"],
    stage: "candidate",
    why: "one title is the appointment decree, the other a 'Muhsin Atcı kimdir' explainer: 2 shared stems of 15, Jaccard 0.13",
    shared: 2,
    hoursApart: 0,
    rescored: 0.53,
    rescoreMatch: true,
  },
];

/** STAY SPLIT: different stories (or stages of one story); the list must not offer them. */
interface StayCase {
  name: string;
  a: Side;
  b: Side;
}

const stayCases: StayCase[] = [
  {
    name: "Bakırköy '40 tutuklama talebi' vs '39 kişi tutuklandı' (the cluster.test.ts titles, 1 h apart)",
    a: {
      id: "bbbbbbb1-0000-4000-8000-000000000001",
      title: "Bakırköy Belediyesi soruşturmasında 40 tutuklama talebi",
      summary: fxc("74356e37").summary,
      firstPublished: "2026-10-30T17:02:50.000Z",
    },
    b: {
      id: "bbbbbbb2-0000-4000-8000-000000000002",
      title: "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı",
      summary: fxc("d18e801f").summary,
      firstPublished: "2026-10-30T18:02:50.000Z",
    },
  },
  {
    name: "Bakırköy request cluster 74356e37 vs verdict cluster e7090671 (real rows, 13.9 h apart)",
    a: sideOf("74356e37"),
    b: sideOf("e7090671"),
  },
  {
    name: "Lavrov vs Fidan-Motegi (ensemble-precision fixtures, 1.25 h apart)",
    a: {
      id: "bbbbbbb3-0000-4000-8000-000000000003",
      title: LAVROV_FIDAN.lavrov.title,
      summary: LAVROV_FIDAN.lavrov.summary,
      firstPublished: LAVROV_FIDAN.lavrov.publishedAt,
    },
    b: {
      id: "bbbbbbb4-0000-4000-8000-000000000004",
      title: LAVROV_FIDAN.fidan.title,
      summary: LAVROV_FIDAN.fidan.summary,
      firstPublished: LAVROV_FIDAN.fidan.publishedAt,
    },
  },
];

const pairKey = (p: [string, string]) => p.join("+");

describe("labelled pairs through the SQL pre-filter and the ensemble", () => {
  // One batch, like the page: a single TfidfIndex over every distinct seed document.
  const mergeRows = MERGE_PAIRS.map(([x, y]) => rpcRow(sideOf(x), sideOf(y)));
  const stayRows = stayCases.map((c) => rpcRow(c.a, c.b));
  const scored = rescoreContentPairs([...mergeRows, ...stayRows]);
  const mergeScores = scored.slice(0, mergeRows.length);
  const stayScores = scored.slice(mergeRows.length);

  const candidateOf = (row: ReturnType<typeof rpcRow>) =>
    isContentTwinCandidate(
      row.title_a,
      row.title_b,
      hoursBetween(row.published_a, row.published_b),
    );

  it("lists the labelled MERGE pairs that pass both stages", () => {
    for (const p of CAUGHT) {
      const i = MERGE_PAIRS.findIndex((m) => pairKey(m) === pairKey(p));
      expect(i, `pair ${pairKey(p)} is in MERGE_PAIRS`).toBeGreaterThanOrEqual(0);
      const row = mergeRows[i] as ReturnType<typeof rpcRow>;
      const s = mergeScores[i] as (typeof scored)[number];
      expect(candidateOf(row), `${pairKey(p)} candidate`).toBe(true);
      expect(s.isMatch, `${pairKey(p)} score ${s.score.toFixed(3)} lane ${s.lane}`).toBe(true);
      expect(s.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    }
  });

  it("every MERGE pair is either caught or an explicit KNOWN_MISS (nothing silently missing)", () => {
    const accounted = new Set([...CAUGHT, ...KNOWN_MISSES.map((k) => k.pair)].map(pairKey));
    expect([...accounted].sort()).toEqual(MERGE_PAIRS.map(pairKey).sort());
  });

  it("KNOWN_MISSES stay missed, at the recorded stage, with the recorded numbers", () => {
    for (const k of KNOWN_MISSES) {
      const i = MERGE_PAIRS.findIndex((m) => pairKey(m) === pairKey(k.pair));
      const row = mergeRows[i] as ReturnType<typeof rpcRow>;
      const s = mergeScores[i] as (typeof scored)[number];
      const candidate = candidateOf(row);
      expect(row.shared_stems, `${pairKey(k.pair)} shared stems`).toBe(k.shared);
      expect(Number(s.hoursApart.toFixed(1)), `${pairKey(k.pair)} hours apart`).toBe(k.hoursApart);
      expect(Number(s.score.toFixed(2)), `${pairKey(k.pair)} rescored`).toBe(k.rescored);
      expect(s.isMatch, `${pairKey(k.pair)} would the ensemble alone list it`).toBe(k.rescoreMatch);
      if (k.stage === "candidate") {
        expect(candidate, `${pairKey(k.pair)} (${k.why}) must be dropped by the pre-filter`).toBe(false);
      } else {
        expect(candidate, `${pairKey(k.pair)} must be a candidate`).toBe(true);
        expect(k.rescoreMatch, `${pairKey(k.pair)} (${k.why}) must score under the threshold`).toBe(false);
      }
    }
  });

  it("the STAY-SPLIT pairs never reach the list: dropped by the pre-filter or the ensemble", () => {
    for (const [i, c] of stayCases.entries()) {
      const row = stayRows[i] as ReturnType<typeof rpcRow>;
      const s = stayScores[i] as (typeof scored)[number];
      const listed = candidateOf(row) && s.isMatch;
      expect(listed, `${c.name}: candidate=${candidateOf(row)} score=${s.score.toFixed(3)} lane=${s.lane}`).toBe(false);
    }
  });

  it("the textual Bakırköy pair is a SQL candidate (shared stems) and the ensemble is what stops it", () => {
    const row = stayRows[0] as ReturnType<typeof rpcRow>;
    const s = stayScores[0] as (typeof scored)[number];
    expect(candidateOf(row)).toBe(true);
    expect(s.isMatch).toBe(false);
    expect(s.lane).toBe("primary");
  });
});

// ---------------------------------------------------------------------------
// 3. rescoreContentPairs on its own
// ---------------------------------------------------------------------------

describe("rescoreContentPairs", () => {
  const base = {
    cluster_a: A,
    cluster_b: B,
    title_a: "Erdoğan Zelenski'yi kabul etti",
    title_b: "Erdoğan, Zelenskiy'i kabul etti",
    summary_a: "",
    summary_b: "",
    published_a: "2026-11-01T10:00:00Z",
    published_b: "2026-11-01T10:30:00Z",
  };

  it("returns [] for null, undefined and an empty list", () => {
    expect(rescoreContentPairs(null)).toEqual([]);
    expect(rescoreContentPairs(undefined)).toEqual([]);
    expect(rescoreContentPairs([])).toEqual([]);
  });

  it("is parallel to the input and reports hoursApart, lane and isMatch", () => {
    const out = rescoreContentPairs([base, { ...base, cluster_a: A, cluster_b: C }]);
    expect(out).toHaveLength(2);
    expect(out[0]?.clusterA).toBe(A);
    expect(out[0]?.clusterB).toBe(B);
    expect(out[1]?.clusterB).toBe(C);
    expect(out[0]?.hoursApart).toBeCloseTo(0.5, 6);
    expect(out[0]?.isMatch).toBe(true);
    expect(out[0]?.lane).toBe("headline-jaccard");
    expect(out[0]?.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it("names the autoAccept lane for identical text (strict fingerprint)", () => {
    const text = {
      title_a: "Merkez Bankası faiz kararını açıkladı",
      title_b: "Merkez Bankası faiz kararını açıkladı",
      summary_a: "Para Politikası Kurulu politika faizini sabit tuttu.",
      summary_b: "Para Politikası Kurulu politika faizini sabit tuttu.",
    };
    const [r] = rescoreContentPairs([{ ...base, ...text }]);
    expect(r?.lane).toBe("autoAccept");
    expect(r?.score).toBe(1);
  });

  it("names the primary lane for unrelated stories and scores them under the threshold", () => {
    const [r] = rescoreContentPairs([
      {
        ...base,
        title_a: "Merkez Bankası faiz kararını açıkladı",
        title_b: "Galatasaray Fenerbahçe derbisini kazandı",
        summary_a: "Para Politikası Kurulu politika faizini sabit tuttu.",
        summary_b: "Sarı kırmızılılar sahasında üç puanı aldı.",
      },
    ]);
    expect(r?.lane).toBe("primary");
    expect(r?.isMatch).toBe(false);
  });

  it("names the live-title lane for the same live-blog title", () => {
    const live = "CANLI | Son dakika";
    const [r] = rescoreContentPairs([{ ...base, title_a: live, title_b: live, summary_a: "a", summary_b: "b" }]);
    expect(["live-title", "autoAccept"]).toContain(r?.lane);
  });

  it("scores a pair with an unreadable date or missing ids as 0 and not a match", () => {
    const out = rescoreContentPairs([
      { ...base, published_b: "nope" },
      { ...base, cluster_b: "" },
      { ...base, cluster_b: A },
      null as never,
    ]);
    for (const r of out) {
      expect(r.score).toBe(0);
      expect(r.isMatch).toBe(false);
    }
  });

  it("is deterministic: the same rows give the same scores", () => {
    const rows = MERGE_PAIRS.map(([x, y]) => rpcRow(sideOf(x), sideOf(y)));
    const first = rescoreContentPairs(rows).map((r) => r.score);
    const second = rescoreContentPairs(rows).map((r) => r.score);
    expect(second).toEqual(first);
  });

  it("builds ONE index over every distinct document: a cluster in two rows is one document", () => {
    const one = rescoreContentPairs([base]);
    const two = rescoreContentPairs([base, { ...base, cluster_b: C, title_b: "Bambaşka bir haber metni burada" }]);
    expect(two[0]?.components.tfidfScore).not.toBe(undefined);
    expect(one).toHaveLength(1);
    expect(two).toHaveLength(2);
  });

  it("copes with 10,000 pairs without throwing", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      ...base,
      cluster_a: `a-${i}`,
      cluster_b: `b-${i}`,
      title_a: `Haber başlığı numara ${i} ilçe`,
      title_b: `Haber başlığı numara ${i} ilçe`,
    }));
    const out = rescoreContentPairs(rows);
    expect(out).toHaveLength(10_000);
  });
});

// ---------------------------------------------------------------------------
// 4. Detail text, lane labels and the dedupe
// ---------------------------------------------------------------------------

describe("formatContentTwinDetail", () => {
  it("renders the documented example", () => {
    expect(formatContentTwinDetail({ score: 0.62, lane: "headline-jaccard", hoursApart: 0.4, sharedStems: 5 })).toBe(
      "Puan 0,62 · başlıklar neredeyse aynı · 24 dk arayla · 5 ortak kelime kökü",
    );
  });

  it("shows minutes under one hour and tr-TR decimals from one hour on", () => {
    const d = (h: number) => formatContentTwinDetail({ score: 0.5, lane: "primary", hoursApart: h, sharedStems: 4 });
    expect(d(0.5)).toContain("30 dk arayla");
    expect(d(1.5)).toContain("1,5 saat arayla");
    expect(d(1)).toContain("1 saat arayla");
    expect(d(6)).toContain("6 saat arayla");
    expect(d(0)).toContain("0 dk arayla");
    // 59.7 minutes rounds to 60: one hour, never "60 dk".
    expect(d(59.7 / 60)).toContain("1 saat arayla");
    expect(d(59.7 / 60)).not.toContain("60 dk");
  });

  it("rounds the score to two tr-TR decimals", () => {
    const d = (s: number) => formatContentTwinDetail({ score: s, lane: "primary", hoursApart: 1, sharedStems: 3 });
    expect(d(0.4)).toMatch(/^Puan 0,40 /);
    expect(d(1)).toMatch(/^Puan 1,00 /);
    expect(d(0.4049)).toMatch(/^Puan 0,40 /);
    expect(d(0.405)).toMatch(/^Puan 0,4[01] /);
  });

  it("labels every lane in natural Turkish", () => {
    expect(CONTENT_TWIN_LANE_LABEL).toEqual({
      autoAccept: "aynı metin (parmak izi)",
      "headline-jaccard": "başlıklar neredeyse aynı",
      "headline-containment": "kısa başlık uzununun içinde",
      "live-title": "aynı canlı yayın başlığı",
      minhash: "metin örtüşmesi",
      primary: "metin ve özne benzerliği",
    });
  });

  it("falls back to 0 for non-finite inputs instead of printing NaN", () => {
    const text = formatContentTwinDetail({ score: Number.NaN, lane: "primary", hoursApart: Number.NaN, sharedStems: Number.NaN });
    expect(text).not.toMatch(/NaN|undefined|Infinity/);
  });
});

describe("excludeKeys", () => {
  const rows = [{ key: "a:b" }, { key: "c:d" }, { key: "e:f" }];

  it("drops rows whose key is in any of the given sets, keeping order", () => {
    expect(excludeKeys(rows, new Set(["c:d"]), new Set(["e:f"]))).toEqual([{ key: "a:b" }]);
  });

  it("returns null for null (an unreadable list stays unreadable) and a copy otherwise", () => {
    expect(excludeKeys(null, new Set(["a:b"]))).toBeNull();
    const out = excludeKeys(rows);
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });

  it("accepts arrays as the key collections", () => {
    expect(excludeKeys(rows, ["a:b"])).toEqual([{ key: "c:d" }, { key: "e:f" }]);
  });
});

// Two clusters that carry the same story: identical title and summary => identical strict
// fingerprint => the autoAccept lane, score 1.
const TWIN_TITLE = "Zelenski İstanbul'a geldi, Erdoğan ile görüşecek";
const TWIN_SUMMARY = "Ukrayna Devlet Başkanı Zelenski İstanbul'a geldi ve Erdoğan ile görüşecek.";
const twinA: Side = {
  id: A,
  title: TWIN_TITLE,
  summary: TWIN_SUMMARY,
  firstPublished: "2026-11-01T10:00:00.000Z",
  articleCount: 3,
};
const twinB: Side = {
  id: B,
  title: TWIN_TITLE,
  summary: TWIN_SUMMARY,
  firstPublished: "2026-11-01T10:24:00.000Z",
  articleCount: 9,
};

// ---------------------------------------------------------------------------
// 5. getContentTwinPairs
// ---------------------------------------------------------------------------

describe("getContentTwinPairs", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    log.states.length = 0;
    fake.calls.rpc.length = 0;
    fx.rpc = { data: [], error: null };
    fx.rpcThrows = null;
    fx.dismissals = { data: [], error: null };
    fx.clusters = {
      data: [
        clusterRow(A, { article_count: 3 }),
        clusterRow(B, { article_count: 9 }),
        clusterRow(C, { article_count: 4 }),
      ],
      error: null,
    };
    fx.headlines = [];
    fx.headlinesError = null;
    fx.createThrows = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls exactly one rpc, admin_content_twin_pairs, with { p_hours: 48, p_limit: 50 }, and writes nothing", async () => {
    fx.rpc = { data: [rpcRow(twinA, twinB)], error: null };
    await getContentTwinPairs();
    expect(fake.calls.rpc).toHaveLength(1);
    expect(fake.calls.rpc[0]?.name).toBe("admin_content_twin_pairs");
    expect(fake.calls.rpc[0]?.args).toEqual({ p_hours: 48, p_limit: 50 });
    expect(fake.calls.mutations).toEqual([]);
  });

  it("builds a row: key, refs in id order, origin content, evidence and the larger cluster as default target", async () => {
    fx.rpc = { data: [rpcRow(twinB, twinA)], error: null };
    const rows = await getContentTwinPairs();
    expect(rows).toHaveLength(1);
    const r = rows![0]!;
    expect(r.key).toBe(`${A}:${B}`);
    expect(r.a.id).toBe(A);
    expect(r.b.id).toBe(B);
    expect(r.origin).toBe("content");
    expect(r.lane).toBe("autoAccept");
    expect(r.score).toBe(1);
    expect(r.hoursApart).toBeCloseTo(0.4, 6);
    expect(r.sharedStems).toBeGreaterThanOrEqual(CONTENT_TWIN.minSharedStems);
    expect(r.detail).toBe(
      `Puan 1,00 · aynı metin (parmak izi) · 24 dk arayla · ${r.sharedStems} ortak kelime kökü`,
    );
    expect(r.defaultTargetId).toBe(B);
  });

  it("keeps only pairs the ensemble accepts", async () => {
    const stay = stayCases[0] as StayCase;
    fx.rpc = { data: [rpcRow(twinA, twinB), rpcRow(stay.a, stay.b)], error: null };
    fx.clusters = {
      data: [clusterRow(A), clusterRow(B), clusterRow(stay.a.id), clusterRow(stay.b.id)],
      error: null,
    };
    const rows = await getContentTwinPairs();
    expect(rows!.map((r) => r.key)).toEqual([`${A}:${B}`]);
  });

  it("sorts by score, highest first", async () => {
    // Identical text scores 1; the SPK pair (real rows) scores lower but above the threshold.
    const spkA = sideOf("71800f1c");
    const spkB = sideOf("4e57766e");
    fx.rpc = { data: [rpcRow(spkA, spkB), rpcRow(twinA, twinB)], error: null };
    fx.clusters = {
      data: [clusterRow(A), clusterRow(B), clusterRow(spkA.id), clusterRow(spkB.id)],
      error: null,
    };
    const rows = await getContentTwinPairs();
    expect(rows!.map((r) => r.key)).toEqual([`${A}:${B}`, [spkA.id, spkB.id].sort().join(":")]);
    expect(rows![0]!.score).toBeGreaterThan(rows![1]!.score);
  });

  it("drops a pair listed in cluster_merge_dismissals (read only, keyed a:b)", async () => {
    fx.rpc = { data: [rpcRow(twinA, twinB)], error: null };
    fx.dismissals = { data: [{ cluster_a: A, cluster_b: B }], error: null };
    expect(await getContentTwinPairs()).toEqual([]);
    const [d] = statesOf("cluster_merge_dismissals");
    expect(d!.in).toEqual([{ col: "cluster_a", vals: expect.arrayContaining([A, B]) }]);
    expect(fake.calls.mutations).toEqual([]);
  });

  it("skips a pair whose cluster is archived, merged into another, or missing", async () => {
    const mk = (over: Record<string, unknown>) => {
      fx.rpc = { data: [rpcRow(twinA, twinB)], error: null };
      fx.clusters = { data: [clusterRow(A), clusterRow(B, over)], error: null };
    };
    mk({ is_archived: true });
    expect(await getContentTwinPairs()).toEqual([]);
    mk({ merged_into: A });
    expect(await getContentTwinPairs()).toEqual([]);
    fx.clusters = { data: [clusterRow(A)], error: null };
    expect(await getContentTwinPairs()).toEqual([]);
  });

  it("de-duplicates a pair the rpc returned twice, in either id order", async () => {
    const r = rpcRow(twinA, twinB);
    const swapped = {
      ...r,
      cluster_a: r.cluster_b,
      cluster_b: r.cluster_a,
      title_a: r.title_b,
      title_b: r.title_a,
      summary_a: r.summary_b,
      summary_b: r.summary_a,
      published_a: r.published_b,
      published_b: r.published_a,
      article_count_a: r.article_count_b,
      article_count_b: r.article_count_a,
    };
    fx.rpc = { data: [r, swapped, r], error: null };
    const rows = await getContentTwinPairs();
    expect(rows).toHaveLength(1);
    expect(rows![0]!.key).toBe(`${A}:${B}`);
  });

  it("ignores malformed rpc rows (null, missing ids, same id twice, non-array)", async () => {
    fx.rpc = { data: [null, {}, { cluster_a: A, cluster_b: A }, 7, rpcRow(twinA, twinB)], error: null };
    expect((await getContentTwinPairs())!.map((r) => r.key)).toEqual([`${A}:${B}`]);
    fx.rpc = { data: { not: "an array" }, error: null };
    expect(await getContentTwinPairs()).toEqual([]);
    fx.rpc = { data: null, error: null };
    expect(await getContentTwinPairs()).toEqual([]);
  });

  it("returns [] for an empty rpc result without reading anything else", async () => {
    expect(await getContentTwinPairs()).toEqual([]);
    expect(log.states).toEqual([]);
  });

  it("returns null, never throws, on an rpc error (139 not applied)", async () => {
    fx.rpc = { data: null, error: { message: "Could not find the function public.admin_content_twin_pairs" } };
    expect(await getContentTwinPairs()).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it("returns null when the rpc throws, the client cannot be created, or a read fails", async () => {
    fx.rpcThrows = new Error("socket hang up");
    expect(await getContentTwinPairs()).toBeNull();
    fx.rpcThrows = null;
    fx.createThrows = true;
    expect(await getContentTwinPairs()).toBeNull();
    fx.createThrows = false;
    fx.rpc = { data: [rpcRow(twinA, twinB)], error: null };
    fx.dismissals = { data: null, error: { message: "boom" } };
    expect(await getContentTwinPairs()).toBeNull();
    fx.dismissals = { data: [], error: null };
    fx.headlinesError = { message: "headline boom" };
    expect(await getContentTwinPairs()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. scripts/content-twin-dryrun.mjs --input
// ---------------------------------------------------------------------------

describe("scripts/content-twin-dryrun.mjs --input", () => {
  const script = resolve(__dirname, "../../../scripts/content-twin-dryrun.mjs");

  it("prints the candidate count, the passing count and a table, from a JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "content-twin-"));
    try {
      const file = join(dir, "rows.json");
      const stay = stayCases[0] as StayCase;
      writeFileSync(file, JSON.stringify([rpcRow(twinA, twinB), rpcRow(stay.a, stay.b)]));
      const out = execFileSync(process.execPath, [script, "--input", file], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      });
      expect(out).toMatch(/^candidates:\s*2$/im);
      expect(out).toMatch(/^passing the rescorer:\s*1\b/im);
      expect(out).toContain(TWIN_TITLE.slice(0, 30));
      expect(out).toMatch(/autoAccept/);
      // the stay-split pair is not in the table of passing pairs
      expect(out).not.toContain("39 kişi tutuklandı");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero with a usage line when neither --input nor --rpc is given", () => {
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [script], { encoding: "utf8", stdio: "pipe", env: { PATH: process.env.PATH ?? "" } });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      status = err.status ?? 1;
      stderr = err.stderr ?? "";
    }
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/--input|--rpc/);
  });
});
