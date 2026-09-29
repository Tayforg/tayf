import { createServerClient } from "@/lib/supabase/server";
import { createRateLimiter } from "@/lib/rate-limit";
import { siteUrl } from "@/lib/site-url";

// IndexNow pings (Bing, Yandex, ...) for freshly (re)clustered stories.
// A complete no-op unless INDEXNOW_KEY is set to a valid key in production.
// See docs/indexnow.md. Never logs the key.

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export const INDEXNOW_KEY_PATH = "/indexnow-key.txt";
export const INDEXNOW_KEY_RE = /^[A-Za-z0-9-]{8,128}$/;
export const BATCH_MAX = 100;
export const DEDUPE_TTL_MS = 12 * 60 * 60 * 1000;
export const TIMEOUT_MS = 5000;
export const COOLDOWN_MS = 60 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 5000;
const CLUSTER_TAG_RE = /^cluster-detail:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

type Env = Record<string, string | undefined>;

export type IndexNowStatus =
  | "disabled"
  | "empty"
  | "rate-limited"
  | "cooldown"
  | "sent"
  | "rejected"
  | "error";

export interface IndexNowResult {
  status: IndexNowStatus;
  count: number;
  httpStatus?: number;
}

export function readIndexNowKey(env: Env = process.env): string | null {
  const key = env.INDEXNOW_KEY;
  return typeof key === "string" && INDEXNOW_KEY_RE.test(key) ? key : null;
}

export function indexNowEnabled(env: Env = process.env): boolean {
  if (!readIndexNowKey(env)) return false;
  if (!siteUrl().startsWith("https://")) return false;
  const vercelEnv = env.VERCEL_ENV;
  return vercelEnv === undefined || vercelEnv === "" || vercelEnv === "production";
}

export function clusterIdsFromTags(tags: readonly string[]): string[] {
  const ids: string[] = [];
  for (const tag of tags) {
    const m = CLUSTER_TAG_RE.exec(tag);
    if (m) ids.push(m[1]!);
  }
  return ids;
}

export function buildIndexNowPayload(base: string, key: string, urls: string[]) {
  return {
    host: new URL(base).host,
    key,
    keyLocation: `${base}${INDEXNOW_KEY_PATH}`,
    urlList: urls,
  };
}

// Process-local state (per serverless instance).
const pinged = new Map<string, number>();
let cooldownUntil = 0;
const limiter = createRateLimiter("indexnow", { capacity: 2, refillPerSecond: 1 / 30 });

function markPinged(ids: string[], now: number): void {
  for (const id of ids) {
    pinged.delete(id); // re-insert so Map order stays oldest-first
    pinged.set(id, now);
  }
  while (pinged.size > DEDUPE_MAX_ENTRIES) {
    const oldest = pinged.keys().next().value;
    if (oldest === undefined) break;
    pinged.delete(oldest);
  }
}

export interface IndexNowDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export async function pingIndexNowForClusters(
  ids: readonly string[],
  deps: IndexNowDeps = {},
): Promise<IndexNowResult> {
  try {
    const key = readIndexNowKey();
    if (!key || !indexNowEnabled()) return { status: "disabled", count: 0 };

    const now = (deps.now ?? Date.now)();
    const fresh = Array.from(new Set(ids)).filter((id) => {
      const at = pinged.get(id);
      return at === undefined || now - at >= DEDUPE_TTL_MS;
    });
    if (fresh.length === 0) return { status: "empty", count: 0 };

    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("clusters")
      .select("id")
      .in("id", fresh.slice(0, BATCH_MAX))
      .eq("is_archived", false)
      .gte("article_count", 2);
    if (error) throw new Error(`eligibility query failed: ${error.message}`);
    const eligible = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (eligible.length === 0) return { status: "empty", count: 0 };

    if (!limiter("global").allowed) {
      return { status: "rate-limited", count: eligible.length };
    }
    if (now < cooldownUntil) return { status: "cooldown", count: eligible.length };

    const base = siteUrl();
    const payload = buildIndexNowPayload(
      base,
      key,
      eligible.map((id) => `${base}/cluster/${id}`),
    );
    const res = await (deps.fetch ?? fetch)(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    console.log(`[indexnow] sent ${eligible.length} url(s) → ${res.status}`);

    if (res.status === 200 || res.status === 202) {
      markPinged(eligible, now);
      return { status: "sent", count: eligible.length, httpStatus: res.status };
    }
    if (res.status === 403 || res.status === 422 || res.status === 429) {
      cooldownUntil = now + COOLDOWN_MS;
      return { status: "rejected", count: eligible.length, httpStatus: res.status };
    }
    return { status: "error", count: eligible.length, httpStatus: res.status };
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    console.warn(`[indexnow] ping failed (${name})`);
    return { status: "error", count: 0 };
  }
}
