// supabase/functions/_shared/rss/fetcher.ts
//
// Charset-aware RSS fetcher for the ingest Edge Function. Ports the
// per-cycle HTTP behaviour from `scripts/rss-worker.mjs` (conditional
// GET, per-source UA override, abort-on-timeout) and adds the
// audit T7 P1-22 charset-aware decode that the legacy `res.text()`
// path was missing.
//
// XML parsing uses `fast-xml-parser` via `esm.sh`, which Deno can load
// natively. We map the parsed object back into the same `RawFeedItem`
// shape that the legacy normalizer expects so the port can stay
// near-mechanical.
//
// A feed body is attacker-controlled input (a compromised outlet, or anyone on
// the path to the plain-http feeds), so the parser is pinned to 4.5.7 (4.5.0
// expanded DOCTYPE entities without a limit: a 210 KB feed became a 400+ MB
// <title> and killed the isolate every cycle, h26-security-1) and `parseFeed`
// refuses DOCTYPE entity declarations outright. See XML_PARSER_OPTIONS.
// The pin is bumped deliberately; tests/guards/edge-deps-pinned.test.ts holds
// the floor.
//
// `?deps=strnum@1.1.2` pins the parser's one dependency too. Without it the
// entry module re-imports `/strnum@^1.0.5`, a range esm.sh re-resolves every
// ten minutes, so each deploy would bundle whatever strnum 1.x is newest into
// the isolate that holds the service-role key (h27-supply-2). The value is the
// package-lock.json version, and the same guard fails when the two drift.

import { XMLParser } from "https://esm.sh/fast-xml-parser@4.5.7?deps=strnum@1.1.2";
import { decodeRssBody } from "./charset.ts";
import { safeResponse, SafeFetchError } from "../safe-fetch.ts";
import { pickItemLink } from "./items.ts";
import { cleanFeedDate, isParseableFeedDate } from "./dates.ts";

export interface RssSource {
  id: string;
  name: string;
  slug: string;
  url: string;
  rss_url: string;
}

export interface RawFeedItem {
  title?: string;
  link?: string;
  content?: string;
  contentSnippet?: string;
  contentEncoded?: string;
  pubDate?: string;
  isoDate?: string;
  enclosure?: { url?: string; type?: string };
  mediaContent?: { $?: { url?: string } };
  mediaThumbnail?: { $?: { url?: string } };
  mediaGroup?: {
    "media:content"?: { $?: { url?: string } };
    "media:thumbnail"?: { $?: { url?: string } };
  };
  itemImage?: string;
}

export interface FetchResult {
  source: RssSource;
  items: RawFeedItem[];
  status: number;
  charset?: string;
  notModified?: boolean;
  etag?: string | null;
  lastModified?: string | null;
  /** SHA-256 hex digest of the raw (pre-decode) response body on a 2xx that
   * parsed (or was recognised as unchanged). NOT returned with `error`: a body
   * the fetcher refused or could not parse must never become the stored
   * validators, or the next poll of the same bytes would count as a healthy
   * "not modified" (h27-live-1). Same for `etag` and `lastModified`. */
  bodyHash?: string;
  /** Set (without etag, lastModified or bodyHash) when the request failed, the
   * status was not 2xx, the body was too large, or a 2xx body was refused:
   * `not a feed: ...` (notAFeed) or `parse error: ...`. In both 2xx cases the
   * conditional cache is back at its pre-request value. */
  error?: string;
  /** Set when the body is not a feed: an HTML page (recognised from its first
   * bytes, or from a parsed body with none of the recognised feed roots rss,
   * feed, rdf:RDF, RDF), a plain-text or a 404 body masquerading as a 2xx feed
   * response (ingest-health). `error` is set alongside this. */
  notAFeed?: boolean;
  /** Count of items whose (isoDate ?? pubDate) is absent or fails
   * `isParseableFeedDate` after `cleanFeedDate` -- ingest-health. */
  dateFallbacks?: number;
  /** The first present-but-unparseable raw date value this fetch saw,
   * sliced to 80 chars -- ingest-health. */
  dateFallbackSample?: string;
  /** Set when `FetchOptions.admitParse` refused the parse of a changed 2xx
   * body (parse budget): nothing was decoded or parsed, `items` is empty and
   * NO validators (etag, lastModified, bodyHash) are returned -- the
   * conditional cache is restored so the next poll fetches the feed again
   * instead of answering it with a 304. Not an error, not a failure. */
  parseDeferred?: boolean;
}

export interface ConditionalCacheEntry {
  etag?: string;
  lastModified?: string;
}

export interface FetchOptions {
  /** Per-source conditional GET cache (etag + last-modified). */
  conditionalCache?: Map<string, ConditionalCacheEntry>;
  /** Per-fetch timeout in milliseconds. Default 10 000. */
  timeoutMs?: number;
  /** Last body hash we stored for this source (migration 041). A 2xx whose
   * body hashes the same is treated as not-modified BEFORE decode/parse. */
  knownBodyHash?: string;
  /** Maximum bytes read from the feed body. Default DEFAULT_MAX_BYTES — lets
   * tests drive the cap with a tiny body without touching the module const. */
  maxBytes?: number;
  /** Parse budget. Called with the body's byte length once the body is in
   * memory and hashed, only when a decode + XML parse would actually follow:
   * never for a 304, a non-2xx, an oversize body or a body-hash hit. Returning
   * false defers the feed (`FetchResult.parseDeferred`); a throw counts as
   * true. Omit it for the unconditional behaviour. */
  admitParse?: (bodyBytes: number) => boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// SEC-01: outbound RSS fetches now go through the same SSRF guard
// (safeResponse) as the og-image path, rather than a bare `fetch`. Plain
// `redirect: "follow"` lets a platform client chase ~20 hops; 5 is enough
// to cover a real http→https→cdn feed migration chain while keeping the
// re-validated-per-hop guard loop bounded.
const FEED_MAX_REDIRECTS = 5;

// A feed body is now attacker-configured (the guard only validates the
// HOST, not the response size), so an unbounded `arrayBuffer()` read is a
// memory-exhaustion DoS. 8 MB comfortably covers the largest legitimate
// outlets in the roster with headroom; readBoundedBytes below enforces it
// via a streamed read rather than buffering first and checking after.
const DEFAULT_MAX_BYTES = 8_000_000;

// Deliberately out of scope for this PR: no DNS cache / TTL-aware re-pin
// here. safeResponse re-resolves per call; a shared cache is a separate
// perf change with its own staleness tradeoffs.

// Hashing the raw bytes (not the decoded text) is both cheaper and much
// smaller to carry on `FetchResult` than the body itself (migration 041) --
// the caller only needs to know "did this change since last time", not the
// content.
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Cast needed: TS's lib.dom BufferSource type wants an
  // ArrayBufferView<ArrayBuffer> specifically, but `bytes` here is typed as
  // Uint8Array<ArrayBufferLike> (it may be backed by a SharedArrayBuffer in
  // principle) even though in practice it never is — it's always the sole
  // Uint8Array wrapping a bounded, reassembled read.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// SEC-01: `source.rss_url` now reaches this function after passing the SSRF
// host guard, but the guard validates only the HOST, not what that host
// sends back -- a malicious or misconfigured outlet can still stream an
// unbounded body. The old `new Uint8Array(await response.arrayBuffer())`
// buffered the whole thing before we ever got to check its size, which is a
// memory-exhaustion DoS on an attacker-configured URL. This reads via the
// stream reader instead, bailing (and cancelling the reader) the moment the
// running total would exceed `maxBytes`, so we never hold more than one cap
// worth of bytes in memory even for a hostile multi-GB reply.
//
// Returns `null` to mean "the cap was exceeded" (the caller decides how to
// report that, rather than this function silently truncating and letting a
// partial-body parse produce corrupt items). A `null` `response.body` (some
// empty 2xx replies have no stream at all) is treated as zero bytes so the
// existing hash/decode path downstream still runs unchanged.
async function readBoundedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const DEFAULT_UA =
  "Mozilla/5.0 (compatible; Tayf/1.0; +https://tayf.app) ingest-edge";

const DEFAULT_HEADERS: Record<string, string> = {
  Accept:
    "application/rss+xml, application/xml, text/xml, application/atom+xml, */*;q=0.1",
  "Accept-Encoding": "gzip, deflate",
  "User-Agent": DEFAULT_UA,
};

// T24 ships behind a default-UA filter — keep the override from the legacy
// fetcher so the feed still resolves under the Edge Function.
const SOURCE_HEADERS: Record<string, Record<string, string>> = {
  t24: {
    "User-Agent": "Mozilla/5.0 (compatible; Tayf/1.0; +https://tayf.app)",
  },
};

export const XML_PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "",
  // Keep tag content (CDATA + raw text) as strings without auto-coercion;
  // RSS pubDate / title values must round-trip verbatim.
  parseTagValue: false,
  parseAttributeValue: false,
  // Important: media:content is allowed multiple times per item. Force
  // the parser to keep arrays for repeated tags so we don't silently
  // drop one of two thumbnails.
  isArray: (name: string) =>
    name === "item" ||
    name === "entry" ||
    name === "media:content" ||
    name === "media:thumbnail" ||
    name === "enclosure",
  trimValues: true,
  // Entities (h26-security-1). `&amp;` / `&lt;` / `&gt;` / `&quot;` / `&apos;`
  // (and their numeric forms) must still decode here, so entity processing
  // stays ON; HTML entities (`&nbsp;`, `&#305;`, `&ccedil;`...) stay LITERAL
  // for normalize.ts's own decoder, exactly as before. DOCTYPE entities are
  // refused before parsing (see parseFeed) and are, as a second layer, capped
  // by the pinned release: one entity <= 10,000 chars, <= 100 declarations,
  // and at most 100,000 chars of DOCTYPE-entity expansion per document.
  //
  // `maxTotalExpansions` is raised on purpose. With the plain `true` form the
  // library budgets 1,000 built-in references (`&lt;` `&gt;` `&quot;` `&apos;`
  // and `&#39;` `&#60;`...) per DOCUMENT and throws once a feed passes it; a
  // 100-item feed whose descriptions carry entity-escaped HTML (a dozen
  // `&lt;p&gt;` per item) would then turn into a `parse error` and the outlet
  // would go silent. A built-in reference costs one linear replace, so the
  // count needs no cap; the size caps above are the real bound.
  processEntities: {
    enabled: true,
    maxEntitySize: 10_000,
    maxExpansionDepth: 10,
    maxExpandedLength: 100_000,
    maxEntityCount: 100,
    maxTotalExpansions: 10_000_000,
  },
  htmlEntities: false,
};

const xmlParser = new XMLParser(XML_PARSER_OPTIONS);

/**
 * Fetch a single RSS source. On HTTP 304 returns `{ notModified: true, items: [] }`
 * and does not parse XML. On any non-2xx (other than 304) returns
 * `{ items: [], error }`. Throws only on programmer error.
 */
export async function fetchFeed(
  source: RssSource,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const cache = opts.conditionalCache;

  const headers: Record<string, string> = { ...DEFAULT_HEADERS };
  const override = SOURCE_HEADERS[source.slug];
  if (override) Object.assign(headers, override);

  const cached = cache?.get(source.id);
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;

  let response: Response;
  try {
    // SEC-01: route through the same SSRF guard (safeResponse) the
    // og-image path uses, instead of a bare `fetch` with
    // `redirect: "follow"`. `source.rss_url` is admin-configured, not
    // reader-supplied, but it still needs DNS/redirect pinning and
    // private-range blocking -- a compromised admin session or a
    // misconfigured source row is exactly the threat model SEC-01 covers.
    ({ response } = await safeResponse(source.rss_url, {
      headers,
      timeoutMs,
      maxRedirects: FEED_MAX_REDIRECTS,
    }));
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    const message =
      name === "TimeoutError" || name === "AbortError"
        ? `Request timed out after ${timeoutMs}ms`
        : err instanceof SafeFetchError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
    return {
      source,
      items: [],
      status: 0,
      error: message,
    };
  }

  if (response.status === 304) {
    return {
      source,
      items: [],
      status: 304,
      notModified: true,
    };
  }

  if (!response.ok) {
    // The body of a non-2xx response is sized by the remote host, and the
    // runtime inflates a gzip or deflate body (we send Accept-Encoding) as it
    // is read, so a small reply can become a very large buffer. It carries
    // nothing we use, so it is never read: cancel the stream and let the
    // platform release it. Giving up connection reuse costs nothing but this
    // error path.
    try {
      await response.body?.cancel();
    } catch {
      // ignore
    }
    return {
      source,
      items: [],
      status: response.status,
      error: `Status code ${response.status}`,
    };
  }

  const buf = await readBoundedBytes(response, maxBytes);
  if (buf === null) {
    return {
      source,
      items: [],
      status: response.status,
      error: `feed body exceeded ${maxBytes} bytes`,
    };
  }
  const bodyHash = await sha256Hex(buf);

  // Refresh conditional-GET cache only on 2xx with a body.
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  if (cache && (etag || lastModified)) {
    cache.set(source.id, {
      etag: etag ?? undefined,
      lastModified: lastModified ?? undefined,
    });
  }

  // Body-hash short-circuit (migration 041): an outlet that reissues
  // byte-identical XML without changing ETag / Last-Modified still costs a
  // full charset-decode + XML parse every cycle unless we catch it here,
  // BEFORE either of those run — this is the exact population the hash
  // exists for (outlets that ignore validators).
  if (opts.knownBodyHash && opts.knownBodyHash === bodyHash) {
    return {
      source,
      items: [],
      status: response.status,
      notModified: true,
      bodyHash,
      etag,
      lastModified,
    };
  }

  // Parse budget (twin-articles item, part B): the decode, the XML parse and
  // the date cleanup below are the CPU-heavy part of a cycle. The caller can
  // refuse them for this feed; the body is dropped and the feed is simply
  // fetched again on a later cycle. Restore the conditional cache exactly like
  // the NotAFeed branch below: `cache.set(...)` above already stamped this
  // response's etag/lastModified, and keeping them would turn the next poll
  // into a 304 for a body that was never parsed.
  if (opts.admitParse) {
    let admitted = true;
    try {
      admitted = opts.admitParse(buf.byteLength);
    } catch {
      // A throwing budget must not cost the feed: parse as if unbudgeted.
      admitted = true;
    }
    if (!admitted) {
      if (cache) {
        if (cached) cache.set(source.id, cached);
        else cache.delete(source.id);
      }
      return {
        source,
        items: [],
        status: response.status,
        parseDeferred: true,
      };
    }
  }

  const { text: xml, charset } = decodeRssBody(
    buf,
    response.headers.get("content-type"),
  );

  let items: RawFeedItem[] = [];
  try {
    items = parseFeed(xml);
  } catch (err) {
    // A refused 2xx body, whatever the reason: restore the conditional cache to
    // its pre-request value. `cache.set(...)` above already stamped this
    // fetch's (bad body's) etag/lastModified, and persisting THOSE would turn
    // next cycle's re-fetch of the same bad body (or a 304 on its ETag) into a
    // spurious "not modified" success that resets fetch_fail_streak instead of
    // advancing it toward quarantine. For the same reason NO validator or body
    // hash is returned with the error (h27-live-1): ingest keeps the source's
    // previous ones.
    if (cache) {
      if (cached) cache.set(source.id, cached);
      else cache.delete(source.id);
    }
    if (err instanceof NotAFeedError) {
      // ingest-health: an HTML/plain-text/404 body -- recognised from its
      // first bytes, or parsed by fast-xml-parser into SOMETHING with no
      // recognised feed root.
      return {
        source,
        items: [],
        status: response.status,
        error: `not a feed: ${err.message}`,
        notAFeed: true,
      };
    }
    return {
      source,
      items: [],
      status: response.status,
      charset,
      error: err instanceof Error ? `parse error: ${err.message}` : "parse error",
    };
  }

  // ingest-health: clean each item's date fields BEFORE they reach
  // normalize.ts's parseDate -- see dates.ts's file header for why (encoded
  // offset signs, a literal-Z-then-numeric-offset shape, extra internal
  // whitespace). `dateFallbacks`/`dateFallbackSample` are computed off the
  // RAW (pre-clean) value so operators see the actual bad string, not the
  // cleaned-but-still-unparseable one.
  let dateFallbacks = 0;
  let dateFallbackSample: string | undefined;
  items = items.map((item) => {
    const cleanedIsoDate = cleanFeedDate(item.isoDate, source.slug);
    const cleanedPubDate = cleanFeedDate(item.pubDate, source.slug);
    const effective = cleanedIsoDate ?? cleanedPubDate;
    const ok = effective !== undefined && isParseableFeedDate(effective, source.slug);
    if (!ok) {
      dateFallbacks++;
      if (dateFallbackSample === undefined) {
        const raw = item.isoDate ?? item.pubDate;
        if (raw !== undefined && raw.trim() !== "") {
          dateFallbackSample = raw.slice(0, 80);
        }
      }
    }
    return { ...item, pubDate: cleanedPubDate, isoDate: cleanedIsoDate };
  });

  return {
    source,
    items,
    status: response.status,
    charset,
    etag,
    lastModified,
    bodyHash,
    dateFallbacks,
    dateFallbackSample,
  };
}

// ---------------------------------------------------------------------------
// XML → RawFeedItem mapping
// ---------------------------------------------------------------------------

type XmlNode = Record<string, unknown>;

// ingest-health: thrown by `parseFeed` when the parsed object has none of
// the recognised feed roots (`rss`, `feed`, `rdf:RDF`, `RDF`) -- an HTML
// error page, a plain-text 404 body, or an empty response masquerading as
// a 2xx feed. `message` is the first top-level key fast-xml-parser produced
// (e.g. `"html"`), or `"empty"` when the parsed object has no keys at all.
export class NotAFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAFeedError";
  }
}

// How much of a body the HTML sniff reads. A page's `<html>` / doctype comes
// within the first few hundred bytes; anything later is left to the parser.
const HTML_SNIFF_CHARS = 1024;

function isXmlSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * Throws `NotAFeedError("html")` for a body that is an HTML page, judged from
 * its first 1,024 characters: after a BOM, whitespace, one `<?xml ... ?>`
 * declaration and any closed `<!-- -->` comments, the body starts with
 * `<!doctype html` or `<html` (any case) followed by whitespace, `>` or `/`.
 *
 * Why before the parser: fast-xml-parser 4.5.7 throws "Maximum nested tags
 * exceeded" on a real HTML page (nested deeper than 100 tags), which used to
 * surface as a 2xx `parse error` instead of `not a feed: html` (h27-live-1).
 * Recognising the page here also saves parsing up to 8 MB of markup. A feed
 * that merely CONTAINS `<html>` (CDATA, a comment) never starts with it.
 */
function sniffHtml(xml: string): void {
  const limit = Math.min(xml.length, HTML_SNIFF_CHARS);
  let i = 0;
  const skipSpace = () => {
    while (i < limit && (xml[i] === "\uFEFF" || isXmlSpace(xml[i]))) i++;
  };
  skipSpace();
  if (xml.startsWith("<?xml", i) && isXmlSpace(xml[i + 5])) {
    const end = xml.indexOf("?>", i);
    if (end === -1 || end + 2 > limit) return;
    i = end + 2;
    skipSpace();
  }
  while (xml.startsWith("<!--", i)) {
    const end = xml.indexOf("-->", i + 4);
    if (end === -1 || end + 3 > limit) return;
    i = end + 3;
    skipSpace();
  }
  if (i >= limit) return;
  const head = xml.slice(i, i + 16).toLowerCase();
  for (const opener of ["<!doctype html", "<html"]) {
    if (!head.startsWith(opener)) continue;
    const next = xml[i + opener.length];
    if (next === undefined || next === ">" || next === "/" || isXmlSpace(next)) {
      throw new NotAFeedError("html");
    }
  }
}

/** True when `xml` has a `<!ENTITY` declaration anywhere from `from` on, skipping nothing. */
function hasEntityToken(xml: string, from: number): boolean {
  for (let p = xml.indexOf("<!", from); p !== -1; p = xml.indexOf("<!", p + 2)) {
    if (xml.slice(p + 2, p + 8).toLowerCase() === "entity") return true;
  }
  return false;
}

/**
 * Index of the character that closes the tag read from `from`, honouring quotes
 * exactly like fast-xml-parser's own tag reader (so a `>` or a `<![CDATA[` inside
 * an attribute value does not end it); -1 when it never closes. `close` is ">"
 * or "?>" (the index of its last character is returned).
 */
function tagEnd(xml: string, from: number, close: ">" | "?>"): number {
  let quote = "";
  for (let k = from; k < xml.length; k++) {
    const ch = xml[k] as string;
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === close[0] && (close.length === 1 || xml[k + 1] === close[1])) {
      return k + close.length - 1;
    }
  }
  return -1;
}

/**
 * True when `xml` carries a `<!ENTITY` declaration the parser could act on:
 * one linear scan that walks the markup the way fast-xml-parser's main loop
 * does and returns true on `<!ENTITY` (any case) anywhere it does not skip.
 *
 * Skipped, because the parser skips them too: a CLOSED `<![CDATA[...]]>`
 * section and a CLOSED `<!--...-->` comment (an item that QUOTES an entity
 * declaration in its CDATA is not a hostile feed: h27-live-1), the closing tag
 * `</...>`, and any tag or processing instruction, read quote-aware, so an
 * opener written inside an attribute value cannot swallow a real DOCTYPE
 * behind it. An unterminated opener is not skipped (the parser throws on those
 * anyway; the body stays refused, as it was). A DOCTYPE with an internal
 * subset (`[`), or any `<` in its head before the first `>`, switches to a
 * plain search of everything after it: the parser's DOCTYPE reader has its own
 * rules for quotes and comments, so nothing there is trusted to be inert. The
 * parser's entity limits (10,000 chars each, 100 declarations, 100,000 chars
 * expanded) stay as a second layer.
 *
 * Linear: every skip moves forward, a closer that was not found once is not
 * searched for again (a later opener cannot find one either), and the DOCTYPE
 * look-ahead stops at the first `>`, which the scan then moves past (a
 * `<!D>` x 500,000 body takes milliseconds, not seconds).
 */
export function hasDeclaredEntity(xml: string): boolean {
  const n = xml.length;
  let noCommentEnd = false;
  let noCdataEnd = false;
  let noClosingGt = false;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt === -1 || lt + 1 >= n) return false;
    const c = xml[lt + 1];

    if (c === "!") {
      if (xml.startsWith("--", lt + 2)) {
        // Comment: the parser looks for "-->" from lt + 4.
        if (!noCommentEnd) {
          const end = xml.indexOf("-->", lt + 4);
          if (end !== -1) {
            i = end + 3;
            continue;
          }
          noCommentEnd = true;
        }
        i = lt + 4;
        continue;
      }
      if (xml[lt + 2] === "[") {
        // CDATA (the parser reads any `<![` this way): up to the next "]]>".
        if (!noCdataEnd) {
          const end = xml.indexOf("]]>", lt);
          if (end !== -1) {
            i = end + 3;
            continue;
          }
          noCdataEnd = true;
        }
        i = lt + 3;
        continue;
      }
      if (xml.slice(lt + 2, lt + 8).toLowerCase() === "entity") return true;
      const kind = xml[lt + 2];
      if (kind === "D" || kind === "d") {
        // DOCTYPE. The parser's reader counts `<` and `>` itself (and ends a
        // comment at any `>` after `--`, so `<!-->` is a whole comment there):
        // only when NO `[` or `<` precedes the first `>` is it certain that the
        // reader stops at that `>` with nothing declared. Anything else is a
        // head this scan cannot follow, so it falls back to a plain search of
        // the rest of the body. The look-ahead never passes that `>`, and a
        // skip lands after it, so the scan stays linear.
        const close = xml.indexOf(">", lt + 3);
        if (close === -1) return hasEntityToken(xml, lt);
        for (let k = lt + 3; k < close; k++) {
          if (xml[k] === "[" || xml[k] === "<") return hasEntityToken(xml, lt);
        }
        // The parser only reads `<!D` (upper case) as a DOCTYPE; `<!d` is an
        // ordinary tag to it, closed quote-aware, so it is read that way below.
        if (kind === "D") {
          i = close + 1;
          continue;
        }
      }
      // Any other `<!X ...>` is an ordinary tag to the parser: read it below.
    } else if (c === "/") {
      if (!noClosingGt) {
        const end = xml.indexOf(">", lt + 2);
        if (end !== -1) {
          i = end + 1;
          continue;
        }
        noClosingGt = true;
      }
      i = lt + 2;
      continue;
    }

    // Opening tag, `<!X` declaration or processing instruction.
    const end = tagEnd(xml, lt + 1, c === "?" ? "?>" : ">");
    if (end === -1) return hasEntityToken(xml, lt + 1);
    i = end + 1;
  }
  return false;
}

/**
 * Parse one feed body into raw items. Throws `NotAFeedError` for a body with no
 * recognised feed root and any other Error for a body the parser (or the
 * hostile-input guard below) refuses; `fetchFeed` turns the latter into the
 * per-feed `parse error`, so one bad feed is skipped and the cycle survives.
 */
export function parseFeed(xml: string): RawFeedItem[] {
  sniffHtml(xml);
  // h26-security-1: an entity can only be declared in a DOCTYPE internal
  // subset, and a feed has no use for one: no captured feed fixture declares
  // any, and the entity references real feeds use (`&amp;`, `&#305;`...) are
  // predefined or numeric, never declared. A declared entity is the entity-bomb
  // lever (one 200 KB entity x 2,000 references = a 400 MB title), so refuse
  // the whole body before the parser reads it. One linear scan; the throw
  // becomes the existing `parse error` of this one feed. The scan reads
  // markup, not text (h27-live-1): a `<!ENTITY` that an item QUOTES inside a
  // CDATA section or a comment is not a declaration, and used to silence the
  // whole feed.
  if (hasDeclaredEntity(xml)) {
    throw new Error("DOCTYPE entity declarations are not accepted");
  }
  const parsed = xmlParser.parse(xml) as XmlNode;

  // RSS 2.0: rss > channel > item[]
  if (parsed.rss !== undefined) {
    const rssChannel = (parsed.rss as XmlNode | undefined)?.channel;
    const rssItems = (rssChannel as XmlNode | undefined)?.item;
    return Array.isArray(rssItems) ? (rssItems as XmlNode[]).map(mapRssItem) : [];
  }

  // Atom: feed > entry[]
  if (parsed.feed !== undefined) {
    const feed = parsed.feed as XmlNode;
    const atomEntries = feed.entry;
    return Array.isArray(atomEntries)
      ? (atomEntries as XmlNode[]).map(mapAtomEntry)
      : [];
  }

  // RDF / RSS 1.0: rdf:RDF > item[]
  if (parsed["rdf:RDF"] !== undefined || parsed.RDF !== undefined) {
    const rdf = (parsed["rdf:RDF"] as XmlNode | undefined) ?? (parsed.RDF as XmlNode);
    const rdfItems = rdf.item;
    return Array.isArray(rdfItems) ? (rdfItems as XmlNode[]).map(mapRssItem) : [];
  }

  // No recognised feed root at all -- an HTML/plain-text/other body.
  const firstKey = Object.keys(parsed)[0];
  throw new NotAFeedError(firstKey ?? "empty");
}

function asString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && "#text" in (v as XmlNode)) {
    const t = (v as XmlNode)["#text"];
    return typeof t === "string" ? t : undefined;
  }
  return undefined;
}

function firstUrl(node: unknown): string | undefined {
  if (!node) return undefined;
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    for (const n of node) {
      const u = firstUrl(n);
      if (u) return u;
    }
    return undefined;
  }
  if (typeof node === "object") {
    const obj = node as XmlNode;
    if (typeof obj.url === "string") return obj.url;
    if (typeof obj.href === "string") return obj.href;
  }
  return undefined;
}

function mapRssItem(node: XmlNode): RawFeedItem {
  const item: RawFeedItem = {
    title: asString(node.title),
    // ingest-health: Milliyet omits <link> entirely, relying on
    // <atom:link href=.../> plus a non-permalink <guid> -- pickItemLink
    // falls through both before giving up.
    link: pickItemLink(node),
    content: asString(node.description),
    contentSnippet: asString(node.description),
    contentEncoded: asString(node["content:encoded"]),
    pubDate: asString(node.pubDate),
    isoDate: asString(node["dc:date"]),
  };

  // Enclosure: single or array → take the first image-typed one if possible.
  const enclosures = node.enclosure;
  const enclosureNode = Array.isArray(enclosures)
    ? (enclosures.find((e) => {
        const t = (e as XmlNode)?.type;
        return typeof t === "string" && t.startsWith("image/");
      }) as XmlNode | undefined) ??
      (enclosures[0] as XmlNode | undefined)
    : (enclosures as XmlNode | undefined);
  if (enclosureNode) {
    item.enclosure = {
      url: typeof enclosureNode.url === "string" ? enclosureNode.url : undefined,
      type:
        typeof enclosureNode.type === "string" ? enclosureNode.type : undefined,
    };
  }

  // media:content and media:thumbnail can be single or array; flatten to one.
  const mc = node["media:content"];
  const mcUrl = firstUrl(mc);
  if (mcUrl) item.mediaContent = { $: { url: mcUrl } };

  const mt = node["media:thumbnail"];
  const mtUrl = firstUrl(mt);
  if (mtUrl) item.mediaThumbnail = { $: { url: mtUrl } };

  const mg = node["media:group"] as XmlNode | undefined;
  if (mg) {
    const grpContentUrl = firstUrl(mg["media:content"]);
    const grpThumbUrl = firstUrl(mg["media:thumbnail"]);
    item.mediaGroup = {
      ...(grpContentUrl
        ? { "media:content": { $: { url: grpContentUrl } } }
        : {}),
      ...(grpThumbUrl
        ? { "media:thumbnail": { $: { url: grpThumbUrl } } }
        : {}),
    };
  }

  // Non-standard <image>URL</image> inside <item> (CNN Türk).
  const ii = node.image;
  if (typeof ii === "string") {
    item.itemImage = ii;
  } else if (ii && typeof ii === "object") {
    const u = asString((ii as XmlNode).url);
    if (u) item.itemImage = u;
  }

  return item;
}

function mapAtomEntry(node: XmlNode): RawFeedItem {
  // Atom links can be `<link href="..." rel="alternate"/>` (object) or
  // multiple `<link>` elements. Pick the first `rel="alternate"` or the
  // first link with an href.
  let link: string | undefined;
  const lnk = node.link;
  if (Array.isArray(lnk)) {
    const alt = (lnk as XmlNode[]).find(
      (l) => l && (l.rel === "alternate" || l.rel === undefined),
    );
    link = asString(alt?.href) ?? firstUrl(lnk);
  } else if (typeof lnk === "object" && lnk) {
    link = asString((lnk as XmlNode).href);
  } else {
    link = asString(lnk);
  }

  const summary = asString(node.summary);
  const content = asString(node.content);

  return {
    title: asString(node.title),
    link,
    content: summary ?? content,
    contentSnippet: summary ?? content,
    contentEncoded: content,
    pubDate: asString(node.published) ?? asString(node.updated),
    isoDate: asString(node.updated),
  };
}
