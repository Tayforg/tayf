// supabase/functions/_shared/cluster/provinces.ts
//
// Pure helpers for the incident province-conflict veto (h16-precision-1, see
// ensemble.ts and constants.ts "(4d)"). Mirrored behaviour-identically by
// `scripts/lib/cluster/provinces.mjs` (tests/functions/_shared/
// ensemble-precision.test.ts pins the two).
//
//   provincesIn(title)      the set of folded province names a headline names
//   hasIncidentWord(title)  whether a headline reports an accident / fire /
//                           quake / attack / casualty
//
// Imports foldTurkishWord and nothing else.

import { foldTurkishWord } from "./fingerprint.ts";

// The 81 provinces, folded ASCII (foldTurkishWord output). No aliases.
export const IL_NAMES: readonly string[] = [
  "adana", "adiyaman", "afyonkarahisar", "agri", "amasya", "ankara",
  "antalya", "artvin", "aydin", "balikesir", "bilecik", "bingol", "bitlis",
  "bolu", "burdur", "bursa", "canakkale", "cankiri", "corum", "denizli",
  "diyarbakir", "edirne", "elazig", "erzincan", "erzurum", "eskisehir",
  "gaziantep", "giresun", "gumushane", "hakkari", "hatay", "isparta",
  "mersin", "istanbul", "izmir", "kars", "kastamonu", "kayseri", "kirklareli",
  "kirsehir", "kocaeli", "konya", "kutahya", "malatya", "manisa",
  "kahramanmaras", "mardin", "mugla", "mus", "nevsehir", "nigde", "ordu",
  "rize", "sakarya", "samsun", "siirt", "sinop", "sivas", "tekirdag", "tokat",
  "trabzon", "tunceli", "sanliurfa", "usak", "van", "yozgat", "zonguldak",
  "aksaray", "bayburt", "karaman", "kirikkale", "batman", "sirnak", "bartin",
  "ardahan", "igdir", "yalova", "karabuk", "kilis", "osmaniye", "duzce",
];

const IL_SET: ReadonlySet<string> = new Set(IL_NAMES);

// Matched against folded words. 'kaza' takes only its inflections (kazada,
// kazasi, kazaya, kazalar), not kazandi or Kazakistan. 'öldü' is deliberately
// absent: it folds to 'oldu' ("happened").
export const INCIDENT_PATTERNS: readonly RegExp[] = [
  /^kaza(?:$|[dlsy])/,
  /^yangin/,
  /^deprem/,
  /^patlama/,
  /^cinayet/,
  /^saldiri/,
  /^carpis(?:ti|ma)/,
  /^devril/,
  /^facia/,
  /^yarali/,
  /^yaralan/,
];

/**
 * Folded province names a headline names. A piece (split on anything that is
 * not a letter, digit or apostrophe, so 'Bolu-Duzce' is two pieces) counts only
 * when it starts with an uppercase letter -- 'ordusu' and 'tokat atti' are not
 * provinces -- and its text before the first apostrophe ("Duzce'de" -> Duzce)
 * folds to an exact province name.
 */
export function provincesIn(title: string): Set<string> {
  const out = new Set<string>();
  for (const piece of title.split(/[^\p{L}\p{N}'’ʼ]+/u)) {
    const first = [...piece][0] ?? "";
    if (!first || first === first.toLocaleLowerCase("tr")) continue;
    const stem = piece.split(/['’ʼ]/)[0] ?? "";
    const folded = foldTurkishWord(stem);
    if (IL_SET.has(folded)) out.add(folded);
  }
  return out;
}

/** True when any folded word of the headline matches an INCIDENT_PATTERNS entry. */
export function hasIncidentWord(title: string): boolean {
  for (const w of foldTurkishWord(title).split(/[^a-z0-9]+/)) {
    if (!w) continue;
    for (const p of INCIDENT_PATTERNS) if (p.test(w)) return true;
  }
  return false;
}
