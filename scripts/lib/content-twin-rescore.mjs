// scripts/lib/content-twin-rescore.mjs
//
// Pure re-scoring core of the content-twin detector (migration 139,
// /admin/birlestir "Olası içerik ikizleri", scripts/content-twin-dryrun.mjs).
//
// WHY HERE. The SQL function admin_content_twin_pairs() is only a cheap
// pre-filter: two live clusters opened within 6 hours of each other whose seed
// titles share enough word stems. Whether such a pair is really one story is the
// clustering scorer's job, so each pair is re-scored with the SAME scorer the
// consumer and the audit use: scripts/lib/cluster/ensemble.mjs, the byte-parity
// Node mirror of supabase/functions/_shared/cluster (tests/functions/_shared/
// cluster.test.ts pins the parity). The Deno copy is not imported because its
// imports end in ".ts" (TS5097 under the app's tsconfig).
//
// HOW. scripts/lib/audit/report.mjs scorePair is the template; the one change is
// that the two seed titles ARE passed to score(), so the headline lane and the
// subject veto run (report.mjs leaves them out). A "document" is one cluster's
// seed text: title + ' ' + summary. One TfidfIndex is built over every distinct
// document of the batch, fingerprint() and extractEntities() run per document.
//
// No I/O, no Date.now(), no randomness: the same rows always give the same
// scores. Nothing here writes or merges anything.

import { extractEntities } from "./cluster/entities.mjs";
import { fingerprint } from "./cluster/fingerprint.mjs";
import { TfidfIndex } from "./cluster/tfidf.mjs";
import { score } from "./cluster/ensemble.mjs";
import { MATCH_THRESHOLD } from "./cluster/constants.mjs";

/**
 * One row of admin_content_twin_pairs(), as PostgREST returns it. Only the
 * fields the scorer reads are required.
 * @typedef {object} ContentPairInput
 * @property {string} cluster_a
 * @property {string} cluster_b
 * @property {string | null | undefined} title_a
 * @property {string | null | undefined} title_b
 * @property {string | null | undefined} summary_a
 * @property {string | null | undefined} summary_b
 * @property {string | number | Date | null | undefined} published_a
 * @property {string | number | Date | null | undefined} published_b
 */

/**
 * Which part of the ensemble decided the score.
 *   autoAccept          identical strict fingerprints (same text)
 *   headline-jaccard    headline lane, token Jaccard (or the short-identical variant)
 *   headline-containment headline lane, the shorter title inside the longer one
 *   live-title          headline lane, the same live-blog title
 *   minhash             the MinHash ceiling beat the primary lane
 *   primary             0.35 * tf-idf + 0.65 * entity overlap
 * @typedef {"autoAccept" | "headline-jaccard" | "headline-containment" | "live-title" | "minhash" | "primary"} ContentTwinLane
 */

/**
 * @typedef {object} ContentPairScore
 * @property {string} clusterA
 * @property {string} clusterB
 * @property {number} score        final ensemble score (0 when the pair cannot be scored)
 * @property {boolean} isMatch     score >= MATCH_THRESHOLD
 * @property {number} hoursApart   |first_published delta| in hours (NaN when a date is unreadable)
 * @property {ContentTwinLane} lane
 * @property {Record<string, unknown>} components  the scorer's components (empty when not scored)
 */

export { MATCH_THRESHOLD };

/** @param {unknown} v @returns {string} */
function text(v) {
  return typeof v === "string" ? v.trim() : "";
}

/** @param {unknown} v @returns {number} epoch ms, NaN when unreadable */
function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Date.parse(v);
  return NaN;
}

/**
 * The seed document of one cluster: title, a space, summary.
 * @param {unknown} title
 * @param {unknown} summary
 * @returns {string}
 */
export function seedDoc(title, summary) {
  return `${text(title)} ${text(summary)}`.trim();
}

/**
 * Names the lane that produced `components.raw`, in the order the scorer
 * applies them: strict fingerprint, headline lane, then whichever of the
 * MinHash and primary lanes was the larger.
 * @param {Record<string, unknown>} components
 * @returns {ContentTwinLane}
 */
export function laneOf(components) {
  if (components.autoAccept === true) return "autoAccept";
  if (components.headlineLane === true) {
    if (components.headlineKind === "containment") return "headline-containment";
    if (components.headlineKind === "live-title") return "live-title";
    return "headline-jaccard";
  }
  const raw = Number(components.raw);
  const jaccardScore = Number(components.jaccardScore);
  const primary = Number(components.primary);
  // The text floor caps `primary` just under the threshold when tf-idf is low.
  const primaryForRaw =
    components.textFloorCapped === true ? Math.min(primary, MATCH_THRESHOLD - 0.01) : primary;
  if (
    components.subjectVeto !== true &&
    Number.isFinite(jaccardScore) &&
    Math.abs(raw - jaccardScore) < 1e-9 &&
    jaccardScore > primaryForRaw
  ) {
    return "minhash";
  }
  return "primary";
}

/**
 * Re-scores every pair with the clustering ensemble. The result is parallel to
 * `rows` (same length, same order).
 *
 * @param {ReadonlyArray<ContentPairInput> | null | undefined} rows
 * @returns {ContentPairScore[]}
 */
export function rescoreContentPairs(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const docs = new Map();
  for (const r of rows) {
    if (r && text(r.cluster_a) && !docs.has(text(r.cluster_a))) {
      docs.set(text(r.cluster_a), seedDoc(r.title_a, r.summary_a));
    }
    if (r && text(r.cluster_b) && !docs.has(text(r.cluster_b))) {
      docs.set(text(r.cluster_b), seedDoc(r.title_b, r.summary_b));
    }
  }

  const tfidf = new TfidfIndex();
  const side = new Map();
  for (const [id, doc] of docs) {
    tfidf.addDoc(id, doc);
  }
  tfidf.finalize();

  /**
   * Fingerprint and entities are computed once per document, from the title and
   * the summary of the first row that mentions the cluster.
   * @param {string} id
   * @param {unknown} title
   * @param {unknown} summary
   */
  const sideOf = (id, title, summary) => {
    let s = side.get(id);
    if (!s) {
      const t = text(title);
      const sm = text(summary);
      s = { title: t, fp: fingerprint(t, sm), entities: extractEntities(`${t} ${sm}`) || [] };
      side.set(id, s);
    }
    return s;
  };

  return rows.map((r) => {
    const clusterA = text(r?.cluster_a);
    const clusterB = text(r?.cluster_b);
    const hoursApart = Math.abs(toMs(r?.published_a) - toMs(r?.published_b)) / 3_600_000;
    if (!r || !clusterA || !clusterB || clusterA === clusterB || !Number.isFinite(hoursApart)) {
      return { clusterA, clusterB, score: 0, isMatch: false, hoursApart, lane: "primary", components: {} };
    }
    const a = sideOf(clusterA, r.title_a, r.summary_a);
    const b = sideOf(clusterB, r.title_b, r.summary_b);
    const res = score(a.fp, b.fp, a.entities, b.entities, tfidf.cosine(clusterA, clusterB), hoursApart, {
      aTitle: a.title,
      bTitle: b.title,
    });
    return {
      clusterA,
      clusterB,
      score: res.score,
      isMatch: res.score >= MATCH_THRESHOLD,
      hoursApart,
      lane: laneOf(res.components),
      components: res.components,
    };
  });
}
