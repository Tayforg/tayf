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
export const KEYWORD_MAX = 40;
/** Hard cap on the RAW input, applied before any normalisation work. */
export const RAW_MAX = 200;
/** The API returns (and the client trusts) at most this many items per follow. */
export const FOLLOW_ITEMS_MAX = 10;

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

/** Canonical keyword form, or null when the input is not an acceptable keyword. */
export function normalizeKeyword(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > RAW_MAX) return null;
  const s = raw
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("tr");
  if (FORBIDDEN_CHARS.test(s)) return null;
  const length = [...s].length;
  if (length < KEYWORD_MIN || length > KEYWORD_MAX) return null;
  return s;
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

// Hub key by its label in keyword form ("deva", "merkez bankası"). A reader who
// tapped "Takip et" on /gundem/deva before the hub follow existed holds
// {kind:"q", value:"deva"}: the old button stored normalizeKeyword(label). The
// same lookup serves a keyword typed into the search box, because both go
// through normalizeKeyword first (canonicalFollow).
const GUNDEM_KEY_BY_KEYWORD = uniqueLookup(
  RISING_ENTITIES.flatMap((e) => {
    const keyword = normalizeKeyword(e.label);
    return keyword === null ? [] : [[keyword, e.key] as const];
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
 * The stored identity of a follow: `value` normalised for `kind`, and a keyword
 * that normalises to a hub's label becomes that hub ({kind:"q", value:"  DEVA "}
 * -> {kind:"gundem", value:"deva"}). Anything else keeps its kind. null when the
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
    const key = GUNDEM_KEY_BY_KEYWORD.get(normalized);
    if (key !== undefined) return { kind: "gundem", value: key };
  }
  return { kind, value: normalized };
}

export function followKey(f: Pick<Follow, "kind" | "value">): string {
  return `${f.kind}:${f.value}`;
}

/** Inverse of followKey. null unless the key is exactly what followKey would emit. */
export function parseFollowKey(
  key: string,
): { kind: FollowKind; value: string } | null {
  const colon = key.indexOf(":");
  if (colon < 0) return null;
  const kind = key.slice(0, colon);
  const value = key.slice(colon + 1);
  if (kind !== "q" && kind !== "konu" && kind !== "gundem") return null;
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

function coerceEntry(entry: unknown): Follow | null {
  // Legacy shape: a bare string was a keyword.
  if (typeof entry === "string") {
    const c = canonicalFollow("q", entry);
    return c === null ? null : { ...c, addedAt: null, seenAt: null };
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const o = entry as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== "q" && kind !== "konu" && kind !== "gundem") return null;
  const addedAt = cleanStamp(o.addedAt);
  const seenAt = cleanStamp(o.seenAt);
  // Same rule as add / has / toggle: a keyword that is a hub's label becomes
  // the hub follow, stamps kept.
  const c = canonicalFollow(kind, o.value);
  if (c === null) return null;
  return { ...c, addedAt, seenAt };
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
    })),
  );
}

/**
 * Adds a follow. A new entry starts with addedAt = seenAt = nowIso, so only
 * stories first published AFTER the follow count as "yeni". Check order:
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
  const next: Follow = { ...canonical, addedAt: nowIso, seenAt: nowIso };
  const key = followKey(next);
  if (list.some((f) => followKey(f) === key)) return { list, result: "exists" };
  if (list.length >= MAX_FOLLOWS) return { list, result: "full" };
  return { list: [...list, next], result: "added" };
}

export function removeFollow(list: readonly Follow[], key: string): Follow[] {
  return list.filter((f) => followKey(f) !== key);
}

/** Moves seenAt to nowIso for exactly the given keys; every other entry is untouched. */
export function markSeen(
  list: readonly Follow[],
  keys: ReadonlySet<string>,
  nowIso: string,
): Follow[] {
  return list.map((f) => (keys.has(followKey(f)) ? { ...f, seenAt: nowIso } : f));
}

/**
 * How many items were first published after the reader last saw this follow.
 * Instants are compared numerically: the API returns PostgREST timestamps
 * ("...+00:00") while seenAt comes from toISOString ("...Z"), so a string
 * comparison would be wrong. No baseline (null / unparseable) means 0 -- the
 * feed never claims novelty it cannot back up.
 */
export function countNew(
  items: ReadonlyArray<{ firstPublished: string }>,
  seenAt: string | null,
): number {
  if (seenAt === null) return 0;
  const seenMs = Date.parse(seenAt);
  if (!Number.isFinite(seenMs)) return 0;
  let n = 0;
  for (const item of items) {
    const ms = Date.parse(item.firstPublished);
    if (Number.isFinite(ms) && ms > seenMs) n += 1;
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
 * "New" is exactly countNew's rule (Date.parse(firstPublished) > Date.parse(seenAt),
 * an unparseable timestamp is never new), and with no usable baseline nothing is
 * new, so the list stays at `base`.
 */
export function followRowsToShow(
  items: ReadonlyArray<{ firstPublished: string }>,
  seenAt: string | null,
  base: number,
): number {
  let rows = base;
  if (seenAt !== null) {
    const seenMs = Date.parse(seenAt);
    if (Number.isFinite(seenMs)) {
      for (let i = items.length - 1; i >= 0; i--) {
        const ms = Date.parse((items[i] as { firstPublished: string }).firstPublished);
        if (Number.isFinite(ms) && ms > seenMs) {
          rows = Math.max(base, i + 1);
          break;
        }
      }
    }
  }
  return Math.min(items.length, rows);
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
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
