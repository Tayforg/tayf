// Shared by the worker builder (sw-core) and the page-side registrar/bookmark flow (sw-shell). Client-safe: no imports.
// KILL SWITCH RUNBOOK: set SW_KILL = true and deploy. /sw.js then serves a worker that deletes every "tayf-" cache and
// unregisters itself (no fetch handler); the registrar stops registering, unregisters existing registrations and ALSO
// deletes every "tayf-" cache from the page itself (the kill worker's own purge only runs when the browser re-fetches
// /sw.js for a registration, which an unregistered registration never does, so the page cannot rely on it).
// Keep /sw.js routed (a 404 on update leaves old workers running) and keep SW_KILL = true for >= 30 days.
// Normal update: bump SW_VERSION (new bytes -> install -> skipWaiting -> activate drops old versioned caches).
// The worker never claims clients, so a first visit stays uncontrolled until its next navigation.
export const SW_URL = "/sw.js";
export const SW_SCOPE = "/";
export const SW_VERSION = "v2";
// How long the page waits for registration.active on an uncontrolled first visit (ready never settles without a registration).
export const SW_READY_TIMEOUT_MS = 10_000;
export const SW_KILL: boolean = false;
export const OFFLINE_PATH = "/offline";
export const CACHE_PREFIX = "tayf-";
export const CACHE_NAMES = {
  static: `tayf-static-${SW_VERSION}`,
  pages: `tayf-pages-${SW_VERSION}`,
  shell: `tayf-shell-${SW_VERSION}`,
  saved: "tayf-saved-v1", // own format version: survives SW_VERSION bumps so pins are not wiped
  meta: `tayf-meta-${SW_VERSION}`, // "could not pin" markers (key = cluster url, value = cached-at stamp only)
} as const;
export const HEADER_CACHED_AT = "x-tayf-cached-at";
export const HEADER_TITLE = "x-tayf-title"; // encodeURIComponent(title)
export const SYNC_MAX_IDS = 500;
export const CLUSTER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type SwMessage =
  | { type: "tayf:pin"; id: string }
  | { type: "tayf:unpin"; id: string }
  | { type: "tayf:sync"; ids: string[] };
export function clusterPath(id: string): string | null {
  return typeof id === "string" && CLUSTER_ID_RE.test(id) ? `/cluster/${id.toLowerCase()}` : null;
}
