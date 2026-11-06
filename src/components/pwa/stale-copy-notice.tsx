"use client";

import { useSyncExternalStore } from "react";

import { formatTurkishTimeAgo } from "@/lib/time";

// "You are looking at an old copy" notice for /cluster/<id> (h47-time-1).
//
// The service worker keeps story pages for up to 14 days and serves the saved
// copy on a timeout, offline or on a 5xx. A saved copy still carries every age
// it was rendered with, and nothing on the page said it was a copy. The page
// stamps the instant the server rendered it (`renderedAtMs`, taken in the
// per-request body of ClusterDetailPage, never in a static shell or a cache
// body) and this island compares that stamp with the instant THIS DOCUMENT
// loaded (`performance.timeOrigin`).
//
// Why the document's load time and not the reader's clock alone: the service
// worker substitutes only navigations (sw-policy.ts / sw-source.ts answer
// `req.mode === "navigate"`), so a saved copy always arrives as a new document
// whose timeOrigin is far past the stamp. A client navigation, and a Back or
// Forward restore (router BFCache, plus a hidden <Activity> under
// cacheComponents that re-runs the snapshot when it is shown again), carry a
// stamp that is later than, or within seconds of, the document's timeOrigin,
// so they never trigger the notice however long the tab sat open.
//
// Hydration: the server render AND the first client render output an empty
// live region. `useSyncExternalStore` answers with its server snapshot (null)
// while the page hydrates and only then asks the clocks, so a copy that is
// hours old never disagrees with the HTML it was built from. (An effect that
// sets state on mount would do the same, but react-hooks/set-state-in-effect
// forbids it here; this is the house pattern, see zone-guess-game.tsx.) The
// role=status region is always mounted and only its text arrives after mount:
// a live region injected together with its text is not reliably announced,
// one that is already in the page and then gets its text is (WCAG 4.1.3; same
// as new-since-last-visit.tsx).
//
// It looks once per mount, on purpose. An old tab that was loaded live is not
// an offline copy, so there is nothing to subscribe to.
//
// Imports stay tiny: react plus @/lib/time, which has no imports of its own
// (guarded in relative-time.test.tsx), so the client chunk is a few hundred
// bytes. The ages in the page itself are re-based by RelativeTime.

/** A copy older than this (measured from the server's render) gets the notice. */
export const STALE_COPY_MS = 30 * 60_000;

/**
 * The notice text for a page the server rendered at `renderedAtMs`, whose
 * document loaded at `loadedAtMs` (`performance.timeOrigin`) and is viewed at
 * `nowMs`. Null unless the document loaded more than STALE_COPY_MS after the
 * render (a page that was live when it loaded, or a payload fetched after the
 * document loaded, is not a saved copy), or any input is unusable (non-finite,
 * a stamp outside the Date range, or a clock that reads before the stamp).
 */
export function staleCopyMessage(
  renderedAtMs: number,
  loadedAtMs: number,
  nowMs: number,
): string | null {
  if (!Number.isFinite(renderedAtMs) || !Number.isFinite(loadedAtMs) || !Number.isFinite(nowMs)) {
    return null;
  }
  if (loadedAtMs - renderedAtMs <= STALE_COPY_MS) return null;
  if (nowMs - renderedAtMs <= STALE_COPY_MS) return null;
  const renderedAt = new Date(renderedAtMs);
  if (Number.isNaN(renderedAt.getTime())) return null;
  // A bare date before "kaydedildi" would need a locative suffix, so the notice stays relative.
  const saved = formatTurkishTimeAgo(renderedAt.toISOString(), {
    now: nowMs,
    absoluteAfterMs: Number.POSITIVE_INFINITY,
  });
  if (saved === "") return null;
  return `Bu sayfanın bu cihazda kayıtlı bir kopyasını görüyorsunuz (${saved} kaydedildi). Güncel hâli yüklenemedi; bağlantınız düzelince sayfayı yenileyin.`;
}

/** The markup, separate from the clock so it renders (and tests) without a browser. */
export function StaleCopyView({ message }: { message: string | null }) {
  return (
    <div role="status" aria-live="polite" className={message === null ? "sr-only" : undefined}>
      {message !== null && (
        <p className="rounded-lg border border-border/60 bg-muted/40 px-3.5 py-2.5 text-[13px] leading-snug text-foreground">
          {message}
        </p>
      )}
    </div>
  );
}

// Nothing to subscribe to: the clocks are read once per render pass, and a page
// loaded live does not turn into an offline copy by sitting open.
const subscribeNever = (): (() => void) => () => {};

export function StaleCopyNotice({ renderedAtMs }: { renderedAtMs: number }) {
  const message = useSyncExternalStore(
    subscribeNever,
    () => staleCopyMessage(renderedAtMs, performance.timeOrigin, Date.now()),
    () => null,
  );
  return <StaleCopyView message={message} />;
}
