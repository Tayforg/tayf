import { BLINDSPOT, isVotingKind, tallyZones } from "@/lib/bias/config";
import type { ZoneTally } from "../../../supabase/functions/_shared/cluster/blindspot";
import type { BiasCategory, NewsCategory, SourceKind } from "@/types";

// Pure filtering/tallying logic for /blindspots, extracted from page.tsx so
// it can be unit-tested independently of the DB fetch and JSX.

export type EmbeddedSource = {
  id: string;
  name: string;
  bias: BiasCategory;
  // Optional so the existing `sources(id, bias)` fixtures (no kind column)
  // keep compiling. `zoneTallyOf` treats a missing/null kind as voting via
  // `isVotingKind`.
  kind?: SourceKind | null;
};

export type EmbeddedArticle = {
  id: string;
  title: string;
  url: string;
  image_url: string | null;
  published_at: string;
  source_id: string;
  category: NewsCategory;
  content_hash: string | null;
  sources: EmbeddedSource | null;
};

type FeedCluster = {
  title_tr: string;
};

type FeedFilterResult = {
  ok: boolean;
  reason?: "min_sources" | "seo_pattern" | "wire_dedup" | "dunya_share" | "politics_share";
};

const POLITICS_CATEGORIES: readonly NewsCategory[] = ["politika", "son_dakika"];

// A5 fix #3: "kimdir / kaç yaşında / son dakika: / canlı / ne dedi" titles are SEO explainers, not coverage gaps.
const SEO_PATTERN =
  /kimdir|kaç yaşında|nedir\?|ne zaman|kaç bin|kaç tl|son dakika.*?:|canlı|ne dedi/i;

// A5 fix #4: below this share of distinct content_hashes, the cluster is one wire copy amplified by N outlets.
const WIRE_UNIQUE_HASH_RATIO = 0.5;

// A5 fix #5: above this dunya share, the substance is foreign affairs, not domestic politics.
const DUNYA_CATEGORY_SHARE_LIMIT = 0.5;

// Soft topical floor: majority of deduped members must be politics/breaking-news.
const POLITICS_CATEGORY_SHARE_MIN = 0.6;

// Earliest article per source, so a single prolific outlet can't inflate its own zone's share.
export function dedupeBySource(members: EmbeddedArticle[]): EmbeddedArticle[] {
  const sortedAsc = [...members].sort(
    (a, b) => new Date(a.published_at).getTime() - new Date(b.published_at).getTime()
  );
  const seen = new Set<string>();
  const deduped: EmbeddedArticle[] = [];
  for (const m of sortedAsc) {
    const sid = m.sources?.id ?? m.source_id;
    if (seen.has(sid)) continue;
    seen.add(sid);
    deduped.push(m);
  }
  return deduped;
}

export function passesFeedFilters(
  cluster: FeedCluster,
  deduped: EmbeddedArticle[]
): FeedFilterResult {
  if (deduped.length < BLINDSPOT.minSources) return { ok: false, reason: "min_sources" };
  if (SEO_PATTERN.test(cluster.title_tr)) return { ok: false, reason: "seo_pattern" };

  const distinctHashes = new Set(
    deduped.map((m) => m.content_hash ?? `__null__:${m.id}`)
  ).size;
  if (distinctHashes / deduped.length < WIRE_UNIQUE_HASH_RATIO) {
    return { ok: false, reason: "wire_dedup" };
  }

  const dunyaCount = deduped.filter((m) => m.category === "dunya").length;
  if (dunyaCount / deduped.length > DUNYA_CATEGORY_SHARE_LIMIT) {
    return { ok: false, reason: "dunya_share" };
  }

  const politicsHits = deduped.filter((m) =>
    POLITICS_CATEGORIES.includes(m.category)
  ).length;
  if (politicsHits / deduped.length < POLITICS_CATEGORY_SHARE_MIN) {
    return { ok: false, reason: "politics_share" };
  }

  return { ok: true };
}

export function zoneTallyOf(deduped: EmbeddedArticle[]): ZoneTally {
  const dist: Partial<Record<BiasCategory, number>> = {};
  for (const m of deduped) {
    // Non-voting kinds (aggregator, niche) are cluster members but never
    // vote — they don't count toward bias_distribution, blindspot/surprise
    // detection or the live tally here.
    if (!m.sources || !isVotingKind(m.sources.kind)) continue;
    dist[m.sources.bias] = (dist[m.sources.bias] ?? 0) + 1;
  }
  return tallyZones(dist);
}
