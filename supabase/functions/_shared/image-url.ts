// supabase/functions/_shared/image-url.ts
//
// ONE source of truth for "is this a usable image URL, and what is its
// canonical spelling". Pure and import-free so the exact same function runs
// in the Deno Edge Functions (ingest, image-consumer) and in Next (re-exported
// from `src/lib/images/image-url.ts`), which is what lets render-time
// normalisation heal rows already stored with a bad spelling -- no backfill.
//
// Nine real-world defects it fixes. Each one is a REPAIR, not a filter: either
// the publisher's own CDN serves the same image at the repaired spelling
// (1-5, 9, all HEAD-verified), or the value was never an image and storing it
// only blocks the og:image backfill (6, 7), or the image exists at a form the
// optimizer can fetch (8):
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
//   4. A `file://` scheme in front of a real DNS host, e.g. hurriyet's
//      `file://image.hurimg.com/i/hurriyet/75/620x350/<id>.jpg` (a path
//      copied from a local editor into the feed's <img src>). A `file:` URL is
//      never loadable by a browser, but the publisher's CDN serves the same
//      path over https, so `file://` becomes `https://`. Only a host that is a
//      dotted DNS name (no userinfo, port, bracket, backslash or space) and
//      does not end in a number is healed: `file:///etc/x.jpg`,
//      `file://localhost/x.jpg` and every IP spelling stay rejected. The
//      rewrite is a string rewrite and the host keeps its case. Whether the
//      healed host may be RENDERED is still decided by the remote-image
//      allowlist (`isAllowedRemoteImageUrl`), not here.
//   5. Aksam's feed writes the <enclosure> as
//      `https://img3.aksam.com.tr/imgsdisk2026/11/01/<slug>_2.jpg` (curl: 404
//      text/html) while media:content carries the same file as
//      `.../imgsdisk/2026/11/01/<slug>_2.jpg` (200 image/jpeg). The enclosure
//      wins at ingest, so 449 of 465 aksam rows in 48 h stored the 404. The
//      missing slash after `imgsdisk` is a publisher typo, the same file lives
//      at the spelling with the slash, so it is put back (first path segment
//      of an `img*.aksam.com.tr` host only, years 2000-2099).
//   6. A host root stored as the image, e.g. `https://cdn.istiklal.com.tr/`
//      (30 rows in 7 d; curl 200 text/html, 0 B, and the optimizer answers 502
//      because the host is allowlisted). There is no image to repair to, so it
//      normalises to null: the row gets NULL and enters the og:image backfill.
//      A root path WITH a query or hash (a resizer shape) is not a host root.
//   7. WordPress emoji PNGs (`https://s.w.org/images/core/emoji/...`, 72x72)
//      that a feed's <img src> picks up from the body text (9 rows in 7 d).
//      They are glyphs, not photos; same outcome as 6: null.
//   8. A YouTube embed page, `https://www.youtube.com/embed/<id>` (31 rows in
//      7 d, medyascope). That is HTML, and www.youtube.com is not on the image
//      allowlist, but `https://img.youtube.com/vi/<id>/hqdefault.jpg` is the
//      video's poster and is. The id must be exactly 11 of [A-Za-z0-9_-]; a
//      malformed id is left alone. Also `youtube-nocookie.com/embed/<id>` and
//      `youtu.be/<id>`.
//   9. Thumbnail-sized variants of an image the same CDN serves large: Gazete
//      Oksijen `/2/150/84/` (696 of 697 rows in 7 d, so the cluster hero,
//      which rejects anything under 320 px, fell back to a favicon tile) and
//      BBC Turkce `/ace/ws/240/`, plus the older rcman `Cw150h84q95gc` preset.
//      See `upgradeImageVariant`.
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

// `file://` + authority. The authority of a healable URL is exactly a dotted DNS
// name: LDH labels of 1-63 characters, at least two of them.
const FILE_SCHEME = /^file:\/\//i;
const DNS_HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const MAX_HOST_LENGTH = 253;
// The WHATWG URL parser reads a host whose LAST label is a decimal or `0x` hex
// number as an IPv4 address (`1.2.3.4`, but also `127.1` and `0x7f.0.0.1`).
// No real DNS name ends in a number, so none of those is healed.
const ENDS_IN_NUMBER = /(?:^|\.)(?:\d+|0x[0-9a-f]*)$/i;

/**
 * `file://<dns host>/...` -> `https://<dns host>/...` by string rewrite, or
 * null when the authority is anything but a dotted DNS name. `s` must start
 * with `file://` (case-insensitive).
 */
function healFileScheme(s: string): string | null {
  const rest = s.slice(7);
  const end = rest.search(/[\/?#]/);
  const host = end === -1 ? rest : rest.slice(0, end);
  if (host.length > MAX_HOST_LENGTH) return null;
  if (!DNS_HOST.test(host) || ENDS_IN_NUMBER.test(host)) return null;
  return "https://" + rest;
}

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

// A path that is nothing but slashes: the URL names a host, not a file.
const ONLY_SLASHES = /^\/+$/;

const EMOJI_PATH_PREFIX = "/images/core/emoji/";

// `youtube.com` / `youtube-nocookie.com` embed pages and `youtu.be` short
// links carry an 11-character video id; the poster is served from img.youtube.com.
const YOUTUBE_EMBED_HOSTS: ReadonlySet<string> = new Set([
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
]);
const YOUTUBE_EMBED_PATH = /^\/embed\/([A-Za-z0-9_-]{11})\/?$/;
const YOUTUBE_SHORT_PATH = /^\/([A-Za-z0-9_-]{11})\/?$/;

function youtubeThumbnail(parsed: URL): string | null {
  const host = parsed.hostname;
  const m =
    host === "youtu.be"
      ? YOUTUBE_SHORT_PATH.exec(parsed.pathname)
      : YOUTUBE_EMBED_HOSTS.has(host)
        ? YOUTUBE_EMBED_PATH.exec(parsed.pathname)
        : null;
  return m ? `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` : null;
}

// Aksam: `/imgsdisk2026/...` is a typo for `/imgsdisk/2026/...`. Anchored to the
// FIRST path segment of an `img*.aksam.com.tr` host; run after the leading
// slash run was collapsed, so the segment is really first.
const AKSAM_IMGSDISK = /^(https?:\/\/img\d*\.aksam\.com\.tr)\/imgsdisk(20\d\d)\//i;

/**
 * `https://img3.aksam.com.tr/imgsdisk2026/11/01/x_2.jpg` ->
 * `https://img3.aksam.com.tr/imgsdisk/2026/11/01/x_2.jpg` by string rewrite
 * (query, hash and host case untouched). Anything else is returned `===`.
 */
function repairAksamImgsdisk(u: string): string {
  return AKSAM_IMGSDISK.test(u) ? u.replace(AKSAM_IMGSDISK, (_m, host: string, year: string) => `${host}/imgsdisk/${year}/`) : u;
}

const OKSIJEN_SMALL = /^(https?:\/\/i\.gazeteoksijen\.com\/2\/)150\/84\//i;
const BBC_SMALL = /^(https?:\/\/ichef\.bbci\.co\.uk\/ace\/)ws\/240\//i;
const RCMAN_SMALL = "/rcman/Cw150h84q95gc/";
const RCMAN_LARGE = "/rcman/Cw1280h720q95gc/";

/**
 * Swap a known small variant of an image for the large one the same CDN
 * serves, by string rewrite (query and hash untouched):
 *
 *   - `i.gazeteoksijen.com/2/150/84/<path>`  -> `/2/1280/720/<path>`
 *     (150x84 -> 1280x720; HEAD-verified 2026-11-01: 200 image/jpeg, 131 KB
 *     against 6 KB for the same file)
 *   - `ichef.bbci.co.uk/ace/ws/240/<path>`   -> `/ace/standard/976/<path>`
 *   - `/rcman/Cw150h84q95gc/` -> `/rcman/Cw1280h720q95gc/` on any host, every
 *     occurrence (aydinlik, ekonomim, f5haber, artigercek, yenicag; the rule
 *     ingest has applied since audit fix A / migration 084)
 *
 * Every other URL, and every already-large variant, is returned `===`; the
 * function is idempotent. milliyet / hurriyet 1200x675 is NOT handled: no
 * larger crop was verified for them.
 */
export function upgradeImageVariant(u: string): string {
  let s = u;
  if (OKSIJEN_SMALL.test(s)) s = s.replace(OKSIJEN_SMALL, (_m, head: string) => `${head}1280/720/`);
  else if (BBC_SMALL.test(s)) s = s.replace(BBC_SMALL, (_m, head: string) => `${head}standard/976/`);
  return s.includes(RCMAN_SMALL) ? s.split(RCMAN_SMALL).join(RCMAN_LARGE) : s;
}

export function normalizeImageUrl(u: string | null | undefined): string | null {
  if (typeof u !== "string") return null;
  let s = u.trim();
  if (!s) return null;
  if (FILE_SCHEME.test(s)) {
    const healed = healFileScheme(s);
    if (healed === null) return null;
    s = healed;
  }
  if (s.startsWith("//")) s = "https:" + s;

  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  // Not an image at all: a host root (no query / hash, so a resizer's
  // `https://h/?u=<origin>` survives) or a WordPress emoji glyph.
  if (ONLY_SLASHES.test(parsed.pathname) && !parsed.search && !parsed.hash) return null;
  if (
    parsed.hostname === "s.w.org" &&
    parsed.pathname.replace(/^\/+/, "/").startsWith(EMOJI_PATH_PREFIX)
  ) {
    return null;
  }

  // A video embed page maps to the video's poster, which is an image.
  const poster = youtubeThumbnail(parsed);
  if (poster !== null) return poster;

  // Order matters: collapse the leading slashes first so a URL carrying both
  // defects heals in a single call, and so the aksam rewrite sees the segment
  // it anchors on as the first one.
  if (LEADING_PATH_SLASHES.test(s)) s = s.replace(LEADING_PATH_SLASHES, "$1/");
  const joined = repairJoinedImageSegment(s);
  if (joined === null) return null;
  return upgradeImageVariant(repairAksamImgsdisk(joined));
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
 * path keeps its case) in NORMALISED form: `normalizeImageUrl('https://' + key)`
 * must return the same string (guarded by a test). Every entry is a publisher logo card or generic
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
  // aksam: generic Akşam stand-in photo, 32 distinct titles. Keyed on the REAL
  // spelling (`/imgsdisk/2026/...`, curl 200): the feed's enclosure spells it
  // `/imgsdisk2026/...` (curl 404), which normalizeImageUrl repairs to this key
  // before the lookup, so one entry covers both. The key must be the form
  // normalisation PRODUCES, or it can never match (the old `imgsdisk2026` key
  // let the 16 rows stored under the real spelling through).
  "img3.aksam.com.tr/imgsdisk/2026/01/01/210220191220255418101_2.jpg",
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

// More CMS stand-ins (hunt-15, 33 rows in 48 h across sozcu, korkusuz, ekonomim,
// muhalif, yenicag, takvim, haberler-com, cgtn-turk, tele1, aydinlik). Each is
// anchored to the WHOLE basename and uses only bounded quantifiers (or one
// unbounded digit run directly before `$`), so every match is linear.
//
//   sozcu / korkusuz  son-dakikajpg-fGomF2NHS0uGhDDwDPCbMQ,
//                     sondakika880x487uzunjpg-<hash>, logojpg-<hash>
//                     (the CMS glues the extension onto the name and appends
//                     a fresh 22-character hash per upload)
//   haberler-com      son-dakika_amp
//   rcman, ekonomim   default            (images/default.png)
//   muhalif           3712-muhalif-default-cover
//   takvim            tkv-default-1754911321840 (also behind the ?u= resizer)
//   cgtn-turk, tele1  placeholder        (assets/images/placeholder.png)
// A slug that merely contains 'default' or 'son-dakika' does not match: the
// word has to be the whole name, or the whole tail after a `-` / `_`.
const PLACEHOLDER_BASENAME_EXTRA: readonly RegExp[] = [
  /^(?:tr[_-]?)?son[_-]?dakika(?:\d{2,4}x\d{2,4})?[a-z]{0,8}(?:jpe?g|png|webp)(?:-[A-Za-z0-9_-]{16,32})?$/i,
  /^logo(?:jpe?g|png|webp)(?:-[A-Za-z0-9_-]{16,32})?$/i,
  /^son[_-]?dakika_amp$/i,
  /^default(?:[-_]cover)?$/i,
  /(?:^|[-_])default[-_]cover$/i,
  /(?:^|[-_])default[-_]\d{6,}$/i,
  /^placeholder$/i,
];

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
  if (name.length > MAX_BASENAME_LENGTH) return false;
  return (
    PLACEHOLDER_BASENAME.test(name) || PLACEHOLDER_BASENAME_EXTRA.some((re) => re.test(name))
  );
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
 * Three layers use it. Ingest drops a placeholder at normalize time (the row
 * gets a NULL image_url, which queues the og:image backfill). The og:image
 * backfill rejects a placeholder too and counts it as an attempt, so it never
 * stores one and cannot loop. The render filter stays as defence for
 * historical rows: callers null the URL at the query boundary, so the hero and
 * credit fall through to the next member's photo or to the logo tier. Never
 * throws; null, empty, unparseable and non-http(s) input is simply `false`.
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

// A whole token `favicon` / `apple-touch-icon` / `icon` / `logo` in the
// basename: at the start or after `-`, `_`, `.`, and followed by the end or a
// `-`, `_`, `.` or digit. `silicon-vadisi` and `catalogo` do not match.
const ICON_LIKE_BASENAME = /(?:^|[-_.])(?:favicon|apple-touch-icon|icon|logo)(?:$|[-_.\d])/i;

function isIconLikePath(url: string): boolean {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  const name = placeholderBasename(path);
  return name.length <= MAX_BASENAME_LENGTH && ICON_LIKE_BASENAME.test(name);
}

/**
 * Whether the file name of `u` is a site icon or logo (`logo.png`,
 * `favicon.ico`, `apple-touch-icon.png`, `site-logo-2x.png`, `icon_32.png`).
 *
 * Why: the ingest extractor trusted any <enclosure> / media:* URL, so a feed
 * that advertises its masthead there (mfa.gov.tr: `/images/logo.png`) stored it
 * as the story's photo. Only the decoded basename (query and hash dropped,
 * extension stripped) is looked at, and only as WHOLE tokens, so a directory
 * called `/logo/`, `silicon-vadisi-haberi.jpg` and `catalogo.jpg` are fine. A
 * resizer URL that wraps its origin in a `u=` query value is checked on the
 * wrapped origin as well. Never throws; null, empty and non-string input is
 * simply `false`.
 */
export function isIconLikeImageUrl(u: string | null | undefined): boolean {
  try {
    if (typeof u !== "string") return false;
    const s = u.trim();
    if (!s) return false;
    if (isIconLikePath(s)) return true;
    const q = s.indexOf("?");
    if (q === -1) return false;
    const wrapped = new URLSearchParams(s.slice(q + 1).split("#", 1)[0]).get("u");
    return !!wrapped && isIconLikePath(wrapped);
  } catch {
    return false;
  }
}
