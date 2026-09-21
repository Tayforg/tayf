/**
 * src/lib/game/framing.ts — pure, isomorphic helpers for the Çerçeve
 * ("Framing") game mode (PACK D / R10: one political headline at a time,
 * outlet hidden, a crowd vote into `public.framing_votes`).
 *
 * ISOMORPHIC ON PURPOSE: this module is imported by BOTH a client component
 * (framing-game.tsx, "use client") AND two route handlers
 * (src/app/api/oyun/cerceve/{next,route}.ts's GET and POST). It must never
 * import from `node:` anything or from a server-only package — Web Crypto
 * (`globalThis.crypto.subtle`) is the one crypto primitive used here,
 * because it's the API available in both the browser and every Next.js
 * runtime without a bundler alias.
 *
 * PRIVACY: the raw session id (a random 32-hex string minted by
 * `newSessionId`, held only in the `tayf_cerceve_sid` cookie) never leaves
 * the browser/cookie jar. Only its sha256 (`hashSessionId`) is ever sent
 * to, or stored in, the database — see `framing_votes.session_hash`
 * (migration 068). `hashSessionId` is async because `subtle.digest` is.
 *
 * Every export below is pure / side-effect-free, with the sole exception
 * of `newSessionId`'s randomness.
 */

export const FRAMING_VOTES = ["iktidar", "muhalefet", "none"] as const;
export type FramingVote = (typeof FRAMING_VOTES)[number];

export const FRAMING_VOTE_LABELS_TR: Record<FramingVote, string> = {
  iktidar: "İktidar lehine",
  muhalefet: "Muhalefet lehine",
  none: "Tarafsız",
};

export interface FramingTally {
  n: number;
  iktidar: number;
  muhalefet: number;
  none: number;
}

export interface FramingRoundEntry {
  vote: FramingVote;
  tally: FramingTally;
}

export const FRAMING_SESSION_COOKIE = "tayf_cerceve_sid";
export const FRAMING_SESSION_MAX_AGE_SECONDS = 2592000;
export const FRAMING_MIN_TALLY_N = 3;
export const FRAMING_ROUND_SECONDS = 60;

const SESSION_ID_RE = /^[0-9a-f]{32}$/;

/** True for exactly "iktidar" | "muhalefet" | "none" — nothing else. */
export function isFramingVote(value: unknown): value is FramingVote {
  return (
    typeof value === "string" &&
    (FRAMING_VOTES as readonly string[]).includes(value)
  );
}

/**
 * Parses the raw `Cookie` request header and returns
 * `FRAMING_SESSION_COOKIE`'s value ONLY when it is exactly 32 lowercase hex
 * characters — an absent cookie, a short/garbled value, or anything that
 * doesn't match the shape `newSessionId` produces all fold to `null` so
 * the caller mints a fresh session rather than trusting a malformed one.
 */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== FRAMING_SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return SESSION_ID_RE.test(value) ? value : null;
  }

  return null;
}

/** 32 lowercase hex chars — a fresh, opaque, unguessable session id. */
export function newSessionId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * sha256 hex of `tayf-cerceve:${rawId}`, computed via
 * `globalThis.crypto.subtle` — never `node:crypto` (see module doc
 * comment: this file is also imported client-side).
 */
export async function hashSessionId(rawId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`tayf-cerceve:${rawId}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Coerces an RPC row into a `FramingTally`; non-finite/negative -> 0. */
export function normalizeTally(input: unknown): FramingTally {
  const row = (input ?? {}) as Record<string, unknown>;
  return {
    n: toCount(row.n),
    iktidar: toCount(row.iktidar),
    muhalefet: toCount(row.muhalefet),
    // The SQL RETURNS TABLE column is `neutral_n` (migration 068 line
    // 115/126 — `none` is a reserved word); the HTTP JSON body this same
    // function also normalises client-side uses `none`, so accept both.
    none: toCount(row.none ?? row.neutral_n),
  };
}

/** The top vote, or `null` when `n === 0` or the top two counts tie. */
export function pluralityVote(tally: FramingTally): FramingVote | null {
  if (tally.n === 0) return null;

  const ranked = FRAMING_VOTES.map((vote) => ({ vote, count: tally[vote] })).sort(
    (a, b) => b.count - a.count,
  );
  const first = ranked[0];
  const second = ranked[1];
  if (!first || !second) return null;
  if (first.count === second.count) return null;
  return first.vote;
}

export function formatTallyLine(tally: FramingTally): string {
  if (tally.n === 0) return "Henüz oy yok";
  const pct = (count: number) => Math.round((count / tally.n) * 100);
  return `${tally.n} oy · İktidar %${pct(tally.iktidar)} · Muhalefet %${pct(tally.muhalefet)} · Tarafsız %${pct(tally.none)}`;
}

export function summariseFramingRound(entries: readonly FramingRoundEntry[]): {
  total: number;
  eligible: number;
  agree: number;
  line: string;
  detail: string;
} {
  const total = entries.length;
  const eligibleEntries = entries.filter((entry) => entry.tally.n >= FRAMING_MIN_TALLY_N);
  const eligible = eligibleEntries.length;
  const agree = eligibleEntries.filter(
    (entry) => pluralityVote(entry.tally) === entry.vote,
  ).length;
  const line =
    eligible === 0
      ? "Henüz karşılaştırmak için yeterli oy yok."
      : `${agree} başlıkta çoğunlukla aynı fikirdesiniz`;
  const detail = `Yeterli oyu olan ${eligible} başlık üzerinden · bu turda ${total} başlık oyladın.`;

  return { total, eligible, agree, line, detail };
}
