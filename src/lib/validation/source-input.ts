import { BIAS_ORDER, SOURCE_KINDS } from "@/lib/bias/config";
import type { BiasCategory, SourceKind } from "@/types";

/**
 * Syntactic-only boundary checks for the admin "add/update source" API.
 *
 * No network, no DNS, no I/O — these are pure string/URL-shape checks. The
 * runtime DNS-resolution / redirect-pinning SSRF guard that actually decides
 * whether a host is safe to *fetch* lives in the Deno ingest fetcher
 * (supabase/functions/_shared/safe-fetch.ts). This module exists to reject
 * obviously-bad input (schemes, credentials, literal IPs, loopback-ish
 * hostnames) before a row is ever written to `sources`, not to replace that
 * guard.
 */
export const MAX_SOURCE_URL_LENGTH = 512;

const IPV4_LITERAL_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOSTNAME_RE = /^[a-z0-9.-]+$/;
const DISALLOWED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

/**
 * https-only is deliberate: unlike a corrections URL (stored, never
 * fetched — see src/app/api/corrections/route.ts's isValidUrl, which stays
 * http-or-https on purpose), a source's `url` / `rss_url` is fetched
 * server-side on every ingest cron cycle, so we don't accept a scheme that
 * can't carry TLS.
 */
export function isValidSourceUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SOURCE_URL_LENGTH) return false;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;

  const hostname = parsed.hostname;
  if (IPV4_LITERAL_RE.test(hostname)) return false;
  if (hostname.startsWith("[")) return false;

  const lower = hostname.replace(/\.$/, "").toLowerCase();
  if (!HOSTNAME_RE.test(lower)) return false;
  if (!lower.includes(".")) return false;
  if (lower === "localhost") return false;
  if (DISALLOWED_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;

  return true;
}

export function isBiasCategory(value: unknown): value is BiasCategory {
  return typeof value === "string" && (BIAS_ORDER as readonly string[]).includes(value);
}

export function isSourceKindValue(value: unknown): value is SourceKind {
  return typeof value === "string" && (SOURCE_KINDS as readonly string[]).includes(value);
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidSourceSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_RE.test(value);
}

export function isValidSourceName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 120;
}
