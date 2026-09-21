import { createServerClient } from "@/lib/supabase/server";

/**
 * Pack E / B11 — the /admin "API anahtarları" section's reader. Mirrors
 * src/lib/admin/jev-shadow-status.ts's rationale: /admin is cookie-gated
 * and dynamic, so this is a plain async fetcher, NOT "use cache". Never
 * throws — a missing migration or a Supabase hiccup renders as a status
 * sentence on the page, never a 500. `null` means "could not read".
 *
 * The plaintext key is NEVER available here (api_keys only stores its
 * sha256 hash) — this reader cannot leak it even by accident.
 */

export interface ApiKeyRow {
  id: number;
  label: string;
  tier: "free" | "partner";
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  calls7d: number;
}

const API_KEYS_LIST_LIMIT = 50;
const USAGE_WINDOW_DAYS = 7;

function utcDayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface RawKeyRow {
  id: number | string;
  label: string | null;
  tier: string | null;
  created_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

interface RawUsageRow {
  key_id: number | string;
  day: string;
  calls: number | string;
}

export async function getApiKeysStatus(): Promise<ApiKeyRow[] | null> {
  try {
    const supabase = createServerClient();

    // USAGE_WINDOW_DAYS - 1: `.gte("day", sinceDay)` is inclusive of today,
    // so subtracting the full window would span 8 UTC days, not 7.
    const since = new Date(Date.now() - (USAGE_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000);
    const sinceDay = utcDayString(since);

    const keysRes = await supabase
      .from("api_keys")
      .select("id, label, tier, created_at, revoked_at, last_used_at")
      .order("created_at", { ascending: false })
      .limit(API_KEYS_LIST_LIMIT);

    if (keysRes.error) {
      console.error(`[admin] api keys status unavailable: ${keysRes.error.message}`);
      return null;
    }

    const keys = Array.isArray(keysRes.data) ? (keysRes.data as RawKeyRow[]) : [];
    if (keys.length === 0) return [];

    // Sequenced after `keys` (not Promise.all'd) so this query can be
    // scoped to exactly the key ids the sibling query listed, with an
    // explicit `.limit()` — without both, PostgREST's implicit row ceiling
    // can silently truncate rows for keys outside the 50 listed above,
    // under-reporting calls7d with no error.
    const usageRes = await supabase
      .from("api_key_usage_daily")
      .select("key_id, day, calls")
      .gte("day", sinceDay)
      .in("key_id", keys.map((k) => Number(k.id)))
      .limit(API_KEYS_LIST_LIMIT * USAGE_WINDOW_DAYS);

    if (usageRes.error) {
      console.error(`[admin] api keys usage unavailable: ${usageRes.error.message}`);
      return null;
    }

    const usage = Array.isArray(usageRes.data) ? (usageRes.data as RawUsageRow[]) : [];

    const callsByKey = new Map<number, number>();
    for (const row of usage) {
      const keyId = Number(row.key_id);
      const calls = Number(row.calls);
      if (!Number.isFinite(keyId)) continue;
      callsByKey.set(keyId, (callsByKey.get(keyId) ?? 0) + (Number.isFinite(calls) ? calls : 0));
    }

    return keys.map((row) => {
      const id = Number(row.id);
      return {
        id,
        label: String(row.label ?? ""),
        tier: row.tier === "partner" ? "partner" : "free",
        created_at: String(row.created_at ?? ""),
        revoked_at: row.revoked_at ?? null,
        last_used_at: row.last_used_at ?? null,
        calls7d: callsByKey.get(id) ?? 0,
      };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] api keys status unavailable: ${message}`);
    return null;
  }
}
