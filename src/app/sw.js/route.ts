// /sw.js -- the offline-reading service worker.
//
// A route handler on a STABLE url, not a hashed /_next/static asset: the kill
// switch (SW_KILL in src/lib/pwa/sw-contract.ts) relies on already-installed
// registrations re-fetching this exact url and finding a worker that wipes the
// "tayf-" caches and unregisters itself. See the runbook in sw-contract.ts.
//
// Headers are set here, so no next.config headers() entry and no CSP change is
// involved. The site CSP (default-src 'self', connect-src 'self' https:) also
// becomes the worker's CSP and already allows same-origin fetch.
//
// Cache-Control: browsers revalidate the worker script on every update check
// anyway; no-cache keeps shared caches honest too. The body is deterministic
// (no build id, no clock), so a deploy that did not touch the worker does not
// reinstall it.
//
// Kept static on purpose (no dynamic APIs). If `next build && next start` ever
// shows Next replacing this Cache-Control header, make GET async and call
// `await connection()` (next/server) first.
import { SW_KILL } from "@/lib/pwa/sw-contract";
import { buildServiceWorkerSource } from "@/lib/pwa/sw-source";

export function GET(): Response {
  return new Response(buildServiceWorkerSource({ kill: SW_KILL }), {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache, max-age=0, must-revalidate",
      "X-Robots-Tag": "noindex",
    },
  });
}
