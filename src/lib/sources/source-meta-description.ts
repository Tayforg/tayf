import { BIAS_LABELS } from "@/lib/bias/config";
import { formatCountTr } from "@/lib/format/number-tr";
import { isThinSource } from "@/lib/seo/thin-source";
import { SOURCE_KIND_META, isVotingSource, sourceKindOf } from "@/lib/sources/kind";
import type { Source } from "@/types";

// The <meta name="description"> of /source/[slug] (also the openGraph and
// twitter description). Pure: a function of the source and its 7-day count.
//
// A voting source (outlet, wire) is described by its bias label and "siyasi
// duruşu" - the two strings below are the ones the page wrote inline before
// h37-content-2 and are pinned verbatim by the test. An aggregator or niche
// source does not vote (it is not on the spectrum, see kind.ts), so its
// snippet names the kind instead of a stance and never says "siyasi duruş".

/**
 * `source` is the `name`, `bias` and `kind` of the row; a missing `kind` is an
 * outlet. `articleCount7d` below the thin-source threshold gives the short
 * "0 haber"-free variant that the page also marks `noindex`.
 */
export function sourceMetaDescription(
  source: Pick<Source, "name" | "bias" | "kind">,
  articleCount7d: number,
): string {
  const thin = isThinSource(articleCount7d);

  if (!isVotingSource(source)) {
    const kindLabel = SOURCE_KIND_META[sourceKindOf(source)].label;
    return thin
      ? `${source.name} (${kindLabel}) kaynağının Tayf profili ve geçmiş haberleri.`
      : `${source.name} (${kindLabel} kaynak) — son 7 günde ${formatCountTr(articleCount7d)} haber. Tayf üzerinden bu kaynağın son haberlerini görün.`;
  }

  const biasLabel = BIAS_LABELS[source.bias];
  return thin
    ? `${source.name} (${biasLabel}) kaynağının Tayf profili: siyasi duruşu ve geçmiş haberleri.`
    : `${source.name} (${biasLabel}) — son 7 günde ${formatCountTr(articleCount7d)} haber. Tayf üzerinden bu Türk haber kaynağının son haberlerini ve siyasi duruşunu görün.`;
}
