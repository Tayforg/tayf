// supabase/functions/_shared/image-url.ts
//
// ONE source of truth for "is this a usable image URL, and what is its
// canonical spelling". Pure and import-free so the exact same function runs
// in the Deno Edge Functions (ingest, image-consumer) and in Next (re-exported
// from `src/lib/images/image-url.ts`), which is what lets render-time
// normalisation heal rows already stored with a bad spelling -- no backfill.
//
// Three real-world defects it fixes:
//
//   1. A doubled leading path slash, e.g. haber7's
//      `https://i12.haber7.net//fotogaleri/x.jpg`. The upstream CDN 404s for
//      it behind the Next optimizer, while `/fotogaleri/x.jpg` works.
//   2. Protocol-relative values (`//cdn.example/a.jpg`) that a bare
//      `new URL(...)` rejects and an `<img>` would resolve against the page.
//   3. Two glued Mongo ObjectIds as the last path segment, e.g. posta's
//      `.../0x0/627e113be4bfdc26aca117f5.jpg6acfb319b65de53ef53b8d3c.jpg`
//      (posta, 2026-10-22: 1,231 rows in 7 days). The publisher writes that
//      string itself in the feed's <img src>; the CDN 404s for it. The first
//      id is a constant placeholder asset, the second is the real image, so
//      the last segment is rewritten to `/<second id>.<second ext>`.
//
// Deliberately NOT done: URL re-serialisation. `new URL(u).toString()` would
// lowercase hosts, percent-encode characters and add a trailing slash,
// silently changing keys that other code (credit lookup, dedupe, DB rows)
// compares by string identity. A clean input is returned `===` unchanged.
// Only the LEADING run of slashes in the path is collapsed; a mid-path `//`
// (e.g. `.../resize/1280x720//haber/x.jpg`) is significant to some CDNs and
// is kept, as are the query string and hash, byte for byte.

const LEADING_PATH_SLASHES = /^(https?:\/\/[^\/?#]+)\/{2,}/i;

// `/<24 hex>.<ext><24 hex>.<ext>` as the LAST path segment (anchored with `$`,
// so it is applied to the path only, never to a query or hash).
const JOINED_OBJECT_ID_SEGMENT =
  /\/([0-9a-f]{24})\.(jpe?g|png|webp)([0-9a-f]{24})\.(jpe?g|png|webp)$/i;

// Scheme + authority prefix; a match must start after it so the host is never
// rewritten (`https://<id>.jpg<id>.jpg` has a `/` right before the "first id").
const AUTHORITY_PREFIX = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^\/]*/i;

/**
 * Heal a URL whose last path segment is two glued Mongo ObjectIds
 * (`/<id1>.<ext1><id2>.<ext2>`, posta) by keeping the SECOND id and extension:
 * `/<id2>.<ext2>`. HEAD-verified 2026-10-22: the joined URL is a 404, `<id1>`
 * is one constant 1,650-byte placeholder image, `<id2>` is the real article
 * image.
 *
 * Only the path (before the first `?` / `#`) is inspected and rewritten; the
 * query and hash are kept byte for byte, the host is never touched, and hex /
 * extension case is preserved. A string that is not that exact shape is
 * returned `===` unchanged. `null` is reserved for a recognised joined shape
 * with no verified-resolvable half; every shape handled today (posta) has one,
 * so the function is currently total.
 */
export function repairJoinedImageSegment(u: string): string | null {
  const cut = u.search(/[?#]/);
  const path = cut === -1 ? u : u.slice(0, cut);
  const m = JOINED_OBJECT_ID_SEGMENT.exec(path);
  if (!m) return u;
  const authorityEnd = AUTHORITY_PREFIX.exec(path)?.[0].length ?? 0;
  if (m.index < authorityEnd) return u;
  const tail = cut === -1 ? "" : u.slice(cut);
  return `${path.slice(0, m.index)}/${m[3]}.${m[4]}${tail}`;
}

export function normalizeImageUrl(u: string | null | undefined): string | null {
  if (typeof u !== "string") return null;
  let s = u.trim();
  if (!s) return null;
  if (s.startsWith("//")) s = "https:" + s;

  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  // Order matters: collapse the leading slashes first so a URL carrying both
  // defects heals in a single call.
  if (LEADING_PATH_SLASHES.test(s)) s = s.replace(LEADING_PATH_SLASHES, "$1/");
  return repairJoinedImageSegment(s);
}

/**
 * Whether `u` may be handed to `next/image` / an `<img>` as a story image.
 *
 * False for an animated GIF (path ending in `.gif`, case-insensitive; the
 * query string and fragment are ignored, so `a.gif?x=1` is out but
 * `img?format=gif` and `a.gifv` are not) and for null / undefined / empty
 * input.
 *
 * Why: haber7 and elips-haber advertise a 22.3 MB animated placeholder GIF
 * as their feed image. `/_next/image` passes animated GIFs through
 * UNMODIFIED (it never re-encodes them), so every card that picks one ships
 * 22 MB to the browser. The filter therefore sits at ingest, at each
 * server-side query boundary (so the URL never reaches the RSC/HTML payload)
 * and in `ClusterCardImage` as defence in depth.
 *
 * Deliberately a pure string check: it does not normalise or parse, so the
 * verdict is the same for `//cdn/a.gif`, `https://h//a.gif` and
 * `https://h/a.gif`.
 */
export function isOptimizableImageUrl(u: string | null | undefined): boolean {
  if (typeof u !== "string") return false;
  const s = u.trim();
  if (!s) return false;
  const path = s.split(/[?#]/, 1)[0] ?? "";
  return !path.toLowerCase().endsWith(".gif");
}

// ---------------------------------------------------------------------------
// db-4 / perf-2: publisher logo cards and 'son dakika' placeholders.
// ---------------------------------------------------------------------------

/**
 * Placeholder assets that cannot be recognised by their file name, keyed
 * `${hostname.toLowerCase()}${pathname}` (no scheme, query or fragment; the
 * path keeps its case). Every entry is a publisher logo card or generic
 * stand-in that the publisher attaches to unrelated stories; the reuse count
 * is the number of DISTINCT titles that carried the URL in a read-only prod
 * sample (articles published in the trailing 48 h, 2026-10-23, threshold
 * >= 10 titles).
 *
 * Add a row only after the same query shows it reused across >= 10 titles at
 * a verified source. Names that follow the 'son dakika' / default-photo shape
 * belong in PLACEHOLDER_BASENAME instead, so they need no entry here.
 */
export const PLACEHOLDER_IMAGE_ASSETS: ReadonlySet<string> = new Set([
  // cnn-turk: the red CNN TÜRK logo card, 174 distinct titles.
  "image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg",
  // aksam: generic Akşam stand-in photo, 32 distinct titles.
  "img3.aksam.com.tr/imgsdisk2026/01/01/210220191220255418101_2.jpg",
  // diken: "gunun" (of the day) card, 22 distinct titles.
  "www.diken.com.tr/wp-content/uploads/2021/10/gunun_11.jpg",
  // star: generic Star stand-in photo, 22 distinct titles.
  "imgs.star.com.tr/imgsdisk/2026/10/02/1138373167528_2-15012019114103500.jpg",
  // gzt: GZT 'son dakika' card, 15 distinct titles.
  "img.piri.net/resim/imagecrop/2018/04/20/06/49/resized_9641d-8b15395cgztsondakika.jpg",
  // haber-global: Haber Global 'son dakika' card, 13 distinct titles.
  "i.haberglobal.com/storage/files/images/2021/09/23/haberglobal-sondakika-1jxM.png",
  // a-haber: the default image lives in the resizer's `u=` query value
  // (iaahbr.tmgrup.com.tr/<crop>?u=<origin>), so the key is the wrapped
  // origin, which holds for every crop of it; 11 distinct titles.
  "iahbr.tmgrup.com.tr/Defaults/Upload/ahbr-default-1754911102530.png",
]);

// Applied to the LAST path segment's basename only (percent-decoded, final
// extension stripped) and anchored to the whole of it, so a directory called
// `/son-dakika/` or an article slug such as
// `son-dakika-erdogan-aciklama-18123456` never matches. Every repetition of
// the suffix group needs its own separator, which keeps the match linear (a
// separator-less `(\d{1,4})*` backtracks exponentially on a long digit run).
//   yeni-safak   tr_son_dakika_530x530
//   haberler-com son-dakika_o
//   isci-haber   default_news_photo
const PLACEHOLDER_BASENAME =
  /^(?:tr[_-]?)?son[_-]?dakika(?:[_-]?\d{1,4})?(?:[_-](?:haberleri?|default|placeholder|logo|o|\d{1,4}|\d+x\d+))*$|^default[_-]?news[_-]?photo(?:[_-]?\d+)?$/i;

// A real file name is short; refuse to run the pattern on anything longer.
const MAX_BASENAME_LENGTH = 200;

function placeholderBasename(pathname: string): string {
  const slash = pathname.lastIndexOf("/");
  let name = slash === -1 ? pathname : pathname.slice(slash + 1);
  try {
    name = decodeURIComponent(name);
  } catch {
    // Malformed percent-encoding: match the raw name instead.
  }
  return name.replace(/\.[a-z0-9]{1,5}$/i, "");
}

function matchesPlaceholder(parsed: URL): boolean {
  if (PLACEHOLDER_IMAGE_ASSETS.has(`${parsed.hostname.toLowerCase()}${parsed.pathname}`)) {
    return true;
  }
  const name = placeholderBasename(parsed.pathname);
  return name.length <= MAX_BASENAME_LENGTH && PLACEHOLDER_BASENAME.test(name);
}

function parseNormalized(u: string): URL | null {
  const n = normalizeImageUrl(u);
  if (n === null) return null;
  try {
    return new URL(n);
  } catch {
    return null;
  }
}

/**
 * Whether `u` is a publisher logo card or a 'son dakika' stand-in that must
 * never be shown as a story's hero, card or thumbnail.
 *
 * Why (db-4): in a read-only prod sample (articles published in the trailing
 * 48 h), one image_url was attached to 10-174 DISTINCT titles at each of ten
 * sources (CNN TÜRK's red logo card alone: 174 titles). Shown as a hero it
 * tells the reader nothing and, worse, lets an unrelated story borrow the
 * look of another. The verdict is: an exact asset (PLACEHOLDER_IMAGE_ASSETS,
 * compared as lower-case host + path, so query, fragment, scheme, a doubled
 * leading slash and host case do not matter) or a basename that matches
 * PLACEHOLDER_BASENAME. A resizer URL that wraps its origin in a `u=` query
 * value is checked on the wrapped origin as well.
 *
 * Render-only for now: callers null the URL at the query boundary, so the
 * hero and credit fall through to the next member's photo or to the logo
 * tier. Ingest still stores the URL and nothing is backfilled. Never throws;
 * null, empty, unparseable and non-http(s) input is simply `false`.
 */
export function isPlaceholderImageUrl(u: string | null | undefined): boolean {
  try {
    const parsed = parseNormalized(u as string);
    if (!parsed) return false;
    if (matchesPlaceholder(parsed)) return true;
    const wrapped = parsed.searchParams.get("u");
    if (!wrapped) return false;
    const inner = parseNormalized(wrapped);
    return inner !== null && matchesPlaceholder(inner);
  } catch {
    return false;
  }
}
