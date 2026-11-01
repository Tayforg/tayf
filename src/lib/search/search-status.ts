import { formatCountTr } from "@/lib/format/number-tr";

// Reader-facing sentences for the home search (h10-a11y-2): the text of the
// always-mounted sr-only live region on "/" and the <title> of "/?q=".
//
// Pure and string-only on purpose. The callers hand the result to React as a
// text child (escaped) and to Next as a metadata title (escaped), so a query
// like `<script>` comes back verbatim here and is never turned into markup.

/** Longest query, in code points, quoted in an announcement or a title. */
export const SEARCH_QUERY_DISPLAY_MAX = 60;

/**
 * The query as it is shown back to the reader: trimmed, runs of whitespace
 * collapsed to one space, and capped at SEARCH_QUERY_DISPLAY_MAX code points
 * (59 characters plus "…" when longer). Truncation walks code points, so an
 * emoji at the boundary is never cut into a lone surrogate.
 */
export function displayQuery(q: string | undefined): string {
  const clean = (q ?? "").trim().replace(/\s+/g, " ");
  const points = Array.from(clean);
  if (points.length <= SEARCH_QUERY_DISPLAY_MAX) return clean;
  return `${points.slice(0, SEARCH_QUERY_DISPLAY_MAX - 1).join("")}…`;
}

export interface SearchStatusArgs {
  q: string | undefined;
  /** Results for the whole search, all pages: in-feed matches plus archive-only rows. */
  count: number;
  /** The archive search filled its page, so more matches may exist. */
  capped: boolean;
  /** The archive search failed or timed out. */
  unavailable: boolean;
}

/**
 * The sentence announced after a search, or "" when there is no search (a
 * blank q has nothing to announce, and an empty live region says nothing).
 * `unavailable` wins over `capped`: a failed archive search is never "capped".
 */
export function searchStatusText({
  q,
  count,
  capped,
  unavailable,
}: SearchStatusArgs): string {
  const shown = displayQuery(q);
  if (!shown) return "";

  const results = Number.isFinite(count) && count > 0 ? count : 0;
  if (unavailable) {
    return results === 0
      ? "Arama şu an yanıt vermiyor."
      : `“${shown}” için ${formatCountTr(results)} sonuç bulundu; arşiv araması şu an yanıt vermiyor.`;
  }
  if (results === 0) return `“${shown}” için sonuç bulunamadı.`;
  if (capped) {
    return `“${shown}” için en ilgili ${formatCountTr(results)} sonuç gösteriliyor.`;
  }
  return `“${shown}” için ${formatCountTr(results)} sonuç bulundu.`;
}

/**
 * Page title for "/?q=…". The root layout's title template appends " — Tayf".
 * A blank query falls back to "Arama" rather than an empty pair of quotes.
 */
export function searchTitle(q: string | undefined): string {
  const shown = displayQuery(q);
  return shown ? `“${shown}” araması` : "Arama";
}
