import { isVotingKind, normalizeSourceKind, zoneOf } from "@/lib/bias/config";
import type { BiasCategory, MediaDnaZone, SourceKind } from "@/types";

/**
 * kap-media-pickup — pure logic for "Medyada yankı" (/ekonomi/[ticker]) and
 * the keyed `GET /api/v1/kap/pickup` endpoint.
 *
 * The window rule is LITERAL per disclosure: each KAP disclosure counts
 * every mention published in its own [t, t+48h) window, regardless of
 * whether another disclosure of the same ticker also claims that mention.
 * Overlapping disclosures double-count the same article on purpose — the
 * `overlapping` field on each result makes that visible instead of hiding
 * it behind a dedup rule. A mention strictly before its disclosure's `t`
 * is never pickup, no matter how close.
 *
 * `disclosure_coverage` (the existing view used by the page's "KAP ile
 * basın arası" panel) is NEVER queried here: an unbounded count against it
 * timed out at 60s in production (see data-3 evidence). Everything below
 * works off `kap_disclosures` and `article_tickers` directly, always
 * ticker- and time-bounded.
 */

export const PICKUP_WINDOW_HOURS = 48;
const PICKUP_WINDOW_MS = PICKUP_WINDOW_HOURS * 3_600_000;

/**
 * data-3: 15.9% of scored article_tickers rows sampled below 0.2 were all
 * false matches (political-party-vs-ticker collisions like DEVA). Rows
 * jev_shadow_predictions never scored (no row at all) are kept — this is
 * an automatic *removal* filter, not a positive relevance gate.
 */
export const TICKER_RELEVANCE_MIN = 0.2;

/**
 * CNN Türk's `published_at` runs ~2.84h into the future (synthetic skew).
 * article_tickers.published_at inherits it via the ingest pipeline, so the
 * query layer widens its published_at bounds by this margin and the pure
 * logic here clamps each mention's effective time to
 * `min(published_at, created_at)` (see effectiveMentionMs).
 */
export const PUBLISHED_AT_SKEW_MARGIN_MS = 3 * 3_600_000;

export interface PickupDisclosure {
  disclosureIndex: number;
  publishedAt: string;
  subject: string | null;
  disclosureClass: string | null;
}

export interface PickupMention {
  articleId: string;
  publishedAt: string;
  createdAt: string | null;
  sourceId: string | null;
}

export interface PickupSource {
  id: string;
  slug: string;
  bias: BiasCategory;
  kind: SourceKind | null;
}

export interface DisclosurePickup {
  disclosureIndex: number;
  disclosedAt: string;
  subject: string | null;
  disclosureClass: string | null;
  kapUrl: string;
  articles: number;
  outlets: number;
  zones: Record<MediaDnaZone, number>;
  sources: Array<{ slug: string; zone: MediaDnaZone }>;
  firstLagMinutes: number | null;
  windowComplete: boolean;
  overlapping: number;
}

export interface PickupTotals {
  disclosures: number;
  pickedUp: number;
  pickupRate: number | null;
  medianFirstLagMinutes: number | null;
  outlets: number;
  zones: Record<MediaDnaZone, number>;
}

function emptyZones(): Record<MediaDnaZone, number> {
  return { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
}

const ZONE_SORT_ORDER: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

function validMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The mention's effective time: `min(valid published_at, valid created_at)`.
 * Falls back to whichever side is a valid timestamp when only one is; null
 * when neither parses. This is what guards against the CNN Türk
 * future-skew inflating a mention's apparent lag (or, worse, pushing it
 * outside a disclosure's window entirely).
 */
export function effectiveMentionMs(m: PickupMention): number | null {
  const pub = validMs(m.publishedAt);
  const created = validMs(m.createdAt);
  if (pub !== null && created !== null) return Math.min(pub, created);
  if (pub !== null) return pub;
  if (created !== null) return created;
  return null;
}

/** `${articleId}:${ticker}` relevance-subject keys, one per distinct article_id. */
export function relevanceKeys(mentions: readonly PickupMention[], ticker: string): string[] {
  const seen = new Set<string>();
  for (const m of mentions) seen.add(`${m.articleId}:${ticker}`);
  return Array.from(seen);
}

/**
 * Removes mentions Jev scored below TICKER_RELEVANCE_MIN for this ticker.
 * A mention with no entry in `scores` (never scored) is always kept — this
 * only strips rows Jev actively flagged as an implausible ticker match.
 */
export function dropIrrelevant(
  mentions: readonly PickupMention[],
  ticker: string,
  scores: ReadonlyMap<string, number>,
): PickupMention[] {
  return mentions.filter((m) => {
    const score = scores.get(`${m.articleId}:${ticker}`);
    if (score === undefined) return true;
    return score >= TICKER_RELEVANCE_MIN;
  });
}

/**
 * Builds one `DisclosurePickup` per disclosure, newest first. `mentions`
 * should already have `dropIrrelevant` applied by the caller — this
 * function does no relevance filtering itself, only windowing.
 */
export function computePickups(
  disclosures: readonly PickupDisclosure[],
  mentions: readonly PickupMention[],
  sourcesById: ReadonlyMap<string, PickupSource>,
  nowMs: number,
): DisclosurePickup[] {
  const withT = disclosures
    .map((d) => ({ d, t: validMs(d.publishedAt) }))
    .filter((x): x is { d: PickupDisclosure; t: number } => x.t !== null);

  const mentionsWithEff = mentions
    .map((m) => ({ m, eff: effectiveMentionMs(m) }))
    .filter((x): x is { m: PickupMention; eff: number } => x.eff !== null);

  const results: DisclosurePickup[] = withT.map(({ d, t }) => {
    const windowEnd = t + PICKUP_WINDOW_MS;
    const matches = mentionsWithEff.filter((x) => x.eff >= t && x.eff < windowEnd);

    let articles = 0;
    let firstEff: number | null = null;
    const zones = emptyZones();
    const votingSlugToZone = new Map<string, MediaDnaZone>();

    for (const { m, eff } of matches) {
      articles += 1;
      if (firstEff === null || eff < firstEff) firstEff = eff;

      const src = m.sourceId ? sourcesById.get(m.sourceId) : undefined;
      if (!src) continue;
      const kind = normalizeSourceKind(src.kind ?? undefined);
      if (!isVotingKind(kind)) continue;
      if (!votingSlugToZone.has(src.slug)) votingSlugToZone.set(src.slug, zoneOf(src.bias));
    }
    for (const zone of votingSlugToZone.values()) zones[zone] += 1;

    const sources = Array.from(votingSlugToZone.entries())
      .map(([slug, zone]) => ({ slug, zone }))
      .sort((a, b) => {
        const za = ZONE_SORT_ORDER.indexOf(a.zone);
        const zb = ZONE_SORT_ORDER.indexOf(b.zone);
        if (za !== zb) return za - zb;
        return a.slug.localeCompare(b.slug);
      });

    const overlapping = withT.filter(
      (other) => other.d.disclosureIndex !== d.disclosureIndex && Math.abs(other.t - t) < PICKUP_WINDOW_MS,
    ).length;

    return {
      disclosureIndex: d.disclosureIndex,
      disclosedAt: d.publishedAt,
      subject: d.subject,
      disclosureClass: d.disclosureClass,
      kapUrl: `https://www.kap.org.tr/tr/Bildirim/${d.disclosureIndex}`,
      articles,
      outlets: votingSlugToZone.size,
      zones,
      sources,
      firstLagMinutes: firstEff === null ? null : Math.round((firstEff - t) / 60_000),
      windowComplete: windowEnd <= nowMs,
      overlapping,
    };
  });

  return results.sort((a, b) => b.disclosedAt.localeCompare(a.disclosedAt));
}

function median(nums: readonly number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Aggregate totals across a ticker's pickups. `outlets`/`zones` are
 * distinct VOTING sources across ALL disclosures (a source appearing in
 * two overlapping disclosures counts once), not a sum of per-disclosure
 * counts. `medianFirstLagMinutes` is over picked-up disclosures only.
 */
export function summarizePickups(p: readonly DisclosurePickup[]): PickupTotals {
  const disclosures = p.length;
  const pickedUpList = p.filter((x) => x.articles > 0);
  const pickedUp = pickedUpList.length;
  const pickupRate = disclosures === 0 ? null : pickedUp / disclosures;
  const lags = pickedUpList
    .map((x) => x.firstLagMinutes)
    .filter((x): x is number => x !== null);
  const medianFirstLagMinutes = median(lags);

  const slugToZone = new Map<string, MediaDnaZone>();
  for (const item of p) {
    for (const s of item.sources) {
      if (!slugToZone.has(s.slug)) slugToZone.set(s.slug, s.zone);
    }
  }
  const zones = emptyZones();
  for (const zone of slugToZone.values()) zones[zone] += 1;

  return {
    disclosures,
    pickedUp,
    pickupRate,
    medianFirstLagMinutes,
    outlets: slugToZone.size,
    zones,
  };
}

/** Page-facing lag label, same style as TickerPage's local `lagLabel()`. */
export function formatPickupLag(minutes: number | null): string {
  if (minutes === null) return "veri yok";
  const abs = Math.abs(minutes);
  if (abs < 1) return "<1 dk sonra";
  if (abs < 60) return `${Math.round(abs)} dk sonra`;
  if (abs < 1440) return `${Math.round(abs / 60)} saat sonra`;
  return `${Math.round(abs / 1440)} gün sonra`;
}
