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
