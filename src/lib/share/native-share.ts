/**
 * src/lib/share/native-share.ts — the one rule for the Web Share API outcome,
 * shared by every "Paylaş" button (the story share chip and "Günün Tayf'ı").
 * Pure: no `window`, no `navigator`, no next/server imports, so both a server
 * test and a 'use client' module can import it.
 */

/**
 * True when a `navigator.share()` rejection is the reader dismissing the
 * share sheet (an `AbortError`). That is a decision, not a failure: the
 * clipboard must stay untouched. Any other rejection (unsupported, blocked)
 * still falls back to copying.
 */
export function isShareAbort(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

/**
 * What a native share attempt amounted to:
 *   - `shared`   the sheet completed; nothing else to do.
 *   - `aborted`  the reader dismissed the sheet; do nothing (no clipboard
 *                write, no analytics event, no state change).
 *   - `fallback` no Web Share API, or it failed for another reason
 *                (NotAllowedError, an unsupported payload, ...): fall back to
 *                copying the link.
 */
export type NativeShareOutcome = "shared" | "aborted" | "fallback";

/**
 * Runs `shareFn(data)` and classifies the result. The call is awaited INSIDE
 * the try, so a synchronous throw (some browsers throw instead of rejecting
 * for a bad payload) lands in the same classification as a rejection.
 *
 * `shareFn` must already be bound to `navigator` (`(d) => navigator.share(d)`):
 * an unbound `navigator.share` throws "Illegal invocation", which would be
 * swallowed here as a `fallback` and silently turn every share into a copy.
 */
export async function runNativeShare(
  shareFn: ((data: ShareData) => Promise<void>) | undefined,
  data: ShareData,
): Promise<NativeShareOutcome> {
  if (shareFn === undefined) return "fallback";
  try {
    await shareFn(data);
    return "shared";
  } catch (err) {
    return isShareAbort(err) ? "aborted" : "fallback";
  }
}
