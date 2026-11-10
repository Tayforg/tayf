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
// The prefix rule has two VERSIONS, because Günün Tayf'ı recomputes every
// replayable day from a cold cache and a day players already saw must come out
// byte-identical:
//   1  the prefix is followed by whitespace or one of `: ! | - – —` (the rule
//      #248 shipped; it misses "Son dakika... X" and "SON DAKİKA… X", whose
//      key keeps "sondakika" and so never meets the plain "X");
//   2  the prefix is followed by ANY run of non-letter, non-number characters
//      ('.', '...', '…', quotes, emoji, dashes, spaces ...).
// The default is 2. daily-set.ts's `dailyTwinKeyVersion(dateKey)` picks the
// version of a puzzle key (1 below DAILY_TWIN_KEY_V2_FROM, 2 from it); Bölge has
// no replay contract and always uses version 2. Version 1 is frozen: do not edit
// BREAKING_PREFIX_V1.
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

/** The twin-key rule: 1 is the frozen #248 rule, 2 also sees through '.', '…' and other lead-in punctuation. */
export type TwinKeyVersion = 1 | 2;

// One breaking-news prefix, matched on the diacritic-folded text: "son dakika"
// ("SON DAKİKA", "SON DAKIKA") or "flaş" ("FLAŞ", "FLAS"), then a separator. The
// separator is required, so "Son dakikada ..." and "Flaşlar ..." keep their
// first word. Both regexes are one anchored literal and ONE un-nested character
// class run, so they match in linear time (no js/redos).
//
// Version 1 (FROZEN, the sets served before the lead-in fix recompute from it):
// whitespace or `: ! | - – —`.
const BREAKING_PREFIX_V1 = /^(?:son dakika|flas)[\s:!|\-–—]+/;
// Version 2: any run of characters that are neither a letter nor a number.
const BREAKING_PREFIX_V2 = /^(?:son dakika|flas)[^\p{L}\p{N}]+/u;

/**
 * The comparison key of a headline text. `''` for a title with no letter or
 * number in it (empty, blank, punctuation only, or a bare breaking-news prefix).
 *
 * Steps: `toLocaleLowerCase("tr-TR")` (so "İ" gives "i" and "I" gives "ı"); strip
 * ONE leading "son dakika" / "flaş" prefix, found on a copy with the six Turkish
 * diacritics folded (a 1:1 character swap, so the prefix length carries over to
 * the unfolded text); then remove every character that is not a Unicode letter
 * or number. Diacritics stay in the key.
 *
 * `version` picks which separators may follow the prefix (see the header): the
 * default 2 takes any run of non-letters, 1 is the frozen #248 rule.
 */
export function twinKey(title: string, version: TwinKeyVersion = 2): string {
  const lowered = title.toLocaleLowerCase("tr-TR");
  const folded = lowered.replace(/[çğıöşü]/g, (ch) => DIACRITIC_FOLD_MAP[ch] ?? ch);
  const prefix = (version === 1 ? BREAKING_PREFIX_V1 : BREAKING_PREFIX_V2).exec(folded);
  const rest = prefix ? lowered.slice(prefix[0].length) : lowered;
  return rest.replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * The twin keys carried by members of two or more DISTINCT zones. One zone
 * running a text twice (two iktidar outlets on the same agency copy) is not a
 * twin: both answers are the same zone. An empty key is never returned. The keys
 * are `twinKey(title, version)`: compare them with a key of the same version.
 */
export function crossZoneTwinKeys(
  members: Iterable<{ title: string; zone: MediaDnaZone }>,
  version: TwinKeyVersion = 2,
): Set<string> {
  const zonesByKey = new Map<string, Set<MediaDnaZone>>();
  for (const { title, zone } of members) {
    const key = twinKey(title, version);
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
