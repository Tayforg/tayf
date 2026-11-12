// View-model for one /saved row: turns the loosely-typed `bias_distribution`
// and `is_blindspot` that saved_clusters_v3 (migration 158; v2 from 124 has the
// same two) returns into what the list renders. Pure and client-safe: no
// network, no storage, no React.
//
// The row comes from jsonb, so nothing about it is trusted. A hand-edited or
// legacy distribution must never reach <BiasSpectrum> as NaN, a negative or a
// string (that would draw a broken bar), so every category is normalised here
// and an unusable distribution becomes `null` (the row then shows no bar).
//
// `is_blindspot` is absent on rows from the v1 fallback (saved_clusters, used
// while migration 124 is not applied yet); absent means "not flagged".
//
// `first_published` comes only from v3 (h38-saved-1). The database already
// applies the recall veto to `is_blindspot` (migration 138); `toPublicSavedRow`
// adds the BLINDSPOT.feedDelayHours wait every other surface applies, through
// publicBlindspotClaim, so /saved shows the "Kör nokta" pill no earlier than a
// card does. On a v2 or v1 row there is no first_published and the claim is the
// veto-only one it was before.
//
// `effective_article_count` comes only from v4 (h112-follows-3, migration 192): the wire-collapsed member count
// the cards, the cluster page and /api/takip print as "N kaynak". `savedSourceLabel` prints it, falling back to
// the stored `article_count` on a v3 / v2 / v1 row or a cluster with no member rows.
import { BIAS_ORDER } from "@/lib/bias/config";
import { sourceCountOf, type SnapshotRow } from "@/components/bookmark/bookmark-snapshots";
import { publicBlindspotClaim } from "@/lib/clusters/recall-veto";
import { formatTurkishTimeAgo } from "@/lib/time";
import type { BiasDistribution } from "@/types";

export interface SavedRowView {
  /** Every bias category present, as a finite count >= 0; null when unusable or empty. */
  distribution: BiasDistribution | null;
  /** True only for a real boolean `true` (never the string "true" or 1). */
  isBlindspot: boolean;
}

export function toSavedRowView(row: { bias_distribution: unknown; is_blindspot?: unknown }): SavedRowView {
  return {
    distribution: toDistribution(row.bias_distribution),
    isBlindspot: row.is_blindspot === true,
  };
}

/**
 * True when an RPC answer means "this function does not exist (yet)": PostgREST
 * PGRST202 (not in the schema cache, migration not applied or cache not yet
 * reloaded) or Postgres 42883 (undefined_function). Only these send /saved to
 * the older lookup; any other error is a real failure and keeps the fail-open path.
 */
export function isRpcMissing(error: { code?: string } | null | undefined): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

/**
 * The row with `is_blindspot` replaced by the claim a reader may see now:
 * `publicBlindspotClaim`, i.e. the flag, and only once the cluster is
 * BLINDSPOT.feedDelayHours past `first_published`. The veto is not applied
 * again here (the RPC did, migration 138); a missing, null or unparseable
 * `first_published` (a v2 / v1 row), or a non-finite clock, passes the flag
 * through, so missing data never hides a claim. Returns a copy; always a real
 * boolean, which is all toSavedRowView reads.
 *
 * `nowMs` is passed in, read once by the caller after the rows have loaded
 * (never during a render).
 */
export function toPublicSavedRow<R extends { is_blindspot?: unknown; first_published?: unknown }>(
  row: R,
  nowMs: number,
): R & { is_blindspot: boolean } {
  const claim = publicBlindspotClaim(
    {
      is_blindspot: row.is_blindspot === true,
      blindspot_side: null,
      first_published: typeof row.first_published === "string" ? row.first_published : null,
    },
    nowMs,
  );
  return { ...row, is_blindspot: claim.isBlindspot };
}

/**
 * "N kaynak" for a /saved row: the effective (wire-collapsed) count when the row has one, else `article_count`.
 * The same number the "+N yeni kaynak" badge compares (`sourceCountOf`), so a story of 6 outlets that reprint
 * 3 distinct texts reads "3 kaynak" here.
 *
 * Known gap (h138-roadmap2-1): the card and the cluster page count a text as one when two outlets share a
 * content_hash OR the same agency lead, but `saved_clusters_v4` (migration 192) counts distinct content_hash
 * only. A cluster linked only by a shared agency lead can therefore read higher on /saved until a follow-up
 * migration mirrors `descriptionKey` (wire.ts). Example: 532ee77c reads 8 here and 3 on its card and page.
 */
export function savedSourceLabel(row: Pick<SnapshotRow, "article_count" | "effective_article_count">): string {
  return `${sourceCountOf({ bias_distribution: null, ...row })} kaynak`;
}

/**
 * The age shown on a /saved row, labelled as what it is. The row shows
 * `updated_at` (the last update of the cluster), not `first_published` (v3
 * returns that only for the claim wait above), so a bare "8 saat önce" read
 * like a publication time. Yields "Son güncelleme: 8 saat önce", or "Son güncelleme: 12 Ekim 2026"
 * once the age is old enough that formatTurkishTimeAgo switches to a date.
 * `now` is only for tests; the real clock is used when it is omitted. An
 * unparseable timestamp gives "" so the caller can hide the label.
 */
export function savedUpdatedLabel(iso: string, now?: number): string {
  const when = formatTurkishTimeAgo(iso, now === undefined ? undefined : { now });
  return when === "" ? "" : `Son güncelleme: ${when}`;
}

function toDistribution(value: unknown): BiasDistribution | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out = {} as BiasDistribution;
  let total = 0;
  // Only the known categories are read, so unknown keys are dropped.
  for (const key of BIAS_ORDER) {
    const v = raw[key];
    const n = typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
    out[key] = n;
    total += n;
  }
  return total > 0 ? out : null;
}
