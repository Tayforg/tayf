// supabase/functions/_shared/rss/normalize.ts
//
// Port of `src/lib/rss/normalize.ts` + `scripts/rss-worker.mjs`'s
// `normalizeItem` into Deno-friendly TypeScript. Two material differences
// vs the legacy modules:
//
//   1. content_hash is computed via `strictFingerprint` ONLY (the canonical
//      sha1-of-shingles algorithm from `_shared/cluster/fingerprint.ts`).
//      The SHA-256(title+url) path is removed entirely — audit T7 P1-21
//      flagged the dual-regime as the root cause of duplicate clusters.
//      B9's migration 026 backfills any rows still carrying the legacy
//      64-char hash.
//
//   2. URL canonicalisation lives inside normalize so the ingest function
//      can pre-compute it once per item without depending on the legacy
//      worker module.
//
// Sports-source tagging, the entity decoder, and the image extractor are
// ported verbatim — they are dialect, not algorithm. The keyword classifier is
// NOT: it lives in `./category.ts` (hunt-19: folded ASCII keywords with word
// boundaries, title + description only, the URL read for its section alone) and
// is imported here. `content_hash` does not depend on the category.

import { sha1, strictFingerprint } from "../cluster/fingerprint.ts";
import {
  codePointToString,
  decodeResidualEntities,
  isContentlessTitle,
  stripInvalidXmlChars,
} from "./entities.ts";
import {
  isIconLikeImageUrl,
  isOptimizableImageUrl,
  isPlaceholderImageUrl,
  normalizeImageUrl,
  upgradeImageVariant,
} from "../image-url.ts";
import type { RawFeedItem, RssSource } from "./fetcher.ts";
import { isLegalNotice } from "./legal-notice.ts";
import { isAdClickLink } from "./ad-link.ts";
import { findInlineImgSrc } from "./inline-image.ts";
import { clampForScan, stripTagsLinear } from "./strip-tags.ts";
import { classifyCategory } from "./category.ts";
import type { NewsCategory } from "./category.ts";

export type { NewsCategory } from "./category.ts";

/**
 * Optional tally the caller passes to `normalizeItem` / `normalizeArticles`.
 * `contentlessTitles` counts the items dropped because their title has no
 * letter or digit after decoding (`isContentlessTitle`: '&nbsp', '&amp;nbsp',
 * '-', '…', an empty or whitespace-only title). A BİK legal notice or an item
 * with no link is dropped too but is NOT counted here.
 * `adLinks` counts the items dropped because their absolute url is on an ad
 * click-tracker host (`isAdClickLink`: a DoubleClick `gampad/clk` link). The
 * ad check runs after the title checks, so a blank or contentless title is
 * counted as contentless, never as an ad link.
 */
export interface NormalizeCounters {
  contentlessTitles: number;
  adLinks: number;
}

export interface NormalizedArticle {
  source_id: string;
  title: string;
  description: string | null;
  url: string;
  image_url: string | null;
  published_at: string;
  content_hash: string;
  category: NewsCategory;
}

// ---------------------------------------------------------------------------
// Category: sports-source override (the keyword classifier is ./category.ts)
// ---------------------------------------------------------------------------

// A feed that is only sport is tagged spor whatever its headlines say.
const SPORTS_SOURCE_SLUGS: ReadonlySet<string> = new Set([
  "fotomac",
  "fotospor",
  "a-spor",
  "ntv-spor",
  "kontraspor",
  "ajansspor",
]);

// ---------------------------------------------------------------------------
// Image extraction
// ---------------------------------------------------------------------------

function isValidImageUrl(url: string): boolean {
  if (!url || url.length < 10) return false;
  if (url.startsWith("data:")) return false;
  // gif-filter (http-1): never store an animated GIF (haber7 / elips-haber
  // ship a 22.3 MB placeholder that /_next/image passes through unmodified).
  if (!isOptimizableImageUrl(url)) return false;
  // db-4 ingest half: a publisher logo card / 'son dakika' stand-in is not a
  // story image (see isPlaceholderImageUrl).
  if (isPlaceholderImageUrl(url)) return false;
  if (/favicon|icon|logo|pixel|tracker|1x1|spacer/i.test(url)) return false;
  // ingest-hygiene: must also be a repairable http(s) URL (shared with the
  // render side) -- a relative path or ftp: value is not a usable image.
  if (normalizeImageUrl(url) === null) return false;
  return true;
}

function getImageEnclosure(item: RawFeedItem): string | null {
  if (!item.enclosure?.url) return null;
  const type = item.enclosure.type ?? "";
  if (type && !type.startsWith("image/")) return null;
  // gif-filter (http-1): an `image/gif` enclosure is skipped even when its
  // URL has no `.gif` extension (the URL check below cannot see those).
  if (type.toLowerCase() === "image/gif") return null;
  return item.enclosure.url;
}

// audit fix A (db-platform): fetcher.ts only ever captures a bare URL for
// media:content / media:thumbnail (no medium/type attribute survives the
// XML->RawFeedItem mapping), so a video posted via media:content (a common
// shape for video-first outlets) looked identical to an image one -- the
// old extractImage happily returned an .mp4/.m3u8 URL as `image_url`,
// which every consumer downstream (OG image, thumbnails, the reader UI)
// then rendered (or tried to) as a static image. Detect by URL extension
// since that's the only signal fetcher.ts preserves.
export function isVideoUrl(u: string): boolean {
  return /\.(mp4|m3u8|webm|mov)(\?|#|$)/i.test(u);
}

// audit fix A (db-platform), R3: rcman-hosted outlets (aydinlik, ekonomim,
// f5haber, artigercek) serve a 150x84 crop by default. A 25-URL sample of
// live rows rewritten to the 1280x720 variant all returned 200 image/* (see
// the 084 migration header for the exact sample), so the larger crop is a
// safe drop-in upgrade for any URL still carrying the small preset.
//
// hunt-15: the rule now lives in the shared `upgradeImageVariant`
// (_shared/image-url.ts) next to the Gazete Oksijen `/2/150/84/` and BBC Turkce
// `/ace/ws/240/` rules, and `normalizeImageUrl` applies it, so the render path
// upgrades stored rows too. This export stays for existing callers.
export function upgradeThumbnailUrl(u: string): string {
  return upgradeImageVariant(u);
}

function firstNonVideoCandidate(candidates: ReadonlyArray<string | null | undefined>): string | null {
  for (const c of candidates) {
    // ingest-hygiene: repair (`//host/x`, `https://h//x`) or skip (relative,
    // data:, ftp:) each candidate BEFORE the video / thumbnail checks.
    // gif-filter (http-1): animated GIFs are skipped so the next candidate
    // (or null) is stored instead of a 22 MB placeholder.
    // db-4 ingest half: a placeholder (publisher logo card, 'son dakika'
    // stand-in) is skipped the same way, so a real media:thumbnail behind it
    // can win and an item with only placeholders stores NULL -- the NULL is
    // what queues the og:image backfill (articles_image_enqueue trigger).
    //
    // hunt-15: a site icon / logo advertised as the enclosure (mfa.gov.tr
    // `/images/logo.png`) is skipped too, by whole-token basename match.
    const normalized = normalizeImageUrl(c);
    if (
      normalized &&
      !isVideoUrl(normalized) &&
      isOptimizableImageUrl(normalized) &&
      !isPlaceholderImageUrl(normalized) &&
      !isIconLikeImageUrl(normalized)
    ) {
      return upgradeThumbnailUrl(normalized);
    }
  }
  return null;
}

// posta-image-url (2026-10-22): posta's feed has no enclosure / media:* /
// <image>; its picture is the first `<img src>` in <description> (-> `content`),
// and the PUBLISHER writes two glued ObjectIds there
// (`.../0x0/<id1>.jpg<id2>.jpg`, a 404). That string is literally in the feed
// XML, not produced by our parser, and every candidate below already routes
// through normalizeImageUrl -- so its shared joined-segment repair is the
// generic ingest fix and no extractor logic changes here.
function extractImage(item: RawFeedItem): string | null {
  const fromFields = firstNonVideoCandidate([
    getImageEnclosure(item),
    item.mediaContent?.$?.url,
    item.mediaThumbnail?.$?.url,
    item.mediaGroup?.["media:content"]?.$?.url,
    item.mediaGroup?.["media:thumbnail"]?.$?.url,
  ]);
  if (fromFields) return fromFields;

  const itemImage = normalizeImageUrl(item.itemImage);
  if (itemImage && isValidImageUrl(itemImage) && !isVideoUrl(itemImage)) {
    return upgradeThumbnailUrl(itemImage);
  }

  const htmlContent = item.contentEncoded ?? item.content ?? "";
  if (htmlContent) {
    // h26-security-2: the unbounded `[^>]+` rescanned the rest of the body from
    // every '<img' that had no '>' behind it (20,000 x '<img' = 1.5 s), and the
    // bounded `[^>]{1,1000}` that replaced it was still ~1000x super-linear
    // (50 KB of '<img' = 15 ms per item, 160 such items = 2.9 s against the 2 s
    // isolate limit). findInlineImgSrc (./inline-image.ts) is a linear scanner
    // with the same pick: the first '<img' with a usable src, the LAST src= in
    // its tag, looking at the first IMAGE_SCAN_CAP units only (a lead image sits
    // at the top of the body).
    const src = findInlineImgSrc(htmlContent, IMAGE_SCAN_CAP);
    const inline = normalizeImageUrl(src);
    if (inline && isValidImageUrl(inline) && !isVideoUrl(inline)) {
      return upgradeThumbnailUrl(inline);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

// h26-security-2: feed text is attacker-controlled and the only length bound on
// it is the 8 MB body cap, so every regex pass below first sees a clamped copy
// (clampForScan, ./strip-tags.ts). A title of 80,000 '<' cost 2.1 s of CPU in
// the old fixpoint strip and a 1 MB description proportionally more, against a
// 2 s isolate limit. The caps sit far above any real value: a headline is
// < 300 chars (the clean title is stored up to 2,000), and the stored
// description is cut to 500 chars of CLEANED text, so 20,000 raw units is a
// 40x margin for markup-heavy snippets. The inline-image scanner looks at the
// first 50,000 units of the body.
const TITLE_SCAN_CAP = 2_000;
const DESCRIPTION_SCAN_CAP = 20_000;
const IMAGE_SCAN_CAP = 50_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

// Single-pass entity decode. Every entity is consumed exactly once by one
// regex, so no replacement's output can be re-interpreted as another entity
// ("&amp;lt;" decodes to the literal "&lt;", never to "<"). Matches the named
// entities, decimal (&#N;) and hex (&#xN;) numeric references the legacy
// modules handled.
//
// Numeric references go through `codePointToString` (./entities.ts), which
// never throws and yields '' for anything XML 1.0 forbids: out-of-range
// (&#1114112;), overflowing (&#99999999999999999999;), NUL, C0 controls,
// surrogates and U+FFFE / U+FFFF. A bad reference is dropped, not replaced.
function decodeEntities(text: string): string {
  return text.replace(
    /&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g,
    (match, entity: string) => {
      if (entity[0] === "#") {
        const codePoint =
          entity[1] === "x" || entity[1] === "X"
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        return codePointToString(codePoint);
      }
      return NAMED_ENTITIES[entity] ?? match;
    },
  );
}

// The first pass above is single-pass on purpose, so a feed that double-encodes
// ("&amp;quot;") used to leave a literal "&quot;" in the stored text. The
// callers below therefore run ONE bounded extra pass, `decodeResidualEntities`
// (./entities.ts), AFTER `stripTagsLinear`. Running it after the strip is what keeps
// the anti-markup guarantee: that pass never emits '<' or '>' ("&lt;" / "&gt;"
// and numeric references to them are left as they are), so it cannot
// reintroduce a tag the strip already removed. It is one level, not a loop:
// "&amp;amp;quot;" ends up as "&quot;".

// Tag stripping lives in ./strip-tags.ts (`stripTagsLinear`). The old code here
// looped `/<[^>]*>/g` to a fixpoint to catch crafted input like
// "<<script>script>", but one pass already IS the fixpoint (after a pass every
// remaining '<' has no '>' after it), and that pass was O(n^2) on a text with
// no '>' (h26-security-2). The scanner copies the single regex pass exactly, so
// the stored title / description and the content_hash are byte-identical.

function cleanDescription(raw?: string | null): string | null {
  if (!raw) return null;
  // Clamp FIRST (h26-security-2), so the decode and the strip below never see
  // more than DESCRIPTION_SCAN_CAP units of attacker-controlled text.
  //
  // Decode so entity-encoded markup becomes real angle brackets, then strip
  // tags (one linear pass is the fixpoint) so reintroduced or nested markup
  // can't survive.
  //
  // Then ONE extra residue pass (double-encoded feeds), after the strip so it
  // cannot bring markup back; see the note above (the residue-pass paragraph).
  //
  // Raw characters XML 1.0 forbids (C0 controls, U+FFFE / U+FFFF, lone
  // surrogates) are removed AFTER the residue pass and BEFORE the trim and the
  // 500-character clamp, so they can neither survive (the pass can reveal one,
  // e.g. "&amp;#11;") nor shift the clamp, which counts decoded text.
  const text = stripInvalidXmlChars(
    decodeResidualEntities(
      stripTagsLinear(decodeEntities(clampForScan(raw, DESCRIPTION_SCAN_CAP))),
    ),
  ).trim();
  if (!text) return null;
  if (text.length <= 500) return text;
  // Clamp to 497 UTF-16 units + "...", but never cut an astral character (an
  // emoji) in half: a dangling high surrogate is itself XML-illegal.
  const lastKept = text.charCodeAt(496);
  const end = lastKept >= 0xd800 && lastKept <= 0xdbff ? 496 : 497;
  return text.slice(0, end) + "...";
}

// ---------------------------------------------------------------------------
// Date parsing (ingest-fixes, migration 074)
//
// The Deno Edge runtime always runs in UTC; a bare `new Date(raw)` on a
// zone-less timestamp string is interpreted as UTC by the ECMAScript spec,
// which silently mislabels an Istanbul wall-clock time as UTC -- a +3h
// (Turkey has had no DST since 2016) skew for every source that omits a
// zone designator. cnn-turk went further and stamped a UTC-looking
// designator (Z/GMT) on what is still Istanbul wall-clock time, an
// additional -3h correction on top of that. Every rule below must resolve
// its OWN explicit offset before ever touching `new Date(...)`, so no
// code path here passes a zone-less string straight to the Date
// constructor and lets the runtime's UTC default decide.
// ---------------------------------------------------------------------------

const TR_WALL_CLOCK_AS_UTC_SLUGS: ReadonlySet<string> = new Set(["cnn-turk"]);

// h42-latency-2: the opposite mislabel. Daily Sabah's feed mixes two kinds of
// <pubDate>, both labelled "+0300":
//
//   Thu, 05 Nov 2026 20:04:00 +0300   minute precision (":00"): honest
//                                     Istanbul time.
//   Thu, 05 Nov 2026 13:54:18 +0300   seconds precision: the clock is UTC and
//                                     only the label is wrong -- the row was
//                                     ingested at 13:57Z, not 16:57Z.
//
// Read at face value the second kind lands exactly 3 h in the past (127 rows
// in 14 days sat in the 180-190 min created_at - published_at bins against 6-9
// in the neighbouring ones), which made card ages 3 h too old and let a skewed
// row win `first_published = min(published_at)` of a multi-source cluster.
// Evidence: __fixtures__/daily-sabah-dates.json.
//
// Per source on purpose. The discriminator (a non-zero seconds field next to a
// "+0300" label) is the ordinary shape of every OTHER Turkish outlet's correct
// stamp -- 43,765 such rows from 88 sources in the 7 days before this fix --
// so no rule about the format alone can tell the two apart.
const UTC_WALL_CLOCK_SECONDS_SLUGS: ReadonlySet<string> = new Set(["daily-sabah"]);

// Seconds field (group 1) of a stamp whose zone is the numeric Istanbul offset
// (`+0300` / `+03:00`), the only label the fixture shows on a UTC clock. The
// string is already trimmed, so the offset is the last token.
const SECONDS_BEFORE_ISTANBUL_OFFSET_RE = /\d{2}:\d{2}:(\d{2})(?:\.\d+)?\s*\+03:?00$/;

// Trailing `Z`, a numeric offset (`+03:00` / `+0300` / `-05:00`), or a named
// zone token (GMT, UTC, UT, or a US abbreviation like EST/PDT).
const ZONE_DESIGNATOR_RE = /(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC?|[PMCE][SD]T)\s*$/i;

// A UTC-*labelled* designator specifically -- the subset rule 3 subtracts
// 3h from, because it's the shape CNN Türk's feed emits over what is
// actually still Istanbul wall-clock time.
const UTC_LIKE_DESIGNATOR_RE = /(?:Z|UTC?|GMT|\+00:?00)\s*$/i;

const ISO_LIKE_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

// A recognisable RFC-822-ish date/time with no zone designator, e.g.
// "Mon, 28 Sep 2026 12:00:00" or "28 Sep 2026 12:00:00" -- deliberately
// narrow so garbage strings (e.g. "not a date") never reach the
// append-a-zone-and-reparse path, where some engines parse the mutated
// string leniently into a nonsense (but non-NaN) date instead of failing.
const RFC822_NO_ZONE_RE =
  /^(?:[A-Za-z]{3},\s*)?\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4}\s+\d{2}:\d{2}(:\d{2})?$/;

export interface ParseDateOptions {
  nowMs: number;
  sourceSlug?: string;
}

/**
 * Parse an RSS item's date string into an ISO-8601 UTC timestamp, per the
 * ingest-fixes (migration 074) rules:
 *
 *   1. Empty / unparseable -> `nowMs` (today's behaviour).
 *   2. No zone designator -> interpret as Europe/Istanbul (+03:00), never
 *      the runtime's default UTC interpretation.
 *   3. `sourceSlug` is in `TR_WALL_CLOCK_AS_UTC_SLUGS` AND the designator is
 *      UTC-like -> subtract 3h (the source labelled Istanbul wall-clock
 *      time as UTC).
 *   3b. `sourceSlug` is in `UTC_WALL_CLOCK_SECONDS_SLUGS` AND the stamp is
 *      labelled `+0300` / `+03:00` AND its seconds field is not `00` -> add
 *      3h (the source labelled a UTC clock as Istanbul time; h42-latency-2).
 *   4. Clamp: the result is never later than `nowMs` -- `published_at`
 *      must never outrun ingest time.
 */
// The "unparseable -> nowMs" value. Built only on the paths that return it:
// a well-formed date (nearly every item) never needs it, and `toISOString` is
// not free per item (hunt-11, A-ingest-cpu).
function fallbackIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

export function parseDate(raw: string | undefined, opts: ParseDateOptions): string {
  const { nowMs, sourceSlug } = opts;
  const trimmed = raw?.trim();
  if (!trimmed) return fallbackIso(nowMs);

  let normalized = trimmed;
  const hasDesignator = ZONE_DESIGNATOR_RE.test(trimmed);
  if (!hasDesignator) {
    // Rule 2: no zone at all -- treat as Istanbul local time. Only a
    // recognised zone-less shape gets a zone appended and re-parsed; any
    // other string falls through to rule 1 (unparseable -> fallback)
    // rather than being mutated into something a lenient Date parser might
    // accept as garbage.
    if (ISO_LIKE_RE.test(trimmed)) {
      normalized = trimmed.replace(" ", "T") + "+03:00";
    } else if (RFC822_NO_ZONE_RE.test(trimmed)) {
      normalized = `${trimmed} +0300`;
    } else {
      return fallbackIso(nowMs);
    }
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return fallbackIso(nowMs);

  let ms = date.getTime();

  // Rule 3: a UTC-labelled designator from a source known to actually stamp
  // Istanbul wall-clock time -- correct the mislabel.
  if (
    hasDesignator &&
    sourceSlug &&
    TR_WALL_CLOCK_AS_UTC_SLUGS.has(sourceSlug) &&
    UTC_LIKE_DESIGNATOR_RE.test(trimmed)
  ) {
    ms -= 3 * 60 * 60 * 1000;
  }

  // Rule 3b: a UTC clock labelled +03:00 (h42-latency-2). `new Date` above
  // read it as Istanbul time, 3 h too early; put the 3 h back. Checked only for
  // the listed slugs, so every other source pays nothing and changes nothing.
  if (hasDesignator && sourceSlug && UTC_WALL_CLOCK_SECONDS_SLUGS.has(sourceSlug)) {
    const m = SECONDS_BEFORE_ISTANBUL_OFFSET_RE.exec(trimmed);
    if (m && m[1] !== "00") ms += 3 * 60 * 60 * 1000;
  }

  // Rule 4: never later than ingest time.
  ms = Math.min(ms, nowMs);

  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// URL canonicalisation
// ---------------------------------------------------------------------------

const SOURCE_CANON_RULES: Record<string, Array<{ pattern: RegExp; replacement: string }>> = {
  "10haber": [
    {
      pattern: /^\/(siyaset|gundem|populer|ekonomi|dunya|spor|yasam)\//,
      replacement: "/",
    },
  ],
  haberler: [
    {
      pattern: /^\/(gundem|siyaset|ekonomi|dunya|spor|yasam|magazin)\//,
      replacement: "/",
    },
  ],
};

const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "ref",
  "ref_source",
  "referrer",
  "source",
  "from",
  "st",
  "amp",
]);

export function canonicalizeUrl(
  rawUrl: string,
  sourceSlug?: string,
): string {
  try {
    const u = new URL(rawUrl);
    u.hostname = u.hostname.toLowerCase();
    if (u.hostname.startsWith("www.")) u.hostname = u.hostname.slice(4);

    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
    }

    let path = u.pathname.replace(/%27/gi, "").replace(/'/g, "");

    const rules = sourceSlug ? SOURCE_CANON_RULES[sourceSlug] : undefined;
    if (rules) {
      for (const rule of rules) {
        path = path.replace(rule.pattern, rule.replacement);
      }
    }
    path = path.replace(/\/{2,}/g, "/");
    if (path.length > 1) path = path.replace(/\/+$/, "");

    u.pathname = path;
    u.hash = "";
    return u.toString();
  } catch {
    return rawUrl;
  }
}

// ---------------------------------------------------------------------------
// Stable article id (hunt-114)
// ---------------------------------------------------------------------------

// Sources whose article url ends in a numeric id that survives a headline edit
// (the slug changes, the id does not) AND whose feed keeps the first url's
// pubDate on the re-slugged item. Anadolu Ajansı retitles a live article ("CANLI
// - Cumhurbaşkanı Erdoğan konuşuyor" -> "...Gabar'da iki yeni sahada daha petrol
// keşfettik") under a new url and still ships the live stub's pubDate, so the
// re-slugged row was stored 2.5-3 hours "old" and gave AA a head start as the
// first mover of the cluster it joined. Ingest looks the id up among the
// source's stored rows and stamps the new url with its first-seen time instead.
//
// Evidence (hunt-114, 7 days to 2026-11-11): 22 AA ids stored under 2 or 3
// urls; 4117359 (pub 11-09 13:14Z, rows created 16:27Z, 16:36Z, 18:09Z),
// 4116605 (pub 08:36Z, created 11:33Z and 12:00Z) and 4118171 (pub 06:36Z,
// created 09:03Z, 09:18Z, 09:21Z) carry one pubDate on every row.
//
// An entry is added only with evidence for that outlet. The capture is digits
// only, which is what lets ingest build a PostgREST filter from it.
//
// Sources whose ids are keyed by `source_article_key` (article-key.ts) are covered
// by the stored (source_id, key) check in ingest instead: a kept row whose pubDate
// predates the id's first sighting is stamped there (h132-purity-1, evrensel
// 6008841, birgun 745397), so no entry is needed here for them.
export const STABLE_ARTICLE_ID_SOURCES: ReadonlyMap<string, RegExp> = new Map([
  ["anadolu-ajansi", /\/(\d{6,9})\/?$/],
]);

/**
 * The stable article id of `url` for `sourceSlug`, or null: the source is not in
 * STABLE_ARTICLE_ID_SOURCES, the url has no numeric path tail, or the digits sit
 * only in the query string or the fragment (both are cut off before matching).
 * The result is always 6-9 ASCII digits, never any other part of the url. Pure;
 * never throws; linear in the url length.
 */
export function stableArticleId(sourceSlug: string, url: string): string | null {
  if (typeof url !== "string") return null;
  const re = STABLE_ARTICLE_ID_SOURCES.get(sourceSlug);
  if (re === undefined) return null;
  const q = url.indexOf("?");
  const h = url.indexOf("#");
  const cut = q < 0 ? h : h < 0 ? q : Math.min(q, h);
  const m = re.exec(cut < 0 ? url : url.slice(0, cut));
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function absolutiseUrl(rawLink: string, source: RssSource): string {
  if (/^https?:\/\//i.test(rawLink)) return rawLink;
  if (rawLink.startsWith("/")) {
    const baseUrl = source.url.replace(/\/+$/, "");
    return baseUrl + rawLink;
  }
  const baseUrl = source.url.replace(/\/+$/, "") + "/";
  return baseUrl + rawLink.replace(/^\/+/, "");
}

/**
 * A raw item after the cheap half of normalisation: the cleaned title and the
 * absolute url, i.e. everything needed to ask the database whether the item is
 * already stored. `item` is the raw feed item, untouched, for `completeItem`.
 */
export interface PreparedItem {
  item: RawFeedItem;
  title: string;
  url: string;
}

/**
 * The cheap half of `normalizeItem`, in the order it always ran: no link ->
 * null (silent); blank title -> counted, null; decode / strip the title, then
 * `isContentlessTitle` -> counted, null; then an absolute url on an ad
 * click-tracker host (`isAdClickLink`, h130-feeds-2) -> counted in `adLinks`,
 * null; otherwise the cleaned title and the absolute url. It does NOT decide the
 * legal-notice drop (that stays in `completeItem`, as a legal notice is never
 * counted as contentless).
 *
 * Ingest runs this for every parsed item, looks up which urls are already
 * stored, and calls `completeItem` only for the rest: 99% of the items of a
 * poll are already stored and used to pay for the full normalisation anyway.
 */
export function prepareItem(
  source: RssSource,
  item: RawFeedItem,
  counters?: NormalizeCounters,
): PreparedItem | null {
  const rawTitle = item.title?.trim() ?? "";
  const rawLink = item.link?.trim() ?? "";
  if (!rawLink) return null;
  if (!rawTitle) {
    if (counters) counters.contentlessTitles++;
    return null;
  }

  // Titles are short plain text; clamp first (h26-security-2: an 80 KB title
  // of '<' cost 2.1 s here, before the known-url skip), decode entities, strip
  // any (possibly reintroduced or nested) markup, then one bounded residue
  // pass for double-encoded feeds. Same discipline and order as
  // `cleanDescription`.
  const title = stripInvalidXmlChars(
    decodeResidualEntities(
      stripTagsLinear(decodeEntities(clampForScan(rawTitle, TITLE_SCAN_CAP))),
    ),
  ).trim();
  // A title that decodes to nothing readable ('&nbsp', '-', '…') is not a
  // headline. Before the legal-notice check: a notice is not counted here.
  if (isContentlessTitle(title)) {
    if (counters) counters.contentlessTitles++;
    return null;
  }
  // h130-feeds-2: an ad click-tracker is not a story (a DoubleClick `gampad/clk`
  // link was stored as a Habertürk card and every reader click paid the
  // advertiser). The absolute url is computed once and checked by host, after
  // the title checks, so a headline-less item stays counted as contentless.
  const url = absolutiseUrl(rawLink, source);
  if (isAdClickLink(url)) {
    if (counters) counters.adLinks++;
    return null;
  }
  return { item, title, url };
}

/**
 * The heavy half of `normalizeItem`: legal notice, canonical url, description,
 * image, date, content hash, category. Returns `null` for a BİK legal notice
 * (`isLegalNotice`). `nowMs` is the clock `parseDate` falls back to and clamps
 * against.
 */
export function completeItem(
  source: RssSource,
  prepared: PreparedItem,
  nowMs: number = Date.now(),
): NormalizedArticle | null {
  const { item, title, url: absoluteUrl } = prepared;

  // ingest-hygiene: BİK court / official notices are not news.
  if (isLegalNotice(title, absoluteUrl)) return null;

  const canonicalUrl = canonicalizeUrl(absoluteUrl, source.slug);

  const description = cleanDescription(item.contentSnippet ?? item.content);
  const imageUrl = extractImage(item);
  const publishedAt = parseDate(item.isoDate ?? item.pubDate, {
    nowMs,
    sourceSlug: source.slug,
  });

  // Strict sha1-of-shingles content hash. Fallbacks mirror the worker's
  // chain so `content_hash` is never null — the column is NOT NULL. The
  // final fallback hashes the canonical absolute URL bytes with SHA-1 so
  // the output is always a 40-char lowercase hex digest, matching the
  // `articles.content_hash` CHECK constraint introduced in migration 026.
  const contentHash =
    strictFingerprint(title, description) ??
    strictFingerprint(title || absoluteUrl, "") ??
    sha1(absoluteUrl);

  const category: NewsCategory = SPORTS_SOURCE_SLUGS.has(source.slug)
    ? "spor"
    : classifyCategory(title, description, canonicalUrl);

  return {
    source_id: source.id,
    title,
    description,
    url: absoluteUrl,
    image_url: imageUrl,
    published_at: publishedAt,
    content_hash: contentHash,
    category,
  };
}

/**
 * Normalise a single raw RSS item into the row shape expected by the
 * `articles` table. `content_hash` is computed via `strictFingerprint`
 * exclusively. Returns `null` if the item lacks a link, has no headline text
 * (see below), links to an ad click-tracker host (`isAdClickLink`, counted in
 * `counters.adLinks`), or is a BİK legal notice (`isLegalNotice`).
 *
 * "No headline text" = the raw title is empty or whitespace-only, or the
 * decoded title holds no letter or digit (`isContentlessTitle`: '&nbsp',
 * '&amp;nbsp', '-', '…'). Such an item used to be stored and surfaced as an
 * indexable story titled '&amp;nbsp — Tayf'. When the item has a link and the
 * caller passes `counters`, `counters.contentlessTitles` is incremented; an item
 * without a link is dropped silently, as before. The check runs BEFORE the
 * legal-notice check, so a notice is never counted as contentless.
 *
 * It is `prepareItem` followed by `completeItem`, nothing more.
 */
export function normalizeItem(
  source: RssSource,
  item: RawFeedItem,
  nowMs: number = Date.now(),
  counters?: NormalizeCounters,
): NormalizedArticle | null {
  const prepared = prepareItem(source, item, counters);
  return prepared ? completeItem(source, prepared, nowMs) : null;
}

// The log line of the *Articles helpers below: the first error message with
// every URL redacted and clamped to 200 characters, never a title.
function describeThrown(err: unknown): string {
  return (err instanceof Error ? err.message : String(err))
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .slice(0, 200);
}

function logSkippedItems(slug: string, skipped: number, firstMessage: string): void {
  if (skipped > 0) {
    console.error(
      `[normalize] ${slug}: skipped ${skipped} item(s) that threw: ${firstMessage}`,
    );
  }
}

/**
 * Normalise an array of raw items, dropping any that fail the title/link
 * filter. Order preserved. `counters`, when given, is forwarded to every
 * `normalizeItem` call and totals the headline-less items of the batch
 * (`contentlessTitles`) and the ad click links (`adLinks`); omitting it behaves
 * exactly as before.
 *
 * One item that throws (a malformed field the decoders did not anticipate)
 * must not take the rest of the source's items down with it: it is skipped on
 * its own and counted, and ONE summary line is logged per call. The line
 * carries the source slug, the count and the first error message only -- never
 * a title or a URL (URLs inside the message are redacted).
 */
export function normalizeArticles(
  source: RssSource,
  items: RawFeedItem[],
  nowMs: number = Date.now(),
  counters?: NormalizeCounters,
): NormalizedArticle[] {
  const out: NormalizedArticle[] = [];
  let skipped = 0;
  let firstMessage = "";
  for (const item of items) {
    try {
      const row = normalizeItem(source, item, nowMs, counters);
      if (row) out.push(row);
    } catch (err) {
      if (skipped === 0) firstMessage = describeThrown(err);
      skipped++;
    }
  }
  logSkippedItems(source.slug, skipped, firstMessage);
  return out;
}

/**
 * `prepareItem` over an array. Items that are dropped (no link, contentless, ad link)
 * are absent from the result; the others keep their order. Same per-item
 * isolation as `normalizeArticles`: an item that throws is skipped on its own
 * and ONE `[normalize] <slug>: skipped N item(s) that threw` line is logged per
 * call (first message only, URLs redacted, never a title).
 */
export function prepareArticles(
  source: RssSource,
  items: readonly RawFeedItem[],
  counters?: NormalizeCounters,
): PreparedItem[] {
  const out: PreparedItem[] = [];
  let skipped = 0;
  let firstMessage = "";
  for (const item of items) {
    try {
      const prepared = prepareItem(source, item, counters);
      if (prepared) out.push(prepared);
    } catch (err) {
      if (skipped === 0) firstMessage = describeThrown(err);
      skipped++;
    }
  }
  logSkippedItems(source.slug, skipped, firstMessage);
  return out;
}

/**
 * `completeItem` over an array of prepared items. The result is ALIGNED with
 * the input: `out[i]` is the row of `prepared[i]`, or `null` when that item is a
 * legal notice or threw. Alignment is what lets ingest walk the feed in its
 * original order while some of its items were never completed. One item that
 * throws is isolated and ONE `[normalize] <slug>: skipped N item(s) that
 * threw` line is logged per call, like `normalizeArticles`.
 */
export function completeArticles(
  source: RssSource,
  prepared: readonly PreparedItem[],
  nowMs: number = Date.now(),
): Array<NormalizedArticle | null> {
  const out: Array<NormalizedArticle | null> = [];
  let skipped = 0;
  let firstMessage = "";
  for (const p of prepared) {
    try {
      out.push(completeItem(source, p, nowMs));
    } catch (err) {
      if (skipped === 0) firstMessage = describeThrown(err);
      skipped++;
      out.push(null);
    }
  }
  logSkippedItems(source.slug, skipped, firstMessage);
  return out;
}
