import { turkishQueryVariants } from "@/lib/clusters/turkish-query";
import {
  RISING_ENTITIES,
  RISING_FOLD_FROM,
  RISING_FOLD_TO,
  RISING_HUB_SPECS,
  type RisingEntity,
  type RisingHubSpec,
} from "@/lib/trends/rising-entities";

// Pure helpers behind the /gundem/[key] entity hubs. No I/O, no clock and no
// Next import, so the page, its metadata and the tests share one definition
// and the middleware-facing vocabulary (rising-entities.ts) stays the only
// source of truth for which hubs exist.

/** Days of coverage a hub shows. Mirrors the SQL default in migrations 123 and 125. */
export const ENTITY_HUB_WINDOW_DAYS = 14;
/** Clusters listed per hub (the RPC clamps p_limit to 1..50). */
export const ENTITY_HUB_LIMIT = 20;
/** A hub with fewer clusters than this is thin and stays out of the index. */
export const ENTITY_HUB_MIN_INDEXABLE = 3;
/**
 * Most queries, and most patterns, a hub sends. Mirrors the `[1:12]` slices in
 * migration 125, which ignore anything beyond the 12th element.
 */
export const ENTITY_HUB_MAX_TERMS = 12;

// A Map, not an object lookup: "__proto__", "constructor" and friends must
// never resolve to something.
const ENTITY_BY_KEY: ReadonlyMap<string, RisingEntity> = new Map(
  RISING_ENTITIES.map((e) => [e.key, e]),
);

/** The curated entity for a route key, or null when the key is unknown. */
export function entityByKey(key: string): RisingEntity | null {
  return typeof key === "string" ? (ENTITY_BY_KEY.get(key) ?? null) : null;
}

export function isEntityKey(key: string): boolean {
  return typeof key === "string" && ENTITY_BY_KEY.has(key);
}

// Moved to @/lib/bias/sum-distributions (shared with /konu/[slug]); re-exported
// so the /gundem/[key] page and its tests keep importing it from here.
export { sumDistributions } from "@/lib/bias/sum-distributions";

/**
 * Robots override for a hub: noindex (but follow) when the read failed or the
 * hub is thin; undefined (inherit the site default, indexable) otherwise.
 */
export function entityHubRobots(
  result: { bundles: readonly unknown[] } | null,
): { index: false; follow: true } | undefined {
  if (result === null || result.bundles.length < ENTITY_HUB_MIN_INDEXABLE) {
    return { index: false, follow: true };
  }
  return undefined;
}

/** "Son 14 günde 422 küme · en yeni 20 tanesi listeleniyor". */
export function entityHubNote(total: number, shown: number): string {
  const base = `Son ${ENTITY_HUB_WINDOW_DAYS} günde ${total} küme`;
  return total > shown ? `${base} · en yeni ${shown} tanesi listeleniyor` : base;
}

// ---------------------------------------------------------------------------
// Precision (migration 125). A hub lists only stories that LITERALLY name the
// entity: the stemmed tsquery over `queries` gives recall on the GIN index, and
// a regex guard over `patterns`, run on text folded exactly like migration 112,
// gives precision (no "devam" under DEVA, "domuz" under Dolar, "iyi" under İYİ
// Parti). Both lists come from the curated vocabulary only, never from request
// input.
//
// Scope and amounts (2026-11-01, app-side only: no migration). Migration 125
// runs `~ any(p_patterns)` on the whole folded text, so a pattern may open with
// a lookahead and see all of it:
//   * excludes (aym, tcmb, meclis): a non-trusted form is prefixed with
//     `^(?![\s\S]*(?:<cue>|<cue>))[\s\S]*`, so "Polonya'da polis Anayasa
//     Mahkemesi'ni bastı", "Avrupa Merkez Bankası" and "İsrail meclisi" are not
//     the Turkish institutions. A trusted alias (AYM, TCMB, TBMM, Büyük Millet
//     Meclisi) stays bare: it names the institution on its own.
//   * quantityGuard (dolar): `\m` + QUANTITY_GUARD + word, so "100 dolar", "2,1
//     milyar dolarlık" and "milyarlarca doları" are amounts, not the currency.
//   * inflections (akp, dem, iyi-parti, asgari-ucret, pkk, borsa): widen the
//     stemmed prefilter only; the patterns do not change.
// Postgres AREs support (?!...) and (?<!...) (checked on production). A pattern
// starts with `^`, never `(?`, which Postgres would read as embedded options.
//
// Measured read-only on production, 2026-11-01, 14-day window, live clusters
// (not archived, article_count >= 2, merged_into is null). old = rows the
// pre-change patterns kept; new = rows the new patterns keep; ceiling = every
// live cluster whose text literally matches the new patterns, whatever the
// prefilter says (for the inflection keys old and new are prefilter-and-guard
// counts with and without the inflected queries). All 72 patterns of the 62
// entities compile (`select 'x' ~ p`), and the 21 behaviour samples of
// entity-hub.test.ts give the same answer in Postgres and in the JS twin.
//
//   key           old   new   ceiling   note
//   aym            40    31       31    9 dropped, all Polonya; 0 Polonya left
//   tcmb            5     2        2    dropped: Avrupa and İsrail Merkez Bankası, FED
//   meclis        409   313      317    CUE retention 251/281 = 0.89 (see below)
//   dolar          44     2        2    63 literal before; all 42 dropped are amounts
//   akp           322   331      331    prefilter 'ak partili', 'ak partimize'
//   dem            30    32       32    'dem partili'
//   iyi-parti      36    38       38    'iyi partili'
//   asgari-ucret    5     6        6    'asgari ücretli', 'asgari ücretlilerin'
//   pkk            11    12       12    'pkk/kck'
//
// The 125 header lists dolar at 70% recall as a gap. It is not: the misses are
// "dolarlık" and "X milyar dolar" amounts, and they are now excluded on purpose.
// Of the 44 rows the old pattern kept, 42 are sums of money (Patriot sales,
// trade targets, fund crises, "111 doları"); the 2 left are one currency
// report and one "75 milyon ABD doları" (a qualifier between the quantity word
// and "doları", the one known hole). 'dolarlık' is deliberately not a form.
//
// meclis, retention. CUE = tbmm | büyük millet meclisi | milletvekili | genel
// kurul | kurtulmuş | chp | akp | ak parti | mhp | dem parti. NEW∩CUE over
// OLD∩CUE is 0.89, under the 0.97 target, and swapping the bare 'israil' and
// 'iran' for 'israil meclis' and 'iran meclis' reaches only 0.92 (258/281) while
// letting 20 more rows in. The loss is not recall: of the 30 CUE rows dropped,
// 19 are municipal councils ("Üsküdar Belediyesi başkan vekili seçimi", "MHP'li
// belediye meclis üyesi"), 10 are Israeli or Libyan politics and 1 is
// Luxembourg's parliament, where a party name or "milletvekili" is the whole
// CUE. About 3 look like Turkish politics (Mekke Anlaşması, a Libya maritime
// agreement, a local-government reform); the real retention is near 0.99. The
// other target, at most 2 foreign or municipal rows among the newest 50 NEW
// rows without CUE, is NOT met: about 11 remain (an Albanian parliament, an
// Egyptian approval, Bakırköy, Milas and İzmir municipal stories) plus about
// 14 chamber-of-commerce "meclis" rows (İTO, MTO, ATSO). A phrase list cannot
// close that; a Meclis hub that requires a parliamentary cue is the next step.
// ---------------------------------------------------------------------------

const FOLD_MAP: ReadonlyMap<string, string> = (() => {
  const from = [...RISING_FOLD_FROM];
  const to = [...RISING_FOLD_TO];
  return new Map(from.map((ch, i) => [ch, to[i] as string]));
})();

/**
 * JS twin of the SQL fold in migration 125 (and 112):
 * `lower(translate(text, FOLD_FROM, FOLD_TO))`. `translate` runs BEFORE
 * `toLowerCase`, so the capital dotted İ and the capital dotless I both become
 * a plain "i" instead of the two-code-point "i̇" that JS lowercasing gives İ.
 */
export function foldEntityText(text: string): string {
  let folded = "";
  for (const ch of text) folded += FOLD_MAP.get(ch) ?? ch;
  return folded.toLowerCase();
}

// A Map, not an object lookup, for the same reason as ENTITY_BY_KEY.
const HUB_SPEC_BY_KEY: ReadonlyMap<string, RisingHubSpec> = new Map(
  Object.entries(RISING_HUB_SPECS),
);

/** The hub-only search data for an entity; `{}` (label, whole word) when none is curated. */
export function entityHubSpec(entity: RisingEntity): RisingHubSpec {
  return HUB_SPEC_BY_KEY.get(entity.key) ?? {};
}

/**
 * The spellings a hub searches: the curated aliases when there are any, else
 * the label alone. Display spellings, with Turkish letters and capitals.
 * `spec` defaults to the curated one; tests pass their own.
 */
export function entityHubForms(
  entity: RisingEntity,
  spec: RisingHubSpec = entityHubSpec(entity),
): readonly string[] {
  return spec.aliases !== undefined && spec.aliases.length > 0 ? spec.aliases : [entity.label];
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/**
 * `p_queries` for entity_cluster_ids_v2: the Turkish lexeme spellings
 * (turkishQueryVariants) of every form, then of every curated inflection,
 * deduped and capped at ENTITY_HUB_MAX_TERMS (so a cap can only ever drop an
 * inflection). The RPC ORs them into one websearch tsquery. Inflections widen
 * the prefilter only: entityHubPatterns ignores them.
 */
export function entityHubQueries(
  entity: RisingEntity,
  spec: RisingHubSpec = entityHubSpec(entity),
): string[] {
  return dedupe(
    [...entityHubForms(entity, spec), ...(spec.inflections ?? [])].flatMap((form) =>
      turkishQueryVariants(form),
    ),
  ).slice(0, ENTITY_HUB_MAX_TERMS);
}

/**
 * Lookbehinds that keep a word out of amounts, for a `quantityGuard` entity:
 * the word may not follow a digit ("100 dolar", "2,1 milyar dolarlık", "49,57
 * dolar") or a quantity word ("bin", "milyon", "milyar", "trilyon",
 * "milyonlarca", "milyarlarca"). PostgreSQL AREs support (?<!...); every one
 * is a single fixed-length alternative, so each is its own lookbehind.
 */
export const QUANTITY_GUARD =
  "(?<![0-9]\\s)(?<![0-9])(?<!bin\\s)(?<!milyon\\s)(?<!milyar\\s)(?<!trilyon\\s)(?<!milyonlarca\\s)(?<!milyarlarca\\s)";

/** The folded, ASCII, non-empty words of a phrase (the shape of a pattern word). */
function foldedWords(text: string): string[] {
  return foldEntityText(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}

/**
 * One alternative of the exclude guard: `\m` + the words joined by `\s+`. It
 * stays open-ended ("polonya" catches "polonyada", "belediye meclis" catches
 * "belediye meclisinde") except for a single word of 3 letters or fewer, which
 * takes `\M`: "fed" must not hit "federasyon".
 */
function excludeAlternative(words: readonly string[]): string {
  const closed = words.length === 1 && (words[0] as string).length <= 3;
  return `\\m${words.join("\\s+")}${closed ? "\\M" : ""}`;
}

/**
 * `p_patterns` for entity_cluster_ids_v2: one PostgreSQL regex (ARE) per form,
 * matched against the folded title and summary. For each form: fold it, split
 * it into words on /[^a-z0-9]+/ and join them with `\s+`.
 *   * single word -> `\m<w>\M` (a word of its own), or `\m<w>` for a
 *     `hubMatch: 'prefix'` entity whose word takes suffixes ("dolara").
 *   * several words -> `\m<w1>\s+<w2>` with NO closing `\M`: the last word may
 *     take a suffix ("AK Partili", "Merkez Bankasının", "asgari ücrete") and
 *     the words being adjacent already keeps it precise.
 * An apostrophe suffix ("DEVA'nın", "Erdoğan'ın") still meets `\M`, because the
 * apostrophe is not a word character. Forms that fold to nothing are dropped.
 *
 * Two optional guards, both built from curated data only:
 *   * `quantityGuard`: a single-word base becomes `\m` + QUANTITY_GUARD + word,
 *     so "100 dolar" and "2,1 milyar dolarlık" are not the currency.
 *   * `excludes`: a form that is not `trusted` is prefixed with
 *     `^(?![\s\S]*(?:<alt>|<alt>))[\s\S]*`, a lookahead over the whole text, so
 *     "Polonya'da ... Anayasa Mahkemesi" never matches. The pattern starts with
 *     `^`, never `(?`, which Postgres would read as embedded options. A trusted
 *     form ("TCMB") stays bare.
 */
export function entityHubPatterns(
  entity: RisingEntity,
  spec: RisingHubSpec = entityHubSpec(entity),
): string[] {
  const prefix = spec.hubMatch === "prefix";
  const trusted = new Set(spec.trusted ?? []);
  const alternatives = (spec.excludes ?? [])
    .map(foldedWords)
    .filter((words) => words.length > 0)
    .map(excludeAlternative);
  const guard = alternatives.length > 0 ? `^(?![\\s\\S]*(?:${alternatives.join("|")}))[\\s\\S]*` : "";
  const patterns: string[] = [];
  for (const form of entityHubForms(entity, spec)) {
    const words = foldedWords(form);
    if (words.length === 0) continue;
    const body = words.join("\\s+");
    const base =
      words.length > 1
        ? `\\m${body}`
        : spec.quantityGuard === true
          ? `\\m${QUANTITY_GUARD}${body}${prefix ? "" : "\\M"}`
          : `\\m${body}${prefix ? "" : "\\M"}`;
    patterns.push(trusted.has(form) ? base : `${guard}${base}`);
  }
  return dedupe(patterns).slice(0, ENTITY_HUB_MAX_TERMS);
}
