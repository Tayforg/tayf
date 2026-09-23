import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createServerClient: vi.fn() }));

import { buildAttentionItems, countNeedsAction, type AttentionInput } from "./attention";
import { JEV_QUEUE_LIMIT } from "@/lib/admin/jev-shadow-status";
import type { JevShadowStatus, JevQueueRow, JevRunRow } from "@/lib/admin/jev-shadow-status";
import type { JevSignalsStatus } from "@/lib/admin/jev-signals";
import type { JevRegressionStatus, JevRegressionRunView } from "@/lib/admin/jev-regression";
import type { JevGoldNext } from "@/lib/admin/jev-gold";
import type { ArchiveExportRow } from "@/lib/admin/archive-status";
import type { LlmBudgetStatus } from "@/lib/admin/llm-budget-status";
import type { CorrectionRow } from "./corrections-status";

const NOW = Date.parse("2026-09-23T12:00:00Z");

function baseInput(overrides: Partial<AttentionInput> = {}): AttentionInput {
  return {
    now: NOW,
    signals: null,
    shadow: null,
    unlink: null,
    regression: null,
    gold: { labeler1: null, labeler2: null },
    corrections: null,
    archive: null,
    llmBudget: null,
    ...overrides,
  };
}

function queueRow(overrides: Partial<JevQueueRow> = {}): JevQueueRow {
  return {
    id: 1,
    task: "politics",
    subject_type: "article",
    subject_id: "a1",
    state_preview: "{}",
    baseline_answer: "iktidar",
    jev_prob: 0.5,
    jev_choice: "iktidar",
    created_at: "2026-09-23T10:00:00Z",
    ...overrides,
  };
}

function shadowRun(overrides: Partial<JevRunRow> = {}): JevRunRow {
  return {
    id: 1,
    started_at: "2026-09-23T10:00:00Z",
    finished_at: "2026-09-23T10:05:00Z",
    calls: 10,
    input_tokens: 1000,
    errors: 0,
    status: "ok",
    note: null,
    ...overrides,
  };
}

function shadowStatus(overrides: Partial<JevShadowStatus> = {}): JevShadowStatus {
  return {
    agreement24h: [],
    agreement7d: [],
    month: { runs: 1, calls: 10, inputTokens: 1000, usd: 0.1, cap: 10000, pct: 10, exceeded: false },
    lastRun: null,
    queue: [],
    ...overrides,
  };
}

function regressionRun(overrides: Partial<JevRegressionRunView> = {}): JevRegressionRunView {
  return {
    id: 1,
    questionSet: "v1",
    startedAt: "2026-09-23T10:00:00Z",
    finishedAt: "2026-09-23T10:05:00Z",
    status: "ok",
    items: 100,
    calls: 100,
    flipRate: 0.02,
    firstRun: false,
    flips: { politics: 1, topic: 1, pair: 1 },
    goldPolitics070: 0.9,
    ...overrides,
  };
}

function goldNext(overrides: Partial<JevGoldNext> = {}): JevGoldNext {
  return { article: null, total: 0, done: 0, ...overrides };
}

function correction(overrides: Partial<CorrectionRow> = {}): CorrectionRow {
  return {
    id: "c1",
    status: "open",
    created_at: "2026-09-23T10:00:00Z",
    reviewed_at: null,
    url: "https://example.com",
    message: "test",
    email: null,
    ...overrides,
  };
}

function archiveRow(overrides: Partial<ArchiveExportRow> = {}): ArchiveExportRow {
  return {
    day: "2026-09-23",
    object_path: "2026/09/23",
    sha256: "a".repeat(64),
    rows: 100,
    bytes: 1000,
    created_at: "2026-09-23T00:10:00Z",
    ...overrides,
  };
}

function llmBudget(overrides: Partial<LlmBudgetStatus> = {}): LlmBudgetStatus {
  return {
    day: "2026-09-23",
    calls: 10,
    inputTokens: 1000,
    outputTokens: 100,
    usd: 0.1,
    cap: 1,
    pct: 10,
    exceeded: false,
    eligibleN: 10,
    ineligibleN: 0,
    eligibleShare: 1,
    ...overrides,
  };
}

describe("buildAttentionItems", () => {
  it("returns 9 items in the fixed id order, all muted, when every input is null", () => {
    const items = buildAttentionItems(baseInput());
    expect(items.map((i) => i.id)).toEqual([
      "alerts",
      "disagreements",
      "unlink",
      "corrections",
      "gold",
      "runs",
      "jev-budget",
      "llm-budget",
      "archive",
    ]);
    expect(items.every((i) => i.tone === "muted")).toBe(true);
    expect(countNeedsAction(items)).toBe(0);
  });

  it("alerts: alertsTotal 5 gives value 5, tone bad, href #uyarilar", () => {
    const signals: JevSignalsStatus = { drift: [], alerts: [], alertsTotal: 5 };
    const items = buildAttentionItems(baseInput({ signals }));
    const alerts = items.find((i) => i.id === "alerts")!;
    expect(alerts.value).toBe("5");
    expect(alerts.tone).toBe("bad");
    expect(alerts.href).toBe("#uyarilar");
    expect(alerts.needsAction).toBe(true);
  });

  it("disagreements: queue length at the cap renders '30+'", () => {
    const shadow = shadowStatus({ queue: Array.from({ length: JEV_QUEUE_LIMIT }, () => queueRow()) });
    const items = buildAttentionItems(baseInput({ shadow }));
    const disagreements = items.find((i) => i.id === "disagreements")!;
    expect(disagreements.value).toBe(`${JEV_QUEUE_LIMIT}+`);
    expect(disagreements.tone).toBe("warn");
  });

  it("runs: a shadow run within 48h counts as bad, past 48h it doesn't", () => {
    const recent = shadowStatus({
      lastRun: shadowRun({ status: "partial", started_at: new Date(NOW - 10 * 60 * 60 * 1000).toISOString() }),
    });
    const recentItems = buildAttentionItems(baseInput({ shadow: recent }));
    const recentRuns = recentItems.find((i) => i.id === "runs")!;
    expect(recentRuns.value).toBe("1");
    expect(recentRuns.tone).toBe("bad");
    expect(recentRuns.href).toBe("#jev-golge");

    const stale = shadowStatus({
      lastRun: shadowRun({ status: "partial", started_at: new Date(NOW - 60 * 60 * 60 * 1000).toISOString() }),
    });
    const staleItems = buildAttentionItems(baseInput({ shadow: stale }));
    const staleRuns = staleItems.find((i) => i.id === "runs")!;
    expect(staleRuns.value).toBe("0");
    expect(staleRuns.tone).toBe("ok");
  });

  it("runs: a regression error run within 48h points at #regresyon", () => {
    const regression: JevRegressionStatus = {
      counts: { articles: 0, pairs: 0, inGold: 0 },
      runs: [regressionRun({ status: "error", startedAt: new Date(NOW - 5 * 60 * 60 * 1000).toISOString() })],
    };
    const items = buildAttentionItems(baseInput({ regression }));
    const runs = items.find((i) => i.id === "runs")!;
    expect(runs.href).toBe("#regresyon");
    expect(runs.tone).toBe("bad");
  });

  it("jev-budget: 85% is warn, exceeded is bad", () => {
    const warnShadow = shadowStatus({
      month: { runs: 1, calls: 1, inputTokens: 8500, usd: 1, cap: 10000, pct: 85, exceeded: false },
    });
    const warnItems = buildAttentionItems(baseInput({ shadow: warnShadow }));
    expect(warnItems.find((i) => i.id === "jev-budget")!.tone).toBe("warn");

    const exceededShadow = shadowStatus({
      month: { runs: 1, calls: 1, inputTokens: 10500, usd: 1, cap: 10000, pct: 105, exceeded: true },
    });
    const exceededItems = buildAttentionItems(baseInput({ shadow: exceededShadow }));
    expect(exceededItems.find((i) => i.id === "jev-budget")!.tone).toBe("bad");
  });

  it("gold: sums remaining across labelers and names labeler 1 in the hint", () => {
    const items = buildAttentionItems(
      baseInput({
        gold: {
          labeler1: goldNext({ total: 304, done: 0 }),
          labeler2: goldNext({ total: 304, done: 304 }),
        },
      }),
    );
    const gold = items.find((i) => i.id === "gold")!;
    expect(gold.value).toBe("304");
    expect(gold.hint).toContain("Etiketleyici 1: 304");
    expect(gold.tone).toBe("warn");
  });

  it("gold: totals of 0 render as muted with the 'not created yet' hint", () => {
    const items = buildAttentionItems(
      baseInput({
        gold: {
          labeler1: goldNext({ total: 0, done: 0 }),
          labeler2: goldNext({ total: 0, done: 0 }),
        },
      }),
    );
    const gold = items.find((i) => i.id === "gold")!;
    expect(gold.value).toBe("0");
    expect(gold.tone).toBe("muted");
    expect(gold.hint).toBe("Altın küme henüz oluşturulmadı");
  });

  it("corrections: counts only open/new rows", () => {
    const corrections = [
      correction({ id: "1", status: "open" }),
      correction({ id: "2", status: "new" }),
      correction({ id: "3", status: "reviewed" }),
    ];
    const items = buildAttentionItems(baseInput({ corrections }));
    const item = items.find((i) => i.id === "corrections")!;
    expect(item.value).toBe("2");
    expect(item.tone).toBe("warn");
  });

  it("archive: today's export is ok, a 3-day-old export is bad, an empty list is warn", () => {
    const todayItems = buildAttentionItems(baseInput({ archive: [archiveRow({ day: "2026-09-23" })] }));
    const today = todayItems.find((i) => i.id === "archive")!;
    expect(today.value).toBe("bugün");
    expect(today.tone).toBe("ok");

    const staleItems = buildAttentionItems(baseInput({ archive: [archiveRow({ day: "2026-09-20" })] }));
    const stale = staleItems.find((i) => i.id === "archive")!;
    expect(stale.value).toBe("3 gün önce");
    expect(stale.tone).toBe("bad");

    const emptyItems = buildAttentionItems(baseInput({ archive: [] }));
    const empty = emptyItems.find((i) => i.id === "archive")!;
    expect(empty.value).toBe("yok");
    expect(empty.tone).toBe("warn");
  });

  it("llm-budget: uses the same warn/bad thresholds", () => {
    const items = buildAttentionItems(baseInput({ llmBudget: llmBudget({ pct: 90, exceeded: false }) }));
    expect(items.find((i) => i.id === "llm-budget")!.tone).toBe("warn");
  });
});
