// Pure parsing of the /karsilastir query string. Raw user input is reduced to
// one of four tagged kinds here and never travels further: later layers (data
// fetch, hrefs, rendering) only ever see a validated, lowercased UUID.

/** Same shape as cluster-detail-query's UUID_RE, applied after lowercasing. */
export const COMPARE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A UUID is 36 chars; anything past this is rejected before the regex runs. */
const MAX_RAW_LENGTH = 64;

export type ParsedSide =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "duplicate" }
  | { kind: "id"; id: string };

export interface ParsedCompareParams {
  a: ParsedSide;
  b: ParsedSide;
}

/**
 * Trim + lowercase + validate. Returns the canonical id, or null for anything
 * that is not a UUID (non-strings, empty, over-long, wrong shape). Shared by
 * the tray so an uppercase route param still resolves.
 */
export function normalizeCompareId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_RAW_LENGTH) return null;
  const lower = trimmed.toLowerCase();
  return COMPARE_UUID_RE.test(lower) ? lower : null;
}

export function parseSide(raw: string | string[] | undefined): ParsedSide {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") return { kind: "missing" };
  const trimmed = first.trim();
  if (trimmed.length === 0) return { kind: "missing" };
  if (trimmed.length > MAX_RAW_LENGTH) return { kind: "invalid" };
  const lower = trimmed.toLowerCase();
  return COMPARE_UUID_RE.test(lower)
    ? { kind: "id", id: lower }
    : { kind: "invalid" };
}

export function parseCompareParams(sp: {
  a?: string | string[];
  b?: string | string[];
}): ParsedCompareParams {
  const a = parseSide(sp.a);
  let b = parseSide(sp.b);
  if (a.kind === "id" && b.kind === "id" && a.id === b.id) {
    b = { kind: "duplicate" };
  }
  return { a, b };
}

/**
 * `/karsilastir?a=..&b=..`, keeping only ids that validate. `/karsilastir`
 * when neither does. Invalid input is dropped, never echoed.
 */
export function compareHref(a?: string | null, b?: string | null): string {
  const params = new URLSearchParams();
  const idA = normalizeCompareId(a);
  const idB = normalizeCompareId(b);
  if (idA) params.set("a", idA);
  if (idB) params.set("b", idB);
  const qs = params.toString();
  return qs ? `/karsilastir?${qs}` : "/karsilastir";
}
