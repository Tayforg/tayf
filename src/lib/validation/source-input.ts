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

/**
 * Shared boundary checks for the zone-registry admin actions
 * (`set_source_registry` / `set_source_bias`, migration 055). Kept here
 * so the route and its tests both read from one definition.
 */

/** `sources.zone_rationale` — operator-written, 1..1000 chars after trim. */
export function isValidZoneRationale(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 1000;
}

/** `sources.trustee_note` — dated public-source citation, 1..500 chars after trim. */
export function isValidTrusteeNote(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 500;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `sources.trustee_since` — ISO yyyy-mm-dd that round-trips through `Date` (rejects e.g. 2025-02-30). */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === value;
}

/**
 * `set_source_bias`'s `reason` — a bias change can never be recorded
 * without a stated reason, so this is deliberately NOT optional (10..500
 * chars after trim), unlike the other predicates here.
 */
export function isValidZoneChangeReason(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 10 && trimmed.length <= 500;
}

/**
 * `set_source_bias`'s `rater` — a company/public-role handle only, never a
 * person's name (KVKK Board Decision 2021/989): shape-checked here AND
 * fixed to an allow-list, matching the shape-only guard the RPC itself
 * enforces (migration 055).
 */
const RATER_HANDLE_RE = /^[a-z0-9-]{1,32}$/;
const RATER_ALLOWLIST = new Set(["tayf-admin", "editor", "kurul"]);

export function isValidRater(value: unknown): value is string {
  return (
    typeof value === "string" &&
    RATER_HANDLE_RE.test(value) &&
    RATER_ALLOWLIST.has(value)
  );
}
