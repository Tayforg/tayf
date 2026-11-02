// supabase/functions/_shared/rss/inline-image.ts
//
// Linear-time lookup of the first inline <img src> in feed HTML (h26-security-2).
//
// `extractImage` (normalize.ts) used to run
//
//     body.slice(0, CAP).match(/<img[^>]{1,1000}src=["']([^"']+)["']/i)
//
// over `contentEncoded` / `content`, which is attacker-controlled feed text
// (a compromised outlet, or anyone on the path to the plain-http feeds). The
// unbounded `[^>]+` was O(n^2); bounding the run to 1,000 units only turned that
// into O(1000 * n): every '<img' start scans up to 1,000 units and backtracks
// over each looking for `src=`. 12,500 x '<img' (50 KB) cost ~15 ms per item on
// the real normalizeItem, so one 5.5 MB feed of 110-160 such items took 1.9-2.9 s
// of CPU against the Edge isolate's 2 s limit, the isolate died before the
// insert, no URL was stored, the known-url skip never helped, and the feed took
// the ingest down every cycle. The hunt-26 og-image fix (og-image.ts) already
// replaced its regexes with a scanner; this is the same shape for <img>.
//
// Deno-compatible and dependency-free.

const CH_DQUOTE = 0x22; // "
const CH_SQUOTE = 0x27; // '

// Lower-case ASCII letter codes. `code | 0x20` folds A-Z onto a-z and maps no
// other code unit onto a letter, which is exactly the ASCII-only case folding
// of a non-unicode `/i` regex (it never equates U+017F with 's' or U+0131 with
// 'i').
const LC_S = 0x73;
const LC_R = 0x72;
const LC_C = 0x63;
const LC_I = 0x69;
const LC_M = 0x6d;
const LC_G = 0x67;

const FOLD = 0x20;

function isQuote(code: number): boolean {
  return code === CH_DQUOTE || code === CH_SQUOTE;
}

/**
 * The URL of the first inline `<img ... src="...">` in `html`, or null.
 *
 * Byte-for-byte the same pick as
 *
 *     html.slice(0, scanCap)
 *       .match(new RegExp(`<img[^>]{1,${maxRun}}src=["']([^"']+)["']`, "i"))?.[1]
 *
 * (tests/functions/_shared/inline-image.test.ts fuzzes the two against each
 * other), i.e.
 *
 *   - only the first `scanCap` units are looked at (a lead image sits at the top
 *     of a body);
 *   - the FIRST '<img' (any case, no word boundary) that has a usable `src=`
 *     wins;
 *   - inside one tag the LAST `src=` (any case, so `data-src=` counts) that is
 *     followed by a quote, a non-empty run of non-quote units and another quote
 *     wins; the closing quote may be either kind and the value may contain '>';
 *   - that `src=` must be at least 1 and at most `maxRun` units after '<img',
 *     with no '>' in between.
 *
 * Cost is O(n) for the whole body, whatever the content:
 *
 *   1. One pass over the '=' signs records every usable `src=` position (and
 *      where its value ends). The "first quote at or after X" cursor only moves
 *      forward, so each unit is read once for it.
 *   2. One pass over '<' finds the '<img' starts. The '>' search is a single
 *      monotonic cursor (`indexOf` runs again only once the start is past the
 *      '>' it found, and no '>' at all ends the searching), so it too reads
 *      each unit once.
 *   3. For a start, the candidate is the LAST recorded `src=` that is <= the
 *      reachable limit `min(first '>', start + 4 + maxRun)`. That limit never
 *      decreases as starts advance, so one forward pointer over the recorded
 *      positions serves all starts. No start ever rescans its attribute run.
 */
export function findInlineImgSrc(
  html: string,
  scanCap: number,
  maxRun = 1000,
): string | null {
  const s = html.length > scanCap ? html.slice(0, scanCap) : html;
  const n = s.length;

  // ---- 1. usable `src=` positions, ascending ------------------------------
  // srcAt[k]: index of the 's' of `src=`; valueEnd[k]: index of the closing
  // quote. The value is s.slice(srcAt[k] + 5, valueEnd[k]) and is never empty.
  const srcAt: number[] = [];
  const valueEnd: number[] = [];
  let quoteAt = -1; // first quote index >= the last value start; n when none
  for (let eq = s.indexOf("="); eq !== -1; eq = s.indexOf("=", eq + 1)) {
    const p = eq - 3;
    if (
      p < 0 ||
      (s.charCodeAt(p) | FOLD) !== LC_S ||
      (s.charCodeAt(p + 1) | FOLD) !== LC_R ||
      (s.charCodeAt(p + 2) | FOLD) !== LC_C ||
      !isQuote(s.charCodeAt(eq + 1)) // NaN past the end: not a quote
    ) {
      continue;
    }
    const valueStart = eq + 2;
    if (quoteAt < valueStart) {
      quoteAt = valueStart;
      while (quoteAt < n && !isQuote(s.charCodeAt(quoteAt))) quoteAt++;
    }
    // quoteAt === n: no closing quote anywhere ahead (and none for any later
    // `src=` either). quoteAt === valueStart: an empty value.
    if (quoteAt >= n || quoteAt === valueStart) continue;
    srcAt.push(p);
    valueEnd.push(quoteAt);
  }
  if (srcAt.length === 0) return null;

  // ---- 2. + 3. '<img' starts ----------------------------------------------
  let gt = -1; // first '>' at or after the current start; -2 once there is none
  let reached = 0; // srcAt[0 .. reached) are <= the current limit
  for (let lt = s.indexOf("<"); lt !== -1; lt = s.indexOf("<", lt + 1)) {
    if (
      (s.charCodeAt(lt + 1) | FOLD) !== LC_I ||
      (s.charCodeAt(lt + 2) | FOLD) !== LC_M ||
      (s.charCodeAt(lt + 3) | FOLD) !== LC_G
    ) {
      continue;
    }
    if (gt !== -2 && gt < lt) {
      gt = s.indexOf(">", lt);
      if (gt === -1) gt = -2;
    }
    const tagEnd = gt === -2 ? n : gt;
    const limit = Math.min(tagEnd, lt + 4 + maxRun);
    while (reached < srcAt.length && (srcAt[reached] as number) <= limit) {
      reached++;
    }
    if (reached === 0) continue;
    const k = reached - 1;
    if ((srcAt[k] as number) >= lt + 5) {
      return s.slice((srcAt[k] as number) + 5, valueEnd[k] as number);
    }
  }
  return null;
}
