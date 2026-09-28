// src/lib/game/framing-draw.ts
//
// Pure helpers for the Çerçeve ("Framing") round clock and draw-response
// classification, pulled out of framing-game.tsx so they can be unit
// tested directly -- the component test harness has no DOM (see
// framing-game.test.tsx's header comment), so all branching logic that
// can be expressed without React state lives here instead.
//
// Bug this fixes (audit fix A): handleStart used to set `endsAtRef.current
// = Date.now() + FRAMING_ROUND_SECONDS * 1000` BEFORE the first
// drawHeadline() fetch resolved. A slow or retried draw then ate into the
// player's round time, or in the worst case the round could already be
// over by the time a headline appeared. The clock now only starts once a
// headline actually lands (see startRoundClock below), and any 4xx/5xx or
// network failure on the FIRST draw of a round shows a retry affordance
// instead of silently burning round time or (previously) treating every
// non-OK response identically to an empty pool.

/** Outcome of classifying a `/api/oyun/cerceve/next` response. */
export type DrawOutcome =
  | { kind: "headline"; articleId: string; title: string }
  | { kind: "pool-empty" }
  | { kind: "error" };

/**
 * Classify a draw response into a `DrawOutcome`.
 *
 * `res` is `null` when the fetch threw (network failure, `AbortSignal`
 * timeout) or the body wasn't parseable JSON -- both collapse to the same
 * "error" outcome, since neither tells the caller anything actionable.
 *
 * A non-OK HTTP status (any 4xx/5xx, including 429) is ALWAYS an error,
 * never treated as an empty pool -- an empty pool is a distinct, valid
 * `article_id: null` response on a 2xx, not a rejected request.
 */
export function classifyDrawResponse(
  res: { ok: boolean; body: unknown } | null,
): DrawOutcome {
  if (res === null) return { kind: "error" };
  if (!res.ok) return { kind: "error" };

  const body = res.body;
  if (body && typeof body === "object") {
    const b = body as { article_id?: unknown; title?: unknown };
    if (b.article_id === null) return { kind: "pool-empty" };
    if (typeof b.article_id === "string" && typeof b.title === "string") {
      return { kind: "headline", articleId: b.article_id, title: b.title };
    }
  }
  return { kind: "error" };
}

/**
 * Compute the round's end timestamp (ms). If a deadline is already set
 * (`currentEndsAtMs > 0`), it is kept as-is -- a subsequent draw within the
 * same round (e.g. after "Sonraki") must never push the deadline out. Only
 * when no deadline has been set yet (0, the idle/never-started sentinel)
 * does the round clock start, anchored to `nowMs` at the moment a headline
 * actually arrives rather than when the player clicked "Başla".
 */
export function startRoundClock(
  currentEndsAtMs: number,
  nowMs: number,
  roundSeconds: number,
): number {
  return currentEndsAtMs > 0 ? currentEndsAtMs : nowMs + roundSeconds * 1000;
}
