// Pure navigation-target computation for SearchBar's debounced effect. Kept
// side-effect-free so a mount with an already-matching `q` (or a
// whitespace-only edit) can short-circuit to `null` and never call
// router.replace, instead of navigating on every render.

export function searchNavTarget({
  value,
  pathname,
  search,
}: {
  value: string;
  pathname: string;
  search: string;
}): string | null {
  const q = value.trim();
  const params = new URLSearchParams(search);
  const current = (params.get("q") ?? "").trim();
  if (q === current) return null;
  if (q) {
    params.set("q", q);
  } else {
    params.delete("q");
  }
  params.delete("page");
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * SearchBar keeps its own text in state, so a URL change it did not cause
 * (the header logo, "Haberler", "Aramayı temizle", g h, Back/forward) has to be
 * copied into that state or the debounced effect writes the stale text back
 * into the URL. `lastWritten` is the query the bar last wrote or adopted.
 * Returns the URL's query when it differs from `lastWritten` (ignoring
 * surrounding whitespace, as searchNavTarget does), so the bar should show it;
 * null when the URL just reflects what the bar already has.
 */
export function externalQueryChange({
  urlQ,
  lastWritten,
}: {
  urlQ: string;
  lastWritten: string;
}): string | null {
  return urlQ.trim() !== lastWritten.trim() ? urlQ : null;
}
