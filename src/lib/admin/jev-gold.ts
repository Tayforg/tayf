import { createServerClient } from "@/lib/supabase/server";

// Pack JEV şimdi (migration 063) — the /admin/jev-altin double-labeling
// surface's reader and vocabulary. Mirrors src/lib/admin/jev-shadow-status.ts's
// rationale in spirit: /admin is cookie-gated and dynamic, so both getters
// below are plain async fetchers, NOT "use cache". Neither ever throws: a
// missing migration, a Supabase hiccup, or a bad RPC shape all render as a
// status sentence on the page, never a 500. `null` means "could not read".

export const JEV_LABELER_COOKIE = "jev_labeler";
export const JEV_LABELER_COOKIE_MAX_AGE = 2_592_000; // 30 days

export const JEV_GOLD_MIN_N = 30;
export const JEV_GOLD_NOTE_MAX_LENGTH = 300;

// Pinned against migration 063's jev_gold_labels.topic CHECK list by the
// JEV-A19 guard in tests/migrations/jev-shadow-parity.test.ts (W1) — keep
// this a single-line array literal so the regex finds it.
export const JEV_GOLD_TOPICS = ["politika", "dunya", "ekonomi", "spor", "yasam", "teknoloji", "genel"] as const;

export const JEV_GOLD_TOPIC_LABELS_TR: Record<(typeof JEV_GOLD_TOPICS)[number], string> = {
  politika: "Politika",
  dunya: "Dünya",
  ekonomi: "Ekonomi",
  spor: "Spor",
  yasam: "Yaşam",
  teknoloji: "Teknoloji",
  genel: "Genel",
};

export type JevLabeler = 1 | 2;
export type JevGoldTopic = (typeof JEV_GOLD_TOPICS)[number];

export function isJevLabeler(v: unknown): v is JevLabeler {
  return v === 1 || v === 2;
}

export function isJevGoldTopic(v: unknown): v is JevGoldTopic {
  return typeof v === "string" && (JEV_GOLD_TOPICS as readonly string[]).includes(v);
}

/**
 * A missing / non-"2" cookie is not an authorization signal — it is only a
 * UI convenience default. hasAdminSession() is the only real gate; see the
 * shared contract's cookie section for the full rationale.
 */
export function parseLabelerCookie(raw: string | undefined): JevLabeler {
  return raw === "2" ? 2 : 1;
}

export interface JevGoldArticle {
  article_id: string;
  title: string;
  description: string | null;
  category: string;
  source_slug: string;
  position: number;
}

export interface JevGoldNext {
  article: JevGoldArticle | null;
  total: number;
  done: number;
}

export interface JevGoldRateFigure {
  n: number;
  correct: number;
  rate: number | null;
}

export interface JevGoldScorecard {
  labeled: Record<string, number>;
  doubleLabeled: {
    n: number;
    politicsAgree: number;
    politicsRate: number | null;
    topicAgree: number;
    topicRate: number | null;
  };
  goldN: number;
  jevPolitics050: JevGoldRateFigure;
  jevPolitics070: JevGoldRateFigure;
  feedPolitics: JevGoldRateFigure;
  jevTopic: JevGoldRateFigure;
}

interface RawJevGoldNextRow {
  article_id: string | null;
  title: string | null;
  description: string | null;
  category: string | null;
  source_slug: string | null;
  gold_position: number | string | null;
  total: number | string;
  done: number | string;
}

interface RawJevGoldRateFigure {
  n?: number | string;
  correct?: number | string;
  rate?: number | string | null;
}

interface RawJevGoldScorecard {
  labeled?: Record<string, number | string>;
  double_labeled?: {
    n?: number | string;
    politics_agree?: number | string;
    politics_rate?: number | string | null;
    topic_agree?: number | string;
    topic_rate?: number | string | null;
  };
  gold_n?: number | string;
  jev_politics_050?: RawJevGoldRateFigure;
  jev_politics_070?: RawJevGoldRateFigure;
  feed_politics?: RawJevGoldRateFigure;
  jev_topic?: RawJevGoldRateFigure;
}

// PostgREST may send numerics as strings — coerce every one, the same
// discipline as jev-shadow-status.ts's toAgreementRows/toQueueRows.
function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toRate(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toRateFigure(raw: RawJevGoldRateFigure | undefined): JevGoldRateFigure {
  return {
    n: toNum(raw?.n),
    correct: toNum(raw?.correct),
    rate: toRate(raw?.rate),
  };
}

export async function getJevGoldNext(labeler: JevLabeler): Promise<JevGoldNext | null> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase.rpc("jev_gold_next", { p_labeler: labeler });

    if (error) {
      console.error(`[admin] jev gold next unavailable: ${error.message}`);
      return null;
    }

    const rows = Array.isArray(data) ? (data as RawJevGoldNextRow[]) : data ? [data as RawJevGoldNextRow] : [];
    const row = rows[0];
    if (!row) {
      console.error("[admin] jev gold next unavailable: empty rpc result");
      return null;
    }

    const article: JevGoldArticle | null =
      row.article_id === null || row.article_id === undefined
        ? null
        : {
            article_id: String(row.article_id),
            title: String(row.title ?? ""),
            description: row.description === null || row.description === undefined ? null : String(row.description),
            category: String(row.category ?? ""),
            source_slug: String(row.source_slug ?? ""),
            position: toNum(row.gold_position),
          };

    return {
      article,
      total: toNum(row.total),
      done: toNum(row.done),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] jev gold next unavailable: ${message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gold seed (migration 076): provisional labeler 0 from the paid Opus
// labels ("Anlaşmazlıklar önce"). Additive to everything above -- neither
// JevGoldNext nor JevGoldScorecard gains a field, and getJevGoldNext /
// getJevGoldScorecard are unchanged. See supabase/migrations/076_jev_gold_
// provisional.sql for the SQL side and its header for the full rationale.
// ---------------------------------------------------------------------------

export const JEV_PROVISIONAL_THRESHOLD = 0.5;
export const JEV_PROVISIONAL_LABEL_SOURCE = "opus-2026-09-20";

export type JevGoldPriority = "disagreement" | "gold" | "provisional";

export interface JevGoldNextPrioritized extends JevGoldNext {
  priority: JevGoldPriority | null;
  disagreements: { total: number; done: number };
}

export interface JevGoldProvisionalScorecard {
  provisionalN: number;
  jevN: number;
  jevLiveN: number;
  jevAgreeN: number;
  disagreeN: number;
  adjudicatedN: number;
  humanSidedJev: number;
  humanSidedProvisional: number;
  humanN: number;
  provisionalVsHumanAgree: number;
  jevVsHumanN: number;
  jevVsHumanAgree: number;
}

interface RawJevGoldNextPrioritizedRow extends RawJevGoldNextRow {
  priority: string | null;
  disagree_total: number | string;
  disagree_done: number | string;
}

interface RawJevGoldProvisionalScorecard {
  provisional_n?: number | string;
  jev_n?: number | string;
  jev_live_n?: number | string;
  jev_agree_n?: number | string;
  disagree_n?: number | string;
  adjudicated_n?: number | string;
  human_sided_jev?: number | string;
  human_sided_provisional?: number | string;
  human_n?: number | string;
  provisional_vs_human_agree?: number | string;
  jev_vs_human_n?: number | string;
  jev_vs_human_agree?: number | string;
}

function isJevGoldPriority(v: unknown): v is JevGoldPriority {
  return v === "disagreement" || v === "gold" || v === "provisional";
}

export async function getJevGoldNextPrioritized(labeler: JevLabeler): Promise<JevGoldNextPrioritized | null> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase.rpc("jev_gold_next_prioritized", { p_labeler: labeler });

    if (error) {
      console.error(`[admin] jev gold next prioritized unavailable: ${error.message}`);
      return null;
    }

    const rows = Array.isArray(data)
      ? (data as RawJevGoldNextPrioritizedRow[])
      : data
        ? [data as RawJevGoldNextPrioritizedRow]
        : [];
    const row = rows[0];
    if (!row) {
      console.error("[admin] jev gold next prioritized unavailable: empty rpc result");
      return null;
    }

    const article: JevGoldArticle | null =
      row.article_id === null || row.article_id === undefined
        ? null
        : {
            article_id: String(row.article_id),
            title: String(row.title ?? ""),
            description: row.description === null || row.description === undefined ? null : String(row.description),
            category: String(row.category ?? ""),
            source_slug: String(row.source_slug ?? ""),
            position: toNum(row.gold_position),
          };

    return {
      article,
      total: toNum(row.total),
      done: toNum(row.done),
      priority: isJevGoldPriority(row.priority) ? row.priority : null,
      disagreements: {
        total: toNum(row.disagree_total),
        done: toNum(row.disagree_done),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] jev gold next prioritized unavailable: ${message}`);
    return null;
  }
}

export async function getJevGoldProvisionalScorecard(): Promise<JevGoldProvisionalScorecard | null> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase.rpc("jev_gold_provisional_scorecard");

    if (error) {
      console.error(`[admin] jev gold provisional scorecard unavailable: ${error.message}`);
      return null;
    }

    const raw = (data ?? {}) as RawJevGoldProvisionalScorecard;

    return {
      provisionalN: toNum(raw.provisional_n),
      jevN: toNum(raw.jev_n),
      jevLiveN: toNum(raw.jev_live_n),
      jevAgreeN: toNum(raw.jev_agree_n),
      disagreeN: toNum(raw.disagree_n),
      adjudicatedN: toNum(raw.adjudicated_n),
      humanSidedJev: toNum(raw.human_sided_jev),
      humanSidedProvisional: toNum(raw.human_sided_provisional),
      humanN: toNum(raw.human_n),
      provisionalVsHumanAgree: toNum(raw.provisional_vs_human_agree),
      jevVsHumanN: toNum(raw.jev_vs_human_n),
      jevVsHumanAgree: toNum(raw.jev_vs_human_agree),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] jev gold provisional scorecard unavailable: ${message}`);
    return null;
  }
}

interface PriorityBadge {
  label: string;
  tone: "warn" | "neutral" | "muted";
}

const PRIORITY_BADGES: Record<JevGoldPriority, PriorityBadge> = {
  disagreement: { label: "Anlaşmazlık", tone: "warn" },
  gold: { label: "Altın küme örneği", tone: "neutral" },
  provisional: { label: "Geçici etiketli", tone: "muted" },
};

export function priorityBadge(priority: JevGoldPriority | null): PriorityBadge | null {
  return priority === null ? null : PRIORITY_BADGES[priority];
}

export interface ProvisionalScorecardLine {
  label: string;
  text: string;
}

function provisionalRateLine(n: number, correct: number): string {
  if (n < JEV_GOLD_MIN_N) return "henüz yok";
  const pct = n > 0 ? Math.round((correct / n) * 100) : 0;
  return `%${pct} (n=${n.toLocaleString("tr-TR")})`;
}

export function buildProvisionalScorecardLines(card: JevGoldProvisionalScorecard): ProvisionalScorecardLine[] {
  return [
    { label: "Geçici etiketli haber", text: card.provisionalN.toLocaleString("tr-TR") },
    { label: "Jev cevabı olan (canlı / test düzeneği)", text: card.jevN.toLocaleString("tr-TR") },
    { label: "Jev ile geçici etiket aynı", text: card.jevAgreeN.toLocaleString("tr-TR") },
    { label: "Anlaşmazlık", text: card.disagreeN.toLocaleString("tr-TR") },
    {
      label: "Karara bağlanan anlaşmazlık",
      text: `${card.adjudicatedN.toLocaleString("tr-TR")} / ${card.disagreeN.toLocaleString("tr-TR")}`,
    },
    {
      label: "İnsan Jev'i haklı buldu",
      text: provisionalRateLine(card.adjudicatedN, card.humanSidedJev),
    },
    {
      label: "İnsan geçici etiketi haklı buldu",
      text: provisionalRateLine(card.adjudicatedN, card.humanSidedProvisional),
    },
    {
      label: "Geçici etiketin insanla uyumu",
      text: provisionalRateLine(card.humanN, card.provisionalVsHumanAgree),
    },
    {
      label: "Jev'in insanla uyumu",
      text: provisionalRateLine(card.jevVsHumanN, card.jevVsHumanAgree),
    },
  ];
}

export async function getJevGoldScorecard(): Promise<JevGoldScorecard | null> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase.rpc("jev_gold_scorecard");

    if (error) {
      console.error(`[admin] jev gold scorecard unavailable: ${error.message}`);
      return null;
    }

    const raw = (data ?? {}) as RawJevGoldScorecard;

    const labeledRaw = raw.labeled ?? {};
    const labeled: Record<string, number> = {};
    for (const [key, value] of Object.entries(labeledRaw)) {
      labeled[key] = toNum(value);
    }

    return {
      labeled,
      doubleLabeled: {
        n: toNum(raw.double_labeled?.n),
        politicsAgree: toNum(raw.double_labeled?.politics_agree),
        politicsRate: toRate(raw.double_labeled?.politics_rate),
        topicAgree: toNum(raw.double_labeled?.topic_agree),
        topicRate: toRate(raw.double_labeled?.topic_rate),
      },
      goldN: toNum(raw.gold_n),
      jevPolitics050: toRateFigure(raw.jev_politics_050),
      jevPolitics070: toRateFigure(raw.jev_politics_070),
      feedPolitics: toRateFigure(raw.feed_politics),
      jevTopic: toRateFigure(raw.jev_topic),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] jev gold scorecard unavailable: ${message}`);
    return null;
  }
}
