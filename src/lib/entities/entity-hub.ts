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
 */
export function entityHubPatterns(
  entity: RisingEntity,
  spec: RisingHubSpec = entityHubSpec(entity),
): string[] {
  const prefix = spec.hubMatch === "prefix";
  const patterns: string[] = [];
  for (const form of entityHubForms(entity, spec)) {
    const words = foldEntityText(form)
      .split(/[^a-z0-9]+/)
      .filter((w) => w !== "");
    if (words.length === 0) continue;
    const body = words.join("\\s+");
    patterns.push(words.length === 1 ? `\\m${body}${prefix ? "" : "\\M"}` : `\\m${body}`);
  }
  return dedupe(patterns).slice(0, ENTITY_HUB_MAX_TERMS);
}
