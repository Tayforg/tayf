// Pure, client-safe helpers for the live /embed/cluster/[id] widget and the
// /api/oembed endpoint. No server imports: the "Gömme kodu" chip
// (share-button.tsx, a client component) and both route handlers share this
// file, so the URL allowlist, the size envelope and the snippet markup cannot
// drift between them.

/** Hosts whose /cluster/<uuid> URLs we will answer for. Exact match only. */
export const EMBED_ALLOWED_HOSTS: readonly string[] = ["tayfhaber.com", "www.tayfhaber.com"];

export const EMBED_DEFAULT_WIDTH = 560;
export const EMBED_DEFAULT_HEIGHT = 200;
export const EMBED_MIN_WIDTH = 120;
export const EMBED_MAX_WIDTH = 560;
export const EMBED_MIN_HEIGHT = 120;
export const EMBED_MAX_HEIGHT = 240;

/** Longest `url=` we will even try to parse. */
const MAX_URL_LENGTH = 2048;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLUSTER_PATH_RE = /^\/cluster\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

const IFRAME_TITLE = "Tayf yelpazesi: bu haberi hangi medya bölgeleri yazdı";

/**
 * Extracts the cluster id from a Tayf cluster URL, or null.
 *
 * This is a PARSER, never a fetcher: the caller (oEmbed) only ever uses the
 * returned uuid, and the given URL is never requested, so a hostile `url=`
 * cannot steer a server-side request. Rejects unless ALL hold: <= 2048 chars,
 * parses as a URL, https, no userinfo, no explicit port, host is allowlisted
 * (or equals `extraHost`, which the caller passes only when its own site URL
 * is https), and the path is exactly /cluster/<uuid> with an optional single
 * trailing slash. Query and hash are ignored. The id is returned lower-cased.
 */
export function parseClusterUrl(raw: string, extraHost?: string | null): string | null {
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null;
  const host = url.hostname.toLowerCase();
  const extra = extraHost ? extraHost.toLowerCase() : null;
  if (!EMBED_ALLOWED_HOSTS.includes(host) && host !== extra) return null;
  const match = CLUSTER_PATH_RE.exec(url.pathname);
  if (!match) return null;
  return match[1]!.toLowerCase();
}

/**
 * oEmbed `maxwidth` / `maxheight` -> a size inside [min, max]. Only 1-5 plain
 * ASCII digits count; anything else (negative, decimal, exponent, padded,
 * empty, null) yields `def`.
 */
export function clampEmbedSize(raw: string | null, def: number, min: number, max: number): number {
  if (raw === null || !/^\d{1,5}$/.test(raw)) return def;
  const n = Number(raw);
  return Math.min(max, Math.max(min, n));
}

/** Escapes the five characters that matter in HTML text and attribute values. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The copy-paste <iframe> for a cluster's live spectrum box, or null when the
 * id is not a uuid. `sandbox` deliberately omits allow-scripts and
 * allow-same-origin (the framed document has no script and needs neither);
 * it keeps popups so the "tayfhaber.com'da oku" link can open a tab, and
 * `allow-popups-to-escape-sandbox` so that tab is a normal, unsandboxed page.
 */
export function buildIframeSnippet(
  origin: string,
  clusterId: string,
  width: number = EMBED_DEFAULT_WIDTH,
  height: number = EMBED_DEFAULT_HEIGHT,
): string | null {
  if (!UUID_RE.test(clusterId)) return null;
  const src = escapeHtml(`${origin}/embed/cluster/${clusterId}`);
  return (
    `<iframe src="${src}" width="${escapeHtml(String(width))}" height="${escapeHtml(String(height))}"` +
    ` title="${escapeHtml(IFRAME_TITLE)}" loading="lazy" style="border:0;max-width:100%"` +
    ` sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe>`
  );
}

/** href for a `<link rel="alternate" type="application/json+oembed">` discovery tag. */
export function oembedDiscoveryHref(origin: string, clusterId: string): string {
  return `${origin}/api/oembed?url=${encodeURIComponent(`${origin}/cluster/${clusterId}`)}&format=json`;
}
