// Shared truth table for the BİK court / official notice predicate.
//
// Two implementations must agree on every row:
//   * isLegalNotice()        supabase/functions/_shared/rss/legal-notice.ts (JS)
//   * public.is_legal_notice() supabase/migrations/107_legal_notice_articles.sql
// tests/functions/_shared/legal-notice.test.ts asserts the JS side;
// tests/migrations/107-legal-notice-articles.test.ts asserts the SQL side
// against a real Postgres when TAYF_PSQL is set.
//
// Everything outside the documented SQL divergences belongs here (letters
// outside the Turkish/ASCII set and newline handling are deliberately NOT
// fixtures: the two sides are allowed to differ there, see the 107 header).
// Non-ASCII spaces and the NFD form are written with escapes so an editor
// cannot silently normalise them away.

export interface LegalNoticeCase {
  title: string;
  url?: string | null;
  expected: boolean;
}

export const LEGAL_NOTICE_CASES: LegalNoticeCase[] = [
  // --- court / institution titles (true) -----------------------------------
  { title: "T.C. SAMSUN 2. SULH HUKUK MAHKEMESİNDEN", expected: true },
  { title: "BARTIN 2. ASLİYE HUKUK MAHKEMESİ", expected: true },
  {
    title: "VAN BÜYÜKŞEHİR BELEDİYESİ EMLAK VE İSTİMLAK DAİRE BAŞKANLIĞI",
    expected: true,
  },
  {
    title: "VAN BÜYÜKŞEHİR BELEDİYESİ EMLAK VE İSTİMLAK DAİRE BAŞKANLIĞINDAN",
    expected: true,
  },
  { title: "BAKIRKÖY BANKA ALACAKLARI İCRA DAİRESİ", expected: true },
  { title: "BAKIRKÖY GAYRİMENKUL SATIŞ İCRA DAİRESİ", expected: true },
  { title: "ANKARA 5. İCRA DAİRESİNDEN SATIŞ İLANI TEBLİGAT", expected: true },
  {
    title: "T.C. İSTANBUL 3. TÜKETİCİ MAHKEMESİ DOSYA 2026/14",
    expected: true,
  },
  { title: "T. C. ANKARA 3. ASLİYE MAHKEMESİ KARARI", expected: true },
  { title: "BARTIN 2. ASLİYE HUKUK MAHKEMESİNDEN.", expected: true },

  // --- İLAN header (true) ----------------------------------------------------
  { title: "İLAN", expected: true },
  { title: "ILAN", expected: true },
  { title: "İLAN: ARAÇ SATIŞ İHALESİ", expected: true },
  { title: "İLAN - ARAÇ SATIŞ İHALESİ", expected: true },
  { title: "İLAN–ARAÇ SATIŞ İHALESİ", expected: true },
  { title: "İLAN.", expected: true },

  // --- normalisation / whitespace (true) -------------------------------------
  // "İ" typed as I + U+0307 (NFD): must be NFC-normalised first.
  { title: "BARTIN 2. ASLI\u0307YE HUKUK MAHKEMESI\u0307", expected: true },
  // Dotless ASCII spelling (feeds that strip Turkish letters).
  { title: "BARTIN 2. ASLIYE HUKUK MAHKEMESI", expected: true },
  // Leading/trailing spaces and a trailing dot are tolerated.
  { title: "   BARTIN 2. ASLİYE HUKUK MAHKEMESİ.  ", expected: true },
  // NBSP and BOM are trimmed like String.prototype.trim().
  { title: "\u00a0BARTIN 2. ASLİYE HUKUK MAHKEMESİ\ufeff", expected: true },

  // --- uppercase ratio boundary (0.85) ----------------------------------------
  // 17 upper + 3 lower = 17/20 = 0.85 exactly: passes the gate.
  { title: "ABCDEFGH abc MAHKEMESİ", expected: true },
  // 16 upper + 3 lower = 16/19 = 0.842: fails the gate.
  { title: "ABCDEFG abc MAHKEMESİ", expected: false },
  // Title case: ratio 0.71.
  { title: "Ankara 5. İCRA DAİRESİ", expected: false },
  // Ends in a lowercase conjunction, not in the institution name.
  { title: "ANKARA İCRA DAİRESİ ve", expected: false },
  { title: "ANKARA İCRA DAİRESİ VE", expected: false },

  // --- real news must pass (false) ---------------------------------------------
  { title: "SON DAKİKA: MERKEZ BANKASI FAİZİ SABİT TUTTU", expected: false },
  { title: "ANAYASA MAHKEMESİ CHP'NİN BAŞVURUSUNU REDDETTİ", expected: false },
  { title: "İSRAİL SAVAŞ İLAN ETTİ", expected: false },
  { title: "Bartın 2. Asliye Hukuk Mahkemesi", expected: false },
  { title: "Anayasa Mahkemesi kararını açıkladı", expected: false },
  { title: "MAHKEMESİ KARARI SONRASI BORSA YÜKSELDİ", expected: false },
  { title: "BORSA İLAN EDİLEN KARARLA YÜKSELDİ", expected: false },
  // No whitespace after "T.C.": the TC_COURT rule needs it.
  { title: "T.C.ANKARA MAHKEMESİ KARARI SONRASI", expected: false },
  // İLAN without a separator is a different word.
  { title: "İLANEN SATIŞ", expected: false },
  { title: "ilan", expected: false },
  { title: "GOL", expected: false },
  { title: "2026/14 123456 789", expected: false },
  { title: "   ", expected: false },
  { title: "", expected: false },

  // --- url path signal (B) -------------------------------------------------------
  { title: "Normal başlık", url: "https://www.cnnturk.com/ilan/abc", expected: true },
  {
    title: "Normal başlık",
    url: "https://example.com/resmi-ilanlar/2026/1",
    expected: true,
  },
  { title: "Normal başlık", url: "https://example.com/ilan", expected: true },
  { title: "Haber", url: "https://x.com/ILAN/1", expected: true },
  { title: "Haber", url: "HTTPS://EXAMPLE.COM/Resmi-Ilanlar/1", expected: true },
  { title: "Haber", url: "https://user@example.com:8080/ilanlar/", expected: true },
  { title: "Haber", url: "https://example.com/ilan?x=1", expected: true },
  // Substring or query/fragment only: no signal.
  { title: "Başlık", url: "/haber/bilanco-aciklandi", expected: false },
  {
    title: "Başlık",
    url: "https://example.com/haber/bilanco-aciklandi",
    expected: false,
  },
  { title: "Haber", url: "https://example.com/haber/ilan-x", expected: false },
  { title: "Haber", url: "https://example.com/haber?x=/ilan/1", expected: false },
  { title: "Haber", url: "https://example.com/haber#/ilan/", expected: false },
  { title: "Haber", url: "https://example.com", expected: false },
  // Relative url (no scheme): unparseable, so no signal even with /ilan/.
  { title: "Haber", url: "/ilan/1", expected: false },
  { title: "Normal başlık", url: "not a url", expected: false },
  { title: "Normal başlık", url: null, expected: false },
  { title: "Normal başlık", url: "", expected: false },
  { title: "Haber başlığı", expected: false },
];
