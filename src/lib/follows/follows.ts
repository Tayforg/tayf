// "Takip ettiklerim" -- client-side follows of a keyword or a /konu slug.
//
// Pure module: NO React, NO next/*, NO server imports. It is bundled to the
// client (use-follows.ts, follow-button.tsx, follow-feed.tsx) and unit-tested
// in the node environment. Follows live in localStorage only (key below); the
// server never sees them, it just answers GET /api/takip for one follow at a
// time. Every function here treats stored data as untrusted: localStorage can
// hold anything (an older build's shape, another script's write, hand edits).

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

export type FollowKind = "q" | "konu";

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

/** The stored form of `value` for `kind`, or null when it is not followable. */
export function normalizeFollowValue(kind: FollowKind, value: unknown): string | null {
  if (kind === "q") return normalizeKeyword(value);
  if (kind === "konu") return isFollowTopicSlug(value) ? value : null;
  return null;
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
  if (kind !== "q" && kind !== "konu") return null;
  return normalizeFollowValue(kind, value) === value ? { kind, value } : null;
}

export function hasFollow(
  list: readonly Follow[],
  kind: FollowKind,
  value: unknown,
): boolean {
  const normalized = normalizeFollowValue(kind, value);
  if (normalized === null) return false;
  const key = followKey({ kind, value: normalized });
  return list.some((f) => followKey(f) === key);
}

function cleanStamp(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 64) return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}

function coerceEntry(entry: unknown): Follow | null {
  // Legacy shape: a bare string was a keyword.
  if (typeof entry === "string") {
    const value = normalizeKeyword(entry);
    return value === null ? null : { kind: "q", value, addedAt: null, seenAt: null };
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const o = entry as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== "q" && kind !== "konu") return null;
  const value = normalizeFollowValue(kind, o.value);
  if (value === null) return null;
  return { kind, value, addedAt: cleanStamp(o.addedAt), seenAt: cleanStamp(o.seenAt) };
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
  const value = normalizeFollowValue(input.kind, input.value);
  if (value === null) return { list, result: "invalid" };
  const next: Follow = { kind: input.kind, value, addedAt: nowIso, seenAt: nowIso };
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

export function followHref(f: Pick<Follow, "kind" | "value">): string {
  return f.kind === "q" ? `/?q=${encodeURIComponent(f.value)}` : `/konu/${f.value}`;
}

export function followLabel(f: Pick<Follow, "kind" | "value">): string {
  if (f.kind === "q") return `“${f.value}”`;
  return isFollowTopicSlug(f.value) ? FOLLOW_TOPIC_LABELS[f.value] : f.value;
}

/**
 * Empty-state copy for a follow whose read returned nothing. A topic read is
 * the last 7 days; a keyword search has NO date window (it ranks the whole
 * archive by corroboration), so only the topic copy may say "son dönemde".
 */
export function followEmptyText(kind: FollowKind): string {
  return kind === "q"
    ? "Eşleşen hikâye bulunamadı."
    : "Son dönemde eşleşen hikâye yok.";
}

/**
 * One-line caption above a follow's list, or null when none is needed. A
 * keyword's matches are the most-corroborated stories the search returned
 * (shown newest first), NOT "the latest stories", and the server cannot see
 * a fresh story the search did not return -- so a keyword's "yeni" count is
 * a lower bound. The caption keeps that honest; a topic list needs none.
 */
export function followListCaption(kind: FollowKind): string | null {
  return kind === "q" ? "En çok kaynaklı eşleşmeler · yeniden eskiye" : null;
}

export function followApiPath(f: Pick<Follow, "kind" | "value">): string {
  return f.kind === "q"
    ? `/api/takip?q=${encodeURIComponent(f.value)}`
    : `/api/takip?konu=${f.value}`;
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
  return {
    id: o.id,
    title: o.title,
    firstPublished: o.firstPublished,
    updatedAt: o.updatedAt,
    sourceCount: o.sourceCount,
    isBlindspot: o.isBlindspot,
    zoneLine: o.zoneLine,
  };
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
