// supabase/functions/_shared/cluster/description-clean.ts
//
// Clustering-time clean-up of an article description. Pure, no imports:
// unit-tested from vitest and used from Deno.
//
// Milliyet's RSS description ends with the site's own "Son dakika..." ticker,
// the headline of a different, unrelated story ("...harekete geçebilir.\nSon
// dakika... MHP lideri Bahçeli'den 100 il 1000 ilçe açıklaması! ..."). Fed
// into the entity extractor, the fingerprint and the tf-idf index, it gave the
// article foreign entities (mhp, bahceli on a social-media age-verification
// scam, article 942d7061), seeded an off-topic cluster, and pulled three
// Bahçeli articles into it (hunt 12, h12-cluster-5).
//
// This runs ONLY in the cluster consumer, on the way into enrichment. It is
// deliberately not wired into rss/normalize.ts: strictFingerprint, content_hash
// and normalizeItem output stay byte-identical (tests/functions/_shared/
// ingest-corpus-equality.test.ts), and the stored description is untouched.

// A ticker line: "Son dakika", "SON DAKİKA" or "Son Dakika" at the start of a
// line (leading blanks allowed), followed by 1-3 dots, an ellipsis, a colon or
// an exclamation mark. "Son dakika haberi" (no punctuation) and a lower-case
// "son dakika" mid-sentence are not tickers.
const TICKER_LINE = /^\s*(?:Son dakika|SON DAKİKA|Son Dakika)\s*(?:\.{1,3}|…|:|!)/u;

export function cleanDescription(d: string): string;
export function cleanDescription(d: string | null): string | null;
export function cleanDescription(d: string | undefined): string | undefined;
export function cleanDescription(d: string | null | undefined): string | null | undefined;
export function cleanDescription(d: string | null | undefined): string | null | undefined {
  if (!d) return d;
  // The first line can never be a ticker block: the ticker is appended to an
  // article, so a "Son dakika..." opening is the article's own text.
  let at = d.indexOf("\n");
  while (at !== -1) {
    const next = d.indexOf("\n", at + 1);
    const line = d.slice(at + 1, next === -1 ? d.length : next);
    if (TICKER_LINE.test(line)) return d.slice(0, at).trimEnd();
    at = next;
  }
  return d;
}
