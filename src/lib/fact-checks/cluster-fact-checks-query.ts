import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { createServerClient } from "@/lib/supabase/server";
import { FACT_CHECK_PUBLISHERS, type FactCheckPublisherKey } from "./feeds";
import { isAllowedFactCheckUrl } from "./normalize";

export interface ClusterFactCheck {
  id: string;
  publisher: FactCheckPublisherKey;
  publisherLabel: string;
  url: string;
  title: string;
  dateLabel: string;
  score: number;
}

/**
 * Kill switch: `FACT_CHECK_BOX=off` disables the whole feature with ZERO
 * queries (see `getClusterFactChecks` below). MUST be read outside any
 * "use cache" boundary -- see `isFramingReceiptPublic`'s doc comment for
 * why a cached read of `process.env` would freeze a stale flag forever.
 */
export function isFactCheckBoxEnabled(): boolean {
  return process.env.FACT_CHECK_BOX !== "off";
}

const DATE_FORMATTER = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Europe/Istanbul",
});

// PostgREST returns an embedded to-one FK select as an object normally, but
// as a single-element array under some query shapes (aggregate/count
// contexts, certain client versions). Accept both.
type FactCheckEmbed =
  | {
      id: string;
      publisher: string;
      url: string;
      title: string;
      published_at: string;
      is_published: boolean;
    }
  | null;

interface ClusterFactCheckRow {
  score: number;
  fact_checks: FactCheckEmbed | FactCheckEmbed[];
}

function normalizeEmbed(embed: FactCheckEmbed | FactCheckEmbed[]): FactCheckEmbed {
  return Array.isArray(embed) ? (embed[0] ?? null) : embed;
}

/**
 * The raw, uncached read. THROWS on a Supabase error -- mirroring
 * search-query.ts's fetch/cache split -- so a transient Supabase failure
 * (or a deploy that shipped before migration 080 landed) can never be
 * memoised as "this cluster has no fact-checks" for the whole cluster-feed
 * cache window: `getClusterFactChecksCached` wraps it in `attemptCached` and
 * only then picks the lifetime. An empty array from a SUCCESSFUL query (the
 * overwhelming majority of clusters) is legitimately cached.
 */
async function readClusterFactChecks(
  clusterId: string,
): Promise<ClusterFactCheck[]> {
  const supabase = createServerClient();

  const { data, error } = await supabase
    .from("cluster_fact_checks")
    .select(
      "score, fact_checks!inner ( id, publisher, url, title, published_at, is_published )",
    )
    .eq("cluster_id", clusterId)
    .eq("is_published", true)
    .eq("fact_checks.is_published", true)
    .order("score", { ascending: false })
    .limit(3);

  if (error) {
    throw new Error(`[fact-checks] cluster-fact-checks-query error: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as ClusterFactCheckRow[];
  const out: ClusterFactCheck[] = [];

  for (const row of rows) {
    const fc = normalizeEmbed(row.fact_checks);
    if (!fc) continue;

    const publisherKey = fc.publisher as FactCheckPublisherKey;
    const publisher = FACT_CHECK_PUBLISHERS[publisherKey];
    if (!publisher) continue;

    // Defence in depth: re-validate the stored URL against the publisher's
    // allow-list at read time, even though the cron only ever writes
    // allowed URLs. Drop silently rather than ever rendering a bad link.
    if (!isAllowedFactCheckUrl(fc.url, publisher)) continue;

    out.push({
      id: fc.id,
      publisher: publisherKey,
      publisherLabel: publisher.label,
      url: fc.url,
      title: fc.title,
      dateLabel: DATE_FORMATTER.format(new Date(fc.published_at)),
      score: row.score,
    });
  }

  return out;
}

// `attemptCached` keeps a failed read from crossing the `"use cache"`
// boundary (a throw there fails `next build`'s prerender) and lets the
// lifetime follow the outcome: a successful read -- an empty list included --
// keeps `cluster-feed`; a failed attempt is memoised for `minutes` only. Exactly
// one `cacheLife` per invocation, after the attempt; `cacheTag` first.
async function getClusterFactChecksCached(clusterId: string) {
  "use cache";
  cacheTag("fact-checks", `fact-checks:${clusterId}`);
  const r = await attemptCached("fact-checks", () => readClusterFactChecks(clusterId));
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("cluster-feed");
  else cacheLife("minutes");
  return r;
}

/**
 * Public entry point. Flag off -> `[]` with ZERO Supabase queries (the
 * cluster page is the hottest route on the site; this must stay free on
 * the common path, so the flag check stays first, outside the cache). A failed
 * read (missing table pre-migration, a Supabase blip) is logged and resolves
 * to `[]` so the page is never affected by this feature failing; there is no
 * live retry, the next request after `minutes` reads again.
 */
export async function getClusterFactChecks(
  clusterId: string,
): Promise<ClusterFactCheck[]> {
  if (!isFactCheckBoxEnabled()) return [];
  const r = await getClusterFactChecksCached(clusterId);
  if (r.ok) return r.data;
  console.warn("[fact-checks] cluster-fact-checks-query failed:", r.error);
  return [];
}
