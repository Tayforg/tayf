// supabase/functions/_shared/rss/retail-catalog.ts
//
// Detects the weekly retail-catalog and promo headlines of the Turkish grocery chains: "BİM 13 KASIM AKTÜEL ÜRÜNLER
// KATALOĞU", "BİM'E ALTUS HALI VE KOLTUK YIKAMA MAKİNESİ GELİYOR! (BİM 8-14 KASIM)", "ŞOK 14-20 Ekim aktüel ürünler
// kataloğu yayınlandı". They name a listed retailer in every title, so the ticker resolver attached BIMAS to them: 179 of
// BIMAS's 197 article_tickers rows over 30 days (hunt 72, h72-kap-3), from 18 sources, with an average Jev
// ticker_relevance of 0.91, so the 0.2 and 0.5 relevance gates keep and count them. They are not news about the company.
//
// The predicate reads the TITLE only (never the URL), folded with foldTr (lower case, Turkish letters to ASCII, every run
// of other characters to one space), and is true when the folded title carries a retail brand token AND one of three cues:
//   (a) a catalog word: "aktuel urun|katalog|liste", "katalog(u|lari)", "indirim katalog";
//   (b) a day range with a Turkish month, "(BİM 8-14 KASIM)" or "(28 EKİM-3 KASIM)": foldTr turns the parentheses and the
//       hyphen into spaces, so what is tested is "8 14 kasim" or "28 ekim 3 kasim";
//   (c) the brand with a dative or locative suffix AND "geliyor" or "satista": "BİM'E ... GELİYOR!", "BUGÜN SATIŞTA!
//       BİM'E ...", "iPhone Migros'ta satışta". foldTr turns the apostrophe into a space, so the suffix is a word of its own.
//
// Accepted misses and hits (the precision/recall trade of a title-only rule, pinned in tests/functions/_shared/retail-catalog.test.ts):
//   * false negative: "MONSTER OYUN BİLGİSAYARLARI 49.990 TL'DEN BAŞLAYAN FİYATLARLA BİM'DE!" carries the brand locative
//     but no catalog word, no day range and no "geliyor" / "satista". Production's own copy ends "(BİM 11-17 KASIM)", which
//     is cue (b), so only the bare form is missed.
//   * false positive: "BİM e-ticarete geliyor" folds to "bim e ticarete geliyor", whose "e" is read as the dative suffix.
//     The apostrophe is gone after the fold, so the two cannot be told apart; the cost is one dropped ticker attachment.
//
// Every pattern below is written with literal spaces as word delimiters (the folded text is padded with one space on each
// side) instead of \b / \m / \M, which JS and Postgres spell differently, so each `.source` is a valid Postgres ARE
// unchanged and public.is_retail_catalog (migration 178) embeds the five sources verbatim. No escape, no flag, no
// lookbehind, no \- in a class (tests/migrations/178-retail-catalog-ticker-gate.test.ts fails the build when the SQL drifts).
//
// Pure and dependency-free apart from foldTr (kap.ts has no imports and no Deno globals), so the same function can run in
// the Deno ingest functions and in Next. Nothing imports it yet: the gate is the SQL twin in the ticker resolver.

import { foldTr } from "../kap.ts";

// A retail brand as a whole folded word. "sok" also reads the word "şok" (shock): it only counts together with a cue.
const BRAND = / (bim|a101|sok|migros|carrefoursa) /;

// (a) "aktuel urun(ler)", "aktuel katalog", "aktuel liste(si)", any "katalog" word, "indirim katalog". The last pattern and
// the aktuel-katalog branch are contained in the bare "katalog" branch; they are kept as the spec words them.
const CATALOG_CUE = / (aktuel (urun|katalog|liste)|indirim katalog|katalog(u|lari)?)/;

// (b) two day numbers and a month ("8 14 kasim"), or a month between them ("28 ekim 3 kasim"). A single date followed by a
// year ("13 kasim 2026") is not a range: a day number is one or two digits and a space must follow it.
const DAY_RANGE =
  / [0-9]{1,2} ((ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik) )?[0-9]{1,2} (ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik) /;

// (c) the brand and the folded dative (e, a, ye, ya) or locative (de, da, te, ta) suffix, next to an arrival or sale verb.
const BRAND_SUFFIX = / (bim|a101|sok|migros|carrefoursa) (e|a|ye|ya|de|da|te|ta) /;
const ARRIVAL = / (geliyor|satista) /;

/**
 * The five rules, exported so the SQL twin can be checked against them (see the header). Not part of the runtime API:
 * callers use isRetailCatalog.
 */
export const RETAIL_CATALOG_PATTERNS = {
  BRAND,
  CATALOG_CUE,
  DAY_RANGE,
  BRAND_SUFFIX,
  ARRIVAL,
} as const;

/** True when the title is a retail-catalog or promo headline of a grocery chain (see the header). Never throws. */
export function isRetailCatalog(title: string): boolean {
  if (typeof title !== "string" || title === "") return false;
  const f = ` ${foldTr(title)} `;
  if (!BRAND.test(f)) return false;
  return CATALOG_CUE.test(f) || DAY_RANGE.test(f) || (BRAND_SUFFIX.test(f) && ARRIVAL.test(f));
}
