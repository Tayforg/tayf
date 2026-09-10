import { getSourceMetadata } from "./factuality";

// Shared "is this source classified?" predicate. `<SourceChips>` already
// decides "nothing to render" with this exact rule (factuality.ts's
// `SOURCE_METADATA` map covers only the ~30 hand-tagged outlets); this
// module lifts the rule out so both the chip and /sources can agree on one
// definition of "sınıflandırılmamış" instead of drifting apart.

export const UNCLASSIFIED_LABEL_TR = "sınıflandırılmamış";
export const UNCLASSIFIED_TITLE_TR =
  "Doğruluk ve sahiplik bilgisi henüz girilmedi.";

/**
 * True when a source has at least one of factuality / ownership tagged in
 * `SOURCE_METADATA`. False for slugs with no entry at all, and false for an
 * entry where both fields are still `null`.
 */
export function isClassifiedSource(slug: string): boolean {
  const meta = getSourceMetadata(slug);
  if (!meta) return false;
  return meta.factuality !== null || meta.ownership !== null;
}

/**
 * Counts how many of the given slugs are classified per
 * `isClassifiedSource`. Used by `/sources` to report directory-wide
 * coverage ("N/M kaynak etiketli") instead of a per-card
 * "sınıflandırılmamış" chip.
 */
export function countClassifiedSources(
  slugs: ReadonlyArray<string>,
): number {
  return slugs.filter(isClassifiedSource).length;
}
