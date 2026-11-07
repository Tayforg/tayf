// h54-editorial-3: an opinion column is not news, and nothing in the schema says
// which article is one. The only signal is the URL path the outlet itself chose:
// Hürriyet, Sabah and A Haber put every column under /yazarlar/<columnist>/, and
// the other outlets use one of a handful of section names. The Jev "opinion"
// question that once answered this was retired for 15% precision
// (supabase/functions/_shared/jev.ts), and the URL needs no model, no column and
// no migration: it is read when it is needed.
//
// A column in a cluster used to become the indexable "neutral" title (539e6666:
// "Utanmazlık abidesi Sarıgül, Özgür Özel’i tehdit mi etti", a Hürriyet columnist's
// insult) and its thesis the story's summary, with no cue that it is a column.
// Callers that hold the article URL use this to keep a column out of the neutral
// title pick (neutral-title.ts, the headline cron), out of the summary
// replacement (summary-agreement.ts) and to label it on the cluster page.
//
// Pure: no I/O, no clock. Never throws.

/**
 * The path segments that mark an opinion column, lower case. A segment must be
 * the WHOLE segment: "yazarlar" matches /yazarlar/ali-veli/ and /haber/yazarlar/,
 * not /haber/yazarlarin-tepkisi-1 or /yazarlar-kurulu/.
 *   yazarlar, yazar          hurriyet, sabah, ahaber: /yazarlar/nedim-sener/...
 *   kose-yazilari, kose-yazisi, koseyazilari
 *   koseyazisi                aydinlik: /koseyazisi/<slug>-<id> (181 articles in 30 days)
 *   gunun-yazilari            serbestiyet: /gunun-yazilari/<slug>/ (55)
 *   column, columns, opinion  /opinion/columns/... on the English desks
 *   gorus                     "görüş"
 * Counts are articles.url over the 30 days to 2026-11-07 (h58-postship-3).
 */
export const OPINION_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "yazarlar",
  "yazar",
  "kose-yazilari",
  "kose-yazisi",
  "koseyazilari",
  "koseyazisi",
  "gunun-yazilari",
  "column",
  "columns",
  "opinion",
  "gorus",
]);

/**
 * Segments that mark a column on ONE outlet only, keyed by host (lower case, one
 * leading "www." removed, exact match). They are generic words, so a global entry
 * would flag other outlets' news (h58-postship-3):
 *   agos.com.tr    yazi    /tr/yazi/<slug>-<id> (36 in 30 days); Agos news is /tr/haber/ (173)
 *   halktv.com.tr  makale  /makale/<slug>-<id> (24); Halk TV news is /turkiye/, /siyaset/ ...
 * Left out on purpose: BirGün /makale/ (324) mixes news and columns, and Bianet /yazi/
 * (60) is the known Bianet item. Yeni Akit and Elips relays of a column sit under /haber/
 * and cannot be told from news by the path.
 */
export const OPINION_HOST_SEGMENTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["agos.com.tr", new Set(["yazi"])],
  ["halktv.com.tr", new Set(["makale"])],
]);

/** A longer segment cannot be one of the above: it is skipped without lower-casing it. */
const LONGEST_SEGMENT = Math.max(
  ...[...OPINION_PATH_SEGMENTS, ...[...OPINION_HOST_SEGMENTS.values()].flatMap((set) => [...set])].map(
    (s) => s.length,
  ),
);

/** The URL host, lower case, with one leading "www." removed ("www.agos.com.tr" -> "agos.com.tr"). */
function hostKey(hostname: string): string {
  const host = hostname.toLowerCase();
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * True when `url` parses as a URL and any segment of its path, lower-cased, is one
 * of {@link OPINION_PATH_SEGMENTS}, or one of the segments {@link OPINION_HOST_SEGMENTS}
 * lists for the URL's own host. The host picks that second set and nothing else (a
 * look-alike host such as agos.com.tr.evil.example gets none); the query string and
 * the fragment are never read ("?ref=yazarlar" is not a column). An unparseable URL
 * (empty, relative, protocol-relative, junk) and a non-string are false. One pass over
 * the path.
 */
export function isOpinionUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string") return false;
  let pathname: string;
  let hostSegments: ReadonlySet<string> | undefined;
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname;
    hostSegments = OPINION_HOST_SEGMENTS.get(hostKey(parsed.hostname));
  } catch {
    return false;
  }
  for (const segment of pathname.split("/")) {
    if (segment.length > LONGEST_SEGMENT) continue;
    const lower = segment.toLowerCase();
    if (OPINION_PATH_SEGMENTS.has(lower) || hostSegments?.has(lower)) return true;
  }
  return false;
}

/**
 * True when there is at least one member and every member's article URL is an
 * opinion URL: a cluster that is columns and nothing else (4555a9bd: the same
 * Sabah and A Haber column). A member with no URL is not known to be a column, so
 * it makes the cluster not all-opinion. False for no members and for a non-array.
 */
export function isAllOpinion(
  members: ReadonlyArray<{ article: { url?: string | null } }>,
): boolean {
  if (!Array.isArray(members) || members.length === 0) return false;
  return members.every((m) => isOpinionUrl(m?.article?.url));
}
