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
import type { RawFeedItem, RssSource } from "./fetcher.ts";

export type NewsCategory =
  | "son_dakika"
  | "politika"
  | "dunya"
  | "ekonomi"
  | "spor"
  | "teknoloji"
  | "yasam"
  | "genel";

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
  if (/favicon|icon|logo|pixel|tracker|1x1|spacer/i.test(url)) return false;
  return true;
}

function getImageEnclosure(item: RawFeedItem): string | null {
  if (!item.enclosure?.url) return null;
  const type = item.enclosure.type ?? "";
  if (type && !type.startsWith("image/")) return null;
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
    if (c && !isVideoUrl(c)) return upgradeThumbnailUrl(c);
  }
  return null;
}

function extractImage(item: RawFeedItem): string | null {
  const fromFields = firstNonVideoCandidate([
    getImageEnclosure(item),
    item.mediaContent?.$?.url,
    item.mediaThumbnail?.$?.url,
    item.mediaGroup?.["media:content"]?.$?.url,
    item.mediaGroup?.["media:thumbnail"]?.$?.url,
  ]);
  if (fromFields) return fromFields;

  if (item.itemImage && isValidImageUrl(item.itemImage) && !isVideoUrl(item.itemImage)) {
    return upgradeThumbnailUrl(item.itemImage);
  }

  const htmlContent = item.contentEncoded ?? item.content ?? "";
  if (htmlContent) {
    const m = htmlContent.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m?.[1] && isValidImageUrl(m[1]) && !isVideoUrl(m[1])) {
      return upgradeThumbnailUrl(m[1]);
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
function decodeEntities(text: string): string {
  return text.replace(
    /&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g,
    (match, entity: string) => {
      if (entity[0] === "#") {
        const codePoint =
          entity[1] === "x" || entity[1] === "X"
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
      }
      return NAMED_ENTITIES[entity] ?? match;
    },
  );
}

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
  const text = stripTags(decodeEntities(raw)).trim();
  if (!text) return null;
  return text.length > 500 ? text.slice(0, 497) + "..." : text;
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
export function parseDate(raw: string | undefined, opts: ParseDateOptions): string {
  const { nowMs, sourceSlug } = opts;
  const fallback = new Date(nowMs).toISOString();
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;

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
      return fallback;
    }
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return fallback;

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
 * Normalise a single raw RSS item into the row shape expected by the
 * `articles` table. `content_hash` is computed via `strictFingerprint`
 * exclusively. Returns `null` if the item lacks a title or a link.
 */
export function normalizeItem(
  source: RssSource,
  item: RawFeedItem,
  nowMs: number = Date.now(),
): NormalizedArticle | null {
  const rawTitle = item.title?.trim() ?? "";
  const rawLink = item.link?.trim() ?? "";
  if (!rawTitle || !rawLink) return null;

  // Titles are short plain text; decode entities then strip any (possibly
  // reintroduced or nested) markup to a fixpoint, same discipline as
  // `cleanDescription`.
  const title = stripTags(decodeEntities(rawTitle)).trim();
  const absoluteUrl = absolutiseUrl(rawLink, source);
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
 * Normalise an array of raw items, dropping any that fail the title/link
 * filter. Order preserved.
 */
export function normalizeArticles(
  source: RssSource,
  items: RawFeedItem[],
  nowMs: number = Date.now(),
): NormalizedArticle[] {
  const out: NormalizedArticle[] = [];
  for (const item of items) {
    const row = normalizeItem(source, item, nowMs);
    if (row) out.push(row);
  }
  return out;
}
