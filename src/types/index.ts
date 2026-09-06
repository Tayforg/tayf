export type BiasCategory =
  | "pro_government"
  | "gov_leaning"
  | "state_media"
  | "center"
  | "opposition_leaning"
  | "opposition"
  | "nationalist"
  | "islamist_conservative"
  | "pro_kurdish"
  | "international";

export type MediaDnaZone = "iktidar" | "bagimsiz" | "muhalefet";

export type Stance = "destekliyor" | "tarafsiz" | "elestiriyor" | "sessiz";

export type NewsCategory =
  | "son_dakika"
  | "politika"
  | "dunya"
  | "ekonomi"
  | "spor"
  | "teknoloji"
  | "yasam"
  | "genel";

export const NEWS_CATEGORIES: Record<NewsCategory, { label: string; icon: string }> = {
  son_dakika: { label: "Son Dakika", icon: "Zap" },
  politika: { label: "Politika", icon: "Landmark" },
  dunya: { label: "Dünya", icon: "Globe" },
  ekonomi: { label: "Ekonomi", icon: "TrendingUp" },
  spor: { label: "Spor", icon: "Trophy" },
  teknoloji: { label: "Teknoloji", icon: "Cpu" },
  yasam: { label: "Yaşam", icon: "Heart" },
  genel: { label: "Genel", icon: "Newspaper" },
};

// Mirrors the app-side union of supabase/functions/_shared/cluster/source-kind.ts's
// SOURCE_KINDS ("outlet" | "aggregator" | "wire" | "niche"). Only "outlet" and
// "wire" vote in bias_distribution, blindspot/surprise detection and trends
// (see that contract for the full semantics). Parity with the contract's
// SOURCE_KINDS tuple is asserted in src/lib/bias/config.test.ts and via
// `satisfies` in src/lib/bias/config.ts.
export type SourceKind = "outlet" | "aggregator" | "wire" | "niche";

export interface Source {
  id: string;
  name: string;
  slug: string;
  url: string;
  rss_url: string;
  bias: BiasCategory;
  logo_url: string | null;
  active: boolean;
  /**
   * Optional at the type level (not on the DB column, which is
   * `NOT NULL DEFAULT 'outlet'` as of migration 034) so fixtures and legacy
   * selects that omit `kind` keep compiling — ownership-line, opengraph-image,
   * cross-spectrum, framing/read-across tests all build `Source` literals
   * without it. Readers never branch on `source.kind` directly; they call
   * `normalizeSourceKind` / `isVotingSource`, which treat undefined the same
   * as "outlet" (a voting kind).
   */
  kind?: SourceKind;
}

export interface Article {
  id: string;
  source_id: string;
  title: string;
  description: string | null;
  url: string;
  image_url: string | null;
  published_at: string;
  content_hash: string;
  category: NewsCategory;
  created_at: string;
  source?: Source;
}

export type BiasDistribution = Record<BiasCategory, number>;

export interface Cluster {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  title_en: string;
  summary_tr: string;
  summary_en: string;
  bias_distribution: BiasDistribution;
  is_blindspot: boolean;
  blindspot_side: BiasCategory | null;
  article_count: number;
  first_published: string;
  created_at: string;
  updated_at: string;
  articles?: Article[];
}

export interface Story {
  id: string;
  slug: string;
  title_tr: string;
  summary_tr: string;
  display_order: number;
  created_at: string;
}

export interface StoryStance {
  story_id: string;
  source_id: string;
  stance: Stance;
  note: string | null;
}

export interface StoryWithStances extends Story {
  stances: Array<StoryStance & { source: Source }>;
}
