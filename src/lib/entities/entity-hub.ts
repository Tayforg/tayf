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
//   * requires (meclis): the same non-trusted form also needs one cue anywhere
//     in the text, a positive lookahead after the exclude one:
//     `^(?![\s\S]*(?:<ex>))(?=[\s\S]*(?:<req>))[\s\S]*`. The bare "Meclis"
//     counts only beside "TBMM", "genel kurul", "milletvekili", a party name and
//     the like, so an İTO, ATSO or MTO "meclis toplantısı", a municipal council
//     and a foreign parliament drop out.
//   * quantityGuard (dolar): `\m` + QUANTITY_GUARD + word, so "100 dolar", "2,1
//     milyar dolarlık" and "milyarlarca doları" are amounts, not the currency.
//   * inflections (akp, dem, iyi-parti, asgari-ucret, pkk, borsa): widen the
//     stemmed prefilter only; the patterns do not change.
// Postgres AREs support (?=...), (?!...) and (?<!...) (checked on production). A
// pattern starts with `^`, never `(?`, which Postgres would read as embedded
// options.
//
// Measured read-only on production, 2026-11-01, 14-day window, live clusters
// (not archived, article_count >= 2, merged_into is null). old = rows the
// pre-change patterns kept; new = rows the new patterns keep; ceiling = every
// live cluster whose text literally matches the new patterns, whatever the
// prefilter says (for the inflection keys old and new are prefilter-and-guard
// counts with and without the inflected queries). All 72 patterns of the 62
// entities compile (`select 'x' ~ p`), and the 21 behaviour samples of
// entity-hub.test.ts, plus the 16 meclis samples of the requires step, give the
// same answer in Postgres and in the JS twin. entity_cluster_ids_v2 called with
// the app's exact arrays returns the 255 meclis rows the counts below say.
//
//   key           old   new   ceiling   note
//   aym            40    31       31    9 dropped, all Polonya; 0 Polonya left
//   tcmb            5     2        2    dropped: Avrupa and İsrail Merkez Bankası, FED
//   meclis        409   255      258    409 -> 313 (excludes) -> 255 (requires); see below
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
// meclis, in two steps. CUE = tbmm | büyük millet meclisi | milletvekili | genel
// kurul | kurtulmuş | chp | akp | ak parti | mhp | dem parti.
//   1. Excludes (foreign and municipal cues) took 409 rows to 313. CUE
//      retention was 0.89 (251/281): of the 30 CUE rows dropped, 19 were
//      municipal councils, 10 Israeli or Libyan politics and 1 Luxembourg's
//      parliament, where a party name or "milletvekili" is the whole CUE.
//      Swapping the bare 'israil' and 'iran' for 'israil meclis' and 'iran
//      meclis' reached only 0.92 while letting 20 more rows in. A phrase list
//      could not close the rest: about 11 foreign or municipal rows (an Albanian
//      parliament, an Egyptian approval, Bakırköy, Milas and İzmir municipal
//      stories) and about 14 chamber-of-commerce "meclis" rows (İTO, MTO, ATSO)
//      stayed among the newest 50 rows without CUE.
//   2. Requires (this step) took 313 rows to 255: the bare "Meclis" now needs
//      one cue (tbmm, genel kurul, milletvekil, kanun/yasa teklif, grup
//      toplanti, meclis baskan, kurtulmus, komisyon, butce gorusme or a party
//      name) in the same folded text, and the excludes gained ticaret/sanayi
//      odası, ito, mto, atso, belediyesi meclis, büyükşehir meclis, meclis
//      üyesi and arnavutluk. NEW∩CUE over OLD∩CUE is 242/250 = 0.97 (target
//      0.95; against the first 409 rows it is 242/279 = 0.87, the same
//      municipal and foreign rows as in step 1). The 8 CUE rows dropped are all
//      municipal councils, 7 by 'meclis üyesi' and 1 by 'belediyesi meclis': an
//      MHP'li council member shot in Kocaeli, CHP council members expelled or
//      resigning (Tarsus, Kemer, İBB, 86 who joined Yeni Parti), a Kartal
//      council session and a Sarıyer council decision. One more row, under the
//      wider "milletvekil" cue, is the Albanian parliament, dropped by
//      'arnavutluk' as it should be.
//      Residue: among the newest 50 NEW rows that match only the bare 'Meclis'
//      pattern (not tbmm, not büyük millet meclisi) there are 7. Five are the
//      Turkish parliament ("Meclis'te Yeni Yol grubu düştü", Tanrıkulu's
//      araştırma komisyonu, the Sarıgül fezleke, a soru önergesi) and 2 are
//      foreign, municipal or chamber rows (target at most 2, met exactly): a
//      Gaziantep Ticaret Borsası "meclis başkanı" story and the Kadıköy "CHP
//      meclis grubu" story. Both carry a real cue word, so only a narrower
//      phrase ('ticaret borsas') could close the first; the second reads the
//      same as a TBMM group story and is left alone.
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
 * One alternative of the exclude and require guards: `\m` + the words joined
 * by `\s+`. It stays open-ended ("polonya" catches "polonyada", "belediye
 * meclis" catches "belediye meclisinde") except for a single word of 3 letters
 * or fewer, which takes `\M`: "fed" must not hit "federasyon", "chp" must not
 * hit "chpx".
 */
function excludeAlternative(words: readonly string[]): string {
  const closed = words.length === 1 && (words[0] as string).length <= 3;
  return `\\m${words.join("\\s+")}${closed ? "\\M" : ""}`;
}

/** The alternatives of a curated phrase list; entries that fold to nothing are dropped. */
function guardAlternatives(phrases: readonly string[] | undefined): string[] {
  return (phrases ?? [])
    .map(foldedWords)
    .filter((words) => words.length > 0)
    .map(excludeAlternative);
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
 * Three optional guards, all built from curated data only:
 *   * `quantityGuard`: a single-word base becomes `\m` + QUANTITY_GUARD + word,
 *     so "100 dolar" and "2,1 milyar dolarlık" are not the currency.
 *   * `excludes`: a form that is not `trusted` is prefixed with
 *     `^(?![\s\S]*(?:<alt>|<alt>))[\s\S]*`, a lookahead over the whole text, so
 *     "Polonya'da ... Anayasa Mahkemesi" never matches.
 *   * `requires`: the same form also needs at least one cue anywhere in the
 *     text, a positive lookahead `(?=[\s\S]*(?:<alt>|<alt>))` placed after the
 *     exclude one: `^(?![\s\S]*(?:<ex>))(?=[\s\S]*(?:<req>))[\s\S]*`. So the
 *     bare "Meclis" of an İTO or a municipal story, with no TBMM cue, is out.
 *   The guard is emitted only when either list holds a usable entry. The
 *   pattern starts with `^`, never `(?`, which Postgres would read as embedded
 *   options. A trusted form ("TCMB", "TBMM") stays bare.
 */
export function entityHubPatterns(
  entity: RisingEntity,
  spec: RisingHubSpec = entityHubSpec(entity),
): string[] {
  const prefix = spec.hubMatch === "prefix";
  const trusted = new Set(spec.trusted ?? []);
  const excludeAlts = guardAlternatives(spec.excludes);
  const requireAlts = guardAlternatives(spec.requires);
  const guard =
    excludeAlts.length > 0 || requireAlts.length > 0
      ? `^${excludeAlts.length > 0 ? `(?![\\s\\S]*(?:${excludeAlts.join("|")}))` : ""}${
          requireAlts.length > 0 ? `(?=[\\s\\S]*(?:${requireAlts.join("|")}))` : ""
        }[\\s\\S]*`
      : "";
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
