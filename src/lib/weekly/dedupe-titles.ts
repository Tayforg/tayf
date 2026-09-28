// browser-qa-15: /hafta's "En geniş yelpaze" and "Kör noktalar" lists could
// show the same real-world story twice when Jev's clustering split a single
// event into two clusters with cosmetically different headlines (case,
// punctuation, an added "!"). Pure, unit-tested title folding + de-dup so
// weekly-query.ts's `summariseWeek` can collapse those before slicing to
// WEEKLY_LIST_SIZE.

/**
 * Folds a title to a comparison key: NFC-normalizes, lowercases with the
 * Turkish locale (so "İ" → "i̇" / "I" → "ı" fold the way a Turkish reader
 * would expect), then strips punctuation, symbols and whitespace runs
 * entirely — "CHP'den istifa etti!" and "CHP’DEN İSTİFA ETTİ" fold to the
 * same key.
 */
export function normalizeWeeklyTitle(title: string): string {
  return title
    .normalize("NFC")
    .toLocaleLowerCase("tr")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

/**
 * Keeps only the FIRST row of each group of rows whose `titleOf(row)` folds
 * to the same key, preserving the input's order. Callers sort by whatever
 * ranking they want (e.g. article count descending) BEFORE calling this, so
 * "first" means "highest-ranked" in practice.
 */
export function dedupeByTitle<T>(rows: readonly T[], titleOf: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = normalizeWeeklyTitle(titleOf(row));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
