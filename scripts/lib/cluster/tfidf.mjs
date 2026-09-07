// scripts/lib/cluster/tfidf.mjs
//
// Minimal in-memory TF-IDF index for Turkish news titles+descriptions.
// Pure JS, no deps. Not the fastest possible implementation but easily
// handles a rolling 48-hour window (a few thousand docs).
//
// Usage:
//   const idx = new TfidfIndex();
//   idx.addDoc("a", "erdoğan akp grup toplantısı");
//   idx.addDoc("b", "erdoğan grup toplantıda konuştu");
//   idx.finalize(); // computes idf
//   idx.cosine("a", "b"); // → 0..1

import { normalizeTurkish, stemTurkish } from "./fingerprint.mjs";

/**
 * A one-off query bag-of-words.
 * `selfId`, when set, is the doc id this query's text stands in for when
 * that id is already indexed (e.g. re-processing an article that is already
 * the seed/latest of its cluster) — see cosineQuery.
 * @typedef {{ tf: Map<string, number>, selfId?: string }} TfidfQuery
 */

export class TfidfIndex {
  constructor() {
    /** @type {Map<string, Map<string, number>>} docId → term → raw tf */
    this.docs = new Map();
    /** @type {Map<string, number>} term → document frequency */
    this.df = new Map();
    /** @type {Map<string, number>} term → idf (filled by finalize) */
    this.idf = new Map();
    /** @type {Map<string, Map<string, number>>} docId → term → tfidf weight (filled by finalize) */
    this.vec = new Map();
    /** @type {Map<string, number>} docId → L2 norm (filled by finalize) */
    this.norms = new Map();
    this.finalized = false;
  }

  // Tokenize + count once: normalizeTurkish -> split -> stemTurkish -> tf
  // map, insertion order = first occurrence. Shared by addDoc() and query()
  // so both sides of a cosine tokenize identically.
  //
  // Stemming conflates Turkish surface forms ("mecliste", "meclisten",
  // "meclisin" → "meclis") for better TF-IDF cosine on paraphrased
  // articles. stemTurkish is conservative — only nominal suffixes with a
  // minimum stem length guard to avoid over-conflation.
  /**
   * @param {string | null | undefined} text
   * @returns {Map<string, number>}
   */
  tokenize(text) {
    const norm = normalizeTurkish(text || "");
    const tf = new Map();
    if (!norm) return tf;
    const tokens = norm.split(" ").filter(Boolean).map(stemTurkish);
    for (const t of tokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }
    return tf;
  }

  // Shared dot/(nA*nB) cosine over two pre-weighted term maps + norms.
  // Iterates the smaller map so op order (and therefore float rounding) is
  // identical between cosine() and cosineQuery().
  /**
   * @param {Map<string, number>} a
   * @param {number} nA
   * @param {Map<string, number>} b
   * @param {number} nB
   * @returns {number}
   */
  cosineOf(a, nA, b, nB) {
    if (nA === 0 || nB === 0) return 0;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    let dot = 0;
    for (const [term, w] of small.entries()) {
      const other = big.get(term);
      if (other !== undefined) dot += w * other;
    }
    return dot / (nA * nB);
  }

  addDoc(id, text) {
    if (this.finalized) {
      // Allow re-use: invalidate finalized state, the caller can call finalize() again.
      this.finalized = false;
      this.vec.clear();
      this.norms.clear();
      this.idf.clear();
    }
    const tf = this.tokenize(text);
    if (tf.size === 0) {
      // Matches the pre-refactor early-return: replacing a doc with empty
      // text does NOT back out its old df contributions (unchanged quirk).
      this.docs.set(id, tf);
      return;
    }
    // df update — only count each term once per doc.
    if (this.docs.has(id)) {
      // Replacing an existing doc → back out old df contributions.
      const old = this.docs.get(id);
      for (const term of old.keys()) {
        const prev = this.df.get(term) || 0;
        if (prev <= 1) this.df.delete(term);
        else this.df.set(term, prev - 1);
      }
    }
    for (const term of tf.keys()) {
      this.df.set(term, (this.df.get(term) || 0) + 1);
    }
    this.docs.set(id, tf);
  }

  finalize() {
    const N = this.docs.size;
    if (N === 0) {
      this.finalized = true;
      return;
    }
    // Smoothed idf: log((N + 1) / (df + 1)) + 1
    this.idf.clear();
    for (const [term, df] of this.df.entries()) {
      this.idf.set(term, Math.log((N + 1) / (df + 1)) + 1);
    }
    this.vec.clear();
    this.norms.clear();
    for (const [id, tf] of this.docs.entries()) {
      const weights = new Map();
      let sumSq = 0;
      for (const [term, count] of tf.entries()) {
        const w = count * (this.idf.get(term) || 0);
        if (w !== 0) {
          weights.set(term, w);
          sumSq += w * w;
        }
      }
      this.vec.set(id, weights);
      this.norms.set(id, Math.sqrt(sumSq));
    }
    this.finalized = true;
  }

  vector(id) {
    if (!this.finalized) this.finalize();
    return this.vec.get(id) || new Map();
  }

  cosine(idA, idB) {
    if (!this.finalized) this.finalize();
    if (idA === idB) return 1;
    const a = this.vec.get(idA);
    const b = this.vec.get(idB);
    if (!a || !b) return 0;
    const nA = this.norms.get(idA) || 0;
    const nB = this.norms.get(idB) || 0;
    return this.cosineOf(a, nA, b, nB);
  }

  // Tokenizes `text` once, without touching docs/df/finalized — safe to call
  // whether or not finalize() has run yet. Pass `selfId` when `text` is a
  // fresher version of a doc already indexed under that id, so cosineQuery
  // does not double-count it.
  /**
   * @param {string | null | undefined} text
   * @param {string} [selfId]
   * @returns {TfidfQuery}
   */
  query(text, selfId) {
    return { tf: this.tokenize(text), selfId };
  }

  // Cosine between a one-off query and indexed doc `id`, scored as if the
  // query were momentarily added to the corpus (N' = docs+1, df' bumped by
  // 1 for terms the query contains) without mutating the index. This
  // reproduces exactly what `addDoc(query); finalize(); cosine(query, id)`
  // would have computed on a fresh index holding the same docs — UNLESS
  // `q.selfId` is already indexed, in which case that add is really a
  // *replace* (N unchanged, that doc's own df contribution backed out
  // first), matching addDoc's replace semantics instead of double-counting.
  /**
   * @param {TfidfQuery} q
   * @param {string} id
   * @returns {number}
   */
  cosineQuery(q, id) {
    const d = this.docs.get(id);
    if (!d) return 0;
    const self = q.selfId !== undefined ? this.docs.get(q.selfId) : undefined;
    const N = this.docs.size + (self ? 0 : 1);
    const idfOf = (t) =>
      Math.log(
        (N + 1) / ((this.df.get(t) || 0) - (self?.has(t) ? 1 : 0) + (q.tf.has(t) ? 1 : 0) + 1),
      ) + 1;

    const qw = new Map();
    let nQ = 0;
    for (const [term, count] of q.tf.entries()) {
      const w = count * idfOf(term);
      if (w !== 0) {
        qw.set(term, w);
        nQ += w * w;
      }
    }
    // If `id` is the doc the query is replacing, its current weights ARE
    // the query's — use q.tf, not the stale indexed `d`.
    const docTf = id === q.selfId ? q.tf : d;
    const dw = new Map();
    let nD = 0;
    for (const [term, count] of docTf.entries()) {
      const w = count * idfOf(term);
      if (w !== 0) {
        dw.set(term, w);
        nD += w * w;
      }
    }
    nQ = Math.sqrt(nQ);
    nD = Math.sqrt(nD);
    if (nQ === 0 || nD === 0) return 0;
    return this.cosineOf(qw, nQ, dw, nD);
  }

  size() {
    return this.docs.size;
  }
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (process.argv[1] === import.meta.url.replace("file://", "")) {
  const assert = (cond, msg) => {
    if (!cond) {
      console.error("FAIL:", msg);
      process.exit(1);
    }
    console.log("ok  -", msg);
  };

  const idx = new TfidfIndex();
  idx.addDoc("a", "Erdoğan AKP grup toplantısında konuştu");
  idx.addDoc("b", "Cumhurbaşkanı Erdoğan AKP grup toplantısında açıklama yaptı");
  idx.addDoc("c", "Galatasaray Fenerbahçe maçında 3-1 galip geldi");
  idx.addDoc("d", "Galatasaray Fenerbahçe derbisinde 3 gol attı");
  idx.finalize();

  const ab = idx.cosine("a", "b");
  const cd = idx.cosine("c", "d");
  const ac = idx.cosine("a", "c");

  assert(ab > 0.2, `erdoğan docs close (ab=${ab.toFixed(3)})`);
  assert(cd > 0.2, `galatasaray docs close (cd=${cd.toFixed(3)})`);
  assert(ac < ab, `cross-topic lower than same-topic (ac=${ac.toFixed(3)} < ab=${ab.toFixed(3)})`);
  assert(idx.cosine("a", "a") === 1, "self-cosine is 1");
  console.log("tfidf.mjs OK");
}
