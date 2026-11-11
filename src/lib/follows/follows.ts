// "Takip ettiklerim" -- client-side follows of a keyword, a /konu slug or a
// /gundem entity hub.
//
// Pure module: NO React, NO next/*, NO server imports (the two allowed imports,
// @/lib/time and the hub vocabulary @/lib/trends/rising-entities, are plain
// data / helpers with no imports of their own). It is bundled to the client
// (use-follows.ts, follow-button.tsx, follow-feed.tsx) and unit-tested in the
// node environment. Follows live in localStorage only (key below); the server
// never sees them, it just answers GET /api/takip for one follow at a time.
// Every function here treats stored data as untrusted: localStorage can hold
// anything (an older build's shape, another script's write, hand edits).

import { formatTurkishTimeAgo } from "@/lib/time";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";

export const FOLLOWS_KEY = "tayf:follows";
export const FOLLOWS_CHANGE_EVENT = "tayf:follows-change";
export const MAX_FOLLOWS = 20;
export const KEYWORD_MIN = 2;
/**
 * Equal to MAX_SEARCH_QUERY_LENGTH in src/lib/clusters/turkish-query.ts: /?q=
 * and GET /api/takip (searchClusters) both cut a search at 64 characters, so a
 * follow of that length runs exactly the search the reader sees. This module
 * may not import turkish-query (client-bundle whitelist above); follows.test.ts
 * holds the parity test. Follows stored at 40 characters or fewer stay valid.
 */
export const KEYWORD_MAX = 64;
/** Hard cap on the RAW input, applied before any normalisation work. */
export const RAW_MAX = 200;
/** The API returns (and the client trusts) at most this many items per follow. */
export const FOLLOW_ITEMS_MAX = 10;
/** A follow remembers at most this many story ids of its last visit (the API caps a list at 10). */
export const SEEN_IDS_MAX = 40;

// The two strings of SEARCH_FOLD_FROM / SEARCH_FOLD_TO in
// src/lib/clusters/turkish-query.ts (the TypeScript twin of the SQL
// tayf_search_fold): Turkish and circumflex letters and their ASCII bases, same
// code-point length. turkish-query.ts cannot be imported here (client-bundle
// whitelist above); follows.test.ts holds the parity test.
export const SEARCH_FOLD_FROM = "İIıŞşĞğÜüÖöÇçÂâÎîÛû";
export const SEARCH_FOLD_TO = "iiissgguuooccaaiiuu";

const FOLD_MAP: ReadonlyMap<string, string> = new Map(
  [...SEARCH_FOLD_FROM].map((from, i) => [from, [...SEARCH_FOLD_TO][i] as string]),
);

// Mirrors TOPIC_SLUGS / TOPIC_LABELS_TR in src/lib/clusters/topic-query.ts,
// which cannot be imported here (it pulls next/cache and Supabase into the
// client bundle). follows.test.ts holds a parity test; the server route uses
// topic-query's own isTopicSlug, which stays authoritative.
export const FOLLOW_TOPIC_SLUGS = [
  "dunya",
  "ekonomi",
  "spor",
  "yasam",
  "teknoloji",
  "genel",
] as const;
export type FollowTopicSlug = (typeof FOLLOW_TOPIC_SLUGS)[number];

export const FOLLOW_TOPIC_LABELS: Record<FollowTopicSlug, string> = {
  dunya: "Dünya",
  ekonomi: "Ekonomi",
  spor: "Spor",
  yasam: "Yaşam",
  teknoloji: "Teknoloji",
  genel: "Genel",
};

/**
 * q      a free-text archive search (the stemmed /?q= path)
 * konu   a /konu/<slug> topic
 * gundem a /gundem/<key> entity hub. The value is the RISING_ENTITIES key, and
 *        the server answers it through the hub's own matcher (aliases,
 *        excludes, word boundaries), NOT through the keyword search -- which
 *        lists "devam" under DEVA and Polish courts under Anayasa Mahkemesi.
 */
export type FollowKind = "q" | "konu" | "gundem";

export type Follow = {
  kind: FollowKind;
  value: string;
  /** ISO instant the follow was created; null for legacy / unparseable data. */
  addedAt: string | null;
  /** ISO instant the reader last saw this follow's results; null = no baseline. */
  seenAt: string | null;
  /**
   * Ids of the stories the last /takip visit showed for this follow (at most
   * SEEN_IDS_MAX); null = none recorded (a legacy follow, a new one, or an empty
   * result), and the seenAt rule applies. h112-follows-1: a story that became
   * listed after the visit keeps a firstPublished from before it, so seenAt alone
   * cannot tell it from one the reader already saw.
   */
  seenIds: readonly string[] | null;
  /** The oldest firstPublished among those rows, as the API gave it; null with seenIds. */
  seenFloor: string | null;
};

export type AddFollowResult = "added" | "exists" | "full" | "invalid";

const TOPIC_SLUG_SET: ReadonlySet<string> = new Set(FOLLOW_TOPIC_SLUGS);

// key -> label of every hub. A Map (not an object) so "__proto__" and
// "constructor" are plain misses; the only way a value gets in is by being a
// curated RISING_ENTITIES key.
const GUNDEM_LABELS: ReadonlyMap<string, string> = new Map(
  RISING_ENTITIES.map((e) => [e.key, e.label]),
);

// Control characters (Cc) cannot be typed into a search box and have no place
// in a stored keyword; lone surrogates (Cs) would make encodeURIComponent
// throw while rendering the follow's link.
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cs}]/u;

// Format characters (Cf: zero-width space / joiners, word joiner, BOM, soft
// hyphen, bidi marks and overrides) are invisible and not whitespace. They are
// stripped from the stored value, otherwise 'seçim' + U+200B would be a second,
// look-alike follow of the same search (the server search strips them too:
// cleanQueryUnicode).
const FORMAT_CHARS = /\p{Cf}/gu;

/** Why a keyword is not followable (see keywordRejectReason). */
export type KeywordRejectReason = "too-long" | "too-short" | "invalid";

type KeywordCheck =
  | { ok: true; value: string }
  | { ok: false; reason: KeywordRejectReason };

// The ONE place the keyword rules live, so normalizeKeyword and
// keywordRejectReason can never disagree about what is accepted.
//
// The stored value is the DISPLAY form: format characters out, NFC (after the
// strip, so a base letter next to a combining mark it was separated from
// composes), whitespace collapsed, trimmed, and the reader's case kept.
// Lower-casing it with Turkish rules turned the ASCII 'IMF' every keyboard types
// into 'ımf' (and 'FIFA' into 'fıfa'), labelled and linked that way. Identity
// (what makes two keywords the same follow) is keywordIdentity, not this value.
function checkKeyword(raw: unknown): KeywordCheck {
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  if (raw.length > RAW_MAX) return { ok: false, reason: "too-long" };
  const s = raw
    .replace(FORMAT_CHARS, "")
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();
  if (FORBIDDEN_CHARS.test(s)) return { ok: false, reason: "invalid" };
  const length = [...s].length;
  if (length < KEYWORD_MIN) return { ok: false, reason: "too-short" };
  if (length > KEYWORD_MAX) return { ok: false, reason: "too-long" };
  return { ok: true, value: s };
}

/** The stored (display) form of a keyword, or null when the input is not an acceptable keyword. */
export function normalizeKeyword(raw: unknown): string | null {
  const check = checkKeyword(raw);
  return check.ok ? check.value : null;
}

/**
 * What makes two keywords the same follow: İ, I and ı fold to i, the rest is
 * lower-cased, then the search fold (Turkish and circumflex letters to ASCII).
 * 'IMF', 'imf' and a legacy stored 'ımf' share the identity 'imf', as do
 * 'Seçim' and 'secim' -- the server search treats them alike (it folds ı and i,
 * ş and s, ...), so following both would spend two of the 20 slots on one
 * result list. Not 'I' -> 'ı': that would make 'Irak' and 'IMF' disagree. The
 * display value keeps the reader's case, and Turkish words that really start
 * with a dotless I ('Irak', 'Isparta') keep it on screen. Expects a value
 * already passed through normalizeKeyword.
 */
export function keywordIdentity(v: string): string {
  let out = "";
  for (const ch of v.replace(/[İIı]/gu, "i").toLowerCase()) out += FOLD_MAP.get(ch) ?? ch;
  return out;
}

/**
 * Why `raw` is not an acceptable keyword, or null when normalizeKeyword accepts
 * it. Lets the follow button tell a reader that a search is over the limit
 * instead of silently dropping the button.
 */
export function keywordRejectReason(raw: unknown): KeywordRejectReason | null {
  const check = checkKeyword(raw);
  return check.ok ? null : check.reason;
}

export function isFollowTopicSlug(v: unknown): v is FollowTopicSlug {
  return typeof v === "string" && TOPIC_SLUG_SET.has(v);
}

/** True only for an exact, curated RISING_ENTITIES key (the /gundem/<key> slug). */
export function isFollowGundemKey(v: unknown): v is string {
  return typeof v === "string" && GUNDEM_LABELS.has(v);
}

// from -> to, except that a `from` produced by two entries maps to nothing
// (ambiguous), so canonicalFollow never guesses between two hubs. No two hubs
// collide today; follows.test.ts pins that.
function uniqueLookup(
  pairs: Iterable<readonly [string, string]>,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [from, to] of pairs) {
    if (ambiguous.has(from)) continue;
    if (map.has(from)) {
      map.delete(from);
      ambiguous.add(from);
      continue;
    }
    map.set(from, to);
  }
  return map;
}

// Hub key by its label's keyword identity ("deva", "merkez bankasi"). A reader
// who tapped "Takip et" on /gundem/deva before the hub follow existed holds
// {kind:"q", value:"deva"}: the old button stored the lower-cased label. The
// same lookup serves a keyword typed into the search box, because both go
// through normalizeKeyword and then keywordIdentity (canonicalFollow), so 'DEVA'
// and 'deva' + U+200B reach the hub as well.
const GUNDEM_KEY_BY_KEYWORD = uniqueLookup(
  RISING_ENTITIES.flatMap((e) => {
    const keyword = normalizeKeyword(e.label);
    return keyword === null ? [] : [[keywordIdentity(keyword), e.key] as const];
  }),
);

/** The stored form of `value` for `kind`, or null when it is not followable. */
export function normalizeFollowValue(kind: FollowKind, value: unknown): string | null {
  if (kind === "q") return normalizeKeyword(value);
  if (kind === "konu") return isFollowTopicSlug(value) ? value : null;
  if (kind === "gundem") return isFollowGundemKey(value) ? value : null;
  return null;
}

/**
 * The stored form of a follow: `value` normalised for `kind` (a keyword keeps
 * its case), and a keyword whose identity is a hub label's identity becomes that
 * hub ({kind:"q", value:"  DEVA "} -> {kind:"gundem", value:"deva"}). Anything
 * else keeps its kind. null when the
 * input is not followable. ONE rule for every path: add / has / toggle use it
 * on what the reader types, and parseStoredFollows (coerceEntry) uses it on what
 * is already in storage, so parse is idempotent (parse(serialize(parse(x))) ==
 * parse(x)), a keyword stored as "Deva" reads back as the hub follow the button
 * looks up, and re-adding it reports "exists" instead of storing a duplicate.
 * Deliberately exact beyond normalisation: "deva partisi", "chp'li" and "devam"
 * stay keywords, because guessing would rewrite a follow the reader chose.
 */
export function canonicalFollow(
  kind: FollowKind,
  value: unknown,
): { kind: FollowKind; value: string } | null {
  const normalized = normalizeFollowValue(kind, value);
  if (normalized === null) return null;
  if (kind === "q") {
    const key = GUNDEM_KEY_BY_KEYWORD.get(keywordIdentity(normalized));
    if (key !== undefined) return { kind: "gundem", value: key };
  }
  return { kind, value: normalized };
}

/**
 * The identity of a follow, used wherever two follows are compared (exists,
 * has, remove, markSeen, React keys). For a keyword it is the keyword's
 * identity ('q:imf' for 'IMF'), NOT its display value; the other kinds use their
 * slug / hub key.
 */
export function followKey(f: Pick<Follow, "kind" | "value">): string {
  return f.kind === "q" ? `q:${keywordIdentity(f.value)}` : `${f.kind}:${f.value}`;
}

/**
 * Inverse of followKey. null unless the key is exactly what followKey would
 * emit. For a keyword the value is its IDENTITY ('imf'), which cannot rebuild
 * the reader's display ('IMF'): never build a link or an API path from it, use
 * the Follow's own value (followHref / followApiPath).
 */
export function parseFollowKey(
  key: string,
): { kind: FollowKind; value: string } | null {
  const colon = key.indexOf(":");
  if (colon < 0) return null;
  const kind = key.slice(0, colon);
  const value = key.slice(colon + 1);
  if (kind === "q") {
    const display = normalizeKeyword(value);
    return display !== null && keywordIdentity(display) === value ? { kind, value } : null;
  }
  if (kind !== "konu" && kind !== "gundem") return null;
  return normalizeFollowValue(kind, value) === value ? { kind, value } : null;
}

export function hasFollow(
  list: readonly Follow[],
  kind: FollowKind,
  value: unknown,
): boolean {
  const canonical = canonicalFollow(kind, value);
  if (canonical === null) return false;
  const key = followKey(canonical);
  return list.some((f) => followKey(f) === key);
}

function cleanStamp(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 64) return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** First SEEN_IDS_MAX distinct entries of `ids` (compared case-insensitively), as given. */
function distinctIds(ids: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (out.length >= SEEN_IDS_MAX) break;
    const lower = id.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(id);
  }
  return out;
}

/**
 * A stored seenIds: null for anything that is not an array (absent, a string, an
 * object) and for an array whose entries are all garbage; otherwise its
 * uuid-shaped entries, de-duplicated, at most SEEN_IDS_MAX.
 */
function cleanSeenIds(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const ids = distinctIds(v.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)));
  return ids.length === 0 && v.length > 0 ? null : ids;
}

function coerceEntry(entry: unknown): Follow | null {
  // Legacy shape: a bare string was a keyword.
  if (typeof entry === "string") {
    const c = canonicalFollow("q", entry);
    return c === null ? null : { ...c, addedAt: null, seenAt: null, seenIds: null, seenFloor: null };
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const o = entry as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== "q" && kind !== "konu" && kind !== "gundem") return null;
  const addedAt = cleanStamp(o.addedAt);
  const seenAt = cleanStamp(o.seenAt);
  const seenIds = cleanSeenIds(o.seenIds);
  const seenFloor = cleanStamp(o.seenFloor);
  // Same rule as add / has / toggle: a keyword that is a hub's label becomes
  // the hub follow, stamps kept. A stored lower-case value ('ımf') parses
  // unchanged: it keeps its display, and its identity makes a later 'IMF' exist.
  const c = canonicalFollow(kind, o.value);
  if (c === null) return null;
  return { ...c, addedAt, seenAt, seenIds, seenFloor };
}

/** Never throws. Invalid entries are dropped, duplicates collapse (first wins). */
export function parseStoredFollows(raw: string | null): Follow[] {
  if (raw === null || raw === "") return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const out: Follow[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    if (out.length >= MAX_FOLLOWS) break;
    const follow = coerceEntry(entry);
    if (follow === null) continue;
    const key = followKey(follow);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(follow);
  }
  return out;
}

export function serializeFollows(list: readonly Follow[]): string {
  return JSON.stringify(
    list.map((f) => ({
      kind: f.kind,
      value: f.value,
      addedAt: f.addedAt,
      seenAt: f.seenAt,
      seenIds: f.seenIds,
      seenFloor: f.seenFloor,
    })),
  );
}

/**
 * Adds a follow. A new entry starts with addedAt = seenAt = nowIso, so only
 * stories first published AFTER the follow count as "yeni", and with no seen ids
 * (it uses the seenAt rule until its first /takip visit records some). Check order:
 * invalid, then exists (an already-followed entry in a full list is "exists",
 * not "full"), then full. On any non-"added" result `list` is the input.
 */
export function addFollow(
  list: readonly Follow[],
  input: { kind: FollowKind; value: string },
  nowIso: string,
): { list: readonly Follow[]; result: AddFollowResult } {
  const canonical = canonicalFollow(input.kind, input.value);
  if (canonical === null) return { list, result: "invalid" };
  const next: Follow = {
    ...canonical,
    addedAt: nowIso,
    seenAt: nowIso,
    seenIds: null,
    seenFloor: null,
  };
  const key = followKey(next);
  if (list.some((f) => followKey(f) === key)) return { list, result: "exists" };
  if (list.length >= MAX_FOLLOWS) return { list, result: "full" };
  return { list: [...list, next], result: "added" };
}

export function removeFollow(list: readonly Follow[], key: string): Follow[] {
  return list.filter((f) => followKey(f) !== key);
}

/** The rows a /takip visit rendered for one follow: their ids and the oldest firstPublished among them. */
export type SeenRows = {
  ids: readonly string[];
  /** null when no rendered row has a readable time (an empty result). */
  floor: string | null;
};

/**
 * Records a visit for exactly the given keys: seenAt = nowIso, plus the ids and
 * the floor of the rows that were actually rendered (rowsShown). Every other
 * entry is untouched. Rows that give no usable record (an empty result, an
 * unreadable floor) reset seenIds / seenFloor to null, so that follow uses the
 * seenAt rule, which is exactly "nothing was on screen".
 */
export function markSeen(
  list: readonly Follow[],
  shown: ReadonlyMap<string, SeenRows>,
  nowIso: string,
): Follow[] {
  return list.map((f) => {
    const rows = shown.get(followKey(f));
    if (rows === undefined) return f;
    const ids = distinctIds(rows.ids);
    const floorOk = rows.floor !== null && cleanStamp(rows.floor) !== null;
    return ids.length > 0 && floorOk
      ? { ...f, seenAt: nowIso, seenIds: ids, seenFloor: rows.floor }
      : { ...f, seenAt: nowIso, seenIds: null, seenFloor: null };
  });
}

/** What isNewItem needs from a follow: its last visit (when, which stories, the oldest of them). */
export type SeenBaseline = Pick<Follow, "seenAt" | "seenIds" | "seenFloor">;

export const NO_BASELINE: SeenBaseline = Object.freeze({
  seenAt: null,
  seenIds: null,
  seenFloor: null,
});

/**
 * A baseline from what callers hold: a SeenBaseline, or the legacy shorthand (a
 * bare seenAt string, or null for no baseline at all), which means the seenAt
 * rule.
 */
function toBaseline(v: SeenBaseline | string | null | undefined): SeenBaseline {
  if (v === null || v === undefined) return NO_BASELINE;
  return typeof v === "string" ? { seenAt: v, seenIds: null, seenFloor: null } : v;
}

type RowLike = { id?: string; firstPublished: string };

/**
 * Whether a story is "yeni" for a follow whose last visit is `baseline`.
 * Instants are compared numerically: the API returns PostgREST timestamps
 * ("...+00:00") while seenAt comes from toISOString ("...Z"), so a string
 * comparison would be wrong. An unparseable firstPublished is never new, and
 * neither is anything without a usable baseline: the feed never claims novelty
 * it cannot back up.
 *
 * With seenIds (and a readable floor), "new" means: the visit did not show it,
 * and it was first published strictly after the oldest story the visit showed.
 * That counts a story that became listed after the visit although it was first
 * published before it (a keyword's second source arrives a median of 33 min
 * after firstPublished), and ignores an old story that merely resurfaced. A tie
 * at the floor is not new: that row may have been below the cut. Otherwise
 * (legacy follows, a new follow, an empty result) it is firstPublished > seenAt.
 */
export function isNewItem(item: RowLike, baseline: SeenBaseline): boolean {
  const ms = Date.parse(item.firstPublished);
  if (!Number.isFinite(ms)) return false;
  if (baseline.seenIds !== null && baseline.seenFloor !== null) {
    const floorMs = Date.parse(baseline.seenFloor);
    if (Number.isFinite(floorMs)) {
      const id = (item.id ?? "").toLowerCase();
      if (id !== "" && baseline.seenIds.some((seen) => seen.toLowerCase() === id)) return false;
      return ms > floorMs;
    }
  }
  if (baseline.seenAt === null) return false;
  const seenMs = Date.parse(baseline.seenAt);
  return Number.isFinite(seenMs) && ms > seenMs;
}

/**
 * How many items are "yeni" for the reader's last visit (isNewItem). `baseline`
 * is the follow's SeenBaseline, or a bare seenAt string / null (the legacy,
 * seenAt-only rule).
 */
export function countNew(
  items: ReadonlyArray<RowLike>,
  baseline: SeenBaseline | string | null,
): number {
  const b = toBaseline(baseline);
  let n = 0;
  for (const item of items) {
    if (isNewItem(item, b)) n += 1;
  }
  return n;
}

/**
 * How many of `items` (newest-first as the API returns them) a follow's list
 * must render so that every story countNew() calls "yeni" is on screen:
 * min(items.length, max(base, index of the last new item + 1)).
 *
 * The API returns up to FOLLOW_ITEMS_MAX items but a section shows `base` rows
 * by default, and a topic read is ordered by updated_at (not first_published),
 * so a new story can sit below row `base`. Without this, the badge counted
 * stories the reader could not see and the visit's markSeen then consumed them.
 * "New" is exactly countNew's rule (isNewItem), and with no usable baseline
 * nothing is new, so the list stays at `base`.
 */
export function followRowsToShow(
  items: ReadonlyArray<RowLike>,
  baseline: SeenBaseline | string | null,
  base: number,
): number {
  const b = toBaseline(baseline);
  let rows = base;
  for (let i = items.length - 1; i >= 0; i--) {
    if (isNewItem(items[i] as RowLike, b)) {
      rows = Math.max(base, i + 1);
      break;
    }
  }
  return Math.min(items.length, rows);
}

/**
 * The rows /takip renders for one follow (the followRowsToShow slice of
 * `items`), as the record markSeen stores: their ids, and the oldest
 * firstPublished among them as the API gave it. Exactly what the reader was
 * shown, never the rest of the response.
 */
export function rowsShown(
  items: ReadonlyArray<{ id: string; firstPublished: string }>,
  baseline: SeenBaseline | string | null,
  base: number,
): SeenRows {
  const rows = items.slice(0, followRowsToShow(items, baseline, base));
  let floor: string | null = null;
  let floorMs = Infinity;
  for (const row of rows) {
    const ms = Date.parse(row.firstPublished);
    if (Number.isFinite(ms) && ms < floorMs) {
      floorMs = ms;
      floor = row.firstPublished;
    }
  }
  return { ids: rows.map((r) => r.id), floor };
}

export function followHref(f: Pick<Follow, "kind" | "value">): string {
  if (f.kind === "q") return `/?q=${encodeURIComponent(f.value)}`;
  if (f.kind === "gundem") return `/gundem/${encodeURIComponent(f.value)}`;
  return `/konu/${f.value}`;
}

export function followLabel(f: Pick<Follow, "kind" | "value">): string {
  if (f.kind === "q") return `“${f.value}”`;
  if (f.kind === "gundem") return GUNDEM_LABELS.get(f.value) ?? f.value;
  return isFollowTopicSlug(f.value) ? FOLLOW_TOPIC_LABELS[f.value] : f.value;
}

/**
 * Empty-state copy for a follow whose read returned nothing. A topic read is
 * the last 7 days and a hub read the last 14; a keyword search has NO date
 * window (it searches the whole archive and /api/takip keeps its 12
 * best-corroborated hits), so only the topic and hub copy may say "son
 * dönemde".
 */
export function followEmptyText(kind: FollowKind): string {
  return kind === "q"
    ? "Eşleşen hikâye bulunamadı."
    : "Son dönemde eşleşen hikâye yok.";
}

/**
 * One-line caption above a follow's list, or null when none is needed. A
 * keyword's matches are a pool: /api/takip takes the search's relevance-ranked
 * hits (up to 24 since migration 129), keeps the 12 with the most sources
 * (KEYWORD_POOL in the route; ties keep the search's order) and shows them
 * newest first, capped at FOLLOW_ITEMS_MAX. They are NOT "the latest
 * stories", and the server cannot see a fresh story the search did not return
 * or that did not make the pool -- so a keyword's "yeni" count is a lower
 * bound. The caption keeps that honest; a topic list needs none.
 */
export function followListCaption(kind: FollowKind): string | null {
  return kind === "q" ? "En çok kaynaklı eşleşmeler · yeniden eskiye" : null;
}

/**
 * Where keyboard / screen-reader focus should go once `removed` leaves `keys`
 * (the follows in display order): the follow that takes its place (the next
 * one), else the one before it, else null (the list is now empty -- the caller
 * focuses the empty state). null as well for a key that is not in the list,
 * since nothing was removed and focus should stay put.
 */
export function focusTargetAfterRemove(
  keys: readonly string[],
  removed: string,
): string | null {
  const index = keys.indexOf(removed);
  if (index < 0) return null;
  return keys[index + 1] ?? keys[index - 1] ?? null;
}

export function followApiPath(f: Pick<Follow, "kind" | "value">): string {
  if (f.kind === "q") return `/api/takip?q=${encodeURIComponent(f.value)}`;
  if (f.kind === "gundem") return `/api/takip?gundem=${encodeURIComponent(f.value)}`;
  return `/api/takip?konu=${f.value}`;
}

// ---------------------------------------------------------------------------
// GET /api/takip response handling (client side)
// ---------------------------------------------------------------------------

export type FollowItem = {
  id: string;
  title: string;
  firstPublished: string;
  updatedAt: string;
  sourceCount: number;
  isBlindspot: boolean;
  zoneLine: string;
  /**
   * The site's sourceCountHead wording, built by the server: 'N kaynak' or 'N
   * kaynak (M sınıflandırılmış)'. Optional because a cached 200 body from
   * before the field existed has none (followRowMeta falls back to
   * '{sourceCount} kaynak').
   */
  countHead?: string;
  /**
   * 'en' when the headline is an English outlet's own article title (WCAG 3.1.2,
   * h118-english-1): the title span carries lang="en". Additive like countHead: a
   * cached body from before the field has none, and only the exact string 'en' is
   * kept.
   */
  lang?: "en";
};

function coerceItem(v: unknown): FollowItem | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !UUID_RE.test(o.id)) return null;
  if (typeof o.title !== "string") return null;
  if (typeof o.firstPublished !== "string") return null;
  if (typeof o.updatedAt !== "string") return null;
  if (typeof o.sourceCount !== "number" || !Number.isFinite(o.sourceCount)) return null;
  if (typeof o.isBlindspot !== "boolean") return null;
  if (typeof o.zoneLine !== "string") return null;
  const item: FollowItem = {
    id: o.id,
    title: o.title,
    firstPublished: o.firstPublished,
    updatedAt: o.updatedAt,
    sourceCount: o.sourceCount,
    isBlindspot: o.isBlindspot,
    zoneLine: o.zoneLine,
  };
  // Additive field: kept only as a non-empty string. Anything else (an old
  // body without it, a number, null, "") is "missing", never a rejected row.
  if (typeof o.countHead === "string" && o.countHead.length > 0) {
    item.countHead = o.countHead;
  }
  // Same rule for lang: exactly 'en' or missing, never a rejected row and never
  // an arbitrary string that would reach a lang attribute.
  if (o.lang === "en") item.lang = "en";
  return item;
}

/**
 * The meta line under a /takip row: '{count head} · {time ago} · {zone line}'.
 * The count head is the server's sourceCountHead ('5 kaynak (4
 * sınıflandırılmış)' when only 4 of the 5 members vote, so the zone line adds
 * up); a cached body without it reads '{n} kaynak'.
 * The age is measured from firstPublished -- the same instant ClusterCard
 * shows and countNew() compares against seenAt -- NOT from updatedAt, which
 * moves whenever a late article joins the cluster and would make an old story
 * read as fresh. `now` is injectable for tests; it defaults to the clock.
 */
export function followRowMeta(
  item: Pick<FollowItem, "sourceCount" | "countHead" | "firstPublished" | "zoneLine">,
  now?: number,
): string {
  const ago = formatTurkishTimeAgo(
    item.firstPublished,
    now === undefined ? undefined : { now },
  );
  const head = item.countHead ?? `${item.sourceCount} kaynak`;
  return `${head} · ${ago} · ${item.zoneLine}`;
}

/**
 * Validates a /api/takip JSON body. null = not the expected shape at all
 * (treated as a failed load); otherwise the well-formed items, capped. An item
 * id must be a uuid because it is interpolated into a /cluster/{id} link.
 */
export function parseFollowItems(json: unknown): FollowItem[] | null {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const items = (json as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const out: FollowItem[] = [];
  for (const raw of items) {
    if (out.length >= FOLLOW_ITEMS_MAX) break;
    const item = coerceItem(raw);
    if (item !== null) out.push(item);
  }
  return out;
}

/**
 * Runs `worker` over `items` with at most `limit` in flight, in input order.
 * Workers own their error handling (a rejection rejects the whole run).
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from(
    { length: Math.max(0, Math.min(Math.floor(limit), items.length)) },
    async () => {
      while (next < items.length) {
        const item = items[next++] as T;
        await worker(item);
      }
    },
  );
  await Promise.all(runners);
}
