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
//   B. the URL path is an /ilan/ (or /resmi-ilan/) section;
//   C. (h168-notices-1, optional third argument) the DESCRIPTION says so:
//      D1 it starts "İlan" + a dash (Yeniçağ prints a court or tax-office notice
//      under a mixed-case title and marks it only there: "İlan-T.C. Kırıkhan 2.
//      Asliye Ceza Mahkemesi"), or D2 the title is MOSTLY UPPERCASE and the
//      description carries a tender marker ("4734 sayılı Kamu İhale Kanunu",
//      "İhale Kayıt Numarası") or starts with the capitals "İLAN " (a
//      municipality's or BOTAŞ's EKAP tender under a bare "ÜMRANİYE BELEDİYE
//      BAŞKANLIĞI" title). The tender law alone is NOT a notice marker: real
//      news (Kızılay ihalesiz alım, Emniyet kumanya, Gaziantep ihalesi) quotes
//      it under mixed-case titles, which is why D2 also needs the uppercase gate;
//   E. (h181-sourcepages-1) tax-office, enforcement-office and mixed-case court
//      notices (a debtor's or a defendant's name, tax number and address on an
//      indexable source page): E1 the title is MOSTLY UPPERCASE and ENDS in a tax
//      or enforcement office's own name ("KOZYATAĞI VERGİ DAİRESİ MÜDÜRLÜĞÜ",
//      "SİLİVRİ İCRA VE İFLAS MÜDÜRLÜĞÜ", ENDS_WITH_OFFICE); E2 the title is
//      MOSTLY UPPERCASE and the description carries the notice's own header
//      ("İLANEN TEBLİĞ", "GAZETE VEYA İNTERNET HABER SİTESİ İLANI"); E3 (TS only,
//      MIXED_COURT_NOTICE) İşçi Haber rewrites a BİK court notice into a
//      sentence-case title ("Kocaeli 3. sulh hukuk Mahkemesi'nden ilanen tebliğ"):
//      a court-level word, then "mahkemesi", and the notice word (ilan, ilanı,
//      ilanen tebliğ or ilanen tebligat) must follow "mahkemesi" directly, after a
//      space or after the ablative -nden (apostrophe optional, at most 24
//      characters between), and END the title. A court story whose title does not
//      read that way ("Kandıra sulh hukuk mahkemesi Kerpe'de 6 arsayı satıyor",
//      "Aile Mahkemesi'ne yeni hakim alım ilanı") is a known residue or plain
//      news and stays visible: no title rule can tell it from news.
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
//
// The description rules (C) have their own twin, the 3-argument
// `public.is_legal_notice(title, url, description)` (migration 210), which
// embeds the `.source` of every pattern in LEGAL_NOTICE_DESCRIPTION_PATTERNS
// verbatim under the same constraints (tests/migrations/210-legal-notice-
// description.test.ts). They live in their own object, not in
// LEGAL_NOTICE_PATTERNS, because the 107 parity test iterates that object and
// the 107 SQL must keep embedding exactly its five patterns.
//
// The h181 rules E1 and E2 have their own twin, the same 3-argument function re-created by
// migration 213 (the live body of 210 plus two blocks), which embeds the `.source` of
// LEGAL_NOTICE_TITLE_V2_PATTERNS and LEGAL_NOTICE_DESCRIPTION_V2_PATTERNS verbatim under the same
// constraints (tests/migrations/213-legal-notice-tax-court.test.ts). They are two more objects, not
// entries of the two earlier ones, for the same reason as above: the 107 and 210 parity tests iterate
// those objects and each migration must keep embedding exactly its own patterns. E3 (MIXED_COURT_NOTICE)
// has NO SQL twin on purpose: it lower-cases the title with the Turkish locale (İ -> i, I -> ı), and case
// folding of İ and ı is not reliable in a POSIX ARE (it depends on the database's collation); the
// /ekonomi ticker counts, the SQL twin's only consumer, do not depend on it (h181 replay, migration 213).
// MIXED_COURT_NOTICE is therefore free of the ARE limits (\p{L}, lookahead) but uses bounded quantifiers
// only, and judges only a title of at most MIXED_COURT_NOTICE_MAX_TITLE characters.
//
// The description is attacker-controlled feed text and String.prototype.normalize
// is super-linear on combining marks that need reordering ('a' + U+0301 x n/2 +
// U+0316 x n/2 costs 152 ms at 20,000 units, benign text about 0.01 ms), so the
// description rules read at most NOTICE_DESCRIPTION_SCAN_CAP units of it and cut
// BEFORE the NFC pass (h169 review, sec-ingest-nfc-quadratic-dos). That is the
// size of the title's own bound (TITLE_SCAN_CAP, normalize.ts) and four times the
// 500 cleaned characters the SQL twin judges. completeItem also clamps the raw
// description it hands in (DESCRIPTION_SCAN_CAP, 20,000): that clamp is the outer
// bound, this one the inner.

/**
 * The most units of a description the description rules read (cut before the NFC pass: see the header). Exported so the tests
 * pin it; a marker, or a leading "İlan-", past it is not seen.
 */
export const NOTICE_DESCRIPTION_SCAN_CAP = 2_000;

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

// C (h168-notices-1): rules on the DESCRIPTION. All four are case-sensitive
// literals or anchored at the start, so each is linear on any input, and each
// `.source` is a valid Postgres ARE unchanged (no lookaround, no `\-` escape,
// the dash class is written `[-–]` with the hyphen first).
//
// D1: Yeniçağ's marker, "İlan-<title>". A dash or an en dash is REQUIRED: the
// word alone is an ordinary headline opener ("İlan sitesine 111 TL ..." is a
// real CNN Türk story).
const DESCRIPTION_ILAN_DASH = /^\s*[İI]lan\s*[-–]/u;
// D2 markers, each only trusted under a mostly-uppercase title.
const DESCRIPTION_TENDER_LAW = /4734 sayılı Kamu İhale Kanunu/u;
const DESCRIPTION_TENDER_REGISTRY = /İhale Kayıt Numarası/u;
const DESCRIPTION_STARTS_WITH_ILAN = /^\s*[İI]LAN\s/u;

// E (h181-sourcepages-1).
//
// E1: the title ENDS in a tax office's or an enforcement office's own name, trailing punctuation tolerated. Like
// ENDS_WITH_INSTITUTION it is trusted only under a mostly-uppercase title (the regex is case-sensitive, so a
// mixed-case "Kadıköy Vergi Dairesi Müdürlüğü" is not matched at all: a known false negative). The
// bank-claims enforcement office ("BANKA ALACAKLARI İCRA DAİRESİ MÜDÜRLÜĞÜ") is covered by the "İCRA DAİRESİ"
// alternative. [İI] / [Eİ] / [ĞG] / [ÜU] accept feeds that strip Turkish letters; the hyphen is last in the class
// and nothing is escaped, so the `.source` is a valid Postgres ARE unchanged (migration 213 embeds it).
const ENDS_WITH_OFFICE =
  /((V[Eİ]RG[İI]|[İI]CRA) DA[İI]RES[İI]|[İI]CRA VE [İI]FLAS) M[ÜU]D[ÜU]RL[ÜU][ĞG][ÜU][\s.:;,!-]*$/u;
// E2: the notice's own header in the description, case-sensitive literals (linear on any input, valid Postgres AREs
// unchanged), each only trusted under a mostly-uppercase title: a lower-case or title-case "ilanen tebliğ" in a
// description is ordinary prose.
const DESCRIPTION_ILANEN_TEBLIG = /İLANEN TEBLİĞ/u;
const DESCRIPTION_GAZETE_INTERNET_ILANI = /GAZETE VEYA İNTERNET HABER SİTESİ İLANI/u;

// E3 (TS only, no SQL twin: see the header). Run on the NFC title lower-cased with the Turkish locale. A court-level
// word (a whole word) is followed, within 40 characters, by "mahkemesi" (which also reads "mahkemesinden"
// and "mahkemesi'nden"). The notice word (ilan, ilanı, ilanen tebliğ or ilanen tebligat) must then follow "mahkemesi"
// DIRECTLY and END the title (trailing punctuation tolerated): the tail is tested on the text right after the first
// "mahkemesi" match, and is either a space and the notice word ("Ankara 22. Aile Mahkemesi ilanı") or the ablative
// -nden (the apostrophe, ASCII or typographic, is optional), at most 24 characters, then the notice word
// ("Batman 6. asliye hukuk Mahkemesi'nden tapu iptal ilanı"). A notice word anywhere else after a court name
// ("Aile Mahkemesi'ne yeni hakim alım ilanı", "Ticaret Mahkemesi'nin kararının ardından Boyner'den iflas ilanı") is news,
// not a notice. "Ticaret Mahkemesi'nden iflas ilanı" has the exact shape of a notice and stays flagged (accepted).
// Every quantifier is bounded, so the work is bounded by the title cap times the gap.
const MIXED_COURT_LEVEL =
  /(?:^|[^\p{L}])(?:asliye|sulh|ağır ceza|icra|iş|aile|tüketici|idare|vergi|ticaret|kadastro|fikri|infaz|çocuk|bölge)(?![\p{L}])[\s\S]{0,40}?mahkemesi/u;
const MIXED_NOTICE_TAIL =
  /^(?:['’]?nden[\s\S]{0,24}?)?[^\p{L}](?:ilan|ilanı|ilanen tebliğ|ilanen tebligat)[\s.:;,!-]{0,20}$/u;
// Cheap precheck (an ASCII case-insensitive substring test) so the lower-casing runs only for titles that name a court.
const COURT_STEM = /mahkeme/i;

/** The longest title (after NFC and trim) MIXED_COURT_NOTICE judges. A notice title is short; a longer one is read as news. */
export const MIXED_COURT_NOTICE_MAX_TITLE = 300;

/**
 * The five title / url rules, exported so the SQL twin can be checked against
 * them (see the header). Not part of the runtime API: callers use isLegalNotice.
 */
export const LEGAL_NOTICE_PATTERNS = {
  ENDS_WITH_INSTITUTION,
  CONTAINS_ABLATIVE,
  TC_COURT,
  STARTS_WITH_ILAN,
  ILAN_PATH,
} as const;

/**
 * The four description rules (C), exported so the 3-argument SQL twin
 * (migration 210) can be checked against them. Kept apart from
 * LEGAL_NOTICE_PATTERNS on purpose (see the header).
 */
export const LEGAL_NOTICE_DESCRIPTION_PATTERNS = {
  DESCRIPTION_ILAN_DASH,
  DESCRIPTION_TENDER_LAW,
  DESCRIPTION_TENDER_REGISTRY,
  DESCRIPTION_STARTS_WITH_ILAN,
} as const;

/**
 * The h181 title rule (E1), exported so the 3-argument SQL twin (migration 213) can be checked against it. Kept apart
 * from LEGAL_NOTICE_PATTERNS and LEGAL_NOTICE_DESCRIPTION_PATTERNS on purpose (see the header).
 */
export const LEGAL_NOTICE_TITLE_V2_PATTERNS = {
  ENDS_WITH_OFFICE,
} as const;

/**
 * The two h181 description rules (E2), exported for the same reason. Kept apart from LEGAL_NOTICE_DESCRIPTION_PATTERNS
 * on purpose (migration 210 embeds exactly its four).
 */
export const LEGAL_NOTICE_DESCRIPTION_V2_PATTERNS = {
  DESCRIPTION_ILANEN_TEBLIG,
  DESCRIPTION_GAZETE_INTERNET_ILANI,
} as const;

/**
 * The h181 mixed-case court rule (E3). TS only: it has NO SQL twin on purpose (see the header), so these sources are
 * not Postgres AREs and no migration embeds them.
 */
export const MIXED_COURT_NOTICE = {
  COURT_LEVEL: MIXED_COURT_LEVEL,
  NOTICE_TAIL: MIXED_NOTICE_TAIL,
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

/**
 * True for a BİK court / official notice or a municipal / institutional tender.
 * `description` (h168-notices-1) is optional: absent, null, empty or not a
 * string, the verdict is exactly the title + url verdict of before. It can only
 * ADD notices, never clear one.
 */
export function isLegalNotice(
  title: string,
  url?: string | null,
  description?: string | null,
): boolean {
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
    // E1 (h181-sourcepages-1): a tax or enforcement office's own name at the end of a mostly-uppercase title.
    if (ENDS_WITH_OFFICE.test(t) && isMostlyUppercase(t, LEGAL_NOTICE_MIN_LETTERS)) return true;
    // E3 (h181-sourcepages-1, TS only): a sentence-case court notice.
    if (isMixedCourtNotice(t)) return true;
  }

  if (url) {
    try {
      if (ILAN_PATH.test(new URL(url).pathname)) return true;
    } catch {
      // Unparseable / relative URL: no signal from B.
    }
  }

  if (typeof description === "string" && description) {
    return isNoticeByDescription(title, description);
  }
  return false;
}

/**
 * Rule C. NFC first, like the title rules ("İ" can arrive as I + U+0307), on the
 * first NOTICE_DESCRIPTION_SCAN_CAP units of the description only.
 * D1 needs no title; D2 and E2 need a mostly-uppercase title, checked LAST because
 * it lower-cases every letter of the title.
 */
function isNoticeByDescription(title: unknown, description: string): boolean {
  // Cut first: normalize() is super-linear on hostile combining marks, so it never sees more than the cap.
  const d = description.slice(0, NOTICE_DESCRIPTION_SCAN_CAP).normalize("NFC");
  if (DESCRIPTION_ILAN_DASH.test(d)) return true;
  if (typeof title !== "string" || !title) return false;
  if (
    DESCRIPTION_TENDER_LAW.test(d) ||
    DESCRIPTION_TENDER_REGISTRY.test(d) ||
    DESCRIPTION_STARTS_WITH_ILAN.test(d) ||
    DESCRIPTION_ILANEN_TEBLIG.test(d) ||
    DESCRIPTION_GAZETE_INTERNET_ILANI.test(d)
  ) {
    return isMostlyUppercase(title.normalize("NFC").trim(), LEGAL_NOTICE_MIN_LETTERS);
  }
  return false;
}

/**
 * E3. `t` is the NFC, trimmed title. A title over MIXED_COURT_NOTICE_MAX_TITLE characters is not judged: cutting it
 * would test an arbitrary mid-sentence boundary for "ends in ilan", and a notice title is short. The cheap substring
 * test comes first, so the Turkish lower-casing (a per-letter locale lookup) runs only for a title that names a court.
 */
function isMixedCourtNotice(t: string): boolean {
  if (t.length > MIXED_COURT_NOTICE_MAX_TITLE) return false;
  if (!COURT_STEM.test(t)) return false;
  const lower = t.toLocaleLowerCase("tr");
  const m = MIXED_COURT_LEVEL.exec(lower);
  return m !== null && MIXED_NOTICE_TAIL.test(lower.slice(m.index + m[0].length));
}
