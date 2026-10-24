// supabase/functions/_shared/rss/title-jaccard.ts
//
// TS mirror of SQL `public.title_word_jaccard(text, text)` (migration 074,
// section 4): word-Jaccard similarity, 0..1, rounded to 3 decimals, between
// two headlines. Pure and import-free (it is covered by the edge-deps-pinned
// guard, and must stay loadable from Deno and from Vitest alike).
//
// What it is for: `ingest`'s twin drop. Two rows of one source that carry the
// same CMS article id under different urls are either one article whose
// headline was edited (the words overlap) or two different stories where the
// CMS reused an id (they share none: aksam 1708103, odatv 120168027, yenicag
// 1084546 on 2026-10-24). The SQL write-back gates the same way, at the same
// 0.2 -- `TITLE_TWIN_MIN_JACCARD`.
//
// Parity with the SQL function, step by step. It is pinned by
// tests/migrations/074-title-word-jaccard-parity.test.ts, which reads the
// literals below out of migration 074 and compares pairs computed by Postgres.
//
//   1. coalesce(null, '')                     -> `a ?? ""`
//   2. translate(t, FROM, TO)                 -> char by char (SQL_TRANSLATE_*)
//   3. lower(...)                             -> `toLowerCase()` of the WHOLE string
//   4. regexp_split_to_table(.., class)       -> `String.split(TITLE_SPLIT_RE)`
//   5. where t <> ''                          -> empty tokens dropped
//   6. distinct                               -> Set
//   7. union 0 -> 0, else round(i / u, 3)     -> Math.round(x * 1000) / 1000
//
// Steps 3 and 4 are NOT what the comment in migration 074 says. It assumes a C
// ctype, where lower() would be a no-op on non-ASCII and [:space:]/[:punct:]
// ASCII-only. Prod (Postgres 17, ICU locale provider, en_US.UTF-8) behaves
// differently, measured with read-only SELECTs on 2026-10-24:
//   - lower('CAFÉ') = 'café', and lower() is ICU u_strToLower of the whole
//     string (Greek final sigma applies), which is exactly JS toLowerCase().
//     translate() still matters: ICU's root rules would turn 'I' into 'i' but
//     leave 'ı', and 'İ' into 'i' + U+0307; translate() maps all three to 'i'.
//   - [:space:] and [:punct:] are ICU u_isspace and u_ispunct: Unicode
//     White_Space plus U+001C..U+001F, and general category P*. NBSP, the
//     middle dot and U+0085 split; the ASCII symbols $ + < = > ^ ` | ~ (all
//     category S*) do not. Over the BMP this regex and prod agree on every
//     code point except three Balinese signs that Unicode 16 made punctuation.
// Mirroring a C ctype instead would give CAFÉ vs café = 0 where prod says 1.

/** A same-key match is a twin only at or above this word-Jaccard (SQL gate: 0.2). */
export const TITLE_TWIN_MIN_JACCARD = 0.2;

/** translate() source characters in migration 074 (11 characters). */
export const SQL_TRANSLATE_FROM = "İIıÇŞĞÜÖÂÎÛ";
/** translate() target characters in migration 074, position for position. */
export const SQL_TRANSLATE_TO = "iiiçşğüöâîû";
/** Characters migration 074 adds to [[:space:][:punct:]] when splitting. */
export const SQL_SPLIT_EXTRA_CHARS = "“”‘’«»…–—";

/**
 * Token separator: ICU u_isspace + u_ispunct plus the SQL class's explicit
 * characters. Not global or sticky, so it carries no lastIndex state.
 */
export const TITLE_SPLIT_RE = new RegExp(
  `[\\p{White_Space}\\p{P}\\u001c-\\u001f${SQL_SPLIT_EXTRA_CHARS}]+`,
  "u",
);

const TRANSLATE = new Map<string, string>();
{
  const from = Array.from(SQL_TRANSLATE_FROM);
  const to = Array.from(SQL_TRANSLATE_TO);
  from.forEach((ch, i) => TRANSLATE.set(ch, to[i] ?? ch));
}

function translate(s: string): string {
  let out = "";
  for (const ch of s) out += TRANSLATE.get(ch) ?? ch;
  return out;
}

/**
 * The distinct lower-cased words of a headline (steps 1-6 above). Exposed so a
 * caller that compares one headline against many (ingest's twin gate) tokenizes
 * each headline ONCE and compares the sets with `jaccardOfSets`, instead of
 * re-tokenizing both strings on every `titleWordJaccard` call.
 */
export function titleTokens(s: string | null | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const t of translate(s ?? "").toLowerCase().split(TITLE_SPLIT_RE)) {
    if (t !== "") out.add(t);
  }
  return out;
}

/**
 * Step 7 on two token sets: `|A n B| / |A u B|` rounded to 3 decimals; 0 when
 * both are empty. Does not mutate its arguments.
 */
export function jaccardOfSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  if (union === 0) return 0;
  return Math.round((inter / union) * 1000) / 1000;
}

/**
 * Word-Jaccard of two headlines, `|A n B| / |A u B|` over their distinct
 * lower-cased word sets, rounded to 3 decimals; 0 when both are empty or null.
 */
export function titleWordJaccard(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  return jaccardOfSets(titleTokens(a), titleTokens(b));
}
