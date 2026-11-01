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
// Sports-source tagging, the keyword classifier, the entity decoder, and
// the image extractor are ported verbatim — they are dialect, not algorithm.

import { sha1, strictFingerprint } from "../cluster/fingerprint.ts";
import {
  codePointToString,
  decodeResidualEntities,
  isContentlessTitle,
  stripInvalidXmlChars,
} from "./entities.ts";
import {
  isOptimizableImageUrl,
  isPlaceholderImageUrl,
  normalizeImageUrl,
} from "../image-url.ts";
import type { RawFeedItem, RssSource } from "./fetcher.ts";
import { isLegalNotice } from "./legal-notice.ts";

export type NewsCategory =
  | "son_dakika"
  | "politika"
  | "dunya"
  | "ekonomi"
  | "spor"
  | "teknoloji"
  | "yasam"
  | "genel";

/**
 * Optional tally the caller passes to `normalizeItem` / `normalizeArticles`.
 * `contentlessTitles` counts the items dropped because their title has no
 * letter or digit after decoding (`isContentlessTitle`: '&nbsp', '&amp;nbsp',
 * '-', '…', an empty or whitespace-only title). A BİK legal notice or an item
 * with no link is dropped too but is NOT counted here.
 */
export interface NormalizeCounters {
  contentlessTitles: number;
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
// Category classifier
// ---------------------------------------------------------------------------

const SPORTS_SOURCE_SLUGS: ReadonlySet<string> = new Set([
  "fotomac",
  "fotospor",
  "a-spor",
  "ntv-spor",
  "kontraspor",
  "ajansspor",
]);

const CATEGORY_RULES: ReadonlyArray<{ category: NewsCategory; keywords: RegExp }> = [
  {
    category: "son_dakika",
    keywords: /son\s*dakika|flaş\s*haber|breaking|acil|sondakika/i,
  },
  {
    category: "spor",
    keywords:
      /futbol|süper\s*lig|galatasaray|fenerbahçe|beşiktaş|trabzonspor|basketbol|voleybol|şampiyonlar\s*ligi|milli\s*takım|gol|maç|transfer|teknik\s*direktör|stadyum|olimpiyat|uefa|fifa|tff/i,
  },
  {
    category: "politika",
    keywords:
      /erdoğan|chp|akp|ak\s*parti|mhp|hdp|tbmm|meclis|cumhurbaşkan|bakan(lık)?|seçim|oy|muhalefet|hükümet|vekil|siyaset|anayasa|parti\s*genel|içişleri|dışişleri/i,
  },
  {
    category: "dunya",
    keywords:
      /abd|amerika|rusya|ukrayna|çin|avrupa|nato|bm|birleşmiş\s*milletler|eu|ingiltere|almanya|fransa|iran|israil|filistin|suriye|irak|dünya|uluslararası|küresel/i,
  },
  {
    category: "ekonomi",
    keywords:
      /dolar|euro|tl|enflasyon|faiz|borsa|merkez\s*bankası|bist|ekonomi|ihracat|ithalat|büyüme|gsyih|vergi|maaş|asgari\s*ücret|zam|piyasa|kur/i,
  },
  {
    category: "teknoloji",
    keywords:
      /yapay\s*zeka|ai|iphone|samsung|google|microsoft|apple|siber|yazılım|uygulama|robot|teknoloji|dijital|startup|kripto|bitcoin|blockchain/i,
  },
  {
    category: "yasam",
    keywords:
      /sağlık|eğitim|üniversite|deprem|hava\s*durumu|trafik|kaza|yangın|sel|çevre|kültür|sanat|müzik|sinema|dizi|magazin|yaşam/i,
  },
];

function detectCategoryFromUrl(url: string): NewsCategory | null {
  const path = url.toLowerCase();
  if (/\/spor\/|\/sport/.test(path)) return "spor";
  if (/\/siyaset\/|\/politika\/|\/politi/.test(path)) return "politika";
  if (/\/ekonomi\/|\/finans\/|\/economy/.test(path)) return "ekonomi";
  if (/\/teknoloji\/|\/tech/.test(path)) return "teknoloji";
  if (/\/dunya\/|\/world\/|\/global/.test(path)) return "dunya";
  if (/\/yasam\/|\/life\/|\/saglik\/|\/egitim/.test(path)) return "yasam";
  return null;
}

function classifyCategory(
  title: string,
  description: string | null,
  url: string,
): NewsCategory {
  const text = `${title} ${description ?? ""} ${url}`.toLowerCase();
  const first = CATEGORY_RULES[0];
  if (first && first.keywords.test(text)) return first.category;
  const urlCategory = detectCategoryFromUrl(url);
  if (urlCategory) return urlCategory;
  for (let i = 1; i < CATEGORY_RULES.length; i++) {
    const rule = CATEGORY_RULES[i];
    if (rule && rule.keywords.test(text)) return rule.category;
  }
  return "genel";
}

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
// TODO(db-platform): haberet's '/150/84/' thumbnail shape is NOT upgraded
// here -- unlike rcman it carries no discoverable larger-variant path
// convention, and the audit found no verified bigger crop to swap in. Leave
// as-is until a haberet-specific larger variant is confirmed.
const RCMAN_SMALL = "/rcman/Cw150h84q95gc/";
const RCMAN_LARGE = "/rcman/Cw1280h720q95gc/";

export function upgradeThumbnailUrl(u: string): string {
  return u.includes(RCMAN_SMALL) ? u.split(RCMAN_SMALL).join(RCMAN_LARGE) : u;
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
    const normalized = normalizeImageUrl(c);
    if (
      normalized &&
      !isVideoUrl(normalized) &&
      isOptimizableImageUrl(normalized) &&
      !isPlaceholderImageUrl(normalized)
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
    const m = htmlContent.match(/<img[^>]+src=["']([^"']+)["']/i);
    const inline = normalizeImageUrl(m?.[1]);
    if (inline && isValidImageUrl(inline) && !isVideoUrl(inline)) {
      return upgradeThumbnailUrl(inline);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

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
// (./entities.ts), AFTER `stripTags`. Running it after the strip is what keeps
// the anti-markup guarantee: that pass never emits '<' or '>' ("&lt;" / "&gt;"
// and numeric references to them are left as they are), so it cannot
// reintroduce a tag the strip already removed. It is one level, not a loop:
// "&amp;amp;quot;" ends up as "&quot;".

// Strip HTML tags repeatedly until the string stops changing. A single
// `/<[^>]*>/` pass can leave a tag behind for crafted input like
// "<<script>script>", so loop to a fixpoint.
function stripTags(text: string): string {
  let prev: string;
  let out = text;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, "");
  } while (out !== prev);
  return out;
}

function cleanDescription(raw?: string | null): string | null {
  if (!raw) return null;
  // Decode FIRST so entity-encoded markup becomes real angle brackets, then
  // strip tags to a fixpoint so reintroduced or nested markup can't survive.
  //
  // Then ONE extra residue pass (double-encoded feeds), after the strip so it
  // cannot bring markup back; see the note above `stripTags`.
  //
  // Raw characters XML 1.0 forbids (C0 controls, U+FFFE / U+FFFF, lone
  // surrogates) are removed AFTER the residue pass and BEFORE the trim and the
  // 500-character clamp, so they can neither survive (the pass can reveal one,
  // e.g. "&amp;#11;") nor shift the clamp, which counts decoded text.
  const text = stripInvalidXmlChars(
    decodeResidualEntities(stripTags(decodeEntities(raw))),
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
 * `isContentlessTitle` -> counted, null; otherwise the cleaned title and the
 * absolute url. It does NOT decide the legal-notice drop (that stays in
 * `completeItem`, as a legal notice is never counted as contentless).
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

  // Titles are short plain text; decode entities then strip any (possibly
  // reintroduced or nested) markup to a fixpoint, then one bounded residue
  // pass for double-encoded feeds. Same discipline and order as
  // `cleanDescription`.
  const title = stripInvalidXmlChars(
    decodeResidualEntities(stripTags(decodeEntities(rawTitle))),
  ).trim();
  // A title that decodes to nothing readable ('&nbsp', '-', '…') is not a
  // headline. Before the legal-notice check: a notice is not counted here.
  if (isContentlessTitle(title)) {
    if (counters) counters.contentlessTitles++;
    return null;
  }
  return { item, title, url: absolutiseUrl(rawLink, source) };
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
 * (see below), or is a BİK legal notice (`isLegalNotice`).
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
 * (`contentlessTitles`); omitting it behaves exactly as before.
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
 * `prepareItem` over an array. Items that are dropped (no link, contentless)
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
