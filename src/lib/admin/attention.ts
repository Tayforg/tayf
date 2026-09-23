import type { JevSignalsStatus } from "@/lib/admin/jev-signals";
import type { JevShadowStatus } from "@/lib/admin/jev-shadow-status";
import { JEV_QUEUE_LIMIT } from "@/lib/admin/jev-shadow-status";
import type { JevUnlinkCandidateView } from "@/lib/admin/jev-cluster";
import { JEV_UNLINK_LIMIT } from "@/lib/admin/jev-cluster";
import type { JevRegressionStatus } from "@/lib/admin/jev-regression";
import type { JevGoldNext } from "@/lib/admin/jev-gold";
import type { CorrectionRow } from "./corrections-status";
import { CORRECTIONS_LIMIT } from "./corrections-status";
import type { ArchiveExportRow } from "@/lib/admin/archive-status";
import type { LlmBudgetStatus } from "@/lib/admin/llm-budget-status";
import { fmtInt, fmtUsd, type Tone } from "./format";

// /admin readability pass — "Bugün dikkat" (AttentionStrip). Pure: takes
// the same nine readers page.tsx already awaits in one Promise.all and
// distills each into a single KPI tile. Every reader already returns
// `null` instead of throwing, so every branch here treats `null` as "could
// not read" (muted, "—", needsAction false) rather than crashing the page.

export type AttentionItemId =
  | "alerts"
  | "disagreements"
  | "unlink"
  | "corrections"
  | "gold"
  | "runs"
  | "jev-budget"
  | "llm-budget"
  | "archive";

export interface AttentionItem {
  id: AttentionItemId;
  label: string;
  value: string;
  hint: string;
  href: string;
  tone: Tone;
  needsAction: boolean;
}

export interface AttentionInput {
  now: number;
  signals: JevSignalsStatus | null;
  shadow: JevShadowStatus | null;
  unlink: JevUnlinkCandidateView[] | null;
  regression: JevRegressionStatus | null;
  gold: { labeler1: JevGoldNext | null; labeler2: JevGoldNext | null };
  corrections: CorrectionRow[] | null;
  archive: ArchiveExportRow[] | null;
  llmBudget: LlmBudgetStatus | null;
}

const RUN_WINDOW_MS = 48 * 60 * 60 * 1000;
const SHADOW_RUN_BAD_STATUSES = new Set(["partial", "error", "rate_limited", "budget_exceeded"]);
const REGRESSION_RUN_BAD_STATUSES = new Set(["partial", "error"]);

function nullItem(id: AttentionItemId, label: string, href: string): AttentionItem {
  return { id, label, value: "—", hint: "Okunamadı", href, tone: "muted", needsAction: false };
}

function alertsItem(signals: JevSignalsStatus | null): AttentionItem {
  const label = "Onay bekleyen uyarı";
  const href = "#uyarilar";
  if (!signals) return nullItem("alerts", label, href);

  const n = signals.alertsTotal;
  const tone: Tone = n > 0 ? "bad" : "ok";
  return {
    id: "alerts",
    label,
    value: String(n),
    hint: "Jev ölçümlerinde olağandışı durum",
    href,
    tone,
    needsAction: tone === "bad",
  };
}

function disagreementsItem(shadow: JevShadowStatus | null): AttentionItem {
  const label = "İncelenecek anlaşmazlık";
  const href = "#anlasmazlik";
  if (!shadow) return nullItem("disagreements", label, href);

  const n = shadow.queue.length;
  const value = n >= JEV_QUEUE_LIMIT ? `${n}+` : String(n);
  const tone: Tone = n > 0 ? "warn" : "ok";
  return {
    id: "disagreements",
    label,
    value,
    hint: "Jev ile sistem farklı cevap verdi",
    href,
    tone,
    needsAction: tone === "warn",
  };
}

function unlinkItem(unlink: JevUnlinkCandidateView[] | null): AttentionItem {
  const label = "Küme dışı aday";
  const href = "#kume-disi";
  if (!unlink) return nullItem("unlink", label, href);

  const n = unlink.length;
  const value = n >= JEV_UNLINK_LIMIT ? `${n}+` : String(n);
  const tone: Tone = n > 0 ? "warn" : "ok";
  return {
    id: "unlink",
    label,
    value,
    hint: "Kümeye ait olmayabilecek haber",
    href,
    tone,
    needsAction: tone === "warn",
  };
}

function correctionsItem(corrections: CorrectionRow[] | null): AttentionItem {
  const label = "Açık düzeltme";
  const href = "#duzeltmeler";
  if (!corrections) return nullItem("corrections", label, href);

  const n = corrections.filter((c) => c.status === "open" || c.status === "new").length;
  const tone: Tone = n > 0 ? "warn" : "ok";
  const hint = corrections.length >= CORRECTIONS_LIMIT ? "Son 50 bildirim içinde" : "Okuyucu hata bildirimleri";
  return {
    id: "corrections",
    label,
    value: String(n),
    hint,
    href,
    tone,
    needsAction: tone === "warn",
  };
}

function goldItem(labeler1: JevGoldNext | null, labeler2: JevGoldNext | null): AttentionItem {
  const label = "Etiketlenmemiş altın";
  const href = "/admin/jev-altin";
  if (!labeler1 && !labeler2) return nullItem("gold", label, href);

  const labelers = [labeler1, labeler2];
  const totals = labelers.filter((l): l is JevGoldNext => l !== null).map((l) => l.total);
  const remaining = labelers.map((l) => (l ? Math.max(0, l.total - l.done) : null));

  if (totals.length > 0 && totals.every((t) => t === 0)) {
    return {
      id: "gold",
      label,
      value: "0",
      hint: "Altın küme henüz oluşturulmadı",
      href,
      tone: "muted",
      needsAction: false,
    };
  }

  const sum = remaining.reduce((acc: number, r) => acc + (r ?? 0), 0);
  const tone: Tone = sum > 0 ? "warn" : "ok";
  const [r1, r2] = remaining;
  return {
    id: "gold",
    label,
    value: String(sum),
    hint: `Etiketleyici 1: ${r1 ?? "—"} · Etiketleyici 2: ${r2 ?? "—"}`,
    href,
    tone,
    needsAction: tone === "warn",
  };
}

function runsItem(
  shadow: JevShadowStatus | null,
  regression: JevRegressionStatus | null,
  now: number,
): AttentionItem {
  const label = "Sorunlu Jev çalışması";
  if (!shadow && !regression) return nullItem("runs", label, "#jev-golge");

  const shadowRun = shadow?.lastRun ?? null;
  const shadowCounts =
    shadowRun !== null &&
    SHADOW_RUN_BAD_STATUSES.has(shadowRun.status) &&
    now - Date.parse(shadowRun.started_at) <= RUN_WINDOW_MS;

  const regressionRun = regression?.runs[0] ?? null;
  const regressionCounts =
    regressionRun !== null &&
    REGRESSION_RUN_BAD_STATUSES.has(regressionRun.status) &&
    now - Date.parse(regressionRun.startedAt) <= RUN_WINDOW_MS;

  const count = (shadowCounts ? 1 : 0) + (regressionCounts ? 1 : 0);
  const href = shadowCounts ? "#jev-golge" : regressionCounts ? "#regresyon" : "#jev-golge";
  const tone: Tone = count > 0 ? "bad" : "ok";
  return {
    id: "runs",
    label,
    value: String(count),
    hint: "Son 48 saat · son gölge çalışması ve regresyon çalışmaları",
    href,
    tone,
    needsAction: tone === "bad",
  };
}

function jevBudgetItem(shadow: JevShadowStatus | null): AttentionItem {
  const label = "Jev aylık bütçe";
  const href = "#jev-golge";
  if (!shadow) return nullItem("jev-budget", label, href);

  const { pct, exceeded, inputTokens, cap } = shadow.month;
  const tone: Tone = exceeded || pct >= 100 ? "bad" : pct >= 80 ? "warn" : "ok";
  return {
    id: "jev-budget",
    label,
    value: `%${pct}`,
    hint: `${fmtInt(inputTokens)} / ${fmtInt(cap)} jeton`,
    href,
    tone,
    needsAction: tone === "bad",
  };
}

function llmBudgetItem(llmBudget: LlmBudgetStatus | null): AttentionItem {
  const label = "Başlık LLM bugün";
  const href = "#llm-butce";
  if (!llmBudget) return nullItem("llm-budget", label, href);

  const { pct, exceeded, calls, cap } = llmBudget;
  const tone: Tone = exceeded ? "bad" : pct >= 80 ? "warn" : "ok";
  return {
    id: "llm-budget",
    label,
    value: `%${pct}`,
    hint: `${calls} çağrı · sınır ${fmtUsd(cap)}`,
    href,
    tone,
    needsAction: tone === "bad",
  };
}

function archiveItem(archive: ArchiveExportRow[] | null, now: number): AttentionItem {
  const label = "Gece arşivi";
  const href = "#arsiv";
  if (!archive) return nullItem("archive", label, href);

  if (archive.length === 0) {
    return {
      id: "archive",
      label,
      value: "yok",
      hint: "Henüz dışa aktarma yok",
      href,
      tone: "warn",
      needsAction: true,
    };
  }

  const latest = archive[0];
  if (!latest) return nullItem("archive", label, href);

  const utcMidnight = Math.floor(now / 86_400_000) * 86_400_000;
  const dayMs = Date.parse(`${latest.day}T00:00:00Z`);
  const ageDays = Math.floor((utcMidnight - dayMs) / 86_400_000);
  const value = ageDays === 0 ? "bugün" : ageDays === 1 ? "dün" : `${ageDays} gün önce`;
  const tone: Tone = ageDays <= 1 ? "ok" : "bad";
  const hint = tone === "ok" ? `${fmtInt(latest.rows)} haber` : "Gece aktarımı gecikti";
  return {
    id: "archive",
    label,
    value,
    hint,
    href,
    tone,
    needsAction: tone === "bad",
  };
}

/**
 * Always returns exactly the nine tiles below, in this fixed order —
 * operators learn the grid positions, so the order itself is part of the
 * contract, not just the content.
 */
export function buildAttentionItems(input: AttentionInput): AttentionItem[] {
  return [
    alertsItem(input.signals),
    disagreementsItem(input.shadow),
    unlinkItem(input.unlink),
    correctionsItem(input.corrections),
    goldItem(input.gold.labeler1, input.gold.labeler2),
    runsItem(input.shadow, input.regression, input.now),
    jevBudgetItem(input.shadow),
    llmBudgetItem(input.llmBudget),
    archiveItem(input.archive, input.now),
  ];
}

export function countNeedsAction(items: AttentionItem[]): number {
  return items.filter((item) => item.needsAction).length;
}
