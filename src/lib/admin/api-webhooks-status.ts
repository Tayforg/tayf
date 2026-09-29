import { createServerClient } from "@/lib/supabase/server";

/**
 * Reader for the /admin/api-webhooks page (migration 097). Same discipline as
 * api-keys-status.ts: plain async fetcher, never throws, `null` means "could
 * not read" (a missing migration renders as a sentence, not a 500).
 *
 * The signing secret is NEVER selected here, and the URL is reduced to its
 * host before it leaves this module: a path or query string can itself carry
 * a receiver's token.
 */

export interface ApiWebhookStatusRow {
  key_id: number;
  host: string | null;
  enabled: boolean;
  fail_streak: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_status: number | null;
  disabled_reason: string | null;
}

const LIST_LIMIT = 100;

interface RawRow {
  key_id: number | string;
  url: string | null;
  enabled: boolean | null;
  fail_streak: number | string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_status: number | string | null;
  disabled_reason: string | null;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export async function getApiWebhooksStatus(): Promise<ApiWebhookStatusRow[] | null> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("api_key_webhooks")
      .select(
        "key_id, url, enabled, fail_streak, last_success_at, last_failure_at, last_status, disabled_reason",
      )
      .order("key_id", { ascending: true })
      .limit(LIST_LIMIT);
    if (error) {
      console.error(`[admin] api webhooks status unavailable: ${error.message}`);
      return null;
    }
    const rows = Array.isArray(data) ? (data as unknown as RawRow[]) : [];
    return rows.map((r) => ({
      key_id: Number(r.key_id),
      host: hostOf(r.url),
      enabled: r.enabled === true,
      fail_streak: Number(r.fail_streak ?? 0) || 0,
      last_success_at: r.last_success_at ?? null,
      last_failure_at: r.last_failure_at ?? null,
      last_status: r.last_status === null || r.last_status === undefined ? null : Number(r.last_status),
      disabled_reason: r.disabled_reason ?? null,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] api webhooks status unavailable: ${message}`);
    return null;
  }
}
