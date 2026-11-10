// Which KAP disclosures a later correction has replaced.
//
// h108-kapdisclosures-3: KAP files a correction as a NEW disclosure, with
// modify_status DUZENLENEN, the same issuer, subject, summary, year and period as the
// notice it replaces (OTTO 1694030 -> 1694331, ATEKS 1695283 -> 1696599, TTKOM
// 1692808 -> 1694263). The original is flagged DUZELTILEN only when the daily replay
// happened to cover it (3 of 30 in 30 days), so the pair read as the same filing twice
// and "Medyada yankı" / "KAP ile basın arası" counted it twice.
//
// The rule, in one place:
//   - modify_status DUZELTILEN: superseded on its own.
//   - ONE-TO-ONE: each DUZENLENEN row replaces at most ONE earlier notice. Corrections are
//     walked oldest first, and each claims the NEWEST still-unclaimed notice (a tie goes to
//     the higher disclosure_index) that was published before it, at most 14 days earlier,
//     and is the same filing: overlapping stock_codes and equal related_stocks (as sets,
//     null = none), subject, summary (null equals null), year and period. The subject must
//     be present: two rows without one say nothing.
//     A correction of a correction chains: 1 <- 2 <- 3 supersedes 1 and 2.
//
// Why one-to-one: a daily notice has the same subject and summary every day (TABGD's "Pay
// Geri Alım İşlemleri": eight rows in ten days, year and period null), so a rule that let
// one correction replace every twin in the window dropped seven filings that were never
// corrected. A rating agency files one subject for many companies (JCRAV: related_stocks
// tells them apart).
//
// Pure: no I/O, no clock. Used on database rows (queries.ts, kap-pickup-query.ts) and,
// through supersededDisclosureIndexes, on the page's own Disclosure rows, so the list
// tags and the counts cannot disagree.

/** A correction counts as the original's replacement when it follows within this many days. */
export const CORRECTION_WINDOW_DAYS = 14;
const CORRECTION_WINDOW_MS = CORRECTION_WINDOW_DAYS * 86_400_000;

export const MODIFY_STATUS_CORRECTION = "DUZENLENEN";
export const MODIFY_STATUS_SUPERSEDED = "DUZELTILEN";

/** The columns of kap_disclosures the rule reads. `year` and `period` are text in the table. */
export interface CorrectionRow {
  disclosure_index: number;
  published_at: string;
  stock_codes?: readonly string[] | null;
  /** The shares a notice names without filing it: tells one company's rating from another's. */
  related_stocks?: readonly string[] | null;
  subject?: string | null;
  summary?: string | null;
  year?: string | number | null;
  period?: string | number | null;
  modify_status?: string | null;
}

const text = (v: string | number | null | undefined): string | null => (v == null ? null : String(v));

interface Prepared {
  row: CorrectionRow;
  ms: number;
}

function sameCodeSet(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const left = new Set(a ?? []);
  const right = new Set(b ?? []);
  if (left.size !== right.size) return false;
  for (const code of left) if (!right.has(code)) return false;
  return true;
}

function sameFiling(original: CorrectionRow, correction: CorrectionRow): boolean {
  if (original.subject == null || original.subject !== correction.subject) return false;
  if ((original.summary ?? null) !== (correction.summary ?? null)) return false;
  if (text(original.year) !== text(correction.year) || text(original.period) !== text(correction.period)) return false;
  if (!sameCodeSet(original.related_stocks, correction.related_stocks)) return false;
  const codes = original.stock_codes ?? [];
  return (correction.stock_codes ?? []).some((c) => codes.includes(c));
}

/**
 * The one-to-one match: original `disclosure_index` -> the `disclosure_index` of the correction
 * that claimed it. Both the original and a correction in the middle of a chain are keys.
 */
function claimOriginals(rows: readonly CorrectionRow[]): Map<number, number> {
  const dated: Prepared[] = [];
  for (const row of rows) {
    const ms = Date.parse(row.published_at);
    if (Number.isFinite(ms)) dated.push({ row, ms });
  }
  dated.sort((a, b) => a.ms - b.ms || a.row.disclosure_index - b.row.disclosure_index);

  const claimedBy = new Map<number, number>();
  for (const correction of dated) {
    if (correction.row.modify_status !== MODIFY_STATUS_CORRECTION) continue;
    let best: Prepared | null = null;
    for (const candidate of dated) {
      const lag = correction.ms - candidate.ms;
      if (lag <= 0 || lag > CORRECTION_WINDOW_MS) continue;
      if (candidate.row.disclosure_index === correction.row.disclosure_index) continue;
      if (claimedBy.has(candidate.row.disclosure_index)) continue;
      if (!sameFiling(candidate.row, correction.row)) continue;
      if (
        best === null ||
        candidate.ms > best.ms ||
        (candidate.ms === best.ms && candidate.row.disclosure_index > best.row.disclosure_index)
      ) {
        best = candidate;
      }
    }
    if (best) claimedBy.set(best.row.disclosure_index, correction.row.disclosure_index);
  }
  return claimedBy;
}

/** The `disclosure_index` of every row in `rows` that a correction in `rows` (or its own flag) supersedes. */
export function supersededIndexes(rows: readonly CorrectionRow[]): Set<number> {
  const superseded = new Set(claimOriginals(rows).keys());
  for (const row of rows) {
    if (row.modify_status === MODIFY_STATUS_SUPERSEDED) superseded.add(row.disclosure_index);
  }
  return superseded;
}

/** Where a surviving correction's filing first appeared: the first version of its chain. */
export interface CorrectionChain {
  earliestIndex: number;
  earliestPublishedAt: string;
}

/**
 * The chains the one-to-one match found, keyed by the LATEST surviving version's
 * `disclosure_index` (a DUZENLENEN row nobody replaced in turn). A pair gives
 * `{ correction => original }`; 1 <- 2 <- 3 gives `{ 3 => 1 }`. A correction that claimed
 * nothing, and a DUZELTILEN row whose correction is not in `rows`, make no entry.
 *
 * h109: the filing was public from its EARLIEST version, so a mention between the original
 * and its correction is that filing's pickup, and the coverage event starts at the original.
 */
export function correctionChains(rows: readonly CorrectionRow[]): Map<number, CorrectionChain> {
  const claimedBy = claimOriginals(rows);
  const originalOf = new Map<number, number>();
  for (const [original, correction] of claimedBy) originalOf.set(correction, original);

  const byIndex = new Map<number, CorrectionRow>();
  for (const row of rows) byIndex.set(row.disclosure_index, row);

  const chains = new Map<number, CorrectionChain>();
  for (const latest of originalOf.keys()) {
    // A correction that was itself replaced is a middle link, not the surviving version.
    if (claimedBy.has(latest)) continue;
    let earliest = originalOf.get(latest)!;
    // Each claim points strictly back in time, so this ends.
    for (let prior = originalOf.get(earliest); prior !== undefined; prior = originalOf.get(earliest)) earliest = prior;
    const row = byIndex.get(earliest);
    if (row) chains.set(latest, { earliestIndex: earliest, earliestPublishedAt: row.published_at });
  }
  return chains;
}

/** The page-side shape: queries.ts's Disclosure (camel case), matched on `filerCodes` = stock_codes. */
export interface CorrectionDisclosure {
  disclosureIndex: number;
  publishedAt: string;
  filerCodes: readonly string[];
  /** `related_stocks`: queries.ts's Disclosure.relatedCodes. */
  relatedCodes?: readonly string[];
  subject: string | null;
  summary: string | null;
  year?: string | null;
  period?: string | null;
  modifyStatus?: string | null;
}

function toCorrectionRows(disclosures: readonly CorrectionDisclosure[]): CorrectionRow[] {
  return disclosures.map((d) => ({
    disclosure_index: d.disclosureIndex,
    published_at: d.publishedAt,
    stock_codes: d.filerCodes,
    related_stocks: d.relatedCodes,
    subject: d.subject,
    summary: d.summary,
    year: d.year,
    period: d.period,
    modify_status: d.modifyStatus,
  }));
}

/** supersededIndexes over the page's Disclosure rows. */
export function supersededDisclosureIndexes(disclosures: readonly CorrectionDisclosure[]): Set<number> {
  return supersededIndexes(toCorrectionRows(disclosures));
}

/** correctionChains over the page's Disclosure rows. */
export function disclosureCorrectionChains(disclosures: readonly CorrectionDisclosure[]): Map<number, CorrectionChain> {
  return correctionChains(toCorrectionRows(disclosures));
}
