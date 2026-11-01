import { cache } from "react";
import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";

import type { ZoneHistoryEntry } from "@/components/source/label-card";
import { attemptCached } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";
import { repairEntityResidue } from "../../../supabase/functions/_shared/rss/entities";
import { isValidSourceSlug } from "@/lib/validation/source-input";
import type { BiasCategory, Source } from "@/types";

// Data layer for /source/[slug] (single-source profile page).
//
// Why this is its own module: the page used to do the read inside a
// `"use cache"` function that THREW on a Supabase error. That is wrong in two
// ways on a cold Micro database (4 s reader cap -> AbortError):
//   1. a throw across the `"use cache"` boundary fails `next build`'s
//      prerender (see src/lib/cache-resilience.ts), and
//   2. the page's callers could not tell "the read timed out" from "there is
//      no such source", so a timeout risked rendering the 404 for a real
//      source.
// Here the cached body never throws (`attemptCached`), picks its lifetime from
// the outcome, and the public entry point only ever returns `null` for "no
// such source" - a sustained failure THROWS so the root error boundary
// (src/app/error.tsx: noindex, "Tekrar dene") renders instead of a 404.

export interface ArticleRow {
  id: string;
  title: string;
  description: string | null;
  url: string;
  image_url: string | null;
  published_at: string;
}

// S-20/M-04 registry columns (migration 055) - not yet on the shared
// `Source` type, so extended locally here rather than editing `@/types`.
interface SourceRegistryFields {
  zone_rationale: string | null;
  zone_rationale_at: string | null;
  trustee_since: string | null;
  trustee_note: string | null;
}

export type SourceWithRegistry = Source & SourceRegistryFields;

export interface ZoneHistoryRow {
  old_bias: string | null;
  new_bias: string;
  reason: string | null;
  rater: string | null;
  changed_at: string;
}

export interface SourceProfile {
  source: SourceWithRegistry;
  articleCount7d: number;
  articles: ArticleRow[];
  zoneHistory: ZoneHistoryEntry[];
}

// Uncached implementation. THROWS on a source, count or articles query error
// (never returns null for a failure); returns null only when no row matches
// the slug. A zone-history failure is deliberately non-fatal.
async function fetchSourceProfile(slug: string): Promise<SourceProfile | null> {
  const supabase = createReaderClient();

  const { data: sourceRow, error: sourceError } = await supabase
    .from("sources")
    .select(
      "id, name, slug, url, rss_url, bias, logo_url, active, image_allowed, excerpt_allowed, zone_rationale, zone_rationale_at, trustee_since, trustee_note",
    )
    .eq("slug", slug)
    .maybeSingle();

  // `maybeSingle` returns null (not an error) when no row matches; only a
  // genuine query failure should throw. notFound() is handled by the page.
  if (sourceError) {
    throw new Error(`source query failed: ${sourceError.message}`);
  }
  if (!sourceRow) return null;

  const source = sourceRow as SourceWithRegistry;

  // Three read-only fetches that depend only on source.id - fire in
  // parallel (one round-trip). The 7-day count uses head/exact to avoid
  // pulling row bodies; the recent-articles list is capped at 20 to keep
  // the payload small; the zone-history list is capped at 20, newest
  // first.
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [countResult, articlesResult, historyResult] = await Promise.all([
    supabase
      .from("articles")
      .select("id", { count: "exact", head: true })
      .eq("source_id", source.id)
      .gte("published_at", sevenDaysAgo),
    supabase
      .from("articles")
      .select("id, title, description, url, image_url, published_at")
      .eq("source_id", source.id)
      .order("published_at", { ascending: false })
      .limit(20),
    supabase
      .from("source_zone_history")
      .select("old_bias, new_bias, reason, rater, changed_at")
      .eq("source_id", source.id)
      .order("changed_at", { ascending: false })
      .limit(20),
  ]);

  if (countResult.error) {
    throw new Error(`count query failed: ${countResult.error.message}`);
  }
  if (articlesResult.error) {
    throw new Error(`articles query failed: ${articlesResult.error.message}`);
  }
  // Deliberately non-fatal, unlike the two checks above: a
  // source_zone_history read failure renders the card without a history
  // list (LabelCard's own empty state) rather than failing the whole
  // profile over a secondary, non-essential fetch. Still logged (not
  // swallowed) so a permanently-broken query doesn't silently masquerade
  // as the honest "Bu etiket hiç değişmedi." empty state forever.
  if (historyResult.error) {
    console.error(
      "[source-profile] zone history query failed",
      historyResult.error,
    );
  }
  const zoneHistory: ZoneHistoryEntry[] = historyResult.error
    ? []
    : ((historyResult.data ?? []) as ZoneHistoryRow[]).map((row) => ({
        oldBias: row.old_bias as BiasCategory | null,
        newBias: row.new_bias as BiasCategory,
        reason: row.reason,
        rater: row.rater,
        changedAt: row.changed_at,
      }));

  return {
    source,
    articleCount7d: countResult.count ?? 0,
    // Read-time repair of double-encoded feed residue ("&quot;", "&#39;"):
    // rows stored before the ingest fix still carry it. Pure and non-throwing,
    // so it is safe inside the "use cache" body.
    articles: ((articlesResult.data ?? []) as ArticleRow[]).map((a) => ({
      ...a,
      title: repairEntityResidue(a.title),
      description:
        typeof a.description === "string"
          ? repairEntityResidue(a.description)
          : null,
    })),
    zoneHistory,
  };
}

// Cached entry. Never throws (`attemptCached`): a failure is returned as
// `{ ok: false }` and memoised only for `minutes`; a success - including the
// legitimate "no such source" `null` - keeps the normal source-directory
// lifetime. Exactly ONE `cacheLife` per invocation, chosen after the attempt.
// The clock read inside `fetchSourceProfile` is inside this cache scope.
async function getSourceProfileCached(slug: string) {
  "use cache";
  cacheTag("sources", "articles");
  const r = await attemptCached("source-profile", () => fetchSourceProfile(slug));
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("source-directory");
  else cacheLife("minutes");
  return r;
}

/**
 * Source profile for /source/[slug] (and its metadata). `null` means exactly
 * one thing: no such source (or a slug that can never be one). A sustained
 * read failure - the cached attempt AND one live retry both failing - THROWS,
 * so the caller renders the error boundary rather than a 404. React `cache`
 * dedupes the page body and `generateMetadata` within a request.
 */
export const getSourceProfile = cache(
  async (slug: string): Promise<SourceProfile | null> => {
    // Cheap guard: a slug the registry can never contain is a clean 404 and
    // must not cost a database round-trip.
    if (!isValidSourceSlug(slug)) return null;

    const attempt = await getSourceProfileCached(slug);
    if (attempt.ok) return attempt.data;

    // The live retry reads the clock (7-day window); Next 16 prerender forbids
    // that in an uncached path, so opt this request into dynamic rendering
    // first. Only reached after a failed cached attempt.
    await connection();
    return fetchSourceProfile(slug);
  },
);
