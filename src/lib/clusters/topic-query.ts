import type { Metadata } from "next";
import { cacheLife, cacheTag } from "next/cache";

import {
  buildClusterBundle,
  CLUSTER_EMBED_SELECT,
  flattenClusterMembers,
  type ClusterBundle,
  type EmbeddedClusterRow,
} from "@/lib/clusters/politics-query";
import { getZoneFeedHealth } from "@/lib/clusters/feed-health";
import { createServerClient } from "@/lib/supabase/server";
import { siteUrl } from "@/lib/site-url";

// Topic-hub read for /konu and /konu/[slug] (Pack C, "Konu", migration 067's
// clusters.topic7 / topic7_p / topic7_n). Reuses politics-query's embedded
// select and bundle builder so hub cards render identically to the home
// feed, and feed-health.ts's getZoneFeedHealth so a blindspot badge on a
// hub never disagrees with the home feed about the same cluster.
//
// Error discipline (deliberate, differs from politics-query.ts's throw):
// getTopicClusters / getTopicCounts carry the "use cache" boundary
// themselves and RETURN NULL on a Supabase error or a thrown exception —
// they never rethrow. This is weekly-query.ts's pattern
// (src/lib/weekly/weekly-query.ts:28-37), not politics-query's, and the
// reason is generateStaticParams: these routes are prerendered, and a
// throw inside "use cache" fails `next build` for every hub the moment
// Supabase blinks. `null` ("could not read, render the unavailable state")
// and `[]` ("read fine, nothing matched, render the empty state") are
// deliberately different answers and the page renders different copy for
// each — see /konu/[slug]/page.tsx.

/** The six hub slugs. `politika` is deliberately absent: it is a valid
 *  clusters.topic7 value but has no hub — /konu/politika 308s to "/", which
 *  already IS the politics feed. */
export const TOPIC_SLUGS = [
  "dunya",
  "ekonomi",
  "spor",
  "yasam",
  "teknoloji",
  "genel",
] as const;
export type TopicSlug = (typeof TOPIC_SLUGS)[number];

/** Slugs that exist in the data but redirect instead of rendering. */
export const TOPIC_REDIRECT_SLUGS = ["politika"] as const;

export const TOPIC_LABELS_TR: Record<TopicSlug, string> = {
  dunya: "Dünya",
  ekonomi: "Ekonomi",
  spor: "Spor",
  yasam: "Yaşam",
  teknoloji: "Teknoloji",
  genel: "Genel",
};

export const TOPIC_PAGE_SIZE = 30;
export const TOPIC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard ceiling on ?sayfa= so the "use cache" key space stays finite. */
export const TOPIC_MAX_PAGE = 20;

/** Honest-note copy. The page renders TOPIC_NOTE_PREFIX then a <Link
 *  href="/metodoloji"> whose text is TOPIC_NOTE_LINK_LABEL. */
export const TOPIC_NOTE_PREFIX =
  "Konu etiketleri otomatik atanır (Jev, eşik 0,8) — ";
export const TOPIC_NOTE_LINK_LABEL = "yöntem";

const TOPIC_SLUG_SET: ReadonlySet<string> = new Set(TOPIC_SLUGS);

export function isTopicSlug(value: string): value is TopicSlug {
  return TOPIC_SLUG_SET.has(value);
}

export interface TopicClustersPage {
  bundles: ClusterBundle[];
  /** True when a (page + 1) exists. Derived from an extra fetched row — this
   *  module never claims a total it did not count. */
  hasMore: boolean;
  page: number;
}

/** Exported: page.tsx clamps BEFORE calling the cached fetcher so the
 *  "use cache" key space stays finite (see TOPIC_MAX_PAGE above). Also kept
 *  as the in-fetcher clamp below, as defence in depth. */
export function clampTopicPage(page: number): number {
  const truncated = Number.isFinite(page) ? Math.trunc(page) : 1;
  return Math.min(TOPIC_MAX_PAGE, Math.max(1, truncated || 1));
}

/** null = could not read (render the unavailable state).
 *  { bundles: [] } = read fine, nothing matched (render the empty state). */
export async function getTopicClusters(
  slug: TopicSlug,
  page: number,
): Promise<TopicClustersPage | null> {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag("clusters-politics");

  const clampedPage = clampTopicPage(page);

  try {
    const supabase = createServerClient();
    // One clock read: two `Date.now()` calls could straddle a tick and
    // leave the window a millisecond wider than TOPIC_WINDOW_MS.
    const nowMs = Date.now();
    const sinceIso = new Date(nowMs - TOPIC_WINDOW_MS).toISOString();
    const from = (clampedPage - 1) * TOPIC_PAGE_SIZE;

    // Blindspot badges on a hub can never disagree with the home feed —
    // same feed-health gate, fetched once per page build.
    const health = await getZoneFeedHealth();

    const { data, error } = await supabase
      .from("clusters")
      .select(CLUSTER_EMBED_SELECT)
      .eq("is_archived", false)
      .eq("topic7", slug)
      .gte("updated_at", sinceIso)
      .order("updated_at", { ascending: false })
      // Tiebreaker: clusters.updated_at is stamped now() by cluster_link_atomic
      // (migration 027), so members linked in one transaction can share a
      // timestamp. Without a unique second key, OFFSET pagination over ties
      // can duplicate one cluster on the next page while hiding another.
      // clusters.id is the uuid primary key (003_create_clusters.sql:2).
      .order("id", { ascending: false })
      // PAGE_SIZE + 1 rows: the extra one IS hasMore.
      .range(from, from + TOPIC_PAGE_SIZE)
      .returns<EmbeddedClusterRow[]>();

    if (error) {
      console.error("[konu] clusters unavailable:", {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      });
      return null;
    }

    const rows = data ?? [];
    const hasMore = rows.length > TOPIC_PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, TOPIC_PAGE_SIZE) : rows;

    const bundles: ClusterBundle[] = [];
    for (const row of pageRows) {
      const members = flattenClusterMembers(row);
      if (members.length === 0) continue;
      bundles.push(buildClusterBundle(row, members, health).bundle);
    }

    return { bundles, hasMore, page: clampedPage };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[konu] clusters unavailable: ${message}`);
    return null;
  }
}

/** 7-day cluster count per hub slug. null = could not read; the index page
 *  then renders the six links with no numbers rather than zeros. */
export async function getTopicCounts(): Promise<Record<
  TopicSlug,
  number
> | null> {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag("clusters-politics");

  try {
    const supabase = createServerClient();
    const nowMs = Date.now();
    const sinceIso = new Date(nowMs - TOPIC_WINDOW_MS).toISOString();

    const results = await Promise.all(
      TOPIC_SLUGS.map((slug) =>
        supabase
          .from("clusters")
          .select("id", { count: "exact", head: true })
          .eq("is_archived", false)
          .eq("topic7", slug)
          .gte("updated_at", sinceIso),
      ),
    );

    const counts = {} as Record<TopicSlug, number>;
    for (let i = 0; i < TOPIC_SLUGS.length; i++) {
      const slug = TOPIC_SLUGS[i]!;
      const result = results[i]!;
      if (result.error) {
        console.error("[konu] counts unavailable:", {
          message: result.error.message,
          code: result.error.code,
          details: result.error.details,
          hint: result.error.hint,
        });
        return null;
      }
      // A successful PostgREST response can still carry count: null (no
      // total in Content-Range). Treat that exactly like the error branch —
      // ?? 0 here would render "son 7 günde 0 küme", a zero this module did
      // not actually count.
      if (result.count === null) {
        console.error("[konu] counts unavailable: null count for", slug);
        return null;
      }
      counts[slug] = result.count;
    }

    return counts;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[konu] counts unavailable: ${message}`);
    return null;
  }
}

/** Pure. schema.org CollectionPage + ItemList of absolute /cluster/<id> URLs. */
export function buildTopicCollectionPage(args: {
  slug: TopicSlug;
  bundles: ClusterBundle[];
}): Record<string, unknown> {
  const { slug, bundles } = args;
  const base = siteUrl();
  const label = TOPIC_LABELS_TR[slug];

  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${label} haberleri`,
    url: `${base}/konu/${slug}`,
    isPartOf: {
      "@type": "WebSite",
      name: "Tayf",
      url: base,
    },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: bundles.length,
      itemListElement: bundles.map((b, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: b.cluster.title_tr,
        url: `${base}/cluster/${b.cluster.id}`,
      })),
    },
  };
}

/** Pure. The exact Metadata object /konu/[slug] exports. */
export function topicMetadata(slug: TopicSlug): Metadata {
  const label = TOPIC_LABELS_TR[slug];

  return {
    // Plain title — the root layout's `title.template = "%s — Tayf"` adds
    // the suffix automatically, rendering "Dünya haberleri — Tayf". The
    // package spec's literal "Dünya haberleri | Tayf" predates that
    // template; a hard-coded pipe would be the only page on the site using
    // one, so the template supplies the brand instead (flagged deviation,
    // see the pack report).
    title: `${label} haberleri`,
    description: `Son 7 günde ${label} başlığı altında kümelenen haberler. Konu etiketleri otomatik atanır (Jev, eşik 0,8).`,
    alternates: { canonical: `/konu/${slug}` },
    // Deliberately no `openGraph.images` / `twitter.images` key at all —
    // setting one silently disables Next's file-convention
    // `opengraph-image.tsx` (see the seo-3 note in
    // src/app/cluster/[id]/page.tsx:93-114). Deliberately no `robots` key
    // either — omitting it lets the root layout's `index: true, follow:
    // true` inherit.
  };
}
