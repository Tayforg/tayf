// companyDisplayName — the short name a reader would say aloud for a KAP
// company title ("ARÇELİK A.Ş." -> "Arçelik").
//
// Why (hunt-17, 2026-11-02): /ekonomi/<TICKER> never named the company in its
// <title>, its description or its H1. A search result or a shared link read
// "ARCLK — hisse haberleri ve KAP bildirimleri" even though the page body
// already printed "ARÇELİK A.Ş." underneath. KAP's legal title is all caps and
// full of corporate boilerplate, so it cannot go into a title as is.
//
// DISPLAY ONLY. The result is for headings and meta text. It is lossy (the
// legal form and the trade descriptors are dropped, the casing is
// reconstructed) and it is NOT unique, so it must never be used as a key, a
// slug, a filter value or a lookup into bist_companies. The ticker and
// kap_member_oid stay the identities.
//
// Pure: no imports, no clock, no I/O, same answer on every call.

/** Corporate forms: always dropped from the end of the title. Compared in their tr-TR upper-case form. */
const LEGAL_FORMS: ReadonlySet<string> = new Set([
  "A.Ş.",
  "A.Ş",
  "AŞ",
  "T.A.Ş.",
  "T.A.Ş",
  "A.O.",
  "A.O",
  "ANONİM",
  "ŞİRKETİ",
  "ORTAKLIĞI",
  "AKTIENGESELLSCHAFT",
]);

/**
 * Trade descriptors: dropped from the end only while another token would remain ("TİCARET A.Ş." stays "Ticaret").
 * DIŞ / İÇ are the "foreign / domestic" of "İÇ VE DIŞ TİCARET": left in, "TEKNOSA İÇ VE DIŞ TİCARET A.Ş." would end as "Teknosa İç ve Dış".
 */
const DESCRIPTORS: ReadonlySet<string> = new Set(["SANAYİ", "SANAYİİ", "TİCARET", "SAN.", "TİC.", "VE", "DIŞ", "İÇ"]);

/** Brand abbreviations that are written in capitals and contain a vowel, so the vowel-free rule would miss them. */
const ACRONYMS: ReadonlySet<string> = new Set(["BİM", "THY", "TÜPRAŞ", "TAV", "ŞOK", "KAP", "ICBC", "ICU", "IC", "ING", "AG"]);

/**
 * Foreign brand words that KAP writes in ASCII capitals. The tr-TR lower-casing
 * below is right for Turkish words (ALTINAY -> Altınay) but would turn the I of
 * these into a dotless ı ("Carrıer", "Fortıs"), so they are lower-cased the
 * English way instead. Keyed by the tr-TR upper-case form of one word (a part
 * of a hyphenated word counts on its own). Add a word here only when its I is
 * a Latin i; a Turkish word must never be listed.
 */
const FOREIGN_WORDS: ReadonlySet<string> = new Set([
  "CAPITAL",
  "CARRIER",
  "CREDITWEST",
  "FORTIS",
  "GRAINTURK",
  "GRANITE",
  "INTERNATIONAL",
  "MONDI",
  "PARIBAS",
  "PRIME",
  "QUICK",
  "TRIVE",
  "TURKISH",
  "UNICO",
  "UNICREDIT",
  "WIND",
]);

/** Whole names whose own spelling is not title case. Keyed by the tr-TR upper-case name left after stripping. */
const BRAND_NAMES: ReadonlyMap<string, string> = new Map([["DO & CO", "DO & CO"]]);

/** Connectives that stay lower case inside a name ("Ereğli Demir ve Çelik"), but not as its first word. */
const LOWER_WORDS: ReadonlySet<string> = new Set(["ve", "ile", "veya"]);

const TR = "tr-TR";
const EN = "en-US";
const VOWELS = "AEIİOÖUÜ";

function upper(s: string): string {
  return s.toLocaleUpperCase(TR);
}

/** Splits on whitespace, joining a spaced "A. Ş." into the single token "A.Ş.". */
function tokenize(title: string): string[] {
  const raw = title.split(/\s+/);
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const token = raw[i];
    if (token === undefined || token === "") continue;
    const next = raw[i + 1];
    if (next !== undefined && upper(token) === "A." && upper(next) === "Ş.") {
      tokens.push("A.Ş.");
      i += 1;
    } else {
      tokens.push(token);
    }
  }
  return tokens;
}

function titleCaseToken(token: string, index: number): string {
  // Abbreviations with a dot (T.C.), ampersands (AT&T) and codes with a digit (A1) are written as they are.
  if (/[.&\d]/.test(token)) return token;
  const up = upper(token);
  if (ACRONYMS.has(up)) return token;
  // A token without a vowel is a spelled-out code (MLP, QNB, HSBC, TSKB), not a word.
  if (!Array.from(up).some((ch) => VOWELS.includes(ch))) return token;
  const lower = token.toLocaleLowerCase(TR);
  if (index > 0 && LOWER_WORDS.has(lower)) return lower;
  return token
    .split("-")
    .map((part) => {
      const locale = FOREIGN_WORDS.has(upper(part)) ? EN : TR;
      return part.charAt(0).toLocaleUpperCase(locale) + part.slice(1).toLocaleLowerCase(locale);
    })
    .join("-");
}

/**
 * The short display name for a KAP company title, or null when nothing
 * usable is left (no title, only a legal form, a single letter).
 */
export function companyDisplayName(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const tokens = tokenize(title);

  // Strip from the tail until neither a legal form nor (with company left) a descriptor remains.
  while (tokens.length > 0) {
    const last = upper(tokens[tokens.length - 1] ?? "");
    if (LEGAL_FORMS.has(last) || (tokens.length > 1 && DESCRIPTORS.has(last))) {
      tokens.pop();
    } else {
      break;
    }
  }
  if (tokens.length === 0) return null;

  const rest = tokens.join(" ");
  if ((rest.match(/\p{L}/gu) ?? []).length < 2) return null;

  // Mixed-case titles ("Pegasus Hava Taşımacılığı") already carry their casing: only the suffix was removed.
  if (rest !== upper(rest)) return rest;
  const brand = BRAND_NAMES.get(rest);
  if (brand !== undefined) return brand;
  return tokens.map(titleCaseToken).join(" ");
}
