import { BIAS_ORDER } from "@/lib/bias/config";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import type { BiasDistribution } from "@/types";

// Day-by-day layout for /hikaye/[slug]. Pure: no Date.now(), no I/O.

export interface ThreadMemberCluster {
  id: string;
  title_tr: string | null;
  title_tr_neutral: string | null;
  first_published: string | null;
  article_count: number | null;
  bias_distribution: unknown;
}

export interface ThreadTimelineDay {
  key: string;
  label: string;
  clusters: Array<{ id: string; title: string; articleCount: number }>;
  distribution: BiasDistribution;
  sourceTotal: number;
}

export interface ThreadTimeline {
  days: ThreadTimelineDay[];
  clusterCount: number;
  dayCount: number;
  firstLabel: string;
  lastLabel: string;
}

const KEY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" });
const LABEL_FMT = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  day: "numeric",
  month: "long",
  weekday: "long",
});

function titleOf(m: ThreadMemberCluster): string {
  const neutral = typeof m.title_tr_neutral === "string" ? m.title_tr_neutral.trim() : "";
  if (neutral !== "") return neutral;
  return typeof m.title_tr === "string" ? m.title_tr.trim() : "";
}

function addDistribution(target: BiasDistribution, raw: unknown): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const src = raw as Record<string, unknown>;
  for (const key of BIAS_ORDER) {
    const v = src[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
      target[key] += v;
    }
  }
}

export function buildThreadTimeline(members: ThreadMemberCluster[]): ThreadTimeline {
  const dated: Array<{ m: ThreadMemberCluster; ms: number; date: Date }> = [];
  for (const m of members) {
    if (typeof m.first_published !== "string") continue;
    const ms = new Date(m.first_published).getTime();
    if (Number.isNaN(ms)) continue;
    dated.push({ m, ms, date: new Date(ms) });
  }
  dated.sort((a, b) => a.ms - b.ms);

  const byDay = new Map<string, ThreadTimelineDay>();
  for (const { m, date } of dated) {
    const key = KEY_FMT.format(date);
    let day = byDay.get(key);
    if (!day) {
      day = {
        key,
        label: LABEL_FMT.format(date),
        clusters: [],
        distribution: emptyBiasDistribution(),
        sourceTotal: 0,
      };
      byDay.set(key, day);
    }
    day.clusters.push({
      id: m.id,
      title: titleOf(m),
      articleCount:
        typeof m.article_count === "number" && Number.isFinite(m.article_count)
          ? m.article_count
          : 0,
    });
    addDistribution(day.distribution, m.bias_distribution);
  }

  const days = [...byDay.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const d of days) {
    d.sourceTotal = BIAS_ORDER.reduce((s, k) => s + d.distribution[k], 0);
  }

  return {
    days,
    clusterCount: dated.length,
    dayCount: days.length,
    firstLabel: days[0]?.label ?? "",
    lastLabel: days[days.length - 1]?.label ?? "",
  };
}
