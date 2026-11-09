// /oyun's twin-text rule. When an outlet of one zone and an outlet or wire of a
// DIFFERENT zone ran the identical headline text in the same story, "which camp
// is this outlet in?" has two correct answers: the same words came from both
// camps (a wire copy that an outlet took over word for word is the usual
// source). Bölge (headline-pool.ts) and Günün Tayf'ı (daily-set.ts, fed by
// daily-query.ts) drop such a headline.
//
// Two titles are twins when `twinKey` is equal: lower-cased the Turkish way,
// one leading breaking-news prefix removed, and everything that is not a letter
// or a number removed, so quotes, final punctuation, spacing and case do not
// hide a copy.
//
// Pure, and the only imports are types: safe in any bundle, and nothing here
// can pull a server module in. Keep it that way (title-twin.test.ts guards it).

import type { MediaDnaZone } from "@/types";

const DIACRITIC_FOLD_MAP: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  ö: "o",
  ş: "s",
  ü: "u",
};

// One breaking-news prefix, matched on the diacritic-folded text: "son dakika"
// ("SON DAKİKA", "SON DAKIKA") or "flaş" ("FLAŞ", "FLAS"), then at least one of
// `: ! | - – —` or whitespace. The separator is required, so "Son dakikada ..."
// and "Flaşlar ..." keep their first word.
const BREAKING_PREFIX = /^(?:son dakika|flas)[\s:!|\-–—]+/;

/**
 * The comparison key of a headline text. `''` for a title with no letter or
 * number in it (empty, blank, punctuation only, or a bare breaking-news prefix).
 *
 * Steps: `toLocaleLowerCase("tr-TR")` (so "İ" gives "i" and "I" gives "ı"); strip
 * ONE leading "son dakika" / "flaş" prefix, found on a copy with the six Turkish
 * diacritics folded (a 1:1 character swap, so the prefix length carries over to
 * the unfolded text); then remove every character that is not a Unicode letter
 * or number. Diacritics stay in the key.
 */
export function twinKey(title: string): string {
  const lowered = title.toLocaleLowerCase("tr-TR");
  const folded = lowered.replace(/[çğıöşü]/g, (ch) => DIACRITIC_FOLD_MAP[ch] ?? ch);
  const prefix = BREAKING_PREFIX.exec(folded);
  const rest = prefix ? lowered.slice(prefix[0].length) : lowered;
  return rest.replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * The twin keys carried by members of two or more DISTINCT zones. One zone
 * running a text twice (two iktidar outlets on the same agency copy) is not a
 * twin: both answers are the same zone. An empty key is never returned.
 */
export function crossZoneTwinKeys(
  members: Iterable<{ title: string; zone: MediaDnaZone }>,
): Set<string> {
  const zonesByKey = new Map<string, Set<MediaDnaZone>>();
  for (const { title, zone } of members) {
    const key = twinKey(title);
    if (key === "") continue;
    const zones = zonesByKey.get(key);
    if (zones) zones.add(zone);
    else zonesByKey.set(key, new Set([zone]));
  }

  const twins = new Set<string>();
  for (const [key, zones] of zonesByKey) {
    if (zones.size >= 2) twins.add(key);
  }
  return twins;
}
