// supabase/functions/_shared/rss/legal-notice.ts
//
// Detects BİK (Basın İlan Kurumu) court and official notices that ride the
// same RSS feeds as news: "T.C. SAMSUN 2. SULH HUKUK MAHKEMESİNDEN",
// "BAKIRKÖY GAYRİMENKUL SATIŞ İCRA DAİRESİ", "İLAN ...". They are not news,
// they pollute clusters and the /ekonomi ticker feed, and they are
// recognisable without an LLM:
//
//   A. the title is MOSTLY UPPERCASE and either ends with an institution name
//      (optionally in the ablative "...MAHKEMESİNDEN"), contains such an
//      ablative form, starts "T.C. ... MAHKEMESİ", or starts with "İLAN";
//   B. the URL path is an /ilan/ (or /resmi-ilan/) section.
//
// A bare "MAHKEMESİ" or "İLAN" in the MIDDLE of a headline must NOT trigger,
// so real all-caps news ("ANAYASA MAHKEMESİ CHP'NİN BAŞVURUSUNU REDDETTİ",
// "İSRAİL SAVAŞ İLAN ETTİ") passes: every pattern below is anchored to the end
// of the title, to an ablative suffix, or to the start of the title.
//
// Pure and import-free (no lookbehind: the TS target is ES2017) so the same
// function runs in the Deno ingest function and in Next (re-exported from
// `src/lib/finance/ticker-relevance.ts`).
//
// SQL twin: `public.is_legal_notice(title, url)` (migration 107) classifies
// rows that were stored before the ingest filter existed, or that slipped
// past it, for the ticker attention counts. It embeds the `.source` of every
// pattern in LEGAL_NOTICE_PATTERNS verbatim, so each pattern here must stay
// valid and equivalent as a Postgres ARE too: no lookbehind, no named groups,
// no `\-` escape (a literal hyphen goes last in the class), no `\p{..}`. The
// parity test (tests/migrations/107-legal-notice-articles.test.ts) fails the
// build when the SQL drifts from these sources.

/** Fewest letters a title needs before the uppercase ratio is trusted. */
export const LEGAL_NOTICE_MIN_LETTERS = 8;
/** Smallest share of uppercase letters that still counts as "mostly uppercase". */
export const LEGAL_NOTICE_MIN_UPPER_RATIO = 0.85;

// (i) ends with an institution name, optionally ablative, trailing
// punctuation tolerated. [İI] / [ĞG] accept feeds that strip Turkish letters.
const ENDS_WITH_INSTITUTION =
  /(MAHKEMES[İI]|[İI]CRA DA[İI]RES[İI]|DA[İI]RE BAŞKANLI[ĞG]I)(NDEN|NDAN)?[\s.:;,!-]*$/u;
// (ii) contains an ablative form ("... MAHKEMESİNDEN ...").
const CONTAINS_ABLATIVE =
  /(MAHKEMES[İI]NDEN|[İI]CRA DA[İI]RES[İI]NDEN|DA[İI]RE BAŞKANLI[ĞG]INDAN)/u;
// (iii) "T.C. <anything> MAHKEMESİ".
const TC_COURT = /^T\.\s?C\.\s.*MAHKEMES[İI]/u;
// (iv) starts with the word İLAN followed by a separator or the end. The
// class is written without an escaped hyphen (the trailing "-" is literal) so
// its `.source` is valid in a Postgres ARE unchanged.
const STARTS_WITH_ILAN = /^[İI]LAN([\s:.–-]|$)/u;

// B: /ilan/, /ilanlar/, /resmi-ilan/, /resmi-ilanlar/ as a whole path segment
// ("/haber/bilanco-aciklandi" must not match).
const ILAN_PATH = /(^|\/)(ilan|ilanlar|resmi-ilan|resmi-ilanlar)(\/|$)/i;

/**
 * The five rules, exported so the SQL twin can be checked against them
 * (see the header). Not part of the runtime API: callers use isLegalNotice.
 */
export const LEGAL_NOTICE_PATTERNS = {
  ENDS_WITH_INSTITUTION,
  CONTAINS_ABLATIVE,
  TC_COURT,
  STARTS_WITH_ILAN,
  ILAN_PATH,
} as const;

/**
 * True when at least `minLetters` letters are present and at least
 * LEGAL_NOTICE_MIN_UPPER_RATIO of them are uppercase. Case is decided with the Turkish
 * locale so dotted/dotless I behave (İ is upper, ı is lower).
 */
function isMostlyUppercase(s: string, minLetters: number): boolean {
  const letters = s.match(/\p{L}/gu);
  if (!letters || letters.length < minLetters) return false;
  let upper = 0;
  for (const ch of letters) {
    if (ch !== ch.toLocaleLowerCase("tr")) upper++;
  }
  return upper / letters.length >= LEGAL_NOTICE_MIN_UPPER_RATIO;
}

export function isLegalNotice(title: string, url?: string | null): boolean {
  if (typeof title === "string" && title) {
    // NFC first: "İ" can arrive decomposed (I + U+0307), which would defeat
    // every [İ] class below.
    const t = title.normalize("NFC").trim();
    // The three anchored regexes run FIRST: they reject an ordinary mixed-case
    // headline outright, whereas isMostlyUppercase lower-cases every letter of
    // the title (toLocaleLowerCase("tr") per letter). Both must hold, so the
    // order changes cost, not the result (hunt-11, A-ingest-cpu; the old order
    // is pinned in tests/functions/_shared/legal-notice.test.ts).
    if (
      (ENDS_WITH_INSTITUTION.test(t) ||
        CONTAINS_ABLATIVE.test(t) ||
        TC_COURT.test(t)) &&
      isMostlyUppercase(t, LEGAL_NOTICE_MIN_LETTERS)
    ) {
      return true;
    }
    // (iv) A bare "İLAN" / "İLAN:" header has fewer than LEGAL_NOTICE_MIN_LETTERS letters
    // but is exactly the notice marker, so it only needs the ratio gate
    // (3 letters = the word itself).
    if (STARTS_WITH_ILAN.test(t) && isMostlyUppercase(t, 3)) return true;
  }

  if (url) {
    try {
      if (ILAN_PATH.test(new URL(url).pathname)) return true;
    } catch {
      // Unparseable / relative URL: no signal from B.
    }
  }
  return false;
}
