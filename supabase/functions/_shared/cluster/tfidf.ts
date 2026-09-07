// supabase/functions/_shared/cluster/tfidf.ts
//
// Minimal in-memory TF-IDF index for Turkish news titles+descriptions.
// Pure TS, no deps. Ported from `scripts/lib/cluster/tfidf.mjs`.

import { normalizeTurkish, stemTurkish } from "./fingerprint.ts";

/** A one-off query bag-of-words: term -> raw tf, insertion order preserved. */
export interface TfidfQuery {
  tf: Map<string, number>;
  // Doc id this query stands in for, when the caller's text is a fresher
  // version of a doc already in the index (e.g. re-processing an article
  // that is already the seed/latest of its cluster). Lets cosineQuery treat
  // it as a replace instead of double-counting the doc in N and df.
  selfId?: string;
}

export class TfidfIndex {
  private docs: Map<string, Map<string, number>>;
  private df: Map<string, number>;
  private idf: Map<string, number>;
  private vec: Map<string, Map<string, number>>;
  private norms: Map<string, number>;
  private finalized: boolean;

  constructor() {
    this.docs = new Map();
    this.df = new Map();
    this.idf = new Map();
    this.vec = new Map();
    this.norms = new Map();
    this.finalized = false;
  }

  // Tokenize + count once: normalizeTurkish -> split -> stemTurkish -> tf
  // map, insertion order = first occurrence. Shared by addDoc() and query()
  // so both sides of a cosine tokenize identically.
  private tokenize(text: string | null | undefined): Map<string, number> {
    const norm = normalizeTurkish(text || "");
    const tf = new Map<string, number>();
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
  private cosineOf(
    a: Map<string, number>,
    nA: number,
    b: Map<string, number>,
    nB: number,
  ): number {
    if (nA === 0 || nB === 0) return 0;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    let dot = 0;
    for (const [term, w] of small.entries()) {
      const other = big.get(term);
      if (other !== undefined) dot += w * other;
    }
    return dot / (nA * nB);
  }

  addDoc(id: string, text: string | null | undefined): void {
    if (this.finalized) {
      // Allow re-use: invalidate finalized state, caller can call finalize() again.
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
    // df update — back out old contributions when replacing an existing doc.
    if (this.docs.has(id)) {
      const old = this.docs.get(id)!;
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

  finalize(): void {
    const N = this.docs.size;
    if (N === 0) {
      this.finalized = true;
      return;
    }
    this.idf.clear();
    for (const [term, df] of this.df.entries()) {
      this.idf.set(term, Math.log((N + 1) / (df + 1)) + 1);
    }
    this.vec.clear();
    this.norms.clear();
    for (const [id, tf] of this.docs.entries()) {
      const weights = new Map<string, number>();
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

  vector(id: string): Map<string, number> {
    if (!this.finalized) this.finalize();
    return this.vec.get(id) || new Map();
  }

  cosine(idA: string, idB: string): number {
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
  query(text: string | null | undefined, selfId?: string): TfidfQuery {
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
  cosineQuery(q: TfidfQuery, id: string): number {
    const d = this.docs.get(id);
    if (!d) return 0;
    const self = q.selfId !== undefined ? this.docs.get(q.selfId) : undefined;
    const N = this.docs.size + (self ? 0 : 1);
    const idfOf = (t: string): number =>
      Math.log(
        (N + 1) / ((this.df.get(t) || 0) - (self?.has(t) ? 1 : 0) + (q.tf.has(t) ? 1 : 0) + 1),
      ) + 1;

    const qw = new Map<string, number>();
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
    const dw = new Map<string, number>();
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

  size(): number {
    return this.docs.size;
  }
}
