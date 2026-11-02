// supabase/functions/_shared/rss/strip-tags.ts
//
// Linear-time tag stripping and input clamping for feed text (h26-security-2).
//
// Feed titles and descriptions are attacker-controlled input (a compromised
// outlet, or anyone on the path to the plain-http feeds). The old stripTags in
// normalize.ts looped `/<[^>]*>/g` to a fixpoint; with no '>' in the text every
// '<' scans to the end of the string, so a SINGLE pass was already O(n^2):
// measured on the real normalizeItem, a title of 80,000 '<' cost 2.1 s of CPU
// (40,000 = 532 ms, 20,000 = 136 ms) against the Edge isolate's 2 s limit, and
// `prepareItem` strips every title before the known-url skip, so one such item
// stopped the whole ingest every cycle for as long as the feed served it. The
// og:image / <img> regexes had the same shape. This module is the fix; it is
// shared with src/lib/fact-checks/normalize.ts, whose cleanTitle ran one pass
// of the same regex.
//
// Deno-compatible and dependency-free so that both the Edge Function and the
// Next.js side can import it.

/**
 * Remove every `<...>` span from `text` in one linear pass, replacing each with
 * `replacement`. Byte-for-byte equal to
 *
 *     text.replace(/<[^>]*>/g, replacement)
 *
 * and, for `replacement === ""`, to the old fixpoint loop around it:
 *
 *   One pass is already the fixpoint. A '<' survives the regex only when no
 *   '>' follows it anywhere in the input (the regex tries a match at every '<'
 *   it reaches, and `[^>]*>` succeeds as soon as ONE '>' exists after it). So
 *   every surviving '<' lies after the last '>' of the input, and the output,
 *   which keeps only characters of the input, has no '>' after it either. A
 *   second pass therefore finds no '<' ... '>' pair and changes nothing, which
 *   is why content_hash stays byte-identical (tests/functions/_shared/
 *   ingest-corpus-equality.test.ts).
 *
 * Cost is O(n): `indexOf('<', pos)` and `indexOf('>', lt + 1)` only ever move
 * forward, each character is looked at at most twice, and the first '<' with
 * no '>' after it ends the scan (the regex rescanned the tail from every such
 * '<', which is the quadratic part). 1 MB of '<' takes ~1 ms.
 */
export function stripTagsLinear(text: string, replacement = ""): string {
  let out = "";
  let pos = 0;
  while (true) {
    const lt = text.indexOf("<", pos);
    if (lt === -1) break;
    const gt = text.indexOf(">", lt + 1);
    // No '>' after this '<': it and everything behind it is plain text.
    if (gt === -1) break;
    out += text.slice(pos, lt) + replacement;
    pos = gt + 1;
  }
  return out + text.slice(pos);
}

/**
 * Bound `text` to `cap` UTF-16 units before any regex or entity work runs on it.
 * Text that already fits is returned unchanged (same string, no copy), so a
 * normal title or description is never altered. Otherwise the text is cut at
 * `cap`, except that
 *
 *   - the cut moves back by one unit when the unit before it is a HIGH
 *     surrogate: its low half would be cut away, and a dangling surrogate is
 *     XML-illegal and mangles the stored text; and
 *   - if the LAST '<' of the kept part has no '>' after it, the cut moves to
 *     that '<': the cut split a tag, and the fragment would otherwise survive
 *     as literal text (an unclosed '<' is plain text to `stripTagsLinear`) when
 *     the full text would have had the whole tag stripped.
 *
 * Linear: one `lastIndexOf` and one `indexOf` over at most `cap` units.
 */
export function clampForScan(text: string, cap: number): string {
  if (text.length <= cap) return text;
  if (cap <= 0) return "";
  let end = cap;
  const lastUnit = text.charCodeAt(cap - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end = cap - 1;
  const kept = text.slice(0, end);
  const lt = kept.lastIndexOf("<");
  if (lt !== -1 && kept.indexOf(">", lt + 1) === -1) return kept.slice(0, lt);
  return kept;
}
