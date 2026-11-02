import { siteUrl } from "@/lib/site-url";

// The return value of `serializeJsonLd` is embedded via
// `dangerouslySetInnerHTML` inside a `<script type="application/ld+json">`
// element. A raw "<" (e.g. from a "</script" substring hiding inside a
// `title_tr` or an LLM-generated `summary_tr`) would terminate the script
// element early — the browser stops parsing JSON-LD at that point and
// whatever text follows is parsed as ordinary HTML. To make that
// impossible, every "<" in the JSON output is emitted as the JSON escape
// `\u003c`, which `JSON.parse` restores losslessly (it's just another way
// to spell the same character inside a JSON string).
//
// Note: ">" and "&" need no escaping here — this is not an HTML text
// node being escaped for a browser's HTML parser, it's a JSON document
// inside a `<script>` element, and only a literal "</script" (case-
// insensitive) can close that element early. U+2028/U+2029 (the
// characters that break unescaped JSON embedded directly in a `<script>`
// as *JavaScript*, e.g. `var x = ...`) are likewise irrelevant here
// because this is not being parsed as JS source — it's `application/ld
// +json`, parsed as JSON text. Both omissions are deliberate, not an
// oversight.
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// ---------------------------------------------------------------------------
// S-17 structured data (pack G3) — schema.org Dataset for /sources and
// BreadcrumbList for /source/[slug]. Both are plain builder functions (no
// JSX, no fetch) so they're trivial to unit-test; the calling page embeds
// the result via `serializeJsonLd` in a `<script type="application/ld+json">`
// exactly like cluster/[id]/page.tsx's existing NewsArticle block.
// ---------------------------------------------------------------------------

export interface RegistryDatasetOptions {
  /**
   * ISO timestamp of the registry's last change, derived by the caller from
   * the database (see registryModifiedAt in src/app/sources/page.tsx). It is
   * never "now": a cache-fill instant tells a crawler nothing about when the
   * registry changed, and moves on every revalidation. Null or omitted when
   * the change time is unknown, in which case `dateModified` is left out of
   * the Dataset entirely rather than guessed. This function never reads the
   * clock, so it stays pure and trivial to test.
   */
  dateModified?: string | null;
}

/**
 * Dataset JSON-LD describing Tayf's public source registry (S-17):
 * name, description, licence (CC BY-SA 4.0, matching /metodoloji's stated
 * licence), the machine-readable distribution (`/api/sources`), and, when
 * known, `dateModified` (the registry's last change time). Rendered on
 * /sources.
 */
export function buildRegistryDataset(options: RegistryDatasetOptions) {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Tayf Kaynak Kaydı",
    description:
      "Tayf'ın izlediği Türk haber kaynaklarının kaydı — yanlılık kategorisi, tür (outlet/aggregator/wire/niche), hak bayrakları ve kayyum durumu dahil.",
    license: "https://creativecommons.org/licenses/by-sa/4.0/",
    distribution: {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${siteUrl()}/api/sources`,
    },
    ...(options.dateModified ? { dateModified: options.dateModified } : {}),
  };
}

// ---------------------------------------------------------------------------
// seo-4/seo-5/seo-7 — sitewide Organization + WebSite graph (layout.tsx) and
// the Organization node reused as NewsArticle.publisher on /cluster/[id].
// `/apple-icon` is the file-convention route (src/app/apple-icon.tsx,
// 180x180 PNG) — a real, stable logo URL instead of the old bare `{ name }`.
// ---------------------------------------------------------------------------

/** File-convention route serving the 180x180 PNG app icon (apple-icon.tsx). */
export const TAYF_LOGO_PATH = "/apple-icon";

/** Pure. The sitewide Tayf Organization node, reused as publisher/author. */
export function buildTayfOrganization() {
  const url = siteUrl();
  return {
    "@type": "Organization",
    "@id": `${url}/#organization`,
    name: "Tayf",
    url,
    logo: {
      "@type": "ImageObject",
      url: `${url}${TAYF_LOGO_PATH}`,
      width: 180,
      height: 180,
    },
  };
}

/** Pure. Sitewide Organization + WebSite graph, rendered once in layout.tsx. */
export function buildSiteJsonLd() {
  const url = siteUrl();
  const organization = buildTayfOrganization();
  return {
    "@context": "https://schema.org",
    "@graph": [
      organization,
      {
        "@type": "WebSite",
        "@id": `${url}/#website`,
        name: "Tayf",
        url,
        inLanguage: "tr-TR",
        publisher: { "@id": organization["@id"] },
      },
    ],
  };
}

export interface BreadcrumbItem {
  /** Visible crumb label. */
  name: string;
  /** Site-relative path (e.g. "/", "/sources", "/source/sabah") — resolved
   *  to an absolute URL via `siteUrl()` since schema.org `item` must be
   *  absolute. */
  path: string;
}

/**
 * BreadcrumbList JSON-LD (S-17). `items` is given in display order (root
 * first); each entry's `position` is 1-based. Rendered on /source/[slug].
 */
export function buildBreadcrumbs(items: BreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${siteUrl()}${item.path}`,
    })),
  };
}

export interface CollectionItem {
  /** Visible item name (a cluster title or an entity label). */
  name: string;
  /** Site-relative path (e.g. "/cluster/<id>", "/gundem/<key>") -- resolved
   *  to an absolute URL via `siteUrl()`. */
  path: string;
}

/**
 * Pure. schema.org CollectionPage whose mainEntity is an ItemList of absolute
 * URLs. Generic and path-based: the /gundem/[key] hubs list clusters, the
 * /gundem index lists the hubs themselves. (/konu/[slug] has its own
 * bundle-based twin in topic-query.ts.) The caller embeds the result via
 * `serializeJsonLd`, which escapes a "</script" hiding in a name.
 */
export function buildClusterCollectionPage(args: {
  name: string;
  path: string;
  items: readonly CollectionItem[];
}): Record<string, unknown> {
  const { name, path, items } = args;
  const base = siteUrl();

  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name,
    url: `${base}${path}`,
    isPartOf: {
      "@type": "WebSite",
      name: "Tayf",
      url: base,
    },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: items.length,
      itemListElement: items.map((item, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: item.name,
        url: `${base}${item.path}`,
      })),
    },
  };
}
