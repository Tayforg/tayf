import { isVotingKind, normalizeSourceKind, zoneOf } from "@/lib/bias/config";
import { companyDisplayName } from "@/lib/finance/company-display-name";
import { TICKER_HIDE_BELOW } from "@/lib/finance/ticker-relevance";
import type { BiasCategory, MediaDnaZone, SourceKind } from "@/types";

/**
 * kap-media-pickup — pure logic for "Medyada yankı" (/ekonomi/[ticker]) and
 * the keyed `GET /api/v1/kap/pickup` endpoint.
 *
 * The window rule is LITERAL per disclosure: each KAP disclosure counts
 * every mention published in its own [t, t+48h) window, regardless of
 * whether another disclosure of the same ticker also claims that mention.
 * t is the disclosure's `publishedAt`, or its `anchorAt` when it is a
 * correction (the window then starts at the filing's earliest version).
 * Overlapping disclosures double-count the same article on purpose — the
 * `overlapping` field on each result makes that visible instead of hiding
 * it behind a dedup rule. A mention strictly before its disclosure's `t`
 * is never pickup, no matter how close.
 *
 * h48-ekonomi-2: only the ticker's OWN filings (`issuer`: stock_codes has the
 * ticker) are scored. A notice that merely names the share (a Takasbank
 * "Temerrüt İşlemi" list, an MKK or SPK ban list: the ticker is only in
 * related_stocks) is still listed, but it carries no pickup numbers and stays
 * out of every total: it was credited with the ticker's unrelated articles, and
 * /ekonomi/ALARK read "bildirim 3, haberi çıkan 2 (%67)" under a coverage panel
 * that said "bildirim 0". Same rule as the coverage panel's issuerDisclosureIndexes.
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
 * data-3: 15.9% of scored article_tickers rows sampled below the old 0.2 line were all
 * false matches (political-party-vs-ticker collisions like DEVA). Rows
 * jev_shadow_predictions never scored (no row at all) are kept — this is
 * an automatic *removal* filter, not a positive relevance gate.
 *
 * h176-ekonomi-1: this IS the reader lists' hide line (ticker-relevance.ts TICKER_HIDE_BELOW), not a copy of its
 * number, so the pickup counts, /api/v1/kap/pickup and the v1 docs move with the list (the h72-kap-1 rule that list
 * and counts share one gate).
 */
export const TICKER_RELEVANCE_MIN = TICKER_HIDE_BELOW;

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
  /** The ticker is one of the notice's own `stock_codes` (false: it is only named in `related_stocks`). */
  issuer: boolean;
  /**
   * h108-kapdisclosures-3: a later correction (a DUZENLENEN twin) replaced this notice. It is
   * read, but computePickups gives it no row, so it is in no total and claims no mention.
   */
  superseded?: boolean;
  /**
   * h109: where the 48-hour window starts when it is not `publishedAt`: the EARLIEST version of
   * a corrected filing (kap-corrections.ts, correctionChains). The row is the correction, but the
   * filing was public from its original, so a mention between the two is still its pickup.
   * Null or absent: the window starts at `publishedAt`.
   */
  anchorAt?: string | null;
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
  /** Copy of the disclosure's `issuer`: false rows are listed with zero numbers and are not summarised. */
  issuer: boolean;
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
  /** The ticker's own filings (`issuer`) in the list; related-only notices are not counted. */
  disclosures: number;
  /** Listed notices that only name the ticker (`issuer: false`): shown, never scored. */
  relatedOnly: number;
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
    // A superseded original is the same filing as its correction: scored once, on the correction,
    // whose window (`anchorAt`) starts where the original's did.
    .filter((d) => d.superseded !== true)
    .map((d) => ({ d, t: validMs(d.anchorAt ?? d.publishedAt) }))
    .filter((x): x is { d: PickupDisclosure; t: number } => x.t !== null);
  // Only issuer filings claim mentions, so only they can overlap one another.
  const issuerWithT = withT.filter((x) => x.d.issuer);

  const mentionsWithEff = mentions
    .map((m) => ({ m, eff: effectiveMentionMs(m) }))
    .filter((x): x is { m: PickupMention; eff: number } => x.eff !== null);

  const results: DisclosurePickup[] = withT.map(({ d, t }) => {
    const windowEnd = t + PICKUP_WINDOW_MS;
    // A related-only notice is not the ticker's filing: no mention is "pickup" of it.
    const matches = d.issuer ? mentionsWithEff.filter((x) => x.eff >= t && x.eff < windowEnd) : [];

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

    const overlapping = d.issuer
      ? issuerWithT.filter(
          (other) => other.d.disclosureIndex !== d.disclosureIndex && Math.abs(other.t - t) < PICKUP_WINDOW_MS,
        ).length
      : 0;

    return {
      disclosureIndex: d.disclosureIndex,
      disclosedAt: d.publishedAt,
      subject: d.subject,
      disclosureClass: d.disclosureClass,
      issuer: d.issuer,
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
 * Aggregate totals across a ticker's pickups. Everything but `relatedOnly` is
 * over the ticker's own filings (`issuer`) only. `outlets`/`zones` are
 * distinct VOTING sources across all of those (a source appearing in
 * two overlapping disclosures counts once), not a sum of per-disclosure
 * counts. `medianFirstLagMinutes` is over picked-up disclosures only, and
 * `pickupRate` is null when there is no issuer filing to divide by.
 */
export function summarizePickups(all: readonly DisclosurePickup[]): PickupTotals {
  const p = all.filter((x) => x.issuer);
  const relatedOnly = all.length - p.length;
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
    relatedOnly,
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

/**
 * The short phrase for a notice that only names the share. The panel's row label and the
 * ticker page's KAP list (h108-kapdisclosures-1: "<filer> bildirimi · hisseyi anan bildirim")
 * both build on it.
 */
export const RELATED_ONLY_SHORT = "hisseyi anan bildirim";

/** What a related-only row says instead of "N haber · M kaynak" (the panel and the tests share this). */
export const RELATED_ONLY_LABEL = `${RELATED_ONLY_SHORT} · yankı hesaplanmaz`;

/**
 * h108-kapdisclosures-1: who filed a notice the page is not about, for a muted marker line.
 * The short company name when KAP's title yields one, else the filer's codes, else
 * "Başka kurum" (a Takasbank or MKK list has no stock_codes and sometimes no usable title).
 */
export function filerName(d: { kapTitle: string | null; filerCodes: readonly string[] }): string {
  return companyDisplayName(d.kapTitle) ?? (d.filerCodes.join(", ") || "Başka kurum");
}

/**
 * h108-kapdisclosures-2: what a code says in place of its pickup numbers when the press for its
 * company is matched to a sibling code (ISATR -> ISCTR). Three pieces, the middle one the link to
 * the sibling's page; the ticker page's "KAP ile basın arası" panel and the "Medyada yankı" panel
 * print the same sentence.
 */
export function pressCodeNote(code: string): { before: string; link: string; after: string } {
  return {
    before: `Basın bu şirketi ${code} koduyla anıyor; bildirimlerin basın karşılığı `,
    link: `${code} sayfasında`,
    after: ".",
  };
}

export type PickupRowKind = "related-only" | "picked-up" | "empty-closed" | "empty-open";

/** Which of the panel's four row states a pickup is in; related-only beats every other. */
export function pickupRowKind(p: Pick<DisclosurePickup, "issuer" | "articles" | "windowComplete">): PickupRowKind {
  if (!p.issuer) return "related-only";
  if (p.articles > 0) return "picked-up";
  return p.windowComplete ? "empty-closed" : "empty-open";
}

/** "%67" for a rate of 2/3, an em dash when there is no issuer filing to rate. */
export function formatPickupRate(rate: number | null): string {
  return rate === null ? "—" : `%${Math.round(rate * 100)}`;
}

/** "+3 hisseyi anan bildirim" beside the filing count, or null when no related-only notice is listed. */
export function relatedOnlyCountLabel(n: number): string | null {
  return n > 0 ? `+${n} ${RELATED_ONLY_SHORT}` : null;
}

/** How many rows the "Medyada yankı" list shows before it folds notices that only name the share. */
export const PICKUP_PANEL_ROWS = 8;

/** Newest first by the instant a row was filed; text order is the fallback for a stamp that does not parse. */
function newestFirst(a: { disclosedAt: string }, b: { disclosedAt: string }): number {
  const am = Date.parse(a.disclosedAt);
  const bm = Date.parse(b.disclosedAt);
  if (Number.isFinite(am) && Number.isFinite(bm) && am !== bm) return bm - am;
  return b.disclosedAt.localeCompare(a.disclosedAt);
}

/**
 * h144-ekonomi-2: which pickup rows the "Medyada yankı" list prints and which wait behind its
 * "<n> hisseyi anan bildirim daha" summary. The list used to be `pickups.slice(0, 8)`, so a busy
 * ticker's related-only notices (no numbers: a Takasbank or MKK list that names the share) pushed
 * the ticker's OWN filings, the ones the totals count, off the panel: THYAO read "bildirim 7" over
 * 3 listed own filings.
 *
 * `shown` is every own (`issuer`) row plus the newest related-only rows that still fit under `cap`
 * (none once the own filings fill it); `hidden` is the rest, all related-only. Both are newest
 * first. Pure: the input is not changed.
 */
export function pickupPanelRows<T extends { issuer: boolean; disclosedAt: string }>(
  pickups: readonly T[],
  cap: number = PICKUP_PANEL_ROWS,
): { shown: T[]; hidden: T[] } {
  const ordered = [...pickups].sort(newestFirst);
  let relatedSlots = Math.max(0, cap - ordered.filter((p) => p.issuer).length);
  const shown: T[] = [];
  const hidden: T[] = [];
  for (const p of ordered) {
    if (p.issuer) {
      shown.push(p);
    } else if (relatedSlots > 0) {
      shown.push(p);
      relatedSlots -= 1;
    } else {
      hidden.push(p);
    }
  }
  return { shown, hidden };
}
