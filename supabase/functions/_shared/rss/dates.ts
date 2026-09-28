// supabase/functions/_shared/rss/dates.ts
//
// Feed-level pubDate cleanup (ingest-health). Runs BEFORE `normalize.ts`'s
// `parseDate` ever sees a raw item date — some outlets emit dates that are
// otherwise-valid-looking but carry cosmetic damage `parseDate`'s
// deliberately-narrow regexes correctly refuse to touch:
//
//   - Sözcü HTML-entity-encodes the `+` in its offset ("&#x2B;0300" /
//     "&#43;0300").
//   - Beyaz Gazete emits a PHP-style `Y-m-d\TH:i:s\Z O` format that prints
//     BOTH a literal `Z` AND the server's numeric local offset
//     ("2026-09-28T12:04:39Z +0300") — the numeric offset is authoritative
//     (a `Z`-then-offset combination only makes sense if the timestamp
//     itself is local, with `O` proving what that local offset is).
//   - Milliyet inserts extra internal whitespace before its zone designator
//     ("Mon, 28 Sep 2026 18:13:15  Z").
//
// This module ONLY cleans the raw string; the actual UTC interpretation
// (including cnn-turk's "UTC-labelled but actually Istanbul time" rule)
// stays entirely inside `normalize.ts`'s `parseDate` — imported here
// read-only, never edited.

import { parseDate } from "./normalize.ts";

/** Per-slug post-clean rewrite, applied after the generic steps below. */
export type SourceDateRule = (cleaned: string) => string;

// Starts empty — see the ingest-health verification step (real-feed curl
// comparison against each outlet's article `meta[property="article:
// published_time"]`) for whether Milliyet's or Beyaz Gazete's interpretation
// needs a slug-specific override here.
export const SOURCE_DATE_RULES: Record<string, SourceDateRule> = {};

// &#x2B; / &#43; / &amp; / &nbsp; — the specific handful of encoded
// characters observed corrupting outlet pubDates. Deliberately narrower
// than normalize.ts's own full entity table: this module only ever touches
// a date string, so there's no title/description markup to worry about.
const DATE_ENTITY_RE = /&(amp|nbsp|#x[0-9a-fA-F]+|#\d+);/g;

function decodeDateEntities(raw: string): string {
  return raw.replace(DATE_ENTITY_RE, (match, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "nbsp") return " ";
    const isHex = entity[1] === "x" || entity[1] === "X";
    const codePoint = isHex
      ? parseInt(entity.slice(2), 16)
      : Number(entity.slice(1));
    return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
  });
}

// A ISO-ish timestamp with a literal `Z` followed by a numeric offset
// (Beyaz Gazete's `Y-m-d\TH:i:s\Z O`). Rewritten to just the numeric
// offset — see the file header for why the offset wins.
const ISO_Z_THEN_OFFSET_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)Z\s*([+-])(\d{2}):?(\d{2})$/;

function rewriteIsoZThenOffset(cleaned: string): string {
  const m = ISO_Z_THEN_OFFSET_RE.exec(cleaned);
  if (!m) return cleaned;
  const [, base, sign, offsetHours, offsetMinutes] = m;
  return `${base}${sign}${offsetHours}:${offsetMinutes}`;
}

/**
 * Cleans one raw RSS/Atom date string before it reaches `parseDate`:
 * decode a small set of HTML entities, collapse/trim whitespace, rewrite a
 * literal-`Z`-then-numeric-offset ISO shape to just the offset, then apply
 * any per-source rule from `SOURCE_DATE_RULES`. Returns `undefined` for a
 * `undefined`/empty/whitespace-only input — there is nothing to clean.
 */
export function cleanFeedDate(
  raw: string | undefined,
  sourceSlug?: string,
): string | undefined {
  if (raw === undefined) return undefined;
  let cleaned = decodeDateEntities(raw);
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;

  cleaned = rewriteIsoZThenOffset(cleaned);

  const rule = sourceSlug ? SOURCE_DATE_RULES[sourceSlug] : undefined;
  if (rule) cleaned = rule(cleaned);

  return cleaned;
}

// A sentinel `nowMs` far in the future (the maximum ECMAScript date value,
// 8.64e15 — see `Date`'s spec-defined range) so `parseDate`'s clamp
// (rule 4: "never later than nowMs") never fires for any real date, and its
// unparseable-fallback path (`new Date(nowMs).toISOString()`) becomes a
// value no genuine feed date can ever equal — detecting the silent fallback
// without touching `normalize.ts` itself.
const SENTINEL_NOW_MS = 8.64e15;

/**
 * True when `cleaned` is both present and actually parses to something
 * other than `normalize.ts`'s silent unparseable-date fallback (which
 * would otherwise be indistinguishable from a legitimately-clamped date).
 */
export function isParseableFeedDate(
  cleaned: string | undefined,
  sourceSlug?: string,
): boolean {
  if (!cleaned) return false;
  const sentinel = new Date(SENTINEL_NOW_MS).toISOString();
  return (
    parseDate(cleaned, { nowMs: SENTINEL_NOW_MS, sourceSlug }) !== sentinel
  );
}
