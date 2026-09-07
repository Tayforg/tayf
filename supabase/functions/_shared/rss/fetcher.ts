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

import { XMLParser } from "https://esm.sh/fast-xml-parser@4.5.0";
import { decodeRssBody } from "./charset.ts";

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
  /** SHA-256 hex digest of the raw (pre-decode) response body on a 2xx. */
  bodyHash?: string;
  error?: string;
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
}

const DEFAULT_TIMEOUT_MS = 10_000;

// Hashing the raw bytes (not the decoded text) is both cheaper and much
// smaller to carry on `FetchResult` than the body itself (migration 041) --
// the caller only needs to know "did this change since last time", not the
// content.
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Cast needed: TS's lib.dom BufferSource type wants an
  // ArrayBufferView<ArrayBuffer> specifically, but `bytes` here is typed as
  // Uint8Array<ArrayBufferLike> (it may be backed by a SharedArrayBuffer in
  // principle) even though in practice it never is — it's always the sole
  // Uint8Array wrapping a fresh `response.arrayBuffer()` result.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  // Keep tag content (CDATA + raw text) as strings without auto-coercion;
  // RSS pubDate / title values must round-trip verbatim.
  parseTagValue: false,
  parseAttributeValue: false,
  // Important: media:content is allowed multiple times per item. Force
  // the parser to keep arrays for repeated tags so we don't silently
  // drop one of two thumbnails.
  isArray: (name) =>
    name === "item" ||
    name === "entry" ||
    name === "media:content" ||
    name === "media:thumbnail" ||
    name === "enclosure",
  trimValues: true,
});

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
  const cache = opts.conditionalCache;

  const headers: Record<string, string> = { ...DEFAULT_HEADERS };
  const override = SOURCE_HEADERS[source.slug];
  if (override) Object.assign(headers, override);

  const cached = cache?.get(source.id);
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;

  let response: Response;
  try {
    response = await fetch(source.rss_url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    const message =
      name === "TimeoutError" || name === "AbortError"
        ? `Request timed out after ${timeoutMs}ms`
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
    // Drain the body so the underlying connection can be reused.
    try {
      await response.arrayBuffer();
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

  const buf = new Uint8Array(await response.arrayBuffer());
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

  const { text: xml, charset } = decodeRssBody(
    buf,
    response.headers.get("content-type"),
  );

  let items: RawFeedItem[] = [];
  try {
    items = parseFeed(xml);
  } catch (err) {
    return {
      source,
      items: [],
      status: response.status,
      charset,
      etag,
      lastModified,
      bodyHash,
      error: err instanceof Error ? `parse error: ${err.message}` : "parse error",
    };
  }

  return {
    source,
    items,
    status: response.status,
    charset,
    etag,
    lastModified,
    bodyHash,
  };
}

// ---------------------------------------------------------------------------
// XML → RawFeedItem mapping
// ---------------------------------------------------------------------------

type XmlNode = Record<string, unknown>;

function parseFeed(xml: string): RawFeedItem[] {
  const parsed = xmlParser.parse(xml) as XmlNode;
  // RSS 2.0: rss > channel > item[]
  const rssChannel = (parsed.rss as XmlNode | undefined)?.channel;
  const rssItems = (rssChannel as XmlNode | undefined)?.item;
  if (Array.isArray(rssItems)) {
    return (rssItems as XmlNode[]).map(mapRssItem);
  }

  // Atom: feed > entry[]
  const feed = parsed.feed as XmlNode | undefined;
  const atomEntries = feed?.entry;
  if (Array.isArray(atomEntries)) {
    return (atomEntries as XmlNode[]).map(mapAtomEntry);
  }

  // RDF / RSS 1.0: rdf:RDF > item[]
  const rdf =
    (parsed["rdf:RDF"] as XmlNode | undefined) ??
    (parsed.RDF as XmlNode | undefined);
  const rdfItems = rdf?.item;
  if (Array.isArray(rdfItems)) {
    return (rdfItems as XmlNode[]).map(mapRssItem);
  }

  return [];
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
    link: asString(node.link),
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
