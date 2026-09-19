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
   * ISO timestamp for `dateModified`. The caller supplies "now" (or a
   * DB-derived last-modified) rather than this function reading the clock
   * itself, so it stays a pure function that's trivial to test.
   */
  dateModified: string;
}

/**
 * Dataset JSON-LD describing Tayf's public source registry (S-17):
 * name, description, licence (CC BY-SA 4.0, matching /metodoloji's stated
 * licence), the machine-readable distribution (`/api/sources`), and
 * `dateModified`. Rendered on /sources.
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
    dateModified: options.dateModified,
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
