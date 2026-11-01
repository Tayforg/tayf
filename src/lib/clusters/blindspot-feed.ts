import { BLINDSPOT, isPoliticsMember, isVotingKind, tallyZones } from "@/lib/bias/config";
import type { ZoneTally } from "../../../supabase/functions/_shared/cluster/blindspot";
import type { BiasCategory, NewsCategory, SourceKind } from "@/types";

// Pure filtering/tallying logic for /blindspots, extracted from page.tsx so
// it can be unit-tested independently of the DB fetch and JSX.

export type EmbeddedSource = {
  id: string;
  name: string;
  bias: BiasCategory;
  // browser-3: source favicon for the /blindspots headline rows. Optional so
  // the existing fixtures (no logo_url column in the embed) keep compiling;
  // blindspots-query.ts coalesces a missing value to null.
  logo_url?: string | null;
  // Optional so the existing `sources(id, bias)` fixtures (no kind column)
  // keep compiling. `zoneTallyOf` treats a missing/null kind as voting via
  // `isVotingKind`.
  kind?: SourceKind | null;
  // BL-13 per-source rights flags (migration 047). Optional so existing
  // fixtures predating the columns keep compiling — `undefined` is treated
  // as allowed by the same rule politics-query.ts's buildClusterBundle uses.
  image_allowed?: boolean;
  excerpt_allowed?: boolean;
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
  /** Migration 089 ("ADMIT") — non-null once Jev has admitted this article
   * into political clustering under a live claim. See isPoliticsMember. */
  politics_admitted_at?: string | null;
  sources: EmbeddedSource | null;
};

type FeedCluster = {
  title_tr: string;
};

type FeedFilterResult = {
  ok: boolean;
  reason?: "min_sources" | "seo_pattern" | "wire_dedup" | "dunya_share" | "politics_share";
};

// A5 fix #3 (rewritten for h13-biasdata-4): "kimdir / kaç yaşında / nedir? / ne zaman ...? /
// kaç bin|tl ...? / canlı izle / ne dedi?" titles are SEO explainers, not coverage gaps. The
// first version matched bare substrings (/canlı|ne zaman|son dakika.*?:/i), which also hid real
// stories such as "Son Dakika! Bakan Kurum: ...", "Canlı | Başkan Erdoğan'dan ...",
// "134 canlıya el koydu" and "Kudüs'e ne zaman girileceğini açıkladı" from /blindspots, its RSS
// feed and the alerts feed while their cluster pages still showed "Kör nokta".
//
// Every pattern is word-bounded with Unicode-aware lookarounds (a JS \b is ASCII-only, so
// "canlıya" would still match a \bcanlı\b), and the question forms need their "?".
const NB = String.raw`(?<![\p{L}\p{N}])`; // not preceded by a letter or digit
const NA = String.raw`(?![\p{L}\p{N}])`; // not followed by a letter or digit

const SEO_EXPLAINER_PATTERNS: readonly RegExp[] = [
  `${NB}kimdir${NA}`,
  `${NB}kaç yaşında${NA}`,
  String.raw`${NB}nedir\s*\?`,
  String.raw`${NB}ne zaman${NA}.*\?\s*$`,
  String.raw`${NB}kaç (?:bin|tl)${NA}.*\?\s*$`,
  // "canlı izle" is the stream-page explainer; the bare word "canlı" is not.
  `${NB}canlı izle${NA}`,
  String.raw`${NB}ne dedi\s*\?`,
].map((source) => new RegExp(source, "u"));

// A leading breaking-news label. "canlı izle" is an explainer in its own right, so a leading
// "Canlı izle: ..." is deliberately not treated as a label.
const BREAKING_PREFIX = new RegExp(
  String.raw`^\s*(?:son\s+dakika|canlı(?!\s+izle${NA}))${NA}[\s!.:|…\-–—]*`,
  "u",
);

// Bounds the stripping loop: a title cannot stack labels forever.
const MAX_PREFIX_STRIPS = 3;

function stripBreakingPrefixes(lowered: string): string {
  let t = lowered;
  for (let i = 0; i < MAX_PREFIX_STRIPS; i++) {
    const next = t.replace(BREAKING_PREFIX, "");
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * True for an SEO explainer title ("Ali Koç kimdir?", "Asgari ücret nedir?",
 * "Altın fiyatları canlı izle"), false for a news headline, including one that
 * merely starts with a breaking-news label ("Son Dakika! ...", "Canlı | ...") or
 * contains an explainer stem inside a longer word ("canlıya", "kimdirler").
 *
 * The title is lower-cased with the Turkish locale (CANLI -> canlı, İ -> i). A
 * locale-neutral lower-casing is tried as well so an upper-case title typed with
 * an ASCII I ("ALI KOC KIMDIR?"), which the original /i regex caught, still filters.
 */
export function isSeoExplainerTitle(title: string): boolean {
  if (typeof title !== "string" || title === "") return false;
  const variants = new Set([title.toLocaleLowerCase("tr-TR"), title.toLowerCase()]);
  for (const lowered of variants) {
    const t = stripBreakingPrefixes(lowered);
    if (SEO_EXPLAINER_PATTERNS.some((re) => re.test(t))) return true;
  }
  return false;
}

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
  if (isSeoExplainerTitle(cluster.title_tr)) return { ok: false, reason: "seo_pattern" };

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

  // Migration 089 ("ADMIT"): isPoliticsMember counts a live-admitted member
  // toward politics_share too. The dunya_share gate above is unaffected.
  const politicsHits = deduped.filter((m) => isPoliticsMember(m)).length;
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
